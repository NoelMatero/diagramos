#!/usr/bin/env node
/**
 * Does `@builds` ever say "A doesn't create B" when A really does? (#362)
 *
 *   npm run measure:builds-absent -- --language=ts           -- the TypeScript clones
 *   npm run measure:builds-absent -- --language=ts --cases   -- print every accusation
 *   npm run measure:builds-absent -- --language=rust         -- the Rust clones, rustc on PATH
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
 * Rust: two, because the reader itself now asks rustc. The accusation needs
 * rustc's MIR for the routine to show no B, so a referee reading the same
 * MIR is not independent of it. So Rust gets both:
 *
 *   - the text scan `measure:constructs` uses (`scripts/lib/construct-scan.ts`):
 *     every `B { .. }` written in a routine, read with no syntax tree and no
 *     compiler. Independent of the MIR half of the reader.
 *   - rustc's MIR, read here by its own line patterns rather than by
 *     `compiled-calls.ts`: every aggregate of B, and every call whose result
 *     is a B -- B's own function (`B::new`), a conversion (`into`, `clone`,
 *     `default`, `collect`), or any other call ("gets"). Independent of the
 *     text half, and of the code that parses the same dump for the reader.
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
  /**
   * How the referee says the routine comes by it. Everything but `gets` is
   * the routine creating it, and must never be accused: `new` / `literal` from
   * the TypeScript compiler, `written` from the Rust text scan, `aggregate`,
   * `own` (B's own function) and `conversion` from rustc's MIR.
   */
  how: "new" | "literal" | "written" | "aggregate" | "own" | "conversion" | "gets";
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

const RUST_TREES = ["anyhow", "clap", "json", "regex", "ripgrep"];
const TREES: Record<string, string[]> = { ts: Object.keys(TS_TREES), rust: RUST_TREES };
if (!TREES[language]) {
  process.stderr.write(`--language=${language}: not measured yet. ts and rust are wired.\n`);
  process.exit(1);
}

const results: ProjectResult[] = [];
const failed: string[] = [];
const self = fileURLToPath(import.meta.url);
for (const project of TREES[language]!) {
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
  const created = (key: string) => !key.startsWith("gets ");
  const sum = (keep: (key: string) => boolean) =>
    Object.entries(tally).filter(([key]) => keep(key)).reduce((total, [, count]) => total + count, 0);

  const createdPairs = sum(created);
  const wrong = results.flatMap((one) => one.wrong.map((pair) => `${one.project}: ${pair}`));
  const gets = sum((key) => key.startsWith("gets "));
  const caught = results.flatMap((one) => one.caught.map((pair) => `${one.project}: ${pair}`));

  console.log(`\n@builds absence, ${language}: ${results.length} project(s)`);
  console.log(`  pairs the compiler says the routine creates: ${createdPairs}`);
  console.log(`    called wrong by the checker: ${wrong.length}   <- must be 0`);
  for (const how of ["new", "literal", "written", "aggregate", "own", "conversion"]) {
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
  if (language === "rust") {
    const { pairs, referee } = await rustPairs(root);
    process.stderr.write(`${project}: ${pairs.length} pairs\n`);
    return askChecker(project, root, pairs, referee);
  }
  // Loaded here so the parent process never pays for the compiler.
  const ts = (await import("typescript")).default;
  const pairs = typescriptPairs(ts, root, TS_TREES[project] ?? []);
  process.stderr.write(`${project}: ${pairs.length} pairs\n`);
  return askChecker(project, root, pairs);
}

/**
 * The Rust referees: the text scan's constructions, and rustc's MIR read by
 * its own line patterns. The crates are built (or read from the cache) the
 * way the product builds them, and handed to the checker the same way.
 */
async function rustPairs(root: string): Promise<{ pairs: Pair[]; referee: import("../src/engine/drift").ClosedBodyReferee }> {
  const { readFileSync } = await import("node:fs");
  const { createHash } = await import("node:crypto");
  const { compileCrates, rustcCacheDir } = await import("../src/engine/referee-rustc");
  const { compiledBodiesOf } = await import("../src/engine/compiled-calls");
  const { initEngine, parseSource, each } = await import("../src/engine/parse");
  const { refereeRoutines } = await import("./lib/construct-scan");
  await initEngine();

  const skip = new Set(["target", ".git", "node_modules", "tests", "benches", "examples", "fuzz"]);
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const name of readdirSync(dir)) {
      if (skip.has(name)) continue;
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (name.endsWith(".rs")) out.push(full);
    }
    return out;
  };
  const absolute = walk(root);
  const files = absolute.map((one) => path.relative(root, one));
  const crates = await compileCrates(root, files, { until: Date.now() + 900_000 });
  const referee = {
    resolveReceiver: () => undefined,
    compiledCrateOf: (file: string) => crates.crateOf(file),
  };

  // Types declared once in the repository, and where.
  const sources = new Map<string, string>();
  const declared = new Map<string, string[]>();
  for (const file of files) {
    const source = readFileSync(path.join(root, file), "utf8");
    sources.set(file, source);
    const tree = parseSource(source, "rust");
    if (!tree) continue;
    each(tree.rootNode, (node) => {
      if (!/^(struct|enum)_item$/.test(node.type)) return;
      const name = node.childForFieldName("name")?.text;
      if (name) declared.set(name, [...(declared.get(name) ?? []), file]);
    });
  }
  const home = (name: string) => {
    const at = declared.get(name);
    return at && at.length === 1 ? at[0] : undefined;
  };

  // rustc's raw bodies, by printed path, closures folded into their function.
  const raw = new Map<string, string[][]>();  // printed path -> its bodies, closures apart
  const manifests = new Set<string>();
  for (const file of absolute) {
    for (let dir = path.dirname(file); dir.startsWith(root); dir = path.dirname(dir)) {
      if (existsSync(path.join(dir, "Cargo.toml"))) { manifests.add(path.join(dir, "Cargo.toml")); break; }
    }
  }
  for (const manifest of manifests) {
    const key = createHash("sha1").update(manifest).digest("hex").slice(0, 16);
    const dump = path.join(rustcCacheDir(), key, "calls.mir");
    if (!existsSync(dump)) continue;
    for (const [printed, lists] of rawBodies(readFileSync(dump, "utf8"))) {
      raw.set(printed, [...(raw.get(printed) ?? []), ...lists]);
    }
  }

  const rank: Pair["how"][] = ["gets", "conversion", "own", "written", "aggregate"];
  const found = new Map<string, Pair>();
  const note = (pair: Pair) => {
    const key = `${pair.from} -> ${pair.to}`;
    const was = found.get(key);
    if (!was || rank.indexOf(pair.how) > rank.indexOf(was.how)) found.set(key, pair);
  };

  for (const file of files) {
    const source = sources.get(file)!;
    // The text scan: every construction written in each routine.
    for (const routine of refereeRoutines(source, "rust")) {
      for (const made of routine.makes) {
        const at = home(made);
        if (at) note({ from: `${file}#${routine.name}`, to: `${at}#${made}`, how: "written", target: "struct" });
      }
    }
    // rustc's MIR for each routine the product can match to its body.
    const crate = crates.crateOf(file);
    if (!crate) continue;
    const tree = parseSource(source, "rust");
    if (!tree) continue;
    const routines = new Set<string>();
    each(tree.rootNode, (node) => {
      if (node.type === "function_item") {
        const name = node.childForFieldName("name")?.text;
        if (name) routines.add(name);
      }
    });
    for (const routine of routines) {
      const reading = compiledBodiesOf(crate, file, source, routine);
      if ("why" in reading) continue;
      const lists: string[][] = [];
      let unique = true;
      for (const body of reading.bodies) {
        const got = raw.get(body.path) ?? [];
        if (got.filter((one) => one[0] === "@@OWN").length !== 1) unique = false;
        else lists.push(...got);
      }
      if (!unique) continue;
      const makes = new Map<string, Pair["how"]>();
      for (const list of lists) {
        for (const [made, how] of mirMakes(list)) {
          const was = makes.get(made);
          if (!was || rank.indexOf(how) > rank.indexOf(was)) makes.set(made, how);
        }
      }
      for (const [made, how] of makes) {
        const at = home(made);
        if (at) note({ from: `${file}#${routine}`, to: `${at}#${made}`, how, target: "struct" });
      }
    }
  }
  return { pairs: [...found.values()], referee };
}

/**
 * Raw MIR per printed path: the function's own body first, then each closure
 * of it as a list of its own. The #360 probe's reading, with one fix: #360
 * folded a closure's lines into its function's, and MIR numbers locals per
 * body, so a closure's `_3` overwrote the function's `_3` and its type was
 * read off the wrong declaration (#362's `next -> Searcher`).
 */
function rawBodies(mir: string): Map<string, string[][]> {
  const out = new Map<string, string[][]>();
  let open: string[] | undefined;
  let skipping = false;
  let ctfe = false;
  for (const line of mir.split("\n")) {
    if (open || skipping) {
      if (line === "}") { open = undefined; skipping = false; } else open?.push(line);
      continue;
    }
    if (line.startsWith("// MIR FOR CTFE")) { ctfe = true; continue; }
    if (line.startsWith(" ") || line.startsWith("//") || !line.endsWith("{")) continue;
    const header = line.match(/^(?:const )?fn (.*)$/);
    if (!header || ctfe) { skipping = true; ctfe = false; continue; }
    const rest = header[1]!;
    let depth = 0;
    let cut = -1;
    for (let index = 0; index < rest.length; index += 1) {
      const char = rest[index]!;
      if ("<{[".includes(char)) depth += 1;
      else if (">}]".includes(char)) depth -= 1;
      else if (char === "(" && depth === 0) { cut = index; break; }
    }
    let printed = cut < 0 ? rest : rest.slice(0, cut);
    const nested = printed.search(/::\{[\w -]+#\d+\}/);
    if (nested >= 0) printed = printed.slice(0, nested);
    const lists = out.get(printed) ?? [];
    out.set(printed, lists);
    open = [];
    // The function's own body is marked, so a printed path rustc gave two
    // functions -- the ambiguity the caller refuses -- can be told apart from
    // one function with closures.
    if (nested < 0) open.push("@@OWN");
    lists.push(open);
  }
  return out;
}

/** What a routine's raw MIR creates, by type name, and how. */
function mirMakes(texts: string[]): Map<string, Pair["how"]> {
  const base = (type: string) =>
    type.replace(/^(&(mut )?|\*(const|mut) )+/, "").replace(/'\w+ /g, "").split("<")[0]!.split("::").pop()!.trim();
  const locals = new Map<string, string>();
  for (const line of texts) {
    const local = line.match(/^\s+let (?:mut )?_(\d+): (.+);$/);
    if (local) locals.set(local[1]!, local[2]!);
  }
  const rank: Pair["how"][] = ["gets", "conversion", "own", "aggregate"];
  const made = new Map<string, Pair["how"]>();
  const note = (name: string, how: Pair["how"]) => {
    const was = made.get(name);
    if (!was || rank.indexOf(how) > rank.indexOf(was)) made.set(name, how);
  };
  for (const line of texts) {
    if (!/ -> \[/.test(line)) {
      const aggregate = line.match(/^\s+(?:\(?\*?)?_\d+[^=]*= ((?:\w+::)*)(\w+)(?:::<[^;]*?>)?(?:::(\w+))?\s*[{(;]/);
      if (aggregate && !/^(move|copy|const)$/.test(aggregate[2]!)) note(aggregate[2]!, "aggregate");
      continue;
    }
    const call = line.match(/^\s+_(\d+) = (.+?) -> \[/);
    if (!call) continue;
    const type = locals.get(call[1]!);
    // A reference or a pointer handed back is somebody else's B, borrowed --
    // not one this routine created (#362: `build_ignore -> WalkBuilder`).
    if (!type || /^[&*]/.test(type)) continue;
    const name = base(type);
    const callee = call[2]!;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const own = new RegExp(`^(?:\\w+::)*${escaped}(?:::<.*?>)?::\\w+|^<(?:\\w+::)*${escaped}(?:<.*?>)? as `).test(callee);
    const conversion = /::(into|from|try_into|try_from|default|clone|collect|parse|to_owned|from_str|from_iter)(::<.*>)?\(/.test(callee);
    note(name, own ? "own" : conversion ? "conversion" : "gets");
  }
  return made;
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

  const rank: Pair["how"][] = ["gets", "literal", "new"];
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
async function askChecker(
  project: string,
  root: string,
  pairs: Pair[],
  referee?: import("../src/engine/drift").ClosedBodyReferee,
): Promise<ProjectResult> {
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
      const report = checkDrift(board, cache.workspace, {
        edges: true, cache, ...(referee ? { closedBodyReferee: referee } : {}),
      });
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
