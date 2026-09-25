#!/usr/bin/env node
/**
 * Does `@builds` ever say "A doesn't create B" when A really does? (#362)
 *
 *   npm run measure:builds-absent -- --language=ts           -- the TypeScript clones
 *   npm run measure:builds-absent -- --language=ts --cases   -- print every accusation
 *
 * **The gate for #362's absence licence. A measurement: it prints and never fails.**
 *
 * ## The question
 *
 * `@builds` may now call an arrow wrong because the routine's own body creates
 * none of the head's type (`constructs.ts`, `refuted`). That accusation is only
 * as good as the reader's "none". So: take every (routine, type) pair a
 * compiler says the routine really creates -- a `new B`, a `<B />`, an object
 * literal the compiler types as a B -- draw it as a `@builds` arrow, and check
 * it with the product's own `checkDrift`. **Every one of those arrows is
 * correct, so the count of `builds-refuted` on them must be 0.**
 *
 * It also prints what the checker said about the pairs the compiler says the
 * routine only *gets* from some other call. Under #360's meaning those arrows
 * are wrong, so that row is how often the new red fires on real code, and how
 * often the guards keep it quiet instead.
 *
 * ## The referee
 *
 * TypeScript: the TypeScript compiler's own type checker -- the type of each
 * `new` expression, the symbol behind each JSX tag, and the contextual type of
 * each object literal. It shares nothing with the reader judged, which reads
 * tree-sitter nodes and follows imports with `calls.ts`' resolver.
 *
 * ## What it cannot see, stated before anybody reads the zero
 *
 * - A workspace import the compiler cannot resolve without `node_modules`
 *   resolves to nothing, so a construction through it is not a pair here.
 * - Only type names declared exactly once in the files read are counted; a
 *   name declared twice is left out rather than guessed at.
 * - The shapes the compiler cannot tell the reader about -- an alias, a
 *   subclass, `this.constructor` -- are the tests in
 *   `tests/builds-absent.test.ts`, one per shape.
 *
 * Each project runs in a process of its own (docs: a corpus sweep needs a
 * process per tree), and a project that fails is named, never dropped.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const flag = (name: string) => args.find((one) => one.startsWith(`--${name}=`))?.split("=")[1];
const language = flag("language") ?? "ts";
const only = flag("one");
const showCases = args.includes("--cases");

/** The pinned clones live in the main checkout; a worktree has none. */
const CORPUS = existsSync(path.resolve(import.meta.dirname, "..", ".corpus"))
  ? path.resolve(import.meta.dirname, "..", ".corpus")
  : path.join(process.env.HOME ?? "", "board-ai", ".corpus");

/**
 * The TypeScript trees, and the packages read in each: the ones the planted
 * boards point into, which is where a wrong red would land. #360's probe read
 * the same directories.
 */
const TS_TREES: Record<string, string[]> = {
  "TanStack-query": ["packages/query-core/src"],
  "vuejs-core": ["packages/reactivity/src", "packages/runtime-core/src"],
  "excalidraw-excalidraw": ["packages/element/src"],
  "nestjs-nest": ["packages/core", "packages/common"],
  "vitejs-vite": ["packages/vite/src"],
};

/** One pair, as the referee sees it. */
interface Pair {
  from: string;
  to: string;
  /** How the referee says the routine comes by it: writes it, types a literal as it, or gets it from a call. */
  how: "new" | "literal" | "gets";
  /** What the head is declared as. */
  target: string;
}

interface ProjectResult {
  project: string;
  /** `${how} ${target} ${answer}` -> count. */
  tally: Record<string, number>;
  /** Pairs the compiler says are created, and the checker called wrong. Must be empty. */
  wrong: string[];
  /** Pairs the compiler says are only got elsewhere, and the checker called wrong. The new red, on real code. */
  caught: string[];
}

if (only) {
  const result = await measureOne(only);
  process.stdout.write(`\n@@RESULT ${JSON.stringify(result)}\n`);
  process.exit(0);
}

if (language !== "ts") {
  process.stderr.write(`--language=${language}: not measured yet. Only ts is wired.\n`);
  process.exit(1);
}

const results: ProjectResult[] = [];
const failed: string[] = [];
const self = fileURLToPath(import.meta.url);
for (const project of Object.keys(TS_TREES)) {
  process.stderr.write(`${project}...\n`);
  const run = spawnSync(process.execPath, [
    ...process.execArgv, self, `--language=${language}`, `--one=${project}`,
  ], { encoding: "utf8", maxBuffer: 1 << 28, env: { ...process.env } });
  const line = run.stdout.split("\n").find((one) => one.startsWith("@@RESULT "));
  if (run.status !== 0 || !line) {
    failed.push(`${project} (exit ${run.status}): ${(run.stderr || "").trim().split("\n").slice(-3).join(" | ")}`);
    continue;
  }
  results.push(JSON.parse(line.slice("@@RESULT ".length)) as ProjectResult);
}

report(results, failed);

function report(results: ProjectResult[], failed: string[]): void {
  const tally: Record<string, number> = {};
  for (const one of results) for (const [key, count] of Object.entries(one.tally)) tally[key] = (tally[key] ?? 0) + count;
  const created = (key: string) => key.startsWith("new ") || key.startsWith("literal ");
  const sum = (keep: (key: string) => boolean) =>
    Object.entries(tally).filter(([key]) => keep(key)).reduce((total, [, count]) => total + count, 0);

  const createdPairs = sum(created);
  const wrong = results.flatMap((one) => one.wrong.map((pair) => `${one.project}: ${pair}`));
  const gets = sum((key) => key.startsWith("gets "));
  const caught = results.flatMap((one) => one.caught.map((pair) => `${one.project}: ${pair}`));

  console.log(`\n@builds absence, ${language}: ${results.length} project(s)`);
  console.log(`  pairs the compiler says the routine creates: ${createdPairs}`);
  console.log(`    called wrong by the checker: ${wrong.length}   <- must be 0`);
  for (const how of ["new", "literal"]) {
    const rows = Object.entries(tally).filter(([key]) => key.startsWith(`${how} `)).sort();
    for (const [key, count] of rows) console.log(`      ${String(count).padStart(5)}  ${key}`);
  }
  console.log(`  pairs the compiler says the routine only gets from a call: ${gets}`);
  console.log(`    called wrong by the checker: ${caught.length}`);
  const quietGets = Object.entries(tally).filter(([key]) => key.startsWith("gets ") && key.includes(" quiet"));
  console.log(`    quiet: ${quietGets.reduce((total, [, count]) => total + count, 0)}`);
  for (const [key, count] of quietGets.sort()) console.log(`      ${String(count).padStart(5)}  ${key}`);
  if (wrong.length > 0) {
    console.log("\n  WRONG (the compiler says it creates one):");
    for (const one of wrong) console.log(`    ${one}`);
  }
  if (showCases && caught.length > 0) {
    console.log("\n  caught (the compiler says it only gets one):");
    for (const one of caught) console.log(`    ${one}`);
  }
  if (failed.length > 0) {
    console.log("\n  FAILED, and not counted:");
    for (const one of failed) console.log(`    ${one}`);
  }
}

async function measureOne(project: string): Promise<ProjectResult> {
  const root = path.join(CORPUS, project);
  // Loaded here so the parent process never pays for the compiler.
  const ts = (await import("typescript")).default;
  const pairs = typescriptPairs(ts, root, TS_TREES[project] ?? []);
  process.stderr.write(`${project}: ${pairs.length} pairs\n`);
  return askChecker(project, root, pairs);
}

/**
 * The referee: which project types each routine creates, and how, by the
 * TypeScript compiler's own reading.
 */
function typescriptPairs(ts: typeof import("typescript"), root: string, dirs: string[]): Pair[] {
  const skip = /^(node_modules|\.git|dist|__tests__|test|tests)$/;
  const walk = (dir: string, out: string[] = []): string[] => {
    if (!existsSync(dir)) return out;
    for (const name of readdirSync(dir)) {
      if (skip.test(name)) continue;
      const file = path.join(dir, name);
      if (statSync(file).isDirectory()) walk(file, out);
      else if (/\.tsx?$/.test(name) && !/\.(d|test|spec)\.tsx?$/.test(name)) out.push(file);
    }
    return out;
  };
  const files = dirs.flatMap((dir) => walk(path.join(root, dir)));
  const reading = new Set(files);
  const program = ts.createProgram(files, {
    target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.Preserve, skipLibCheck: true, noEmit: true,
    strict: false, experimentalDecorators: true, allowJs: false,
  });
  const checker = program.getTypeChecker();

  // Types declared in these files, by name, kept only when declared once.
  const declared = new Map<string, Array<{ file: string; kind: string }>>();
  for (const source of program.getSourceFiles()) {
    if (!reading.has(source.fileName)) continue;
    ts.forEachChild(source, function visit(node) {
      const kind = ts.isClassDeclaration(node) ? "class"
        : ts.isInterfaceDeclaration(node) ? "interface"
        : ts.isTypeAliasDeclaration(node) ? "alias"
        : ts.isFunctionDeclaration(node) && source.fileName.endsWith(".tsx") ? "component"
        : undefined;
      const name = (node as { name?: import("typescript").Node }).name;
      if (kind && name && ts.isIdentifier(name)) {
        const list = declared.get(name.text) ?? [];
        list.push({ file: path.relative(root, source.fileName), kind });
        declared.set(name.text, list);
      }
      ts.forEachChild(node, visit);
    });
  }
  const unique = (name: string) => {
    const list = declared.get(name);
    return list && list.length === 1 ? list[0] : undefined;
  };
  const namesOf = (type: import("typescript").Type | undefined): string[] => {
    if (!type) return [];
    if (type.isUnion()) return type.types.flatMap(namesOf).concat(type.aliasSymbol ? [type.aliasSymbol.name] : []);
    return [type.aliasSymbol?.name, type.symbol?.name].filter((one): one is string => Boolean(one));
  };
  const symbolName = (symbol: import("typescript").Symbol | undefined) => {
    if (!symbol) return undefined;
    if (symbol.flags & ts.SymbolFlags.Alias) {
      try { symbol = checker.getAliasedSymbol(symbol); } catch { /* keep the alias */ }
    }
    return symbol.name;
  };
  const routineOf = (node: import("typescript").Node): string | undefined => {
    if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name && ts.isIdentifier(node.name) && node.body) {
      return node.name.text;
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
      && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
      return node.name.text;
    }
    return undefined;
  };

  const rank = ["gets", "literal", "new"] as const;
  const pairs: Pair[] = [];
  for (const source of program.getSourceFiles()) {
    if (!reading.has(source.fileName)) continue;
    const file = path.relative(root, source.fileName);
    ts.forEachChild(source, function visit(node) {
      const routine = routineOf(node);
      if (routine) {
        const made = new Map<string, Pair["how"]>();
        const note = (name: string | undefined, how: Pair["how"]) => {
          if (!name || !unique(name)) return;
          const was = made.get(name);
          if (!was || rank.indexOf(how) > rank.indexOf(was)) made.set(name, how);
        };
        (function inner(child: import("typescript").Node) {
          if (ts.isNewExpression(child)) {
            for (const name of namesOf(checker.getTypeAtLocation(child))) note(name, "new");
            note(symbolName(checker.getSymbolAtLocation(child.expression)), "new");
          } else if (ts.isJsxOpeningElement(child) || ts.isJsxSelfClosingElement(child)) {
            note(symbolName(checker.getSymbolAtLocation(child.tagName)), "new");
          } else if (ts.isObjectLiteralExpression(child)) {
            for (const name of namesOf(checker.getContextualType(child))) note(name, "literal");
          } else if (ts.isCallExpression(child)) {
            for (const name of namesOf(checker.getTypeAtLocation(child))) note(name, "gets");
          }
          ts.forEachChild(child, inner);
        })(node);
        for (const [name, how] of made) {
          const at = unique(name)!;
          if (at.file === file && name === routine) continue;
          pairs.push({ from: `${file}#${routine}`, to: `${at.file}#${name}`, how, target: at.kind });
        }
      }
      ts.forEachChild(node, visit);
    });
  }
  return pairs;
}

/** Every pair drawn as a `@builds` arrow and checked by the product. */
async function askChecker(project: string, root: string, pairs: Pair[]): Promise<ProjectResult> {
  const { checkDrift, createWorkspace, newCheckCache, ACCUSING_EDGE_KINDS } = await import("../src/engine/drift");
  const { emptyBoard } = await import("../src/engine/board-file");
  const { createDiagram } = await import("../src/engine/diagram");
  const { initEngine } = await import("../src/engine/parse");
  const { installExcalifontMeasurer } = await import("../tests/helpers/excalifont");
  installExcalifontMeasurer();
  await initEngine();

  const cache = newCheckCache(createWorkspace(root));
  const accusing = new Set<string>(ACCUSING_EDGE_KINDS);
  const result: ProjectResult = { project, tally: {}, wrong: [], caught: [] };
  for (const pair of pairs) {
    const { board } = await createDiagram(emptyBoard(), {
      name: "b",
      nodes: [{ id: "a", label: "a", ref: pair.from }, { id: "b", label: "b", ref: pair.to }],
      edges: [{ from: "a", to: "b", claim: "builds" }],
    });
    let answer: string;
    try {
      const report = checkDrift(board, cache.workspace, { edges: true, cache });
      const red = report.edges.find((finding) => accusing.has(finding.kind));
      if (red) answer = `red ${red.kind}`;
      else if (report.claims.buildsConfirmed > 0) answer = "green";
      else answer = `quiet ${Object.keys(report.claims.buildsWithheld).join("+") || "-"}`;
    } catch (error) {
      answer = `throw ${(error as Error).message.slice(0, 40)}`;
    }
    const key = `${pair.how} ${pair.target} ${answer}`;
    result.tally[key] = (result.tally[key] ?? 0) + 1;
    if (answer === "red builds-refuted") {
      (pair.how === "gets" ? result.caught : result.wrong).push(`${pair.from} -> ${pair.to} (${pair.target})`);
    }
  }
  return result;
}
