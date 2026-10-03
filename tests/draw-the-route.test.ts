/**
 * An arrow drawn as one step when the code takes several (#375).
 *
 * `main --calls--> tokenize` when main calls load, load calls parse and parse
 * calls tokenize is a board drawn one level too high. #366 decided it is never
 * red -- people draw summaries on purpose -- so the check says it gets there
 * in three steps and leaves the arrow standing. But an agent draws most
 * boards, and an agent can draw exactly what is true, if it is told while it
 * is still drawing. These tests hold the two halves of that:
 *
 * - every finding that says "it gets there through ..." carries the route, so
 *   the draw-time result can name it in one line whatever the word;
 * - an arrow that names its route with `via` is a summary on purpose, and is
 *   quiet when the code goes that way.
 */
import { describe, expect, it, beforeAll } from "vitest";

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

async function boardOf(
  from: string,
  to: string,
  edge: { claim?: "calls" | "needs" | "depends"; via?: string[] } = {},
): Promise<BoardFile> {
  const { board } = await createDiagram(emptyBoard(), {
    name: "arch",
    nodes: [
      { id: "one", label: "run", ref: from },
      { id: "two", label: "render", ref: to },
    ],
    edges: [{ from: "one", to: "two", ...edge }],
  });
  return board;
}

/** run -> draw -> render, across three files. */
const CHAIN = {
  "src/a.ts": 'import { draw } from "./helper";\nexport function run() { return draw(1); }\n',
  "src/helper.ts": 'import { render } from "./b";\nexport function draw(n: number) { return render(n); }\n',
  "src/b.ts": "export function render(n: number) { return n; }\n",
};

/** c.ts imports b.ts, which imports a.ts; c.ts never imports a.ts itself. */
const IMPORTS = {
  "a.ts": "export const a = 1;\n",
  "b.ts": 'import { a } from "./a";\nexport const b = a;\n',
  "c.ts": 'import { b } from "./b";\nexport const c = b;\n',
};

/** The same chain in Python, where a chained `@needs` is told rather than accused. */
const PY_IMPORTS = {
  "pkg/__init__.py": "",
  "pkg/a.py": "A = 1\n",
  "pkg/b.py": "from pkg.a import A\nB = A\n",
  "pkg/c.py": "from pkg.b import B\nC = B\n",
};

describe("a finding about a longer route carries the route", () => {
  it("names every routine on the way for a calls arrow", async () => {
    const report = checkDrift(await boardOf("src/a.ts#run", "src/b.ts#render", { claim: "calls" }),
      fakeWorkspace(CHAIN), { edges: true });
    const [advisory] = report.edges.filter((finding) => finding.kind === "calls-one-level-up");
    expect(advisory?.route).toEqual(["run", "draw", "render"]);
  });

  it("names every file on the way for a needs arrow that is accused", async () => {
    const report = checkDrift(await boardOf("c.ts", "a.ts", { claim: "needs" }),
      fakeWorkspace(IMPORTS), { edges: true });
    expect(report.edges.map((finding) => finding.kind)).toEqual(["needs-indirect"]);
    expect(report.edges[0]!.route).toEqual(["c.ts", "b.ts", "a.ts"]);
  });

  it("names every file on the way for a needs arrow that is only told", async () => {
    const report = checkDrift(await boardOf("pkg/c.py", "pkg/a.py", { claim: "needs" }),
      fakeWorkspace(PY_IMPORTS), { edges: true });
    expect(report.edges.map((finding) => finding.kind)).toEqual(["needs-one-level-up"]);
    expect(report.edges[0]!.route).toEqual(["pkg/c.py", "pkg/b.py", "pkg/a.py"]);
  });

  it("carries no route on any other finding", async () => {
    // Backwards is about the direct call, and the far end really does call
    // this one: no route to name.
    const backwards = {
      "src/a.ts": "export function run() { return 1; }\n",
      "src/b.ts": 'import { run } from "./a";\nexport function render() { return run(); }\n',
    };
    const report = checkDrift(await boardOf("src/a.ts#run", "src/b.ts#render", { claim: "calls" }),
      fakeWorkspace(backwards), { edges: true });
    expect(report.edges.map((finding) => finding.kind)).toEqual(["calls-backwards"]);
    expect(report.edges[0]!.route).toBeUndefined();
  });
});

describe("an arrow that names its route is a summary on purpose", () => {
  it("is quiet when via names the routines the code goes through", async () => {
    const report = checkDrift(
      await boardOf("src/a.ts#run", "src/b.ts#render", { claim: "calls", via: ["draw"] }),
      fakeWorkspace(CHAIN), { edges: true });
    expect(report.edges).toEqual([]);
    expect(report.claims.callsConfirmed).toBe(1);
    expect(report.clean).toBe(true);
  });

  it("still says the route when via names a different one", async () => {
    const report = checkDrift(
      await boardOf("src/a.ts#run", "src/b.ts#render", { claim: "calls", via: ["paint"] }),
      fakeWorkspace(CHAIN), { edges: true });
    const [advisory] = report.edges.filter((finding) => finding.kind === "calls-one-level-up");
    expect(advisory?.route).toEqual(["run", "draw", "render"]);
    expect(report.claims.callsConfirmed).toBe(0);
  });

  it("is quiet for a needs arrow whose via names the file in between", async () => {
    for (const via of [["b.ts"], ["b"]]) {
      const report = checkDrift(await boardOf("c.ts", "a.ts", { claim: "needs", via }),
        fakeWorkspace(IMPORTS), { edges: true });
      expect(report.edges).toEqual([]);
      expect(report.clean).toBe(true);
    }
  });

  it("is quiet for a Python needs arrow whose via names the module in between", async () => {
    const report = checkDrift(await boardOf("pkg/c.py", "pkg/a.py", { claim: "needs", via: ["pkg/b.py"] }),
      fakeWorkspace(PY_IMPORTS), { edges: true });
    expect(report.edges).toEqual([]);
  });

  it("keeps the red when a needs arrow's via is not the route", async () => {
    const report = checkDrift(await boardOf("c.ts", "a.ts", { claim: "needs", via: ["z.ts"] }),
      fakeWorkspace(IMPORTS), { edges: true });
    expect(report.edges.map((finding) => finding.kind)).toEqual(["needs-indirect"]);
  });

  it("leaves depends as it was: the chain is what it claims", async () => {
    const report = checkDrift(await boardOf("c.ts", "a.ts", { claim: "depends" }),
      fakeWorkspace(IMPORTS), { edges: true });
    expect(report.edges).toEqual([]);
  });
});

/**
 * A routine that picks its callee from a list written in the code (#375).
 *
 * `handlers[k]()` can neither confirm nor refute "run calls start", so the
 * board keeps an arrow nobody can check. When the list is closed the true
 * drawing is "run runs one of {start, stop}" -- one calls arrow per choice --
 * and the check names the choices so the draw-time result can say so. It
 * never changes a verdict, and a lookup that may take any string gets nothing.
 */
describe("a routine that picks its callee from a closed list", () => {
  const OPS = "export function start() { return 1; }\nexport function stop() { return 2; }\n";
  const PY_OPS = "def start():\n    return 1\n\n\ndef stop():\n    return 2\n";

  async function picker(from: string, to: string[]): Promise<BoardFile> {
    const { board } = await createDiagram(emptyBoard(), {
      name: "arch",
      nodes: [
        { id: "run", label: "run", ref: from },
        ...to.map((ref) => ({ id: ref.split("#")[1]!, label: ref.split("#")[1]!, ref })),
      ],
      edges: to.map((ref) => ({ from: "run", to: ref.split("#")[1]!, claim: "calls" as const })),
    });
    return board;
  }

  const ts = (table: string, signature: string, extra = "") => ({
    "src/cmd.ts": `import { start, stop } from "./ops";\n${table}\n${extra}`
      + `export function run(${signature}) { return handlers[k](); }\n`,
    "src/ops.ts": OPS,
  });

  it("names the choices for a TypeScript key typed as a union of strings", async () => {
    const files = ts("const handlers = { start, stop };", 'k: "start" | "stop"');
    const report = checkDrift(await picker("src/cmd.ts#run", ["src/ops.ts#start"]), fakeWorkspace(files), { edges: true });
    expect(report.pickedAtRunTime).toEqual([
      { node: "run", label: "run", table: "handlers", names: ["start", "stop"], missing: ["stop"] },
    ]);
    // The arrow's own answer is what it was: unconfirmed, nothing red.
    expect(report.edges).toEqual([]);
    expect(report.unconfirmedEdges.map((arrow) => arrow.reason)).toEqual(["claim-not-checked"]);
  });

  it("reads keyof typeof and a union alias as closed too", async () => {
    for (const [extra, signature] of [
      ["", "k: keyof typeof handlers"],
      ['type Command = "start" | "stop";\n', "k: Command"],
    ] as const) {
      const files = ts("const handlers = { start, stop: stop };", signature, extra);
      const report = checkDrift(await picker("src/cmd.ts#run", ["src/ops.ts#start"]), fakeWorkspace(files), { edges: true });
      expect(report.pickedAtRunTime?.[0]?.names).toEqual(["start", "stop"]);
    }
  });

  it("says nothing new when the key may be any string", async () => {
    // The correct-code test the issue asks for: the same table behind a
    // `string` key is a lookup that can miss, and an open lookup gets no line.
    const files = ts("const handlers: Record<string, () => number> = { start, stop };", "k: string");
    const report = checkDrift(await picker("src/cmd.ts#run", ["src/ops.ts#start"]), fakeWorkspace(files), { edges: true });
    expect(report.pickedAtRunTime).toBeUndefined();
    expect(report.edges).toEqual([]);
    expect(report.unconfirmedEdges.map((arrow) => arrow.reason)).toEqual(["claim-not-checked"]);
  });

  it("says nothing when the table is let, written into, or holds an unnamed function", async () => {
    for (const [table, extra] of [
      ["let handlers = { start, stop };", ""],
      ["const handlers = { start, stop };", "handlers.extra = start;\n"],
      ["const handlers = { start, stop };", "Object.assign(handlers, { more: stop });\n"],
      ["const handlers = { start, stop: () => 2 };", ""],
      ["const handlers = { start, ...others };", "const others = { stop };\n"],
    ] as const) {
      const files = ts(table, 'k: "start" | "stop"', extra);
      const report = checkDrift(await picker("src/cmd.ts#run", ["src/ops.ts#start"]), fakeWorkspace(files), { edges: true });
      expect(report.pickedAtRunTime, `${table} ${extra}`).toBeUndefined();
    }
  });

  it("names the choices for a Python dict written out in the file, in one step or two", async () => {
    for (const body of ["    return HANDLERS[k]()\n", "    h = HANDLERS.get(k)\n    return h()\n"]) {
      const files = {
        "pkg/__init__.py": "",
        "pkg/cmd.py": "from pkg.ops import start, stop\n\nHANDLERS = {'start': start, 'stop': stop}\n\n\n"
          + `def run(k):\n${body}`,
        "pkg/ops.py": PY_OPS,
      };
      const report = checkDrift(await picker("pkg/cmd.py#run", ["pkg/ops.py#stop"]), fakeWorkspace(files), { edges: true });
      expect(report.pickedAtRunTime).toEqual([
        { node: "run", label: "run", table: "HANDLERS", names: ["start", "stop"], missing: ["start"] },
      ]);
    }
  });

  it("says nothing for getattr, or a dict something writes into", async () => {
    for (const source of [
      "from pkg import ops\n\n\ndef run(k):\n    return getattr(ops, k)()\n",
      "from pkg.ops import start, stop\n\nHANDLERS = {'start': start, 'stop': stop}\n\n\n"
        + "def register(name, fn):\n    HANDLERS[name] = fn\n\n\ndef run(k):\n    return HANDLERS[k]()\n",
    ]) {
      const files = { "pkg/__init__.py": "", "pkg/cmd.py": source, "pkg/ops.py": PY_OPS };
      const report = checkDrift(await picker("pkg/cmd.py#run", ["pkg/ops.py#stop"]), fakeWorkspace(files), { edges: true });
      expect(report.pickedAtRunTime).toBeUndefined();
    }
  });

  it("goes quiet once every choice has its arrow", async () => {
    const files = ts("const handlers = { start, stop };", 'k: "start" | "stop"');
    const report = checkDrift(await picker("src/cmd.ts#run", ["src/ops.ts#start", "src/ops.ts#stop"]),
      fakeWorkspace(files), { edges: true });
    expect(report.pickedAtRunTime).toBeUndefined();
  });

  it("says nothing when the far end is not one of the choices", async () => {
    const files = {
      ...ts("const handlers = { start, stop };", 'k: "start" | "stop"'),
      "src/other.ts": "export function other() { return 3; }\n",
    };
    const report = checkDrift(await picker("src/cmd.ts#run", ["src/other.ts#other"]), fakeWorkspace(files), { edges: true });
    expect(report.pickedAtRunTime).toBeUndefined();
  });
});
