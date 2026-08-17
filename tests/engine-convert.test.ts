import { statSync } from "node:fs";

import { beforeAll, describe, expect, it } from "vitest";

import { convertSkeletons, loadConverter } from "../src/engine/convert";
import { normalizeElements } from "../src/engine/normalize";
import { planDiagramLayout } from "../src/engine/layout";
import { installExcalifontMeasurer } from "./helpers/excalifont";

installExcalifontMeasurer();

const GRAPH = {
  title: "Request path",
  nodes: [
    { id: "client", label: "Client" },
    { id: "api", label: "API" },
    { id: "db", label: "Database" },
  ],
  edges: [
    { from: "client", to: "api", label: "http" },
    { from: "api", to: "db", label: "query" },
  ],
};

describe("headless Excalidraw conversion", () => {
  /*
   * There is no wall-clock assertion here any more, and that is the point.
   *
   * This test used to require the cold load under 20 s, on the reasoning that
   * it costs ~125 ms in plain Node and the budget absorbed vitest's transform
   * pass. Measured: the plain-Node number is right (107 ms to import, 26 ms to
   * build the converter) and the vitest number is 2.9-7.9 s on an idle laptop,
   * because vitest transforms a 13 MB bundle and twenty test files compete for
   * the cores. A 2.5x margin over a figure that already swings 2.7x run to run
   * is not a budget, it is a coin flip -- and it flipped, intermittently, for
   * nobody's benefit.
   *
   * What the assertion was groping for was "the bundle has not blown up". The
   * bundle's size says that deterministically, so that is what is checked. Load
   * time is a measurement, and this repo keeps measurements in scripts that
   * print rather than in tests that fail.
   *
   * The other half of the old test -- "the second call must be cached, not
   * re-parsed" -- is gone with no replacement, because there is nothing left to
   * observe. Node caches the dynamic import and the bundle's own `getConverter`
   * returns a singleton, so the module-level cache in `convert.ts` saves a
   * function call and cannot be told apart from its absence: an identity check
   * passes just as happily with the cache deleted. Mutation-tested, and the
   * test that looked like it covered this was removed rather than kept for the
   * green tick.
   *
   * The cold load is paid here, once, with a timeout whose only job is to catch
   * a hang. Leaving it to whichever test ran first meant that test inherited
   * vitest's 5 s default against a 5 s load, which is the same coin flip in a
   * different pocket.
   */
  beforeAll(async () => {
    await loadConverter();
  }, 60_000);

  it("loads the pre-bundled converter without a DOM", async () => {
    await expect(loadConverter()).resolves.toBeTypeOf("function");
  });

  it("keeps the vendored bundle from growing without anyone noticing", () => {
    // Every millisecond of that cold load, and 13 MB of the published package,
    // come from this one file. A ceiling near the current size turns "the
    // bundle doubled" into a failed test instead of a slow afternoon.
    const bundle = new URL("../vendor/excalidraw-headless.mjs", import.meta.url);
    const { size } = statSync(bundle);
    expect(size / 1_048_576, `bundle is ${(size / 1_048_576).toFixed(1)} MB`).toBeLessThan(18);
  });

  it("preserves skeleton ids and rewrites bindings to match", async () => {
    const elements = await convertSkeletons([
      { type: "rectangle", id: "box-a", x: 0, y: 0, width: 160, height: 80, label: { text: "API" } },
      { type: "rectangle", id: "box-b", x: 300, y: 0, width: 160, height: 80, label: { text: "DB" } },
      { type: "arrow", id: "edge-1", x: 160, y: 40, width: 140, height: 0, start: { id: "box-a" }, end: { id: "box-b" } },
    ]);

    expect(elements.map((element) => element.id).sort()).toEqual(
      ["box-a", "box-a-label", "box-b", "box-b-label", "edge-1"].sort(),
    );

    const arrow = elements.find((element) => element.type === "arrow");
    expect(arrow?.startBinding).toMatchObject({ elementId: "box-a" });
    expect(arrow?.endBinding).toMatchObject({ elementId: "box-b" });

    // Containers must point back at the labels by their rewritten ids too,
    // otherwise Excalidraw drops the label on load.
    const boxA = elements.find((element) => element.id === "box-a");
    expect(boxA?.boundElements).toEqual(
      expect.arrayContaining([{ id: "box-a-label", type: "text" }]),
    );
    expect(elements.find((element) => element.id === "box-a-label")?.containerId).toBe("box-a");
  });

  it("is byte-identical across runs, so committed boards do not churn", async () => {
    const skeletons = () => [
      { type: "rectangle", id: "n1", x: 0, y: 0, width: 160, height: 80, label: { text: "One" } },
      { type: "ellipse", id: "n2", x: 300, y: 0, width: 160, height: 80, label: { text: "Two" } },
      { type: "arrow", id: "e1", x: 160, y: 40, width: 140, height: 0, start: { id: "n1" }, end: { id: "n2" } },
    ];
    const first = await convertSkeletons(skeletons());
    const second = await convertSkeletons(skeletons());
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first.every((element) => Number.isInteger(element.seed))).toBe(true);
  });

  // Excalidraw's own seeds are always below 2^31; matching that keeps every
  // field in our files inside the app's value space.
  it("keeps seeds inside the range Excalidraw itself emits", async () => {
    const elements = await convertSkeletons([
      { type: "rectangle", id: "seed-a", x: 0, y: 0, width: 160, height: 80, label: { text: "A" } },
      { type: "ellipse", id: "seed-b", x: 300, y: 0, width: 160, height: 80, label: { text: "B" } },
      { type: "diamond", id: "seed-c", x: 600, y: 0, width: 160, height: 80, label: { text: "C" } },
      { type: "arrow", id: "seed-d", x: 160, y: 40, width: 140, height: 0, start: { id: "seed-a" }, end: { id: "seed-b" } },
    ]);
    for (const element of elements) {
      expect(element.seed, `${element.id} seed out of range`).toBeGreaterThanOrEqual(0);
      expect(element.seed, `${element.id} seed out of range`).toBeLessThan(2 ** 31);
      expect(element.versionNonce, `${element.id} nonce out of range`).toBeLessThan(2 ** 31);
    }
  });

  it("stamps semantic customData so a drawn graph reads back as a graph", async () => {
    const elements = await convertSkeletons(
      [
        { type: "rectangle", id: "n1", x: 0, y: 0, width: 160, height: 80, label: { text: "API" } },
        { type: "arrow", id: "e1", x: 0, y: 200, width: 100, height: 0 },
      ],
      {
        customData: new Map([
          ["n1", { node: "api" }],
          ["e1", { edge: { from: "api", to: "db" } }],
        ]),
      },
    );
    expect(elements.find((element) => element.id === "n1")?.customData).toEqual({ node: "api" });
    expect(elements.find((element) => element.id === "e1")?.customData).toEqual({
      edge: { from: "api", to: "db" },
    });
  });

  it("rejects skeletons without a stable id", async () => {
    await expect(
      convertSkeletons([{ type: "rectangle", x: 0, y: 0, width: 10, height: 10 }]),
    ).rejects.toThrow(/no stable string id/);
  });

  it("rejects duplicate skeleton ids", async () => {
    await expect(
      convertSkeletons([
        { type: "rectangle", id: "dup", x: 0, y: 0, width: 10, height: 10 },
        { type: "rectangle", id: "dup", x: 20, y: 0, width: 10, height: 10 },
      ]),
    ).rejects.toThrow(/Duplicate skeleton ids: dup/);
  });

  it("fails loudly if the converter stops matching skeletons one-to-one", () => {
    expect(() =>
      normalizeElements([{ id: "x", type: "rectangle" }], { skeletonIds: ["a", "b"] }),
    ).toThrow(/output shape changed/);
  });
});

describe("full ELK layout to elements, headless", () => {
  it("lays out and converts a real graph end to end in Node", async () => {
    const plan = await planDiagramLayout(GRAPH, { x: 0, y: 0 }, "diagram");
    const customData = new Map(
      [...plan.elementIdByNode].map(([nodeId, elementId]) => [elementId, { node: nodeId }]),
    );
    const elements = await convertSkeletons(plan.skeletons as Record<string, unknown>[], { customData });

    expect(plan.nodeCount).toBe(3);
    expect(plan.edgeCount).toBe(2);
    expect(elements.length).toBeGreaterThan(plan.skeletons.length);

    // Every node the caller asked for is findable by its semantic id alone.
    for (const nodeId of ["client", "api", "db"]) {
      const element = elements.find(
        (candidate) => (candidate.customData as { node?: string } | undefined)?.node === nodeId,
      );
      expect(element, `no element carries node=${nodeId}`).toBeDefined();
    }

    // Arrows must bind to real elements, not dangle at coordinates.
    const ids = new Set(elements.map((element) => element.id));
    for (const arrow of elements.filter((element) => element.type === "arrow")) {
      const start = (arrow.startBinding as { elementId?: string } | null)?.elementId;
      const end = (arrow.endBinding as { elementId?: string } | null)?.elementId;
      expect(start && ids.has(start), `dangling start on ${arrow.id}`).toBe(true);
      expect(end && ids.has(end), `dangling end on ${arrow.id}`).toBe(true);
    }
  });

  it("produces an identical file for an identical graph", async () => {
    const render = async () => {
      const plan = await planDiagramLayout(GRAPH, { x: 0, y: 0 }, "diagram");
      return JSON.stringify(await convertSkeletons(plan.skeletons as Record<string, unknown>[]));
    };
    expect(await render()).toBe(await render());
  });
});
