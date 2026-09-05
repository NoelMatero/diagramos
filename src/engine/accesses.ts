/**
 * Whether a routine reads a named member off a type.
 *
 * The gap this closes (#213): it is the largest thing a diagram could draw and
 * had no word for. The census in `measure:vocabulary` counts 53,362 drawable
 * member accesses against 1,946 for the next uncovered relation -- a factor of
 * twenty-seven -- and eighteen arrows in this repository's own board corpus
 * write it in prose instead: `reads`, `write`, `key`, `value`, `drain socket`.
 *
 *     Renderer --[width @accesses]--> Config
 *
 * ## The two ends are not on the same footing, and that is the whole design
 *
 * Every other word in `claim.ts` reads one kind of thing. This one reads two,
 * and they can be believed to different degrees:
 *
 *  - **The type end is a declaration.** A member list is a closed region, so an
 *    arrow naming a member the type does not have is refutable, on exactly the
 *    footing `holds.ts` stands on. That is the value of the word: rename a
 *    field and every diagram still naming the old one goes red.
 *  - **The routine end is a body.** Nobody can enumerate what a body touches
 *    without knowing every receiver's type, which needs the whole program --
 *    the may-analysis #203 measured and rejected, and the shape #210's own
 *    engine records as `used-as-a-receiver`. Not finding an access in a routine
 *    is not evidence there is none. This end confirms and is otherwise silent.
 *
 * Refuting from one end and staying silent at the other is not a compromise
 * between the two. It is the same split `builds` uses one relation over, where
 * the accusation rests on the construction found at the far end and an absence
 * in the near one is never a finding.
 *
 * So there are two answers where other readers have one, and they are named
 * after the end they came from. `no-such-member` is the type end refuting.
 * `absent` is the routine end finding nothing, and **it must never become a
 * finding** -- a routine can reach a member through a helper, a destructuring
 * this reader does not follow, a callback, or a receiver whose type is not
 * written down.
 *
 * ## Why confirming needs both halves
 *
 * `claim.ts` admits a word only when confirming it is evidence of the specific
 * thing it asserts. "Config declares `width`" is not: every arrow drawn at a
 * type with a `width` would come back green whatever routine sat at the other
 * end. "This routine writes `.width` somewhere" is not either: it says nothing
 * about Config. Together they are the strongest static evidence available
 * without a type checker, so a confirmation needs both and gets neither on its
 * own.
 *
 * ## What a member is, in four grammars and one sentence
 *
 *     a member is a name a type declares in its own body -- a field, a method,
 *     or, in Python, an attribute a method assigns to `self`
 *
 * Rust spells fields `field_declaration` and keeps methods somewhere else
 * entirely, in `impl` blocks the struct does not contain. TypeScript spells
 * them `property_signature`, `public_field_definition` and `method_definition`.
 * Python spells one as an annotated assignment in the class block and the other
 * as `self.x = ..` inside `__init__`, which is where most real Python
 * attributes are and the reason this reader cannot stop at the class body.
 *
 * Unlike `holds.ts`, methods count. A routine reading `config.width()` is
 * reading a member of Config in every ordinary sense, and a member list that
 * left the methods out would refute half the arrows anybody draws.
 *
 * ## Why this is a separate file from `holds.ts`
 *
 * `holds.ts` already walks a type's members, and reusing it was the obvious
 * move. Three reasons it is not what happened:
 *
 *  - **It reads the wrong half.** `holds` asks what a member's *type* is; this
 *    asks what the member is *called*. The overlap is the twenty lines that
 *    find the declaration and walk down from its body.
 *  - **It excludes methods on purpose,** with a comment saying why -- counting
 *    a method as a field would make every method a held type. A shared
 *    enumerator would need a flag that changes what the word "member" means
 *    between two callers, which is the specialization layer #190 warns about.
 *  - **It is measured.** `holds`'s licence rows say "field asks", with numbers
 *    behind them. Widening what it enumerates would silently change what those
 *    numbers were counting, and the measurement would not notice.
 */
import { mayAccuse } from "./licence";
import { each, parseSource, type Language, type Node } from "./parse";

/**
 * Why no verdict was reached. Every one of these is a reason to stay quiet, and
 * the caller reports the arrow exactly as it would have been reported before
 * anybody claimed anything.
 */
export type AccessesWithheld =
  /** No grammar for one of the two languages, or the file would not parse. */
  | "unreadable"
  /**
   * The arrow claims `@accesses` and names no member.
   *
   * The one refusal here that is about the board rather than about the code,
   * and the caller is loud about it rather than quiet: without a member name
   * there is nothing on either end to read. The type end has no name to look
   * for, and the routine end cannot be asked "does it touch *something* on
   * Config" without knowing what every receiver in it is -- which is the whole
   * reason this word does not have a may-analysis behind it.
   */
  | "no-member-named"
  /** Nothing in the far file declares that name. The node check reports that itself. */
  | "not-declared"
  /** The name is declared and it is not a type with members. Nothing to read. */
  | "no-members"
  /**
   * The parse recovered from an error, so "the type does not declare this" is a
   * statement about a file we only partly read.
   */
  | "incomplete"
  /**
   * The name is an alias for a type declared somewhere else -- `type Config =
   * SomeOtherShape`. Its members are not here, so "not in this member list" is
   * a fact about the wrong declaration. The shape `holds.ts` withholds on, for
   * the same reason.
   */
  | "aliased"
  /**
   * The type has a parent, so its member list is not closed.
   *
   * The refusal with no counterpart in any other reader here, and the one that
   * decides whether this word is safe. `class Renderer extends Base` declares
   * some of its members and inherits the rest; `class Config(BaseModel)` in
   * Python inherits nearly all of them. Reading only the declaration in front
   * of us and calling the rest absent is a false red about code that is
   * perfectly ordinary -- and it is a false red on the *commonest* shape in two
   * of the four languages, which is what makes it the first thing to get right.
   *
   * Rust structs have no parent and this never fires on one. Rust traits have
   * supertraits and it does.
   */
  | "inherited"
  /**
   * The type takes members the declaration does not list.
   *
   * A TypeScript index signature -- `[key: string]: unknown` -- makes every
   * name a legal member. Python's `__getattr__` does the same thing at runtime,
   * and a class that defines one answers to names nothing has written down.
   * Absence proves nothing against either.
   */
  | "open"
  /**
   * Rust keeps a type's methods in `impl` blocks the type does not contain, and
   * an `impl` block may sit in another file entirely.
   *
   * So a Rust member list is closed for fields and open for methods, and this
   * is the half that is open. Fired when the name is not among the fields and
   * the file holds no `impl` for the type -- because then the methods are
   * somewhere this reader has not looked, and "not a member" would be a
   * statement about the wrong half of the declaration.
   */
  | "impl-elsewhere"
  /**
   * The far end of the arrow is a routine, not a type.
   *
   * A category error rather than a false statement, and the same one
   * `holds.ts` catches: a routine has no members, so the question has no
   * answer and an absence is not evidence of anything.
   */
  | "not-a-type"
  /**
   * The language has a grammar and no measured licence for **this word**, so
   * nothing has ever checked how often this reader is wrong about it.
   *
   * Confirming is unaffected and stays: finding a name is evidence the name is
   * there whoever reads it. It is the absence that needs a licence (#207).
   */
  | "unlicensed";

/** Where the access was written, so a report can quote a file and a line. */
export interface AccessesEvidence {
  /** The member that was read. */
  member: string;
  /** 1-based, in the routine's file. */
  line: number;
  /** The access as written, so a reader can see what was found. */
  wrote: string;
}

export type AccessesVerdict =
  /** The type declares the member and the routine can be seen reading it. */
  | { verdict: "confirmed"; evidence: AccessesEvidence }
  /**
   * The type does not declare that member, and its member list is closed.
   *
   * **The accusation**, and the only one this word makes. It comes from the
   * type end alone, which is why it is decided before the routine is read at
   * all: whether the routine touches `width` does not bear on whether Config
   * has one.
   */
  | { verdict: "no-such-member"; members: string }
  /**
   * The type declares the member and nothing in the routine reads it, as far as
   * the text shows.
   *
   * **Not a finding, and this must stay true.** Reported exactly as an
   * unclaimed arrow is.
   */
  | { verdict: "absent" }
  | { verdict: "withheld"; why: AccessesWithheld };

/** Node types that declare a type with a member list, in any grammar we load. */
const TYPE_DECLARATION =
  /^(struct_item|enum_item|union_item|trait_item|interface_declaration|class_declaration|abstract_class_declaration|class_definition|object_type)$/;

/** Node types that introduce a name for a type written elsewhere. */
const ALIASES = new Set(["type_alias_declaration", "type_item"]);

/** A member read off a value: `config.width`, `self.width`, `cfg.width()`. */
const ACCESS = /^(field_expression|member_expression|attribute)$/;

/**
 * A member as an author would write it on a canvas, beside itself as written.
 *
 * TypeScript spells a private member `#pending` and the grammar hands the name
 * back with the hash on it. Nobody labels an arrow `#pending`, and
 * `measure-accesses.mts` counted 22 refutations of arrows about a private
 * field -- the largest remaining class of accusation once the referee's own
 * bugs were out.
 *
 * Both spellings go in the member list rather than one being normalised to the
 * other, because the access side has the same two spellings and picking one
 * would break the other end. Widening a member list can only ever withhold an
 * accusation, which is the direction to be wrong in.
 */
function spellings(name: string): string[] {
  const bare = name.replace(/^#/, "");
  return bare === name ? [name] : [name, bare];
}

/** Where each grammar puts the member's name on one of those. */
function memberOn(node: Node): Node | undefined {
  return node.childForFieldName("field")
    ?? node.childForFieldName("property")
    ?? node.childForFieldName("attribute")
    ?? undefined;
}

/** The name a declaration goes by. Python annotates through `left`, not `name`. */
function nameOf(node: Node): string | undefined {
  const name = node.childForFieldName("name") ?? node.childForFieldName("left");
  return name && name.childCount === 0 ? name.text : undefined;
}

/** 1-based line of a byte offset, counted the way an editor counts. */
const lineOf = (source: string, offset: number) =>
  source.slice(0, offset).split("\n").length;

/**
 * A name shaped like a member, which is the only thing an arrow may name.
 *
 * `.width` and `width()` are written as often as `width` on a canvas and mean
 * the same thing, so the punctuation is taken off rather than refused. Anything
 * with a space in it is prose -- `reads the config` -- and prose names no
 * member.
 */
export function memberNamed(label: string | undefined): string | undefined {
  const written = label?.trim().replace(/^\./, "").replace(/\(\s*\)$/, "").trim();
  // A leading `#` is a TypeScript private member, which somebody copying a
  // declaration off the screen will write exactly as the code has it.
  return written && /^#?[A-Za-z_$][\w$]*$/.test(written) ? written : undefined;
}

/**
 * What the type end says about a member name.
 *
 * Separated from the routine end because it is the half that can accuse, and
 * because keeping the two apart is what lets `measure-accesses.mts` count them
 * separately -- a miss at this end is a false red, a miss at the other is a
 * confirmation nobody gets.
 */
export type TypeEnd =
  | { declares: true }
  | { declares: false; members: string }
  | { why: AccessesWithheld };

/** Whether a name is declared as a routine in this source. */
function isRoutine(root: Node, name: string): boolean {
  let routine = false;
  each(root, (node) => {
    if (routine) return;
    if (nameOf(node) !== name) return;
    if (node.childForFieldName("body") && node.childForFieldName("parameters")) routine = true;
  });
  return routine;
}

/**
 * Whether this declaration names a parent, in whatever way its grammar spells
 * one.
 *
 * Read off the declaration rather than guessed at from the member list, and
 * read generously: anything that looks like a heritage clause counts, because
 * being wrong here in the other direction is a red on a type whose members are
 * somewhere else.
 */
function hasParent(declaration: Node): boolean {
  // Python and Rust name theirs on the declaration itself.
  if (declaration.childForFieldName("superclasses")) return true;
  let parent = false;
  for (let index = 0; index < declaration.childCount; index += 1) {
    const child = declaration.child(index);
    if (!child) continue;
    if (/^(class_heritage|extends_clause|extends_type_clause|implements_clause|trait_bounds)$/
      .test(child.type)) parent = true;
  }
  return parent;
}

/**
 * Whether the member list admits names it does not write down.
 *
 * A TypeScript index signature answers to every string, and a Python class with
 * `__getattr__` answers to every attribute. Either way the declaration in front
 * of us has stopped being a closed region.
 */
function openMembership(body: Node): boolean {
  let open = false;
  each(body, (node) => {
    if (node.type === "index_signature") open = true;
    if (nameOf(node) === "__getattr__" || nameOf(node) === "__getattribute__") open = true;
  });
  return open;
}

/**
 * Every name a type declaration writes down as its own.
 *
 * Walks down from the body rather than asking a member who its parent is:
 * `Node` here exposes no parent, which is the trap `holds.ts` records reading
 * 0 fields in every language for.
 *
 * Methods are in. A routine reading `config.render()` is reading a member of
 * Config in the only sense a diagram means, and leaving methods out would
 * refute every arrow anybody draws at a class.
 */
function membersIn(body: Node): Set<string> {
  const members = new Set<string>();
  const visit = (member: Node, depth: number) => {
    // A nested type is its own declaration and its members belong to it.
    if (depth > 0 && (member.type === "object_type" || TYPE_DECLARATION.test(member.type))) return;
    if (depth > 0) {
      const name = nameOf(member);
      if (name) {
        for (const spelling of spellings(name)) members.add(spelling);
        /*
         * A method's own body is not a member list, and descending into it
         * would collect every local variable in the class as a member -- which
         * makes the type look like it declares everything and refutes nothing.
         * The one thing wanted from in there is handled by `selfAssigned`.
         */
        const parameters = member.childForFieldName("parameters");
        if (parameters) {
          if (name === "constructor") {
            for (const property of parameterProperties(parameters)) members.add(property);
          }
          return;
        }
      }
    }
    for (let index = 0; index < member.childCount; index += 1) {
      const child = member.child(index);
      if (child) visit(child, depth + 1);
    }
  };
  visit(body, 0);
  return members;
}

/**
 * TypeScript members declared in the constructor's parameter list.
 *
 * `constructor(private width: number)` declares a member, and there is no line
 * anywhere in the member list for it. This is the shape a referee cannot find,
 * because a text scan is blind to it in exactly the same way the tree walk was
 * -- both read the parameter list as a parameter list, agree, and the reader
 * goes on refuting a correct arrow. Found by reading the language rather than a
 * disagreement, which is the only way this class of hole ever is.
 *
 * Only a parameter carrying a modifier. A plain `constructor(width: number)`
 * declares no member, and taking every parameter would buy a false green:
 * confirmation needs the routine end too, and a routine reading `.width` off
 * something else would then be credited to this type.
 */
function parameterProperties(parameters: Node): string[] {
  const found: string[] = [];
  for (let index = 0; index < parameters.childCount; index += 1) {
    const parameter = parameters.child(index);
    if (!parameter) continue;
    let modified = false;
    for (let child = 0; child < parameter.childCount; child += 1) {
      const part = parameter.child(child);
      if (part && (part.type === "accessibility_modifier" || part.text === "readonly")) modified = true;
    }
    const pattern = parameter.childForFieldName("pattern");
    if (modified && pattern && pattern.childCount === 0) found.push(pattern.text);
  }
  return found;
}

/**
 * Attributes a Python class assigns to `self`.
 *
 * Where most real Python attributes are: `self.width = width` in `__init__`,
 * with nothing in the class body to say so. A reader that stops at the class
 * block reads a Python class as declaring almost nothing, and then refutes
 * almost every arrow drawn at one.
 *
 * Collected from anywhere inside the declaration rather than from `__init__`
 * alone, because an attribute set in any method is still an attribute -- and
 * this is the direction where being wide only ever costs a refutation.
 */
function selfAssigned(declaration: Node): Set<string> {
  const members = new Set<string>();
  each(declaration, (node) => {
    if (node.type !== "attribute") return;
    const object = node.childForFieldName("object");
    const attribute = node.childForFieldName("attribute");
    if (!object || !attribute) return;
    if (object.text !== "self" && object.text !== "cls") return;
    if (attribute.childCount === 0) members.add(attribute.text);
  });
  return members;
}

/**
 * Rust's methods, which the struct does not contain.
 *
 * `impl Config { fn width(&self) .. }` is a separate top-level node, and it may
 * be in another file -- so this returns whether any `impl` for the type was
 * found at all, as well as what was in the ones that were. A name absent from
 * the fields with no `impl` in sight is `impl-elsewhere` rather than absent.
 */
function rustMethods(root: Node, type: string): { methods: Set<string>; sawImpl: boolean } {
  const methods = new Set<string>();
  let sawImpl = false;
  each(root, (node) => {
    if (node.type !== "impl_item") return;
    const target = node.childForFieldName("type");
    if (!target || target.text !== type) return;
    sawImpl = true;
    const body = node.childForFieldName("body");
    if (body) for (const name of membersIn(body)) methods.add(name);
  });
  return { methods, sawImpl };
}

/**
 * What a type's declaration says about one member name.
 *
 * Every declaration of the name is read and the safest answer wins, the rule
 * `signature.ts` arrived at after judging the wrong declaration six times in
 * 159 on real Rust: any declaration that has the member settles it, and failing
 * that a single reason to withhold silences the whole answer.
 */
export function declaresMember(
  source: string,
  names: string[],
  member: string,
  language: Language,
): TypeEnd {
  const tree = parseSource(source, language);
  if (!tree) return { why: "unreadable" };
  if (tree.rootNode.hasError) return { why: "incomplete" };

  /*
   * The sort check, before anything else is read -- including before the
   * declaration lookup, which is where the first version of this put it.
   *
   * A routine at the far end declares no type, so looking for one first
   * answered `not-declared` and the category error never surfaced. Both are
   * silent, so nothing went red either way; what was lost is that
   * `not-declared` sends somebody to check the anchor while `not-a-type` says
   * the claim can never be read at all, and the caller is loud about exactly
   * one of them. An arrow drawn at a function would have sat there quietly
   * forever, which is the thing `garbledClaims` exists to prevent.
   */
  if (names.some((name) => isRoutine(tree.rootNode, name))) return { why: "not-a-type" };

  const wanted = new Set(names);
  const declarations: Node[] = [];
  each(tree.rootNode, (node) => {
    const named = TYPE_DECLARATION.test(node.type) || ALIASES.has(node.type);
    const name = nameOf(node);
    if (named && name !== undefined && wanted.has(name)) declarations.push(node);
  });
  if (declarations.length === 0) return { why: "not-declared" };

  let withheld: AccessesWithheld | undefined;
  let listed = "";

  for (const declaration of declarations) {
    if (ALIASES.has(declaration.type)) {
      /*
       * An alias to a bare name stands for a declaration that is not in front
       * of us. Only the object form -- `type X = { .. }` -- carries members.
       */
      const value = declaration.childForFieldName("value");
      if (value?.type !== "object_type") { withheld = "aliased"; continue; }
    }
    if (hasParent(declaration)) { withheld = "inherited"; continue; }

    const body = declaration.type === "object_type"
      ? declaration
      : ALIASES.has(declaration.type)
        ? declaration.childForFieldName("value")
        : declaration.childForFieldName("body");
    if (!body) { withheld = "no-members"; continue; }
    if (openMembership(body)) { withheld = "open"; continue; }

    const members = membersIn(body);
    if (language === "python") for (const name of selfAssigned(declaration)) members.add(name);
    if (language === "rust") {
      const { methods, sawImpl } = rustMethods(tree.rootNode, nameOf(declaration)!);
      for (const name of methods) members.add(name);
      if (!members.has(member) && !sawImpl) { withheld = "impl-elsewhere"; continue; }
    }

    if (members.has(member)) return { declares: true };
    if (!listed) listed = [...members].join(", ");
  }

  if (withheld) return { why: withheld };
  return { declares: false, members: listed };
}

/**
 * Every routine of this name in this source, as nodes to scan.
 *
 * The rule from `parse.ts` rather than `body.ts`, for the reasons
 * `constructs.ts` records: a routine is a declaration that has `parameters`,
 * which holds for `function f()` and for `const f = () => x` alike where the
 * two `body.ts` helpers disagree with each other.
 *
 * A type whose methods do the reading counts as well. Nobody draws a box for
 * `Renderer.prototype.draw`; they draw `Renderer` and mean "this thing reads
 * the config", which is the ordinary shape on a real board.
 */
function routinesNamed(root: Node, routine: string): { routines: Node[]; declared: boolean } {
  const routines: Node[] = [];
  let declared = false;
  each(root, (node) => {
    // Rust puts a type's routines in `impl Foo`, which carries the name on a
    // `type` field and has no `name` at all.
    const name = node.type === "impl_item"
      ? node.childForFieldName("type")
      : node.childForFieldName("name") ?? node.childForFieldName("left");
    if (!name || name.childCount !== 0 || name.text !== routine) return;
    declared = true;
    const value = node.childForFieldName("value");
    if (node.childForFieldName("parameters") ?? value?.childForFieldName("parameters")) {
      routines.push(node);
      return;
    }
    if (holdsRoutines(node)) routines.push(node);
  });
  return { routines, declared };
}

/** Whether this declaration has a routine anywhere inside it. */
function holdsRoutines(node: Node): boolean {
  let found = false;
  each(node, (child) => {
    if (found || child.id === node.id) return;
    if (child.childForFieldName("parameters")) found = true;
  });
  return found;
}

/**
 * Whether a routine reads a member of this name, and where.
 *
 * Deliberately blind to what it is read *off*. Knowing that `config.width` is a
 * Config needs every receiver's type, which needs the whole program -- and this
 * end never accuses, so being wide costs a confirmation nobody was owed rather
 * than a red somebody did not deserve.
 */
export function accessesIn(
  source: string,
  routine: string,
  member: string,
  language: Language,
): AccessesEvidence | undefined {
  const tree = parseSource(source, language);
  if (!tree) return undefined;

  const { routines } = routinesNamed(tree.rootNode, routine);
  let found: AccessesEvidence | undefined;
  for (const body of routines) {
    each(body, (node) => {
      if (found || !ACCESS.test(node.type)) return;
      const name = memberOn(node);
      if (!name || name.childCount !== 0) return;
      if (!spellings(name.text).includes(member.replace(/^#/, "")) && name.text !== member) return;
      found = {
        member,
        line: lineOf(source, node.startIndex),
        wrote: node.text.replace(/\s+/g, " ").slice(0, 80),
      };
    });
    if (found) break;
  }
  return found;
}

/**
 * Whether this routine reads this member off this type.
 *
 * `type.names` is every name the far box stands for, and any one of them is
 * enough -- the same any-of-the-members rule the other checks use.
 *
 * The type end is asked first and it is asked alone. Whether the routine
 * touches `width` has no bearing on whether Config has one, so the refutation
 * must not be gated on a body this reader may not be able to read -- and
 * putting the order the other way round is how the accusing half ends up
 * silenced by a doubt about the half that never accuses.
 */
export function memberAccesses(
  source: string,
  routine: string,
  member: string | undefined,
  language: Language,
  type: { source: string; names: string[]; language: Language },
): AccessesVerdict {
  const named = memberNamed(member);
  if (!named) return { verdict: "withheld", why: "no-member-named" };

  const declared = declaresMember(type.source, type.names, named, type.language);
  if ("why" in declared) return { verdict: "withheld", why: declared.why };
  /*
   * The last gate, and the only one here that is about us rather than about the
   * code. It sits in this function rather than inside `declaresMember`, and
   * that placement is what lets the measurement mean anything: with the gate
   * one layer down, an unlicensed language turns every refutation into
   * `unlicensed` before the referee can see it, and the accusation column comes
   * out zero because nothing was ever allowed to accuse. A number that cannot
   * be non-zero is not a measurement.
   */
  if (!declared.declares && !mayAccuse("accesses", type.language)) {
    return { verdict: "withheld", why: "unlicensed" };
  }
  if (!declared.declares) return { verdict: "no-such-member", members: declared.members };

  const tree = parseSource(source, language);
  if (!tree) return { verdict: "withheld", why: "unreadable" };
  if (tree.rootNode.hasError) return { verdict: "withheld", why: "incomplete" };
  const { routines, declared: isThere } = routinesNamed(tree.rootNode, routine);
  if (routines.length === 0) {
    return { verdict: "withheld", why: isThere ? "no-members" : "not-declared" };
  }

  const evidence = accessesIn(source, routine, named, language);
  return evidence ? { verdict: "confirmed", evidence } : { verdict: "absent" };
}
