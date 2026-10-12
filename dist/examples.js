export const examples = [
  { id: 'hello', title: 'Hello, world', symbol: '👋', description: 'The traditional first questionable decision.', code: `// Rust syntax. JavaScript consequences.
fn main() {
    let greeting = String::from("Hello, world.");
    println!("{} Unfortunately, it's JavaScript.", greeting);

    let meaning_of_life = 6 * 7;
    println!("The answer is {}. The runtime is JS.", meaning_of_life);
}` },
  { id: 'borrows', title: 'Borrow checker', symbol: '&', description: 'Try safe mode. Then turn off your better judgment.', code: `// Two mutable references walk into a runtime.
fn main() {
    let mut greeting = String::from("Hello");
    let first = &mut greeting;
    let second = &mut greeting;

    first.push_str(", world");
    second.push_str(". What could go wrong?");
    println!("{}", first);
}` },
  { id: 'moves', title: 'Ownership issues', symbol: '⇢', description: 'Even JavaScript can have commitment issues.', code: `fn main() {
    let original = String::from("This is mine.");
    let new_owner = original;

    println!("New owner: {}", new_owner);
    // Use original.clone() when moving to keep both.
    println!("Old owner: {}", original);
}` },
  { id: 'option', title: 'Option, maybe', symbol: '?', description: 'Some hope. None of the native performance.', code: `fn main() {
    let answer = Some(42);

    match answer {
        Some(value) => println!("Found the answer: {}", value),
        None => println!("Nothing here. Very JavaScript."),
    }
}` },
  { id: 'result', title: 'Results may vary', symbol: '✓', description: 'Error handling with plausible deniability.', code: `fn main() {
    let outcome = Err("JavaScript was a design decision.");

    match outcome {
        Ok(value) => println!("Success: {}", value),
        Err(reason) => println!("Well: {}", reason),
    }
}` },
  { id: 'structs', title: 'Structs & feelings', symbol: '{}', description: 'A little structure in an otherwise questionable project.', code: `struct Developer {
    name: String,
    confidence: i32,
}

fn main() {
    let dev = Developer {
        name: String::from("Ferris"),
        confidence: 100,
    };

    println!("{} has {}% confidence.", dev.name, dev.confidence);
}` },
  { id: 'functions', title: 'Functioning, barely', symbol: 'fn', description: 'Functions, arguments, and a suspiciously working return value.', code: `fn square(number: i32) -> i32 {
    number * number
}

fn main() {
    let result = square(7);
    println!("7 squared is {}. This part works.", result);
}` },
  { id: 'loops', title: 'Going in circles', symbol: '↻', description: 'Loops work. Infinite optimism has an execution limit.', code: `fn main() {
    let mut count = 0;

    while count < 3 {
        println!("Attempt {}: still JavaScript.", count + 1);
        count = count + 1;
    }

    println!("Fearless concurrency. Single-threaded.");
}` },
];
