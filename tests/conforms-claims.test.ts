/**
 * `@conforms` as it reaches a report (#216).
 *
 * `engine-conforms.test.ts` covers the reader. What is covered here is the half
 * that decides what anybody is told: which answer becomes a red, which becomes
 * silence, and whether a claim nobody could check is distinguishable in the
 * report from a claim that passed.
 *
 * The arrow this word exists for is the one drawn the wrong way round. Before
 * it, `Base -> Handler` and `Handler -> Base` were the same arrow to this tool:
 * inheritance brings an import with it, the corroboration search found the
 * import, and both passed. So the first test here is the backwards one.
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
 * Two type boxes, with the arrow drawn subtype -> supertype.
 *
 * Subject first, the way `holds` and `builds` are drawn, and the way every class
 * diagram has drawn a generalisation for thirty years.
 */
async function boardOf(
  fromRef: string,
  toRef: string,
  edge: { claim?: "conforms"; state?: "planned" } = {},
  labels: { from?: string; to?: string } = {},
): Promise<BoardFile> {
  const { board } = await createDiagram(emptyBoard(), {
    name: "arch",
    nodes: [
      { id: "subtype", label: labels.from ?? "Handler", ref: fromRef },
      { id: "supertype", label: labels.to ?? "Base", ref: toRef },
    ],
    edges: [{ from: "subtype", to: "supertype", ...edge }],
  });
  return board;
}

/** A base in one file and a subclass in another, importing it. The ordinary shape. */
const PYTHON = {
  "src/base.py": "class Base:\n    def handle(self):\n        pass\n",
  "src/handler.py": "from .base import Base\n\n\nclass Handler(Base):\n    def handle(self):\n        pass\n",
};

describe("@conforms drawn the way round the code has it", () => {
  it("confirms it, and counts the claim as held", async () => {
    const board = await boardOf("src/handler.py#Handler", "src/base.py#Base", { claim: "conforms" });
    const report = checkDrift(board, fakeWorkspace(PYTHON), { edges: true });

    expect(report.claims.conforms).toBe(1);
    expect(report.claims.conformsConfirmed).toBe(1);
    expect(report.clean).toBe(true);
  });

  it("confirms an interface extending an interface", async () => {
    const files = {
      "src/base.ts": "export interface Base { id: string }\n",
      "src/props.ts": "import type { Base } from './base';\nexport interface Props extends Base { n: number }\n",
    };
    const board = await boardOf("src/props.ts#Props", "src/base.ts#Base", { claim: "conforms" });
    const report = checkDrift(board, fakeWorkspace(files), { edges: true });

    expect(report.claims.conformsConfirmed).toBe(1);
    expect(report.clean).toBe(true);
  });
});

describe("@conforms drawn from the base down to the subclass", () => {
  it("calls it wrong, and says it is the right fact backwards", async () => {
    /*
     * The whole point of the word. `Base -> Handler` and `Handler -> Base` were
     * indistinguishable to this tool: inheritance brings an import with it, the
     * corroboration search found the import, and the wrong one passed.
     */
    const board = await boardOf(
      "src/base.py#Base", "src/handler.py#Handler", { claim: "conforms" },
      { from: "Base", to: "Handler" },
    );
    const report = checkDrift(board, fakeWorkspace(PYTHON), { edges: true });

    expect(report.clean).toBe(false);
    const finding = report.edges.find((one) => one.kind === "conforms-absent");
    expect(finding).toBeDefined();
    // The fix, in the row: turn it round. Not "go and look for a missing base".
    expect(finding?.detail).toContain("backwards");
    expect(finding?.detail).toContain("Handler is one of Base");
  });

  it("says what the declaration does name, when the arrow is simply wrong", async () => {
    const files = {
      ...PYTHON,
      "src/other.py": "class Other:\n    pass\n",
    };
    const board = await boardOf(
      "src/handler.py#Handler", "src/other.py#Other", { claim: "conforms" },
      { from: "Handler", to: "Other" },
    );
    const report = checkDrift(board, fakeWorkspace(files), { edges: true });

    const finding = report.edges.find((one) => one.kind === "conforms-absent");
    expect(finding).toBeDefined();
    // What it read, so nobody has to take the verdict on trust.
    expect(finding?.detail).toContain("(Base)");
    expect(finding?.detail).not.toContain("backwards");
  });

  it("calls a class that declares no base at all wrong, and says so plainly", async () => {
    const files = {
      "src/base.py": "class Base:\n    pass\n",
      "src/handler.py": "class Handler:\n    pass\n",
    };
    const board = await boardOf("src/handler.py#Handler", "src/base.py#Base", { claim: "conforms" });
    const report = checkDrift(board, fakeWorkspace(files), { edges: true });

    const finding = report.edges.find((one) => one.kind === "conforms-absent");
    expect(finding?.detail).toContain("no base at all");
  });
});

describe("Rust, which may confirm and may not accuse", () => {
  const STRUCT = "pub struct Orangutan;\n";
  const TRAIT = "pub trait Router {\n    fn route(&self);\n}\n";

  it("confirms an impl that sits beside the type", async () => {
    const files = {
      "src/router.rs": TRAIT,
      "src/app.rs": `use crate::router::Router;\n\n${STRUCT}\nimpl Router for Orangutan {\n    fn route(&self) {}\n}\n`,
    };
    const board = await boardOf(
      "src/app.rs#Orangutan", "src/router.rs#Router", { claim: "conforms" },
      { from: "Orangutan", to: "Router" },
    );
    const report = checkDrift(board, fakeWorkspace(files), { edges: true });

    expect(report.claims.conformsConfirmed).toBe(1);
    expect(report.clean).toBe(true);
  });

  it("never reads red when the impl is in another file, and says why in the report", async () => {
    /*
     * The definition of done, item three. `impl Trait for Type` is a
     * free-standing item that may sit next to neither the trait nor the type, so
     * an absence here is a fact about where the reader looked -- and a red in
     * the language this project has the least of is the false accusation it can
     * least afford.
     *
     * Silence is not enough on its own: a refusal nobody is told about looks
     * exactly like a claim that passed. The reason is in the report, in its own
     * words rather than as `unlicensed`, because no measurement of any reader
     * would ever change this one.
     */
    const files = {
      "src/router.rs": TRAIT,
      "src/app.rs": `use crate::router::Router;\n\n${STRUCT}`,
      "src/wiring.rs": "impl Router for Orangutan {\n    fn route(&self) {}\n}\n",
    };
    const board = await boardOf(
      "src/app.rs#Orangutan", "src/router.rs#Router", { claim: "conforms" },
      { from: "Orangutan", to: "Router" },
    );
    const report = checkDrift(board, fakeWorkspace(files), { edges: true });

    expect(report.edges.some((one) => one.kind === "conforms-absent")).toBe(false);
    expect(report.claims.conformsWithheld["region-is-the-crate"]).toBe(1);
  });

  it("does not accuse even when the arrow really is backwards", async () => {
    // A Rust arrow drawn base-first is wrong and Rust still may not say so: the
    // trait's declaration cannot enumerate its implementors either.
    const files = {
      "src/router.rs": TRAIT,
      "src/app.rs": `${STRUCT}\nimpl Router for Orangutan {\n    fn route(&self) {}\n}\n`,
    };
    const board = await boardOf(
      "src/router.rs#Router", "src/app.rs#Orangutan", { claim: "conforms" },
      { from: "Router", to: "Orangutan" },
    );
    const report = checkDrift(board, fakeWorkspace(files), { edges: true });

    expect(report.edges.some((one) => one.kind === "conforms-absent")).toBe(false);
  });
});

describe("a claim nothing can ever read", () => {
  it("is loud about an arrow pointing at a function, rather than going quiet", async () => {
    /*
     * A function that satisfies a protocol is structural typing, which is
     * written down nowhere and is not on offer -- and it is the nearest word to
     * reach for. Silence would leave the arrow looking checked forever, which is
     * the one thing `claim.ts` refuses to allow.
     */
    const files = {
      "src/handler.py": "class Handler(Base):\n    pass\n",
      "src/handle.py": "def handle(request):\n    return None\n",
    };
    const board = await boardOf(
      "src/handler.py#Handler", "src/handle.py#handle", { claim: "conforms" },
      { from: "Handler", to: "handle" },
    );
    const report = checkDrift(board, fakeWorkspace(files), { edges: true });

    const garbled = report.garbledClaims?.find((one) => one.written === "conforms");
    expect(garbled).toBeDefined();
    expect(garbled?.detail).toContain("function rather than a type");
    // Not a red: the code has not been asked anything. The board is wrong.
    expect(report.edges.some((one) => one.kind === "conforms-absent")).toBe(false);
  });

  it("is loud about an arrow drawn from a function too", async () => {
    const files = {
      "src/handle.py": "def handle(request):\n    return None\n",
      "src/base.py": "class Base:\n    pass\n",
    };
    const board = await boardOf(
      "src/handle.py#handle", "src/base.py#Base", { claim: "conforms" },
      { from: "handle", to: "Base" },
    );
    const report = checkDrift(board, fakeWorkspace(files), { edges: true });

    const garbled = report.garbledClaims?.find((one) => one.written === "conforms");
    expect(garbled?.detail).toContain("Draw it from the type that has the base");
  });
});

describe("a plan that claims conformance", () => {
  it("keeps the confirmation and is refused the accusation", async () => {
    const files = {
      "src/base.py": "class Base:\n    pass\n",
      "src/handler.py": "class Handler:\n    pass\n",
    };
    const board = await boardOf(
      "src/handler.py#Handler", "src/base.py#Base",
      { claim: "conforms", state: "planned" },
    );
    const report = checkDrift(board, fakeWorkspace(files), { edges: true });

    // Sketching a hierarchy before writing it is what a plan is for.
    expect(report.edges.some((one) => one.kind === "conforms-absent")).toBe(false);
  });
});
