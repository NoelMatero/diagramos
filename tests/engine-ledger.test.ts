/**
 * The coverage ledger: whether a verdict was built on a file that is source.
 *
 * Every gate before this one asked something about a file's *contents* -- is the
 * language measured, did the parse finish, does the code reach out at runtime.
 * None of them asked the prior question: **is this a file of this repository at
 * all?** The reader will parse a 13 MB generated bundle in `vendor/` as
 * cheerfully as it parses `src/engine/drift.ts`, and hand back a confident list
 * of dependencies from something nobody wrote. On this repository that is 142
 * files which clear every other gate.
 *
 * Two authorities answer, and a file only has to satisfy either: git, asked what
 * it knows about, and graphify's `manifest.json`. The union is not tidiness --
 * the manifest alone leaves 41 of this repository's own source files unvouched,
 * because it is built at commit time and the files you are working on are the
 * newest ones. That is measured in `ledger.ts`'s header. Git is right about a
 * file one second after you create it; the manifest survives a tree with no
 * `.git`. `loadLedger` below is the manifest half, tested on its own.
 *
 * The two claims use the result in opposite directions, which is the thing these
 * tests are mostly about:
 *
 * - **`needs` subtracts.** It is a claim about two named files, and the
 *   accusation says one of them contains no such dependency. An end no index has
 *   ever read is an end at the edge of the repository, and the verdict is
 *   withheld as `unvouched`.
 * - **`closed` adds.** It is a claim about *every* file, and the tree walk that
 *   feeds it refuses to enter dotted and vendored directories without saying so.
 *   The ledger names what is in there, those files get read, and one that
 *   imports into the box is a breach with a line number rather than a green box.
 *
 * Absent means off, in both directions. A ledger nobody built is not a ledger
 * that said no, and the primary evidence -- our own read of the text -- is the
 * same either way.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, beforeAll } from "vitest";

import { emptyBoard, type BoardFile } from "../src/engine/board-file";
import { createDiagram } from "../src/engine/diagram";
import { checkDrift, type Workspace } from "../src/engine/drift";
import { createLedger, loadLedger, ledgerAdditions, vouchedFor, type Ledger } from "../src/engine/ledger";
import { checkNeeds } from "../src/engine/needs";
import { initEngine } from "../src/engine/parse";
import { installExcalifontMeasurer } from "./helpers/excalifont";

installExcalifontMeasurer();

beforeAll(async () => {
  await initEngine();
}, 60_000);

/** The manifest shape graphify actually writes, so nothing here is invented. */
function manifest(...files: string[]): Record<string, unknown> {
  return Object.fromEntries(files.map((file, index) => [
    file,
    {
      mtime: 1785927163.36 + index,
      seen: 1787221225.46 + index,
      ast_hash: `${index}`.repeat(32).slice(0, 32),
      semantic_hash: `${index}`.repeat(32).slice(0, 32),
    },
  ]));
}

/** A ledger vouching for exactly these files. */
function ledgerOf(...files: string[]): Ledger {
  return loadLedger(manifest(...files))!;
}

function fakeWorkspace(files: Record<string, string>): Workspace {
  // Root is "." rather than "", as in engine-closed.test.ts: the walk joins with
  // a separator, and a root of "" turns the first child into "/src".
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

describe("reading the manifest, strictly", () => {
  // The manifest half on its own. `createLedger` unions this with what git
  // knows, which is not testable against a fake tree and is measured instead.
  it("vouches for every file graphify recorded", () => {
    const ledger = loadLedger(manifest("src/a.ts", "scripts/b.mjs"));
    expect([...ledger!.files].sort()).toEqual(["scripts/b.mjs", "src/a.ts"]);
  });

  it("refuses the whole file when one row is missing its hash", () => {
    // The same strictness loadCodeGraph uses. A ledger we half understand is a
    // ledger that would vouch for the wrong things, and vouching is all it does.
    const rows = manifest("src/a.ts", "src/b.ts");
    delete (rows["src/b.ts"] as Record<string, unknown>).ast_hash;
    expect(loadLedger(rows)).toBeUndefined();
  });

  it("refuses the whole file when one row is missing its mtime", () => {
    const rows = manifest("src/a.ts");
    (rows["src/a.ts"] as Record<string, unknown>).mtime = "yesterday";
    expect(loadLedger(rows)).toBeUndefined();
  });

  it("refuses anything that is not a map of rows", () => {
    expect(loadLedger([{ mtime: 1, ast_hash: "x" }])).toBeUndefined();
    expect(loadLedger("graphify-out/manifest.json")).toBeUndefined();
    expect(loadLedger(null)).toBeUndefined();
    expect(loadLedger({ "src/a.ts": null })).toBeUndefined();
  });

  it("treats a manifest vouching for nothing as no ledger at all", () => {
    // Not an empty ledger: an empty one would silence every verdict on every
    // board, which is not what a zero-row file means. It means nothing ran.
    expect(loadLedger({})).toBeUndefined();
  });

  it("normalises separators, because a ref is always written with slashes", () => {
    expect([...loadLedger(manifest("src\\engine\\a.ts"))!.files]).toEqual(["src/engine/a.ts"]);
  });

  it("vouches for everything when neither authority answered", () => {
    expect(vouchedFor(undefined, "vendor/anything.mjs")).toBe(true);
    expect(vouchedFor(ledgerOf("src/a.ts"), "vendor/anything.mjs")).toBe(false);
  });
});

describe("`needs`, where an unvouched end subtracts", () => {
  /** `from` really does depend on `to`, so the arrow drawn `to -> from` is backwards. */
  const files = {
    "src/app.ts": 'import { bundled } from "../vendor/bundle.mjs";\nexport const app = bundled;\n',
    "vendor/bundle.mjs": "export const bundled = 1;\n",
  };

  async function boardOf(from: string, to: string): Promise<BoardFile> {
    const { board } = await createDiagram(emptyBoard(), {
      name: "arch",
      nodes: [
        { id: "one", label: "One", ref: from },
        { id: "two", label: "Two", ref: to },
      ],
      edges: [{ from: "one", to: "two", claim: "needs" }],
    });
    return board;
  }

  it("withholds a verdict on an end no source index has read", () => {
    // The case from the issue: `vendor/` holds two generated bundles the map has
    // never seen. Nobody listed them here -- the ledger simply does not name them.
    const verdict = checkNeeds(
      "src/app.ts", "vendor/bundle.mjs", fakeWorkspace(files), new Map(), ledgerOf("src/app.ts"),
    );
    expect(verdict).toEqual({ verdict: "withheld", why: "unvouched" });
  });

  it("refuses to call an arrow backwards on the strength of an unvouched file", () => {
    // The one that matters. Drawn `vendor -> app`, the dependency plainly runs
    // the other way, and every other gate would let this through as WRONG.
    const workspace = fakeWorkspace(files);
    expect(checkNeeds("vendor/bundle.mjs", "src/app.ts", workspace, new Map()))
      .toMatchObject({ verdict: "backwards" });
    expect(checkNeeds("vendor/bundle.mjs", "src/app.ts", workspace, new Map(), ledgerOf("src/app.ts")))
      .toEqual({ verdict: "withheld", why: "unvouched" });
  });

  it("still says wrong when both ends are vouched for", () => {
    // The gate must not be a way of never answering. Same tree, same arrow,
    // one more row in the ledger.
    const verdict = checkNeeds(
      "vendor/bundle.mjs", "src/app.ts", fakeWorkspace(files), new Map(),
      ledgerOf("src/app.ts", "vendor/bundle.mjs"),
    );
    expect(verdict).toMatchObject({ verdict: "backwards" });
  });

  it("tells a person the file is gone rather than that it is unvouched", () => {
    // Order of the gates: stat before vouch. Both are true of a deleted file and
    // "could not be read" is the more useful sentence to hear.
    const verdict = checkNeeds(
      "src/app.ts", "src/deleted.ts", fakeWorkspace(files), new Map(), ledgerOf("src/app.ts"),
    );
    expect(verdict).toEqual({ verdict: "withheld", why: "unreadable" });
  });

  it("counts the withholding on the board, so the cost is visible", async () => {
    const report = await checkDrift(
      await boardOf("vendor/bundle.mjs", "src/app.ts"), fakeWorkspace(files),
      { edges: true, ledger: ledgerOf("src/app.ts") },
    );
    expect(report.claims.needsWithheld).toEqual({ unvouched: 1 });
    // Edge verdicts live in report.edges; `backwards-edge` is an EdgeFindingKind
    // and cannot appear in report.findings at all.
    expect(report.edges.filter((edge) => edge.kind === "backwards-edge")).toEqual([]);
    expect(report.clean).toBe(true);
  });
});

describe("`closed`, where a ledger file the walk never offered adds", () => {
  /*
   * `sourceFilesUnder` will not enter a dotted directory, so `.diagramos/` is
   * invisible to it -- and the script in there imports straight into the box.
   * That is the hole: a green box on a walk that never opened the file.
   */
  const files = {
    "src/engine/inner.ts": "export const inner = 1;\n",
    "src/server/serve.ts": "export const serve = 1;\n",
    ".diagramos/show-code-map.mts": 'import { inner } from "../src/engine/inner";\nexport const shown = inner;\n',
  };

  async function boardOf(): Promise<BoardFile> {
    const { board } = await createDiagram(emptyBoard(), {
      name: "arch",
      nodes: [{ id: "engine", label: "Engine", ref: "src/engine", closed: {} }],
      edges: [],
    });
    return board;
  }

  it("holds the box when nothing tells it the hidden file exists", async () => {
    // The regression this prevents, written down first so the next test means
    // something. The import is right there in the tree and the box goes green.
    const report = await checkDrift(await boardOf(), fakeWorkspace(files), { edges: false });
    expect(report.claims).toMatchObject({ closed: 1, closedHeld: 1 });
    expect(report.closedBreaches).toEqual([]);
  });

  it("finds the breach once the ledger says what is in there", async () => {
    const report = await checkDrift(await boardOf(), fakeWorkspace(files), {
      edges: false,
      ledger: ledgerOf("src/engine/inner.ts", "src/server/serve.ts", ".diagramos/show-code-map.mts"),
    });
    expect(report.closedBreaches).toEqual([{
      node: "engine",
      label: "Engine",
      file: ".diagramos/show-code-map.mts",
      into: "src/engine/inner.ts",
      specifier: "../src/engine/inner",
      line: 1,
    }]);
    expect(report.claims.closedHeld).toBe(0);
    expect(report.clean).toBe(false);
  });

  it("never subtracts: a walked file the ledger has not heard of is still read", async () => {
    // The asymmetry with `needs`, as a test. We read `src/server/serve.ts`
    // ourselves and the absence of an import in it is our own evidence.
    const report = await checkDrift(await boardOf(), fakeWorkspace(files), {
      edges: false,
      ledger: ledgerOf(".diagramos/show-code-map.mts"),
    });
    expect(report.closedBreaches).toHaveLength(1);
    expect(report.closedUnproven).toEqual([]);
  });

  it("ignores a ledger file that no longer exists", async () => {
    // A ledger is built at a commit. Treating a since-deleted file as a hole
    // would make every `closed` box unprovable the moment somebody removed one.
    const report = await checkDrift(await boardOf(), fakeWorkspace({
      "src/engine/inner.ts": "export const inner = 1;\n",
      "src/server/serve.ts": "export const serve = 1;\n",
    }), {
      edges: false,
      ledger: ledgerOf("src/engine/inner.ts", "src/server/serve.ts", "src/server/gone.ts"),
    });
    expect(report.claims).toMatchObject({ closed: 1, closedHeld: 1 });
    expect(report.closedUnproven).toEqual([]);
  });

  it("ignores a ledger file in a language no licence covers", async () => {
    // A Python fixture cannot import a TypeScript module, so counting it against
    // the box is pessimism with nothing behind it -- and the walk drops it today
    // for the same reason.
    const report = await checkDrift(await boardOf(), fakeWorkspace({
      "src/engine/inner.ts": "export const inner = 1;\n",
      "src/server/serve.ts": "export const serve = 1;\n",
      "tests/fixtures/sample.py": "import os\n",
    }), {
      edges: false,
      ledger: ledgerOf("src/engine/inner.ts", "src/server/serve.ts", "tests/fixtures/sample.py"),
    });
    expect(report.claims).toMatchObject({ closed: 1, closedHeld: 1 });
    expect(report.closedUnproven).toEqual([]);
  });

  it("offers only the files the walk missed, sorted, and nothing else", () => {
    // Sorted so a report reads the same twice: the ledger's own order is
    // whatever order graphify happened to walk the tree in.
    const workspace = fakeWorkspace({
      ...files,
      ".hidden/later.ts": "export const later = 1;\n",
      ".aaa/first.ts": "export const first = 1;\n",
    });
    // Listed in an order that is neither sorted nor its reverse, so the
    // expectation below is a statement about sorting rather than a coincidence.
    expect(ledgerAdditions(
      ledgerOf(
        "src/engine/inner.ts", ".diagramos/show-code-map.mts", ".hidden/later.ts",
        ".aaa/first.ts", "src/gone.ts", "a.py",
      ),
      ["src/engine/inner.ts", "src/server/serve.ts"],
      workspace,
    )).toEqual([".aaa/first.ts", ".diagramos/show-code-map.mts", ".hidden/later.ts"]);
    expect(ledgerAdditions(undefined, [], workspace)).toEqual([]);
  });
});

describe("the two authorities, against a real tree", () => {
  /*
   * `createLedger` is the only part of this that talks to git and the disk, and
   * it is the part carrying the design decision: either authority is enough. A
   * fake workspace cannot exercise that, so this one uses a real repository.
   */
  let project: string;

  function git(...args: string[]): void {
    execFileSync("git", args, {
      cwd: project,
      stdio: "ignore",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
      },
    });
  }

  function write(relative: string, body: string): void {
    const full = path.join(project, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, body);
  }

  beforeEach(() => {
    project = mkdtempSync(path.join(os.tmpdir(), "ledger-"));
  });
  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
  });

  it("takes git's word for what is source, with no manifest anywhere", () => {
    write(".gitignore", "out/\nvendor/\n");
    write("src/app.ts", "export const app = 1;\n");
    write("out/bundle.js", "export const bundled = 1;\n");
    write("vendor/huge.mjs", "export const huge = 1;\n");
    git("init", "-q");
    git("add", "-A");
    git("commit", "-qm", "first");

    const ledger = createLedger(project)!;
    expect(vouchedFor(ledger, "src/app.ts")).toBe(true);
    // Somebody already wrote these rules down in .gitignore, and
    // --exclude-standard is what reads them.
    expect(vouchedFor(ledger, "out/bundle.js")).toBe(false);
    expect(vouchedFor(ledger, "vendor/huge.mjs")).toBe(false);
  });

  it("vouches for a file created a second ago and never staged", () => {
    // The reason --others is in there. A gate that goes quiet on the file you
    // just wrote is a gate that is off exactly when you are working.
    write(".gitignore", "out/\n");
    write("src/app.ts", "export const app = 1;\n");
    git("init", "-q");
    git("add", "-A");
    git("commit", "-qm", "first");
    write("src/brand-new.ts", "export const fresh = 1;\n");

    expect(vouchedFor(createLedger(project)!, "src/brand-new.ts")).toBe(true);
  });

  it("adds the manifest's files to git's, so either authority is enough", () => {
    // A hidden directory git ignores, that graphify walked anyway. Neither list
    // is a subset of the other, which is the whole reason this is a union.
    write(".gitignore", ".diagramos/\n");
    write("src/app.ts", "export const app = 1;\n");
    write(".diagramos/show-code-map.mts", "export const shown = 1;\n");
    write("graphify-out/manifest.json", JSON.stringify(manifest(".diagramos/show-code-map.mts")));
    git("init", "-q");
    git("add", "-A");
    git("commit", "-qm", "first");

    const ledger = createLedger(project)!;
    expect(vouchedFor(ledger, "src/app.ts")).toBe(true);          // git only
    expect(vouchedFor(ledger, ".diagramos/show-code-map.mts")).toBe(true); // manifest only
    expect(vouchedFor(ledger, "out/bundle.js")).toBe(false);      // neither
  });

  it("falls back to the manifest alone in a tree with no git", () => {
    write("src/app.ts", "export const app = 1;\n");
    write("graphify-out/manifest.json", JSON.stringify(manifest("src/app.ts")));

    const ledger = createLedger(project);
    expect(vouchedFor(ledger!, "src/app.ts")).toBe(true);
    expect(vouchedFor(ledger!, "out/bundle.js")).toBe(false);
  });

  it("stands aside when git knows about nothing at all", () => {
    /*
     * A repository where every file is ignored is a repository git has no
     * opinion about, and no opinion must not be read as "none of these are
     * source" -- that would silence every verdict on the board. The guard is
     * `files.size === 0`, and without it this is the case that breaks.
     */
    write(".gitignore", "*\n");
    write("src/app.ts", "export const app = 1;\n");
    git("init", "-q");
    expect(createLedger(project)).toBeUndefined();
  });

  it("stands aside entirely when neither authority answered", () => {
    // No git, no manifest. Not an empty ledger -- no ledger, and every verdict
    // goes on exactly as it did before this module existed.
    write("src/app.ts", "export const app = 1;\n");
    expect(createLedger(project)).toBeUndefined();
  });

  it("stands aside when the manifest is corrupt and there is no git either", () => {
    write("graphify-out/manifest.json", "{ not json");
    expect(createLedger(project)).toBeUndefined();
  });
});
