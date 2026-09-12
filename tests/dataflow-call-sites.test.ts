/**
 * Which calls a body records, and which of those it can put a name to (#203).
 *
 * `settleCalls` -- the "+ resolved calls" half of `measure:dataflow` -- can only
 * ask about a call that is in `body.calls`. `calleeName` answers for a bare name
 * and for `self.foo()` / `this.foo()`, and `body.calls` used to be appended to
 * `if (callee)`, so a call on any other receiver was recorded **nowhere**:
 * `store.keep(v)` made `v` escape `passed-to-a-call` and left nothing for a
 * resolver to be pointed at. Measured over the corpus that was 4,191 of 9,257
 * values, 45.3%, absent from the question in the numerator and the denominator
 * alike -- and 87.4% of Python's doors.
 *
 * Now the site is recorded with an **empty callee**, which is the refusal
 * `settleCalls` and `keeps` have always had a branch for and could never reach:
 * `callee-is-a-method`. So the population is counted rather than silent.
 *
 * The distinction these tests hold is the one that matters: recording the site
 * must not make it *resolvable*. Resolving `handle.write(body)` by name would
 * find any local routine called `write` and read the wrong body -- which could
 * free a value that did leave. An empty name cannot be looked up, so the site
 * can only ever refuse.
 */
import { beforeAll, describe, expect, it } from "vitest";

import {
  chainFrom, contained, readBodies, settleCalls,
  type Body, type Resolver,
} from "../src/engine/dataflow";
import { initEngine, type Language } from "../src/engine/parse";

const routineIn = (source: string, language: Language): Body => {
  const { bodies } = readBodies(source, language);
  const found = bodies.find((body) => body.scope === "routine");
  if (!found) throw new Error("no routine body was read");
  return found;
};

const escapesOf = (body: Body, name: string) =>
  body.locals.find((local) => local.name === name)?.escapes ?? [];

const named = (body: Body) => body.calls.map((call) => call.callee).filter(Boolean);

/** A resolver that answers for nothing, so only the refusals are on show. */
const resolvesNothing: Resolver = () => undefined;

describe("the calls a body records a site for", () => {
  beforeAll(async () => { await initEngine(); });

  it("names a bare call, and which local went in", () => {
    const body = routineIn(
      'import { writeFileSync } from "node:fs";\n'
      + "export function save(rows: string) {\n"
      + "  const body = shape(rows);\n"
      + '  writeFileSync("/tmp/x", body);\n'
      + "}\n",
      "ts",
    );
    expect(named(body)).toContain("writeFileSync");
    expect(body.calls.find((call) => call.callee === "writeFileSync")?.passed).toEqual(["body"]);
    expect(escapesOf(body, "body")).toEqual(["passed-to-a-call"]);
  });

  it("records the same door written on a namespace, with no name to resolve", () => {
    const body = routineIn(
      'import fs from "node:fs";\n'
      + "export function save(rows: string) {\n"
      + "  const body = shape(rows);\n"
      + '  fs.writeFileSync("/tmp/x", body);\n'
      + "}\n",
      "ts",
    );
    // Recorded, so the exit is countable...
    const site = body.calls.find((call) => call.args.includes("body"));
    expect(site).toBeDefined();
    expect(site?.callee).toBe("");
    // ...and unnameable, so nothing can look it up and read the wrong body.
    expect(named(body)).not.toContain("writeFileSync");
    expect(escapesOf(body, "body")).toEqual(["passed-to-a-call"]);
  });

  it("records a Python module-qualified call the same way", () => {
    const body = routineIn(
      "import os\n"
      + "def save(rows):\n"
      + "    body = shape(rows)\n"
      + '    os.replace(body, "/tmp/x")\n',
      "python",
    );
    const site = body.calls.find((call) => call.args.includes("body"));
    expect(site?.callee).toBe("");
    expect(named(body)).not.toContain("replace");
  });

  it("names a Python bare call", () => {
    const body = routineIn(
      "def save(rows):\n"
      + "    body = shape(rows)\n"
      + "    open(body)\n",
      "python",
    );
    expect(named(body)).toContain("open");
  });

  it("names a call on `this`, which is the one receiver it answers for", () => {
    const body = routineIn(
      "export class Store {\n"
      + "  keep(rows: string) {\n"
      + "    const body = shape(rows);\n"
      + "    this.write(body);\n"
      + "  }\n"
      + "}\n",
      "ts",
    );
    expect(named(body)).toContain("write");
  });
});

describe("what a recorded method call does to the escape question", () => {
  beforeAll(async () => { await initEngine(); });

  it("refuses by name rather than freeing the value", () => {
    const body = routineIn(
      "def save(rows, handle):\n"
      + "    body = shape(rows)\n"
      + "    handle.write(body)\n",
      "python",
    );
    const settled = settleCalls(body, resolvesNothing);
    // The refusal is now reachable, and it is counted under its own name.
    expect(settled.why.get("callee-is-a-method")).toBe(1);
    expect(settled.freed).toBe(0);
    expect(contained(body.locals.find((local) => local.name === "body")!)).toBe(false);
  });

  it("still refuses when a routine of the method's name is in the same body's file", () => {
    /*
     * The trap recording the site could have opened. `write` is declared right
     * here, so a resolver keyed on the *name* would read this body, see the
     * argument used harmlessly, and free a value that went out through
     * `handle`. The empty callee is what stops the lookup happening at all.
     */
    const source =
      "def write(payload):\n"
      + "    return len(payload)\n"
      + "def save(rows, handle):\n"
      + "    body = shape(rows)\n"
      + "    handle.write(body)\n";
    const { bodies } = readBodies(source, "python");
    const save = bodies.find((one) => one.routine === "save")!;
    const write = bodies.find((one) => one.routine === "write")!;
    const resolver: Resolver = (callee) =>
      callee === "write" ? { body: write, file: "same.py" } : undefined;

    const settled = settleCalls(save, resolver);
    expect(settled.why.get("callee-is-a-method")).toBe(1);
    expect(settled.freed).toBe(0);
  });

  it("stops freeing a value that also left through a call nobody recorded", () => {
    /*
     * The correctness half, and the reason this is not only bookkeeping.
     * `payload` goes to `inspect`, which provably keeps it, *and* to
     * `sink.send`. With no site for the second, `settleCalls` saw one exit,
     * resolved it cleanly and called the value contained -- an absence offered
     * as proof, about a value handed straight out on the next line. A/B against
     * the reader as it was: `freed=1 contained=true`.
     *
     * And it did not show up as a leak. Because the reader set `freedByCall`,
     * `measure-dataflow.mts` files the disagreement under "having read another
     * routine's body", the population it declares unrefereeable by
     * construction -- so a referee that could see this one was told not to
     * count it.
     */
    const source =
      "def inspect(value):\n"
      // A property read hands out the property, not the object, so this callee
      // provably keeps what it is given -- which is what made the bug reachable.
      + "    return value.count\n"
      + "def run(rows, sink):\n"
      + "    payload = shape(rows)\n"
      + "    inspect(payload)\n"
      + "    sink.send(payload)\n";
    const { bodies } = readBodies(source, "python");
    const run = bodies.find((one) => one.routine === "run")!;
    const inspect = bodies.find((one) => one.routine === "inspect")!;
    const resolver: Resolver = (callee) =>
      callee === "inspect" ? { body: inspect, file: "same.py" } : undefined;

    const settled = settleCalls(run, resolver);
    expect(settled.freed).toBe(0);
    expect(settled.why.get("callee-is-a-method")).toBe(1);
    expect(contained(run.locals.find((local) => local.name === "payload")!)).toBe(false);
  });

  it("does not invent a flow between two names through an unnamed call", () => {
    /*
     * `chainFrom` matches a consumer by name, and an empty name must match
     * nothing -- otherwise a board's `@feeds` arrow could confirm off a call
     * whose far end this reader never identified.
     */
    const body = routineIn(
      "def run(rows, sink):\n"
      + "    parsed = parse(rows)\n"
      + "    sink.render(parsed)\n",
      "python",
    );
    expect(chainFrom(body, ["parse"], ["render"])).toBeUndefined();
    expect(chainFrom(body, ["parse"], [""])).toBeUndefined();
  });
});
