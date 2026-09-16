#!/usr/bin/env node
/**
 * Where "the right relationship at the wrong altitude" can be read (#280).
 *
 *   npm run measure:altitude
 *
 * #217 named a gap: a box anchored at a module, with an arrow about something
 * two functions inside it do. Nothing reads altitude, and a check that cannot
 * tell that from a deliberate summary would call good boards wrong. So this
 * prints every candidate definition's hits for a person to read, rather than a
 * score: whether a file box "meant" one function is a question about intent,
 * and no referee here can answer it.
 *
 * Three sections:
 *
 *   A. Every arrow on a code board, by the altitude of its two ends, and the
 *      arrows whose two ends are in one file with at least one end the whole
 *      file -- the definition that survived. After #280 each of those should
 *      be unread, `ends-in-one-file`, and none confirmed.
 *   B. File boxes whose label names something the file declares. It fires on
 *      the Rust field boxes, and on "read", "server", "layout" everywhere else.
 *   C. File-level arrows whose evidence -- the other file's names -- sits inside
 *      one declaration. TypeScript and JavaScript only, by name, and crude:
 *      a name match is not a resolved use.
 *
 * The corpus is `boardCorpus()`, which starts from the directory this is run
 * in. The boards are the owner's own test diagrams, so a count here says
 * whether a rule can be read, never whether anybody wants it.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { boardCorpus } from "./lib/boards";
import { readBoard } from "../src/engine/board-file";
import { declarationsOf } from "../src/engine/body";
import { checkDrift, createWorkspace } from "../src/engine/drift";
import { readGraph } from "../src/engine/graph";
import { each, initEngine, languageOf, parseSource, type Node } from "../src/engine/parse";

const HOME = process.env.HOME ?? "";

function repositoryOf(file: string): string | undefined {
  let directory = path.dirname(file);
  for (;;) {
    if (existsSync(path.join(directory, ".git"))) return directory;
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

type Altitude = "none" | "symbol" | "file" | "dir" | "missing";

function altitudeOf(ref: string | undefined, root: string): Altitude {
  if (!ref) return "none";
  if (ref.includes("#")) return "symbol";
  if (!existsSync(path.join(root, ref))) return "missing";
  return /\.[a-z]+$/i.test(ref) ? "file" : "dir";
}

const fileOf = (ref: string) => ref.split("#")[0]!;
const flat = (text: string | undefined, width = 40) => (text ?? "").replace(/\s+/g, " ").trim().slice(0, width);

interface End { ref: string; altitude: Altitude; label: string; text: string }
interface Arrow { board: string; root: string; id: string; from: End; to: End; label: string; outcome: string }

/* ── read every code board once ─────────────────────────────────────────── */

await initEngine();
const arrows: Arrow[] = [];
const skipped: string[] = [];
for (const file of boardCorpus((root) => skipped.push(root))) {
  let board;
  try {
    board = await readBoard(file);
  } catch {
    continue;
  }
  const graph = readGraph(board);
  if (graph.describes === "concept") continue;
  const root = repositoryOf(file);
  if (!root) continue;
  let report;
  try {
    report = checkDrift(board, createWorkspace(root), { edges: true });
  } catch {
    continue;
  }
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  for (const edge of graph.edges) {
    const from = nodes.get(edge.from);
    const to = nodes.get(edge.to);
    const id = `${edge.from} -> ${edge.to}`;
    const same = (one: { from: string; to: string }) => one.from === edge.from && one.to === edge.to;
    const finding = report.edges.find((one) => one.node === id);
    const unconfirmed = report.unconfirmedEdges.find(same);
    const unread = report.unreadEdges.find(same);
    // Confirmed is what is left: the report names every other outcome.
    const outcome = finding ? `finding ${finding.kind}`
      : unconfirmed ? `unconfirmed ${unconfirmed.reason}`
      : unread ? `unread ${unread.reason}`
      : edge.state === "planned" ? "planned"
      : "confirmed";
    const end = (node: typeof from): End => ({
      ref: node?.ref ?? "",
      altitude: altitudeOf(node?.ref, root),
      label: flat(node?.label),
      // Whole, for section B: a word past the display cut is still a word.
      text: flat(node?.label, Infinity),
    });
    arrows.push({
      board: path.relative(HOME, file), root, id, from: end(from), to: end(to), label: flat(edge.label, 24), outcome,
    });
  }
}

const tally = <T,>(items: T[], key: (item: T) => string) => {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]);
};

/* ── A · altitude, and the one-file rule ────────────────────────────────── */

console.log("A · ARROWS BY THE ALTITUDE OF THEIR ENDS");
for (const root of skipped) console.log(`  (no boards under ${root} -- skipped)`);
console.log(`  ${arrows.length} arrows on ${new Set(arrows.map((arrow) => arrow.board)).size} code boards`);
for (const [pair, count] of tally(arrows, (arrow) => [arrow.from.altitude, arrow.to.altitude].sort().join(" + "))) {
  console.log(`  ${String(count).padStart(4)}  ${pair}`);
}
const anchored = (arrow: Arrow) => arrow.from.altitude !== "none" && arrow.to.altitude !== "none";
const mixed = arrows.filter((arrow) => anchored(arrow) && arrow.from.altitude !== arrow.to.altitude);
const oneFile = arrows.filter((arrow) =>
  arrow.from.ref && arrow.to.ref
  && fileOf(arrow.from.ref) === fileOf(arrow.to.ref)
  && (arrow.from.altitude === "file" || arrow.to.altitude === "file"));
console.log();
console.log(`  ${mixed.length} arrows join two anchored ends at different altitudes;`);
console.log(`  ${oneFile.length} have both ends in one file and at least one end the whole file:`);
for (const arrow of oneFile) {
  console.log(`    ${arrow.board.split("/").pop()}  ${arrow.from.label} -> ${arrow.to.label}  [${arrow.outcome}]`);
}
const passed = oneFile.filter((arrow) => arrow.outcome === "confirmed").length;
console.log(`  of those, confirmed: ${passed} (nothing can confirm them; this should be 0)`);
console.log();
console.log(`  the other ${mixed.length - mixed.filter((arrow) => oneFile.includes(arrow)).length} cross files, where no rule separates a mistake from a summary:`);
for (const arrow of mixed.filter((one) => !oneFile.includes(one))) {
  console.log(`    ${arrow.board.split("/").pop()}  ${arrow.from.label} -> ${arrow.to.label}  "${arrow.label}"`);
}

/* ── B · a file box whose label names a declaration ─────────────────────── */

console.log();
console.log("B · FILE BOXES WHOSE LABEL NAMES SOMETHING THE FILE DECLARES");
const boxes = new Map<string, { board: string; root: string; end: End }>();
for (const arrow of arrows) {
  for (const end of [arrow.from, arrow.to]) {
    if (end.altitude !== "file") continue;
    boxes.set(`${arrow.board}|${end.ref}|${end.label}`, { board: arrow.board, root: arrow.root, end });
  }
}
let readable = 0;
let naming = 0;
for (const { board, root, end } of boxes.values()) {
  const language = languageOf(end.ref);
  if (!language) continue;
  readable += 1;
  const source = readFileSync(path.join(root, end.ref), "utf8");
  const words = [...new Set(end.text.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) ?? [])];
  const declared = words.filter((word) => declarationsOf(source, word, language).length > 0);
  if (declared.length === 0) continue;
  naming += 1;
  console.log(`    ${board.split("/").pop()}  ${end.ref}  "${end.label}"  names ${declared.join(", ")}`);
}
console.log(`  ${naming} of ${readable} file boxes in a language with a grammar`);

/* ── C · the evidence for a file-level arrow sits in one declaration ────── */

console.log();
console.log("C · FILE-LEVEL ARROWS WHOSE EVIDENCE SITS IN ONE DECLARATION (ts/js, by name)");

function topLevel(root: Node): Node[] {
  const out: Node[] = [];
  for (let index = 0; index < root.childCount; index += 1) {
    const child = root.child(index)!;
    out.push(child.type === "export_statement" ? child.childForFieldName("declaration") ?? child : child);
  }
  return out;
}

function namesOf(declaration: Node): string[] {
  const name = declaration.childForFieldName("name");
  if (name) return [name.text];
  const out: string[] = [];
  for (let index = 0; index < declaration.childCount; index += 1) {
    const declarator = declaration.child(index)!;
    const bound = declarator.isNamed ? declarator.childForFieldName("name") : null;
    if (bound?.type === "identifier") out.push(bound.text);
  }
  return out;
}

function treeOf(root: string, ref: string): Node | undefined {
  const language = languageOf(ref);
  const file = path.join(root, ref);
  if (!language || language === "rust" || language === "python" || !existsSync(file)) return undefined;
  return parseSource(readFileSync(file, "utf8"), language)?.rootNode;
}

/** Top-level declarations of `user` that mention any of `names`, outside its imports. */
function sites(user: Node, names: Set<string>): string[] {
  const found: string[] = [];
  for (const top of topLevel(user)) {
    if (top.type === "import_statement") continue;
    let mentions = false;
    each(top, (node) => {
      if (/identifier$/.test(node.type) && names.has(node.text)) mentions = true;
    });
    if (!mentions) continue;
    const own = namesOf(top);
    found.push(own.length > 0 ? own.join("/") : `<${top.type}>`);
  }
  return found;
}

let asked = 0;
let one = 0;
for (const arrow of arrows) {
  const ends = [arrow.from, arrow.to];
  if (!ends.some((end) => end.altitude === "file")) continue;
  if (!ends.every((end) => end.altitude === "file" || end.altitude === "symbol")) continue;
  if (fileOf(arrow.from.ref) === fileOf(arrow.to.ref)) continue;
  const from = treeOf(arrow.root, fileOf(arrow.from.ref));
  const to = treeOf(arrow.root, fileOf(arrow.to.ref));
  if (!from || !to) continue;
  const offered = (tree: Node, ref: string) => {
    const symbol = ref.split("#")[1]?.split("@")[0];
    return new Set(symbol ? [symbol] : topLevel(tree).flatMap(namesOf));
  };
  // Whichever file mentions the other's names is where the evidence is.
  const fromSites = sites(from, offered(to, arrow.to.ref));
  const [user, where] = fromSites.length > 0
    ? [arrow.from, fromSites]
    : [arrow.to, sites(to, offered(from, arrow.from.ref))];
  if (user.altitude !== "file") continue;
  asked += 1;
  if (where.length !== 1 || where[0]!.startsWith("<")) continue;
  one += 1;
  console.log(`    ${arrow.board.split("/").pop()}  ${arrow.from.label} -> ${arrow.to.label}  all in ${where[0]}`);
}
console.log(`  ${one} of ${asked} file-level arrows between two ts/js files`);
