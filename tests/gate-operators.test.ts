/**
 * "equal calls Money.__eq__" is not called wrong when the call is one the
 * language makes: `a == b` runs `__eq__`, `` `${m}` `` runs `toString`
 * (#384, #393).
 *
 * Nobody writes those calls, so "every call was checked and none reaches it"
 * is no evidence for a method the language runs on the caller's behalf --
 * Rust has treated its operator traits that way since #357. The red is now
 * put to the compiler: which method that name lands on for each value the
 * routine uses. With no compiler it is withheld.
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
  "money.py": [
    "class Money:",
    "    def __init__(self, cents):",
    "        self.cents = cents",
    "",
    "    def __eq__(self, other):",
    "        return self.cents == other.cents",
    "",
    "    def __add__(self, other):",
    "        return Money(self.cents + other.cents)",
    "",
    "    def __str__(self):",
    "        return str(self.cents)",
    "",
    "    def __len__(self):",
    "        return 1",
    "",
    "    def __contains__(self, x):",
    "        return x == self.cents",
    "",
    "    def __iter__(self):",
    "        yield self.cents",
    "",
    "    def __hash__(self):",
    "        return hash(self.cents)",
    "",
    "    def total(self):",
    "        return self.cents",
    "",
  ].join("\n"),
  "a.py": [
    "from money import Money",
    "",
    "",
    "def equal(a, b: Money):",
    "    return a == b",
    "",
    "",
    "def add(a: Money, b: Money):",
    "    return a + b",
    "",
    "",
    "def show(m: Money):",
    "    return f\"{m}\"",
    "",
    "",
    "def size(m: Money):",
    "    return len(m)",
    "",
    "",
    "def has(m: Money):",
    "    return 3 in m",
    "",
    "",
    "def loop(m: Money):",
    "    return [x for x in m]",
    "",
    "",
    "def key(m: Money):",
    "    return {m: 1}",
    "",
    "",
    "def cents(m: Money):",
    "    return m.cents",
    "",
    "",
    "def count(n: int):",
    "    return n == 1",
    "",
  ].join("\n"),
};

describe("Python, a method an operator or a builtin runs", () => {
  const RIGHT: Array<[string, string]> = [
    ["a.py#equal", "money.py#__eq__"],
    ["a.py#add", "money.py#__add__"],
    ["a.py#show", "money.py#__str__"],
    ["a.py#size", "money.py#__len__"],
    ["a.py#has", "money.py#__contains__"],
    ["a.py#loop", "money.py#__iter__"],
    ["a.py#key", "money.py#__hash__"],
  ];

  it("stays quiet on each", async () => {
    repo = scratchRepo(PY);
    const { each } = await verdicts(repo, RIGHT.map(([from, to]) => [from, to, "calls"]));
    expect(each.map((one, index) => [RIGHT[index]!.join(" -> "), one.reds])).toEqual(RIGHT.map((pair) => [pair.join(" -> "), []]));
  }, 180_000);

  it("is withheld, not red, with no compiler", async () => {
    repo = scratchRepo(PY);
    const { each: [arrow] } = await verdicts(repo, [["a.py#equal", "money.py#__eq__", "calls"]], { compiler: false });
    expect(arrow).toEqual({ reds: [], unconfirmed: "rests-on-unwritten" });
  }, 60_000);

  it("still calls it wrong when pyright says no value there has that method", async () => {
    repo = scratchRepo(PY);
    expect(await redsOf(repo, ["a.py#count", "money.py#__eq__", "calls"])).toEqual(["calls-refuted"]);
  }, 180_000);

  it("still calls wrong an arrow to an ordinary method, with no compiler", async () => {
    repo = scratchRepo(PY);
    expect(await redsOf(repo, ["a.py#cents", "money.py#total", "calls"], { compiler: false })).toEqual(["calls-refuted"]);
  }, 60_000);
});

const TS = {
  "tsconfig.json": "{ \"compilerOptions\": { \"strict\": true, \"target\": \"es2022\" } }\n",
  "money.ts": [
    "export class Money {",
    "  constructor(private cents: number) {}",
    "  valueOf(): number {",
    "    return this.cents;",
    "  }",
    "  toJSON(): object {",
    "    return { cents: this.cents };",
    "  }",
    "  toString(): string {",
    "    return String(this.cents);",
    "  }",
    "  total(): number {",
    "    return this.cents;",
    "  }",
    "}",
    "",
    "export class Later {",
    "  then(ok: (v: number) => void): void {",
    "    ok(1);",
    "  }",
    "}",
    "",
  ].join("\n"),
  "a.ts": [
    "import { Money, Later } from \"./money\";",
    "",
    "export function add(m: Money): number {\n  return +m + 1;\n}",
    "export function compare(a: Money, b: Money): boolean {\n  return a > b;\n}",
    "export function serialise(m: Money): string {\n  return JSON.stringify(m);\n}",
    "export function interp(m: Money): string {\n  return `${m}`;\n}",
    "export async function wait(l: Later): Promise<number> {\n  return await l;\n}",
    "export function count(n: number): number {\n  return +n;\n}",
    "",
  ].join("\n"),
};

describe("TypeScript, a method the language runs", () => {
  const RIGHT: Array<[string, string]> = [
    ["a.ts#add", "money.ts#valueOf"],
    ["a.ts#compare", "money.ts#valueOf"],
    ["a.ts#serialise", "money.ts#toJSON"],
    ["a.ts#interp", "money.ts#toString"],
    ["a.ts#wait", "money.ts#then"],
  ];

  it("stays quiet on each", async () => {
    repo = scratchRepo(TS);
    const { each } = await verdicts(repo, RIGHT.map(([from, to]) => [from, to, "calls"]));
    expect(each.map((one, index) => [RIGHT[index]!.join(" -> "), one.reds])).toEqual(RIGHT.map((pair) => [pair.join(" -> "), []]));
  }, 60_000);

  it("is withheld, not red, with no compiler", async () => {
    repo = scratchRepo(TS);
    const { each: [arrow] } = await verdicts(repo, [["a.ts#interp", "money.ts#toString", "calls"]], { compiler: false });
    expect(arrow).toEqual({ reds: [], unconfirmed: "rests-on-unwritten" });
  }, 60_000);

  it("still calls it wrong when the compiler says no value there has that method", async () => {
    repo = scratchRepo(TS);
    expect(await redsOf(repo, ["a.ts#count", "money.ts#valueOf", "calls"])).toEqual(["calls-refuted"]);
  }, 60_000);

  it("still calls wrong an arrow to an ordinary method, with no compiler", async () => {
    repo = scratchRepo(TS);
    expect(await redsOf(repo, ["a.ts#add", "money.ts#total", "calls"], { compiler: false })).toEqual(["calls-refuted"]);
  }, 60_000);
});
