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

describe("the guidance teaches nothing the engine would refuse", () => {
  /**
   * The other direction, and the one that rots quietly. Guidance still teaching a
   * word that was taken out of the whitelist sends an author to write a ref that
   * comes back as broken -- and the author has no way to tell that the guidance
   * is the thing at fault rather than their diagram.
   *
   * Every file that teaches authoring, not just the skill: the commands teach the
   * same vocabulary and rot the same way, and `plan-diagram` now spells `@needs`
   * out where a person would type it.
   */
  const AUTHORING = [
    "skills/diagram/SKILL.md",
    "commands/plan-diagram.md",
    "commands/annotate-diagram.md",
    "commands/update-diagram.md",
  ];

  it.each(AUTHORING)("uses no @word in %s outside the two closed whitelists", (file) => {
    const allowed = new Set<string>([...SYMBOL_WORDS, ...ARROW_CLAIMS]);
    const written = [...read(file).matchAll(/@([a-z][a-z-]*)/g)].map((match) => match[1]!);
    expect([...new Set(written)].filter((word) => !allowed.has(word))).toEqual([]);
  });
});

describe("the commands that author boards mention the claims", () => {
  /*
   * Narrower than the skill for one of them and not for the other, and the
   * asymmetry is the point.
   *
   * `annotate-diagram` is a procedure for one job -- somebody has the file open,
   * which is the only honest moment to transcribe a claim -- so it has to name
   * the claims its job can produce and nothing more.
   *
   * `plan-diagram` carries the whole vocabulary, because it is the one place a
   * claim means something *different* (#123). Everywhere else a claim is a
   * transcription: write it only when you have read the line. On a planned thing
   * there is no line, so the claim is a specification -- when this is built, it
   * will work this way -- and the rule that governs `built` does not restrict it.
   * An author who has only ever been taught the transcription rule concludes,
   * correctly from what they were told and wrongly in fact, that a plan must not
   * carry claims at all. So a claim missing from this file is not a thinner
   * explanation of the same thing; it is the only explanation there was.
   */
  const PLAN = copyable(read("commands/plan-diagram.md"));

  it.each([...ARROW_CLAIMS])("plan-diagram says a planned arrow can specify %s", (claim) => {
    expect(PLAN).toContain(claim);
  });

  it.each([...BOX_CLAIMS])("plan-diagram says a planned box can specify %s", (claim) => {
    expect(PLAN).toContain(claim);
  });

  it("annotate-diagram offers claims under the approval gate it already has", () => {
    const annotate = copyable(read("commands/annotate-diagram.md"));
    expect(annotate).toContain("needs");
    expect(annotate).toContain("closed");
  });
});

describe("the skill teaches an order of operations, not only a vocabulary", () => {
  /*
   * The gap #186 measured, pinned the same way #110's was.
   *
   * That issue's finding was not that the guidance was wrong -- every entry in it
   * is precise -- but that it was entirely a dictionary. It defined `ref`,
   * `needs`, `closed`, `complete`, `via` and the rest, and never said how to turn
   * a repository into a board: no target box count, no rule for what a box stands
   * for, no criterion for when one board should be two, and no completion
   * condition. So 21 sessions each invented one, and 47% of boxes came out with
   * no anchor and 5% of arrows with a claim.
   *
   * A tool that answers those questions is worth nothing if the guidance does not
   * tell an author to call it first, which is exactly how `needs` and `closed`
   * shipped and went unwritten. These are shallow on purpose -- a grep cannot
   * judge a procedure -- but they make its absence impossible.
   */
  const SKILL_TEXT = SKILL;

  it("tells an author to survey the scope before reading code", () => {
    expect(SKILL_CODE).toContain("survey_scope");
  });

  it("answers all four decisions a session would otherwise invent", () => {
    // How many boxes, and what a box stands for.
    expect(SKILL_TEXT).toMatch(/how many boxes/i);
    // Whether this is one board or several.
    expect(SKILL_CODE).toContain("separateBoards");
    // When the diagram is finished.
    expect(SKILL_TEXT).toMatch(/When it is done/);
  });

  it("says whose job the naming is, since a survey will not do it", () => {
    expect(SKILL_TEXT).toMatch(/filenames/);
  });

  it("does not send an author to render a board to find out whether it reads", () => {
    // The passage #186 quoted as the documented method was "use it to catch
    // overlap, crowding, or an unreadable label" -- two of which are arithmetic
    // the layout already has, and #185 now reports at draw time.
    expect(SKILL_TEXT).not.toMatch(/use it to catch\s+overlap, crowding, or an unreadable label/);
    expect(SKILL_TEXT).toMatch(/Do not render to find out/);
  });

  it("does not present drawing and looking as the way to pick a layout", () => {
    // Also quoted in #186: "If the first layout comes out wrong ... try the other
    // one." The flow is chosen by measurement on a first draw now.
    expect(SKILL_TEXT).not.toMatch(/If the first layout comes\s+out wrong/);
  });
});
