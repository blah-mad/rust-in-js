/**
 * Rust.js: an intentionally small Rust-shaped interpreter written in JavaScript.
 * Source is tokenized and interpreted; it is never passed to eval or Function.
 * Ownership is checked at runtime, with conservative lexical borrow lifetimes.
 */

export const SUPPORTED_SUBSET = Object.freeze({
  ownership: "Runtime moves and conservative lexical borrow scopes",
  syntax: ["fn", "let / let mut", "blocks", "if / else", "loop / while", "for .. / ..=", "struct", "match", "return", "break", "continue"],
  values: ["numbers", "bool", "&str", "String", "struct", "Some / None", "Ok / Err", "& / &mut"],
  methods: ["clone", "len", "push_str", "unwrap", "expect", "is_some", "is_none", "is_ok", "is_err", "to_string"],
  limits: { sourceCharacters: 40000, tokens: 16000, nesting: 64, outputLines: 200, outputCharacters: 16000 },
});

const LIMITS = SUPPORTED_SUBSET.limits;
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const isString = (value) => value?.type === "str" || value?.type === "String";
const str = (text, owned = false) => ({ type: owned ? "String" : "str", text });
const unit = null;

class Diagnostic extends Error {
  constructor(code, message, token, hint = "") {
    super(message);
    this.detail = { code, message, line: token?.line ?? 1, column: token?.column ?? 1, hint };
  }
}

function fail(code, message, token, hint) {
  throw new Diagnostic(code, message, token, hint);
}

function tokenize(source) {
  const tokens = [];
  let index = 0, line = 1, column = 1;
  const advance = () => {
    const char = source[index++];
    if (char === "\n") { line++; column = 1; } else { column++; }
    return char;
  };
  const add = (kind, value, start) => {
    if (tokens.length >= LIMITS.tokens) fail("LIMIT_TOKENS", "This program has too many tokens.", start, "Keep the playground example below 16,000 tokens.");
    tokens.push({ kind, value, ...start });
  };
  while (index < source.length) {
    const char = source[index];
    const start = { line, column };
    if (/\s/.test(char)) { advance(); continue; }
    if (source.startsWith("//", index)) {
      while (index < source.length && source[index] !== "\n") advance();
      continue;
    }
    if (source.startsWith("/*", index)) {
      advance(); advance();
      let depth = 1;
      while (index < source.length && depth) {
        if (source.startsWith("/*", index)) { advance(); advance(); depth++; }
        else if (source.startsWith("*/", index)) { advance(); advance(); depth--; }
        else advance();
      }
      if (depth) fail("E0001", "Unclosed block comment.", start, "Close the comment with */.");
      continue;
    }
    if (char === '"') {
      advance();
      let text = "", closed = false;
      while (index < source.length) {
        const next = advance();
        if (next === '"') { closed = true; break; }
        if (next === "\\") {
          if (index >= source.length) break;
          const escape = advance();
          const escapes = { n: "\n", r: "\r", t: "\t", '"': '"', "\\": "\\", "0": "\0" };
          if (!own(escapes, escape)) fail("E0001", `Unsupported string escape \\${escape}.`, start, "Use \\n, \\t, \\r, \\\\, or \\\".");
          text += escapes[escape];
        } else text += next;
      }
      if (!closed) fail("E0001", "Unclosed string literal.", start, 'Add the closing double quote.');
      add("string", text, start);
      continue;
    }
    if (/[0-9]/.test(char)) {
      let number = "";
      while (index < source.length && /[0-9_]/.test(source[index])) number += advance();
      if (source[index] === "." && /[0-9]/.test(source[index + 1] ?? "")) {
        number += advance();
        while (index < source.length && /[0-9_]/.test(source[index])) number += advance();
      }
      const numericValue = Number(number.replaceAll("_", ""));
      if (!Number.isFinite(numericValue) || Number.isInteger(numericValue) && !Number.isSafeInteger(numericValue)) fail("LIMIT_NUMBER", "Number is outside JavaScript's safe numeric range.", start, "Use values within ±9,007,199,254,740,991.");
      // Numeric type suffixes are accepted as annotations; arithmetic uses JS numbers.
      const suffix = source.slice(index).match(/^(?:u(?:8|16|32|64|128|size)|i(?:8|16|32|64|128|size)|f(?:32|64))\b/);
      if (suffix) for (let k = 0; k < suffix[0].length; k++) advance();
      add("number", numericValue, start);
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      let identifier = "";
      while (index < source.length && /[A-Za-z0-9_]/.test(source[index])) identifier += advance();
      add("identifier", identifier, start);
      continue;
    }
    const operator = ["..=", "::", "=>", "->", "==", "!=", "<=", ">=", "&&", "||", "+=", "-=", "*=", "/=", "%=", ".."].find((item) => source.startsWith(item, index));
    if (operator) {
      for (let k = 0; k < operator.length; k++) advance();
      add("symbol", operator, start);
      continue;
    }
    if ("{}()[];,:.+-*/%=&!<>|?#".includes(char)) { add("symbol", advance(), start); continue; }
    fail("E0001", `Unexpected character ${JSON.stringify(char)}.`, start, "The playground supports a small Rust subset; remove this character.");
  }
  tokens.push({ kind: "eof", value: "<eof>", line, column });
  return tokens;
}

const PRECEDENCE = { "=": 1, "+=": 1, "-=": 1, "*=": 1, "/=": 1, "%=": 1, "..": 2, "..=": 2, "||": 3, "&&": 4, "==": 5, "!=": 5, "<": 6, ">": 6, "<=": 6, ">=": 6, "+": 7, "-": 7, "*": 8, "/": 8, "%": 8 };

class Parser {
  constructor(tokens) {
    this.tokens = tokens; this.index = 0; this.depth = 0; this.nodes = 0;
    this.structNames = new Set(tokens.filter((token, index) => index > 0 && tokens[index - 1].value === "struct" && token.kind === "identifier").map((token) => token.value));
  }
  current() { return this.tokens[this.index]; }
  peek(value) { return this.current().kind !== "string" && this.current().kind !== "number" && this.current().value === value; }
  take() { return this.tokens[this.index++]; }
  eat(value) { if (this.peek(value)) return this.take(); return null; }
  expect(value) {
    if (!this.peek(value)) fail("E0001", `Expected ${JSON.stringify(value)}, found ${JSON.stringify(this.current().value)}.`, this.current(), "Check the punctuation near this position.");
    return this.take();
  }
  name() {
    const token = this.take();
    if (token.kind !== "identifier") fail("E0001", "Expected a name.", token);
    return token;
  }
  nested(callback) {
    if (++this.depth > LIMITS.nesting) fail("LIMIT_NESTING", "Program nesting is too deep.", this.current(), "Use fewer nested expressions or blocks.");
    try { return callback(); } finally { this.depth--; }
  }
  node(type, token, fields = {}) {
    if (++this.nodes > LIMITS.tokens) fail("LIMIT_AST", "This program is too large.", token);
    return { type, token, ...fields };
  }
  annotation(stops) {
    const parts = [];
    let angle = 0, square = 0, paren = 0;
    while (this.current().kind !== "eof") {
      const value = this.current().value;
      if (!angle && !square && !paren && stops.includes(value)) break;
      if (value === "<") angle++;
      if (value === ">") angle--;
      if (value === "[") square++;
      if (value === "]") square--;
      if (value === "(") paren++;
      if (value === ")") paren--;
      if (angle < 0 || square < 0 || paren < 0 || ["{", "}", ";"].includes(value)) break;
      parts.push(this.take().value);
    }
    if (!parts.length) fail("E0001", "Expected a type annotation.", this.current());
    return parts.join(" ");
  }
  program() {
    const functions = new Map(), structs = new Map();
    while (this.current().kind !== "eof") {
      if (this.eat("#")) {
        this.expect("[");
        let count = 1;
        while (count && this.current().kind !== "eof") { const t = this.take(); if (t.value === "[") count++; if (t.value === "]") count--; }
        if (count) fail("E0001", "Unclosed attribute.", this.current());
        continue;
      }
      this.eat("pub");
      if (this.eat("fn")) {
        const name = this.name();
        if (functions.has(name.value)) fail("E0428", `Function ${name.value} is defined twice.`, name);
        this.expect("(");
        const parameters = [];
        while (!this.peek(")")) {
          const mutable = !!this.eat("mut");
          const parameter = this.name();
          const annotation = this.eat(":") ? this.annotation([",", ")"]) : "";
          parameters.push({ name: parameter.value, mutable, annotation, token: parameter });
          if (!this.eat(",")) break;
        }
        this.expect(")");
        const returnType = this.eat("->") ? this.annotation(["{"]) : "";
        const body = this.block();
        functions.set(name.value, { name: name.value, token: name, parameters, returnType, body });
      } else if (this.eat("struct")) {
        const name = this.name();
        if (structs.has(name.value)) fail("E0428", `Struct ${name.value} is defined twice.`, name);
        this.structNames.add(name.value);
        this.expect("{");
        const fields = [];
        while (!this.peek("}")) {
          this.eat("pub");
          const field = this.name();
          this.expect(":");
          const annotation = this.annotation([",", "}"]);
          if (fields.some((entry) => entry.name === field.value)) fail("E0124", `Field ${field.value} is declared twice.`, field);
          fields.push({ name: field.value, annotation, token: field });
          if (!this.eat(",")) break;
        }
        this.expect("}");
        structs.set(name.value, { name: name.value, fields, token: name });
      } else fail("E0658", `Expected fn or struct, found ${JSON.stringify(this.current().value)}.`, this.current(), "Put executable statements inside fn main() { ... }.");
    }
    if (!functions.has("main")) fail("E0601", "No main function found.", this.tokens[0], "Add fn main() { ... } as the program's entry point.");
    return { functions, structs };
  }
  block() {
    return this.nested(() => {
      const token = this.expect("{");
      const statements = [];
      let tail = null;
      while (!this.peek("}")) {
        if (this.current().kind === "eof") fail("E0001", "Unclosed block.", token, "Add a closing }.");
        if (this.eat(";")) continue;
        if (this.peek("let")) { statements.push(this.letStatement()); continue; }
        if (this.peek("loop")) {
          const keyword = this.take();
          const condition = this.node("literal", keyword, { value: true });
          statements.push(this.node("while", keyword, { condition, body: this.block() }));
          continue;
        }
        if (this.peek("while")) {
          const keyword = this.take();
          const condition = this.expression();
          statements.push(this.node("while", keyword, { condition, body: this.block() }));
          continue;
        }
        if (this.peek("for")) {
          const keyword = this.take(), name = this.name();
          this.expect("in");
          const range = this.expression();
          statements.push(this.node("for", keyword, { name: name.value, range, body: this.block() }));
          continue;
        }
        if (this.peek("return")) {
          const keyword = this.take();
          const value = this.peek(";") || this.peek("}") ? null : this.expression();
          this.eat(";");
          statements.push(this.node("return", keyword, { value }));
          continue;
        }
        if (this.peek("break") || this.peek("continue")) {
          const keyword = this.take();
          this.eat(";");
          statements.push(this.node(keyword.value, keyword));
          continue;
        }
        const expression = this.expression();
        if (this.eat(";")) statements.push(this.node("expression", expression.token, { expression }));
        else if (this.peek("}")) { tail = expression; break; }
        else if (["if", "block", "match"].includes(expression.type)) statements.push(this.node("expression", expression.token, { expression }));
        else fail("E0001", "Expected a semicolon after this expression.", this.current(), "Add ; at the end of the statement.");
      }
      this.expect("}");
      return this.node("block", token, { statements, tail });
    });
  }
  letStatement() {
    const token = this.expect("let"), mutable = !!this.eat("mut"), name = this.name();
    const annotation = this.eat(":") ? this.annotation(["="]) : "";
    this.expect("=");
    const value = this.expression();
    this.expect(";");
    return this.node("let", token, { name: name.value, mutable, annotation, value, nameToken: name });
  }
  expression(minimum = 0) {
    return this.nested(() => {
      let left = this.prefix();
      while (true) {
        if (this.peek("(")) {
          const token = this.take(), args = this.arguments(")");
          left = this.node("call", token, { callee: left, args });
          continue;
        }
        if (this.eat(".")) {
          const member = this.name();
          if (this.eat("(")) left = this.node("method", member, { object: left, name: member.value, args: this.arguments(")") });
          else left = this.node("member", member, { object: left, name: member.value });
          continue;
        }
        if (this.peek("!") && left.type === "path") {
          const token = this.take();
          this.expect("(");
          left = this.node("macro", token, { name: left.parts.join("::"), args: this.arguments(")") });
          continue;
        }
        const operator = this.current().value, precedence = PRECEDENCE[operator];
        if (precedence === undefined || precedence < minimum) break;
        const token = this.take();
        const right = this.expression(precedence + (precedence === 1 ? 0 : 1));
        left = this.node(precedence === 1 ? "assign" : operator === ".." || operator === "..=" ? "range" : "binary", token, { operator, left, right });
      }
      return left;
    });
  }
  arguments(end) {
    const args = [];
    while (!this.peek(end)) {
      args.push(this.expression());
      if (!this.eat(",")) break;
    }
    this.expect(end);
    return args;
  }
  prefix() {
    const token = this.current();
    if (this.eat("&")) {
      const mutable = !!this.eat("mut");
      return this.node("borrow", token, { mutable, value: this.expression(9) });
    }
    if (token.kind === "symbol" && ["!", "-", "*"].includes(token.value)) { this.take(); return this.node("unary", token, { operator: token.value, value: this.expression(9) }); }
    if (token.kind === "number" || token.kind === "string") { this.take(); return this.node("literal", token, { value: token.kind === "string" ? str(token.value) : token.value }); }
    if (this.eat("true")) return this.node("literal", token, { value: true });
    if (this.eat("false")) return this.node("literal", token, { value: false });
    if (this.eat("(")) {
      if (this.eat(")")) return this.node("literal", token, { value: unit });
      const value = this.expression(); this.expect(")"); return value;
    }
    if (this.peek("{")) return this.block();
    if (this.eat("if")) {
      const condition = this.expression(), yes = this.block();
      let no = null;
      if (this.eat("else")) no = this.peek("if") ? this.prefix() : this.block();
      return this.node("if", token, { condition, yes, no });
    }
    if (this.eat("match")) {
      const value = this.expression();
      this.expect("{");
      const arms = [];
      while (!this.peek("}")) {
        const pattern = this.pattern();
        const guard = this.eat("if") ? this.expression() : null;
        this.expect("=>");
        const expression = this.expression();
        arms.push({ pattern, guard, expression });
        if (!this.eat(",") && !this.peek("}") && expression.type !== "block") this.expect(",");
      }
      this.expect("}");
      return this.node("match", token, { value, arms });
    }
    if (token.kind === "identifier") {
      const parts = [this.take().value];
      while (this.eat("::")) parts.push(this.name().value);
      if (this.peek("{") && this.structNames.has(parts.join("::"))) {
        this.take();
        const fields = [];
        while (!this.peek("}")) {
          const name = this.name();
          const value = this.eat(":") ? this.expression() : this.node("path", name, { parts: [name.value] });
          if (fields.some((entry) => entry.name === name.value)) fail("E0062", `Field ${name.value} is supplied twice.`, name);
          fields.push({ name: name.value, value, token: name });
          if (!this.eat(",")) break;
        }
        this.expect("}");
        return this.node("struct", token, { name: parts.join("::"), fields });
      }
      return this.node("path", token, { parts });
    }
    fail("E0001", `Expected an expression, found ${JSON.stringify(token.value)}.`, token, "Try a value, variable, function call, or block.");
  }
  pattern() {
    return this.nested(() => {
      const token = this.take();
      if (token.kind === "identifier" && token.value === "_") return { type: "wildcard", token };
      if (token.kind === "string" || token.kind === "number" || token.value === "true" || token.value === "false") {
        return { type: "literal", token, value: token.kind === "string" ? str(token.value) : token.value === "true" ? true : token.value === "false" ? false : token.value };
      }
      let mutable = false, name = token;
      if (token.value === "mut") { mutable = true; name = this.name(); }
      if (name.kind !== "identifier") fail("E0001", "Expected a match pattern.", name);
      const parts = [name.value];
      while (this.eat("::")) parts.push(this.name().value);
      const tag = parts.at(-1);
      if (["Some", "Ok", "Err"].includes(tag)) {
        this.expect("("); const inner = this.pattern(); this.expect(")");
        return { type: "variant", token, tag, inner };
      }
      if (tag === "None") return { type: "variant", token, tag, inner: null };
      if (parts.length > 1) fail("E0658", "This match pattern is outside the supported subset.", token);
      return { type: "binding", token, name: name.value, mutable };
    });
  }
}

class Scope {
  constructor(parent, id) { this.parent = parent; this.id = id; this.cells = new Map(); this.borrowIds = []; }
  find(name) { return this.cells.get(name) ?? this.parent?.find(name) ?? null; }
}

class Flow {
  constructor(kind, value = unit, token = null) { this.kind = kind; this.value = value; this.token = token; }
}

function copyable(value, depth = 0) {
  if (depth > LIMITS.nesting) return false;
  if (value === null || typeof value !== "object") return true;
  if (value.type === "str") return true;
  if (value.type === "ref") return !value.mutable;
  if (value.type === "enum") return copyable(value.data, depth + 1);
  return false;
}

function cloneValue(value, depth = 0, visit = () => {}) {
  visit();
  if (depth > LIMITS.nesting) fail("LIMIT_NESTING", "Value nesting is too deep.", null);
  if (value === null || typeof value !== "object") return value;
  if (isString(value)) return str(value.text, value.type === "String");
  if (value.type === "enum") return { type: "enum", tag: value.tag, data: cloneValue(value.data, depth + 1, visit) };
  if (value.type === "struct") return { type: "struct", name: value.name, fields: Object.fromEntries(Object.entries(value.fields).map(([key, entry]) => [key, cloneValue(entry, depth + 1, visit)])), movedFields: new Set(value.movedFields) };
  return value;
}

class Runtime {
  constructor(program, options) {
    this.program = program; this.unsafe = options.unsafe === true;
    this.maxSteps = Number.isFinite(options.maxSteps) ? Math.max(1, Math.min(200000, Math.floor(options.maxSteps))) : 10000;
    this.steps = 0; this.stdout = []; this.outputCharacters = 0; this.outputOpen = false; this.borrowHistory = []; this.borrowRecords = new Map();
    this.scopeCounter = 0; this.borrowCounter = 0; this.callDepth = 0; this.loopDepth = 0;
    this.warnings = this.unsafe ? ["Unsafe mode bypasses borrow conflicts and moved-value checks. Mutability and execution limits still apply."] : [];
    this.global = new Scope(null, ++this.scopeCounter);
  }
  tick(token) {
    if (this.steps >= this.maxSteps) fail("LIMIT_STEPS", `Execution stopped after ${this.maxSteps.toLocaleString("en-US")} steps.`, token, "Shorten the loop or increase maxSteps for trusted examples.");
    this.steps++;
  }
  scope(parent) { return new Scope(parent, ++this.scopeCounter); }
  release(scope) {
    for (const id of scope.borrowIds) {
      const record = this.borrowRecords.get(id);
      if (record) { record.active = false; record.cell?.borrows.delete(record); delete record.cell; }
    }
  }
  bind(scope, name, value, mutable, token) {
    const cell = { name, value, mutable, moved: false, token, scopeId: scope.id, borrows: new Set() };
    scope.cells.set(name, cell); return cell;
  }
  cell(name, scope, token) {
    const cell = scope.find(name);
    if (!cell) fail("E0425", `Cannot find value \`${name}\` in this scope.`, token, "Declare it with let before using it.");
    return cell;
  }
  active(cell, except = null) {
    const ignored = new Set();
    let id = except;
    while (id !== null && id !== undefined && !ignored.has(id)) { ignored.add(id); id = this.borrowRecords.get(id)?.parentId; }
    return [...cell.borrows].filter((record) => record.active && !ignored.has(record.id));
  }
  checkMoved(cell, token) {
    if (cell.moved && !this.unsafe) fail("E0382", `Use of moved value \`${cell.name}\`.`, token, `Use ${cell.name}.clone() before moving it, or use a reference.`);
  }
  checkAccess(location, action, token, allowMoved = false) {
    if (!allowMoved) this.checkMoved(location.cell, token);
    if (this.unsafe) return;
    const borrows = this.active(location.cell, location.via);
    const conflicts = action === "read" ? borrows.filter((record) => record.kind === "mutable") : borrows;
    if (conflicts.length) {
      const previous = conflicts[0];
      fail(action === "read" ? "E0502" : "E0505", `Cannot ${action} \`${location.cell.name}\` while it is borrowed ${previous.kind === "mutable" ? "mutably" : "immutably"}.`, token, `The borrow from line ${previous.line} lasts until its enclosing block ends. Use a separate { ... } scope.`);
    }
  }
  dereference(value, token, depth = 0) {
    if (depth > LIMITS.nesting) fail("LIMIT_NESTING", "Too many nested references.", token);
    if (value?.type !== "ref") return value;
    if (!this.unsafe && !this.borrowRecords.get(value.borrowId)?.active) fail("E0597", "This reference outlived its borrowing scope.", token, "Keep the reference inside the { ... } block where it was created.");
    this.checkAccess(value.location, "read", token);
    return this.dereference(this.getLocation(value.location, token), token, depth + 1);
  }
  getLocation(location, token) {
    if (location.via !== null && location.via !== undefined && !this.unsafe && !this.borrowRecords.get(location.via)?.active) fail("E0597", "This reference outlived its borrowing scope.", token, "Keep the reference inside the { ... } block where it was created.");
    this.checkMoved(location.cell, token);
    let value = location.cell.value;
    for (const field of location.fields) {
      if (value?.type !== "struct" || !own(value.fields, field)) fail("E0609", `No field \`${field}\` on this value.`, token);
      if (value.movedFields.has(field) && !this.unsafe) fail("E0382", `Use of moved field \`${field}\`.`, token, "Clone the field before moving it.");
      value = value.fields[field];
    }
    return value;
  }
  location(expression, scope) {
    if (expression.type === "path" && expression.parts.length === 1) {
      return { cell: this.cell(expression.parts[0], scope, expression.token), fields: [], via: null, throughMutableRef: false };
    }
    if (expression.type === "unary" && expression.operator === "*") {
      const reference = this.evaluate(expression.value, scope);
      if (reference?.type !== "ref") fail("E0614", "This value cannot be dereferenced.", expression.token, "Use * with a reference created by & or &mut.");
      return { ...reference.location, via: reference.borrowId, throughMutableRef: reference.mutable };
    }
    if (expression.type === "member") {
      let location = this.location(expression.object, scope);
      let value = this.getLocation(location, expression.token);
      while (value?.type === "ref") {
        location = { ...value.location, via: value.borrowId, throughMutableRef: value.mutable };
        value = this.getLocation(location, expression.token);
      }
      if (value?.type !== "struct" || !own(value.fields, expression.name)) fail("E0609", `No field \`${expression.name}\` on this value.`, expression.token);
      return { ...location, fields: [...location.fields, expression.name] };
    }
    fail("E0070", "This expression is not an assignable value.", expression.token, "Use a variable, a struct field, or *reference.");
  }
  readLocation(location, token, mode = "read") {
    this.checkAccess(location, mode === "move" && !copyable(this.getLocation(location, token)) ? "move" : "read", token);
    const value = this.getLocation(location, token);
    if (mode === "move" && !copyable(value)) {
      if (location.via !== null && !this.unsafe) fail("E0507", "Cannot move an owned value out of a borrowed reference.", token, "Use .clone() to make an owned copy.");
      if (!location.fields.length) location.cell.moved = true;
      else {
        const parent = this.getLocation({ ...location, fields: location.fields.slice(0, -1) }, token);
        parent.movedFields.add(location.fields.at(-1));
      }
    }
    if (value?.type === "struct" && value.movedFields.size && !this.unsafe) fail("E0382", `Use of partially moved value \`${location.cell.name}\`.`, token, "Clone owned fields before moving them out of a struct.");
    return value;
  }
  writable(location, token, allowMoved = false) {
    if (location.via !== null ? !location.throughMutableRef : !location.cell.mutable) {
      fail("E0594", `Cannot mutate \`${location.cell.name}\` because it is immutable.`, token, location.via !== null ? "Create the reference with &mut." : `Declare it with let mut ${location.cell.name} = ...;`);
    }
    this.checkAccess(location, "write", token, allowMoved);
  }
  setLocation(location, value, token, allowMoved = false) {
    this.writable(location, token, allowMoved);
    if (!location.fields.length) { location.cell.value = value; location.cell.moved = false; return; }
    const parent = this.getLocation({ ...location, fields: location.fields.slice(0, -1) }, token);
    parent.fields[location.fields.at(-1)] = value;
    parent.movedFields.delete(location.fields.at(-1));
  }
  borrow(expression, scope) {
    let location = this.location(expression.value, scope);
    // Reborrows of a reference refer to its target, preserving shared/mutable access.
    const raw = this.getLocation(location, expression.token);
    if (raw?.type === "ref" && expression.value.type === "unary") location = { ...raw.location, via: raw.borrowId, throughMutableRef: raw.mutable };
    this.checkMoved(location.cell, expression.token);
    if (expression.mutable && (location.via !== null ? !location.throughMutableRef : !location.cell.mutable)) {
      fail("E0596", `Cannot borrow \`${location.cell.name}\` as mutable because it is immutable.`, expression.token, `Declare it with let mut ${location.cell.name} = ...;`);
    }
    const existing = this.active(location.cell, location.via);
    const conflict = expression.mutable ? existing[0] : existing.find((record) => record.kind === "mutable");
    if (conflict && !this.unsafe) {
      fail(expression.mutable && conflict.kind === "mutable" ? "E0499" : "E0502", `Cannot borrow \`${location.cell.name}\` ${expression.mutable ? "mutably" : "immutably"} while another ${conflict.kind} borrow is active.`, expression.token, `The first borrow starts on line ${conflict.line}. Put each borrow in its own { ... } block, or enable Unsafe mode.`);
    }
    const record = { id: ++this.borrowCounter, parentId: location.via, cell: location.cell, name: location.cell.name, kind: expression.mutable ? "mutable" : "shared", line: expression.token.line, column: expression.token.column, scope: scope.id, active: true };
    this.borrowHistory.push(record); this.borrowRecords.set(record.id, record); location.cell.borrows.add(record); scope.borrowIds.push(record.id);
    return { type: "ref", mutable: expression.mutable, borrowId: record.id, location: { ...location, via: record.id, throughMutableRef: expression.mutable } };
  }
  bool(value, token) {
    value = this.dereference(value, token);
    if (typeof value !== "boolean") fail("E0308", "Expected a bool condition.", token, "Use a comparison such as count < 5.");
    return value;
  }
  number(value, token) {
    value = this.dereference(value, token);
    if (typeof value !== "number") fail("E0308", "Expected a number.", token);
    return value;
  }
  text(value, token) {
    value = this.dereference(value, token);
    if (!isString(value)) fail("E0308", "Expected a string.", token);
    return value.text;
  }
  checkedString(text, token, owned = true) {
    if (text.length > LIMITS.sourceCharacters) fail("LIMIT_STRING", "A string grew beyond 40,000 characters.", token, "Use smaller strings in the playground.");
    return str(text, owned);
  }
  display(value, token, debug = false, depth = 0, budget = { remaining: LIMITS.outputCharacters }) {
    if (depth > LIMITS.nesting) fail("LIMIT_NESTING", "Value nesting is too deep to print.", token);
    value = this.dereference(value, token);
    const emit = (text) => {
      budget.remaining -= text.length;
      if (budget.remaining < 0) fail("LIMIT_OUTPUT", "Formatted output is too large.", token, "Print a smaller value (maximum 16,000 characters).");
      return text;
    };
    if (isString(value)) return emit(debug ? JSON.stringify(value.text) : value.text);
    if (value === null || value === undefined) return emit("()");
    if (typeof value === "number" || typeof value === "boolean") return emit(String(value));
    if (value.type === "enum") return value.tag === "None" ? emit("None") : emit(`${value.tag}(`) + this.display(value.data, token, debug, depth + 1, budget) + emit(")");
    if (value.type === "struct") {
      let text = emit(`${value.name} { `), first = true;
      for (const [name, field] of Object.entries(value.fields)) {
        text += emit(`${first ? "" : ", "}${name}: `) + this.display(field, token, true, depth + 1, budget); first = false;
      }
      return text + emit(" }");
    }
    fail("E0277", "This value cannot be printed.", token);
  }
  output(text, newline, token) {
    const rendered = text + (newline ? "\n" : "");
    if (this.outputCharacters + rendered.length > LIMITS.outputCharacters) fail("LIMIT_OUTPUT", "Output limit reached.", token, "Print fewer characters (maximum 16,000).");
    const fragments = rendered.split("\n");
    for (let index = 0; index < fragments.length; index++) {
      const fragment = fragments[index], closesLine = index < fragments.length - 1;
      if (!this.outputOpen && (fragment.length || closesLine)) {
        if (this.stdout.length >= LIMITS.outputLines) fail("LIMIT_OUTPUT", "Output line limit reached.", token, "Print fewer lines (maximum 200).");
        this.stdout.push(""); this.outputOpen = true;
      }
      if (this.outputOpen) this.stdout[this.stdout.length - 1] += fragment;
      if (closesLine) this.outputOpen = false;
    }
    this.outputCharacters += rendered.length;
  }
  binary(operator, left, right, token) {
    left = this.dereference(left, token); right = this.dereference(right, token);
    if (["==", "!="].includes(operator)) {
      const equals = isString(left) && isString(right) ? left.text === right.text : left?.type === "enum" && right?.type === "enum" ? left.tag === right.tag && this.display(left, token, true) === this.display(right, token, true) : left === right;
      return operator === "==" ? equals : !equals;
    }
    if (["<", ">", "<=", ">="].includes(operator)) {
      const a = isString(left) ? left.text : this.number(left, token), b = isString(right) ? right.text : this.number(right, token);
      if (typeof a !== typeof b) fail("E0308", "Comparison operands have different types.", token);
      return operator === "<" ? a < b : operator === ">" ? a > b : operator === "<=" ? a <= b : a >= b;
    }
    if (operator === "+" && isString(left) && isString(right)) return this.checkedString(left.text + right.text, token);
    const a = this.number(left, token), b = this.number(right, token);
    if ((operator === "/" || operator === "%") && b === 0) fail("PANIC", "Attempt to divide by zero.", token, "Check the divisor before dividing.");
    let result = operator === "+" ? a + b : operator === "-" ? a - b : operator === "*" ? a * b : operator === "/" ? Number.isInteger(a) && Number.isInteger(b) ? Math.trunc(a / b) : a / b : a % b;
    if (!Number.isFinite(result) || Number.isInteger(result) && !Number.isSafeInteger(result)) fail("LIMIT_NUMBER", "Arithmetic exceeded JavaScript's safe numeric range.", token, "Use values within the safe integer range (±9,007,199,254,740,991).");
    return result;
  }
  block(block, parent, mode = "read") {
    const scope = this.scope(parent);
    try {
      for (const statement of block.statements) this.statement(statement, scope);
      return block.tail ? this.evaluate(block.tail, scope, mode) : unit;
    } finally { this.release(scope); }
  }
  statement(statement, scope) {
    this.tick(statement.token);
    switch (statement.type) {
      case "let": this.bind(scope, statement.name, this.evaluate(statement.value, scope, "move"), statement.mutable, statement.nameToken); return;
      case "expression": this.evaluate(statement.expression, scope); return;
      case "return": throw new Flow("return", statement.value ? this.evaluate(statement.value, scope, "move") : unit, statement.token);
      case "break": case "continue":
        if (!this.loopDepth) fail("E0268", `${statement.type} used outside a loop.`, statement.token);
        throw new Flow(statement.type, unit, statement.token);
      case "while": {
        this.loopDepth++;
        try {
          while (this.bool(this.evaluate(statement.condition, scope), statement.token)) {
            this.tick(statement.token);
            try { this.block(statement.body, scope); } catch (flow) { if (!(flow instanceof Flow) || flow.kind === "return") throw flow; if (flow.kind === "break") break; }
          }
        } finally { this.loopDepth--; }
        return;
      }
      case "for": {
        const range = this.evaluate(statement.range, scope);
        if (range?.type !== "range") fail("E0277", "This for loop expects a numeric range.", statement.token, "Use for i in 0..5 { ... }.");
        this.loopDepth++;
        try {
          for (let number = range.start; range.inclusive ? number <= range.end : number < range.end; number++) {
            this.tick(statement.token);
            const iteration = this.scope(scope); this.bind(iteration, statement.name, number, false, statement.token);
            try { this.block(statement.body, iteration); } catch (flow) { if (!(flow instanceof Flow) || flow.kind === "return") throw flow; if (flow.kind === "break") break; }
            finally { this.release(iteration); }
          }
        } finally { this.loopDepth--; }
        return;
      }
      default: fail("INTERNAL", "Unknown statement.", statement.token);
    }
  }
  evaluate(expression, scope, mode = "read") {
    this.tick(expression.token);
    switch (expression.type) {
      case "literal": return expression.value;
      case "path": {
        const name = expression.parts.join("::");
        if (name === "None" || name === "Option::None") return { type: "enum", tag: "None", data: unit };
        if (expression.parts.length !== 1) fail("E0425", `Cannot find value \`${name}\`.`, expression.token);
        return this.readLocation(this.location(expression, scope), expression.token, mode);
      }
      case "borrow": return this.borrow(expression, scope);
      case "member": return this.readLocation(this.location(expression, scope), expression.token, mode);
      case "unary": {
        if (expression.operator === "*") return this.readLocation(this.location(expression, scope), expression.token, mode);
        const value = this.evaluate(expression.value, scope);
        return expression.operator === "!" ? !this.bool(value, expression.token) : -this.number(value, expression.token);
      }
      case "binary": {
        const left = this.evaluate(expression.left, scope);
        if (expression.operator === "&&") return this.bool(left, expression.token) && this.bool(this.evaluate(expression.right, scope), expression.token);
        if (expression.operator === "||") return this.bool(left, expression.token) || this.bool(this.evaluate(expression.right, scope), expression.token);
        return this.binary(expression.operator, left, this.evaluate(expression.right, scope), expression.token);
      }
      case "range": {
        const start = this.number(this.evaluate(expression.left, scope), expression.token), end = this.number(this.evaluate(expression.right, scope), expression.token);
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) fail("E0308", "Range bounds must be safe integers.", expression.token);
        return { type: "range", start, end, inclusive: expression.operator === "..=" };
      }
      case "assign": {
        const location = this.location(expression.left, scope);
        const allowMoved = expression.operator === "=" && !location.fields.length;
        this.writable(location, expression.token, allowMoved);
        const right = this.evaluate(expression.right, scope, "move");
        const value = expression.operator === "=" ? right : this.binary(expression.operator.slice(0, -1), this.getLocation(location, expression.token), right, expression.token);
        this.setLocation(location, value, expression.token, allowMoved); return unit;
      }
      case "block": return this.block(expression, scope, mode);
      case "if": return this.bool(this.evaluate(expression.condition, scope), expression.token) ? this.block(expression.yes, scope, mode) : expression.no ? this.evaluate(expression.no, scope, mode) : unit;
      case "struct": {
        const definition = this.program.structs.get(expression.name);
        if (!definition) fail("E0422", `Cannot find struct \`${expression.name}\`.`, expression.token);
        const fields = Object.create(null);
        for (const field of expression.fields) {
          if (!definition.fields.some((entry) => entry.name === field.name)) fail("E0560", `Struct \`${expression.name}\` has no field \`${field.name}\`.`, field.token);
          fields[field.name] = this.evaluate(field.value, scope, "move");
        }
        const missing = definition.fields.find((field) => !own(fields, field.name));
        if (missing) fail("E0063", `Missing field \`${missing.name}\` in ${expression.name}.`, expression.token);
        return { type: "struct", name: expression.name, fields, movedFields: new Set() };
      }
      case "match": {
        const value = this.dereference(this.evaluate(expression.value, scope, "move"), expression.token);
        for (const arm of expression.arms) {
          const bindings = [];
          if (!this.matches(arm.pattern, value, bindings)) continue;
          const armScope = this.scope(scope);
          for (const binding of bindings) this.bind(armScope, binding.name, binding.value, binding.mutable, binding.token);
          try {
            if (arm.guard && !this.bool(this.evaluate(arm.guard, armScope), arm.guard.token)) continue;
            return this.evaluate(arm.expression, armScope, mode);
          } finally { this.release(armScope); }
        }
        fail("E0004", "No match arm covered this value.", expression.token, "Add the missing variant or a wildcard arm: _ => ...");
      }
      case "call": return this.call(expression, scope);
      case "macro": return this.macro(expression, scope);
      case "method": return this.method(expression, scope);
      default: fail("INTERNAL", "Unknown expression.", expression.token);
    }
  }
  matches(pattern, value, bindings) {
    if (pattern.type === "wildcard") return true;
    if (pattern.type === "binding") { bindings.push({ ...pattern, value }); return true; }
    if (pattern.type === "literal") return this.binary("==", pattern.value, value, pattern.token);
    if (pattern.type === "variant") return value?.type === "enum" && value.tag === pattern.tag && (!pattern.inner || this.matches(pattern.inner, value.data, bindings));
    return false;
  }
  call(expression, scope) {
    if (expression.callee.type !== "path") fail("E0658", "Only named functions can be called in this playground.", expression.token);
    const name = expression.callee.parts.join("::"), tag = expression.callee.parts.at(-1);
    if (["Some", "Ok", "Err"].includes(tag) && [tag, `Option::${tag}`, `Result::${tag}`].includes(name)) {
      this.arity(expression, 1);
      return { type: "enum", tag, data: this.evaluate(expression.args[0], scope, "move") };
    }
    if (name === "String::from") {
      this.arity(expression, 1);
      return this.checkedString(this.text(this.evaluate(expression.args[0], scope), expression.token), expression.token);
    }
    if (name === "String::new") { this.arity(expression, 0); return str("", true); }
    const fn = this.program.functions.get(name);
    if (!fn) fail("E0425", `Cannot find function \`${name}\`.`, expression.callee.token, "Try String::from, Some, Ok, Err, or a function declared in this program.");
    this.arity(expression, fn.parameters.length);
    const args = expression.args.map((arg) => this.evaluate(arg, scope, "move"));
    return this.invoke(fn, args, expression.token);
  }
  arity(expression, expected) {
    if (expression.args.length !== expected) fail("E0061", `Expected ${expected} argument${expected === 1 ? "" : "s"}, received ${expression.args.length}.`, expression.token);
  }
  invoke(fn, args, token) {
    this.tick(token);
    if (++this.callDepth > 64) { this.callDepth--; fail("LIMIT_CALLS", "Function calls are nested too deeply.", token, "Check the recursion's stopping condition."); }
    const scope = this.scope(this.global), previousLoopDepth = this.loopDepth;
    this.loopDepth = 0;
    try {
      fn.parameters.forEach((parameter, index) => this.bind(scope, parameter.name, args[index], parameter.mutable, parameter.token));
      try { return this.block(fn.body, scope, "move"); } catch (flow) { if (flow instanceof Flow && flow.kind === "return") return flow.value; throw flow; }
    } finally { this.release(scope); this.loopDepth = previousLoopDepth; this.callDepth--; }
  }
  format(expression, scope) {
    if (!expression.args.length) return "";
    const format = this.text(this.evaluate(expression.args[0], scope), expression.token);
    const args = expression.args.slice(1).map((arg) => this.evaluate(arg, scope));
    let output = "", index = 0, argument = 0, used = new Set();
    while (index < format.length) {
      const char = format[index++];
      if (char === "{" && format[index] === "{") { index++; output += "{"; continue; }
      if (char === "}" && format[index] === "}") { index++; output += "}"; continue; }
      if (char === "}") fail("E0001", "Unmatched } in the format string.", expression.token, "Use }} to print a literal brace.");
      if (char !== "{") { output += char; continue; }
      const close = format.indexOf("}", index);
      if (close === -1) fail("E0001", "Unclosed placeholder in the format string.", expression.token);
      const specifier = format.slice(index, close), match = specifier.match(/^(\d*|[A-Za-z_][A-Za-z0-9_]*)?(?::(\?|#\?))?$/);
      if (!match) fail("E0658", `Unsupported format placeholder {${specifier}}.`, expression.token, "Use {}, {:?}, {:#?}, {0}, or {variable}.");
      const key = match[1] ?? "", debug = !!match[2];
      let value;
      if (/^[A-Za-z_]/.test(key)) value = this.readLocation({ cell: this.cell(key, scope, expression.token), fields: [], via: null }, expression.token);
      else {
        const selected = key === "" ? argument++ : Number(key);
        if (selected >= args.length) fail("E0061", "The format string has more placeholders than arguments.", expression.token);
        used.add(selected); value = args[selected];
      }
      output += this.display(value, expression.token, debug); index = close + 1;
      if (output.length > LIMITS.outputCharacters) fail("LIMIT_OUTPUT", "Formatted output is too large.", expression.token);
    }
    if (used.size < args.length) fail("E0061", "An argument has no placeholder in the format string.", expression.token, "Add a {} placeholder for each argument.");
    return output;
  }
  macro(expression, scope) {
    if (["println", "print", "format", "panic"].includes(expression.name)) {
      const text = this.format(expression, scope);
      if (expression.name === "format") return this.checkedString(text, expression.token);
      if (expression.name === "panic") fail("PANIC", text || "Explicit panic.", expression.token, "Inspect the value before panicking.");
      this.output(text, expression.name === "println", expression.token); return unit;
    }
    if (expression.name === "assert") {
      if (!expression.args.length) fail("E0061", "assert! requires a condition.", expression.token);
      if (!this.bool(this.evaluate(expression.args[0], scope), expression.token)) fail("PANIC", "Assertion failed.", expression.token);
      return unit;
    }
    fail("E0658", `Macro \`${expression.name}!\` is not supported.`, expression.token, "Try println! or format!.");
  }
  method(expression, scope) {
    const name = expression.name;
    if (name === "push_str") {
      this.arity(expression, 1);
      let location = this.location(expression.object, scope), value = this.getLocation(location, expression.token);
      while (value?.type === "ref") { location = { ...value.location, via: value.borrowId, throughMutableRef: value.mutable }; value = this.getLocation(location, expression.token); }
      this.writable(location, expression.token);
      if (value?.type !== "String") fail("E0599", "push_str is available on owned String values.", expression.token, "Create a String with String::from(...).");
      const extra = this.text(this.evaluate(expression.args[0], scope), expression.token);
      const next = this.checkedString(value.text + extra, expression.token);
      // Mutate the allocation so an unsafe alias observes the same underlying String.
      value.text = next.text; return unit;
    }
    this.arity(expression, name === "expect" ? 1 : 0);
    const value = this.dereference(this.evaluate(expression.object, scope, name === "unwrap" || name === "expect" ? "move" : "read"), expression.token);
    if (name === "clone") return cloneValue(value, 0, () => this.tick(expression.token));
    if (name === "to_string") return this.checkedString(this.display(value, expression.token), expression.token);
    if (name === "len") {
      if (!isString(value)) fail("E0599", "len is available on strings in this playground.", expression.token);
      // Rust String::len counts UTF-8 bytes.
      return new TextEncoder().encode(value.text).length;
    }
    if (["unwrap", "expect", "is_some", "is_none", "is_ok", "is_err"].includes(name)) {
      if (value?.type !== "enum") fail("E0599", `${name} is available on Option / Result values.`, expression.token);
      if (name === "is_some") return value.tag === "Some";
      if (name === "is_none") return value.tag === "None";
      if (name === "is_ok") return value.tag === "Ok";
      if (name === "is_err") return value.tag === "Err";
      const message = name === "expect" ? this.text(this.evaluate(expression.args[0], scope), expression.token) : "";
      if (value.tag === "None" || value.tag === "Err") fail("PANIC", message || `Called unwrap() on ${this.display(value, expression.token, true)}.`, expression.token, "Use match to handle the missing value or error.");
      return value.data;
    }
    fail("E0599", `Method \`${name}\` is not supported.`, expression.token, `Supported methods: ${SUPPORTED_SUBSET.methods.join(", ")}.`);
  }
  run() {
    const main = this.program.functions.get("main");
    if (main.parameters.length) fail("E0580", "main must not take parameters.", main.token, "Use fn main() { ... }.");
    this.invoke(main, [], main.token);
  }
  borrows() { return this.borrowHistory.map(({ cell, ...record }) => record); }
}

/** Run a bounded Rust-subset program. Errors are data, never uncaught exceptions. */
export function execute(source, { unsafe = false, maxSteps = 10000 } = {}) {
  let runtime = null;
  try {
    if (typeof source !== "string") fail("E0001", "Source must be a string.", null);
    if (source.length > LIMITS.sourceCharacters) fail("LIMIT_SOURCE", "Source exceeds 40,000 characters.", null, "Keep this a small playground program.");
    const program = new Parser(tokenize(source)).program();
    runtime = new Runtime(program, { unsafe, maxSteps });
    runtime.run();
    return { ok: true, stdout: runtime.stdout, error: null, steps: runtime.steps, borrows: runtime.borrows(), warnings: runtime.warnings };
  } catch (error) {
    const detail = error instanceof Diagnostic ? error.detail : { code: "INTERNAL", message: "The interpreter could not finish this program.", line: 1, column: 1, hint: "This may be an unsupported Rust feature. Try a smaller example." };
    return { ok: false, stdout: runtime?.stdout ?? [], error: detail, steps: runtime?.steps ?? 0, borrows: runtime?.borrows() ?? [], warnings: runtime?.warnings ?? (unsafe ? ["Unsafe mode is enabled."] : []) };
  }
}
