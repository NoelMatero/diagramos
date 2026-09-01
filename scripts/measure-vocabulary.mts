#!/usr/bin/env node
/**
 * How much of a diagram can be judged, and what the missing words would be.
 *
 *   npm run measure:vocabulary
 *
 * Every number quoted in #187 and #190 should come out of one run of this. A
 * number in an issue that nothing reproduces is the same problem as a claim on a
 * board that nothing checks.
 *
 * An arrow can carry a claim word -- `@needs`, `@feeds`, `@takes`, `@returns` --
 * and when it does, the engine reads the code and can say the arrow is wrong.
 * Six words exist, so most of a board asserts "these two are related, somehow",
 * which nothing can ever call wrong. This does not add a word. It measures the
 * gap, so the question "do we need more words" is a command rather than an
 * opinion.
 *
 * Four probes, cheapest first. This file carries the first three; the fourth
 * points Claude at unseen repositories and is the only one that costs money to
 * run, so it lives outside a script that anybody might run on a whim.
 *
 *   A  failed claims   every arrow the checker calls wrong today
 *   B  arrow prose     what authors wrote when there was no word
 *   C  relation census what the code actually says, per language
 *
 * Nothing here decides anything and nothing here fails. It prints, the way
 * `measure-survey.mts` and `measure-signature.mts` print, so the decision can be
 * argued with rather than asserted.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import { readFileSync } from "node:fs";

import { readBoard } from "../src/engine/board-file";
import { checkDrift, createWorkspace, type DriftFinding, type EdgeDriftFinding } from "../src/engine/drift";
import { readGraph } from "../src/engine/graph";
import { each, initEngine, languageOf, parseSource, type Language, type Node } from "../src/engine/parse";

const HOME = process.env.HOME ?? "/Users/noelmatero";

/**
 * Where boards are looked for.
 *
 * There are 1,902 `.excalidraw` files on the machine this was written on and
 * roughly two dozen distinct boards. The rest are copies: 1,171 live in
 * throwaway worktrees under `.claude`, several hundred are test fixtures, and
 * six sibling checkouts -- `board-ai-anchors`, `board-ai-daemon` and friends --
 * each hold an older copy of the same thirteen boards this repository has now.
 *
 * Counting those is not more data. It is the same board six times at six
 * different ages, which inflates every total by about six and makes staleness
 * look like signal. So the corpus is named rather than discovered, and a root
 * that is not on disk is skipped and said to be skipped.
 */
const BOARD_ROOTS = [
  path.resolve(process.cwd()),
  `${HOME}/orangutan`,
  `${HOME}/Downloads`,
];

/**
 * Copies and fixtures rather than boards.
 *
 * `demo-124` and `demo-141` are the awkward ones and they are excluded for a
 * reason worth stating: they hold a *deliberately* backwards arrow, drawn to
 * demonstrate what a red looks like. Counting them puts a permanent one in the
 * failed-claim number, which is meant to be a regression signal that sits near
 * zero -- a floor nothing can ever clear reads exactly like a bug nobody fixed.
 */
const NOT_A_BOARD = [
  "/node_modules/",
  "/.claude/",
  "/tests/",
  "/fixtures/",
  "/out/",
  "/.git/",
  "/demo-",
];

function boardsUnder(root: string): string[] {
  if (!existsSync(root)) return [];
  try {
    return execFileSync("find", [root, "-name", "*.excalidraw", "-type", "f"], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      /*
       * Matched against the path *below* the root, never the whole path. A
       * worktree of this repository lives under `.claude` itself, so filtering
       * the absolute path threw away every board in the checkout the run was
       * started from -- and reported four boards as if that were the corpus.
       */
      .filter((file) => {
        const below = `/${path.relative(root, file)}`;
        return !NOT_A_BOARD.some((fragment) => below.includes(fragment));
      })
      .sort();
  } catch {
    return [];
  }
}

/**
 * The repository a board describes, which is the tree its refs resolve against.
 *
 * A board in `orangutan/docs/diagrams` names Rust files in `orangutan`, so the
 * workspace has to be that checkout and not this one. Nearest ancestor holding a
 * `.git` -- and a board with no repository above it is read for its prose and
 * left out of the checker, because every ref it carries would report missing for
 * a reason that is about us rather than about the board.
 */
function repositoryOf(file: string): string | undefined {
  let directory = path.dirname(file);
  for (;;) {
    if (existsSync(path.join(directory, ".git"))) return directory;
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

/* ── A · the failed-claim sweep ─────────────────────────────────────────────
 *
 * Every arrow the checker calls wrong today, and every box claim it calls
 * wrong. A red on a diagram whose author believes it is correct is a missing
 * word rather than a wrong diagram -- that is how the `RouteInfo` case in #188
 * was found -- but which of the two it is cannot be decided by a script. So this
 * prints the list and the sort stays a human read.
 *
 * Staleness is the thing that would otherwise drown it. Most boards here are out
 * of date, and that is mostly harmless: a board that has fallen behind fails as
 * a *box* finding -- its anchor names a file or a symbol that is gone -- and a
 * claim gets no verdict at all when its ends do not resolve. The case that does
 * leak through is a file and a symbol that still exist with a changed signature,
 * which is genuine rot presenting as a red. It cannot be separated by machine,
 * so each red is printed with a count of the same board's staleness findings
 * beside it: a red on a board that is otherwise rotten is a different thing from
 * a red on a board that is otherwise clean.
 */

/** Findings that mean a claim was contradicted. */
const CLAIM_REDS = new Set(["backwards-edge", "signature-absent"]);

/** Box and board findings that mean a claim was contradicted. */
const CLAIM_BOX_REDS = new Set([
  "open-box",
  "incomplete-board",
  "missing-declaration",
  "unused-symbol",
]);

/** Findings that mean the board has fallen behind the code. Never a vocabulary gap. */
const STALE = new Set([
  "missing-file",
  "missing-symbol",
  "unresolvable-ref",
  "empty-ref",
  "generated-ref",
  "missing-route",
  "stale-number",
  "unsupported-member",
]);

interface Red {
  board: string;
  what: string;
  kind: string;
  claim?: string;
  label?: string;
  detail: string;
  /** How stale the rest of the board is, so a reader can weigh the red. */
  staleOnBoard: number;
}

/* ── B · what authors wrote when there was no word ──────────────────────────
 *
 * The prose on arrow labels with the `@` tokens removed, bucketed by the
 * relation it implies. The buckets are a judgement call, so every raw phrase is
 * printed under its bucket and the placement is arguable.
 *
 * The negative result matters as much as the positive one. Most arrow prose is
 * not a relation at all -- `covers`, `gate`, `after boot`, `per (path, method)`
 * are captions, domain narrative about what a step means, which is the thing a
 * diagram is for and the thing no vocabulary should try to swallow. That sets a
 * ceiling on how much of a board any claim vocabulary could ever cover, and it
 * kills the idea of deriving the relation set from what authors write.
 */
const BUCKETS: Array<[string, RegExp]> = [
  ["invokes", /\b(calls?|call|calling|invoke[sd]?|runs?|run|delegates?|dispatch(es)?|polls?|triggers?)\b/i],
  ["accesses", /\b(reads?|writes?|key|value|counted|drain(s|ed)?|fills?|stores?|looks? up|holds? state)\b/i],
  ["flows", /\b(passed to|pushes|pushed|feeds?|sends?|emits?|returns?|yields?|streams?)\b/i],
  ["constructs", /\b(builds?|constructs?|creates?|expands? to|makes?|instantiates?)\b/i],
  ["contains", /\b(owns?|contains?|has a|holds? a|field|member)\b/i],
  ["conforms", /\b(implements?|satisfies|conforms?|extends?|inherits?)\b/i],
  ["depends", /\b(imports?|requires?|needs?|depends? on|uses)\b/i],
];

/** Box labels wrap onto several lines on a canvas; a report line is one line. */
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/** A label with its claim tokens taken out, or nothing if that leaves nothing. */
function proseOf(label: string | undefined): string | undefined {
  if (!label) return undefined;
  const prose = label
    .replace(/@[A-Za-z][\w+-]*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return prose.length > 0 ? prose : undefined;
}

function bucketOf(prose: string): string {
  return BUCKETS.find(([, pattern]) => pattern.test(prose))?.[0] ?? "unclassified";
}

/* ── C · what the code actually says ────────────────────────────────────────
 *
 * Every relationship between named things, counted per language, so the
 * question "which relation deserves a word" has a number under it instead of an
 * intuition.
 *
 * ## Read natively, never off a precomputed graph
 *
 * The first draft of #190 answered this out of `graphify-out/graph.json` and was
 * wrong by two orders of magnitude: it read 8,167 `contains` edges as the
 * field-of-type relation, and `contains` there means one callable lexically
 * inside another. Counting a graph measures the graph. So this walks the syntax
 * tree, and a second unrelated reading checks it -- see the referee below.
 *
 * ## The generic rule, and the trap it exists to avoid
 *
 * `parse.ts` found that three facts hold in every grammar: a declaration is a
 * node with a `name` field, a function also has a `body`, a call has a
 * `function`. A fourth holds too, and it is the one #188 needs:
 *
 *     a field is a node with a `type` field, inside a type declaration's body
 *
 * Rust spells it `field_declaration`, TypeScript `property_signature`, Python an
 * `assignment` with a `type` inside a class block -- and Python names it through
 * `left` where the others use `name`, which `signature.ts` already handles. One
 * rule, three spellings, no per-language branch.
 *
 * That is worth stating because the alternative was measured and it fails
 * silently: a detector written for `field_declaration` alone reads **0 Python
 * fields**, prints a clean-looking table, and would have taken "the field
 * relation does not generalise" into a design decision. It happened twice
 * already -- once in the census written for #187, once in graphify, which has no
 * Python field extractor at all.
 *
 * ## Two denominators, because one of them flatters nothing
 *
 * "A quarter of what code says has a word for it" is counted against every
 * relationship the syntax shows, and that includes every `console.log` and every
 * `.map()`. None of those is a thing anybody draws as two boxes, and junk in the
 * total pushes the covered share *down*. So the share is a floor, not an
 * estimate, and both denominators are printed:
 *
 *   - **all** -- what the syntax shows. Good for ranking relations against each other.
 *   - **drawable** -- both ends named somewhere in the same tree, which is the
 *     only population an arrow could ever point at.
 *
 * ## Two tables, because two kinds of number are not comparable
 *
 * A relation read out of a **closed region** -- a signature, a field list, a
 * file's imports -- can be counted to a certainty, and can later be refuted,
 * because absence there is genuine absence. One read out of a **function body**
 * can be neither: a call reaches its target through dynamic dispatch, a
 * callback, a decorator or a macro, and no reader sees all of them. Printing
 * both in one table lets the rough number inherit the precise one's authority,
 * which is the same mistake as the graph count, one level up.
 */

/** A relation counted in a closed region: exact, and a candidate for refutation. */
const REFEREED = new Set(["contains", "accepts", "produces", "depends", "conforms"]);

interface Fact {
  relation: string;
  /** What kind of position the type was written in. The meaning lives here. */
  context: string;
  /** The name at the far end, for the drawable denominator. */
  target: string;
}

/** Node types that declare a type with a member list, in any of the four grammars. */
const TYPE_DECLARATION = /^(struct_item|enum_item|union_item|trait_item|interface_declaration|class_declaration|abstract_class_declaration|class_definition|object_type)$/;

/** A name a reader would recognise, wherever a grammar puts type names. */
const TYPE_NAME = /(type_identifier|primitive_type|predefined_type)$/;

/**
 * Every type name written inside a type expression.
 *
 * Generics are read through rather than around: a field typed `Vec<RouteInfo>`,
 * `Promise<Response>` or `list[Route]` holds the inner type in every ordinary
 * reading of a diagram, and a reader that took only the outermost name would
 * report the container and miss the thing being drawn.
 */
function typeNamesIn(node: Node): string[] {
  const names: string[] = [];
  const visit = (child: Node) => {
    /*
     * A built-in is not a leaf. TypeScript wraps `string` in a `predefined_type`
     * and Rust wraps `bool` in a `primitive_type`, each with the keyword as a
     * child, so a reader that only collected childless `identifier` nodes saw
     * neither -- and a field typed `string` yielded no name at all, which is a
     * third of the fields in a TypeScript interface. #169 hit this exact blind
     * spot in the signature reader; it is written down there too.
     */
    if (TYPE_NAME.test(child.type)) {
      names.push(child.text);
      return;
    }
    if (child.childCount === 0) {
      if (child.type === "identifier") names.push(child.text);
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

/** The name a declaration goes by, with Python's spelling included. */
const nameOf = (node: Node): string | undefined => {
  const name = node.childForFieldName("name") ?? node.childForFieldName("left");
  return name && name.childCount === 0 ? name.text : undefined;
};

/**
 * Everything one file says, as facts.
 *
 * `declared` comes back alongside because the drawable denominator needs to know
 * which names exist in this tree at all, and the same walk already visits every
 * declaration.
 */
function factsIn(source: string, language: Language): { facts: Fact[]; declared: string[]; sites: Map<string, number> } {
  const tree = parseSource(source, language);
  if (!tree) return { facts: [], declared: [], sites: new Map() };

  const facts: Fact[] = [];
  const declared: string[] = [];
  /*
   * How many *places* a relation was written, as against how many type names
   * those places mention.
   *
   * The two are not the same and the difference is not small: one field typed
   * `dict[str, list[Route]]` is one place and four names. The census wants
   * names, because an arrow points at a type. The referee reads lines of source,
   * so it counts places -- and comparing names against places made the first run
   * report ratios of 0.31 and 4.10 that meant nothing but the unit mismatch.
   */
  const sites = new Map<string, number>();
  const add = (relation: string, context: string, targets: string[]) => {
    if (targets.length > 0) sites.set(relation, (sites.get(relation) ?? 0) + 1);
    for (const target of targets) facts.push({ relation, context, target });
  };

  each(tree.rootNode, (node) => {
    if (!TYPE_DECLARATION.test(node.type)) return;

    /*
     * The fields of this type, read by walking down from its body rather than by
     * asking a member who its parent is.
     *
     * The first attempt did ask -- and `Node` here exposes no `parent`, so the
     * test was `undefined` on every node and the walk reported **0 fields in
     * every language** while the text referee found 12,428 in TypeScript alone.
     * That is precisely the failure the referee exists to catch, and it caught it
     * on the first run. A census that only agrees with itself would have printed
     * a clean table saying the field relation does not exist.
     *
     * The walk stops at anything with a `body` of its own. A method inside a
     * class body has typed parameters, and descending into it would count every
     * parameter as a field.
     */
    /*
     * The member list. Usually a `body`, except in TypeScript, where `type X = {
     * ... }` is an `object_type` that owns its members directly and carries no
     * `body` at all -- so the walk skipped 41 of them in `drift.ts` alone and
     * read TypeScript at a third of what the referee saw.
     */
    const body = node.type === "object_type" ? node : node.childForFieldName("body");
    if (body) {
      const fields = (member: Node, depth: number) => {
        if (depth > 0 && member.childForFieldName("body")) return;
        // An inline object type is its own container, and `each` reaches it on
        // its own. Descending here as well would count its members twice.
        if (depth > 0 && member.type === "object_type") return;
        const memberType = member.childForFieldName("type");
        if (depth > 0 && memberType) {
          add("contains", "field", typeNamesIn(memberType));
          return;
        }
        for (let index = 0; index < member.childCount; index += 1) {
          const child = member.child(index);
          if (child) fields(child, depth + 1);
        }
      };
      fields(body, 0);
    }
    // Python and TypeScript both name their parents on the declaration itself.
    const parents = node.childForFieldName("superclasses");
    if (parents) add("conforms", "inherits", typeNamesIn(parents));
    for (let index = 0; index < node.childCount; index += 1) {
      const child = node.child(index);
      if (child && (child.type === "class_heritage" || child.type === "implements_clause"
        || child.type === "extends_clause" || child.type === "extends_type_clause")) {
        add("conforms", "implements", typeNamesIn(child));
      }
    }
  });
  // Rust says it on the impl block instead: `impl Trait for Type`.
  each(tree.rootNode, (node) => {
    if (node.type !== "impl_item") return;
    const trait = node.childForFieldName("trait");
    if (trait) add("conforms", "implements", typeNamesIn(trait));
  });

  each(tree.rootNode, (node) => {
    const name = nameOf(node);
    if (name) declared.push(name);

    // Parameters and return types: the two relations `signature.ts` already reads.
    const parameters = node.childForFieldName("parameters");
    if (parameters) add("accepts", "parameter", typeNamesIn(parameters));
    const returns = node.childForFieldName("return_type");
    if (returns) add("produces", "return", typeNamesIn(returns));

    // A call is a node with a `function` field, in every grammar tried.
    const called = node.childForFieldName("function");
    if (called) {
      const target = called.childCount === 0 ? called.text : called.text.split(/[.:]/).pop() ?? "";
      if (target) add("invokes", "call", [target]);
    }

    // Imports, which is what `@needs` already claims.
    if (/^(import_statement|import_from_statement|use_declaration|import_declaration)$/.test(node.type)) {
      add("depends", "import", [node.text.replace(/\s+/g, " ").slice(0, 80)]);
    }

    /*
     * A routine touching a datum. Read from inside a body, so it is in the
     * ordering-only table and can only ever be a confirm-only word -- see the
     * `may accuse` column in #190's layer 2.
     */
    if (/^(field_expression|member_expression|attribute)$/.test(node.type)) {
      const field = node.childForFieldName("field") ?? node.childForFieldName("property")
        ?? node.childForFieldName("attribute");
      if (field && field.childCount === 0) add("accesses", "member", [field.text]);
    }

    /*
     * Making one of something.
     *
     * Three spellings, and the first census counted only the first two, which
     * read `constructs` at 0.3% of all code and made it look like a relation
     * nobody performs. The missing one is JSX: `<MenuContent />` is a component
     * making another component, it is the most common thing on any React board,
     * and half the arrows on the tsx board in `probe-generative.mts` are it.
     *
     * Counted here as one relation rather than as a separate `renders`, because
     * that is what it is -- `<MenuContent />` compiles to a call that makes a
     * MenuContent. A vocabulary meant to hold across languages should not carry
     * a word for one framework's spelling of a thing it already has.
     *
     * Python is still undercounted and there is no fixing it here: it constructs
     * by calling a class name, which is syntactically a call and lands in
     * `invokes`. Said rather than papered over.
     */
    if (node.type === "new_expression" || node.type === "struct_expression") {
      const constructed = node.childForFieldName("constructor") ?? node.childForFieldName("name");
      if (constructed) add("constructs", "new", typeNamesIn(constructed));
    }
    if (node.type === "jsx_opening_element" || node.type === "jsx_self_closing_element") {
      const element = node.childForFieldName("name");
      // A lowercase name is a host element -- `div`, `span` -- not a component
      // anybody draws a box for.
      if (element && /^[A-Z]/.test(element.text)) add("constructs", "element", [element.text]);
    }

    // Counted only so the decision to leave it out has a number under it.
    if (/^(type_arguments|type_parameter)$/.test(node.type)) {
      add("type-argument", "generic", typeNamesIn(node));
    }
  });

  return { facts, declared, sites };
}

/**
 * The referee: the same relations counted by reading the *text*.
 *
 * Deliberately a different mechanism from the syntax walk above, per
 * `measure-signature.mts`. Two unrelated readings agreeing says something; one
 * reading agreeing with itself says nothing, and this whole probe exists because
 * a count that agreed with itself got two orders of magnitude into an issue.
 *
 * It is not trying to match the walk exactly -- a regex over source will always
 * differ at the edges, and chasing that would just be writing a second parser.
 * It is trying to catch the one failure that matters here: **a relation a
 * language spells differently, which the walk reads as zero and prints as a
 * clean result.** A walk reporting 0 where the text scan reports thousands is
 * that bug, every time.
 */
const SCANS: Array<[string, Partial<Record<Language, RegExp>>]> = [
  ["contains", {
    rust: /^\s*(?:pub(?:\([^)]*\))?\s+)?[a-z_][\w]*\s*:\s*[^,;{}()]+,?\s*$/gm,
    /*
     * Ends in `;`, which is what separates a member of an interface or a class
     * from a key in an object literal. Without that clause this matched every
     * `{ key: value, }` in the tree and read 12,428 fields in TypeScript where
     * there are a few thousand -- a referee wrong in the loud direction, which
     * is worse than no referee.
     */
    ts: /^\s*(?:readonly\s+|public\s+|private\s+|protected\s+)*[\w$]+\??\s*:\s*[^;={}()]+;\s*$/gm,
    tsx: /^\s*(?:readonly\s+|public\s+|private\s+|protected\s+)*[\w$]+\??\s*:\s*[^;={}()]+;\s*$/gm,
    python: /^\s{4,}[a-z_][\w]*\s*:\s*[A-Za-z_][^\n=]*$/gm,
  }],
  ["produces", {
    rust: /->\s*[A-Za-z_]/g,
    ts: /\)\s*:\s*[A-Za-z_]/g,
    tsx: /\)\s*:\s*[A-Za-z_]/g,
    python: /->\s*[A-Za-z_"']/g,
  }],
  ["depends", {
    rust: /^\s*(?:pub\s+)?use\s+/gm,
    ts: /^\s*(?:import|export)\s.*\sfrom\s|^\s*import\s+["']/gm,
    tsx: /^\s*(?:import|export)\s.*\sfrom\s|^\s*import\s+["']/gm,
    python: /^\s*(?:import\s+\w|from\s+[\w.]+\s+import)/gm,
    js: /^\s*(?:import|export)\s.*\sfrom\s|require\s*\(/gm,
  }],
];

function refereeCounts(source: string, language: Language): Map<string, number> {
  const counts = new Map<string, number>();
  for (const [relation, byLanguage] of SCANS) {
    const pattern = byLanguage[language];
    if (!pattern) continue;
    counts.set(relation, (source.match(pattern) ?? []).length);
  }
  return counts;
}

/* ── the run ────────────────────────────────────────────────────────────── */

await initEngine();

const boards = BOARD_ROOTS.flatMap((root) => {
  const found = boardsUnder(root);
  if (found.length === 0) console.log(`  (no boards under ${root} -- skipped)`);
  return found;
});

const reds: Red[] = [];
const prose = new Map<string, Map<string, number>>();
const claimCounts = new Map<string, number>();

let arrowsTotal = 0;
let arrowsClaimed = 0;
let arrowsLabelled = 0;
let arrowsWithProse = 0;
let boardsRead = 0;
let boardsChecked = 0;
let boardsUnreadable = 0;
let staleTotal = 0;
let boxesChecked = 0;
let boxesSkipped = 0;
let edgesChecked = 0;
let edgesSkipped = 0;
let conceptBoards = 0;
let conceptArrows = 0;

for (const file of boards) {
  let board;
  try {
    board = await readBoard(file);
  } catch {
    boardsUnreadable += 1;
    continue;
  }
  boardsRead += 1;

  // ── B, which needs no repository and so runs on every board.
  const graph = readGraph(board);
  /*
   * A board that describes a protocol rather than this repository is counted
   * apart, and the reason is that lumping the two together overstates the very
   * thing this probe is measuring. The IMS and VoLTE boards here carry `REGISTER`,
   * `INVITE`, `ISUP`, `LTE-Uu` -- every one a caption, every one *necessarily* a
   * caption, because no arrow on a board about a telecom standard could ever
   * carry a claim about code in this tree. Counting them makes the caption share
   * look like a fact about vocabulary when it is a fact about the corpus.
   */
  const concept = graph.describes === "concept";
  if (concept) conceptBoards += 1;
  for (const edge of graph.edges) {
    arrowsTotal += 1;
    if (concept) conceptArrows += 1;
    if (edge.claim) {
      arrowsClaimed += 1;
      claimCounts.set(edge.claim, (claimCounts.get(edge.claim) ?? 0) + 1);
    }
    if (edge.label && edge.label.trim().length > 0) arrowsLabelled += 1;
    const text = proseOf(edge.label);
    if (!text) continue;
    if (concept) continue;
    arrowsWithProse += 1;
    const bucket = bucketOf(text);
    const phrases = prose.get(bucket) ?? new Map<string, number>();
    phrases.set(text, (phrases.get(text) ?? 0) + 1);
    prose.set(bucket, phrases);
  }

  // ── A, which needs the tree the board's refs resolve against.
  const root = repositoryOf(file);
  if (!root) continue;
  let report;
  try {
    report = checkDrift(board, createWorkspace(root), { edges: true });
  } catch {
    continue;
  }
  boardsChecked += 1;
  /*
   * Reported because a checker that skipped everything also finds nothing, and
   * the two are indistinguishable from a clean report. `0 staleness findings`
   * means something only next to the number of boxes and arrows that were
   * actually read.
   */
  boxesChecked += report.checked;
  boxesSkipped += report.skipped;
  edgesChecked += report.edgesChecked;
  edgesSkipped += report.edgesSkipped;

  const stale = report.findings.filter((finding: DriftFinding) => STALE.has(finding.kind)).length;
  staleTotal += stale;
  const shown = path.relative(HOME, file);

  for (const finding of report.edges as EdgeDriftFinding[]) {
    if (!CLAIM_REDS.has(finding.kind)) continue;
    // `node` is `fromId -> toId`, the arrow as the canvas knows it.
    const [fromId, toId] = finding.node.split(" -> ");
    const edge = graph.edges.find((candidate) => candidate.from === fromId && candidate.to === toId);
    reds.push({
      board: shown,
      what: `${oneLine(finding.fromLabel)} -> ${oneLine(finding.toLabel)}`,
      kind: finding.kind,
      claim: edge?.claim,
      label: edge?.label ? oneLine(edge.label) : undefined,
      detail: finding.detail,
      staleOnBoard: stale,
    });
  }
  for (const finding of report.findings as DriftFinding[]) {
    if (!CLAIM_BOX_REDS.has(finding.kind)) continue;
    reds.push({
      board: shown,
      what: oneLine(finding.label),
      kind: finding.kind,
      label: finding.ref,
      detail: finding.detail,
      staleOnBoard: stale,
    });
  }
}

/* ── the report ─────────────────────────────────────────────────────────── */

const percent = (part: number, whole: number) =>
  whole === 0 ? "  n/a" : `${((part / whole) * 100).toFixed(1)}%`.padStart(6);

console.log();
console.log("CORPUS");
for (const file of boards) console.log(`  ${path.relative(HOME, file)}`);
console.log();
console.log(`  ${boardsRead} boards read, ${boardsChecked} checked against a repository`
  + (boardsUnreadable > 0 ? `, ${boardsUnreadable} unreadable` : ""));
console.log(`  ${arrowsTotal} arrows, ${arrowsLabelled} labelled, ${arrowsClaimed} carrying a claim`
  + ` (${percent(arrowsClaimed, arrowsTotal)} of all, ${percent(arrowsClaimed, arrowsLabelled)} of labelled)`);
console.log(`  ${boxesChecked} boxes read (${boxesSkipped} skipped),`
  + ` ${edgesChecked} arrows read (${edgesSkipped} skipped)`);
console.log(`  ${staleTotal} staleness findings across the corpus`);
if (claimCounts.size > 0) {
  console.log(`  claims written: ${[...claimCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([word, count]) => `@${word} ${count}`)
    .join(", ")}`);
}

console.log();
console.log("A · FAILED CLAIMS -- every claim the checker calls wrong today");
console.log("  A red on a diagram its author believes is correct is a missing word.");
console.log("  Which of the two it is cannot be decided here; the sort is a human read.");
console.log();
if (reds.length === 0) {
  console.log("  none.");
} else {
  for (const red of reds) {
    console.log(`  ${red.board}`);
    console.log(`      ${red.what}`);
    console.log(`      ${red.kind}${red.claim ? ` · @${red.claim}` : ""}`
      + `${red.label ? ` · label "${red.label}"` : ""}`);
    console.log(`      ${red.detail}`);
    console.log(`      (${red.staleOnBoard} staleness findings on this board -- `
      + `${red.staleOnBoard === 0 ? "the board is otherwise current" : "weigh the red against that"})`);
    console.log();
  }
}
console.log(`  ${reds.length} failed claims across ${boardsChecked} boards.`);

console.log();
console.log("B · ARROW PROSE -- what was written where a word was missing");
console.log("  Buckets are a judgement call, so every raw phrase is printed under its bucket.");
console.log(`  ${arrowsWithProse} arrows on code boards carry prose beyond their claim.`);
console.log(`  ${conceptArrows} arrows on ${conceptBoards} concept boards are left out: a board about a`);
console.log("  protocol can carry no claim about this code, so its labels are captions by construction.");
console.log();

const buckets = [...prose.entries()]
  .map(([name, phrases]) => ({
    name,
    arrows: [...phrases.values()].reduce((sum, count) => sum + count, 0),
    phrases: [...phrases.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
  }))
  .sort((a, b) => (a.name === "unclassified" ? -1 : b.name === "unclassified" ? 1 : b.arrows - a.arrows));

for (const bucket of buckets) {
  console.log(`  ${bucket.name.padEnd(14)} ${String(bucket.arrows).padStart(4)} arrows`);
  const shown = bucket.phrases.slice(0, 24);
  for (const [phrase, count] of shown) {
    console.log(`      ${count > 1 ? `${count}x ` : "   "}${phrase}`);
  }
  if (bucket.phrases.length > shown.length) {
    console.log(`      ... ${bucket.phrases.length - shown.length} more distinct phrases`);
  }
  console.log();
}

const unclassified = buckets.find((bucket) => bucket.name === "unclassified")?.arrows ?? 0;
console.log(`  ${unclassified} of ${arrowsWithProse} phrases (${percent(unclassified, arrowsWithProse)})`
  + " are not a relation at all -- captions, which no vocabulary should swallow.");
console.log();

/* ── C · the relation census ────────────────────────────────────────────── */

/**
 * The trees the census reads.
 *
 * Taken as they sit on disk rather than pinned by commit, the way
 * `measure-survey.mts` takes its scopes: these are dormant checkouts, not moving
 * targets, and a scope that is not there is skipped and said to be skipped. If
 * one of them starts moving again, pin it the way `licence.ts` pins its corpus.
 *
 * Four languages throughout, never one. A single-language corpus produces
 * confident wrong answers here specifically -- see the Python field spelling
 * above, which read 0 and looked clean.
 */
const CODE_ROOTS: Array<{ name: string; path: string }> = [
  { name: "board-ai/src", path: path.resolve("src") },
  { name: "board-ai/scripts", path: path.resolve("scripts") },
  { name: "rust-test", path: existsSync(path.resolve("rust-test")) ? path.resolve("rust-test") : `${HOME}/board-ai/rust-test` },
  { name: "orangutan", path: `${HOME}/orangutan` },
  { name: "mundane", path: `${HOME}/mundane` },
  { name: "infrarouter", path: `${HOME}/infrarouter` },
];

const SKIP_SOURCE = ["/node_modules/", "/target/", "/.git/", "/dist/", "/out/", "/vendor/", "/.venv/"];

function sourcesUnder(root: string): string[] {
  if (!existsSync(root)) return [];
  try {
    return execFileSync("find", [root, "-type", "f"], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .filter((file) => !SKIP_SOURCE.some((fragment) => file.includes(fragment)))
      .filter((file) => languageOf(file) !== undefined);
  } catch {
    return [];
  }
}

interface Tally {
  /** By (relation, context, language). */
  counted: Map<string, number>;
  /** The same, restricted to relationships whose far end is declared in the tree. */
  drawable: Map<string, number>;
  byLanguage: Map<Language, number>;
  walk: Map<string, number>;
  referee: Map<string, number>;
  files: Map<Language, number>;
  unreadable: number;
}

const tally: Tally = {
  counted: new Map(),
  drawable: new Map(),
  byLanguage: new Map(),
  walk: new Map(),
  referee: new Map(),
  files: new Map(),
  unreadable: 0,
};

const bump = (map: Map<string, number>, key: string, by = 1) =>
  map.set(key, (map.get(key) ?? 0) + by);

const scopesRead: string[] = [];
for (const scope of CODE_ROOTS) {
  const files = sourcesUnder(scope.path);
  if (files.length === 0) {
    scopesRead.push(`${scope.name}: not on disk, skipped`);
    continue;
  }
  scopesRead.push(`${scope.name}: ${files.length} files`);

  /*
   * Two passes, because the drawable denominator asks whether the far end is
   * declared *anywhere in this tree*, which is not knowable while reading the
   * first file. Same walk both times; only the question changes.
   */
  const parsed: Array<{ language: Language; facts: Fact[] }> = [];
  const declared = new Set<string>();
  for (const file of files) {
    const language = languageOf(file)!;
    let source: string;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      tally.unreadable += 1;
      continue;
    }
    const read = factsIn(source, language);
    if (read.facts.length === 0 && read.declared.length === 0) tally.unreadable += 1;
    for (const name of read.declared) declared.add(name);
    parsed.push({ language, facts: read.facts });
    for (const [relation, count] of read.sites) bump(tally.walk, `${relation}|${language}`, count);
    tally.files.set(language, (tally.files.get(language) ?? 0) + 1);
    for (const [relation, count] of refereeCounts(source, language)) {
      bump(tally.referee, `${relation}|${language}`, count);
    }
  }

  for (const { language, facts } of parsed) {
    for (const fact of facts) {
      bump(tally.counted, `${fact.relation}|${fact.context}|${language}`);
      tally.byLanguage.set(language, (tally.byLanguage.get(language) ?? 0) + 1);
      /*
       * `depends` is exempt: an import names a module, never a symbol declared
       * in this tree, so asking whether its far end is declared here answers no
       * every time and reads as "no import is drawable", which is false -- every
       * `@needs` arrow on every board is exactly this relation.
       */
      if (fact.relation === "depends" || declared.has(fact.target)) {
        bump(tally.drawable, `${fact.relation}|${fact.context}|${language}`);
      }
    }
  }
}

const LANGUAGES: Language[] = ["rust", "ts", "tsx", "python", "js"];

/** Which relation each of the six words already claims. */
const WORD_FOR: Record<string, string> = {
  depends: "@needs",
  accepts: "@takes",
  produces: "@returns",
};

function rows(source: Map<string, number>) {
  const byRelation = new Map<string, Map<Language, number>>();
  for (const [key, count] of source) {
    const [relation, context, language] = key.split("|") as [string, string, Language];
    const name = `${relation}/${context}`;
    const languages = byRelation.get(name) ?? new Map<Language, number>();
    languages.set(language, (languages.get(language) ?? 0) + count);
    byRelation.set(name, languages);
  }
  return [...byRelation.entries()]
    .map(([name, languages]) => ({
      name,
      relation: name.split("/")[0],
      languages,
      total: [...languages.values()].reduce((sum, count) => sum + count, 0),
    }))
    .sort((a, b) => b.total - a.total);
}

function table(title: string, only: (relation: string) => boolean) {
  const all = rows(tally.counted).filter((row) => only(row.relation));
  const drawable = new Map(rows(tally.drawable).map((row) => [row.name, row]));
  const total = all.reduce((sum, row) => sum + row.total, 0);
  const drawableTotal = all.reduce((sum, row) => sum + (drawable.get(row.name)?.total ?? 0), 0);

  console.log(`  ${title}`);
  console.log("    " + "relation / context".padEnd(24)
    + LANGUAGES.map((language) => language.padStart(9)).join("")
    + "all".padStart(10) + "drawable".padStart(10) + "  word");
  for (const row of all) {
    console.log("    " + row.name.padEnd(24)
      + LANGUAGES.map((language) => String(row.languages.get(language) ?? 0).padStart(9)).join("")
      + String(row.total).padStart(10)
      + String(drawable.get(row.name)?.total ?? 0).padStart(10)
      + "  " + (WORD_FOR[row.relation] ?? "—"));
  }
  console.log("    " + "total".padEnd(24) + " ".repeat(9 * LANGUAGES.length)
    + String(total).padStart(10) + String(drawableTotal).padStart(10));
  console.log();
  return { total, drawableTotal, rows: all };
}

console.log();
console.log("C · RELATION CENSUS -- what the code actually says");
for (const line of scopesRead) console.log(`  ${line}`);
console.log(`  ${[...tally.files.entries()].map(([language, count]) => `${language} ${count}`).join(", ")}`
  + ` files parsed${tally.unreadable > 0 ? `, ${tally.unreadable} unreadable` : ""}`);
console.log();

const refereed = table(
  "REFEREED -- read from a closed region, countable exactly, refutable in principle",
  (relation) => REFEREED.has(relation),
);
const ordering = table(
  "ORDERING-ONLY -- read from a function body, which nobody can count exactly",
  (relation) => !REFEREED.has(relation),
);

console.log("  COVERAGE -- how much of what the code says has a word for it");
const claimed = (result: ReturnType<typeof table>) => result.rows
  .filter((row) => WORD_FOR[row.relation])
  .reduce((sum, row) => sum + row.total, 0);
const claimedAll = claimed(refereed) + claimed(ordering);
const grandTotal = refereed.total + ordering.total;
const grandDrawable = refereed.drawableTotal + ordering.drawableTotal;
const claimedDrawable = [...rows(tally.drawable)]
  .filter((row) => WORD_FOR[row.relation])
  .reduce((sum, row) => sum + row.total, 0);
console.log(`    against everything the syntax shows: ${percent(claimedAll, grandTotal)}`
  + `  (${claimedAll} of ${grandTotal})`);
console.log(`    against what a diagram could draw:   ${percent(claimedDrawable, grandDrawable)}`
  + `  (${claimedDrawable} of ${grandDrawable})`);
console.log("    The first counts every console.log and .map(). It is a floor, not an estimate.");
console.log("    Type names inside a generic are counted in the position they appear AND under");
console.log("    type-argument, so the two overlap. Said rather than netted off: which of the two");
console.log("    a `Vec<Route>` field is depends on what an arrow would be drawn to mean.");
console.log();

console.log("  REFEREE -- the same relations counted by reading the text, not the tree");
console.log("    Not expected to match: a regex and a parser always differ at the edges.");
console.log("    What it is looking for is a walk reading 0 where the text reads thousands,");
console.log("    which is a language whose spelling the walk does not know.");
console.log();
console.log("    " + "relation".padEnd(14) + "language".padEnd(10)
  + "walk".padStart(10) + "referee".padStart(10) + "  verdict");
for (const [relation] of SCANS) {
  for (const language of LANGUAGES) {
    const referee = tally.referee.get(`${relation}|${language}`) ?? 0;
    const walk = tally.walk.get(`${relation}|${language}`) ?? 0;
    if (referee === 0 && walk === 0) continue;
    const verdict = walk === 0 && referee > 0
      ? "BLIND -- the walk does not know this language's spelling"
      : referee === 0
        ? "no referee for this language"
        : `ratio ${(walk / referee).toFixed(2)}`;
    console.log("    " + relation.padEnd(14) + language.padEnd(10)
      + String(walk).padStart(10) + String(referee).padStart(10) + "  " + verdict);
  }
}
console.log();
