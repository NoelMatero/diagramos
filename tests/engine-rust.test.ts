/**
 * Reading Rust dependencies, one rule of the language per test.
 *
 * Every rule below was learned the same way and none of them were guessed: the
 * reader was measured against rust-analyzer over five real repositories
 * (`scripts/lib/licence-rust.ts`), and each rule here is a cluster of
 * disagreements that measurement produced. `[[bin]] path` cost ninety-five
 * edges in ripgrep; `autotests = false` cost six; uniform paths cost six in
 * clap; `super` inside an inline `mod tests` invented eleven in ripgrep alone.
 * A reader built from a reading of the reference would have shipped every one
 * of those, which is the argument for the licence in one paragraph.
 *
 * Rust is here at all to answer a fair question about the previous step: is the
 * licence a mechanism, or is it a story about TypeScript? The way to find out is
 * to put a language through it that shares nothing with TypeScript except the
 * word "import" -- and Rust does not even share that. A TypeScript specifier is
 * a path with half the answer written in it. A Rust path names a position in a
 * module tree that no single file contains.
 */
import { describe, expect, it, beforeAll } from "vitest";

import { checkClosed } from "../src/engine/closed";
import { readDependencies } from "../src/engine/deps";
import type { Workspace } from "../src/engine/drift";
import { licenceFor } from "../src/engine/licence";
import { initEngine } from "../src/engine/parse";
import { readRustLayout, resolveRustPath } from "../src/engine/rust";

beforeAll(async () => {
  await initEngine();
}, 60_000);

/** A workspace over a flat file map, with directories inferred from the paths. */
function fakeWorkspace(files: Record<string, string>): Workspace {
  const norm = (target: string) => {
    const trimmed = target.replace(/^\.\//, "");
    return trimmed === "" || trimmed === "." ? "." : trimmed;
  };
  return {
    resolve: (relative) => (relative.startsWith("../") ? undefined : norm(relative)),
    stat: (target) => {
      const at = norm(target);
      if (at === ".") return "directory";
      if (files[at] !== undefined) return "file";
      return Object.keys(files).some((file) => file.startsWith(`${at}/`)) ? "directory" : "missing";
    },
    read: (target) => files[norm(target)] ?? "",
    list: (target) => {
      const at = norm(target);
      const prefix = at === "." ? "" : `${at}/`;
      const names = new Set<string>();
      for (const file of Object.keys(files)) {
        if (!file.startsWith(prefix)) continue;
        names.add(file.slice(prefix.length).split("/")[0]!);
      }
      return [...names];
    },
  };
}

const MANIFEST = '[package]\nname = "demo"\nedition = "2021"\n';

/**
 * Repo-relative files one file declares a dependency on, in source order.
 *
 * A file naming itself is dropped, which is what every caller does with it:
 * `crate::` inside the crate root, or `super` inside an inline module, resolves
 * to the file it is written in, and a file depending on itself is not a fact
 * anybody wants. `checkNeeds` refuses a same-file pair outright and `closed`
 * skips anything inside the box, so nothing downstream ever sees one.
 */
function depsOf(files: Record<string, string>, file: string): string[] {
  const workspace = fakeWorkspace(files);
  const read = readDependencies(file, files[file]!, workspace, new Map());
  if (!read) throw new Error(`no reader for ${file}`);
  const out: string[] = [];
  for (const dependency of read.dependencies) {
    if (!dependency.file || dependency.file === file) continue;
    if (!out.includes(dependency.file)) out.push(dependency.file);
  }
  return out;
}

function flagsOf(files: Record<string, string>, file: string): string[] {
  const workspace = fakeWorkspace(files);
  return readDependencies(file, files[file]!, workspace, new Map())?.dynamic ?? [];
}

describe("the module tree, which is where a Rust path lands", () => {
  it("reads `mod x;` as the file it creates", () => {
    const files = {
      "Cargo.toml": MANIFEST,
      "src/lib.rs": "mod helper;\n",
      "src/helper.rs": "pub fn go() {}\n",
    };
    expect(depsOf(files, "src/lib.rs")).toEqual(["src/helper.rs"]);
  });

  it("takes `x/mod.rs` when there is no `x.rs`", () => {
    const files = {
      "Cargo.toml": MANIFEST,
      "src/lib.rs": "mod helper;\n",
      "src/helper/mod.rs": "pub fn go() {}\n",
    };
    expect(depsOf(files, "src/lib.rs")).toEqual(["src/helper/mod.rs"]);
  });

  it("puts a plain file's children in the directory named after it", () => {
    /*
     * `mod.rs` and a crate root own the directory they sit in; every other file
     * owns the directory named after it. One level out and a whole subtree
     * resolves to nothing -- silently, which is why it is stated here.
     */
    const files = {
      "Cargo.toml": MANIFEST,
      "src/lib.rs": "mod outer;\n",
      "src/outer.rs": "mod inner;\n",
      "src/outer/inner.rs": "pub fn go() {}\n",
    };
    expect(depsOf(files, "src/outer.rs")).toEqual(["src/outer/inner.rs"]);
  });

  it("names every module along a path, not just the last", () => {
    // `use crate::a::B` depends on the crate root *and* on `a`. Reporting only
    // the deepest loses `use crate::Error`, where the root is the whole answer.
    const files = {
      "Cargo.toml": MANIFEST,
      "src/lib.rs": "mod a;\n",
      "src/a.rs": "pub struct B;\n",
      "src/user.rs": "use crate::a::B;\n",
    };
    expect(depsOf(files, "src/user.rs")).toEqual(["src/lib.rs", "src/a.rs"]);
  });

  it("stops where the modules end and the items begin", () => {
    const files = {
      "Cargo.toml": MANIFEST,
      "src/lib.rs": "mod a;\n",
      "src/a.rs": "pub struct Deep;\n",
      "src/user.rs": "use crate::a::Deep;\n",
    };
    // No `src/a/Deep.rs`, so `Deep` is an item and resolution stops at `a`.
    expect(depsOf(files, "src/user.rs")).toEqual(["src/lib.rs", "src/a.rs"]);
  });

  it("reads `super` as the module one level up", () => {
    const files = {
      "Cargo.toml": MANIFEST,
      "src/lib.rs": "mod group;\n",
      "src/group/mod.rs": "mod one;\nmod two;\n",
      "src/group/one.rs": "pub fn one() {}\n",
      "src/group/two.rs": "use super::one::one;\n",
    };
    expect(depsOf(files, "src/group/two.rs")).toEqual(["src/group/mod.rs", "src/group/one.rs"]);
  });

  it("reads `super` inside an inline module as the same file", () => {
    /*
     * `#[cfg(test)] mod tests { use super::*; }` is in every second Rust file,
     * and its `super` is the file it is written in rather than the one above.
     * Read from the file alone, every test module in the language declares a
     * dependency on its parent that is not there.
     */
    const files = {
      "Cargo.toml": MANIFEST,
      "src/lib.rs": "mod escape;\n",
      "src/escape.rs": "pub fn escape() {}\n\n#[cfg(test)]\nmod tests {\n    use super::escape;\n}\n",
    };
    expect(depsOf(files, "src/escape.rs")).toEqual([]);
  });

  it("resolves a raw identifier to the file its plain name spells", () => {
    // `r#match` is the module `match`; the escape is spelling, not name. It has
    // to survive on the `mod` that creates it and on every path that reaches it.
    const files = {
      "Cargo.toml": MANIFEST,
      "src/lib.rs": "mod r#match;\n",
      "src/match.rs": "pub struct Found;\n",
      "src/user.rs": "use crate::r#match::Found;\n",
    };
    expect(depsOf(files, "src/lib.rs")).toEqual(["src/match.rs"]);
    expect(depsOf(files, "src/user.rs")).toEqual(["src/lib.rs", "src/match.rs"]);
  });
});

describe("every place a `use` can be written", () => {
  const base = {
    "Cargo.toml": MANIFEST,
    "src/lib.rs": "mod a;\nmod b;\n",
    "src/a.rs": "pub struct One;\npub struct Two;\n",
    "src/b.rs": "pub struct Three;\n",
  };

  it("expands a brace list", () => {
    const files = { ...base, "src/user.rs": "use crate::a::{One, Two};\n" };
    expect(depsOf(files, "src/user.rs")).toEqual(["src/lib.rs", "src/a.rs"]);
  });

  it("expands a nested brace list", () => {
    const files = { ...base, "src/user.rs": "use crate::{a::One, b::Three};\n" };
    expect(depsOf(files, "src/user.rs")).toEqual(["src/lib.rs", "src/a.rs", "src/b.rs"]);
  });

  it("follows a glob", () => {
    const files = { ...base, "src/user.rs": "use crate::a::*;\n" };
    expect(depsOf(files, "src/user.rs")).toEqual(["src/lib.rs", "src/a.rs"]);
  });

  it("follows a renamed import", () => {
    const files = { ...base, "src/user.rs": "use crate::a::One as Uno;\n" };
    expect(depsOf(files, "src/user.rs")).toEqual(["src/lib.rs", "src/a.rs"]);
  });

  it("finds a `use` written inside a function body", () => {
    // anyhow puts real imports there, and a reader that only looked at the top
    // of the file would call those two files unrelated.
    const files = { ...base, "src/user.rs": "fn go() {\n    use crate::b::Three;\n}\n" };
    expect(depsOf(files, "src/user.rs")).toEqual(["src/lib.rs", "src/b.rs"]);
  });
});

describe("paths written anywhere else", () => {
  const base = {
    "Cargo.toml": MANIFEST,
    "src/lib.rs": "mod a;\n",
    "src/a.rs": "pub struct Thing;\npub fn go() {}\n",
  };

  it("reads a path in a type position", () => {
    const files = { ...base, "src/user.rs": "impl crate::a::Thing {}\n" };
    expect(depsOf(files, "src/user.rs")).toEqual(["src/lib.rs", "src/a.rs"]);
  });

  it("reads a path out of a macro's token tree", () => {
    /*
     * `write!(f, "{:?}", crate::a::Thing)` is an ordinary dependency in an
     * ordinary place, but a macro argument is a token tree: there is no path
     * node in there, only `crate`, `::`, `a` side by side. regex writes a
     * hundred of its dependencies this way.
     */
    const files = { ...base, "src/user.rs": 'fn go(f: &str) { write!(f, "{:?}", crate::a::Thing); }\n' };
    expect(depsOf(files, "src/user.rs")).toEqual(["src/lib.rs", "src/a.rs"]);
  });

  it("does not read a path out of a `quote!` body", () => {
    /*
     * `quote!` holds code being *written*, not code being run: its paths belong
     * to whatever crate compiles the output. Reading them made every proc-macro
     * crate look like it depended on the library it generates calls into.
     */
    const files = { ...base, "src/user.rs": "fn go() { quote! { crate::a::Thing::new() } }\n" };
    expect(depsOf(files, "src/user.rs")).toEqual([]);
  });

  it("does not mistake a called function for a module of the same name", () => {
    /*
     * Modules and functions are different namespaces in Rust, so a file may sit
     * next to a function sharing its name. The thing being called is never the
     * module.
     */
    const files = {
      ...base,
      "src/a/go.rs": "pub fn helper() {}\n",
      "src/user.rs": "fn run() { crate::a::go(); }\n",
    };
    expect(depsOf(files, "src/user.rs")).toEqual(["src/lib.rs", "src/a.rs"]);
  });

  it("resolves a short name the file bound with a `use`", () => {
    /*
     * `use crate::args;` and then `args::syntax::Config` a hundred lines later
     * is the ordinary way to write Rust, and the second line names a file as
     * surely as the first. A hundred and ten of regex's edges were this shape.
     */
    const files = {
      "Cargo.toml": MANIFEST,
      "src/lib.rs": "mod args;\n",
      "src/args/mod.rs": "pub mod syntax;\n",
      "src/args/syntax.rs": "pub struct Config;\n",
      "src/user.rs": "use crate::args;\n\nfn go() -> args::syntax::Config { args::syntax::Config }\n",
    };
    expect(depsOf(files, "src/user.rs")).toEqual(["src/lib.rs", "src/args/mod.rs", "src/args/syntax.rs"]);
  });

  it("binds the prefix when a brace list says `self`", () => {
    const files = {
      "Cargo.toml": MANIFEST,
      "src/lib.rs": "mod args;\n",
      "src/args/mod.rs": "pub mod syntax;\npub struct Usage;\n",
      "src/args/syntax.rs": "pub struct Config;\n",
      "src/user.rs": "use crate::args::{self, Usage};\n\nfn go() { args::syntax::Config; }\n",
    };
    expect(depsOf(files, "src/user.rs")).toEqual(["src/lib.rs", "src/args/mod.rs", "src/args/syntax.rs"]);
  });

  it("reads `pub(crate)` as the crate root and `pub(self)` as nothing", () => {
    const files = {
      "Cargo.toml": MANIFEST,
      "src/lib.rs": "mod a;\n",
      "src/a.rs": "pub(crate) fn one() {}\npub(self) fn two() {}\n",
    };
    expect(depsOf(files, "src/a.rs")).toEqual(["src/lib.rs"]);
  });

  it("follows `include!` to the file it inlines", () => {
    const files = {
      "Cargo.toml": MANIFEST,
      "src/lib.rs": 'include!("generated.rs");\n',
      "src/generated.rs": "pub fn go() {}\n",
    };
    expect(depsOf(files, "src/lib.rs")).toEqual(["src/generated.rs"]);
  });
});

describe("crates, which the manifest decides and the directory does not", () => {
  it("spells a package name with dashes as a crate name with underscores", () => {
    const files = {
      "one/Cargo.toml": '[package]\nname = "my-lib"\nedition = "2021"\n',
      "one/src/lib.rs": "pub struct Thing;\n",
      "two/Cargo.toml": '[package]\nname = "user"\nedition = "2021"\n',
      "two/src/lib.rs": "use my_lib::Thing;\n",
    };
    expect(depsOf(files, "two/src/lib.rs")).toEqual(["one/src/lib.rs"]);
  });

  it("finds a root named by `[[bin]] path`", () => {
    /*
     * ripgrep puts its binary at `crates/core/main.rs`, nowhere near a `src/`.
     * Ninety-five of the first hundred disagreements on that repository were
     * this one line of manifest.
     */
    const files = {
      "Cargo.toml": '[package]\nname = "demo"\nedition = "2021"\n\n[[bin]]\npath = "core/main.rs"\nname = "demo"\n',
      "core/main.rs": "mod flags;\n",
      "core/flags.rs": "use crate::flags;\n",
    };
    expect(depsOf(files, "core/flags.rs")).toEqual(["core/main.rs"]);
  });

  it("stops auto-discovering tests when the manifest says not to", () => {
    /*
     * With discovery on, every `tests/*.rs` is its own crate; with it off, only
     * the declared one is and the rest are its modules. Read the wrong way,
     * `crate::` in six of ripgrep's test files pointed into a tree that does
     * not exist.
     */
    const files = {
      "Cargo.toml": '[package]\nname = "demo"\nedition = "2021"\nautotests = false\n\n[[test]]\npath = "tests/lib.rs"\nname = "it"\n',
      "src/lib.rs": "pub struct Thing;\n",
      "tests/lib.rs": "mod part;\npub fn shared() {}\n",
      "tests/part.rs": "use crate::shared;\n",
    };
    expect(depsOf(files, "tests/part.rs")).toEqual(["tests/lib.rs"]);
  });

  it("counts a target named twice as one crate", () => {
    /*
     * regex-automata declares `[[test]] path = "tests/lib.rs"` for a file Cargo
     * would have discovered anyway. Listed twice it looks like two crates over
     * one directory, which reads as ambiguous -- and `crate::` in that whole
     * test tree resolves to nothing at all.
     */
    const files = {
      "Cargo.toml": '[package]\nname = "demo"\nedition = "2021"\n\n[[test]]\npath = "tests/lib.rs"\nname = "it"\n',
      "src/lib.rs": "pub struct Thing;\n",
      "tests/lib.rs": "mod part;\npub fn shared() {}\n",
      // A subdirectory, because a top-level `tests/*.rs` would be its own target
      // and the point here is the duplicate, not auto-discovery.
      "tests/part/mod.rs": "use crate::shared;\n",
    };
    expect(depsOf(files, "tests/part/mod.rs")).toEqual(["tests/lib.rs"]);
  });

  it("reads a bare first segment in a `use` as a module of the current one", () => {
    /*
     * Uniform paths: from edition 2018 a `use` may start at an item of the
     * module it is written in, so `pub use generator::*;` beside `mod
     * generator;` is ordinary modern Rust.
     */
    const files = {
      "Cargo.toml": MANIFEST,
      "src/lib.rs": "mod generator;\npub use generator::utils::Helper;\n",
      "src/generator.rs": "pub mod utils;\n",
      "src/generator/utils.rs": "pub struct Helper;\n",
    };
    // `utils` is only reachable through the bare `generator`, so a reader that
    // required a crate name there would stop one module short.
    expect(depsOf(files, "src/lib.rs")).toEqual(["src/generator.rs", "src/generator/utils.rs"]);
  });

  it("reads a bare first segment as crate-root-relative at edition 2015", () => {
    const files = {
      "Cargo.toml": '[package]\nname = "demo"\n',
      "src/lib.rs": "mod a;\nmod user;\n",
      "src/a.rs": "pub struct Thing;\n",
      "src/user.rs": "use a::Thing;\n",
    };
    // The crate root is named too: at 2015 the path is measured from it.
    expect(depsOf(files, "src/user.rs")).toEqual(["src/lib.rs", "src/a.rs"]);
  });

  it("follows a crate re-exported under another name", () => {
    /*
     * `pub extern crate grep_printer as printer;` makes `grep::printer` name a
     * file two packages away, and no directory under `crates/grep` has anything
     * to do with it. Thirty of ripgrep's edges are that shape.
     */
    const files = {
      "printer/Cargo.toml": '[package]\nname = "demo-printer"\nedition = "2021"\n',
      "printer/src/lib.rs": "pub struct Standard;\n",
      "facade/Cargo.toml": '[package]\nname = "facade"\nedition = "2021"\n',
      "facade/src/lib.rs": "pub extern crate demo_printer as printer;\n",
      "user/Cargo.toml": '[package]\nname = "user"\nedition = "2021"\n',
      "user/src/lib.rs": "use facade::printer::Standard;\n",
    };
    expect(depsOf(files, "user/src/lib.rs")).toEqual(["facade/src/lib.rs", "printer/src/lib.rs"]);
  });

  it("follows a re-export chain to the module it stands for", () => {
    const files = {
      "Cargo.toml": MANIFEST,
      "src/lib.rs": "mod sink;\npub use crate::sink::sinks;\n",
      "src/sink.rs": "pub mod sinks {\n    pub struct UTF8;\n}\n",
      "src/user.rs": "use crate::sinks::UTF8;\n",
    };
    expect(depsOf(files, "src/user.rs")).toEqual(["src/lib.rs", "src/sink.rs"]);
  });
});

describe("`#[path]`, which makes one file belong to two crates", () => {
  const SHARED = {
    "Cargo.toml": '[package]\nname = "demo"\nedition = "2021"\n',
    "src/lib.rs": "mod lexical;\n",
    "src/lexical/mod.rs": "pub mod num;\n",
    "src/lexical/num.rs": "pub struct Num;\n",
    "tests/lexical.rs": '#[path = "../src/lexical/mod.rs"]\nmod lexical;\n',
  };

  it("resolves a redirected `mod` past the file sitting where it would have been", () => {
    expect(depsOf(SHARED, "tests/lexical.rs")).toEqual(["src/lexical/mod.rs"]);
  });

  it("sends a later path through the redirection too", () => {
    /*
     * The trap: `tests/lexical.rs` is itself a file called `lexical`, sitting
     * exactly where a reader measuring `crate::lexical` from the directory would
     * look. Read that way, every path in the crate lands on the wrong one of the
     * two and the redirection may as well not be there.
     */
    const files = {
      ...SHARED,
      "tests/lexical.rs": '#[path = "../src/lexical/mod.rs"]\nmod lexical;\n\nuse crate::lexical::num::Num;\n',
    };
    expect(depsOf(files, "tests/lexical.rs")).toEqual(["src/lexical/mod.rs", "src/lexical/num.rs"]);
  });

  it("gives both answers for `crate::` in a file two crates compile", () => {
    /*
     * serde_json shares `src/lexical` between its library and one of its tests,
     * so `crate::` in those files is the library in one build and that test in
     * another. Both are true; picking one and calling it the answer would make
     * the other build's dependencies look like they were never there.
     */
    const files = { ...SHARED, "src/lexical/num.rs": "use crate::lexical::Num;\n" };
    expect(depsOf(files, "src/lexical/num.rs")).toContain("src/lib.rs");
    expect(depsOf(files, "src/lexical/num.rs")).toContain("tests/lexical.rs");
  });
});

describe("the reasons a Rust file cannot support a refutation", () => {
  it("flags a macro at item level, which could be hiding anything", () => {
    /*
     * `cfg_if! { use crate::unix::Fd; }` puts a real import somewhere no grammar
     * can see it -- the `use` inside is three loose tokens. The file says so
     * rather than pretending to have read it.
     */
    const files = {
      "Cargo.toml": MANIFEST,
      "src/lib.rs": "cfg_if! {\n    if #[cfg(unix)] { use crate::unix::Fd; }\n}\n",
    };
    expect(flagsOf(files, "src/lib.rs")).toEqual(["macro-expansion"]);
  });

  it("costs a `closed` box its confirmation, because a macro can hide a `use`", () => {
    /*
     * The flag's own words are that the file could be declaring anything and the
     * reader would not know, and "nothing outside reaches in" is a statement
     * about every file. So the file is recorded as unread rather than counted as
     * clean: the box comes back unproven, not green.
     *
     * The reader does better than the flag suggests -- it pulls `::`-joined runs
     * out of token trees and reads `macro_rules!` bodies where they are written
     * -- so this costs a confirmation only where one would have been a guess.
     */
    const files = {
      "Cargo.toml": MANIFEST,
      "src/lib.rs": "pub mod engine;\npub mod outside;\n",
      "src/engine/mod.rs": "pub struct Inner;\n",
      "src/outside.rs": "wire_up!();\n",
    };
    const rust = Object.keys(files).filter((file) => file.endsWith(".rs"));
    const verdict = checkClosed(
      "src/engine", ["src/engine/mod.rs"], rust, fakeWorkspace(files), () => false,
    );
    expect(verdict.breaches).toEqual([]);
    expect(verdict.unread).toEqual(["src/outside.rs"]);
  });

  it("does not flag a macro inside a function body", () => {
    // No call creates a module dependency that is not declared in the text, so
    // a `write!` in a body blinds nobody.
    const files = {
      "Cargo.toml": MANIFEST,
      "src/lib.rs": 'fn go(f: &str) { write!(f, "hello"); }\n',
    };
    expect(flagsOf(files, "src/lib.rs")).toEqual([]);
  });

  it("reports a file it could not parse to the end as incomplete", () => {
    const files = { "Cargo.toml": MANIFEST, "src/lib.rs": "fn go() { let x = ~~~; }\n" };
    const read = readDependencies("src/lib.rs", files["src/lib.rs"]!, fakeWorkspace(files), new Map());
    expect(read?.complete).toBe(false);
  });
});

describe("what the licence lets Rust say", () => {
  it("covers a Rust file, and still covers nothing it has not measured", () => {
    expect(licenceFor("src/main.rs")?.language).toBe("rust");
    expect(licenceFor("src/main.go")).toBeUndefined();
  });

  it("resolves nothing at all when there is no manifest", () => {
    // No Cargo.toml is no crate, and no crate is no `crate::`. Silence, not a
    // guess at which directory might have been the root.
    const files = { "src/lib.rs": "mod a;\n", "src/a.rs": "use crate::Thing;\n" };
    const layout = readRustLayout(fakeWorkspace(files));
    expect(layout.roots).toEqual([]);
    expect(resolveRustPath(["crate", "Thing"], "src/a.rs", layout, fakeWorkspace(files), true)).toEqual([]);
  });
});
