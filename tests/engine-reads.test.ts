/**
 * Every member a routine reads, and what type it was read off (#255).
 *
 * `resolution.ts` already answers "what is `x` in `x.foo()`". This is the same
 * question asked of `x.width` -- a read rather than a call -- because that is
 * the population `@accesses` claims about, and the routine end of that word
 * cannot say *wrong* until every read in a body has been seen.
 *
 * A measurement's reader. Nothing here accuses; see the module doc.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { initEngine } from "../src/engine/parse";
import { memberReadsIn, type ReadsReading } from "../src/engine/resolution";
import { type ResolutionVerdict } from "../src/engine/resolution";

beforeAll(async () => { await initEngine(); }, 120_000);

function verdictOf(verdict: ResolutionVerdict): string {
  if (verdict.verdict === "withheld") return `withheld/${verdict.why}`;
  return `resolved/${verdict.evidence.shape}/${verdict.evidence.type}`;
}

function sitesOf(reading: ReadsReading) {
  if (!reading.read) throw new Error(`unreadable: ${reading.why}`);
  return reading.routines.flatMap((routine) => routine.sites);
}

function onlySite(reading: ReadsReading) {
  const sites = sitesOf(reading);
  expect(sites).toHaveLength(1);
  return sites[0]!;
}

describe("a read off an annotated parameter", () => {
  it("finds the member and names the type it was read off", () => {
    const source = "function draw(c: Config) {\n  return c.width;\n}";
    const site = onlySite(memberReadsIn(source, "ts"));
    expect(site.member).toBe("width");
    expect(verdictOf(site.verdict)).toBe("resolved/annotated-parameter/Config");
  });
});

describe("a read off the routine's own type", () => {
  it("names the enclosing class, which is where most reads are", () => {
    const source = "class Renderer {\n  width = 1;\n  draw() {\n    return this.width;\n  }\n}";
    const site = onlySite(memberReadsIn(source, "ts"));
    expect(site.member).toBe("width");
    expect(site.kind).toBe("own");
    expect(verdictOf(site.verdict)).toBe("resolved/enclosing-type/Renderer");
  });

  it("names the enclosing class in Python, where most attributes are read", () => {
    const source = "class Config:\n    def read(self):\n        return self.width\n";
    const site = onlySite(memberReadsIn(source, "python"));
    expect(site.member).toBe("width");
    expect(verdictOf(site.verdict)).toBe("resolved/enclosing-type/Config");
  });

  it("names the type an `impl` block is for, which the struct does not contain", () => {
    const source = "struct Config { width: u32 }\nimpl Config {\n  fn read(&self) -> u32 { self.width }\n}";
    const site = onlySite(memberReadsIn(source, "rust"));
    expect(site.member).toBe("width");
    expect(verdictOf(site.verdict)).toBe("resolved/enclosing-type/Config");
  });
});

describe("a read off one of the routine's own fields", () => {
  it("resolves through the declared field, not through the class", () => {
    const source = "class Renderer {\n  cache: Config = load();\n  draw() {\n    return this.cache.width;\n  }\n}";
    const sites = sitesOf(memberReadsIn(source, "ts"));
    const width = sites.find((one) => one.member === "width")!;
    expect(width.kind).toBe("field");
    expect(width.receiver).toBe("cache");
    expect(verdictOf(width.verdict)).toBe("resolved/declared-field/Config");
  });

  it("counts the intermediate read as well, so a body's read set is complete", () => {
    const source = "class Renderer {\n  cache: Config = load();\n  draw() {\n    return this.cache.width;\n  }\n}";
    const members = sitesOf(memberReadsIn(source, "ts")).map((one) => one.member).sort();
    expect(members).toEqual(["cache", "width"]);
  });
});

describe("reads this reader cannot place, which decide whether a body is closed", () => {
  it("counts a read off a call rather than dropping it", () => {
    const source = "function f() {\n  return make().width;\n}";
    const site = onlySite(memberReadsIn(source, "ts"));
    expect(site.member).toBe("width");
    expect(verdictOf(site.verdict)).toBe("withheld/not-a-name");
  });

  it("counts a read off an index rather than dropping it", () => {
    const source = "function f(rows: Row[]) {\n  return rows[0].width;\n}";
    const members = sitesOf(memberReadsIn(source, "ts")).map((one) => one.member);
    expect(members).toContain("width");
    const width = sitesOf(memberReadsIn(source, "ts")).find((one) => one.member === "width")!;
    expect(verdictOf(width.verdict)).toBe("withheld/not-a-name");
  });

  it("counts a chained read off another read", () => {
    const source = "function f(a: A) {\n  return a.b.c;\n}";
    const sites = sitesOf(memberReadsIn(source, "ts"));
    expect(sites.map((one) => one.member).sort()).toEqual(["b", "c"]);
    expect(verdictOf(sites.find((one) => one.member === "b")!.verdict)).toBe("resolved/annotated-parameter/A");
    expect(verdictOf(sites.find((one) => one.member === "c")!.verdict)).toBe("withheld/not-a-name");
  });
});

describe("a method call is a read of that member", () => {
  it("reads `cfg.width()` as reading width, the way accesses.ts counts it", () => {
    const source = "function f(c: Config) {\n  return c.width();\n}";
    const site = onlySite(memberReadsIn(source, "ts"));
    expect(site.member).toBe("width");
    expect(verdictOf(site.verdict)).toBe("resolved/annotated-parameter/Config");
  });
});

describe("a checker's answer, for the reads the text cannot place", () => {
  it("leaves the syntactic verdict alone and records the answer beside it", () => {
    const source = "function f() {\n  const x = load();\n  return x.width;\n}";
    const bare = onlySite(memberReadsIn(source, "ts"));
    expect(verdictOf(bare.verdict)).toBe("withheld/from-a-call");
    expect(bare.placed).toBeUndefined();

    const asked = onlySite(memberReadsIn(source, "ts", () => ({
      kind: "declared", file: "config.ts", concrete: true,
    })));
    expect(verdictOf(asked.verdict)).toBe("withheld/from-a-call");
    expect(asked.placed).toEqual({ kind: "declared", file: "config.ts", concrete: true });
  });

  it("asks about the receiver's own position, not the member's", () => {
    const source = "function f() {\n  const x = load();\n  return x.width;\n}";
    const asked: Array<{ start: number; end: number }> = [];
    memberReadsIn(source, "ts", (at) => { asked.push(at); return undefined; });
    expect(asked).toHaveLength(1);
    expect(source.slice(asked[0]!.start, asked[0]!.end)).toBe("x");
  });

  it("records nothing when the checker has no opinion", () => {
    const source = "function f() {\n  const x = load();\n  return x.width;\n}";
    expect(onlySite(memberReadsIn(source, "ts", () => undefined)).placed).toBeUndefined();
  });
});

/*
 * The reads that do not look like reads.
 *
 * `const { width } = config` reads `width` off Config, and neither this
 * reader nor `scripts/lib/access-scan.ts` -- the independent referee -- sees
 * anything at all. They agree, a measurement reports nothing, and a
 * routine-end refutation would call a correct arrow wrong. `accesses.ts`
 * already records destructuring as a known gap, on the grounds that it only
 * ever costs a confirmation; the moment that end can accuse, the same gap
 * makes a false red.
 *
 * This is #219's own lesson repeating: a hole a referee structurally cannot
 * find has to be caught by reading the language instead.
 */
describe("reads that no `.name` appears for", () => {
  const hazardsOf = (source: string, language: Parameters<typeof memberReadsIn>[1]) => {
    const reading = memberReadsIn(source, language);
    if (!reading.read) throw new Error("unreadable");
    return reading.routines.flatMap((one) => one.hazards).map((one) => one.kind).sort();
  };

  it("flags a destructured binding in TypeScript", () => {
    expect(hazardsOf("function f(c: C) {\n  const { width } = c;\n}", "ts")).toEqual(["destructured"]);
  });

  it("flags a destructured parameter, which is outside the body", () => {
    expect(hazardsOf("function f({ width }: C) {\n  return width;\n}", "ts")).toEqual(["destructured"]);
  });

  it("flags a Rust struct pattern, which is how Rust spells it", () => {
    expect(hazardsOf("fn f(c: C) {\n  let C { width } = c;\n}", "rust")).toEqual(["destructured"]);
  });

  it("does not flag Python tuple unpacking, which reads no member", () => {
    expect(hazardsOf("def f(c):\n    width, height = c\n", "python")).toEqual([]);
  });

  it("flags an object spread, which reads every member at once", () => {
    expect(hazardsOf("function f(c: C) {\n  return { ...c };\n}", "ts")).toEqual(["spread"]);
  });

  it("does not flag an array spread, which reads no member", () => {
    expect(hazardsOf("function f(a: A[]) {\n  return [...a];\n}", "ts")).toEqual([]);
  });

  it("flags Rust's struct update syntax, its spelling of the same thing", () => {
    expect(hazardsOf("fn f(c: C) -> C {\n  C { width: 1, ..c }\n}", "rust")).toEqual(["spread"]);
  });

  it("flags Python's dictionary splat", () => {
    expect(hazardsOf("def f(c):\n    return {**c}\n", "python")).toEqual(["spread"]);
  });

  it("flags a computed member, which can name any member at all", () => {
    expect(hazardsOf("function f(c: C, k: string) {\n  return c[k];\n}", "ts")).toEqual(["computed"]);
  });

  it("flags the same shape in Python and Rust", () => {
    expect(hazardsOf("def f(c, k):\n    return c[k]\n", "python")).toEqual(["computed"]);
    expect(hazardsOf("fn f(c: Vec<u8>, k: usize) -> u8 {\n  c[k]\n}", "rust")).toEqual(["computed"]);
  });

  it("leaves an ordinary body with no hazard at all", () => {
    expect(hazardsOf("function f(c: C) {\n  return c.width;\n}", "ts")).toEqual([]);
  });
});
