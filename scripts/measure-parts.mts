#!/usr/bin/env node
/**
 * How often "this end lacks a body / signature / result / field list / base
 * list" is wrong, measured before any of it may go red (#297).
 *
 *   npm run measure:parts -- /Users/noelmatero/board-ai/.corpus/*
 *   npm run measure:parts -- <tree>... [--only=rust|python|ts] [--show=20]
 *
 * `parts.ts` reads each declaration's shape from tree-sitter fields. The
 * referees read the same names another way entirely:
 *
 *   TypeScript, TSX, JavaScript   the TypeScript compiler's own syntax tree
 *   Rust                          rust-analyzer, `textDocument/documentSymbol`
 *   Python                        pyright, `textDocument/documentSymbol`
 *
 * Every name a file declares is read once by `partsOf`, the call `drift.ts`
 * makes, and once by the referee over every declaration of that name in that
 * file. Four outcomes per part, and only one of them is expensive:
 *
 *   wrong lacks     the reader says "lacks", the referee says "has" -- a
 *                   false red waiting to happen. Any at all, and that part
 *                   may not accuse in that language.
 *   unrefereed      the reader says "lacks" and the referee cannot say.
 *                   Not proven wrong, not proven right, so it blocks too.
 *   agreed lacks    both say "lacks": the reds this is for.
 *   missed          the referee says "lacks" and the reader does not.
 *                   Costs a red that never fires, nothing more.
 *
 * A run is a measurement, not a test: it prints and never fails.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

import { sourceFiles } from "./lib/source-files";
import { flatten, literalValue, refereeParts, writtenTypeCallable, type RefereeReading } from "./lib/lsp-symbols";
import { createRustAnalyzerReferee } from "./lib/resolution-rust-lsp";
import { createPyrightLspReferee } from "./lib/resolution-python-lsp";

import { initEngine, languageOf, type Language } from "../src/engine/parse";
import { declaredShapes } from "../src/engine/body";
import { PARTS, partsOf, type Part } from "../src/engine/parts";

await initEngine();

const args = process.argv.slice(2);
const roots = args.filter((argument) => !argument.startsWith("--")).map((root) => path.resolve(root));
const only = args.find((argument) => argument.startsWith("--only="))?.slice(7);
const show = Number(args.find((argument) => argument.startsWith("--show="))?.slice(7) ?? 15);
if (roots.length === 0) {
  console.error("usage: measure-parts <tree>... [--only=rust|python|ts]");
  process.exit(1);
}

type Family = "ts" | "rust" | "python";
const familyOf = (language: Language): Family =>
  language === "rust" ? "rust" : language === "python" ? "python" : "ts";

type Outcome = "wrong" | "unrefereed" | "agreed" | "missed" | "agreedHas" | "wrongHas";
const tally = new Map<string, Record<Outcome, number>>();
const names = new Map<Language, { read: number; refereed: number }>();
const examples = new Map<string, string[]>();
const bump = (language: Language, part: Part, outcome: Outcome, example?: string) => {
  const key = `${language}\t${part}`;
  const row = tally.get(key) ?? { wrong: 0, unrefereed: 0, agreed: 0, missed: 0, agreedHas: 0, wrongHas: 0 };
  row[outcome] += 1;
  tally.set(key, row);
  if (example) {
    const list = examples.get(`${key}\t${outcome}`) ?? [];
    list.push(example);
    examples.set(`${key}\t${outcome}`, list);
  }
};

/** A 0-based line for a string offset, the way the engine counts offsets. */
const lineStarts = new Map<string, number[]>();
const lineAt = (source: string, offset: number) => {
  let starts = lineStarts.get(source);
  if (!starts) {
    starts = [0];
    for (let index = 0; index < source.length; index += 1) {
      if (source.charCodeAt(index) === 10) starts.push(index + 1);
    }
    lineStarts.clear();
    lineStarts.set(source, starts);
  }
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (starts[middle]! <= offset) low = middle; else high = middle - 1;
  }
  return low;
};

/** One split per source, reused: these files are read name by name. */
const splitCache = new Map<string, string[]>();
function linesOf(source: string): string[] {
  const cached = splitCache.get(source);
  if (cached) return cached;
  const lines = source.split("\n");
  splitCache.clear();
  splitCache.set(source, lines);
  return lines;
}

type RefereeByLine = Map<string, Record<Part, RefereeReading>>;

/** How many declarations the second, text referee had to answer for. */
let byText = 0;

/** Score one file, given what the referee says about each (line, name). */
function score(
  file: string, source: string, language: Language,
  referee: RefereeByLine | undefined,
  refereeRan = true,
  implemented?: ReadonlySet<string>,
) {
  const shapes = declaredShapes(source, language);
  if (!shapes) return;
  const counts = names.get(language) ?? { read: 0, refereed: 0 };
  names.set(language, counts);
  for (const [name, declarations] of shapes) {
    const ours = partsOf(source, name, language);
    if (!ours) continue;
    counts.read += 1;
    const theirs = declarations.map(({ nameNode }) => {
      const line = lineAt(source, nameNode.startIndex);
      const listed = referee?.get(`${line}\t${name}`);
      if (!refereeRan) return listed;
      const answered = listed && PARTS.filter((part) => listed[part] !== "unknown").length;
      if (answered && PARTS.every((part) => listed![part] !== "unknown")) return listed;
      /*
       * Part by part rather than all or nothing (#337). A server that files a
       * name as a variable has answered "not a type" and said nothing about
       * calling it -- pyright's range for one covers the name and not the
       * annotation -- and before this the half-answer kept the line from
       * being read at all.
       */
      const text = declaringLine(source, line, name, language);
      if (!text) return listed;
      if (!listed) { byText += 1; return text; }
      byText += 1;
      const merged = { ...listed };
      for (const part of PARTS) if (merged[part] === "unknown") merged[part] = text[part];
      return merged;
    });
    if (implemented) {
      /*
       * A Rust type's code is its `impl` blocks, which sit outside the type and
       * may be in any file of the crate (#299, found by #301's test set). So a
       * type has a body when one is in sight here, and otherwise nobody can say.
       */
      for (let index = 0; index < theirs.length; index += 1) {
        const reading = theirs[index];
        if (reading && reading.signature === "lacks" && reading.body === "lacks") {
          theirs[index] = { ...reading, body: implemented.has(name) ? "has" : "unknown" };
        }
      }
    }
    if (theirs.some((one) => one !== undefined)) counts.refereed += 1;
    const where = `${file}:${lineAt(source, declarations[0]!.nameNode.startIndex) + 1} ${name}`;
    for (const part of PARTS) {
      const readings = theirs.map((one) => one?.[part] ?? "unknown");
      const verdict: RefereeReading = readings.some((one) => one === "has")
        ? "has"
        : readings.every((one) => one === "lacks") ? "lacks" : "unknown";
      if (ours[part] === "lacks") {
        bump(language, part, verdict === "has" ? "wrong" : verdict === "lacks" ? "agreed" : "unrefereed",
          verdict === "lacks" ? undefined : where);
      } else if (verdict === "lacks") {
        bump(language, part, ours[part] === "has" ? "wrongHas" : "missed", where);
      } else if (ours[part] === "has" && verdict === "has") {
        bump(language, part, "agreedHas");
      }
    }
  }
}

/**
 * The second referee, for the lines the first one never classified.
 *
 * Both servers have blind spots, and neither is about syntax. pyright lists one
 * symbol per name per scope, so a property's getter hides behind its setter,
 * and it lists nothing declared inside a function -- which is most of Django's
 * test classes. rust-analyzer answers nothing at all for a file in no crate
 * (pydantic's `tests/pydantic_core/test.rs`) and skips `fn gen`, whose name is
 * a keyword in the 2024 edition.
 *
 * So the line itself is read, as text, for the keyword the language writes.
 * That is a third mechanism rather than the reader's: no tree, no server. It is
 * per-language by nature, which is fine in a referee -- `measure-holds.mts`'s
 * referee is a text scan for the same reason -- and it is why every square this
 * licenses can be traced to one of the two lists below.
 */
function declaringLine(
  source: string, line: number, name: string, language: Language,
): Record<Part, RefereeReading> | undefined {
  const text = source.split("\n")[line] ?? "";
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const routine = language === "python"
    ? new RegExp(`^\\s*(async\\s+)?def\\s+${escaped}\\s*[\\[(]`)
    : new RegExp(`\\bfn\\s+${escaped}\\s*[<(]`);
  const container = language === "python"
    ? new RegExp(`^\\s*class\\s+${escaped}\\s*[(:]`)
    : new RegExp(`\\b(struct|enum|trait|union|mod)\\s+${escaped}\\b`);
  /*
   * An assignment on the reader's own line, which the servers often file
   * elsewhere: pyright lists one symbol per name per scope, so the `brotli =
   * None` in an `except ImportError:` hides behind the `import ... as brotli`
   * above it. The value is read the same way as everywhere else here.
   */
  const statement = statementAt(linesOf(source), line, language === "rust");
  /*
   * The name has to open the statement. Allowing it after a bracket or a comma
   * read `def save(self, name, content, save=True)` as an assignment of `True`
   * to `save`, and called a Django method a plain value -- the referee's own
   * version of the mistake this whole file measures.
   */
  const assigns = new RegExp(
    `^\\s*((pub(\\([^)]*\\))?\\s+)?(const|static|let|var|export|declare|mut|readonly)\\s+)*`
    // `count += 1` binds a number to a name as surely as `count = 1` does.
    + `${escaped}\\s*(:[^=]*)?[+\\-*/|&^%]?=[^=]`,
  );
  if (statement && assigns.test(statement) && !routine.test(text)) {
    const literal = literalValue(statement, language === "rust");
    if (literal === "lacks") {
      return {
        body: "lacks", signature: "lacks", result: "unknown", fields: "unknown", bases: "unknown",
        type: "lacks", callable: "lacks",
      };
    }
  }
  if (routine.test(text)) {
    return refereeParts(12, language === "python" ? "" : text.trimEnd().endsWith(";") ? ";" : "}", language === "python");
  }
  if (container.test(text)) return refereeParts(5, "", language === "python");
  /*
   * A name with a type written on it and no value, which the servers miss for
   * the same reasons as above -- a `const _: () = {...}` inside a `cfg`, a
   * field of a struct in a file rust-analyzer would not open. The type is on
   * the line, so the line answers it (#337).
   */
  const annotated = new RegExp(
    `^\\s*((pub(\\([^)]*\\))?\\s+)?(const|static|let|var|export|declare|mut|readonly|public|private|protected)\\s+)*`
    + `${escaped}\\??\\s*:`,
  );
  /*
   * The line as well as the statement: `#[cfg(feature = "help")]` on the line
   * above makes the statement open with an attribute, and the annotation this
   * is about is on the line the name is on.
   */
  const declaring = routine.test(text) ? undefined
    : statement && annotated.test(statement) ? statement
      : annotated.test(text) ? text : undefined;
  if (declaring) {
    const callable = writtenTypeCallable(declaring, language === "python", language === "rust");
    return {
      body: callable, signature: callable, result: "unknown", fields: "unknown", bases: "unknown",
      // The line says this name is a value of that type; a type is not
      // introduced with a colon in any of the three.
      type: "lacks", callable,
    };
  }
  return undefined;
}

/**
 * A written type the compiler's own tree says nothing could call (#337).
 *
 * Keywords, literals, and what can be built out of them. A named type is not
 * in here on purpose: `type NodeTransform = (node, ctx) => void` is a name,
 * and answering that one needs the whole program rather than this file -- so
 * it comes back "cannot say", and the reader is held to the same line.
 */
function notCallableType(node: ts.TypeNode): boolean {
  const KEYWORDS = new Set<ts.SyntaxKind>([
    ts.SyntaxKind.StringKeyword, ts.SyntaxKind.NumberKeyword, ts.SyntaxKind.BooleanKeyword,
    ts.SyntaxKind.VoidKeyword, ts.SyntaxKind.UndefinedKeyword, ts.SyntaxKind.SymbolKeyword,
    ts.SyntaxKind.BigIntKeyword, ts.SyntaxKind.NeverKeyword, ts.SyntaxKind.ObjectKeyword,
  ]);
  if (KEYWORDS.has(node.kind)) return true;
  if (ts.isLiteralTypeNode(node)) return true;
  // An array holds functions without being one: `handlers: Array<() => void>`
  // is read by subscripting it, never by calling it.
  if (ts.isArrayTypeNode(node) || ts.isTupleTypeNode(node)) return true;
  if (ts.isParenthesizedTypeNode(node)) return notCallableType(node.type);
  if (ts.isTypeOperatorNode(node)) return notCallableType(node.type);
  if (ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node)) {
    return node.types.every((one) => notCallableType(one));
  }
  return false;
}

/** The TypeScript compiler's reading of one file. */
function typescriptReferee(file: string, source: string): RefereeByLine {
  const kind = file.endsWith("x") ? ts.ScriptKind.TSX
    : /\.[mc]?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const found: RefereeByLine = new Map();
  const visit = (node: ts.Node) => {
    const name = (node as { name?: ts.Node }).name;
    if (ts.isConstructorDeclaration(node)) {
      // The compiler gives a constructor no name; its keyword is where it is.
      const at = node.getStart(tree) + node.getText(tree).indexOf("constructor");
      found.set(`${tree.getLineAndCharacterOfPosition(at).line}\tconstructor`, {
        body: node.body ? "has" : "lacks", signature: "has", result: "has", fields: "lacks", bases: "lacks",
        type: "lacks", callable: "has",
      });
    }
    /*
     * `{ [key: string]: string }`. The grammar the reader walks files the
     * index parameter as a name the interface declares, so the referee has to
     * have an answer for it: it is a parameter standing for a key, which is a
     * value and never a type.
     */
    if (ts.isIndexSignatureDeclaration(node)) {
      const parameter = node.parameters[0]?.name;
      if (parameter && ts.isIdentifier(parameter)) {
        const written = notCallableType(node.type) ? "lacks" : "unknown";
        found.set(`${tree.getLineAndCharacterOfPosition(parameter.getStart(tree)).line}\t${parameter.text}`, {
          body: written, signature: written, result: "unknown", fields: "unknown", bases: "unknown",
          type: "lacks", callable: written,
        });
      }
    }
    if (name && (ts.isIdentifier(name) || ts.isPrivateIdentifier(name))) {
      let reading: Record<Part, RefereeReading> | undefined;
      if (ts.isFunctionLike(node)) {
        reading = {
          body: (node as { body?: ts.Node }).body ? "has" : "lacks",
          signature: "has", result: "has", fields: "lacks", bases: "lacks", type: "lacks",
          callable: "has",
        };
      } else if (ts.isClassLike(node) || ts.isInterfaceDeclaration(node)
        || ts.isEnumDeclaration(node) || ts.isModuleDeclaration(node)) {
        reading = {
          body: "lacks", signature: "lacks", result: "lacks", fields: "unknown", bases: "unknown",
          type: "has", callable: "unknown",
        };
      } else if ((ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) && node.initializer) {
        /*
         * The compiler's own classification of an initialiser (#307). A literal
         * is not callable and is not a type; anything else -- a call, an arrow
         * function, a name -- it declines to judge, which is the reader's own
         * stance and arrived at through a different tree.
         */
        /*
         * Through the wrappers that do not change what is written: `-1` is a
         * unary expression around a number, and `{ 1: 8 } as const` is an
         * assertion around an object.
         */
        let written: ts.Expression = node.initializer;
        for (let step = 0; step < 4; step += 1) {
          if (ts.isAsExpression(written) || ts.isTypeAssertionExpression(written)
            || ts.isParenthesizedExpression(written) || ts.isSatisfiesExpression(written)
            || ts.isNonNullExpression(written)) {
            written = written.expression;
          } else if (ts.isPrefixUnaryExpression(written)
            && (written.operator === ts.SyntaxKind.MinusToken || written.operator === ts.SyntaxKind.PlusToken)) {
            written = written.operand;
          } else break;
        }
        const literal = ts.isNumericLiteral(written) || ts.isStringLiteral(written)
          || (ts.isIdentifier(written) && written.text === "undefined")
          || ts.isNoSubstitutionTemplateLiteral(written) || ts.isBigIntLiteral(written)
          || written.kind === ts.SyntaxKind.TrueKeyword || written.kind === ts.SyntaxKind.FalseKeyword
          || written.kind === ts.SyntaxKind.NullKeyword
          || (ts.isArrayLiteralExpression(written)
            && written.elements.every((one) => ts.isNumericLiteral(one) || ts.isStringLiteral(one)))
          || (ts.isObjectLiteralExpression(written) && written.properties.every((one) =>
            ts.isPropertyAssignment(one)
            && (ts.isNumericLiteral(one.initializer) || ts.isStringLiteral(one.initializer))));
        /*
         * Only when it answers. An all-unknown record reads as silence
         * further down anyway, and leaving it unset is what lets the two
         * readings below have their turn at the same declaration (#337).
         */
        if (literal) {
          reading = {
            body: "lacks", signature: "lacks", result: "unknown", fields: "unknown",
            bases: "unknown", type: "lacks", callable: "lacks",
          };
        }
      }
      /*
       * A name with a type written on it, and nothing assigned that says
       * otherwise (#337). The compiler's tree gives both halves: that this is
       * a value declaration rather than a type, and what the written type is
       * made of.
       */
      if (!reading && (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)
        || ts.isPropertySignature(node)) && node.type) {
        const assigned = (node as { initializer?: ts.Expression }).initializer;
        const written = assigned && (ts.isArrowFunction(assigned) || ts.isFunctionExpression(assigned))
          ? "has"
          : notCallableType(node.type) ? "lacks" : "unknown";
        reading = {
          body: written, signature: written, result: "unknown", fields: "unknown", bases: "unknown",
          type: "lacks", callable: written,
        };
      }
      /*
       * And a value with no type written, whose shape the tree still settles:
       * `new WeakSet()` is an instance and `(a) => a` is a function. Neither
       * is a type, and only one of them can be called.
       */
      if (!reading && (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node))
        && node.initializer) {
        const assigned = node.initializer;
        if (ts.isNewExpression(assigned)) {
          reading = {
            body: "lacks", signature: "lacks", result: "unknown", fields: "unknown",
            bases: "unknown", type: "lacks", callable: "lacks",
          };
        } else if (ts.isArrowFunction(assigned) || ts.isFunctionExpression(assigned)) {
          reading = {
            body: "has", signature: "has", result: "has", fields: "lacks", bases: "lacks",
            type: "lacks", callable: "has",
          };
        }
      }
      if (!reading && ts.isVariableDeclaration(node) && !node.initializer
        && node.parent && ts.isVariableDeclarationList(node.parent)
        && node.parent.parent
        && (ts.isForOfStatement(node.parent.parent) || ts.isForInStatement(node.parent.parent))) {
        // `for (const noise of [0, 3])`: the value is on the statement, and
        // what the name is bound to is each element of it.
        const over = node.parent.parent.expression;
        const literal = ts.isArrayLiteralExpression(over)
          && over.elements.length > 0
          && over.elements.every((one) => ts.isNumericLiteral(one) || ts.isStringLiteral(one));
        if (literal) {
          reading = {
            body: "lacks", signature: "lacks", result: "unknown", fields: "unknown",
            bases: "unknown", type: "lacks", callable: "lacks",
          };
        }
      }
      if (reading) {
        const line = tree.getLineAndCharacterOfPosition(name.getStart(tree)).line;
        found.set(`${line}\t${name.text}`, reading);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return found;
}

/** The nearest enclosing directory holding `marker`, topmost first. */
function outermost(file: string, tree: string, marker: string): string {
  let best = tree;
  let found = false;
  for (let directory = path.dirname(file); directory.startsWith(tree); directory = path.dirname(directory)) {
    if (existsSync(path.join(directory, marker))) { best = directory; found = true; }
    if (directory === tree) break;
  }
  return found ? best : tree;
}

for (const tree of roots) {
  const files = sourceFiles(tree).filter((file) => {
    const language = languageOf(file);
    return language !== undefined && (!only || familyOf(language) === only);
  });
  const byFamily = new Map<Family, string[]>();
  for (const file of files) {
    const family = familyOf(languageOf(file)!);
    byFamily.set(family, [...(byFamily.get(family) ?? []), file]);
  }

  for (const file of byFamily.get("ts") ?? []) {
    const source = readFileSync(file, "utf8");
    score(file, source, languageOf(file)!, typescriptReferee(file, source));
  }

  const rustFiles = byFamily.get("rust") ?? [];
  const crates = new Map<string, string[]>();
  for (const file of rustFiles) {
    const root = outermost(file, tree, "Cargo.toml");
    crates.set(root, [...(crates.get(root) ?? []), file]);
  }
  for (const [root, group] of crates) {
    const referee = await createRustAnalyzerReferee(root).catch((error: Error) => {
      console.error(`rust-analyzer unavailable at ${root}: ${error.message}`);
      return undefined;
    });
    if (referee) await referee.warmUp();
    let silent = 0;
    for (const file of group) {
      const source = readFileSync(file, "utf8");
      const symbols = referee ? await referee.documentSymbols(file) : undefined;
      if (!symbols) silent += 1;
      score(file, source, "rust", symbols ? byLine(symbols, source, false) : undefined, true,
        implementedNames(symbols, source));
    }
    referee?.close();
    console.error(`rust ${path.relative(tree, root) || "."}: ${group.length} files, ${silent} unanswered`
      + (referee && !referee.primedCleanly() ? " (server never said it was ready)" : ""));
  }

  const pythonFiles = byFamily.get("python") ?? [];
  if (pythonFiles.length > 0) {
    const referee = await createPyrightLspReferee(tree).catch((error: Error) => {
      console.error(`pyright unavailable at ${tree}: ${error.message}`);
      return undefined;
    });
    if (referee) {
      const first = pythonFiles[0]!;
      await referee.warmUp(first, readFileSync(first, "utf8"), 0);
    }
    let silent = 0;
    const batch = 8;
    for (let start = 0; start < pythonFiles.length; start += batch) {
      await Promise.all(pythonFiles.slice(start, start + batch).map(async (file) => {
        const source = readFileSync(file, "utf8");
        const symbols = referee ? await referee.documentSymbols(file) : undefined;
        if (!symbols) silent += 1;
        score(file, source, "python", symbols ? byLine(symbols, source, true) : undefined, true);
      }));
    }
    referee?.close();
    console.error(`python ${path.basename(tree)}: ${pythonFiles.length} files, ${silent} unanswered`);
  }
}

/**
 * The names a Rust file writes an `impl` for, read off rust-analyzer's own
 * `impl ...` symbols -- or, for a file it would not answer, off the source
 * lines that open one. `impl<T> Trait for Foo<T>` implements `Foo`.
 */
function implementedNames(symbols: Parameters<typeof flatten>[0] | undefined, source: string): Set<string> {
  const headers = symbols
    ? flatten(symbols).map((symbol) => symbol.name).filter((name) => /^impl\b/.test(name))
    : source.split("\n").filter((line) => /^\s*(pub\s+)?(unsafe\s+)?impl\b/.test(line));
  const names = new Set<string>();
  for (const header of headers) {
    let rest = header.replace(/^\s*(pub\s+)?(unsafe\s+)?impl\s*/, "");
    // Drop the impl's own generic list, which may nest.
    if (rest.startsWith("<")) {
      let depth = 0;
      let cut = 0;
      for (; cut < rest.length; cut += 1) {
        if (rest[cut] === "<") depth += 1;
        if (rest[cut] === ">" && --depth === 0) break;
      }
      rest = rest.slice(cut + 1);
    }
    const target = / for\s+(.*)$/.exec(rest)?.[1] ?? rest;
    const path = /^\s*&?(?:mut\s+)?((?:\w+::)*\w+)/.exec(target)?.[1];
    if (path) names.add(path.split("::").pop()!);
  }
  return names;
}

/**
 * The declaration that starts on this line, as text, to wherever its brackets
 * close. `undefined` when the line assigns nothing.
 */
function statementAt(lines: string[], line: number, rust: boolean): string | undefined {
  if (!(lines[line] ?? "").includes("=")) return undefined;
  let depth = 0;
  let quote = "";
  let out = "";
  for (let index = line; index < lines.length && index < line + 40; index += 1) {
    const text = lines[index]!;
    out += (index === line ? "" : "\n") + text;
    for (let at = 0; at < text.length; at += 1) {
      const character = text[at]!;
      if (quote) {
        if (character === "\\") at += 1;
        else if (character === quote) quote = "";
        continue;
      }
      // A Rust lifetime opens with `'` and closes with nothing, and reading one
      // as a string swallowed the next forty lines of code (#307). Rust only:
      // Python writes `# '2006-10-25'` and that is a pair of quotes.
      if (rust && character === "'" && /^'\w+\b(?!')/.test(text.slice(at))) continue;
      if (character === '"' || character === "'" || character === "`") { quote = character; continue; }
      if ("([{".includes(character)) depth += 1;
      if (")]}".includes(character)) depth -= 1;
    }
    /*
     * Keep going while the value has not started: `static NO_EQUALS_ERROR: &str
     * =` puts it on the next line, and stopping here reads it as assigning
     * nothing at all.
     */
    const started = out.slice(out.indexOf("=") + 1).trim() !== "";
    if (depth <= 0 && !quote && started) break;
  }
  return out;
}

function byLine(symbols: Parameters<typeof flatten>[0], source: string, python: boolean): RefereeByLine {
  const lines = source.split("\n");
  const found: RefereeByLine = new Map();
  for (const symbol of flatten(symbols)) {
    const { start, end } = symbol.range;
    const text = start.line === end.line
      ? (lines[start.line] ?? "").slice(start.character, end.character)
      : [(lines[start.line] ?? "").slice(start.character), ...lines.slice(start.line + 1, end.line),
        (lines[end.line] ?? "").slice(0, end.character)].join("\n");
    /*
     * A server's range for a constant is often the name alone (pyright does
     * this for `__version__ = "0.28.1"`), and `literalValue` needs the whole
     * statement -- which can run over several lines, as a parenthesised string
     * does. So the statement is read from the source instead, by counting
     * brackets, and that stays a text reading rather than a parse.
     */
    const whole = statementAt(lines, start.line, !python) ?? text;
    found.set(`${symbol.line}\t${symbol.name}`, refereeParts(symbol.kind, whole, python, !python));
  }
  return found;
}

console.log(`\nparts, read from grammar fields, against each language's own tooling`);
console.log(`trees: ${roots.map((root) => path.basename(root)).join(", ")}\n`);
for (const [language, counts] of names) {
  console.log(`${language}: ${counts.read} names read, ${counts.refereed} of them seen by the referee`);
}
console.log(`${byText} declarations the servers did not classify, read off the line instead\n`);
console.log(["language", "part", "wrong lacks", "unrefereed", "agreed lacks", "missed", "wrong has", "licence"]
  .join("\t"));
for (const [key, row] of [...tally].sort()) {
  const [language, part] = key.split("\t");
  const licence = row.wrong === 0 && row.unrefereed === 0 && row.agreed > 0 ? "yes" : "no";
  console.log([language, part, row.wrong, row.unrefereed, row.agreed, row.missed, row.wrongHas, licence].join("\t"));
}
for (const [key, list] of [...examples].sort()) {
  const [language, part, outcome] = key.split("\t");
  if (outcome === "missed") continue;
  console.log(`\n${language} ${part} ${outcome} (${list.length}):`);
  for (const example of list.slice(0, show)) console.log(`  ${example}`);
}
const missed = [...examples].filter(([key]) => key.endsWith("\tmissed"));
if (missed.length > 0) {
  console.log("\nmissed lacks, a sample (cost: a red that never fires):");
  for (const [key, list] of missed.sort()) {
    const [language, part] = key.split("\t");
    console.log(`  ${language} ${part}: ${list.length}, e.g. ${list.slice(0, 3).join(" · ")}`);
  }
}
process.exit(0);
