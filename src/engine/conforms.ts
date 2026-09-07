/**
 * Whether a type's declaration says it is one of another type.
 *
 * The gap this closes (#216): the second of the two relations the #187 census
 * left with no word. A class inheriting a base, an interface extending another,
 * a struct implementing a trait --
 *
 *     class Handler(Base):
 *     class Store extends Cache implements Reader
 *     impl Router for Orangutan
 *
 * -- and an arrow could not say any of it. 2,919 of them in the corpus, 2,352
 * between two boxes a diagram could actually draw, and until this word existed
 * every one was an arrow claiming nothing: the check looked for any connection,
 * found the import that inheritance always brings with it, and went quiet.
 * Including when the arrow was drawn from the base down to the subclass, which
 * is the mistake anybody makes from habit.
 *
 * ## The direction
 *
 * The arrow runs **subtype -> supertype**: `Handler -> Base` says Handler's
 * declaration names Base as something it is one of.
 *
 * Subject first, the way `holds`, `builds`, `calls` and `accesses` are drawn --
 * the thing being described at the tail. It is also the way every class diagram
 * for thirty years has drawn a generalisation, and the way the one arrow of
 * prose in the census wrote it: `extend`, tail to head.
 *
 * The cost is that an author can draw it the wrong way round, and that is the
 * case this word is worth having for. It must never confirm both ways -- a
 * claim that comes back green whichever way it was drawn is decoration in a
 * verdict's clothes -- so the reverse is *named* on the refutation instead, and
 * the report can tell somebody to turn the arrow round rather than leaving them
 * to work out which end was wrong.
 *
 * ## Why this one may accuse, and where it may not
 *
 * A base list is written in the declaration and it is closed: a base that is
 * not in it is not a base. So an absence here is genuinely an absence, the
 * footing `holds` and `takes` stand on, and this file is written almost
 * entirely out of the places that stops being true.
 *
 * **That is Python and TypeScript, and it is not Rust.** `impl Trait for Type`
 * is a free-standing item that may sit in any file in the crate, next to
 * neither the trait nor the type. Reading `struct Type` tells you nothing about
 * what it implements, so the region is the crate rather than the declaration
 * and an absence in one file proves nothing at all. Rust confirms what it finds
 * and says why it cannot do more -- `region-is-the-crate`, out loud in the
 * report, because a refusal nobody is told about looks exactly like a claim
 * that passed.
 *
 * That split is what the #209 licence grid exists to record: one word, two
 * footings, and the language says which. Getting it wrong in the permissive
 * direction would put a false red in the language this project has the least of
 * and understands worst.
 *
 * ## Where it stops
 *
 * - **Not structural typing.** A TypeScript object that satisfies an interface
 *   without naming it, or a Python class that satisfies a Protocol the same
 *   way, is written down nowhere. Nothing here can read it, so an arrow drawn
 *   at one is refused rather than answered.
 * - **Not transitive.** `A extends B extends C` confirms `A -> B`. It says
 *   nothing about `A -> C`, and pretending otherwise would need a resolver for
 *   every base in the tree, which is a different measurement.
 * - **Not a trait bound.** `fn f<T: Display>` constrains a parameter. It is not
 *   a claim that any type conforms to anything.
 *
 * ## Four spellings, and one of them is 470 of the population
 *
 *     class Handler(Base)          python      superclasses on the declaration
 *     class A extends B            typescript  an extends clause under the heritage
 *     class A implements C         typescript  an implements clause, same place
 *     interface X extends Y        typescript  an extends-type clause
 *     impl Trait for Type          rust        a free-standing item, anywhere
 *
 * The fourth is not a footnote. Every one of the 313 `conforms` facts in tsx is
 * `interface X extends Y` and there is not one class heritage clause in any
 * `.tsx` file in the corpus -- so a reader written for `class_declaration` alone
 * would refuse the largest TypeScript case and the refusal would read as a
 * language problem instead of a missing branch. That number was only visible
 * because the census had been counting all three TypeScript spellings in one
 * bucket and #216 made it split them.
 */
import { mayAccuse } from "./licence";
import { each, parseSource, type Language, type Node } from "./parse";

/**
 * Why no verdict was reached. Every one is a reason to stay quiet, and the
 * caller reports the arrow exactly as it would have been before anybody claimed
 * anything.
 */
export type ConformsWithheld =
  /** No grammar for this language, or the file would not parse at all. */
  | "unreadable"
  /**
   * The parse recovered from an error, so "this is not one of its bases" is a
   * statement about a file we only partly read.
   */
  | "incomplete"
  /** Nothing in that file declares that name. */
  | "not-declared"
  /**
   * The tail is a routine rather than a type.
   *
   * A category error, and the one this word will meet most: a function that
   * *satisfies* a protocol or a function-pointer type is the thing people reach
   * for this arrow to say, and it is exactly the structural claim that is not on
   * offer. A routine has no base list, so the question has no answer -- and a
   * question with no answer must be said out loud rather than withheld quietly,
   * which is `holds`'s `not-a-type` and the same reasoning.
   */
  | "subject-not-a-type"
  /**
   * The far end is a routine rather than a type. Nothing can be one of a
   * function, so the same category error one end over.
   */
  | "not-a-type"
  /**
   * The tail's own name stands for a type declared somewhere else -- `type
   * Handler = SomeOtherShape`. Its bases are not here, or a base is imported
   * under another name, so an absence is a fact about the wrong declaration.
   */
  | "aliased"
  /**
   * A base is an expression rather than a name: `class A extends mixin(B)`,
   * `class X(make_base())`, `class Y(*bases)`.
   *
   * The mixin pattern, and Python's class factories. What the base *is* cannot
   * be read off the text at all, so an absence here is a fact about a name the
   * reader never saw. Refused by default rather than by enumeration: anything
   * in a base position that is not plainly a name lands here.
   */
  | "computed-base"
  /**
   * Rust, and the reason it may confirm and never accuse.
   *
   * `impl Trait for Type` is a free-standing item. It may sit in any file in
   * the crate, next to neither the trait nor the type, so reading the
   * declaration enumerates nothing and an absence proves nothing. Named rather
   * than folded into `unlicensed` because they are different sentences: this one
   * says the fact is not in front of us, and no measurement of any reader would
   * change it.
   */
  | "region-is-the-crate"
  /**
   * The language has a grammar and no measured licence for this word, so nothing
   * has ever checked how often this reader is wrong about it.
   *
   * Confirming is unaffected and stays. It is the absence that needs a licence,
   * because an absence is a claim about the whole of a declaration and it is
   * what turns a reader's blindness into somebody's wrong diagram.
   */
  | "unlicensed";

/** Where the base was named, so a report can quote a file and a line. */
export interface ConformsEvidence {
  /** The name that was found. */
  name: string;
  /** 1-based. */
  line: number;
  /** The heritage as written, so a verdict can show what it read. */
  bases: string;
}

export type ConformsVerdict =
  | { verdict: "confirmed"; evidence: ConformsEvidence }
  | {
    verdict: "absent";
    /** What the declaration does say it is one of, or "" for nothing at all. */
    bases: string;
    /**
     * The far end declares *this* end as one of its bases, so the arrow is not
     * merely wrong -- it is the right fact drawn backwards.
     *
     * Never a confirmation, for the reason the direction section gives. It is
     * carried so the report can name the fix instead of leaving somebody to
     * work out which end was wrong.
     */
    reversed?: boolean;
  }
  | { verdict: "withheld"; why: ConformsWithheld };

/** Node types that declare a type which can name what it is one of. */
const TYPE_DECLARATION =
  /^(struct_item|enum_item|union_item|trait_item|interface_declaration|class_declaration|abstract_class_declaration|class_definition)$/;

/**
 * The clause a grammar hangs a base list on.
 *
 * `class_heritage` is TypeScript's wrapper and holds the clause that says which
 * kind it is, so it is read through rather than counted; the others are the
 * clause itself.
 */
const HERITAGE = new Set([
  "class_heritage", "extends_clause", "implements_clause", "extends_type_clause",
  "trait_bounds",
]);

/**
 * A base position holding a plain name, which is the only thing this reader will
 * read a base out of.
 *
 * A whitelist, and the default is to refuse -- see `computed-base`. Every
 * grammar allows an arbitrary expression where a base goes, and a reader that
 * took the identifiers out of one would read `mixin(B)` as a base called
 * `mixin`, then call the arrow to `B` wrong on the strength of it.
 */
const BASE_NAME = new Set([
  "identifier", "type_identifier", "attribute", "member_expression",
  "nested_type_identifier", "scoped_type_identifier", "qualified_type",
  "predefined_type", "primitive_type",
]);

/**
 * A base wearing type arguments: the name is inside, and the arguments are not
 * bases of anything.
 */
const BASE_APPLIED = new Set(["generic_type", "subscript", "type_constructor"]);

/**
 * Nodes in a base list that are not bases and are not evidence of anything.
 *
 * Two of these were found by `measure:conforms` on the first run.
 *
 * `keyword_argument` is the one that changes an answer: `class Handler(Base,
 * metaclass=ABCMeta)` names one base and one keyword, and reading the keyword's
 * value as a base would confirm an arrow drawn at `ABCMeta`.
 *
 * `type_arguments` is the one that cost a measurement. TypeScript hangs a
 * class's type arguments off the clause as a *sibling* of the base name --
 * `extends ReactStore` then `<ListboxState, ListboxContext, typeof selectors>`
 * -- rather than wrapping the two together the way it does in an interface's
 * heritage. With no rule for that node it fell through to "not a name I can
 * read", and the whole declaration carried a doubt that silences every absence
 * on it. Confirmations were unaffected, which is why it took a run over real
 * code to see at all.
 */
const NOT_A_BASE = new Set([
  "keyword_argument", "comment", "lifetime", "type_parameters", "type_arguments",
  "type_query",
]);

/** A name a reader would recognise, wherever a grammar puts type names. */
const TYPE_NAME = /(type_identifier|primitive_type|predefined_type)$/;

/** Node types that can rename something on the way in, if they actually do. */
const RENAMES = new Set([
  "import_specifier", "aliased_import", "export_specifier", "use_as_clause",
]);

/** Node types that introduce a name for a type written elsewhere. */
const ALIASES = new Set(["type_alias_declaration", "type_item"]);

/**
 * Names in this file that stand for something other than themselves.
 *
 * A class extending `B`, where `import { Base as B }` sits above it, extends
 * Base -- and a reader comparing spellings calls the arrow to Base wrong.
 *
 * Only a rename that actually renames. Every grammar gives a plain named import
 * the same node type as a renamed one and the `alias` field is the only thing
 * separating them; treating every import as a possible rename took the signature
 * reader's refusal rate to 42% when #169 measured it, which is a word that ships
 * and never fires.
 *
 * A near-copy of the one in `holds.ts`, deliberately. Both readers can accuse,
 * each was measured on its own against its own referee, and sharing this would
 * mean a change made for one word silently moves the other word's numbers.
 */
function shadowNames(root: Node): Set<string> {
  const shadows = new Set<string>();
  each(root, (node) => {
    if (RENAMES.has(node.type)) {
      const alias = node.childForFieldName("alias");
      if (alias && alias.childCount === 0) shadows.add(alias.text);
      return;
    }
    if (ALIASES.has(node.type)) {
      const name = node.childForFieldName("name");
      if (name) shadows.add(name.text);
    }
  });
  return shadows;
}

/** The name a declaration goes by. Python annotates through `left`, not `name`. */
function nameOf(node: Node): string | undefined {
  const name = node.childForFieldName("name") ?? node.childForFieldName("left");
  return name && name.childCount === 0 ? name.text : undefined;
}

/**
 * The name in one base position, and nothing else in it.
 *
 * Read *around* type arguments rather than through them, which is the opposite
 * of what `holds.ts` does and is a decision rather than an inconsistency. A
 * field typed `Vec<RouteInfo>` really does hold a RouteInfo, so reading through
 * is the whole answer there. `class Store extends Cache<Entry>` says Store is
 * one of Cache; it does not say Store is one of Entry, and confirming that
 * would be answering `type-argument` -- 12.6% of all code and deliberately
 * outside this vocabulary (#187) -- with the wrong word.
 *
 * A qualified name comes back twice: the full spelling in case somebody anchored
 * a box that way, and the tail, which is what a diagram calls it. Nobody labels
 * a box `abc.ABCMeta`.
 */
function baseNameIn(node: Node): Array<{ name: string; at: number }> | "computed" {
  if (BASE_NAME.has(node.type) || TYPE_NAME.test(node.type)) {
    const names = [{ name: node.text, at: node.startIndex }];
    const tail = node.text.split(/::|\./).pop();
    if (tail && tail !== node.text) names.push({ name: tail, at: node.startIndex });
    return names;
  }
  if (BASE_APPLIED.has(node.type)) {
    /*
     * The applied name, which is the first thing under here that is a name. A
     * `subscript` puts it on `value` and a `generic_type` on `type`; taking the
     * first named child that is not the argument list covers both without a
     * per-grammar branch.
     */
    const applied = node.childForFieldName("value") ?? node.childForFieldName("type");
    if (applied) return baseNameIn(applied);
    for (let index = 0; index < node.childCount; index += 1) {
      const child = node.child(index);
      if (!child || !child.isNamed || NOT_A_BASE.has(child.type)) continue;
      return baseNameIn(child);
    }
    return "computed";
  }
  return "computed";
}

/**
 * The bases one heritage clause names, or that it names something unreadable.
 *
 * Punctuation and keywords arrive as anonymous nodes whose type is the text --
 * `extends`, `,`, `(` -- and are skipped by having no name of their own. What is
 * left is either a name this reader knows how to read or a reason to refuse.
 */
function basesIn(clause: Node): { names: Array<{ name: string; at: number }>; computed: boolean } {
  const names: Array<{ name: string; at: number }> = [];
  let computed = false;
  for (let index = 0; index < clause.childCount; index += 1) {
    const child = clause.child(index);
    if (!child) continue;
    // TypeScript's wrapper: the clause underneath says which kind this is.
    if (HERITAGE.has(child.type)) {
      const inner = basesIn(child);
      names.push(...inner.names);
      computed = computed || inner.computed;
      continue;
    }
    if (NOT_A_BASE.has(child.type)) continue;
    // An anonymous node -- `extends`, `implements`, `,`, `(`, `:`, `+`.
    if (!child.isNamed) continue;
    const read = baseNameIn(child);
    if (read === "computed") computed = true;
    else names.push(...read);
  }
  return { names, computed };
}

/**
 * Whether a name is declared as a routine in this source.
 *
 * `parse.ts`'s generic rule: a function is a declaration that also has a body
 * and parameters. Deliberately narrow -- it answers only about names this file
 * declares, and a name it cannot find is not a routine as far as anybody here
 * knows, which leaves the ordinary path untouched.
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

/**
 * The traits this file says are implemented for a type.
 *
 * Rust's whole story, and the reason this is a search rather than a read: the
 * fact is on an `impl` item somewhere in the crate rather than on the type. What
 * this finds is proof; what it fails to find is not evidence of anything.
 */
function implementedFor(root: Node, holder: string): Array<{ name: string; at: number }> {
  const found: Array<{ name: string; at: number }> = [];
  each(root, (node) => {
    if (node.type !== "impl_item") return;
    const trait = node.childForFieldName("trait");
    const forType = node.childForFieldName("type");
    if (!trait || !forType) return;
    const implFor = baseNameIn(forType);
    if (implFor === "computed") return;
    if (!implFor.some((candidate) => candidate.name === holder)) return;
    const implemented = baseNameIn(trait);
    if (implemented !== "computed") found.push(...implemented);
  });
  return found;
}

/**
 * The traits a Rust type derives.
 *
 * `#[derive(Clone, Debug)]` generates the impls at compile time, so there is no
 * `impl Clone for Config` anywhere in the source and a reader that only looks
 * for impl blocks sees none of it. Measured over the five pinned Rust clones
 * that is the **larger half of the relation**: 1,401 written trait impls
 * against 3,741 derived conformances.
 *
 * A confirmation and never anything else, which is the whole of Rust here. A
 * derive list is written on the declaration, so it looks like a closed region
 * and is not one: the trait may be implemented by hand in any file in the
 * crate, so a name missing from the derives proves nothing at all.
 *
 * The attributes are **siblings** of the declaration rather than children of
 * it, and this `Node` exposes no parent -- so the run of `attribute_item`s
 * immediately before an item is tracked on the way down. Anything that is not
 * an attribute resets the run, which is what stops one type's derives being
 * lent to the type declared after it.
 */
function derivedBy(root: Node, subject: string): Array<{ name: string; at: number }> {
  const found: Array<{ name: string; at: number }> = [];
  const visit = (node: Node) => {
    let attributes: Node[] = [];
    for (let index = 0; index < node.childCount; index += 1) {
      const child = node.child(index);
      if (!child) continue;
      if (child.type === "attribute_item") {
        attributes.push(child);
        continue;
      }
      if (TYPE_DECLARATION.test(child.type) && nameOf(child) === subject) {
        for (const attribute of attributes) found.push(...derivesIn(attribute));
      }
      attributes = [];
      visit(child);
    }
  };
  visit(root);
  return found;
}

/**
 * The trait names in one `#[derive(..)]`, or nothing if it is another attribute.
 *
 * The argument list is a `token_tree` -- an unparsed run of tokens, so
 * `serde::Serialize` arrives as two identifiers and a `::` between them and
 * there is no node standing for the path. Read as text for that reason, which
 * is the one place in this file that happens: the grammar has not parsed it, so
 * there is nothing else to read.
 *
 * `#[serde(rename_all = "kebab-case")]` is configuration rather than a
 * conformance, and confirming `rename_all` off it would be a green on a claim
 * nothing could ever refute. So only `derive` is read, by name.
 */
function derivesIn(attribute: Node): Array<{ name: string; at: number }> {
  let arguments_: Node | undefined;
  let isDerive = false;
  const inner = (node: Node) => {
    for (let index = 0; index < node.childCount; index += 1) {
      const child = node.child(index);
      if (!child) continue;
      if (child.type === "attribute") {
        const name = child.child(0);
        isDerive = name?.text === "derive";
        inner(child);
        continue;
      }
      if (child.type === "token_tree") arguments_ ??= child;
    }
  };
  inner(attribute);
  if (!isDerive || !arguments_) return [];
  return arguments_.text
    .replace(/^\(|\)$/g, "")
    .split(",")
    .map((written) => written.trim().split("::").pop()?.trim() ?? "")
    .filter((name) => /^[A-Za-z_]\w*$/.test(name))
    .map((name) => ({ name, at: arguments_!.startIndex }));
}

/** 1-based line of a byte offset, counted the way an editor counts. */
const lineOf = (source: string, offset: number) =>
  source.slice(0, offset).split("\n").length;

/**
 * What a declaration says its type is one of, without asking whether anybody is
 * allowed to accuse on the strength of it.
 *
 * The reader's closed-region half, exported for one reason: the licence gate
 * lives in `conformedTypes`, so with no measurement every refutation comes back
 * `unlicensed` -- and `measure-conforms.mts` is the run that has to produce the
 * measurement in the first place. A number that cannot be non-zero is not a
 * measurement. This is one of the reader's halves rather than a door cut for
 * the harness, and `conformedTypes` is nothing but this plus the two questions
 * about the far end and the gate.
 */
export type BasesRead =
  | {
    /** Every name written in a base position, read through generics. */
    bases: Array<{ name: string; at: number }>;
    /** The heritage as written, so a verdict can show what it read. */
    written: string;
    /**
     * Whether an absence here means anything.
     *
     * True for a declaration's own base list, which can be listed in full.
     * False for a search of the file for a free-standing `impl`, which is
     * whatever happened to be in front of us.
     */
    closed: boolean;
    /**
     * A reason an absence would prove nothing, if there turns out to be one.
     *
     * Carried rather than returned, because it only matters when nothing was
     * found: checking it first throws away confirmations sitting in plain sight
     * beside it, which `measure-holds.mts` put at 48% of Python types when
     * `holds` got that order wrong.
     */
    doubt?: "computed-base" | "aliased";
  }
  | { why: ConformsWithheld };

export function declaredBases(
  source: string,
  subject: string,
  language: Language,
): BasesRead {
  const tree = parseSource(source, language);
  if (!tree) return { why: "unreadable" };
  if (tree.rootNode.hasError) return { why: "incomplete" };

  /*
   * The sort of the tail, before its declaration is looked for.
   *
   * A routine has no base list, so this is a category error rather than a false
   * statement -- and it has to be checked ahead of `not-declared`, or the
   * commonest authoring mistake this word will meet comes back as "nothing
   * declares that name" about a name that is declared in plain sight.
   */
  if (isRoutine(source, language, subject)) return { why: "subject-not-a-type" };

  const declarations: Node[] = [];
  each(tree.rootNode, (node) => {
    const named = TYPE_DECLARATION.test(node.type) || node.type === "type_alias_declaration";
    if (named && nameOf(node) === subject) declarations.push(node);
  });
  if (declarations.length === 0) return { why: "not-declared" };

  const shadows = shadowNames(tree.rootNode);
  const bases: Array<{ name: string; at: number }> = [];
  const written: string[] = [];
  let closed = true;
  let doubt: "computed-base" | "aliased" | undefined;

  /*
   * Rust first, because it is not answering the same question. The fact lives on
   * a free-standing `impl`, so what this finds is proof and what it fails to
   * find is not evidence of anything -- which is the whole of `closed`.
   */
  if (language === "rust") {
    const implemented = implementedFor(tree.rootNode, subject);
    if (implemented.length > 0) {
      bases.push(...implemented);
      written.push(implemented.map((candidate) => candidate.name).join(", "));
    }
    const derived = derivedBy(tree.rootNode, subject);
    if (derived.length > 0) {
      bases.push(...derived);
      written.push(`derive(${derived.map((candidate) => candidate.name).join(", ")})`);
    }
  }

  /*
   * Every declaration of the name, and the safest answer wins -- the rule
   * `signature.ts` arrived at after reading only the first one judged the wrong
   * declaration six times in 159 on real Rust. Anything any of them names is a
   * confirmation; a single reason to doubt silences an absence, because "one of
   * these could be hiding it" is exactly the doubt that forbids an accusation.
   */
  for (const declaration of declarations) {
    /*
     * `type Handler = Base` names a type declared elsewhere. Its bases are not
     * in front of us, and an intersection -- `type A = B & C` -- is structural
     * rather than a declaration that A is one of B, which is the thing this word
     * does not do.
     */
    if (declaration.type === "type_alias_declaration") {
      closed = false;
      doubt ??= "aliased";
      continue;
    }

    const clauses: Node[] = [];
    const superclasses = declaration.childForFieldName("superclasses");
    if (superclasses) clauses.push(superclasses);
    for (let index = 0; index < declaration.childCount; index += 1) {
      const child = declaration.child(index);
      if (child && HERITAGE.has(child.type)) clauses.push(child);
    }

    /*
     * A Rust type carries no base list of its own, so an empty one is not an
     * empty region -- it is the wrong place to be looking. The difference
     * between "it implements nothing" and "what it implements is not written
     * here", and the second one is never a finding.
     *
     * A `trait Foo: Bar` does write its supertraits on the declaration and that
     * list *is* closed. So the region is fine for that one shape and the
     * measurement is what is missing, which is a different sentence and the
     * licence's to say.
     */
    if (language === "rust" && clauses.length === 0) {
      closed = false;
      continue;
    }

    for (const clause of clauses) {
      const read = basesIn(clause);
      bases.push(...read.names);
      if (read.computed) doubt ??= "computed-base";
    }
    const text = clauses.map((clause) => clause.text.replace(/\s+/g, " ").trim()).join(" ").trim();
    if (text) written.push(text);
  }

  if (doubt === undefined && bases.some((candidate) => shadows.has(candidate.name))) {
    doubt = "aliased";
  }
  return { bases, written: written.join(" · "), closed, ...(doubt ? { doubt } : {}) };
}

/**
 * What one type's declaration says about a set of type names.
 *
 * `targets` is every name the far box stands for, and any one of them is enough
 * -- the same any-of-them rule the field, call and signature checks use.
 */
export function conformedTypes(
  source: string,
  subject: string,
  targets: string[],
  language: Language,
  /**
   * The far end's own source, when the caller has it.
   *
   * Two things need it and neither is optional to the design: the sort of the
   * thing at the far end, so a routine there is a category error rather than an
   * absence, and whether the far end names *this* end as its base, which turns
   * "wrong" into "drawn backwards" in the report.
   *
   * Optional because the reader is useful without it -- every test that names
   * two types in one file passes nothing -- and because a caller that cannot
   * produce the file should get the answer it would have got anyway rather than
   * a refusal it cannot act on.
   */
  target?: { source: string; language: Language },
): ConformsVerdict {
  const read = declaredBases(source, subject, language);
  if ("why" in read) return { verdict: "withheld", why: read.why };

  /*
   * The sort of the head, asked after the tail has been read and before
   * anything is concluded from an absence. A base list can no more name a
   * function than a field list can, so a routine at the far end is a category
   * error and an absence found here would be an accusation about a question
   * that has no answer.
   */
  if (target && targets.some((name) => isRoutine(target.source, target.language, name))) {
    return { verdict: "withheld", why: "not-a-type" };
  }

  const wanted = new Set(targets);
  const hit = read.bases.find((candidate) => wanted.has(candidate.name));
  if (hit) {
    return {
      verdict: "confirmed",
      evidence: { name: hit.name, line: lineOf(source, hit.at), bases: read.written },
    };
  }

  if (read.doubt) return { verdict: "withheld", why: read.doubt };
  /*
   * Nothing was found and the region was never closed, which in practice is
   * Rust: no `impl` in this file and no supertrait list, so what it conforms to
   * is simply not written where we looked.
   */
  if (!read.closed) return { verdict: "withheld", why: "region-is-the-crate" };
  // The last gate, and the only one about us rather than about the code.
  if (!mayAccuse("conforms", language)) return { verdict: "withheld", why: "unlicensed" };

  /*
   * The reverse, named and never confirmed.
   *
   * Asked only once the answer is already an absence, and asked without a far
   * end of its own so it cannot recurse: this is one look at the other
   * declaration, not a walk of the hierarchy.
   */
  const reversed = target
    ? targets.some((name) =>
      conformedTypes(target.source, name, [subject], target.language).verdict === "confirmed")
    : false;
  return { verdict: "absent", bases: read.written, ...(reversed ? { reversed: true } : {}) };
}
