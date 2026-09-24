/**
 * A call through a base class runs whatever overrides it (#353).
 *
 * `send(t: Transport)` calling `t.handle(r)` is the whole point of a base
 * class: when `t` is an `HTTPTransport`, `HTTPTransport.handle` runs. "Go to
 * definition" answers `Transport.handle` all the same, and the check took
 * that as the one place the call runs, so a correct arrow `send ->
 * HTTPTransport` went red.
 *
 * Per language, each shape the call is written in: through a typed
 * parameter, and through a field. And the guard the other way: a base class
 * nothing overrides still has its wrong arrow called wrong.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { emptyBoard, type BoardFile } from "../src/engine/board-file";
import { createDiagram } from "../src/engine/diagram";
import { ACCUSING_EDGE_KINDS, checkDrift, createWorkspace, type DriftReport } from "../src/engine/drift";
import { initEngine } from "../src/engine/parse";
import { refereedCheckLive } from "../src/engine/referee-live";
import { installExcalifontMeasurer } from "./helpers/excalifont";

installExcalifontMeasurer();

beforeAll(async () => { await initEngine(); }, 60_000);

const ACCUSES = new Set<string>(ACCUSING_EDGE_KINDS);

let repo: string;

function write(files: Record<string, string>): void {
  for (const [relative, contents] of Object.entries(files)) {
    const full = path.join(repo, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
}

async function checked(fromRef: string, toRef: string): Promise<DriftReport> {
  const { board } = await createDiagram(emptyBoard(), {
    name: "arch",
    nodes: [
      { id: "caller", label: "send", ref: fromRef },
      { id: "callee", label: "transport", ref: toRef },
    ],
    edges: [{ from: "caller", to: "callee", claim: "calls" }],
  });
  const workspace = createWorkspace(repo);
  const live = await refereedCheckLive(repo, (referee) =>
    checkDrift(board as BoardFile, workspace, { edges: true, ...(referee ? { closedBodyReferee: referee } : {}) }));
  return live.report;
}

const accusations = (report: DriftReport) => report.edges.filter((finding) => ACCUSES.has(finding.kind)).map((finding) => finding.kind);

beforeEach(() => {
  // Outside the worktree: a scratch source file inside one is read by the
  // dependency tests as though it belonged to this repository.
  repo = mkdtempSync(path.join(tmpdir(), "calls-overridden-"));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("Python", () => {
  const FILES = {
    "base.py":
      "class Transport:\n    def handle(self, r):\n        raise NotImplementedError\n\n"
      + "    def send(self, r):\n        return self.handle(r)\n",
    "http.py":
      "from base import Transport\n\n\nclass HTTPTransport(Transport):\n    def handle(self, r):\n        return r\n\n"
      + "    def forward(self, r):\n        return self.send(r)\n",
    "plain.py":
      "class Plain:\n    def handle(self, r):\n        return r\n\n    def run(self, r):\n        return self.handle(r)\n",
    "client.py":
      "from base import Transport\nfrom plain import Plain\n\n\n"
      + "def send(t: Transport, r):\n    return t.handle(r)\n\n\n"
      + "class Client:\n    def __init__(self, t: Transport):\n        self.t: Transport = t\n\n"
      + "    def forward(self, r):\n        return self.t.handle(r)\n\n\n"
      + "def plain(p: Plain, r):\n    return p.handle(r)\n",
    "render.py": "def render(n):\n    return n\n",
  };

  it("leaves the subclass arrow alone through a typed parameter", async () => {
    write(FILES);
    expect(accusations(await checked("client.py#send", "http.py#HTTPTransport"))).toEqual([]);
  }, 120_000);

  it("leaves the subclass arrow alone through a field", async () => {
    write(FILES);
    expect(accusations(await checked("client.py#forward", "http.py#HTTPTransport"))).toEqual([]);
  }, 120_000);

  it("leaves the subclass arrow alone when the base calls its own method on self", async () => {
    write(FILES);
    expect(accusations(await checked("base.py#send", "http.py#HTTPTransport"))).toEqual([]);
  }, 120_000);

  it("leaves the base arrow alone when a subclass calls an inherited method on self", async () => {
    write(FILES);
    // `send` is not declared in HTTPTransport: it runs in base.py.
    expect(accusations(await checked("http.py#forward", "base.py#Transport"))).toEqual([]);
  }, 120_000);

  it("sees an override two classes down, under an import alias", async () => {
    write({
      ...FILES,
      "http.py": "from base import Transport as Base\n\n\nclass HTTPTransport(Base):\n    pass\n",
      "retry.py":
        "from http import HTTPTransport\n\n\nclass Retrying(HTTPTransport):\n    def handle(self, r):\n        return r\n",
    });
    expect(accusations(await checked("client.py#send", "retry.py#Retrying"))).toEqual([]);
  }, 120_000);

  it("still calls a wrong arrow wrong when nothing overrides the method", async () => {
    write(FILES);
    expect(accusations(await checked("client.py#plain", "render.py#render"))).toEqual(["calls-refuted"]);
    expect(accusations(await checked("plain.py#run", "render.py#render"))).toEqual(["calls-refuted"]);
  }, 120_000);
});

describe("TypeScript", () => {
  const FILES = {
    "tsconfig.json": "{ \"compilerOptions\": { \"strict\": true } }\n",
    "base.ts":
      "export class Transport {\n  handle(r: number): number {\n    throw new Error(\"no\");\n  }\n\n"
      + "  send(r: number): number {\n    return this.handle(r);\n  }\n}\n",
    "http.ts":
      "import { Transport } from \"./base\";\n\n"
      + "export class HTTPTransport extends Transport {\n  handle(r: number): number {\n    return r;\n  }\n\n"
      + "  forward(r: number): number {\n    return this.send(r);\n  }\n}\n",
    "plain.ts":
      "export class Plain {\n  handle(r: number): number {\n    return r;\n  }\n\n"
      + "  run(r: number): number {\n    return this.handle(r);\n  }\n}\n",
    "client.ts":
      "import { Transport } from \"./base\";\nimport { Plain } from \"./plain\";\n\n"
      + "export function send(t: Transport, r: number): number {\n  return t.handle(r);\n}\n\n"
      + "export class Client {\n  constructor(private t: Transport) {}\n\n"
      + "  forward(r: number): number {\n    return this.t.handle(r);\n  }\n}\n\n"
      + "export function plain(p: Plain, r: number): number {\n  return p.handle(r);\n}\n",
    "render.ts": "export function render(n: number): number {\n  return n;\n}\n",
  };

  it("leaves the subclass arrow alone through a typed parameter", async () => {
    write(FILES);
    expect(accusations(await checked("client.ts#send", "http.ts#HTTPTransport"))).toEqual([]);
  }, 120_000);

  it("leaves the subclass arrow alone through a field", async () => {
    write(FILES);
    expect(accusations(await checked("client.ts#forward", "http.ts#HTTPTransport"))).toEqual([]);
  }, 120_000);

  it("leaves the subclass arrow alone when the base calls its own method on this", async () => {
    write(FILES);
    expect(accusations(await checked("base.ts#send", "http.ts#HTTPTransport"))).toEqual([]);
  }, 120_000);

  it("leaves the base arrow alone when a subclass calls an inherited method on this", async () => {
    write(FILES);
    expect(accusations(await checked("http.ts#forward", "base.ts#Transport"))).toEqual([]);
  }, 120_000);

  it("sees an override two classes down, under an import alias", async () => {
    write({
      ...FILES,
      "http.ts": "import { Transport as Base } from \"./base\";\n\nexport class HTTPTransport extends Base {}\n",
      "retry.ts":
        "import { HTTPTransport } from \"./http\";\n\n"
        + "export class Retrying extends HTTPTransport {\n  handle(r: number): number {\n    return r;\n  }\n}\n",
    });
    expect(accusations(await checked("client.ts#send", "retry.ts#Retrying"))).toEqual([]);
  }, 120_000);

  it("still calls a wrong arrow wrong when nothing overrides the method", async () => {
    write(FILES);
    expect(accusations(await checked("client.ts#plain", "render.ts#render"))).toEqual(["calls-refuted"]);
    expect(accusations(await checked("plain.ts#run", "render.ts#render"))).toEqual(["calls-refuted"]);
  }, 120_000);
});

describe("Rust", () => {
  const FILES = {
    "Cargo.toml": "[package]\nname = \"fixture\"\nversion = \"0.1.0\"\nedition = \"2021\"\n[workspace]\n",
    "src/lib.rs": "pub mod transport;\npub mod http;\npub mod render;\n",
    "src/transport.rs":
      "pub trait Transport {\n    fn handle(&self, r: u32) -> u32;\n\n"
      + "    fn send(&self, r: u32) -> u32 {\n        self.handle(r)\n    }\n}\n",
    "src/http.rs":
      "use crate::transport::Transport;\n\npub struct Http;\n\n"
      + "impl Transport for Http {\n    fn handle(&self, r: u32) -> u32 {\n        r\n    }\n}\n\n"
      + "impl Http {\n    pub fn get(&self, r: u32) -> u32 {\n        self.twice(r)\n    }\n\n"
      + "    fn twice(&self, r: u32) -> u32 {\n        r * 2\n    }\n}\n",
    "src/render.rs": "pub fn render(n: u32) -> u32 {\n    n\n}\n",
  };

  it("leaves the implementation arrow alone when a trait's default method calls self", async () => {
    write(FILES);
    expect(accusations(await checked("src/transport.rs#send", "src/http.rs#Http"))).toEqual([]);
  }, 180_000);

  it("still calls a wrong arrow wrong inside an impl", async () => {
    write(FILES);
    expect(accusations(await checked("src/http.rs#get", "src/render.rs#render"))).toEqual(["calls-refuted"]);
  }, 180_000);
});
