/**
 * `measure:calls`' second referee (#254).
 *
 * The text scan behind `@calls`' licence cannot say whose `foo` `x.foo()` is,
 * so 1,995 calls were left out of the number the licence rests on. A real
 * checker can: asked "go to definition" at `foo`, it names the declaration.
 * These tests pin the pieces that turn that answer into a verdict on the reader.
 */
import { describe, expect, it } from "vitest";

import { callSitesOn, landingOf, scoreReceiverCall } from "../scripts/lib/call-receivers";

/** The text each range covers, so a wrong offset reads as a wrong word. */
const covered = (source: string, ranges: Array<{ start: number; end: number }>) =>
  ranges.map(({ start, end }) => `${source.slice(0, start).split("\n").length}:${source.slice(start, end)}`);

describe("callSitesOn: where a call the text scan saw is written", () => {
  it("finds a call on a namespace or a value, in TypeScript", () => {
    const source = "import * as util from './util';\nexport function run() {\n  util.foo(1); obj?.foo();\n}\n";
    expect(covered(source, callSitesOn(source, 3, "foo", "receiver", "ts"))).toEqual(["3:foo", "3:foo"]);
  });

  it("finds a call at the end of a chain, in Python", () => {
    const source = "def run(self):\n    return self.cache . foo (1)\n";
    expect(covered(source, callSitesOn(source, 2, "foo", "receiver", "python"))).toEqual(["2:foo"]);
  });

  it("finds a path call, in Rust", () => {
    const source = "fn run() {\n    let x = Store::foo();\n}\n";
    expect(covered(source, callSitesOn(source, 2, "foo", "receiver", "rust"))).toEqual(["2:foo"]);
  });

  it("reads past a lifetime in Rust rather than taking it for a string", () => {
    const source = "fn run<'a>(s: &'a Store) {\n    let x: &'a str = s.foo(); let y: &'a u8 = s.foo();\n}\n";
    expect(covered(source, callSitesOn(source, 2, "foo", "receiver", "rust"))).toEqual(["2:foo", "2:foo"]);
  });

  it("does not take a longer name, a bare call or an attribute for a receiver call", () => {
    const source = "function run() {\n  x.foobar(); foo(); x.foo; y.foo();\n}\n";
    expect(covered(source, callSitesOn(source, 2, "foo", "receiver", "ts"))).toEqual(["2:foo"]);
    expect(covered(source, callSitesOn(source, 2, "foo", "bare", "ts"))).toEqual(["2:foo"]);
  });

  it("does not take a call written inside a string or a comment", () => {
    const ts = "function run() {\n  log('x.foo()'); y.foo(); // z.foo()\n}\n";
    expect(covered(ts, callSitesOn(ts, 2, "foo", "receiver", "ts"))).toEqual(["2:foo"]);
    const python = "def run():\n    log(\"x.foo()\"); y.foo()  # z.foo()\n";
    expect(callSitesOn(python, 2, "foo", "receiver", "python")).toHaveLength(1);
  });
});

describe("landingOf: whether the call is to the one routine the text scan meant", () => {
  const files: Record<string, string[]> = {
    "/repo/store.py": ["class Store:", "    def foo(self):", "        pass", "    def bar(self):"],
    "/repo/other.py": ["def foo():"],
  };
  const lineOf = (file: string, line: number) => files[file]?.[line];

  it("lands when the checker names a line in the target file that declares the name", () => {
    expect(landingOf([{ file: "/repo/store.py", line: 1 }], "/repo/store.py", "foo", lineOf))
      .toEqual({ kind: "lands" });
  });

  it("lands when any one site of the call does, since one real call is the call", () => {
    const answers = [{ file: "/lib/typeshed/str.pyi", line: 9 }, undefined, { file: "/repo/store.py", line: 1 }];
    expect(landingOf(answers, "/repo/store.py", "foo", lineOf)).toEqual({ kind: "lands" });
  });

  it("is elsewhere when every site answered and none is the target: a library, or another file", () => {
    expect(landingOf([{ file: "/lib/typeshed/str.pyi", line: 9 }], "/repo/store.py", "foo", lineOf))
      .toEqual({ kind: "elsewhere", at: { file: "/lib/typeshed/str.pyi", line: 9 } });
    expect(landingOf([{ file: "/repo/other.py", line: 0 }], "/repo/store.py", "foo", lineOf).kind).toBe("elsewhere");
  });

  it("is elsewhere when the checker names the target file but a line that is not this routine", () => {
    expect(landingOf([{ file: "/repo/store.py", line: 3 }], "/repo/store.py", "foo", lineOf).kind).toBe("elsewhere");
  });

  it("stays silent, with the reason, rather than guessing from part of an answer", () => {
    expect(landingOf([], "/repo/store.py", "foo", lineOf)).toEqual({ kind: "silent", why: "no-site" });
    expect(landingOf([undefined, undefined], "/repo/store.py", "foo", lineOf))
      .toEqual({ kind: "silent", why: "checker-silent" });
    expect(landingOf([{ file: "/repo/other.py", line: 0 }, undefined], "/repo/store.py", "foo", lineOf))
      .toEqual({ kind: "silent", why: "partly-silent" });
  });
});

describe("scoreReceiverCall: what the reader's answer was worth", () => {
  const lands = { kind: "lands" } as const;
  const elsewhere = { kind: "elsewhere", at: { file: "/lib/x.d.ts", line: 0 } } as const;

  it("scores a real call the way the bare-call population is scored", () => {
    expect(scoreReceiverCall(lands, "confirmed")).toBe("agreed");
    expect(scoreReceiverCall(lands, "withheld")).toBe("refused");
    expect(scoreReceiverCall(lands, "absent")).toBe("missed");
    expect(scoreReceiverCall(lands, "backwards")).toBe("accused");
  });

  it("calls a confirmation of a call that goes somewhere else invented", () => {
    expect(scoreReceiverCall(elsewhere, "confirmed")).toBe("invented");
    expect(scoreReceiverCall(elsewhere, "withheld")).toBe("rightly-unconfirmed");
    expect(scoreReceiverCall(elsewhere, "absent")).toBe("rightly-unconfirmed");
  });

  it("keeps a backwards verdict on a call that goes elsewhere apart, since only one direction was checked", () => {
    expect(scoreReceiverCall(elsewhere, "backwards")).toBe("backwards-elsewhere");
  });
});
