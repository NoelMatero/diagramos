/**
 * What rustc's call list may settle that it could not before (#434).
 *
 * The bad outcomes, both on the planted bench. Correct arrows whose call was
 * written inside a macro -- clap's `ok!(self.parse_long_arg(..))`, serde_json's
 * `tri!(self.parse_decimal(..))` -- never turned green, although rustc lists
 * the call. And wrong arrows stayed quiet for reasons that cannot hide a call:
 * a local named like the far function (`let vtable = ..` beside `fn vtable`),
 * or a far function that is a library trait's method (`Display::fmt`,
 * serde's `deserialize_enum`) when nothing the body calls is library code.
 *
 * These read a dump written by hand in the shape rustc 1.93 prints, so they
 * run without cargo; `calls-compiled-rust.test.ts` holds the live build.
 */
import { beforeAll, describe, expect, it } from "vitest";

import {
  compiledRefutes, ownCallIn, readCompiledCrate, type CompiledBody, type CompiledCrate,
} from "../src/engine/compiled-calls";
import { initEngine } from "../src/engine/parse";

beforeAll(async () => { await initEngine(); }, 120_000);

const HELPERS = [
  "pub struct Counter;",
  "",
  "impl Counter {",
  "    pub fn bump(&self) -> u8 {",
  "        1",
  "    }",
  "    pub fn push(&self) -> u8 {",
  "        2",
  "    }",
  "}",
  "",
  "pub struct Report;",
  "",
  "impl std::fmt::Display for Report {",
  "    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {",
  "        f.write_str(\"report\")",
  "    }",
  "}",
  "",
  "pub fn helper() -> u8 {",
  "    1",
  "}",
  "",
].join("\n");

/** One body per routine; each line after the header is a statement rustc would print. */
function body(path: string, params: string, ...lines: string[]): string {
  return [`fn ${path}(${params}) -> u8 {`, ...lines.map((line) => `    ${line}`), "}", ""].join("\n");
}

const MIR = [
  body("helpers::<impl at src/helpers.rs:3:1: 3:13>::bump", "_1: &Counter", "debug self => _1;", "let mut _0: u8;", "_0 = const 1_u8;"),
  body("helpers::<impl at src/helpers.rs:3:1: 3:13>::push", "_1: &Counter", "debug self => _1;", "let mut _0: u8;", "_0 = const 2_u8;"),
  body("helpers::helper", ""),
  body("callers::by_method", "_1: &Counter",
    "debug c => _1;", "let mut _0: u8;",
    "_0 = helpers::Counter::bump(copy _1) -> [return: bb1, unwind continue];"),
  body("callers::by_function", "",
    "let mut _0: u8;",
    "_0 = helpers::helper() -> [return: bb1, unwind continue];"),
  body("callers::by_impl_segment", "_1: &Counter",
    "let mut _0: u8;",
    "_0 = helpers::<impl Counter>::bump(copy _1) -> [return: bb1, unwind continue];"),
  body("callers::by_vec_push", "_1: &mut Vec<u8>",
    "let mut _0: u8;", "let _2: ();",
    "_2 = Vec::<u8>::push(copy _1, const 1_u8) -> [return: bb1, unwind continue];"),
  body("callers::by_bare_owner", "_1: &Counter",
    "let mut _0: u8;",
    "_0 = Counter::bump(copy _1) -> [return: bb1, unwind continue];"),
  body("callers::shadowed", "",
    "let mut _0: u8;", "let _1: u8;", "debug helper => _1;",
    "_1 = const 3_u8;",
    "_0 = helpers::Counter::bump(const helpers::Counter) -> [return: bb1, unwind continue];"),
  body("callers::builds_report", "",
    "let mut _0: u8;", "let _1: helpers::Report;",
    "_1 = helpers::Report;",
    "_0 = callers::keep(move _1) -> [return: bb1, unwind continue];"),
  body("callers::keep", "_1: helpers::Report", "debug r => _1;", "let mut _0: u8;", "_0 = const 1_u8;"),
  body("callers::shows_report", "_1: &helpers::Report",
    "let mut _0: u8;", "let _2: String;",
    "_2 = <helpers::Report as ToString>::to_string(copy _1) -> [return: bb1, unwind continue];",
    "drop(_2) -> [return: bb2, unwind continue];"),
  body("callers::drops_report", "_1: helpers::Report",
    "let mut _0: u8;", "let _2: helpers::Report;",
    "_2 = move _1;",
    "_0 = callers::keep_ref(const 1_u8) -> [return: bb1, unwind continue];",
    "drop(_2) -> [return: bb2, unwind continue];"),
  body("callers::keep_ref", "_1: u8", "let mut _0: u8;", "_0 = copy _1;"),
  // Names unique among every crate rustc read are printed bare, ours or not.
  body("hold", "_1: u8", "let mut _0: u8;", "_0 = copy _1;"),
  body("callers::by_bare_function", "",
    "let mut _0: u8;",
    "_0 = hold(const 1_u8) -> [return: bb1, unwind continue];"),
  body("callers::by_bare_library_type", "_1: Option<u8>",
    "let mut _0: u8;",
    "_0 = Option::<u8>::unwrap(move _1) -> [return: bb1, unwind continue];"),
].join("\n");

let crate: CompiledCrate;
const of = (name: string): CompiledBody =>
  crate.byName.get(name)?.[0] ?? [...crate.byImpl.values()].flat().find((one) => one.path.endsWith(`::${name}`))!;

beforeAll(() => {
  crate = readCompiledCrate(MIR, "target/debug/deps/shapes.d: src/lib.rs src/helpers.rs src/callers.rs\n", {
    workspace: "/ws", repo: "/ws", root: "/ws/src/lib.rs",
  }, (file) => (file === "src/helpers.rs" ? HELPERS : undefined));
});

describe("a body that runs nothing outside the crate", () => {
  it("is one whose every call is to this crate, under its module", () => {
    expect(of("by_method").onlyHere).toBe(true);
    expect(of("by_function").onlyHere).toBe(true);
    expect(of("by_impl_segment").onlyHere).toBe(true);
    expect(of("builds_report").onlyHere).toBe(true);
  });

  it("is one whose call is written bare, when the bare name is one of this crate's", () => {
    // rustc writes a name unique among every crate bare, so a bare one this crate declares is this crate's.
    expect(of("by_bare_owner").onlyHere).toBe(true);
    expect(of("by_bare_function").onlyHere).toBe(true);
  });

  it("is not one that calls the standard library, bare or not, or calls through a trait", () => {
    expect(of("by_vec_push").onlyHere).toBe(false);
    expect(of("by_bare_library_type").onlyHere).toBe(false);
    expect(of("shows_report").onlyHere).toBe(false);
  });

  it("is not known without the source to read the crate's own types from", () => {
    const blind = readCompiledCrate(MIR, "target/debug/deps/shapes.d: src/lib.rs src/helpers.rs src/callers.rs\n", {
      workspace: "/ws", repo: "/ws", root: "/ws/src/lib.rs",
    });
    expect(blind.byName.get("by_bare_owner")?.[0]?.onlyHere).toBe(false);
  });

  it("is not one that drops a value, whose drop may run anything", () => {
    expect(of("drops_report").onlyHere).toBe(false);
  });
});

describe("rustc's \"never\" on a library trait's method", () => {
  const fmt = { names: ["fmt"], source: HELPERS };

  it("holds when nothing outside the crate runs: building a value and keeping it is not formatting it", () => {
    expect(compiledRefutes([of("builds_report")], fmt)).toEqual({ sites: 1 });
  });

  it("holds for a generic body too, when every call stays in the crate", () => {
    expect(compiledRefutes([of("builds_report")], fmt, new Set(["T"]))).toEqual({ sites: 1 });
  });

  it("is withheld when a library is handed the value, or a value is dropped", () => {
    expect(compiledRefutes([of("shows_report")], fmt)).toEqual({ why: "called-implicitly" });
    expect(compiledRefutes([of("drops_report")], fmt)).toEqual({ why: "called-implicitly" });
  });
});

describe("a local named like the far function", () => {
  it("is not the function: its name alone does not withhold rustc's \"never\"", () => {
    expect(of("shadowed").words.has("helper")).toBe(true);
    expect(compiledRefutes([of("shadowed")], { names: ["helper"], source: HELPERS })).toEqual({ sites: 1 });
  });

  it("still withholds on a name a statement writes", () => {
    expect(compiledRefutes([of("shadowed")], { names: ["Counter"], source: HELPERS })).toEqual({ why: "same-name" });
  });
});

describe("a call in rustc's list confirms only on the far function's own path", () => {
  const head = (names: string[]) => ({ file: "src/helpers.rs", source: HELPERS, names });

  it("confirms a method called under its module and its type", () => {
    expect(ownCallIn(crate, [of("by_method")], head(["bump"]))).toBe("bump");
    expect(ownCallIn(crate, [of("by_impl_segment")], head(["bump"]))).toBe("bump");
  });

  it("confirms a free function under its module", () => {
    expect(ownCallIn(crate, [of("by_function")], head(["helper"]))).toBe("helper");
  });

  it("does not confirm another type's method of the same name", () => {
    expect(ownCallIn(crate, [of("by_vec_push")], head(["push"]))).toBeUndefined();
  });

  it("confirms a method written with its type bare, which rustc does only for a name no other crate has", () => {
    expect(ownCallIn(crate, [of("by_bare_owner")], head(["bump"]))).toBe("bump");
  });

  it("does not confirm a trait method, which a library's blanket implementation may answer", () => {
    expect(ownCallIn(crate, [of("shows_report")], head(["fmt"]))).toBeUndefined();
  });

  it("does not confirm a head outside the crate rustc built", () => {
    expect(ownCallIn(crate, [of("by_method")], { ...head(["bump"]), file: "other/src/helpers.rs" })).toBeUndefined();
  });
});
