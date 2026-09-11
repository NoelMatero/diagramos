/**
 * Where code touches the outside world: files, the network, other processes.
 *
 * A measurement first (#58). An arrow onto a box outside the repository -- a
 * file on disk, a service, a database -- carries no claim any check here can
 * read, because every channel asks whether code A reaches code B and there is
 * no B. What *is* in the repository is the code that talks to that thing: a
 * save function, a client, a spawn. This reader finds those calls, so a box for
 * the outside thing can be anchored at its door and an arrow onto it becomes a
 * question about code.
 *
 * Nothing consumes this but `scripts/measure-doors.mts`. It puts no colour on a
 * diagram and no word rests on it.
 */
import { bindingsIn } from "./calls";
import { parseSource, type Language, type Node } from "./parse";

/** The kinds of outside contact counted. Console output is deliberately not one. */
export type OutsideKind = "file" | "network" | "process";

/** One call, and what this reader could tell about where it lands. */
export type CallReading =
  /** The callee resolves to a name on the outside list. */
  | { verdict: "outside"; kind: OutsideKind; qualified: string }
  /** The callee resolves to a name that is not on the list. */
  | { verdict: "not-outside"; qualified: string }
  /** The callee could not be named: a value's method, a computed callee. */
  | { verdict: "unknown"; why: "receiver" | "computed" };

export interface OutsideCall {
  /** The innermost named routine the call is written in, when there is one. */
  routine?: string;
  /** 1-based. */
  line: number;
  /** The called name's own range, which is where a checker is asked. */
  nameAt: { start: number; end: number };
  reading: CallReading;
}

/** Languages that share one module system, and so one list. */
type Family = "ts" | "python" | "rust";

const FAMILY: Partial<Record<Language, Family>> = { ts: "ts", tsx: "ts", js: "ts", python: "python", rust: "rust" };

/**
 * What counts as the outside, by module, per family -- the one list.
 *
 * Keyed by module rather than by function wherever a module is one kind of
 * thing through and through: everything `fs` exports touches the disk. A list
 * of functions would be the list `docs/reading-a-grammar.md` warns about, and
 * would go stale with every release of the runtime.
 *
 * The benchmark prints every standard-library call this list does not cover, so
 * its edge is a number rather than a guess.
 */
const OUTSIDE: Record<Family, ReadonlyArray<readonly [string, OutsideKind]>> = {
  ts: [
    ["fs", "file"],
    ["fs/promises", "file"],
    ["child_process", "process"],
    ["net", "network"],
    ["http", "network"],
    ["https", "network"],
    ["http2", "network"],
    ["dgram", "network"],
    ["tls", "network"],
    ["dns", "network"],
    ["fetch", "network"],
  ],
  /*
   * Python's `os` is the one module that is three things at once -- the disk,
   * other processes, and harmless questions like `getenv` -- so it is the one
   * place members are listed rather than the module.
   */
  python: [
    ["open", "file"],
    ["io.open", "file"],
    ["shutil", "file"],
    ["tempfile", "file"],
    ["glob", "file"],
    ["fileinput", "file"],
    ...[
      "remove", "unlink", "rename", "renames", "replace", "mkdir", "makedirs", "rmdir", "removedirs",
      "listdir", "scandir", "walk", "stat", "lstat", "chmod", "chown", "link", "symlink", "readlink",
      "truncate", "utime", "open", "fdopen",
    ].map((name) => [`os.${name}`, "file"] as const),
    ...[
      "exists", "lexists", "isfile", "isdir", "islink", "getsize", "getmtime", "getatime", "getctime", "samefile",
    ].map((name) => [`os.path.${name}`, "file"] as const),
    ...[
      "system", "popen", "execv", "execve", "execl", "execle", "execlp", "execvp", "execvpe",
      "spawnl", "spawnv", "posix_spawn", "fork", "kill", "startfile",
    ].map((name) => [`os.${name}`, "process"] as const),
    ["subprocess", "process"],
    ["socket", "network"],
    ["ssl", "network"],
    ["http.client", "network"],
    ["urllib.request", "network"],
    ["ftplib", "network"],
    ["smtplib", "network"],
  ],
  rust: [
    ["std::fs", "file"],
    ["std::net", "network"],
    ["std::process::Command", "process"],
  ],
};

/** Crate roots a Rust path may start from without any `use`. */
const RUST_ROOTS = new Set(["std", "core", "alloc"]);

/** How a family writes the step between a module and a member. */
const STEP: Record<Family, string> = { ts: ".", python: ".", rust: "::" };

/** The kind of outside a qualified name lands in, by its longest listed module. */
function kindOf(qualified: string, family: Family): OutsideKind | undefined {
  const name = family === "ts" ? qualified.replace(/^node:/, "") : qualified;
  let best: readonly [string, OutsideKind] | undefined;
  for (const entry of OUTSIDE[family]) {
    const [module] = entry;
    if (name !== module && !name.startsWith(module + STEP[family])) continue;
    if (!best || module.length > best[0].length) best = entry;
  }
  return best?.[1];
}

/**
 * The kind of outside a qualified name lands in, for a caller holding a name it
 * worked out some other way -- the benchmark's checker, which names a call by
 * where "go to definition" landed. Both sides consult this one list, so a
 * disagreement between them is about which name a call is, never about what
 * counts as the outside.
 */
export function kindOfQualified(qualified: string, language: Language): OutsideKind | undefined {
  const family = FAMILY[language];
  return family ? kindOf(qualified, family) : undefined;
}

/*
 * A callee is read through the grammar's own fields, never its node names: a
 * member access has a head (`object`, `path`, `value`) and a tail (`property`,
 * `attribute`, `name`, `field`) in every grammar here, and a bare name is a
 * leaf. Anything else -- a call's result, a subscript -- is not a name.
 */
const HEAD_FIELDS = ["object", "path", "value"];
const TAIL_FIELDS = ["property", "attribute", "name", "field"];

/** The callee as a chain of names, and the node the last one is written at. */
function chainOf(node: Node): { names: string[]; last: Node } | undefined {
  if (node.childCount === 0) return { names: [node.text], last: node };
  for (const field of TAIL_FIELDS) {
    const tail = node.childForFieldName(field);
    if (!tail) continue;
    const headNode = HEAD_FIELDS.map((one) => node.childForFieldName(one)).find((one) => one !== null);
    if (!headNode) return undefined;
    const head = chainOf(headNode);
    return head ? { names: [...head.names, tail.text], last: tail } : undefined;
  }
  return undefined;
}

/** A routine's name, by the rule `callSitesIn` uses: a name, parameters, and a body. */
function routineNameOf(node: Node): string | undefined {
  const name = node.childForFieldName("name") ?? node.childForFieldName("left");
  if (!name || name.childCount !== 0) return undefined;
  const value = node.childForFieldName("value");
  if (!(node.childForFieldName("parameters") ?? value?.childForFieldName("parameters"))) return undefined;
  if (!(node.childForFieldName("body") ?? value?.childForFieldName("body"))) return undefined;
  return name.text;
}

const lineAt = (source: string, index: number) => source.slice(0, index).split("\n").length;

export function outsideCallsIn(source: string, language: Language): { read: boolean; calls: OutsideCall[] } {
  const family = FAMILY[language];
  if (!family) return { read: false, calls: [] };
  const bindings = bindingsIn(source, language);
  const tree = parseSource(source, language);
  if (!bindings || !tree) return { read: false, calls: [] };

  const readingOf = (names: string[]): CallReading => {
    const [head, ...rest] = names;
    const binding = head === undefined ? undefined : bindings.imported.get(head);
    if (head === undefined || bindings.ambiguous.has(head)) return { verdict: "unknown", why: "receiver" };
    let qualified: string;
    if (binding) {
      // A named TypeScript import records its module and not its own name, so
      // the name is put back; every other binding already ends in the name.
      qualified = family === "ts" && !binding.namespace && rest.length === 0
        ? `${binding.specifier}${STEP[family]}${head}`
        : [binding.specifier, ...rest].join(STEP[family]);
    } else if (rest.length === 0) {
      qualified = head;
    } else if (family === "rust" && RUST_ROOTS.has(head)) {
      qualified = names.join(STEP[family]);
    } else {
      return { verdict: "unknown", why: "receiver" };
    }
    const kind = bindings.local.has(head) && !binding ? undefined : kindOf(qualified, family);
    return kind ? { verdict: "outside", kind, qualified } : { verdict: "not-outside", qualified };
  };

  const calls: OutsideCall[] = [];
  const walk = (node: Node, routine: string | undefined): void => {
    const here = routineNameOf(node) ?? routine;
    const callee = node.childForFieldName("function");
    if (callee) {
      const chain = chainOf(callee);
      const at = chain?.last ?? callee;
      calls.push({
        ...(here ? { routine: here } : {}),
        line: lineAt(source, at.startIndex),
        nameAt: { start: at.startIndex, end: at.startIndex + at.text.length },
        reading: chain ? readingOf(chain.names) : { verdict: "unknown", why: "computed" },
      });
    }
    for (let index = 0; index < node.childCount; index += 1) {
      const child = node.child(index);
      if (child) walk(child, here);
    }
  };
  walk(tree.rootNode, undefined);
  return { read: true, calls };
}
