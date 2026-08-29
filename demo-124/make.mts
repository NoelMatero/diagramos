/**
 * A plan whose code went the other way, for trying out #124.
 *
 * Both arrows below are `planned`: the board is a sketch of work to be done, and
 * the check's job is to notice when it lands. Both connections already exist in
 * this repository, so both would once have been reported as built. One of them
 * is built the other way round -- `accept.ts` imports `graph.ts`, so an arrow
 * planning "Graph will need Accept" is the plan the code contradicts.
 */
import { emptyBoard, writeBoard } from "../src/engine/board-file";
import { createDiagram } from "../src/engine/diagram";
import { initEngine } from "../src/engine/parse";

await initEngine();
const { board } = await createDiagram(emptyBoard(), {
  name: "plan-demo",
  nodes: [
    { id: "graph", label: "Graph", ref: "src/engine/graph.ts" },
    { id: "accept", label: "Accept", ref: "src/engine/accept.ts" },
    { id: "repair", label: "Repair", ref: "src/engine/repair.ts" },
  ],
  edges: [
    // Planned, and landed the way it was drawn: repair.ts imports ./graph.
    // This is the promotion, and it is what the other row used to look like.
    { from: "repair", to: "graph", state: "planned", claim: "needs" },
    // Planned, and landed backwards: accept.ts imports ./graph, not the
    // reverse. Before #124 this promoted too, in green, on the same run.
    { from: "graph", to: "accept", state: "planned", claim: "needs" },
  ],
});
await writeBoard("demo-124/backwards-plan.excalidraw", board);
console.log("wrote demo-124/backwards-plan.excalidraw");
