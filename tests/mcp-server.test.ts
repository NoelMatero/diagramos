/**
 * Drives the board server over a real stdio transport, the same way Claude
 * Code does. Nothing here reaches into the engine directly: if the tool
 * schemas, serialisation, or path handling break, these fail.
 */
import { createServer } from "node:http";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const REPO = path.resolve(__dirname, "..");
const BOARD = "docs/diagrams/architecture.excalidraw";

let workspace: string;
let client: Client;
let boardPort: number;

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
}

function jsonOf(result: unknown): Record<string, unknown> {
  return JSON.parse(textOf(result)) as Record<string, unknown>;
}

async function call(name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  if ((result as { isError?: boolean }).isError) throw new Error(`${name}: ${textOf(result)}`);
  return result;
}

/**
 * A port nobody is on, claimed by binding and releasing it.
 *
 * Without this the server under test uses the default 4747 — and if a real board
 * is running there, which it is whenever anyone is using this project, the tests
 * reach out and re-point somebody's live page. It also made `board_status`
 * ambient: the assertion depended on whether a board happened to be up.
 */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

beforeAll(async () => {
  // Resolved: the board service reports resolved paths, and /var is a link.
  workspace = realpathSync(mkdtempSync(path.join(os.tmpdir(), "board-mcp-")));
  boardPort = await freePort();
  client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: "npx",
      args: ["tsx", path.join(REPO, "src/mcp/server.ts")],
      cwd: REPO,
      env: { ...process.env, DIAGRAMOS_MCP_ROOT: workspace, DIAGRAMOS_PORT: String(boardPort) },
    }),
  );
}, 120_000);

afterAll(async () => {
  await client?.close();
  if (workspace) rmSync(workspace, { recursive: true, force: true });
});

describe("board MCP server", () => {
  it("advertises the board tools", async () => {
    const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
    expect(names).toEqual(
      [
        "board_status",
        "check_drift",
        "connect_nodes",
        "create_diagram",
        "delete_diagram",
        "edit_diagram",
        "new_board",
        "open_board",
        "place_image",
        "read_diagram",
        "render_diagram",
      ].sort(),
    );
  });

  it("creates a diagram and writes a real .excalidraw file", async () => {
    const result = jsonOf(
      await call("create_diagram", {
        path: BOARD,
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
      }),
    );
    expect(result.nodes).toBe(3);
    expect(result.edges).toBe(2);

    const board = JSON.parse(await readFile(path.join(workspace, BOARD), "utf8"));
    expect(board.type).toBe("excalidraw");
    expect(board.elements.length).toBeGreaterThan(5);
  }, 120_000);

  it("reads the diagram back as the graph that was written", async () => {
    const graph = jsonOf(await call("read_diagram", { path: BOARD }));
    expect(graph.title).toBe("Request path");

    const nodes = graph.nodes as Array<{ id: string; label: string; provenance: string }>;
    expect(nodes.map((node) => node.id).sort()).toEqual(["api", "client", "db"]);
    expect(nodes.find((node) => node.id === "api")?.label).toBe("API");
    // Everything this tool drew must round-trip exactly, never be re-guessed.
    // Recorded is the default and is left out of the response, so what proves
    // it round-tripped is that nothing came back inferred.
    expect(nodes.every((node) => node.provenance === undefined)).toBe(true);

    const edges = graph.edges as Array<{ from: string; to: string; label?: string }>;
    expect(edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: "client", to: "api", label: "http" }),
        expect.objectContaining({ from: "api", to: "db", label: "query" }),
      ]),
    );
  }, 60_000);

  it("edits by semantic element id and reflects it on the next read", async () => {
    const board = JSON.parse(await readFile(path.join(workspace, BOARD), "utf8"));
    const apiElement = board.elements.find(
      (element: { customData?: { node?: string } }) => element.customData?.node === "api",
    );
    await call("edit_diagram", {
      path: BOARD,
      updates: [{ id: apiElement.id, backgroundColor: "#ffec99" }],
    });
    const after = JSON.parse(await readFile(path.join(workspace, BOARD), "utf8"));
    const updated = after.elements.find((element: { id: string }) => element.id === apiElement.id);
    expect(updated.backgroundColor).toBe("#ffec99");
  }, 60_000);

  it("connects nodes by semantic id, with bindings both ways", async () => {
    await call("connect_nodes", {
      path: BOARD,
      connections: [{ from: "db", to: "client", label: "cache" }],
    });
    const graph = jsonOf(await call("read_diagram", { path: BOARD }));
    expect(graph.edges).toEqual(
      expect.arrayContaining([expect.objectContaining({ from: "db", to: "client", label: "cache" })]),
    );

    const board = JSON.parse(await readFile(path.join(workspace, BOARD), "utf8"));
    const arrow = board.elements.find(
      (element: { customData?: { edge?: { from?: string } } }) => element.customData?.edge?.from === "db",
    );
    expect(arrow.startBinding.elementId).toBeTruthy();
    expect(arrow.endBinding.elementId).toBeTruthy();
    // The shape must list the arrow too, or the editor drops the attachment.
    const source = board.elements.find((element: { id: string }) => element.id === arrow.startBinding.elementId);
    expect(source.boundElements.some((bound: { id: string }) => bound.id === arrow.id)).toBe(true);
  }, 60_000);

  /**
   * read_diagram no longer hands out elementId by default, so the only id a
   * caller normally holds is the node id. If an edit could not take that, the
   * saving would have been paid for with a second read on every change -- or,
   * worse, a silent "no element has these ids" on an id the tool just printed.
   */
  it("edits by the node id read_diagram actually returns", async () => {
    const graph = jsonOf(await call("read_diagram", { path: BOARD }));
    const clientNode = (graph.nodes as Array<Record<string, unknown>>).find((node) => node.id === "client");
    expect(clientNode).not.toHaveProperty("elementId");

    const result = jsonOf(await call("edit_diagram", {
      path: BOARD,
      updates: [{ id: "client", backgroundColor: "#b2f2bb" }],
    }));
    expect(result.skipped).toBeUndefined();

    const board = JSON.parse(await readFile(path.join(workspace, BOARD), "utf8"));
    const element = board.elements.find(
      (item: { customData?: { node?: string } }) => item.customData?.node === "client",
    );
    expect(element.backgroundColor).toBe("#b2f2bb");
  }, 60_000);

  it("reports unknown ids instead of silently doing nothing", async () => {
    const result = jsonOf(await call("edit_diagram", { path: BOARD, deletes: ["does-not-exist"] }));
    expect(result.skipped).toEqual(["does-not-exist"]);
  }, 60_000);

  it("refuses to touch paths outside the workspace", async () => {
    const result = await client.callTool({
      name: "read_diagram",
      arguments: { path: "../../../etc/passwd" },
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result)).toMatch(/escapes the workspace/i);
  }, 60_000);

  /**
   * The live view is the one piece of state the model cannot infer from a file,
   * and guessing produced a URL that answered nothing. It has to be askable.
   */
  it("reports whether a live board exists instead of leaving it to be guessed", async () => {
    const status = jsonOf(await call("board_status", {}));
    expect(typeof status.running).toBe("boolean");
    if (!status.running) {
      expect(String(status.note)).toMatch(/open_board/);
      return;
    }
    // followUrl is the bare page that follows whichever board was written last.
    // Every open board also gets its own pinned URL, because handing the user one
    // address for several diagrams is how they end up looking at the wrong one.
    expect(String(status.followUrl)).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    const boards = status.boards as Array<{ file: string; url: string }>;
    expect(Array.isArray(boards)).toBe(true);
    expect(boards.length).toBeGreaterThan(0);
    for (const board of boards) {
      expect(board.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?file=/);
      expect(board.file).toBeTruthy();
    }
  }, 60_000);

  it("keeps edge colours through a regenerate", async () => {
    const board = "docs/diagrams/colored.excalidraw";
    const args = {
      path: board,
      title: "Colored",
      nodes: [
        { id: "a", label: "A", backgroundColor: "#4dabf7", strokeColor: "#1971c2" },
        { id: "b", label: "B" },
      ],
      edges: [{ from: "a", to: "b", label: "flow", strokeColor: "#1971c2" }],
    };
    await call("create_diagram", args);
    // Regenerating must not silently revert styling and force a second pass.
    await call("create_diagram", args);

    const parsed = JSON.parse(await readFile(path.join(workspace, board), "utf8"));
    const live = parsed.elements.filter((element: { isDeleted?: boolean }) => !element.isDeleted);
    const arrows = live.filter((element: { type: string }) => element.type === "arrow");
    expect(arrows.length).toBeGreaterThan(0);
    expect(arrows.every((arrow: { strokeColor: string }) => arrow.strokeColor === "#1971c2")).toBe(true);

    // The label on the filled node must not inherit a near-invisible colour.
    const filled = live.find(
      (element: { customData?: { node?: string } }) => element.customData?.node === "a",
    );
    const label = live.find((element: { containerId?: string }) => element.containerId === filled.id);
    expect(label.strokeColor).not.toBe("#1971c2");
  }, 120_000);

  /**
   * The claim slot, over the wire.
   *
   * The engine tests cover what a claim is; this covers whether an agent can
   * actually write one and read it back, which is the part that breaks when a
   * schema field is added in one place and forgotten in another.
   */
  it("carries an arrow claim through the tools and shows it on the board", async () => {
    const board = "docs/diagrams/claimed.excalidraw";
    const wrote = jsonOf(await call("create_diagram", {
      path: board,
      nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
      edges: [{ from: "a", to: "b", claim: "needs" }],
    }));
    // Named the turn it is written.
    expect(String(wrote.claims)).toContain("needs");
    // Named per word, because the two carry opposite consequences: this one can
    // come back wrong, and an author told otherwise would be told wrong.
    expect(String(wrote.claims)).toContain("backwards");

    const read = jsonOf(await call("read_diagram", { path: board }));
    expect((read.edges as Array<{ claim?: string }>)[0].claim).toBe("needs");

    // And visible: the word is on the canvas, not only in the metadata.
    const parsed = JSON.parse(await readFile(path.join(workspace, board), "utf8"));
    const texts = parsed.elements
      .filter((element: { isDeleted?: boolean; type: string }) => !element.isDeleted && element.type === "text")
      .map((element: { text: string }) => element.text);
    expect(texts).toContain("@needs");
  }, 120_000);

  it("refuses a claim word that is not in the vocabulary", async () => {
    const board = "docs/diagrams/bad-claim.excalidraw";
    // Through the schema there is nothing to argue about: the enum rejects it.
    await expect(call("create_diagram", {
      path: board,
      nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
      edges: [{ from: "a", to: "b", claim: "depends" }],
    })).rejects.toThrow();

    // Typed into a label instead, it is caught the turn it is written rather
    // than at the end of the turn by the hook.
    const wrote = jsonOf(await call("create_diagram", {
      path: board,
      nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
      edges: [{ from: "a", to: "b", label: "@need" }],
    }));
    expect(JSON.stringify(wrote.garbledClaims)).toContain("@needs");
  }, 120_000);

  /**
   * Without this tool the only way to drop a diagram was to regenerate the
   * board from a graph you still had to hand, or to enumerate element ids into
   * edit_diagram. Both are workarounds standing in for a missing feature.
   */
  it("deletes a named diagram without disturbing another on the same board", async () => {
    const board = "docs/diagrams/two-diagrams.excalidraw";
    await call("create_diagram", { path: board, nodes: [{ id: "a", label: "A" }], name: "arch" });
    await call("create_diagram", {
      path: board,
      nodes: [{ id: "b", label: "B" }],
      name: "ims",
      append: true,
    });

    // The names delete_diagram takes have to be discoverable from a read.
    const before = jsonOf(await call("read_diagram", { path: board }));
    expect((before.diagrams as Array<{ name: string }>).map((diagram) => diagram.name)).toEqual([
      "arch",
      "ims",
    ]);

    const deleted = jsonOf(await call("delete_diagram", { path: board, name: "arch" }));
    expect(deleted.deleted).toEqual(["arch"]);
    expect(deleted.remainingDiagrams).toEqual(["ims"]);

    const graph = jsonOf(await call("read_diagram", { path: board }));
    expect((graph.nodes as Array<{ id: string }>).map((node) => node.id)).toEqual(["b"]);

    // Removing the last one leaves a valid, empty board rather than a stub.
    const emptied = jsonOf(await call("delete_diagram", { path: board }));
    expect(emptied.remainingDiagrams).toBeUndefined();
    const parsed = JSON.parse(await readFile(path.join(workspace, board), "utf8"));
    expect(parsed.type).toBe("excalidraw");
    expect(parsed.elements.filter((element: { isDeleted?: boolean }) => !element.isDeleted)).toEqual([]);
  }, 120_000);

  it("refuses an unknown diagram name instead of reporting a no-op as success", async () => {
    const board = "docs/diagrams/named.excalidraw";
    await call("create_diagram", { path: board, nodes: [{ id: "a", label: "A" }], name: "arch" });
    const result = await client.callTool({
      name: "delete_diagram",
      arguments: { path: board, name: "nope" },
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result)).toMatch(/Available: arch/);
  }, 120_000);

  /**
   * The end-to-end path that matters for drift: a ref given to create_diagram
   * has to survive the schema, land in customData, come back from read_diagram,
   * and be what check_drift compares against the real working tree.
   */
  it("carries a node's ref through to check_drift", async () => {
    const board = "docs/diagrams/refs.excalidraw";
    await writeFile(path.join(workspace, "kept.ts"), "export function keptSymbol() {}\n");
    await call("create_diagram", {
      path: board,
      nodes: [
        { id: "kept", label: "Kept", ref: "kept.ts" },
        { id: "symbol", label: "Symbol", ref: "kept.ts#keptSymbol" },
        { id: "plain", label: "No ref here" },
      ],
    });

    const graph = jsonOf(await call("read_diagram", { path: board }));
    const refs = (graph.nodes as Array<{ id: string; ref?: string }>).map((node) => node.ref);
    expect(refs).toEqual(["kept.ts", "kept.ts#keptSymbol", undefined]);

    const clean = jsonOf(await call("check_drift", { path: board }));
    expect(clean).toMatchObject({ clean: true, checked: 2, skipped: 1 });
    expect(clean.note).toBeUndefined();

    rmSync(path.join(workspace, "kept.ts"));
    const drifted = jsonOf(await call("check_drift", { path: board }));
    expect(drifted.clean).toBe(false);
    expect((drifted.findings as Array<{ node: string }>).map((finding) => finding.node)).toEqual([
      "kept",
      "symbol",
    ]);
    // Every finding names its own board, because a project holds several and a
    // caller has to know which file to redraw.
    expect((drifted.findings as Array<{ board: string }>).every((f) => f.board === board)).toBe(true);
  }, 120_000);

  /**
   * The plan-first loop's draw-time half (#78): a box pointing at code that
   * does not exist is either a typo or a plan that forgot to say so, and the
   * tool result has to say it immediately -- to the model, while it can still
   * fix the ref or mark the box planned -- instead of one turn later as a red
   * notice to the user.
   */
  it("says at draw time when a box points at code that does not exist", async () => {
    const board = "docs/diagrams/draw-time.excalidraw";
    await writeFile(path.join(workspace, "already.ts"), "export const already = 1;\n");
    const result = jsonOf(
      await call("create_diagram", {
        path: board,
        nodes: [
          { id: "real", label: "Already here", ref: "already.ts" },
          { id: "ghost", label: "Ghost", ref: "src/not-written-yet.ts" },
        ],
      }),
    );
    expect(result.pointsAtNothing).toEqual(["Ghost → src/not-written-yet.ts"]);
    expect(String(result.fix)).toContain('state: "planned"');
    expect(result.plannedWork).toBeUndefined();
  }, 120_000);

  it("reports planned boxes as tracked work, not as a problem", async () => {
    const board = "docs/diagrams/plan.excalidraw";
    await writeFile(path.join(workspace, "already.ts"), "export const already = 1;\n");
    const result = jsonOf(
      await call("create_diagram", {
        path: board,
        nodes: [
          { id: "real", label: "Already here", ref: "already.ts" },
          { id: "next", label: "Next", ref: "src/next.ts", state: "planned" },
        ],
        edges: [{ from: "real", to: "next", state: "planned" }],
      }),
    );
    expect(result.pointsAtNothing).toBeUndefined();
    expect(result.fix).toBeUndefined();
    // One item, not two: the planned arrow's far end has no code yet, so the
    // arrow is unreadable rather than pending -- the same answer check_drift
    // and the end-of-turn notice give, which is the point of reusing them.
    expect(String(result.plannedWork)).toMatch(/^1 planned item tracked/);
  }, 120_000);

  it("stays quiet at draw time when every ref resolves", async () => {
    const board = "docs/diagrams/resolved.excalidraw";
    await writeFile(path.join(workspace, "already.ts"), "export const already = 1;\n");
    const result = jsonOf(
      await call("create_diagram", {
        path: board,
        nodes: [{ id: "real", label: "Already here", ref: "already.ts" }],
      }),
    );
    expect(result.pointsAtNothing).toBeUndefined();
    expect(result.plannedWork).toBeUndefined();
  }, 120_000);

  /**
   * An arrow nothing checked, named on request.
   *
   * The counts already say how many arrows went unread and why. A caller
   * deciding whether a diagram can be trusted needs to know *which*, and the
   * reason alone does not say: an arrow onto an `external` box carries no claim
   * any check here can test, and until it is named it reads exactly like an
   * arrow that passed.
   */
  it("names unread arrows only when coverage is asked for", async () => {
    const board = "docs/diagrams/unread.excalidraw";
    await writeFile(path.join(workspace, "engine.ts"), "export const plan = 1;\n");
    await call("create_diagram", {
      path: board,
      nodes: [
        { id: "engine", label: "ELK layout engine", ref: "engine.ts" },
        { id: "file", label: "board.excalidraw", state: "external" },
      ],
      edges: [{ from: "engine", to: "file", label: "writes" }],
    });

    // The per-turn answer stays a count: this response is read every turn.
    const quiet = jsonOf(await call("check_drift", { path: board }));
    expect(quiet.clean).toBe(true);
    expect(quiet.edgesSkippedWhy).toEqual({ "endpoint-external": 1 });
    expect(quiet.unreadEdges).toBeUndefined();

    const asked = jsonOf(await call("check_drift", { path: board, coverage: true }));
    expect(asked.unreadEdges).toEqual([
      {
        board,
        from: "engine",
        to: "file",
        fromLabel: "ELK layout engine",
        toLabel: "board.excalidraw",
        label: "writes",
        reason: "endpoint-external",
      },
    ]);
    // Unread is not drift. Nothing here was claimed falsely; nothing was read.
    expect(asked.clean).toBe(true);
  }, 120_000);

  /**
   * No diagram is "current": a project holds as many as it likes, and checking
   * means checking all of them unless one is named.
   */
  it("checks every diagram at once when no path is given", async () => {
    const dir = path.join(workspace, "docs", "diagrams");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(workspace, "present.ts"), "export const present = 1;\n");
    await call("create_diagram", {
      path: "docs/diagrams/one.excalidraw",
      nodes: [{ id: "a", label: "Here", ref: "present.ts" }],
    });
    await call("create_diagram", {
      path: "docs/diagrams/two.excalidraw",
      nodes: [{ id: "b", label: "Gone", ref: "never-existed.ts" }],
    });

    const report = jsonOf(await call("check_drift", {}));
    const boards = report.boards as string[];
    // Containment rather than an exact list: every test in this file shares one
    // workspace, and since create_diagram confines boards to the diagram
    // directory they all land here. An exact list only held while the other
    // tests were writing somewhere check_drift could not see, which is the
    // blind spot this directory rule exists to close.
    expect(boards).toEqual(expect.arrayContaining(["docs/diagrams/one.excalidraw", "docs/diagrams/two.excalidraw"]));
    for (const board of boards) expect(board.startsWith("docs/diagrams/")).toBe(true);
    expect(report.clean).toBe(false);
    // Only the second of the two is stale, and the report attributes it there
    // rather than to the board that is fine.
    const findings = report.findings as Array<{ board: string; node: string }>;
    expect(findings.filter((finding) => finding.board.endsWith("two.excalidraw"))).toMatchObject([
      { board: "docs/diagrams/two.excalidraw", node: "b" },
    ]);
    expect(findings.some((finding) => finding.board.endsWith("one.excalidraw"))).toBe(false);
  }, 120_000);

  it("says when a clean report checked nothing at all", async () => {
    const board = "docs/diagrams/no-refs.excalidraw";
    await call("create_diagram", { path: board, nodes: [{ id: "a", label: "Auth" }] });
    const report = jsonOf(await call("check_drift", { path: board }));
    // "clean: true" over zero comparisons would otherwise read as a pass.
    expect(report).toMatchObject({ clean: true, checked: 0 });
    expect(report.note).toMatch(/No node carried a ref/);
  }, 120_000);

  /**
   * Two images whose names sanitise to the same string used to land on the same
   * element id and overwrite each other in board.files, and re-placing one
   * appended a second element carrying an id the first already had.
   */
  it("gives every image its own id and updates in place when re-placed", async () => {
    const board = "docs/diagrams/with-images.excalidraw";
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
      "base64",
    );
    await writeFile(path.join(workspace, "shot a.png"), png);
    await writeFile(path.join(workspace, "shot-a.png"), png);
    await call("create_diagram", { path: board, nodes: [{ id: "n", label: "N" }] });

    const first = jsonOf(await call("place_image", { path: board, image: "shot a.png" }));
    const second = jsonOf(await call("place_image", { path: board, image: "shot-a.png" }));
    expect(first.elementId).not.toBe(second.elementId);

    // Move it, the way a user would, then re-place the same file.
    await call("edit_diagram", { path: board, updates: [{ id: first.elementId, x: 500, y: 700 }] });
    const again = jsonOf(await call("place_image", { path: board, image: "shot a.png" }));
    expect(again.replacedInPlace).toBe(first.elementId);

    const parsed = JSON.parse(await readFile(path.join(workspace, board), "utf8"));
    const images = parsed.elements.filter(
      (element: { type: string; isDeleted?: boolean }) => element.type === "image" && !element.isDeleted,
    ) as Array<{ id: string; x: number; y: number }>;
    const ids = images.map((element) => element.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    // Both images must still have their own data behind them.
    expect(Object.keys(parsed.files)).toEqual(expect.arrayContaining(ids));
    // Re-placing must not drag the image back to where it was first put.
    expect(images.find((element) => element.id === first.elementId)).toMatchObject({ x: 500, y: 700 });
  }, 120_000);

  /**
   * Tool results are charged to a context window, and the defaults are what a
   * model pays without asking. A raw element dump ran to ~25k tokens on one
   * 24-node board, most of it seeds, nonces and fill styles nothing can use.
   */
  it("keeps read_diagram lean by default and opt-in when detail is wanted", async () => {
    const board = "docs/diagrams/cost.excalidraw";
    const nodes = Array.from({ length: 20 }, (_, index) => ({ id: `n${index}`, label: `Node ${index}` }));
    // One box that disagrees with every default, so the trim is proved to be
    // dropping repetition rather than dropping content.
    nodes.push({ id: "odd", label: "Odd", shape: "ellipse", state: "planned" } as (typeof nodes)[number]);
    await call("create_diagram", {
      path: board,
      title: "Cost",
      nodes,
      edges: nodes.slice(1).map((node, index) => ({ from: nodes[index].id, to: node.id, label: "to" })),
    });

    const lean = textOf(await call("read_diagram", { path: board }));
    const withGeometry = textOf(await call("read_diagram", { path: board, geometry: true }));
    const withElements = textOf(await call("read_diagram", { path: board, includeElements: true }));

    // Not pretty-printed: indentation was over a third of the response.
    expect(lean).not.toContain("\n");
    // Geometry is real detail, so it must cost something and be off by default.
    expect(withGeometry.length).toBeGreaterThan(lean.length);
    const leanNodes = (JSON.parse(lean) as { nodes: Array<Record<string, unknown>> }).nodes;
    expect(leanNodes[0]).not.toHaveProperty("x");
    expect(
      (JSON.parse(withGeometry) as { nodes: Array<Record<string, unknown>> }).nodes[0],
    ).toHaveProperty("x");

    // Words every box repeats are not content. These are the documented
    // defaults, so their absence is the claim; only the id, the label and
    // whatever the board actually says survive.
    for (const key of ["shape", "provenance", "state", "elementId"]) {
      expect(leanNodes[0], key).not.toHaveProperty(key);
    }
    expect(leanNodes[0]).toEqual({ id: "n0", label: "Node 0" });
    const leanEdges = (JSON.parse(lean) as { edges: Array<Record<string, unknown>> }).edges;
    for (const key of ["provenance", "endpoints", "state", "elementId"]) {
      expect(leanEdges[0], key).not.toHaveProperty(key);
    }
    // An empty array is four bytes saying nothing.
    expect(JSON.parse(lean)).not.toHaveProperty("unattributed");

    // The response has to explain its own omissions. A board where everything
    // agrees with every default would otherwise never mention that provenance,
    // state or endpoints exist, and a reader cannot ask about a concept it has
    // no way to know is there.
    expect(JSON.parse(lean).omittedWhenDefault).toEqual({
      shape: "rectangle",
      provenance: "recorded",
      state: "built",
      endpoints: "declared",
    });

    const odd = leanNodes.find((node) => node.id === "odd");
    expect(odd).toEqual({ id: "odd", label: "Odd", shape: "ellipse", state: "planned" });

    // Withheld, never lost: either detail flag brings the raw handle back for
    // a caller that has to address an element directly.
    for (const detailed of [withGeometry, withElements]) {
      expect(
        (JSON.parse(detailed) as { nodes: Array<Record<string, unknown>> }).nodes[0],
      ).toHaveProperty("elementId");
    }

    // Elements are projected to what an edit addresses, not dumped raw.
    const elements = (JSON.parse(withElements) as { elements: Array<Record<string, unknown>> }).elements;
    expect(elements.length).toBeGreaterThan(20);
    for (const key of ["seed", "versionNonce", "roughness", "groupIds", "customData"]) {
      expect(elements[0], key).not.toHaveProperty(key);
    }
    expect(elements[0]).toMatchObject({ id: expect.any(String), type: expect.any(String) });
  }, 120_000);

  it("returns an error result rather than crashing on a bad graph", async () => {
    const result = await client.callTool({
      name: "create_diagram",
      arguments: { path: "docs/diagrams/broken.excalidraw", nodes: [{ id: "a", label: "A" }], edges: [{ from: "a", to: "ghost" }] },
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
  }, 60_000);
});

/**
 * The tool layer for boards open side by side.
 *
 * The server keeps its boards apart (board-server.test.ts) and two real pages
 * stay put (the e2e run), but neither covers what Claude is actually handed: a
 * URL per board. The plugin's own instructions say never to give the user a
 * localhost address you did not get from these tools, so the addresses these
 * tools hand out have to answer — and answer with the right diagram. Nothing
 * checked that, and a pinned URL that quietly serves the wrong board looks
 * exactly like one that works.
 */
describe("open_board with several boards", () => {
  const alpha = "docs/diagrams/alpha.excalidraw";
  const beta = "docs/diagrams/beta.excalidraw";

  /** The board a pinned URL actually serves, asked over HTTP. */
  async function servedBy(pinned: string): Promise<string> {
    const url = new URL(pinned);
    const api = new URL("/api/board", url);
    api.search = url.search;
    const response = await fetch(api, { cache: "no-store" });
    if (!response.ok) throw new Error(`${api.href} -> ${response.status}`);
    return path.basename(((await response.json()) as { file: string }).file);
  }

  let alphaUrl: string;

  it("hands back a URL pinned to the board it opened, and it serves that board", async () => {
    await call("create_diagram", { path: alpha, title: "Alpha", nodes: [{ id: "a", label: "Alpha node" }] });
    const opened = jsonOf(await call("open_board", { path: alpha, open: false }));
    alphaUrl = String(opened.url);

    expect(alphaUrl).toContain("?file=");
    expect(opened.file).toBe(alpha);
    expect(await servedBy(alphaUrl)).toBe("alpha.excalidraw");
  }, 120_000);

  it("opening a second board does not move the first one's URL", async () => {
    await call("create_diagram", { path: beta, title: "Beta", nodes: [{ id: "b", label: "Beta node" }] });
    const opened = jsonOf(await call("open_board", { path: beta, open: false }));
    const betaUrl = String(opened.url);

    expect(betaUrl).not.toBe(alphaUrl);
    expect(await servedBy(betaUrl)).toBe("beta.excalidraw");
    // The whole point: the first address still means what it meant.
    expect(await servedBy(alphaUrl)).toBe("alpha.excalidraw");
  }, 120_000);

  it("board_status lists every open board with its own address", async () => {
    const status = jsonOf(await call("board_status", {}));
    expect(status.running).toBe(true);

    const boards = status.boards as Array<{ file: string; url: string }>;
    expect(boards.map((board) => board.file).sort()).toEqual([alpha, beta].sort());
    for (const board of boards) {
      expect(path.basename(board.file)).toBe(await servedBy(board.url));
    }

    // The bare page follows the last board opened; the pinned ones do not.
    expect(String(status.followUrl)).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(status.showing).toBe(beta);
  }, 120_000);
});
