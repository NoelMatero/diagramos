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
 * `npm run measure:signature` re-runs it. Over this repository and rust-test --
 * 644 functions, 1711 type names written in their signatures -- the reader found
 * every one, and refused to answer on 64 of the 644 (58 for an alias, 6 for a
 * recovered parse). The referee is a text scan of the signature source, chosen
 * because it shares no machinery with the syntax walk here: two unrelated
 * readings agreeing says something, and one reading agreeing with itself does
 * not.
 *
 * The measurement found two reader bugs before shipping, both of which would
 * have produced a false red:
 *
 *   - reading only `identifier` leaves left it blind to every built-in, because
 *     TypeScript calls `string` a `predefined_type` and Rust calls `bool` a
 *     `primitive_type` -- a third of every signature;
 *   - reading only the *first* declaration of a name judged the wrong signature
 *     whenever a name is declared twice, which is `new`, `parse`, `from`, and
 *     any method on two `impl` blocks.
 *
 * Neither was reachable by thinking about it, which is the argument for the
 * script existing rather than for a number in a comment.
 */
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
  | "untyped-return";

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
 */
function typeNames(node: Node | null | undefined, into: Set<string>): void {
  if (!node) return;
  each(node, (leaf) => { if (isTypeWord(leaf)) into.add(leaf.text); });
}

function parameterTypes(parameters: Node): Set<string> {
  const names = new Set<string>();
  for (let index = 0; index < parameters.childCount; index += 1) {
    const parameter = parameters.child(index);
    if (!parameter || parameter.childCount === 0) continue;
    typeNames(parameter.childForFieldName("type"), names);
  }
  return names;
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

  const declarations: Node[] = [];
  each(tree.rootNode, (node) => {
    if (node.type === "token_tree") return;
    const name = node.childForFieldName("name") ?? node.childForFieldName("left");
    if (name && name.childCount === 0 && name.text === symbol) declarations.push(node);
  });

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

  for (const declaration of declarations) {
    sawName = true;
    const signature = signatureNode(declaration);
    if (!signature) continue;
    sawSignature = true;

    const parameters = signature.childForFieldName("parameters");
    const returned = signature.childForFieldName("return_type");
    const inParameters = parameters ? parameterTypes(parameters) : new Set<string>();
    const inReturn = new Set<string>();
    typeNames(returned, inReturn);

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
  if (absent) return absent;

  if (!sawName) return { verdict: "withheld", why: "not-declared" };
  return { verdict: "withheld", why: sawSignature ? "unreadable" : "no-signature" };
}
