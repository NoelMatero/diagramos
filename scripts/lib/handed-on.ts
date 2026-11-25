/**
 * "g runs the function handed to it", followed one step with the TypeScript
 * compiler's own symbols: the referee behind `measure:handed-on` (calls
 * research 2026-11).
 *
 * Three shapes, each true by the compiler's word, none with the far end's
 * name written at the call that runs it:
 *
 *   - `argument`  `run(fits)`, where the routine `run` resolves to calls its
 *                 parameter: "run calls fits".
 *   - `option`    `run({ onDone: fits })`, where `run` calls `options.onDone`.
 *   - `field`     `this.h = fits` in a class, and a method of that class that
 *                 calls `this.h(..)`.
 *
 * Only routines of the tree count, at either end, and a hand-over through a
 * cast is marked (`cast`), because a cast is where a type stops saying what a
 * value is.
 */
import type * as TS from "typescript";

/** One true arrow: `from` runs `to`, which was handed to it at `site`. */
export interface FlowPair {
  from: { file: string; name: string; line: number };
  to: { file: string; name: string; line: number };
  how: "argument" | "option" | "field";
  cast: boolean;
  site: string;
}

/** Every hand-over in one program, for files `inTree` accepts. */
export function flowPairsOf(ts: typeof TS, program: TS.Program, checker: TS.TypeChecker, inTree: (file: string) => boolean): FlowPair[] {
  const out: FlowPair[] = [];
  const lineOf = (node: TS.Node) => node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1;
  const strip = (node: TS.Expression): { node: TS.Expression; cast: boolean } => {
    let cast = false;
    let at = node;
    for (;;) {
      if (ts.isParenthesizedExpression(at) || ts.isNonNullExpression(at)) at = at.expression;
      else if (ts.isAsExpression(at) || ts.isTypeAssertionExpression(at) || ts.isSatisfiesExpression(at)) { cast = cast || !ts.isSatisfiesExpression(at); at = at.expression; }
      else return { node: at, cast };
    }
  };
  /** A named routine of the tree that this expression names, if it names one. */
  const routineNamed = (expression: TS.Expression): { file: string; name: string; line: number } | undefined => {
    if (!ts.isIdentifier(expression) && !ts.isPropertyAccessExpression(expression)) return undefined;
    let symbol = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(expression) ? expression.name : expression);
    if (!symbol) return undefined;
    if (symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    const declarations = symbol.getDeclarations() ?? [];
    if (declarations.length === 0) return undefined;
    for (const one of declarations) {
      const isRoutine = (ts.isFunctionDeclaration(one) && !!one.body) || (ts.isMethodDeclaration(one) && !!one.body)
        || ((ts.isVariableDeclaration(one) || ts.isPropertyDeclaration(one)) && !!one.initializer && (ts.isArrowFunction(one.initializer) || ts.isFunctionExpression(one.initializer)));
      if (!isRoutine) return undefined;
      const file = one.getSourceFile().fileName;
      if (!inTree(file) || !one.name || !(ts.isIdentifier(one.name) || ts.isPrivateIdentifier(one.name))) return undefined;
    }
    const first = declarations[0] as TS.NamedDeclaration;
    return { file: first.getSourceFile().fileName, name: (first.name as TS.Identifier).text, line: lineOf(first.name!) };
  };
  /** The named routine a function-like declaration is, for the tail of an arrow. */
  const nameOfRoutine = (declaration: TS.SignatureDeclaration): { file: string; name: string; line: number; body: TS.Node } | undefined => {
    const body = (declaration as TS.FunctionLikeDeclaration).body;
    if (!body) return undefined;
    let name: TS.Node | undefined = (declaration as TS.NamedDeclaration).name;
    if (!name && (ts.isArrowFunction(declaration) || ts.isFunctionExpression(declaration)) && ts.isVariableDeclaration(declaration.parent)) name = declaration.parent.name;
    if (ts.isConstructorDeclaration(declaration)) return undefined;
    if (!name || !(ts.isIdentifier(name) || ts.isPrivateIdentifier(name))) return undefined;
    const file = declaration.getSourceFile().fileName;
    if (!inTree(file)) return undefined;
    return { file, name: name.text, line: lineOf(name), body };
  };
  /** Whether the body calls the parameter itself (`how: argument`), or a member `key` of it (`option`). */
  const bodyCalls = (body: TS.Node, parameter: TS.Symbol, key?: string): boolean => {
    let found = false;
    const visit = (node: TS.Node): void => {
      if (found) return;
      if (ts.isCallExpression(node)) {
        const callee = strip(node.expression).node;
        if (key === undefined && ts.isIdentifier(callee) && checker.getSymbolAtLocation(callee) === parameter) { found = true; return; }
        if (key !== undefined && ts.isPropertyAccessExpression(callee) && callee.name.text === key && ts.isIdentifier(callee.expression)
          && checker.getSymbolAtLocation(callee.expression) === parameter) { found = true; return; }
      }
      ts.forEachChild(node, visit);
    };
    visit(body);
    return found;
  };
  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile || !inTree(sourceFile.fileName)) continue;
    const visit = (node: TS.Node): void => {
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const signature = checker.getResolvedSignature(node);
        const declaration = signature?.declaration;
        const tail = declaration && !ts.isJSDocSignature(declaration) ? nameOfRoutine(declaration) : undefined;
        if (tail && declaration && !ts.isJSDocSignature(declaration)) {
          (node.arguments ?? []).forEach((argument, index) => {
            const parameter = declaration.parameters[index];
            if (!parameter || parameter.dotDotDotToken || !ts.isIdentifier(parameter.name)) return;
            const symbol = checker.getSymbolAtLocation(parameter.name);
            if (!symbol) return;
            const { node: value, cast } = strip(argument);
            const site = `${sourceFile.fileName}:${lineOf(node)}`;
            const head = routineNamed(value);
            if (head && bodyCalls(tail.body, symbol)) out.push({ from: tail, to: head, how: "argument", cast, site });
            if (ts.isObjectLiteralExpression(value)) {
              for (const property of value.properties) {
                if (ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) {
                  const inner = strip(property.initializer);
                  const held = routineNamed(inner.node);
                  if (held && bodyCalls(tail.body, symbol, property.name.text)) out.push({ from: tail, to: held, how: "option", cast: cast || inner.cast, site });
                } else if (ts.isShorthandPropertyAssignment(property)) {
                  const target = checker.getShorthandAssignmentValueSymbol(property);
                  const fake = target?.valueDeclaration && ts.isFunctionDeclaration(target.valueDeclaration) ? routineNamed(property.name) : undefined;
                  if (fake && bodyCalls(tail.body, symbol, property.name.text)) out.push({ from: tail, to: fake, how: "option", cast, site });
                }
              }
            }
          });
        }
      }
      // `this.h = f` in a class, and a method of that class calling `this.h(..)`.
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(node.left)
        && node.left.expression.kind === ts.SyntaxKind.ThisKeyword) {
        const { node: value, cast } = strip(node.right);
        const head = routineNamed(value);
        const field = node.left.name.text;
        let holder: TS.Node | undefined = node;
        while (holder && !ts.isClassLike(holder)) holder = holder.parent;
        if (head && holder && ts.isClassLike(holder)) {
          for (const member of holder.members) {
            if (!ts.isMethodDeclaration(member) || !member.body) continue;
            const tail = nameOfRoutine(member);
            if (!tail) continue;
            let calls = false;
            const look = (inner: TS.Node): void => {
              if (calls) return;
              if (ts.isCallExpression(inner)) {
                const callee = strip(inner.expression).node;
                if (ts.isPropertyAccessExpression(callee) && callee.name.text === field && callee.expression.kind === ts.SyntaxKind.ThisKeyword) { calls = true; return; }
              }
              ts.forEachChild(inner, look);
            };
            look(member.body);
            if (calls) out.push({ from: tail, to: head, how: "field", cast, site: `${sourceFile.fileName}:${lineOf(node)}` });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return out;
}
