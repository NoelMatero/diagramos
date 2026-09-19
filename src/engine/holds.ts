/**
 * Whether a type's field list names another type.
 *
 * The gap this closes (#188): the most ordinary thing a data type does is hold
 * another one --
 *
 *     struct RouteInfo { handler: fn(&Request) -> Response }
 *
 * -- and an arrow could not say it. The one hand-drawn claim in this project's
 * whole board corpus was somebody reaching for `@takes` to say exactly this, on
 * a Rust struct they had written themselves, and being told in red that they
 * were wrong. The checker was right, the diagram was right, and the word between
 * them was the only thing available.
 *
 * ## Why this one is allowed an opinion
 *
 * `claim.ts` admits a word that can be called wrong, and being callable-wrong
 * needs a closed region -- somewhere absence is genuinely absence. A function
 * body is not closed, which is why `feeds` confirms and never refutes. A field
 * list is: read the declaration and "this type has no field of that type" is a
 * statement about the whole of it. Same footing as `signature.ts`, and this file
 * is written out of the same refusals, for the same reason.
 *
 * ## The direction, which is a decision rather than an accident
 *
 * The arrow runs **holder -> held**: `RouteInfo -> Response` says RouteInfo has
 * a field whose type names Response.
 *
 * That is the opposite end from `takes` and `returns`, where the declaration
 * being read sits at the *to* end, and the inconsistency is deliberate. Three
 * reasons, in the order they carried weight:
 *
 *  - **The one real author drew it that way.** The hand-drawn arrow on
 *    orangutan's board is `route_info -> user_handler`, unprompted, by the
 *    person who wrote the Rust. `AGENTS.md` treats a sketch as a specification,
 *    and that applies to what it meant as much as to where it sits.
 *  - **It is the established convention for containment.** UML composition and
 *    aggregation point whole to part. Nobody draws a field backwards.
 *  - **A signature claim is about a position, a field claim is about a
 *    structure.** `Request -> handler` reads as a value going in. `RouteInfo ->
 *    Response` reads as a thing containing a thing. Forcing one convention onto
 *    both would make one of them read backwards on every board.
 *
 * The cost is that an author can draw it the wrong way round, and the answer to
 * that is the same one `signature.ts` gives: the reverse direction is named and
 * counted, never confirmed and never a finding. It must not confirm -- a claim
 * that comes back green whichever way it was drawn is decoration in a verdict's
 * clothes, which is the whole of `claim.ts`'s admission rule.
 *
 * ## What a field is, in four grammars and one sentence
 *
 *     a field is a node with a `type`, inside a type declaration's body,
 *     that is not itself a function
 *
 * Rust spells it `field_declaration`, TypeScript `property_signature` or
 * `public_field_definition`, Python an annotated assignment in a class block.
 * The rule above holds for all of them, which is the layer-3 thesis of #190 and
 * the reason this is one reader rather than four.
 *
 * The last clause is not decoration: a method declared in a class body carries a
 * return type, and counting it would make every method a field.
 */
import { aliasesFor, aliasNames } from "./alias";
import { mayAccuse } from "./licence";
import {
  declaresField, each, INSTANCE_NAMES, parseSource, qualifiedTail,
  type Language, type Node,
} from "./parse";

/**
 * Why no verdict was reached. Every one of these is a reason to stay quiet, and
 * the caller reports the arrow exactly as it would have been before anybody
 * claimed anything.
 */
export type HoldsWithheld =
  /** No grammar for this language, or the file would not parse at all. */
  | "unreadable"
  /** Nothing in that file declares that name. The node check reports that itself. */
  | "not-declared"
  /** The name is declared and it is not a type with fields. Nothing to read. */
  | "no-fields"
  /**
   * The parse recovered from an error, so "the type is not in here" is a
   * statement about a file we only partly read.
   */
  | "incomplete"
  /**
   * The name is an alias for a type declared somewhere else -- `type RouteInfo =
   * SomeOtherShape`. Its fields are not here, so "not in this field list" is a
   * fact about the wrong declaration.
   *
   * The same shape `signature.ts` withholds on, and the reason a refutable word
   * needs a file like this one: without this branch the reader returns `absent`
   * on an alias, which is an accusation built on having read the wrong thing.
   */
  | "aliased"
  /**
   * A field's type is written as a string -- `x: "Path | FileSlice"`.
   *
   * How Python writes a forward reference, and the only way to annotate a type
   * imported under `if TYPE_CHECKING`. The names sit inside a string literal
   * rather than as identifiers, so the reader sees none of them, and reporting
   * that as absence is an accusation built on not having looked.
   *
   * The same shape #195 found in the signature reader. Found independently here
   * by `measure-holds.mts`, which is the argument for both existing.
   */
  | "quoted"
  /**
   * The far end of the arrow is a routine, not a type.
   *
   * A category error rather than a false statement, and #190's layer 1 doing
   * real work the first time anything asked it. The live arrow this word was
   * added for is exactly this: `RouteInfo` has a field typed `fn(&Request) ->
   * Response` and the box at the other end is `hello_handler`, a function that
   * *fits* that type rather than a type the field is of.
   *
   * A field list can never name a function, so the question has no answer and
   * an absence is not evidence of anything. Silence -- the engine must not
   * answer a question it was never going to be able to answer.
   */
  | "not-a-type"
  /**
   * The language has a grammar and no measured licence, so nothing has ever
   * checked how often this reader is wrong about it.
   *
   * Confirming is unaffected and stays: finding a name is evidence the name is
   * there whoever reads it. It is the absence that needs a licence, because an
   * absence is a claim about the whole of a declaration and it is what turns a
   * reader's blindness into somebody's wrong diagram (`licence.ts`).
   *
   * Python is the live case. It is the largest field population in the corpus
   * and the only language here with no referee, which is #198.
   */
  | "unlicensed";

/** Where the type was named, so a report can quote a file and a line. */
export interface HoldsEvidence {
  /** The name that was found. */
  name: string;
  /** 1-based. */
  line: number;
  /** The field list as written, so a refutable verdict can show what it read. */
  fields: string;
}

export type HoldsVerdict =
  | { verdict: "confirmed"; evidence: HoldsEvidence }
  | { verdict: "absent"; fields: string }
  | { verdict: "withheld"; why: HoldsWithheld };

/** Node types that declare a type with a member list, in any grammar we load. */
const TYPE_DECLARATION =
  /^(struct_item|enum_item|union_item|trait_item|interface_declaration|class_declaration|abstract_class_declaration|class_definition|object_type)$/;

/** A name a reader would recognise, wherever a grammar puts type names. */
const TYPE_NAME = /(type_identifier|primitive_type|predefined_type)$/;

/** The name a declaration goes by. Python annotates through `left`, not `name`. */
function nameOf(node: Node): string | undefined {
  const name = node.childForFieldName("name") ?? node.childForFieldName("left");
  return name && name.childCount === 0 ? name.text : undefined;
}

/**
 * Every type name written inside a type expression.
 *
 * Generics are read through rather than around: a field typed `Vec<RouteInfo>`,
 * `Promise<Response>` or `list[Route]` holds the inner type in every ordinary
 * reading of a diagram, and a reader taking only the outermost name would report
 * the container and miss the thing being drawn.
 *
 * A built-in is not a leaf, which is the trap #169 hit and this repeats the fix
 * for: TypeScript wraps `string` in a `predefined_type` and Rust wraps `bool` in
 * a `primitive_type`, each with the keyword as a child. Collecting only childless
 * `identifier` nodes sees neither, and a field typed `string` yields no name at
 * all -- a third of the fields in a TypeScript interface.
 */
function typeNamesIn(node: Node): Array<{ name: string; line: number; qualifier?: true }> {
  const names: Array<{ name: string; line: number; qualifier?: true }> = [];
  const visit = (child: Node) => {
    if (TYPE_NAME.test(child.type)) {
      /*
       * A qualified name is one name with a namespace on the front, and the box
       * on a board carries the last part of it -- nobody labels a box
       * `NodeJS.Timeout`. Both are recorded: the full spelling in case somebody
       * anchored it that way, and the tail, which is what a diagram calls it.
       *
       * `nested_type_identifier` and `scoped_type_identifier` both end in
       * `type_identifier`, so they arrive here as a single leaf whose text is
       * the whole dotted string -- and matching that against `Timeout` failed on
       * every React and Node type in the corpus.
       */
      names.push({ name: child.text, line: child.startIndex });
      const tail = child.text.split(/::|\./).pop();
      if (tail && tail !== child.text) names.push({ name: tail, line: child.startIndex });
      return;
    }
    /*
     * A qualified name the grammar gave a node of its own, which is every
     * language whose separator is not part of a type identifier. Python writes
     * `fmt.Formatter` as an `attribute`, and descending into it read `fmt` as a
     * type this class holds -- the #306 bug, in the reader next door.
     *
     * The namespace segments are still recorded, marked as what they are, and
     * the caller keeps them out of the match and in the alias check. They were
     * doing that second job by accident before: `import typing as t` above a
     * field typed `t.ValuesView[..]` is a name in the field list standing for
     * something else, which is a reason to withhold, and dropping the segment
     * altogether turned one of flask's withheld arrows into a red.
     */
    const tail = qualifiedTail(child);
    if (tail) {
      names.push({ name: child.text, line: child.startIndex });
      for (let index = 0; index < child.childCount; index += 1) {
        const part = child.child(index);
        if (!part || part.id === tail.id || !part.isNamed) continue;
        each(part, (leaf) => {
          if (leaf.childCount === 0 && leaf.type === "identifier") {
            names.push({ name: leaf.text, line: leaf.startIndex, qualifier: true });
          }
        });
      }
      visit(tail);
      return;
    }
    if (child.childCount === 0) {
      if (child.type === "identifier") names.push({ name: child.text, line: child.startIndex });
      return;
    }
    for (let index = 0; index < child.childCount; index += 1) {
      const grandchild = child.child(index);
      if (grandchild) visit(grandchild);
    }
  };
  visit(node);
  return names;
}

/**
 * Whether any field in this member list writes its type as a string.
 *
 * Deliberately about the *type position* only. A class with a docstring, or a
 * field defaulting to `"json"`, has strings all over it and none of them hide a
 * type name; silencing on those would take the refusal rate somewhere useless.
 */
function quotedTypeIn(body: Node): boolean {
  let quoted = false;
  const visit = (member: Node, depth: number) => {
    if (quoted) return;
    if (depth > 0 && member.childForFieldName("parameters")) return;
    if (depth > 0 && (member.type === "object_type" || TYPE_DECLARATION.test(member.type))) return;
    const type = member.childForFieldName("type");
    if (depth > 0 && type) {
      each(type, (node) => {
        if (node.type === "string" || node.type === "string_literal") quoted = true;
      });
      return;
    }
    for (let index = 0; index < member.childCount; index += 1) {
      const child = member.child(index);
      if (child) visit(child, depth + 1);
    }
  };
  visit(body, 0);
  return quoted;
}

/**
 * Fields a class declares inside one of its own routines.
 *
 * The largest source of false reds #301 found -- 7 of its 8, across vue, nest,
 * httpx, flask and poetry. A field list is only a closed region if it is the
 * whole list, and in two of these languages a great deal of it is written
 * inside the constructor instead:
 *
 *     constructor(public dep: Dep)            TypeScript declares it here
 *     self._request: Request | None = request  Python declares it here
 *
 * Neither appears anywhere in the class body, so a walk that stops at the
 * first thing with a parameter list reads the class as holding almost nothing
 * and then refutes almost every arrow drawn at one. Rust has neither shape --
 * a struct lists every field on the declaration -- so nothing here changes a
 * Rust answer.
 *
 * Both signals come from `parse.ts` so that `accesses.ts`, which reads the
 * same two shapes for member *names*, cannot disagree with this about what a
 * class declares.
 *
 * It only ever adds names, so it can turn an absence into a confirmation and
 * never the other way about: no accusation here is new.
 */
function declaredInRoutine(routine: Node): Array<{ name: string; line: number }> {
  const found: Array<{ name: string; line: number }> = [];

  const parameters = routine.childForFieldName("parameters");
  if (parameters) {
    for (let index = 0; index < parameters.childCount; index += 1) {
      const parameter = parameters.child(index);
      if (!parameter || !declaresField(parameter)) continue;
      const type = parameter.childForFieldName("type");
      if (type) found.push(...typeNamesIn(type));
    }
  }

  /*
   * An annotated assignment onto the instance. Read through the grammar's own
   * fields -- `left` and `type` on the assignment, `object` on the member
   * access -- rather than by node type, which spells this differently in every
   * language that has it.
   *
   * Annotated only, because an unannotated `self.x = x` writes no type down
   * and there is nothing for a field claim to read. That is the reason this
   * cannot silence an absence instead of answering it: a Python class that
   * assigns its attributes without annotating them says nothing either way,
   * which is what it said before.
   */
  const body = routine.childForFieldName("body");
  if (body) {
    each(body, (node) => {
      const left = node.childForFieldName("left");
      const type = node.childForFieldName("type");
      if (!left || !type) return;
      const object = left.childForFieldName("object");
      if (!object || !INSTANCE_NAMES.has(object.text)) return;
      found.push(...typeNamesIn(type));
    });
  }

  return found;
}

/**
 * Whether a name is declared as a routine in this source.
 *
 * `parse.ts`'s generic rule: a function is a declaration that also has a `body`.
 * Deliberately narrow -- it answers only about names this file declares, and a
 * name it cannot find is not a routine as far as anybody here knows, which
 * leaves the ordinary path untouched.
 */
function isRoutine(source: string, language: Language, name: string): boolean {
  const tree = parseSource(source, language);
  if (!tree) return false;
  let routine = false;
  each(tree.rootNode, (node) => {
    if (routine) return;
    if (nameOf(node) !== name) return;
    if (node.childForFieldName("body") && node.childForFieldName("parameters")) routine = true;
  });
  return routine;
}

/** 1-based line of a byte offset, counted the way an editor counts. */
const lineOf = (source: string, offset: number) =>
  source.slice(0, offset).split("\n").length;

/**
 * What one type's field list says about a set of type names.
 *
 * `targets` is every name the far box stands for, and any one of them is enough
 * -- the same any-of-the-members rule the call check and the signature check use.
 */
export function heldTypes(
  source: string,
  holder: string,
  targets: string[],
  language: Language,
  /**
   * The far end's own source, when the caller has it, so the sort of the thing
   * being claimed can be checked before its absence is read as evidence.
   *
   * Optional because the reader is useful without it -- every test that names
   * two types in one file passes it nothing -- and because a caller that cannot
   * produce the file should get the same answer it always did rather than a
   * refusal it cannot act on.
   */
  target?: { source: string; language: Language },
): HoldsVerdict {
  const tree = parseSource(source, language);
  if (!tree) return { verdict: "withheld", why: "unreadable" };
  if (tree.rootNode.hasError) return { verdict: "withheld", why: "incomplete" };

  /*
   * `type X = { ... }` carries its name on the alias and its fields on the
   * `object_type` underneath, so neither node answers on its own: the named one
   * has no members and the one with members has no name.
   */
  const declarations: Node[] = [];
  each(tree.rootNode, (node) => {
    const named = TYPE_DECLARATION.test(node.type) || node.type === "type_alias_declaration";
    if (named && nameOf(node) === holder) declarations.push(node);
  });
  if (declarations.length === 0) return { verdict: "withheld", why: "not-declared" };

  /*
   * The sort check, before anything else is read. A routine at the far end
   * makes this claim a category error, and an absence found afterwards would be
   * an accusation about a question that has no answer.
   */
  if (target && targets.some((name) => isRoutine(target.source, target.language, name))) {
    return { verdict: "withheld", why: "not-a-type" };
  }

  /*
   * Names that are not what they say, from the two places one can be hidden:
   * this file's own renames and aliases, and what the *target's* file calls the
   * type besides its own name -- `use crate::model::{Req, Request}` where
   * `model.rs` says `pub type Req = Request`, which nothing in this file marks
   * as anything but an import (#303).
   */
  const shadows = aliasNames(tree.rootNode);
  if (target) for (const name of aliasesFor(target.source, target.language, targets)) shadows.add(name);
  const wanted = new Set(targets);
  let sawFields = false;
  let quoted = "";
  /*
   * Every declaration of the name, and the safest answer wins -- the rule
   * `signature.ts` arrived at after reading only the first one judged the wrong
   * declaration six times in 159 on real Rust. Any declaration that confirms,
   * confirms; failing that, a single reason to withhold silences the whole
   * answer, because "one of these could be hiding it" is exactly the doubt that
   * forbids an accusation.
   */
  let withheld: HoldsWithheld | undefined;

  for (const declaration of declarations) {
    let body = declaration.type === "object_type"
      ? declaration
      : declaration.type === "type_alias_declaration"
        ? declaration.childForFieldName("value")
        : declaration.childForFieldName("body");
    /*
     * An alias to a bare name stands for a declaration that is not in front of
     * us. Only the object form -- `type X = { ... }` -- carries fields of its own.
     */
    if (declaration.type === "type_alias_declaration" && body?.type !== "object_type") {
      withheld = "aliased";
      continue;
    }
    if (!body) continue;
    sawFields = true;
    if (!quoted) quoted = body.text.replace(/\s+/g, " ").trim();

    // Walk down from the body rather than asking a member who its parent is:
    // `Node` here exposes no parent, and the census in #187 read 0 fields in
    // every language for exactly that reason.
    const found: Array<{ name: string; line: number; qualifier?: true }> = [];
    const fields = (member: Node, depth: number) => {
      /*
       * A routine, not a field. A method in a class body has a return type and
       * typed parameters, and counting those would make every method a field
       * and every parameter a held type.
       *
       * Discriminated on `parameters` rather than on having a body, which was
       * the first attempt and skipped every Rust enum variant: `Adhoc(Payload)`
       * is an `enum_variant` carrying a body, and a variant's payload is held by
       * the enum in exactly the sense a struct field is.
       */
      if (depth > 0 && member.childForFieldName("parameters")) {
        // ... unless it declares one on the way. A constructor is where
        // TypeScript and Python put most of a real class's fields (#303).
        found.push(...declaredInRoutine(member));
        return;
      }
      // A nested type is its own declaration and `each` reaches it on its own;
      // descending here as well would count its fields twice.
      if (depth > 0 && (member.type === "object_type" || TYPE_DECLARATION.test(member.type))) return;
      const type = member.childForFieldName("type");
      if (depth > 0 && type) {
        found.push(...typeNamesIn(type));
        return;
      }
      for (let index = 0; index < member.childCount; index += 1) {
        const child = member.child(index);
        if (child) fields(child, depth + 1);
      }
    };
    fields(body, 0);

    /*
     * Whether any field's type was written as a string. Read off the member
     * types rather than the whole declaration, so a docstring or a default
     * value of `"json"` does not silence a type whose annotations are all plain.
     */
    const quotedFields = quotedTypeIn(body);

    // A namespace segment is not a name this type holds (#306), and it is in
    // the list only for the alias check below.
    const hit = found.find((candidate) => !candidate.qualifier && wanted.has(candidate.name));

    /*
     * A quoted annotation hides every name it contains, so an absence here is
     * about what the reader could see rather than about what the type holds.
     * Checked only when nothing was found, for the same reason the alias check
     * below is: a confirmation the reader plainly has should not be thrown away.
     */
    if (!hit && quotedFields) {
      withheld = "quoted";
      continue;
    }

    /*
     * A name in the field list standing for something else means absence stops
     * proving anything -- but only when there is an absence to explain.
     *
     * The order of these two is the whole of it, and getting it wrong is not
     * academic: checking the shadows first silenced every type that had *any*
     * aliased field, including the ones whose answer was sitting right there.
     * `measure-holds.mts` put that at 48% of Python types and 28% of TypeScript
     * ones -- a word that ships and almost never fires, which `signature.ts`
     * warns about in the same breath as the false red.
     */
    if (!hit && found.some((candidate) => shadows.has(candidate.name))) {
      withheld = "aliased";
      continue;
    }

    if (hit) {
      return {
        verdict: "confirmed",
        evidence: { name: hit.name, line: lineOf(source, hit.line), fields: quoted },
      };
    }
  }

  if (withheld) return { verdict: "withheld", why: withheld };
  if (!sawFields) return { verdict: "withheld", why: "no-fields" };
  // The last gate, and the only one that is about us rather than about the code.
  if (!mayAccuse("holds", language)) return { verdict: "withheld", why: "unlicensed" };
  return { verdict: "absent", fields: quoted };
}
