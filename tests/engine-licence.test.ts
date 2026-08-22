/**
 * The licence: what the reader had to learn before it could be believed.
 *
 * Every rule below is here because a measurement found it missing, not because
 * somebody thought of it. `scripts/lib/licence.ts` runs the TypeScript compiler
 * over a tree as an independent referee -- its own parser for the specifiers,
 * its own `resolveModuleName` for the files -- and each of these tests pins one
 * of the disagreements that turned up across five repositories and 12,824
 * dependency edges.
 *
 * The referee matters more than the rules. `deps.ts` and the regex channel in
 * `drift.ts` both hand their specifiers to `resolve.ts`, so their agreement was
 * never evidence about the step they share, which is exactly where the tsconfig
 * and package.json nicknames live. Measuring against the compiler is what turned
 * that blind spot into 121 named, fixable misses.
 *
 * The last block is the guard that keeps this true: the same harness over this
 * repository, failing on any disagreement at all.
 */
import { describe, expect, it, beforeAll } from "vitest";
import path from "node:path";

import { readDependencies } from "../src/engine/deps";
import { createWorkspace, type Workspace } from "../src/engine/drift";
import { initEngine } from "../src/engine/parse";
import { resolveDependency } from "../src/engine/resolve";
import { LICENCES, licenceFor, licenceTotals } from "../src/engine/licence";
import { measureLicence } from "../scripts/lib/licence";

beforeAll(async () => {
  await initEngine();
}, 60_000);

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

/** Where a specifier written in `from` lands, given a tree. */
function lands(specifier: string, from: string, files: Record<string, string>): string | undefined {
  return resolveDependency(specifier, from, fakeWorkspace(files))?.rel;
}

describe("a type-only module is still a file", () => {
  it("resolves a specifier whose only match is a declaration", () => {
    // 119 of the 121 misses in the first measurement were this one shape:
    // `import { Foo } from "./utils"` where the only utils is `utils.d.ts`.
    expect(lands("./utils", "src/a.ts", { "src/a.ts": "", "src/utils.d.ts": "" })).toBe("src/utils.d.ts");
  });

  it("prefers the code to the declaration describing it", () => {
    // This repository's own `scripts/lib/box.mjs` ships a hand-written
    // `box.d.mts` beside it. A box on a board is the module, not its types.
    expect(
      lands("./box.mjs", "scripts/check.mjs", {
        "scripts/check.mjs": "",
        "scripts/box.mjs": "",
        "scripts/box.d.mts": "",
      }),
    ).toBe("scripts/box.mjs");
  });

  it("falls back to a declaration when the code is not there", () => {
    expect(lands("./box.mjs", "scripts/check.mjs", { "scripts/check.mjs": "", "scripts/box.d.mts": "" }))
      .toBe("scripts/box.d.mts");
  });

  it("maps a .cjs specifier onto the .cts that will build it", () => {
    expect(lands("./hello.cjs", "src/a.ts", { "src/a.ts": "", "src/hello.cts": "" })).toBe("src/hello.cts");
  });
});

describe("package.json nicknames", () => {
  const tree = {
    "package.json": JSON.stringify({
      imports: { "#types/*": "./types/*.d.ts", "#dep-types/*": "./src/types/*.d.ts" },
    }),
    "src/node/http.ts": "",
    "src/types/connect.d.ts": "",
    "types/hot.d.ts": "",
  };

  it("follows an imports wildcard to the file it names", () => {
    // 77 of vite's 84 remaining misses were `#dep-types/...` alone.
    expect(lands("#dep-types/connect", "src/node/http.ts", tree)).toBe("src/types/connect.d.ts");
    expect(lands("#types/hot", "src/node/http.ts", tree)).toBe("types/hot.d.ts");
  });

  it("takes the condition every reader shares, not the first one offered", () => {
    // vite offers "module-sync" before "default". Whether module-sync holds is
    // not in the text, so it is not a candidate; every compiler takes false.js.
    const conditional = {
      "package.json": JSON.stringify({
        imports: { "#flag": { "module-sync": "./misc/true.js", default: "./misc/false.js" } },
      }),
      "src/a.ts": "",
      "misc/true.js": "",
      "misc/false.js": "",
    };
    expect(lands("#flag", "src/a.ts", conditional)).toBe("misc/false.js");
  });

  it("still lets tsconfig claim a # nickname of its own", () => {
    // vite's resolver fixtures declare `"#/*": ["./src/*"]` in tsconfig paths.
    // Reserving `#` for Node outright lost that edge.
    expect(
      lands("#/imported", "src/hash.ts", {
        "tsconfig.json": JSON.stringify({ compilerOptions: { paths: { "#/*": ["./src/*"] } } }),
        "src/hash.ts": "",
        "src/imported.js": "",
      }),
    ).toBe("src/imported.js");
  });
});

describe("a directory is not always an index file", () => {
  it("follows the entry its own package.json names", () => {
    expect(
      lands("./", "dep/entry.js", {
        "dep/entry.js": "",
        "dep/package.json": JSON.stringify({ main: "lib/main.js" }),
        "dep/lib/main.js": "",
      }),
    ).toBe("dep/lib/main.js");
  });

  it("still prefers index when nothing names an entry", () => {
    expect(lands("./lib", "dep/entry.js", { "dep/entry.js": "", "dep/lib/index.ts": "" }))
      .toBe("dep/lib/index.ts");
  });
});

describe("a package reaching for itself by name", () => {
  const own = {
    "pkg/package.json": JSON.stringify({
      name: "@scope/thing",
      exports: { ".": "./index.js", "./test": "./test/index.js" },
    }),
    "pkg/index.js": "",
    "pkg/test/index.js": "",
    "pkg/test/side.js": "",
  };

  it("resolves the bare name through its own exports", () => {
    expect(lands("@scope/thing", "pkg/test/side.js", own)).toBe("pkg/index.js");
  });

  it("resolves a subpath the exports map declares", () => {
    expect(lands("@scope/thing/test", "pkg/test/side.js", own)).toBe("pkg/test/index.js");
  });

  it("refuses the name when there is no exports field", () => {
    // Node's rule, and the reason it matters: without `exports` the import is
    // simply broken, and resolving it anyway asserts an edge no runtime has.
    const noExports = {
      "pkg/package.json": JSON.stringify({ name: "@scope/thing", main: "index.js" }),
      "pkg/index.js": "",
      "pkg/side.js": "",
    };
    expect(lands("@scope/thing", "pkg/side.js", noExports)).toBeUndefined();
  });

  it("leaves a genuinely third-party name alone", () => {
    expect(lands("@scope/other", "pkg/test/side.js", own)).toBeUndefined();
  });
});

describe("backticks", () => {
  const files = { "src/a.ts": "", "src/static.ts": "" };

  it("reads a template with nothing in it as the string it is", () => {
    const source = "import(`./static`).then(() => {});";
    const read = readDependencies("src/a.ts", source, fakeWorkspace({ ...files, "src/a.ts": source }))!;
    expect(read.dependencies.map((one) => one.file)).toEqual(["src/static.ts"]);
  });

  it("declines to guess at one with a value in it", () => {
    const source = "const n = 'static';\nimport(`./${n}`).then(() => {});";
    const read = readDependencies("src/a.ts", source, fakeWorkspace({ ...files, "src/a.ts": source }))!;
    expect(read.dependencies).toEqual([]);
    expect(read.dynamic).toContain("dynamic-import");
  });
});

describe("the licence on record", () => {
  const licence = LICENCES.find((one) => one.language === "typescript")!;

  it("pins every corpus entry to a commit", () => {
    expect(licence.corpus.length).toBeGreaterThan(0);
    for (const entry of licence.corpus) {
      expect(entry.commit, entry.name).toMatch(/^[0-9a-f]{40}$/);
      expect(entry.url, entry.name).toMatch(/^https:\/\//);
    }
  });

  it("covers a file this tool would actually read", () => {
    expect(licenceFor("src/engine/drift.ts")?.language).toBe("typescript");
    expect(licenceFor("src/engine/board.rs")?.language).toBe("rust");
    expect(licenceFor("src/main.go")).toBeUndefined();
    expect(licenceFor("docs/notes.md")).toBeUndefined();
  });

  it("adds up to the numbers it claims", () => {
    const totals = licenceTotals(licence);
    expect(totals.edges).toBe(12824);
    expect(totals.missed).toBe(2);
    expect(totals.invented).toBe(1);
    expect(totals.recall).toBeGreaterThan(0.9998);
    expect(totals.precision).toBeGreaterThan(0.9999);
  });

  it("names the disagreements it does not expect to close", () => {
    // Two entries for three disagreements: vite's miss and its invention are the
    // same specifier in the same fixture, resolved two defensible ways.
    expect(licence.known.length).toBe(2);
  });
});

describe("the compiler over this repository", () => {
  let measured: Awaited<ReturnType<typeof measureLicence>>;

  beforeAll(async () => {
    measured = await measureLicence(path.resolve(__dirname, ".."));
  }, 120_000);

  it("agrees with the reader on every dependency, both ways", () => {
    // Not a count, which would rot on the next commit -- a disagreement of zero,
    // which is the thing the licence actually claims.
    expect(measured.missed).toEqual([]);
    expect(measured.invented).toEqual([]);
    expect(measured.refereeEdges.size).toBeGreaterThan(200);
  });

  it("has a grammar for every source file it looked at", () => {
    // A silence by design is fine; a silence nobody noticed is how a licence
    // ends up covering less than it says.
    expect(measured.skipped).toEqual([]);
  });
});
