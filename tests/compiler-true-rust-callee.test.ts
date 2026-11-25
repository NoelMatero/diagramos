/**
 * The Rust referee of `measure:compiler-true` reads the path rustc prints
 * for a called function, not only its last name.
 *
 * It held four arrows to be true that are not: each tail calls a *different*
 * function of the same name -- std's, a string's own, the one in its own
 * file -- and the referee matched the name against the one free function of
 * that name a board can draw. They showed as reds on "correct code" the
 * moment a Rust body could be read to its end without a compiler (calls
 * research, 2026-11), and each was read in the source before this was
 * written. The lines below are rustc's own, from its list of each body.
 */
import { describe, expect, it } from "vitest";

import { declaredInModule, freeCallee } from "../scripts/lib/compiler-true-rust";

describe("what a callee rustc printed names", () => {
  it("regex `write_label`: `label.len()` is str's own `len`, not `utf8.rs#len`", () => {
    expect(freeCallee("core::str::<impl str>::len")).toBeUndefined();
    expect(freeCallee("core::slice::<impl [u8]>::copy_from_slice")).toBeUndefined();
  });

  it("ripgrep `is_tty_stdout`: `std::io::stdout()` is std's, not `wtr.rs#stdout`", () => {
    expect(freeCallee("std::io::stdout")).toBeUndefined();
    expect(freeCallee("core::mem::swap")).toBeUndefined();
    expect(freeCallee("alloc::fmt::format")).toBeUndefined();
  });

  it("clap `did_you_mean_flag`: `suggestions::did_you_mean` is the one in `suggestions.rs`, not `format.rs`'s", () => {
    const named = freeCallee("suggestions::did_you_mean");
    expect(named).toEqual({ name: "did_you_mean", module: "suggestions" });
    expect(declaredInModule("clap_builder/src/error/format.rs", "fn did_you_mean() {}\n", named!.module!)).toBe(false);
    expect(declaredInModule("clap_builder/src/parser/features/suggestions.rs", "", named!.module!)).toBe(true);
  });

  it("a call within one module is printed bare, and still names the crate's function", () => {
    expect(freeCallee("write_label_len")).toEqual({ name: "write_label_len" });
    expect(freeCallee("padding_len")).toEqual({ name: "padding_len" });
  });

  it("a path through a trait or a type's impl is not a free function at all", () => {
    expect(freeCallee("<Lexer as Iterator>::next")).toBeUndefined();
  });
});

describe("which file a module's name means", () => {
  it("the file of that name, its `mod.rs`, or a `mod` written inside the file", () => {
    expect(declaredInModule("src/util/wire.rs", "", "wire")).toBe(true);
    expect(declaredInModule("src/util/mod.rs", "", "util")).toBe(true);
    expect(declaredInModule("src/util/wire.rs", "mod imp {\n    pub fn go() {}\n}\n", "imp")).toBe(true);
    expect(declaredInModule("src/util/wire.rs", "", "utf8")).toBe(false);
  });

  it("never rules out a crate's root file, which paths name by the crate", () => {
    expect(declaredInModule("src/lib.rs", "", "regex_automata")).toBe(true);
    expect(declaredInModule("src/main.rs", "", "rg")).toBe(true);
  });
});
