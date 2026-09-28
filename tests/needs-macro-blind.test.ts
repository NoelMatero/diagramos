/**
 * An escape that cannot hide an import no longer stops an import arrow being
 * called wrong (#366, section 4).
 *
 * A Rust file with a macro at item level, or a TypeScript file with an
 * `import(...)`, was treated as possibly importing anything, so no arrow
 * touching it could ever be called wrong. Most of them cannot hide an import:
 *
 * - a macro inside an `impl` or `trait` body expands to associated items, and
 *   an associated item is never a `use`, a `mod` or an `extern crate` -- the
 *   same footing as a macro inside a function, which never blinded;
 * - a `macro_rules!` defined in the same file is read where it is defined, so
 *   unless its body writes `use`/`mod`/`extern` or builds a path out of an
 *   argument, expanding it names nothing the reader has not seen;
 * - `compile_error!`, `assert!` and the rest of std's expression macros expand
 *   to no item;
 * - `import('class-validator')` loads a package outside the repository, which
 *   cannot be the file an arrow here points at.
 *
 * 8 wrong arrows on the planted bench stayed quiet behind these. A macro from
 * another crate at item level, an `import()` whose name is computed, and a lazy
 * `import()` of a file in this repository still blind.
 */
import { beforeAll, describe, expect, it } from "vitest";

import type { Workspace } from "../src/engine/drift";
import { checkNeeds } from "../src/engine/needs";
import { initEngine } from "../src/engine/parse";

beforeAll(async () => {
  await initEngine();
}, 60_000);

function treeWorkspace(files: Record<string, string>): Workspace {
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
        if (file.startsWith(prefix)) names.add(file.slice(prefix.length).split("/")[0]!);
      }
      return [...names];
    },
  };
}

/**
 * `a.rs` imports `b.rs` and carries `extra`; the arrow `b.rs -> a.rs` is drawn
 * backwards, and says so only when neither file can hide an import.
 */
function backwardsVerdict(extra: string): string {
  const workspace = treeWorkspace({
    "Cargo.toml": '[package]\nname = "demo"\nversion = "0.1.0"\n',
    "src/lib.rs": "mod a;\nmod b;\n",
    "src/a.rs": `use crate::b::B;\npub struct A(B);\n${extra}`,
    "src/b.rs": "pub struct B;\n",
  });
  const verdict = checkNeeds("src/b.rs", "src/a.rs", workspace);
  return verdict.verdict === "withheld" ? `withheld ${verdict.why}` : verdict.verdict;
}

describe("a Rust macro that cannot hide an import", () => {
  it("a macro from another crate inside an impl body", () => {
    // serde_json's number.rs: `forward_to_deserialize_any!` in `impl Deserializer`.
    expect(backwardsVerdict(
      "impl A {\n    serde::forward_to_deserialize_any! { bool i8 }\n}\n",
    )).toBe("backwards");
  });

  it("a macro inside a trait body", () => {
    expect(backwardsVerdict("pub trait T {\n    other::declare_methods!();\n}\n")).toBe("backwards");
  });

  it("a macro_rules! defined in the file, invoked at file level", () => {
    // serde_json's value/from.rs: `from_integer!` building `impl From<..>`s.
    expect(backwardsVerdict(
      "macro_rules! from_integer {\n"
      + "    ($($ty:ident)*) => {\n"
      + "        $(impl From<$ty> for A { fn from(n: $ty) -> Self { A(crate::b::B) } })*\n"
      + "    };\n"
      + "}\n"
      + "from_integer! { i8 i16 }\n",
    )).toBe("backwards");
  });

  it("a test macro defined and invoked inside mod tests", () => {
    // ripgrep's ignore/src/types.rs: `matched!` generating one #[test] each.
    expect(backwardsVerdict(
      "#[cfg(test)]\nmod tests {\n"
      + "    macro_rules! matched {\n"
      + "        ($name:ident, $want:expr) => {\n"
      + "            #[test]\n            fn $name() { assert_eq!($want, true); matched!(@inner); }\n"
      + "        };\n"
      + "        (@inner) => {};\n"
      + "    }\n"
      + "    matched!(one, true);\n"
      + "}\n",
    )).toBe("backwards");
  });

  it("compile_error! at file level", () => {
    // anyhow's lib.rs, behind a #[cfg].
    expect(backwardsVerdict('#[cfg(all())]\ncompile_error!("no");\n')).toBe("backwards");
  });
});

describe("a Rust macro that still could", () => {
  it("a macro from another crate at file level", () => {
    expect(backwardsVerdict("cfg_if::cfg_if! {\n    if #[cfg(unix)] { use crate::b::B as C; }\n}\n"))
      .toBe("withheld dynamic");
  });

  it("a macro_rules! whose body writes a use", () => {
    expect(backwardsVerdict(
      "macro_rules! bring {\n    ($p:path) => { use $p; };\n}\nbring!(std::fmt);\n",
    )).toBe("withheld dynamic");
  });

  it("a macro_rules! whose body writes a mod", () => {
    expect(backwardsVerdict(
      "macro_rules! declare {\n    ($m:ident) => { mod $m; };\n}\ndeclare!(c);\n",
    )).toBe("withheld dynamic");
  });

  it("a macro_rules! whose body builds a path from an argument", () => {
    expect(backwardsVerdict(
      "macro_rules! call {\n    ($m:ident) => { pub fn go() { $m::run() } };\n}\ncall!(c);\n",
    )).toBe("withheld dynamic");
  });

  it("a macro_rules! that invokes a macro from elsewhere", () => {
    expect(backwardsVerdict(
      "macro_rules! wrap {\n    () => { lazy_static::lazy_static! { static ref X: u8 = 1; } };\n}\nwrap!();\n",
    )).toBe("withheld dynamic");
  });

  it("a macro_rules! defined in another file", () => {
    expect(backwardsVerdict("elsewhere!();\n")).toBe("withheld dynamic");
  });
});

function fakeWorkspace(files: Record<string, string>): Workspace {
  return {
    resolve: (relative) => (relative.startsWith("../") ? undefined : relative),
    stat: (target) => {
      if (files[target] !== undefined) return "file";
      return Object.keys(files).some((file) => file.startsWith(`${target}/`)) ? "directory" : "missing";
    },
    read: (target) => files[target] ?? "",
    list: () => [],
  };
}

/** `a.ts` imports `b.ts` and carries `extra`; the arrow `b.ts -> a.ts` is drawn backwards. */
function tsVerdict(extra: string): string {
  const workspace = fakeWorkspace({
    "a.ts": `import { b } from "./b";\nexport const a = b;\n${extra}`,
    "b.ts": "export const b = 1;\n",
  });
  const verdict = checkNeeds("b.ts", "a.ts", workspace);
  return verdict.verdict === "withheld" ? `withheld ${verdict.why}` : verdict.verdict;
}

describe("a TypeScript import() that names its module", () => {
  it("a package named in a string", () => {
    // nest's validation.pipe.ts: `() => import('class-validator')`.
    expect(tsVerdict("export const load = () => import('class-validator');\n")).toBe("backwards");
  });

  it("a package named in a template with nothing interpolated", () => {
    expect(tsVerdict("export const load = () => import(`class-transformer`);\n")).toBe("backwards");
  });

  it("still blinds on a file in this repository, loaded lazily", () => {
    /*
     * A lazy import inside the repo is how a file hands itself to the one it
     * loads, which then calls back: `font.ts` loads `layout.ts` and registers
     * its measurer there. The import is read; the call back the other way is
     * not, so the file stays one that cannot support an absence.
     */
    expect(tsVerdict("export const load = () => import(\"./b\");\n")).toBe("withheld dynamic");
  });

  it("still blinds when the name is computed", () => {
    expect(tsVerdict("export const load = (name: string) => import(name);\n")).toBe("withheld dynamic");
  });

  it("still blinds on a relative file the reader cannot find", () => {
    expect(tsVerdict("export const load = () => import(\"./missing\");\n")).toBe("withheld dynamic");
  });

  it("still blinds when a template interpolates", () => {
    expect(tsVerdict("export const load = (name: string) => import(`./${name}`);\n")).toBe("withheld dynamic");
  });
});
