/**
 * The four questions a red is put to before it is shown (#393), asked of
 * pyright. One case per shape #373 found red on correct Python, each with the
 * answer that would have kept it quiet, and a control per question whose
 * honest answer is "no".
 *
 * Asked through the batch resolvers the live check uses, so the paths and the
 * keys are the ones a check would read back. The readers of pyright's printed
 * text are tested on their own at the top, without a server.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { partsInclude, type DeclaredAt, type TypeParts } from "../src/engine/compiler-questions";
import type { ClosedBodyReferee, DriftReport } from "../src/engine/drift";
import {
  fitsKey, refereePool, resolvePythonFits, resolvePythonImports, resolvePythonMembers, resolvePythonTypeParts,
  type QuestionQuery, type RefereePool,
} from "../src/engine/referee-pool";
import { liveRefereePool, refereedCheckLive } from "../src/engine/referee-live";
import {
  createPyrightLspReferee, hoverType, pythonTypeNames, relativeModule, typeVarBound,
} from "../src/engine/referee-python-lsp";

describe("reading what pyright prints", () => {
  it.each([
    ["(variable) engine: Engine | None", "Engine | None"],
    ["(parameter) n: S@run", "S@run"],
    ["(property) prop: (self: Self@Plain) -> Engine", "Engine"],
    ["(property) __class__: type[Plain]", "type[Plain]"],
    ["(class) Plain", "Plain"],
    ["(function) def make(size: int) -> Wheel", "(size: int) -> Wheel"],
  ])("the type in %j", (hover, type) => {
    expect(hoverType(hover)).toBe(type);
  });

  it("names a union's members, a generic's arguments and Self's class", () => {
    expect(pythonTypeNames("dict[str, Wheel] | type[Self@Plain] | None")).toEqual({
      names: ["dict", "str", "Wheel", "type", "Plain", "None"], typeVars: [], whole: true,
    });
  });

  it("leaves a type variable to be bounded, and Unknown partial", () => {
    expect(pythonTypeNames("list[S@Holder] | Unknown")).toEqual({ names: ["list"], typeVars: ["S"], whole: false });
  });

  it("drops a parameter's name and a string literal", () => {
    expect(pythonTypeNames("(self: Self@Plain, mode: Literal['fast']) -> Engine").names).toEqual(["Plain", "Literal", "Engine"]);
  });

  it.each([
    ['S = TypeVar("S", bound=Named)', "S", "Named"],
    ["S = typing.TypeVar('S', bound='Named')", "S", "Named"],
    ['T = TypeVar("T", Engine, Wheel)', "T", "Engine | Wheel"],
    ['T = TypeVar("T", Engine, Wheel)\nfoo(a, b)', "T", "Engine | Wheel"],
    ['S = TypeVar(\n    "S",\n    bound=Named,\n)', "S", "Named"],
    ["class Holder[S: Seat]:", "S", "Seat"],
    ["def run[N: (Engine, Wheel)](n: N) -> N:", "N", "Engine, Wheel"],
  ])("the bound in %j", (declaration, name, bound) => {
    expect(typeVarBound(declaration, name)).toBe(bound);
  });

  it("has no bound for a bare TypeVar", () => {
    expect(typeVarBound('T = TypeVar("T")', "T")).toBeUndefined();
  });

  it.each([
    ["/r/pkg", "/r/pkg/car.py", ".car"],
    ["/r/pkg", "/r/pkg/__init__.py", "."],
    ["/r/pkg/a", "/r/pkg/b/parts.py", "..b.parts"],
    ["/r", "/r/pkg/sub/__init__.py", ".pkg.sub"],
  ])("from %s, %s is imported as %s", (directory, file, module) => {
    expect(relativeModule(directory, file)).toBe(module);
  });
});

let repo: string;
let pool: RefereePool<Awaited<ReturnType<typeof createPyrightLspReferee>>>;
const sources = new Map<string, string>();

function write(relative: string, contents: string): void {
  const full = path.join(repo, relative);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, contents);
  sources.set(relative, contents);
}

/** The range of `mark` inside the `nth` occurrence of `needle`. */
function at(file: string, needle: string, mark = needle, nth = 0): { start: number; end: number } {
  const text = sources.get(file)!;
  let from = -1;
  for (let i = 0; i <= nth; i += 1) {
    from = text.indexOf(needle, from + 1);
    if (from < 0) throw new Error(`fixture bug: ${JSON.stringify(needle)} not in ${file}`);
  }
  const start = from + needle.indexOf(mark);
  return { start, end: start + mark.length };
}

function line(file: string, needle: string): number {
  const text = sources.get(file)!;
  return text.slice(0, text.indexOf(needle)).split("\n").length;
}

const PARTS = "pkg/parts.py";
const CAR = "pkg/car.py";
const place = (needle: string, name: string): { name: string; at: DeclaredAt } =>
  ({ name, at: { file: PARTS, line: line(PARTS, needle) } });

beforeAll(() => {
  repo = mkdtempSync(path.join(os.tmpdir(), "compiler-questions-py-"));
  write("pkg/__init__.py", "");
  write(PARTS, [
    "from typing import Protocol",
    "",
    "",
    "class Engine:",
    "    def __eq__(self, other: object) -> bool:",
    "        return True",
    "",
    "    def __str__(self) -> str:",
    '        return "engine"',
    "",
    "",
    "class Wheel:",
    "    pass",
    "",
    "",
    "class Named(Protocol):",
    "    def name(self) -> str: ...",
    "",
  ].join("\n"));
  write(CAR, [
    "from typing import Generic, TypeVar",
    "from .parts import Engine, Named, Wheel",
    "",
    'S = TypeVar("S", bound=Named)',
    'T = TypeVar("T")',
    "",
    "",
    "class Plain:",
    "    def __init__(self) -> None:",
    "        self.wheels = [Wheel()]",
    "        self.count = 0",
    "",
    "    @property",
    "    def prop(self) -> Engine:",
    "        return Engine()",
    "",
    "    def clone(self) -> 'Plain':",
    "        return self.__class__()",
    "",
    "",
    "class Later:",
    "    def __init__(self) -> None:",
    "        self.engine = None",
    "",
    "    def start(self) -> None:",
    "        self.engine = Engine()",
    "",
    "",
    "class Holder(Generic[S]):",
    "    def __init__(self, seat: S) -> None:",
    "        self.seat = seat",
    "",
    "",
    "class Dog:",
    "    def name(self) -> str:",
    '        return "dog"',
    "",
    "",
    "def run(n: S) -> S:",
    "    return n",
    "",
    "",
    "def anything(t: T) -> T:",
    "    return t",
    "",
    "",
    "def compare(a: Engine, b: Engine, w: Wheel) -> object:",
    "    return a == b, str(a), w == w",
    "",
  ].join("\n"));
  pool = refereePool();
});

afterAll(() => {
  pool?.close();
  rmSync(repo, { recursive: true, force: true });
});

const partsOf = async (queries: Array<[string, { start: number; end: number }]>): Promise<Array<TypeParts | undefined>> => {
  const asked: QuestionQuery[] = queries.map(([file, range]) => ({ file, at: range }));
  const answers = await resolvePythonTypeParts(repo, asked, pool);
  return asked.map((one) => answers.cache.get(one.file, one.at));
};

describe("typePartsAt, asked of pyright", () => {
  it("answers every shape #373 found red, and says no only on a whole type", async () => {
    const [later, wheels, run, seat, prop, klass, count, anything] = await partsOf([
      [CAR, at(CAR, "self.engine = None", "engine")],
      [CAR, at(CAR, "self.wheels", "wheels")],
      [CAR, at(CAR, "run(n: S)", "n")],
      [CAR, at(CAR, "self.seat", "seat")],
      [CAR, at(CAR, "def prop", "prop")],
      [CAR, at(CAR, "self.__class__()", "__class__")],
      [CAR, at(CAR, "self.count", "count")],
      [CAR, at(CAR, "anything(t: T)", "t")],
    ]);
    // #378: a field set to None in __init__ and to an Engine later holds an Engine.
    expect(partsInclude(later, place("class Engine", "Engine"))).toBe(true);
    expect(partsInclude(wheels, place("class Wheel", "Wheel"))).toBe(true);
    // #380: a type variable is its bound, on a parameter and on a field.
    expect(partsInclude(run, place("class Named", "Named"))).toBe(true);
    expect(partsInclude(seat, place("class Named", "Named"))).toBe(true);
    // #378: a property is the value it returns.
    expect(partsInclude(prop, place("class Engine", "Engine"))).toBe(true);
    // #387: self.__class__ is the class itself.
    expect(klass?.parts.map((one) => one.name)).toContain("Plain");
    expect(partsInclude(count, place("class Engine", "Engine"))).toBe(false);
    expect(partsInclude(anything, place("class Engine", "Engine"))).toBeUndefined();
  }, 120_000);
});

describe("fitsAt, asked of pyright (#379)", () => {
  it("says a class fits a Protocol it satisfies without naming it, and not one it does not", async () => {
    const named = { file: PARTS, line: line(PARTS, "class Named") };
    const asked: QuestionQuery[] = [
      { file: CAR, at: at(CAR, "class Dog", "Dog"), extra: fitsKey(named) },
      { file: PARTS, at: at(PARTS, "class Engine", "Engine"), extra: fitsKey(named) },
    ];
    const answers = await resolvePythonFits(repo, asked, pool);
    expect(asked.map((one) => answers.cache.get(one.file, one.at, one.extra))).toEqual([true, false]);
  }, 120_000);
});

describe("importTargetAt, asked of pyright", () => {
  it("follows a relative import to its file", async () => {
    const asked: QuestionQuery[] = [{ file: CAR, at: at(CAR, "from .parts", ".parts") }];
    const answers = await resolvePythonImports(repo, asked, pool);
    expect(answers.cache.get(CAR, asked[0]!.at)).toEqual({ file: PARTS });
  }, 120_000);

  it("places the standard library outside the repository", async () => {
    const asked: QuestionQuery[] = [{ file: CAR, at: at(CAR, "from typing", "typing") }];
    const answers = await resolvePythonImports(repo, asked, pool);
    expect(answers.cache.get(CAR, asked[0]!.at)).toBe("outside");
  }, 120_000);
});

describe("memberAt, asked of pyright (#384)", () => {
  it("finds the dunder an operator or a builtin runs, and places object's own outside", async () => {
    const asked: QuestionQuery[] = [
      { file: CAR, at: at(CAR, "a == b", "a"), extra: "__eq__" },
      { file: CAR, at: at(CAR, "str(a)", "a"), extra: "__str__" },
      { file: CAR, at: at(CAR, "w == w", "w"), extra: "__eq__" },
    ];
    const answers = await resolvePythonMembers(repo, asked, pool);
    const found = asked.map((one) => answers.cache.get(one.file, one.at, one.extra));
    expect(found[0]).toEqual([{ file: PARTS, line: line(PARTS, "def __eq__") }]);
    expect(found[1]).toEqual([{ file: PARTS, line: line(PARTS, "def __str__") }]);
    expect(found[2]).toEqual(["outside"]);
  }, 120_000);
});

describe("the live check passes the questions through", () => {
  it("records a Python question on the first pass and answers it on the real one", async () => {
    // A first pass that stopped on something a compiler could settle, so the servers are asked.
    const unsettled = { claims: {
      callsWithheld: {}, callsNotClosed: {}, buildsNotClosed: {}, buildsUnsettled: 0, endsUnsettled: 1,
      callsCompilable: 0, buildsCompilable: 0,
    } } as unknown as DriftReport;
    let seen: TypeParts | undefined;
    const live = liveRefereePool();
    try {
      await refereedCheckLive(repo, (referee?: ClosedBodyReferee) => {
        if (referee) seen = referee.typePartsAt?.(CAR, at(CAR, "self.wheels", "wheels"));
        return unsettled;
      }, { pool: live, compiler: false });
    } finally {
      live.close();
    }
    expect(partsInclude(seen, place("class Wheel", "Wheel"))).toBe(true);
  }, 120_000);
});
