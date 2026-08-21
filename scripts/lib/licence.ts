/**
 * Measuring the dependency reader against a referee that is not ours.
 *
 * A "wrong" verdict is an accusation: your arrow points the other way from your
 * code. It rests on two claims at once -- that B really does depend on A, and
 * that A really does not depend on B -- so both a false edge and a missing one
 * turn into a false accusation. A language does not get to make that accusation
 * until somebody has counted how often each happens, and the count is in the
 * repo.
 *
 * The referee here is the TypeScript compiler. That choice is the whole point.
 * `deps.ts` and the regex channel in `drift.ts` find specifiers differently but
 * both hand them to `resolve.ts` to turn into a file, so agreeing with each
 * other says nothing at all about the step they share -- and that shared step is
 * where the tsconfig nicknames live, which is exactly the part most likely to be
 * wrong. `ts.resolveModuleName` is the resolution the language actually defines,
 * written by people who were not us. Disagreeing with it is our bug by
 * definition.
 *
 * The referee also finds its own specifiers, with `ts.createSourceFile` rather
 * than our tree-sitter parse, so no part of the ground truth is borrowed from
 * the thing being measured.
 */
import { readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

import ts from "typescript";

import { readDependencies } from "../../src/engine/deps";
import { createWorkspace } from "../../src/engine/drift";
import { initEngine } from "../../src/engine/parse";

/** A `from -> to` pair, both repo-relative, both inside the repo. */
export type Edge = string;

export interface LicenceMeasurement {
  root: string;
  /** Files both sides looked at. */
  files: string[];
  /** Source files the reader has no grammar for, and is silent about by design. */
  skipped: string[];
  /** Files too large to be anybody's source; excluded, but counted out loud. */
  oversized: string[];
  refereeEdges: Set<Edge>;
  ourEdges: Set<Edge>;
  /** The referee found it, we did not. An absence we would wrongly believe. */
  missed: Edge[];
  /** We found it, the referee did not. An edge we would wrongly assert. */
  invented: Edge[];
  /** Files tree-sitter recovered from, where nothing can be proved absent. */
  incomplete: string[];
  /** Files that reach out at runtime, which a verdict already refuses to use. */
  dynamic: string[];
}

const SKIP_DIRECTORIES = new Set([
  "node_modules", ".git", "dist", "build", "coverage", ".next", ".nuxt",
  ".output", ".turbo", ".yarn", ".cache", "out", "vendor",
]);

/** Everything the reader claims a grammar for. */
const SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

/** Above this, it is generated. Minified output measures nothing about reading code. */
const TOO_LARGE = 1_000_000;

function sourceFiles(root: string): { files: string[]; oversized: string[] } {
  const files: string[] = [];
  const oversized: string[] = [];
  const walk = (directory: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(directory);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.startsWith(".") && entry !== ".") continue;
      if (SKIP_DIRECTORIES.has(entry)) continue;
      const full = path.join(directory, entry);
      let info;
      try {
        info = statSync(full);
      } catch {
        continue;
      }
      const relative = path.relative(root, full).split(path.sep).join("/");
      if (info.isDirectory()) walk(full);
      else if (SOURCE.test(entry)) {
        if (info.size > TOO_LARGE) oversized.push(relative);
        else files.push(relative);
      }
    }
  };
  walk(root);
  return { files: files.sort(), oversized: oversized.sort() };
}

/*
 * Compiler options, per directory.
 *
 * The nearest enclosing tsconfig wins, which is how every editor and bundler
 * behaves and the only reading that survives a monorepo -- a package's `paths`
 * are meaningless to its sibling. Walking up from each file and caching by
 * directory costs one config parse per package instead of one per file.
 */
function optionsFinder(root: string): (file: string) => ts.CompilerOptions {
  const byDirectory = new Map<string, ts.CompilerOptions>();

  const parse = (configPath: string): ts.CompilerOptions => {
    const read = ts.readConfigFile(configPath, ts.sys.readFile);
    if (read.error || !read.config) return {};
    const parsed = ts.parseJsonConfigFileContent(
      read.config,
      ts.sys,
      path.dirname(configPath),
      undefined,
      configPath,
    );
    return parsed.options;
  };

  return (file: string): ts.CompilerOptions => {
    let directory = path.dirname(path.resolve(root, file));
    const seen: string[] = [];
    for (;;) {
      const cached = byDirectory.get(directory);
      if (cached) {
        for (const each of seen) byDirectory.set(each, cached);
        return cached;
      }
      seen.push(directory);
      for (const name of ["tsconfig.json", "jsconfig.json"]) {
        const candidate = path.join(directory, name);
        if (ts.sys.fileExists(candidate)) {
          const options = parse(candidate);
          for (const each of seen) byDirectory.set(each, options);
          return options;
        }
      }
      const parent = path.dirname(directory);
      if (parent === directory || !directory.startsWith(root)) break;
      directory = parent;
    }
    for (const each of seen) byDirectory.set(each, {});
    return {};
  };
}

/*
 * Declaration files, mapped back to the code they describe.
 *
 * `scripts/lib/box.mjs` ships a hand-written `box.d.mts` beside it. Both sides
 * are right about a different question: asked where `./lib/box.mjs` leads, the
 * compiler answers with the types, because types are what a compiler is for,
 * and the reader answers with the module, because a box on a board is a piece
 * of code. Counting that as a miss would licence nothing and teach the reader
 * to point at a file nobody would ever draw. So the referee's answer is moved
 * to the implementation when one sits beside it -- the only place the two are
 * reconciled, and the reason it is written down here.
 */
const DECLARATION = /\.d\.(m|c)?ts$/;

function implementationFor(declaration: string): string | undefined {
  const stem = declaration.replace(/\.d\.(m|c)?ts$/, "");
  const suffix = declaration.match(DECLARATION)?.[1] ?? "";
  const candidates = suffix
    ? [`${stem}.${suffix}js`, `${stem}.${suffix}ts`]
    : [`${stem}.ts`, `${stem}.tsx`, `${stem}.js`, `${stem}.jsx`];
  return candidates.find((candidate) => ts.sys.fileExists(candidate));
}

function scriptKind(file: string): ts.ScriptKind {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (file.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.(js|mjs|cjs)$/.test(file)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/**
 * Every specifier the compiler's own parser sees, in the forms a dependency can
 * take. Only string literals: a computed specifier is not knowable statically to
 * anybody, so neither side is allowed to guess at one.
 */
function refereeSpecifiers(file: string, text: string): string[] {
  const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, scriptKind(file));
  const found: string[] = [];

  const literal = (node: ts.Node | undefined): void => {
    if (node && ts.isStringLiteralLike(node)) found.push(node.text);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      literal(node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      literal(node.moduleReference.expression);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      literal(node.argument.literal);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(callee) && callee.text === "require";
      if (isImport || isRequire) literal(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };

  visit(tree);
  return found;
}

/** The reader and the compiler over the same tree, edge for edge. */
export async function measureLicence(root: string): Promise<LicenceMeasurement> {
  /*
   * Real path, not the one given. `ts.resolveModuleName` answers in real paths,
   * so a root reached through a symlink made every resolution look like it
   * landed outside the repository and the referee found almost nothing --
   * silently, and in the direction that flatters the reader.
   */
  const ROOT = realpathSync(path.resolve(root));
  await initEngine();
  const workspace = createWorkspace(ROOT);
  const { files, oversized } = sourceFiles(ROOT);
  const optionsFor = optionsFinder(ROOT);

  const refereeEdges = new Set<Edge>();
  const ourEdges = new Set<Edge>();
  const skipped: string[] = [];
  const incomplete: string[] = [];
  const dynamic: string[] = [];
  const configs = new Map();
  const measured: string[] = [];

  /** Only what a board could draw: files of this repo, that we would also read. */
  const inside = new Set(files);

  for (const file of files) {
    const absolute = workspace.resolve(file);
    if (!absolute || workspace.stat(absolute) !== "file") continue;
    let source: string;
    try {
      source = workspace.read(absolute);
    } catch {
      continue;
    }
    measured.push(file);

    const read = readDependencies(file, source, workspace, configs);
    if (!read) {
      /*
       * No grammar. The referee's edges out of this file are dropped with it --
       * silence by design is not a miss -- so the count above has to stay at
       * zero for the licence to mean anything, and the script prints it.
       */
      skipped.push(file);
      continue;
    }

    const options = optionsFor(file);
    for (const specifier of refereeSpecifiers(file, source)) {
      /*
       * `allowJs` is forced on. Without it the compiler declines to resolve a
       * specifier that lands on a `.js` file at all, because it would not be
       * compiling one -- which is an answer about the compiler's job, not about
       * where the import points, and it showed up as the reader inventing an
       * edge that was plainly there in the text.
       */
      const resolved = ts.resolveModuleName(
        specifier,
        absolute,
        { ...options, allowJs: true },
        ts.sys,
      ).resolvedModule;
      if (!resolved || resolved.isExternalLibraryImport) continue;
      let resolvedFile = resolved.resolvedFileName;
      if (DECLARATION.test(resolvedFile)) {
        const implementation = implementationFor(resolvedFile);
        if (implementation) resolvedFile = implementation;
      }
      const target = path.relative(ROOT, resolvedFile).split(path.sep).join("/");
      if (inside.has(target)) refereeEdges.add(`${file} -> ${target}`);
    }
    if (!read.complete) incomplete.push(file);
    if (read.dynamic.length > 0) dynamic.push(file);
    for (const dependency of read.dependencies) {
      if (dependency.file && inside.has(dependency.file)) ourEdges.add(`${file} -> ${dependency.file}`);
    }
  }

  return {
    root: ROOT,
    files: measured,
    skipped,
    oversized,
    refereeEdges,
    ourEdges,
    missed: [...refereeEdges].filter((edge) => !ourEdges.has(edge)).sort(),
    invented: [...ourEdges].filter((edge) => !refereeEdges.has(edge)).sort(),
    incomplete,
    dynamic,
  };
}
