/**
 * A box marked `external` whose ref names a class declared in this repository
 * (#366, section 1).
 *
 * `external` means "real, but not code in this repo": a browser, a database.
 * Its ref, if any, is the routine here that talks to it -- its door (#272). A
 * class is never a door. So an external box anchored at a class declared here
 * is code in this repo that was marked wrongly, and every arrow touching it was
 * skipped as "outside the repo". On the planted bench that was 9 wrong arrows
 * that nothing read: Haiku drew httpx's `BaseTransport` and `ByteStream`
 * external although both are declared in httpx.
 *
 * Such a box is now read like a built one, and the report says it is marked
 * wrongly. A ref that names a routine keeps its door meaning, and a ref to a
 * name the file does not declare, or to somewhere outside the repository, is
 * skipped as before. A ref to a whole file here is read and never accuses
 * (#435, at the bottom).
 */
import { beforeAll, describe, expect, it } from "vitest";

import { emptyBoard, type BoardFile } from "../src/engine/board-file";
import { createDiagram } from "../src/engine/diagram";
import { checkDrift, type Workspace } from "../src/engine/drift";
import type { NodeState } from "../src/engine/graph";
import { initEngine } from "../src/engine/parse";
import { installExcalifontMeasurer } from "./helpers/excalifont";

installExcalifontMeasurer();

beforeAll(async () => {
  await initEngine();
}, 60_000);

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

async function boardOf(
  tail: { ref: string; state?: NodeState },
  head: { ref: string; state?: NodeState },
  claim: "needs" | "calls" = "needs",
): Promise<BoardFile> {
  return (await createDiagram(emptyBoard(), {
    name: "arch",
    nodes: [
      { id: "tail", label: "Tail", ...tail },
      { id: "head", label: "Head", ...head },
    ],
    edges: [{ from: "tail", to: "head", claim }],
  })).board;
}

const ts = {
  "src/transport.ts": "export class BaseTransport {\n  send() {\n    return 1;\n  }\n}\n",
  "src/shape.ts": "export interface Shape {\n  area(): number;\n}\n",
  "src/client.ts": "export function send() {\n  return 2;\n}\n",
  "src/user.ts": 'import { BaseTransport } from "./transport";\nexport function user() {\n  return new BaseTransport();\n}\n',
  "src/plain.ts": "export function plain() {\n  return 1;\n}\n",
};

/** Rust builds its module tree from the `Cargo.toml` files, so this one can list. */
function treeWorkspace(files: Record<string, string>): Workspace {
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
        if (file.startsWith(prefix)) names.add(file.slice(prefix.length).split("/")[0]!);
      }
      return [...names];
    },
  };
}

const rust = {
  "Cargo.toml": '[package]\nname = "demo"\nversion = "0.1.0"\n',
  "src/lib.rs": "pub mod transport;\npub mod client;\n",
  "src/transport.rs": "pub struct Transport {\n    pub open: bool,\n}\npub struct Marker;\n",
  "src/client.rs": "pub fn send() -> u32 {\n    2\n}\n",
};

const python = {
  "pkg/transport.py": "class BaseTransport:\n    def send(self):\n        return 1\n",
  "pkg/client.py": "def send():\n    return 2\n",
};

describe("an external box anchored at a class in this repository", () => {
  it("reads a wrong arrow onto a TypeScript class and calls it wrong", async () => {
    const board = await boardOf(
      { ref: "src/client.ts#send" },
      { ref: "src/transport.ts#BaseTransport", state: "external" },
    );
    const report = checkDrift(board, fakeWorkspace(ts));
    expect(report.unreadEdges).toEqual([]);
    expect(report.edges.map((finding) => finding.kind)).toEqual(["needs-absent"]);
    expect(report.edges[0]!.detail).toContain("marked external");
    expect(report.clean).toBe(false);
  });

  it("does the same for a TypeScript interface", async () => {
    const board = await boardOf(
      { ref: "src/client.ts#send" },
      { ref: "src/shape.ts#Shape", state: "external" },
    );
    const report = checkDrift(board, fakeWorkspace(ts));
    expect(report.edges.map((finding) => finding.kind)).toEqual(["needs-absent"]);
  });

  it("does the same when the external box is the tail", async () => {
    const board = await boardOf(
      { ref: "src/transport.ts#BaseTransport", state: "external" },
      { ref: "src/client.ts#send" },
    );
    const report = checkDrift(board, fakeWorkspace(ts));
    expect(report.edges.map((finding) => finding.kind)).toEqual(["needs-absent"]);
    expect(report.edges[0]!.detail).toContain("marked external");
  });

  it("does the same for a Python class", async () => {
    const board = await boardOf(
      { ref: "pkg/client.py#send" },
      { ref: "pkg/transport.py#BaseTransport", state: "external" },
    );
    const report = checkDrift(board, fakeWorkspace(python));
    expect(report.unreadEdges).toEqual([]);
    expect(report.edges.map((finding) => finding.kind)).toEqual(["needs-absent"]);
  });

  it("does the same for a Rust struct", async () => {
    const board = await boardOf(
      { ref: "src/client.rs#send" },
      { ref: "src/transport.rs#Transport", state: "external" },
    );
    const report = checkDrift(board, treeWorkspace(rust));
    expect(report.unreadEdges).toEqual([]);
    expect(report.edges.map((finding) => finding.kind)).toEqual(["needs-absent"]);
  });

  it("confirms a correct arrow onto it, without a finding", async () => {
    const board = await boardOf(
      { ref: "src/user.ts#user" },
      { ref: "src/transport.ts#BaseTransport", state: "external" },
    );
    const report = checkDrift(board, fakeWorkspace(ts));
    expect(report.edgesChecked).toBe(1);
    expect(report.edges).toEqual([]);
    expect(report.clean).toBe(true);
  });
});

describe("an external box that still means something outside", () => {
  const skipped = async (ref: string) => {
    const board = await boardOf({ ref: "src/client.ts#send" }, { ref, state: "external" });
    const report = checkDrift(board, fakeWorkspace(ts));
    expect(report.edges).toEqual([]);
    expect(report.unreadEdges.map((entry) => entry.reason)).toEqual(["endpoint-external"]);
  };

  it("skips one anchored at a routine, which is the door it talks through", async () => {
    await skipped("src/plain.ts#plain");
  });

  it("skips one whose name the file does not declare", async () => {
    await skipped("src/transport.ts#Elsewhere");
  });

  it("skips a Rust unit struct, whose declaration has no body to tell it from a value", async () => {
    const board = await boardOf(
      { ref: "src/client.rs#send" },
      { ref: "src/transport.rs#Marker", state: "external" },
    );
    const report = checkDrift(board, treeWorkspace(rust));
    expect(report.unreadEdges.map((entry) => entry.reason)).toEqual(["endpoint-external"]);
  });

  it("skips one whose file is not in the repository", async () => {
    await skipped("pydantic_core#SchemaValidator");
  });

  it("skips one anchored at a whole file that is not there, a directory or a pattern", async () => {
    await skipped("src/browser.ts");
    await skipped("src");
    await skipped("src/*.ts");
  });
});

/**
 * An external box anchored at a whole file in this repository (#435).
 *
 * httpx's `_urls.py` and `_transports/default.py` were drawn external, and
 * every correct `@needs` arrow touching them went unread. A file is no more a
 * door than a class is, so the box is read as code -- but it may also be an
 * author pointing loosely at the code that talks to the outside thing, so the
 * read may confirm and never accuses.
 */
describe("an external box anchored at a whole file in this repository", () => {
  it("confirms a correct arrow onto it", async () => {
    const board = await boardOf({ ref: "src/user.ts#user" }, { ref: "src/transport.ts", state: "external" });
    const report = checkDrift(board, fakeWorkspace(ts));
    expect(report.unreadEdges).toEqual([]);
    expect(report.edgesChecked).toBe(1);
    expect(report.edges).toEqual([]);
    expect(report.unconfirmedEdges).toEqual([]);
    expect(report.clean).toBe(true);
  });

  it("confirms one from it, when it is the tail", async () => {
    const board = await boardOf({ ref: "src/user.ts", state: "external" }, { ref: "src/transport.ts#BaseTransport" });
    const report = checkDrift(board, fakeWorkspace(ts));
    expect(report.edgesChecked).toBe(1);
    expect(report.edges).toEqual([]);
    expect(report.unconfirmedEdges).toEqual([]);
  });

  it("never calls a wrong arrow onto it wrong, and says the mark is wrong", async () => {
    const board = await boardOf({ ref: "src/client.ts#send" }, { ref: "src/transport.ts", state: "external" });
    const report = checkDrift(board, fakeWorkspace(ts));
    expect(report.unreadEdges).toEqual([]);
    expect(report.edges).toEqual([]);
    expect(report.clean).toBe(true);
    expect(report.unconfirmedEdges.map((arrow) => arrow.reason)).toEqual(["end-marked-external"]);
    expect(report.unconfirmedEdges[0]!.detail).toContain("is marked external, but src/transport.ts is a file in this repository");
  });

  it("does the same in Python and Rust", async () => {
    const py = await boardOf({ ref: "pkg/client.py#send" }, { ref: "pkg/transport.py", state: "external" });
    expect(checkDrift(py, fakeWorkspace(python)).unconfirmedEdges.map((arrow) => arrow.reason))
      .toEqual(["end-marked-external"]);
    const rs = await boardOf({ ref: "src/client.rs#send" }, { ref: "src/transport.rs", state: "external" });
    const report = checkDrift(rs, treeWorkspace(rust));
    expect(report.edges).toEqual([]);
    expect(report.unconfirmedEdges.map((arrow) => arrow.reason)).toEqual(["end-marked-external"]);
  });
});
