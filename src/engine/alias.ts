/**
 * Names that stand for a type written somewhere else (#303).
 *
 * Both refutable readers of a declaration -- `signature.ts` and `holds.ts` --
 * are allowed to say *wrong* because what they read is a closed region: a
 * parameter list and a field list can each be written out in full, so a type
 * absent from one is absent. That holds only while every name in the region
 * means itself. One alias in it and the target could be sitting there under
 * another spelling, and the absence is about the reader rather than the code.
 *
 * Each reader used to carry its own copy of this, kept separate on purpose. The
 * copies then disagreed, which is the failure `docs/reading-a-grammar.md` is
 * about: #300's fixtures found `@takes`, `@returns` and `@holds` all calling a
 * correct aliased arrow wrong, and Python doing it even for an alias declared
 * on the line above -- because Python spells an alias as an ordinary assignment
 * and neither copy read one.
 *
 * Two questions, and they are not the same question:
 *
 *  - **What does this file rename?** `use a::B as C`, `import { B as C }`,
 *    `type C = B`, `C = B`. Seeing `C` in a signature means the signature might
 *    be naming the target, so nothing may refute.
 *  - **What does the *target's* file call it?** The alias that hides a type is
 *    usually declared beside the type, and imported plainly from there --
 *    `use crate::model::{Req, Request}`, where `model.rs` says `pub type Req =
 *    Request`. Nothing in the reading file marks `Req` as anything but an
 *    import, so the first question cannot see it and the second is the only one
 *    that can.
 *
 * Neither is alias *resolution*, which would need a type checker: an alias
 * found here withholds the answer, and never turns one into a confirmation.
 */
import { each, parseSource, type Language, type Node } from "./parse";

/** Node types that can rename something on the way in, if they actually do. */
const RENAMES = new Set([
  "import_specifier", "aliased_import", "export_specifier", "use_as_clause",
]);

/** Node types that introduce a name for a type written elsewhere. */
const ALIASES = new Set(["type_alias_declaration", "type_item"]);

/** A declaration's name, wherever its grammar puts one. Python annotates through `left`. */
function nameOf(node: Node): Node | undefined {
  return node.childForFieldName("name") ?? node.childForFieldName("left") ?? undefined;
}

/** What a declaration stands for, wherever its grammar puts that. */
function valueOf(node: Node): Node | undefined {
  return node.childForFieldName("value")
    ?? node.childForFieldName("type")
    ?? node.childForFieldName("right")
    ?? undefined;
}

/**
 * Whether this declaration is one that gives a name to something else.
 *
 * `parse.ts`'s rule, read the way it is written there: a declaration has a
 * `name`, a routine also has `parameters`, and something with a `body` of its
 * own is a thing rather than a name for one. What is left -- a name and a value
 * and neither of those -- is every spelling of an alias in every grammar
 * loaded here, and a hand-written list of node types would have missed the
 * Python one, which is how this shipped wrong.
 */
function isAlias(node: Node): boolean {
  if (node.childForFieldName("parameters") || node.childForFieldName("body")) return false;
  return nameOf(node) !== undefined && valueOf(node) !== undefined;
}

/**
 * Names in this file that stand for something other than themselves.
 *
 * The last name in a rename is the one the file goes on to use -- `use a::B as
 * C`, `import { B as C }`, `from a import B as C` all end in the alias -- and
 * the name of an alias declaration is the one it introduces.
 *
 * Only a rename that actually renames. Every grammar here gives a plain named
 * import the same node type as a renamed one, and the `alias` field is the only
 * thing separating them; treating every import as a possible rename took the
 * signature reader's refusal rate to 42% when #169 measured it, which is a word
 * that ships and never fires.
 *
 * Deliberately a set of names rather than a flag on the file. A file with one
 * alias in it that no signature uses is still a file whose signatures can be
 * refuted, and the whole-file version would have withheld on most real code.
 */
export function aliasNames(root: Node): Set<string> {
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
  for (const name of boundAtTopLevel(root)) shadows.add(name);
  return shadows;
}

/**
 * Names this file binds to a value at its top level.
 *
 * How Python spells a type alias: `Req = Request`, with no keyword to say so
 * and no node type of its own. So the rule is the position -- a name bound at
 * module level, used where a type goes -- and that is sound in the one
 * direction it is asked: a name that is a variable in this file is not a name
 * that can be relied on to mean itself.
 *
 * Top level only, walked through the statement wrappers each grammar puts
 * around one. A local inside a routine is not visible where an annotation is
 * written, and collecting every one of them would have silenced a file for
 * every temporary in it.
 *
 * **It must bind something.** A name that is only *annotated* -- `declare const
 * ComputedRefSymbol: unique symbol`, which vue's `computed.ts` writes twice --
 * declares a thing rather than a name for another thing, and nothing can be
 * hiding behind it. So `type` does not count here, where it does in
 * `aliasesFor`: there the question is what a declaration stands for, and Rust
 * writes that on `type`.
 *
 * No board in the corpus changes verdict on this alone; it is here because the
 * wider rule was reached for while reading one of these, and a refusal that
 * cannot be right is worth not making.
 */
function boundAtTopLevel(root: Node): string[] {
  const names: string[] = [];
  const consider = (node: Node, depth: number): void => {
    if (depth > 2) return;
    const bound = node.childForFieldName("value") ?? node.childForFieldName("right");
    if (bound && isAlias(node)) {
      const name = nameOf(node);
      if (name && name.childCount === 0) names.push(name.text);
      return;
    }
    if (node.childForFieldName("parameters") || node.childForFieldName("body")) return;
    for (let index = 0; index < node.childCount; index += 1) {
      const child = node.child(index);
      if (child) consider(child, depth + 1);
    }
  };
  for (let index = 0; index < root.childCount; index += 1) {
    const child = root.child(index);
    if (child) consider(child, 0);
  }
  return names;
}

/**
 * What the file declaring a type calls it, besides its own name.
 *
 * `use crate::model::{Req, Request}` tells the reading file nothing: both
 * arrive as plain imports and only `model.rs` knows that one of them is
 * `pub type Req = Request`. Every one of #300's nine aliased false reds is this
 * shape, in three languages, and it is not visible from the file being refuted.
 *
 * One hop, and deliberately: an alias naming the target directly is the shape
 * real code writes, and a chain of them is a question for a type checker. What
 * a longer chain costs is a red that should have been silence, which is the
 * failure that was already there.
 */
export function aliasesFor(
  source: string,
  language: Language,
  targets: string[],
): Set<string> {
  const names = new Set<string>();
  const tree = parseSource(source, language);
  if (!tree) return names;
  const wanted = new Set(targets);
  each(tree.rootNode, (node) => {
    if (!isAlias(node)) return;
    const name = nameOf(node);
    const value = valueOf(node);
    if (!name || name.childCount !== 0 || !value) return;
    let stands = false;
    each(value, (part) => {
      if (part.childCount === 0 && wanted.has(part.text)) stands = true;
    });
    if (stands) names.add(name.text);
  });
  return names;
}
