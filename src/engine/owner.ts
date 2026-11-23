/**
 * A box written `Type::method`, read as that type's method when confirming
 * (fill study, 2026-11).
 *
 * Since #409 a ref's owner is dropped on the way in: `glob.rs#MatchStrategy::new`
 * is the name `new`, and every reader looks up `new`. That is right for
 * *refuting* -- an end the reader cannot pin down must never go red -- and it
 * was wrong for *confirming*: any `new` in the file could answer. "`Glob`
 * returns `MatchStrategy::new`" came back green because `Glob::new` returns a
 * `Glob`; "`Policy::check` calls `TowerRedirectPolicy::redirect`" because
 * `Policy::check` calls its own `redirect`. 11 of the 93 wrong arrows the code
 * confirmed on 123 boards were this.
 *
 * So a confirmation is asked twice where it matters. The plain reading first,
 * exactly as before; and when it confirms and the file declares the name
 * under some other owner too, again over an **owner view** of the file: the
 * same text with every declaration of the name that is *not* the owner's
 * renamed out of reach, character for character, so every offset and line
 * stays where it was. What still confirms there confirmed the owner's own
 * declaration. What does not is "not sure" -- never red, because the plain
 * reading, which is what any accusation rests on, said yes.
 *
 * The owner of a declaration is read off the structure: every declaration
 * around it (a class, a trait, an interface, a module, a namespace, a
 * variable holding an object or a class), and for a Rust `impl` both its type
 * and its trait, generics and paths taken off. Where no declaration of the
 * name sits under the owner at all -- an owner spelled some way this cannot
 * read -- nothing is hidden, and the reading stays what #409 made it.
 */
import { declarationName } from "./declared";
import { parseSource, type Language, type Node } from "./parse";

/** The bare name a type is spelled with: `Wrap` in `&'a mut Wrap<T>`, `Error` in `crate::Error`. */
function typeName(node: Node | null): string | undefined {
  let type = node;
  for (let step = 0; type && step < 6; step += 1) {
    if (type.childCount === 0) return /^[A-Za-z_]\w*$/.test(type.text) ? type.text : undefined;
    const next = type.childForFieldName("name") ?? type.childForFieldName("type");
    if (!next) return undefined;
    type = next;
  }
  return undefined;
}

/** The names a node gives what is declared inside it. */
function ownerNames(node: Node): string[] {
  if (node.type === "impl_item") {
    return [typeName(node.childForFieldName("type")), typeName(node.childForFieldName("trait"))]
      .filter((name): name is string => name !== undefined);
  }
  const name = declarationName(node);
  return name ? [name.text] : [];
}

interface Declared {
  /** The leaf that names it. */
  name: Node;
  /** Every owner name around it, innermost last. */
  owners: string[];
}

function declarationsOf(source: string, language: Language, name: string): Declared[] | undefined {
  const tree = parseSource(source, language);
  if (!tree) return undefined;
  const found: Declared[] = [];
  const visit = (node: Node, owners: string[]): void => {
    if (node.type === "token_tree") return;
    if (node.type !== "impl_item") {
      const named = declarationName(node);
      if (named?.text === name) found.push({ name: named, owners });
    }
    const inside = [...owners, ...ownerNames(node)];
    for (let index = 0; index < node.childCount; index += 1) {
      const child = node.child(index);
      if (child) visit(child, inside);
    }
  };
  visit(tree.rootNode, []);
  return found;
}

/**
 * The file as the owner's declaration of `name` sees it: every other
 * declaration of `name` renamed to a run of underscores of the same length.
 *
 * `undefined` when there is nothing to hide -- every declaration of the name
 * is the owner's -- or nothing to go on: no declaration of it sits under the
 * owner, or the file does not parse.
 */
export function ownerView(source: string, language: Language, name: string, owner: string): string | undefined {
  const declared = declarationsOf(source, language, name);
  if (!declared) return undefined;
  const others = declared.filter((one) => !one.owners.includes(owner));
  if (others.length === 0 || others.length === declared.length) return undefined;
  let view = source;
  for (const { name: leaf } of others) {
    const start = leaf.startIndex;
    const end = start + leaf.text.length;
    view = view.slice(0, start) + "_".repeat(end - start) + view.slice(end);
  }
  return view;
}

/** Owners that mean "where this is written", not a type: `Self::new`, `crate::parse`, `self.run`. */
const HERE_WORDS = new Set(["Self", "self", "crate", "super", "this", "cls"]);

/**
 * The owner a ref was written with, when it picks one declaration out of
 * several: not a word meaning "here", and not the file's own module
 * (`net.rs#net::accept`).
 */
export function pickingOwner(owner: string | undefined, file: string): string | undefined {
  if (!owner || HERE_WORDS.has(owner)) return undefined;
  const stem = file.replace(/\\/g, "/").split("/").pop()!.replace(/\.[^.]*$/, "");
  return owner === stem ? undefined : owner;
}
