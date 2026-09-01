#!/usr/bin/env node
/**
 * Reports diagrams that no longer match the code.
 *
 *   npm run check:drift                      # every board under docs/diagrams
 *   npm run check:drift docs/diagrams/a.excalidraw b.excalidraw
 *   npm run check:drift -- --hook            # as a Claude Code Stop hook
 *
 * Silent when nothing has drifted. That is the point: this is meant to run on
 * every turn, and a check that announces good news thirty times an hour is a
 * check someone turns off.
 *
 * Two ways out, because two readers want opposite things:
 *
 * - **A terminal, CI, a pre-commit hook** want the report on stderr and a
 *   non-zero exit, so a build can fail on it. That is the default.
 * - **A Claude Code Stop hook** wants `--hook`: the report goes out as a
 *   `systemMessage` on stdout and the process exits 0.
 *
 * That second channel was measured rather than assumed, three times. Plain text on
 * stdout with exit 0 is discarded silently. stderr with a non-zero exit shows, but
 * Claude Code wraps it in "Stop hook error: Failed with non-blocking status code",
 * which reads as a broken tool rather than a finding — the check spent its whole
 * life apologising for working. Structured JSON on stdout renders as an ordinary
 * notice, and newlines, indentation, box-drawing characters, symbols and ANSI
 * colour all survive it.
 *
 * Colour took two rounds to settle, and the first answer was wrong: escapes were
 * put in a notice and the reply came back as pasted text, where colour is invisible
 * either way. It renders. Severity is carried by colour rather than emoji, which
 * matters beyond looks — an escape occupies no cells, while `⚠️` is ambiguous-width
 * and sheared every padded row it appeared in.
 *
 * The JSON shape below is the one that was measured. Slimming it is not obviously
 * safe without measuring again.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { box, fit, pad } from "./lib/box.mjs";
import {
  buildCodeGraph,
  codeGraphIsCurrent,
  findInstaller,
  graphifyVersion,
  headCommit,
} from "./lib/code-graph.mjs";
import { readBoard, writeBoard } from "../src/engine/board-file.ts";
import { applyPromotions, clearLivePromotions } from "../src/engine/promote.ts";
import { applyFollowed } from "../src/engine/repair.ts";
import { acceptBackwards } from "../src/engine/accept.ts";
import { readGraph } from "../src/engine/graph.ts";
import { damageSentence } from "../src/engine/damage.ts";
import { CONFIG_FILE, ConfigError, DEFAULT_DIAGRAM_DIR, diagramDir } from "../src/engine/config.ts";
import { countedWords, coverageLabel } from "../src/engine/summary.ts";
import {
  checkDrift,
  createGitBaseline,
  createWorkspace,
  findBoards,
  findStrayBoards,
  parseRef,
  UNCONFIRMED_WORDS,
} from "../src/engine/drift.ts";
import { createGitTrail } from "../src/engine/follow.ts";
import { initEngine } from "../src/engine/parse.ts";
import { createCodeGraphOption, TESTED_VERSION_PREFIX } from "../src/engine/codegraph.ts";
import { createLedger } from "../src/engine/ledger.ts";
import { goodNewsIds, goodNewsLine, goodNewsSince, novelGoodNews } from "../src/engine/goodnews.ts";

const root = process.cwd();

const USAGE = [
  "usage: diagramos drift [board.excalidraw ...] [options]",
  "",
  `  no arguments   check every board in this project's diagram directory`,
  `                 (${DEFAULT_DIAGRAM_DIR}, or "diagrams" in ${CONFIG_FILE})`,
  "",
  "  --hook         report as a Claude Code Stop hook and exit 0",
  "  --details      every finding, plus what was and was not checked",
  "  --expand       keep reporting in full until --shrink",
  "  --shrink       go back to the short notice",
  "  --no-edges     skip the arrow check",
  "  --no-deletions skip the removed-box check",
  "  --coverage     also suggest code the diagram does not show (never automatic)",
  "  --repair       rewrite the refs whose code the repository can place, and",
  "                 say which. Only where there is exactly one answer; never",
  "                 on the per-turn path.",
  '  --accept "a -> b"',
  "                 the code is right and the arrow was wrong: turn that one",
  "                 arrow round. Only an arrow this run reports as backwards,",
  "                 one at a time, never on the per-turn path.",
  "",
  "Silent, exit 0, when nothing has drifted.",
].join("\n");

function parseArgs() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    process.exit(0);
  }
  const opts = {
    edges: true,
    deletions: true,
    coverage: false,
    hook: false,
    details: false,
    expand: false,
    shrink: false,
    repair: false,
    /** The one arrow `--accept` was asked to turn round, if any. */
    accept: undefined,
  };
  const boards = [];

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--no-edges") {
      opts.edges = false;
    } else if (arg === "--no-deletions") {
      opts.deletions = false;
    } else if (arg === "--coverage") {
      opts.coverage = true;
    } else if (arg === "--hook") {
      opts.hook = true;
    } else if (arg === "--details" || arg === "--full") {
      opts.details = true;
    } else if (arg === "--expand") {
      opts.expand = true;
    } else if (arg === "--shrink") {
      opts.shrink = true;
    } else if (arg === "--repair") {
      opts.repair = true;
    } else if (arg === "--accept" || arg.startsWith("--accept=")) {
      /*
       * The one argument here that takes a value, because the value is the
       * whole safety property: accepting is per-arrow, and an `--accept` that
       * defaulted to "all of them" would be the silent rewriting this is
       * carefully not.
       */
      const inline = arg.startsWith("--accept=") ? arg.slice("--accept=".length) : undefined;
      const value = inline ?? argv[++index];
      if (!value || value.startsWith("--")) {
        console.error('--accept needs the arrow to turn round, as `--accept "from -> to"`.');
        process.exit(2);
      }
      opts.accept = value.trim();
    } else if (!arg.startsWith("--")) {
      boards.push(arg);
    }
  }

  return { boards, opts };
}

/**
 * Whether the notice has been asked to stay expanded.
 *
 * A file rather than an argument, because the caller that needs to know is the
 * *next* hook run, and a command cannot reach into a message the hook has already
 * written. It lives in .diagramos/, which is gitignored, so the preference is one
 * person's and not the repository's.
 *
 * The obvious objection to a mode is that it is invisible once set and then
 * puzzling — so the expanded notice always names the way back. Nothing here is
 * remembered that the notice does not say out loud.
 */
const MODE_FILE = path.join(root, ".diagramos", "report-expanded");

function setExpanded(on) {
  if (on) {
    mkdirSync(path.dirname(MODE_FILE), { recursive: true });
    writeFileSync(MODE_FILE, "expanded\n");
  } else {
    rmSync(MODE_FILE, { force: true });
  }
}

function isExpanded() {
  return existsSync(MODE_FILE);
}

async function boardsToCheck(boards, directory) {
  return boards.length > 0 ? boards.map((entry) => path.resolve(root, entry)) : findBoards(root, directory);
}

/** Box name as the reader sees it on the canvas. */
function boxName(finding) {
  return oneLine(finding.label || finding.node);
}

/**
 * A box label as one row.
 *
 * Labels wrap on the board -- "board server\nHTTP · SSE · watch" is one label
 * with a newline in it -- and a row containing a newline does not shear the
 * frame, it splits it in half. Every label reaching a padded row goes through
 * here.
 */
function oneLine(text) {
  return String(text).replace(/\s+/g, " ");
}

/**
 * Why a finding is a finding, spelled out.
 *
 * Deliberately absent from the notice, which fires every turn and would otherwise
 * repeat it — and present here, where somebody has asked.
 */
const REASONS = {
  "missing-file": "that file is not in the repo any more",
  "open-box": "something outside this directory reaches into it",
  "missing-symbol": "the file is there, that name in it is not",
  "unresolvable-ref": "that is not a path in this repo at all",
  "empty-ref": "it exists but has nothing in it",
  "missing-declaration": "the name is in the file, but nothing there declares it",
  "unused-symbol": "it is declared, and nothing outside its own declaration uses it",
  "unsupported-member": "the box lists it, and its body shows no trace of the others",
  "missing-route": "the file serves routes, and that one is not among them",
  "stale-number": "the label states a number the code it points at no longer uses",
  "generated-ref": "it points into build output, which no change to your code will ever disturb",
};
/**
 * Why a `needs` arrow got no direction verdict.
 *
 * Phrased as what is missing rather than as a code, because every one of these
 * is a reason the tool declined to accuse somebody and the reader is entitled to
 * know which. `cycle` is the odd one out: nothing is missing there, the question
 * simply has no answer.
 */
const NEEDS_WITHHELD = {
  unlicensed: "in a language with no measured reader",
  unreadable: "with an end that could not be read",
  incomplete: "with an end that could not be parsed to the end",
  dynamic: "with an end that reaches out at runtime",
  unvouched: "with an end no source index has ever read",
  "same-file": "pointing at their own file",
  cycle: "in a cycle, where neither direction is more correct",
  /*
   * The arrow never reached `checkNeeds` at all. Same sentence, because the
   * question the reader is asking is the same one -- why did nobody check this
   * -- and the phrasing that already answers it should not fork just because
   * the answer comes from an earlier gate.
   */
  "ends-not-bound": "with an end not snapped to its box",
  "endpoint-missing": "with an end that points at no box",
  "endpoint-external": "with an end marked external",
  "endpoint-has-no-ref": "with an end that has no ref",
  "endpoint-outside-repo": "with an end pointing outside the repo",
  "endpoint-generated": "with an end pointing into build output",
  "endpoint-file-missing": "with an end whose file is missing",
  "directory-ref": "with an end that refs a directory, not a file",
  "glob-ref": "with an end that refs a glob, not a file",
};

/**
 * Why a `@feeds` claim got no confirmation.
 *
 * Split into two groups by one question -- could anybody have looked -- because
 * that is what decides whether it belongs in a notice that fires every turn.
 * The first four mean nobody could, which is the same news an unanswered
 * `@needs` is (#113): silence in reply to a question reads as "checked, and
 * fine". The last two mean somebody looked, and #133 settled what those are
 * worth: a count, never an alarm.
 */
const FEEDS_NOT_CONFIRMED = {
  "not-symbols": "with an end anchored at a file rather than a symbol",
  "nowhere-to-look": "in a tree too large to walk",
  "ends-not-bound": "with an end not snapped to its box",
  "endpoint-missing": "with an end that points at no box",
  "endpoint-external": "with an end marked external",
  "endpoint-has-no-ref": "with an end that has no ref",
  "endpoint-outside-repo": "with an end pointing outside the repo",
  "endpoint-generated": "with an end pointing into build output",
  "endpoint-file-missing": "with an end whose file is missing",
  "directory-ref": "with an end that refs a directory, not a file",
  "glob-ref": "with an end that refs a glob, not a file",
  absent: "where no flow was found in either direction",
  reversed: "where the only flow found runs the other way",
};

/**
 * Why a claim written on a `planned` arrow could not be read.
 *
 * Mostly the sentences the live claims get, because the reader's question is
 * the same one -- why did nobody check this -- and only the framing above them
 * differs.
 *
 * The last three keys appear on no other line. A live claim is answered by
 * `checkNeeds` or by the `feeds` block before the walk can reach the licence
 * gate, so only a plan arrives there uncounted.
 */
const PLAN_UNREAD = {
  ...NEEDS_WITHHELD,
  /*
   * The one reason a plan needs its own words for.
   *
   * "with an end whose file is missing" is the sentence for a live claim, and it
   * means a file was deleted. Nothing was deleted here -- the file has not been
   * written, which is what the arrow was drawn to say. Printing the live wording
   * over a plan would report the plan working as a file going missing.
   */
  "endpoint-file-missing": "not written yet",
  "unlicensed-language": "in a language with no measured reader",
  "outside-licence": "with an end the reader was not measured over",
  "no-function-body": "with an end whose body could not be read",
};

/** The feeds reasons that mean nobody looked, which are the ones worth a notice. */
const FEEDS_UNANSWERED = new Set(
  Object.keys(FEEDS_NOT_CONFIRMED).filter((why) => why !== "absent" && why !== "reversed"),
);

/** Reasons with a count, commonest first, so a sentence can list them. */
function withheldReasons(table, only) {
  return Object.entries(table ?? {})
    .filter(([why, count]) => count > 0 && (!only || only.has(why)))
    .sort((a, b) => b[1] - a[1]);
}

/**
 * Claims nobody answered, on this board.
 *
 * The count, not the reasons: this is the number that decides whether the board
 * is worth a notice at all, and it is read in three places.
 *
 * Both words land here, and `feeds` brings only the half of its reasons that
 * mean nobody could look. A flow that was searched for and not found is not an
 * unanswered question, it is an answer of "no evidence" -- which is a count
 * (#133), and putting it in a per-turn notice is how the amber this project
 * just finished removing would come back under a new name.
 */
function unansweredClaims(report) {
  const needs = withheldReasons(report.claims?.needsWithheld);
  const feeds = withheldReasons(report.claims?.feedsWithheld, FEEDS_UNANSWERED);
  return [...needs, ...feeds].reduce((sum, [, count]) => sum + count, 0);
}

/**
 * The one-line version: what went unanswered and why, ordered commonest first.
 *
 * Deliberately the same sentence `--details` prints. `--details` earns the right
 * to say it about every board; the notice says it because a question asked and
 * not answered is news whether or not anybody asked for the long form.
 *
 * One line per word, because the two words are answered by different readers
 * and a reader who wrote one of them should not have to work out which half of
 * a merged sentence is about theirs.
 */
function unansweredClaimLines(report) {
  const said = [];
  for (const [word, reasons, table] of [
    ["needs", withheldReasons(report.claims?.needsWithheld), NEEDS_WITHHELD],
    ["feeds", withheldReasons(report.claims?.feedsWithheld, FEEDS_UNANSWERED), FEEDS_NOT_CONFIRMED],
  ]) {
    const total = reasons.reduce((sum, [, count]) => sum + count, 0);
    if (total === 0) continue;
    said.push(
      `${total} ${word} ${total === 1 ? "arrow" : "arrows"} not checked: `
      + reasons.map(([why, count]) => `${count} ${table[why] ?? why}`).join(", "),
    );
  }
  /*
   * One string per line, never one string with newlines in it. A row carrying a
   * newline does not wrap inside the frame, it splits the frame in half -- the
   * same rule `oneLine` exists for.
   */
  return said;
}

/**
 * What the plan asked for and nothing could answer yet.
 *
 * Its own sentence, and never folded into the two above (#129). Those say the
 * live claims on this board went unanswered, which is news; this says the code
 * has not arrived, which is what a plan is for. Merged, a sketch would report
 * its own arrows as unchecked every turn of the session that drew it.
 *
 * Said all the same. A `@needs` on a `planned` arrow is a specification of what
 * the dependency will be, and the arrows that carry one were being skipped in
 * silence -- so a plan built at the wrong path, with every ref pointing at a
 * file that was never written, read exactly like a plan nobody had started:
 * nothing red, nothing amber, exit 0.
 *
 * "cannot be checked yet" rather than "not checked", for the same reason it is
 * dim rather than yellow: nothing here is wrong or late. It is the one line on
 * the board that is expected to be true.
 */
function plannedClaimLine(report) {
  const reasons = withheldReasons(report.claims?.plannedWithheld);
  const total = reasons.reduce((sum, [, count]) => sum + count, 0);
  if (total === 0) return undefined;
  return `${total} of this plan's claims cannot be checked yet: `
    + reasons.map(([why, count]) => `${count} ${PLAN_UNREAD[why] ?? why}`).join(", ");
}

/** How many claims a plan is carrying that nothing could read. */
function plannedClaims(report) {
  return Object.values(report.claims?.plannedWithheld ?? {}).reduce((sum, count) => sum + count, 0);
}

/**
 * The one reason on that list somebody can fix by hand, and how.
 *
 * `ends-not-bound` is the only one a person causes by drawing rather than by
 * the shape of their code, and it is invisible on screen: an arrow whose ends
 * merely touch its boxes looks exactly like one snapped to them. Every other
 * reason is a fact about the files, where there is nothing to drag.
 *
 * Its own row rather than more words on the line above, because the line above
 * has to survive being one of several reasons on a board with several arrows,
 * and the notice truncates at the width of the box.
 */
function unsnappedClaimFix(report) {
  return (report.claims?.needsWithheld?.["ends-not-bound"] ?? 0) > 0
    ? "  drag each end onto its box until the box highlights"
    : undefined;
}

/**
 * What a promotion just started, said once, under the promotions it belongs to.
 *
 * `@feeds` only, and it used to be both words (#124). A promoted claim had been
 * read by nothing so far, so "built now" this turn and "drawn backwards" the
 * next read back to back as the tool contradicting itself (#123), and one line
 * here made the promotion's narrower meaning the obvious reading.
 *
 * A `@needs` arrow no longer arrives here with that question open. Its direction
 * is read before the promotion is offered, and a backwards answer holds the
 * promotion back rather than following it a run later -- so a promoted `@needs`
 * is one whose direction was either confirmed or is one nothing can answer, and
 * the pair of contradicting runs cannot happen. `@feeds` has no direction to be
 * wrong about and no such check, so it keeps the line.
 *
 * Only the promotions actually written. A promotion merely *reported* -- `drift`
 * in a terminal, or a box with anchors still unbuilt -- leaves the arrow planned,
 * so nothing goes live and there is nothing to warn about.
 *
 * Its own row rather than more words on the line above, for the same reason
 * `unsnappedClaimFix` has one: those lines carry a box label and the notice
 * truncates at the width of the box.
 */
function claimWentLive(promoted) {
  const word = promoted.find((promotion) => promotion.claim === "feeds")?.claim;
  return word ? `  a promoted @${word} is read for the first time on the next check` : undefined;
}

/**
 * The short row's version of a broken route.
 *
 * Two sentences the engine can produce, and they are not the same news: one
 * says the connection is gone, the other says only the route is stale. Reading
 * them off the detail keeps the notice from turning both into the scarier one.
 */
/**
 * The short row's version of a breached `closed` box: who got in, and how many.
 *
 * Read off the detail the same way `brokenHop` is, and for the same reason --
 * the engine already wrote the sentence, and a second phrasing here is a second
 * thing to keep in sync.
 */
function openBox(detail) {
  const who = detail.match(/^(\S+) line (\d+)/);
  const more = detail.match(/and (\d+) more/);
  if (!who) return "something outside reaches in";
  return `${who[1]}:${who[2]} reaches in`
    + (more ? ` (+${more[1]} more)` : "");
}

/**
 * A complete claim's refusal, short enough for a notice that fires every turn.
 *
 * The engine's sentence names the module, says how the board reaches it, counts
 * the rest and says what to do about it -- which is right in a report somebody
 * opened on purpose and four times too long for a box that appears unasked. The
 * first module and the count are the part that says how bad it is; the rest is
 * in `--details` and in `undrawn`.
 */
function incompleteBoard(detail) {
  const missing = /\. (\S+) has no box/.exec(detail);
  const more = /and (\d+) more modules? (?:is|are) missing/.exec(detail);
  const scope = /every module under (\S+)/.exec(detail);
  if (!missing) return detail;
  return `${missing[1]} has no box`
    + (more ? ` (+${more[1]} more` : "")
    + (more && scope ? ` under ${scope[1]})` : more ? ")" : "");
}

/**
 * A stale number, short enough for a notice that fires every turn.
 *
 * The name and the number, and nothing else. `box -> its ref` is the wrong row
 * here for the reason `open-box` gets its own: the anchor is fine, the picture
 * is what is wrong, and on the board this came from the label runs to four
 * lines -- so a row ending in the path truncates away the only part that says
 * which number to go and look at.
 */
function staleNumber(detail) {
  const said = /says (\S+?)=(\S+?),/.exec(detail);
  return said ? `says ${said[1]}=${said[2]}, the code does not` : "states a number the code does not";
}

function brokenHop(detail) {
  if (detail.includes("still connected, but not by this route")) {
    return "connected, but the route is wrong";
  }
  const gone = /breaks at ([^:]+):/.exec(detail);
  return gone ? `breaks at ${gone[1]}` : undefined;
}

/** What a stale box points at. */
function target(finding) {
  const { path: file, symbol } = parseRef(finding.ref);
  if (finding.kind === "missing-symbol") return `${symbol} in ${file}`;
  if (finding.kind === "missing-declaration" || finding.kind === "unused-symbol") {
    return `${symbol} in ${file}`;
  }
  if (finding.kind === "unresolvable-ref") return finding.ref;
  if (finding.kind === "missing-route") return `${symbol} in ${file}`;
  // The subject is the picture, not the anchor, so the row names the box's own
  // words rather than a path somebody would go and open.
  if (finding.kind === "stale-number") return symbol ? `${symbol} in ${file}` : file;
  return file;
}

/** Colour, applied where it renders: a terminal, and the notice. Never a pipe. */
const COLOUR = {
  red: "\u001b[31m",
  yellow: "\u001b[33m",
  green: "\u001b[32m",
  dim: "\u001b[2m",
  off: "\u001b[0m",
};

function paint(text, colour, enabled) {
  return enabled && colour ? `${COLOUR[colour]}${text}${COLOUR.off}` : String(text);
}

/**
 * Where the code behind a stale box went, under the row that says it is stale.
 *
 * Dim and indented, because it is not a second problem -- it is the answer to
 * the search the row above used to start, and painting it red would read as one
 * more thing wrong.
 *
 * The notice shows only the rows that end in an address. A followed ref with no
 * address is an explanation of why nobody can answer, which is worth reading
 * once when somebody asks and is not worth a line every turn.
 */
function followRow(followed, colour, all) {
  if (!followed) return [];
  if (!all && !followed.becomes) return [];
  return [paint(`  ↳ ${oneLine(followed.detail)}`, "dim", colour)];
}

/**
 * Plans the code contradicted, as opposed to plans it has not reached (#124).
 *
 * Both are work items and the report keeps them together, because both mean the
 * same thing about the board: this is still a sketch. They are pulled apart
 * everywhere a person reads them, because they mean opposite things about what
 * to do next -- one says carry on, the other says somebody has to decide which
 * of the two directions is the wrong one.
 */
function builtBackwards(report) {
  return report.workItems.filter((item) => item.kind === "built-backwards");
}

/** Rows of findings. Low on purpose: this fires at the end of every turn. */
const MAX_LISTED = 6;

/**
 * The way out, under the findings that need one (#141).
 *
 * `backwards-edge` is the only verdict here that means *wrong*, and until there
 * was a command for it the answers were to change the code or hand-edit the
 * board file -- so the loudest thing this check says was the one thing nobody
 * could act on. The foot offers `/update-diagram`, which is scoped to anchors
 * that went stale and says outright that it is not for this, so the report has
 * to carry its own answer.
 *
 * One line per report rather than one per arrow, and added *after* the rows are
 * trimmed rather than among them. It is not a finding: counted as one it ate
 * into the six that get listed and inflated "and N more", so a notice about
 * twelve arrows claimed twenty-one.
 *
 * It names an id because the id is what the command takes, and only one because
 * only one can be accepted at a time -- with no count of the rest, which in the
 * expanded view would sit under a list of every one of them.
 *
 * Dim, and phrased as the exception, because it is one: the common reading of a
 * backwards arrow is that the code drifted and the diagram was right, and a line
 * leading with "or accept it" would be teaching people to silence the check.
 */
function acceptHint(entries, colour) {
  // Both reports that say an arrow runs against the code, and they are offered
  // the same way out because it is the same one (#124): a `built` arrow the
  // check contradicts, and a `planned` one the code went the other way on.
  const backwards = entries.flatMap(({ report }) => [
    ...report.edges.filter((finding) => finding.kind === "backwards-edge"),
    ...builtBackwards(report),
  ]);
  if (backwards.length === 0) return [];
  return [
    paint(
      `  \u21b3 code right? /accept-arrow "${backwards[0].node}"`
      // Named only when there is a choice to be wrong about. With several
      // backwards arrows the line names one of them, and somebody who read that
      // as "this fixes them all" would be surprised by the second run.
      + (backwards.length > 1 ? " \u00b7 one arrow at a time" : ""),
      "dim",
      colour,
    ),
  ];
}

/**
 * One finding per row: what the box says, and what it points at.
 *
 * Work items are listed only when `all` is set, which the long form does and the
 * notice does not. A planned box the code has not reached is not a disagreement
 * with anything -- it is the sketch being ahead on purpose, and it would sit
 * there unchanged for the whole of a design session.
 */
function rowsFor({ report, promoted = [] }, colour, all = false) {
  const promotedNodes = new Set(promoted.map((promotion) => promotion.node));
  const followedFor = new Map((report.followed ?? []).map((entry) => [entry.node, entry]));
  const unanswered = unansweredClaimLines(report);
  const unsnapped = unsnappedClaimFix(report);
  const planned = plannedClaimLine(report);
  const promotedClaim = claimWentLive(promoted);
  return [
    // First, because it is the only row here that says the check could not read
    // the board rather than that the board and the code disagree.
    ...(report.garbledClaims ?? []).map((finding) =>
      paint(
        `${finding.on === "arrow" ? "arrow " : ""}${oneLine(finding.label)} \u00b7 `
        // A board stamped by a newer diagramos is not a board with a typo on
        // it, and telling its author to fix the diagram is an invented red
        // (#181). Same row, opposite instruction.
        + (finding.cause === "older-build"
          ? `@${finding.written} is a claim this build does not have \u2014 update diagramos`
          : `@${finding.written} is not a claim`),
        "red",
        colour,
      ),
    ),
    /*
     * A question asked and not answered, next to the unreadable ones and above
     * the disagreements, for the same reason they are: the rows below are the
     * board and the code differing, which somebody can go and look at. This one
     * says nobody looked, and reading it after a clean-looking list is how it
     * gets mistaken for a footnote.
     *
     * Yellow, not red. Nothing here is wrong -- the claim may well hold. What is
     * wrong is that a clean report was standing in for an answer.
     */
    ...unanswered.map((line) => paint(line, "yellow", colour)),
    ...(unsnapped ? [paint(unsnapped, "dim", colour)] : []),
    /*
     * Under those and dim, which is the whole difference between them: the line
     * above is a question about today that nobody answered, this one is a
     * question about later that nobody could answer yet. Painting them the same
     * would turn the ordinary state of a plan into two lines of amber.
     */
    ...(planned ? [paint(planned, "dim", colour)] : []),
    ...report.deleted.map((finding) =>
      paint(`${boxName(finding)} removed, ${parseRef(finding.ref).path} still there`, "red", colour),
    ),
    ...report.findings.flatMap((finding) => [
      /*
       * The findings whose subject is somewhere other than the anchor.
       *
       * Every other row here reads "box → the thing it points at", because every
       * other finding is the anchor going stale. An `open-box` is about somebody
       * else's import, so the arrow form would name the wrong file entirely --
       * it would point at the directory that is fine rather than at the file
       * that reached into it. `incomplete-board` is further out still: it is not
       * about a box at all, but about a module with no box, so there is nothing
       * for an arrow to point from. `stale-number` is about the label itself,
       * and its anchor is not what went wrong. All three say the engine's own
       * sentence instead.
       */
      finding.kind === "stale-number"
        // The label is cut, not the sentence. A box carrying a number claim is
        // a densely written one by nature -- the one this came from runs to
        // four lines -- and the number is the half worth reading.
        ? paint(`${fit(boxName(finding), 28)} \u00b7 ${staleNumber(finding.detail)}`, "red", colour)
        : finding.kind === "open-box"
        ? paint(`${boxName(finding)} \u00b7 ${openBox(finding.detail)}`, "red", colour)
        : finding.kind === "incomplete-board"
          ? paint(`${boxName(finding)} \u00b7 ${incompleteBoard(finding.detail)}`, "red", colour)
          : paint(`${boxName(finding)} \u2192 ${target(finding)}`, "red", colour),
      ...followRow(followedFor.get(finding.node), colour, all),
    ]),
    ...report.edges.map((finding) => {
      // A named route knows where it stopped holding, and that is the only
      // thing this shape offers over a plain unsupported arrow. Printing just
      // the endpoints would throw it away.
      const hop = finding.kind === "broken-chain" ? brokenHop(finding.detail) : undefined;
      /*
       * The one arrow row that is red, and the only one that says which way to
       * fix it. Every other yellow row here means "worth a look"; this one means
       * the arrow is pointing the wrong way, and it is worth looking different so
       * nobody spends time re-checking a connection that is simply reversed.
       */
      const backwards = finding.kind === "backwards-edge";
      /*
       * The second verdict that means wrong (#169), and red for the same reason.
       * A different sentence, though: this arrow is not pointing the wrong way,
       * it is pointing at a function whose signature does not mention the type,
       * and "should be \u2190" would send somebody to turn round an arrow that is
       * already the right way round.
       */
      const wrongSignature = finding.kind === "signature-absent";
      /*
       * The third (#188), red for the same reason and a third sentence: this
       * arrow points at a type whose fields do not mention the other end, which
       * is fixed by looking at the fields rather than at a signature.
       */
      const wrongHolds = finding.kind === "holds-absent";
      return paint(
        `${boxName({ label: finding.fromLabel, node: finding.from })}`
        + ` ${backwards ? "\u2192 (should be \u2190)" : "\u2192"} `
        + `${boxName({ label: finding.toLabel, node: finding.to })}`
        + (backwards ? " \u00b7 drawn backwards" : "")
        + (wrongSignature ? " \u00b7 not in the signature" : "")
        + (wrongHolds ? " \u00b7 not in the fields" : "")
        + (hop ? ` \u00b7 ${hop}` : ""),
        backwards || wrongSignature || wrongHolds ? "red" : "yellow",
        colour,
      );
    }),
    /*
     * A plan the code went the other way on.
     *
     * Not gated on --all, unlike every other work item, and yellow rather than
     * dim. Until #124 this arrow was promoted instead: "built now — board
     * updated", in green, on the strength of a connection that runs against the
     * plan, with the contradiction arriving a run later once the arrow was
     * `built`. The row that replaces it has to be visible in the same place the
     * green one was, or the fix is only that the good news stopped.
     *
     * Not red, and phrased as an observation rather than a verdict: from here a
     * plan somebody drew to invert a dependency and a plan an agent implemented
     * backwards are the same two files pointing the same way. What is certain is
     * what the code does, and that the plan is not built.
     */
    ...builtBackwards(report).map((item) =>
      paint(`${boxName(item)} \u00b7 built the other way round`, "yellow", colour),
    ),
    // Deleted edges: quiet notes about arrows that were removed but the code still supports
    ...(report.deletedEdges ?? []).map((finding) =>
      paint(
        `arrow ${oneLine(finding.fromLabel || finding.from)} → ${oneLine(finding.toLabel || finding.to)} deleted — the code still connects them`,
        "dim",
        colour,
      ),
    ),
    // Good news the check acted on: the board is already advanced, so this
    // line appears once and the next run is quiet about it.
    ...promoted.map((promotion) =>
      paint(`${boxName(promotion)} is built now — board updated`, "green", colour),
    ),
    ...(promotedClaim ? [paint(promotedClaim, "dim", colour)] : []),
    // Good news the check held back from: the same box still has unbuilt
    // anchors, so flipping it would erase the remaining work from the picture.
    ...report.promotions
      .filter((promotion) => !promotedNodes.has(promotion.node))
      .map((promotion) => paint(`${boxName(promotion)} is built now`, "green", colour)),
    ...(all
      ? report.workItems
        .filter((item) => item.kind !== "built-backwards")
        .map((item) => paint(`${boxName(item)} not built yet`, "dim", colour))
      : []),
  ];
}

/**
 * "2 gone  1 arrow  1 built", each part coloured, empty parts dropped.
 *
 * Named fields rather than positions: there are a dozen of them, two call sites
 * spell every one out, and the twelfth argument is where a counting bug goes to
 * hide.
 */
/**
 * The arrow verdicts that mean **wrong** rather than *worth a look*.
 *
 * A set rather than a chain of `!==`, which is what this was: every arrival of a
 * refutable kind meant remembering to extend two filters, and forgetting either
 * one counts a red arrow among the ambers -- which is the one summary mistake
 * #169 exists to prevent.
 */
const WRONG_EDGE_KINDS = new Set(["backwards-edge", "signature-absent", "holds-absent"]);

function tallyCounts({ gone, generated, empty, unused, open, incomplete, removed, garbled, unanswered, backwards, signatures, fields, arrows, stray, promoted, built, planned }, colour) {
  return [
    gone ? paint(`${gone} gone`, "red", colour) : "",
    // Its own word, because "gone" is the opposite of what happened: the file
    // is there, it is simply a build artifact, and a reader told "gone" goes
    // looking for a deletion nobody made.
    generated
      ? paint(`${generated} ${generated === 1 ? "points" : "point"} at build output`, "red", colour)
      : "",
    empty ? paint(`${empty} empty`, "red", colour) : "",
    // Its own word, because "1 gone" was actively wrong for it: nothing is gone,
    // a boundary the board claimed is being reached through.
    open ? paint(`${open} reached into`, "red", colour) : "",
    // Same reasoning as "reached into": "1 gone" would say a file disappeared,
    // and what happened is that the board never drew one.
    incomplete ? paint(`${incomplete} incomplete`, "red", colour) : "",
    // Separate from "gone" because it is a different sentence: the code is
    // still there, and nothing calls it any more.
    unused ? paint(`${unused} unused`, "red", colour) : "",
    removed ? paint(`${removed} removed`, "red", colour) : "",
    // Red, and not folded into "arrows": an unreadable claim is not an arrow the
    // code failed to corroborate, it is a word the check could not read at all.
    garbled ? paint(`${garbled} unreadable`, "red", colour) : "",
    // Apart from "arrows", which means the code did not corroborate this one.
    // Here nothing was corroborated or refuted: the claim was never put to the
    // code at all, and folding it into the amber total would make "not asked"
    // read as "asked, no answer".
    unanswered ? paint(`${unanswered} unchecked ${unanswered === 1 ? "claim" : "claims"}`, "yellow", colour) : "",
    /*
     * Backwards arrows counted apart, and red, the way the board page has
     * always counted them.
     *
     * They used to sit inside the amber "N arrows" total beside the arrows the
     * code merely failed to corroborate, which read a refutation as a maybe.
     * Since #133 that total holds nothing else worth confusing them with --
     * absence is a count now, not a finding -- so keeping them folded in would
     * be colouring the only certain arrow verdict as the uncertain one.
     */
    backwards ? paint(`${backwards} ${backwards === 1 ? "arrow" : "arrows"} backwards`, "red", colour) : "",
    /*
     * The second refutable arrow verdict (#169), red and counted apart from the
     * first for the same reason the first is counted apart from the ambers: both
     * mean wrong, and they want opposite fixes. "2 arrows backwards" would send
     * somebody to turn round an arrow that is already the right way round.
     */
    fields
      ? paint(`${fields} ${fields === 1 ? "field" : "fields"} disagree`, "red", colour)
      : null,
    signatures
      ? paint(`${signatures} ${signatures === 1 ? "signature" : "signatures"} disagree`, "red", colour)
      : "",
    arrows ? paint(`${arrows} ${arrows === 1 ? "arrow" : "arrows"}`, "yellow", colour) : "",
    stray ? paint(`${stray} stray ${stray === 1 ? "arrow" : "arrows"}`, "dim", colour) : "",
    // "promoted" is done -- the board was advanced this run; "built" is still
    // waiting -- the code landed and the board could not be advanced for it.
    promoted ? paint(`${promoted} promoted`, "green", colour) : "",
    built ? paint(`${built} built`, "green", colour) : "",
    planned ? paint(`${planned} planned`, "dim", colour) : "",
  ].filter(Boolean).join("  ");
}

function tallyFor({ report, promoted = [] }, colour) {
  const count = (kind) => report.findings.filter((finding) => finding.kind === kind).length;
  const empty = count("empty-ref");
  const unused = count("unused-symbol");
  const open = count("open-box");
  // Out of "gone" for the reason "open-box" is: nothing here is missing from
  // the tree, the board is missing something from the picture.
  const incomplete = count("incomplete-board");
  const generated = count("generated-ref");
  const promotedNodes = new Set(promoted.map((promotion) => promotion.node));
  return tallyCounts(
    {
      gone: report.findings.length - empty - unused - open - incomplete - generated,
      generated,
      empty,
      unused,
      open,
      incomplete,
      removed: report.deleted.length,
      garbled: (report.garbledClaims ?? []).length,
      unanswered: unansweredClaims(report),
      backwards: report.edges.filter((finding) => finding.kind === "backwards-edge").length,
      // Counted with `backwards` rather than with the amber arrows: both mean
      // wrong, and an arrow definitely wrong must never be summarised as one of
      // N things worth a look (#169).
      signatures: report.edges.filter((finding) => finding.kind === "signature-absent").length,
      fields: report.edges.filter((finding) => finding.kind === "holds-absent").length,
      arrows: report.edges.filter((finding) => !WRONG_EDGE_KINDS.has(finding.kind)).length,
      stray: report.strayArrows ?? 0,
      promoted: promoted.length,
      built: report.promotions.filter((promotion) => !promotedNodes.has(promotion.node)).length,
      planned: report.workItems.length,
    },
    colour,
  );
}

/**
 * The long form: the same rows as the notice, one box per diagram, nothing capped.
 *
 * No reasons on the rows. The notice is trimmed for brevity, so what is missing
 * from it is the *findings*, not an explanation of them — and someone who wants
 * the reasoning can ask, or read docs/drift-check.md. The command sits in the
 * bottom border of the last box, so it appears once under everything.
 */
function renderDetails(stale, colour, foot = "/update-diagram updates the diagram") {
  return box({
    sections: stale.map((entry) => ({
      label: `${path.basename(entry.file)}  ${tallyFor(entry, colour)}`,
      rows: [...rowsFor(entry, colour, true), ...acceptHint([entry], colour)],
    })),
    foot,
    max: 72,
  });
}

/**
 * The notice. Small by default, because it fires at the end of every turn.
 *
 * One stale diagram lists what is wrong with it. Several list themselves with
 * their counts, and /expand-report is how somebody sees all of it — a command that
 * shows more once, rather than a mode that has to be switched back off.
 */
function render(stale, colour) {
  const single = stale.length === 1;
  const found = stale.map((entry) => ({ entry, rows: rowsFor(entry, colour) }));

  // One diagram shows its findings; several show a line each with their counts.
  //
  // Listing findings across diagrams was tried and reverted: three findings in two
  // diagrams became a seven-line box where counts were four, which is the opposite
  // of what a notice firing every turn should do. The rule is now the simple one —
  // one diagram, see what is wrong; several, see where.
  const totals = stale.reduce(
    (sum, { report, promoted = [] }) => {
      const promotedNodes = new Set(promoted.map((promotion) => promotion.node));
      return {
        gone: sum.gone + report.findings.filter(
          (finding) => finding.kind !== "empty-ref" && finding.kind !== "unused-symbol"
            && finding.kind !== "open-box" && finding.kind !== "incomplete-board"
            && finding.kind !== "generated-ref",
        ).length,
        generated: sum.generated
          + report.findings.filter((finding) => finding.kind === "generated-ref").length,
        open: sum.open + report.findings.filter((finding) => finding.kind === "open-box").length,
        incomplete: sum.incomplete
          + report.findings.filter((finding) => finding.kind === "incomplete-board").length,
        empty: sum.empty + report.findings.filter((finding) => finding.kind === "empty-ref").length,
        unused: sum.unused + report.findings.filter((finding) => finding.kind === "unused-symbol").length,
        removed: sum.removed + report.deleted.length,
        garbled: sum.garbled + (report.garbledClaims ?? []).length,
        unanswered: sum.unanswered + unansweredClaims(report),
        backwards: sum.backwards
          + report.edges.filter((finding) => finding.kind === "backwards-edge").length,
        signatures: sum.signatures
          + report.edges.filter((finding) => finding.kind === "signature-absent").length,
        fields: sum.fields
          + report.edges.filter((finding) => finding.kind === "holds-absent").length,
        arrows: sum.arrows
          + report.edges.filter((finding) => !WRONG_EDGE_KINDS.has(finding.kind)).length,
        stray: sum.stray + (report.strayArrows ?? 0),
        promoted: sum.promoted + promoted.length,
        built: sum.built
          + report.promotions.filter((promotion) => !promotedNodes.has(promotion.node)).length,
        planned: sum.planned + report.workItems.length,
      };
    },
    { gone: 0, generated: 0, empty: 0, unused: 0, open: 0, incomplete: 0, removed: 0, garbled: 0, unanswered: 0, backwards: 0, signatures: 0, fields: 0, arrows: 0, stray: 0, promoted: 0, built: 0, planned: 0 },
  );

  // Too many to list: counts per diagram, and a pointer to the view that has room.
  const head = single
    ? `${path.basename(stale[0].file)}  ${tallyCounts(totals, colour)}`
    : `${stale.length} diagrams out of date  ${tallyCounts(totals, colour)}`;

  const rows = [];
  let hidden = 0;
  if (single) {
    rows.push(...found[0].rows.slice(0, MAX_LISTED));
    hidden = found[0].rows.length - MAX_LISTED;
  } else {
    const widest = Math.min(28, Math.max(...stale.map(({ file }) => path.basename(file).length)));
    for (const { entry } of found.slice(0, MAX_LISTED)) {
      rows.push(`${pad(fit(path.basename(entry.file), widest), widest)}  ${tallyFor(entry, colour)}`);
    }
    hidden = Math.max(0, stale.length - MAX_LISTED);
  }
  if (hidden > 0) {
    rows.push(paint(`\u2026 and ${hidden} more${single ? "" : " diagrams"}`, "dim", colour));
  }
  rows.push(...acceptHint(stale, colour));

  return box({ head, foot: "/update-diagram updates it · /expand-report shows them all", rows });
}

async function hookOnStdin() {
  if (process.stdin.isTTY) return false;

  let timer;
  const read = new Promise((resolve) => {
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", () => resolve(""));
  });
  const raw = await Promise.race([
    read,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(""), 200);
    }),
  ]);

  // Both of these matter. Listening on stdin puts it in flowing mode and holds the
  // event loop open, so a clean run — which prints nothing and never calls exit —
  // hung until the test harness killed it at two minutes. The timer holds it open
  // the same way.
  clearTimeout(timer);
  process.stdin.pause();
  // Only a socket has unref. Redirect stdin from /dev/null and it is an fs stream
  // instead, where calling it throws — which is how `npm run check:drift` from a
  // script died while every test, all of which used a pipe, passed.
  if (typeof process.stdin.unref === "function") process.stdin.unref();

  try {
    const payload = JSON.parse(raw);
    return Boolean(payload && typeof payload === "object" && payload.hook_event_name);
  } catch {
    return false;
  }
}

const { boards, opts } = parseArgs();
if (!opts.hook) opts.hook = await hookOnStdin();
/*
 * The per-turn path never accepts, and the guard is here rather than a comment,
 * because `--hook` is also set by being *run* as a hook -- so this catches a
 * configuration that would otherwise turn arrows round every turn with nobody
 * watching. Accepting is a person deciding the architecture changed; a hook
 * cannot be that person.
 */
if (opts.accept && opts.hook) {
  console.error("--accept is not available on the hook path: turning an arrow round is a decision somebody makes, not one a check makes for them.");
  process.exit(2);
}
if (opts.expand) setExpanded(true);
if (opts.shrink) setExpanded(false);
// --details is a one-off; the mode file is what the next hook run reads.
const expanded = opts.details || opts.expand || (!opts.shrink && isExpanded());
const workspace = createWorkspace(root);
const stale = [];
const examined = [];
const suggested = [];
const unannotated = [];
const problems = [];

/*
 * A config that exists but cannot be honoured is fatal, and loudly so. Falling
 * back to the default directory would mean checking somewhere other than where
 * the project said, silently -- the exact failure this whole area is about.
 * Through the hook it goes out as a systemMessage, because stderr from a hook is
 * discarded and a report nobody can read is the same as no report.
 */
let directory;
try {
  directory = diagramDir(root);
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  if (opts.hook) {
    process.stdout.write(
      `${JSON.stringify({ continue: true, suppressOutput: false, systemMessage: `\n${error.message}` })}\n`,
    );
    process.exit(0);
  }
  console.error(error.message);
  process.exit(1);
}

const checking = await boardsToCheck(boards, directory);

/*
 * "Nothing drifted" and "nothing was looked at" used to be the same output --
 * silence and exit 0 -- so a board one directory off the standard place made
 * this report clean forever, including through the Stop hook, where a project
 * would go a whole lifetime believing its diagrams were guarded.
 *
 * Said only on demand. The hook fires every turn, and a project with no
 * diagrams must not be told so thirty times an hour; staying quiet there is the
 * property this check was tuned for. Exit 0 either way: having no diagrams is
 * not a failure, and CI should not go red over it.
 */
if (checking.length === 0) {
  if (!opts.hook) {
    const lines = [
      existsSync(path.resolve(root, directory))
        ? `no .excalidraw files in ${directory}/ — nothing to check`
        : `${directory}/ does not exist — nothing to check`,
    ];
    // Only here, where the check has already come up empty, is it worth reading
    // the whole repository to find out whether the diagrams are simply
    // somewhere else. "You have boards, just not where I looked" is the
    // likeliest reason to be in this branch and the least guessable.
    const strays = await findStrayBoards(root, directory);
    if (strays.boards.length > 0) {
      const more = strays.more > 0 ? ` (and ${strays.more} more)` : "";
      lines.push(
        `found ${strays.boards.length + strays.more} elsewhere${more}: ${strays.boards.join(", ")}`,
        `move them into ${directory}/, or set {"diagrams": "..."} in ${CONFIG_FILE}`,
      );
    }
    console.error(lines.join("\n"));
  }
  process.exit(0);
}

// Grammars load once per process; everything below this line is synchronous.
await initEngine();

/*
 * Every board is read before any of them is checked, because two decisions
 * need the files in hand: whether an unreadable board is a problem to report,
 * and whether this run has a single arrow on it -- which is the only thing the
 * code graph can ever help with, and therefore the guard on paying to build
 * one.
 */
const loaded = [];
for (const file of checking) {
  try {
    loaded.push({ file, boardFile: await readBoard(file) });
  } catch (error) {
    // An unreadable board is a problem, but not drift. Say so and keep going
    // rather than failing a commit over a file that may not be a board at all.
    problems.push(`${path.relative(root, file)}: could not read (${error.message})`);
  }
}

/*
 * The graph, built here when this project has none.
 *
 * It used to be built only by a post-commit hook, installed by `npm prepare`
 * -- which never runs for a project that installs this tool, so the graph was
 * never built there and the check told the reader to run two scripts out of
 * *this* package.json (#132). Telling someone to fetch a Python tool in a Rust
 * repo is weaker than opt-in; it is opt-in with instructions that do not work.
 * So the check does it, once per commit, and says so once.
 *
 * The guard is what keeps this cheap, and every part of it is a file test or a
 * `--version`:
 *
 * - only when arrows are being checked, and only when a board draws one;
 * - only when the graph is missing or a commit behind (an uncommitted edit is
 *   not stale: the reader falls back per file, and rebuilding per edit would
 *   mean rebuilding every turn);
 * - only when graphify is already installed, at a version the reader accepts
 *   -- this never installs anything, and never builds a graph that would be
 *   refused on arrival;
 * - at most one attempt per commit, so a repo where the extraction fails or
 *   times out pays for it once rather than on every turn.
 *
 * DIAGRAMOS_SKIP_GRAPHIFY=1 opts out entirely, the same variable that stops
 * the installer.
 */
const ATTEMPT_FILE = path.join(root, ".diagramos", "code-graph-attempted");
/** What was built this run, for the one-time line at the bottom. */
let builtGraph;
/** Whether a build ran here at all, which is what "could not be built" means. */
let attemptedGraph = false;
// Cheapest questions first: two flags and a walk over elements already in
// memory, before anything spawns a subprocess.
if (
  opts.edges
  && !process.env.DIAGRAMOS_SKIP_GRAPHIFY
  && loaded.some(({ boardFile }) => boardFile.elements.some((element) => element.type === "arrow"))
) {
  const head = headCommit(root);
  if (head && !codeGraphIsCurrent(root, head) && readAttempt() !== head) {
    // Recorded before the build, not after, so a build that dies -- or takes
    // the whole timeout -- is still an attempt that happened.
    writeAttempt(head);
    attemptedGraph = true;
    // A minute, not the builder's two: this one runs in front of somebody
    // waiting for a turn to end, and a check that hangs is worse than an arrow
    // that goes unread.
    builtGraph = buildCodeGraph(root, {
      timeout: 60_000,
      versionPrefix: TESTED_VERSION_PREFIX,
    });
  }
}

/** The commit the last build attempt here was for, successful or not. */
function readAttempt() {
  try {
    return readFileSync(ATTEMPT_FILE, "utf8").trim();
  } catch {
    return undefined;
  }
}

function writeAttempt(commit) {
  try {
    mkdirSync(path.dirname(ATTEMPT_FILE), { recursive: true });
    writeFileSync(ATTEMPT_FILE, `${commit}\n`);
  } catch {
    // A tree we cannot write to: the attempt may repeat, nothing else changes.
  }
}

// The code graph, when a build of it exists and parses -- the one just made, or
// one an earlier run or the commit hook left. Every failure is silence: the
// checker below runs exactly as it does without it.
const codeGraphOption = createCodeGraphOption(root);

// Which files a source index has read, so a verdict is never built on one
// nothing has. No manifest means no gate, not an empty one.
const ledger = createLedger(root);

/**
 * Boards that improved since their last commit: a box added, a box or arrow
 * somebody other than this hook flipped to built (#67). Bad news always
 * reached the notice; this is the green counterpart, computed against the same
 * git baseline the deleted-box check uses.
 */
const improved = [];

/*
 * Where moved code went, shared by every board in this run.
 *
 * Always on, and no flag to turn it off, because it costs nothing to have here:
 * nothing is asked of git until a box is *already* a finding, so a clean report
 * -- the case that fires at the end of every turn -- never touches it at all. One
 * trail rather than one per board so two diagrams pointing at the same moved file
 * ask about it once.
 */
const trail = createGitTrail(root);

/** Refs `--repair` rewrote, per board. Empty on every other run. */
const repaired = [];

/** The arrow `--accept` turned round, and the reason it did not. One of each, at most. */
const accepted = [];
const acceptHeld = [];

/*
 * Which board holds the arrow `--accept` names, settled before a single board is
 * written.
 *
 * The rule the whole feature rests on is one claim at a time, and the loop below
 * writes each board as it reaches it -- so if two diagrams both drew `a -> b`,
 * deciding inside the loop would flip the first and only then discover the
 * second. This asks the cheap question first: it reads the recorded graph of
 * each board, which costs nothing next to a drift check, and refuses outright
 * rather than turning an arrow nobody pointed at.
 */
let acceptFile;
if (opts.accept) {
  const holding = loaded.filter(({ boardFile }) =>
    readGraph(boardFile).edges.some((edge) => `${edge.from} -> ${edge.to}` === opts.accept),
  );
  if (holding.length === 0) {
    console.error(
      `No arrow here is drawn \`${opts.accept}\`. Run the check without --accept; `
        + `a backwards finding names the arrow in the form to pass back.`,
    );
    process.exit(2);
  }
  if (holding.length > 1) {
    console.error(
      `\`${opts.accept}\` is drawn on ${holding.length} boards, and this turns one arrow round, `
        + `not several. Name the board:\n`
        + holding.map(({ file }) => `  diagramos drift ${path.relative(root, file)} --accept "${opts.accept}"`)
          .join("\n"),
    );
    process.exit(2);
  }
  acceptFile = holding[0].file;
}

for (const { file, boardFile } of loaded) {
  let report;
  /** Promotions actually written to the board this run, one per box or arrow. */
  let promoted = [];
  try {
    // Per board, so the cheap "unmodified" answer short-circuits each one.
    const baseline = opts.deletions ? createGitBaseline(root, file) : undefined;
    report = checkDrift(boardFile, workspace, {
      edges: opts.edges,
      coverage: opts.coverage,
      trail,
      ...(baseline ? { baseline } : {}),
      ...(codeGraphOption ? { codeGraph: codeGraphOption } : {}),
      ...(ledger ? { ledger } : {}),
    });
    // Read before promotions are applied below, so a flip the hook makes this
    // run is announced once as "promoted" and never again as news.
    if (opts.hook && baseline) {
      const news = goodNewsSince(boardFile, baseline.committed());
      if (news) improved.push({ file, news });
    }
    /*
     * A promotion says the board is behind the code by exactly one edit, and
     * this makes the edit: flip the box to built, write the file, say so once.
     * The next run then has nothing to repeat, and on a live board the box
     * turns solid on screen the moment the work lands.
     *
     * Hook-only on purpose. `drift` in a terminal, CI or a pre-commit hook is
     * a check, and a check that mutates the working tree breaks every
     * `git diff --exit-code` that runs after it. A box only partly landed --
     * several anchors, some unresolved -- is held, not applied.
     */
    /*
     * The board repairing its own addresses, when somebody asks it to.
     *
     * Everything above reports; this is the one path that writes a ref. Asked
     * for explicitly and never on `--hook`, because the per-turn path runs
     * without anybody watching and this is the edit that has to be watched: a
     * wrong rebind is silent, and the whole argument for allowing one at all
     * (`docs/rebind-measurement.md`) rests on the two channels behind it being
     * the ones that were never wrong. Reported line by line, old ref and new,
     * so it can be read and reverted.
     *
     * Ordered before promotions so a box whose ref this fixes is checked again
     * on the next run rather than being promoted on the strength of the old one.
     */
    if (opts.repair && !opts.hook && report.followed.length > 0) {
      const result = applyFollowed(boardFile, report);
      if (result.applied.length > 0) {
        try {
          await writeBoard(file, result.board);
          repaired.push({ file, applied: result.applied });
          // The board just changed underneath the report, so the findings this
          // repair answered are no longer true. Re-checking is cheaper than
          // explaining a stale list, and it is what the next run would say.
          report = checkDrift(result.board, workspace, {
            edges: opts.edges,
            coverage: opts.coverage,
            trail,
            // The baseline comes too. Without it the second pass would drop the
            // removed-box findings the first pass made, and a repair would
            // quietly take a deleted claim off the report with it.
            ...(baseline ? { baseline } : {}),
            ...(codeGraphOption ? { codeGraph: codeGraphOption } : {}),
            ...(ledger ? { ledger } : {}),
          });
        } catch {
          // An unwritable tree: keep reporting the suggestion instead of it.
        }
      }
    }
    /*
     * The one place a claim's meaning changes, and only because somebody said so.
     *
     * Everything else on this path either reports, repairs an address, or
     * releases a plan gate the code already opened. This decides that the
     * dependency runs the other way -- a design decision, which is why it is
     * reachable only from an argument naming one arrow, and never from --hook.
     *
     * It is checked against the report first: an arrow this run does not accuse
     * cannot be accepted, so a stale terminal cannot flip something that stopped
     * being wrong ten minutes ago.
     */
    if (file === acceptFile) {
      const result = acceptBackwards(boardFile, report, opts.accept);
      if (result.applied) {
        try {
          await writeBoard(file, result.board);
          accepted.push({ file, applied: result.applied });
          // The board changed underneath the report, and the finding this just
          // answered is not true any more. Re-checking is what the next run
          // would say, and cheaper than explaining a stale list.
          report = checkDrift(result.board, workspace, {
            edges: opts.edges,
            coverage: opts.coverage,
            trail,
            ...(baseline ? { baseline } : {}),
            ...(codeGraphOption ? { codeGraph: codeGraphOption } : {}),
            ...(ledger ? { ledger } : {}),
          });
        } catch (error) {
          acceptHeld.push({
            file,
            held: { node: opts.accept, why: "unwritable", detail: `could not write the board (${error.message}).` },
          });
        }
      } else if (result.held) {
        acceptHeld.push({ file, held: result.held });
      }
    }
    if (opts.hook) {
      const result =
        report.promotions.length > 0
          ? applyPromotions(boardFile, report)
          : { board: boardFile, applied: [] };
      /*
       * Previews the promotion above did not settle, taken back off.
       *
       * While a board is being watched, the service flips a box to a solid
       * stroke the moment its code lands, without recording it as built (#130).
       * That preview is only as good as the moment it was drawn -- and this is
       * the moment the question gets asked properly. A box whose file has since
       * been deleted, or which the check now holds for another unresolved
       * anchor, goes back to dashed here and never became `built`.
       *
       * `applyPromotions` has already removed the marker from everything it
       * settled, so what this finds is exactly the previews that did not earn
       * it. It also cleans up after a service that was killed mid-turn, which
       * would otherwise leave a board looking built with a record saying
       * planned and nothing left running to correct it.
       */
      const settled = clearLivePromotions(result.board);
      if (result.applied.length > 0 || settled.cleared > 0) {
        try {
          await writeBoard(file, settled.board);
          promoted = result.applied;
        } catch {
          // A tree we cannot write to: keep reporting the promotion instead.
        }
      }
    }
  } catch (error) {
    // A board that read fine and still could not be checked: a problem, but not
    // drift. Say so and keep going rather than failing a commit over one file.
    problems.push(`${path.relative(root, file)}: could not check (${error.message})`);
    continue;
  }
  examined.push({ file, report, promoted });

  /*
   * A board that contradicts itself, said before anything else about it (#165).
   *
   * It goes in `problems` rather than in the drift report, and that placement is
   * the point. `problems` already means "this run could not honestly answer for
   * this file", and it is the one channel here that reaches the exit code
   * without pretending to be drift. Nothing about the code has changed; the
   * board simply does not draw the way it reads, so the clean report this run
   * would otherwise print about it is worth nothing -- which is exactly what
   * happened to the board that prompted this, checked clean while blank.
   */
  const damage = damageSentence(report.damage ?? []);
  if (damage) {
    problems.push(`${path.relative(root, file)}: ${damage}`);
  }

  // Suggestions are collected apart from drift: they are not a claim going wrong,
  // and a board with nothing but suggestions is still a clean board.
  if (report.unrepresented.length > 0) suggested.push({ file, report });
  if (report.unannotated.length > 0) unannotated.push({ file, report });

  // A deleted arrow the code still supports is one-time news: the note lasts
  // until the deletion is committed, then the baseline agrees and it goes away.
  // It keeps the board on the list without ever touching the exit code.
  if (
    report.clean
    && report.promotions.length === 0
    && report.workItems.length === 0
    && (report.deletedEdges?.length ?? 0) === 0
    // A `@needs` nobody could answer keeps the board on the list, the same way a
    // deleted arrow does and for the same reason: it is news, and it never
    // touches the exit code. The claim is not failing -- it was never tried.
    && unansweredClaims(report) === 0
    /*
     * A plan's unreadable claims keep the board on the *long* list only. There
     * is no work item to keep it there when the arrow is planned and both its
     * boxes are built, and a board dropped here is one `--details` never
     * mentions -- which is the silence #129 is about. `worthANotice` below
     * deliberately does not repeat this test, so it stays out of the per-turn
     * notice: it is the expected state of a plan, not news about one.
     */
    && plannedClaims(report) === 0
  ) continue;

  stale.push({ file, report, promoted });
}

/*
 * A promotion opens the notice; a work item does not, but it is still listed by
 * anyone who asked for the long form.
 *
 * Both come from a `planned` box, and the difference is which side is behind. A
 * work item means the code has not caught up, which is the sketch doing its job
 * -- it would sit there unchanged for a whole design session, and a notice
 * repeating it every turn is one nobody reads. A promotion means the board is
 * now wrong: it says planned, the code says built. That is drift in the mild
 * direction, and it is one edit from going away.
 *
 * `--details` and /expand-report were asked for, so they show everything. That is
 * the difference between being quiet and withholding.
 */
const worthANotice = stale.filter(
  ({ report }) =>
    !report.clean
    || report.promotions.length > 0
    || (report.deletedEdges?.length ?? 0) > 0
    /*
     * Someone wrote `@needs` and got no answer. That is the one skip that has to
     * reach the per-turn notice rather than wait for `--details`, because
     * writing the claim *was* the question, and a quiet report in reply reads as
     * "checked, and fine" -- the exact conflation this whole check exists to
     * prevent. Work items stay out for the opposite reason: nobody asked.
     */
    || unansweredClaims(report) > 0
    /*
     * The one work item that does open a notice, and the paragraph above says
     * why the others do not: a sketch the code has not reached would sit there
     * unchanged for a whole design session. This one is not that. Something
     * landed between the last turn and this one and it runs against the plan,
     * which is news exactly once, at the moment it is cheapest to fix.
     */
    || builtBackwards(report).length > 0,
);
const showing = expanded ? stale : worthANotice;

/**
 * Code the diagram does not show.
 *
 * Its own box, not folded into the drift tally: "2 gone" is a claim going wrong,
 * while this is a suggestion about what might be worth drawing, and mixing them
 * would let a suggestion read as a defect. Ranked most-imported first by the
 * engine, so the module several boxes depend on sits at the top, with the
 * entry points that call into the board after them.
 */
function renderCoverage(entries, colour) {
  return box({
    sections: entries.map((entry) => ({
      label: path.basename(entry.file)
        + "  "
        + paint(entry.report.unrepresented.length + " not shown", "dim", colour),
      rows: entry.report.unrepresented.map((missing) => {
        // Which way the import runs. `<-` is a module the boxes lean on; `->`
        // is a surface that calls in and that nothing imports back, so no
        // amount of drawing would have made it show up in the first list.
        const inbound = missing.imports ?? null;
        const count = inbound ? inbound.length : missing.importedBy.length;
        const noun = count === 1 ? "box" : "boxes";
        const arrow = inbound ? "\u2192 " : "\u2190 ";
        return missing.file + "  " + paint(arrow + count + " " + noun, "dim", colour);
      }),
    })),
    foot: "suggestions, not drift \u00b7 add a box or ignore",
    max: 76,
  });
}

/**
 * Boxes that claim to be about this repo and do not say where.
 *
 * Separate from the coverage box above, which is the opposite direction: that
 * one is code with no box, this one is a box with no code. Both are
 * suggestions, and neither is drift.
 *
 * The point of naming them rather than counting them is that a count cannot be
 * acted on. `/annotate-diagram` reads this list and proposes an anchor per box.
 */
function renderUnannotated(entries, colour) {
  return box({
    sections: entries.map((entry) => ({
      label: path.basename(entry.file)
        + "  "
        + paint(entry.report.unannotated.length + " unanchored", "dim", colour),
      rows: entry.report.unannotated.map((item) => oneLine(item.label) + "  " + paint(item.node, "dim", colour)),
    })),
    foot: "/annotate-diagram proposes an anchor for each",
    max: 76,
  });
}

/** Skip reasons in words, since the engine's keys are for callers, not readers. */
const SKIP_WORDS = {
  "no-ref": "no ref",
  "ref-outside-repo": "ref points outside the repo",
  "ref-generated": "a label naming build output",
  "anchor-too-large": "a directory anchor too large to read",
  "no-route-literals": "a route anchor on a file that serves none",
  "ends-not-bound": "ends not snapped to their boxes",
  "endpoint-missing": "an end points at no box",
  "endpoint-external": "an end is marked external",
  "endpoint-has-no-ref": "an end has no ref",
  "endpoint-outside-repo": "an end points outside the repo",
  "endpoint-generated": "an end points into build output",
  "endpoint-file-missing": "an end's file is missing",
  "directory-ref": "an end refs a directory",
  "glob-ref": "an end refs a glob",
  "unlicensed-language": "no licence for that language",
  "outside-licence": "an end the reader cannot place",
  "no-function-body": "both ends name something with no body to read",
};

/*
 * Why an arrow the check read came back unconfirmed, in words.
 *
 * Kept apart from SKIP_WORDS above because it is the opposite situation: a skip
 * means nobody looked, and these mean somebody looked and found nothing.
 *
 * The table itself moved into the engine when `create_diagram` started saying
 * the same thing at draw time (#145). Two surfaces reading one table is the
 * point: this report and the tool result now cannot describe the same arrow in
 * two different vocabularies, which is the failure `summary.ts` was written to
 * end for the sentence above it.
 */

/** Why a `@declared` / `@used` claim was read as a plain mention instead. */
function assertionWords(assertions) {
  return [
    assertions.unsupportedLanguage ? `${assertions.unsupportedLanguage} no reader for that language` : "",
    assertions.downgraded ? `${assertions.downgraded} could not read the file cleanly` : "",
  ].filter(Boolean).join(" · ");
}

/** "14 not TypeScript or JavaScript · 6 an end is marked external", most first. */
function reasonWords(why, words) {
  return Object.entries(why)
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => `${count} ${words[reason] ?? reason}`)
    .join(" · ");
}

function skipWords(why) {
  return reasonWords(why, SKIP_WORDS);
}

/**
 * How many arrows to name before the list stops being read.
 *
 * Eight is enough for every board in this repo and short enough that the audit
 * box stays skimmable on a diagram with fifty arrows. The overflow says how many
 * it kept back: a list that quietly stopped at eight would be the same failure
 * as a count -- it would read as "that is all of them".
 */
const ARROW_CAP = 8;

/**
 * The arrows behind the count.
 *
 * The count and its reason were already here, and neither can be acted on: a
 * board saying "4 arrows skipped: an end is marked external" leaves a reader no
 * way to find out which four without opening the engine. Naming them is the same
 * move `unannotated` already made for boxes, for the same reason.
 *
 * They are named by their box labels rather than their refs, because that is
 * what a person recognises when they go and look at the board. The arrow's own
 * label is carried when it has one -- it is often the whole claim ("writes"),
 * and it is the part no check reads.
 *
 * Grouped by reason, and the reason is repeated per group only when the board
 * has more than one: with a single reason it is already on the line above, and
 * printing it twice is noise.
 *
 * Two lists come through here now — arrows nothing read, and arrows that were
 * read and not corroborated — because a reader wants the same thing of both:
 * which arrows, and why. The words differ, so the table is passed in.
 */
function arrowRows(arrowsIn, words, colour) {
  const byReason = new Map();
  for (const arrow of arrowsIn ?? []) {
    if (!byReason.has(arrow.reason)) byReason.set(arrow.reason, []);
    byReason.get(arrow.reason).push(arrow);
  }
  const rows = [];
  const grouped = byReason.size > 1;
  const indent = grouped ? "    " : "  ";
  for (const [reason, arrows] of byReason) {
    if (grouped) rows.push(paint(`  ${words[reason] ?? reason}`, "dim", colour));
    for (const arrow of arrows.slice(0, ARROW_CAP)) {
      const claim = arrow.label ? paint(`  ${oneLine(arrow.label)}`, "dim", colour) : "";
      rows.push(`${indent}${oneLine(arrow.fromLabel)} → ${oneLine(arrow.toLabel)}${claim}`);
    }
    const held = arrows.length - ARROW_CAP;
    if (held > 0) rows.push(paint(`${indent}+${held} more`, "dim", colour));
  }
  return rows;
}

/**
 * What was looked at, and what was not.
 *
 * Printed only for --details, and printed even when everything is clean. That is
 * the whole point: silence had two meanings -- "these agreed" and "there was
 * nothing here I could read" -- and no way to tell them apart. It stays off the
 * per-turn notice, which has to remain quiet to stay switched on.
 */
function renderCoverageAudit(entries, colour) {
  return box({
    sections: entries.map(({ file, report }) => {
      const rows = [];
      // No concept row: this box's header now carries those exact words, and
      // saying it twice in one frame is how two phrasings start drifting again.
      if (report.excused) rows.push(paint(`${report.excused} boxes outside this repo by declaration`, "dim", colour));
      if (report.handDrawn) rows.push(paint(`${report.handDrawn} hand-drawn boxes, never checked`, "dim", colour));
      if (report.skipped) rows.push(paint(`${report.skipped} boxes skipped: ${skipWords(report.skippedWhy)}`, "yellow", colour));
      if (report.edgesSkipped) {
        rows.push(paint(`${report.edgesSkipped} arrows skipped: ${skipWords(report.edgesSkippedWhy)}`, "yellow", colour));
        rows.push(...arrowRows(report.unreadEdges, SKIP_WORDS, colour));
      }
      /*
       * Read, and not corroborated. The line the amber arrows became (#133).
       *
       * Yellow like the skips and unlike a finding, because it belongs to the
       * same family: what this check could not establish. It is the answer to
       * "how much of this board is actually verified", which a clean verdict on
       * its own cannot give.
       */
      const unconfirmed = report.unconfirmedEdges ?? [];
      if (unconfirmed.length) {
        const why = {};
        for (const arrow of unconfirmed) why[arrow.reason] = (why[arrow.reason] ?? 0) + 1;
        rows.push(paint(
          `${unconfirmed.length} ${unconfirmed.length === 1 ? "arrow" : "arrows"} read and not `
          + `confirmed: ${reasonWords(why, UNCONFIRMED_WORDS)}`,
          "yellow",
          colour,
        ));
        rows.push(...arrowRows(unconfirmed, UNCONFIRMED_WORDS, colour));
      }
      if (report.strayArrows) {
        rows.push(paint(`${report.strayArrows} stray ${report.strayArrows === 1 ? "arrow" : "arrows"} (attached at one end or none)`, "dim", colour));
      }
      // A weakened assertion still passes the plain mention check, so without
      // this line an unjudged claim and a satisfied one look identical.
      const weak = report.assertions.downgraded + report.assertions.unsupportedLanguage;
      if (report.assertions.checked) {
        rows.push(paint(`${report.assertions.checked} declared/used claims checked`, "dim", colour));
      }
      if (weak) {
        rows.push(paint(`${weak} declared/used claims read as plain mentions: ${assertionWords(report.assertions)}`, "yellow", colour));
      }
      /*
       * What became of the claims, in the one view that exists to admit to gaps.
       *
       * A `needs` arrow can now be called wrong, which makes the difference
       * between "checked and fine" and "never checked" worth real money -- they
       * look identical in a clean report, and only one of them means the diagram
       * is being held to anything. So the withheld ones are named by reason.
       */
      /*
       * What became of the box claims.
       *
       * `closed` is the one claim whose *silence* costs something to earn: it is
       * about every file in the repository, so it holds only if every file was
       * read. A box nothing disproved and nothing could prove is neither red nor
       * green, and saying so is the only honest third thing.
       */
      const closed = report.claims?.closed ?? 0;
      if (closed > 0) {
        const held = report.claims?.closedHeld ?? 0;
        if (held > 0) {
          rows.push(paint(`${held} closed ${held === 1 ? "box" : "boxes"} held`, "dim", colour));
        }
        for (const gap of report.closedUnproven ?? []) {
          rows.push(paint(
            `${oneLine(gap.label)} · @closed: no breach found, `
            + (gap.capped
              ? "the repository is too large to walk"
              : `${gap.unread.length} ${gap.unread.length === 1 ? "file" : "files"} could not be read`),
            "dim",
            colour,
          ));
        }
        // Never silent. An exclusion you cannot see is one that rots, and this
        // is the number that says how much the test exemption is carrying.
        const reaches = report.claims?.closedTestReaches ?? 0;
        if (reaches > 0) {
          rows.push(paint(
            `${reaches} ${reaches === 1 ? "import" : "imports"} into a closed box from tests, which do not break the claim`,
            "dim",
            colour,
          ));
        }
        for (const stale of report.closedUnusedDoors ?? []) {
          rows.push(paint(
            `${oneLine(stale.label)} · ${stale.doors.length} listed `
            + `${stale.doors.length === 1 ? "door nothing" : "doors nothing"} came through: ${stale.doors.join(", ")}`,
            "dim",
            colour,
          ));
        }
      }
      /*
       * And the one claim a whole board makes.
       *
       * Same shape as `closed` above, for the same reason: held is worth saying
       * out loud because silence is what the claim buys, and a scope nothing
       * could read is neither held nor broken. The modules themselves are a
       * finding, so they are already in the list above this one -- what is left
       * here is what became of the claim.
       */
      const complete = report.claims?.complete ?? 0;
      if (complete > 0) {
        if ((report.claims?.completeHeld ?? 0) > 0) {
          rows.push(paint("board complete about its scope: nothing it reaches is undrawn", "dim", colour));
        }
        for (const gap of report.completeUnproven ?? []) {
          rows.push(paint(`@complete ${gap.about}: ${gap.detail}`, "dim", colour));
        }
      }
      const needs = report.claims?.needs ?? 0;
      const feeds = report.claims?.feeds ?? 0;
      if (needs > 0 || feeds > 0) {
        const checked = report.claims?.needsChecked ?? 0;
        if (checked > 0) {
          rows.push(paint(
            `${checked} needs ${checked === 1 ? "arrow" : "arrows"} checked for direction`,
            "dim",
            colour,
          ));
        }
        /*
         * `feeds` says confirmed rather than checked, because that is all it can
         * ever say: it finds the flow or it does not, and not finding one is not
         * a verdict about the arrow. The word difference is the whole difference
         * between the two claims, in the one place a reader meets both.
         */
        const flows = report.claims?.feedsConfirmed ?? 0;
        if (flows > 0) {
          rows.push(paint(
            `${flows} feeds ${flows === 1 ? "arrow" : "arrows"} confirmed by a flow`,
            "dim",
            colour,
          ));
        }
        // Looked at, and nothing found: the count, here only. It is not news
        // and it never opens a notice; a reader who asked for details gets it.
        const searched = withheldReasons(report.claims?.feedsWithheld)
          .filter(([why]) => !FEEDS_UNANSWERED.has(why));
        const searchedTotal = searched.reduce((sum, [, count]) => sum + count, 0);
        if (searchedTotal > 0) {
          rows.push(paint(
            `${searchedTotal} feeds ${searchedTotal === 1 ? "arrow" : "arrows"} not confirmed: `
            + searched.map(([why, count]) => `${count} ${FEEDS_NOT_CONFIRMED[why] ?? why}`).join(", "),
            "yellow",
            colour,
          ));
        }
        // The same sentences the notice prints, from the same function. Two
        // phrasings of one fact is two things to keep in sync, and the notice's
        // is the one a person sees every turn.
        for (const line of unansweredClaimLines(report)) rows.push(paint(line, "yellow", colour));
        const unsnapped = unsnappedClaimFix(report);
        if (unsnapped) rows.push(paint(unsnapped, "dim", colour));
        // The plan's share, in the view whose whole job is admitting to gaps.
        // Last of the claim rows and dim, because it is the one line here that
        // is not a gap in the checking -- it is the code not having arrived.
        const plannedLine = plannedClaimLine(report);
        if (plannedLine) rows.push(paint(plannedLine, "dim", colour));
      }
      if (rows.length === 0) rows.push(paint("everything on this board was checked", "dim", colour));
      return {
        // The same words the live board's chip uses, from the same function --
        // "refs" here and "boxes" there was one number with two names. The
        // verdict stays out of it: this box prints over a broken board too, and
        // the label form is the one that survives a filename eating the width.
        label: `${path.basename(file)}  ${paint(coverageLabel(report), "dim", colour)}`,
        rows,
      };
    }),
    foot: "silence means these agreed · not that everything was read",
    max: 76,
  });
}

// A box with no code, and code with no box: opposite directions, both
// suggestions, so they get their own boxes rather than one mixed tally.
const unanchoredLines =
  opts.coverage && unannotated.length > 0
    ? renderUnannotated(unannotated, Boolean(process.stderr.isTTY))
    : [];

const coverageLines =
  opts.coverage && suggested.length > 0
    ? renderCoverage(suggested, Boolean(process.stderr.isTTY))
    : [];

// --details is a question, so it always gets an answer -- including on a board
// with nothing wrong, which is the case the old output could not distinguish.
const auditLines =
  opts.details && examined.length > 0
    ? renderCoverageAudit(examined, Boolean(process.stderr.isTTY))
    : [];

/*
 * One line about the code graph, said once ever per checkout, only when it
 * would have mattered: this run left arrows the graph could have read.
 *
 * There are two things to say and they are not the same sentence, which is
 * where this went wrong before (#132). When the graph was built, the news is
 * that it happened and that nobody has to do it again. When graphify is
 * missing, the news is that some arrows cannot be checked here -- and the
 * command that would change that is a Python tool install, so it is named only
 * when this machine already has something to install it with. Sending a Rust
 * repo off to acquire a Python toolchain is not advice, and the old line did
 * worse: it named two `npm run` scripts out of this package.json, which the
 * reader's project does not have.
 *
 * The marker lives beside the expand/shrink mode in .diagramos/, which is
 * gitignored, so the choice to ignore it is one person's. Never a finding,
 * never an exit code.
 */
const HINT_FILE = path.join(root, ".diagramos", "code-graph-hint-shown");

/** The sentence, or nothing when there is no true one to say. */
function codeGraphNews() {
  // Built *and* read back: a graph the reader refused is not good news, and
  // announcing one would be the check congratulating itself.
  if (builtGraph && codeGraphOption) {
    return `built the code graph in ${builtGraph.seconds.toFixed(1)}s — arrows in any language `
      + "can be checked now, and it rebuilds itself when it falls behind";
  }
  // Somebody who opted out already knows.
  if (process.env.DIAGRAMOS_SKIP_GRAPHIFY) return undefined;
  // Not installed is the ordinary case, and the only one an install fixes. The
  // command is named only when this machine already has something to run it
  // with: a Rust repo does not necessarily want a Python toolchain, and telling
  // it to get one is not advice.
  if (!graphifyVersion()) {
    const installer = findInstaller();
    return installer
      ? "some arrows could not be checked — a deeper check exists, and needs graphify: "
        + `${installer.hint} (a Python tool; the check then builds and refreshes the graph itself)`
      : "some arrows cannot be checked in this project — the deeper check needs graphify, "
        + "a Python tool, and this machine has no uv or pipx to install it with";
  }
  // Installed, tried here, and still nothing usable: an extraction that failed
  // or ran past the timeout, a graphify release outside the tested range, a
  // graph the reader will not parse. Naming an install would be nonsense, and
  // the arrows really did go unread.
  if (attemptedGraph) {
    return "some arrows could not be checked — there is no code graph here the check "
      + "can use, so the deeper check stayed off";
  }
  // Installed, and a graph already on disk that the reader refused. Nothing was
  // attempted this run, and that is this project's business rather than the
  // reader's: silent, as it has always been.
  return undefined;
}

const hintLines = [];
/*
 * Worth saying only when the graph would have changed this run's answer: it
 * was just built, or arrows went unconfirmed that it could have read. The
 * sentence itself is worked out once -- it probes for graphify, so asking
 * twice would pay twice.
 *
 * Every reason here is one the graph can answer where the live channels
 * could not: an end standing for a directory or for a glob, a language no
 * licence covers, a file the reader cannot place, or no body to read.
 */
const worthSaying =
  !existsSync(HINT_FILE)
  && (builtGraph
    || (!codeGraphOption
      && examined.some(({ report }) =>
        /*
         * Every way the graph could have changed this run's answer. Arrows that
         * went unconfirmed are the biggest of them, and they used to be counted
         * here as `edges.length` -- absence was a finding then (#133). The skips
         * under it are the ones the graph reads and the live channels do not: a
         * directory or glob anchor, a language no licence names, an end the
         * reader cannot place, and two ends with no body between them.
         */
        (report.unconfirmedEdges ?? []).length > 0
        || (report.edgesSkippedWhy["directory-ref"] ?? 0) > 0
        || (report.edgesSkippedWhy["glob-ref"] ?? 0) > 0
        || (report.edgesSkippedWhy["unlicensed-language"] ?? 0) > 0
        || (report.edgesSkippedWhy["outside-licence"] ?? 0) > 0
        || (report.edgesSkippedWhy["no-function-body"] ?? 0) > 0)));
const graphNews = worthSaying ? codeGraphNews() : undefined;
if (graphNews) {
  hintLines.push(paint(graphNews, "dim", opts.hook || Boolean(process.stderr.isTTY)));
  try {
    mkdirSync(path.dirname(HINT_FILE), { recursive: true });
    writeFileSync(HINT_FILE, "shown\n");
  } catch {
    // A tree we cannot write to: the hint may repeat, nothing else changes.
  }
}

/*
 * The green line (#67): what improved on a board since its last commit — a box
 * added, a box or arrow flipped to built by anything other than this hook. The
 * hook's own promotions already have a line, so they are excluded above by
 * reading the board before they were applied, and recorded below so the next
 * run does not rediscover them.
 *
 * Said once. The comparison point is git, and boards go uncommitted for whole
 * sessions, so the same news would otherwise repeat every turn until a commit
 * -- and a notice that repeats good news thirty times an hour is a notice
 * somebody turns off. What has been announced is remembered per board in
 * .diagramos/, which is gitignored, beside the expand/shrink mode. A committed
 * board has no news, so its memory clears itself.
 */
const NEWS_SEEN_FILE = path.join(root, ".diagramos", "good-news-seen.json");
/**
 * What `--repair` rewrote, in a box of its own.
 *
 * Separate from the findings above rather than folded in, because these are the
 * opposite kind of line: everything else says the board and the code disagree,
 * and this says the disagreement is over and here is the edit that ended it.
 * Old ref and new on every row, because the only defence against a wrong rebind
 * is that somebody can see it and put it back.
 */
const repairedLines = repaired.length === 0
  ? []
  : box({
      sections: repaired.map(({ file, applied }) => ({
        label: `${path.basename(file)}  ${applied.length} repaired`,
        rows: applied.map((entry) =>
          paint(
            `${oneLine(entry.label)} \u00b7 ${entry.was} \u2192 ${entry.now}`,
            "green",
            opts.hook || Boolean(process.stderr.isTTY),
          ),
        ),
      })),
      foot: "refs rewritten from git \u00b7 check the diff before committing",
      max: 72,
    });

/**
 * The arrow `--accept` turned round, or the reason it would not.
 *
 * Its own box for the same reason `--repair` has one: everything else on the
 * report says the board and the code disagree, and this says somebody settled a
 * disagreement and here is the edit. The foot is the important line -- the diff
 * is the whole record that a design decision was made, so it has to be read
 * before it is committed.
 */
const acceptedLines = accepted.length === 0 && acceptHeld.length === 0
  ? []
  : box({
      sections: [
        ...accepted.map(({ file, applied }) => ({
          label: `${path.basename(file)}  arrow turned round`,
          rows: [
            paint(
              `${oneLine(applied.fromLabel)} \u2192 ${oneLine(applied.toLabel)}`
                + `  becomes  ${oneLine(applied.toLabel)} \u2192 ${oneLine(applied.fromLabel)}`,
              "green",
              Boolean(process.stderr.isTTY),
            ),
            `${applied.was.from} -> ${applied.was.to}  becomes  ${applied.now.from} -> ${applied.now.to}`,
          ],
        })),
        /*
         * The reason, and only the reason.
         *
         * It used to list the arrows that *are* backwards, which read as helpful
         * and was not: the report printing directly underneath already names
         * every one of them, and carries the command with the id to paste. Two
         * boxes saying the same thing is how a refusal starts looking like the
         * tool having said everything twice.
         */
        ...acceptHeld.map(({ file, held }) => ({
          label: `${path.basename(file)}  not accepted`,
          rows: [paint(held.detail, "red", Boolean(process.stderr.isTTY))],
        })),
      ],
      foot: accepted.length > 0
        ? "the diagram now says the dependency runs the other way \u00b7 read the diff before committing"
        : "nothing was changed",
      max: 78,
    });

const goodLines = [];
if (opts.hook) {
  let seen = {};
  try {
    seen = JSON.parse(readFileSync(NEWS_SEEN_FILE, "utf8"));
    if (!seen || typeof seen !== "object") seen = {};
  } catch {
    // First run, or a file we cannot read: everything current counts as news.
    seen = {};
  }
  const next = {};
  for (const { file, news } of improved) {
    const key = path.relative(root, file);
    const already = Array.isArray(seen[key]) ? seen[key] : [];
    const line = goodNewsLine(novelGoodNews(news, already));
    if (line) goodLines.push(paint(`${path.basename(file)} improved: ${line}`, "green", true));
    // Ids that stopped being news -- a box deleted again before the commit --
    // drop out here, so doing the same thing twice is announced twice.
    next[key] = goodNewsIds(news);
  }
  // A flip this hook applied is announced as "promoted" this run; remember it
  // so the next run, where the baseline still says planned, keeps quiet.
  for (const { file, promoted } of examined) {
    if (promoted.length === 0) continue;
    const key = path.relative(root, file);
    const ids = promoted.map((promotion) =>
      promotion.node.includes(" -> ")
        ? `>${promotion.node.split(" -> ").join("→")}`
        : `=${promotion.node}`,
    );
    next[key] = [...new Set([...(next[key] ?? []), ...ids])];
  }
  try {
    mkdirSync(path.dirname(NEWS_SEEN_FILE), { recursive: true });
    writeFileSync(NEWS_SEEN_FILE, `${JSON.stringify(next)}\n`);
  } catch {
    // A tree we cannot write to: the news may repeat, nothing else changes.
  }
}

if (showing.length > 0 || problems.length > 0 || coverageLines.length > 0
  || unanchoredLines.length > 0 || auditLines.length > 0 || hintLines.length > 0
  || goodLines.length > 0 || repairedLines.length > 0 || acceptedLines.length > 0) {
  // Measured: ANSI renders in a systemMessage. Off only when the output is being
  // piped or captured, where escapes would be junk in somebody's log.
  const colour = opts.hook || Boolean(process.stderr.isTTY);
  const lines = [
    // First: it is the one group here that reports a change already made to the
    // working tree, and it has to be read before the findings that survived it.
    ...acceptedLines,
    ...repairedLines,
    ...auditLines,
    ...unanchoredLines,
    ...coverageLines,
    ...problems,
    ...(showing.length === 0
      ? []
      : expanded
        ? renderDetails(
            showing,
            colour,
            // Never a mode you cannot find your way out of: while it is on, the
            // notice says how to turn it off.
            isExpanded()
              ? "/update-diagram updates it · /shrink-report makes this short again"
              : "/update-diagram updates the diagram",
          )
        : render(showing, colour)),
    ...goodLines,
    ...hintLines,
  ];

  if (opts.hook) {
    process.stdout.write(
      `${JSON.stringify({ continue: true, suppressOutput: false, systemMessage: `\n${lines.join("\n")}` })}\n`,
    );
    // Zero on purpose: the notice has been delivered, and a non-zero exit here is
    // what produced the "Stop hook error: Failed" framing in the first place.
    process.exit(0);
  }

  console.error(lines.join("\n"));
  /*
   * A refused `--accept` answers the command rather than the repository.
   *
   * 2, like every other way of asking for the wrong arrow -- an id nothing is
   * drawn as, an id on two boards, the flag with no value. Those exit before a
   * board is read; this one cannot, because whether the arrow is accused is a
   * question only the check can answer. Falling through to the report's own code
   * meant a refusal on an otherwise clean board exited 0, so a script could not
   * tell "turned it round" from "would not".
   */
  if (acceptHeld.length > 0 && accepted.length === 0) process.exit(2);
  // Non-zero only for something that has actually regressed. A promotion or an
  // unbuilt sketch must not fail a build: CI reads this exit code, and a diagram
  // describing next week's work is not a broken repository.
  process.exit(stale.some(({ report }) => !report.clean) || problems.length > 0 ? 1 : 0);
} else if (!opts.hook && examined.length > 0) {
  /*
   * One line, for a person who typed the command and got nothing back.
   *
   * The hook stays silent, and that is not an inconsistency: it fires unbidden
   * every turn, where announcing good news is how a check gets switched off. A
   * command someone chose to run is the opposite situation -- silence there is
   * indistinguishable from a broken install, which is exactly how it was read.
   * Same distinction --details already draws: a question deserves an answer.
   *
   * It names what went unread rather than implying everything was verified.
   * "Clean" and "read" were the same output once, and separating them is the
   * whole point of the coverage work; a summary line that forgot that would put
   * the confusion back in a shorter form.
   */
  const total = (pick) => examined.reduce((n, { report }) => n + pick(report), 0);
  const refs = total((r) => r.checked);
  const arrows = total((r) => r.edgesChecked);
  const unread = total((r) => r.skipped + r.edgesSkipped);
  const planned = total((r) => r.workItems.length);
  /*
   * Read and not corroborated, said out loud next to "nothing drifted".
   *
   * "30 arrows checked · nothing drifted" was true and heard as "30 arrows
   * verified", and on a board over a language full of data types most of those
   * arrows can be read without being confirmed (#133). Unconfirmed and unread
   * are two different silences and they share the tail, because the reader's
   * next move for both is the same flag.
   */
  const unconfirmed = total((r) => (r.unconfirmedEdges ?? []).length);
  const quiet = [
    unconfirmed ? `${unconfirmed} unconfirmed` : "",
    unread ? `${unread} unread` : "",
  ].filter(Boolean).join(", ");
  console.error(
    [
      `${examined.length} board${examined.length === 1 ? "" : "s"}`,
      // Totalled across boards, so no single board's concept flag applies --
      // but the nouns and the plurals are the shared ones.
      `${countedWords({ checked: refs, edgesChecked: arrows })} checked`,
      "nothing drifted",
      // Deliberately not a notice of its own: a work item is the sketch being
      // ahead on purpose, and it belongs in a tally rather than in an alarm.
      ...(planned ? [`${planned} planned`] : []),
      ...(quiet ? [`${quiet}, --details says why`] : []),
    ].join(" · "),
  );
}
