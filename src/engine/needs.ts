/**
 * Whether a `needs` arrow points the way the code does.
 *
 * This is the first verdict in the tool that can say **wrong**. Everything else
 * either confirms or goes quiet, because "related somehow" has no opposite: fail
 * to find a connection and you have learned nothing, so the answer is amber
 * forever and a backwards arrow survives every check ever written.
 *
 * `needs` has an opposite. The tail declares a dependency on the head, which is
 * a direction, so finding the dependency pointing the other way *and nowhere
 * else* is proof the arrow is drawn backwards. That is the one thing here worth
 * having, and the one thing that can cost trust if it is ever wrong.
 *
 * So the whole file is written as reasons not to answer. A verdict needs all of:
 *
 * - both files in a language whose reader has been **measured** (`licence.ts`);
 * - both files **parsed to the end**, because "there is no dependency in here"
 *   is a statement about the whole file and a recovered parse read less than one;
 * - neither file **reaching out at runtime**, where no reader can follow;
 * - the dependency in **exactly one** direction. Both ways is a cycle, which is
 *   legal in TypeScript and in Rust, and unanswerable either way: neither
 *   arrow is more correct.
 *
 * Miss any of those and this returns `withheld` with the reason, and the caller
 * falls back to the amber it would have shown anyway. Silence is always available
 * and always safe; the accusation is not.
 */
import { readDependencies } from "./deps";
import { licenceFor } from "./licence";
import type { ConfigCache } from "./resolve";
import type { Workspace } from "./workspace";

/** Why no direction verdict was reached. Each one is a reason to stay quiet. */
export type NeedsWithheld =
  /** No measured reader for one of these languages, so no right to refute. */
  | "unlicensed"
  /** One end could not be read at all -- missing, or a language with no grammar. */
  | "unreadable"
  /** A parse recovered from an error, so nothing can be proved absent in it. */
  | "incomplete"
  /** One end reaches out at runtime; the text is not the whole story. */
  | "dynamic"
  /** Both ends are the same file, which cannot depend on itself in any useful sense. */
  | "same-file";

/** Where a dependency was declared, for a report that has to name its evidence. */
export interface NeedsEvidence {
  /** The file doing the depending. */
  file: string;
  /** The file depended on. */
  on: string;
  /** The specifier as written, so the report can quote it. */
  specifier: string;
  /** 1-based. */
  line: number;
}

export type NeedsVerdict =
  /** The dependency runs the way the arrow does. */
  | { verdict: "confirmed"; evidence: NeedsEvidence }
  /** It runs the other way, and only the other way. The arrow is backwards. */
  | { verdict: "backwards"; evidence: NeedsEvidence }
  /** Both directions exist. Legal, and unanswerable. */
  | { verdict: "cycle" }
  /** Neither file declares the other. Amber, exactly as before claims existed. */
  | { verdict: "absent" }
  | { verdict: "withheld"; why: NeedsWithheld };

/** What one file declares about another, and whether it can be trusted to. */
function declares(
  file: string,
  workspace: Workspace,
  cache: ConfigCache,
): { on: Map<string, NeedsEvidence>; why?: NeedsWithheld } {
  if (!licenceFor(file)) return { on: new Map(), why: "unlicensed" };

  const absolute = workspace.resolve(file);
  if (!absolute || workspace.stat(absolute) !== "file") return { on: new Map(), why: "unreadable" };

  const read = readDependencies(file, workspace.read(absolute), workspace, cache);
  if (!read) return { on: new Map(), why: "unreadable" };
  /*
   * Order matters here, and it is the pessimistic one: a file that is both
   * incompletely read and dynamic reports as incomplete, because that is the
   * more fundamental problem. Either way the caller says nothing, so the only
   * thing at stake is which reason a person is told, and "we could not read all
   * of this" is the more useful one to hear first.
   */
  if (!read.complete) return { on: new Map(), why: "incomplete" };
  if (read.dynamic.length > 0) return { on: new Map(), why: "dynamic" };

  const on = new Map<string, NeedsEvidence>();
  for (const dependency of read.dependencies) {
    if (!dependency.file) continue;
    // First mention wins: a file importing the same module twice should quote the
    // line somebody would look at first.
    if (!on.has(dependency.file)) {
      on.set(dependency.file, {
        file,
        on: dependency.file,
        specifier: dependency.specifier,
        line: dependency.line,
      });
    }
  }
  return { on };
}

/**
 * Which way the dependency between two files actually runs.
 *
 * `from` and `to` are repo-relative and read as the arrow does: `from` claims to
 * depend on `to`.
 */
export function checkNeeds(
  from: string,
  to: string,
  workspace: Workspace,
  cache: ConfigCache = new Map(),
): NeedsVerdict {
  if (from === to) return { verdict: "withheld", why: "same-file" };

  const tail = declares(from, workspace, cache);
  if (tail.why) return { verdict: "withheld", why: tail.why };
  const head = declares(to, workspace, cache);
  if (head.why) return { verdict: "withheld", why: head.why };

  const forward = tail.on.get(to);
  const backward = head.on.get(from);

  if (forward && backward) return { verdict: "cycle" };
  if (forward) return { verdict: "confirmed", evidence: forward };
  if (backward) return { verdict: "backwards", evidence: backward };
  return { verdict: "absent" };
}
