/**
 * A number written on a box, checked against the code the box points at (#142).
 *
 * The gap this closes: a ref going stale is reported, and a *label* going stale
 * never was. Change a slab from 2048 to 4096 and the box still saying 2048 is
 * lying, while the ref resolves, the arrows hold and the report is clean --
 * ordinary documentation rot living inside a tool built to prevent it.
 *
 * What makes it checkable, and a scan of the prose not, is that the claim is
 * **declared**. Nothing is inferred out of a sentence, so nothing can be
 * misread out of one: `Token(2)..Token(2050)` sitting beside the claim stays
 * prose and stays unchecked, which is right, because 2050 is the author's own
 * arithmetic and appears in no file.
 *
 * Two things below are load-bearing beyond the happy path:
 *
 * - Numbers are read from the parse, never from the file's text. `src/lib.rs`
 *   says "255 chefs" in a comment above the `ThreadPool::new(255)` that means
 *   it, and a text search cannot tell those apart.
 * - The claim is checked against the narrowest thing the box points at. The
 *   same file writes 2048 five times over, so a file-wide question stays green
 *   after the one number this box is about has changed.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { emptyBoard, type BoardFile } from "../src/engine/board-file";
import { createDiagram } from "../src/engine/diagram";
import { checkDrift, type Workspace } from "../src/engine/drift";
import { readLabelValues, parseValueClaim } from "../src/engine/claim";
import { readGraph } from "../src/engine/graph";
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

/**
 * The shape from the board this came from, cut down.
 *
 * `serve` is the one under test. `warm` exists to hold an unrelated 2048, which
 * is what makes the narrowing testable rather than theoretical: a file-wide
 * question cannot tell the two apart. The comment saying 255 is the other half
 * -- a number in prose is not a number the code uses.
 */
const RUST = [
  "impl Pool {",
  "    /// A kitchen with 255 chefs, which is a comment and not a fact.",
  "    fn serve(&mut self) -> Pool {",
  "        let conns = Slab::new_starting_at(Token(2), 2048);",
  "        let workers = ThreadPool::new(255);",
  "        Pool { conns, workers }",
  "    }",
  "",
  "    fn warm(&mut self) {",
  "        let buffer = Vec::with_capacity(2048);",
  "    }",
  "}",
  "",
].join("\n");

const TYPESCRIPT = [
  "export function serve(): Server {",
  "  const port = 8080;",
  "  const retries = 0x03;",
  "  const label = '2048';",
  "  return listen(port, retries, label);",
  "}",
  "",
].join("\n");

const PYTHON = ["def serve():", "    workers = 2_048", "    return workers", ""].join("\n");

const FILES = {
  "src/lib.rs": RUST,
  "src/serve.ts": TYPESCRIPT,
  "src/serve.py": PYTHON,
  "src/notes.md": "# 2048 is written here, in a language with no reader\n",
};

async function boxed(label: string, ref: string): Promise<BoardFile> {
  const { board } = await createDiagram(emptyBoard(), {
    name: "arch",
    nodes: [{ id: "a", label, ref }],
    edges: [],
  });
  return board;
}

const report = (board: BoardFile, files: Record<string, string> = FILES) =>
  checkDrift(board, fakeWorkspace(files), { edges: true });

const stale = (board: BoardFile, files?: Record<string, string>) =>
  report(board, files).findings.filter((finding) => finding.kind === "stale-number");

beforeAll(async () => {
  await boxed("warm up", "src/lib.rs");
}, 60_000);

describe("reading the claim out of a label", () => {
  it("takes the number and leaves the prose", () => {
    const read = readLabelValues("conns: Slab @cap=2048 full slab = backpressure");
    expect(read.values).toEqual([{ name: "cap", value: 2048, written: "2048" }]);
    // The prose survives intact, including its own `=`, which is why the marker
    // is the `@` and not the `=`.
    expect(read.text).toBe("conns: Slab full slab = backpressure");
  });

  it("takes several, because two numbers on a box are two facts", () => {
    // Unlike two words on an arrow, which is one unanswered question about
    // which was meant. The board this came from has exactly this box.
    const read = readLabelValues("bind Slab @cap=2048 Pool @workers=255");
    expect(read.values.map((one) => one.value)).toEqual([2048, 255]);
    expect(read.text).toBe("bind Slab Pool");
  });

  it("leaves a vocabulary word alone, which is what the = is for", () => {
    /*
     * The measurement that chose this syntax. Sixteen text elements across the
     * seventeen boards in this repository carry an `@` token and every one is a
     * vocabulary word; one of them is a *box* label on the board documenting
     * this feature, reading `what a ref claims · @declared · @used`. Read bare
     * `@word` as a value claim and that box breaks the day this ships.
     */
    const read = readLabelValues("what a ref claims @declared @used");
    expect(read.values).toEqual([]);
    expect(read.garbled).toEqual([]);
    expect(read.text).toBe("what a ref claims @declared @used");
  });

  it("refuses a marked value that is not a number, rather than ignoring it", () => {
    // A claim nothing judges reads exactly like a claim that passed, so a board
    // marking something uncheckable has to be told the turn it is written.
    expect(readLabelValues("@default=utf-8").garbled).toEqual(["default=utf-8"]);
    expect(parseValueClaim("@cap=2048")).toEqual({
      claim: { name: "cap", value: 2048, written: "2048" },
    });
  });

  it("returns a label with no claim in it byte for byte", () => {
    /*
     * The regression this file exists to prevent as much as the feature.
     *
     * A box label wraps -- this is one label with a newline in it -- and an
     * earlier version of the parser split on whitespace and rejoined with
     * single spaces, flattening every label on every board whether it claimed
     * anything or not. Looking for a number in somebody's words must not
     * rewrite them.
     */
    const wrapped = "board server\nHTTP · SSE · watch";
    expect(readLabelValues(wrapped).text).toBe(wrapped);
  });

  it("keeps the rest of the lines when it does take a claim out", () => {
    const label = "conns: Slab<Client>\nSlab @cap=2048 · Pool\nfull slab = backpressure";
    const read = readLabelValues(label);
    expect(read.text).toBe("conns: Slab<Client>\nSlab · Pool\nfull slab = backpressure");
    expect(read.values).toEqual([{ name: "cap", value: 2048, written: "2048" }]);
  });

  it("keeps the claim off the label the report prints", async () => {
    const graph = readGraph(await boxed("Pool @workers=255", "src/lib.rs#serve"));
    expect(graph.nodes[0]!.label).toBe("Pool");
    expect(graph.nodes[0]!.values).toEqual([{ name: "workers", value: 255, written: "255" }]);
  });
});

describe("a number the code still uses", () => {
  it("says nothing, and counts as checked", async () => {
    const found = report(await boxed("Pool @workers=255", "src/lib.rs#serve"));
    expect(found.findings).toEqual([]);
    expect(found.valuesChecked).toBe(1);
    expect(found.valuesUnread).toBe(0);
    expect(found.clean).toBe(true);
  });

  it("matches however the number is spelled", async () => {
    // `2_048` in Python, `0x03` in TypeScript. One value, several spellings,
    // and a claim is about the number rather than about the typing.
    expect(stale(await boxed("@workers=2048", "src/serve.py"))).toEqual([]);
    expect(stale(await boxed("@retries=3", "src/serve.ts#serve"))).toEqual([]);
  });
});

describe("a number the code no longer uses", () => {
  it("is a finding, with the name and the number in the sentence", async () => {
    const found = report(await boxed("Pool @workers=999", "src/lib.rs#serve"));

    expect(found.findings).toHaveLength(1);
    expect(found.findings[0]).toMatchObject({ kind: "stale-number", ref: "src/lib.rs#serve" });
    expect(found.findings[0]!.detail).toContain("workers=999");
    expect(found.findings[0]!.detail).toContain("no longer uses 999");
    // Refutable, so it is allowed to say wrong -- the same standing a stale
    // route has, and for the same reason: the numbers in a file are enumerable.
    expect(found.clean).toBe(false);
  });

  it("is scoped to what the box points at, not to the whole file", async () => {
    /*
     * The case that made the file-wide version worthless. `warm` holds an
     * unrelated 2048, so a box about `serve` claiming 2048 stays green forever
     * on a file-wide question -- which is exactly the motivating scenario,
     * silently missed.
     */
    expect(stale(await boxed("@cap=2048", "src/lib.rs#serve"))).toEqual([]);
    const moved = { ...FILES, "src/lib.rs": RUST.replace("Token(2), 2048", "Token(2), 4096") };
    expect(stale(await boxed("@cap=2048", "src/lib.rs#serve"), moved)).toHaveLength(1);
    // Same edit, same claim, asked of the whole file: `warm`'s 2048 answers for
    // a number that is gone. Weaker on purpose -- a box that points at a file
    // gets the answer it asked for -- and the reason to anchor at a symbol.
    expect(stale(await boxed("@cap=2048", "src/lib.rs"), moved)).toEqual([]);
  });

  it("does not read a number out of a comment", async () => {
    /*
     * The half a text search cannot do, and the reason this reads the parse.
     * `serve`'s doc comment says 255 one line above the `ThreadPool::new(255)`
     * that means it: delete the real one and the claim must fail, comment or no
     * comment.
     */
    const commentOnly = {
      ...FILES,
      "src/lib.rs": RUST.replace("ThreadPool::new(255)", "ThreadPool::new(4)"),
    };
    const found = stale(await boxed("@workers=255", "src/lib.rs#serve"), commentOnly);
    expect(found).toHaveLength(1);
  });

  it("does not read a number out of a string", async () => {
    // `const label = '2048'` is a string, and a number written in one is a
    // mention rather than a number the code uses.
    expect(stale(await boxed("@cap=2048", "src/serve.ts#serve"))).toHaveLength(1);
  });
});

describe("when nobody could look", () => {
  it("counts rather than accusing, in a language with no reader", async () => {
    // Markdown has no grammar here, so "there are no numbers in it" is not a
    // sentence this engine is entitled to say.
    const found = report(await boxed("@cap=2048", "src/notes.md"));
    expect(found.findings.filter((one) => one.kind === "stale-number")).toEqual([]);
    expect(found.valuesUnread).toBe(1);
    expect(found.valuesChecked).toBe(0);
  });

  it("stays quiet when the name is not declared, which is already a finding", async () => {
    // The node check reports the missing symbol on its own. Answering again
    // here would be one mistake reported as two.
    const found = report(await boxed("@cap=2048", "src/lib.rs#gone"));
    expect(found.findings.map((one) => one.kind)).toEqual(["missing-symbol"]);
    expect(found.valuesUnread).toBe(1);
  });
});
