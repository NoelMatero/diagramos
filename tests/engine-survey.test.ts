/**
 * The shape of a board, decided before a box is drawn (#186).
 *
 * Twenty-one boards in this repository were drawn against a 553-line guide, and
 * across them 47% of boxes carry a code anchor, 5% of arrows carry a checkable
 * claim, and nine do not render legibly. Those are not careless authors: nothing
 * told any of them how many boxes to draw, what a box should stand for, or when
 * one board should have been two, so each session decided for itself.
 *
 * So the bar here is not that a survey returns something. It is that the four
 * decisions come back *answered by measurement*, that the board a survey drafts
 * survives the engine's own checker, and that a scope the reader cannot read is
 * refused rather than drafted badly -- because a confident draft of a language
 * nobody measured is exactly the false red the rest of this engine is built to
 * avoid.
 */
import { readFileSync } from "node:fs";

import { beforeAll, describe, expect, it } from "vitest";

import { emptyBoard } from "../src/engine/board-file";
import { createDiagram } from "../src/engine/diagram";
import { checkDrift, createWorkspace, type Workspace } from "../src/engine/drift";
import { initEngine } from "../src/engine/parse";
import { edgesFor, scanScope, surveyScope } from "../src/engine/survey";
import { installExcalifontMeasurer, uninstallExcalifontMeasurer } from "./helpers/excalifont";

beforeAll(async () => {
  await initEngine();
}, 60_000);

/** A tree that exists only here, so a survey can be held to an exact answer. */
function fakeWorkspace(files: Record<string, string>): Workspace {
  const paths = Object.keys(files);
  return {
    resolve: (relative) => (relative.startsWith("../") ? undefined : relative),
    stat: (target) => {
      if (files[target] !== undefined) return "file";
      return paths.some((file) => file.startsWith(`${target}/`)) ? "directory" : "missing";
    },
    read: (target) => files[target] ?? "",
    list: (target) => {
      const prefix = target === "." ? "" : `${target}/`;
      const names = new Set<string>();
      for (const file of paths) {
        if (!file.startsWith(prefix)) continue;
        names.add(file.slice(prefix.length).split("/")[0]);
      }
      return [...names];
    },
  };
}

describe("what a survey reads", () => {
  it("finds every source file under the scope and skips the directories a ref could never point at", () => {
    const workspace = fakeWorkspace({
      "src/a.ts": "import './b';",
      "src/b.ts": "",
      "src/nested/c.ts": "",
      "src/a.test.ts": "",
      "src/node_modules/dep/index.ts": "",
      "src/dist/a.js": "",
      "src/tests/helper.ts": "",
      "src/notes.md": "",
    });
    const { files } = scanScope("src", workspace);
    expect(files).toEqual(["src/a.ts", "src/b.ts", "src/nested/c.ts"]);
  });

  it("counts what it could not read, by language, instead of pretending the scope is empty", () => {
    const workspace = fakeWorkspace({
      "app/main.py": "import helpers",
      "app/helpers.py": "",
      "app/util.ts": "",
    });
    const { read, unread } = scanScope("app", workspace);
    expect(read).toBe(1);
    expect(unread).toEqual({ python: 2 });
  });

  it("keeps only dependencies that land inside the scope, since a board cannot point at a box it lacks", () => {
    const workspace = fakeWorkspace({
      "src/in/a.ts": "import '../out/b';\nimport './c';",
      "src/in/c.ts": "",
      "src/out/b.ts": "",
    });
    const { deps } = scanScope("src/in", workspace);
    expect(deps.get("src/in/a.ts")).toEqual([{ to: "src/in/c.ts", line: 2, declaration: true }]);
  });
});

describe("the arrows a grouping implies", () => {
  const workspace = fakeWorkspace({
    "src/api/route.ts": "import '../core/parse';",
    "src/api/middleware.ts": "import '../core/parse';",
    "src/core/parse.ts": "import './token';",
    "src/core/token.ts": "",
  });

  it("carries the line the dependency was read from, so the claim is a transcription", () => {
    const { deps } = scanScope("src", workspace);
    const edges = edgesFor(
      [
        { id: "api", label: "api", dir: "src/api", files: ["src/api/route.ts", "src/api/middleware.ts"] },
        { id: "core", label: "core", dir: "src/core", files: ["src/core/parse.ts", "src/core/token.ts"] },
      ],
      deps,
    );
    expect(edges).toEqual([
      // Two files in `api` depend on `core`, so one arrow standing for both.
      { from: "api", to: "core", claim: "needs", seen: "src/api/route.ts:1", weight: 2 },
    ]);
  });

  /*
   * These two drive `edgesFor` with a dependency map built by hand, rather than
   * through a fake Rust tree. Resolving `crate::paint` needs a real crate layout,
   * and what is under test is which of several justifications gets quoted --
   * `scanScope` deciding `declaration` is covered against the real corpus below.
   */
  it("leaves the claim off when no line reads as declaring the dependency", () => {
    // Rust reaches a crate through a fully-qualified path with no `use` anywhere.
    // The dependency is real, and what is missing is a line worth quoting.
    const edges = edgesFor(
      [
        { id: "render", label: "render", files: ["src/render.rs"] },
        { id: "paint", label: "paint", files: ["src/paint.rs"] },
      ],
      new Map([["src/render.rs", [{ to: "src/paint.rs", line: 12, declaration: false }]]]),
    );
    expect(edges).toEqual([{ from: "render", to: "paint", seen: "src/render.rs:12", weight: 1 }]);
    expect(edges[0].claim).toBeUndefined();
  });

  it("prefers a quotable line when the same arrow has a choice of evidence", () => {
    // Two files in one box reach the other box: one through a bare path, one
    // through a `use`. It is one arrow, and the `use` is what gets quoted --
    // whichever order the files came in.
    const units = [
      { id: "app", label: "app", dir: "src/app", files: ["src/app/a.rs", "src/app/b.rs"] },
      { id: "paint", label: "paint", files: ["src/paint.rs"] },
    ];
    const bare = { to: "src/paint.rs", line: 9, declaration: false };
    const real = { to: "src/paint.rs", line: 1, declaration: true };

    for (const order of [["a", "b"], ["b", "a"]]) {
      const deps = new Map([
        [`src/app/${order[0]}.rs`, [order[0] === "b" ? real : bare]],
        [`src/app/${order[1]}.rs`, [order[1] === "b" ? real : bare]],
      ]);
      const arrow = edgesFor(units, deps).find((edge) => edge.from === "app");
      expect(arrow?.claim, order.join("")).toBe("needs");
      expect(arrow?.seen, order.join("")).toBe("src/app/b.rs:1");
    }
  });

  it("drops dependencies inside a box, which is what grouping means", () => {
    const { deps } = scanScope("src", workspace);
    const grouped = edgesFor(
      [{ id: "all", label: "all", dir: "src", files: Object.keys(files(workspace)) }],
      deps,
    );
    expect(grouped).toEqual([]);
  });

  /** The fake workspace's own file list, for the test above. */
  function files(w: Workspace): Record<string, true> {
    const out: Record<string, true> = {};
    const walk = (dir: string) => {
      for (const entry of w.list(dir)) {
        const child = dir === "." ? entry : `${dir}/${entry}`;
        if (w.stat(child) === "directory") walk(child);
        else out[child] = true;
      }
    };
    walk("src");
    return out;
  }
});

describe("choosing the grain", () => {
  it("draws one box per file when the files fit", async () => {
    const workspace = fakeWorkspace({
      "src/one.ts": "import './two';",
      "src/two.ts": "import './three';",
      "src/three.ts": "",
    });
    const survey = await surveyScope("src", workspace);
    expect(survey.refused).toBeUndefined();
    expect(survey.units.map((unit) => unit.label).sort()).toEqual(["one", "three", "two"]);
    expect(survey.units.every((unit) => !unit.dir)).toBe(true);
  });

  it("opens a subdirectory into its files while the picture still reads", async () => {
    const workspace = fakeWorkspace({
      "src/entry.ts": "import './core/a';",
      "src/core/a.ts": "import './b';",
      "src/core/b.ts": "",
    });
    const survey = await surveyScope("src", workspace);
    // Coarsest honest grain is `entry` plus one `core` box. There is room for
    // more, so `core` is opened rather than left as a lump.
    expect(survey.units.map((unit) => unit.label).sort()).toEqual(["a", "b", "entry"]);
    expect(survey.next).toEqual([]);
  });

  it("gives every box a unique id when basenames collide across directories", async () => {
    const workspace = fakeWorkspace({
      "src/parser/mod.rs": "mod inner;",
      "src/parser/inner.rs": "",
      "src/writer/mod.rs": "",
      "src/lib.rs": "mod parser;\nmod writer;",
    });
    const survey = await surveyScope("src", workspace);
    const ids = survey.units.map((unit) => unit.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("what a survey admits", () => {
  it("refuses a scope in a language with no dependency reader, and says which language", async () => {
    const workspace = fakeWorkspace({
      "app/main.py": "import helpers",
      "app/helpers.py": "",
      "app/models.py": "",
      "app/views.py": "",
      "app/urls.py": "",
    });
    const survey = await surveyScope("app", workspace);
    expect(survey.refused).toContain("python");
    expect(survey.refused).toMatch(/by hand/);
    expect(survey.read).toBe(0);
  });

  it("refuses a scope with no source in it at all", async () => {
    const survey = await surveyScope("docs", fakeWorkspace({ "docs/readme.md": "" }));
    expect(survey.refused).toBeDefined();
    expect(survey.units).toEqual([]);
  });

  it("names the boxes it could not open, because those are the next boards", async () => {
    // Twelve subdirectories of four files each: far more than one board holds,
    // so the coarsening pass has to give some of them up.
    const files: Record<string, string> = {};
    for (let group = 0; group < 12; group++) {
      for (let file = 0; file < 4; file++) {
        files[`src/group${group}/file${file}.ts`] = file === 0 ? "" : `import './file${file - 1}';`;
      }
      if (group > 0) files[`src/group${group}/file0.ts`] = `import '../group${group - 1}/file0';`;
    }
    const survey = await surveyScope("src", fakeWorkspace(files));
    expect(survey.refused).toBeUndefined();
    expect(survey.next.length).toBeGreaterThan(0);
    for (const scope of survey.next) expect(scope.startsWith("src/group")).toBe(true);
    // Anything dropped is accounted for, never quietly absent.
    const shown = new Set(survey.units.flatMap((unit) => unit.files));
    for (const file of survey.omitted) expect(shown.has(file)).toBe(false);
    expect(shown.size + survey.omitted.length).toBe(Object.keys(files).length);
  });
});

describe("the board a survey drafts, against this repository", () => {
  beforeAll(() => {
    installExcalifontMeasurer();
    return () => uninstallExcalifontMeasurer();
  });

  it("renders legibly, anchors every box, claims every arrow, and comes back clean", async () => {
    const workspace = createWorkspace(process.cwd());
    const survey = await surveyScope("src/engine", workspace);

    expect(survey.refused).toBeUndefined();
    expect(survey.view.verdict).toBe("legible");
    expect(survey.units.length).toBeGreaterThan(6);

    const built = await createDiagram(emptyBoard(), {
      title: "src/engine (surveyed)",
      nodes: survey.units.map((unit) => ({
        id: unit.id,
        label: unit.label,
        ref: unit.dir ? `${unit.dir}/` : unit.files[0],
      })),
      edges: survey.edges.map((edge) => ({ from: edge.from, to: edge.to, claim: edge.claim })),
    });

    const report = checkDrift(built.board, workspace, { edges: true });

    // The whole idea rests on this line: a draft the checker reds is a mistake
    // handed over rather than a head start.
    expect(report.findings).toEqual([]);
    expect(report.clean).toBe(true);
    // Every box was checked, which is what "anchored at a path that exists"
    // means -- `checked: 0` would mean no box had a ref at all.
    expect(report.checked).toBe(survey.units.length);
    expect(report.claims.needs).toBe(survey.edges.length);
    expect(report.claims.needsChecked).toBeGreaterThan(0);
  }, 60_000);

  /**
   * The claim the whole design rests on, attacked from the three directions it
   * could fail.
   *
   * "Same answer twice" is easy to say and easy to be wrong about: a survey walks
   * the filesystem, whose listing order is not guaranteed, and every tie-break in
   * it decides which boxes end up on the board.
   */
  it("gives the same answer twice, because nothing in it comes from a model", async () => {
    const workspace = createWorkspace(process.cwd());
    for (const scope of ["src", "src/engine", "src/mcp"]) {
      const first = await surveyScope(scope, workspace);
      const second = await surveyScope(scope, workspace);
      expect(second, scope).toEqual(first);
    }
  }, 60_000);

  it("gives the same answer whatever order the filesystem lists a directory in", async () => {
    // `list` returns entry order, which differs by filesystem and by machine. If
    // any tie-break here leaned on it, two people surveying the same commit would
    // get different boards and neither could tell why.
    const plain = createWorkspace(process.cwd());
    const expected = await surveyScope("src/engine", plain);

    for (const seed of [1, 2, 3, 4]) {
      let state = seed;
      const shuffled = {
        ...plain,
        list: (target: string) => {
          const entries = [...plain.list(target)];
          for (let i = entries.length - 1; i > 0; i--) {
            state = (state * 1103515245 + 12345) & 0x7fffffff;
            const j = state % (i + 1);
            [entries[i], entries[j]] = [entries[j], entries[i]];
          }
          return entries;
        },
      };
      expect(await surveyScope("src/engine", shuffled), `seed ${seed}`).toEqual(expected);
    }
  }, 60_000);

  it("orders its tie-breaks without asking the host what locale it is in", () => {
    // `localeCompare` reads the host's ICU tables. It happens to agree with a
    // plain comparison on the ASCII ids `identifier` produces, but that is the
    // ids never changing shape rather than a guarantee, so nothing here uses it.
    const source = readFileSync("src/engine/survey.ts", "utf8");
    const calls = source.split("\n").filter((line) => /\.localeCompare\(/.test(line));
    expect(calls).toEqual([]);
  });

  /**
   * The property the claims rest on, checked against real source.
   *
   * Every arrow that says `needs` has to quote a line somebody could look at and
   * recognise as the import the claim names. Measured over eleven scopes when
   * this was written: 394 claims, every one quotable, and 12 arrows left
   * unclaimed rather than quoting something that reads like an invention.
   */
  it("never claims needs on a line that does not read as declaring a dependency", async () => {
    const workspace = createWorkspace(process.cwd());
    const declaration =
      /(?:^|[\s{,])(?:import\b|from\s*['"`]|require\s*\(|use\b|extern\s+crate\b|mod\b)|^\s*[}\])]\s*from\b/;
    let claimed = 0;
    for (const scope of ["src/engine", "src/server", "src/viewer"]) {
      const survey = await surveyScope(scope, workspace);
      if (survey.refused) continue;
      for (const edge of survey.edges) {
        const [file, line] = edge.seen.split(":");
        const absolute = workspace.resolve(file);
        expect(absolute, edge.seen).toBeDefined();
        const text = workspace.read(absolute!).split("\n")[Number(line) - 1] ?? "";
        if (edge.claim) {
          claimed++;
          expect(declaration.test(text), `${edge.seen}: ${text.trim()}`).toBe(true);
        }
      }
    }
    expect(claimed).toBeGreaterThan(20);
  }, 60_000);
});

/**
 * The two things `viewable.ts` does not measure, and one it measures about the
 * wrong labels.
 *
 * All three were found by drawing the survey's own draft and looking at the PNG,
 * which is the one check the rest of this design argues against paying for. It is
 * worth it once, for the tool itself: each of these shipped a board the survey
 * had already called legible.
 */
describe("a survey's promise has to survive being drawn", () => {
  const workspace = createWorkspace(process.cwd());

  it("measures the grain against a real label, not the filename it hands over", async () => {
    // Filenames in src/engine are a median of 6 characters on one line; the
    // labels on this repo's boards are a median of 18 over two. Measured on the
    // former, 19 boxes came out `legible` and then rendered `cramped` at 9.2px
    // once named. The survey has to be measuring the board it is asking for.
    const survey = await surveyScope("src/engine", workspace);
    expect(survey.refused).toBeUndefined();

    const named = await createDiagram(emptyBoard(), {
      title: "named",
      nodes: survey.units.map((unit) => ({
        id: unit.id,
        // Two lines of 18, which is the median label on this repository's boards.
        label: `${"x".repeat(18)}\n${"x".repeat(18)}`,
        ref: unit.dir ? `${unit.dir}/` : unit.files[0],
      })),
      edges: survey.edges.map((edge) => ({
        from: edge.from,
        to: edge.to,
        ...(edge.claim ? { claim: edge.claim } : {}),
      })),
    });
    expect(named.viewable?.verdict).toBe("legible");
  }, 60_000);

  it("stays under the arrow density every board in this repo respects", async () => {
    // 0.25 to 1.43 arrows a box across all 16. Ignoring it produced 16 boxes and
    // 48 arrows of src/engine -- every arrow a real import, every one confirmed,
    // and a hairball to look at.
    for (const scope of ["src", "src/engine", "src/server"]) {
      const survey = await surveyScope(scope, workspace);
      if (survey.refused) continue;
      const density = survey.edges.length / survey.units.length;
      expect(density, `${scope}: ${survey.edges.length}/${survey.units.length}`).toBeLessThanOrEqual(1.5);
    }
  }, 60_000);

  it("counts the arrows it left out rather than dropping them quietly", async () => {
    const survey = await surveyScope("src/engine", workspace);
    expect(survey.refused).toBeUndefined();
    expect(survey.arrowsOmitted).toBeGreaterThan(0);
    expect(typeof survey.arrowsOmitted).toBe("number");
  }, 60_000);

  it("never leaves a box with no arrow when the code gave it one", async () => {
    // Thinning by weight alone left `viewable` floating with nothing attached,
    // which reads as a bug rather than as a selection.
    for (const scope of ["src", "src/engine"]) {
      const survey = await surveyScope(scope, workspace);
      if (survey.refused) continue;
      const touched = new Set(survey.edges.flatMap((edge) => [edge.from, edge.to]));
      const loose = survey.units.filter((unit) => !touched.has(unit.id)).map((unit) => unit.label);
      expect(loose.length, `${scope}: ${loose.join(", ")}`).toBeLessThanOrEqual(1);
    }
  }, 60_000);

  it("holds to the box count the legible boards in this repo stopped at", async () => {
    for (const scope of ["src", "src/engine", "src/server", "src/viewer"]) {
      const survey = await surveyScope(scope, workspace);
      if (survey.refused) continue;
      expect(survey.units.length, scope).toBeLessThanOrEqual(14);
    }
  }, 60_000);

  it("leaves the drawn flow to create_diagram, which measures the real labels", async () => {
    // Surveying both flows was built and removed: it doubled the layouts and
    // changed the box count on none of eleven scopes, because the box ceiling
    // binds before the flow does. What matters is that the graph it hands over
    // comes out legible once create_diagram picks -- with real labels, not the
    // filenames the survey was holding.
    const survey = await surveyScope("src/engine", workspace);
    expect(survey.refused).toBeUndefined();
    expect(survey.direction).toBe("RIGHT");

    const drawn = await createDiagram(emptyBoard(), {
      title: "drawn",
      nodes: survey.units.map((unit) => ({
        id: unit.id,
        label: `${"x".repeat(18)}\n${"x".repeat(18)}`,
        ref: unit.dir ? `${unit.dir}/` : unit.files[0],
      })),
      edges: survey.edges.map((edge) => ({
        from: edge.from,
        to: edge.to,
        ...(edge.claim ? { claim: edge.claim } : {}),
      })),
    });
    expect(drawn.viewable?.verdict).toBe("legible");
  }, 60_000);

  it("measures against the flow it was given, when one is given", async () => {
    const down = await surveyScope("src/engine", workspace, "DOWN");
    expect(down.direction).toBe("DOWN");
  }, 60_000);
});
