/**
 * "Could the value called here be that function?" -- the TypeScript compiler's
 * answer, for a call nobody can place (calls research 2026-11, step 2).
 *
 * `handler(req)`, `this.processFn(job)`, `strategy.apply(n)`, `table[k](x)`:
 * the value called is handed in, kept in a field, reached through an
 * interface or looked up. Where it goes is often unknowable; whether it can
 * be one particular function is not. The value has a type, and a function
 * that cannot be used where that type is expected cannot be held there
 * without a cast or an `any` on the way. So `calleeCanHold` answers `false`
 * only when the compiler says none of the head's declarations fits the
 * called value's type, and `undefined` wherever the types cannot say:
 *
 *   the called value is `any`, `unknown`, `Function`,    no signature to compare
 *   or a type variable bound by nothing
 *   the head is not only routines (a field, a class,     nothing to compare it as
 *   an accessor), or any of its declarations is `any`
 *   "does not fit" may be about the type arguments       only what the signatures
 *   (a type variable either side) or about members         plainly show counts:
 *   besides the call (`Handler & { meta }`)                a parameter of another
 *                                                          type, a count the call
 *                                                          type never gives, what
 *                                                          it hands back
 *   a JavaScript file at either end                      its types are guesses
 *
 * One more answer that is not about fit: a call written without `new` never
 * runs a class's `constructor` -- JavaScript throws when a class is called
 * plainly -- unless it is `super(..)`.
 *
 * Types can be wrong about what a value holds: a cast, an `any` it passed
 * through. `forgetsShape` is the guard on the head's side: wherever the head
 * is written as a value and handed to something that forgets what it is
 * (`any`, `unknown`, `Function`, `object`, `{}`, a type variable), or is
 * cast, the type question must not speak. What it cannot see is an `any`
 * reached through another variable first (#377 found the same hole).
 */
import type * as TS from "typescript";

/** The head as the question names it: its declarations by name in a file, or one function with no name by where it is written. */
export interface CalleeHead {
  /** Absolute. */
  file: string;
  /** The head's names in `file`; ignored when `at` is given. */
  names: readonly string[];
  /** A function with no name -- an arrow, a function expression -- by its exact range. */
  at?: { start: number; end: number };
}

const JAVASCRIPT_FILE = /\.(c|m)?jsx?$/;

/** The value a call runs, for the node a reader handed in: a name's access, not the name alone. */
export function calledValue(ts: typeof TS, node: TS.Node): TS.Node {
  let at = node;
  // `foo` in `x.foo`: the member read, which is what is called.
  if (ts.isIdentifier(at) || ts.isPrivateIdentifier(at)) {
    const parent = at.parent;
    if (parent && ts.isPropertyAccessExpression(parent) && parent.name === at) at = parent;
  }
  return at;
}

export function calleeCanHold(
  ts: typeof TS,
  program: TS.Program,
  checker: TS.TypeChecker,
  callee: TS.Node,
  head: CalleeHead,
): boolean | undefined {
  if (JAVASCRIPT_FILE.test(callee.getSourceFile().fileName) || JAVASCRIPT_FILE.test(head.file)) return undefined;
  const value = calledValue(ts, callee);
  if (value.kind === ts.SyntaxKind.SuperKeyword || value.kind === ts.SyntaxKind.ImportKeyword) return undefined;
  // `x.call(..)`, `x.apply(..)`, `x.bind(..)` as the value itself: what runs is `x`.
  if (ts.isPropertyAccessExpression(value) && /^(call|apply|bind)$/.test(value.name.text)) return undefined;
  /*
   * Only the value a call is made on: `f` in `f(..)`, `(f)(..)`, `f!(..)`,
   * `f?.(..)`, `new f(..)` -- or `f.call(t, ..)` and `f.apply(t, xs)` where
   * `call` and `apply` are the language's own, which run `f`.
   */
  let written: TS.Node = value;
  while (written.parent && (ts.isParenthesizedExpression(written.parent) || ts.isNonNullExpression(written.parent))) written = written.parent;
  let call = written.parent;
  if (call && ts.isPropertyAccessExpression(call) && call.expression === written && /^(call|apply)$/.test(call.name.text)
    && ts.isCallExpression(call.parent) && call.parent.expression === call && builtIn(ts, checker, call.name)) {
    written = call;
    call = call.parent;
  }
  if (!call || !(ts.isCallExpression(call) || ts.isNewExpression(call)) || call.expression !== written) return undefined;
  const isNew = ts.isNewExpression(call);
  const home = program.getSourceFile(head.file);
  if (!home || home.isDeclarationFile) return undefined;
  const called = checker.getNonNullableType(checker.getTypeAtLocation(value));
  if (called.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return undefined;

  let heads: TS.Type[] | undefined;
  if (head.at) {
    const written = nodeAt(ts, home, head.at.start, head.at.end);
    if (!written || !(ts.isArrowFunction(written) || ts.isFunctionExpression(written))) return undefined;
    const type = checker.getTypeAtLocation(written);
    heads = type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown) ? undefined : [type];
  } else {
    const names = head.names.map((name) => name.replace(/^#/, ""));
    if (names.length > 0 && names.every((name) => name === "constructor")) {
      // A plain call is never a class's constructor: only `new` and `super(..)` run one.
      return !isNew && declaresAConstructor(ts, home) ? false : undefined;
    }
    heads = headTypesOf(ts, checker, home, names);
  }
  if (!heads || heads.length === 0) return undefined;
  const options = program.getCompilerOptions();
  const strict = options.strictFunctionTypes ?? options.strict ?? false;
  return canHold(ts, checker, called, heads, isNew, strict);
}

/** Whether a member's every declaration is the language's own -- `Function.prototype.call` -- not one written in the repository. */
function builtIn(ts: typeof TS, checker: TS.TypeChecker, name: TS.Node): boolean {
  const declarations = checker.getSymbolAtLocation(name)?.declarations ?? [];
  return declarations.length > 0 && declarations.every((one) => {
    const file = one.getSourceFile();
    return file.isDeclarationFile && /(^|[\\/])lib\.[\w.]*\.d\.ts$/.test(file.fileName);
  });
}

function declaresAConstructor(ts: typeof TS, home: TS.SourceFile): boolean {
  let declared = false;
  const look = (node: TS.Node): void => {
    if (declared) return;
    if (ts.isConstructorDeclaration(node)) declared = true;
    else ts.forEachChild(node, look);
  };
  look(home);
  return declared;
}

/**
 * Whether a name written as a value on this line is handed to something whose
 * type forgets what it is, or is cast. `undefined` when the line writes none
 * of the names as a value.
 */
export function forgetsShape(
  ts: typeof TS,
  checker: TS.TypeChecker,
  sourceFile: TS.SourceFile,
  line: number,
  names: readonly string[],
): boolean | undefined {
  const wanted = new Set(names.map((name) => name.replace(/^#/, "")));
  let seen = false;
  let forgets = false;
  const visit = (node: TS.Node): void => {
    if (forgets) return;
    if ((ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) && wanted.has(node.text.replace(/^#/, ""))
      && sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1 === line) {
      // The whole expression the name is the end of: `H`, `this.H`, `ns.H`.
      let value: TS.Node = node;
      if (node.parent && ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) value = node.parent;
      const parent = value.parent;
      const declares = parent !== undefined && (parent as { name?: TS.Node }).name === value && !ts.isPropertyAccessExpression(parent);
      const called = parent !== undefined && (ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === value;
      if (!declares && !called && ts.isExpression(value)) {
        seen = true;
        let at: TS.Node = value;
        while (at.parent && (ts.isParenthesizedExpression(at.parent) || ts.isNonNullExpression(at.parent))) at = at.parent;
        if (at.parent && (ts.isAsExpression(at.parent) || ts.isTypeAssertionExpression(at.parent))) { forgets = true; return; }
        try {
          if (shapeless(ts, checker, checker.getContextualType(at as TS.Expression))) { forgets = true; return; }
          // An argument: the parameter as declared, before a type variable there was filled in with the head's own type.
          if (shapeless(ts, checker, declaredParameterType(ts, checker, at))) { forgets = true; return; }
          const up = at.parent;
          if (up && ts.isBinaryExpression(up) && up.operatorToken.kind === ts.SyntaxKind.EqualsToken && up.right === at
            && shapeless(ts, checker, checker.getTypeAtLocation(up.left))) { forgets = true; return; }
        } catch {
          forgets = true;
          return;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return seen ? forgets : undefined;
}

/**
 * The type a call's declaration gives the parameter `argument` is handed to,
 * as written there: `T` in `keep<T>(x: T)`, where the contextual type is
 * already `typeof head`. `undefined` for anything but an argument.
 */
function declaredParameterType(ts: typeof TS, checker: TS.TypeChecker, argument: TS.Node): TS.Type | undefined {
  const call = argument.parent;
  if (!call || !(ts.isCallExpression(call) || ts.isNewExpression(call))) return undefined;
  const index = call.arguments?.indexOf(argument as TS.Expression) ?? -1;
  if (index < 0) return undefined;
  const declaration = checker.getResolvedSignature(call)?.declaration;
  if (!declaration || ts.isJSDocSignature(declaration)) return undefined;
  const signature = checker.getSignatureFromDeclaration(declaration);
  if (!signature || signature.parameters.length === 0) return undefined;
  const parameter = signature.parameters[Math.min(index, signature.parameters.length - 1)]!;
  let type: TS.Type | undefined = checker.getTypeOfSymbol(parameter);
  // A rest parameter `...xs: T[]`: what one argument is handed to is the element.
  const last = parameter.valueDeclaration;
  if (last && ts.isParameter(last) && last.dotDotDotToken) {
    type = checker.isArrayType(type) ? checker.getTypeArguments(type as TS.TypeReference)[0] : undefined;
  } else if (index >= signature.parameters.length) {
    return undefined;
  }
  /*
   * Only the routine's own type variables: `Array<T>.push(x: T)` is bound by
   * the array it is called on, which the contextual type already says.
   */
  const own = new Set(signature.typeParameters ?? []);
  const parts = type?.isUnion() ? type.types : type ? [type] : [];
  return parts.find((one) => own.has(one as TS.TypeParameter));
}

/** A type that keeps nothing of what a function value was: `any`, `unknown`, `Function`, `object`, `{}`, a free type variable. */
function shapeless(ts: typeof TS, checker: TS.TypeChecker, type: TS.Type | undefined): boolean {
  if (!type) return false;
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.NonPrimitive)) return true;
  if (type.isUnionOrIntersection()) return type.types.some((one) => shapeless(ts, checker, one));
  if (type.flags & ts.TypeFlags.TypeParameter) {
    const bound = checker.getBaseConstraintOfType(type);
    return !bound || bound === type || shapeless(ts, checker, bound);
  }
  const name = type.symbol?.name;
  if (name === "Function" || name === "CallableFunction" || name === "NewableFunction" || name === "Object") return true;
  // `{}`: an object type with nothing in it.
  return (type.flags & ts.TypeFlags.Object) !== 0 && checker.getPropertiesOfType(type).length === 0
    && checker.getSignaturesOfType(type, ts.SignatureKind.Call).length === 0
    && checker.getSignaturesOfType(type, ts.SignatureKind.Construct).length === 0
    && !checker.getIndexInfoOfType(type, ts.IndexKind.String);
}

function nodeAt(ts: typeof TS, sourceFile: TS.SourceFile, start: number, end: number): TS.Node | undefined {
  let found: TS.Node | undefined;
  const visit = (node: TS.Node): void => {
    const nodeStart = node.getStart(sourceFile);
    const nodeEnd = node.getEnd();
    if (nodeStart > start || nodeEnd < end) return;
    if (nodeStart === start && nodeEnd === end) found = node;
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/** The type of every declaration of `names` in a file, or undefined when one of them is not a routine. */
function headTypesOf(ts: typeof TS, checker: TS.TypeChecker, home: TS.SourceFile, names: readonly string[]): TS.Type[] | undefined {
  const wanted = new Set(names);
  const types: TS.Type[] = [];
  let notARoutine = false;
  const visit = (node: TS.Node): void => {
    if (notARoutine) return;
    const name = (node as { name?: TS.Node }).name;
    if (name && (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name)) && wanted.has(name.text.replace(/^#/, ""))) {
      if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) {
        // A decorator may put anything in the routine's place.
        if (ts.canHaveDecorators(node) && (ts.getDecorators(node)?.length ?? 0) > 0) notARoutine = true;
        else types.push(checker.getTypeAtLocation(name));
      } else if (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node) || ts.isPropertyAssignment(node)) {
        const value = node.initializer;
        if (value && (ts.isArrowFunction(value) || ts.isFunctionExpression(value))
          && !(ts.isPropertyDeclaration(node) && (ts.getDecorators(node)?.length ?? 0) > 0)) types.push(checker.getTypeAtLocation(name));
        else notARoutine = true;
      } else if (ts.isClassLike(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)
        || ts.isEnumMember(node) || ts.isPropertySignature(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node)
        || ts.isShorthandPropertyAssignment(node) || ts.isModuleDeclaration(node) || ts.isParameter(node)
        || ts.isBindingElement(node) || ts.isImportSpecifier(node) || ts.isExportSpecifier(node) || ts.isImportClause(node)
        || ts.isNamespaceImport(node)) {
        notARoutine = true;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(home);
  if (notARoutine) return undefined;
  if (types.some((type) => (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0)) return undefined;
  return types;
}

/** Whether a type mentions a type variable anywhere the comparison would read: then "does not fit" may be about arguments nobody gave. */
function hasTypeVariables(ts: typeof TS, checker: TS.TypeChecker, type: TS.Type, depth = 0, seen = new Set<TS.Type>()): boolean {
  if (seen.has(type)) return false;
  seen.add(type);
  if (type.flags & (ts.TypeFlags.TemplateLiteral | ts.TypeFlags.StringMapping)) {
    // `${number}ms`: a pattern over strings, generic only if one of its holes is.
    const holes = (type as unknown as { types?: TS.Type[]; type?: TS.Type }).types ?? [(type as unknown as { type: TS.Type }).type];
    return holes.some((one) => one !== undefined && hasTypeVariables(ts, checker, one, depth + 1, seen));
  }
  if (type.flags & ts.TypeFlags.Instantiable) return true;
  if (depth > 4) return true;
  if (type.isUnionOrIntersection()) return type.types.some((one) => hasTypeVariables(ts, checker, one, depth + 1, seen));
  if (type.aliasTypeArguments?.some((one) => hasTypeVariables(ts, checker, one, depth + 1, seen))) return true;
  if (!(type.flags & ts.TypeFlags.Object)) return false;
  const object = type as TS.ObjectType;
  if (object.objectFlags & ts.ObjectFlags.Reference) {
    if (checker.getTypeArguments(object as TS.TypeReference).some((one) => hasTypeVariables(ts, checker, one, depth + 1, seen))) return true;
  }
  const signatures = [...checker.getSignaturesOfType(type, ts.SignatureKind.Call), ...checker.getSignaturesOfType(type, ts.SignatureKind.Construct)];
  for (const signature of signatures) {
    if (signature.typeParameters?.length) return true;
    for (const parameter of signature.parameters) {
      if (hasTypeVariables(ts, checker, checker.getTypeOfSymbol(parameter), depth + 1, seen)) return true;
    }
    if (hasTypeVariables(ts, checker, checker.getReturnTypeOfSignature(signature), depth + 1, seen)) return true;
  }
  if (object.objectFlags & ts.ObjectFlags.Anonymous) {
    for (const property of checker.getPropertiesOfType(type).slice(0, 40)) {
      if (hasTypeVariables(ts, checker, checker.getTypeOfSymbol(property), depth + 1, seen)) return true;
    }
  }
  return false;
}

function restOf(ts: typeof TS, signature: TS.Signature): boolean {
  const last = signature.parameters[signature.parameters.length - 1]?.valueDeclaration;
  return !!last && ts.isParameter(last) && !!last.dotDotDotToken;
}

/**
 * With type variables or extra members in play: whether every signature of
 * the head plainly differs from every one of the called value's -- more
 * arguments needed than it is ever given, a parameter of a plainly different
 * type (the strict way round where the program asks for it and the called
 * type is not a method, whose parameters TypeScript compares both ways), or
 * a result that is not what the caller is promised.
 */
function plainlyDiffers(ts: typeof TS, checker: TS.TypeChecker, head: TS.Type, called: TS.Type, kind: TS.SignatureKind, strict: boolean): boolean {
  const headSignatures = checker.getSignaturesOfType(head, kind);
  const calledSignatures = checker.getSignaturesOfType(called, kind);
  // `new` on a routine nothing can construct -- a method, an arrow -- runs no routine of it.
  if (headSignatures.length === 0) return kind === ts.SignatureKind.Construct;
  if (calledSignatures.length === 0) return false;
  for (const mine of headSignatures) {
    for (const theirs of calledSignatures) {
      let differs = false;
      const needs = (mine as unknown as { minArgumentCount?: number }).minArgumentCount ?? 0;
      if (!restOf(ts, theirs) && needs > theirs.parameters.length) differs = true;
      const upTo = Math.min(mine.parameters.length - (restOf(ts, mine) ? 1 : 0), theirs.parameters.length - (restOf(ts, theirs) ? 1 : 0));
      const method = theirs.declaration !== undefined && (ts.isMethodSignature(theirs.declaration) || ts.isMethodDeclaration(theirs.declaration));
      const strictly = strict && !method;
      for (let at = 0; !differs && at < upTo; at += 1) {
        const a = checker.getTypeOfSymbol(mine.parameters[at]!);
        const b = checker.getTypeOfSymbol(theirs.parameters[at]!);
        if (hasTypeVariables(ts, checker, a) || hasTypeVariables(ts, checker, b)) continue;
        if (strictly ? !checker.isTypeAssignableTo(b, a) : !checker.isTypeAssignableTo(a, b) && !checker.isTypeAssignableTo(b, a)) differs = true;
      }
      // What the head hands back has to be what the caller is promised, unless the caller is promised nothing.
      if (!differs) {
        const back = checker.getReturnTypeOfSignature(mine);
        const wanted = checker.getReturnTypeOfSignature(theirs);
        if (!(wanted.flags & (ts.TypeFlags.Void | ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Undefined))
          && !(back.flags & (ts.TypeFlags.Any | ts.TypeFlags.Never))
          && !hasTypeVariables(ts, checker, back) && !hasTypeVariables(ts, checker, wanted)
          && !checker.isTypeAssignableTo(back, wanted)) differs = true;
      }
      if (!differs) return false;
    }
  }
  return true;
}

function canHold(ts: typeof TS, checker: TS.TypeChecker, called: TS.Type, heads: TS.Type[], isNew: boolean, strict: boolean): boolean | undefined {
  const kind = isNew ? ts.SignatureKind.Construct : ts.SignatureKind.Call;
  let members = called.isUnion() ? called.types : [called];
  members = members.filter((one) => !(one.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void)));
  if (members.length === 0) return undefined;
  const resolved: TS.Type[] = [];
  for (const member of members) {
    let one = member;
    if (one.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return undefined;
    if (one.flags & ts.TypeFlags.TypeParameter) {
      const bound = checker.getBaseConstraintOfType(one);
      if (!bound || bound === one || bound.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return undefined;
      one = bound;
    }
    // Something callable the compiler has no signature for (`Function`, an intersection it cannot call): no answer.
    if (checker.getSignaturesOfType(one, kind).length === 0) return undefined;
    resolved.push(one);
  }
  for (const head of heads) {
    for (const one of resolved) {
      if (checker.isTypeAssignableTo(head, one)) return true;
      /*
       * "Does not fit" has to be about the call. A called type with members of
       * its own (`Handler & { meta }`, a function with properties) refuses a
       * plain function for the members, and the value may still be that
       * function with them attached; a type variable refuses for arguments
       * nobody gave. Then only what the signatures themselves show counts.
       */
      const loose = checker.getPropertiesOfType(one).length > 0 || hasTypeVariables(ts, checker, head) || hasTypeVariables(ts, checker, one);
      if (loose && !plainlyDiffers(ts, checker, head, one, kind, strict)) return undefined;
    }
  }
  return false;
}
