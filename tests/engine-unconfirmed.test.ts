/**
 * An arrow that claims nothing, and what the check is entitled to say about it.
 *
 * The measurement this exists for: an agent drew a 50-arrow board over a Rust
 * HTTP server and 17 arrows came back amber — 15 of them carrying a descriptive
 * label and no claim at all (`owns`, `populates`, `fills i_buf`), 11 of those
 * pointing at a struct while the body search walks function bodies looking for
 * a call. `claim.ts` admits a word only once something can call it wrong; the
 * converse is what was missing, and this is it: an arrow that asserts nothing
 * checkable is counted, never judged (#133).
 *
 * So there are now three states an arrow can be in, and the tests below are
 * mostly about keeping them apart:
 *
 * - **confirmed** — a channel found the connection. Silent, as always.
 * - **unconfirmed** — read, nothing found either way. A count and a name, with
 *   the reason; never a finding, never an exit code, never a colour.
 * - **unread** — nobody looked (`edgesSkipped`), which is a different silence.
 *
 * A finding is what is left: a claim the code contradicts.
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
 * The shape from the issue, cut down: a struct, an accessor whose only mention
 * of that struct is in its return type, and two functions that touch the same
 * collection without ever calling each other.
 *
 * Every relationship a reader would draw here is real. None of them is a call,
 * and a search through function bodies cannot see one of them.
 */
const RUST = [
  "pub struct Client {",
  "    pub sock: TcpStream,",
  "    pub i_buf: Vec<u8>,",
  "}",
  "",
  "impl Orangutan {",
  "    fn get_client(&mut self, token: Token) -> &mut Client {",
  "        self.conns.get_mut(token).unwrap()",
  "    }",
  "",
  "    fn accept(&mut self) -> TcpStream {",
  "        self.listener.accept().unwrap()",
  "    }",
  "",
  "    fn readable(&mut self, token: Token) {",
  "        let client = self.get_client(token);",
  "        client.i_buf.clear();",
  "    }",
  "}",
  "",
].join("\n");

const FILES = { "src/lib.rs": RUST };

async function arrow(
  from: string,
  to: string,
  edge: { claim?: "needs"; state?: "planned"; label?: string } = {},
): Promise<BoardFile> {
  const { board } = await createDiagram(emptyBoard(), {
    name: "arch",
    nodes: [
      { id: "a", label: "Left", ref: from },
      { id: "b", label: "Right", ref: to },
    ],
    edges: [{ from: "a", to: "b", ...edge }],
  });
  return board;
}

function report(board: BoardFile, files: Record<string, string> = FILES) {
  return checkDrift(board, fakeWorkspace(files), { edges: true });
}

beforeAll(async () => {
  await arrow("src/lib.rs", "src/lib.rs");
}, 60_000);

describe("an arrow whose end names data", () => {
  it("is counted with the reason and the fix, and is not a finding", async () => {
    // `get_client` returns `&mut Client`. The relationship is real, it is in a
    // signature, and no body anywhere names the other end -- which is a fact
    // about where Rust puts types, not about the diagram being wrong.
    const found = report(await arrow("src/lib.rs#get_client", "src/lib.rs#Client"));

    expect(found.edges).toEqual([]);
    expect(found.clean).toBe(true);
    expect(found.unconfirmedEdges).toHaveLength(1);
    expect(found.unconfirmedEdges[0]).toMatchObject({
      from: "a",
      to: "b",
      fromLabel: "Left",
      toLabel: "Right",
      reason: "an-end-is-data",
    });
    // The one reason a reader can act on says how, in the sentence itself.
    expect(found.unconfirmedEdges[0]!.detail).toContain("Client");
    expect(found.unconfirmedEdges[0]!.detail).toContain("file level");
  });

  it("was still read, so it counts as checked and not as skipped", async () => {
    // The distinction the whole report turns on: this is not "nobody looked".
    const found = report(await arrow("src/lib.rs#get_client", "src/lib.rs#Client"));
    expect(found.edgesChecked).toBe(1);
    expect(found.edgesSkipped).toBe(0);
    expect(found.unreadEdges).toEqual([]);
  });

  it("carries the arrow's own label, which is usually the whole relationship", async () => {
    // "owns", "populates", "fills i_buf" -- the part no check reads, and the
    // part a person needs to recognise the arrow they are being told about.
    const found = report(
      await arrow("src/lib.rs#get_client", "src/lib.rs#Client", { label: "owns" }),
    );
    expect(found.unconfirmedEdges[0]!.label).toBe("owns");
  });

  it("is confirmed, not counted, when a body does name the other end", async () => {
    // `readable` calls `get_client`, so this one has evidence behind it and
    // nothing is recorded at all.
    const found = report(await arrow("src/lib.rs#readable", "src/lib.rs#get_client"));
    expect(found.edges).toEqual([]);
    expect(found.unconfirmedEdges).toEqual([]);
    expect(found.edgesChecked).toBe(1);
  });
});

describe("an end naming something the file does not declare at all", () => {
  it("is not called data, because that is a second diagnosis for one mistake", async () => {
    // The missing symbol is the node check's finding and it makes it. The arrow
    // gets the plain reason, so nobody is told to re-anchor an end whose real
    // problem is that the name is gone.
    const found = report(await arrow("src/lib.rs#get_client", "src/lib.rs#Gone"));

    expect(found.findings.map((finding) => finding.kind)).toContain("missing-symbol");
    expect(found.unconfirmedEdges.map((one) => one.reason)).toEqual(["no-call-either-way"]);
  });
});

describe("an arrow between two things that both run", () => {
  it("gets the sharper reason, and still no finding", async () => {
    /*
     * `accept` never touches `get_client` and `get_client` never calls
     * `accept`: both bodies were read, both directions asked, nothing found.
     * That is the most this engine can honestly say, and it is still not
     * evidence of anything -- absence of a call is not absence of a
     * relationship, which is why the arrow is counted rather than accused.
     *
     * The reason word is kept apart from `an-end-is-data` because these two are
     * worth different amounts: this one is a question with an answer.
     */
    const found = report(await arrow("src/lib.rs#accept", "src/lib.rs#get_client"));
    expect(found.edges).toEqual([]);
    expect(found.unconfirmedEdges.map((one) => one.reason)).toEqual(["no-call-either-way"]);
    expect(found.clean).toBe(true);
  });
});

describe("a claim the check could not answer", () => {
  it("is not also reported as an arrow the code does not support", async () => {
    /*
     * The straight contradiction from the issue. A `needs` whose direction was
     * withheld -- here because one end reaches out at runtime -- used to be
     * counted as withheld *and* painted amber by the corroboration channel, so
     * the same board said "I could not check this" and "this looks wrong" about
     * one arrow at the same time.
     *
     * Now it says the first thing only, and the count says so once.
     */
    const files = {
      // `one` reaches out at runtime, so its text is not the whole story and the
      // direction check declines -- the same reason both claimed arrows on the
      // Rust board went unanswered.
      "src/one.ts": 'export const load = (name: string) => import(`./${name}`);\n',
      "src/two.ts": "export const two = 2;\n",
    };
    const found = report(await arrow("src/one.ts", "src/two.ts", { claim: "needs" }), files);

    expect(found.claims.needs).toBe(1);
    expect(found.claims.needsChecked).toBe(0);
    expect(found.claims.needsWithheld).toEqual({ dynamic: 1 });
    expect(found.edges).toEqual([]);
    expect(found.clean).toBe(true);
    expect(found.unconfirmedEdges).toHaveLength(1);
  });

  it("still calls a claim wrong when the code says the opposite", async () => {
    // The half that must survive all of this: a claim with a line of code
    // against it is a finding, and it is the only arrow verdict left that is.
    const files = {
      "src/one.ts": "export const one = 1;\n",
      "src/two.ts": 'import { one } from "./one";\nexport const two = one;\n',
    };
    const found = report(await arrow("src/one.ts", "src/two.ts", { claim: "needs" }), files);

    expect(found.edges.map((finding) => finding.kind)).toEqual(["backwards-edge"]);
    expect(found.clean).toBe(false);
    // Judged, so not also counted as unanswered: one arrow, one verdict.
    expect(found.unconfirmedEdges).toEqual([]);
  });
});

describe("a planned arrow, which is the one place absence still speaks", () => {
  it("stays a work item rather than becoming a count", async () => {
    /*
     * `planned` means "the connection I want", so nothing being there yet is
     * the news the board asked for -- the plan-first flow, working. It is not
     * an accusation and never was, which is why it is the one caller that still
     * uses the old word for absence.
     */
    const found = report(await arrow("src/lib.rs#accept", "src/lib.rs#Client", { state: "planned" }));

    expect(found.edges).toEqual([]);
    expect(found.unconfirmedEdges).toEqual([]);
    expect(found.workItems).toHaveLength(1);
    expect(found.workItems[0]).toMatchObject({ kind: "unsupported-edge", node: "a -> b" });
    expect(found.clean).toBe(true);
  });
});
