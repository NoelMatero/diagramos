/**
 * The gate every red passes before it is shown (#393): the rule itself, and
 * the helpers each reader shares to say what it could not read.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { askTypeParts, gateRed, typeParametersIn, type RedRests } from "../src/engine/gate";
import type { ClosedBodyReferee } from "../src/engine/drift";
import { initEngine, parseSource, type Language } from "../src/engine/parse";

beforeAll(async () => { await initEngine(); }, 60_000);

const referee = {} as ClosedBodyReferee;
const says = (does: boolean | undefined): RedRests["ask"] => () => ({ does, said: "it said so" });

describe("the rule", () => {
  it("withdraws a red the compiler says the code does", () => {
    expect(gateRed({ written: true, ask: says(true) }, referee)).toMatchObject({ stands: false, why: "compiler-says-it-does" });
  });

  it("keeps a red the compiler says the code does not, written or not", () => {
    expect(gateRed({ written: false, ask: says(false) }, referee)).toMatchObject({ stands: true });
    expect(gateRed({ written: true, ask: says(false) }, referee)).toMatchObject({ stands: true });
  });

  it("keeps a red on written evidence when the compiler cannot say or is not there", () => {
    expect(gateRed({ written: true, ask: says(undefined) }, referee)).toMatchObject({ stands: true });
    expect(gateRed({ written: true, ask: says(true) }, undefined)).toMatchObject({ stands: true });
  });

  it("withholds a red that rests on what is not written when the compiler cannot say or is not there", () => {
    expect(gateRed({ written: false, ask: says(undefined) }, referee)).toMatchObject({ stands: false, why: "rests-on-unwritten" });
    expect(gateRed({ written: false, ask: says(true) }, undefined)).toMatchObject({ stands: false, why: "rests-on-unwritten" });
    expect(gateRed({ written: false }, referee)).toMatchObject({ stands: false, why: "rests-on-unwritten" });
  });
});

describe("asking what a type is made of, place by place", () => {
  const head = { name: "Engine", at: [{ file: "engine.ts", line: 1 }] };
  const place = (name: string, written: boolean) => ({ file: "car.ts", name, at: { start: 0, end: 1 }, written });
  const answering = (answers: Record<string, ReturnType<NonNullable<ClosedBodyReferee["typePartsAt"]>>>) =>
    ({ typePartsAt: (_file: string, at: { start: number }) => answers[String(at.start)] }) as unknown as ClosedBodyReferee;

  it("lets a place whose type is written stand on it when the compiler cannot say", () => {
    const referee = answering({ 0: undefined, 1: { parts: [{ name: "Motor", at: { file: "engine.ts", line: 2 } }], whole: true } });
    const places = [place("typed", true), { ...place("untyped", false), at: { start: 1, end: 2 } }];
    expect(askTypeParts(referee, places, head).does).toBe(false);
  });

  it("does not let a place whose type is not written stand on anything", () => {
    const referee = answering({ 0: undefined, 1: { parts: [{ name: "Motor", at: { file: "engine.ts", line: 2 } }], whole: true } });
    const places = [place("untyped", false), { ...place("typed", true), at: { start: 1, end: 2 } }];
    expect(askTypeParts(referee, places, head).does).toBeUndefined();
  });
});

describe("the type parameters a file declares (#380)", () => {
  const names = (source: string, language: Language) => [...typeParametersIn(parseSource(source, language)!.rootNode, source)].sort();

  it("reads TypeScript's names and not their bounds or defaults", () => {
    expect(names("export function f<T extends User, K = Order>(u: T): T { return u; }\nclass C<S> {}\n", "ts")).toEqual(["K", "S", "T"]);
  });

  it("reads Rust's, from functions, impls and structs, and leaves lifetimes out", () => {
    expect(names("pub fn g<'a, N: Named, M>(n: N) where M: Other {}\nimpl<T: X> Foo<T> {}\npub struct Gen<S: Seat> { seat: S }\n", "rust")).toEqual(["M", "N", "S", "T"]);
  });

  it("reads Python's, written as a TypeVar or in brackets", () => {
    expect(names("T = TypeVar('T', bound=User)\nclass H[S: Seat]:\n    pass\ndef f[U](u: U) -> U: ...\n", "python")).toEqual(["S", "T", "U"]);
  });
});
