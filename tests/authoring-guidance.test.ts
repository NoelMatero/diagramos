/**
 * Everything the engine accepts is taught somewhere an author will read.
 *
 * This exists because of a measured gap, not a hypothetical one. `needs` and
 * `closed` shipped with a checker, a CLI report, a browser panel and a good tool
 * schema -- and across all fourteen boards in this repository they were written
 * exactly zero times (#110). The schema is read at call time; the skill is what
 * shapes intent when somebody says "draw a diagram". Nothing taught the claims,
 * so nothing wrote them, so none of the checking had ever run on real work.
 *
 * The rule this pins is the one `claim.ts` already states about the vocabulary:
 * a word goes in on the day something can call it wrong. This adds the other
 * half -- a word goes in on the day something *tells an author it exists*. Add a
 * claim to the whitelist and these fail until the guidance catches up, which is
 * the only mechanism that would have caught the original gap.
 *
 * Deliberately shallow. It asserts the words are present and reachable, not that
 * the prose around them is good; a grep cannot judge writing. What it can do is
 * make silence impossible.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { SYMBOL_WORDS } from "../src/engine/assert";
import { ARROW_CLAIMS, BOX_CLAIMS } from "../src/engine/claim";
import { NODE_STATES } from "../src/engine/graph";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative: string) => readFileSync(path.join(ROOT, relative), "utf8");

const SKILL = read("skills/diagram/SKILL.md");

/**
 * Only what an author could copy: fenced blocks and inline code spans.
 *
 * Prose does not count, and the distinction is not pedantic -- it is the exact
 * hole this file exists for. Before #110 the old skill contained the word
 * "needs" once, in an ordinary English sentence, so a plain substring check
 * would have called the claim taught and gone green over a vocabulary nobody
 * had ever been told about.
 */
function copyable(markdown: string): string {
  const fenced = [...markdown.matchAll(/```[\s\S]*?```/g)].map((match) => match[0]);
  const inline = [...markdown.matchAll(/`[^`\n]+`/g)].map((match) => match[0]);
  return [...fenced, ...inline].join("\n");
}

const SKILL_CODE = copyable(SKILL);

describe("the skill teaches everything the engine accepts", () => {
  it.each([...ARROW_CLAIMS])("teaches the arrow claim %s in a form you can copy", (claim) => {
    expect(SKILL_CODE).toContain(claim);
  });

  it.each([...BOX_CLAIMS])("teaches the box claim %s in a form you can copy", (claim) => {
    expect(SKILL_CODE).toContain(claim);
  });

  it.each([...SYMBOL_WORDS])("teaches the symbol assertion @%s", (word) => {
    expect(SKILL_CODE).toContain(`@${word}`);
  });

  // `built` is the default and is never written, but it is still a word an
  // author has to be able to look up -- "why is this box not dashed" is a
  // question the guidance has to answer.
  it.each([...NODE_STATES])("teaches the state %s", (state) => {
    expect(SKILL_CODE).toContain(state);
  });
});

describe("the skill teaches nothing the engine would refuse", () => {
  /**
   * The other direction, and the one that rots quietly. A skill still teaching a
   * word that was taken out of the whitelist sends an author to write a ref that
   * comes back as broken -- and the author has no way to tell that the guidance
   * is the thing at fault rather than their diagram.
   */
  it("uses no @word outside the two closed whitelists", () => {
    const allowed = new Set<string>([...SYMBOL_WORDS, ...ARROW_CLAIMS]);
    const written = [...SKILL.matchAll(/@([a-z][a-z-]*)/g)].map((match) => match[1]!);
    expect([...new Set(written)].filter((word) => !allowed.has(word))).toEqual([]);
  });
});

describe("the commands that author boards mention the claims", () => {
  /*
   * Narrower than the skill on purpose. A command is a procedure for one job, so
   * it has to name the claim *its* job can produce and is not required to carry
   * the whole vocabulary: planning is where a dependency direction is decided
   * before it exists, and annotating is the one pass where somebody already has
   * the file open, which is the only honest moment to transcribe one.
   */
  it("plan-diagram says a planned arrow can specify its direction", () => {
    expect(copyable(read("commands/plan-diagram.md"))).toContain("needs");
  });

  it("annotate-diagram offers claims under the approval gate it already has", () => {
    const annotate = copyable(read("commands/annotate-diagram.md"));
    expect(annotate).toContain("needs");
    expect(annotate).toContain("closed");
  });
});
