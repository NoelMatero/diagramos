/**
 * The answer key for `measure:reach`: a call graph built by a real compiler,
 * sharing nothing with the reader it judges.
 *
 * The question `measure:reach` asks is whether one routine reaches another
 * through a chain of calls. Answering it needs two things this repository's
 * engine also computes -- where a routine's body starts and ends, and which
 * routine each call inside it lands on -- so a referee that borrowed either
 * would be grading the reader against itself. Hence:
 *
 *   typescript   `ts.Program` end to end. Routines are the compiler's own
 *                function-like declarations (methods included, which is the
 *                one thing `call-scan.ts` cannot see), call sites are its
 *                `CallExpression` nodes, and each one is resolved with
 *                `checker.getResolvedSignature`. No tree-sitter, no
 *                `resolve.ts`, no `deps.ts`.
 *   python       `call-scan.ts`'s text referee for the routines and the call
 *                sites -- it finds a `def` by the shape of its opening line
 *                and resolves nothing -- and pyright's "go to definition" for
 *                where each one lands.
 *   rust         the same text referee, and rust-analyzer for the landings.
 *
 * ## Expanded lazily, and that is the whole feasibility argument
 *
 * A complete call graph over `django-django` is hundreds of thousands of
 * language-server round trips. Nobody needs one: a reach question only ever
 * touches the routines forward of its own start, so a node's successors are
 * resolved the first time somebody asks for them and remembered after. A
 * closure that runs past `NODE_BUDGET` stops and says so.
 *
 * ## `complete`, which is the only reason a negative answer exists
 *
 * A path the referee finds is a path. A path it fails to find is not an
 * absence -- unless every call on the way was resolved, which is what
 * `complete` records per node. A closure of complete nodes that does not
 * contain the far end is the one shape entitled to say "does not reach", and
 * `measure:reach` draws its negative population from nowhere else.
 *
 * Even then it is static-call reach and no more. A callback handed out of the
 * closure, a `getattr`, a trait object: none of those is a call site anybody
 * can resolve, and the benchmark's own extra guard (the far end's name absent
 * from every file in the closure) is what stands in for them.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import ts from "typescript";

import { languageOf, type Language } from "../../src/engine/parse";

import { callSitesOn, checkerFor, type CallChecker } from "./call-receivers";
import { refereeRoutines, stripNoise } from "./call-scan";
import { sourceFiles } from "./source-files";

/** One routine the referee recognises. `file` is repo-relative, `line` 1-based. */
export interface RefereeNode {
  file: string;
  name: string;
  line: number;
}

/** `file#name@line`. Line included because one name can open twice in a file. */
export type NodeId = string;

export const idOf = (node: RefereeNode): NodeId => `${node.file}#${node.name}@${node.line}`;

/** What the referee found when it read one routine's calls. */
export interface Expansion {
  /** Routines in this tree that a call in the body provably lands on. */
  out: NodeId[];
  /** Call sites read in the body. */
  sites: number;
  /**
   * Sites the referee could not land anywhere: no answer from the checker, or
   * an answer naming a declaration that is not a routine it knows. Every one
   * of these is a successor that might exist, so a node with any is never part
   * of a negative answer.
   */
  unresolved: number;
  /** Sites landing provably outside the tree. Resolved, and terminal. */
  external: number;
}

export interface RefereeGraph {
  nodes: Map<NodeId, RefereeNode>;
  /** Routine ids declared in one repo-relative file. */
  byFile: Map<string, NodeId[]>;
  expand(id: NodeId): Promise<Expansion>;
  /** Which checker answered, at which version -- printed beside the number. */
  label: string;
  close(): void;
}

/* --------------------------------------------------------------- typescript */

const TS_EXTENSIONS = new Set<Language>(["ts", "tsx", "js"]);

/** Whether a declaration is a routine with a body somebody could draw a box on. */
function functionLike(node: ts.Node): node is ts.SignatureDeclaration & { body: ts.Node } {
  return (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)
    || ts.isFunctionExpression(node) || ts.isArrowFunction(node)
    || ts.isConstructorDeclaration(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node))
    && (node as { body?: ts.Node }).body !== undefined;
}

/**
 * The name a routine is drawn under.
 *
 * An arrow function has none of its own, so the variable or property it is
 * assigned to is its name -- `const render = () => ..` is a box called
 * `render` to anybody reading the file, and leaving it nameless would drop
 * most of a modern TypeScript codebase out of the population.
 */
function nameOfTs(node: ts.Node): string | undefined {
  const own = (node as { name?: ts.Node }).name;
  if (own && ts.isIdentifier(own)) return own.text;
  if (own && ts.isStringLiteral(own)) return own.text;
  const parent = node.parent;
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if (parent && ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if (parent && ts.isPropertyDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  return undefined;
}

const DEFAULT_OPTIONS: ts.CompilerOptions = {
  allowJs: true,
  skipLibCheck: true,
  noEmit: true,
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.Preserve,
};

/**
 * One program over the whole tree, deliberately unlike `resolution-ts.ts`'s
 * program-per-package.
 *
 * A reach chain crosses packages -- that is most of what makes it multi-step --
 * and a per-package program cannot resolve the call that leaves its package,
 * so every such call would read as unresolved and every closure as leaky. The
 * cost is that a monorepo's per-package `paths` are not all in force at once;
 * what that shows up as is an unresolved site, which the benchmark counts and
 * never reads as an absence.
 */
function tsProgram(tree: string): ts.Program {
  const files = sourceFiles(tree).filter((file) => TS_EXTENSIONS.has(languageOf(file)!));
  const config = ts.findConfigFile(tree, ts.sys.fileExists);
  let options = DEFAULT_OPTIONS;
  if (config && config.startsWith(tree)) {
    const read = ts.readConfigFile(config, ts.sys.readFile);
    if (!read.error && read.config) {
      const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(config));
      options = { ...parsed.options, allowJs: true, skipLibCheck: true, noEmit: true, jsx: ts.JsxEmit.Preserve };
    }
  }
  return ts.createProgram(files, options);
}

function typescriptGraph(tree: string): RefereeGraph {
  const program = tsProgram(tree);
  const checker = program.getTypeChecker();
  const nodes = new Map<NodeId, RefereeNode>();
  const byFile = new Map<string, NodeId[]>();
  /** The compiler node each routine was found at, so its calls can be walked later. */
  const declarationOf = new Map<NodeId, { node: ts.Node; source: ts.SourceFile }>();
  /** Routine id by absolute file and 1-based opening line, for landing a call. */
  const atLine = new Map<string, NodeId>();

  const inTree = (file: string): boolean =>
    !file.includes(`${path.sep}node_modules${path.sep}`)
    && !file.endsWith(".d.ts")
    && file.startsWith(tree + path.sep);

  for (const source of program.getSourceFiles()) {
    if (!inTree(source.fileName)) continue;
    const rel = path.relative(tree, source.fileName);
    const here: NodeId[] = [];
    const walk = (node: ts.Node): void => {
      if (functionLike(node)) {
        const name = nameOfTs(node);
        if (name) {
          const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
          const id = idOf({ file: rel, name, line });
          if (!nodes.has(id)) {
            nodes.set(id, { file: rel, name, line });
            here.push(id);
            declarationOf.set(id, { node, source });
            atLine.set(`${source.fileName}:${line}`, id);
          }
        }
      }
      ts.forEachChild(node, walk);
    };
    ts.forEachChild(source, walk);
    byFile.set(rel, here);
  }

  /**
   * The declaration a call lands on, through however many aliases.
   *
   * `getResolvedSignature` first, because it is the compiler's own answer to
   * exactly this question and it sees through overloads. A symbol lookup is
   * the fallback for the shapes it declines -- a call on a value whose type is
   * a call signature, mostly -- and `getAliasedSymbol` is what follows an
   * `import { x }` to what `x` actually is.
   */
  const landingOfCall = (call: ts.CallExpression): ts.Declaration[] | undefined => {
    const signature = checker.getResolvedSignature(call);
    if (signature?.declaration) return [signature.declaration];
    let symbol = checker.getSymbolAtLocation(call.expression);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
      try { symbol = checker.getAliasedSymbol(symbol); } catch { /* not an alias after all */ }
    }
    const declarations = symbol?.declarations;
    return declarations && declarations.length > 0 ? [...declarations] : undefined;
  };

  const expansions = new Map<NodeId, Expansion>();

  const expand = async (id: NodeId): Promise<Expansion> => {
    const cached = expansions.get(id);
    if (cached) return cached;
    const found: Expansion = { out: [], sites: 0, unresolved: 0, external: 0 };
    expansions.set(id, found);
    const declaration = declarationOf.get(id);
    if (!declaration) { found.unresolved += 1; return found; }
    const { node, source } = declaration;
    const out = new Set<NodeId>();

    const body = (node as { body?: ts.Node }).body;
    const walk = (current: ts.Node): void => {
      if (ts.isCallExpression(current) || ts.isNewExpression(current)) {
        found.sites += 1;
        const landings = ts.isCallExpression(current) ? landingOfCall(current) : undefined;
        if (!landings) {
          // A `new Foo()` is not a call to a routine in any of these grammars,
          // and neither the reader nor this referee treats it as one -- but a
          // constructor body does run, so it is counted as a site whose
          // successor is unknown rather than ignored.
          found.unresolved += 1;
        } else {
          let placed = false;
          for (const landed of landings) {
            const file = landed.getSourceFile().fileName;
            if (!inTree(file)) { placed = true; found.external += 1; continue; }
            const line = landed.getSourceFile()
              .getLineAndCharacterOfPosition(landed.getStart(landed.getSourceFile())).line + 1;
            const target = atLine.get(`${file}:${line}`);
            if (target) { out.add(target); placed = true; continue; }
            /*
             * In the tree, and not a routine this referee knows: a class, an
             * interface, a plain variable. A call landing on a class is `new`
             * in disguise and its constructor body is a successor nothing here
             * can name, so it counts as a leak rather than as terminal.
             */
          }
          if (!placed) found.unresolved += 1;
        }
      }
      ts.forEachChild(current, walk);
    };
    if (body) ts.forEachChild(body, walk);
    else found.unresolved += 1;
    found.out = [...out];
    return found;
  };

  return {
    nodes,
    byFile,
    expand,
    label: `tsc ${ts.version}`,
    close: () => {},
  };
}

/* ----------------------------------------------------------- python / rust */

/**
 * The scan-and-checker graph, for the two languages with no in-process
 * compiler: the text referee names the routines and the call sites, and a
 * language server says where each one lands.
 */
async function scannedGraph(tree: string, language: Language): Promise<RefereeGraph> {
  const files = sourceFiles(tree).filter((file) => languageOf(file) === language);
  const nodes = new Map<NodeId, RefereeNode>();
  const byFile = new Map<string, NodeId[]>();
  const atLine = new Map<string, NodeId>();
  const sources = new Map<string, string>();
  /** Call sites per routine, from the text referee. */
  const callsOf = new Map<NodeId, Array<{ name: string; line: number; via: "bare" | "receiver" }>>();

  for (const absolute of files) {
    const rel = path.relative(tree, absolute);
    let source: string;
    try { source = readFileSync(absolute, "utf8"); } catch { continue; }
    sources.set(rel, source);
    const here: NodeId[] = [];
    for (const routine of refereeRoutines(source, language)) {
      const node = { file: rel, name: routine.name, line: routine.line };
      const id = idOf(node);
      if (nodes.has(id)) continue;
      nodes.set(id, node);
      here.push(id);
      atLine.set(`${absolute}:${routine.line}`, id);
      const seen = new Map<string, { name: string; line: number; via: "bare" | "receiver" }>();
      for (const call of routine.calls) {
        if (call.construction) continue;
        const key = `${call.name}:${call.line}`;
        if (!seen.has(key)) seen.set(key, { name: call.name, line: call.line, via: call.via });
      }
      callsOf.set(id, [...seen.values()]);
    }
    byFile.set(rel, here);
  }

  const made = await checkerFor(tree, language);
  const checker: CallChecker | undefined = "unavailable" in made ? undefined : made;
  const why = "unavailable" in made ? made.unavailable : undefined;
  const expansions = new Map<NodeId, Expansion>();

  const expand = async (id: NodeId): Promise<Expansion> => {
    const cached = expansions.get(id);
    if (cached) return cached;
    const found: Expansion = { out: [], sites: 0, unresolved: 0, external: 0 };
    expansions.set(id, found);
    const node = nodes.get(id);
    const calls = callsOf.get(id);
    if (!node || !calls || !checker) {
      found.unresolved += 1;
      return found;
    }
    const source = sources.get(node.file)!;
    const absolute = path.join(tree, node.file);
    const out = new Set<NodeId>();
    for (const call of calls) {
      found.sites += 1;
      const sites = callSitesOn(source, call.line, call.name, call.via, language);
      if (sites.length === 0) { found.unresolved += 1; continue; }
      let placed = false;
      let leaked = false;
      for (const site of sites) {
        const answer = await checker.definitionAt(absolute, source, site);
        if (!answer) { leaked = true; continue; }
        if (!answer.file.startsWith(tree + path.sep)) { placed = true; found.external += 1; continue; }
        const target = atLine.get(`${answer.file}:${answer.line + 1}`);
        if (target) { out.add(target); placed = true; continue; }
        /*
         * The checker named a declaration in this tree that the text referee
         * does not read as a routine -- a class, a constant, a decorator's
         * target. Its body, if it has one, is a successor nothing here can
         * name, so the site leaks.
         */
        leaked = true;
      }
      // One unanswered site among several is still a successor nobody can
      // name, so a partly-answered site leaks exactly as a silent one does.
      if (leaked || !placed) found.unresolved += 1;
    }
    found.out = [...out];
    return found;
  };

  return {
    nodes,
    byFile,
    expand,
    label: checker ? checker.label : `no checker (${why})`,
    close: () => checker?.close(),
  };
}

/** The referee for one tree in one language. */
export async function refereeGraph(tree: string, language: Language): Promise<RefereeGraph> {
  if (!existsSync(tree)) throw new Error(`no tree at ${tree}`);
  if (TS_EXTENSIONS.has(language)) return typescriptGraph(tree);
  return scannedGraph(tree, language);
}

/** Whether any file in a set writes a name at all -- the callback guard. */
export function namedAnywhere(
  name: string,
  files: Iterable<string>,
  tree: string,
  language: Language,
): boolean {
  const pattern = new RegExp(`(?<![\\w$])${name.replace(/[$]/g, "\\$")}(?![\\w$])`);
  for (const file of files) {
    let source: string;
    try { source = readFileSync(path.join(tree, file), "utf8"); } catch { continue; }
    if (pattern.test(stripNoise(source, language))) return true;
  }
  return false;
}
