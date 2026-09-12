/**
 * Following a chain of calls across files, and the one cache bug that made an
 * answer depend on what else had been read.
 *
 * `engine-calls.test.ts` covers what one body calls. What is covered here is
 * the walk between bodies: a chain that leaves the file it started in, the
 * hops it refuses to follow, and the difference between "no chain found" and
 * "there is no chain".
 *
 * The shapes come from the corpus rather than from the design.
 * `measure:reach` is where each one was found, and the number it moved is in
 * the comment beside the case.
 */
import { describe, expect, it, beforeAll } from "vitest";

import { emptyBoard } from "../src/engine/board-file";
import { reaches } from "../src/engine/body";
import type { CallSide } from "../src/engine/calls";
import { createDiagram } from "../src/engine/diagram";
import { checkDrift, checkSymbolEdge, type Workspace } from "../src/engine/drift";
import { initEngine, languageOf, parseSource, type Language } from "../src/engine/parse";
import { reachBetween } from "../src/engine/reach";
import { installExcalifontMeasurer } from "./helpers/excalifont";

installExcalifontMeasurer();

beforeAll(async () => { await initEngine(); }, 60_000);

/**
 * Sides over a set of in-memory files, with no receiver resolver of its own --
 * so what these tests exercise is the reader alone, tier 1, exactly as a
 * check with no compiler wired in sees it.
 */
function sides(files: Record<string, string>) {
  const imports = (file: string): CallSide["imports"] => {
    const source = files[file] ?? "";
    const found: CallSide["imports"] = [];
    for (const hit of source.matchAll(/from\s+["']([^"']+)["']/g)) {
      const specifier = hit[1]!;
      const target = `${specifier.replace(/^\.\//, "")}.ts`;
      found.push({ specifier, ...(files[target] !== undefined ? { file: target } : {}) });
    }
    for (const hit of source.matchAll(/^from\s+([\w.]+)\s+import/gm)) {
      const specifier = hit[1]!;
      const target = `${specifier.replace(/\./g, "/")}.py`;
      found.push({ specifier, ...(files[target] !== undefined ? { file: target } : {}) });
    }
    return found;
  };
  const open = (file: string) => {
    const source = files[file];
    const language = languageOf(file);
    if (source === undefined || !language) return undefined;
    return { source, language, imports: imports(file) };
  };
  const side = (file: string): CallSide => ({
    file, source: files[file]!, language: languageOf(file)! as Language,
    imports: imports(file), open,
  });
  return { side };
}

describe("a chain that leaves the file", () => {
  const files = {
    "server.ts": `
      import { parseBody } from "./parser";
      export function handleRequest(request: string) {
        return parseBody(request);
      }
    `,
    "parser.ts": `
      import { decode } from "./codec";
      export function parseBody(raw: string) {
        return decode(raw);
      }
    `,
    "codec.ts": `
      export function decode(raw: string) {
        return raw;
      }
    `,
  };

  it("is not found by the one-file search", () => {
    // The wall this exists to get past: `reaches` looks a callee's name up in
    // the tree it already parsed, so the chain ends at the file boundary.
    expect(reaches(files["server.ts"], "handleRequest", ["decode"], "ts")).toBe(false);
  });

  it("is found by the walk", () => {
    const { side } = sides(files);
    const verdict = reachBetween(
      { ...side("server.ts"), routine: "handleRequest" },
      { ...side("codec.ts"), names: ["decode"] },
    );
    expect(verdict.verdict).toBe("reached");
    if (verdict.verdict === "reached") {
      expect(verdict.via).toEqual(["handleRequest", "parseBody", "decode"]);
    }
  });

  /*
   * The refutation, and it is only available because every body on the way is
   * closed. Add one `JSON.parse(raw)` to `decode` and this goes back to
   * `withheld` -- a receiver nothing typed is a door the chain may have gone
   * through, and that is the answer the whole file is arranged to give.
   */
  it("says never when the closure is closed and the far end is not in it", () => {
    const { side } = sides(files);
    const verdict = reachBetween(
      { ...side("server.ts"), routine: "handleRequest" },
      { ...side("parser.ts"), names: ["somethingElse"] },
    );
    expect(verdict.verdict).toBe("never");
  });
});

describe("a hop the reader will not follow", () => {
  /*
   * The failure both earlier attempts made, in the form they made it
   * (ee3b29e): a library's method sharing a name with one of the project's
   * own routines. `events.readable()` is not `readable` in this file, and a
   * walk that followed names rather than calls confirmed the arrow anyway.
   */
  const files = {
    "conn.ts": `
      import { events } from "mio";
      import { log } from "./logger";
      export function ready(state: string) {
        return events.readable(state);
      }
      export function readable(state: string) {
        return log(state);
      }
    `,
    "logger.ts": `
      export function log(line: string) {
        return line;
      }
    `,
  };

  it("does not confirm through a name the file never calls", () => {
    const { side } = sides(files);
    const verdict = reachBetween(
      { ...side("conn.ts"), routine: "ready" },
      { ...side("logger.ts"), names: ["log"] },
    );
    expect(verdict.verdict).not.toBe("reached");
  });
});

describe("a later hop landing back in the head's own file", () => {
  /*
   * The bug `measure:reach` found and no hand-written fixture would have: the
   * walk asked "is this the head's *file*" where it meant "is this the head",
   * so a local call back into that file read as the head having no body and
   * abandoned every chain still on the frontier. 86 of one corpus's 367
   * reaching pairs were lost to it.
   */
  const files = {
    "board.ts": `
      import { paint } from "./canvas";
      const SIZE = 10;
      export function draw() {
        return size() + step();
      }
      export function step() {
        return paint(SIZE);
      }
      export function size() {
        return SIZE;
      }
    `,
    "canvas.ts": `
      export function paint(at: number) {
        return at;
      }
    `,
  };

  it("keeps walking the rest of the frontier", () => {
    const { side } = sides(files);
    const verdict = reachBetween(
      { ...side("board.ts"), routine: "draw" },
      { ...side("canvas.ts"), names: ["paint"] },
    );
    expect(verdict.verdict).toBe("reached");
  });
});

describe("the route a confirmation quotes", () => {
  /*
   * The route is what makes `calls-one-level-up` an advisory somebody can act
   * on rather than an assertion, so it has to name the right things. A
   * TypeScript `#private` method puts a `#` inside the routine name, which is
   * also the separator the walk keys its frontier with -- so the route is
   * carried alongside the key rather than parsed back out of it.
   */
  const files = {
    "panel.ts": 'import { paint } from "./canvas";\n'
      + "export class Panel {\n"
      + "  draw() { return this.#step(); }\n"
      + "  #step() { return paint(1); }\n"
      + "}\n",
    "canvas.ts": "export function paint(at: number) { return at; }\n",
  };

  it("names the private method it went through, not the file", () => {
    const { side } = sides(files);
    const verdict = reachBetween(
      { ...side("panel.ts"), routine: "draw" },
      { ...side("canvas.ts"), names: ["paint"] },
    );
    expect(verdict.verdict).toBe("reached");
    if (verdict.verdict === "reached") {
      expect(verdict.via).toEqual(["draw", "#step", "paint"]);
      expect(verdict.hops.map((hop) => hop.file)).toEqual(["panel.ts", "canvas.ts"]);
    }
  });
});

describe("a method called on a value", () => {
  /*
   * Every Python chain the walk failed to follow began with one of these
   * (`measure:reach`, 23 misses out of 23). The type is written down at the
   * constructor, which is what `resolution.ts` reads -- wired in here as a
   * receiver resolver for the first time.
   */
  const files = {
    "test_stream.py": `
from httpx.models import Response

def test_iter_bytes():
    response = Response(200)
    return response.iter_bytes()
`,
    "httpx/models.py": `
from httpx.decoders import decode

class Response:
    def iter_bytes(self):
        return decode(self.raw)
`,
    "httpx/decoders.py": `
def decode(raw):
    return raw
`,
  };

  it("is followed to the type the text names", () => {
    const { side } = sides(files);
    const verdict = reachBetween(
      { ...side("test_stream.py"), routine: "test_iter_bytes" },
      { ...side("httpx/decoders.py"), names: ["decode"] },
    );
    expect(verdict.verdict).toBe("reached");
  });

  it("never rests on one, because a printed type name is not the runtime type", () => {
    const { side } = sides(files);
    const verdict = reachBetween(
      { ...side("test_stream.py"), routine: "test_iter_bytes" },
      { ...side("httpx/decoders.py"), names: ["nothingCalledThis"] },
    );
    expect(verdict.verdict).toBe("withheld");
  });
});

describe("the answer does not depend on what else has been read", () => {
  /*
   * `body.ts` cached one node's tokens in a map keyed by node id, and a node
   * id is an address inside one tree. Evict that tree and the next one is
   * handed the same addresses, so the cache answers about the new file with
   * the old file's tokens -- and which files had been read in between decided
   * whether an arrow was confirmed. `measure:reach` moved by one arrow with
   * nothing about that arrow changed, which is how it was found.
   */
  const source = `
    export function alpha() { return beta(); }
    export function beta() { return "beta"; }
  `;
  /** Past `parse.ts`'s CACHE_LIMIT, so the tree above is freed and re-parsed. */
  const others = Array.from({ length: 70 }, (_, index) =>
    `export function other${index}() { return ${index}; }`);

  it("gives the same verdict before and after the parse cache turns over", () => {
    const before = reaches(source, "alpha", ["beta"], "ts");
    for (const other of others) parseSource(other, "ts");
    const after = reaches(source, "alpha", ["beta"], "ts");
    expect(after).toBe(before);
    expect(after).toBe(true);
  });
});

/* --------------------------------------------------- and on a real board */

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

describe("a plain arrow between two routines in different files", () => {
  /*
   * What the person holding the board sees, which is the only reason any of
   * this matters. Before, an arrow between two routines with a helper in
   * between came back as one of the arrows nothing corroborated, with
   * `no-call-either-way` on the row -- amber, on a correct arrow, and the
   * commonest thing this engine said wrongly (`measure:reach`: 313 of 545
   * reaching pairs in two repositories).
   */
  const files = {
    "src/server.ts": 'import { parseBody } from "./parser";\n'
      + "export function handleRequest(raw: string) { return parseBody(raw); }\n",
    "src/parser.ts": 'import { decode } from "./codec";\n'
      + "export function parseBody(raw: string) { return decode(raw); }\n",
    "src/codec.ts": "export function decode(raw: string) { return raw; }\n",
  };

  it("is confirmed rather than reported as connected by nothing", async () => {
    const { board } = await createDiagram(emptyBoard(), {
      name: "arch",
      nodes: [
        { id: "server", label: "handleRequest", ref: "src/server.ts#handleRequest" },
        { id: "codec", label: "decode", ref: "src/codec.ts#decode" },
      ],
      edges: [{ from: "server", to: "codec" }],
    });
    const report = checkDrift(board, fakeWorkspace(files), { edges: true });
    expect(report.edges).toEqual([]);
    // The row that used to carry `no-call-either-way`. Empty is the whole
    // point: the arrow is not merely un-accused, it is confirmed.
    expect(report.unconfirmedEdges).toEqual([]);
    expect(report.clean).toBe(true);
  });
});

describe("a name in another file that means something else", () => {
  /*
   * The corpus shapes, one test each, because they are three different
   * problems wearing one word. Every one of them was a **confirmed** arrow
   * before `measure:reach` counted them: 51 in `anyhow` and 6 in `flask`.
   */
  const edge = (files: Record<string, string>, from: string, to: string) => {
    const workspace = fakeWorkspace(files);
    const split = (ref: string) => {
      const [file, symbol] = ref.split("#");
      return { file: file!, path: file!, symbols: [symbol!] };
    };
    return checkSymbolEdge(split(from), split(to), workspace).verdict;
  };

  it("does not confirm on a method called on a value (rust)", () => {
    // `anyhow`: `chain.rs#len` writes `cause.source()`, which is
    // `StdError::source` on a trait object, not `context.rs#source`.
    const verdict = edge({
      "src/context.rs": "impl Foo {\n    fn source(&self) -> Option<&Error> { Some(&self.error) }\n}\n",
      "src/chain.rs": "impl Chain {\n    fn len(&self) -> usize {\n"
        + "        let mut n = 0;\n        while let Some(cause) = next { next = cause.source(); n += 1; }\n"
        + "        n\n    }\n}\n",
    }, "src/context.rs#source", "src/chain.rs#len");
    expect(verdict).not.toBe("reached");
  });

  it("does not confirm on a path call either, which is the number correcting the design", () => {
    /*
     * `Error::construct_from_display(..)` writes the type at the call site,
     * which reads like better evidence than `x.foo()` -- and it was let
     * through on that argument, because none of the 51 wrong confirmations
     * had been a path call. Measured over the whole Rust population it bought
     * 17 confirmations and cost 5 more wrong ones, so the argument lost.
     * `ripgrep`'s `config.rs` has a test `fn basic` writing `Parser::new()`,
     * and an arrow to `parse.rs#new` went green on it.
     */
    const verdict = edge({
      "src/context.rs": "fn context(c: C) -> Result<T> {\n"
        + "    Err(Error::construct_from_display(c, backtrace!()))\n}\n",
      "src/error.rs": "impl Error {\n    pub fn construct_from_display(m: M, b: B) -> Self { Self }\n}\n",
    }, "src/context.rs#context", "src/error.rs#construct_from_display");
    expect(verdict).not.toBe("reached");
  });

  it("does not confirm on a nested declaration of the same name (python)", () => {
    // `flask`: `blueprints.py#app_template_filter` declares its own nested
    // `decorator`, so the word in its body is not `app.py`'s `decorator`.
    const verdict = edge({
      "src/app.py": "def template_filter(name=None):\n    def decorator(f):\n        return f\n    return decorator\n",
      "src/blueprints.py": "def app_template_filter(name=None):\n    def decorator(f):\n        return f\n    return decorator\n",
    }, "src/app.py#decorator", "src/blueprints.py#app_template_filter");
    expect(verdict).not.toBe("reached");
  });

  it("still confirms on a bare call across files (typescript)", () => {
    // The standard the rule must not cost anything: a plain imported call.
    const verdict = edge({
      "src/a.ts": 'import { render } from "./b";\nexport function run() { return render(1); }\n',
      "src/b.ts": "export function render(n: number) { return n; }\n",
    }, "src/a.ts#run", "src/b.ts#render");
    expect(verdict).toBe("reached");
  });

  it("still confirms through self, whose impl may be in the other file (rust)", () => {
    const verdict = edge({
      "src/a.rs": "impl Error {\n    fn chain(&self) -> Chain { self.inner_chain() }\n}\n",
      "src/b.rs": "impl Error {\n    fn inner_chain(&self) -> Chain { Chain::new() }\n}\n",
    }, "src/a.rs#chain", "src/b.rs#inner_chain");
    expect(verdict).toBe("reached");
  });
});
