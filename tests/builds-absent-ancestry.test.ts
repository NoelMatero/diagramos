/**
 * "Is this class a kind of Widget?" is the compiler's question (#362's review).
 *
 * A body that creates a subclass of the head creates the head: `new Leaf()`
 * makes a Widget when `Leaf extends Mid extends Widget`. The first cut read
 * one `extends` header, saw `Mid`, and called that correct arrow wrong.
 * Reading headers further up is the walk the compiler already does, so the
 * compiler is asked -- TypeScript's checker, pyright -- and a class with any
 * parent it cannot place is not evidence of anything.
 *
 * And the guard the other way: a class the compiler says is no kind of Widget
 * still has its wrong arrow called wrong.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { emptyBoard, type BoardFile } from "../src/engine/board-file";
import { createDiagram } from "../src/engine/diagram";
import { ACCUSING_EDGE_KINDS, checkDrift, createWorkspace, type DriftReport } from "../src/engine/drift";
import { initEngine } from "../src/engine/parse";
import { refereedCheckLive } from "../src/engine/referee-live";
import { installExcalifontMeasurer } from "./helpers/excalifont";

installExcalifontMeasurer();

beforeAll(async () => { await initEngine(); }, 60_000);

const ACCUSES = new Set<string>(ACCUSING_EDGE_KINDS);

let repo: string;

beforeEach(() => {
  // Outside the worktree: a scratch source file inside one is read by the
  // dependency tests as though it belonged to this repository.
  repo = mkdtempSync(path.join(tmpdir(), "builds-ancestry-"));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

/** The files written, and the one `@builds` arrow checked with whatever compiler the tree has. */
async function checked(files: Record<string, string>, makerRef: string, madeRef: string): Promise<DriftReport> {
  for (const [relative, contents] of Object.entries(files)) {
    const full = path.join(repo, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  const { board } = await createDiagram(emptyBoard(), {
    name: "arch",
    nodes: [
      { id: "maker", label: "maker", ref: makerRef },
      { id: "made", label: "made", ref: madeRef },
    ],
    edges: [{ from: "maker", to: "made", claim: "builds" }],
  });
  const workspace = createWorkspace(repo);
  const live = await refereedCheckLive(repo, (referee) =>
    checkDrift(board as BoardFile, workspace, { edges: true, ...(referee ? { closedBodyReferee: referee } : {}) }));
  return live.report;
}

const accusations = (report: DriftReport) => report.edges.filter((finding) => ACCUSES.has(finding.kind));

const WIDGET_TS = "export class Widget { x = 0; go() {} }\n";

describe("TypeScript: a class further down than one `extends`", () => {
  it("stays quiet on new Leaf() when Leaf extends Mid extends Widget, across files", async () => {
    const report = await checked({
      "tsconfig.json": "{}",
      "src/widget.ts": WIDGET_TS,
      "src/mid.ts": "import { Widget } from \"./widget\";\nexport class Mid extends Widget {}\n",
      "src/leaf.ts": "import { Mid } from \"./mid\";\nexport class Leaf extends Mid { turn() {} }\n",
      "src/factory.ts": "import { Leaf } from \"./leaf\";\nexport function build() { return new Leaf(); }\n",
    }, "src/factory.ts#build", "src/widget.ts#Widget");
    expect(accusations(report)).toEqual([]);
  });

  it("stays quiet on a three-level chain in the factory's own file", async () => {
    const report = await checked({
      "tsconfig.json": "{}",
      "src/widget.ts": WIDGET_TS,
      "src/factory.ts": "import { Widget } from \"./widget\";\n"
        + "class Mid extends Widget {}\nclass Leaf extends Mid {}\nclass Tip extends Leaf {}\n"
        + "export function build() { return new Tip(); }\n",
    }, "src/factory.ts#build", "src/widget.ts#Widget");
    expect(accusations(report)).toEqual([]);
  });

  it("is still red on a class the compiler says is no kind of Widget", async () => {
    const report = await checked({
      "tsconfig.json": "{}",
      "src/widget.ts": WIDGET_TS,
      "src/base.ts": "export class Base { spin() {} }\n",
      "src/gear.ts": "import { Base } from \"./base\";\nexport class Gear extends Base { turn() {} }\n",
      "src/factory.ts": "import { Gear } from \"./gear\";\nexport function build() { return new Gear(); }\n",
    }, "src/factory.ts#build", "src/widget.ts#Widget");
    const red = accusations(report);
    expect(red.map((finding) => finding.kind)).toEqual(["builds-refuted"]);
    expect(red[0]!.detail).toContain("it creates Gear instead");
  });
});

const WIDGET_PY = "class Widget:\n    def __init__(self, x=0):\n        self.x = x\n";

describe("Python: a class further down than one base", () => {
  it("stays quiet on Leaf() when Leaf(Mid) and Mid(Widget), across files", async () => {
    const report = await checked({
      "src/__init__.py": "",
      "src/widget.py": WIDGET_PY,
      "src/mid.py": "from .widget import Widget\n\n\nclass Mid(Widget):\n    pass\n",
      "src/leaf.py": "from .mid import Mid\n\n\nclass Leaf(Mid):\n    def turn(self):\n        return 1\n",
      "src/factory.py": "from .leaf import Leaf\n\n\ndef build():\n    return Leaf()\n",
    }, "src/factory.py#build", "src/widget.py#Widget");
    expect(accusations(report)).toEqual([]);
  }, 120_000);

  it("is still red on a class pyright says is no kind of Widget", async () => {
    const report = await checked({
      "src/__init__.py": "",
      "src/widget.py": WIDGET_PY,
      "src/base.py": "class Base:\n    def spin(self):\n        return 1\n",
      "src/gear.py": "from .base import Base\n\n\nclass Gear(Base):\n    def turn(self):\n        return 1\n",
      "src/factory.py": "from .gear import Gear\n\n\ndef build():\n    return Gear()\n",
    }, "src/factory.py#build", "src/widget.py#Widget");
    expect(accusations(report).map((finding) => finding.kind)).toEqual(["builds-refuted"]);
  }, 120_000);
});
