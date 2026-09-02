/**
 * Whether a function's signature names a type.
 *
 * The gap this closes (#169): a great many arrows on a typed board mean neither
 * "A imports B" (`needs`) nor "A's result goes into B" (`feeds`). They mean the
 * most ordinary thing a typed language writes down --
 *
 *     struct Request  ->  fn user_handler(request: &Request) -> Response
 *
 * -- and there was no word for it. The relationship is stated in the signature,
 * which is a place `body.ts` already reads (#144), so the arrow above is
 * confirmed today. What it cannot do is be *wrong*: reading a signature can make
 * an arrow green and nothing can make one red, so an author who draws that arrow
 * backwards is never told.
 *
 * ## Why this one is allowed an opinion
 *
 * `claim.ts`'s rule is that a word goes in when something can call it wrong, and
 * being callable-wrong needs a closed region -- somewhere absence is genuinely
 * absence. A body is not closed: a value reaches another function through a
 * field, a callback, a builder chain, so "not in this body" says nothing, which
 * is why `feeds` confirms and never refutes.
 *
 * A signature is closed. Every parameter and the return type can be enumerated
 * and there is no helper, macro or re-export for a type to hide behind -- with
 * one exception, and this whole file is built around it.
 *
 * ## The exception, and the reason for every refusal below
 *
 *     type Req = Request;
 *     fn f(r: &Req) { }
 *
 * The signature is fully enumerable, it does not contain `Request`, and the
 * arrow is right. Renamed imports (`use request::Request as Req`) do the same
 * thing. In both, a name in the signature stands for something other than
 * itself, and absence stops proving anything.
 *
 * So a refutation is only offered from a signature with no such name in it. Any
 * alias or rename that the signature actually uses, and this withholds -- which
 * is the same discipline `needs.ts` follows and for the same reason: silence is
 * always available and always safe, and the accusation is not. A wrong red here
 * is the tool telling somebody their correct diagram is wrong, and that is not
 * recoverable by being right afterwards.
 *
 * ## Two positions, not one
 *
 * `takes` reads the parameters, `returns` reads the return type, and they are
 * separate words because collapsing them makes an arrow's orientation
 * meaningless exactly where a diagram is trying to show flow: `Request ->
 * handler` and `handler -> Response` are different statements, and one word
 * would confirm both no matter which way they were drawn. Finding the name in
 * the *other* position is its own verdict -- the analogue of `needs.ts`'s
 * "backwards", and the strongest thing here, because it rests on something
 * found rather than on something missing.
 *
 * Measured across the four grammars the engine loads: `parameters` is a field on
 * every one of them, `return_type` on all but JavaScript, which writes none. So
 * there are no per-language branches here, the same way `body.ts` has none.
 *
 * ## The number, and how to argue with it
 *
 * `npm run measure:signature` re-runs it. Over this repository, rust-test and
 * graphify -- 2236 functions, 5874 type names written in their signatures -- the
 * reader finds every one, and refuses to answer on 208 of them. Per language,
 * which is the number that matters, because a reader can be perfect on three and
 * blind on the fourth:
 *
 *     python  1543 functions, 4002 names, 0 missed, withholds 139 (71 aliased, 68 quoted)
 *     ts       572 functions, 1677 names, 0 missed, withholds  64 (58 aliased, 6 incomplete)
 *     rust      63 functions,  154 names, 0 missed, withholds   5 (self-type)
 *     tsx        7 functions,   41 names, 0 missed, withholds   0
 *
 * The referee is a text scan of the signature source, chosen because it shares
 * no machinery with the syntax walk here: two unrelated readings agreeing says
 * something, and one reading agreeing with itself does not.
 *
 * The measurement found three reader bugs, all of which produce a false red. The
 * first two were caught before shipping; the third was not, because the corpus
 * had no Python in it and the referee blanked a quoted annotation the way it
 * blanks any other string -- so a reader that could not read 122 of the type
 * names in graphify's signatures measured as perfect. Both halves of that are
 * fixed, and the number above is what the corrected referee reports.
 *
 *   - reading only `identifier` leaves left it blind to every built-in, because
 *     TypeScript calls `string` a `predefined_type` and Rust calls `bool` a
 *     `primitive_type` -- a third of every signature;
 *   - reading only the *first* declaration of a name judged the wrong signature
 *     whenever a name is declared twice, which is `new`, `parse`, `from`, and
 *     any method on two `impl` blocks;
 *   - reading a Python annotation as a syntax tree found nothing at all in
 *     `unit: "Path | FileSlice"`, because a quoted type is text to the grammar
 *     -- 122 names across graphify, every one of them an arrow that could be
 *     drawn and called wrong.
 *
 * None of the three was reachable by thinking about it, which is the argument for
 * the script existing rather than for a number in a comment -- and the third is
 * the argument for the corpus covering every language the reader is allowed to
 * speak in.
 *
 * ## Why this file does not call `licenceFor`, decided at #195
 *
 * Every other refutation in the engine asks `licence.ts` first, and this one
 * does not, which #195 raised as the thing that let Python -- the language with
 * no licence -- ship the only unchecked accusation in the tool. The complaint
 * was right about the state and this is the decision about the mechanism.
 *
 * `licence.ts` is not a badge saying a language is supported. It is one
 * measurement of one reader: does `deps.ts` resolve an import to the same file
 * the compiler resolves it to, judged by `tsc` and by rust-analyzer. Nothing in
 * that number is evidence about whether a parameter list names a type. Calling
 * it from here would let Rust's import measurement authorise Rust's signature
 * reader -- which is exactly the authorisation that would have been in force
 * during #193, when `-> Self` was turning correct Rust boards red on a language
 * that had held a licence the whole time. A borrowed number does not become
 * evidence by being about the same language.
 *
 * What a refutation needs is a measurement of *itself*, and this one has had one
 * since it shipped: `scripts/measure-signature.mts`, refereed by a text scan
 * that shares no machinery with the syntax walk here. The defect #195 objects to
 * was never the missing `licenceFor` call. It was that the corpus had no Python
 * in it, so the reader was measured at 100% on three languages and unmeasured on
 * the fourth, and read as licensed. Python is in the corpus now, and the referee
 * was taught to read a quoted annotation rather than blank it as a string --
 * without which it would have gone on agreeing with a reader that could not see
 * 122 of the type names a person can read in graphify's signatures.
 *
 * The cheaper option -- gate this file on `licenceFor` and let Python go silent
 * -- was rejected for costing every correct Python verdict to buy silence on one
 * wrong shape, when the shape itself can be named and silenced. If this reader
 * ever needs a referee stronger than a text scan, `mypy` or `pyright` is a
 * referee for *this* measurement, added to that script. It is not a call to
 * `licenceFor`.
 */
import { mayAccuse } from "./licence";
import { parseSource, type Language, type Node } from "./parse";

/** Which half of a signature a claim is about. */
export type SignaturePosition = "parameter" | "return";

/**
 * Why no verdict was reached. Every one of these is a reason to stay quiet, and
 * the caller reports the arrow exactly as it would have been reported before
 * anybody claimed anything.
 */
export type SignatureWithheld =
  /** No grammar for this language, or the file would not parse at all. */
  | "unreadable"
  /** Nothing in that file declares that name. The node check reports that itself. */
  | "not-declared"
  /** The name is declared, and it is not a function. There is no signature to read. */
  | "no-signature"
  /**
   * The parse recovered from an error, so "the type is not in here" is a
   * statement about a file we only partly read.
   */
  | "incomplete"
  /**
   * A name in the signature stands for something other than itself -- a type
   * alias, or an import renamed on the way in. Absence proves nothing here.
   */
  | "aliased"
  /** The declaration came out of macro soup: tokens awaiting an expansion. */
  | "macro"
  /** `returns` asked of a language that writes no return types. */
  | "untyped-return"
  /**
   * The language has a grammar and no measured licence, so nothing has ever
   * checked how often this reader is wrong about it.
   *
   * The gap #195 found: this file gates on having a *grammar*, and Python has
   * one, so Python was the only language here shipping an accusation from a
   * reader no referee had ever seen -- and getting an ordinary signature wrong
   * while doing it. `needs.ts` and `deps.ts` have consulted `licenceFor` from
   * the start; this reader and `holds.ts` now do too, which makes it one rule
   * rather than a property of which file you happened to land in.
   *
   * Confirming is unaffected. Finding a name is evidence the name is there
   * whoever reads it, and it is the same evidence a measured reader would have
   * found. Absence is the claim about the whole of a signature, and it is what
   * turns a reader's blindness into somebody's wrong diagram.
   */
  | "unlicensed"
  /**
   * The signature says `Self` and there is no plain type to read it as -- a
   * generic `impl`, or a trait's own default method. Same reason as `aliased`:
   * a name that stands for something else, and nothing here can name it.
   */
  | "self-type"
  /**
   * The claimed half of the signature writes a type inside a string --
   * `def unit_path(unit: "Path | FileSlice")`. The names in there are read, so
   * the arrow can still be confirmed; what cannot be done is refuted, because
   * everything inside the quotes was read by scanning text rather than by
   * parsing a type, and "I did not find it in that text" is not an absence.
   */
  | "quoted-annotation";

/** Where the type was named, so a report can quote a file and a line. */
export interface SignatureEvidence {
  /** The name that was found. */
  name: string;
  /** 1-based. */
  line: number;
  /** Which half of the signature it was found in. */
  position: SignaturePosition;
  /** The signature text, trimmed, so the report can show what it read. */
  signature: string;
}

export type SignatureVerdict =
  /** The claimed position names the type. */
  | { verdict: "confirmed"; evidence: SignatureEvidence }
  /**
   * The signature names the type in the *other* half. The claim is the wrong
   * way round rather than untrue, and this is the one verdict here resting on
   * something found rather than on something missing.
   */
  | { verdict: "misplaced"; evidence: SignatureEvidence }
  /** The signature was read to the end and does not name the type anywhere. */
  | { verdict: "absent"; signature: string; line: number }
  | { verdict: "withheld"; why: SignatureWithheld };

/** A leaf that is a name rather than punctuation or a keyword. */
const IDENTIFIER = /identifier$/;
const isName = (node: Node): boolean => node.childCount === 0 && IDENTIFIER.test(node.type);

/**
 * A leaf in a type position that spells a word, whatever the grammar calls it.
 *
 * Wider than `isName` on purpose. A built-in is not an `identifier` node --
 * TypeScript calls `string` a `predefined_type` and Rust calls `bool` a
 * `primitive_type` -- and reading only identifiers left the reader blind to
 * roughly a third of every signature it was measured on. Nothing ever draws a
 * box for `string`, so the confirmations this adds are worthless; what it buys
 * is the refusals. Every name the reader cannot see is a name it could wrongly
 * call absent, and this is the one direction that error runs.
 */
const WORD = /^[A-Za-z_][A-Za-z0-9_]*$/;
const isTypeWord = (node: Node): boolean => node.childCount === 0 && WORD.test(node.text);

/** Node types that can rename something on the way in, if they actually do. */
const RENAMES = new Set([
  "import_specifier", "aliased_import", "export_specifier", "use_as_clause",
]);
/** Node types that introduce a name for a type written elsewhere. */
const ALIASES = new Set(["type_alias_declaration", "type_item"]);

function each(node: Node, visit: (node: Node) => void): void {
  visit(node);
  for (let index = 0; index < node.childCount; index += 1) {
    const child = node.child(index);
    if (child) each(child, visit);
  }
}

const lineOf = (source: string, index: number): number =>
  source.slice(0, index).split("\n").length;

/**
 * Names in this file that stand for something other than themselves.
 *
 * The last name in a rename is the one the file goes on to use -- `use a::B as
 * C`, `import { B as C }`, `from a import B as C` all end in the alias -- and
 * the name of a type alias is the one it introduces. Either way, seeing that
 * name in a signature means the signature might be naming the target under
 * another spelling, and nothing here may refute.
 *
 * Deliberately a set of names rather than a flag on the file. A file with one
 * alias in it that no signature uses is still a file whose signatures can be
 * refuted, and the whole-file version would have withheld on most real code.
 */
function shadowNames(tree: Tree): Set<string> {
  const shadows = new Set<string>();
  each(tree.rootNode, (node) => {
    if (RENAMES.has(node.type)) {
      /*
       * Only when it renames something. Every grammar here gives a plain named
       * import the same node type as a renamed one -- `import { Request }` and
       * `import { Request as Req }` are both `import_specifier` -- and the
       * `alias` field is the only thing that tells them apart. Reading the node
       * type alone treated every import in the file as a name that might mean
       * something else, and measured on this repository that withheld on 212 of
       * 522 functions: the word would have shipped and almost never fired.
       */
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

interface Tree {
  rootNode: Node;
}

/**
 * `Self`, and why it is neither a confirmation nor an absence on its own.
 *
 * A Rust constructor almost always ends `-> Self`, and every word in that is
 * doing its job: the diagram saying `Error --returns--> Error::new` is right,
 * `returns` is the right word for it, and the reader used to look for the token
 * `Error`, find `Self`, and call the correct board wrong -- in red, with a file
 * and a line. Nine per cent of every returning function in the #96 Rust corpus
 * writes `Self` in its return type, thirty per cent in clap.
 *
 * `Self` is the same shape as the alias this file was built around: a name in a
 * signature standing for something other than itself. The difference is that it
 * is usually readable. Inside `impl Error`, `Self` is `Error`; inside `impl
 * Display for Error` it is still `Error`, because the `type` half of an impl is
 * the concrete type either way. So it is resolved where the `impl` names a plain
 * type and withheld everywhere else, which keeps the accusation to the cases
 * where the evidence is unambiguous:
 *
 *   impl Error                 ->  Self is Error, and the answer is given
 *   impl Display for Error     ->  Self is Error
 *   impl<T> Wrapper<T>         ->  the enclosing type is generic: withheld
 *   trait Maker { fn make() }  ->  Self is whoever implements it: withheld
 *
 * The cost is on the record. Over `anyhow` and `serde_json` -- 1234 Rust
 * functions -- the reader would refute on 817 rather than 874, and `self-type`
 * is 127 of its 417 refusals. Reading the generic ones too would buy most of
 * that back, and is deliberately not done: withholding costs an answer and
 * never spends trust, which is the direction every refusal in this file runs.
 */
const SELF = "Self";

/**
 * Languages where `Self` in a type position means the enclosing type.
 *
 * Rust reserves the word, so there is nothing else it could be. Python spells
 * the same idea `typing.Self` and it is only conventionally reserved, so the
 * guard below drops the whole treatment for a file that declares a `Self` of
 * its own. TypeScript has no such word -- `Self` there is an ordinary imported
 * name, and reading it as anything else could invent the false red this is
 * removing.
 */
const SELF_MEANS_ENCLOSING = new Set<Language>(["rust", "python"]);

/**
 * Languages where a type may be written inside a string, and #195, which is the
 * reason this exists.
 *
 *     def unit_path(unit: "Path | FileSlice") -> Path:
 *
 * `unit_path` takes a `FileSlice`. The reader walked the parameter, found a
 * `string` node whose contents are not identifiers to a grammar, saw no names at
 * all, and called a correct arrow wrong -- in red, with a file and a line. It is
 * the same shape as `Self` in #193: the type is there, the reader cannot see it,
 * and absence gets treated as proof.
 *
 * Not an oddity of one file either. The quoted form is how Python writes a
 * forward reference, and the only way to write a type imported under `if
 * TYPE_CHECKING:` -- which is to say, exactly the places a diagram wants to draw
 * an arrow. 49 of the 82 files in the graphify corpus have one.
 *
 * So the words inside the quotes are read, which is enough to confirm, and the
 * half that contains them may not refute. They are read by a scan for words, not
 * by a parse: `"Path | FileSlice"` is a piece of text to every grammar here, and
 * the honest reading of a text scan is that finding a name proves it is there
 * while not finding one proves nothing.
 *
 * Deliberately Python only. A quoted thing in a type position means something
 * else in the other languages this engine loads -- in TypeScript it is a literal
 * type, `mode: "read" | "write"`, which means itself and nothing else, and
 * treating those as unreadable would withhold on ordinary TypeScript for no
 * reason at all.
 */
const QUOTED_TYPES = new Set<Language>(["python"]);

/** Identifiers inside a quoted annotation, read as words rather than parsed. */
const WORDS = /[A-Za-z_][A-Za-z0-9_]*/g;

/** A type-position child that is one whole word, or nothing. */
function plainType(node: Node | null): string | undefined {
  return node && node.childCount === 0 && WORD.test(node.text) ? node.text : undefined;
}

/**
 * What `Self` means at a node, carried down the tree rather than looked up.
 *
 * `undefined` covers both "no enclosing type" and "an enclosing type this
 * cannot name", because the caller does the same thing with either. A `trait`
 * deliberately clears an outer impl's meaning: a trait's own `name` is not what
 * `Self` stands for inside it.
 */
function selfTypeOf(node: Node, inherited: string | undefined): string | undefined {
  if (node.type === "impl_item") return plainType(node.childForFieldName("type"));
  if (node.type === "trait_item") return undefined;
  if (node.type === "class_definition") return plainType(node.childForFieldName("name"));
  return inherited;
}

/** The function-shaped node a name was bound to, which may be one level down. */
const FUNCTIONISH = /function|arrow|lambda|closure|method|fn/;

function signatureNode(node: Node): Node | undefined {
  if (node.childForFieldName("parameters")) return node;
  // `const f = (a: A): B => c` binds the name on the outside and writes the
  // signature on the inside.
  for (const field of ["value", "right", "declarator"]) {
    const inner = node.childForFieldName(field);
    if (inner && (FUNCTIONISH.test(inner.type) || inner.childForFieldName("parameters"))) {
      const found = signatureNode(inner);
      if (found) return found;
    }
  }
  let found: Node | undefined;
  each(node, (current) => {
    if (!found && current !== node && FUNCTIONISH.test(current.type)
      && current.childForFieldName("parameters")) found = current;
  });
  return found;
}

/**
 * Type names written in one half of a signature.
 *
 * A parameter's own binding name is not a type and is skipped by reading the
 * `type` field rather than the parameter node -- every grammar here puts the
 * type there, and Rust's `&mut self` has no such field, so a receiver
 * contributes nothing. Names are read as whole identifiers, never as substrings,
 * so `Client` cannot match `ClientPool`.
 *
 * Returns whether a quoted annotation was read on the way, because that decides
 * what this half is allowed to say afterwards -- see `QUOTED_TYPES`.
 */
function typeNames(
  node: Node | null | undefined,
  into: Set<string>,
  quoting: boolean,
): boolean {
  if (!node) return false;
  let quoted = false;
  each(node, (part) => {
    if (quoting && part.type === "string") {
      quoted = true;
      for (const word of part.text.matchAll(WORDS)) into.add(word[0]);
      return;
    }
    if (isTypeWord(part)) into.add(part.text);
  });
  return quoted;
}

function parameterTypes(parameters: Node, into: Set<string>, quoting: boolean): boolean {
  let quoted = false;
  for (let index = 0; index < parameters.childCount; index += 1) {
    const parameter = parameters.child(index);
    if (!parameter || parameter.childCount === 0) continue;
    if (typeNames(parameter.childForFieldName("type"), into, quoting)) quoted = true;
  }
  return quoted;
}

/**
 * What one function's signature says about a set of type names.
 *
 * `targets` is every name the far box stands for, and any one of them is enough
 * -- the same any-of-the-members rule the call check uses.
 */
export function signatureNames(
  source: string,
  symbol: string,
  targets: string[],
  position: SignaturePosition,
  language: Language,
): SignatureVerdict {
  if (language === "js" && position === "return") return { verdict: "withheld", why: "untyped-return" };

  const tree = parseSource(source, language) as Tree | undefined;
  if (!tree) return { verdict: "withheld", why: "unreadable" };
  if (tree.rootNode.hasError) return { verdict: "withheld", why: "incomplete" };

  const shadows = shadowNames(tree);
  let sawName = false;
  let sawSignature = false;

  /*
   * `Self` is only read as the enclosing type where the language reserves it
   * and this file has not declared one of its own. A file with `class Self` in
   * it means that class, and substituting the enclosing type there would invent
   * exactly the false red this treatment exists to remove.
   */
  let declaresSelf = false;
  each(tree.rootNode, (node) => {
    const name = node.childForFieldName("name");
    if (name && name.childCount === 0 && name.text === SELF) declaresSelf = true;
  });
  const selfMeansEnclosing = SELF_MEANS_ENCLOSING.has(language) && !declaresSelf;
  const quoting = QUOTED_TYPES.has(language);

  /* Every declaration of the name, with what `Self` meant where it was written. */
  const declarations: Array<{ node: Node; self: string | undefined }> = [];
  const collect = (node: Node, self: string | undefined): void => {
    const here = selfTypeOf(node, self);
    if (node.type !== "token_tree") {
      const name = node.childForFieldName("name") ?? node.childForFieldName("left");
      if (name && name.childCount === 0 && name.text === symbol) declarations.push({ node, self: here });
    }
    for (let index = 0; index < node.childCount; index += 1) {
      const child = node.child(index);
      if (child) collect(child, here);
    }
  };
  collect(tree.rootNode, undefined);

  /*
   * Every declaration of the name, and the safest answer wins.
   *
   * A name is declared more than once all the time -- `new`, `parse`, `from`,
   * a method on two `impl` blocks, an overload -- and reading only the first
   * one found means judging a signature that is not the one the arrow is
   * about. Measured on real code that was six wrong answers out of 159, every
   * one of them a `absent` that would have been a red.
   *
   * So: any declaration that confirms, confirms. Failing that, any that finds
   * the name in the other half says so. Failing that, a single reason to
   * withhold silences the whole answer, because "one of these signatures could
   * be hiding it behind an alias" is exactly the doubt that forbids an
   * accusation.
   */
  let misplaced: SignatureVerdict | undefined;
  let withheld: SignatureVerdict | undefined;
  let absent: SignatureVerdict | undefined;

  for (const { node: declaration, self } of declarations) {
    sawName = true;
    const signature = signatureNode(declaration);
    if (!signature) continue;
    sawSignature = true;

    const parameters = signature.childForFieldName("parameters");
    const returned = signature.childForFieldName("return_type");
    const inParameters = new Set<string>();
    const quotedParameters = parameters
      ? parameterTypes(parameters, inParameters, quoting) : false;
    const inReturn = new Set<string>();
    const quotedReturn = typeNames(returned, inReturn, quoting);

    /*
     * `Self` reads as the type the `impl` names, and where there is no such
     * name it is struck out and remembered: a signature with an unresolvable
     * `Self` in it may be naming the target under that spelling, so it can
     * still confirm and can no longer refute.
     */
    let selfHeld = false;
    if (selfMeansEnclosing) {
      for (const half of [inParameters, inReturn]) {
        if (!half.delete(SELF)) continue;
        if (self) half.add(self); else selfHeld = true;
      }
    }

    const here = position === "parameter" ? inParameters : inReturn;
    const there = position === "parameter" ? inReturn : inParameters;
    const text = `${parameters?.text ?? ""}${returned ? ` -> ${returned.text.replace(/^:\s*/, "")}` : ""}`.trim();
    const line = lineOf(source, signature.startIndex);

    const found = targets.find((target) => here.has(target));
    if (found) {
      return { verdict: "confirmed", evidence: { name: found, line, position, signature: text } };
    }

    const elsewhere = targets.find((target) => there.has(target));
    if (elsewhere && !misplaced) {
      misplaced = {
        verdict: "misplaced",
        evidence: {
          name: elsewhere,
          line,
          position: position === "parameter" ? "return" : "parameter",
          signature: text,
        },
      };
      continue;
    }
    if (elsewhere) continue;

    if (selfHeld) {
      withheld ??= { verdict: "withheld", why: "self-type" };
      continue;
    }
    /*
     * A type written inside a string in the half being claimed. The words in it
     * were read and the target is not among them -- but they were read by
     * scanning text, so that is the reader failing to find a name rather than
     * the signature failing to have one.
     *
     * Asked of the claimed half only. An absence is a statement about the half
     * the arrow names, and a quoted parameter has no bearing on whether the
     * return type says what it says.
     */
    if (position === "parameter" ? quotedParameters : quotedReturn) {
      withheld ??= { verdict: "withheld", why: "quoted-annotation" };
      continue;
    }
    /*
     * Read to the end and the name is not in it -- but only worth saying when
     * every name that *is* in it means itself. One alias in the signature and
     * the target could be sitting there under another spelling.
     */
    const spellings = new Set([...inParameters, ...inReturn]);
    if ([...spellings].some((name) => shadows.has(name))) {
      withheld ??= { verdict: "withheld", why: "aliased" };
      continue;
    }
    // `returns` asked of a function that declares no return type is a question
    // about lines that do not exist, not an absence.
    if (position === "return" && !returned) {
      withheld ??= { verdict: "withheld", why: "untyped-return" };
      continue;
    }
    absent ??= { verdict: "absent", signature: text, line };
  }

  if (misplaced) return misplaced;
  if (withheld) return withheld;
  /*
   * The last gate, and the only one here that is about us rather than about the
   * code. Placed after every other answer so a language with no licence still
   * gets its confirmations, its `misplaced` verdict and its ordinary refusals --
   * losing the licence should cost the accusation and nothing else.
   */
  if (absent) return mayAccuse(language) ? absent : { verdict: "withheld", why: "unlicensed" };

  if (!sawName) return { verdict: "withheld", why: "not-declared" };
  return { verdict: "withheld", why: sawSignature ? "unreadable" : "no-signature" };
}
