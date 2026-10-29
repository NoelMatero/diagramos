/**
 * Calls written inside Rust macros (#471).
 *
 * `trace!("..", input.get_span())`, `format!`, `assert!`, `vec![..]`: a
 * macro's arguments are loose tokens to tree-sitter, so every call in them was
 * invisible, and every body holding a macro stayed open. Where the macro is
 * one whose arguments are code -- std's, or a `macro_rules!` this crate
 * writes -- they are now read as code, in place. Where it is not, or the
 * tokens are not code, nothing changes: the body stays "not sure".
 *
 * Refusals first: each is a case that must not be read.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { callsBetween, callSitesIn, EXTERNAL_RECEIVER, type CallSide, type CallsVerdict } from "../src/engine/calls";
import { initEngine } from "../src/engine/parse";

beforeAll(async () => { await initEngine(); }, 120_000);

type Files = Record<string, { source: string; imports?: CallSide["imports"] }>;

function sideOf(files: Files, file: string): CallSide {
  const one = files[file]!;
  return {
    file, source: one.source, language: "rust", imports: one.imports ?? [],
    open: (wanted) => files[wanted] ? { source: files[wanted]!.source, language: "rust", imports: files[wanted]!.imports ?? [] } : undefined,
  };
}

/** Each site of `routine` as `name -> where`, `?why` when unplaced, and `?macro` for a macro left unread. */
function sites(files: Files, file: string, routine: string): string[] {
  const reading = callSitesIn(sideOf(files, file));
  if (!reading.read) throw new Error(reading.why);
  const body = reading.bodies.find((one) => one.routine === routine)!;
  return body.sites.map((one) => (one.why === "macro" ? "?macro" : `${one.name} -> ${one.file ?? `?${one.why}`}`));
}

function verdict(files: Files, from: { file: string; routine: string }, to: { file: string; names: string[] }): string {
  const got: CallsVerdict = callsBetween({ ...sideOf(files, from.file), routine: from.routine }, { ...sideOf(files, to.file), names: to.names });
  return got.verdict === "withheld" ? `withheld/${got.why}` : got.verdict;
}

const RENDER = { source: "pub fn render(n: u32) -> u32 { n }\npub fn other() {}\n" };

describe("macros whose tokens stay unread", () => {
  it("leaves a macro that pastes identifiers unread", () => {
    // `paste!` and `concat_idents!` build a name out of pieces; the call is to a name nobody wrote.
    const files: Files = {
      "src/a.rs": { source: "fn run() {\n    paste! { [<ren der>](1) };\n    concat_idents!(ren, der)(1);\n}\n" },
      "src/b.rs": RENDER,
    };
    expect(sites(files, "src/a.rs", "run").filter((one) => one === "?macro")).toHaveLength(2);
    expect(sites(files, "src/a.rs", "run").some((one) => one.startsWith("ren"))).toBe(false);
  });

  it("leaves a library's macro unread: it may be procedural, and do anything with its tokens", () => {
    const files: Files = {
      "src/a.rs": {
        source: "use crate::b::render;\nuse my_derive::my_macro;\n\nfn run() {\n    my_macro!(render(1));\n    my_derive::other_macro!(render(2));\n}\n",
        imports: [{ specifier: "crate::b::render", file: "src/b.rs" }, { specifier: "my_derive::my_macro", library: true }],
      },
      "src/b.rs": RENDER,
    };
    expect(sites(files, "src/a.rs", "run")).toEqual([`my_macro -> ${EXTERNAL_RECEIVER}`, "?macro", "other_macro -> ?receiver", "?macro"]);
    expect(verdict(files, { file: "src/a.rs", routine: "run" }, { file: "src/b.rs", names: ["render"] })).toBe("withheld/macro");
  });

  it("leaves a macro nobody can find unread, though its name is std's elsewhere", () => {
    const files: Files = { "src/a.rs": { source: "fn run() { my_macro!(render(1)); }\n" }, "src/b.rs": RENDER };
    expect(verdict(files, { file: "src/a.rs", routine: "run" }, { file: "src/b.rs", names: ["render"] })).toBe("withheld/macro");
  });

  it("leaves tokens that are not expressions unread, even for a macro it can read", () => {
    const files: Files = {
      "src/a.rs": { source: "macro_rules! route {\n    ($a:ident => $b:expr) => { $b };\n}\n\nfn run() {\n    route!(home => render(1));\n}\n" },
      "src/b.rs": RENDER,
    };
    expect(sites(files, "src/a.rs", "run")).toEqual(["route -> src/a.rs", "?macro"]);
  });

  it("leaves unread the arguments of a macro that takes them apart", () => {
    // rayon's `convert_char!(self.drive(c))` calls `drive` on an iterator it builds, not on `self`.
    const files: Files = {
      "src/a.rs": { source: "macro_rules! convert {\n    ($self:ident . $method:ident ( $( $arg:expr ),* )) => { other().$method($( $arg ),*) };\n}\n\nstruct R;\nimpl R {\n    fn drive(&self, c: u8) -> u8 { convert!(self.drive(c)) }\n}\n" },
    };
    expect(sites(files, "src/a.rs", "drive")).toEqual(["convert -> src/a.rs", "?macro"]);
  });

  it("reads the arguments of a macro whose expansion runs more, and keeps the body open", () => {
    // The template calls into this crate (`$crate::out::write`): that call is in nobody's arguments.
    const files: Files = {
      "src/a.rs": { source: "macro_rules! log_it {\n    ($e:expr) => { $crate::out::write($e) };\n}\n\nfn run() {\n    log_it!(render(1));\n}\n" },
      "src/b.rs": RENDER,
    };
    expect(sites(files, "src/a.rs", "run")).toEqual(["log_it -> src/a.rs", "?macro", "render -> ?unbound"]);
  });

  it("keeps the body open for a macro that calls a name it is handed", () => {
    // `call!(render)` runs `render()`, and `render` is written as a plain name, not a call.
    const files: Files = {
      "src/a.rs": { source: "macro_rules! call {\n    ($f:ident) => { $f() };\n}\n\nfn run() {\n    call!(render);\n}\n" },
      "src/b.rs": RENDER,
    };
    expect(sites(files, "src/a.rs", "run")).toContain("?macro");
  });

  it("keeps an attribute that may be procedural as a doubt", () => {
    const files: Files = { "src/a.rs": { source: "fn g() {}\nfn run() {\n    #[my_attr(g())]\n    g();\n}\n" } };
    expect(sites(files, "src/a.rs", "run")).toEqual(["?macro", "g -> src/a.rs"]);
  });

  it("keeps a macro and a method of the same name apart", () => {
    // #468: one catch on main came from `debug_assert!` read as the file's method `debug_assert`.
    const files: Files = {
      "src/a.rs": { source: "struct S;\nimpl S {\n    fn debug_assert(&self) {}\n    fn run(&self) {\n        debug_assert!(self.ok());\n    }\n    fn ok(&self) -> bool { true }\n}\n" },
    };
    expect(sites(files, "src/a.rs", "run")[0]).toBe(`debug_assert -> ${EXTERNAL_RECEIVER}`);
  });
});

describe("macros whose arguments are read as code", () => {
  it("reads std's formatting and assertion macros, and the body closes", () => {
    const files: Files = {
      "src/a.rs": {
        source: "use crate::b::render;\n\nfn run(x: u32) {\n    println!(\"{}\", render(x));\n    assert_eq!(render(1), 1, \"{}\", x);\n}\n",
        imports: [{ specifier: "crate::b::render", file: "src/b.rs" }],
      },
      "src/b.rs": RENDER,
    };
    expect(sites(files, "src/a.rs", "run")).toEqual([
      `println -> ${EXTERNAL_RECEIVER}`, "render -> src/b.rs", `assert_eq -> ${EXTERNAL_RECEIVER}`, "render -> src/b.rs",
    ]);
    expect(verdict(files, { file: "src/a.rs", routine: "run" }, { file: "src/b.rs", names: ["render"] })).toBe("confirmed");
    // Closed: it reaches `render` in that file and nothing else, so not `other`.
    expect(verdict(files, { file: "src/a.rs", routine: "run" }, { file: "src/b.rs", names: ["other"] })).toBe("wrong-routine");
  });

  it("reads past `#[cfg(..)]` and lint attributes on a statement: they run nothing", () => {
    const files: Files = { "src/a.rs": { source: "fn g() {}\nfn run() {\n    #[cfg(not(feature = \"x\"))]\n    g();\n    #[allow(unused)]\n    let a = 1;\n}\n" } };
    expect(sites(files, "src/a.rs", "run")).toEqual(["g -> src/a.rs"]);
  });

  it("reads `vec![..]` as an array, the repeat form too", () => {
    const files: Files = { "src/a.rs": { source: "fn make(n: usize) -> u32 { n as u32 }\nfn run(n: usize) {\n    let a = vec![make(1), make(2)];\n    let b = vec![make(n); n];\n}\n" } };
    expect(sites(files, "src/a.rs", "run").filter((one) => one.startsWith("make"))).toEqual(Array(3).fill("make -> src/a.rs"));
  });

  it("reads `matches!` as a match: the value and the guard, with the pattern's names bound", () => {
    const files: Files = { "src/a.rs": { source: "fn limit() -> u8 { 1 }\nfn run(x: Option<u8>) -> bool {\n    matches!(x, Some(y) if y > limit())\n}\n" } };
    expect(sites(files, "src/a.rs", "run")).toEqual([`matches -> ${EXTERNAL_RECEIVER}`, "limit -> src/a.rs"]);
  });

  it("reads a macro inside a macro", () => {
    const files: Files = { "src/a.rs": { source: "fn f() -> u8 { 1 }\nfn run(x: Option<u8>) {\n    assert!(matches!(x, Some(_)) || format!(\"{}\", f()).is_empty());\n}\n" } };
    expect(sites(files, "src/a.rs", "run")).toContain("f -> src/a.rs");
    expect(sites(files, "src/a.rs", "run")).not.toContain("?macro");
  });

  it("looks a name up in the routine around the macro", () => {
    // A parameter holding a function, named like the file's own: the routine's scope, not the file's.
    const files: Files = { "src/a.rs": { source: "fn render() {}\nfn run(render: fn(u8) -> u8) {\n    println!(\"{}\", render(1));\n}\n" } };
    expect(sites(files, "src/a.rs", "run")).toContain("render -> ?local-callee");
  });

  it("reads a crate's own `macro_rules!` whose template runs only std, and the body closes", () => {
    const tri = "macro_rules! tri {\n    ($e:expr $(,)?) => {\n        match $e {\n            core::result::Result::Ok(val) => val,\n            core::result::Result::Err(err) => return core::result::Result::Err(err),\n        }\n    };\n}\n";
    const files: Files = {
      "src/a.rs": { source: `${tri}\nfn parse() -> Result<u8, ()> { Ok(1) }\nfn run() -> Result<u8, ()> {\n    let v = tri!(parse());\n    Ok(v)\n}\n` },
    };
    expect(sites(files, "src/a.rs", "run")).toEqual(["tri -> src/a.rs", "parse -> src/a.rs", `Ok -> ${EXTERNAL_RECEIVER}`]);
  });
});

describe("a crate's macro written in another file", () => {
  const files: Files = {
    "src/lib.rs": { source: "#[macro_use]\nmod macros;\n\nmacro_rules! tri {\n    ($e:expr) => { match $e { Ok(v) => v, Err(e) => return Err(e) } };\n}\n\nmod de;\n\nmacro_rules! late {\n    ($e:expr) => { $e };\n}\n" },
    "src/macros.rs": { source: "macro_rules! debug {\n    ($($arg:tt)*) => { eprintln!($($arg)*) };\n}\n" },
    "src/de/mod.rs": { source: "mod parse;\n" },
    "src/de/parse.rs": { source: "fn whitespace() -> Result<u8, ()> { Ok(1) }\nfn run() -> Result<u8, ()> {\n    debug!(\"at {}\", whitespace().is_ok());\n    let v = tri!(whitespace());\n    late!(whitespace());\n    Ok(v)\n}\n" },
  };

  it("finds one from `#[macro_use] mod macros;` and one written above the `mod`, and reads both", () => {
    const got = sites(files, "src/de/parse.rs", "run");
    expect(got.slice(0, 5)).toEqual(["debug -> src/macros.rs", "is_ok -> ?receiver", "whitespace -> src/de/parse.rs", "tri -> src/lib.rs", "whitespace -> src/de/parse.rs"]);
  });

  it("does not see one written below the `mod`, which is out of textual scope there", () => {
    const got = sites(files, "src/de/parse.rs", "run");
    expect(got).toContain("late -> ?unbound");
    expect(got).toContain("?macro");
  });
});
