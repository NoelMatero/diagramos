/**
 * `@feeds`: the arrow that means "A's output goes into B".
 *
 * The measurement behind it (#127): on the first board an agent drew here
 * unprompted, every arrow that could never be confirmed was this one shape, and
 * the wiring for all four lived in a third function neither endpoint imports.
 *
 * Two halves are tested, and the second matters more than the first. The half
 * that finds a flow is easy to get right; the half that *refuses* to is where a
 * false confirmation would come from, and a false confirmation here is the tool
 * agreeing with a diagram that is wrong. So most of what follows is shapes that
 * look like a flow and are not.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { emptyBoard, type BoardFile } from "../src/engine/board-file";
import { createDiagram } from "../src/engine/diagram";
import { checkDrift, type Workspace } from "../src/engine/drift";
import { checkFeeds } from "../src/engine/feeds";
import { initEngine, type Language } from "../src/engine/parse";
import { installExcalifontMeasurer } from "./helpers/excalifont";

installExcalifontMeasurer();

beforeAll(async () => {
  await initEngine();
}, 60_000);

/** One file, one question: does A's result reach B here? */
function flow(source: string, language: Language = "ts") {
  return checkFeeds(
    { symbols: ["A"] },
    { symbols: ["B"] },
    [{ path: `wiring.${language}`, source, language }],
  );
}

describe("a flow written down where a person can read it", () => {
  it("finds a bound result passed on, and names the line and the binding", () => {
    const found = flow("function wire() {\n  const v = A(1);\n  return B(v);\n}\n");
    expect(found).toEqual({
      verdict: "confirmed",
      evidence: { file: "wiring.ts", line: 3, producer: "A", consumer: "B", through: "v" },
    });
  });

  it("finds a result handed straight over, with no name in between", () => {
    const found = flow("function wire() { return B(A(1)); }");
    expect(found.verdict).toBe("confirmed");
    // No `through`: there was no binding, and inventing a name for one would be
    // evidence that does not exist in the file.
    expect(found.verdict === "confirmed" && found.evidence.through).toBeUndefined();
  });

  it("sees through the wrappers that do not change whose result it is", () => {
    // The exact shape from the issue: `const sibling = await readBoard(...)`.
    expect(flow("async function wire() {\n  const v = await A(1);\n  B(v);\n}\n").verdict)
      .toBe("confirmed");
    expect(flow("fn wire() { let v = A(1)?; B(v); }", "rust").verdict).toBe("confirmed");
  });

  it("reads the wiring wherever the scope reaches, including module level", () => {
    // A binding at the top of the file is visible to every function under it,
    // which is ordinary wiring and not a coincidence of names.
    expect(flow("const v = A(1);\nfunction wire() { B(v); }\n").verdict).toBe("confirmed");
  });

  it("works in every language with a grammar, not just TypeScript", () => {
    expect(flow("fn wire() { let v = A(1); B(v); }", "rust").verdict).toBe("confirmed");
    expect(flow("def wire():\n    v = A(1)\n    B(v)\n", "python").verdict).toBe("confirmed");
    // `self.` is the same object's method, the rule `body.ts` already follows.
    expect(flow("impl T { fn wire(&self) { let v = self.A(1); self.B(v); } }", "rust").verdict)
      .toBe("confirmed");
  });

  it("accepts any of the symbols a box lists, either end", () => {
    const found = checkFeeds(
      { symbols: ["parse", "parseAll"] },
      { symbols: ["render", "renderAll"] },
      [{ path: "w.ts", source: "function wire() { const v = parseAll(1); renderAll(v); }", language: "ts" }],
    );
    expect(found.verdict).toBe("confirmed");
    expect(found.verdict === "confirmed" && found.evidence.producer).toBe("parseAll");
  });
});

describe("what it refuses, which is the half that keeps it honest", () => {
  it("refuses a name bound in one function and passed in another", () => {
    /*
     * The false positive this was designed against. Two functions in a file can
     * each hold `const v = ...`, and joining a binding in the first to a call in
     * the second would confirm an arrow out of two unrelated lines. Valid code
     * cannot mean what that reading claims.
     */
    expect(flow("function one() { const v = A(1); use(v); }\nfunction two() { B(v); }\n").verdict)
      .toBe("absent");
  });

  it("refuses a value used before it was bound", () => {
    expect(flow("function wire() { B(v); const v = A(1); }").verdict).toBe("absent");
  });

  it("refuses anything but the binding itself, passed directly", () => {
    // Each of these is a judgement call about what a value became, and a wrong
    // judgement is the tool contradicting a correct diagram.
    expect(flow("function wire() { const v = A(1); B(v.part); }").verdict).toBe("absent");
    expect(flow("function wire() { const v = A(1); B({ v }); }").verdict).toBe("absent");
    expect(flow("function wire() { const v = A(1); B([v]); }").verdict).toBe("absent");
    expect(flow("function wire() { const v = [A(1)]; B(v); }").verdict).toBe("absent");
    expect(flow("function wire() { const v = wrap(A(1)); B(v); }").verdict).toBe("absent");
  });

  it("refuses somebody else's function of the same name", () => {
    // `other.A()` is not the `A` a box anchors, and following it is how a search
    // starts confirming arrows about libraries.
    expect(flow("function wire() { const v = other.A(1); B(v); }").verdict).toBe("absent");
    expect(flow("fn wire() { let v = Other::A(1); B(v); }", "rust").verdict).toBe("absent");
  });

  it("refuses a name that is only written in a comment or a string", () => {
    expect(flow("function wire() { /* A() */ const v = 'A()'; B(v); }").verdict).toBe("absent");
  });

  it("says nothing at all when there is nowhere to look or nothing to look for", () => {
    expect(checkFeeds({ symbols: [] }, { symbols: ["B"] }, [])).toEqual({
      verdict: "withheld", why: "not-symbols",
    });
    expect(checkFeeds({ symbols: ["A"] }, { symbols: ["B"] }, [])).toEqual({
      verdict: "withheld", why: "nowhere-to-look",
    });
  });
});

describe("a flow that runs the other way", () => {
  it("is reported as what it is, with its evidence", () => {
    // Drawn `B feeds A`, and the file says the opposite. Specific, quotable, and
    // still not a refutation: a forward flow through a callback would have been
    // missed, so absence of one proves nothing.
    const found = checkFeeds(
      { symbols: ["B"] },
      { symbols: ["A"] },
      [{ path: "w.ts", source: "function wire() {\n  const v = A(1);\n  B(v);\n}\n", language: "ts" }],
    );
    expect(found.verdict).toBe("reversed");
    expect(found.verdict === "reversed" && found.evidence).toMatchObject({
      file: "w.ts", line: 3, producer: "A", consumer: "B",
    });
  });

  it("loses to a flow the arrow actually claims, wherever that is", () => {
    // Both directions exist. The claimed one is the answer, and the search says
    // so without the reader having to weigh two verdicts.
    const both = [
      { path: "back.ts", source: "function b() { const v = B(1); A(v); }", language: "ts" as const },
      { path: "fwd.ts", source: "function f() { const v = A(1); B(v); }", language: "ts" as const },
    ];
    const found = checkFeeds({ symbols: ["A"] }, { symbols: ["B"] }, both);
    expect(found.verdict).toBe("confirmed");
    expect(found.verdict === "confirmed" && found.evidence.file).toBe("fwd.ts");
  });
});

/**
 * The whole thing through a report, on a tree the walk can actually walk.
 *
 * `path` here matters: the wiring is in a file **no box points at**, which is
 * the case the word exists for. A board-shaped candidate list would have missed
 * every arrow on the diagram that motivated this.
 */
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

const PIPELINE = {
  "src/read.ts": "export function readBoard(p: string) { return { elements: [] }; }\n",
  "src/graph.ts": "export function readGraph(b: unknown) { return { nodes: [] }; }\n",
  // The wiring, in a file the board never mentions.
  "src/wire.ts":
    'import { readBoard } from "./read";\nimport { readGraph } from "./graph";\n'
    + "export function run(p: string) {\n  const board = readBoard(p);\n  return readGraph(board);\n}\n",
};

async function pipelineBoard(
  claim: "feeds" | "needs" | undefined,
  { reversed = false } = {},
): Promise<BoardFile> {
  const read = { id: "read", label: "read", ref: "src/read.ts#readBoard" };
  const graph = { id: "graph", label: "graph", ref: "src/graph.ts#readGraph" };
  const { board } = await createDiagram(emptyBoard(), {
    name: "pipeline",
    nodes: [read, graph],
    edges: [{
      ...(reversed ? { from: "graph", to: "read" } : { from: "read", to: "graph" }),
      ...(claim ? { claim } : {}),
    }],
  });
  return board;
}

describe("a feeds claim on a real board", () => {
  it("confirms the arrow from wiring in a file no box points at", async () => {
    const report = checkDrift(await pipelineBoard("feeds"), treeWorkspace(PIPELINE), { edges: true });

    expect(report.claims.feeds).toBe(1);
    expect(report.claims.feedsConfirmed).toBe(1);
    expect(report.claims.feedsWithheld).toEqual({});
    // Confirmed is silent, like every other confirmation.
    expect(report.edges).toEqual([]);
    expect(report.unconfirmedEdges).toEqual([]);
    expect(report.edgesChecked).toBe(1);
    expect(report.clean).toBe(true);
  });

  it("is the arrow the same board could not confirm without the word", async () => {
    // The measurement from the issue, in one assertion: no claim, no
    // confirmation -- the flow is in `wire.ts`, and every other channel looks
    // only at the two ends.
    const bare = checkDrift(await pipelineBoard(undefined), treeWorkspace(PIPELINE), { edges: true });
    expect(bare.unconfirmedEdges.map((arrow) => arrow.reason)).toEqual(["no-call-either-way"]);
  });

  it("is a different fact from needs, which the same arrow gets wrong", async () => {
    /*
     * `graph.ts` does not import `read.ts` -- `wire.ts` imports both -- so the
     * dependency direction and the flow direction are simply different
     * questions about one arrow. This is the whole reason the word had to exist
     * rather than `needs` being stretched to cover it.
     */
    const needs = checkDrift(await pipelineBoard("needs"), treeWorkspace(PIPELINE), { edges: true });
    expect(needs.claims.needsWithheld).toEqual({});
    expect(needs.edges).toEqual([]);
    // Nothing declares anything either way, so `needs` has no verdict to give.
    expect(needs.claims.needsChecked).toBe(1);
  });

  it("says which way the flow ran when the arrow is drawn against it", async () => {
    const report = checkDrift(
      await pipelineBoard("feeds", { reversed: true }),
      treeWorkspace(PIPELINE),
      { edges: true },
    );

    expect(report.edges).toEqual([]);
    expect(report.clean).toBe(true);
    expect(report.claims.feedsConfirmed).toBe(0);
    expect(report.claims.feedsWithheld).toEqual({ reversed: 1 });
    expect(report.unconfirmedEdges).toHaveLength(1);
    const [arrow] = report.unconfirmedEdges;
    expect(arrow!.reason).toBe("feeds-runs-the-other-way");
    // The evidence, so a reader can go and look rather than take our word.
    expect(arrow!.detail).toContain("src/wire.ts line 5");
    expect(arrow!.detail).toContain("readBoard");
    expect(arrow!.detail).toContain("not proof");
  });

  it("counts a claim it could not even look at, rather than passing it", async () => {
    // An end anchored at a file has no result, so there is no call to look for.
    const { board } = await createDiagram(emptyBoard(), {
      name: "pipeline",
      nodes: [
        { id: "read", label: "read", ref: "src/read.ts" },
        { id: "graph", label: "graph", ref: "src/graph.ts#readGraph" },
      ],
      edges: [{ from: "read", to: "graph", claim: "feeds" }],
    });
    const report = checkDrift(board, treeWorkspace(PIPELINE), { edges: true });

    expect(report.claims.feeds).toBe(1);
    expect(report.claims.feedsConfirmed).toBe(0);
    expect(report.claims.feedsWithheld).toEqual({ "not-symbols": 1 });
  });

  it("leaves a planned arrow alone until the code lands", async () => {
    // Nothing is graded on a plan, and a plan with a claim is a specification.
    const { board } = await createDiagram(emptyBoard(), {
      name: "pipeline",
      nodes: [
        { id: "read", label: "read", ref: "src/read.ts#readBoard" },
        { id: "graph", label: "graph", ref: "src/graph.ts#readGraph" },
      ],
      edges: [{ from: "read", to: "graph", claim: "feeds", state: "planned" }],
    });
    const report = checkDrift(board, treeWorkspace(PIPELINE), { edges: true });

    expect(report.claims.feeds).toBe(1);
    expect(report.claims.feedsWithheld).toEqual({});
    expect(report.clean).toBe(true);
    // The flow is already there, so the plan has landed: that is a promotion,
    // and the message says the claim is about to be read for the first time.
    expect(report.promotions).toHaveLength(1);
    expect(report.promotions[0]!.detail).toContain("@feeds");
  });
});
