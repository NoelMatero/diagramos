/**
 * The TypeScript referee for #227: what `tsc` itself says a receiver's type
 * is, asked at the exact position the reader asked about.
 *
 * Unlike `licence.ts`, which compares two *edge sets*, this compares two
 * *opinions about one expression* -- so the referee has to be handed the same
 * node the reader looked at, not a name it re-derives. `resolveReceiversIn`
 * already records the receiver's exact byte range as written at the call site
 * (`ReceiverSite.at`); this file's whole job is finding the `ts.Node` that
 * occupies that same range and asking the checker what it is.
 *
 * One `ts.Program` per tree, built from the tree's own `tsconfig.json` when it
 * has one -- the same nearest-config discovery `licence.ts` uses, because a
 * receiver's real type depends on the same path aliases an import does. A
 * fresh `ts.Program` per file would repeat the same whole-project type-check
 * for every file in it; one per tree asks the compiler once and queries it
 * many times, which is what makes measuring a real corpus affordable at all.
 */
import { readdirSync, statSync } from "node:fs";
import path from "node:path";

import ts from "typescript";

export interface TsTypeAnswer {
  /** `checker.typeToString`, exactly as the compiler would print it. */
  text: string;
  /** The head of that string -- the part a resolver's own head-name is compared to. */
  head: string;
}

export interface TsReferee {
  /** `undefined` when no node in the program spans exactly this range: the file was not part of the program, or the range does not land on an expression the checker has an opinion about (whitespace, a comment, a syntax error). */
  typeAt(file: string, start: number, end: number): TsTypeAnswer | undefined;
}

const SKIP_DIRECTORIES = new Set([
  "node_modules", ".git", "dist", "build", "coverage", ".next", ".nuxt",
  ".output", ".turbo", ".yarn", ".cache", "out", "vendor",
]);
const SOURCE = /\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/;

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (directory: string): void => {
    let entries: string[];
    try { entries = readdirSync(directory); } catch { return; }
    for (const entry of entries) {
      if (entry.startsWith(".") && entry !== ".") continue;
      if (SKIP_DIRECTORIES.has(entry)) continue;
      const full = path.join(directory, entry);
      let info;
      try { info = statSync(full); } catch { continue; }
      if (info.isDirectory()) walk(full);
      else if (SOURCE.test(entry) && info.size <= 1_000_000) files.push(full);
    }
  };
  walk(root);
  return files;
}

/**
 * The head of a **TypeScript** type string, in `checker.typeToString`'s own
 * printed form.
 *
 * Not shared with `headOfPython` in this same file on purpose, even though
 * both exist to answer the same question: the two printers use `[` for
 * unrelated things. TypeScript's compiler never prints `Array<Foo>` -- its
 * canonical form for an array is the postfix `Foo[]`, and for
 * `ReadonlyArray<Foo>` it is `readonly Foo[]`; pyright's `[` is a generic
 * argument list, `list[Node]`, the same role TypeScript's `<...>` plays.
 * Splitting on `[` here to catch a TypeScript array truncated `Foo[]` at the
 * bracket and left the element name behind; splitting on it for Python
 * dropped the bracket TypeScript never has and returned the whole
 * `list[Node]` unsplit. `measure:resolution`'s first full run hit both, in
 * opposite directions, from the same shared function -- which is the reason
 * there are two now.
 *
 * An inline object type (`{ board: string; ... }`) is reported as `Object`
 * for the same reason a bracket split is wrong for it: splitting on the
 * first `[` or `<` found *inside* one, rather than only at the top level,
 * truncated the string mid-field and called the result a disagreement with a
 * real type.
 */
export function headOfTs(typeText: string): string {
  // `import("/abs/path").Config` -- the compiler's own way of naming a type it
  // had to resolve through a module, printed whenever the type is not in
  // scope by its bare name at the position asked. The name after the dot is
  // what a person would call it.
  const qualified = typeText.match(/^import\([^)]*\)\.(.+)$/);
  const text = (qualified ? qualified[1]! : typeText).trim();
  if (/^readonly\s+.*\[\]$/.test(text)) return "ReadonlyArray";
  if (/\[\]$/.test(text)) return "Array";
  if (text.startsWith("{")) return "Object";
  if (text.startsWith("[")) return "Array"; // a tuple, which is one at runtime.
  return text.split(/[<(]/)[0]!.trim();
}

/**
 * The head of a **pyright** type string -- `list[Node]`, `Dict[str, Row]`,
 * `Config`. Pyright's generic argument list is bracketed the way
 * TypeScript's is angled, so the split includes `[` here and must not
 * include it in `headOfTs`. See that function's doc for why they are not one.
 */
export function headOfPython(typeText: string): string {
  return typeText.trim().split(/[<[(]/)[0]!.trim();
}

/** One program per tree, built from its own `tsconfig.json` when there is one. */
export function createTsReferee(root: string): TsReferee {
  const configPath = ts.findConfigFile(root, ts.sys.fileExists, "tsconfig.json");
  let options: ts.CompilerOptions = {
    allowJs: true, checkJs: false, target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true, noEmit: true, jsx: ts.JsxEmit.Preserve,
  };
  let rootNames = sourceFiles(root);

  if (configPath) {
    const read = ts.readConfigFile(configPath, ts.sys.readFile);
    if (!read.error && read.config) {
      const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(configPath));
      options = { ...parsed.options, allowJs: true, skipLibCheck: true, noEmit: true };
      if (parsed.fileNames.length > 0) rootNames = parsed.fileNames;
    }
  }

  const program = ts.createProgram(rootNames, options);
  const checker = program.getTypeChecker();

  function typeAt(file: string, start: number, end: number): TsTypeAnswer | undefined {
    const sourceFile = program.getSourceFile(file);
    if (!sourceFile) return undefined;
    const node = findNodeAt(sourceFile, start, end);
    if (!node) return undefined;
    let type: ts.Type;
    try {
      type = checker.getTypeAtLocation(node);
    } catch {
      return undefined;
    }
    const text = checker.typeToString(type, node, ts.TypeFormatFlags.NoTruncation);
    return { text, head: headOfTs(text) };
  }

  return { typeAt };
}

/**
 * The smallest node in `sourceFile` whose own range is exactly `[start, end)`,
 * ignoring surrounding trivia -- comments and whitespace are not what the
 * reader pointed at.
 *
 * Descends only into a node that *contains* the target range, so a large file
 * costs one walk down its own nesting rather than a walk of the whole tree.
 */
function findNodeAt(sourceFile: ts.SourceFile, start: number, end: number): ts.Node | undefined {
  let found: ts.Node | undefined;
  const visit = (node: ts.Node): void => {
    const nodeStart = node.getStart(sourceFile);
    const nodeEnd = node.getEnd();
    if (nodeStart > start || nodeEnd < end) return;
    if (nodeStart === start && nodeEnd === end) found = node;
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}
