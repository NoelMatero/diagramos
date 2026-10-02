/**
 * A name written with its owner means the name (#382, #385).
 *
 * `money.rs#Money::new`, `box.ts#Box.make`, `b.py#Store.save` on a box, and
 * `Kind.A`, `Method::Get`, `Self::Get` in a box's `handles` list, are how each
 * language spells the thing. The checker matched the text as written, found
 * nothing, and judged the arrow or the box anyway, so correct work was called
 * wrong: a `calls` arrow "reaching none of money.rs", a routine with "no case
 * for Kind.A" on the line that reads `case Kind.A:`.
 *
 * Per language, every shape the two issues list, drawn on correct code and
 * checked the way the MCP server checks it. Beside each, a wrong arrow or a
 * wrong case list in the same repo that must still be called wrong, and an end
 * that names nothing, which may not be.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { emptyBoard, type BoardFile } from "../src/engine/board-file";
import { createDiagram } from "../src/engine/diagram";
import { ACCUSING_EDGE_KINDS, checkDrift, createWorkspace, type DriftReport } from "../src/engine/drift";
import { writtenName } from "../src/engine/lines";
import { initEngine } from "../src/engine/parse";
import { refereedCheckLive } from "../src/engine/referee-live";
import { installExcalifontMeasurer } from "./helpers/excalifont";

installExcalifontMeasurer();

beforeAll(async () => { await initEngine(); }, 60_000);

const hasRustAnalyzer = (() => {
  try { execFileSync("rust-analyzer", ["--version"], { stdio: "ignore" }); return true; }
  catch { return false; }
})();

const ACCUSES = new Set<string>(ACCUSING_EDGE_KINDS);

let repo: string;

function write(files: Record<string, string>): void {
  for (const [relative, contents] of Object.entries(files)) {
    const full = path.join(repo, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
}

async function arrow(fromRef: string, toRef: string, live: boolean): Promise<DriftReport> {
  const { board } = await createDiagram(emptyBoard(), {
    name: "arch",
    nodes: [
      { id: "caller", label: "caller", ref: fromRef },
      { id: "callee", label: "callee", ref: toRef },
    ],
    edges: [{ from: "caller", to: "callee", claim: "calls" }],
  });
  const workspace = createWorkspace(repo);
  if (!live) return checkDrift(board as BoardFile, workspace, { edges: true });
  const checked = await refereedCheckLive(repo, (referee) =>
    checkDrift(board as BoardFile, workspace, { edges: true, ...(referee ? { closedBodyReferee: referee } : {}) }));
  return checked.report;
}

async function handles(ref: string, cases: string[]): Promise<DriftReport> {
  const { board } = await createDiagram(emptyBoard(), {
    name: "arch",
    nodes: [{ id: "router", label: "router", ref, handles: cases }],
    edges: [],
  });
  return checkDrift(board as BoardFile, createWorkspace(repo), {});
}

const accusations = (report: DriftReport) =>
  report.edges.filter((finding) => ACCUSES.has(finding.kind)).map((finding) => finding.kind);
const boxFindings = (report: DriftReport) => report.findings.map((finding) => `${finding.kind}: ${finding.detail}`);

beforeEach(() => {
  // Outside the worktree: a scratch source file inside one is read by the
  // dependency tests as though it belonged to this repository.
  repo = mkdtempSync(path.join(tmpdir(), "owner-names-"));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("writtenName", () => {
  it.each([
    ["Money::new", "new", "Money"],
    ["Self::Get", "Get", "Self"],
    ["Method::Get", "Get", "Method"],
    ["Kind.A", "A", "Kind"],
    ["Store.save", "save", "Store"],
    ["crate::net::accept", "accept", "net"],
    ["Server#accept", "accept", "Server"],
    ["Money::new@declared", "new@declared", "Money"],
  ])("reads %s as %s, owned by %s", (written, name, owner) => {
    expect(writtenName(written)).toEqual({ name, owner });
  });

  it.each(["new", "GET /api/users", "/api/users", "user.created\"", "a b", "Money::"])(
    "leaves %s as it was written",
    (written) => {
      expect(writtenName(written)).toEqual({ name: written });
    },
  );
});

/** One language's fixture: arrows that must not be red, and wrong ones that must. */
interface Arrows {
  files: Record<string, string>;
  right: Array<[string, string, string]>;
  wrong: Array<[string, string, string]>;
  /** An end that names nothing in its file: never red, said why. */
  unfound: Array<[string, string, string]>;
}

function arrows(language: string, fixture: Arrows, timeout: number, live: boolean, skip = false): void {
  describe.skipIf(skip)(`${language} calls arrows${live ? ", compilers running" : ""}`, () => {
    it.each(fixture.right)("is not called wrong when %s", async (_shape, from, to) => {
      write(fixture.files);
      const report = await arrow(from, to, live);
      expect(accusations(report)).toEqual([]);
      // The box is understood too: no "write the plain name" about it.
      expect(boxFindings(report)).toEqual([]);
    }, timeout);

    it.each(fixture.wrong)("still calls a wrong arrow wrong when %s", async (_shape, from, to) => {
      write(fixture.files);
      expect(accusations(await arrow(from, to, live))).toEqual(["calls-refuted"]);
    }, timeout);

    it.each(fixture.unfound)("does not judge an arrow whose end is not found when %s", async (_shape, from, to) => {
      write(fixture.files);
      const report = await arrow(from, to, live);
      expect(accusations(report)).toEqual([]);
      expect(report.unreadEdges.map((one) => one.reason)).toEqual(["endpoint-not-found"]);
      expect(report.findings.length).toBeGreaterThan(0);
    }, timeout);
  });
}

const RUST = {
  "Cargo.toml": "[package]\nname = \"fixture\"\nversion = \"0.1.0\"\nedition = \"2021\"\n[workspace]\n",
  "src/lib.rs": "pub mod a;\npub mod money;\npub mod purse;\npub mod store;\npub mod file_store;\n",
  "src/purse.rs": "#[derive(Default)]\npub struct Purse(pub i64);\n",
  "src/money.rs": [
    "#[derive(Debug)]\npub struct Money(pub i64);",
    "impl Default for Money {\n    fn default() -> Self {\n        Money(0)\n    }\n}",
    "impl Money {\n    pub fn new(c: i64) -> Self {\n        Money(c)\n    }\n\n    pub fn cents(&self) -> i64 {\n        self.0\n    }\n}",
    "impl From<i64> for Money {\n    fn from(c: i64) -> Self {\n        Money(c)\n    }\n}",
    "",
  ].join("\n\n"),
  "src/store.rs": "pub trait Store {\n    fn save(&self, v: i64);\n\n    fn save_twice(&self, v: i64) {\n        self.save(v);\n        self.save(v);\n    }\n}\n",
  "src/file_store.rs": [
    "use crate::store::Store;",
    "pub struct FileStore;",
    "impl Store for FileStore {\n    fn save(&self, v: i64) {\n        println!(\"{}\", v);\n    }\n}",
    "",
  ].join("\n\n"),
  "src/a.rs": [
    "use crate::file_store::FileStore;\nuse crate::money::Money;\nuse crate::store::Store;",
    "pub fn in_vec() -> Vec<Money> {\n    vec![Money::new(1)]\n}",
    "pub fn uses_from() -> Money {\n    Money::from(2)\n}",
    "pub fn uses_default() -> Money {\n    Money::default()\n}",
    "pub fn derived() -> crate::purse::Purse {\n    crate::purse::Purse::default()\n}",
    "pub fn formats(m: &Money) -> String {\n    format!(\"{}\", m.cents())\n}",
    "pub fn stores() {\n    FileStore.save(3);\n}",
    "pub fn twice() {\n    FileStore.save_twice(4);\n}",
    "pub fn unrelated() -> i64 {\n    7\n}",
    "",
  ].join("\n\n"),
};

const RUST_ARROWS: Arrows = {
  files: RUST,
  right: [
    ["the head is Money::new, called inside vec![]", "src/a.rs#in_vec", "src/money.rs#Money::new"],
    ["the head is Money::from", "src/a.rs#uses_from", "src/money.rs#Money::from"],
    ["the head is Money::default", "src/a.rs#uses_default", "src/money.rs#Money::default"],
    ["the head is Money::cents, called inside format!", "src/a.rs#formats", "src/money.rs#Money::cents"],
    ["the head is a trait impl's method, FileStore::save", "src/a.rs#stores", "src/file_store.rs#FileStore::save"],
    ["the tail is qualified, Store::save_twice", "src/store.rs#Store::save_twice", "src/file_store.rs#save"],
    ["both ends are qualified", "src/store.rs#Store::save_twice", "src/file_store.rs#FileStore::save"],
    ["the plain spelling, as before", "src/a.rs#in_vec", "src/money.rs#new"],
  ],
  wrong: [
    ["the head is Money::new and nothing calls it", "src/a.rs#unrelated", "src/money.rs#Money::new"],
    ["the head is FileStore::save and nothing calls it", "src/a.rs#unrelated", "src/file_store.rs#FileStore::save"],
    ["the plain spelling, as before", "src/a.rs#unrelated", "src/money.rs#new"],
  ],
  unfound: [
    ["the head names a method money.rs does not have", "src/a.rs#in_vec", "src/money.rs#Money::spend"],
    ["the head names an owner money.rs never mentions", "src/a.rs#in_vec", "src/money.rs#Wallet::new"],
    ["the tail names nothing", "src/a.rs#nothing_here", "src/money.rs#Money::new"],
    // Derived, so no file writes `default`: the box check cannot find it,
    // which is its own gap (#373's unwritten family), and the arrow waits.
    ["the head is a derived Purse::default", "src/a.rs#derived", "src/purse.rs#Purse::default"],
  ],
};

arrows("Rust", RUST_ARROWS, 60_000, false);
arrows("Rust", RUST_ARROWS, 180_000, true, !hasRustAnalyzer);

const TS_ARROWS: Arrows = {
  files: {
    "tsconfig.json": "{ \"compilerOptions\": { \"strict\": true } }\n",
    "box.ts": "export class Box {\n  static make(): Box {\n    return new Box();\n  }\n\n  open(): number {\n    return 1;\n  }\n}\n",
    "a.ts": [
      "import { Box } from \"./box\";",
      "export function build(): Box {\n  return Box.make();\n}",
      "export class Runner {\n  run(): number {\n    return new Box().open();\n  }\n}",
      "export function unrelated(): number {\n  return 7;\n}",
      "",
    ].join("\n\n"),
  },
  right: [
    ["the head is Box.make", "a.ts#build", "box.ts#Box.make"],
    ["both ends are qualified", "a.ts#Runner.run", "box.ts#Box.open"],
    ["the plain spelling, as before", "a.ts#build", "box.ts#make"],
  ],
  wrong: [
    ["the head is Box.make and nothing calls it", "a.ts#unrelated", "box.ts#Box.make"],
    ["the plain spelling, as before", "a.ts#unrelated", "box.ts#make"],
  ],
  unfound: [
    ["the head names a method box.ts does not have", "a.ts#build", "box.ts#Box.close"],
    ["the head names an owner box.ts never mentions", "a.ts#build", "box.ts#Crate.make"],
  ],
};

arrows("TypeScript", TS_ARROWS, 60_000, false);
arrows("TypeScript", TS_ARROWS, 120_000, true);

const PY_ARROWS: Arrows = {
  files: {
    "b.py": "class Store:\n    def save(self, v):\n        print(v)\n\n    def load(self):\n        return 1\n",
    "a.py": [
      "from b import Store",
      "def go():\n    Store().save(1)",
      "class Runner:\n    def run(self):\n        return Store().load()",
      "def unrelated():\n    return 7",
      "",
    ].join("\n\n\n"),
  },
  right: [
    ["the head is Store.save", "a.py#go", "b.py#Store.save"],
    ["both ends are qualified", "a.py#Runner.run", "b.py#Store.load"],
    ["the plain spelling, as before", "a.py#go", "b.py#save"],
  ],
  wrong: [
    ["the head is Store.save and nothing calls it", "a.py#unrelated", "b.py#Store.save"],
    ["the plain spelling, as before", "a.py#unrelated", "b.py#save"],
  ],
  unfound: [
    ["the head names a method b.py does not have", "a.py#go", "b.py#Store.drop"],
    ["the head names an owner b.py never mentions", "a.py#go", "b.py#Cache.save"],
  ],
};

arrows("Python", PY_ARROWS, 60_000, false);
arrows("Python", PY_ARROWS, 120_000, true);

/** One language's dispatch: case lists that are right, and wrong ones that must stay wrong. */
interface Cases {
  files: Record<string, string>;
  ref: string;
  right: Array<[string, string[]]>;
  wrong: Array<[string, string[]]>;
}

function cases(language: string, fixture: Cases): void {
  describe(`${language} handles`, () => {
    it.each(fixture.right)("is not called wrong when the box lists %s", async (_shape, listed) => {
      write(fixture.files);
      expect(boxFindings(await handles(fixture.ref, listed))).toEqual([]);
    }, 60_000);

    it.each(fixture.wrong)("still calls a wrong list wrong when the box lists %s", async (_shape, listed) => {
      write(fixture.files);
      const report = await handles(fixture.ref, listed);
      const said = [...report.findings.map((one) => one.kind), ...(report.claims?.handlesWithheld ?? []).map((one) => `withheld:${one.why}`)];
      // A language with no licence to accuse withholds instead; it must never come back held.
      expect(said.some((one) => one === "mishandled-box" || one === "withheld:unlicensed")).toBe(true);
    }, 60_000);
  });
}

cases("TypeScript", {
  files: {
    "h.ts": [
      "export enum Kind { A, B, C }",
      "export function enumCases(k: Kind): number {\n  switch (k) {\n    case Kind.A: return 1;\n    case Kind.B: return 2;\n    case Kind.C: return 3;\n  }\n}",
      "export function events(name: string): number {\n  switch (name) {\n    case \"user.created\": return 1;\n    case \"user.deleted\": return 2;\n    default: return 0;\n  }\n}",
      "",
    ].join("\n\n"),
  },
  ref: "h.ts#enumCases",
  right: [
    ["the cases as the code spells them, Kind.A", ["Kind.A", "Kind.B", "Kind.C"]],
    ["the bare names, as before", ["A", "B", "C"]],
    ["both spellings mixed", ["Kind.A", "B", "Kind.C"]],
  ],
  wrong: [
    ["one case short", ["Kind.A", "Kind.B"]],
    ["a case the code does not have", ["Kind.A", "Kind.B", "Kind.C", "Kind.D"]],
    ["a case from another owner", ["Kind.A", "Kind.B", "Other.C"]],
  ],
});

describe("TypeScript handles on string cases", () => {
  it("keeps a dotted string case whole", async () => {
    write({ "h.ts": "export function events(name: string): number {\n  switch (name) {\n    case \"user.created\": return 1;\n    case \"user.deleted\": return 2;\n  }\n  return 0;\n}\n" });
    expect(boxFindings(await handles("h.ts#events", ["user.created", "user.deleted"]))).toEqual([]);
  });

  it("does not read a dotted string case as its last part", async () => {
    write({ "h.ts": "export function events(name: string): number {\n  switch (name) {\n    case \"user.created\": return 1;\n    case \"user.deleted\": return 2;\n  }\n  return 0;\n}\n" });
    expect((await handles("h.ts#events", ["created", "deleted"])).findings.map((one) => one.kind)).toEqual(["mishandled-box"]);
  });
});

const METHOD = [
  "#[derive(Clone, Copy)]\npub enum Method {\n    Get,\n    Head,\n    Post,\n}",
  "pub fn route(m: Method) -> u16 {\n    match m {\n        Method::Get => 200,\n        Method::Head => 204,\n        Method::Post => 201,\n    }\n}",
  "impl Method {\n    pub fn code(self) -> u16 {\n        match self {\n            Self::Get => 1,\n            Self::Head => 2,\n            Self::Post => 3,\n        }\n    }\n}",
  "",
].join("\n\n");

cases("Rust", {
  files: { "Cargo.toml": RUST["Cargo.toml"], "src/lib.rs": "pub mod h;\n", "src/h.rs": METHOD },
  ref: "src/h.rs#route",
  right: [
    ["the cases as the code spells them, Method::Get", ["Method::Get", "Method::Head", "Method::Post"]],
    ["Self::Get", ["Self::Get", "Self::Head", "Self::Post"]],
    ["the bare names, as before", ["Get", "Head", "Post"]],
  ],
  wrong: [
    ["one case short", ["Method::Get", "Method::Head"]],
    ["a case the code does not have", ["Method::Get", "Method::Head", "Method::Post", "Method::Put"]],
  ],
});

cases("Rust, inside impl Method", {
  files: { "Cargo.toml": RUST["Cargo.toml"], "src/lib.rs": "pub mod h;\n", "src/h.rs": METHOD },
  ref: "src/h.rs#Method::code",
  right: [
    ["Self::Get", ["Self::Get", "Self::Head", "Self::Post"]],
    ["Method::Get", ["Method::Get", "Method::Head", "Method::Post"]],
  ],
  wrong: [
    ["one case short", ["Self::Get", "Self::Head"]],
  ],
});

cases("Python", {
  files: {
    "h.py": [
      "import enum",
      "class Color(enum.Enum):\n    RED = 1\n    GREEN = 2",
      "def paint(c):\n    match c:\n        case Color.RED:\n            return 1\n        case Color.GREEN:\n            return 2",
      "",
    ].join("\n\n\n"),
  },
  ref: "h.py#paint",
  right: [
    ["the cases as the code spells them, Color.RED", ["Color.RED", "Color.GREEN"]],
    ["the bare names, as before", ["RED", "GREEN"]],
  ],
  wrong: [
    ["one case short", ["Color.RED"]],
  ],
});

describe("TypeScript @accesses, the member written with its type", () => {
  const files = {
    "tsconfig.json": "{ \"compilerOptions\": { \"strict\": true } }\n",
    "config.ts": "export class Config {\n  width = 1;\n}\n",
    "render.ts": "import { Config } from \"./config\";\n\nexport function render(c: Config): number {\n  return c.width;\n}\n",
  };

  async function member(label: string): Promise<DriftReport> {
    const { board } = await createDiagram(emptyBoard(), {
      name: "arch",
      nodes: [
        { id: "render", label: "render", ref: "render.ts#render" },
        { id: "config", label: "Config", ref: "config.ts#Config" },
      ],
      edges: [{ from: "render", to: "config", claim: "accesses", label }],
    });
    return checkDrift(board as BoardFile, createWorkspace(repo), { edges: true });
  }

  it("reads Config.width as width", async () => {
    write(files);
    const report = await member("Config.width");
    expect(accusations(report)).toEqual([]);
    expect(report.garbledClaims ?? []).toEqual([]);
    expect(report.unconfirmedEdges).toEqual([]);
  });

  it("still calls a member the type lacks wrong", async () => {
    write(files);
    expect(accusations(await member("Config.height"))).not.toEqual([]);
  });
});

/*
 * Found by measuring this change: once `NestApplication.init` could be found,
 * 18 correct `returns` arrows went red with no compiler running, every one a
 * method returning `this`. The plain spelling (`#init`) was red on main too.
 */
describe("TypeScript @returns on a method that returns this", () => {
  const files = {
    "tsconfig.json": "{ \"compilerOptions\": { \"strict\": true } }\n",
    "app.ts": [
      "export class Other {}",
      "export class App {\n  async init(): Promise<this> {\n    return this;\n  }\n\n  use(x: number): this {\n    return this;\n  }\n}",
      "export interface Builder {\n  add(): this;\n}",
      "export interface Options {\n  debug?: boolean;\n}",
      "export class Context<T extends Options = Options> {\n  opts?: T;\n\n  start(): this {\n    return this;\n  }\n}",
      "",
    ].join("\n\n"),
  };

  async function returns(typeRef: string, routineRef: string): Promise<DriftReport> {
    const { board } = await createDiagram(emptyBoard(), {
      name: "arch",
      nodes: [
        { id: "type", label: "type", ref: typeRef },
        { id: "routine", label: "routine", ref: routineRef },
      ],
      edges: [{ from: "type", to: "routine", claim: "returns" }],
    });
    return checkDrift(board as BoardFile, createWorkspace(repo), { edges: true });
  }

  it.each([
    ["Promise<this>, written with the class", "app.ts#App", "app.ts#App.init"],
    ["Promise<this>, the plain spelling", "app.ts#App", "app.ts#init"],
    ["this", "app.ts#App", "app.ts#App.use"],
  ])("confirms %s", async (_shape, type, routine) => {
    write(files);
    const report = await returns(type, routine);
    expect(accusations(report)).toEqual([]);
    expect(report.claims.signatureConfirmed).toBe(1);
  });

  it("confirms the class on a generic class's this", async () => {
    write(files);
    const report = await returns("app.ts#Context", "app.ts#Context.start");
    expect(accusations(report)).toEqual([]);
    expect(report.claims.signatureConfirmed).toBe(1);
  });

  it("does not call a generic class's this wrong about its type parameter's bound", async () => {
    write(files);
    expect(accusations(await returns("app.ts#Options", "app.ts#Context.start"))).toEqual([]);
  });

  it("does not call an interface's this wrong", async () => {
    write(files);
    expect(accusations(await returns("app.ts#Builder", "app.ts#Builder.add"))).toEqual([]);
  });

  it("still calls an arrow naming another class wrong", async () => {
    write(files);
    expect(accusations(await returns("app.ts#Other", "app.ts#App.init"))).toEqual(["signature-absent"]);
  });
});
