/**
 * The member reader (#213), and the one word here whose two ends do not stand
 * on the same footing.
 *
 * `Renderer --@accesses--> Config`, with the member named on the arrow: this
 * routine reads that member off that type.
 *
 *   - The **type** end is a declaration. A member list is a closed region, so a
 *     type that does not declare the member refutes the arrow -- the same
 *     footing `@holds` stands on, and the reason the word is worth having:
 *     rename a field and every diagram still naming the old one goes red.
 *   - The **routine** end is a body. Nobody can enumerate what a body touches
 *     without knowing every receiver's type, which needs the whole program. Not
 *     finding an access is not evidence there is none, so this end confirms and
 *     is otherwise silent. It must never produce a red.
 *
 * So the tests that matter most are the ones under "refuses rather than
 * accuses". Each is a type whose member list looks enumerable, does not contain
 * the name, and whose arrow is nevertheless right.
 *
 * `scripts/measure-accesses.mts` asks the same questions of whole repositories.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { initEngine } from "../src/engine/parse";
import { memberAccesses, type AccessesVerdict } from "../src/engine/accesses";

beforeAll(async () => { await initEngine(); }, 120_000);

/** The verdict as one word, so a test reads as the sentence it is checking. */
function verdictOf(verdict: AccessesVerdict): string {
  return verdict.verdict === "withheld" ? `withheld/${verdict.why}` : verdict.verdict;
}

describe("a routine that reads a member the type declares", () => {
  it("confirms a TypeScript class field", () => {
    const type = "class Config { width: number; height: number; }";
    const routine = "function render(config: Config) { return config.width; }";
    const verdict = memberAccesses(routine, "render", "width", "ts", {
      source: type, names: ["Config"], language: "ts",
    });
    expect(verdict.verdict).toBe("confirmed");
    if (verdict.verdict !== "confirmed") return;
    expect(verdict.evidence.member).toBe("width");
    expect(verdict.evidence.line).toBe(1);
  });
});

describe("the same rule, in four grammars", () => {
  it("reads a Python attribute assigned to self, which is where most of them are", () => {
    // The shape that would refute nearly every Python arrow if it were missed:
    // a class body that declares nothing and an `__init__` that sets it all.
    const type = [
      "class Config:",
      "    def __init__(self, width):",
      "        self.width = width",
    ].join("\n");
    const routine = [
      "def render(config):",
      "    return config.width",
    ].join("\n");
    expect(verdictOf(memberAccesses(routine, "render", "width", "python", {
      source: type, names: ["Config"], language: "python",
    }))).toBe("confirmed");
  });

  it("reads a Python class annotation", () => {
    const type = ["class Config:", "    width: int"].join("\n");
    const routine = ["def render(config):", "    return config.width"].join("\n");
    expect(verdictOf(memberAccesses(routine, "render", "width", "python", {
      source: type, names: ["Config"], language: "python",
    }))).toBe("confirmed");
  });

  it("reads a Rust struct field", () => {
    const type = "pub struct Config {\n    pub width: u32,\n}";
    const routine = "fn render(config: &Config) -> u32 {\n    config.width\n}";
    expect(verdictOf(memberAccesses(routine, "render", "width", "rust", {
      source: type, names: ["Config"], language: "rust",
    }))).toBe("confirmed");
  });

  it("reads a Rust method, which lives in an impl block the struct does not contain", () => {
    // The one place Rust keeps a member somewhere else. A reader stopping at
    // `struct Config { .. }` sees no methods at all and refutes every one.
    const type = [
      "pub struct Config { pub width: u32 }",
      "impl Config {",
      "    pub fn scaled(&self) -> u32 { self.width * 2 }",
      "}",
    ].join("\n");
    const routine = "fn render(config: &Config) -> u32 {\n    config.scaled()\n}";
    expect(verdictOf(memberAccesses(routine, "render", "scaled", "rust", {
      source: type, names: ["Config"], language: "rust",
    }))).toBe("confirmed");
  });

  it("reads a method on a TypeScript class, which `holds` deliberately does not", () => {
    // The one way this reader's notion of a member is wider than `holds.ts`'s,
    // and it has to be: `config.render()` reads a member in the only sense a
    // diagram means.
    const type = "class Config { render(): void {} }";
    const routine = "function draw(config: Config) { config.render(); }";
    expect(verdictOf(memberAccesses(routine, "draw", "render", "ts", {
      source: type, names: ["Config"], language: "ts",
    }))).toBe("confirmed");
  });

  it("reads `type X = { ... }`, which carries no body field at all", () => {
    const type = "type Config = { width: number };";
    const routine = "function render(config: Config) { return config.width; }";
    expect(verdictOf(memberAccesses(routine, "render", "width", "ts", {
      source: type, names: ["Config"], language: "ts",
    }))).toBe("confirmed");
  });
});

describe("refuses rather than accuses", () => {
  /*
   * Each of these is a type whose member list looks enumerable, does not
   * contain the name, and whose arrow is nevertheless right. They are the
   * tests that matter: a red here is not a missed finding, it is the tool
   * telling somebody their correct diagram is wrong, and that is not
   * recoverable by being right afterwards.
   */
  it("says nothing about a type with a parent", () => {
    // The commonest shape there is, and the one that would make this word a
    // false-red generator: `width` is Base's, and Base is not in front of us.
    const type = "class Config extends Base { height: number; }";
    const routine = "function render(config: Config) { return config.width; }";
    expect(verdictOf(memberAccesses(routine, "render", "width", "ts", {
      source: type, names: ["Config"], language: "ts",
    }))).toBe("withheld/inherited");
  });

  it("says nothing about a Python class with a base", () => {
    const type = ["class Config(BaseModel):", "    height: int"].join("\n");
    const routine = ["def render(config):", "    return config.width"].join("\n");
    expect(verdictOf(memberAccesses(routine, "render", "width", "python", {
      source: type, names: ["Config"], language: "python",
    }))).toBe("withheld/inherited");
  });

  it("says nothing about a type with an index signature", () => {
    // `[key: string]: unknown` makes every name a legal member, so absence
    // proves nothing at all.
    const type = "interface Config { height: number; [key: string]: unknown; }";
    const routine = "function render(config: Config) { return config.width; }";
    expect(verdictOf(memberAccesses(routine, "render", "width", "ts", {
      source: type, names: ["Config"], language: "ts",
    }))).toBe("withheld/open");
  });

  it("says nothing about a Python class that answers to any attribute", () => {
    const type = [
      "class Config:",
      "    def __getattr__(self, name):",
      "        return self._values[name]",
    ].join("\n");
    const routine = ["def render(config):", "    return config.width"].join("\n");
    expect(verdictOf(memberAccesses(routine, "render", "width", "python", {
      source: type, names: ["Config"], language: "python",
    }))).toBe("withheld/open");
  });

  it("says nothing about an alias for a type declared somewhere else", () => {
    const type = "type Config = SomeOtherShape;";
    const routine = "function render(config: Config) { return config.width; }";
    expect(verdictOf(memberAccesses(routine, "render", "width", "ts", {
      source: type, names: ["Config"], language: "ts",
    }))).toBe("withheld/aliased");
  });

  it("says nothing when the far end is a routine rather than a type", () => {
    // A routine has no members, so the question has no answer -- the same
    // category error `holds.ts` catches.
    const type = "function config(width: number) { return width; }";
    const routine = "function render() { return 1; }";
    expect(verdictOf(memberAccesses(routine, "render", "width", "ts", {
      source: type, names: ["config"], language: "ts",
    }))).toBe("withheld/not-a-type");
  });

  it("says nothing when a Rust type's methods are in an impl this file does not hold", () => {
    // A Rust member list is closed for fields and open for methods, and an
    // `impl` block may sit in another file entirely.
    const type = "pub struct Config { pub height: u32 }";
    const routine = "fn render(config: &Config) -> u32 { config.scaled() }";
    expect(verdictOf(memberAccesses(routine, "render", "scaled", "rust", {
      source: type, names: ["Config"], language: "rust",
    }))).toBe("withheld/impl-elsewhere");
  });

  it("says nothing when the arrow names no member", () => {
    // `@accesses` with prose on it names nothing to look for at either end.
    const type = "class Config { width: number; }";
    const routine = "function render(config: Config) { return config.width; }";
    expect(verdictOf(memberAccesses(routine, "render", "reads the config", "ts", {
      source: type, names: ["Config"], language: "ts",
    }))).toBe("withheld/no-member-named");
    expect(verdictOf(memberAccesses(routine, "render", undefined, "ts", {
      source: type, names: ["Config"], language: "ts",
    }))).toBe("withheld/no-member-named");
  });

  it("says nothing about a file it only partly read", () => {
    const type = "class Config { width: number;";
    const routine = "function render(config: Config) { return config.width; }";
    expect(verdictOf(memberAccesses(routine, "render", "width", "ts", {
      source: type, names: ["Config"], language: "ts",
    }))).toBe("withheld/incomplete");
  });

  it("says nothing about a name the far file does not declare", () => {
    const routine = "function render(config: Config) { return config.width; }";
    expect(verdictOf(memberAccesses(routine, "render", "width", "ts", {
      source: "class Other { width: number; }", names: ["Config"], language: "ts",
    }))).toBe("withheld/not-declared");
  });
});

describe("the routine end confirms and is otherwise silent", () => {
  /*
   * The half that must never produce a red. Nobody can enumerate what a body
   * touches without knowing every receiver's type, so not finding an access is
   * not evidence there is none.
   */
  it("is silent, not red, when the type has the member and the body does not show it", () => {
    const type = "class Config { width: number; }";
    const routine = "function render(config: Config) { return measure(config); }";
    expect(verdictOf(memberAccesses(routine, "render", "width", "ts", {
      source: type, names: ["Config"], language: "ts",
    }))).toBe("absent");
  });

  it("is silent when the routine reaches the member through a destructuring", () => {
    // A shape this reader does not follow, and the cost of that is exactly one
    // confirmation nobody gets -- never a red.
    const type = "class Config { width: number; }";
    const routine = "function render(config: Config) { const { width } = config; return width; }";
    expect(verdictOf(memberAccesses(routine, "render", "width", "ts", {
      source: type, names: ["Config"], language: "ts",
    }))).toBe("absent");
  });

  it("confirms off a type whose methods do the reading", () => {
    // Nobody draws a box for `Renderer.prototype.draw`. They draw `Renderer`.
    const type = "class Config { width: number; }";
    const routine = "class Renderer { draw(config: Config) { return config.width; } }";
    expect(verdictOf(memberAccesses(routine, "Renderer", "width", "ts", {
      source: type, names: ["Config"], language: "ts",
    }))).toBe("confirmed");
  });

  it("accepts a member written the way a person writes one on a canvas", () => {
    const type = "class Config { width: number; }";
    const routine = "function render(config: Config) { return config.width; }";
    const ask = (written: string) => verdictOf(memberAccesses(routine, "render", written, "ts", {
      source: type, names: ["Config"], language: "ts",
    }));
    expect(ask(".width")).toBe("confirmed");
    expect(ask(" width ")).toBe("confirmed");
  });
});

describe("a member spelled with a sigil the author would not type", () => {
  /*
   * Found by `measure-accesses.mts`, and it was 22 of the 36 accusations left
   * after the referee's own bugs were out. TypeScript writes a private member
   * `#pending` and the grammar hands the name back with the hash on it; nobody
   * labels an arrow `#pending`. Both spellings answer, and the direction is the
   * safe one -- a wider member list can only ever withhold an accusation.
   */
  it("confirms a TypeScript private field written without its hash", () => {
    const type = "class BoardSync { #pending = 0; }";
    const routine = "function flush(sync: BoardSync) { return sync.#pending; }";
    expect(verdictOf(memberAccesses(routine, "flush", "pending", "ts", {
      source: type, names: ["BoardSync"], language: "ts",
    }))).toBe("confirmed");
  });

  it("still answers when the hash is written", () => {
    const type = "class BoardSync { #pending = 0; }";
    const routine = "function flush(sync: BoardSync) { return sync.#pending; }";
    expect(verdictOf(memberAccesses(routine, "flush", "#pending", "ts", {
      source: type, names: ["BoardSync"], language: "ts",
    }))).toBe("confirmed");
  });
});

describe("a member declared somewhere the member list is not", () => {
  /*
   * The hole a referee cannot find, because it shares the blindness: if
   * neither the text scan nor the tree walk can see a member, the measurement
   * reports agreement and the reader still refutes a correct arrow. So these
   * are read off the language rather than off a disagreement, and they are the
   * shapes where a declaration puts a member somewhere other than its own body.
   */
  it("finds a TypeScript constructor parameter property", () => {
    // `constructor(private width: number)` declares a member and writes it in
    // the parameter list. The member list has no line for it at all.
    const type = "class Config { constructor(private width: number) {} }";
    const routine = "function render(config: Config) { return config.width; }";
    expect(verdictOf(memberAccesses(routine, "render", "width", "ts", {
      source: type, names: ["Config"], language: "ts",
    }))).toBe("confirmed");
  });

  it("finds a Rust method on a trait impl for the type", () => {
    // `impl Draw for Config` gives Config a member, and the struct's own
    // declaration says nothing about it.
    const type = [
      "pub struct Config { pub width: u32 }",
      "impl Draw for Config {",
      "    fn draw(&self) -> u32 { self.width }",
      "}",
    ].join("\n");
    const routine = "fn render(config: &Config) -> u32 { config.draw() }";
    expect(verdictOf(memberAccesses(routine, "render", "draw", "rust", {
      source: type, names: ["Config"], language: "rust",
    }))).toBe("confirmed");
  });
});
