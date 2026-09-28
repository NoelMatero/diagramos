/**
 * A Rust struct with no fields holds nothing (#366, section 6).
 *
 * `pub struct Serializer;` has no fields, so an arrow saying it holds a
 * `Value` is wrong. The reader declined instead ("no fields to read"): a unit
 * struct has no field list node at all, so it looked unread rather than
 * empty, and 2 wrong arrows on the planted bench stayed quiet (serde_json's
 * `value/ser.rs#Serializer` and `value/de.rs#ValueVisitor`, both -> `Value`).
 *
 * Rust only: a struct cannot grow a field anywhere but its declaration.
 * Found on the way, and red on correct code on main: a Rust tuple struct,
 * `struct S(Value);`, read as holding nothing at all, and an enum variant
 * with two fields read only its first.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { heldTypes, type HoldsVerdict } from "../src/engine/holds";
import { initEngine } from "../src/engine/parse";

beforeAll(async () => { await initEngine(); }, 120_000);

function verdictOf(verdict: HoldsVerdict): string {
  return verdict.verdict === "withheld" ? `withheld/${verdict.why}` : verdict.verdict;
}

describe("a Rust struct with no fields", () => {
  it("a unit struct, as serde_json writes its Serializer", () => {
    const verdict = heldTypes("pub struct Serializer;\n", "Serializer", ["Value"], "rust");
    expect(verdictOf(verdict)).toBe("absent");
    // An accusation shows what it read.
    if (verdict.verdict === "absent") expect(verdict.fields).toBe("pub struct Serializer;");
  });

  it("a private unit struct with a derive", () => {
    expect(verdictOf(heldTypes("#[derive(Clone, Copy)]\nstruct ValueVisitor;\n", "ValueVisitor", ["Value"], "rust")))
      .toBe("absent");
  });

  it("an empty braced struct", () => {
    expect(verdictOf(heldTypes("pub struct S {}\n", "S", ["Value"], "rust"))).toBe("absent");
  });

  it("an empty tuple struct", () => {
    expect(verdictOf(heldTypes("pub struct S();\n", "S", ["Value"], "rust"))).toBe("absent");
  });
});

describe("what still holds, or cannot be told", () => {
  /*
   * Red on main: a tuple list carries one `type` per field on itself, and the
   * reader took only the first -- and on a tuple struct, where the list is the
   * body, none at all. Every Rust tuple struct read as holding nothing.
   */
  it("a tuple struct with a field of the type confirms", () => {
    expect(verdictOf(heldTypes("pub struct S(Value);\n", "S", ["Value"], "rust"))).toBe("confirmed");
  });

  it("a tuple struct with a public field and a generic confirms", () => {
    expect(verdictOf(heldTypes("pub struct S(pub u8, Vec<Value>);\n", "S", ["Value"], "rust"))).toBe("confirmed");
  });

  it("an enum variant whose second field is the type confirms", () => {
    expect(verdictOf(heldTypes("enum K {\n    A(u8, Value),\n}\n", "K", ["Value"], "rust"))).toBe("confirmed");
  });

  it("a tuple struct without the type is still absent", () => {
    expect(verdictOf(heldTypes("pub struct S(u8, String);\n", "S", ["Value"], "rust"))).toBe("absent");
  });

  it("a unit struct a setting swaps for one with the field confirms", () => {
    const source = "#[cfg(test)]\npub struct S;\n#[cfg(not(test))]\npub struct S {\n    v: Value,\n}\n";
    expect(verdictOf(heldTypes(source, "S", ["Value"], "rust"))).toBe("confirmed");
  });
});
