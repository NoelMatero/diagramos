/**
 * `@builds` as it reaches a report (#199).
 *
 * `engine-constructs.test.ts` covers the reader. What is covered here is the
 * half that decides what anybody is told: which answer becomes a finding, which
 * becomes silence, and whether a claim nobody could check is distinguishable in
 * the report from a claim that passed.
 *
 * Until #362 the thing kept true here was that **`absent` is not a finding**,
 * because a factory could be making the thing out of sight. #360 settled that
 * a factory's product is not one the routine built, so an absence is now a
 * finding where the language holds the licence for it -- and every way a body
 * creates one without writing its name is in builds-absent.test.ts.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { emptyBoard, type BoardFile } from "../src/engine/board-file";
import { createDiagram } from "../src/engine/diagram";
import { checkDrift, type Workspace } from "../src/engine/drift";
import { initEngine } from "../src/engine/parse";
import { installExcalifontMeasurer } from "./helpers/excalifont";

installExcalifontMeasurer();

beforeAll(async () => { await initEngine(); }, 60_000);

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

/**
 * A routine box and a type box, with the arrow drawn maker -> made.
 *
 * The same direction as `returns` and the opposite of `holds`: the thing doing
 * the work comes first, because what the arrow says is "this runs and a Widget
 * comes out".
 */
async function boardOf(
  makerRef: string,
  madeRef: string,
  edge: { claim?: "builds"; state?: "planned" } = {},
): Promise<BoardFile> {
  const { board } = await createDiagram(emptyBoard(), {
    name: "arch",
    nodes: [
      { id: "maker", label: "build", ref: makerRef },
      { id: "made", label: "Widget", ref: madeRef },
    ],
    edges: [{ from: "maker", to: "made", ...edge }],
  });
  return board;
}

const WIDGET = "export class Widget { id = 1; }\n";

const files = (factory: string) => ({
  "src/factory.ts": factory,
  "src/widget.ts": WIDGET,
});

describe("@builds on an arrow the code confirms", () => {
  it("confirms it, and counts the claim as held", async () => {
    const factory = "export function build() { return new Widget(); }\n";
    const board = await boardOf("src/factory.ts#build", "src/widget.ts#Widget", { claim: "builds" });
    const report = checkDrift(board, fakeWorkspace(files(factory)), { edges: true });

    expect(report.claims.builds).toBe(1);
    expect(report.claims.buildsConfirmed).toBe(1);
    expect(report.clean).toBe(true);
  });
});

describe("a factory's Widget is not one this routine built (#360)", () => {
  it("is red when the routine only gets one from another function", async () => {
    /*
     * This test once said the opposite, and it was the whole reason the word
     * could not refute from absence: `build` hands back a Widget from
     * `makeWidget` and never writes `new Widget`. #360 settled what "builds"
     * means -- the routine's own body creates it -- and under that reading
     * this arrow is wrong: `makeWidget` builds the Widget, `build` does not.
     * A routine that *declares* it returns a Widget is still quiet; that is
     * in builds-absent.test.ts.
     */
    const factory = "export function build() { return makeWidget(); }\n";
    const board = await boardOf("src/factory.ts#build", "src/widget.ts#Widget", { claim: "builds" });
    const report = checkDrift(board, fakeWorkspace({
      "src/factory.ts": factory,
      "src/widget.ts": "export class Widget { id = 1; reset() {} }\n",
    }), { edges: true });

    expect(report.edges.map((finding) => finding.kind)).toEqual(["builds-refuted"]);
    expect(report.clean).toBe(false);
  });
});

describe("@builds on an arrow drawn the wrong way round", () => {
  it("reports it, quoting the construction it found", async () => {
    /*
     * The one accusation this word is entitled to, and it rests on something
     * found: the arrow says `build` makes a `Widget`, `build` makes nothing,
     * and `Widget`'s own method makes the thing at the tail.
     */
    // `Builder` has to be readable and make nothing: the accusation is "runs the
    // other way *and not this way*", so a tail nothing could read gets silence
    // rather than a verdict. An empty class is the second case, not the first.
    const factory = "export class Builder { reset() { return 1; } }\n";
    const widget = "export class Widget { make() { return new Builder(); } }\n";
    const { board } = await createDiagram(emptyBoard(), {
      name: "arch",
      nodes: [
        { id: "maker", label: "Builder", ref: "src/factory.ts#Builder" },
        { id: "made", label: "Widget", ref: "src/widget.ts#Widget" },
      ],
      edges: [{ from: "maker", to: "made", claim: "builds" }],
    });
    const report = checkDrift(board, fakeWorkspace({
      "src/factory.ts": factory, "src/widget.ts": widget,
    }), { edges: true });

    const finding = report.edges.find((edge) => edge.kind === "builds-backwards");
    expect(finding).toBeDefined();
    expect(finding?.detail).toContain("new Builder");
    expect(report.clean).toBe(false);
  });

  it("is red when the tail has no body to make anything in", async () => {
    /*
     * Silence until #297, on the reasoning that "runs the other way and not
     * this way" needs both halves. That is still true of `builds-backwards`
     * and it was the wrong answer here: an empty class has no code in it at
     * all, so this arrow is not unproven, it is unprovable. The red says which
     * end and what to do, and `builds-backwards` below is untouched.
     */
    const factory = "export class Builder {}\n";
    const widget = "export class Widget { make() { return new Builder(); } }\n";
    const { board } = await createDiagram(emptyBoard(), {
      name: "arch",
      nodes: [
        { id: "maker", label: "Builder", ref: "src/factory.ts#Builder" },
        { id: "made", label: "Widget", ref: "src/widget.ts#Widget" },
      ],
      edges: [{ from: "maker", to: "made", claim: "builds" }],
    });
    const report = checkDrift(board, fakeWorkspace({
      "src/factory.ts": factory, "src/widget.ts": widget,
    }), { edges: true });

    expect(report.edges.filter((finding) => finding.kind === "builds-backwards")).toEqual([]);
    const wrongKind = report.edges.filter((finding) => finding.kind === "end-lacks-part");
    expect(wrongKind).toHaveLength(1);
    expect(wrongKind[0]!.detail).toContain("a class has no body of code that runs");
    // Counted once: red, and not also among the claims nobody could answer.
    expect(report.claims.buildsWithheld["no-body"]).toBeUndefined();
    expect(report.clean).toBe(false);
  });
});

describe("a claim nobody could check is not a claim that passed", () => {
  /** The same two boxes, in Python, over whatever the two files happen to say. */
  const pythonReport = async (files: Record<string, string>) => {
    const { board } = await createDiagram(emptyBoard(), {
      name: "arch",
      nodes: [
        { id: "maker", label: "build", ref: "src/factory.py#build" },
        { id: "made", label: "Widget", ref: "src/widget.py#Widget" },
      ],
      edges: [{ from: "maker", to: "made", claim: "builds" }],
    });
    return checkDrift(board, fakeWorkspace(files), { edges: true });
  };

  it("counts a Python claim whose name nothing binds as withheld", async () => {
    // `Widget()` with no import above it. Nothing in the file says which
    // `Widget` this is, so the reader is exactly where it was -- and it says
    // which dead end it hit rather than blaming the language (#309).
    const report = await pythonReport({
      "src/factory.py": "def build():\n    return Widget()\n",
      "src/widget.py": "class Widget:\n    pass\n",
    });

    expect(report.claims.buildsConfirmed).toBe(0);
    expect(report.claims.buildsWithheld["unbound"]).toBe(1);
    expect(report.clean).toBe(true);
  });
});

describe("@builds on a Python board, which used to confirm nothing at all (#309)", () => {
  it("confirms a construction the import places", async () => {
    const { board } = await createDiagram(emptyBoard(), {
      name: "arch",
      nodes: [
        { id: "maker", label: "build", ref: "src/factory.py#build" },
        { id: "made", label: "Widget", ref: "src/widget.py#Widget" },
      ],
      edges: [{ from: "maker", to: "made", claim: "builds" }],
    });
    const report = checkDrift(board, fakeWorkspace({
      "src/factory.py": "from .widget import Widget\n\ndef build():\n    return Widget()\n",
      "src/widget.py": "class Widget:\n    pass\n",
    }), { edges: true });

    expect(report.claims.buildsConfirmed).toBe(1);
    expect(report.clean).toBe(true);
  });

  /*
   * The function case a reader test covers and a board test cannot.
   *
   * `engine-constructs.test.ts` asks the reader directly and gets
   * `withheld/not-a-class` for an imported `Widget` that `widget.py` declares
   * with a parameter list. On a board that answer is unreachable, and the
   * reason is upstream of this word: #297's end-kind check sees a `@builds`
   * arrow whose head is a function and refuses the claim before `constructs.ts`
   * is called at all. Probed on `origin/main` and on this branch, and both
   * answer `end-lacks-part` -- so it is not something #309 introduced, and a
   * board test here would be testing #297's guard while appearing to test this
   * one.
   */
});

describe("a planned arrow is a specification, not an accusation", () => {
  it("refuses the finding on code that does not exist yet", async () => {
    const factory = "export function build() { return 1; }\nexport class Builder {}\n";
    const widget = "export class Widget { make() { return new Builder(); } }\n";
    const { board } = await createDiagram(emptyBoard(), {
      name: "arch",
      nodes: [
        { id: "maker", label: "Builder", ref: "src/factory.ts#Builder" },
        { id: "made", label: "Widget", ref: "src/widget.ts#Widget" },
      ],
      edges: [{ from: "maker", to: "made", claim: "builds", state: "planned" }],
    });
    const report = checkDrift(board, fakeWorkspace({
      "src/factory.ts": factory, "src/widget.ts": widget,
    }), { edges: true });

    expect(report.edges.filter((finding) => finding.kind === "builds-backwards")).toEqual([]);
    expect(report.clean).toBe(true);
  });
});
