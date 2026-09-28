/**
 * A Rust visibility marker is not an import (#319, #366 section 3).
 *
 * `pub(crate) type HashMap<K, V> = ...` says who may see an item. The `crate`
 * inside it resolves to the crate root, so the reader recorded `fnv.rs` as
 * using `lib.rs` although `fnv.rs` has no `use` at all -- and an arrow drawn
 * the wrong way round, `fnv.rs -> lib.rs#GlobSet`, came back green. 4 wrong
 * arrows on the planted bench (ripgrep's globset, clap_lex).
 *
 * The reader still records the marker, because the licence was measured
 * against a referee that counts it; an arrow's verdict no longer rests on it.
 * One test per way the marker is spelt, plus the real imports that must still
 * confirm beside it.
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

const CARGO = '[package]\nname = "demo"\nversion = "0.1.0"\n';

/** A crate whose root declares `mod fnv;` and whose `fnv.rs` holds only `body`. */
function rootAnd(body: string): Workspace {
  return treeWorkspace({
    "Cargo.toml": CARGO,
    "src/lib.rs": "mod fnv;\npub struct GlobSet;\n",
    "src/fnv.rs": body,
  });
}

/** A crate with `src/a/mod.rs` declaring `mod b;`, and `b.rs` holding only `body`. */
function parentAnd(body: string): Workspace {
  return treeWorkspace({
    "Cargo.toml": CARGO,
    "src/lib.rs": "mod a;\n",
    "src/a/mod.rs": "mod b;\npub struct Parent;\n",
    "src/a/b.rs": body,
  });
}

describe("a visibility marker is not an import", () => {
  it("pub(crate) on a type alias: the arrow into the root is backwards", () => {
    // globset's fnv.rs, line 2.
    const workspace = rootAnd("pub(crate) type HashMap<K, V> = std::collections::HashMap<K, V>;\n");
    expect(checkNeeds("src/fnv.rs", "src/lib.rs", workspace)).toMatchObject({
      verdict: "backwards",
      evidence: { file: "src/lib.rs", on: "src/fnv.rs", line: 1 },
    });
  });

  it("pub(crate) on a struct", () => {
    const workspace = rootAnd("pub(crate) struct Hasher(u64);\n");
    expect(checkNeeds("src/fnv.rs", "src/lib.rs", workspace).verdict).toBe("backwards");
  });

  it("pub(crate) on a function", () => {
    const workspace = rootAnd("pub(crate) fn hash(bytes: &[u8]) -> u64 {\n    bytes.len() as u64\n}\n");
    expect(checkNeeds("src/fnv.rs", "src/lib.rs", workspace).verdict).toBe("backwards");
  });

  it("pub(super) on a function", () => {
    const workspace = parentAnd("pub(super) fn helper() -> u32 {\n    1\n}\n");
    expect(checkNeeds("src/a/b.rs", "src/a/mod.rs", workspace).verdict).toBe("backwards");
  });

  it("pub(in crate::a) on a function", () => {
    const workspace = parentAnd("pub(in crate::a) fn helper() -> u32 {\n    1\n}\n");
    expect(checkNeeds("src/a/b.rs", "src/a/mod.rs", workspace).verdict).toBe("backwards");
  });

  it("pub(crate) on a field inside a struct", () => {
    const workspace = rootAnd("pub struct Hasher {\n    pub(crate) state: u64,\n}\n");
    expect(checkNeeds("src/fnv.rs", "src/lib.rs", workspace).verdict).toBe("backwards");
  });
});

describe("a real import beside a marker still confirms", () => {
  it("use crate::... next to pub(crate)", () => {
    const workspace = rootAnd("use crate::GlobSet;\npub(crate) fn make() -> GlobSet {\n    GlobSet\n}\n");
    expect(checkNeeds("src/fnv.rs", "src/lib.rs", workspace)).toMatchObject({
      verdict: "confirmed",
      evidence: { file: "src/fnv.rs", on: "src/lib.rs", line: 1 },
    });
  });

  it("use super::* next to pub(super)", () => {
    const workspace = parentAnd("use super::*;\npub(super) fn make() -> Parent {\n    Parent\n}\n");
    expect(checkNeeds("src/a/b.rs", "src/a/mod.rs", workspace).verdict).toBe("confirmed");
  });

  it("a crate:: path written in a body", () => {
    const workspace = rootAnd("pub(crate) fn make() -> crate::GlobSet {\n    crate::GlobSet\n}\n");
    expect(checkNeeds("src/fnv.rs", "src/lib.rs", workspace).verdict).toBe("confirmed");
  });
});
