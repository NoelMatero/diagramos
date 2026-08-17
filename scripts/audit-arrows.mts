/**
 * How often is the arrow check wrong, on code nobody picked for it?
 *
 * Everything else measures against fixtures, which our own machinery both
 * writes and judges -- and that cannot find a bug the two halves share. This
 * asks the TypeScript compiler for the truth instead: every declaration it
 * sees, every function body, and every same-file call it resolves, compared
 * against what the regexes here conclude.
 *
 *   npx tsx scripts/audit-arrows.mts
 *
 * The number that matters is FALSE ALARMS -- a real call we say is not there.
 * That is the loud direction, and the one that gets a check switched off.
 * First run against the regex engine: 12.8%. Three bugs later: 0.6%, and the
 * two that remained were `#private` class fields, whose leading `#` defeated
 * the word boundary every symbol search used. On tree-sitter it is 0.0%, and
 * so are missed declarations and unreadable bodies.
 *
 * `wrongly confirmed` is the one number still worth reading. It is not a
 * parser problem: an arrow is satisfied when a body *names* the other end
 * rather than calling it, so `filesIn` "reaches" a local `stat` by way of
 * `workspace.stat`. That is a choice about what an arrow means, not a bug.
 *
 * A run is a measurement, not a test: it prints and never fails. The bugs it
 * finds become tests.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
import { reaches, bodyOf } from "../src/engine/body";
import { initEngine } from "../src/engine/parse";
import { symbolEvidence } from "../src/engine/assert";

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((e) => {
    const p = `${dir}/${e}`;
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const files = walk(path.join(REPO, "src")).filter((f) => /\.tsx?$/.test(f));

interface Fn { name: string; start: number; end: number; }

/** Every named function-ish declaration, and every call inside it. */
function parse(source: string, file: string) {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const fns: Fn[] = [];
  const decls = new Set<string>();
  const calls: Array<{ from: string; to: string }> = [];

  function nameOf(node: ts.Node): string | undefined {
    if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) return node.name?.getText();
    if (ts.isVariableDeclaration(node) && node.initializer
        && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
      return node.name.getText();
    }
    return undefined;
  }

  const collect = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)
        || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)
        || ts.isEnumDeclaration(node) || ts.isMethodDeclaration(node)) {
      const n = (node as any).name?.getText();
      if (n) decls.add(n);
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) decls.add(node.name.getText());
    const n = nameOf(node);
    if (n) fns.push({ name: n, start: node.getStart(sf), end: node.getEnd() });
    ts.forEachChild(node, collect);
  };
  collect(sf);

  // A call belongs to the innermost function whose span contains it.
  const owner = (pos: number): string | undefined => {
    let best: Fn | undefined;
    for (const f of fns) {
      if (pos >= f.start && pos < f.end && (!best || f.start > best.start)) best = f;
    }
    return best?.name;
  };
  const findCalls = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const e = node.expression;
      // Only the forms our checker follows: bare and this./self.
      let callee: string | undefined;
      if (ts.isIdentifier(e)) callee = e.getText();
      else if (ts.isPropertyAccessExpression(e) && e.expression.kind === ts.SyntaxKind.ThisKeyword) {
        callee = e.name.getText();
      }
      const from = owner(node.getStart(sf));
      if (callee && from && callee !== from) calls.push({ from, to: callee });
    }
    ts.forEachChild(node, findCalls);
  };
  findCalls(sf);
  return { fns, decls, calls };
}

await initEngine();

let declTotal = 0, declMissed: string[] = [];
let bodyTotal = 0, bodyMissing: string[] = [];
let edgeTotal = 0, edgeMissed: string[] = [], edgeSkipped: string[] = [];
let negTotal = 0, negWrong: string[] = [];

for (const file of files) {
  const source = readFileSync(file, "utf8");
  const short = file.replace(/.*src\//, "");
  const language = file.endsWith(".tsx") ? "tsx" as const : "ts" as const;
  const { fns, decls, calls } = parse(source, file);

  // 1. Do we find every declaration tsc calls a declaration?
  for (const name of decls) {
    declTotal += 1;
    if (!symbolEvidence(file, source, name)?.declared) declMissed.push(`${short}#${name}`);
  }
  // 2. Can we extract a body for every function tsc found?
  for (const f of new Set(fns.map((f) => f.name))) {
    bodyTotal += 1;
    if (bodyOf(source, f, language) === undefined) bodyMissing.push(`${short}#${f}`);
  }
  // 3. Every real same-file call must be confirmed. A miss is a FALSE ALARM.
  const localFns = new Set(fns.map((f) => f.name));
  for (const { from, to } of calls) {
    if (!localFns.has(to) || !localFns.has(from)) continue;
    edgeTotal += 1;
    const verdict = reaches(source, from, [to], language);
    // `undefined` is "no readable body": the arrow is skipped and counted,
    // which is silence rather than a false alarm. Only `false` is loud.
    if (verdict === false) edgeMissed.push(`${short}: ${from} -> ${to}`);
    else if (verdict === undefined) edgeSkipped.push(`${short}: ${from} -> ${to}`);
  }
  // 4. Pairs with no path at all: our answer must be false, not true.
  const reachable = new Map<string, Set<string>>();
  for (const { from, to } of calls) {
    if (!reachable.has(from)) reachable.set(from, new Set());
    reachable.get(from)!.add(to);
  }
  const closure = (a: string) => {
    const seen = new Set<string>(); const q = [a];
    while (q.length) { const x = q.pop()!; for (const y of reachable.get(x) ?? []) if (!seen.has(y)) { seen.add(y); q.push(y); } }
    return seen;
  };
  const names = [...localFns];
  for (const a of names) {
    const reach = closure(a);
    for (const b of names) {
      if (a === b || reach.has(b)) continue;
      negTotal += 1;
      if (reaches(source, a, [b], language) === true) negWrong.push(`${short}: ${a} -> ${b}`);
    }
  }
}

const pct = (n: number, d: number) => d === 0 ? "n/a" : `${((n / d) * 100).toFixed(1)}%`;
console.log(`files: ${files.length}\n`);
console.log(`declarations tsc found:      ${declTotal}`);
console.log(`  our table missed:          ${declMissed.length}  (${pct(declMissed.length, declTotal)}) <- would false-alarm on @declared`);
console.log(`functions tsc found:         ${bodyTotal}`);
console.log(`  no body extracted:         ${bodyMissing.length}  (${pct(bodyMissing.length, bodyTotal)}) <- arrow skipped, counted`);
console.log(`real same-file call edges:   ${edgeTotal}`);
console.log(`  wrongly said no:           ${edgeMissed.length}  (${pct(edgeMissed.length, edgeTotal)}) <- FALSE ALARMS`);
console.log(`  skipped, no readable body: ${edgeSkipped.length}  (${pct(edgeSkipped.length, edgeTotal)}) <- silent, counted`);
console.log(`unconnected pairs:           ${negTotal}`);
console.log(`  we wrongly confirmed:      ${negWrong.length}  (${pct(negWrong.length, negTotal)}) <- missed drift`);
for (const [label, list] of [["missed declarations", declMissed], ["no body", bodyMissing], ["FALSE ALARMS", edgeMissed], ["skipped", edgeSkipped], ["wrongly confirmed", negWrong]] as const) {
  if (list.length) console.log(`\n${label} (first 12):\n  ` + list.slice(0, 12).join("\n  "));
}
