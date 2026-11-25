/**
 * "write calls Console.__enter__" is not called wrong because the same body
 * also calls another method of Console.
 *
 * `with console:` runs `console.__enter__()` and `console.__exit__()`, and
 * nobody writes either call. The plain "it calls nothing in that file" red
 * already knew that (#384): a method the language runs is put to the compiler
 * before it is called wrong. The near-miss red did not. When the body also
 * wrote `console.print(...)`, it said "it calls `print`, not `__enter__`" --
 * on main, on rich's `FileProxy.write`, caught by calls recorded while rich's
 * own tests ran (calls research 2026-11, side finding 1).
 *
 * The rule, as a fact about the languages: a call the language makes without
 * it being written -- a `with` block's `__enter__` and `__exit__`, an
 * `async with`'s `__aenter__` and `__aexit__`, a `for` loop's `__iter__`, an
 * operator's `__add__`; TypeScript's coercion to `toString` or `valueOf` --
 * is not ruled out by a written
 * call that lands on another routine of the far end's file. Both reds rest
 * on the same question, so both ask it.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { initEngine } from "../src/engine/parse";
import { dropRepo, redsOf, scratchRepo, verdicts } from "./helpers/arrow-probe";
import { installExcalifontMeasurer } from "./helpers/excalifont";

installExcalifontMeasurer();
beforeAll(async () => { await initEngine(); }, 60_000);

let repo: string | undefined;
afterEach(() => { if (repo) dropRepo(repo); repo = undefined; });

const PY = {
  "term.py": [
    "class Console:",
    "    def __init__(self, width: int):",
    "        self.width = width",
    "",
    "    def __enter__(self):",
    "        return self",
    "",
    "    def __exit__(self, *rest):",
    "        return None",
    "",
    "    async def __aenter__(self):",
    "        return self",
    "",
    "    async def __aexit__(self, *rest):",
    "        return None",
    "",
    "    def __iter__(self):",
    "        yield self.width",
    "",
    "    def __add__(self, other: \"Console\") -> \"Console\":",
    "        return Console(self.width + other.width)",
    "",
    "    def print(self, text: str) -> None:",
    "        pass",
    "",
    "    async def flush(self) -> None:",
    "        pass",
    "",
    "    def rule(self) -> None:",
    "        pass",
    "",
  ].join("\n"),
  "proxy.py": [
    "from term import Console",
    "",
    "",
    "def write(console: Console, text: str) -> None:",
    "    with console:",
    "        console.print(text)",
    "",
    "",
    "async def drain(console: Console) -> None:",
    "    async with console:",
    "        await console.flush()",
    "",
    "",
    "def each(console: Console) -> None:",
    "    for line in console:",
    "        console.print(str(line))",
    "",
    "",
    "def wider(a: Console, b: Console) -> Console:",
    "    a.rule()",
    "    return a + b",
    "",
    "",
    "class Proxy:",
    "    def __init__(self, console: Console) -> None:",
    "        self._console = console",
    "",
    "    def flush(self, text: str) -> None:",
    "        console = self._console",
    "        with console:",
    "            console.print(text)",
    "",
  ].join("\n"),
};

describe("Python: a call the language makes, beside a written call into the same file", () => {
  const RIGHT: Array<[string, string]> = [
    ["proxy.py#write", "term.py#__enter__"],
    ["proxy.py#write", "term.py#__exit__"],
    ["proxy.py#drain", "term.py#__aenter__"],
    ["proxy.py#drain", "term.py#__aexit__"],
    ["proxy.py#each", "term.py#__iter__"],
    ["proxy.py#wider", "term.py#__add__"],
    ["proxy.py#Proxy.flush", "term.py#__enter__"],
    ["proxy.py#Proxy.flush", "term.py#__exit__"],
  ];

  it("is not called wrong, with the compiler", async () => {
    repo = scratchRepo(PY);
    const { each } = await verdicts(repo, RIGHT.map(([from, to]) => [from, to, "calls"]));
    expect(each.map((one, index) => [RIGHT[index]!.join(" -> "), one.reds]))
      .toEqual(RIGHT.map((pair) => [pair.join(" -> "), []]));
  }, 180_000);

  it("is not called wrong with no compiler either", async () => {
    repo = scratchRepo(PY);
    const { each } = await verdicts(repo, RIGHT.map(([from, to]) => [from, to, "calls"]), { compiler: false });
    expect(each.map((one, index) => [RIGHT[index]!.join(" -> "), one.reds]))
      .toEqual(RIGHT.map((pair) => [pair.join(" -> "), []]));
  }, 60_000);

  it("still names the routine it does call, for an arrow to an ordinary method", async () => {
    repo = scratchRepo(PY);
    const { each } = await verdicts(repo, [
      ["proxy.py#write", "term.py#rule", "calls"],
      ["proxy.py#Proxy.flush", "term.py#rule", "calls"],
      ["proxy.py#wider", "term.py#print", "calls"],
    ]);
    expect(each.map((one) => one.reds)).toEqual([["calls-wrong-routine"], ["calls-wrong-routine"], ["calls-wrong-routine"]]);
  }, 180_000);
});

const TS = {
  "tsconfig.json": "{ \"compilerOptions\": { \"strict\": true, \"target\": \"es2022\", \"lib\": [\"es2022\", \"esnext.disposable\"] } }\n",
  "money.ts": [
    "export class Money {",
    "  constructor(private cents: number) {}",
    "  toString(): string {",
    "    return String(this.cents);",
    "  }",
    "  valueOf(): number {",
    "    return this.cents;",
    "  }",
    "  total(): number {",
    "    return this.cents;",
    "  }",
    "  round(): number {",
    "    return Math.round(this.cents);",
    "  }",
    "}",
    "",
  ].join("\n"),
  "a.ts": [
    "import { Money } from \"./money\";",
    "",
    "export function label(m: Money): string {",
    "  m.total();",
    "  return `${m}`;",
    "}",
    "",
    "export function plus(m: Money): number {",
    "  m.total();",
    "  return +m + 1;",
    "}",
    "",
  ].join("\n"),
};

describe("TypeScript: a method the language runs, beside a written call into the same file", () => {
  const RIGHT: Array<[string, string]> = [
    ["a.ts#label", "money.ts#toString"],
    ["a.ts#plus", "money.ts#valueOf"],
  ];

  it("is not called wrong, with the compiler", async () => {
    repo = scratchRepo(TS);
    const { each } = await verdicts(repo, RIGHT.map(([from, to]) => [from, to, "calls"]));
    expect(each.map((one, index) => [RIGHT[index]!.join(" -> "), one.reds]))
      .toEqual(RIGHT.map((pair) => [pair.join(" -> "), []]));
  }, 60_000);

  it("is not called wrong with no compiler either", async () => {
    repo = scratchRepo(TS);
    const { each } = await verdicts(repo, RIGHT.map(([from, to]) => [from, to, "calls"]), { compiler: false });
    expect(each.map((one, index) => [RIGHT[index]!.join(" -> "), one.reds]))
      .toEqual(RIGHT.map((pair) => [pair.join(" -> "), []]));
  }, 60_000);

  it("still names the routine it does call, for an arrow to an ordinary method", async () => {
    repo = scratchRepo(TS);
    expect(await redsOf(repo, ["a.ts#label", "money.ts#round", "calls"])).toEqual(["calls-wrong-routine"]);
  }, 60_000);
});
