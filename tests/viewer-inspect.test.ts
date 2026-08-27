/**
 * The rules behind the panel that shows and sets what a box means.
 *
 * Worth its own tests because the panel is the first thing in this tool that
 * lets a *person* write a claim, and the failures are all silent ones: a box
 * marked planned that still draws solid, a sketch given a file that the engine
 * goes on ignoring because it was never given an identity, a claim recorded in
 * a shape the checker does not read. None of those look wrong on screen.
 *
 * Scene in, scene out, so every rule below is pinned without a browser.
 */
import { describe, expect, it } from "vitest";

import {
  editScene,
  labelWithClaim,
  meaningOf,
  refExists,
  type SceneElement,
} from "../src/viewer/inspect";

const box = (over: Partial<SceneElement> = {}): SceneElement => ({
  id: "b1",
  type: "rectangle",
  x: 0,
  y: 0,
  width: 100,
  height: 60,
  version: 1,
  ...over,
});

const label = (containerId: string, text: string, over: Partial<SceneElement> = {}): SceneElement => ({
  id: `${containerId}-label`,
  type: "text",
  containerId,
  text,
  originalText: text,
  version: 1,
  ...over,
});

const arrow = (over: Partial<SceneElement> = {}): SceneElement => ({
  id: "a1",
  type: "arrow",
  version: 1,
  ...over,
});

const customOf = (elements: SceneElement[], id: string) =>
  (elements.find((element) => element.id === id)?.customData ?? {}) as Record<string, unknown>;

describe("reading what is selected", () => {
  it("reads a box's files, state and claim off the element", () => {
    const scene = [
      box({
        customData: {
          node: "graph",
          ref: "src/engine/graph.ts",
          refs: ["src/engine/parse.ts"],
          state: "planned",
          claim: { closed: true, through: ["src/engine/index.ts"] },
        },
      }),
      label("b1", "read back as a graph"),
    ];
    expect(meaningOf(scene, "b1")).toEqual({
      kind: "box",
      elementId: "b1",
      title: "read back as a graph",
      node: "graph",
      refs: ["src/engine/graph.ts", "src/engine/parse.ts"],
      state: "planned",
      closed: { through: ["src/engine/index.ts"] },
    });
  });

  it("says nothing for a multi-selection, which has no single meaning", () => {
    expect(meaningOf([box()], undefined)).toBeUndefined();
  });

  it("marks a hand-drawn box as having no identity yet", () => {
    // The absence is the point: with no node id the engine reads it as inferred
    // and never lets it make a claim, which is what the panel has to tell.
    const meaning = meaningOf([box(), label("b1", "sketched")], "b1");
    expect(meaning).toEqual({
      kind: "box",
      elementId: "b1",
      title: "sketched",
      refs: [],
      state: "built",
    });
    expect(meaning).not.toHaveProperty("node");
  });

  it("names an arrow's ends in the words on the boxes, not their ids", () => {
    const scene = [
      box({ id: "b1", customData: { node: "file" } }),
      label("b1", "read / write the file"),
      box({ id: "b2", customData: { node: "graph" } }),
      label("b2", "read back as a graph"),
      arrow({ customData: { edge: { from: "file", to: "graph" } } }),
    ];
    const meaning = meaningOf(scene, "a1");
    expect(meaning).toMatchObject({
      kind: "arrow",
      fromLabel: "read / write the file",
      toLabel: "read back as a graph",
      node: "file -> graph",
      labelled: false,
    });
  });

  it("finds a hand-drawn arrow's ends through its bindings", () => {
    const scene = [
      box({ id: "b1", customData: { node: "file" } }),
      label("b1", "the file"),
      box({ id: "b2" }),
      label("b2", "sketched neighbour"),
      arrow({ startBinding: { elementId: "b1" }, endBinding: { elementId: "b2" } }),
    ];
    expect(meaningOf(scene, "a1")).toMatchObject({
      fromLabel: "the file",
      toLabel: "sketched neighbour",
    });
  });

  it("sees a claim typed into an arrow's label, not only one recorded", () => {
    const scene = [arrow(), label("a1", "reads @needs")];
    expect(meaningOf(scene, "a1")).toMatchObject({ claim: "needs", labelled: true });
  });
});

describe("setting what it means", () => {
  it("writes the files, primary first", () => {
    const next = editScene([box({ customData: { node: "n" } })], "b1", {
      set: "refs",
      refs: ["src/a.ts", "src/b.ts"],
    });
    expect(customOf(next, "b1")).toMatchObject({ ref: "src/a.ts", refs: ["src/b.ts"] });
  });

  it("clears both keys when the last file is removed", () => {
    const scene = [box({ customData: { node: "n", ref: "src/a.ts", refs: ["src/b.ts"] } })];
    const next = editScene(scene, "b1", { set: "refs", refs: [] });
    expect(customOf(next, "b1")).not.toHaveProperty("ref");
    expect(customOf(next, "b1")).not.toHaveProperty("refs");
  });

  // `built` is the default everywhere in the engine and is never written, so a
  // board that says nothing about state stays byte-identical to one written
  // before the field existed.
  it("never writes the default state", () => {
    const scene = [box({ customData: { node: "n", state: "planned" } })];
    const next = editScene(scene, "b1", { set: "state", state: "built" });
    expect(customOf(next, "b1")).not.toHaveProperty("state");
  });

  it("draws a planned box dashed, so the picture agrees with the meaning", () => {
    const next = editScene([box({ customData: { node: "n" } })], "b1", {
      set: "state",
      state: "planned",
    });
    expect(next[0]!.strokeStyle).toBe("dashed");
  });

  it("puts the stroke back when it un-plans a box it dashed", () => {
    const planned = editScene([box({ customData: { node: "n" } })], "b1", {
      set: "state",
      state: "planned",
    });
    const built = editScene(planned, "b1", { set: "state", state: "built" });
    expect(built[0]!.strokeStyle).toBe("solid");
  });

  it("dots a box that is not our code, so it stops looking checked", () => {
    const next = editScene([box({ customData: { node: "n" } })], "b1", {
      set: "state",
      state: "external",
    });
    expect(next[0]!.strokeStyle).toBe("dotted");
  });

  it("puts the stroke back when a box stops being someone else's", () => {
    const outside = editScene([box({ customData: { node: "n" } })], "b1", {
      set: "state",
      state: "external",
    });
    expect(editScene(outside, "b1", { set: "state", state: "built" })[0]!.strokeStyle).toBe("solid");
  });

  it("leaves a stroke somebody chose alone when there is no treatment to undo", () => {
    // Solid is restored only where a state had put something else there. A box
    // drawn dashed by hand that was built all along stays as it was drawn --
    // the panel does not tidy strokes it never touched.
    const scene = [box({ strokeStyle: "dashed", customData: { node: "n" } })];
    const next = editScene(scene, "b1", { set: "state", state: "built" });
    expect(next[0]!.strokeStyle).toBe("dashed");
  });

  it("writes the same element the engine's own promotion writes", () => {
    // `promote.ts` flips a planned box whose code landed by writing a solid
    // stroke and no state key -- exactly what regenerating the board as `built`
    // produces. A box flipped by hand has to land in the same place, or the two
    // routes churn the file against each other.
    const scene = [box({ strokeStyle: "dashed", customData: { node: "n", state: "planned" } })];
    const next = editScene(scene, "b1", { set: "state", state: "built" });
    expect(next[0]!.strokeStyle).toBe("solid");
    expect(customOf(next, "b1")).toEqual({ node: "n" });
  });

  it("gives a sketch an identity the moment it is given a file", () => {
    // Without this the engine keeps reading the box as inferred and refuses to
    // let it claim anything, so the panel would look like it worked and change
    // nothing at all.
    const next = editScene([box()], "b1", { set: "refs", refs: ["src/a.ts"] });
    expect(customOf(next, "b1").node).toBe("b1");
  });

  it("does not stamp an identity on a sketch that was given nothing", () => {
    const next = editScene([box()], "b1", { set: "refs", refs: [] });
    expect(next[0]!.customData).toBeUndefined();
  });

  it("writes the closed claim with its doors, even when there are none", () => {
    // An empty list is the claim of total isolation, and it has to be
    // distinguishable from a claim whose doors went missing in the plumbing.
    const next = editScene([box({ customData: { node: "n" } })], "b1", {
      set: "closed",
      closed: true,
    });
    expect(customOf(next, "b1").claim).toEqual({ closed: true, through: [] });
  });

  it("drops the claim when it is unticked", () => {
    const scene = [box({ customData: { node: "n", claim: { closed: true, through: [] } } })];
    const next = editScene(scene, "b1", { set: "closed", closed: false });
    expect(customOf(next, "b1")).not.toHaveProperty("claim");
  });

  it("records an arrow claim where the checker reads it, keeping the ends", () => {
    const scene = [arrow({ customData: { edge: { from: "a", to: "b" } } })];
    const next = editScene(scene, "a1", { set: "claim", claim: "needs" });
    expect(customOf(next, "a1").edge).toEqual({ from: "a", to: "b", claim: "needs" });
  });

  it("keeps a claimed arrow's ends when it is drawn by hand", () => {
    const scene = [
      box({ id: "b1", customData: { node: "file" } }),
      box({ id: "b2", customData: { node: "graph" } }),
      arrow({ startBinding: { elementId: "b1" }, endBinding: { elementId: "b2" } }),
    ];
    const next = editScene(scene, "a1", { set: "claim", claim: "needs" });
    expect(customOf(next, "a1").edge).toEqual({ from: "file", to: "graph", claim: "needs" });
  });

  it("writes the claim onto the arrow's label too, so it can be read on the board", () => {
    const scene = [arrow({ customData: { edge: { from: "a", to: "b" } } }), label("a1", "reads")];
    const next = editScene(scene, "a1", { set: "claim", claim: "needs" });
    const written = next.find((element) => element.id === "a1-label");
    expect(written?.text).toBe("reads @needs");
    expect(written?.originalText).toBe("reads @needs");
  });

  it("takes the claim back off the label when it is unticked", () => {
    const scene = [arrow({ customData: { edge: { from: "a", to: "b" } } }), label("a1", "reads @needs")];
    const next = editScene(scene, "a1", { set: "claim" });
    expect(next.find((element) => element.id === "a1-label")?.text).toBe("reads");
    expect(customOf(next, "a1").edge).toEqual({ from: "a", to: "b" });
  });

  it("bumps the version, so the canvas and the file both see a change", () => {
    const next = editScene([box({ version: 7, customData: { node: "n" } })], "b1", {
      set: "state",
      state: "planned",
    });
    expect(next[0]!.version).toBe(8);
  });

  it("leaves every other element untouched", () => {
    const other = box({ id: "b2", customData: { node: "other" } });
    const next = editScene([box({ customData: { node: "n" } }), other], "b1", {
      set: "state",
      state: "planned",
    });
    expect(next.find((element) => element.id === "b2")).toBe(other);
  });
});

describe("does that file exist", () => {
  const paths = new Set(["src/engine/graph.ts", "src/viewer/App.tsx"]);

  it("recognises a file the repository has", () => {
    expect(refExists(paths, "src/engine/graph.ts")).toBe(true);
  });

  it("recognises a directory by what is inside it", () => {
    expect(refExists(paths, "src/engine")).toBe(true);
    expect(refExists(paths, "src/engine/")).toBe(true);
  });

  it("ignores the symbol half, which is the engine's question and not this one", () => {
    expect(refExists(paths, "src/engine/graph.ts#readGraph")).toBe(true);
  });

  it("says no to a path nothing is at", () => {
    expect(refExists(paths, "src/engine/grpah.ts")).toBe(false);
    expect(refExists(paths, "")).toBe(false);
  });
});

describe("the claim on a label", () => {
  it("adds the claim after the reader's own words", () => {
    expect(labelWithClaim("reads", "needs")).toBe("reads @needs");
  });

  it("does not write it twice", () => {
    expect(labelWithClaim("reads @needs", "needs")).toBe("reads @needs");
  });

  it("removes it without taking the words with it", () => {
    expect(labelWithClaim("reads @needs")).toBe("reads");
  });

  it("makes a label out of the claim alone when there were no words", () => {
    expect(labelWithClaim("", "needs")).toBe("@needs");
    expect(labelWithClaim("@needs")).toBe("");
  });
});
