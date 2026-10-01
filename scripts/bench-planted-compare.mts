#!/usr/bin/env node
/**
 * Two `bench:planted --details` runs, arrow for arrow (#403).
 *
 *   npm run bench:planted:compare -- <run>               totals, planted and true, by word
 *   npm run bench:planted:compare -- <base> <arm>        both, and every arrow whose answer changed
 *
 * A run is a folder from `bench:planted:runs` or the saved output of one
 * `npm run bench:planted -- --details`; the two can be mixed. Only projects
 * present in both are compared, and a project one side has and the other does
 * not is named rather than silently dropped.
 *
 * An arrow "changed" when its outcome did (red, not sure, green, silent) --
 * those are the flips, listed with what each side said. One whose outcome held
 * but whose reason or wording moved is counted separately and listed with
 * `--all`: it moves no number in the score, and is still not the same answer.
 * Exit status 1 when anything changed, so a script can ask "same?".
 */
import { readRun, type Arrow } from "./lib/bench-details";

const args = process.argv.slice(2);
const all = args.includes("--all");
const [baseAt, armAt] = args.filter((one) => !one.startsWith("--"));
if (!baseAt) {
  console.log("usage: bench-planted-compare.mts <run> [<other run>] [--all]");
  process.exit(2);
}

type Row = Record<"red" | "not sure" | "green" | "silent", number>;
const zero = (): Row => ({ red: 0, "not sure": 0, green: 0, silent: 0 });

function print(title: string, arrows: Iterable<Arrow>): void {
  console.log(title);
  const rows = new Map<string, Row>();
  const sides = { planted: zero(), true: zero() };
  for (const arrow of arrows) {
    const side = arrow.truth === "false" ? "planted" : "true";
    const key = `${side} ${arrow.word}`;
    const row = rows.get(key) ?? zero();
    row[arrow.outcome as keyof Row] += 1;
    sides[side][arrow.outcome as keyof Row] += 1;
    rows.set(key, row);
  }
  const line = (name: string, row: Row) => console.log(`  ${name.padEnd(20)} red ${String(row.red).padStart(4)}`
    + `  not-sure ${String(row["not sure"]).padStart(4)}  green ${String(row.green).padStart(4)}`
    + `  silent ${String(row.silent).padStart(4)}`);
  for (const key of [...rows.keys()].sort()) line(key, rows.get(key)!);
  line("planted ALL", sides.planted);
  line("true ALL", sides.true);
}

const base = readRun(baseAt);
const note = (empty: string[]) => (empty.length > 0 ? `, NO ARROWS: ${empty.join(" ")}` : "");
print(`== ${baseAt} (${base.arrows.size} arrows${note(base.empty)})`, base.arrows.values());
if (!armAt) process.exit(0);

const arm = readRun(armAt);
print(`== ${armAt} (${arm.arrows.size} arrows${note(arm.empty)})`, arm.arrows.values());

const projectsOf = (arrows: Map<string, Arrow>) => new Set([...arrows.values()].map((one) => one.project));
const inBase = projectsOf(base.arrows);
const inArm = projectsOf(arm.arrows);
const onlyBase = [...inBase].filter((one) => !inArm.has(one)).sort();
const onlyArm = [...inArm].filter((one) => !inBase.has(one)).sort();
if (onlyBase.length > 0) console.log(`  not compared, only in ${baseAt}: ${onlyBase.join(" ")}`);
if (onlyArm.length > 0) console.log(`  not compared, only in ${armAt}: ${onlyArm.join(" ")}`);

console.log("== changed");
let flipped = 0;
let reworded = 0;
let missing = 0;
const side = (one: Arrow) => (one.truth === "false" ? "PLANTED" : "TRUE   ");
for (const [id, was] of base.arrows) {
  if (!inArm.has(was.project)) continue;
  const now = arm.arrows.get(id);
  if (!now) { missing += 1; console.log(`  MISSING in ${armAt}: ${id}`); continue; }
  const flip = now.outcome !== was.outcome;
  const moved = !flip && (now.reason !== was.reason || now.detail !== was.detail);
  if (flip) flipped += 1;
  if (moved) reworded += 1;
  if (!flip && !(moved && all)) continue;
  console.log(`  ${side(was)} ${was.outcome} -> ${now.outcome}  ${was.language} ${id}`);
  console.log(`      base [${was.reason}] ${was.detail}`);
  console.log(`      arm  [${now.reason}] ${now.detail}`);
}
for (const id of arm.arrows.keys()) {
  if (!base.arrows.has(id) && inBase.has(arm.arrows.get(id)!.project)) {
    missing += 1;
    console.log(`  MISSING in ${baseAt}: ${id}`);
  }
}
console.log(`  ${flipped} flipped, ${reworded} same outcome with a different reason or wording`
  + `${all || reworded === 0 ? "" : " (--all lists them)"}, ${missing} on one side only`);
process.exit(flipped + reworded + missing > 0 ? 1 : 0);
