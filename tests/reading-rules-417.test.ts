/**
 * Four reading rules that ended a check before it looked (#417).
 *
 * Each one kept a wrong arrow from ever going red, whatever the code said.
 * Every rule was loosened to the principle under it, in every language that
 * has the shape, and each test below is either a wrong arrow that now goes
 * red or correct code the old rule was protecting, which must stay quiet.
 *
 *   1. An end anchored at a parameter, a loop variable or a Rust `let` was
 *      no declaration at all, so "only a type can be made" was never asked.
 *   2. A "makes" check stopped when the body named the class anywhere --
 *      including its own declaration, and the type of a parameter it is
 *      handed.
 *   3. A Python "makes" check stopped when the far end calls the near end
 *      and the near end is a function, which is no construction.
 *   4. A local holding one of several functions, all written down
 *      (`DEV ? f : NOOP`), was read as a call on an unknown value.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { emptyBoard } from "../src/engine/board-file";
import type { ArrowClaim } from "../src/engine/claim";
import { createDiagram } from "../src/engine/diagram";
import { ACCUSING_EDGE_KINDS, checkDrift, type ClosedBodyReferee, type DriftReport, type Workspace } from "../src/engine/drift";
import { initEngine } from "../src/engine/parse";
import { partsOf } from "../src/engine/parts";
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

async function checked(
  claim: ArrowClaim, fromRef: string, toRef: string, files: Record<string, string>,
  referee?: ClosedBodyReferee,
): Promise<DriftReport> {
  const { board } = await createDiagram(emptyBoard(), {
    name: "arch",
    nodes: [
      { id: "from", label: "from", ref: fromRef },
      { id: "to", label: "to", ref: toRef },
    ],
    edges: [{ from: "from", to: "to", claim }],
  });
  return checkDrift(board, fakeWorkspace(files), { edges: true, ...(referee ? { closedBodyReferee: referee } : {}) });
}

const ACCUSING = new Set<string>(ACCUSING_EDGE_KINDS);
const reds = (report: DriftReport) => report.edges.filter((finding) => ACCUSING.has(finding.kind));
const kinds = (report: DriftReport) => reds(report).map((finding) => finding.kind);

const py = (files: Record<string, string>) => ({ "src/__init__.py": "", ...files });
const ts = (files: Record<string, string>) => ({ "tsconfig.json": "{}", ...files });
const rust = (files: Record<string, string>) => ({
  "Cargo.toml": "[package]\nname = \"demo\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
  ...files,
});

describe("rule 1: a parameter, a loop variable or a `let` is not a type", () => {
  const MAKER = "def build():\n    return 1\n";

  it("calls a \"makes\" arrow into **kwargs wrong (httpx's Request -> kwargs)", async () => {
    const report = await checked("builds", "src/maker.py#build", "src/url.py#kwargs", py({
      "src/maker.py": MAKER,
      "src/url.py": "class URL:\n    def __init__(self, url='', **kwargs: typing.Any) -> None:\n        self.kw = kwargs\n",
    }));
    expect(kinds(report)).toEqual(["end-lacks-part"]);
    expect(reds(report)[0]!.detail).toContain("a parameter");
  });

  it("calls a \"makes\" arrow into a typed parameter wrong (poetry's level: str)", async () => {
    const report = await checked("builds", "src/maker.py#build", "src/repo.py#level", py({
      "src/maker.py": MAKER,
      "src/repo.py": "def _log(msg, level: str = 'info'):\n    print(level)\n\ndef age(*, level: str):\n    return level\n",
    }));
    expect(kinds(report)).toEqual(["end-lacks-part"]);
  });

  it("calls a \"makes\" arrow into a loop variable wrong (poetry's for operation in group)", async () => {
    const report = await checked("builds", "src/maker.py#build", "src/run.py#operation", py({
      "src/maker.py": MAKER,
      "src/run.py": "def run(group):\n    for operation in group:\n        operation.go()\n",
    }));
    expect(kinds(report)).toEqual(["end-lacks-part"]);
    expect(reds(report)[0]!.detail).toContain("a value");
  });

  it("calls a \"makes\" arrow into a TypeScript parameter wrong", async () => {
    const report = await checked("builds", "src/maker.ts#build", "src/run.ts#options", ts({
      "src/maker.ts": "export function build() { return 1; }\n",
      "src/run.ts": "export function run(options: RunOptions) { return options.x; }\n",
    }));
    expect(kinds(report)).toEqual(["end-lacks-part"]);
  });

  it("calls a \"makes\" arrow into a Rust parameter, `let` and loop variable wrong", async () => {
    for (const name of ["config", "count", "item"]) {
      const report = await checked("builds", "src/lib.rs#build", `src/run.rs#${name}`, rust({
        "src/lib.rs": "mod run;\npub fn build() -> u8 { 1 }\n",
        "src/run.rs": "pub fn run(config: &Config) -> usize {\n    let count = config.items.len();\n    for item in &config.items { item.go(); }\n    count\n}\n",
      }));
      expect(kinds(report), name).toEqual(["end-lacks-part"]);
    }
  });

  it("stays quiet when the same name is also a class in that file", async () => {
    const report = await checked("builds", "src/maker.py#build", "src/kinds.py#Level", py({
      "src/maker.py": "from .kinds import Level\n\ndef build():\n    return Level()\n",
      "src/kinds.py": "class Level:\n    pass\n\ndef pick(Level):\n    return Level\n",
    }));
    expect(kinds(report)).toEqual([]);
  });

  it("still calls a declared value wrong when a parameter elsewhere shares its name (flask's ctx)", async () => {
    // The parameter is somebody else's `ctx`; the box means the one declared.
    const report = await checked("calls", "src/app.py#run", "src/app.py#ctx", py({
      "src/app.py": "ctx = 0\n\ndef push(ctx):\n    return ctx\n\ndef run():\n    return push(1)\n",
    }));
    expect(kinds(report)).toEqual(["end-lacks-part"]);
  });

  it("stays quiet when the file imports the name a parameter shadows", async () => {
    // A box at `level` may well mean the imported class; the parameter is no evidence.
    const report = await checked("builds", "src/maker.py#build", "src/repo.py#Level", py({
      "src/maker.py": MAKER,
      "src/kinds.py": "class Level:\n    pass\n",
      "src/repo.py": "from .kinds import Level\n\ndef log(msg, Level: str = 'info'):\n    print(Level)\n",
    }));
    expect(kinds(report)).toEqual([]);
  });

  it("stays quiet on a \"calls\" arrow into a parameter that may hold a function", async () => {
    // `callback` is called right there; nothing says it is not a function.
    const report = await checked("calls", "src/run.py#run", "src/run.py#callback", py({
      "src/run.py": "def run(callback):\n    return callback()\n",
    }));
    expect(kinds(report)).toEqual([]);
  });

  it("no longer reads a loop's iterable as the loop variable's value", () => {
    /*
     * `for (const fn of new Set(fns))` once read `fn` as the Set it loops
     * over -- a construction, so a value nothing can call -- and a correct
     * "calls fn" arrow would have gone red.
     */
    const parts = partsOf("function go(fns) { for (const fn of new Set(fns)) fn(); }\n", "fn", "ts");
    expect(parts?.callable).toBe("unsure");
    expect(parts?.type).toBe("lacks");
  });
});

describe("rule 2: naming the class is not making one", () => {
  const INCOMPAT = "class Incompatibility:\n    def __init__(self, terms):\n        self.terms = terms\n";
  const SOLVER = "from .helpers import note\nfrom .incompat import Incompatibility\n\n";
  const files = (body: string, extra: Record<string, string> = {}) => py({
    "src/incompat.py": INCOMPAT,
    "src/helpers.py": "def note(x):\n    return x\n",
    "src/solver.py": SOLVER + body,
    ...extra,
  });
  const ask = (body: string, extra?: Record<string, string>) =>
    checked("builds", "src/solver.py#propagate", "src/incompat.py#Incompatibility", files(body, extra));

  it("calls it wrong when the class is only the type of a parameter (poetry's _propagate_incompatibility)", async () => {
    const report = await ask("def propagate(incompatibility: Incompatibility) -> str | None:\n    note(incompatibility.terms)\n    return None\n");
    expect(kinds(report)).toEqual(["builds-refuted"]);
  });

  /*
   * What the rule was protecting (#362): a body that may make one without a
   * call spelt as the class. Each of these names the class, and each must
   * stay quiet.
   */
  it("stays quiet when the parameter is the class itself, type[Incompatibility]", async () => {
    const report = await ask("def propagate(factory: type[Incompatibility]):\n    return factory([])\n");
    expect(kinds(report)).toEqual([]);
  });

  it("stays quiet when a class parameter is handed on, note(factory) with factory: type[Incompatibility]", async () => {
    // Handing the class to something that may call it, as map(Incompatibility, xs) does by name.
    const report = await ask("def propagate(factory: type[Incompatibility]):\n    return note(factory)\n");
    expect(kinds(report)).toEqual([]);
  });

  it("stays quiet when the parameter makes one, Callable[..., Incompatibility]", async () => {
    const report = await ask("def propagate(make: Callable[[], Incompatibility]):\n    note(make())\n");
    expect(kinds(report)).toEqual([]);
  });

  it("stays quiet when the routine says it returns one", async () => {
    const report = await ask("def propagate(x) -> Incompatibility:\n    return note(x)\n");
    expect(kinds(report)).toEqual([]);
  });

  it("stays quiet when the class is handed on, map(Incompatibility, xs)", async () => {
    const report = await ask("def propagate(xs: list[Incompatibility]):\n    return list(map(Incompatibility, xs))\n");
    expect(kinds(report)).toEqual([]);
  });

  it("stays quiet when a local holds it with a type, i: Incompatibility = note(x)", async () => {
    const report = await ask("def propagate(x):\n    i: Incompatibility = note(x)\n    return i\n");
    expect(kinds(report)).toEqual([]);
  });

  it("is still green when the body makes one, whatever else it names", async () => {
    const report = await ask("def propagate(other: Incompatibility):\n    return Incompatibility(other.terms)\n");
    expect(kinds(report)).toEqual([]);
    expect(report.claims.buildsConfirmed).toBe(1);
  });

  it("still counts a parameter's type for a \"calls\" arrow into the class: iterating it runs its methods", async () => {
    // `for x in r` runs Range.__iter__ with no call written (#373's probe, in Python).
    const report = await checked("calls", "src/use.py#loop", "src/rng.py#Range", py({
      "src/rng.py": "class Range:\n    def __iter__(self):\n        return iter([1])\n\n    def entries(self):\n        return [1]\n",
      "src/helpers.py": "def note(x):\n    return x\n",
      "src/use.py": "from .helpers import note\nfrom .rng import Range\n\ndef loop(r: Range):\n    n = 0\n    for x in r:\n        n = note(x)\n    return n\n",
    }));
    expect(kinds(report)).toEqual([]);
  });

  describe("TypeScript", () => {
    const WIDGET = "export class Widget { x = 0; go() {} }\n";
    const tsAsk = (factory: string) => checked("builds", "src/factory.ts#build", "src/widget.ts#Widget", ts({
      "src/factory.ts": "import { Widget } from \"./widget\";\nimport { Other } from \"./other\";\n" + factory,
      "src/widget.ts": WIDGET,
      "src/other.ts": "export class Other { go() {} }\n",
    }));

    it("calls it wrong when Widget is only a parameter's type", async () => {
      expect(kinds(await tsAsk("export function build(w: Widget) { return new Other(); }\n"))).toEqual(["builds-refuted"]);
    });

    it("stays quiet on a factory parameter, make: () => Widget", async () => {
      expect(kinds(await tsAsk("export function build(make: () => Widget) { new Other(); return make(); }\n"))).toEqual([]);
    });

    it("stays quiet on a class parameter, ctor: typeof Widget", async () => {
      expect(kinds(await tsAsk("export function build(ctor: typeof Widget) { new Other(); return new ctor(); }\n"))).toEqual([]);
    });

    it("stays quiet on a constructor type, ctor: new () => Widget", async () => {
      expect(kinds(await tsAsk("export function build(ctor: new () => Widget) { return new ctor(); }\n"))).toEqual([]);
    });
  });

  it("is still green on a class that makes itself, now that its own name is not a mention", async () => {
    const report = await checked("builds", "src/node.py#Node", "src/node.py#Node", py({
      "src/node.py": "class Node:\n    def clone(self):\n        return Node()\n",
    }));
    expect(kinds(report)).toEqual([]);
    expect(report.claims.buildsConfirmed).toBe(1);
  });
});

describe("rule 3: a function the far end calls is still asked whether it makes one", () => {
  const QUERY = (method: string) => "from .helpers import note\n\n"
    + "class QueryParams:\n    def __init__(self, items):\n        self._items = items\n\n"
    + "    def __eq__(self, other):\n        return self.multi_items() == other\n\n" + method;

  it("calls it wrong when the function makes nothing (httpx's multi_items -> QueryParams)", async () => {
    const report = await checked("builds", "src/urls.py#multi_items", "src/urls.py#QueryParams", py({
      "src/helpers.py": "def note(x):\n    return x\n",
      "src/urls.py": QUERY("    def multi_items(self):\n        return note(self._items)\n"),
    }));
    expect(kinds(report)).toEqual(["builds-refuted"]);
  });

  it("stays quiet when the function makes one through something it cannot read", async () => {
    const report = await checked("builds", "src/urls.py#multi_items", "src/urls.py#QueryParams", py({
      "src/helpers.py": "def note(x):\n    return x\n",
      "src/urls.py": QUERY("    def multi_items(self):\n        return KINDS['q'](self._items)\n"),
    }));
    expect(kinds(report)).toEqual([]);
  });

  it("is still backwards when the near end is a class the far end makes", async () => {
    const report = await checked("builds", "src/factory.py#Maker", "src/widget.py#Widget", py({
      "src/factory.py": "class Maker:\n    def run(self):\n        return 1\n",
      "src/widget.py": "from .factory import Maker\n\nclass Widget:\n    def make(self):\n        return Maker()\n",
    }));
    expect(kinds(report)).toEqual(["builds-backwards"]);
  });
});

describe("rule 4: a local chosen by a condition is followed down every branch", () => {
  const SCHEDULER = (pick: string, extra = "") =>
    "import { NOOP } from \"./shared\";\n"
    + "export function checkRecursive(job: number) { return job > 1; }\n"
    + "export function nextTick() { return 1; }\n"
    + "export function flushPost() { return 2; }\n"
    + `export function flushJobs(job: number) {\n${pick}\n  check(job);\n  flushPost();\n}\n${extra}`;
  const files = (pick: string) => ts({
    "src/scheduler.ts": SCHEDULER(pick),
    "src/shared.ts": "export const NOOP = () => {};\n",
  });
  const ask = (pick: string) => checked("calls", "src/scheduler.ts#flushJobs", "src/scheduler.ts#nextTick", files(pick));

  it("calls a wrong arrow wrong: DEV ? (j) => checkRecursive(j) : NOOP (vue's flushJobs -> nextTick)", async () => {
    const report = await ask("  const check = DEV ? (j: number) => checkRecursive(j) : NOOP;");
    expect(kinds(report)).toEqual(["calls-wrong-routine"]);
  });

  it("follows an if/else that assigns it on each side", async () => {
    const report = await ask("  let check;\n  if (DEV) { check = checkRecursive; } else { check = NOOP; }");
    expect(kinds(report)).toEqual(["calls-wrong-routine"]);
  });

  /* The doubts it keeps. */
  it("stays quiet when a branch is the head itself: DEV ? nextTick : NOOP", async () => {
    expect(kinds(await ask("  const check = DEV ? nextTick : NOOP;"))).toEqual([]);
  });

  it("stays quiet when a branch is computed: DEV ? table[k] : NOOP", async () => {
    expect(kinds(await ask("  const check = DEV ? table[k] : NOOP;"))).toEqual([]);
  });

  it("stays quiet when a branch is a call's result: DEV ? make() : NOOP", async () => {
    expect(kinds(await ask("  const check = DEV ? make() : NOOP;"))).toEqual([]);
  });

  it("stays quiet when the local is declared in a block the call cannot see", async () => {
    const report = await checked("calls", "src/scheduler.ts#flushJobs", "src/scheduler.ts#nextTick", ts({
      "src/scheduler.ts": "import { NOOP } from \"./shared\";\nexport function nextTick() { return 1; }\n"
        + "export function flushJobs(job: number) {\n  if (DEV) { const check = NOOP; }\n  check(job);\n}\n",
      "src/shared.ts": "export const NOOP = () => {};\n",
    }));
    expect(kinds(report)).toEqual([]);
  });

  it("stays quiet when the local is a parameter with a default: check = NOOP", async () => {
    // The default is one choice; whoever calls can pass any other.
    const report = await checked("calls", "src/scheduler.ts#flushJobs", "src/scheduler.ts#nextTick", ts({
      "src/scheduler.ts": "import { NOOP } from \"./shared\";\nexport function nextTick() { return 1; }\n"
        + "export function flushPost() { return 2; }\n"
        + "export function flushJobs(job: number, check = NOOP) {\n  check(job);\n  flushPost();\n}\n",
      "src/shared.ts": "export const NOOP = () => {};\n",
    }));
    expect(kinds(report)).toEqual([]);
  });

  it("stays quiet when it is reassigned from a parameter", async () => {
    const report = await checked("calls", "src/scheduler.ts#flushJobs", "src/scheduler.ts#nextTick", ts({
      "src/scheduler.ts": "import { NOOP } from \"./shared\";\nexport function nextTick() { return 1; }\n"
        + "export function flushJobs(job: number, given: () => void) {\n  let check = NOOP;\n  check = given;\n  check(job);\n}\n",
      "src/shared.ts": "export const NOOP = () => {};\n",
    }));
    expect(kinds(report)).toEqual([]);
  });

  it("does the same in Python: check = check_recursive if DEV else noop", async () => {
    const report = await checked("calls", "src/sched.py#flush_jobs", "src/sched.py#next_tick", py({
      "src/shared.py": "def noop(*a):\n    return None\n",
      "src/sched.py": "from .shared import noop\n\nDEV = True\n\n"
        + "def check_recursive(job):\n    return job\n\ndef next_tick():\n    return 1\n\n"
        + "def flush_jobs(job):\n    check = check_recursive if DEV else noop\n    check(job)\n",
    }));
    expect(kinds(report)).toEqual(["calls-wrong-routine"]);
  });

  it("stays quiet in Python when a nested function's local shares the name", async () => {
    // `inner`'s `check` is inner's own; the one `flush_jobs` calls is not written here.
    const report = await checked("calls", "src/sched.py#flush_jobs", "src/sched.py#next_tick", py({
      "src/sched.py": "def next_tick():\n    return 1\n\n"
        + "def check_recursive(job):\n    return job\n\n"
        + "def flush_jobs(job):\n    def inner():\n        check = check_recursive\n        return check\n    check(job)\n",
    }));
    expect(kinds(report)).toEqual([]);
  });
});

/*
 * #432. A type written as a use -- given type arguments, or reached through a
 * path -- is not a second declaration of it. And for `@calls` into a class, a
 * parameter of the class's type names it only when the body runs one of the
 * class's methods through it with no call written, and the class declares
 * that method. The quiet cases are each way a value runs one.
 */
describe("#432: a type's use is not a declaration, and a parameter names the class only when it runs it", () => {
  it("calls a \"makes\" arrow wrong when the head's file only casts to the type", async () => {
    const report = await checked("builds", "src/cache.ts#remove", "src/mutation.ts#Mutation", ts({
      "src/cache.ts": "import { Mutation } from \"./mutation\";\nexport function remove(m: Mutation<unknown>) { return m.id; }\n",
      "src/mutation.ts": "export class Mutation<T> {\n  id = 1;\n  run(): T | undefined { return undefined; }\n}\n"
        + "export function same(x: unknown) { return x as Mutation<unknown>; }\n",
    }));
    expect(kinds(report)).toEqual(["builds-refuted"]);
  });

  it("stays quiet when the name really is declared a second way", async () => {
    const report = await checked("builds", "src/cache.ts#remove", "src/mutation.ts#Mutation", ts({
      "src/cache.ts": "import { Mutation } from \"./mutation\";\nexport function remove(m: Mutation) { return m.id; }\n",
      "src/mutation.ts": "export class Mutation {\n  id = 1;\n  run() { return 1; }\n}\nexport interface Mutation { extra?: number }\n",
    }));
    expect(kinds(report)).toEqual([]);
  });

  const loop = (klass: string, body: string) => checked("calls", "src/use.py#loop", "src/rng.py#Range", py({
    "src/rng.py": klass,
    "src/base.py": "class Base:\n    pass\n",
    "src/helpers.py": "def note(x):\n    return x\n",
    "src/use.py": `from .helpers import note\nfrom .rng import Range\n\ndef loop(r: Range):\n${body}`,
  }));
  const PLAIN = "class Range:\n    def entries(self):\n        return [1]\n";
  const withMethod = (method: string) => `class Range:\n    def ${method}(self, *a):\n        return 1\n\n    def entries(self):\n        return [1]\n`;

  it("calls a \"calls\" arrow wrong when the value is only handed on and read from", async () => {
    expect(kinds(await loop(PLAIN, "    note(r)\n    return r.entries\n"))).toEqual(["calls-refuted"]);
  });

  it("calls it wrong when the value is hashed and the class has no __hash__ (poetry's shape)", async () => {
    expect(kinds(await loop(withMethod("__str__"), "    return note({r})\n"))).toEqual(["calls-refuted"]);
  });

  it("stays quiet when the value is formatted and the class has __str__", async () => {
    expect(kinds(await loop(withMethod("__str__"), "    return note(f\"{r}\")\n"))).toEqual([]);
  });

  it("stays quiet when the value is hashed and the class has __hash__", async () => {
    expect(kinds(await loop(withMethod("__hash__"), "    return note({r})\n"))).toEqual([]);
  });

  it("stays quiet when the value is in a list a builtin walks, and the class compares", async () => {
    expect(kinds(await loop(withMethod("__lt__"), "    return note(sorted([r, r]))\n"))).toEqual([]);
  });

  it("stays quiet when the value is used with an operator the class defines", async () => {
    expect(kinds(await loop(withMethod("__add__"), "    return note(r + 1)\n"))).toEqual([]);
  });

  it("stays quiet when the value's truth is tested and the class has __bool__", async () => {
    expect(kinds(await loop(withMethod("__bool__"), "    if r:\n        return note(1)\n    return 0\n"))).toEqual([]);
  });

  it("stays quiet when the value is entered and the class has __enter__", async () => {
    expect(kinds(await loop(withMethod("__enter__"), "    with r:\n        return note(1)\n"))).toEqual([]);
  });

  it("stays quiet when the class names a base, which may hold the method", async () => {
    const based = "from .base import Base\n\nclass Range(Base):\n    def entries(self):\n        return [1]\n";
    expect(kinds(await loop(based, "    return note(f\"{r}\")\n"))).toEqual([]);
  });

  /*
   * Handed to code outside the repository (#412's rule): a library may run
   * any special method the class defines. The language's own routines whose
   * use is known stay precise -- `hash` hashes, it does not format.
   */
  // Where "go to definition" puts `logging.info` and `copy.deepcopy`: the standard library.
  const LIBRARY: ClosedBodyReferee = { resolveReceiver: () => undefined, declarationAt: () => "outside" };
  const handed = (klass: string, body: string) => checked("calls", "src/use.py#loop", "src/rng.py#Range", py({
    "src/rng.py": klass,
    "src/use.py": `import copy\nimport logging\nfrom .rng import Range\n\ndef loop(r: Range):\n${body}`,
  }), LIBRARY);

  it("stays quiet when the value is handed to logging and the class has __str__", async () => {
    expect(kinds(await handed(withMethod("__str__"), "    logging.info(\"%s\", r)\n    return r.entries\n"))).toEqual([]);
  });

  it("stays quiet when the value is deep-copied and the class has __deepcopy__", async () => {
    expect(kinds(await handed(withMethod("__deepcopy__"), "    return copy.deepcopy(r)\n"))).toEqual([]);
  });

  it("stays quiet when the value is handed to a library by keyword", async () => {
    expect(kinds(await handed(withMethod("__str__"), "    logging.info(\"%s\", extra=r)\n    return r.entries\n"))).toEqual([]);
  });

  it("calls it wrong when the value is handed to logging and the class defines no special method", async () => {
    expect(kinds(await handed(PLAIN, "    logging.info(\"%s\", r)\n    return r.entries\n"))).toEqual(["calls-refuted"]);
  });

  it("calls it wrong when a builtin that only hashes is handed a class with only __str__", async () => {
    expect(kinds(await handed(withMethod("__str__"), "    return hash(r)\n"))).toEqual(["calls-refuted"]);
  });

  it("stays quiet when a TypeScript value is handed to a library and the class has toString", async () => {
    const report = await checked("calls", "src/use.ts#loop", "src/rng.ts#Range", ts({
      "src/rng.ts": "export class Range {\n  toString() { return \"r\"; }\n  entries() { return [1]; }\n}\n",
      "src/use.ts": "import { Range } from \"./rng\";\nexport function loop(r: Range) { return encodeURIComponent(r as unknown as string); }\n",
    }));
    expect(kinds(report)).toEqual([]);
  });

  it("stays quiet when a TypeScript value is spread and the class is iterable", async () => {
    const report = await checked("calls", "src/use.ts#loop", "src/rng.ts#Range", ts({
      "src/rng.ts": "export class Range {\n  *[Symbol.iterator]() { yield 1; }\n  entries() { return [1]; }\n}\n",
      "src/helpers.ts": "export function note(x: unknown) { return x; }\n",
      "src/use.ts": "import { note } from \"./helpers\";\nimport { Range } from \"./rng\";\nexport function loop(r: Range) { return note([...r]); }\n",
    }));
    expect(kinds(report)).toEqual([]);
  });
});
