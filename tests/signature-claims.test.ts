/**
 * `@takes` and `@returns` as they reach a report (#169).
 *
 * `engine-signature.test.ts` covers the reader. What is covered here is the half
 * that decides what anybody is told: which answer becomes a red finding, which
 * becomes a note, which becomes silence, and whether a claim nobody could check
 * is distinguishable in the report from a claim that passed.
 *
 * The board these words exist for is `struct Request -> handler(&Request)`. It is
 * the ordinary shape of a typed diagram, neither `needs` nor `feeds` is true of
 * it, and until now an author could not state it at all -- so the engine
 * confirmed the relationship silently and nothing could ever be wrong.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { emptyBoard, type BoardFile } from "../src/engine/board-file";
import { createDiagram } from "../src/engine/diagram";
import { checkDrift, type Workspace } from "../src/engine/drift";
import { initEngine } from "../src/engine/parse";
import { installExcalifontMeasurer } from "./helpers/excalifont";

installExcalifontMeasurer();

beforeAll(async () => { await initEngine(); }, 60_000);

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

/**
 * A type box and a function box, with the arrow drawn type -> function.
 *
 * That direction is the point: it is how an agent draws dataflow, and the claim
 * reads "the head's signature names the tail's type".
 */
async function boardOf(
  typeRef: string,
  functionRef: string,
  edge: { claim?: "takes" | "returns"; state?: "planned" } = {},
): Promise<BoardFile> {
  const { board } = await createDiagram(emptyBoard(), {
    name: "arch",
    nodes: [
      { id: "type", label: "Request", ref: typeRef },
      { id: "fn", label: "handler", ref: functionRef },
    ],
    edges: [{ from: "type", to: "fn", ...edge }],
  });
  return board;
}

const HANDLER = "fn user_handler(request: &Request) -> Response { todo!() }\n";
const REQUEST = "pub struct Request { pub uri: String }\n";

const files = (handler = HANDLER) => ({
  "src/main.rs": handler,
  "src/request.rs": REQUEST,
});

describe("@takes on the arrow the words exist for", () => {
  it("confirms it, and counts the claim as held", async () => {
    const board = await boardOf("src/request.rs#Request", "src/main.rs#user_handler", { claim: "takes" });
    const report = checkDrift(board, fakeWorkspace(files()), { edges: true });

    expect(report.clean).toBe(true);
    expect(report.edges).toEqual([]);
    expect(report.claims.takes).toBe(1);
    expect(report.claims.signatureConfirmed).toBe(1);
    // Nothing withheld: the question was asked and answered.
    expect(report.claims.signatureWithheld).toEqual({});
  });

  it("reports it in red when the signature does not name the type", async () => {
    const board = await boardOf("src/request.rs#Request", "src/main.rs#user_handler", { claim: "takes" });
    const changed = files("fn user_handler(id: usize) -> Response { todo!() }\n");
    const report = checkDrift(board, fakeWorkspace(changed), { edges: true });

    expect(report.clean).toBe(false);
    expect(report.edges).toHaveLength(1);
    expect(report.edges[0].kind).toBe("signature-absent");
    // The evidence, quoted. A refutable verdict has to show what it read.
    expect(report.edges[0].detail).toContain("(id: usize) -> Response");
    expect(report.edges[0].detail).toContain("does not name it");
    expect(report.claims.signatureConfirmed).toBe(0);
  });
});

describe("@returns", () => {
  it("confirms a type in the return position", async () => {
    const board = await boardOf("src/request.rs#Response", "src/main.rs#user_handler", { claim: "returns" });
    const report = checkDrift(board, fakeWorkspace(files()), { edges: true });
    expect(report.claims.returns).toBe(1);
    expect(report.claims.signatureConfirmed).toBe(1);
    expect(report.edges).toEqual([]);
  });

  /*
   * The whole reason there are two words. With one word covering the signature,
   * this arrow would pass -- and an arrow that passes either way round carries
   * no information about direction, which is what a dataflow diagram is for.
   */
  it("does not confirm a parameter type, and says which side it is on", async () => {
    const board = await boardOf("src/request.rs#Request", "src/main.rs#user_handler", { claim: "returns" });
    const report = checkDrift(board, fakeWorkspace(files()), { edges: true });

    // Not a finding. The relationship is real; the position is wrong.
    expect(report.edges).toEqual([]);
    expect(report.clean).toBe(true);
    const note = report.unconfirmedEdges.find((arrow) => arrow.reason === "signature-other-half");
    expect(note).toBeDefined();
    expect(note?.detail).toContain("the other side");
    expect(note?.detail).toContain("@takes");
    expect(report.claims.signatureWithheld.misplaced).toBe(1);
  });
});

/**
 * The half that protects the tool's reputation.
 *
 * A wrong red here is the tool telling somebody their correct diagram is wrong,
 * and no later correctness buys that back. Each of these boards is right and
 * each signature is fully enumerable without containing the type.
 */
describe("refuses rather than accusing", () => {
  it("stays silent when the type is written under an alias", async () => {
    const board = await boardOf("src/request.rs#Request", "src/main.rs#user_handler", { claim: "takes" });
    const aliased = files("type Req = Request;\nfn user_handler(request: &Req) -> Response { todo!() }\n");
    const report = checkDrift(board, fakeWorkspace(aliased), { edges: true });

    expect(report.edges).toEqual([]);
    expect(report.clean).toBe(true);
    // Counted, not swallowed: a claim nobody could check must be
    // distinguishable in the report from a claim that passed.
    expect(report.claims.signatureWithheld.aliased).toBe(1);
    expect(report.claims.signatureConfirmed).toBe(0);
  });

  it("stays silent when the import was renamed on the way in", async () => {
    const board = await boardOf("src/request.rs#Request", "src/main.rs#user_handler", { claim: "takes" });
    const renamed = files("use crate::request::Request as Req;\nfn user_handler(r: &Req) -> Response { todo!() }\n");
    const report = checkDrift(board, fakeWorkspace(renamed), { edges: true });
    expect(report.edges).toEqual([]);
    expect(report.claims.signatureWithheld.aliased).toBe(1);
  });

  it("will not accuse a plan of a signature that does not exist yet", async () => {
    // Sketching a signature before writing it is the entire point of a plan, and
    // a red finding about one would be a lie about it -- the same rule `needs`
    // follows.
    const board = await boardOf(
      "src/request.rs#Request", "src/main.rs#user_handler",
      { claim: "takes", state: "planned" },
    );
    const changed = files("fn user_handler(id: usize) -> Response { todo!() }\n");
    const report = checkDrift(board, fakeWorkspace(changed), { edges: true });

    expect(report.edges.filter((edge) => edge.kind === "signature-absent")).toEqual([]);
    expect(report.clean).toBe(true);
  });

  it("still confirms a plan whose signature has landed", async () => {
    const board = await boardOf(
      "src/request.rs#Request", "src/main.rs#user_handler",
      { claim: "takes", state: "planned" },
    );
    const report = checkDrift(board, fakeWorkspace(files()), { edges: true });
    expect(report.edges.filter((edge) => edge.kind === "signature-absent")).toEqual([]);
  });

  it("says nothing at all about an arrow carrying no claim", async () => {
    const board = await boardOf("src/request.rs#Request", "src/main.rs#user_handler");
    const changed = files("fn user_handler(id: usize) -> Response { todo!() }\n");
    const report = checkDrift(board, fakeWorkspace(changed), { edges: true });

    expect(report.edges.filter((edge) => edge.kind === "signature-absent")).toEqual([]);
    expect(report.claims.takes).toBe(0);
    expect(report.claims.signatureWithheld).toEqual({});
  });

  /*
   * The one that shipped (#195). `unit_path` takes a `FileSlice` -- it says so
   * in its own parameter list -- and the reader read the annotation as a piece
   * of text, saw no names in it, and told the author their diagram was wrong.
   * Python is not a corner of this engine: 49 of graphify's 82 files write an
   * annotation this way, because it is how a forward reference and a
   * `TYPE_CHECKING`-only import have to be written.
   */
  it("confirms a Python parameter whose type is written inside a string", async () => {
    const board = await boardOf(
      "graphify/file_slice.py#FileSlice", "graphify/file_slice.py#unit_path",
      { claim: "takes" },
    );
    const report = checkDrift(board, fakeWorkspace({
      "graphify/file_slice.py": [
        "class FileSlice:",
        "    pass",
        "",
        'def unit_path(unit: "Path | FileSlice") -> Path:',
        "    return unit",
        "",
      ].join("\n"),
    }), { edges: true });

    expect(report.edges.filter((edge) => edge.kind === "signature-absent")).toEqual([]);
    expect(report.clean).toBe(true);
    expect(report.claims.signatureConfirmed).toBe(1);
  });

  it("stays silent rather than refuting a quoted annotation it cannot read", async () => {
    const board = await boardOf(
      "graphify/file_slice.py#Database", "graphify/file_slice.py#unit_path",
      { claim: "takes" },
    );
    const report = checkDrift(board, fakeWorkspace({
      "graphify/file_slice.py": [
        "class Database:",
        "    pass",
        "",
        'def unit_path(unit: "Path | FileSlice") -> Path:',
        "    return unit",
        "",
      ].join("\n"),
    }), { edges: true });

    expect(report.edges.filter((edge) => edge.kind === "signature-absent")).toEqual([]);
    expect(report.clean).toBe(true);
    expect(report.claims.signatureWithheld["quoted-annotation"]).toBe(1);
  });

  it("declines when the function end anchors a file rather than a name", async () => {
    // A bare path is a file, and a file has no signature. The node check already
    // says what a bare path is; this only refuses to guess.
    const board = await boardOf("src/request.rs#Request", "src/main.rs", { claim: "takes" });
    const report = checkDrift(board, fakeWorkspace(files()), { edges: true });
    expect(report.edges.filter((edge) => edge.kind === "signature-absent")).toEqual([]);
    expect(report.claims.signatureWithheld["endpoint-has-no-ref"]).toBe(1);
  });
});

describe("the vocabulary", () => {
  it("carries both new words, so an older reader can tell it is behind", async () => {
    const board = await boardOf("src/request.rs#Request", "src/main.rs#user_handler", { claim: "takes" });
    const report = checkDrift(board, fakeWorkspace(files()), { edges: true });
    expect(report.vocabulary).toContain("signature-absent");
  });

  it("refuses a word that is not one of the four", async () => {
    const board = await boardOf("src/request.rs#Request", "src/main.rs#user_handler");
    // Written straight onto the arrow's customData, the way a hand edit would.
    const edited: BoardFile = {
      ...board,
      elements: board.elements.map((element) => {
        const custom = element.customData as { edge?: { from?: string } } | undefined;
        if (!custom?.edge) return element;
        return { ...element, customData: { ...custom, edge: { ...custom.edge, claim: "consumes" } } };
      }),
    };
    const report = checkDrift(edited, fakeWorkspace(files()), { edges: true });
    expect(report.garbledClaims).toHaveLength(1);
    expect(report.garbledClaims[0].written).toBe("consumes");
    // The refusal names the whole vocabulary, so an author sees the two new words.
    expect(report.garbledClaims[0].detail).toContain("takes");
    expect(report.garbledClaims[0].detail).toContain("returns");
  });
});
