/**
 * Route anchors: `path#/api/board`, and what happens when the route goes away.
 *
 * The reason this form exists is that a server's boxes are the least anchorable
 * ones on any diagram. "Board API" is not a symbol and not a file -- it is an
 * endpoint, and the only mechanically checkable thing about an endpoint is that
 * the literal is still there.
 *
 * `missing-route` is loud, so the negative tests are the ones that matter. A
 * file that writes no route literals at all cannot be read for routing, and the
 * bar below is that it goes quiet and counted rather than reporting an endpoint
 * as gone because it could not find the routing table.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { parseSymbol, routeOf } from "../src/engine/assert";
import { emptyBoard, type BoardFile } from "../src/engine/board-file";
import { createDiagram } from "../src/engine/diagram";
import { checkDrift, createWorkspace, type Workspace } from "../src/engine/drift";
import { installExcalifontMeasurer } from "./helpers/excalifont";

installExcalifontMeasurer();

function fakeWorkspace(files: Record<string, string>): Workspace {
  return {
    resolve: (relative) => (relative.startsWith("../") ? undefined : relative),
    stat: (target) =>
      files[target] !== undefined
        ? "file"
        : Object.keys(files).some((file) => file.startsWith(`${target}/`))
          ? "directory"
          : "missing",
    read: (target) => files[target] ?? "",
    list: (target) =>
      Object.keys(files)
        .filter((file) => file.startsWith(`${target}/`))
        .map((file) => file.slice(target.length + 1))
        .filter((rest) => !rest.includes("/")),
  };
}

async function boardWith(
  nodes: Array<{ id: string; label: string; ref?: string; refs?: string[] }>,
): Promise<BoardFile> {
  const result = await createDiagram(emptyBoard(), { name: "api", nodes, edges: [] });
  return result.board;
}

/** One box, one route anchor, one version of the server file. */
async function claim(ref: string, files: Record<string, string>) {
  const board = await boardWith([{ id: "api", label: "Board API", ref }]);
  return checkDrift(board, fakeWorkspace(files));
}

const SERVER = [
  "export function serve(request: Request, url: URL) {",
  '  if (url.pathname === "/api/health") return ok();',
  '  if (request.method === "GET" && url.pathname === "/api/board") return board();',
  '  if (request.method === "POST" && url.pathname === "/api/file") return write();',
  "  return notFound();",
  "}",
].join("\n");

beforeAll(async () => {
  await boardWith([{ id: "warmup", label: "Warm up" }]);
}, 60_000);

describe("reading a route anchor", () => {
  it("takes a bare path", () => {
    expect(routeOf("/api/board")).toEqual({ route: "/api/board" });
  });

  it("takes a method token and remembers it without checking it", () => {
    expect(routeOf("POST /api/file")).toEqual({ method: "POST", route: "/api/file" });
    expect(routeOf("post /api/file")).toEqual({ method: "POST", route: "/api/file" });
  });

  it("is not a route just because it contains a space", () => {
    // Otherwise any two-word symbol would silently become an endpoint claim.
    expect(routeOf("handle request")).toBeUndefined();
    expect(routeOf("logLine")).toBeUndefined();
    expect(routeOf("GET nothing")).toBeUndefined();
  });

  it("keeps @ inside a route, with or without a method", () => {
    // `@` means an assertion everywhere else, and a route is the one place it
    // does not. The method form is the case that regressed when the token was
    // added: `GET /api/users/@me` no longer starts with a slash.
    expect(parseSymbol("/api/users/@me")).toEqual({ symbol: "/api/users/@me" });
    expect(parseSymbol("GET /api/users/@me")).toEqual({ symbol: "GET /api/users/@me" });
  });
});

describe("a box anchored to a route", () => {
  it("is quiet while the file still serves it", async () => {
    const report = await claim("src/server.ts#/api/board", { "src/server.ts": SERVER });
    expect(report.clean).toBe(true);
    expect(report.checked).toBe(1);
  });

  it("ignores the method token, which is decoration", async () => {
    const report = await claim("src/server.ts#POST /api/board", { "src/server.ts": SERVER });
    // `/api/board` is a GET here. The claim still holds, because verifying the
    // method needs framework parsing that is wrong per framework.
    expect(report.clean).toBe(true);
  });

  it("flags the route being taken out while the file stays", async () => {
    const report = await claim("src/server.ts#/api/board", {
      "src/server.ts": SERVER.replace(/.*\/api\/board.*\n/, ""),
    });
    expect(report.findings.map((finding) => finding.kind)).toEqual(["missing-route"]);
    expect(report.findings[0]!.detail).toContain("/api/board");
  });

  it("still flags the file itself going away, through the older check", async () => {
    const report = await claim("src/server.ts#/api/board", {});
    expect(report.findings.map((finding) => finding.kind)).toEqual(["missing-file"]);
  });
});

describe("what a route anchor refuses to guess", () => {
  it("says nothing about a file that writes no routes at all", async () => {
    // The load-bearing case. A helper module has no routing table to read, and
    // reporting the endpoint as gone because we could not find one would be a
    // loud wrong answer -- the one kind this design never allows.
    const report = await claim("src/helpers.ts#/api/board", {
      "src/helpers.ts": "export function ok() { return new Response(); }\n",
    });
    expect(report.findings).toEqual([]);
    expect(report.clean).toBe(true);
    expect(report.skippedWhy).toEqual({ "no-route-literals": 1 });
  });

  it("stays quiet when the route is composed rather than written whole", async () => {
    // `router.use("/api")` plus `.get("/board")` serves /api/board and writes it
    // nowhere. Every framework that mounts a prefix does this.
    const report = await claim("src/server.ts#/api/board", {
      "src/server.ts": 'import { boards } from "./boards";\nrouter.use("/api", boards);\n',
      "src/boards.ts": 'router.get("/board", handler);\n',
    });
    expect(report.findings).toEqual([]);
    expect(report.clean).toBe(true);
  });

  it("finds a route its imports serve, one hop out", async () => {
    const report = await claim("src/server.ts#/api/board", {
      "src/server.ts": 'import { routes } from "./routes";\nserve(routes);\n',
      "src/routes.ts": 'export const routes = { "/api/board": board, "/api/file": write };\n',
    });
    expect(report.clean).toBe(true);
  });

  it("refuses a route pointed at a directory, which cannot serve one", async () => {
    const report = await claim("src/server/#/api/board", {
      "src/server/index.ts": SERVER,
    });
    expect(report.findings.map((finding) => finding.kind)).toEqual(["unresolvable-ref"]);
    expect(report.findings[0]!.detail).toContain("not one file");
  });

  it("judges an arrow between two route boxes on the files, not on symbols", async () => {
    // A route is not a name, so there is no body to search. The arrow falls
    // through to the file-level channels, and here they are right to complain:
    // two unrelated files with no import and no shared route are not connected.
    //
    // The guard that keeps routes out of the symbol list cannot be observed
    // from here -- a `/`-prefixed string can never be an identifier, so the
    // symbol search would come back empty anyway. It is kept because it was
    // load-bearing when symbols were matched as raw text, and would be again if
    // that ever changed. Mutation-tested: removing it changes nothing today.
    const board = await createDiagram(emptyBoard(), {
      name: "api",
      nodes: [
        { id: "a", label: "Board API", ref: "src/a.ts#/api/board" },
        { id: "b", label: "File API", ref: "src/b.ts#/api/file" },
      ],
      edges: [{ from: "a", to: "b" }],
    });
    const report = checkDrift(board.board, fakeWorkspace({
      "src/a.ts": 'export function serveA(url: URL) { if (url.pathname === "/api/board") return 1; }\n',
      "src/b.ts": 'export function serveB(url: URL) { if (url.pathname === "/api/file") return 2; }\n',
    }));
    // Both boxes checked and clean; the arrow is what is in doubt.
    expect(report.findings).toEqual([]);
    expect(report.checked).toBe(2);
    expect(report.edgesChecked).toBe(1);
    expect(report.edges.map((edge) => edge.kind)).toEqual(["unsupported-edge"]);
  });

});

/**
 * The acceptance example named in the design, against the real file rather than
 * a fixture: `board-server.ts` really does serve `/api/board`, and the ghost
 * really is absent.
 */
describe("against this repo's own server", () => {
  const workspace = createWorkspace(process.cwd());

  it("confirms a route the server actually serves", async () => {
    const board = await boardWith([
      { id: "api", label: "Board API", ref: "src/server/board-server.ts#GET /api/board" },
    ]);
    const report = checkDrift(board, workspace);
    expect(report.findings).toEqual([]);
    expect(report.checked).toBe(1);
  });

  it("flags one it does not", async () => {
    const board = await boardWith([
      { id: "api", label: "Ghost API", ref: "src/server/board-server.ts#/api/ghost" },
    ]);
    const report = checkDrift(board, workspace);
    expect(report.findings.map((finding) => finding.kind)).toEqual(["missing-route"]);
  });
});
