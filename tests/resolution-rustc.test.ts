/**
 * `rustc` as a referee for rust-analyzer's type answers (#250).
 *
 * The question #246 could not answer: three quarters of rust-analyzer's answers
 * had nothing independent weighed against them, because the only independent
 * check was our own syntactic reader and it names a type for a fifth of
 * receivers. The compiler names one for all of them. It is asked by planting a
 * probe at each receiver -- a method that exists only under a trait bound
 * nothing satisfies -- and reading the error it prints, which states the
 * receiver's type and points at that type's declaration.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  askRustc, declaredByMacro, probeMethodName, probeSource, readProbeAnswer,
  type RustcMessage, type RustcReading, type RustcSite,
} from "../scripts/lib/resolution-rustc";

const hasCargo = (() => {
  try { execFileSync("cargo", ["--version"], { stdio: "ignore" }); return true; }
  catch { return false; }
})();

/** A first build of a fresh workspace, under a loaded test suite. */
const LIVE_TIMEOUT_MS = 180_000;

/** A span as `cargo check --message-format=json` writes one, trimmed to what is read. */
function span(file_name: string, line_start: number, label: string | null, is_primary = false) {
  return { file_name, line_start, label, is_primary };
}

describe("probeSource", () => {
  it("wraps a receiver so the call still reads as a call on the same expression, on the same line", () => {
    const source = "fn f(x: Vec<u8>) -> usize {\n    x.len()\n}\n";
    const start = source.indexOf("x.len") ;
    const probed = probeSource(source, [{ id: 7, start, end: start + 1 }]);

    expect(probed.split("\n")).toHaveLength(source.split("\n").length);
    const name = probeMethodName(7);
    expect(probed).toContain(
      `({ trait __P7 { fn ${name}(&self) {} } trait __Q7 {} impl<T: ?Sized + __Q7> __P7 for T {} `
      + `let __p = x; __p.${name}(); __p }).len()`);
  });

  it("nests the probes of a chain, where one receiver is the start of the next one's", () => {
    // `w.items.iter().count()`: `.iter()`'s receiver is `w.items`, and
    // `.count()`'s is `w.items.iter()` -- two ranges sharing a start.
    const source = "fn f(w: W) -> usize { w.items.iter().count() }";
    const start = source.indexOf("w.items");
    const inner = { id: 1, start, end: start + "w.items".length };
    const outer = { id: 2, start, end: start + "w.items.iter()".length };

    const [one, two] = [probeMethodName(1), probeMethodName(2)];
    const expected = "fn f(w: W) -> usize { "
      + `({ trait __P2 { fn ${two}(&self) {} } trait __Q2 {} impl<T: ?Sized + __Q2> __P2 for T {} let __p = `
      + `({ trait __P1 { fn ${one}(&self) {} } trait __Q1 {} impl<T: ?Sized + __Q1> __P1 for T {} let __p = `
      + `w.items; __p.${one}(); __p }).iter()`
      + `; __p.${two}(); __p }).count() }`;
    // Either order of the input list is the same chain.
    expect(probeSource(source, [inner, outer])).toBe(expected);
    expect(probeSource(source, [outer, inner])).toBe(expected);
  });
});

describe("probeMethodName", () => {
  /** Levenshtein distance, which is what rustc's similar-name search measures. */
  function distance(a: string, b: string): number {
    let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const current = [i];
      for (let j = 1; j <= b.length; j++) {
        current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      previous = current;
    }
    return previous[b.length]!;
  }

  it("names probes so that rustc does not find them similar to one another", () => {
    /*
     * Every probe is a method call that fails, and for each failure rustc looks
     * for a method with a similar name to suggest -- within a third of the
     * name's length. `__probe_17` and `__probe_183` are that close, and so is
     * nearly every pair of such names, so each error searched all the others:
     * 100 probes built in 1.6s, 200 in 5.9s, 400 in 266s, and one ripgrep crate
     * ran past half an hour. Names that share nothing but a prefix built 400 in
     * 0.8s and 800 in 1.8s. Measured on rustc 1.93.
     */
    const names = Array.from({ length: 300 }, (_, id) => probeMethodName(id));
    expect(new Set(names).size).toBe(names.length);
    let close = 0;
    let pairs = 0;
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        pairs += 1;
        const reach = Math.floor(Math.max(names[i]!.length, 3) / 3);
        if (distance(names[i]!, names[j]!) <= reach) close += 1;
      }
    }
    expect(close / pairs).toBeLessThan(0.01);
  });
});

describe("readProbeAnswer", () => {
  it("reads the type rustc states and the declaration it points at, through a reference", () => {
    // Captured from rustc 1.93 on a two-crate workspace: `&h.items[0]`, whose
    // element type is `dep::Match`, declared on line 2 of the other crate.
    const message: RustcMessage = {
      level: "error",
      code: { code: "E0599" },
      message: `the method \`${probeMethodName(3)}\` exists for reference \`&dep::Match\`, but its trait bounds were not satisfied`,
      spans: [
        span("app/src/main.rs", 10, "method cannot be called on `&dep::Match` due to unsatisfied trait bounds", true),
        span("/work/copy/dep/src/lib.rs", 2, "doesn't satisfy `dep::Match: main::__P3` or `dep::Match: main::__Q3`"),
      ],
    };
    const read = readProbeAnswer(message, (file) => file.replace("/work/copy", "/repo"));

    expect(read).toEqual({
      id: 3,
      answer: {
        printed: "&dep::Match",
        kind: "reference",
        declaration: { file: "/repo/dep/src/lib.rs", line: 1 },
      },
    });
  });

  it("takes the declaration of the type itself, not of a type inside it", () => {
    // Captured: `self.cb` typed `Box<dyn Fn() -> usize>`. rustc points at both
    // `trait Fn` and `struct Box`, and lists `Fn` first.
    const std = "/Users/me/.rustup/toolchains/stable/lib/rustlib/src/rust/library";
    const message: RustcMessage = {
      level: "error",
      code: { code: "E0599" },
      message: `the method \`${probeMethodName(6)}\` exists for struct \`Box<dyn Fn() -> usize>\`, but its trait bounds were not satisfied`,
      spans: [
        span(`${std}/core/src/ops/function.rs`, 76, "doesn't satisfy `dyn Fn() -> usize: main::__Q6`"),
        span(`${std}/alloc/src/boxed.rs`, 234, "doesn't satisfy `Box<dyn Fn() -> usize>: main::__P6` or `Box<dyn Fn() -> usize>: main::__Q6`"),
        span("app/src/main.rs", 12, "method cannot be called due to unsatisfied trait bounds", true),
      ],
    };

    expect(readProbeAnswer(message, (file) => file)?.answer.declaration)
      .toEqual({ file: `${std}/alloc/src/boxed.rs`, line: 233 });
  });

  it("reads the longer label rustc writes for a type declared in the crate being built", () => {
    // Captured from ripgrep's `grep-matcher`: a local struct's label says why the
    // method is missing before it says which bound failed.
    const name = probeMethodName(4911);
    const message: RustcMessage = {
      level: "error",
      code: { code: "E0599" },
      message: `the method \`${name}\` exists for struct \`ByteSet\`, but its trait bounds were not satisfied`,
      spans: [
        span("crates/matcher/src/lib.rs", 297, "method cannot be called on `ByteSet` due to unsatisfied trait bounds", true),
        span("crates/matcher/src/lib.rs", 288,
          `method \`${name}\` not found for this struct because it doesn't satisfy \`ByteSet: __P4911\` or \`ByteSet: __Q4911\``),
      ],
    };

    expect(readProbeAnswer(message, (file) => file)?.answer.declaration)
      .toEqual({ file: "crates/matcher/src/lib.rs", line: 287 });
  });

  it("takes the one declaration rustc points at when the type is still being inferred", () => {
    // Captured from ripgrep's `grep-matcher`: the receiver's type still holds an
    // inference hole at the probe, and the label spells the whole type `_`.
    // The span is still `enum Result`, and it is the only one.
    const std = "/Users/me/.rustup/toolchains/stable/lib/rustlib/src/rust/library";
    const message: RustcMessage = {
      level: "error",
      code: { code: "E0599" },
      message: `the method \`${probeMethodName(4917)}\` exists for enum \`Result<Result<(), _>, <Self as Matcher>::Error>\`, but its trait bounds were not satisfied`,
      spans: [
        span("crates/matcher/src/lib.rs", 657, "method cannot be called due to unsatisfied trait bounds", true),
        span(`${std}/core/src/result.rs`, 557, "doesn't satisfy `_: __P4917` or `_: __Q4917`"),
      ],
    };

    expect(readProbeAnswer(message, (file) => file)?.answer.declaration)
      .toEqual({ file: `${std}/core/src/result.rs`, line: 556 });
  });

  it("reads a type parameter, which rustc reports in other words and which declares no type", () => {
    // Captured: `fn generic<T: Clone>(t: T)`, probing `t`. The span rustc adds
    // is the parameter in the signature -- not a type's declaration, so it is
    // not offered as one.
    const message: RustcMessage = {
      level: "error",
      code: { code: "E0599" },
      message: `no method named \`${probeMethodName(1)}\` found for type parameter \`T\` in the current scope`,
      spans: [
        span("app/src/main.rs", 6, `method \`${probeMethodName(1)}\` not found for this type parameter`),
        span("app/src/main.rs", 6, "method not found in `T`", true),
      ],
    };

    expect(readProbeAnswer(message, (file) => file))
      .toEqual({ id: 1, answer: { printed: "T", kind: "type parameter" } });
  });
});

describe("declaredByMacro", () => {
  it("recognises core's `str::Split`, where rustc lands in the macro body and rust-analyzer on the call", () => {
    // Both captured from this corpus: `core/src/str/iter.rs:495` is inside
    // `generate_pattern_iterators!`, and `:794` is the invocation naming Split.
    expect(declaredByMacro(
      "        pub struct $forward_iterator<'a, P: Pattern>(pub(super) $internal_iterator<'a, P>);",
      "        struct Split;",
      "std::str::Split<'_, char>",
    )).toBe(true);
  });

  it("recognises the two other macro shapes in this corpus, which are not `struct` lines at all", () => {
    // `AtomicUsize`: rust-analyzer's line is the macro's argument list, and the
    // type's name sits in it bare. `ROUTES`: rustc lands on `lazy_static!`'s
    // inner forwarding call, which declares nothing at all.
    expect(declaredByMacro("        pub struct $atomic_type {", "            usize AtomicUsize", "AtomicUsize")).toBe(true);
    expect(declaredByMacro(
      "        __lazy_static_internal!($(#[$attr])* (pub) static ref $N : $T = $e; $($t)*);",
      "    pub static ref ROUTES: Mutex<Vec<RouteInfo>> = Mutex::new(Vec::new());",
      "ROUTES",
    )).toBe(true);
  });

  it("does not excuse two answers that are genuinely different types", () => {
    // ripgrep's `args.iter().skip(1)`: rustc says `Skip`, rust-analyzer says
    // `Vec`, and one of them is wrong. Neither line is a macro body.
    expect(declaredByMacro(
      "pub struct Skip<I> {",
      "pub struct Vec<T, A: Allocator = Global> {",
      "Skip<std::slice::Iter<'_, &str>>",
    )).toBe(false);
  });

  it("does not excuse a macro-declared type when the other answer names a different one", () => {
    // The condition that carries the weight: a macro body on rustc's side is
    // not enough on its own.
    expect(declaredByMacro("        pub struct $atomic_type {", "pub struct Vec<T> {", "AtomicUsize")).toBe(false);
  });

  it("will not take a name that merely contains the other, which this corpus has next to each other", () => {
    // `Split` and `SplitN` are declared eleven lines apart in `core`.
    expect(declaredByMacro("        pub struct $forward_iterator<'a, P: Pattern>(", "        struct SplitN;", "std::str::Split<'_, char>")).toBe(false);
  });
});

describe.skipIf(!hasCargo)("askRustc, against a real cargo workspace", () => {
  let tree: string;
  let work: string;
  let reading: RustcReading;
  const sites: RustcSite[] = [];
  const at = (relative: string, receiver: string, occurrence = 0): number => {
    const file = path.join(tree, relative);
    const source = readFileSync(file, "utf8");
    let start = -1;
    for (let i = 0; i <= occurrence; i++) start = source.indexOf(receiver, start + 1);
    if (start < 0) throw new Error(`fixture bug: ${receiver} not in ${relative}`);
    const id = sites.length;
    sites.push({ id, file, start, end: start + receiver.length });
    return id;
  };
  const write = (relative: string, contents: string) => {
    const full = path.join(tree, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, contents);
  };

  let inDependency: number, throughAlias: number, field: number, chain: number, fromCall: number, inactive: number;
  let inLibrary: number, inTests: number, inBinary: number;

  beforeAll(async () => {
    tree = realpathSync(mkdtempSync(path.join(os.tmpdir(), "rustc-referee-tree-")));
    work = mkdtempSync(path.join(os.tmpdir(), "rustc-referee-work-"));
    write("Cargo.toml", '[workspace]\nmembers = ["dep", "app", "user"]\nresolver = "2"\n');
    write("user/Cargo.toml", '[package]\nname = "user"\nversion = "0.1.0"\nedition = "2021"\n[dev-dependencies]\ndep = { path = "../dep" }\n');
    write("user/src/lib.rs", [
      "pub fn words(text: &str) -> usize { text.len() }",
      "#[cfg(test)]",
      "mod tests {",
      "    #[test]",
      "    fn counts() {",
      "        let found = vec![dep::Match { n: 1 }];",
      "        assert_eq!(dep::total(&found), found.len());",
      "    }",
      "}",
      "",
    ].join("\n"));
    write("dep/Cargo.toml", '[package]\nname = "dep"\nversion = "0.1.0"\nedition = "2021"\n');
    write("dep/src/lib.rs", [
      "pub mod inner {",
      "    pub struct Match {",
      "        pub n: usize,",
      "    }",
      "    impl Match { pub fn len(&self) -> usize { self.n } }",
      "}",
      "pub use inner::Match;",
      "pub fn total(found: &[Match]) -> usize { found.len() }",
      "",
    ].join("\n"));
    write("user/src/main.rs", "fn main() { let count = user::words(\"x\"); println!(\"{}\", count.count_ones()); }\n");
    write("app/Cargo.toml", '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n[dependencies]\ndep = { path = "../dep" }\n');
    write("app/src/main.rs", [
      "use dep::Match;",
      "type Range = Match;",
      "struct Holder { items: Vec<Range> }",
      "fn make() -> Range { Match { n: 1 } }",
      "fn main() {",
      "    let held: Range = make();",
      "    let w = Holder { items: vec![make()] };",
      "    let a = held.len() + w.items.len() + w.items.iter().count() + make().len();",
      "    #[cfg(windows)]",
      "    let _ = make().len();",
      "    println!(\"{a}\");",
      "}",
      "",
    ].join("\n"));
    inDependency = at("dep/src/lib.rs", "found", 1);
    throughAlias = at("app/src/main.rs", "held", 1);
    field = at("app/src/main.rs", "w.items", 1);
    chain = at("app/src/main.rs", "w.items.iter()");
    fromCall = at("app/src/main.rs", "make()", 3);
    inactive = at("app/src/main.rs", "make()", 4);
    inLibrary = at("user/src/lib.rs", "text", 1);
    inTests = at("user/src/lib.rs", "found", 2);
    inBinary = at("user/src/main.rs", "count", 1);
    reading = await askRustc(tree, [tree], sites, { workDir: work });
  }, LIVE_TIMEOUT_MS);

  afterAll(() => {
    if (tree) rmSync(tree, { recursive: true, force: true });
    if (work) rmSync(work, { recursive: true, force: true });
  });

  it("answers for a crate whose dependency's probes fail to compile", () => {
    // `dep` fails on its own probe, so `app` cannot be checked in the same
    // build. Every answer below is in `app`.
    expect(reading.answers.get(inDependency)?.printed).toMatch(/^&\[(?:crate::)?(?:inner::|dep::)?Match\]$/);
    // A slice is a type with no declaration of its own.
    expect(reading.answers.get(inDependency)?.declaration).toBeUndefined();
    expect(reading.answers.get(fromCall)).toBeDefined();
  });

  it("follows an alias to the struct it names, declared in the other crate", () => {
    expect(reading.answers.get(throughAlias)?.declaration)
      .toEqual({ file: path.join(tree, "dep/src/lib.rs"), line: 1 });
    expect(reading.answers.get(fromCall)?.declaration)
      .toEqual({ file: path.join(tree, "dep/src/lib.rs"), line: 1 });
  });

  it("types a field and a chain, which the text alone cannot", () => {
    expect(reading.answers.get(field)?.printed).toMatch(/^Vec<.*Match>$/);
    expect(reading.answers.get(field)?.declaration?.file).toMatch(/library\/alloc\/src\/vec\/mod\.rs$/);
    expect(reading.answers.get(chain)?.printed).toMatch(/^std::slice::Iter<'_, .*Match>$|^Iter<'_, .*Match>$/);
  });

  it("answers inside a crate's unit tests when they use a dependency that has probes of its own", () => {
    // `user` builds without `dep`; its tests do not. A strategy that settles a
    // file once any site in it answers takes `text` and never comes back for
    // `found` -- ripgrep's printer lost 923 of 1,246 sites that way.
    expect(reading.answers.get(inLibrary)?.printed).toBe("&str");
    expect(reading.answers.get(inTests)?.printed).toMatch(/^Vec<.*Match>$/);
  });

  it("answers in a package's binary, which links a library whose own probes fail", () => {
    // `user`'s binary cannot build while `user`'s library carries probes, so it
    // takes a second build with only the unanswered sites probed.
    expect(reading.answers.get(inBinary)?.printed).toBe("usize");
  });

  it("gives no answer for code the build does not compile", () => {
    expect(reading.answers.has(inactive)).toBe(false);
  });

  it("leaves the tree it measured untouched", () => {
    expect(readFileSync(path.join(tree, "dep/src/lib.rs"), "utf8")).not.toContain("let __p = ");
    expect(readFileSync(path.join(tree, "app/src/main.rs"), "utf8")).not.toContain("let __p = ");
  });
});
