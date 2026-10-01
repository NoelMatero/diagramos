/**
 * The last thing a red passes before it is shown (#393).
 *
 * #373 drew 448 correct arrows and 58 went red. Every one of those reds read
 * something that was not written -- a field's type, a parameter's, a generic
 * bound, a base list nobody wrote, an import the reader could not place -- and
 * took it for something that was not there. The compiler knew each answer.
 *
 * So every red now carries what it rests on (`RedRests`), and `checkDrift`
 * files it through `gateRed` in one place:
 *
 * - the compiler says the code does what the arrow says: no red;
 * - the compiler says it does not: the red stands;
 * - the compiler cannot say, or is not running: the red stands only if the
 *   reader's evidence was **written** -- a field typed `Motor`, a base list
 *   naming something else. A red built on "not written" is withheld.
 *
 * The question is each word's own, asked through `compiler-questions.ts` and
 * nothing else. The rule is the same for all of them, which is the point: the
 * one mistake became thirteen bugs by being written once per reader.
 */
import { declaredShapes } from "./body";
import { partsInclude, type DeclaredAt, type TypeParts } from "./compiler-questions";
import type { ClosedBodyReferee } from "./drift";
import { each, parseSource, type Language, type Node } from "./parse";

/** What the compiler said about the one thing a red rests on. */
export interface CompilerSaid {
  /**
   * `true`: the code does what the arrow says. `false`: it does not.
   * `undefined`: the compiler could not say.
   */
  does: boolean | undefined;
  /** The answer in a sentence, for the report and for somebody reading why a red went. */
  said?: string;
}

/**
 * What a red rests on, which every accusing verdict has to say.
 *
 * `written` is the whole of the fallback: whether "doesn't" was read off
 * something the code writes down. `unwritten` names what was not, in words.
 * `ask` is the question; a red with nothing the compiler could be asked
 * leaves it out, and stands or goes on `written` alone.
 */
export interface RedRests {
  written: boolean;
  unwritten?: string;
  ask?: (referee: ClosedBodyReferee) => CompilerSaid;
}

/** A red resting only on what the code writes, and on no question: presence reds (drawn backwards). */
export const WRITTEN: RedRests = { written: true };

/** Why a red did not stand. */
export type GateWithdrawn = "compiler-says-it-does" | "rests-on-unwritten";

export type GateVerdict =
  | { stands: true; asked: boolean; said?: string }
  | { stands: false; why: GateWithdrawn; asked: boolean; said?: string; unwritten?: string };

/**
 * The gate. `referee` is whatever this check was handed; absent is no
 * compiler, which is a user with none installed, or CI.
 */
export function gateRed(rests: RedRests, referee: ClosedBodyReferee | undefined): GateVerdict {
  const answer = referee && rests.ask ? rests.ask(referee) : undefined;
  const asked = rests.ask !== undefined;
  const said = answer?.said;
  if (answer?.does === true) return { stands: false, why: "compiler-says-it-does", asked, ...(said ? { said } : {}) };
  if (answer?.does === false || rests.written) return { stands: true, asked, ...(said ? { said } : {}) };
  return {
    stands: false, why: "rests-on-unwritten", asked,
    ...(said ? { said } : {}),
    ...(rests.unwritten ? { unwritten: rests.unwritten } : {}),
  };
}

/**
 * A name a reader read, by its range, and whether the type it stands for is
 * written out: annotated, and not with a type parameter. A reader's absence
 * rests on written evidence only when every site it read is written.
 */
export interface Site {
  name: string;
  start: number;
  end: number;
  written: boolean;
  /**
   * Where the written type is, when one is. A name in it may be an alias,
   * which says nothing about what it stands for (#393), and only a reader
   * with the workspace can look: `drift.ts`'s `throughAliases`.
   */
  annotation?: { start: number; end: number };
}

/** The names of the sites whose type is not written, once each. */
export function unwrittenNames(sites: Site[]): string[] {
  return [...new Set(sites.filter((one) => !one.written).map((one) => one.name))];
}

/**
 * Every type parameter declared anywhere in a file, and Python's module-level
 * `TypeVar`s: a type written as one of these stands for whatever its bound
 * says, which is not written where it is used (#380).
 *
 * The whole file rather than the one declaration's list, because a method's
 * `T` may be the class's or the `impl`'s, and a reader here cannot walk up.
 * Too many names only ever withholds.
 */
export function typeParametersIn(root: Node, source: string): Set<string> {
  const names = new Set<string>();
  each(root, (node) => {
    /*
     * The list: `type_parameters` in TypeScript and Rust, and in Python a
     * `type_parameter` holding each parameter as a `type` -- which in the
     * other two is the name of one parameter, told apart by its `name`.
     */
    const list = node.type === "type_parameters"
      || (node.type === "type_parameter" && !node.childForFieldName("name"));
    if (!list) return;
    // Each parameter's own name, never its bound: `<T extends User>` and
    // `[S: Seat]` declare `T` and `S`. The name comes first in every grammar.
    for (let index = 0; index < node.childCount; index += 1) {
      const parameter = node.child(index);
      if (!parameter?.isNamed) continue;
      let name: Node | null = parameter.childForFieldName("name") ?? parameter.childForFieldName("left") ?? parameter;
      while (name && name.childCount > 0) name = name.child(0);
      if (name && /identifier$/.test(name.type)) names.add(name.text);
    }
  });
  for (const match of source.matchAll(/^([A-Za-z_]\w*)\s*(?::\s*[\w.]+\s*)?=\s*(?:[A-Za-z_]\w*\.)?(?:TypeVar|ParamSpec|TypeVarTuple)\(/gm)) {
    names.add(match[1]!);
  }
  return names;
}

/** Whether a type expression uses any of these type parameters. */
export function usesTypeParameter(type: Node, parameters: Set<string>): boolean {
  let found = false;
  each(type, (node) => { if (node.childCount === 0 && parameters.has(node.text)) found = true; });
  return found;
}

/**
 * Node types of a TypeScript type the text computes rather than names:
 * `typeof f`, `keyof T`, `T["k"]`, `A extends B ? C : D`, `infer U`, a
 * mapped type, a template literal type. `...args: Parameters<typeof f>`
 * names no type at all, so "it names other things" is not read off writing
 * there (#393: 13 correct vue arrows red).
 */
const COMPUTED_TYPE = new Set([
  "type_query", "index_type_query", "lookup_type", "conditional_type", "infer_type",
  "mapped_type_clause", "template_literal_type",
]);

/**
 * Whether what a type annotation says is not written out: it uses a type
 * parameter (`seat: S`), or computes its type rather than naming one.
 */
export function unwrittenType(type: Node, parameters: Set<string>): boolean {
  if (usesTypeParameter(type, parameters)) return true;
  let computed = false;
  each(type, (node) => { if (COMPUTED_TYPE.has(node.type)) computed = true; });
  return computed;
}

/** Declarations that name a type for good: `class`, `interface`, `enum`, `struct`, `trait`. */
const NOMINAL_DECLARATION = /^(class_declaration|abstract_class_declaration|interface_declaration|enum_declaration|class_definition|struct_item|enum_item|trait_item|union_item)$/;
/** Declarations that name another type: `type X = ...` in TypeScript, Rust and Python 3.12. */
const ALIAS_DECLARATION = /^(type_alias_declaration|type_item|type_alias_statement)$/;

/**
 * Whether this file declares `name` as an alias of another type (true), as
 * a type of its own (false), or not at all (undefined).
 *
 * A Python module-level `Name = ...` is an alias too: `Engines = list[Engine]`
 * and `Handler = Union[A, B]` are how Python wrote one before 3.12.
 */
export function declaresAlias(source: string, language: Language, name: string): boolean | undefined {
  const tree = parseSource(source, language);
  if (!tree) return undefined;
  let found: boolean | undefined;
  each(tree.rootNode, (node) => {
    if (found !== undefined) return;
    const declared = node.childForFieldName("name")?.text ?? (node.type === "type_alias_statement" ? node.child(1)?.text : undefined);
    if (declared === name && NOMINAL_DECLARATION.test(node.type)) found = false;
    else if (declared === name && ALIAS_DECLARATION.test(node.type)) found = true;
    else if (language === "python" && node.type === "module") {
      for (let index = 0; index < node.childCount; index += 1) {
        const statement = node.child(index);
        const assignment = statement?.type === "expression_statement" ? statement.child(0) : undefined;
        if (assignment?.type === "assignment" && assignment.childForFieldName("left")?.text === name) found = true;
      }
    }
  });
  return found;
}

/** A place to ask about: a name in a file and its range, as the questions take it. */
export interface AskedAt {
  file: string;
  name: string;
  at: { start: number; end: number };
  /**
   * Whether the reader read this place's answer off something written. Where
   * the compiler cannot say about such a place, the written answer stands for
   * it -- the rule the gate applies to a whole red, applied per place -- so one
   * field the compiler cannot place does not unsettle a list written out in
   * full.
   */
  written?: boolean;
}

/**
 * "Is any of these made of the head?" -- `typePartsAt` at each place, read
 * with `partsInclude` against every declaration of the head's name.
 *
 * Yes at any place is a yes. No needs a no at every place. Anything else is
 * the compiler not saying.
 */
export function askTypeParts(
  referee: ClosedBodyReferee,
  places: AskedAt[],
  head: { name: string; at: DeclaredAt[] },
  what = "is",
  /**
   * Whether a name the answer gives stands for another type. Pyright prints
   * an alias by its name -- `timeout: TimeoutTypes` -- and stops there, so an
   * answer naming one has not said what the place holds (#393).
   */
  alias?: (name: string) => boolean,
): CompilerSaid {
  if (!referee.typePartsAt || places.length === 0 || head.at.length === 0) return { does: undefined };
  let unsure: string | undefined;
  const nos: string[] = [];
  for (const place of places) {
    const answer = referee.typePartsAt(place.file, place.at);
    const found = head.at.map((at) => partsInclude(answer, { name: head.name, at }));
    if (found.includes(true)) {
      return { does: true, said: `\`${place.name}\` ${what} ${printed(answer)}, which is ${head.name}` };
    }
    const unexpanded = alias !== undefined && (answer?.parts ?? []).some((part) => alias(part.name));
    if ((found.includes(undefined) || unexpanded) && !place.written) unsure ??= place.name;
    else nos.push(`\`${place.name}\` ${what} ${printed(answer)}`);
  }
  if (unsure !== undefined) return { does: undefined, said: `the compiler could not say what \`${unsure}\` ${what}` };
  return { does: false, said: nos.join("; ") };
}

/** A type's parts as a reader would say them: `Engine`, `Engine | None`. */
function printed(answer: TypeParts | undefined): string {
  if (!answer || answer.parts.length === 0) return "nothing nameable";
  return answer.parts.map((part) => `\`${part.name}\``).join(" or ");
}

/**
 * Where the head of an arrow is declared, as the questions' answers place a
 * type: its file, and the line of its name. Every declaration of the name in
 * that file, because a compiler placing any of them is placing it.
 */
export function declaredIn(
  source: string,
  language: Language,
  file: string,
  symbol: string,
): { name: string; at: DeclaredAt[] } {
  const name = symbol.split(/::|\./).pop()!;
  const shapes = declaredShapes(source, language)?.get(name) ?? [];
  return {
    name,
    at: [...new Set(shapes.map((shape) => source.slice(0, shape.nameNode.startIndex).split("\n").length))].map((line) => ({ file, line })),
  };
}

/**
 * "Can this be used where the head is wanted?" -- `fitsAt` at each place,
 * against every declaration of the head. Yes anywhere is a yes; no needs a
 * no for every pair.
 */
export function askFits(
  referee: ClosedBodyReferee,
  places: AskedAt[],
  head: { name: string; at: DeclaredAt[] },
): CompilerSaid {
  if (!referee.fitsAt || places.length === 0 || head.at.length === 0) return { does: undefined };
  let unsure = false;
  for (const place of places) {
    for (const at of head.at) {
      const fits = referee.fitsAt(place.file, place.at, at);
      if (fits === true) return { does: true, said: `\`${place.name}\` can be used wherever a \`${head.name}\` is wanted` };
      if (fits === undefined) unsure = true;
    }
  }
  if (unsure) return { does: undefined, said: `the compiler could not say whether \`${places[0]!.name}\` fits` };
  return { does: false, said: `\`${places[0]!.name}\` cannot be used where a \`${head.name}\` is wanted` };
}

/**
 * "Does the member `name` of any of these values land on the head?" --
 * `memberAt` at each place (#384). Yes at any place is a yes; a no needs
 * every place answered and none landing there.
 */
export function askMember(
  referee: ClosedBodyReferee,
  places: AskedAt[],
  name: string,
  head: { name: string; at: DeclaredAt[] },
): CompilerSaid {
  if (!referee.memberAt || places.length === 0 || head.at.length === 0) return { does: undefined };
  let unsure: string | undefined;
  for (const place of places) {
    const landed = referee.memberAt(place.file, place.at, name);
    if (landed === undefined) { unsure ??= place.name; continue; }
    const hit = landed.some((one) => one !== "outside" && head.at.some((at) => at.file === one.file && at.line === one.line));
    if (hit) return { does: true, said: `\`${name}\` on \`${place.name}\` is this ${head.name}` };
  }
  if (unsure !== undefined) return { does: undefined, said: `the compiler could not say what \`${name}\` on \`${unsure}\` is` };
  return { does: false, said: `no value the routine uses has this \`${name}\`` };
}

/**
 * "Does the type named here have a member called `name` at all?" --
 * `memberAt` at the type's own name (#393). Anything it lands on, in the
 * repository or a library's, is a yes; nothing is a no.
 */
export function askHasMember(referee: ClosedBodyReferee, places: AskedAt[], name: string): CompilerSaid {
  if (!referee.memberAt || places.length === 0 || !name) return { does: undefined };
  let unsure = false;
  for (const place of places) {
    const landed = referee.memberAt(place.file, place.at, name);
    if (landed === undefined) { unsure = true; continue; }
    if (landed.length > 0) return { does: true, said: `\`${place.name}\` has a \`${name}\`` };
  }
  return unsure ? { does: undefined } : { does: false, said: `\`${places[0]!.name}\` has no \`${name}\`` };
}
