/**
 * The guards on #296's test set.
 *
 * The one that matters is the first: the answer key must not come from the
 * thing it scores. If `bench-oracle.ts`, `bench-tooling.ts` or
 * `bench-shapes.ts` ever import `src/engine`, the benchmark stops measuring
 * the checker against the language tools and starts measuring it against
 * itself, and nothing else would say so.
 *
 * The rest are about the key staying readable: every stored claim has a
 * verdict from the three the oracle can give, every plant names the true
 * claim it was grown from, and the shape readers answer the way a person
 * reading the same source would.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { fieldsOf, signatureOf, splitTop, matchBracket, rustImplBlocks } from "../scripts/lib/bench-shapes";
import type { Sym } from "../scripts/lib/bench-tooling";

const REPO = path.resolve(__dirname, "..");
const BOARDS = path.join(REPO, "bench/boards");

const ORACLE_FILES = [
  "scripts/lib/bench-oracle.ts",
  "scripts/lib/bench-tooling.ts",
  "scripts/lib/bench-shapes.ts",
];

describe("the answer key shares no machinery with the checker", () => {
  for (const file of ORACLE_FILES) {
    it(`${file} imports nothing from src/engine`, () => {
      const source = readFileSync(path.join(REPO, file), "utf8");
      const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]!);
      expect(imports.filter((i) => i.includes("engine"))).toEqual([]);
    });
  }
});

/** A declaration standing in for one the tool would have reported. */
function sym(file: string, source: string, name: string, extra: Partial<Sym> = {}): Sym {
  const nameStart = source.indexOf(name);
  return {
    name, kind: "routine", detail: "test", file,
    start: 0, end: source.length, nameStart, ...extra,
  };
}

describe("the shape readers find the region a claim is read from", () => {
  it("reads a Rust signature's parameters and return type apart", () => {
    const source = "impl Foo {\n    pub fn make(&self, spec: &Spec, count: usize) -> Result<Widget> {\n        todo!()\n    }\n}";
    const file = "/tmp/a.rs";
    writeFixture(file, source);
    const found = signatureOf("rust", sym(file, source, "make"));
    expect(found).toBeDefined();
    expect(found!.params[0]!.receiver).toBe(true);
    expect(source.slice(found!.params[1]!.type!.start, found!.params[1]!.type!.end).trim()).toBe("&Spec");
    expect(source.slice(found!.returns!.start, found!.returns!.end).trim()).toBe("Result<Widget>");
  });

  it("reads a Rust struct's field types, and an enum's payloads", () => {
    const source = "pub struct Held {\n    pub one: Vec<Spec>,\n    two: u32,\n}\npub enum Kind {\n    A(Spec),\n    B { at: usize },\n}";
    const file = "/tmp/b.rs";
    writeFixture(file, source);
    const held = fieldsOf("rust", sym(file, source, "Held", { kind: "type", start: 0, end: source.indexOf("pub enum") }));
    expect(held!.typed.map((s) => source.slice(s.start, s.end).trim())).toEqual(["Vec<Spec>", "u32"]);
    const kind = fieldsOf("rust", sym(file, source, "Kind", {
      kind: "type", start: source.indexOf("pub enum"), end: source.length,
    }));
    expect(kind!.typed.map((s) => source.slice(s.start, s.end).trim())).toEqual(["Spec", "usize"]);
  });

  it("reads a Python class's annotated fields and notices the ones with no type", () => {
    const source = "class Client:\n    timeout: Timeout\n    retries = 3\n\n    def __init__(self, auth: Auth) -> None:\n        self._auth = auth\n";
    const file = "/tmp/c.py";
    writeFixture(file, source);
    const found = fieldsOf("python", sym(file, source, "Client", { kind: "type" }));
    expect(found!.typed.map((s) => source.slice(s.start, s.end).trim())).toEqual(["Timeout"]);
    // `retries = 3` and `self._auth = auth` are both fields with no type written.
    expect(found!.unannotated).toBe(2);
    expect(found!.open).toBe(false);
  });

  it("counts a TypeScript class with a base as open, because a field can come from it", () => {
    const source = "export class Cache extends Subscribable<Listener> {\n  #store: QueryStore\n  constructor(private config: Config) { super() }\n}";
    const file = "/tmp/d.ts";
    writeFixture(file, source);
    const found = fieldsOf("ts", sym(file, source, "Cache", { kind: "type" }));
    expect(found!.typed.map((s) => source.slice(s.start, s.end).trim())).toEqual(["QueryStore", "Config"]);
    expect(found!.open).toBe(true);
  });

  it("finds which type a Rust impl block is for, and the trait it implements", () => {
    const source = "impl fmt::Display for Widget {\n    fn fmt(&self) {}\n}\nimpl Widget {\n    fn new() {}\n}";
    const file = "/tmp/e.rs";
    writeFixture(file, source);
    const blocks = rustImplBlocks(file);
    expect(blocks.map((b) => [b.traitName, b.selfName])).toEqual([["Display", "Widget"], [undefined, "Widget"]]);
  });

  it("splits at top-level commas only, and matches brackets past a generic", () => {
    const text = "(a: Map<K, V>, b: (u8, u8))";
    expect(matchBracket(text, 0)).toBe(text.length);
    expect(splitTop(text, 1, text.length - 1).map((s) => text.slice(s.start, s.end).trim()))
      .toEqual(["a: Map<K, V>", "b: (u8, u8)"]);
  });
});

describe("the stored answer keys", () => {
  const files = existsSync(BOARDS)
    ? readdirSync(BOARDS).flatMap((project) =>
      readdirSync(path.join(BOARDS, project))
        .filter((name) => name.endsWith(".answers.json"))
        .map((name) => path.join(BOARDS, project, name)))
    : [];

  it("exist, one per board", () => {
    const boards = existsSync(BOARDS)
      ? readdirSync(BOARDS).flatMap((project) =>
        readdirSync(path.join(BOARDS, project)).filter((name) => name.endsWith(".excalidraw")))
      : [];
    expect(files.length).toBe(boards.length);
    expect(boards.length).toBeGreaterThanOrEqual(40);
  });

  it("say what the tooling answered, and name the claim each plant came from", () => {
    const ids = new Set<string>();
    for (const file of files) {
      const key = JSON.parse(readFileSync(file, "utf8"));
      for (const claim of key.claims) ids.add(`${key.board}|${claim.id}`);
    }
    for (const file of files) {
      const key = JSON.parse(readFileSync(file, "utf8"));
      expect(key.pin, `${file} records the commit it describes`).toMatch(/^[0-9a-f]{7,40}$/);
      for (const claim of key.claims) {
        expect(["true", "false", "undecidable"]).toContain(claim.truth);
        expect(claim.why.length, `${claim.id} says why`).toBeGreaterThan(0);
        if (claim.source === "drawn" || claim.source === "labelled") continue;
        expect(ids.has(`${key.board}|${claim.parent}`), `${claim.id}'s parent is in the key`).toBe(true);
      }
    }
  });
});

function writeFixture(file: string, source: string) {
  // The shape readers read through `sourceOf`, which caches by path; writing
  // the fixture to disk is what makes a unit test of them honest.
  const fs = require("node:fs") as typeof import("node:fs");
  fs.writeFileSync(file, source);
}

/**
 * The scorer runs each claim on a board of its own -- two boxes, one arrow --
 * so that one arrow's verdict is unambiguous. That is only sound if an arrow
 * alone is judged the way it is judged among its neighbours. It was not, at
 * first: the scorer was dropping each box's `state`, so an arrow into a box
 * the author had marked `external` was scored as though they never had.
 */
describe("an arrow alone is judged as it is on its own board", () => {
  const board = path.join(BOARDS, "anyhow/error-construction.excalidraw");
  const corpus = process.env.CORPUS ?? "/Users/noelmatero/board-ai/.corpus";
  const runnable = existsSync(board) && existsSync(path.join(corpus, "anyhow"));

  it.runIf(runnable)("agrees on every claim the anyhow board draws", async () => {
    const { emptyBoard } = await import("../src/engine/board-file");
    const { createDiagram } = await import("../src/engine/diagram");
    const { checkDrift, createWorkspace } = await import("../src/engine/drift");
    const { initEngine } = await import("../src/engine/parse");
    const { readGraph } = await import("../src/engine/graph");
    await initEngine();
    const workspace = createWorkspace(path.join(corpus, "anyhow"));
    const file = JSON.parse(readFileSync(board, "utf8"));
    const graph = readGraph(file);
    const whole = checkDrift(file, workspace, { edges: true });
    const verdict = (report: ReturnType<typeof checkDrift>, from: string, to: string) => {
      const found = report.edges.find((edge) => edge.node === `${from} -> ${to}`);
      if (found) return found.kind;
      const unconfirmed = report.unconfirmedEdges.find((edge) => edge.from === from && edge.to === to);
      if (unconfirmed) return `unconfirmed:${unconfirmed.reason}`;
      const unread = report.unreadEdges.find((edge) => edge.from === from && edge.to === to);
      return unread ? `unread:${unread.reason}` : "quiet";
    };
    const nodeOf = (id: string) => graph.nodes.find((node) => node.id === id)!;
    for (const edge of graph.edges) {
      const from = nodeOf(edge.from);
      const to = nodeOf(edge.to);
      if (!edge.claim || !from?.ref || !to?.ref) continue;
      const alone = await createDiagram(emptyBoard(), {
        title: "one arrow",
        nodes: [
          { id: "from", label: from.label, ref: from.ref, ...(from.state !== "built" ? { state: from.state } : {}) },
          { id: "to", label: to.label, ref: to.ref, ...(to.state !== "built" ? { state: to.state } : {}) },
        ],
        edges: [{ from: "from", to: "to", claim: edge.claim, ...(edge.label ? { label: edge.label } : {}) }],
      });
      const one = checkDrift(JSON.parse(JSON.stringify(alone.board)), workspace, { edges: true });
      expect(verdict(one, "from", "to"), `@${edge.claim} ${from.ref} -> ${to.ref}`)
        .toBe(verdict(whole, edge.from, edge.to));
    }
  }, 120_000);
});
