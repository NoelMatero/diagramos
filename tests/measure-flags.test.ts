/**
 * A findings list a measurement prints must be liftable, or the number above it
 * cannot be argued with.
 *
 * `measure-accesses.mts` reported "450 MISSED" and printed fifteen of them, and
 * the fifteen read as a plausible tail of hard cases. They were not: reading all
 * 450 -- which needed editing the script -- showed eight sites accounting for 86
 * of them and whole clusters that were not member reads at all (#222). The cap
 * did not hide a detail, it hid the shape of the number, and for a release
 * nobody could see that without a patch. (#224)
 *
 * So the flag is the contract, not the cap: a report that truncates has to say
 * so and name the way to lift it.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const SCRIPTS = path.resolve(__dirname, "..", "scripts");
const source = readFileSync(path.join(SCRIPTS, "measure-accesses.mts"), "utf8");

describe("measure:accesses -- --all", () => {
  it("is documented where somebody looking for it would read", () => {
    expect(source).toContain("npm run measure:accesses -- --all");
  });

  it("is read off the command line rather than ignored", () => {
    expect(source).toContain('flags.has("--all")');
  });

  it("truncates nothing except through the cap the flag lifts", () => {
    /*
     * Four lists: accused, missed, invented, and the directories the walk could
     * not open. A bare `.slice(0, 15)` is the bug -- it looks like a cap and is
     * a wall, because no argument reaches it.
     */
    const bare = [...source.matchAll(/\.slice\(0,\s*(\d+)\)/g)].map((hit) => hit[0]);
    expect(bare, "a findings list is sliced to a constant, so --all cannot lift it").toEqual([]);
    expect([...source.matchAll(/\.slice\(0,\s*cap\(/g)]).toHaveLength(4);
  });

  it("says how many it hid, and how to see them", () => {
    // One notice per list. A count with nothing after it tells the reader a
    // number is missing but not that it can be had.
    expect([...source.matchAll(/--all prints every one/g)]).toHaveLength(4);
  });
});
