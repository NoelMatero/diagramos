/**
 * `closed`: the claim a box makes, and the walk that has to earn its silence.
 *
 * `needs` gave an arrow a direction. `closed` does the same for a box, and it is
 * what an architecture diagram actually asserts -- you draw a ring round a
 * subsystem and put the rest of the system outside it, and what you mean is *the
 * rest of the system does not reach in here*.
 *
 * The tests below split along the one thing that makes this claim different from
 * every other check in the tool. `needs` is about one pair of files; `closed` is
 * about every file there is. So its two halves are wildly unequal, and the split
 * is the design:
 *
 * - **Refuting is cheap and sound.** One import from outside, and the claim is
 *   false. Nothing else has to be readable; we saw the line.
 * - **Confirming is expensive and gated.** "Nothing reaches in" is a statement
 *   about every file, so it holds only if every file was read. One file that
 *   could import at runtime and the honest answer is *no breach found*, which is
 *   a different sentence from *closed*.
 *
 * Getting that backwards is the failure worth naming: a walk that quietly
 * skipped what it could not read would paint a green box over a subsystem it
 * never opened.
 */
import { describe, expect, it, beforeAll } from "vitest";

import { emptyBoard, type BoardFile } from "../src/engine/board-file";
import { parseBoxClaim } from "../src/engine/claim";
import { checkClosed } from "../src/engine/closed";
import { createDiagram } from "../src/engine/diagram";
import { checkDrift, type Workspace } from "../src/engine/drift";
import { readGraph } from "../src/engine/graph";
import { initEngine } from "../src/engine/parse";
import { installExcalifontMeasurer } from "./helpers/excalifont";

installExcalifontMeasurer();

beforeAll(async () => {
  await initEngine();
}, 60_000);

/**
 * A workspace over a flat file map, with directories inferred from the paths.
 *
 * `list` is real here rather than stubbed, because `closed` is the first check
 * that walks the tree, and a walk against a `list` that returns nothing would
 * pass every test while proving nothing at all.
 */
function fakeWorkspace(files: Record<string, string>): Workspace {
  // The root is "." rather than "": the walk joins with a separator, and a root
  // of "" turns the first child into "/src", which is a different tree.
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

const NO_TESTS = () => false;
const BY_NAME = (file: string) => /\.test\.ts$/.test(file) || file.startsWith("tests/");

/** A repo where `src/engine` is reached from one place outside it. */
const BREACHED = {
  "src/engine/drift.ts": "export const drift = 1;\n",
  "src/engine/inner.ts": "export const inner = 2;\n",
  "src/server/serve.ts": 'import { inner } from "../engine/inner";\nexport const serve = inner;\n',
};

describe("refuting is cheap: one import is enough", () => {
  it("names the file, the line and what it reached", () => {
    const verdict = checkClosed(
      "src/engine", [], Object.keys(BREACHED), fakeWorkspace(BREACHED), NO_TESTS,
    );
    expect(verdict.breaches).toEqual([
      { file: "src/server/serve.ts", into: "src/engine/inner.ts", specifier: "../engine/inner", line: 1 },
    ]);
  });

  it("reports the breach even when other files could not be read", () => {
    // The asymmetry, as a test. A breach is a line somebody read; it does not
    // become less true because a file elsewhere reaches out at runtime.
    const files = {
      ...BREACHED,
      "src/other.ts": 'const later = await import("./whatever");\nexport const other = later;\n',
      "src/whatever.ts": "export const whatever = 1;\n",
    };
    const verdict = checkClosed(
      "src/engine", [], Object.keys(files), fakeWorkspace(files), NO_TESTS,
    );
    expect(verdict.breaches).toHaveLength(1);
    expect(verdict.unread).toContain("src/other.ts");
  });

  it("counts a file inside the directory as inside, however deep", () => {
    const files = {
      "src/engine/a.ts": 'import { b } from "./deep/b";\nexport const a = b;\n',
      "src/engine/deep/b.ts": "export const b = 1;\n",
    };
    const verdict = checkClosed(
      "src/engine", [], Object.keys(files), fakeWorkspace(files), NO_TESTS,
    );
    expect(verdict.breaches).toEqual([]);
    expect(verdict.unread).toEqual([]);
  });

  it("is not fooled by a sibling directory with the same prefix", () => {
    /*
     * `src/engine-tools` is not inside `src/engine`, and a prefix test without
     * the slash says it is -- in both directions at once, which is why this
     * needs a real import to catch it. Treated as inside, the tools file is
     * never scanned, so its reach into the box goes unreported and the box comes
     * back clean. Asserting only that nothing is reported would pass either way,
     * which is exactly how this test failed to catch the bug the first time.
     */
    const files = {
      "src/engine/inner.ts": "export const inner = 1;\n",
      "src/engine-tools/t.ts": 'import { inner } from "../engine/inner";\nexport const t = inner;\n',
    };
    const verdict = checkClosed(
      "src/engine", [], Object.keys(files), fakeWorkspace(files), NO_TESTS,
    );
    expect(verdict.breaches).toEqual([
      { file: "src/engine-tools/t.ts", into: "src/engine/inner.ts", specifier: "../engine/inner", line: 1 },
    ]);
  });

  it("does not treat a sibling's own file as inside the box", () => {
    // The other direction of the same mistake: an import into `engine-tools`
    // read as an import into `engine`, which is an accusation about a boundary
    // nobody drew.
    const files = {
      "src/engine/inner.ts": "export const inner = 1;\n",
      "src/engine-tools/t.ts": "export const t = 1;\n",
      "src/server/a.ts": 'import { t } from "../engine-tools/t";\nexport const a = t;\n',
    };
    const verdict = checkClosed(
      "src/engine", [], Object.keys(files), fakeWorkspace(files), NO_TESTS,
    );
    expect(verdict.breaches).toEqual([]);
  });
});

describe("confirming is gated: silence has to be earned", () => {
  const clean = {
    "src/engine/a.ts": "export const a = 1;\n",
    "src/other.ts": "export const other = 1;\n",
  };

  it("says nothing is unread when everything was read", () => {
    const verdict = checkClosed("src/engine", [], Object.keys(clean), fakeWorkspace(clean), NO_TESTS);
    expect(verdict.breaches).toEqual([]);
    expect(verdict.unread).toEqual([]);
  });

  it("records a file that reaches out at runtime rather than skipping it", () => {
    const files = {
      ...clean,
      "src/runtime.ts": 'const x = await import(`./${name}.js`);\nexport const r = x;\n',
    };
    const verdict = checkClosed("src/engine", [], Object.keys(files), fakeWorkspace(files), NO_TESTS);
    expect(verdict.unread).toEqual(["src/runtime.ts"]);
  });

  it("records a file it could not parse to the end", () => {
    const files = { ...clean, "src/torn.ts": "export function f() { if (true { return 1;\n" };
    const verdict = checkClosed("src/engine", [], Object.keys(files), fakeWorkspace(files), NO_TESTS);
    expect(verdict.unread).toEqual(["src/torn.ts"]);
  });

  it("records a file in a language nobody measured", () => {
    const files = { ...clean, "src/main.rs": "mod helper;\n" };
    const verdict = checkClosed("src/engine", [], Object.keys(files), fakeWorkspace(files), NO_TESTS);
    expect(verdict.unread).toEqual(["src/main.rs"]);
  });

  it("does not count a computed call, which cannot hide an import", () => {
    /*
     * The distinction that keeps this claim usable. `needs` withholds on all
     * four escape flags; `closed` only cares about the two that can conjure a
     * module dependency. You cannot import through `table[key]()`.
     */
    const files = { ...clean, "src/dispatch.ts": "const table = {};\nexport const go = (k) => table[k]();\n" };
    const verdict = checkClosed("src/engine", [], Object.keys(files), fakeWorkspace(files), NO_TESTS);
    expect(verdict.unread).toEqual([]);
  });
});

describe("doors", () => {
  const files = {
    "src/engine/index.ts": "export const index = 1;\n",
    "src/engine/inner.ts": "export const inner = 2;\n",
    "src/server/a.ts": 'import { index } from "../engine/index";\nexport const a = index;\n',
    "src/server/b.ts": 'import { inner } from "../engine/inner";\nexport const b = inner;\n',
  };

  it("lets through exactly what is listed, and nothing else", () => {
    const verdict = checkClosed(
      "src/engine", ["src/engine/index.ts"], Object.keys(files), fakeWorkspace(files), NO_TESTS,
    );
    expect(verdict.breaches.map((breach) => breach.into)).toEqual(["src/engine/inner.ts"]);
  });

  it("reports a door nothing came through", () => {
    // Not a failure. Usually a door that was used until the import that needed
    // it moved, and a stale door silently widens the claim.
    const verdict = checkClosed(
      "src/engine",
      ["src/engine/index.ts", "src/engine/inner.ts", "src/engine/ghost.ts"],
      Object.keys(files),
      fakeWorkspace(files),
      NO_TESTS,
    );
    expect(verdict.breaches).toEqual([]);
    expect(verdict.unusedDoors).toEqual(["src/engine/ghost.ts"]);
  });
});

describe("tests reach into everything, and that is not a breach", () => {
  const files = {
    "src/engine/inner.ts": "export const inner = 1;\n",
    "src/engine/inner.test.ts": 'import { inner } from "./inner";\nexport const t = inner;\n',
    "tests/engine.test.ts": 'import { inner } from "../src/engine/inner";\nexport const t = inner;\n',
    "src/server/a.ts": 'import { inner } from "../engine/inner";\nexport const a = inner;\n',
  };

  it("holds them apart rather than dropping them", () => {
    /*
     * The exclusion this claim cannot live without, and the reason it is carried
     * rather than filtered upstream: an exclusion you cannot see is one that
     * rots. Renaming a file to `foo.test.ts` moves a breach from one list to the
     * other in public. It does not make it disappear.
     */
    const verdict = checkClosed(
      "src/engine", [], Object.keys(files), fakeWorkspace(files), BY_NAME,
    );
    expect(verdict.breaches.map((breach) => breach.file)).toEqual(["src/server/a.ts"]);
    expect(verdict.fromTests.map((breach) => breach.file)).toEqual(["tests/engine.test.ts"]);
  });
});

describe("the vocabulary", () => {
  it("reads both shapes a claim gets written in", () => {
    expect(parseBoxClaim("closed")).toEqual({ claim: { closed: true, through: [] } });
    expect(parseBoxClaim("@Closed")).toEqual({ claim: { closed: true, through: [] } });
    expect(parseBoxClaim({ closed: true })).toEqual({ claim: { closed: true, through: [] } });
    expect(parseBoxClaim({ closed: true, through: ["src/engine/index.ts"] }))
      .toEqual({ claim: { closed: true, through: ["src/engine/index.ts"] } });
  });

  it("refuses anything else out loud", () => {
    expect(parseBoxClaim("sealed")).toEqual({ garbled: "sealed" });
    expect(parseBoxClaim({ sealed: true })).toEqual({ garbled: "sealed" });
    // Not "no claim": a claim spelled wrong. Ignoring it would let the box look
    // checked when nothing read it, and the refusal names the word that was
    // written rather than the empty set it parsed to.
    expect(parseBoxClaim({ closed: false })).toEqual({ garbled: "closed" });
  });

  it("says nothing about a box with no claim at all", () => {
    expect(parseBoxClaim(undefined)).toBeUndefined();
    expect(parseBoxClaim(null)).toBeUndefined();
  });
});

describe("on a board", () => {
  async function boardOf(ref: string, through?: string[]): Promise<BoardFile> {
    const { board } = await createDiagram(emptyBoard(), {
      name: "arch",
      nodes: [{ id: "engine", label: "Engine", ref, closed: through ? { through } : {} }],
      edges: [],
    });
    return board;
  }

  it("writes the claim through create_diagram and reads it back", async () => {
    const board = await boardOf("src/engine", ["src/engine/index.ts"]);
    expect(readGraph(board).nodes[0]!.claim)
      .toEqual({ closed: true, through: ["src/engine/index.ts"] });
  });

  it("reports one finding for a breached box, naming the worst offender", async () => {
    const report = await checkDrift(await boardOf("src/engine"), fakeWorkspace(BREACHED), { edges: false });
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({ kind: "open-box", node: "engine" });
    expect(report.findings[0]!.detail).toContain("src/server/serve.ts line 1");
    expect(report.clean).toBe(false);
    // The whole list is carried separately: "and 36 more" is not actionable.
    expect(report.closedBreaches).toHaveLength(1);
  });

  it("refuses a box whose ref is a file rather than a directory", async () => {
    // Read as "nobody imports this file" it would be a dead-code check wearing
    // a boundary claim's clothes, so it is refused rather than answered.
    const report = await checkDrift(
      await boardOf("src/engine/drift.ts"), fakeWorkspace(BREACHED), { edges: false },
    );
    expect(report.findings[0]).toMatchObject({ kind: "open-box" });
    expect(report.findings[0]!.detail).toContain("is not a directory");
  });

  it("reports an unproven box as a gap rather than a failure", async () => {
    const files = {
      ...BREACHED,
      "src/server/serve.ts": "export const serve = 1;\n",
      "src/runtime.ts": 'const x = await import(`./${n}.js`);\nexport const r = x;\n',
    };
    const report = await checkDrift(await boardOf("src/engine"), fakeWorkspace(files), { edges: false });
    expect(report.findings).toEqual([]);
    expect(report.closedUnproven).toHaveLength(1);
    expect(report.closedUnproven[0]!.unread).toEqual(["src/runtime.ts"]);
    expect(report.claims.closedHeld).toBe(0);
    // The board is not wrong, it is unchecked. Those must not read the same.
    expect(report.clean).toBe(true);
  });

  it("counts a box as held only when every file was read", async () => {
    const files = { ...BREACHED, "src/server/serve.ts": "export const serve = 1;\n" };
    const report = await checkDrift(await boardOf("src/engine"), fakeWorkspace(files), { edges: false });
    expect(report.claims).toMatchObject({ closed: 1, closedHeld: 1 });
    expect(report.closedUnproven).toEqual([]);
    expect(report.clean).toBe(true);
  });

  it("leaves a box with no claim exactly as it was", async () => {
    const { board } = await createDiagram(emptyBoard(), {
      name: "arch",
      nodes: [{ id: "engine", label: "Engine", ref: "src/engine" }],
      edges: [],
    });
    const report = await checkDrift(board, fakeWorkspace(BREACHED), { edges: false });
    expect(report.findings).toEqual([]);
    expect(report.claims.closed).toBe(0);
    expect(report.clean).toBe(true);
  });
});
