/**
 * An arrow between a routine and the file that holds it (#280).
 *
 * The two ends are at different altitudes over the same file, so every
 * file-level channel is about one file twice: a board that also shows any
 * importer of that file confirmed the arrow on nothing.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { emptyBoard, type BoardFile } from "../src/engine/board-file";
import { createDiagram } from "../src/engine/diagram";
import { checkDrift, type Workspace } from "../src/engine/drift";
import { installExcalifontMeasurer } from "./helpers/excalifont";

installExcalifontMeasurer();

function fakeWorkspace(files: Record<string, string>): Workspace {
  return {
    resolve: (relative) => (relative.startsWith("../") ? undefined : relative),
    stat: (target) => (files[target] === undefined ? "missing" : "file"),
    read: (target) => files[target] ?? "",
    list: () => [],
  };
}

/** Directories inferred from the paths: Rust and Python need a walk. */
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
        if (!file.startsWith(prefix)) continue;
        names.add(file.slice(prefix.length).split("/")[0]!);
      }
      return [...names];
    },
  };
}

async function boardWith(
  nodes: Array<{ id: string; label: string; ref?: string }>,
  edges: Array<{ from: string; to: string }>,
): Promise<BoardFile> {
  return (await createDiagram(emptyBoard(), { name: "arch", nodes, edges })).board;
}

beforeAll(async () => {
  await boardWith([{ id: "warmup", label: "Warm up" }], []);
}, 60_000);

const FILES = {
  "src/server.ts": [
    "export const pool = new Array<number>(255);",
    "export function start(): void {",
    "  console.log('up');",
    "}",
  ].join("\n"),
  "src/main.ts": [
    "import { start } from './server';",
    "start();",
  ].join("\n"),
};

/** The routine, the file that holds it, and an importer of that file. */
function shapes(start: string, pool: string, main: string) {
  return [
    { id: "start", label: "start", ref: start },
    { id: "pool", label: "pool: 255 slots", ref: pool },
    { id: "main", label: "entry", ref: main },
  ];
}

function unread(report: ReturnType<typeof checkDrift>) {
  return report.unreadEdges.map((edge) => `${edge.from} -> ${edge.to}: ${edge.reason}`);
}

describe("an arrow from a routine to its own file", () => {
  it("is not confirmed because some other box imports that file", async () => {
    // `start` never touches `pool`. The only thing the board offers is
    // main.ts, which imports server.ts -- and server.ts is both ends.
    const board = await boardWith(
      shapes("src/server.ts#start", "src/server.ts", "src/main.ts"),
      [{ from: "start", to: "pool" }],
    );
    const report = checkDrift(board, fakeWorkspace(FILES));
    expect(report.edges).toEqual([]);
    // Neither counted as read-and-unconfirmed nor as checked: it was a green.
    expect(report.unconfirmedEdges).toEqual([]);
    expect(report.edgesChecked).toBe(0);
    expect(unread(report)).toEqual(["start -> pool: ends-in-one-file"]);
  });

  it("is not confirmed the other way round, from the file to its routine", async () => {
    // The reactor board's `conns -> Client`: the file-level box is the tail.
    const board = await boardWith(
      shapes("src/server.ts#start", "src/server.ts", "src/main.ts"),
      [{ from: "pool", to: "start" }],
    );
    const report = checkDrift(board, fakeWorkspace(FILES));
    // Neither counted as read-and-unconfirmed nor as checked: it was a green.
    expect(report.unconfirmedEdges).toEqual([]);
    expect(report.edgesChecked).toBe(0);
    expect(unread(report)).toEqual(["pool -> start: ends-in-one-file"]);
  });

  it("is not confirmed between two boxes that both anchor the whole file", async () => {
    // `conns` and `tpool` on the orangutan boards: two fields, one file each.
    const board = await boardWith(
      shapes("src/server.ts", "src/server.ts", "src/main.ts"),
      [{ from: "start", to: "pool" }],
    );
    const report = checkDrift(board, fakeWorkspace(FILES));
    // Neither counted as read-and-unconfirmed nor as checked: it was a green.
    expect(report.unconfirmedEdges).toEqual([]);
    expect(report.edgesChecked).toBe(0);
    expect(unread(report)).toEqual(["start -> pool: ends-in-one-file"]);
  });
});

describe("what the one-file rule leaves alone", () => {
  it("still confirms a routine's arrow to a different file that its file imports", async () => {
    // A routine pointing at another module is the deliberate-summary shape on
    // this repo's own boards, and the import is real evidence for it.
    const board = await boardWith(
      shapes("src/main.ts#run", "src/server.ts", "src/other.ts"),
      [{ from: "start", to: "pool" }],
    );
    const report = checkDrift(board, fakeWorkspace({
      ...FILES,
      "src/main.ts": "import { start } from './server';\nexport function run() { start(); }\n",
      "src/other.ts": "export const other = 1;\n",
    }));
    expect(report.unreadEdges).toEqual([]);
    expect(report.unconfirmedEdges).toEqual([]);
    expect(report.edgesChecked).toBe(1);
  });

  it("still reads the bodies when both ends name something in the one file", async () => {
    const board = await boardWith(
      shapes("src/server.ts#start", "src/server.ts#pool", "src/main.ts"),
      [{ from: "start", to: "pool" }],
    );
    const report = checkDrift(board, fakeWorkspace(FILES));
    expect(report.unreadEdges).toEqual([]);
    expect(report.edgesChecked).toBe(1);
    expect(report.unconfirmedEdges.map((edge) => edge.reason)).toEqual(["an-end-is-data"]);
  });

  it("does not advise moving a data end to the file the other end is already in", async () => {
    // That advice is how the orangutan boxes got their file anchors, and taking
    // it here lands the arrow in the rule above: nothing left to check.
    const board = await boardWith(
      shapes("src/server.ts#start", "src/server.ts#pool", "src/main.ts"),
      [{ from: "start", to: "pool" }],
    );
    const [data] = checkDrift(board, fakeWorkspace(FILES)).unconfirmedEdges;
    expect(data!.detail).not.toContain("file level");
    expect(data!.detail).toContain("src/server.ts");
  });

  it("does not tell a plan in this shape that the code already built it", async () => {
    const board = (await createDiagram(emptyBoard(), {
      name: "arch",
      nodes: shapes("src/server.ts#start", "src/server.ts", "src/main.ts"),
      edges: [{ from: "start", to: "pool", state: "planned" }],
    })).board;
    const report = checkDrift(board, fakeWorkspace(FILES));
    expect(report.promotions).toEqual([]);
    expect(unread(report)).toEqual(["start -> pool: ends-in-one-file"]);
  });
});

/**
 * The same shape in the two other languages with a licence. The shared-importer
 * channel is not language-specific, so neither is the green it gave.
 */
describe("an arrow from a routine to its own file, in Rust and Python", () => {
  it("is not confirmed in Rust because the crate root declares the module", async () => {
    // The orangutan shape: a field box anchored at the file, the routine that
    // never touches it, and a box for the file that declares the module.
    const files = {
      "Cargo.toml": '[package]\nname = "demo"\nedition = "2021"\n',
      "src/lib.rs": "pub mod server;\n",
      "src/server.rs": [
        "pub struct Server { pub conns: Vec<u8> }",
        "impl Server {",
        "    pub fn start(&self) {}",
        "}",
      ].join("\n"),
    };
    const board = await boardWith(
      shapes("src/server.rs#start", "src/server.rs", "src/lib.rs"),
      [{ from: "start", to: "pool" }],
    );
    const report = checkDrift(board, treeWorkspace(files), { edges: true });
    // Neither counted as read-and-unconfirmed nor as checked: it was a green.
    expect(report.unconfirmedEdges).toEqual([]);
    expect(report.edgesChecked).toBe(0);
    expect(unread(report)).toEqual(["start -> pool: ends-in-one-file"]);
  });

  it("is not confirmed in Python because another module imports it", async () => {
    const files = {
      "pkg/__init__.py": "",
      "pkg/server.py": "POOL = [0] * 255\n\ndef start():\n    print('up')\n",
      "pkg/main.py": "from pkg.server import start\n\nstart()\n",
    };
    const board = await boardWith(
      shapes("pkg/server.py#start", "pkg/server.py", "pkg/main.py"),
      [{ from: "start", to: "pool" }],
    );
    const report = checkDrift(board, treeWorkspace(files), { edges: true });
    // Neither counted as read-and-unconfirmed nor as checked: it was a green.
    expect(report.unconfirmedEdges).toEqual([]);
    expect(report.edgesChecked).toBe(0);
    expect(unread(report)).toEqual(["start -> pool: ends-in-one-file"]);
  });
});

describe("two named ends in one file with no body to read", () => {
  it("is not confirmed because some other box imports that file either", async () => {
    // Not an altitude: both ends name something. The same one-file question
    // reached the same channels, and got the same green.
    const files = {
      "src/api.ts": "export declare function open(): void;\nexport declare function close(): void;\n",
      "src/main.ts": "import { open } from './api';\nopen();\n",
    };
    const board = await boardWith(
      shapes("src/api.ts#open", "src/api.ts#close", "src/main.ts"),
      [{ from: "start", to: "pool" }],
    );
    const report = checkDrift(board, fakeWorkspace(files));
    expect({ checked: report.edgesChecked, unread: unread(report), unconfirmed: report.unconfirmedEdges.length })
      .toEqual({ checked: 0, unread: ["start -> pool: no-function-body"], unconfirmed: 0 });
  });
});
