/**
 * Whether a method is one some subclass in the repository declares again
 * (#353).
 *
 * `@calls`' closed reading takes the method a call lands on as the place the
 * call runs. For a plain base class that is only true when nothing overrides
 * it: `send(t: Transport)` calling `t.handle(r)` runs `HTTPTransport.handle`
 * whenever `t` is one, which is the point of the base class. "Go to
 * definition" answers `Transport.handle` all the same, and so does a
 * compiler's call hierarchy -- which is why `bench:planted`'s key could never
 * see it. The rule the reading needs is "runs where it is declared, and
 * nothing overrides it", and this file is the second half.
 *
 * Read from the text, by the bases `conforms.ts` already reads: a class that
 * names the holder as a base -- directly, through a qualified name, through an
 * import alias, or anywhere inside a base it cannot read as a name -- and
 * declares a member of the same name. And transitively, because a grandchild
 * overriding is the same hazard one level down.
 *
 * Every doubt answers yes. Matching by name rather than by binding finds a
 * subclass of an unrelated class that happens to share the holder's name, and
 * the cost of that is one arrow withheld, not one arrow called wrong. A walk
 * past its cap, or a chain of subclasses longer than anyone writes, is the
 * same answer for the same reason.
 *
 * Rust is not read: a method in an `impl` block cannot be overridden, and a
 * trait's default method is already withheld where the definition is judged.
 */
import { basesOfDeclaration } from "./conforms";
import { each, withParsed, type Language, type Node } from "./parse";

export interface Overrides {
  /**
   * Whether a class deriving from the one named `holder`, at any depth,
   * declares `member` itself. `true` whenever that cannot be ruled out.
   */
  below(holder: string, member: string): boolean;
}

export interface OverrideSource {
  source: string;
  language: Language;
}

/** A class some other class names as a base, as far as it matters here. */
interface Derived {
  name?: string;
  members: Set<string>;
}

/**
 * Past this many classes down one holder's tree, the answer is yes rather
 * than a longer walk. No hierarchy in `.corpus` comes near it.
 */
const DEPTH_CAP = 256;

/**
 * An override index over the files `sources` hands back, read lazily: nothing
 * is walked or parsed until the first question, and a file is parsed only when
 * its text names the class being asked about. `undefined` from `sources` is a
 * walk that gave up, and every question then answers yes.
 */
export function overridesIn(sources: () => readonly OverrideSource[] | undefined): Overrides {
  let files: readonly OverrideSource[] | undefined | null = null;
  const derivedFrom = new Map<string, Derived[]>();
  const answers = new Map<string, boolean>();

  const derived = (name: string): Derived[] => {
    const known = derivedFrom.get(name);
    if (known) return known;
    const found: Derived[] = [];
    const word = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
    for (const file of files ?? []) {
      if (file.language === "rust" || !word.test(file.source)) continue;
      found.push(...derivedIn(file, name, word));
    }
    derivedFrom.set(name, found);
    return found;
  };

  return {
    below(holder, member) {
      const key = `${holder}\0${member}`;
      const known = answers.get(key);
      if (known !== undefined) return known;
      if (files === null) files = sources();
      if (files === undefined) return true;

      let answer = false;
      const seen = new Set([holder]);
      const queue = [holder];
      while (queue.length > 0 && !answer) {
        for (const one of derived(queue.shift()!)) {
          if (one.members.has(member)) { answer = true; break; }
          if (!one.name || seen.has(one.name)) continue;
          if (seen.size >= DEPTH_CAP) { answer = true; break; }
          seen.add(one.name);
          queue.push(one.name);
        }
      }
      answers.set(key, answer);
      return answer;
    },
  };
}

/** Every class in one file that names `name` as a base, however it is spelled there. */
function derivedIn(file: OverrideSource, name: string, word: RegExp): Derived[] {
  return withParsed(file.source, file.language, (tree) => derivedInTree(tree.rootNode, name, word)) ?? [];
}

function derivedInTree(root: Node, name: string, word: RegExp): Derived[] {
  const spelled = aliasesOf(root, name);
  const found: Derived[] = [];
  each(root, (node) => {
    const body = node.childForFieldName("body");
    if (!body || node.childForFieldName("parameters")) return;
    const bases = basesOfDeclaration(node);
    const names = bases.names.map((base) => base.split(/::|\./).pop()!);
    /*
     * A base this reader will not take a name out of -- `mixin(Transport)`,
     * `with_metaclass(Meta, Transport)` -- is counted when the holder's name
     * is anywhere in the file, which is what `word` already established: the
     * doubt answers yes.
     */
    if (!names.some((base) => spelled.has(base)) && !(bases.computed && word.test(node.text))) return;
    const own = node.childForFieldName("name");
    found.push({
      ...(own && own.childCount === 0 ? { name: own.text } : {}),
      members: membersOf(body),
    });
  });
  return found;
}

/**
 * The names a class goes by in this file: its own, and any alias an import
 * gives it -- `import { Transport as Base }`, `from base import Transport as
 * Base`. `conforms.ts`' shadow rule, turned round to answer which spellings
 * stand for the one name rather than which stand for something else.
 */
function aliasesOf(root: Node, name: string): Set<string> {
  const spelled = new Set([name]);
  each(root, (node) => {
    const alias = node.childForFieldName("alias");
    const original = node.childForFieldName("name");
    if (!alias || !original || alias.childCount !== 0) return;
    if (original.text.split(/::|\./).pop() === name) spelled.add(alias.text);
  });
  return spelled;
}

/**
 * The names a class body declares directly: methods, fields, and Python's
 * class-level assignments, through a decorator where one is written. A nested
 * class's members are its own.
 */
function membersOf(body: Node): Set<string> {
  const members = new Set<string>();
  const declared = (node: Node): string | undefined => {
    const named = node.childForFieldName("name") ?? node.childForFieldName("left");
    if (named) return named.childCount === 0 ? named.text : undefined;
    const inner = node.childForFieldName("definition") ?? onlyNamedChild(node);
    return inner ? declared(inner) : undefined;
  };
  for (const child of namedChildren(body)) {
    const name = declared(child);
    if (name) members.add(name);
  }
  return members;
}

function namedChildren(node: Node): Node[] {
  const named: Node[] = [];
  for (let index = 0; index < node.childCount; index += 1) {
    const child = node.child(index);
    if (child?.isNamed) named.push(child);
  }
  return named;
}

/** A statement wrapping one thing -- Python's `expression_statement` around an assignment. */
function onlyNamedChild(node: Node): Node | undefined {
  const named = namedChildren(node);
  return named.length === 1 ? named[0] : undefined;
}

/**
 * The declaration each routine in a tree belongs to as a member -- the class,
 * `impl` or trait around a method -- keyed by node id. A routine at the top of
 * its file, or inside something that is not one, has no entry.
 *
 * Read by structure rather than by a list of node types, so all four grammars
 * answer by one rule: the nearest enclosing node with a body and a name (or,
 * for an `impl`, a type) that is not itself a routine. A loop has a body and
 * no name; a function has a name and parameters, and a function nested in a
 * method belongs to the method's class. Top-down, because the engine's nodes
 * do not carry a parent.
 */
export function holdersIn(root: Node): Map<number, Node> {
  const holders = new Map<number, Node>();
  const visit = (node: Node, holder: Node | undefined): void => {
    const routine = node.childForFieldName("parameters") !== null;
    if (holder && (node.childForFieldName("name") ?? node.childForFieldName("left"))) holders.set(node.id, holder);
    const holds = !routine && node.childForFieldName("body") !== null
      && (node.childForFieldName("name") ?? node.childForFieldName("type")) !== null;
    for (let index = 0; index < node.childCount; index += 1) {
      const child = node.child(index);
      if (child) visit(child, holds ? node : holder);
    }
  };
  visit(root, undefined);
  return holders;
}

/** Whether a holder's own body declares `member` -- not a base's, and not one set on the instance later. */
export function declaresMember(holder: Node, member: string): boolean {
  const body = holder.childForFieldName("body");
  return body ? membersOf(body).has(member) : false;
}
