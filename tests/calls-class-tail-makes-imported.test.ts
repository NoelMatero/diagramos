/**
 * "Screen calls console.py's __init__" is not turned round when Screen's own
 * code makes a `Group`, a class `console.py` declares.
 *
 * Found on main by replaying calls recorded while rich's tests ran, redrawn
 * with the class at the near end (`measure:calls-at-run-time
 * --ends=class-tail`): rich's `Screen.__init__` writes `from rich.console
 * import Group` and then `Group(...)`, which runs `Group.__init__`. The file
 * also imports `Group` at its top, under `if TYPE_CHECKING:` and spelt
 * `.console`. Two imports of one name with two spellings read as "this name
 * could be either", so `Group(...)` counted as making nothing of the head's,
 * nothing was found going forwards, and "it is the other way round" answered
 * from `ScreenContext.__init__`, which makes a Screen.
 *
 * The rules, as facts about Python:
 *
 *   - a name a function imports is that import, inside the function and in
 *     the functions written inside it, whatever else the module binds under
 *     the same name;
 *   - a name bound by two imports, one of them from the head's file, may be
 *     the head's: making one is a doubt, never "not this one".
 *
 * TypeScript has no import inside a function and Rust's `use` in a body is
 * read already; both are pinned here so they stay that way.
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

const CONSOLE = [
  "from .screen import Screen",
  "",
  "",
  "class Group:",
  "    def __init__(self, *items) -> None:",
  "        self.items = items",
  "",
  "",
  "class ScreenContext:",
  "    def __init__(self) -> None:",
  "        self.screen = Screen()",
  "",
].join("\n");

/** rich's shape: imported at the top for the type checker, and again inside the function that makes one. */
const IMPORTED_INSIDE = {
  "rich/__init__.py": "",
  "rich/console.py": CONSOLE,
  "rich/screen.py": [
    "from typing import TYPE_CHECKING",
    "",
    "if TYPE_CHECKING:",
    "    from .console import Group",
    "",
    "",
    "class Screen:",
    "    def __init__(self, *items) -> None:",
    "        from rich.console import Group",
    "",
    "        self.renderable = Group(*items)",
    "",
  ].join("\n"),
};

/** The same, made in a function written inside the one that imports it. */
const IMPORTED_AROUND = {
  "rich/__init__.py": "",
  "rich/console.py": CONSOLE,
  "rich/screen.py": [
    "from typing import TYPE_CHECKING",
    "",
    "if TYPE_CHECKING:",
    "    from .console import Group",
    "",
    "",
    "class Screen:",
    "    def __init__(self, *items) -> None:",
    "        from rich.console import Group",
    "",
    "        def make():",
    "            return Group(*items)",
    "",
    "        self.renderable = make()",
    "",
  ].join("\n"),
};

/** Two imports at the top, one of them the head's file: which one runs is not in the text. */
const IMPORTED_TWICE = {
  "rich/__init__.py": "",
  "rich/console.py": CONSOLE,
  "rich/fallback.py": [
    "class Group:",
    "    def __init__(self, *items) -> None:",
    "        self.items = items",
    "",
  ].join("\n"),
  "rich/screen.py": [
    "try:",
    "    from .console import Group",
    "except ImportError:",
    "    from .fallback import Group",
    "",
    "",
    "class Screen:",
    "    def __init__(self, *items) -> None:",
    "        self.renderable = Group(*items)",
    "",
  ].join("\n"),
};

/** The wrong way round for real: Screen makes nothing of console.py's, and ScreenContext makes a Screen. */
const MAKES_SOMETHING_ELSE = {
  "rich/__init__.py": "",
  "rich/console.py": CONSOLE,
  "rich/segment.py": [
    "class Segment:",
    "    def __init__(self, *items) -> None:",
    "        self.items = items",
    "",
  ].join("\n"),
  "rich/screen.py": [
    "from typing import TYPE_CHECKING",
    "",
    "if TYPE_CHECKING:",
    "    from .console import Group",
    "",
    "",
    "class Screen:",
    "    def __init__(self, *items) -> None:",
    "        from rich.segment import Segment",
    "",
    "        self.renderable = Segment(*items)",
    "",
  ].join("\n"),
};

describe("Python: a class that makes one of a class it imports inside its own code", () => {
  const ARROWS: Array<[string, string]> = [
    ["rich/screen.py#Screen", "rich/console.py#__init__"],
    ["rich/screen.py#Screen", "rich/console.py#Group.__init__"],
    ["rich/screen.py#Screen.__init__", "rich/console.py#__init__"],
  ];

  it("confirms the arrow when the import is inside the function, with no compiler", async () => {
    repo = scratchRepo(IMPORTED_INSIDE);
    const { each } = await verdicts(repo, calls(ARROWS), { compiler: false });
    expect(each.map((one) => [one.reds, one.unconfirmed ?? "confirmed"])).toEqual(ARROWS.map(() => [[], "confirmed"]));
  }, 60_000);

  it("confirms it when the class is made in a function inside the one that imports it, with no compiler", async () => {
    repo = scratchRepo(IMPORTED_AROUND);
    const { each } = await verdicts(repo, calls([ARROWS[0]!]), { compiler: false });
    expect(each.map((one) => [one.reds, one.unconfirmed ?? "confirmed"])).toEqual([[[], "confirmed"]]);
  }, 60_000);

  it("does not turn it round when the name is imported twice at the top, one from the head's file", async () => {
    repo = scratchRepo(IMPORTED_TWICE);
    const { each } = await verdicts(repo, calls(ARROWS), { compiler: false });
    expect(each.map((one) => one.reds)).toEqual(ARROWS.map(() => []));
  }, 60_000);

  it("still turns it round when the class makes nothing of the head's file", async () => {
    repo = scratchRepo(MAKES_SOMETHING_ELSE);
    const { each } = await verdicts(repo, calls([ARROWS[0]!, ARROWS[2]!]), { compiler: false });
    expect(each[0]!.reds).toEqual(["calls-backwards"]);
  }, 60_000);

  it("says the same with the compiler", async () => {
    for (const files of [IMPORTED_INSIDE, IMPORTED_TWICE]) {
      repo = scratchRepo(files);
      const { each } = await verdicts(repo, calls(ARROWS));
      expect(each.map((one) => one.reds)).toEqual(ARROWS.map(() => []));
      dropRepo(repo);
    }
    repo = scratchRepo(MAKES_SOMETHING_ELSE);
    const { each } = await verdicts(repo, calls([ARROWS[0]!]));
    expect(each[0]!.reds).toEqual(["calls-backwards"]);
  }, 300_000);
});

describe("TypeScript and Rust: the same arrow, a class at the near end", () => {
  const TS = {
    "tsconfig.json": "{ \"compilerOptions\": { \"strict\": true, \"target\": \"es2022\" } }\n",
    "console.ts": [
      "import { Screen } from \"./screen\";",
      "export class Group {",
      "  items: unknown[];",
      "  constructor(...items: unknown[]) { this.items = items; }",
      "}",
      "export class ScreenContext {",
      "  screen: Screen;",
      "  constructor() { this.screen = new Screen(); }",
      "}",
      "",
    ].join("\n"),
    "screen.ts": [
      "import type { Group as Shown } from \"./console\";",
      "import { Group } from \"./console\";",
      "export class Screen {",
      "  renderable: Shown;",
      "  constructor(...items: unknown[]) { this.renderable = new Group(...items); }",
      "}",
      "",
    ].join("\n"),
  };
  const RS = {
    "Cargo.toml": "[package]\nname = \"p\"\nversion = \"0.1.0\"\nedition = \"2021\"\n\n[lib]\npath = \"src/lib.rs\"\n",
    "src/lib.rs": "pub mod console;\npub mod screen;\n",
    "src/console.rs": [
      "use crate::screen::Screen;",
      "pub struct Group { pub n: usize }",
      "impl Group {",
      "    pub fn new(n: usize) -> Self { Group { n } }",
      "}",
      "pub struct ScreenContext { pub screen: Screen }",
      "impl ScreenContext {",
      "    pub fn new() -> Self { ScreenContext { screen: Screen::new(1) } }",
      "}",
      "",
    ].join("\n"),
    "src/screen.rs": [
      "pub struct Screen { pub g: crate::console::Group }",
      "impl Screen {",
      "    pub fn new(n: usize) -> Self {",
      "        use crate::console::Group;",
      "        Screen { g: Group::new(n) }",
      "    }",
      "}",
      "",
    ].join("\n"),
  };

  it("TypeScript: confirms a class that makes one of the head file's classes, with no compiler", async () => {
    repo = scratchRepo(TS);
    const arrows: Array<[string, string]> = [["screen.ts#Screen", "console.ts#constructor"], ["screen.ts#Screen.constructor", "console.ts#constructor"]];
    const { each } = await verdicts(repo, calls(arrows), { compiler: false });
    expect(each.map((one) => [one.reds, one.unconfirmed ?? "confirmed"])).toEqual(arrows.map(() => [[], "confirmed"]));
  }, 60_000);

  it("Rust: confirms a struct whose method uses a type inside its body and calls it, with no compiler", async () => {
    repo = scratchRepo(RS);
    const arrows: Array<[string, string]> = [["src/screen.rs#Screen", "src/console.rs#new"], ["src/screen.rs#Screen::new", "src/console.rs#new"]];
    const { each } = await verdicts(repo, calls(arrows), { compiler: false });
    expect(each.map((one) => [one.reds, one.unconfirmed ?? "confirmed"])).toEqual(arrows.map(() => [[], "confirmed"]));
  }, 60_000);

  it.skipIf(!hasRustAnalyzer)("Rust: calls none of it wrong with the compiler", async () => {
    repo = scratchRepo(RS);
    const { each } = await verdicts(repo, calls([["src/screen.rs#Screen", "src/console.rs#new"]]));
    expect(each[0]!.reds).toEqual([]);
  }, 300_000);
});
