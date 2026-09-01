/**
 * The shape of a board, worked out before a box is drawn.
 *
 * ## Why this exists
 *
 * A session asked to diagram a codebase has to decide four things, and #186
 * measured that nothing tells it any of them: how many boxes, what a box stands
 * for, whether this is one board or four, and when the board is finished. So it
 * guesses, draws, finds out, and draws again -- #183 priced one instance of that
 * at $1.94 for two diagrams.
 *
 * The reason it guesses is not a missing paragraph. Every fact needed to answer
 * those four questions is already in this engine, and every one of them is only
 * reachable *after* a board exists: `viewable.ts` sizes a board once it has a
 * graph, `boardCoverage` names what a board omits once it has boxes, `gaps.ts`
 * answers what it leaves out once it has refs. The only way to learn the shape
 * of a board was to draw one. That is the loop, and it is structural.
 *
 * This module asks the same questions of a *directory* instead of a board.
 *
 * ## How the grain is chosen
 *
 * Not by a convention. The candidate grains are laid out and measured, and the
 * board keeps whatever detail the picture can hold:
 *
 * 1. Start at the scope's immediate children -- subdirectories as boxes, loose
 *    files as boxes.
 * 2. While that does not fit, drop the least-connected boxes. A board keeps the
 *    modules carrying the traffic, and the dropped ones are reported.
 * 3. While it does fit, expand the box hiding the most files into its own
 *    children, keeping every expansion the layout still measures legible.
 *
 * Each step is one `planDiagramLayout` -- milliseconds, deterministic, and no
 * image. Measured over 42 files in `src/engine` that is nine layouts and 0.7s.
 *
 * Two answers fall out of the same walk rather than needing rules of their own.
 * A box the picture could not afford to open is **the next board** -- which is
 * the split criterion #186 says does not exist. And a file no box covers is the
 * board's remainder, stated rather than left for `coverage: true` to find later.
 *
 * ## What it will not do
 *
 * **It does not name anything.** Every box comes back labelled with its
 * filename, and a board of filenames is a dependency graph rather than an
 * architecture diagram: this repo's own best boards say "ELK layout / real font
 * metrics" where a survey says "layout". Reading the label out of each module's
 * own opening comment was tried and measured: available for 76% of files here
 * and in serde_json, and for 3-13% in vue, nest, vite and ripgrep, with false
 * positives (`istanbul ignore file`, `!/usr/bin/env node`) among the hits. It
 * does not generalise, so it is not done. Naming is the model's half of the
 * work, and it is the half worth paying for -- the same trade as "supply
 * meaning, never geometry", one level up.
 *
 * **It only knows about dependencies.** Every arrow here is an import, read out
 * of source by `deps.ts`, so a survey draws the structural board. A flow board
 * -- how a request becomes a picture -- is a call path, and the whole-repo call
 * graph is measurably too holey to derive one: `createDiagram -> viewable` and
 * `checkDrift -> body` are both real and neither is in it. So flows are not
 * offered rather than offered wrongly.
 *
 * **It is silent in a language it cannot read.** `deps.ts` reads TypeScript,
 * TSX, JavaScript and Rust. Python is 82 files and 0 edges in graphify, and the
 * survey refuses the scope instead of drafting a board of unconnected boxes. A
 * draft nothing corroborated would be exactly the false confidence the rest of
 * this engine is built to avoid.
 */
import { dirname } from "node:path";

import { readDependencies } from "./deps";
import { languageOf } from "./parse";
import { planBounds, planDiagramLayout } from "./layout";
import type { LayoutDirection } from "./graph";
import { viewability, type Viewability } from "./viewable";
import type { Workspace } from "./workspace";

/**
 * Directories a survey never walks into.
 *
 * `target`, `dist`, `out`, `build` and `node_modules` are the same list refs are
 * refused for, and for the same reason: a box anchored in build output goes
 * green and stays green while its source is renamed away. The test directories
 * are excluded because a board of a subsystem is not a board of its suite --
 * tests reach into everything, so drawing them makes every box look connected
 * to every other one.
 */
const NEVER_WALK = new Set([
  "node_modules", "target", "dist", "out", "build", "vendor", "__pycache__",
  "tests", "test", "benches", "examples", "fixtures",
]);

/** Files whose names say they are tests, in the conventions of every language read here. */
const TEST_FILE = /(\.|_)(test|spec)\.[^.]+$|^test_|_test\.[^.]+$/;

/**
 * A line that a person checking the claim would recognise as declaring one.
 *
 * This does not decide whether a dependency is real -- `deps.ts` already did
 * that, and it is right about more than this matches. It decides which line to
 * *quote*, and that is a separate question, because an arrow's evidence is read
 * by somebody deciding whether to believe the tool.
 *
 * Rust is the reason it exists. A crate can be depended on through a
 * fully-qualified path with no `use` anywhere -- `StyledStr(crate::builder::StyledStr)`,
 * `dfa: &crate::dfa::dense::DFA<..>` -- and `deps-rust.ts` correctly reports
 * those. Quoting one next to `claim: "needs"` shows a reader a line that looks
 * nothing like the import the claim says it is, and an arrow whose evidence looks
 * invented is worse than an arrow with no claim. Measured over eight scopes: 227
 * of 268 quoted lines already read as a declaration, and preferring one where the
 * arrow has a choice takes it to 268 of 268.
 */
const DECLARATION_LINE =
  /(?:^|[\s{,])(?:import\b|from\s*['"`]|require\s*\(|use\b|extern\s+crate\b|mod\b|pub\s+use\b)|^\s*[}\])]\s*from\b/;

/** One in-scope dependency of one file, as the scan read it. */
export interface ScopeDependency {
  /** Repo-relative file depended on. */
  to: string;
  /** 1-based line of the declaration. */
  line: number;
  /** Whether that line is one a reader would recognise as declaring a dependency. */
  declaration: boolean;
}

/** A box the survey is proposing: one directory, or one file. */
export interface SurveyUnit {
  id: string;
  /** The filename or directory name. Meaning is the caller's to supply. */
  label: string;
  /** Set when this box stands for a directory rather than a single file. */
  dir?: string;
  /** Every source file this box covers, which is what its arrows are derived from. */
  files: string[];
}

/** An arrow the survey is proposing, with the line the dependency was read from. */
export interface SurveyEdge {
  from: string;
  to: string;
  /**
   * `needs` when the line quoted in `seen` is one a reader would recognise as
   * declaring a dependency -- an import, a require, a `use`, an include. Then the
   * claim is a transcription rather than a hypothesis, which is the only
   * condition under which SKILL.md permits writing one.
   *
   * **Absent otherwise**, and 12 arrows in 406 across the corpus come back that
   * way. All twelve are Rust, where a crate can be depended on entirely through
   * fully-qualified paths (`dfa: &crate::dfa::dense::DFA<..>`) with no `use`
   * anywhere. `deps.ts` is right that the dependency is real, and the `needs`
   * check would confirm it -- so claiming it would not go red. It is left off
   * anyway, for the reason the vocabulary exists: the evidence a reader would be
   * shown looks nothing like the import the claim names, and an arrow whose
   * evidence looks invented costs more trust than an unclaimed arrow costs
   * information. An arrow with no claim is the normal case, not a shortfall.
   */
  claim?: "needs";
  /** `path:line` the dependency was read from, so it can be checked by hand. */
  seen: string;
  /**
   * How many file-to-file dependencies this one arrow stands for.
   *
   * One on a file-to-file arrow, and up to dozens when both ends are
   * directories. It is what thinning ranks by: an arrow standing for thirty
   * imports is the structure, and one standing for a single import is a detail.
   */
  weight: number;
}

export interface SurveyResult {
  scope: string;
  /** The boxes to draw, already anchored at a path that exists. */
  units: SurveyUnit[];
  /** The arrows to draw, already claimed and already evidenced. */
  edges: SurveyEdge[];
  /** How the board this implies will render, from the same measure `create_diagram` uses. */
  view: Viewability;
  /**
   * The flow the grain was measured in. Not an instruction: `create_diagram`
   * chooses the drawn flow itself, from the real labels.
   */
  direction: LayoutDirection;
  /**
   * Boxes the picture could not afford to open, in the order it declined them.
   * Each is a directory, and each is the scope of the next board.
   */
  next: string[];
  /** Source files no proposed box covers. The board's honest remainder. */
  omitted: string[];
  /**
   * Real dependencies between two boxes on this board that the picture does not
   * draw, because drawing every one of them makes a hairball. The other half of
   * the board's remainder, and stated for the same reason.
   */
  arrowsOmitted: number;
  /** Files read, and files the reader had no grammar for, by language. */
  read: number;
  unread: Record<string, number>;
  /** Layouts spent choosing the grain. Reported because it is the only cost here. */
  layouts: number;
  /**
   * Set when no grain fits. `units` is then the best that was reached and must
   * not be drawn as it stands -- almost always because the language has no
   * measured reader, so there were no arrows to lay out in the first place.
   */
  refused?: string;
}

/**
 * Order two ids the same way on every machine.
 *
 * `localeCompare` was here and is not wrong today -- `identifier` strips ids to
 * ASCII lowercase, and eight locales order those identically. But it reads the
 * host's ICU tables, so the guarantee rests on the ids never changing shape and
 * on Node being built with full ICU. Neither is worth depending on for a
 * tie-break: a plain comparison is the same answer everywhere, for free.
 */
const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const identifier = (text: string) =>
  text.replace(/[^a-z0-9]/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "box";

const stem = (path: string) => path.split("/").pop()!.replace(/\.[^.]+$/, "");

/**
 * Every source file under a scope, with what each one depends on.
 *
 * One pass of `deps.ts` over the whole scope, which is the entire cost of
 * knowing the structure: 45 files in `src/engine` come back with 114 import
 * edges and nothing unread. In-repo dependencies pointing outside the scope are
 * dropped, because a board of a scope cannot draw an arrow to a box it does not
 * have.
 */
export function scanScope(
  scope: string,
  workspace: Workspace,
): {
  files: string[];
  deps: Map<string, ScopeDependency[]>;
  read: number;
  unread: Record<string, number>;
} {
  const files: string[] = [];
  /*
   * Walked through the workspace rather than through `fs`, which is the rule the
   * rest of this engine keeps: every path a check touches resolves inside the
   * root, symlinks re-checked, and `list` is one level so a walk can never
   * become a search. It also means a survey can be tested against a tree that
   * does not exist on disk.
   */
  const walk = (dir: string) => {
    const absolute = workspace.resolve(dir);
    if (!absolute || workspace.stat(absolute) !== "directory") return;
    for (const entry of workspace.list(absolute)) {
      if (entry.startsWith(".") || NEVER_WALK.has(entry)) continue;
      const child = dir === "." ? entry : `${dir}/${entry}`;
      const childAbsolute = workspace.resolve(child);
      if (!childAbsolute) continue;
      const kind = workspace.stat(childAbsolute);
      if (kind === "directory") walk(child);
      else if (kind === "file" && languageOf(child) && !TEST_FILE.test(entry)) files.push(child);
    }
  };
  walk(scope);
  files.sort();

  const inScope = new Set(files);
  const deps = new Map<string, ScopeDependency[]>();
  const unread: Record<string, number> = {};
  let read = 0;
  for (const file of files) {
    const absolute = workspace.resolve(file);
    const source = absolute && workspace.stat(absolute) === "file" ? workspace.read(absolute) : undefined;
    const declared = source === undefined ? undefined : readDependencies(file, source, workspace);
    if (!declared) {
      const language = languageOf(file) ?? "unknown";
      unread[language] = (unread[language] ?? 0) + 1;
      continue;
    }
    read++;
    // The source is in hand here and nowhere later, so whether a line reads as a
    // declaration is settled now rather than by re-reading the file to quote it.
    const lines = source!.split("\n");
    deps.set(
      file,
      declared.dependencies
        .filter((dependency) => dependency.file && inScope.has(dependency.file) && dependency.file !== file)
        .map((dependency) => ({
          to: dependency.file!,
          line: dependency.line,
          declaration: DECLARATION_LINE.test(lines[dependency.line - 1] ?? ""),
        })),
    );
  }
  return { files, deps, read, unread };
}

/**
 * The immediate children of a directory, as boxes.
 *
 * A subdirectory becomes one box covering everything beneath it; a file sitting
 * directly in the directory becomes a box of its own. That mixture is the point:
 * it is what lets the refinement below answer "what does a box stand for"
 * per box rather than once for the whole board.
 */
function childrenOf(dir: string, files: string[]): SurveyUnit[] {
  const dirs = new Map<string, string[]>();
  const loose: string[] = [];
  const prefix = dir === "." ? "" : `${dir}/`;
  for (const file of files) {
    if (!file.startsWith(prefix)) continue;
    const rest = file.slice(prefix.length);
    const cut = rest.indexOf("/");
    if (cut < 0) loose.push(file);
    else {
      const key = `${prefix}${rest.slice(0, cut)}`;
      const bucket = dirs.get(key);
      if (bucket) bucket.push(file);
      else dirs.set(key, [file]);
    }
  }
  return [
    ...[...dirs].map(([path, covered]) => ({
      id: identifier(stem(path)),
      label: stem(path),
      dir: path,
      files: covered,
    })),
    ...loose.map((file) => ({ id: identifier(stem(file)), label: stem(file), files: [file] })),
  ];
}

/**
 * Ids have to be unique and basenames are not.
 *
 * `mod.rs`, `index.ts` and `__init__.py` appear once per directory, so a board
 * of children two levels down collides immediately -- and `create_diagram`
 * refuses a duplicate id outright rather than quietly merging two boxes. The
 * parent directory disambiguates both the id and the label, which is also what a
 * reader needs: `parser/mod` says something `mod` does not.
 */
function withUniqueIds(units: SurveyUnit[]): SurveyUnit[] {
  const used = new Set<string>();
  return units.map((unit) => {
    if (!used.has(unit.id)) {
      used.add(unit.id);
      return unit;
    }
    const parent = stem(dirname(unit.dir ?? unit.files[0]));
    let id = identifier(`${parent}-${unit.id}`);
    let n = 2;
    while (used.has(id)) id = `${unit.id}-${n++}`;
    used.add(id);
    return { ...unit, id, label: `${parent}/${unit.label}` };
  });
}

/**
 * The arrows a grouping implies, each with the line it was read from.
 *
 * Several files in one box may depend on several in another; that is one arrow,
 * and the first declaration found is the one quoted. Dependencies inside a box
 * disappear, which is the honest consequence of grouping -- a box standing for a
 * directory is claiming its internals are not the subject.
 */
export function edgesFor(
  units: SurveyUnit[],
  deps: Map<string, ScopeDependency[]>,
): SurveyEdge[] {
  const owner = new Map<string, string>();
  for (const unit of units) for (const file of unit.files) owner.set(file, unit.id);
  const found = new Map<string, { edge: SurveyEdge; declaration: boolean }>();
  for (const unit of units) {
    for (const file of unit.files) {
      for (const dependency of deps.get(file) ?? []) {
        const to = owner.get(dependency.to);
        if (!to || to === unit.id) continue;
        const key = `${unit.id} ${to}`;
        const already = found.get(key);
        const weight = (already?.edge.weight ?? 0) + 1;
        // Several files in one box may depend on several in another, and any of
        // them justifies the arrow. Where there is a choice, quote the line a
        // reader would recognise -- the first one found is otherwise arbitrary.
        if (already && (already.declaration || !dependency.declaration)) {
          already.edge.weight = weight;
          continue;
        }
        found.set(key, {
          edge: {
            from: unit.id,
            to,
            ...(dependency.declaration ? { claim: "needs" as const } : {}),
            seen: `${file}:${dependency.line}`,
            weight,
          },
          declaration: dependency.declaration,
        });
      }
    }
  }
  return [...found.values()].map((entry) => entry.edge);
}

/**
 * The label size a survey measures against, which is not the filename.
 *
 * This is the one place a survey could lie and did. The grain is chosen by
 * laying candidate boards out, and the labels available at that point are
 * filenames -- `layout`, `deps`, `graph`. But the survey's own next instruction
 * is to *replace* them, and a real label is much bigger: measured over the 209
 * labels on this repository's own boards, the widest line is a median of 18
 * characters and 71% of labels run to more than one line, median 2. A filename
 * stem in `src/engine` is a median of 6 characters on one line.
 *
 * So a board measured on filenames is measured at roughly a third of the width
 * and half the height it will have once it is named, and the failure is not
 * theoretical: 19 boxes of `src/engine` measured `legible` at 9 characters a
 * label and came back `cramped` at 4328px once the labels said what the boxes
 * did. That is the survey breaking its own promise on the step it asks for.
 *
 * Measuring against the allowance instead costs boxes -- honestly. A survey that
 * promises 19 and delivers a redraw is worse than one that promises 12.
 */
const LABEL_ALLOWANCE_CHARS = 18;
const LABEL_ALLOWANCE_LINES = 2;

/**
 * A stand-in the width and height a renamed label will be. Measurement only:
 * the units a survey returns keep their filenames.
 *
 * Built out of the real label so a genuinely long name is never shrunk to the
 * allowance -- `excalidraw-assets` is wider than 18 characters and has to be
 * measured as itself.
 */
function sizingLabel(label: string): string {
  const lines = label.split("\n");
  const padded = lines.map((line) =>
    line.length >= LABEL_ALLOWANCE_CHARS ? line : line.padEnd(LABEL_ALLOWANCE_CHARS, " label"[line.length % 6] || "n"),
  );
  while (padded.length < LABEL_ALLOWANCE_LINES) padded.push("n".repeat(LABEL_ALLOWANCE_CHARS));
  return padded.join("\n");
}

/**
 * How the board a grouping implies will render, and how much of it is connected.
 *
 * Laid out through the same `planDiagramLayout` `create_diagram` uses, with the
 * claims folded into the labels the same way, so the size measured here is the
 * size the caller will get -- at the label size the caller will end up with,
 * not the filenames it is handed.
 */
async function measureGrouping(
  units: SurveyUnit[],
  deps: Map<string, ScopeDependency[]>,
  direction: LayoutDirection,
): Promise<{ edges: SurveyEdge[]; view: Viewability; isolated: number; dropped: number }> {
  // Thinned before it is laid out, so the size measured is the size of the board
  // that will actually be drawn rather than of a denser one nobody will see.
  const { edges, dropped } = thin(edgesFor(units, deps), units.length);
  const plan = await planDiagramLayout(
    {
      nodes: units.map((unit) => ({ id: unit.id, label: sizingLabel(unit.label) })),
      edges: edges.map((edge) => ({
        from: edge.from,
        to: edge.to,
        ...(edge.claim ? { claim: edge.claim } : {}),
      })),
      layout: { direction },
    },
    { x: 0, y: 0 },
    "survey-probe",
  );
  const bounds = planBounds(plan);
  const view = viewability({
    width: bounds.maxX - bounds.minX,
    height: bounds.maxY - bounds.minY,
  });
  const touched = new Set(edges.flatMap((edge) => [edge.from, edge.to]));
  return { edges, view, isolated: units.length - touched.size, dropped };
}

/**
 * The most arrows a board may carry, per box.
 *
 * Measured, and the measurement is unusually clean: across all 16 boards in this
 * repository -- hand-drawn, model-drawn, good and bad -- the arrows-per-box ratio
 * runs from 0.25 to **1.43**, and not one board exceeds it. Among the eight that
 * render legibly the median is 1.0 and the maximum 1.22.
 *
 * A survey ignoring this produced 16 boxes and 48 arrows of `src/engine` -- 3.0
 * per box, twice as dense as anything anyone has drawn here. Every arrow was a
 * real import and the checker passed all 48. Rendered, it was a hairball: long
 * connectors crossing the full width, unfollowable. `viewable.ts` called it
 * legible and was right about the only thing it measures, which is how big the
 * labels come out.
 *
 * So this is the second half of "can this be read". A person drawing at 1.21
 * arrows per box was not drawing every dependency; they were drawing the ones
 * that carry the structure. `thin` below does the same thing on purpose and says
 * how many it left out, because a selective diagram is normal and a silently
 * selective one is not.
 */
const MAX_ARROWS_PER_BOX = 1.5;

/**
 * The most boxes a board gets, whatever the label arithmetic allows.
 *
 * The label measure says whether text is big enough, and it is more permissive
 * than a person is: refining to the last legible box produced 32-box boards of
 * serde_json and query-core at 11px, which is twice what anybody has drawn here
 * and reads as a wall.
 *
 * Measured over this repository's 16 boards, the eight that render legibly hold
 * 3, 4, 5, 6, 8, 9, 14 and 14 boxes -- **14 is the most any legible board has**,
 * and the boards above it (16, 18, 19, 21, 33) are every one of them cramped or
 * unviewable. So this is not a taste; it is where the boards that worked stopped.
 *
 * A scope with more to say than 14 boxes is not truncated silently: the boxes
 * left closed come back as the next boards to draw, which is what `next` is for.
 */
const MAX_BOXES = 14;

/**
 * The arrows worth drawing, and how many were left out.
 *
 * Every box keeps its heaviest arrow before the budget is spent on anything
 * else. Thinning by weight alone left `viewable` sitting on the board with
 * nothing attached -- a floating label, which is a worse picture than a missing
 * arrow and reads as a bug rather than as a choice. So isolation is not something
 * this is allowed to cause; it can only leave alone what the code left alone.
 *
 * The budget is then filled by weight, heaviest first: the arrow standing for
 * thirty imports is the most structural thing on offer, and the one standing for
 * a single import is a detail.
 */
function thin(edges: SurveyEdge[], boxes: number): { edges: SurveyEdge[]; dropped: number } {
  const budget = Math.max(boxes - 1, Math.floor(boxes * MAX_ARROWS_PER_BOX));
  if (edges.length <= budget) return { edges, dropped: 0 };

  const order = (a: SurveyEdge, b: SurveyEdge) =>
    b.weight - a.weight || byId(`${a.from} ${a.to}`, `${b.from} ${b.to}`);

  const best = new Map<string, SurveyEdge>();
  for (const edge of [...edges].sort(order)) {
    for (const end of [edge.from, edge.to]) if (!best.has(end)) best.set(end, edge);
  }
  const keep = new Set<SurveyEdge>(best.values());
  for (const edge of [...edges].sort(order)) {
    if (keep.size >= budget) break;
    keep.add(edge);
  }
  // Sorted back into the input's order so the same graph always produces the
  // same board, whatever order the budget happened to fill in.
  return { edges: edges.filter((edge) => keep.has(edge)), dropped: edges.length - keep.size };
}

/**
 * A board is acceptable when it can be read and when it is mostly joined up.
 *
 * Legibility alone is not enough and the failure is not hypothetical: the
 * coarsest grain of a 30-file package came out as two boxes and one arrow, which
 * renders beautifully and says nothing. A board is also allowed a few loose
 * boxes -- one in seven -- because a genuine leaf module is not a defect.
 */
function acceptable(measured: { view: Viewability; isolated: number }, boxes: number): boolean {
  return measured.view.verdict === "legible"
    && measured.isolated <= Math.max(1, Math.floor(boxes * 0.15));
}

/**
 * Work out the shape of a board for one directory.
 *
 * The grain is measured in one flow, and `create_diagram` picks the flow the
 * board is finally drawn in -- it does that with the *real* labels, which is
 * strictly better information than this has.
 *
 * Surveying both flows and handing over the winner was built and then removed.
 * It doubled the layouts -- ripgrep went from 3.2s to 6.4s -- and across eleven
 * scopes it changed the box count on none of them, because the box ceiling binds
 * long before the flow does. Every one of those boards then came out legible
 * when `create_diagram` chose. Pass a direction only when the board is a
 * sequence and you already know you want DOWN; how much fits does depend on it.
 */
export async function surveyScope(
  scope: string,
  workspace: Workspace,
  direction: LayoutDirection = "RIGHT",
): Promise<SurveyResult> {
  const { files, deps, read, unread } = scanScope(scope, workspace);
  const base = {
    scope,
    read,
    unread,
    omitted: [] as string[],
    arrowsOmitted: 0,
    next: [] as string[],
  };
  if (files.length === 0) {
    return {
      ...base, units: [], edges: [], layouts: 0, direction,
      view: viewability({ width: 0, height: 0 }),
      refused: `No source file under ${scope} in a language this engine reads.`,
    };
  }

  let units = withUniqueIds(childrenOf(scope, files));
  let measured = await measureGrouping(units, deps, direction);
  let layouts = 1;
  const declined: SurveyUnit[] = [];

  /*
   * Coarsen, while the scope's own children do not fit.
   *
   * There is nothing coarser than the children to fall back to, so the only way
   * down is to show fewer of them, and the ones to lose are the ones carrying
   * the least traffic. They are collected, never dropped quietly: "what is not
   * on this board" is the one question a picture cannot answer about itself.
   */
  while ((!acceptable(measured, units.length) || units.length > MAX_BOXES) && units.length > 4) {
    const degree = new Map<string, number>();
    for (const edge of measured.edges) {
      degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
      degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
    }
    const byTraffic = [...units].sort(
      (a, b) => (degree.get(a.id) ?? 0) - (degree.get(b.id) ?? 0) || byId(a.id, b.id),
    );
    const cut = Math.max(1, Math.round(units.length * 0.15));
    declined.push(...byTraffic.slice(0, cut));
    units = byTraffic.slice(cut);
    measured = await measureGrouping(units, deps, direction);
    layouts++;
  }

  /*
   * Refine, while it does fit: open the box hiding the most files, which is the
   * biggest thing the picture is currently not saying. An expansion that breaks
   * legibility is reverted and that box is left closed -- and a box left closed
   * is the next board, so declining to expand is how the split gets decided.
   */
  const closed: SurveyUnit[] = [];
  if (acceptable(measured, units.length)) {
    for (;;) {
      if (units.length >= MAX_BOXES) break;
      const openable = units
        .filter((unit) => unit.dir && !closed.includes(unit) && childrenOf(unit.dir, files).length > 1)
        .sort((a, b) => b.files.length - a.files.length || byId(a.id, b.id));
      if (openable.length === 0) break;
      const pick = openable[0];
      const opened = withUniqueIds([
        ...units.filter((unit) => unit !== pick),
        ...childrenOf(pick.dir!, files),
      ]);
      const next = await measureGrouping(opened, deps, direction);
      layouts++;
      // A box that opens into more than the ceiling can hold is left closed and
      // becomes its own board, rather than pushing the whole picture over.
      if (opened.length <= MAX_BOXES && acceptable(next, opened.length)) {
        units = opened;
        measured = next;
      } else {
        closed.push(pick);
      }
    }
  }

  const shown = new Set(units.flatMap((unit) => unit.files));
  const result: SurveyResult = {
    ...base,
    units,
    direction,
    edges: measured.edges,
    arrowsOmitted: measured.dropped,
    view: measured.view,
    next: [...closed, ...declined].map((unit) => unit.dir).filter((dir): dir is string => !!dir),
    omitted: files.filter((file) => !shown.has(file)),
    layouts,
  };
  if (!acceptable(measured, units.length)) {
    const languages = Object.entries(unread)
      .map(([language, count]) => `${count} ${language}`)
      .join(", ");
    result.refused = read === 0
      ? `Nothing under ${scope} has a dependency reader (${languages}), so there are no arrows to `
        + "draw and no way to tell which modules matter. Draw this one by hand."
      : `No grain of ${scope} both renders legibly and comes out connected. Survey its `
        + `subdirectories separately: ${result.next.slice(0, 6).join(", ") || "there are none"}.`;
  }
  return result;
}

