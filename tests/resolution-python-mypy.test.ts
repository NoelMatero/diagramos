/**
 * mypy as a second oracle for pyright's type answers (#258).
 *
 * Item 17's Python check asks pyright two questions and compares its two
 * answers, so it cannot catch pyright being wrong -- the same shape item 14
 * admits for TypeScript. #250 gave Rust a genuinely independent referee by
 * asking a different implementation; mypy is Python's.
 *
 * The probe is a tagged `reveal_type`, and the tag is not decoration: mypy
 * prints one note per distinct message per line, so two receivers of the same
 * type on one line would report once and the second would vanish. Wrapping the
 * receiver in a tuple with a per-site `Literal` makes every message distinct
 * and carries the site's own id in the output, so nothing is matched by
 * position.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  askMypy, isModuleReceiver, mypyCommand, namesOnlyBuiltins, PROBE_IMPORT, probeSource, probeTagOf,
  readRevealedTypes,
  type MypyReading, type MypySite,
} from "../scripts/lib/resolution-python-mypy";

const hasMypy = mypyCommand() !== undefined;

/** A first mypy run over a fresh copy, under a loaded test suite. */
const LIVE_TIMEOUT_MS = 180_000;

describe("probeSource", () => {
  it("wraps a receiver so the call still reads as a call, on the same line", () => {
    const source = "def f(x: Config) -> int:\n    return x.size()\n";
    const start = source.indexOf("x.size") ;
    const probed = probeSource(source, [{ id: 7, start, end: start + 1 }]);

    expect(probed.split("\n")).toHaveLength(source.split("\n").length + 1);
    expect(probed).toContain(`reveal_type((${probeTagOf(7)}, x))[1].size()`);
  });

  it("puts the import after a docstring and after `from __future__`, which must come first", () => {
    const source = [
      '"""What this module is for.',
      "",
      'Still the docstring.',
      '"""',
      "from __future__ import annotations",
      "",
      "import os",
      "",
      "def f(x: Config) -> int:",
      "    return x.size()",
      "",
    ].join("\n");
    const start = source.indexOf("x.size");

    const lines = probeSource(source, [{ id: 1, start, end: start + 1 }]).split("\n");

    expect(lines.indexOf(PROBE_IMPORT)).toBe(5);
    expect(lines[4]).toBe("from __future__ import annotations");
  });

  it("puts the import first when the file opens straight into code", () => {
    const source = "# a comment\nimport os\n";
    expect(probeSource(source, []).split("\n")[0]).toBe(PROBE_IMPORT);
  });

  it("nests the probes of a chain, where one receiver is the start of the next one's", () => {
    // `w.items.first().size()`: `.first()`'s receiver is `w.items`, and
    // `.size()`'s is `w.items.first()` -- two ranges sharing a start.
    const source = "def f(w: W) -> int:\n    return w.items.first().size()\n";
    const start = source.indexOf("w.items");
    const inner = { id: 1, start, end: start + "w.items".length };
    const outer = { id: 2, start, end: start + "w.items.first()".length };

    const expected = `reveal_type((${probeTagOf(2)}, reveal_type((${probeTagOf(1)}, w.items))[1].first()))[1].size()`;
    expect(probeSource(source, [inner, outer])).toContain(expected);
    expect(probeSource(source, [outer, inner])).toContain(expected);
  });
});

describe("readRevealedTypes", () => {
  it("reads a site's id out of the note rather than off its line and column", () => {
    // Captured from mypy 1.x. The two notes share a line; without the tag the
    // second would not be distinguishable, and if their types matched mypy
    // would have printed only one of them.
    const output = [
      'app.py:7:24: note: Revealed type is "tuple[Literal[1], pkg.model.Match]"',
      'app.py:7:64: note: Revealed type is "tuple[Literal[2], builtins.str]"',
      'app.py:9:1: error: Name "_run" already defined  [no-redef]',
      'app.py:12:5: note: By default the bodies of untyped functions are not checked',
    ].join("\n");

    expect(readRevealedTypes(output)).toEqual(new Map([[1, "pkg.model.Match"], [2, "builtins.str"]]));
  });

  it("keeps a generic type whole, brackets and all", () => {
    const output = 'a.py:3:9: note: Revealed type is "tuple[Literal[8], builtins.list[pkg.model.Match]]"';
    expect(readRevealedTypes(output).get(8)).toBe("builtins.list[pkg.model.Match]");
  });

  it("takes an untyped body's answer, which is the whole reason the run needs --check-untyped-defs", () => {
    // Without that flag mypy does not check an unannotated function's body and
    // reveals a bare `Any` -- no tuple, no tag, so the site cannot even be
    // identified. With it, the tag survives and the answer is honest.
    expect(readRevealedTypes('a.py:6: note: Revealed type is "Any"').size).toBe(0);
    expect(readRevealedTypes('a.py:6: note: Revealed type is "tuple[Literal[3], Any]"').get(3)).toBe("Any");
  });
});

describe("namesOnlyBuiltins", () => {
  it("recognises the types no file in a repo can declare", () => {
    for (const revealed of ["str", "int", "None", "dict[Any, Any]", "list[graphify.build.Node]", "str | Any", "tuple[int, str]"]) {
      expect(namesOnlyBuiltins(revealed), revealed).toBe(true);
    }
  });

  it("does not claim a repo type is a builtin, whatever it is wrapped in", () => {
    for (const revealed of ["graphify.build.Node", "graphify.ids.NodeId", "def (x: int) -> str"]) {
      expect(namesOnlyBuiltins(revealed), revealed).toBe(false);
    }
  });

  it("reads the outermost type only, which is the one a declaring file is about", () => {
    // A `list` of repo objects is declared in typeshed, not in the repo, so an
    // answer naming a repo file for it is about the wrong type either way.
    expect(namesOnlyBuiltins("list[graphify.build.Node]")).toBe(true);
    expect(namesOnlyBuiltins("graphify.build.Index[str]")).toBe(false);
  });
});

describe("isModuleReceiver", () => {
  it("recognises a module used as a receiver, where both answers are right", () => {
    // `import graphify.extract as extract_mod; extract_mod.extract(...)`.
    // mypy types the receiver `types.ModuleType`; pyright names the module's
    // own file. Neither is wrong, and a board would want pyright's.
    expect(isModuleReceiver("types.ModuleType")).toBe(true);
    expect(isModuleReceiver("Module")).toBe(true);
  });

  it("does not excuse an ordinary type", () => {
    expect(isModuleReceiver("graphify.extract.Extractor")).toBe(false);
    expect(isModuleReceiver("str")).toBe(false);
  });
});

describe.skipIf(!hasMypy)("askMypy, against a real package", () => {
  let tree: string;
  let work: string;
  let reading: MypyReading;
  const sites: MypySite[] = [];
  /** `find` locates the site; `receiver` is the part of it that is the receiver. */
  const at = (relative: string, find: string, occurrence = 0, receiver = find): number => {
    const file = path.join(tree, relative);
    const source = readFileSync(file, "utf8");
    let start = -1;
    for (let i = 0; i <= occurrence; i++) start = source.indexOf(find, start + 1);
    if (start < 0) throw new Error(`fixture bug: ${find} #${occurrence} not in ${relative}`);
    const id = sites.length;
    sites.push({ id, file, start, end: start + receiver.length });
    return id;
  };
  const write = (relative: string, contents: string) => {
    const full = path.join(tree, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, contents);
  };

  let annotated: number, field: number, chain: number, fromCall: number,
    inUntyped: number, builtin: number, unresolved: number, inSilentModule: number, functionLocal: number;

  beforeAll(async () => {
    tree = realpathSync(mkdtempSync(path.join(os.tmpdir(), "mypy-referee-tree-")));
    work = mkdtempSync(path.join(os.tmpdir(), "mypy-referee-work-"));
    write("pkg/__init__.py", "");
    write("pkg/kinds.py", [
      "class Kind:",
      "    def label(self) -> str:",
      "        return 'k'",
      "",
    ].join("\n"));
    write("pkg/model.py", [
      '"""The model, whose docstring must not push the import above it."""',
      "from __future__ import annotations",
      "",
      "from pkg.kinds import Kind",
      "",
      "",
      "class Match:",
      "    def __init__(self, n: int) -> None:",
      "        self.n = n",
      "",
      "    def size(self) -> int:",
      "        return self.n",
      "",
      "",
      "def make() -> Match:",
      "    return Match(1)",
      "",
      "",
      "def kind_of(m: Match) -> Kind:",
      "    return Kind()",
      "",
    ].join("\n"));
    write("pkg/app.py", [
      "from pkg.kinds import Kind",
      "from pkg.model import Match, make",
      "",
      "",
      "class Holder:",
      "    def __init__(self) -> None:",
      "        self.items: list[Match] = [make()]",
      "        self.name = 'x'",
      "",
      "    def go(self, first: Match, k: Kind) -> int:",
      "        return first.size() + self.items[0].size() + make().size() + self.name.count('x') + len(k.label())",
      "",
      "",
      "def untyped(h):",
      "    got = make()",
      "    return got.size() + h.go(make(), None)",
      "",
      "",
      "def local_factory() -> int:",
      "    class Local:",
      "        def ping(self) -> int:",
      "            return 1",
      "",
      "    return Local().ping()",
      "",
    ].join("\n"));
    annotated = at("pkg/app.py", "first", 1);
    field = at("pkg/app.py", "self.items[0]");
    chain = at("pkg/app.py", "make()", 1);
    builtin = at("pkg/app.py", "self.name", 1);
    inUntyped = at("pkg/app.py", "got", 1);
    unresolved = at("pkg/app.py", "h.go", 0, "h");
    inSilentModule = at("pkg/app.py", "k.label", 0, "k");
    functionLocal = at("pkg/app.py", "Local().ping", 0, "Local()");
    fromCall = at("pkg/model.py", "self.n", 1);
    reading = await askMypy(tree, [path.join(tree, "pkg/app.py"), path.join(tree, "pkg/model.py")], sites, { workDir: work });
  }, LIVE_TIMEOUT_MS);

  afterAll(() => {
    if (tree) rmSync(tree, { recursive: true, force: true });
    if (work) rmSync(work, { recursive: true, force: true });
  });

  it("names the type and the file it is declared in, across modules", () => {
    expect(reading.answers.get(annotated)?.revealed).toBe("pkg.model.Match");
    expect(reading.answers.get(annotated)?.declaration).toBe(path.join(tree, "pkg/model.py"));
  });

  it("types a field, a chain and a value out of a call, which the text alone cannot", () => {
    expect(reading.answers.get(field)?.revealed).toBe("pkg.model.Match");
    expect(reading.answers.get(chain)?.revealed).toBe("pkg.model.Match");
    // mypy 2.3 prints a builtin unqualified, and only a builtin.
    expect(reading.answers.get(fromCall)?.revealed).toBe("int");
  });

  it("answers inside a function nobody annotated, which mypy skips unless asked", () => {
    expect(reading.answers.get(inUntyped)?.revealed).toBe("pkg.model.Match");
    expect(reading.answers.get(inUntyped)?.declaration).toBe(path.join(tree, "pkg/model.py"));
  });

  it("gives a builtin no declaring file in the tree, rather than inventing one", () => {
    expect(reading.answers.get(builtin)?.revealed).toBe("str");
    expect(reading.answers.get(builtin)?.declaration).toBeUndefined();
  });

  it("says Any where it has no idea, rather than withholding the site", () => {
    expect(reading.answers.get(unresolved)?.revealed).toBe("Any");
  });

  it("names a module that holds no probe of its own, which the file list never mentions", () => {
    // `pkg/kinds.py` has no receiver site, so it is not in the list of files
    // handed to mypy. Indexing only those files resolved `pkg.kinds.Kind` to
    // the nearest package instead -- a wrong file rather than a missing one.
    expect(reading.answers.get(inSilentModule)?.revealed).toBe("pkg.kinds.Kind");
    expect(reading.answers.get(inSilentModule)?.declaration).toBe(path.join(tree, "pkg/kinds.py"));
  });

  it("names the file of a class declared inside a function, which mypy prints with its line", () => {
    // mypy spells a function-local class `pkg.app.Local@13`. Read as a dotted
    // name, the `@13` matches no module, so the class came back declared
    // outside the tree -- a disagreement with pyright that was this referee's
    // own misreading (graphify's `tests.test_llm_backends._SubPath@229`).
    expect(reading.answers.get(functionLocal)?.revealed).toMatch(/^pkg\.app\.Local@\d+$/);
    expect(reading.answers.get(functionLocal)?.declaration).toBe(path.join(tree, "pkg/app.py"));
  });

  it("leaves the tree it measured untouched", () => {
    expect(readFileSync(path.join(tree, "pkg/app.py"), "utf8")).not.toContain("reveal_type");
    expect(readFileSync(path.join(tree, "pkg/model.py"), "utf8")).not.toContain(PROBE_IMPORT);
  });
});
