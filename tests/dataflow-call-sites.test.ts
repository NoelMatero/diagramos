/**
 * Which calls the dataflow reader writes a call site for (#203).
 *
 * `settleCalls` -- the "+ resolved calls" half of `measure:dataflow`, and the
 * 1.4% #203 quotes -- can only ask about a call that is in `body.calls`.
 * `calleeName` answers for a bare name and for `self.foo()` / `this.foo()`, and
 * `body.calls` is appended to `if (callee)`, so a call on any other receiver
 * records no site: the value escapes `passed-to-a-call` and there is nothing
 * for a resolver to be pointed at.
 *
 * Measured over the corpus that is 4,191 of 9,257 values (45.3%) and 87.4% of
 * Python's doors (`measure:dataflow-reach`, `measure:door-values`). These tests
 * pin the boundary rather than assert it is right, so that closing it is a
 * deliberate change to this file and not a silent one -- the escape is recorded
 * either way, so the gap costs coverage and never a false `contained`.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { readBodies, type Body } from "../src/engine/dataflow";
import { initEngine, type Language } from "../src/engine/parse";

const routineIn = (source: string, language: Language): Body => {
  const { bodies } = readBodies(source, language);
  const found = bodies.find((body) => body.scope === "routine");
  if (!found) throw new Error("no routine body was read");
  return found;
};

const escapesOf = (body: Body, name: string) =>
  body.locals.find((local) => local.name === name)?.escapes ?? [];

const calleesOf = (body: Body) => body.calls.map((call) => call.callee);

describe("the calls a body records a site for", () => {
  beforeAll(async () => { await initEngine(); });

  it("records a bare call, and which local went in", () => {
    const body = routineIn(
      'import { writeFileSync } from "node:fs";\n'
      + "export function save(rows: string) {\n"
      + "  const body = shape(rows);\n"
      + '  writeFileSync("/tmp/x", body);\n'
      + "}\n",
      "ts",
    );
    expect(calleesOf(body)).toContain("writeFileSync");
    expect(body.calls.find((call) => call.callee === "writeFileSync")?.passed).toEqual(["body"]);
    expect(escapesOf(body, "body")).toEqual(["passed-to-a-call"]);
  });

  it("records nothing for the same door written on a namespace", () => {
    const body = routineIn(
      'import fs from "node:fs";\n'
      + "export function save(rows: string) {\n"
      + "  const body = shape(rows);\n"
      + '  fs.writeFileSync("/tmp/x", body);\n'
      + "}\n",
      "ts",
    );
    expect(calleesOf(body)).not.toContain("writeFileSync");
    // The exit is still recorded, so the gap never buys a false `contained`.
    expect(escapesOf(body, "body")).toEqual(["passed-to-a-call"]);
  });

  it("records nothing for a Python module-qualified call", () => {
    const body = routineIn(
      "import os\n"
      + "def save(rows):\n"
      + "    body = shape(rows)\n"
      + '    os.replace(body, "/tmp/x")\n',
      "python",
    );
    expect(calleesOf(body)).not.toContain("replace");
    expect(escapesOf(body, "body")).toEqual(["passed-to-a-call"]);
  });

  it("records a Python bare call", () => {
    const body = routineIn(
      "def save(rows):\n"
      + "    body = shape(rows)\n"
      + "    open(body)\n",
      "python",
    );
    expect(calleesOf(body)).toContain("open");
    expect(escapesOf(body, "body")).toEqual(["passed-to-a-call"]);
  });

  it("records nothing for a method on a value", () => {
    const body = routineIn(
      "def save(rows, handle):\n"
      + "    body = shape(rows)\n"
      + "    handle.write(body)\n",
      "python",
    );
    expect(calleesOf(body)).not.toContain("write");
    expect(escapesOf(body, "body")).toEqual(["passed-to-a-call"]);
  });

  it("records a call on `this`, which is the one receiver it answers for", () => {
    const body = routineIn(
      "export class Store {\n"
      + "  keep(rows: string) {\n"
      + "    const body = shape(rows);\n"
      + "    this.write(body);\n"
      + "  }\n"
      + "}\n",
      "ts",
    );
    expect(calleesOf(body)).toContain("write");
    expect(escapesOf(body, "body")).toEqual(["passed-to-a-call"]);
  });
});
