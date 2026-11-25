/**
 * "get_default_columns calls BarColumn.__init__" is not called wrong when
 * the routine writes `BarColumn()`.
 *
 * Two readings went wrong together, on main, on rich's `progress.py`
 * (calls recorded while rich's own tests ran, `measure:calls-at-run-time`):
 *
 *   - making one of a class was not read as running its constructor, so the
 *     forward question "does it call `__init__`?" found nothing; and
 *   - "it is the other way round" then looked through every `__init__` in
 *     the file, found `Progress.__init__` calling `get_default_columns`, and
 *     said so -- about an arrow whose head is `BarColumn.__init__`.
 *
 * The rule, as facts about the languages: making one of a class -- Python's
 * `X(...)`, TypeScript's `new X(...)` -- runs that class's own constructor
 * and nothing else of it; calling a value a routine binds itself (a class
 * handed in as a parameter) may be making one, so for a constructor it is a
 * doubt; and a call found running back from a `Class.method` end has to be
 * that class's own. Rust has no constructors (`X::new()` is an ordinary
 * call), so only the last of these applies there.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { initEngine } from "../src/engine/parse";
import { dropRepo, hasRustAnalyzer, scratchRepo, verdicts, type Arrow } from "./helpers/arrow-probe";
import { installExcalifontMeasurer } from "./helpers/excalifont";

installExcalifontMeasurer();
beforeAll(async () => { await initEngine(); }, 60_000);

let repo: string | undefined;
afterEach(() => { if (repo) dropRepo(repo); repo = undefined; });

const calls = (pairs: Array<[string, string]>): Arrow[] => pairs.map(([from, to]) => [from, to, "calls"]);
const named = (pairs: Array<[string, string]>, each: Array<{ reds: string[]; unconfirmed?: string }>, read: (one: { reds: string[]; unconfirmed?: string }) => unknown) =>
  each.map((one, index) => [pairs[index]!.join(" -> "), read(one)]);

const PY = {
  "progress.py": [
    "from columns import SpinnerColumn",
    "",
    "",
    "class Progress:",
    "    def __init__(self) -> None:",
    "        self.cols = self.get_default_columns()",
    "        self.refresh()",
    "",
    "    def get_default_columns(self) -> tuple:",
    "        return (BarColumn(), SpinnerColumn())",
    "",
    "    def refresh(self) -> None:",
    "        pass",
    "",
    "",
    "class BarColumn:",
    "    def __init__(self) -> None:",
    "        self.width = 1",
    "",
    "    def render(self) -> str:",
    "        return \"-\" * self.width",
    "",
    "",
    "class Task:",
    "    def __init__(self) -> None:",
    "        self.done = False",
    "",
  ].join("\n"),
  "columns.py": [
    "class SpinnerColumn:",
    "    def __init__(self) -> None:",
    "        self.frame = 0",
    "",
  ].join("\n"),
  "fields.py": [
    "class Field:",
    "    def __init__(self) -> None:",
    "        self.name = \"\"",
    "",
    "",
    "class Decimal(Field):",
    "    def __init__(self, places: int = 2) -> None:",
    "        super().__init__()",
    "        self.places = places",
    "",
    "",
    "def _resolve_field_instance(cls_or_instance):",
    "    if isinstance(cls_or_instance, type):",
    "        return cls_or_instance()",
    "    return cls_or_instance",
    "",
    "",
    "class List(Field):",
    "    def __init__(self, cls_or_instance) -> None:",
    "        super().__init__()",
    "        self.inner = _resolve_field_instance(cls_or_instance)",
    "",
  ].join("\n"),
};

describe("Python: making one of a class runs its __init__", () => {
  /* Each writes the class it makes by name: confirmed, by either reading. */
  const MADE: Array<[string, string]> = [
    ["progress.py#get_default_columns", "progress.py#__init__"],
    ["progress.py#Progress.get_default_columns", "progress.py#BarColumn.__init__"],
    ["progress.py#Progress.get_default_columns", "columns.py#SpinnerColumn.__init__"],
  ];
  /* A class handed in and called: which one is not written, so not sure -- never "the other way round". */
  const HANDED: Array<[string, string]> = [
    ["fields.py#_resolve_field_instance", "fields.py#Decimal.__init__"],
    ["fields.py#_resolve_field_instance", "fields.py#__init__"],
  ];

  it("confirms an arrow to the __init__ of a class the routine makes, with no compiler", async () => {
    repo = scratchRepo(PY);
    const { each } = await verdicts(repo, calls(MADE), { compiler: false });
    expect(named(MADE, each, (one) => [one.reds, one.unconfirmed ?? "confirmed"]))
      .toEqual(MADE.map((pair) => [pair.join(" -> "), [[], "confirmed"]]));
  }, 60_000);

  it("does not call an arrow to __init__ wrong when the class is handed in and called, with no compiler", async () => {
    repo = scratchRepo(PY);
    const { each } = await verdicts(repo, calls(HANDED), { compiler: false });
    expect(named(HANDED, each, (one) => one.reds)).toEqual(HANDED.map((pair) => [pair.join(" -> "), []]));
  }, 60_000);

  it("calls none of them wrong with the compiler", async () => {
    repo = scratchRepo(PY);
    const all = [...MADE, ...HANDED];
    const { each } = await verdicts(repo, calls(all));
    expect(named(all, each, (one) => one.reds)).toEqual(all.map((pair) => [pair.join(" -> "), []]));
  }, 180_000);

  it("still turns round an arrow whose own class's __init__ calls the tail", async () => {
    repo = scratchRepo(PY);
    const { each } = await verdicts(repo, calls([["progress.py#Progress.get_default_columns", "progress.py#Progress.__init__"]]), { compiler: false });
    expect(each.map((one) => one.reds)).toEqual([["calls-backwards"]]);
  }, 60_000);

  it("runs the constructor and nothing else: an arrow to another method of the class made is still wrong", async () => {
    repo = scratchRepo(PY);
    const { each } = await verdicts(repo, calls([["progress.py#Progress.get_default_columns", "progress.py#BarColumn.render"]]), { compiler: false });
    expect(each.map((one) => one.reds)).toEqual([["calls-refuted"]]);
  }, 60_000);

  it("does not say \"the other way round\" from another class's __init__", async () => {
    repo = scratchRepo(PY);
    // Progress.__init__ calls refresh; Task.__init__ does not.
    const { each, report } = await verdicts(repo, calls([["progress.py#Progress.refresh", "progress.py#Task.__init__"]]), { compiler: false });
    expect(each[0]!.reds).not.toContain("calls-backwards");
    expect(report.edges.map((one) => one.detail ?? "").join("\n")).not.toMatch(/self\.refresh\(\)/);
  }, 60_000);
});

const TS = {
  "tsconfig.json": "{ \"compilerOptions\": { \"strict\": true, \"target\": \"es2022\" } }\n",
  "progress.ts": [
    "import { SpinnerColumn } from \"./columns\";",
    "",
    "export class Progress {",
    "  cols: unknown[];",
    "  constructor() {",
    "    this.cols = this.getDefaultColumns();",
    "    this.refresh();",
    "  }",
    "",
    "  getDefaultColumns(): unknown[] {",
    "    return [new BarColumn(), new SpinnerColumn()];",
    "  }",
    "",
    "  refresh(): void {}",
    "}",
    "",
    "export class BarColumn {",
    "  width: number;",
    "  constructor() {",
    "    this.width = 1;",
    "  }",
    "",
    "  render(): string {",
    "    return \"-\".repeat(this.width);",
    "  }",
    "}",
    "",
    "export class Task {",
    "  done: boolean;",
    "  constructor() {",
    "    this.done = false;",
    "  }",
    "}",
    "",
    "export function resolveColumn(make: new () => unknown): unknown {",
    "  return new make();",
    "}",
    "",
    "export class Columns {",
    "  inner: unknown;",
    "  constructor(make: new () => unknown) {",
    "    this.inner = resolveColumn(make);",
    "  }",
    "}",
    "",
  ].join("\n"),
  "columns.ts": [
    "export class SpinnerColumn {",
    "  frame: number;",
    "  constructor() {",
    "    this.frame = 0;",
    "  }",
    "}",
    "",
  ].join("\n"),
};

describe("TypeScript: new X() runs X's constructor", () => {
  const MADE: Array<[string, string]> = [
    ["progress.ts#getDefaultColumns", "progress.ts#constructor"],
    ["progress.ts#Progress.getDefaultColumns", "progress.ts#BarColumn.constructor"],
    ["progress.ts#Progress.getDefaultColumns", "columns.ts#SpinnerColumn.constructor"],
  ];
  const HANDED: Array<[string, string]> = [
    ["progress.ts#resolveColumn", "progress.ts#Task.constructor"],
    ["progress.ts#resolveColumn", "progress.ts#constructor"],
  ];

  it("confirms an arrow to the constructor of a class the routine makes, with no compiler", async () => {
    repo = scratchRepo(TS);
    const { each } = await verdicts(repo, calls(MADE), { compiler: false });
    expect(named(MADE, each, (one) => [one.reds, one.unconfirmed ?? "confirmed"]))
      .toEqual(MADE.map((pair) => [pair.join(" -> "), [[], "confirmed"]]));
  }, 60_000);

  it("does not call an arrow to a constructor wrong when the class is handed in and made, with no compiler", async () => {
    repo = scratchRepo(TS);
    const { each } = await verdicts(repo, calls(HANDED), { compiler: false });
    expect(named(HANDED, each, (one) => one.reds)).toEqual(HANDED.map((pair) => [pair.join(" -> "), []]));
  }, 60_000);

  it("calls none of them wrong with the compiler", async () => {
    repo = scratchRepo(TS);
    const all = [...MADE, ...HANDED];
    const { each } = await verdicts(repo, calls(all));
    expect(named(all, each, (one) => one.reds)).toEqual(all.map((pair) => [pair.join(" -> "), []]));
  }, 120_000);

  it("still turns round an arrow whose own class's constructor calls the tail", async () => {
    repo = scratchRepo(TS);
    const { each } = await verdicts(repo, calls([["progress.ts#Progress.getDefaultColumns", "progress.ts#Progress.constructor"]]), { compiler: false });
    expect(each.map((one) => one.reds)).toEqual([["calls-backwards"]]);
  }, 60_000);

  it("runs the constructor and nothing else: an arrow to another method of the class made is still wrong", async () => {
    repo = scratchRepo(TS);
    const { each } = await verdicts(repo, calls([["progress.ts#Progress.getDefaultColumns", "progress.ts#BarColumn.render"]]), { compiler: false });
    expect(each.map((one) => one.reds)).toEqual([["calls-refuted"]]);
  }, 60_000);

  it("does not say \"the other way round\" from another class's constructor", async () => {
    repo = scratchRepo(TS);
    const { each, report } = await verdicts(repo, calls([["progress.ts#Progress.refresh", "progress.ts#Task.constructor"]]), { compiler: false });
    expect(each[0]!.reds).not.toContain("calls-backwards");
    expect(report.edges.map((one) => one.detail ?? "").join("\n")).not.toMatch(/this\.refresh\(\)/);
  }, 60_000);
});

const RS = {
  "Cargo.toml": "[package]\nname = \"p\"\nversion = \"0.1.0\"\nedition = \"2021\"\n\n[lib]\npath = \"src/lib.rs\"\n",
  "src/lib.rs": "pub mod progress;\n",
  "src/progress.rs": [
    "pub struct Progress {",
    "    pub cols: Vec<BarColumn>,",
    "}",
    "",
    "impl Progress {",
    "    pub fn new() -> Self {",
    "        let mut made = Progress { cols: Vec::new() };",
    "        made.refresh();",
    "        made.cols = Progress::get_default_columns();",
    "        made",
    "    }",
    "",
    "    pub fn get_default_columns() -> Vec<BarColumn> {",
    "        let mut cols = Vec::new();",
    "        cols.push(BarColumn::new());",
    "        cols",
    "    }",
    "",
    "    pub fn refresh(&mut self) {}",
    "}",
    "",
    "pub struct BarColumn {",
    "    pub width: u32,",
    "}",
    "",
    "impl BarColumn {",
    "    pub fn new() -> Self {",
    "        BarColumn { width: 1 }",
    "    }",
    "}",
    "",
    "pub struct Task {",
    "    pub done: bool,",
    "}",
    "",
    "impl Task {",
    "    pub fn new() -> Self {",
    "        Task { done: false }",
    "    }",
    "}",
    "",
  ].join("\n"),
};

describe.skipIf(!hasRustAnalyzer)("Rust: a call found running back from Type::new is that type's own", () => {
  it("confirms Type::new written at the call, and does not turn it round from another type's new", async () => {
    repo = scratchRepo(RS);
    const pairs: Array<[string, string]> = [
      ["src/progress.rs#Progress::get_default_columns", "src/progress.rs#BarColumn::new"],
      ["src/progress.rs#Progress::refresh", "src/progress.rs#Task::new"],
    ];
    const { each, report } = await verdicts(repo, calls(pairs));
    expect(each[0]!.reds).toEqual([]);
    expect(each[1]!.reds).not.toContain("calls-backwards");
    expect(report.edges.map((one) => one.detail ?? "").join("\n")).not.toMatch(/made\.refresh\(\)/);
  }, 300_000);

  it("still turns round an arrow whose own type's new calls the tail", async () => {
    repo = scratchRepo(RS);
    const { each } = await verdicts(repo, calls([["src/progress.rs#Progress::refresh", "src/progress.rs#Progress::new"]]));
    expect(each.map((one) => one.reds)).toEqual([["calls-backwards"]]);
  }, 300_000);
});
