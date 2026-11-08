/**
 * A plain arrow means direct (2026-11-08).
 *
 * `run --calls--> render` when run calls draw and draw calls render claims a
 * call that does not exist. The checker already worked out the route and
 * printed it as a note -- "it gets there in 2 steps, through draw" -- and
 * then answered "not sure", so the wrong arrow was never flagged: 29, 28 and
 * 19 wrong arrows on the three benchmark sets, and never a correct one.
 *
 * Now it is red where the direct call (or import) is ruled out, and the red
 * shows the hops and both ways out as the literal edit. Where something keeps
 * a direct call possible, the route stays a note. Both halves, per language.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { emptyBoard, type BoardFile } from "../src/engine/board-file";
import { createDiagram } from "../src/engine/diagram";
import { accuses, checkDrift, type Workspace } from "../src/engine/drift";
import { initEngine } from "../src/engine/parse";
import { installExcalifontMeasurer } from "./helpers/excalifont";

installExcalifontMeasurer();

beforeAll(async () => { await initEngine(); }, 60_000);

/** In memory, and listable: a Rust crate's module tree is read from its `Cargo.toml`. */
function memory(files: Record<string, string>): Workspace {
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
      for (const file of Object.keys(files)) if (file.startsWith(prefix)) names.add(file.slice(prefix.length).split("/")[0]!);
      return [...names];
    },
  };
}

async function boardOf(
  from: string,
  to: string,
  claim: "calls" | "needs",
  via?: string[],
): Promise<BoardFile> {
  const { board } = await createDiagram(emptyBoard(), {
    name: "arch",
    nodes: [
      { id: "caller", label: "caller", ref: from },
      { id: "callee", label: "callee", ref: to },
    ],
    edges: [{ from: "caller", to: "callee", claim, ...(via ? { via } : {}) }],
  });
  return board;
}

const CARGO = '[package]\nname = "flow"\nversion = "0.1.0"\nedition = "2021"\n';

/** run -> draw -> render, every call placed. */
const CHAIN: Record<string, { files: Record<string, string>; from: string; to: string }> = {
  typescript: {
    files: {
      "src/app.ts": "export function run() { return draw(1); }\n"
        + "export function draw(n: number) { return render(n); }\n"
        + "export function render(n: number) { return n; }\n",
    },
    from: "src/app.ts#run",
    to: "src/app.ts#render",
  },
  "typescript, across files": {
    files: {
      "src/a.ts": 'import { draw } from "./helper";\nexport function run() { return draw(1); }\n',
      "src/helper.ts": 'import { render } from "./b";\nexport function draw(n: number) { return render(n); }\n',
      "src/b.ts": "export function render(n: number) { return n; }\n",
    },
    from: "src/a.ts#run",
    to: "src/b.ts#render",
  },
  python: {
    files: {
      "app/flow.py": "def run():\n    return draw(1)\n\n\ndef draw(n):\n    return render(n)\n\n\n"
        + "def render(n):\n    return n\n",
    },
    from: "app/flow.py#run",
    to: "app/flow.py#render",
  },
  rust: {
    files: {
      "Cargo.toml": CARGO,
      "src/lib.rs": "pub fn run() -> u32 { draw(1) }\n"
        + "pub fn draw(n: u32) -> u32 { render(n) }\n"
        + "pub fn render(n: u32) -> u32 { n }\n",
    },
    from: "src/lib.rs#run",
    to: "src/lib.rs#render",
  },
};

describe("a calls arrow the code reaches only through another call", () => {
  for (const [language, { files, from, to }] of Object.entries(CHAIN)) {
    it(`is red and shows the hops (${language})`, async () => {
      const report = checkDrift(await boardOf(from, to, "calls"), memory(files), { edges: true });
      expect(report.edges.map((finding) => finding.kind)).toEqual(["calls-indirect"]);
      const [red] = report.edges;
      expect(accuses(red!.kind)).toBe(true);
      expect(red!.route).toEqual(["run", "draw", "render"]);
      expect(red!.detail).toMatch(/^A calls arrow means a direct call\. run doesn't call render directly/);
      expect(red!.detail).toContain("it gets there in 2 hops: run → draw → render.");
      // Both ways out, the second as the exact call a small model can make.
      expect(red!.detail).toContain("Draw `draw` as a box between them");
      expect(red!.detail).toContain('edit_diagram updates [{"id":"caller -> callee","via":["draw"]}]');
      expect(report.claims.callsConfirmed).toBe(0);
      expect(report.clean).toBe(false);
    });

    it(`is green once via names the route (${language})`, async () => {
      const report = checkDrift(await boardOf(from, to, "calls", ["draw"]), memory(files), { edges: true });
      expect(report.edges).toEqual([]);
      expect(report.claims.callsConfirmed).toBe(1);
    });
  }

  it("is red when the far end also calls back, and the tail's calls are all read", async () => {
    // `render` calls `run`, so the old answer was "turn it round" -- stopped
    // because run reaches render forwards. Forwards is still not direct.
    const files = {
      "src/app.ts": "export function run() { return draw(1); }\n"
        + "export function draw(n: number) { return render(n); }\n"
        + "export function render(n: number): number { return n > 9 ? n : run(); }\n",
    };
    const report = checkDrift(await boardOf("src/app.ts#run", "src/app.ts#render", "calls"), memory(files), { edges: true });
    expect(report.edges.map((finding) => finding.kind)).toEqual(["calls-indirect"]);
    expect(report.edges[0]!.detail).toContain("2 hops: run → draw → render");
  });
});

/**
 * The tail also hands the far end on by name -- `xs.map(render)` -- to
 * something that may run it. Then the far end may be run straight from the
 * tail, and "doesn't call it directly" is not something the text can say.
 */
const HANDS_ON: Record<string, { files: Record<string, string>; from: string; to: string }> = {
  typescript: {
    files: {
      "src/app.ts": "export function run(xs: number[]) { xs.map(render); return draw(1); }\n"
        + "export function draw(n: number) { return render(n); }\n"
        + "export function render(n: number): number { return n > 9 ? n : run([n]); }\n",
    },
    from: "src/app.ts#run",
    to: "src/app.ts#render",
  },
  python: {
    files: {
      "app/flow.py": "def run(xs):\n    list(map(render, xs))\n    return draw(1)\n\n\n"
        + "def draw(n):\n    return render(n)\n\n\n"
        + "def render(n):\n    return n if n > 9 else run([n])\n",
    },
    from: "app/flow.py#run",
    to: "app/flow.py#render",
  },
  rust: {
    files: {
      "Cargo.toml": CARGO,
      "src/lib.rs": "pub fn run(xs: Vec<u32>) -> u32 { let _: Vec<u32> = xs.into_iter().map(render).collect(); draw(1) }\n"
        + "pub fn draw(n: u32) -> u32 { render(n) }\n"
        + "pub fn render(n: u32) -> u32 { if n > 9 { n } else { run(vec![n]) } }\n",
    },
    from: "src/lib.rs#run",
    to: "src/lib.rs#render",
  },
};

describe("a calls arrow where a direct call is still possible", () => {
  for (const [language, { files, from, to }] of Object.entries(HANDS_ON)) {
    it(`keeps the route as a note and is not red (${language})`, async () => {
      const report = checkDrift(await boardOf(from, to, "calls"), memory(files), { edges: true });
      expect(report.edges.filter((finding) => accuses(finding.kind))).toEqual([]);
      // Still told the route: the note is there, not silence.
      expect(report.edges.map((finding) => finding.kind)).toEqual(["calls-one-level-up"]);
      expect(report.edges[0]!.route![0]).toBe("run");
      expect(report.claims.callsConfirmed).toBe(0);
    });
  }
});

describe("a Python needs arrow the code reaches only through another file", () => {
  it("is red and shows the files on the way", async () => {
    const files = {
      "pkg/__init__.py": "",
      "pkg/a.py": "A = 1\n",
      "pkg/b.py": "from pkg.a import A\nB = A\n",
      "pkg/c.py": "from pkg.b import B\nC = B\n",
    };
    const report = checkDrift(await boardOf("pkg/c.py", "pkg/a.py", "needs"), memory(files), { edges: true });
    expect(report.edges.map((finding) => finding.kind)).toEqual(["needs-indirect"]);
    const [red] = report.edges;
    expect(accuses(red!.kind)).toBe(true);
    expect(red!.detail).toContain("pkg/c.py doesn't import pkg/a.py directly; it gets there in 2 hops: "
      + "pkg/c.py → pkg/b.py → pkg/a.py.");
    expect(red!.detail).toContain('edit_diagram updates [{"id":"caller -> callee","via":["pkg/b.py"]}]');
  });

  it("is red when the only shared name is one the tail defines for itself", async () => {
    // Every module has a `logger`; the tail's own is not the far end's.
    const files = {
      "pkg/__init__.py": "",
      "pkg/head.py": "import logging\nlogger = logging.getLogger(__name__)\n\n\ndef thing():\n    return 1\n",
      "pkg/mid.py": "from pkg.head import thing\n\n\ndef helper():\n    return thing()\n",
      "pkg/tail.py": "import logging\nfrom pkg.mid import helper\nlogger = logging.getLogger(__name__)\n\n\n"
        + "def run():\n    logger.info('x')\n    return helper()\n",
    };
    const report = checkDrift(await boardOf("pkg/tail.py", "pkg/head.py", "needs"), memory(files), { edges: true });
    expect(report.edges.map((finding) => finding.kind)).toEqual(["needs-indirect"]);
  });

  it("stays a note when the tail writes a name the far end defines, which a re-export may hand on", async () => {
    // `pkg.Thing` is head.py's class, handed on by the package: the compiler
    // calls that an import of head.py, and so does the person who drew it.
    const files = {
      "pkg/__init__.py": "from pkg.head import Thing\n",
      "pkg/head.py": "class Thing:\n    pass\n",
      "app.py": "import pkg\n\n\ndef make():\n    return pkg.Thing()\n",
    };
    const report = checkDrift(await boardOf("app.py", "pkg/head.py", "needs"), memory(files), { edges: true });
    expect(report.edges.map((finding) => finding.kind)).toEqual(["needs-one-level-up"]);
    expect(accuses(report.edges[0]!.kind)).toBe(false);
    expect(report.edges[0]!.route).toEqual(["app.py", "pkg/__init__.py", "pkg/head.py"]);
    expect(report.edges[0]!.detail).toContain("app.py writes `Thing`, which pkg/head.py defines");
  });

  it("stays a note when the name comes in through a star import", async () => {
    const files = {
      "pkg/__init__.py": "from pkg.mid import *\n",
      "pkg/mid.py": "from pkg.head import *\n",
      "pkg/head.py": "def thing():\n    return 1\n",
      "app.py": "import pkg\n\n\ndef make():\n    return pkg.thing()\n",
    };
    const report = checkDrift(await boardOf("app.py", "pkg/head.py", "needs"), memory(files), { edges: true });
    expect(report.edges.filter((finding) => accuses(finding.kind))).toEqual([]);
  });
});

describe("a needs arrow the code reaches only through another file, in TypeScript and Rust", () => {
  it("shows the hops in TypeScript", async () => {
    const files = {
      "a.ts": "export const a = 1;\n",
      "b.ts": 'import { a } from "./a";\nexport const b = a;\n',
      "c.ts": 'import { b } from "./b";\nexport const c = b;\n',
    };
    const report = checkDrift(await boardOf("c.ts", "a.ts", "needs"), memory(files), { edges: true });
    expect(report.edges.map((finding) => finding.kind)).toEqual(["needs-indirect"]);
    expect(report.edges[0]!.detail).toContain("c.ts doesn't import a.ts directly; it gets there in 2 hops: c.ts → b.ts → a.ts.");
  });

  it("shows the hops in Rust", async () => {
    const files = {
      "Cargo.toml": CARGO,
      "src/lib.rs": "mod a;\nmod b;\nmod c;\n",
      "src/a.rs": "pub fn a() -> u32 { 1 }\n",
      "src/b.rs": "use crate::a::a;\npub fn b() -> u32 { a() }\n",
      "src/c.rs": "use crate::b::b;\npub fn c() -> u32 { b() }\n",
    };
    const report = checkDrift(await boardOf("src/c.rs", "src/a.rs", "needs"), memory(files), { edges: true });
    expect(report.edges.map((finding) => finding.kind)).toEqual(["needs-indirect"]);
    expect(report.edges[0]!.detail).toContain("src/c.rs doesn't import src/a.rs directly; it gets there in 2 hops: "
      + "src/c.rs → src/b.rs → src/a.rs.");
  });
});
