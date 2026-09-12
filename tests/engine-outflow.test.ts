/**
 * Does this value reach a door? (#203, #270)
 *
 * #270 enumerated the doors -- the calls that touch files, the network and
 * other processes -- and answered the *routine* version of the question: can
 * this function reach one. This is the value version, which is what #203 keeps
 * arriving at: **this value is created here; does it ever reach something that
 * writes it to a file, sends it over the network, or hands it to another
 * process?**
 *
 * Confirming only, and that is a decision rather than a stage. A door this
 * reader fails to see costs silence, which the engine accepts everywhere. The
 * opposite verdict -- "this value never reaches a door" -- is not here and must
 * not be: 87.4% of Python's doors were invisible to the reader until #203
 * recorded the site for a call on a receiver, `tsx` and `rust` are still 0 of 4
 * and 0 of 1, and a value handed out through `f.write(row)` is not in the
 * population at all. A wrong "never" is unrecoverable.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { outflowIn } from "../src/engine/outflow";
import { initEngine } from "../src/engine/parse";

const flows = (source: string, language: "ts" | "python" = "ts") => {
  const reading = outflowIn(source, language);
  expect(reading.read).toBe(true);
  return reading.flows;
};

/** A flow as a string, so a test reads like the sentence it is checking. */
const said = (source: string, language: "ts" | "python" = "ts") =>
  flows(source, language).map((flow) =>
    `${flow.routine}: ${flow.value}`
    + (flow.through.length > 0 ? ` -> ${flow.through.join(" -> ")}` : "")
    + ` -> ${flow.door.qualified} (${flow.door.kind})`);

describe("outflowIn", () => {
  beforeAll(async () => { await initEngine(); });

  it("says a value handed straight to a door reaches it", () => {
    expect(said(
      'import { writeFileSync } from "node:fs";\n'
      + "export function save(rows: string) {\n"
      + "  const body = shape(rows);\n"
      + '  writeFileSync("/tmp/x", body);\n'
      + "}\n",
    )).toContain("save: shape -> body -> node:fs.writeFileSync (file)");
  });

  it("follows a value through as many locals as it takes", () => {
    const told = said(
      'import { writeFileSync } from "node:fs";\n'
      + "export function save(input: string) {\n"
      + "  const rows = parse(input);\n"
      + "  const shaped = normalise(rows);\n"
      + '  writeFileSync("/tmp/x", shaped);\n'
      + "}\n",
    );
    // The far producer, through both hops, which is the whole point of it.
    expect(told).toContain("save: parse -> rows -> shaped -> node:fs.writeFileSync (file)");
    expect(told).toContain("save: normalise -> shaped -> node:fs.writeFileSync (file)");
  });

  it("says nothing when the value never goes near a door", () => {
    expect(said(
      'import { writeFileSync } from "node:fs";\n'
      + "export function save(rows: string) {\n"
      + "  const body = shape(rows);\n"
      + "  return body.length;\n"
      + "}\n",
    )).toEqual([]);
  });

  it("says nothing about a call that is not a door", () => {
    expect(said(
      "export function save(rows: string) {\n"
      + "  const body = shape(rows);\n"
      + "  emit(body);\n"
      + "}\n",
    )).toEqual([]);
  });

  it("reads a Python module-qualified door, which is how Python writes them", () => {
    expect(said(
      "import os\n"
      + "def save(rows):\n"
      + "    body = shape(rows)\n"
      + '    os.replace(body, "/tmp/x")\n',
      "python",
    )).toContain("save: shape -> body -> os.replace (file)");
  });

  it("names the network and a subprocess as well as the disk", () => {
    const network = said(
      "export async function send(rows: string) {\n"
      + "  const payload = shape(rows);\n"
      + '  await fetch("https://example.com", payload);\n'
      + "}\n",
    );
    expect(network).toContain("send: shape -> payload -> fetch (network)");

    const process = said(
      "import subprocess\n"
      + "def run(rows):\n"
      + "    args = shape(rows)\n"
      + "    subprocess.run(args)\n",
      "python",
    );
    expect(process).toContain("run: shape -> args -> subprocess.run (process)");
  });

  it("follows what was put in a collection when the collection goes out", () => {
    const told = said(
      'import { writeFileSync } from "node:fs";\n'
      + "export function save() {\n"
      + "  const bag: string[] = [];\n"
      + "  const item = build();\n"
      + "  bag.push(item);\n"
      + '  writeFileSync("/tmp/x", bag);\n'
      + "}\n",
    );
    /*
     * #203's own example, pointed at a door: one thing in, the same thing out.
     * The index is deliberately not tracked -- the collection is one value and
     * this is everything in it.
     */
    expect(told).toContain("save: build -> item -> bag -> node:fs.writeFileSync (file)");
  });

  it("does not follow a collection that stayed at home", () => {
    expect(said(
      'import { writeFileSync } from "node:fs";\n'
      + "export function save() {\n"
      + "  const bag: string[] = [];\n"
      + "  const item = build();\n"
      + "  bag.push(item);\n"
      + '  writeFileSync("/tmp/x", "nothing to do with it");\n'
      + "}\n",
    )).toEqual([]);
  });

  it("keeps two routines apart", () => {
    const told = said(
      'import { writeFileSync } from "node:fs";\n'
      + "export function save(rows: string) {\n"
      + "  const body = shape(rows);\n"
      + '  writeFileSync("/tmp/x", body);\n'
      + "}\n"
      + "export function quiet(rows: string) {\n"
      + "  const body = shape(rows);\n"
      + "  return body;\n"
      + "}\n",
    );
    expect(told.some((one) => one.startsWith("save:"))).toBe(true);
    expect(told.some((one) => one.startsWith("quiet:"))).toBe(false);
  });

  it("reports each value once per door rather than once per mention", () => {
    const told = flows(
      'import { writeFileSync } from "node:fs";\n'
      + "export function save(rows: string) {\n"
      + "  const body = shape(rows);\n"
      + '  writeFileSync("/tmp/x", body);\n'
      + "}\n",
    );
    const keys = told.map((one) => `${one.value}@${one.door.line}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("invents nothing out of source that is not a program", () => {
    /*
     * `read` is not a parse gate here: tree-sitter recovers from almost
     * anything and `outsideCallsIn` reports `read: true` for the wreckage. What
     * matters is the claim, and the claim is that there is none.
     */
    const reading = outflowIn("function (((", "ts");
    expect(reading.flows).toEqual([]);
  });

  it("attributes an argument to the door and not to another call on the same line", () => {
    /*
     * `readFileSync(path.join(root, file), "utf8")` puts two calls on one line.
     * Keying doors by line alone attributed `path.join`'s arguments to the door,
     * so `file` was reported as arriving at `readFileSync` position 1 -- which
     * is `join`'s position, and `readFileSync` takes no second value argument.
     * The flow was true and the path was not.
     */
    const told = flows(
      'import { readFileSync } from "node:fs";\n'
      + "export function read(root: string, file: string) {\n"
      + '  return readFileSync(path.join(root, file), "utf8");\n'
      + "}\n",
    );
    expect(told.some((one) => one.value === "file" && one.at === 1)).toBe(false);
    // And nothing is attributed to a position the door does not have.
    expect(told.every((one) => one.at === undefined || one.at === 0)).toBe(true);
  });

  it("does not follow a value wrapped in an object literal, which fetch is normally written with", () => {
    /*
     * The limit worth knowing before reading any number off this, because it is
     * the *usual* spelling of the commonest door in TypeScript:
     *
     *   fetch(url, { body: payload })
     *
     * `payload` escapes `into-a-structure`, and `dataflow.ts` does not model a
     * structure the way it models a collection -- so nothing connects it to the
     * argument. Silence, which is the direction this reader is allowed to be
     * wrong in, and a reason the network row reads low.
     */
    expect(said(
      "export async function send(rows: string) {\n"
      + "  const payload = shape(rows);\n"
      + '  await fetch("https://example.com", { body: payload });\n'
      + "}\n",
    )).toEqual([]);
  });
});
