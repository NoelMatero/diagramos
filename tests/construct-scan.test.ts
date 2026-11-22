/**
 * The text-scan referee `measure:builds-absent` and `measure:constructs` read
 * Rust with (#422): a struct name inside a string is not a construction.
 */
import { describe, expect, it } from "vitest";

import { refereeRoutines } from "../scripts/lib/construct-scan";

const makes = (source: string) =>
  Object.fromEntries(refereeRoutines(source, "rust").map((routine) => [routine.name, routine.makes]));

describe("Rust: what the referee scan says a routine makes", () => {
  it("does not read a struct name in a format string as building it (clap, regex)", () => {
    expect(makes(
      "fn help() {\n    debug_assert!(x, \"for the Command {}, but\", y);\n}\n"
        + "fn fmt(f: &mut F) -> R {\n    write!(f, \"StartByteMap{{\")?;\n    Ok(())\n}\n",
    )).toEqual({ help: [], fmt: [] });
  });

  it("does not read one in a raw string or count a brace in a char", () => {
    expect(makes("fn r() {\n    let s = r#\"Fake { }\"#;\n    let c = '{';\n}\nfn b() { Other { y: 2 } }\n"))
      .toEqual({ r: [], b: ["Other"] });
  });

  it("still reads a struct literal written as code", () => {
    expect(makes("fn a() {\n    let s = Real { x: 1 };\n}\n")).toEqual({ a: ["Real"] });
  });
});
