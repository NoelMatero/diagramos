/**
 * `resolvePythonReceivers`'s own two questions (#243): does the async-to-sync
 * seam actually resolve a real receiver against a live pyright process, and
 * does the concrete-guard classification `isConcreteClassLine` reads off a
 * declaration's own header line agree with what the two hazard shapes
 * (`ABC`, `Protocol`) actually look like once pyright is asked for real --
 * the same "confirmed live, not assumed" bar item 17 and #233's own guard
 * were held to.
 *
 * One server for the whole describe block, `resolution-python-lsp.test.ts`'s
 * own reason: a fresh `pyright-langserver` per test multiplies every test by
 * pyright's own startup cost for nothing.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  isConcreteClassLine, pythonDeclarationKind, pythonTypeDeclaredOnLine, resolvePythonReceivers,
} from "../scripts/lib/resolution-python-live";

function write(root: string, relative: string, contents: string): void {
  const full = path.join(root, relative);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, contents);
}

function rangeOf(source: string, needle: string): { start: number; end: number } {
  const start = source.indexOf(needle);
  if (start < 0) throw new Error(`fixture bug: ${JSON.stringify(needle)} not found`);
  return { start, end: start + needle.length };
}

describe("isConcreteClassLine", () => {
  it("reads a plain class as concrete", () => {
    expect(isConcreteClassLine("class Foo:")).toBe(true);
  });

  it("reads an ordinary base class as concrete", () => {
    expect(isConcreteClassLine("class Foo(Bar):")).toBe(true);
  });

  it("reads typing.Protocol as the interface hazard", () => {
    expect(isConcreteClassLine("class Store(Protocol):")).toBe(false);
    expect(isConcreteClassLine("class Store(typing.Protocol):")).toBe(false);
  });

  it("reads abc.ABC and an ABCMeta metaclass as the same hazard", () => {
    expect(isConcreteClassLine("class Base(ABC):")).toBe(false);
    expect(isConcreteClassLine("class Base(abc.ABC):")).toBe(false);
    expect(isConcreteClassLine("class Base(metaclass=ABCMeta):")).toBe(false);
  });

  it("reads a hazard mixed in among ordinary bases", () => {
    expect(isConcreteClassLine("class Both(Mixin, Protocol):")).toBe(false);
  });

  it("withholds rather than guesses on a line it does not recognise", () => {
    expect(isConcreteClassLine("@dataclass")).toBeUndefined();
    expect(isConcreteClassLine("class Split(")).toBeUndefined();
  });
});

describe("pythonTypeDeclaredOnLine", () => {
  /*
   * Whether the line `textDocument/typeDefinition` pointed at declares a type
   * at all (#258). Every shape below is a line pyright really pointed at on
   * graphify or infrarouter, or the typeshed header a builtin resolves to.
   * The ones that declare nothing are the answers `isConcreteClassLine` turns
   * into `concrete: false` -- safe for an accusation, and still a wrong file.
   */
  it.each([
    ["a plain class", "class Match:", { kind: "class", name: "Match" }],
    ["a class with bases", "class LanguageConfig(BaseModel):", { kind: "class", name: "LanguageConfig" }],
    ["a nested class, indented", "    class Inner(Base, metaclass=Meta):", { kind: "class", name: "Inner" }],
    ["a header split across lines", "class Split(", { kind: "class", name: "Split" }],
    ["a typeshed builtin", "class str(Sequence[str]):", { kind: "class", name: "str" }],
    ["a 3.12 alias", "type Vector = list[float]", { kind: "alias", name: "Vector" }],
    ["an annotated alias", "Vector: TypeAlias = list[float]", { kind: "alias", name: "Vector" }],
    ["a NewType", 'NodeId = NewType("NodeId", str)', { kind: "newtype", name: "NodeId" }],
    ["a TypeVar", 'T = typing.TypeVar("T", bound=Base)', { kind: "typevar", name: "T" }],
  ])("reads %s as a type declaration", (_label, line, expected) => {
    expect(pythonTypeDeclaredOnLine(line)).toEqual(expected);
  });

  it.each([
    ["a receiver's own assignment, which is where an Unknown type lands", "                a = args[i]"],
    ["a loop variable", "        for i, a in enumerate(args):"],
    ["the function a call anchor asked about instead of its result", "def out_path(*parts: str) -> Path:"],
    ["a method, indented", "    def _base_market(self) -> Market:"],
    ["an assignment from a call", "            global_path = _custom_providers_path(global_=True)"],
    ["a decorator above a class", "@dataclass(frozen=True)"],
  ])("reads %s as declaring no type", (_label, line) => {
    expect(pythonTypeDeclaredOnLine(line)).toBeUndefined();
  });
});

describe("pythonDeclarationKind", () => {
  /*
   * What `textDocument/typeDefinition` pointed at, in three answers rather than
   * two (#258). A module receiver -- `import graphify.extract as extract_mod;
   * extract_mod.extract(...)` -- lands on the first line of the module's own
   * file, which declares no type and is still the right answer: it is the file
   * a board would point at. Counting it with `a = args[i]` overstated how much
   * of pyright's answering was wrong, by 724 answers across 23 files of
   * graphify and infrarouter.
   */
  it("reads a class line as a type, wherever it sits", () => {
    expect(pythonDeclarationKind("class Match:", 41)).toBe("type");
    expect(pythonDeclarationKind("class Early:", 0)).toBe("type");
  });

  it("reads the top of a file as a module, whatever that first line holds", () => {
    // The three first lines graphify's module receivers really landed on.
    expect(pythonDeclarationKind('"""Query logging for graphify -- append-only JSONL, fail-silent."""', 0)).toBe("module");
    expect(pythonDeclarationKind("from __future__ import annotations", 0)).toBe("module");
    expect(pythonDeclarationKind("import sys", 0)).toBe("module");
  });

  it("reads everything else that declares no type as not a type", () => {
    expect(pythonDeclarationKind("                a = args[i]", 884)).toBe("not a type");
    expect(pythonDeclarationKind("def out_path(*parts: str) -> Path:", 294)).toBe("not a type");
    expect(pythonDeclarationKind("        for node_id, data in graph.nodes(data=True)", 147)).toBe("not a type");
  });
});

describe("resolvePythonReceivers", () => {
  let repo: string;

  beforeAll(() => {
    repo = mkdtempSync(path.join(os.tmpdir(), "resolution-python-live-"));
    write(repo, "store.py", "from typing import Protocol\n\nclass Store(Protocol):\n    def run(self) -> int: ...\n");
    write(
      repo, "base.py",
      "from abc import ABC, abstractmethod\n\nclass Base(ABC):\n    @abstractmethod\n    def run(self) -> int: ...\n",
    );
    write(repo, "concrete_store.py", "class ConcreteStore:\n    def run(self) -> int:\n        return 1\n");
    write(
      repo, "caller.py",
      "from store import Store\nfrom base import Base\nfrom concrete_store import ConcreteStore\n\n"
      + "def use_protocol(store: Store) -> int:\n    return store.run()\n\n"
      + "def use_abc(base: Base) -> int:\n    return base.run()\n\n"
      + "def use_concrete(cs: ConcreteStore) -> int:\n    return cs.run()\n\n"
      + "def use_unresolvable(x) -> int:\n    return x.run()\n",
    );
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("withholds a Protocol receiver behind the same guard #233 built for an interface", async () => {
    const source = readCallerSource(repo);
    const { start, end } = rangeOf(source, "return store.run");
    const at = { start: start + "return ".length, end: start + "return store".length };
    const { cache, close } = await resolvePythonReceivers(repo, [{ file: "caller.py", at }]);
    close();
    const resolved = cache.get("caller.py", at);
    expect(resolved).toEqual({ kind: "declared", file: "store.py", concrete: false });
  }, 60_000);

  it("withholds an ABC receiver the same way", async () => {
    const source = readCallerSource(repo);
    const { start } = rangeOf(source, "return base.run");
    const at = { start: start + "return ".length, end: start + "return base".length };
    const { cache, close } = await resolvePythonReceivers(repo, [{ file: "caller.py", at }]);
    close();
    expect(cache.get("caller.py", at)).toEqual({ kind: "declared", file: "base.py", concrete: false });
  }, 60_000);

  it("places a concrete class receiver, unguarded", async () => {
    const source = readCallerSource(repo);
    const { start } = rangeOf(source, "return cs.run");
    const at = { start: start + "return ".length, end: start + "return cs".length };
    const { cache, close } = await resolvePythonReceivers(repo, [{ file: "caller.py", at }]);
    close();
    expect(cache.get("caller.py", at)).toEqual({ kind: "declared", file: "concrete_store.py", concrete: true });
  }, 60_000);

  it("leaves an unannotated receiver pyright cannot really type unanswered", async () => {
    /*
     * Found live rather than assumed: asked about `x` with no annotation,
     * `typeDefinition` does not answer `null` -- it falls back to `x`'s own
     * parameter declaration, in `caller.py` itself, which is a real repo file
     * and not a class at all. Until #259 that came back as
     * `{ kind: "declared", file: "caller.py", concrete: false }`: safe, since
     * `concrete: false` never accuses, and still a wrong file. The client now
     * withholds a line that declares no type, so there is no answer to cache.
     */
    const source = readCallerSource(repo);
    const { start } = rangeOf(source, "return x.run");
    const at = { start: start + "return ".length, end: start + "return x".length };
    const { cache, close } = await resolvePythonReceivers(repo, [{ file: "caller.py", at }]);
    close();
    expect(cache.get("caller.py", at)).toBeUndefined();
  }, 60_000);

  it("still places a module used as a receiver, at the module's own file", async () => {
    /*
     * The answer #259 must not withhold: `helpers_mod.tool()` lands on line 0
     * of `helpers.py`, which declares no type and is the file a board points
     * at. 724 such answers on graphify and infrarouter (#258).
     */
    write(repo, "helpers.py", "\"\"\"Helpers.\"\"\"\n\n\ndef tool() -> int:\n    return 1\n");
    const moduleSource = "import helpers as helpers_mod\n\n\ndef use_module() -> int:\n    return helpers_mod.tool()\n";
    write(repo, "module_caller.py", moduleSource);
    const { start } = rangeOf(moduleSource, "helpers_mod.tool");
    const at = { start, end: start + "helpers_mod".length };
    const { cache, close } = await resolvePythonReceivers(repo, [{ file: "module_caller.py", at }]);
    close();
    expect(cache.get("module_caller.py", at)).toEqual({ kind: "declared", file: "helpers.py", concrete: false });
  }, 60_000);

  it("resolves a batch of queries off one warm-up, and answers a key never asked with undefined", async () => {
    const source = readCallerSource(repo);
    const protocolAt = rangeOf(source, "store.run");
    const concreteAt = rangeOf(source, "cs.run");
    const queries = [
      { file: "caller.py", at: { start: protocolAt.start, end: protocolAt.start + "store".length } },
      { file: "caller.py", at: { start: concreteAt.start, end: concreteAt.start + "cs".length } },
    ];
    const { cache, close } = await resolvePythonReceivers(repo, queries);
    close();
    expect(cache.get("caller.py", queries[0]!.at)).toEqual({ kind: "declared", file: "store.py", concrete: false });
    expect(cache.get("caller.py", queries[1]!.at)).toEqual({ kind: "declared", file: "concrete_store.py", concrete: true });
    expect(cache.get("caller.py", { start: 0, end: 1 })).toBeUndefined();
  }, 60_000);

  it("asks nothing and spawns nothing for an empty query list", async () => {
    const { cache, close } = await resolvePythonReceivers(repo, []);
    close();
    expect(cache.get("caller.py", { start: 0, end: 1 })).toBeUndefined();
  });
});

function readCallerSource(repo: string): string {
  // The fixture is static for the whole file; re-reading keeps this test
  // file from needing its own copy of the string `beforeAll` already wrote
  // to disk once.
  return readFileSync(path.join(repo, "caller.py"), "utf8");
}
