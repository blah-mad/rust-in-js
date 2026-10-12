import test from 'node:test';
import assert from 'node:assert/strict';
import { execute } from '../dist/interpreter.js';

function succeeds(source, stdout, options) {
  const result = execute(source, options);
  assert.equal(result.ok, true, result.error?.message);
  assert.equal(result.error, null);
  assert.deepEqual(result.stdout, stdout);
  assert.ok(Number.isInteger(result.steps) && result.steps >= 0);
  assert.ok(Array.isArray(result.borrows));
  assert.ok(Array.isArray(result.warnings));
  return result;
}

function fails(source, messagePattern, options) {
  let result;
  assert.doesNotThrow(() => { result = execute(source, options); });
  assert.equal(result.ok, false);
  assert.ok(Array.isArray(result.stdout));
  assert.ok(result.error && typeof result.error === 'object');
  assert.equal(typeof result.error.code, 'string');
  assert.ok(result.error.code.length > 0);
  assert.equal(typeof result.error.message, 'string');
  assert.match(result.error.message, messagePattern);
  assert.ok(Number.isInteger(result.error.line) && result.error.line >= 1);
  assert.ok(Number.isInteger(result.error.column) && result.error.column >= 1);
  assert.ok(Number.isInteger(result.steps) && result.steps >= 0);
  return result;
}

test('println formats multiple values and retains each output line', () => {
  succeeds(`
    fn main() {
      println!("hello, {}! {} + {} = {}", "Ferris", 2, 3, 5);
      println!("ready: {}", true);
      println!("{} {} {} {}", "!", "&", "-", "*");
    }
  `, ['hello, Ferris! 2 + 3 = 5', 'ready: true', '! & - *']);
});

test('nested arithmetic respects grouping, precedence, and unary minus', () => {
  succeeds(`fn main() { println!("{}", (2 + 3) * (8 - 2) / 3 + -2); }`, ['8']);
});

test('typed user functions can return a tail expression', () => {
  succeeds(`
    fn double(value: i32) -> i32 { value * 2 }
    fn main() { println!("{}", double(7) + double(2)); }
  `, ['18']);
});

test('a mutable binding may be assigned after initialization', () => {
  succeeds(`fn main() { let mut count = 1; count = count + 2; println!("{}", count); }`, ['3']);
});

test('writing an immutable binding reports a diagnostic', () => {
  fails(`fn main() { let count = 1; count = 2; }`, /immutable|mutab|cannot assign/i);
});

test('copying a number leaves the original usable', () => {
  succeeds(`fn main() { let original = 7; let copied = original; println!("{} {}", original, copied); }`, ['7 7']);
});

const conflictingBorrows = `
  fn main() {
    let mut value = 1;
    let first = &mut value;
    let second = &mut value;
    *second = 2;
    println!("{}", *first);
  }
`;

test('two simultaneous mutable borrows fail in safe mode', () => {
  fails(conflictingBorrows, /borrow|mutable|reference/i);
});

test('unsafe mode allows conflicting borrows and moved-value access, with a warning', () => {
  const result = succeeds(conflictingBorrows, ['2'], { unsafe: true });
  assert.ok(result.borrows.length >= 2);
  assert.ok(result.warnings.length > 0, 'Unsafe borrow bypass must be visible to the user.');
  succeeds(`fn main() { let original = String::from("Ferris"); let moved = original; println!("{}", original); }`, ['Ferris'], { unsafe: true });
});

test('a shared borrow prevents mutation of its owner', () => {
  fails(`fn main() { let mut value = 1; let reader = &value; value = 2; println!("{}", *reader); }`, /borrow|reference/i);
});

test('moving a String invalidates its owner, which can be initialized again if mutable', () => {
  fails(`fn main() { let original = String::from("Ferris"); let first = original; let second = original; }`, /mov|consum|owner/i);
  succeeds(`fn main() { let mut original = String::from("old"); let moved = original; original = String::from("new"); println!("{}", original); }`, ['new']);
});

test('cloning a String preserves independent owners', () => {
  succeeds(`
    fn main() {
      let original = String::from("Ferris");
      let mut copy = original.clone();
      copy.push_str(" Jr.");
      println!("{} / {}", original, copy);
    }
  `, ['Ferris / Ferris Jr.']);
});

test('Option match dispatches Some and binds its payload', () => {
  succeeds(`
    fn main() {
      let answer = Some(21);
      match answer { Some(value) => println!("{}", value * 2), None => println!("missing") }
    }
  `, ['42']);
});

test('Option handles None through match and diagnoses unwrap panic', () => {
  succeeds(`
    fn main() {
      let answer = None;
      match answer { Some(value) => println!("{}", value), None => println!("missing") }
    }
  `, ['missing']);
  fails(`fn main() { let absent = None; println!("{}", absent.unwrap()); }`, /unwrap|panic|None/i);
});

test('Result match dispatches Ok and binds its payload', () => {
  succeeds(`
    fn main() {
      let outcome = Ok(7);
      match outcome { Ok(value) => println!("ok: {}", value), Err(error) => println!("err: {}", error) }
    }
  `, ['ok: 7']);
});

test('Result match dispatches Err and binds its payload', () => {
  succeeds(`
    fn main() {
      let outcome = Err("single-threaded panic");
      match outcome { Ok(value) => println!("ok: {}", value), Err(error) => println!("err: {}", error) }
    }
  `, ['err: single-threaded panic']);
});

test('a struct can be constructed, read, and updated through a mutable owner', () => {
  succeeds(`
    struct Crab { name: String, clicks: i32 }
    fn main() {
      let mut crab = Crab { name: String::from("Ferris"), clicks: 1 };
      crab.clicks = crab.clicks + 2;
      println!("{}: {}", crab.name, crab.clicks);
    }
  `, ['Ferris: 3']);
});

test('leaving a nested lexical scope releases its mutable borrow', () => {
  const result = succeeds(`
    fn main() {
      let mut value = 1;
      { let first = &mut value; *first = 41; }
      let second = &mut value;
      *second = *second + 1;
      println!("{}", *second);
    }
  `, ['42']);
  assert.ok(result.borrows.length >= 2);
  succeeds(`
    fn main() {
      let mut value = 1;
      let first = &mut value;
      { let second = &mut *first; *second = 2; }
      println!("{}", *first);
    }
  `, ['2']);
});

test('loops iterate inclusive ranges and stop an infinite loop at the execution budget', () => {
  succeeds(`fn main() { for value in 0..=2 { println!("{}", value); } }`, ['0', '1', '2']);
  const result = fails(`fn main() { loop { } }`, /step|limit|budget/i, { maxSteps: 40 });
  assert.ok(result.steps <= 41, 'The step budget should stop an empty loop promptly.');
});

test('unsupported Rust syntax returns a located error instead of throwing', () => {
  fails(`fn main() { async fn later() { } }`, /unsupported|unexpected|expected|syntax/i);
});

test('JavaScript-looking input is rejected without executing it', () => {
  const marker = '__rustJsInterpreterInjectionTest';
  const previous = Object.getOwnPropertyDescriptor(globalThis, marker);
  globalThis[marker] = 'untouched';
  try {
    fails(`globalThis.${marker} = "executed";`, /unsupported|unexpected|expected|syntax|function/i);
    assert.equal(globalThis[marker], 'untouched');
    fails(`fn main() { eval("globalThis.${marker} = 'executed'"); }`, /unknown|unsupported|function|defined/i);
    assert.equal(globalThis[marker], 'untouched');
  } finally {
    if (previous) Object.defineProperty(globalThis, marker, previous);
    else delete globalThis[marker];
  }
});

test('a mutable reference can update a String, and an escaped local reference is rejected', () => {
  succeeds(`
    fn main() {
      let mut name = String::from("Ferris");
      { let writer = &mut name; writer.push_str(" Jr."); }
      println!("{}", name);
    }
  `, ['Ferris Jr.']);
  fails(`fn main() { let escaped = { let local = 42; &local }; println!("{}", *escaped); }`, /scope|dangl|live|drop|reference/i);
});

test('deep nesting and excessive output produce bounded diagnostics', () => {
  fails(`fn main() { println!("{}", ${'('.repeat(70)}1${')'.repeat(70)}); }`, /nest|deep|limit/i);
  const result = fails(`fn main() { for value in 0..201 { println!("x"); } }`, /output|limit/i);
  assert.equal(result.stdout.length, 200);
});
