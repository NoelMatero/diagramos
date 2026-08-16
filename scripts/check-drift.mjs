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
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { box, fit, pad } from "./lib/box.mjs";
import { readBoard } from "../src/engine/board-file.ts";
import { CONFIG_FILE, ConfigError, DEFAULT_DIAGRAM_DIR, diagramDir } from "../src/engine/config.ts";
import {
  checkDrift,
  createGitBaseline,
  createWorkspace,
  findBoards,
  findStrayBoards,
  parseRef,
} from "../src/engine/drift.ts";

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
  };
  const boards = [];

  for (const arg of argv) {
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
  return (finding.label || finding.node).replace(/\s+/g, " ");
}

/**
 * Why a finding is a finding, spelled out.
 *
 * Deliberately absent from the notice, which fires every turn and would otherwise
 * repeat it — and present here, where somebody has asked.
 */
const REASONS = {
  "missing-file": "that file is not in the repo any more",
  "missing-symbol": "the file is there, that name in it is not",
  "unresolvable-ref": "that is not a path in this repo at all",
  "empty-ref": "it exists but has nothing in it",
  "missing-declaration": "the name is in the file, but nothing there declares it",
  "unused-symbol": "it is declared, and nothing outside its own declaration uses it",
};
const EDGE_REASON = "nothing in the code connects them: no import either way, "
  + "no third file importing both, no shared route string";

/** What a stale box points at. */
function target(finding) {
  const { path: file, symbol } = parseRef(finding.ref);
  if (finding.kind === "missing-symbol") return `${symbol} in ${file}`;
  if (finding.kind === "missing-declaration" || finding.kind === "unused-symbol") {
    return `${symbol} in ${file}`;
  }
  if (finding.kind === "unresolvable-ref") return finding.ref;
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

/** Rows of findings. Low on purpose: this fires at the end of every turn. */
const MAX_LISTED = 6;

/**
 * One finding per row: what the box says, and what it points at.
 *
 * Work items are listed only when `all` is set, which the long form does and the
 * notice does not. A planned box the code has not reached is not a disagreement
 * with anything -- it is the sketch being ahead on purpose, and it would sit
 * there unchanged for the whole of a design session.
 */
function rowsFor({ report }, colour, all = false) {
  return [
    ...report.deleted.map((finding) =>
      paint(`${boxName(finding)} removed, ${parseRef(finding.ref).path} still there`, "red", colour),
    ),
    ...report.findings.map((finding) => paint(`${boxName(finding)} \u2192 ${target(finding)}`, "red", colour)),
    ...report.edges.map((finding) =>
      paint(
        `${boxName({ label: finding.fromLabel, node: finding.from })}`
        + ` \u2192 ${boxName({ label: finding.toLabel, node: finding.to })}`,
        "yellow",
        colour,
      ),
    ),
    // Good news, and the only row here that says the diagram is behind the code
    // rather than the other way round.
    ...report.promotions.map((promotion) =>
      paint(`${boxName(promotion)} is built now`, "green", colour),
    ),
    ...(all
      ? report.workItems.map((item) => paint(`${boxName(item)} not built yet`, "dim", colour))
      : []),
  ];
}

/** "2 gone  1 arrow  1 built", each part coloured, empty parts dropped. */
function tallyCounts(gone, empty, unused, removed, arrows, built, planned, colour) {
  return [
    gone ? paint(`${gone} gone`, "red", colour) : "",
    empty ? paint(`${empty} empty`, "red", colour) : "",
    // Separate from "gone" because it is a different sentence: the code is
    // still there, and nothing calls it any more.
    unused ? paint(`${unused} unused`, "red", colour) : "",
    removed ? paint(`${removed} removed`, "red", colour) : "",
    arrows ? paint(`${arrows} ${arrows === 1 ? "arrow" : "arrows"}`, "yellow", colour) : "",
    built ? paint(`${built} built`, "green", colour) : "",
    planned ? paint(`${planned} planned`, "dim", colour) : "",
  ].filter(Boolean).join("  ");
}

function tallyFor(report, colour) {
  const count = (kind) => report.findings.filter((finding) => finding.kind === kind).length;
  const empty = count("empty-ref");
  const unused = count("unused-symbol");
  return tallyCounts(
    report.findings.length - empty - unused,
    empty,
    unused,
    report.deleted.length,
    report.edges.length,
    report.promotions.length,
    report.workItems.length,
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
      label: `${path.basename(entry.file)}  ${tallyFor(entry.report, colour)}`,
      rows: rowsFor(entry, colour, true),
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
    (sum, { report }) => ({
      gone: sum.gone + report.findings.filter(
        (finding) => finding.kind !== "empty-ref" && finding.kind !== "unused-symbol",
      ).length,
      empty: sum.empty + report.findings.filter((finding) => finding.kind === "empty-ref").length,
      unused: sum.unused + report.findings.filter((finding) => finding.kind === "unused-symbol").length,
      removed: sum.removed + report.deleted.length,
      arrows: sum.arrows + report.edges.length,
      built: sum.built + report.promotions.length,
      planned: sum.planned + report.workItems.length,
    }),
    { gone: 0, empty: 0, unused: 0, removed: 0, arrows: 0, built: 0, planned: 0 },
  );

  // Too many to list: counts per diagram, and a pointer to the view that has room.
  const head = single
    ? `${path.basename(stale[0].file)}  ${tallyCounts(totals.gone, totals.empty, totals.unused, totals.removed, totals.arrows, totals.built, totals.planned, colour)}`
    : `${stale.length} diagrams out of date  ${tallyCounts(totals.gone, totals.empty, totals.unused, totals.removed, totals.arrows, totals.built, totals.planned, colour)}`;

  const rows = [];
  let hidden = 0;
  if (single) {
    rows.push(...found[0].rows.slice(0, MAX_LISTED));
    hidden = found[0].rows.length - MAX_LISTED;
  } else {
    const widest = Math.min(28, Math.max(...stale.map(({ file }) => path.basename(file).length)));
    for (const { entry } of found.slice(0, MAX_LISTED)) {
      rows.push(`${pad(fit(path.basename(entry.file), widest), widest)}  ${tallyFor(entry.report, colour)}`);
    }
    hidden = Math.max(0, stale.length - MAX_LISTED);
  }
  if (hidden > 0) {
    rows.push(paint(`\u2026 and ${hidden} more${single ? "" : " diagrams"}`, "dim", colour));
  }

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
if (opts.expand) setExpanded(true);
if (opts.shrink) setExpanded(false);
// --details is a one-off; the mode file is what the next hook run reads.
const expanded = opts.details || opts.expand || (!opts.shrink && isExpanded());
const workspace = createWorkspace(root);
const stale = [];
const examined = [];
const suggested = [];
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

for (const file of checking) {
  let report;
  try {
    report = checkDrift(await readBoard(file), workspace, {
      edges: opts.edges,
      coverage: opts.coverage,
      // Per board, so the cheap "unmodified" answer short-circuits each one.
      ...(opts.deletions ? { baseline: createGitBaseline(root, file) } : {}),
    });
  } catch (error) {
    // An unreadable board is a problem, but not drift. Say so and keep going
    // rather than failing a commit over a file that may not be a board at all.
    problems.push(`${path.relative(root, file)}: could not read (${error.message})`);
    continue;
  }
  examined.push({ file, report });

  // Suggestions are collected apart from drift: they are not a claim going wrong,
  // and a board with nothing but suggestions is still a clean board.
  if (report.unrepresented.length > 0) suggested.push({ file, report });

  if (report.clean && report.promotions.length === 0 && report.workItems.length === 0) continue;

  stale.push({ file, report });
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
  ({ report }) => !report.clean || report.promotions.length > 0,
);
const showing = expanded ? stale : worthANotice;

/**
 * Code the diagram does not show.
 *
 * Its own box, not folded into the drift tally: "2 gone" is a claim going wrong,
 * while this is a suggestion about what might be worth drawing, and mixing them
 * would let a suggestion read as a defect. Ranked most-imported first by the
 * engine, so the module several boxes depend on sits at the top.
 */
function renderCoverage(entries, colour) {
  return box({
    sections: entries.map((entry) => ({
      label: path.basename(entry.file)
        + "  "
        + paint(entry.report.unrepresented.length + " not shown", "dim", colour),
      rows: entry.report.unrepresented.map((missing) => {
        const count = missing.importedBy.length;
        const noun = count === 1 ? "box" : "boxes";
        return missing.file + "  " + paint("\u2190 " + count + " " + noun, "dim", colour);
      }),
    })),
    foot: "suggestions, not drift \u00b7 add a box or ignore",
    max: 76,
  });
}

/** Skip reasons in words, since the engine's keys are for callers, not readers. */
const SKIP_WORDS = {
  "no-ref": "no ref",
  "ref-outside-repo": "ref points outside the repo",
  "ends-not-bound": "ends not snapped to their boxes",
  "endpoint-missing": "an end points at no box",
  "endpoint-external": "an end is marked external",
  "endpoint-has-no-ref": "an end has no ref",
  "endpoint-outside-repo": "an end points outside the repo",
  "endpoint-file-missing": "an end's file is missing",
  "directory-ref": "an end refs a directory",
  "not-ts-or-js": "not TypeScript or JavaScript",
};

/** Why a `@declared` / `@used` claim was read as a plain mention instead. */
function assertionWords(assertions) {
  return [
    assertions.unsupportedLanguage ? `${assertions.unsupportedLanguage} no reader for that language` : "",
    assertions.downgraded ? `${assertions.downgraded} could not read the file cleanly` : "",
  ].filter(Boolean).join(" · ");
}

function skipWords(why) {
  return Object.entries(why)
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => `${count} ${SKIP_WORDS[reason] ?? reason}`)
    .join(" · ");
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
      if (report.concept) rows.push(paint("concept board · not about this repo", "dim", colour));
      if (report.excused) rows.push(paint(`${report.excused} boxes outside this repo by declaration`, "dim", colour));
      if (report.handDrawn) rows.push(paint(`${report.handDrawn} hand-drawn boxes, never checked`, "dim", colour));
      if (report.skipped) rows.push(paint(`${report.skipped} boxes skipped: ${skipWords(report.skippedWhy)}`, "yellow", colour));
      if (report.edgesSkipped) rows.push(paint(`${report.edgesSkipped} arrows skipped: ${skipWords(report.edgesSkippedWhy)}`, "yellow", colour));
      // A weakened assertion still passes the plain mention check, so without
      // this line an unjudged claim and a satisfied one look identical.
      const weak = report.assertions.downgraded + report.assertions.unsupportedLanguage;
      if (report.assertions.checked) {
        rows.push(paint(`${report.assertions.checked} declared/used claims checked`, "dim", colour));
      }
      if (weak) {
        rows.push(paint(`${weak} declared/used claims read as plain mentions: ${assertionWords(report.assertions)}`, "yellow", colour));
      }
      if (rows.length === 0) rows.push(paint("everything on this board was checked", "dim", colour));
      return {
        label: `${path.basename(file)}  ${paint(`${report.checked} refs · ${report.edgesChecked} arrows checked`, "dim", colour)}`,
        rows,
      };
    }),
    foot: "silence means these agreed · not that everything was read",
    max: 76,
  });
}

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

if (showing.length > 0 || problems.length > 0 || coverageLines.length > 0 || auditLines.length > 0) {
  // Measured: ANSI renders in a systemMessage. Off only when the output is being
  // piped or captured, where escapes would be junk in somebody's log.
  const colour = opts.hook || Boolean(process.stderr.isTTY);
  const lines = [
    ...auditLines,
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
  // Non-zero only for something that has actually regressed. A promotion or an
  // unbuilt sketch must not fail a build: CI reads this exit code, and a diagram
  // describing next week's work is not a broken repository.
  process.exit(stale.some(({ report }) => !report.clean) || problems.length > 0 ? 1 : 0);
}
