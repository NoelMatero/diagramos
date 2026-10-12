/**
 * Where a plain name comes from, read by each language's own scoping rules (#468).
 *
 * A call is placed by first asking what its name means at the spot it is
 * written. The answer is one of three: declared in this repository at some
 * place, declared outside it, or not known. The census of every call (#467)
 * found the reader answering that question wrongly in both directions:
 *
 *   - **placed where it is not.** Rust `Err(e)` read as the file's own
 *     `type Err`, `self.len()` read as some other type's `len` in the file,
 *     Python `set()` inside a method read as the class's own `set`, Vite's
 *     `this.resolve()` in a plugin hook read as a function of the module.
 *     1,329 calls, and a wrong placement can become a wrong red.
 *   - **not placed where the language settles it.** `Some(x)` after an
 *     `if let Some(v)`, `isinstance(a, b) and c`, `Number(x) + 1`, all read
 *     as names the routine binds; one `use super::*` inside a Rust test module
 *     switching every prelude name in the file off.
 *
 * The first block below is the refusals: shapes where the honest answer is
 * still "not sure", and that must stay so.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { callSitesIn, EXTERNAL_RECEIVER, type CallSide } from "../src/engine/calls";
import { initEngine, type Language } from "../src/engine/parse";

beforeAll(async () => { await initEngine(); }, 120_000);

const FILE: Record<Language, string> = { ts: "a.ts", tsx: "a.tsx", js: "a.js", python: "a.py", rust: "a.rs" };

/** Each call in one routine, as `file` when placed and `?why` when not. */
function placed(source: string, routine: string, language: Language, extra: Partial<CallSide> = {}): string[] {
  const reading = callSitesIn({ file: FILE[language], source, language, imports: [], ...extra });
  if (!reading.read) throw new Error(`refused: ${reading.why}`);
  const body = reading.bodies.find((one) => one.routine === routine);
  if (!body) throw new Error(`no body ${routine}`);
  return body.sites.filter((one) => one.why !== "macro").map((one) => one.file ?? `?${one.why}`);
}

/** Each call's name and where it went, for a routine with several. */
function named(source: string, routine: string, language: Language, extra: Partial<CallSide> = {}): Record<string, string> {
  const reading = callSitesIn({ file: FILE[language], source, language, imports: [], ...extra });
  if (!reading.read) throw new Error(`refused: ${reading.why}`);
  const body = reading.bodies.find((one) => one.routine === routine)!;
  return Object.fromEntries(body.sites.filter((one) => one.why !== "macro").map((one) => [one.name, one.file ?? `?${one.why}`]));
}

/** A repository of several files, opened by name. */
function repo(files: Record<string, string>, language: Language): Pick<CallSide, "open"> {
  return {
    open: (file) => (files[file] === undefined ? undefined : { source: files[file]!, language, imports: [] }),
  };
}

const OUT = EXTERNAL_RECEIVER;

describe("refusals: the answer stays not sure", () => {
  it("a local that shadows a built-in is the local, in each language", () => {
    expect(placed("def f(v):\n    len = pick()\n    return len(v)\n", "f", "python")).toEqual(["?unbound", "?local-callee"]);
    expect(placed("def f(len):\n    return len(1)\n", "f", "python")).toEqual(["?local-callee"]);
    expect(placed("function f(Number) {\n  return Number(1);\n}\n", "f", "ts")).toEqual(["?local-callee"]);
    expect(placed("function f() {\n  const setTimeout = pick();\n  setTimeout(go, 1);\n}\n", "f", "ts"))
      .toEqual(["?unbound", "?local-callee"]);
    expect(placed("fn f(drop: fn(u8)) {\n    drop(1);\n}\n", "f", "rust")).toEqual(["?local-callee"]);
    // `let Some = ..` is not Rust: a variant in scope is a pattern, never a binding.
    expect(placed("fn f() {\n    let size_of = pick();\n    size_of(1);\n}\n", "f", "rust")).toEqual(["?unbound", "?local-callee"]);
  });

  it("a shadow in an enclosing routine counts too", () => {
    expect(placed("def outer(len):\n    def f(v):\n        return len(v)\n    return f\n", "f", "python"))
      .toEqual(["?local-callee"]);
    expect(placed("function outer(Number) {\n  const f = (v) => Number(v);\n}\n", "f", "ts"))
      .toEqual(["?local-callee"]);
  });

  it("a built-in this file declares for itself is this file's", () => {
    expect(placed("def len(v):\n    return 0\n\n\ndef f(v):\n    return len(v)\n", "f", "python")).toEqual(["a.py"]);
    expect(placed("function setTimeout(go, ms) {}\nfunction f() {\n  setTimeout(go, 1);\n}\n", "f", "ts"))
      .toEqual(["a.ts"]);
    expect(named("fn drop(x: u8) {}\nfn f() {\n    drop(1);\n}\n", "f", "rust")).toEqual({ drop: "a.rs" });
  });

  it("a wildcard import that does export the name", () => {
    const python = repo({ "shims.py": "def list(v):\n    return v\n" }, "python");
    const imports = [{ specifier: ".shims", file: "shims.py" }];
    expect(placed("from .shims import *\n\n\ndef f(v):\n    return list(v)\n", "f", "python", { ...python, imports }))
      .toEqual(["?unbound"]);

    const rust = repo({ "lib.rs": "pub fn Ok<T>(v: T) -> T { v }\n" }, "rust");
    expect(placed("use crate::lib::*;\n\nfn f() {\n    Ok(1);\n}\n", "f", "rust", {
      ...rust, imports: [{ specifier: "crate::lib", file: "lib.rs" }],
    })).toEqual(["?unbound"]);
  });

  it("a name only a wildcard could bring is placed where it is declared, unless the language has it too", () => {
    const python = repo({ "shims.py": "def helper(v):\n    return v\n\n\ndef list(v):\n    return v\n" }, "python");
    const imports = [{ specifier: ".shims", file: "shims.py" }];
    expect(named("from .shims import *\n\n\ndef f(v):\n    helper(v)\n    return list(v)\n", "f", "python", { ...python, imports }))
      .toEqual({ helper: "shims.py", list: "?unbound" });
    // Python's `__all__` decides what a wildcard carries; this reader does not read it.
    const limited = repo({ "shims.py": "__all__ = ['other']\n\n\ndef helper(v):\n    return v\n" }, "python");
    expect(placed("from .shims import *\n\n\ndef f(v):\n    return helper(v)\n", "f", "python", { ...limited, imports }))
      .toEqual(["?unbound"]);
  });

  it("a wildcard import nobody can open", () => {
    expect(placed("from .shims import *\n\n\ndef f(v):\n    return list(v)\n", "f", "python")).toEqual(["?unbound"]);
    expect(placed("use crate::shims::*;\n\nfn f() {\n    Ok(1);\n}\n", "f", "rust")).toEqual(["?unbound"]);
  });

  it("a re-export cycle", () => {
    const files = {
      "b.ts": "export { go } from \"./c\";\n",
      "c.ts": "export { go } from \"./b\";\n",
    };
    const side = {
      open: (file: string) => files[file as keyof typeof files] === undefined ? undefined : {
        source: files[file as keyof typeof files], language: "ts" as const,
        imports: [{ specifier: "./c", file: "c.ts" }, { specifier: "./b", file: "b.ts" }],
      },
      imports: [{ specifier: "./b", file: "b.ts" }],
    };
    expect(placed("import { go } from \"./b\";\nfunction f() {\n  go();\n}\n", "f", "ts", side)).toEqual(["?elsewhere"]);

    const py: Record<string, string> = { "b.py": "from .c import *\n", "c.py": "from .b import *\n" };
    const pySide = {
      open: (file: string) => py[file] === undefined ? undefined : {
        source: py[file]!, language: "python" as const,
        imports: [{ specifier: ".c", file: "c.py" }, { specifier: ".b", file: "b.py" }],
      },
      imports: [{ specifier: ".b", file: "b.py" }],
    };
    expect(placed("from .b import *\n\n\ndef f(v):\n    return list(v)\n", "f", "python", pySide)).toEqual(["?unbound"]);
  });
});

describe("wrong placements: a name means what its scope says", () => {
  it("Rust: a type named Err is not the value Err", () => {
    const source = "impl FromStr for Level {\n    type Err = ParseError;\n"
      + "    fn from_str(s: &str) -> Result<Level, Self::Err> {\n        Err(ParseError)\n    }\n}\n";
    expect(placed(source, "from_str", "rust")).toEqual([OUT]);
    expect(placed("type Ok = u8;\nfn f() {\n    Ok(1);\n}\n", "f", "rust")).toEqual([OUT]);
  });

  it("Rust: a method inside an impl is not a name a free function can call", () => {
    const source = "struct G;\nimpl Drop for G {\n    fn drop(&mut self) {}\n}\nfn f(x: u8) {\n    drop(x);\n}\n";
    expect(placed(source, "f", "rust")).toEqual([OUT]);
  });

  it("Rust: self.x() is placed only at the same type's own method", () => {
    const other = "struct Mine;\nimpl Mine {\n    fn len(&self) -> usize { 0 }\n}\n"
      + "impl Shape for Vec<u8> {\n    fn size(&self) -> usize {\n        self.len()\n    }\n}\n";
    expect(placed(other, "size", "rust")).toEqual(["?receiver"]);

    const same = "struct Mine;\nimpl Mine {\n    fn len(&self) -> usize { 0 }\n}\n"
      + "impl Shape for Mine {\n    fn size(&self) -> usize {\n        self.len()\n    }\n}\n";
    expect(placed(same, "size", "rust")).toEqual(["a.rs"]);

    const generic = "impl<T> Wrap<T> {\n    fn a(&self) {\n        self.b();\n    }\n    fn b(&self) {}\n}\n";
    expect(placed(generic, "a", "rust")).toEqual(["a.rs"]);
  });

  it("Python: a class body's names are not visible inside its methods", () => {
    const source = "class K:\n    def set(self, v):\n        pass\n\n    def run(self, v):\n        return set(v)\n";
    expect(placed(source, "run", "python")).toEqual([OUT]);
    expect(placed("class K:\n    def run(self):\n        return self.set(1)\n\n    def set(self, v):\n        pass\n", "run", "python"))
      .toEqual(["a.py"]);
  });

  it("TS: this inside an object-literal method is not the module", () => {
    const hook = "function resolve(id) {}\n"
      + "export default function plugin() {\n  return {\n    name: 'x',\n"
      + "    resolveId(id) {\n      return this.resolve(id);\n    },\n  };\n}\n";
    expect(placed(hook, "resolveId", "ts")).toEqual(["?receiver"]);

    const own = "export const api = {\n  run() {\n    return this.step();\n  },\n  step() {},\n};\n";
    expect(placed(own, "run", "ts")).toEqual(["a.ts"]);
  });

  it("TS: this inside a plain function is whatever called it", () => {
    expect(placed("function go() {}\nfunction f() {\n  this.go();\n}\n", "f", "ts")).toEqual(["?receiver"]);
  });

  it("TS: an object literal inside a class method has its own this", () => {
    const source = "class K {\n  step() {}\n  run() {\n    return {\n      go() {\n        return this.step();\n      },\n    };\n  }\n}\n";
    expect(placed(source, "go", "ts")).toEqual(["?receiver"]);
    // An arrow keeps the class's.
    expect(placed("class K {\n  step() {}\n  run() {\n    const go = () => this.step();\n  }\n}\n", "go", "ts"))
      .toEqual(["a.ts"]);
  });
});

describe("names the language settles, placed outside", () => {
  it("Rust: a pattern's constructor is not a name the routine binds", () => {
    const source = "fn f(y: Option<u8>) -> Option<u8> {\n    if let Some(x) = y {\n        return Some(x);\n    }\n"
      + "    match y {\n        Some(v) => Some(v),\n        None => None,\n    }\n}\n";
    expect(placed(source, "f", "rust")).toEqual([OUT, OUT]);
  });

  it("Python: a built-in on the left of `and` is not an assignment", () => {
    expect(placed("def f(a, b, c):\n    return isinstance(a, b) and c\n", "f", "python")).toEqual([OUT]);
    expect(placed("def f(a):\n    return len(a) + 1\n", "f", "python")).toEqual([OUT]);
  });

  it("TS: a built-in on the left of an operator is not an assignment", () => {
    expect(placed("function f(x) {\n  return Number(x) + 1;\n}\n", "f", "ts")).toEqual([OUT]);
  });

  it("Rust: a wildcard inside a test module does not reach the rest of the file", () => {
    const source = "fn f() -> Result<u8, E> {\n    Ok(1)\n}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n}\n";
    expect(placed(source, "f", "rust")).toEqual([OUT]);
  });

  it("Rust: a wildcard over this file's own enum brings only its variants", () => {
    const source = "enum Kind { A, B }\nfn f() -> Result<Kind, E> {\n    use self::Kind::*;\n    Ok(A)\n}\n";
    expect(placed(source, "f", "rust")).toEqual([OUT]);
  });

  it("Rust: a wildcard over std brings nothing from the repository", () => {
    expect(placed("use std::io::*;\n\nfn f() -> Result<u8> {\n    Ok(1)\n}\n", "f", "rust")).toEqual([OUT]);
  });

  it("Rust: a wildcard into the repository that does not have the name", () => {
    const rust = repo({ "parent.rs": "pub fn helper() {}\npub type Err = u8;\n" }, "rust");
    expect(placed("use super::*;\n\nfn f() {\n    Err(1);\n}\n", "f", "rust", {
      ...rust, imports: [{ specifier: "super", file: "parent.rs" }],
    })).toEqual([OUT]);
  });

  it("Python: a wildcard into the repository that does not have the name", () => {
    const python = repo({ "shims.py": "def helper(v):\n    return v\n" }, "python");
    const imports = [{ specifier: ".shims", file: "shims.py" }];
    expect(placed("from .shims import *\n\n\ndef f(v):\n    return list(v)\n", "f", "python", { ...python, imports }))
      .toEqual([OUT]);
  });

  it("TS: re-exporting with export * brings no name into this file", () => {
    expect(placed("export * from \"./x\";\nfunction f(v) {\n  return Number(v);\n}\n", "f", "ts")).toEqual([OUT]);
  });

  it("TS: a host global", () => {
    expect(placed("function f(go) {\n  setTimeout(go, 1);\n  queueMicrotask(go);\n}\n", "f", "ts")).toEqual([OUT, OUT]);
  });
});

describe("Rust's order and modules", () => {
  it("a let is the value only after its statement", () => {
    const source = "fn f(bytes: &[u8]) -> usize {\n    fn len(b: u8) -> usize { 1 }\n    let len = len(bytes[0]);\n    len\n}\n";
    expect(named(source, "f", "rust")).toEqual({ len: "a.rs" });
    expect(placed("fn f() {\n    let go = pick();\n    go();\n}\nfn go() {}\n", "f", "rust")).toEqual(["?unbound", "?local-callee"]);
  });

  it("a module written in the file sees the file's names through use super::*, and not without it", () => {
    const glob = "fn helper() {}\nmod inner {\n    use super::*;\n    fn f() {\n        helper();\n        Ok::<u8, u8>(1);\n    }\n}\n";
    expect(named(glob, "f", "rust")).toEqual({ helper: "a.rs", Ok: OUT });
    expect(placed("fn helper() {}\nmod inner {\n    fn f() {\n        helper();\n    }\n}\n", "f", "rust")).toEqual(["?unbound"]);
    // The file's own `drop` comes in through the wildcard, and so does the prelude's: not known which.
    expect(placed("fn drop(x: u8) {}\nmod inner {\n    use super::*;\n    fn f() {\n        drop(1);\n    }\n}\n", "f", "rust"))
      .toEqual(["?unbound"]);
  });

  it("Type::make() is the type's own only from an inherent impl the spot can see", () => {
    const own = "struct Pool;\nimpl Pool {\n    fn make() -> Pool { Pool }\n}\nfn f() {\n    Pool::make();\n}\n";
    expect(placed(own, "f", "rust")).toEqual(["a.rs"]);
    const traitOnly = "impl Shape for Pool {\n    fn make() -> Pool { Pool::make() }\n}\n";
    expect(placed(traitOnly, "make", "rust")).toEqual(["?receiver"]);
    const other = "mod a {\n    pub struct Mutex;\n    impl Mutex {\n        pub fn new() -> Mutex { Mutex }\n    }\n}\n"
      + "mod b {\n    use std::sync::Mutex;\n    fn f() {\n        Mutex::new(1);\n    }\n}\n";
    expect(placed(other, "f", "rust")).toEqual(["?receiver"]);
  });
});

describe("a name declared twice, but in different scopes", () => {
  it("Python: a method and a module function of one name are not a collision", () => {
    const source = "def get(v):\n    return v\n\n\nclass K:\n    def get(self):\n        pass\n\n\ndef f(v):\n    return get(v)\n";
    expect(placed(source, "f", "python")).toEqual(["a.py"]);
  });

  it("Rust: an impl's method and a free function of one name are not a collision", () => {
    const source = "fn helper() {}\nimpl K {\n    fn helper(&self) {}\n}\nfn f() {\n    helper();\n}\n";
    expect(placed(source, "f", "rust")).toEqual(["a.rs"]);
  });

  it("two in one scope of this file are still this file's", () => {
    // One per `#[cfg]`, one per branch: whichever wins, it is this file's `get`.
    const source = "if X:\n    def get(v):\n        return v\nelse:\n    def get(v):\n        return 1\n\n\ndef f(v):\n    return get(v)\n";
    expect(placed(source, "f", "python")).toEqual(["a.py"]);
  });

  it("but declared here and imported too is not known", () => {
    const source = "try:\n    from fast import get\nexcept ImportError:\n    def get(v):\n        return v\n\n\ndef f(v):\n    return get(v)\n";
    expect(placed(source, "f", "python", { imports: [{ specifier: "fast.get" }] })).toEqual(["?ambiguous"]);
  });
});
