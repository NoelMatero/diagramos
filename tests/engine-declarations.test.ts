/**
 * A relationship the code states in a declaration, which the body search
 * cannot see (#144).
 *
 * The measurement this exists for: on the Rust board, 17 of 39 arrows came back
 * read-and-not-confirmed, and 5 of those had their evidence one line outside
 * where the search looked -- in a return type, in a parameter type, in a
 * field's own type, or in the `impl` header above the method. Every one of
 * those lines is already parsed. Nothing read them.
 *
 * So the search now reads a declaration without its body when, and only when,
 * one end of the arrow names data. The gate matters as much as the search: for
 * two functions, "nothing calls the other" is a real answer and the sharpest
 * thing this engine says, and a shared parameter type is not allowed to blunt
 * it. Where one end holds no code there is nothing sharp to lose -- the
 * alternative reading is not "these are unrelated", it is "we read the wrong
 * lines".
 *
 * Confirm-only throughout, like every other channel: finding the name proves
 * the two are related, and not finding it proves nothing at all.
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

/**
 * The three shapes from the issue, in the language it was measured in.
 *
 * `get_client` names `Client` only in its return type. `receive` names it only
 * by sitting in `impl Client`. `conns` names it only in its own field type.
 * `accept` does not name it at all, and the doc comment above it is there to
 * stay uncounted: a name in prose is a mention, not a use.
 */
const RUST = [
  "pub struct Client {",
  "    pub sock: TcpStream,",
  "}",
  "",
  "pub struct Orangutan {",
  "    conns: Slab<Client>,",
  "}",
  "",
  "impl Client {",
  "    fn receive(&mut self) -> bool {",
  "        self.sock.read()",
  "    }",
  "}",
  "",
  "impl Orangutan {",
  "    fn get_client(&mut self, token: Token) -> &mut Client {",
  "        self.conns.get_mut(token).unwrap()",
  "    }",
  "",
  "    /// Hands back a socket, never a Client.",
  "    fn accept(&mut self) -> TcpStream {",
  "        self.listener.accept().unwrap()",
  "    }",
  "}",
  "",
].join("\n");

/**
 * The same three shapes where a language writes them differently.
 *
 * A TypeScript class holds its methods, so the body search already answers the
 * membership question there -- what it cannot answer is the type in a
 * signature or on a field, which is the half that generalises. `render` and
 * `plain` are the gate: two functions, one naming the other outside its body,
 * and no confirmation allowed.
 */
const TYPESCRIPT = [
  "export interface Client {",
  "  sock: Socket;",
  "}",
  "",
  "export class Pool {",
  "  conns: Slab<Client>;",
  "}",
  "",
  "export function getClient(token: Token): Client {",
  "  return lookup(token);",
  "}",
  "",
  "export function accept(): Socket {",
  "  return listen();",
  "}",
  "",
  "export function plain(text: string): string {",
  "  return text;",
  "}",
  "",
  "export function render(text: string, format = plain): string {",
  "  return format(text);",
  "}",
  "",
].join("\n");

/** A module-level annotation, which is where Python writes the same fact. */
const PYTHON = [
  "class Client:",
  "    def receive(self):",
  "        return self.sock.read()",
  "",
  "",
  "conns: Slab[Client] = Slab()",
  "",
].join("\n");

const FILES = {
  "src/lib.rs": RUST,
  "src/pool.ts": TYPESCRIPT,
  "src/pool.py": PYTHON,
};

async function arrow(from: string, to: string, label?: string): Promise<BoardFile> {
  const { board } = await createDiagram(emptyBoard(), {
    name: "arch",
    nodes: [
      { id: "a", label: "Left", ref: from },
      { id: "b", label: "Right", ref: to },
    ],
    edges: [{ from: "a", to: "b", ...(label ? { label } : {}) }],
  });
  return board;
}

const report = (board: BoardFile) => checkDrift(board, fakeWorkspace(FILES), { edges: true });

beforeAll(async () => {
  await arrow("src/lib.rs", "src/lib.rs");
}, 60_000);

describe("a relationship written in a signature", () => {
  it("is confirmed from the return type", async () => {
    // `fn get_client(&mut self, token: Token) -> &mut Client`. The body names
    // `conns` and `get_mut` and never `Client`, so this is the declaration
    // being read and nothing else.
    const found = report(await arrow("src/lib.rs#get_client", "src/lib.rs#Client", "owns"));

    expect(found.unconfirmedEdges).toEqual([]);
    expect(found.edgesChecked).toBe(1);
    expect(found.edgesSkipped).toBe(0);
    expect(found.clean).toBe(true);
  });

  it("is confirmed the other way round too, because an arrow is not a caller", async () => {
    // The evidence sits in the tail's declaration either way. Direction on a
    // board is a reading of the design, not a claim about who calls whom.
    const found = report(await arrow("src/lib.rs#Client", "src/lib.rs#get_client"));
    expect(found.unconfirmedEdges).toEqual([]);
    expect(found.edgesChecked).toBe(1);
  });

  it("reads a parameter type as well as a returned one", async () => {
    const found = report(await arrow("src/pool.ts#getClient", "src/pool.ts#Client"));
    expect(found.unconfirmedEdges).toEqual([]);
    expect(found.edgesChecked).toBe(1);
  });
});

describe("a relationship written in the block above a method", () => {
  it("is confirmed from the enclosing impl", async () => {
    /*
     * `Client::receive` is a method *on* the struct the arrow points at, and
     * Rust writes that membership in the line above the function rather than
     * anywhere inside it -- the struct's own field list does not name the
     * method either. Three of the five arrows this fixed were this shape.
     */
    const found = report(await arrow("src/lib.rs#receive", "src/lib.rs#Client", "fills i_buf"));

    expect(found.unconfirmedEdges).toEqual([]);
    expect(found.edgesChecked).toBe(1);
    expect(found.clean).toBe(true);
  });
});

describe("a box anchored at the field itself", () => {
  it("is confirmed from the field's own type", async () => {
    /*
     * The case that made the issue unarguable. The declaration reads, in full,
     * `conns: Slab<Client>,`: the ref is right, both ends are anchored exactly
     * where they should be, the evidence is one line long, and the answer used
     * to be "not confirmed".
     */
    const found = report(await arrow("src/lib.rs#conns", "src/lib.rs#Client", "owns"));

    expect(found.edges).toEqual([]);
    expect(found.unconfirmedEdges).toEqual([]);
    expect(found.clean).toBe(true);
  });

  it("reads the same shape on a class field", async () => {
    const found = report(await arrow("src/pool.ts#conns", "src/pool.ts#Client"));
    expect(found.unconfirmedEdges).toEqual([]);
  });

  it("reads the same shape on an annotated Python name", async () => {
    // No per-language code went in for any of these. A declaration is a node
    // with a name, a body is a field, and a type annotation is neither.
    const found = report(await arrow("src/pool.py#conns", "src/pool.py#Client"));
    expect(found.unconfirmedEdges).toEqual([]);
  });
});

describe("the gate, which is what keeps the sharper answer sharp", () => {
  it("stays shut between two things that both run", async () => {
    /*
     * `render(text, format = plain)` names `plain` in its parameter list, which
     * is outside its body and would be read if the declarations were searched
     * unconditionally. Both ends run, so they are not: "nothing calls the
     * other" is a question with an answer, and it keeps it.
     */
    const found = report(await arrow("src/pool.ts#render", "src/pool.ts#plain"));

    expect(found.unconfirmedEdges.map((one) => one.reason)).toEqual(["no-call-either-way"]);
    expect(found.clean).toBe(true);
  });

  it("still counts an arrow whose declarations are silent too", async () => {
    /*
     * `accept` returns a `TcpStream` and names `Client` only in a doc comment,
     * which is prose rather than a token. Nothing found in a body, nothing
     * found in a declaration: counted, named, and still not a finding.
     */
    const found = report(await arrow("src/lib.rs#accept", "src/lib.rs#Client"));

    expect(found.edges).toEqual([]);
    expect(found.unconfirmedEdges.map((one) => one.reason)).toEqual(["an-end-is-data"]);
    expect(found.clean).toBe(true);
  });

  it("tells the reader the declarations were read, not just the bodies", async () => {
    // The sentence used to promise that a signature, a field and an enclosing
    // impl were all invisible. Saying that now would be false.
    const found = report(await arrow("src/lib.rs#accept", "src/lib.rs#Client"));
    expect(found.unconfirmedEdges[0]!.detail).toContain("declarations were read");
  });
});
