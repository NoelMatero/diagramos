/**
 * A box marked `external` whose ref points at code in this repository is read
 * as code, whatever it is marked (2026-11-24). A class since #366, a whole file
 * since #435, and now a function, a method or a value too -- and a file may be
 * called wrong now, not only confirmed.
 *
 * The history, for the record: a box marked `external` whose ref names a class
 * declared in this repository (#366, section 1).
 *
 * `external` means "real, but not code in this repo": a browser, a database.
 * Its ref, if any, is the routine here that talks to it -- its door (#272). A
 * class is never a door. So an external box anchored at a class declared here
 * is code in this repo that was marked wrongly, and every arrow touching it was
 * skipped as "outside the repo". On the planted bench that was 9 wrong arrows
 * that nothing read: Haiku drew httpx's `BaseTransport` and `ByteStream`
 * external although both are declared in httpx.
 *
 * Such a box is read like a built one, and the report says it is marked
 * wrongly. What stays skipped is what is not code here: no ref, a ref outside
 * the repository, a missing file, a directory, a pattern, and a name the file
 * does not declare.
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
  "src/caller.ts": 'import { plain } from "./plain";\nexport function caller() {\n  return plain();\n}\n',
  "src/limits.ts": "export const LIMIT = 5;\n",
  "src/uses-limit.ts": 'import { LIMIT } from "./limits";\nexport function bounded() {\n  return LIMIT;\n}\n',
  "src/fetcher.ts": "export function get() {\n  return fetch(\"https://example.com\");\n}\n",
  "src/service.ts": "export class Service {\n  run() {\n    return 1;\n  }\n}\n",
  "src/runner.ts": 'import { Service } from "./service";\nexport function runner(s: Service) {\n  return s.run();\n}\n',
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
  "src/transport.rs": "pub struct Transport {\n    pub open: bool,\n}\npub struct Marker;\npub fn plain() -> u32 {\n    1\n}\npub const LIMIT: u32 = 5;\n",
  "src/client.rs": "pub fn send() -> u32 {\n    2\n}\n",
};

/** The same crate with a caller of `plain`, for the confirming direction. */
const rustWithCaller = {
  ...rust,
  "src/lib.rs": "pub mod transport;\npub mod client;\npub mod caller;\n",
  "src/caller.rs": "use crate::transport::plain;\npub fn caller() -> u32 {\n    plain()\n}\n",
};

const python = {
  "pkg/transport.py": "class BaseTransport:\n    def send(self):\n        return 1\n\ndef plain():\n    return 1\n\nLIMIT = 5\n",
  "pkg/client.py": "def send():\n    return 2\n",
  "pkg/caller.py": "from pkg.transport import plain\n\ndef caller():\n    return plain()\n",
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

describe("an external box anchored at a function, a method or a value in this repository", () => {
  it("calls a wrong arrow onto a TypeScript function wrong, and says the mark is wrong", async () => {
    const board = await boardOf({ ref: "src/client.ts#send" }, { ref: "src/plain.ts#plain", state: "external" }, "calls");
    const report = checkDrift(board, fakeWorkspace(ts));
    expect(report.unreadEdges).toEqual([]);
    expect(report.edges.map((finding) => finding.kind)).toEqual(["calls-refuted"]);
    expect(report.edges[0]!.detail).toContain("is marked external, but src/plain.ts#plain is declared in this repository");
  });

  it("confirms a correct arrow onto a TypeScript function", async () => {
    const board = await boardOf({ ref: "src/caller.ts#caller" }, { ref: "src/plain.ts#plain", state: "external" }, "calls");
    const report = checkDrift(board, fakeWorkspace(ts));
    expect(report.unreadEdges).toEqual([]);
    expect(report.edgesChecked).toBe(1);
    expect(report.edges).toEqual([]);
    expect(report.unconfirmedEdges).toEqual([]);
  });

  it("does the same when the function is the tail", async () => {
    const board = await boardOf({ ref: "src/caller.ts#caller", state: "external" }, { ref: "src/client.ts#send" }, "calls");
    const report = checkDrift(board, fakeWorkspace(ts));
    expect(report.edges.map((finding) => finding.kind)).toEqual(["calls-refuted"]);
    expect(report.edges[0]!.detail).toContain("marked external");
  });

  it("reads a method written with its class", async () => {
    const wrong = await boardOf({ ref: "src/client.ts#send" }, { ref: "src/service.ts#Service.run", state: "external" }, "needs");
    expect(checkDrift(wrong, fakeWorkspace(ts)).edges.map((finding) => finding.kind)).toEqual(["needs-absent"]);
    const right = await boardOf({ ref: "src/runner.ts#runner" }, { ref: "src/service.ts#Service.run", state: "external" }, "needs");
    const report = checkDrift(right, fakeWorkspace(ts));
    expect(report.unreadEdges).toEqual([]);
    expect(report.edges).toEqual([]);
  });

  it("reads a TypeScript value", async () => {
    const wrong = await boardOf({ ref: "src/client.ts#send" }, { ref: "src/limits.ts#LIMIT", state: "external" });
    expect(checkDrift(wrong, fakeWorkspace(ts)).edges.map((finding) => finding.kind)).toEqual(["needs-absent"]);
    const right = await boardOf({ ref: "src/uses-limit.ts#bounded" }, { ref: "src/limits.ts#LIMIT", state: "external" });
    const report = checkDrift(right, fakeWorkspace(ts));
    expect(report.unreadEdges).toEqual([]);
    expect(report.edges).toEqual([]);
  });

  it("does the same in Python: a function and a value", async () => {
    const wrong = await boardOf({ ref: "pkg/client.py#send" }, { ref: "pkg/transport.py#plain", state: "external" }, "calls");
    const report = checkDrift(wrong, fakeWorkspace(python));
    expect(report.unreadEdges).toEqual([]);
    expect(report.edges.map((finding) => finding.kind)).toEqual(["calls-refuted"]);
    const right = await boardOf({ ref: "pkg/caller.py#caller" }, { ref: "pkg/transport.py#plain", state: "external" }, "calls");
    expect(checkDrift(right, fakeWorkspace(python)).edges).toEqual([]);
    const value = await boardOf({ ref: "pkg/client.py#send" }, { ref: "pkg/transport.py#LIMIT", state: "external" });
    expect(checkDrift(value, fakeWorkspace(python)).edges.map((finding) => finding.kind)).toEqual(["needs-absent"]);
  });

  it("does the same in Rust: a function, a value and a unit struct", async () => {
    const wrong = await boardOf({ ref: "src/client.rs#send" }, { ref: "src/transport.rs#plain", state: "external" }, "calls");
    const report = checkDrift(wrong, treeWorkspace(rust));
    expect(report.unreadEdges).toEqual([]);
    expect(report.edges.map((finding) => finding.kind)).toEqual(["calls-refuted"]);
    const right = await boardOf({ ref: "src/caller.rs#caller" }, { ref: "src/transport.rs#plain", state: "external" }, "calls");
    expect(checkDrift(right, treeWorkspace(rustWithCaller)).edges).toEqual([]);
    for (const name of ["LIMIT", "Marker"]) {
      const board = await boardOf({ ref: "src/client.rs#send" }, { ref: `src/transport.rs#${name}`, state: "external" });
      expect(checkDrift(board, treeWorkspace(rust)).edges.map((finding) => finding.kind)).toEqual(["needs-absent"]);
    }
  });
});

describe("an external box that still means something outside", () => {
  const skipped = async (ref: string, files: Record<string, string> = ts) => {
    const board = await boardOf({ ref: "src/client.ts#send" }, { ref, state: "external" });
    const report = checkDrift(board, fakeWorkspace(files));
    expect(report.edges).toEqual([]);
    expect(report.unreadEdges.map((entry) => entry.reason)).toEqual(["endpoint-external"]);
  };

  it("skips one whose name the file does not declare", async () => {
    await skipped("src/transport.ts#Elsewhere");
  });

  it("skips one whose name the file only uses, as a door's outside call does", async () => {
    // `fetch` is what the box stands for, not something declared here.
    await skipped("src/fetcher.ts#fetch");
  });

  it("skips one written with an owner the file does not have", async () => {
    await skipped("src/transport.ts#Wallet.send");
  });

  it("skips one whose file is not in the repository", async () => {
    await skipped("pydantic_core#SchemaValidator");
    await skipped("../outside/lib.ts#thing");
  });

  it("skips one anchored at a whole file that is not there, a directory or a pattern", async () => {
    await skipped("src/browser.ts");
    await skipped("src");
    await skipped("src/*.ts");
  });

  it("skips a name Python and Rust files do not declare", async () => {
    const py = await boardOf({ ref: "pkg/client.py#send" }, { ref: "pkg/transport.py#Elsewhere", state: "external" });
    expect(checkDrift(py, fakeWorkspace(python)).unreadEdges.map((entry) => entry.reason)).toEqual(["endpoint-external"]);
    const rs = await boardOf({ ref: "src/client.rs#send" }, { ref: "src/transport.rs#Elsewhere", state: "external" });
    expect(checkDrift(rs, treeWorkspace(rust)).unreadEdges.map((entry) => entry.reason)).toEqual(["endpoint-external"]);
  });
});

/**
 * An external box anchored at a whole file in this repository (#435).
 *
 * httpx's `_urls.py` and `_transports/default.py` were drawn external, and
 * every correct `@needs` arrow touching them went unread. #435 read the file
 * but never accused, in case "Browser" against `src/client.ts` stood for more
 * than the file shows. Since the external mark stopped counting for a ref into
 * the repo, the file is code like any other file ref, and a wrong arrow is red.
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

  it("calls a wrong arrow onto it wrong, and says the mark is wrong", async () => {
    const board = await boardOf({ ref: "src/client.ts#send" }, { ref: "src/transport.ts", state: "external" });
    const report = checkDrift(board, fakeWorkspace(ts));
    expect(report.unreadEdges).toEqual([]);
    expect(report.edges.map((finding) => finding.kind)).toEqual(["needs-absent"]);
    expect(report.edges[0]!.detail).toContain("is marked external, but src/transport.ts is a file in this repository");
    expect(report.clean).toBe(false);
  });

  it("does the same in Python and Rust", async () => {
    const py = await boardOf({ ref: "pkg/client.py#send" }, { ref: "pkg/transport.py", state: "external" });
    expect(checkDrift(py, fakeWorkspace(python)).edges.map((finding) => finding.kind)).toEqual(["needs-absent"]);
    const rs = await boardOf({ ref: "src/client.rs#send" }, { ref: "src/transport.rs", state: "external" });
    expect(checkDrift(rs, treeWorkspace(rust)).edges.map((finding) => finding.kind)).toEqual(["needs-absent"]);
  });
});
