/**
 * A function that hands a whole value to something that reads every field of
 * it reads every field (#388).
 *
 * `JSON.stringify(c)`, `Object.values(c)`, `asdict(c)`, a derived
 * `c.clone()`: none of them writes `width`, and each reads it. The check read
 * every member the body names, found none called `width`, and called the
 * correct arrow `json --[width @accesses]--> Config` wrong -- while Python's
 * `asdict` and Rust's derived `Debug` stayed quiet on the same shape, and
 * only by accident: `asdict(c)` went red too once the body read anything else.
 *
 * Per language, every shape in the issue and each one beside another read,
 * and a function of the repository's own that walks its parameter. And the
 * guard the other way, in the same repositories: a function that never
 * touches a Config, one that hands a different value to the same kind of
 * call, and one that hands the Config to a helper reading only `height`,
 * are each still called wrong. Both with the compilers running and with none.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { initEngine } from "../src/engine/parse";
import { dropRepo, scratchRepo, verdicts, type Arrow } from "./helpers/arrow-probe";
import { installExcalifontMeasurer } from "./helpers/excalifont";

installExcalifontMeasurer();
beforeAll(async () => { await initEngine(); }, 60_000);

/**
 * `COMPILER` marks a shape whose silence needs a compiler: only one can say
 * `JSON.stringify` or `asdict` is the language's own rather than a function
 * nobody can see into, and a call nobody can see into keeps the red (#255).
 * With none running those stay red, and the test says so.
 */
const COMPILER = true;
type Shape = [shape: string, from: string, to: string, member: string, needsCompiler?: boolean];

/** One language's repository: the right arrows that must stay quiet, the wrong ones that must stay red. */
interface Shapes {
  files: Record<string, string>;
  right: Shape[];
  wrong: Shape[];
}

const TYPESCRIPT: Shapes = {
  files: {
    "tsconfig.json": '{ "compilerOptions": { "strict": true, "target": "es2022" } }\n',
    "c.ts": "export interface Config {\n  width: number;\n  height: number;\n}\n",
    "r.ts": [
      'import type { Config } from "./c";',
      'import { walk, pick } from "./h";',
      "export function json(c: Config): string {\n  return JSON.stringify(c);\n}",
      "export function values(c: Config): number {\n  return Object.values(c).reduce((a, b) => a + b, 0);\n}",
      "export function assign(c: Config): Config {\n  return Object.assign({}, c);\n}",
      "export function forIn(c: Config): number {\n  let n = 0;\n  for (const k in c) n += (c as any)[k];\n  return n;\n}",
      "export function spread(c: Config): Config {\n  return { ...c };\n}",
      "export function indexed(c: Config): number {\n  return c['width'];\n}",
      "export function destructured(c: Config): number {\n  const { width } = c;\n  return width;\n}",
      "export function jsonMixed(c: Config): string {\n  console.log(Math.max(c.height, 0));\n  return JSON.stringify(c);\n}",
      "export function clone(c: Config): Config {\n  return structuredClone(c);\n}",
      "export function logged(c: Config): number {\n  console.log(c);\n  return c.height;\n}",
      "export function ownWalker(c: Config): string {\n  return walk(c);\n}",
      "export function ownMethodLike(c: Config): string {\n  return String(c.height) + walk(c);\n}",
      // Wrong arrows: these never touch a Config, or hand one to a helper reading only `height`.
      "export function other(n: number): number {\n  return Math.abs(n);\n}",
      "export function logsString(msg: string): number {\n  console.log(msg);\n  return msg.length + Math.abs(1);\n}",
      "export function viaPick(c: Config): number {\n  return pick(c) + Math.abs(1);\n}",
      "",
    ].join("\n\n"),
    "h.ts": [
      'import type { Config } from "./c";',
      "export function walk(v: unknown): string {\n  return JSON.stringify(v);\n}",
      "export function pick(c: Config): number {\n  return c.height;\n}",
      "",
    ].join("\n\n"),
  },
  right: [
    ["JSON.stringify", "r.ts#json", "c.ts#Config", "width", COMPILER],
    ["Object.values", "r.ts#values", "c.ts#Config", "height", COMPILER],
    ["Object.assign", "r.ts#assign", "c.ts#Config", "width", COMPILER],
    ["for..in", "r.ts#forIn", "c.ts#Config", "width"],
    ["spread", "r.ts#spread", "c.ts#Config", "width"],
    ["c['width']", "r.ts#indexed", "c.ts#Config", "width"],
    ["destructuring", "r.ts#destructured", "c.ts#Config", "width"],
    ["JSON.stringify beside other reads", "r.ts#jsonMixed", "c.ts#Config", "width", COMPILER],
    ["structuredClone", "r.ts#clone", "c.ts#Config", "width"],
    ["console.log(c)", "r.ts#logged", "c.ts#Config", "width", COMPILER],
    ["own walker (unknown param)", "r.ts#ownWalker", "c.ts#Config", "width"],
    ["own walker beside other reads", "r.ts#ownMethodLike", "c.ts#Config", "width", COMPILER],
  ],
  wrong: [
    ["never touches Config", "r.ts#other", "c.ts#Config", "width"],
    ["hands a string to console.log", "r.ts#logsString", "c.ts#Config", "width"],
    ["hands Config to a helper reading height", "r.ts#viaPick", "c.ts#Config", "width"],
  ],
};

const PYTHON: Shapes = {
  files: {
    "c.py": "from dataclasses import dataclass\n\n\n@dataclass\nclass Config:\n    width: int\n    height: int\n",
    "h.py": "from dataclasses import asdict\nfrom c import Config\n\n\ndef walk(v: object) -> dict:\n    return asdict(v)\n\n\ndef pick(c: Config) -> int:\n    return c.height\n",
    "r.py": [
      "import json\nimport logging\nimport math\nfrom dataclasses import asdict, astuple\nfrom c import Config\nfrom h import walk, pick\n\nlog = logging.getLogger(__name__)",
      "def as_dict(c: Config):\n    return asdict(c)",
      "def as_tuple(c: Config):\n    w, h = astuple(c)\n    return w",
      "def compare(a: Config, b: Config):\n    return a == b",
      "def as_dict_mixed(c: Config):\n    log.info(\"x\")\n    return asdict(c)",
      "def dumped(c: Config):\n    return json.dumps(asdict(c))",
      "def printed(c: Config):\n    print(c)\n    return c.height",
      "def own_walker(c: Config):\n    log.info(\"x\")\n    return walk(c)",
      "def other(n: int):\n    return math.floor(n)",
      "def logs_string(msg: str):\n    print(msg)\n    return msg.upper()",
      "def via_pick(c: Config):\n    return math.floor(pick(c))",
      "",
    ].join("\n\n\n"),
  },
  right: [
    ["asdict", "r.py#as_dict", "c.py#Config", "width"],
    ["astuple", "r.py#as_tuple", "c.py#Config", "width"],
    ["dataclass ==", "r.py#compare", "c.py#Config", "width"],
    ["asdict beside other reads", "r.py#as_dict_mixed", "c.py#Config", "width", COMPILER],
    ["json.dumps(asdict(c))", "r.py#dumped", "c.py#Config", "width", COMPILER],
    ["print(c)", "r.py#printed", "c.py#Config", "width"],
    ["own walker (object param)", "r.py#own_walker", "c.py#Config", "width", COMPILER],
  ],
  wrong: [
    ["never touches Config", "r.py#other", "c.py#Config", "width"],
    ["hands a str to print", "r.py#logs_string", "c.py#Config", "width"],
    ["hands Config to a helper reading height", "r.py#via_pick", "c.py#Config", "width"],
  ],
};

const RUST: Shapes = {
  files: {
    "Cargo.toml": '[package]\nname = "probe"\nversion = "0.1.0"\nedition = "2021"\n',
    "src/lib.rs": "pub mod c;\npub mod h;\npub mod r;\n",
    "src/c.rs": "#[derive(Debug, Clone, PartialEq, Hash)]\npub struct Config {\n    pub width: u32,\n    pub height: u32,\n}\n",
    "src/h.rs": "use crate::c::Config;\nuse std::fmt::Debug;\n\npub fn walk<T: Debug>(v: &T) -> String {\n    format!(\"{:?}\", v)\n}\n\npub fn pick(c: &Config) -> u32 {\n    c.height\n}\n",
    "src/r.rs": [
      "use crate::c::Config;\nuse crate::h::{pick, walk};",
      "pub fn debug(c: &Config) -> String {\n    format!(\"{:?}\", c)\n}",
      "pub fn cloned(c: &Config) -> Config {\n    c.clone()\n}",
      "pub fn cloned_mixed(c: &Config) -> (u32, Config) {\n    (c.height.max(1), c.clone())\n}",
      "pub fn equal(a: &Config, b: &Config) -> bool {\n    a == b\n}",
      "pub fn moved(c: Config) -> (u32, u32) {\n    let Config { width, height } = c;\n    (width, height)\n}",
      "pub fn own_walker(c: &Config) -> String {\n    walk(c).to_uppercase()\n}",
      "pub fn other(n: u32) -> u32 {\n    n.pow(2)\n}",
      "pub fn strings(s: &str) -> usize {\n    s.to_string().len()\n}",
      "pub fn via_pick(c: &Config) -> u32 {\n    pick(c).pow(2)\n}",
      "",
    ].join("\n\n"),
  },
  right: [
    ["derived Debug {:?}", "src/r.rs#debug", "src/c.rs#Config", "width"],
    ["derived Clone", "src/r.rs#cloned", "src/c.rs#Config", "width"],
    ["derived Clone beside other reads", "src/r.rs#cloned_mixed", "src/c.rs#Config", "width"],
    ["derived PartialEq ==", "src/r.rs#equal", "src/c.rs#Config", "height"],
    ["full destructure", "src/r.rs#moved", "src/c.rs#Config", "height"],
    ["own generic walker", "src/r.rs#own_walker", "src/c.rs#Config", "width"],
  ],
  wrong: [
    ["never touches Config", "src/r.rs#other", "src/c.rs#Config", "width"],
    ["hands a &str to to_string", "src/r.rs#strings", "src/c.rs#Config", "width"],
    ["hands Config to a helper reading height", "src/r.rs#via_pick", "src/c.rs#Config", "width"],
  ],
};

function shapes(language: string, fixture: Shapes): void {
  describe.each([true, false])(`${language}, compilers running: %s`, (compiler) => {
    it("calls no right arrow wrong, and every wrong one wrong", async () => {
      const repo = scratchRepo(fixture.files, "reads-every-field-");
      try {
        const all = [...fixture.right, ...fixture.wrong];
        const { each } = await verdicts(
          repo, all.map(([, from, to, member]): Arrow => [from, to, "accesses", member]), { compiler },
        );
        const red = (index: number) => each[index]!.reds.includes("accesses-not-read");
        expect({
          right: fixture.right.filter((_, index) => red(index)).map(([shape]) => shape),
          wrong: fixture.wrong.filter((_, index) => !red(fixture.right.length + index)).map(([shape]) => shape),
        }).toEqual({
          right: compiler ? [] : fixture.right.filter(([, , , , needs]) => needs).map(([shape]) => shape),
          wrong: [],
        });
      } finally {
        dropRepo(repo);
      }
    }, 300_000);
  });
}

shapes("TypeScript", TYPESCRIPT);
shapes("Python", PYTHON);
shapes("Rust", RUST);
