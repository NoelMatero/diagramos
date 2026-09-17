/**
 * The `@feeds` referee: one routine's result handed to another, read off the
 * screen with no syntax tree.
 *
 * Written for #302, because `@feeds` never accuses and so no licence ever
 * needed a referee for it. It shares nothing with `feeds.ts`: routines are
 * found and bounded by `call-scan.ts`, and a flow is two regexes over the text
 * that is left once strings and comments are blanked.
 *
 * It claims only the two shapes a person reads off one screen without thinking,
 * which are also the two `feeds.ts` says it confirms:
 *
 *     B(A(x))                    A's result handed straight to B
 *     v = A(x)  ...  B(v)        A's result bound to a name, and the name passed
 *
 * Both names bare -- `obj.B(..)` is somebody else's `B`, which the call referee
 * cannot place either -- and the bound name passed on its own as a whole
 * argument, after the binding, inside the same routine, with no second
 * assignment to it in between. Anything cleverer it declines to offer: a
 * smaller population, never a wrong one.
 */
import { type Language } from "../../src/engine/parse";

import { NOT_CALLS, refereeRoutines, stripNoise } from "./call-scan";

export interface RefereeFlow {
  /** The routine whose result flows. */
  producer: string;
  /** The routine it flows into. */
  consumer: string;
  /** 1-based line the consumer call is written on. */
  line: number;
  /** The name that held the result on the way, for the bound shape. */
  through?: string;
}

const NAME = "[A-Za-z_$][\\w$]*";
/** A bare call's name: not after `.`, `::` or another name character. */
const BARE = `(?<![\\w$.:])(${NAME})`;
const NESTED = new RegExp(`${BARE}\\s*\\(\\s*(${NAME})\\s*\\(`, "g");
const BINDING = new RegExp(
  `^\\s*(?:(?:const|let|var)\\s+(?:mut\\s+)?)?(${NAME})\\s*(?::[^=]*)?=\\s*(?:await\\s+)?${BARE}\\s*\\(`,
);
const CALL = new RegExp(`${BARE}\\s*\\(([^()]*)\\)`, "g");

const escape = (text: string) => text.replace(/[$]/g, "\\$&");

/**
 * Where the call whose `(` is at `open` ends, or -1 on this line. The result is
 * only the producer's when nothing but `?`, `;` or a closing bracket follows:
 * `super().clean(v)` and `f(x).y` hand on something else.
 */
function closes(code: string, open: number): number {
  let depth = 0;
  for (let at = open; at < code.length; at += 1) {
    if (code[at] === "(") depth += 1;
    else if (code[at] === ")" && --depth === 0) return at;
  }
  return -1;
}
const handsOnItsResult = (code: string, open: number, rest: RegExp) => {
  const end = closes(code, open);
  return end !== -1 && rest.test(code.slice(end + 1));
};

/** Every flow in one file, one routine at a time. */
export function refereeFlows(source: string, language: Language): RefereeFlow[] {
  const lines = stripNoise(source, language).split("\n");
  const routines = refereeRoutines(source, language);
  const found: RefereeFlow[] = [];
  const seen = new Set<string>();
  const add = (flow: RefereeFlow) => {
    const key = `${flow.producer}>${flow.consumer}`;
    if (flow.producer === flow.consumer || seen.has(key)) return;
    if (NOT_CALLS.has(flow.producer) || NOT_CALLS.has(flow.consumer)) return;
    seen.add(key);
    found.push(flow);
  };

  routines.forEach((routine, index) => {
    // Bounded by the next routine's opening line: a nested routine ends this
    // one early, which only ever shrinks what is offered.
    const end = routines[index + 1]?.line ?? lines.length + 1;
    const body = lines.slice(routine.line, end - 1);
    const bound = new Map<string, { producer: string; at: number }>();

    body.forEach((code, offset) => {
      const line = routine.line + 1 + offset;
      for (const hit of code.matchAll(NESTED)) {
        const inner = hit.index + hit[0].length - 1;
        if (handsOnItsResult(code, inner, /^\s*\??\s*[,)]/)) add({ producer: hit[2]!, consumer: hit[1]!, line });
      }

      for (const hit of code.matchAll(CALL)) {
        const args = hit[2]!.split(",").map((part) => part.trim());
        for (const [name, held] of bound) {
          if (!args.includes(name) || held.at === offset) continue;
          add({ producer: held.producer, consumer: hit[1]!, line, through: name });
        }
      }

      // A second assignment to a held name ends what it held.
      for (const name of [...bound.keys()]) {
        if (new RegExp(`(?<![\\w$.])${escape(name)}\\s*=(?!=)`).test(code) && bound.get(name)!.at !== offset) {
          bound.delete(name);
        }
      }
      const binding = BINDING.exec(code);
      if (binding && !NOT_CALLS.has(binding[2]!)
        && handsOnItsResult(code, binding[0].length - 1, /^\s*\??\s*;?\s*$/)) {
        bound.set(binding[1]!, { producer: binding[2]!, at: offset });
      }
    });
  });
  return found;
}
