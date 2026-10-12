# Rust.js

A small Rust-style language interpreter written in JavaScript, with a browser playground for running programs and exploring ownership, borrowing, and pattern matching.

Rust.js reads source code, builds a syntax tree, and evaluates it in JavaScript. It supports a deliberately limited subset of Rust syntax, with ownership and borrow checks performed while the program runs.

## Run locally

You need Node.js 20 or later. There are no package dependencies to install.

```sh
git clone https://github.com/blah-mad/rust-in-js.git
cd rust-in-js
npm start
```

Open the local URL printed in the terminal. Pick an example, edit the code, and run it to see output or a diagnostic. The playground runs programs in your browser.

Run the interpreter tests with:

```sh
npm test
```

## Write a program

```rust
fn main() {
    let name = "JavaScript";
    println!("Hello, {}!", name);
}
```

Output:

```text
Hello, JavaScript!
```

## Use the interpreter

The interpreter is also an ES module:

```js
import { execute } from './dist/interpreter.js';

const result = execute(`
    fn main() {
        println!("Hello from Rust.js");
    }
`);

if (result.ok) {
    console.log(result.stdout.join('\n'));
} else {
    console.error(result.error);
}
```

`execute(source, options)` returns captured `stdout`, an `ok` flag, a located `error` when execution fails, and execution statistics. Pass `{ maxSteps: 10000 }` to set an execution budget or `{ unsafe: true }` to disable ownership and borrow checks.

## Supported language features

- Variables, mutable bindings, assignment, and lexical scopes.
- Numbers, strings, booleans, and common arithmetic and comparison operators.
- Functions, arguments, and return values.
- Conditional expressions and loops.
- Owned strings with `String::from`, `.clone()`, and `.push_str()`.
- Structs and field access.
- `Option` and `Result` values with `match` expressions.
- Shared and mutable references, with runtime ownership and borrow checks.
- `println!` for console output.
- An unsafe execution option that bypasses ownership and borrow checks.

The bundled examples show supported syntax and the diagnostics these features produce.

## Ownership at runtime

Moving an owned string makes its previous binding unusable:

```rust
fn main() {
    let original = String::from("Ferris");
    let current = original;
    println!("{}", original);
}
```

This produces a use-after-move diagnostic. Clone the value before moving it to keep both bindings usable. References are tracked while their lexical scope is active; conflicting mutable borrows and mutation through a borrowed owner produce diagnostics.

## How it works

The tokenizer turns source text into tokens. The parser builds a syntax tree. The evaluator executes that tree using JavaScript values and tracks bindings, references, and ownership as execution progresses.

Diagnostics point to the source location that triggered an error. Checks happen only for code that executes; this is different from Rust's compile-time analysis.

## Differences from Rust

Rust.js is an interpreter for a small language subset, not a Rust compiler. Existing Rust projects will not run unchanged.

- There is no Cargo, crate ecosystem, macro system, or Rust standard library.
- Type annotations do not provide Rust's static type checking.
- JavaScript handles storage and garbage collection. There is no native memory layout or manual memory access.
- Unsafe mode changes interpreter checks; it does not expose raw machine memory.
- Numeric behavior and performance follow JavaScript rather than native Rust.
- Lifetimes, traits, generics, async execution, and multithreading are outside the supported subset.

Use the playground to experiment with the implemented language features. Use the Rust toolchain for real Rust programs.

## Contributing

Bug reports and small, focused pull requests are welcome. Include a minimal program that demonstrates the behavior. Add an interpreter test when changing language semantics, and run `npm test` before submitting a pull request.

## License

[MIT](LICENSE).

---

This is a meme project. After years of trying to escape JavaScript, Rust can finally enjoy its garbage collector, runtime errors, and single-threaded hospitality. Fearless concurrency, subject to availability.
