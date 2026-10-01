/**
 * The TypeScript half of `measure:compiler-true` (#393): every pair the
 * TypeScript compiler's own type checker says is true, for each word whose
 * licence rested on a text scan.
 *
 * The checker is asked directly, through the compiler API, with a program of
 * its own. The product asks the same compiler through a language service at
 * the one place a red is decided (`gate.ts`), so the two share the compiler
 * and nothing else: no tree-sitter query, no site list, no import resolver.
 *
 * Each pair says whether what made it true is **written** at the site -- the
 * type's name in the annotation, the base in the header -- or known to the
 * compiler only. The second population is the one the old text referees could
 * not see (#373), so a zero that rests on the first alone says nothing new.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import type * as TS from "typescript";

export type TrueWord = "holds" | "takes" | "returns" | "conforms" | "calls" | "accesses";

/** One correct arrow, as the compiler sees it. */
export interface TruePair {
  word: TrueWord;
  from: string;
  to: string;
  /** The member, for `accesses`. */
  label?: string;
  /**
   * What made it true. `written`: the name is in the text at the site.
   * Anything else is the compiler's alone -- `inferred` (no annotation),
   * `bound` (a type parameter's constraint), `alias` (written under another
   * name), `ancestor` (a base of a base), `structural` (fits without naming
   * it), `other-name` (a call or read spelled differently from what it lands on).
   */
  how: string;
}

const SKIP = /^(node_modules|\.git|dist|__tests__|test|tests|__mocks__)$/;

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    if (SKIP.test(name)) continue;
    const file = path.join(dir, name);
    if (statSync(file).isDirectory()) walk(file, out);
    else if (/\.tsx?$/.test(name) && !/\.(d|test|spec)\.tsx?$/.test(name)) out.push(file);
  }
  return out;
}

export function typescriptTruePairs(ts: typeof TS, root: string, dirs: string[]): TruePair[] {
  const files = dirs.flatMap((dir) => walk(path.join(root, dir)));
  const reading = new Set(files);
  // The project's own settings: whether one type fits another depends on
  // `strict`, and a looser program said 80 classes fit what the project's
  // compiler says they do not.
  const configPath = ts.findConfigFile(path.join(root, dirs[0] ?? "."), ts.sys.fileExists);
  const parsed = configPath ? ts.getParsedCommandLineOfConfigFile(configPath, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined }) : undefined;
  const program = ts.createProgram(files, {
    ...(parsed?.options ?? { target: ts.ScriptTarget.ES2022, strict: true }),
    jsx: ts.JsxEmit.Preserve, skipLibCheck: true, noEmit: true, experimentalDecorators: true, allowJs: false,
  });
  const checker = program.getTypeChecker();
  const sources = program.getSourceFiles().filter((source) => reading.has(source.fileName));
  const rel = (node: TS.Node) => path.relative(root, node.getSourceFile().fileName);

  // Types declared once in the files read: the only heads a pair may name.
  const declared = new Map<string, string[]>();
  const typeDeclaration = (node: TS.Node) =>
    ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node);
  for (const source of sources) {
    for (const statement of source.statements) {
      if (typeDeclaration(statement) && (statement as TS.DeclarationStatement).name) {
        const name = (statement as TS.DeclarationStatement).name!.getText();
        declared.set(name, [...(declared.get(name) ?? []), rel(statement)]);
      }
    }
  }
  const home = (name: string) => {
    const at = declared.get(name);
    return at && at.length === 1 ? at[0] : undefined;
  };
  /** A declaration of a type the files read declare once, by its own node. */
  const headOf = (symbol: TS.Symbol | undefined): string | undefined => {
    const declaration = symbol?.declarations?.find((one) => typeDeclaration(one) && reading.has(one.getSourceFile().fileName));
    if (!declaration) return undefined;
    const name = (declaration as TS.DeclarationStatement).name?.getText();
    return name && home(name) === rel(declaration) && declaration.parent && ts.isSourceFile(declaration.parent) ? name : undefined;
  };

  /**
   * Every project type a type is made of: itself, an alias it was written
   * through, its type arguments, an array's element, a union's members, and a
   * type parameter's constraint (`bound`). A function type's insides are not
   * part of what a field holds or a parameter takes, so they are left out.
   */
  const partsOf = (type: TS.Type, out = new Map<string, "plain" | "bound">(), depth = 0, bound = false) => {
    if (depth > 5) return out;
    const note = (symbol: TS.Symbol | undefined) => {
      const name = headOf(symbol);
      if (name && !out.has(name)) out.set(name, bound ? "bound" : "plain");
    };
    note(type.aliasSymbol);
    for (const argument of written(type.aliasSymbol, type.aliasTypeArguments)) partsOf(argument, out, depth + 1, bound);
    if (type.isUnionOrIntersection()) {
      for (const member of type.types) partsOf(member, out, depth + 1, bound);
      return out;
    }
    if (type.flags & ts.TypeFlags.TypeParameter) {
      const constraint = checker.getBaseConstraintOfType(type);
      if (constraint && constraint !== type) partsOf(constraint, out, depth + 1, true);
      return out;
    }
    note(type.getSymbol());
    if (type.flags & ts.TypeFlags.Object && (type as TS.ObjectType).objectFlags & ts.ObjectFlags.Reference) {
      const reference = type as TS.TypeReference;
      for (const argument of written(reference.target?.getSymbol(), checker.getTypeArguments(reference))) {
        partsOf(argument, out, depth + 1, bound);
      }
    }
    return out;
  };
  /**
   * Type arguments, less the ones the declaration's defaults filled in:
   * `ComponentObjectPropsOptions` is not "returns Data" because its parameter
   * defaults to `Data` (#393's first run: 30 vue pairs nobody would draw).
   */
  function written(symbol: TS.Symbol | undefined, args: readonly TS.Type[] | undefined): readonly TS.Type[] {
    if (!args) return [];
    const declared = symbol?.declarations?.find((one) => (one as { typeParameters?: unknown }).typeParameters) as
      { typeParameters?: TS.NodeArray<TS.TypeParameterDeclaration> } | undefined;
    return args.filter((argument, index) => {
      const fallback = declared?.typeParameters?.[index]?.default;
      return !fallback || checker.getTypeAtLocation(fallback) !== argument;
    });
  }
  /** `written` when the name is spelled in the annotation, else what the compiler alone knows. */
  const howWritten = (annotation: TS.Node | undefined, name: string, part: "plain" | "bound") => {
    if (part === "bound") return "bound";
    if (!annotation) return "inferred";
    return new RegExp(`\\b${name}\\b`).test(annotation.getText()) ? "written" : "alias";
  };

  const pairs: TruePair[] = [];
  const seen = new Set<string>();
  const add = (pair: TruePair) => {
    const key = `${pair.word} ${pair.from} ${pair.to} ${pair.label ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    pairs.push(pair);
  };

  // The routines a board can point at by name: top-level functions, the
  // methods of a top-level class, and a module-level `const f = () => ...`.
  interface Routine { ref: string; node: TS.SignatureDeclaration & { body?: TS.Node } }
  const routines: Routine[] = [];
  const refOfDeclaration = new Map<TS.Node, string>();
  for (const source of sources) {
    const file = rel(source);
    const taken = new Map<string, number>();
    const found: Routine[] = [];
    for (const statement of source.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) {
        found.push({ ref: `${file}#${statement.name.text}`, node: statement });
      } else if (ts.isVariableStatement(statement)) {
        for (const variable of statement.declarationList.declarations) {
          if (ts.isIdentifier(variable.name) && variable.initializer
            && (ts.isArrowFunction(variable.initializer) || ts.isFunctionExpression(variable.initializer))) {
            found.push({ ref: `${file}#${variable.name.text}`, node: variable.initializer });
          }
        }
      } else if (ts.isClassDeclaration(statement) && statement.name) {
        for (const member of statement.members) {
          if (ts.isMethodDeclaration(member) && member.body && ts.isIdentifier(member.name)) {
            found.push({ ref: `${file}#${statement.name.text}.${member.name.text}`, node: member });
          }
        }
      }
    }
    for (const one of found) taken.set(one.ref, (taken.get(one.ref) ?? 0) + 1);
    // An overloaded or twice-declared name is left out rather than guessed at.
    for (const one of found) {
      if (taken.get(one.ref) !== 1) continue;
      routines.push(one);
      refOfDeclaration.set(one.node, one.ref);
    }
  }

  // holds: every field of a top-level class or interface, by the type the
  // compiler gives it -- written, or inferred from its initializer.
  for (const source of sources) {
    for (const statement of source.statements) {
      if (!(ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement)) || !statement.name) continue;
      const holder = statement.name.text;
      if (home(holder) !== rel(statement)) continue;
      const fields: Array<{ name: TS.Node; annotation?: TS.Node }> = [];
      for (const member of statement.members as TS.NodeArray<TS.ClassElement | TS.TypeElement>) {
        if ((ts.isPropertyDeclaration(member) || ts.isPropertySignature(member)) && !ts.isComputedPropertyName(member.name)) {
          fields.push({ name: member.name, annotation: member.type });
        } else if (ts.isConstructorDeclaration(member)) {
          for (const parameter of member.parameters) {
            if (ts.getModifiers(parameter)?.length && ts.isIdentifier(parameter.name)) {
              fields.push({ name: parameter.name, annotation: parameter.type });
            }
          }
        }
      }
      for (const field of fields) {
        const type = checker.getTypeAtLocation(field.name);
        if (type.getCallSignatures().length > 0) continue;
        for (const [name, part] of partsOf(type)) {
          if (name === holder) continue;
          add({ word: "holds", from: `${rel(statement)}#${holder}`, to: `${home(name)}#${name}`, how: howWritten(field.annotation, name, part) });
        }
      }
    }
  }

  for (const routine of routines) {
    const { node } = routine;
    // takes: each parameter, by the type the compiler gives it.
    for (const parameter of node.parameters) {
      if (ts.isIdentifier(parameter.name) && parameter.name.text === "this") continue;
      const type = checker.getTypeAtLocation(parameter.name);
      for (const [name, part] of partsOf(type)) {
        add({ word: "takes", from: `${home(name)}#${name}`, to: routine.ref, how: howWritten(parameter.type, name, part) });
      }
    }
    // returns: the return type the compiler gives the signature.
    const signature = checker.getSignatureFromDeclaration(node);
    if (signature) {
      for (const [name, part] of partsOf(checker.getReturnTypeOfSignature(signature))) {
        add({ word: "returns", from: `${home(name)}#${name}`, to: routine.ref, how: howWritten(node.type, name, part) });
      }
    }
    if (!node.body) continue;
    const routineNode = node;
    (function inner(child: TS.Node) {
      // calls: the declaration the compiler resolves each call to.
      if (ts.isCallExpression(child)) {
        const declaration = checker.getResolvedSignature(child)?.declaration;
        const callee = declaration ? refOfDeclaration.get(declaration as TS.Node) : undefined;
        if (callee && declaration !== routineNode) {
          const spelled = ts.isPropertyAccessExpression(child.expression) ? child.expression.name.text : child.expression.getText();
          const name = callee.split(/[#.]/).pop()!;
          add({ word: "calls", from: routine.ref, to: callee, how: spelled === name ? "written" : "other-name" });
        }
      }
      // accesses: a property the compiler says a `.name` reads, on the type
      // that declares it. A method called is a call, not a read.
      if (ts.isPropertyAccessExpression(child) && !(ts.isCallExpression(child.parent) && child.parent.expression === child)) {
        const symbol = checker.getSymbolAtLocation(child.name);
        const declaration = symbol?.declarations?.[0];
        const owner = declaration?.parent;
        if (declaration && owner
          && (ts.isPropertyDeclaration(declaration) || ts.isPropertySignature(declaration) || ts.isParameter(declaration)
            || ts.isGetAccessorDeclaration(declaration))
          && (ts.isClassDeclaration(owner) || ts.isInterfaceDeclaration(owner) || ts.isConstructorDeclaration(owner))) {
          const type = ts.isConstructorDeclaration(owner) ? owner.parent : owner;
          const name = headOf(checker.getSymbolAtLocation((type as TS.ClassDeclaration).name!) ?? undefined);
          if (name) add({ word: "accesses", from: routine.ref, to: `${home(name)}#${name}`, label: child.name.text, how: "written" });
        }
      }
      ts.forEachChild(child, inner);
    })(node.body);
  }

  // conforms: every class or interface each top-level class or interface
  // derives from at any depth, by the compiler's own base types; and, apart,
  // every one it fits without naming it.
  const shapes: Array<{ name: string; type: TS.Type; node: TS.ClassDeclaration | TS.InterfaceDeclaration }> = [];
  for (const source of sources) {
    for (const statement of source.statements) {
      if (!(ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement)) || !statement.name) continue;
      if (home(statement.name.text) !== rel(statement)) continue;
      const symbol = checker.getSymbolAtLocation(statement.name);
      if (!symbol) continue;
      shapes.push({ name: statement.name.text, type: checker.getDeclaredTypeOfSymbol(symbol), node: statement });
    }
  }
  const nominal = new Map<string, Map<string, string>>();
  for (const shape of shapes) {
    const found = new Map<string, string>();
    const visit = (type: TS.Type, depth: number) => {
      if (depth > 12) return;
      const bases: TS.Type[] = [...(checker.getBaseTypes(type as TS.InterfaceType) ?? [])];
      // `implements` is not a base type to the checker; read each clause's type.
      for (const declaration of type.getSymbol()?.declarations ?? []) {
        if (!ts.isClassDeclaration(declaration)) continue;
        for (const clause of declaration.heritageClauses ?? []) {
          if (clause.token !== ts.SyntaxKind.ImplementsKeyword) continue;
          for (const written of clause.types) bases.push(checker.getTypeAtLocation(written));
        }
      }
      for (const base of bases) {
        const target = (base as TS.TypeReference).target ?? base;
        const name = headOf(target.getSymbol());
        if (name && !found.has(name)) {
          found.set(name, depth === 0 ? "written" : "ancestor");
          visit(target, depth + 1);
        }
      }
    };
    visit(shape.type, 0);
    found.delete(shape.name);
    nominal.set(shape.name, found);
    for (const [name, how] of found) {
      add({ word: "conforms", from: `${rel(shape.node)}#${shape.name}`, to: `${home(name)}#${name}`, how });
    }
  }
  // Fits without naming: a non-generic class against every non-generic class
  // or interface with at least one member that it is assignable to. An empty
  // type fits everything, which says nothing.
  const plain = (shape: (typeof shapes)[number]) => !shape.node.typeParameters?.length;
  // At least one member that must be there: a type whose members are all
  // optional is fitted by nearly anything, which says nothing.
  const targets = shapes.filter((shape) => plain(shape)
    && checker.getPropertiesOfType(shape.type).some((member) => !(member.flags & ts.SymbolFlags.Optional)));
  for (const shape of shapes) {
    if (!ts.isClassDeclaration(shape.node) || !plain(shape)) continue;
    for (const target of targets) {
      if (target.name === shape.name || nominal.get(shape.name)!.has(target.name)) continue;
      if (!checker.isTypeAssignableTo(shape.type, target.type)) continue;
      add({ word: "conforms", from: `${rel(shape.node)}#${shape.name}`, to: `${rel(target.node)}#${target.name}`, how: "structural" });
    }
  }
  return pairs;
}
