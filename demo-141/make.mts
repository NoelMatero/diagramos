/**
 * A board with one arrow drawn the wrong way round, for trying out #141.
 *
 * The two claims below are about real files in this repository, and one of them
 * is a lie: `accept.ts` imports `graph.ts`, so an arrow saying Graph needs
 * Accept is backwards, and the check can prove it.
 */
import { emptyBoard, writeBoard } from "../src/engine/board-file";
import { createDiagram } from "../src/engine/diagram";
import { initEngine } from "../src/engine/parse";

await initEngine();
const { board } = await createDiagram(emptyBoard(), {
  name: "accept-demo",
  nodes: [
    { id: "graph", label: "Graph", ref: "src/engine/graph.ts" },
    { id: "accept", label: "Accept", ref: "src/engine/accept.ts" },
    { id: "repair", label: "Repair", ref: "src/engine/repair.ts" },
  ],
  edges: [
    // True: repair.ts imports ./graph. Confirmed, and the check stays quiet.
    { from: "repair", to: "graph", claim: "needs" },
    // False: accept.ts imports ./graph, not the other way. This is the finding.
    { from: "graph", to: "accept", claim: "needs" },
  ],
});
await writeBoard("demo-141/backwards.excalidraw", board);
console.log("wrote demo-141/backwards.excalidraw");
