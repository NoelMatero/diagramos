// The wiring. SKILL.md: the wiring usually lives in a third file the board
// often does not draw at all -- this file, not `stages.ts`.
import { collect, format, parse, render } from "./stages";

/** PLAINLY TRUE: parse's result is bound and passed straight into render. */
export function run(text: string): string {
  const value = parse(text);
  return render(value);
}

/** FALSE AND UNPROVABLE: nothing here connects the two. */
export function unrelated(): number {
  return 0;
}

/**
 * TRUE BUT HIDDEN: collect's result really does reach format, through a
 * struct field -- SKILL.md's own example of a place "no reader follows".
 * `collect`/`format` have no other wiring routine, so this is the only
 * evidence there is to find, and the checker still cannot find it.
 */
export interface Held {
  value: number;
}

export function runViaField(text: string): string {
  const held: Held = { value: collect(text) };
  return format(held.value);
}
