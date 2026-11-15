/**
 * A needs arrow means the import written in the file names the far file
 * (decided 2026-11-08, #450). What an import names is the language's answer:
 *
 * - TypeScript: the file its specifier resolves to. A barrel in between is a
 *   file in between, so `import { X } from "./lib"` reaches `lib/x.ts` in two
 *   hops. tRPC's arrow onto `links/types.ts`, three files on, was confirmed.
 * - Python: the module the line writes. `from pkg import X` names
 *   `pkg/__init__.py`, and `import a.b.c` names `a.b.c` -- Python runs
 *   `a/b/__init__.py` on the way, and pip's arrow onto it was confirmed.
 * - Rust: the item the path names, wherever `pub use` moved it. `use
 *   crate::DateTime` is `datetime/mod.rs`'s, and that stays confirmed.
 *
 * The refusals come first: what must never be red. A file whose import writes
 * the very name the arrow points at stays a note in TypeScript and Python,
 * because nobody who wrote that line would call the arrow wrong.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { emptyBoard, type BoardFile } from "../src/engine/board-file";
import { createDiagram } from "../src/engine/diagram";
import { accuses, checkDrift, type Workspace } from "../src/engine/drift";
import { checkNeeds } from "../src/engine/needs";
import { initEngine } from "../src/engine/parse";
import { installExcalifontMeasurer } from "./helpers/excalifont";

installExcalifontMeasurer();

beforeAll(async () => { await initEngine(); }, 60_000);

/**
 * In memory and listable. `caseless` answers `stat` the way macOS does, so
 * `src/DateTime/mod.rs` is found when `src/datetime/mod.rs` is there (#449);
 * a listing still gives the names as written.
 */
function memory(files: Record<string, string>, caseless = false): Workspace {
  const norm = (target: string) => {
    const trimmed = target.replace(/^\.\//, "");
    return trimmed === "" || trimmed === "." ? "." : trimmed;
  };
  const real = (target: string) => {
    const at = norm(target);
    if (!caseless) return at;
    const lower = at.toLowerCase();
    for (const file of Object.keys(files)) {
      if (file.toLowerCase() === lower) return file;
      const directory = file.toLowerCase();
      if (directory.startsWith(`${lower}/`)) return file.slice(0, at.length);
    }
    return at;
  };
  return {
    resolve: (relative) => (relative.startsWith("../") ? undefined : norm(relative)),
    stat: (target) => {
      const at = real(target);
      if (at === ".") return "directory";
      if (files[at] !== undefined) return "file";
      return Object.keys(files).some((file) => file.startsWith(`${at}/`)) ? "directory" : "missing";
    },
    read: (target) => files[real(target)] ?? "",
    list: (target) => {
      const at = real(target);
      const prefix = at === "." ? "" : `${at}/`;
      const names = new Set<string>();
      for (const file of Object.keys(files)) if (file.startsWith(prefix)) names.add(file.slice(prefix.length).split("/")[0]!);
      return [...names];
    },
  };
}

async function boardOf(from: string, to: string, claim: "needs" | "depends" = "needs"): Promise<BoardFile> {
  const { board } = await createDiagram(emptyBoard(), {
    name: "arch",
    nodes: [
      { id: "tail", label: "tail", ref: from },
      { id: "head", label: "head", ref: to },
    ],
    edges: [{ from: "tail", to: "head", claim }],
  });
  return board;
}

const check = async (files: Record<string, string>, from: string, to: string, caseless = false) =>
  checkDrift(await boardOf(from, to), memory(files, caseless), { edges: true });

const CARGO = '[package]\nname = "demo"\nversion = "0.1.0"\nedition = "2021"\n';

/** tRPC's shape: a test imports a type through two barrels. */
const BARREL = {
  "src/index.ts": 'export * from "./links";\n',
  "src/links.ts": 'export * from "./links/types";\n',
  "src/links/types.ts": "export type OperationLink = () => void;\nexport type TRPCLink = () => OperationLink;\n",
};

describe("never red: the import writes the name the arrow points at", () => {
  it("TypeScript, through two barrels", async () => {
    const files = { ...BARREL, "src/links/dedupe.test.ts": 'import type { TRPCLink } from "../index";\nexport const x: TRPCLink[] = [];\n' };
    const report = await check(files, "src/links/dedupe.test.ts", "src/links/types.ts#TRPCLink");
    expect(report.edges.filter((finding) => accuses(finding.kind))).toEqual([]);
    expect(report.edges.map((finding) => finding.kind)).toEqual(["needs-one-level-up"]);
    expect(report.edges[0]!.detail).toContain("writes `TRPCLink`, the name this arrow points at");
  });

  it("TypeScript, a member of the name", async () => {
    const files = {
      "lib/index.ts": 'export { Store } from "./store";\n',
      "lib/store.ts": "export class Store { load() { return 1; } }\n",
      "app.ts": 'import { Store } from "./lib";\nexport const s = new Store();\n',
    };
    const report = await check(files, "app.ts", "lib/store.ts#Store.load");
    expect(report.edges.filter((finding) => accuses(finding.kind))).toEqual([]);
  });

  it("TypeScript, a namespace import that writes the name later", async () => {
    const files = { ...BARREL, "src/use.ts": 'import * as trpc from "./index";\nexport const x: trpc.TRPCLink[] = [];\n' };
    const report = await check(files, "src/use.ts", "src/links/types.ts#TRPCLink");
    expect(report.edges.filter((finding) => accuses(finding.kind))).toEqual([]);
  });

  it("Python, through a package that re-exports it", async () => {
    const files = {
      "pkg/__init__.py": "from pkg.thing import Thing\n",
      "pkg/thing.py": "class Thing:\n    pass\n",
      "app.py": "from pkg import Thing\n\n\ndef make():\n    return Thing()\n",
    };
    const report = await check(files, "app.py", "pkg/thing.py#Thing");
    expect(report.edges.filter((finding) => accuses(finding.kind))).toEqual([]);
  });
});

describe("Rust: a use names the item, wherever pub use moved it", () => {
  const crate = {
    "Cargo.toml": CARGO,
    "src/lib.rs": "mod datetime;\nmod naive;\npub use datetime::DateTime;\npub use datetime::Utc;\n",
    "src/datetime/mod.rs": "pub struct DateTime;\npub struct Utc;\nimpl DateTime { pub fn from_utc() -> Self { DateTime } }\n",
    "src/naive.rs": "use crate::{DateTime, Utc};\npub fn naive() -> DateTime { let _ = Utc; DateTime::from_utc() }\n",
  };

  it("confirms the arrow onto the item", async () => {
    const report = await check(crate, "src/naive.rs", "src/datetime/mod.rs#DateTime::from_utc");
    expect(report.edges).toEqual([]);
    expect(checkNeeds("src/naive.rs", "src/datetime/mod.rs", memory(crate)).verdict).toBe("confirmed");
  });

  it("confirms it on a disk that ignores case, where `DateTime` also finds `datetime/` (#449)", async () => {
    // chrono's correct arrow went red on a Mac: the import landed on
    // `src/DateTime/mod.rs`, a file that does not exist under that name.
    expect(checkNeeds("src/naive.rs", "src/datetime/mod.rs", memory(crate, true)).verdict).toBe("confirmed");
    const report = await check(crate, "src/naive.rs", "src/datetime/mod.rs#DateTime::from_utc", true);
    expect(report.edges.filter((finding) => accuses(finding.kind))).toEqual([]);
  });

  it("confirms an arrow onto another item of that file, as a direct import would", async () => {
    // The key calls this true: the file takes `Utc` from there.
    const report = await check(crate, "src/naive.rs", "src/datetime/mod.rs#DateTime");
    expect(report.edges.filter((finding) => accuses(finding.kind))).toEqual([]);
  });
});

describe("Python: a package the file only passes through (#450)", () => {
  const pip = {
    "pip/__init__.py": "",
    "pip/_internal/__init__.py": "def main():\n    return 0\n",
    "pip/_internal/outdated.py": "X = 1\n",
    "pip/_internal/cache.py": "class WheelCache:\n    pass\n",
  };

  it("is never red, even where the package imports the file back", async () => {
    const files = {
      ...pip,
      "pip/_internal/__init__.py": "from pip._internal.install import run\n",
      "pip/_internal/install.py": "import pip._internal.outdated  # noqa: F401\nfrom pip._internal.cache import WheelCache\n\n\ndef run():\n    return WheelCache()\n",
    };
    const report = await check(files, "pip/_internal/install.py", "pip/_internal/__init__.py");
    expect(report.edges.filter((finding) => accuses(finding.kind))).toEqual([]);
  });

  it("confirms the package where the file goes on to use it", async () => {
    const files = {
      ...pip,
      "pip/_internal/install.py": "import pip._internal.outdated\n\n\ndef run():\n    return pip._internal.main()\n",
    };
    expect(checkNeeds("pip/_internal/install.py", "pip/_internal/__init__.py", memory(files)).verdict).toBe("confirmed");
  });

  it("confirms a package the line names: `import a.b`, `from a.b import x`", () => {
    const named = { ...pip, "app.py": "import pip._internal\n" };
    expect(checkNeeds("app.py", "pip/_internal/__init__.py", memory(named)).verdict).toBe("confirmed");
    const from = { ...pip, "app.py": "from pip._internal import main\n" };
    expect(checkNeeds("app.py", "pip/_internal/__init__.py", memory(from)).verdict).toBe("confirmed");
    // Both orders: the package loaded first and named later still counts as named.
    const both = { ...pip, "app.py": "import pip._internal.outdated\nimport pip._internal\n" };
    expect(checkNeeds("app.py", "pip/_internal/__init__.py", memory(both)).verdict).toBe("confirmed");
  });

  it("still confirms the module the line names", () => {
    const files = { ...pip, "app.py": "import pip._internal.outdated\n" };
    expect(checkNeeds("app.py", "pip/_internal/outdated.py", memory(files)).verdict).toBe("confirmed");
  });

  it("is a note that says Python runs the package and the line does not name it", async () => {
    const files = { ...pip, "pip/_internal/install.py": "import pip._internal.outdated  # noqa: F401\n" };
    const report = await check(files, "pip/_internal/install.py", "pip/_internal/__init__.py");
    expect(report.edges.map((finding) => finding.kind)).toEqual(["needs-one-level-up"]);
    expect(report.edges[0]!.detail).toContain("makes Python run pip/_internal/__init__.py but does not name it");
  });

  it("depends: Python does run it, so the dependency is there", async () => {
    const files = { ...pip, "pip/_internal/install.py": "import pip._internal.outdated  # noqa: F401\n" };
    const report = checkDrift(await boardOf("pip/_internal/install.py", "pip/_internal/__init__.py", "depends"),
      memory(files), { edges: true });
    expect(report.edges).toEqual([]);
  });
});

describe("Python star imports: a literal __all__ is exactly what the star brings (#450)", () => {
  /** The tail star-imports `gen`, and reaches the head only through `mid`. */
  const layered = (gen: string) => ({
    "pkg/__init__.py": "",
    "pkg/head.py": "def thing():\n    return 1\n",
    "pkg/mid.py": "from pkg.head import thing\n\n\ndef helper():\n    return thing()\n",
    "pkg/gen.py": gen,
    "pkg/tail.py": "from pkg.gen import *\nfrom pkg.mid import helper\n\n\ndef run():\n    return helper() + made()\n",
  });

  it("keeps the note when the starred module has no __all__", async () => {
    const report = await check(layered("def made():\n    return 2\n"), "pkg/tail.py", "pkg/head.py");
    expect(report.edges.filter((finding) => accuses(finding.kind))).toEqual([]);
    expect(report.edges[0]!.detail).toContain("has a star import");
  });

  it("keeps the note when __all__ lists a name the module imported", async () => {
    const gen = "from pkg.head import thing\n__all__ = [\"made\", \"thing\"]\n\n\ndef made():\n    return 2\n";
    const report = await check(layered(gen), "pkg/tail.py", "pkg/head.py");
    expect(report.edges.filter((finding) => accuses(finding.kind))).toEqual([]);
  });

  it("keeps the note when __all__ is built up", async () => {
    const gen = "__all__ = [\"made\"]\n__all__ += [\"other\"]\n\n\ndef made():\n    return 2\n\n\ndef other():\n    return 3\n";
    const report = await check(layered(gen), "pkg/tail.py", "pkg/head.py");
    expect(report.edges.filter((finding) => accuses(finding.kind))).toEqual([]);
  });

  it("keeps the note when __all__ is not a list of strings", async () => {
    const gen = "from pkg.other import names\n__all__ = names\n\n\ndef made():\n    return 2\n";
    const report = await check({ ...layered(gen), "pkg/other.py": "names = ['made']\n" }, "pkg/tail.py", "pkg/head.py");
    expect(report.edges.filter((finding) => accuses(finding.kind))).toEqual([]);
  });

  it("is red when every star leads to a literal __all__ of the module's own names (trio's generated files)", async () => {
    const gen = "__all__ = [\"made\"]\n\n\ndef made():\n    return 2\n";
    const report = await check(layered(gen), "pkg/tail.py", "pkg/head.py");
    expect(report.edges.map((finding) => finding.kind)).toEqual(["needs-indirect"]);
    expect(report.edges[0]!.detail).toContain("pkg/tail.py → pkg/mid.py → pkg/head.py");
  });
});

describe("a re-export chain is a route, not the import (#450)", () => {
  it("TypeScript: tRPC's arrow onto another name of the far file is red with the hops", async () => {
    const files = { ...BARREL, "src/links/dedupe.test.ts": 'import type { OperationLink } from "../index";\nexport const x: OperationLink[] = [];\n' };
    const report = await check(files, "src/links/dedupe.test.ts", "src/links/types.ts#TRPCLink");
    expect(report.edges.map((finding) => finding.kind)).toEqual(["needs-indirect"]);
    expect(report.edges[0]!.detail).toContain(
      "src/links/dedupe.test.ts doesn't import src/links/types.ts directly; it gets there in 3 hops: "
      + "src/links/dedupe.test.ts → src/index.ts → src/links.ts → src/links/types.ts.",
    );
  });

  it("TypeScript: zx's arrow onto the file behind `export *` is red", async () => {
    const files = {
      "src/vendor.ts": 'export * from "./vendor-core";\nexport * from "./vendor-extra";\n',
      "src/vendor-core.ts": "export const chalk = 1;\n",
      "src/vendor-extra.ts": "export const fs = 1;\nexport const minimist = 2;\n",
      "src/goods.ts": 'import { fs, minimist } from "./vendor";\nexport function sleep() { return fs + minimist; }\n',
    };
    const report = await check(files, "src/goods.ts#sleep", "src/vendor-extra.ts");
    expect(report.edges.map((finding) => finding.kind)).toEqual(["needs-indirect"]);
    expect(report.edges[0]!.detail).toContain("src/goods.ts → src/vendor.ts → src/vendor-extra.ts");
  });

  it("TypeScript: depends still holds over the barrels", async () => {
    const files = { ...BARREL, "src/links/dedupe.test.ts": 'import type { OperationLink } from "../index";\nexport const x: OperationLink[] = [];\n' };
    const report = checkDrift(await boardOf("src/links/dedupe.test.ts", "src/links/types.ts#TRPCLink", "depends"),
      memory(files), { edges: true });
    expect(report.edges).toEqual([]);
  });

  it("Python: trio's arrow onto another name, through a package, is no longer confirmed", async () => {
    // `_abc.py` takes `Task` from `_core`, which has it from `_run.py`; the
    // arrow says it needs `Runner`. Still a note: it writes `Task`.
    const files = {
      "trio/__init__.py": "",
      "trio/_core/__init__.py": "from trio._core._run import Task, Runner\n",
      "trio/_core/_run.py": "class Task:\n    pass\n\n\nclass Runner:\n    pass\n",
      "trio/_abc.py": "from trio._core import Task\n\n\nclass Clock:\n    def start(self, task: Task):\n        return task\n",
    };
    const report = await check(files, "trio/_abc.py#Clock", "trio/_core/_run.py#Runner");
    expect(report.edges.map((finding) => finding.kind)).toEqual(["needs-one-level-up"]);
    expect(report.edges[0]!.detail).toContain("writes `Task`");
  });
});
