/**
 * What each claim is *documented* to say about each shape, in three languages.
 *
 * The expectations here are transcribed from `skills/diagram/SKILL.md` and the
 * licence grid in `docs/claim-vocabulary.md`. They are not read off the reader:
 * a fixture whose expected verdict came from running the checker proves only
 * that the checker is self-consistent (#298).
 *
 * `open` marks a square the documentation does not settle. Those are carried
 * into the report rather than guessed at, and the runner does not fail on them.
 */
import type { GraphNode } from "../src/engine/layout";
import type { ArrowClaim } from "../src/engine/claim";

/**
 * The four shapes #298 asks for, the fifth where it applies, and two the
 * documentation makes a specific promise about.
 *
 * `wrong-half` is `takes`/`returns` with the type in the other half of the
 * signature; SKILL.md promises that is neither a red nor a silence but a row
 * saying the arrow may be the wrong way round. `generic-wrapper` is `holds`
 * through a `Vec<T>`, which SKILL.md promises confirms.
 */
export type Shape =
  | "plainly-true"
  | "true-but-hidden"
  | "false-and-provable"
  | "false-and-unprovable"
  | "wrong-kind-of-end"
  | "wrong-half"
  | "generic-wrapper"
  /** The alias is declared in the same file as the signature, not imported. */
  | "alias-in-file";

/**
 * What a user sees for one arrow. `red` is the accusing half of a report;
 * `not-verified` covers every way an arrow can come back neither proved nor
 * accused -- unconfirmed, unread, or carrying an advisory finding.
 */
export type Verdict = "confirmed" | "red" | "not-verified";

export type Language = "rust" | "python" | "typescript";

export interface FixtureEdge {
  shape: Shape;
  from: string;
  to: string;
  label?: string;
  expect: Verdict;
  /** Where the expectation comes from, in the documentation. */
  because: string;
  /** Set when the documentation does not say. The runner never fails on these. */
  open?: string;
}

export interface Fixture {
  claim: ArrowClaim;
  language: Language;
  /** Repo-relative fixture directory; the board lives in it as `board.excalidraw`. */
  dir: string;
  nodes: GraphNode[];
  edges: FixtureEdge[];
}

export const BOARD_FILE = "board.excalidraw";

const NEEDS_DOC =
  "SKILL.md: `needs` refutes from the presence of the opposite import; it withholds "
  + "where it cannot see enough to refute.";


/** Where the same fixture tree is written three times, this is the only difference. */
interface Dialect {
  language: Language;
  /** The file holding the types. */
  model: string;
  /** The file holding the routines. */
  api: string;
  /** `handle_alias` in snake_case languages, `handleAlias` in TypeScript. */
  name: (snake: string) => string;
}

const DIALECTS: Dialect[] = [
  { language: "rust", model: "src/model.rs", api: "src/api.rs", name: (snake) => snake },
  { language: "python", model: "model.py", api: "api.py", name: (snake) => snake },
  {
    language: "typescript",
    model: "model.ts",
    api: "api.ts",
    name: (snake) => snake.replace(/_(.)/g, (_, letter: string) => letter.toUpperCase()),
  },
];

const SIGNATURE_DOC =
  "SKILL.md: a function's parameters and return type can be listed in full, so a type "
  + "absent from both is genuinely absent; nothing is reported when the type could be "
  + "written under another name.";

const WRONG_KIND_DOC =
  "claims.md: each claim needs a kind of thing at each end, and the wrong kind is red. "
  + "A type has no parameters, so an arrow whose head is one is a claim nothing can read "
  + "rather than one the code disagrees with -- #297 made it red and #303 wrote it down. "
  + "Python reaches the same verdict by a different sentence: a class has an `__init__` "
  + "with a signature, and the signature reader answers before the end's kind is asked "
  + "about.";

function signatureFixture(claim: "takes" | "returns", dialect: Dialect): Fixture {
  const dir = `bench/fixtures/${claim}/${dialect.language}`;
  const api = (snake: string) => `${dir}/${dialect.api}#${dialect.name(snake)}`;
  const right = claim === "takes" ? "handle" : "produce";
  const alias = claim === "takes" ? "handle_alias" : "produce_alias";
  const opaque = claim === "takes" ? "handle_opaque" : "produce_opaque";
  const other = claim === "takes" ? "produce" : "handle";
  const local = claim === "takes" ? "handle_local_alias" : "produce_local_alias";
  return {
    claim,
    language: dialect.language,
    dir,
    nodes: [
      { id: "request", label: "Request", ref: `${dir}/${dialect.model}#Request` },
      { id: "response", label: "Response", ref: `${dir}/${dialect.model}#Response` },
      { id: "right", label: right, ref: api(right) },
      { id: "alias", label: alias, ref: api(alias) },
      { id: "count", label: "count", ref: api("count") },
      { id: "opaque", label: opaque, ref: api(opaque) },
      { id: "other", label: other, ref: api(other) },
      { id: "local", label: local, ref: api(local) },
    ],
    edges: [
      {
        shape: "plainly-true", from: "request", to: "right",
        expect: "confirmed", because: SIGNATURE_DOC,
      },
      {
        shape: "true-but-hidden", from: "request", to: "alias",
        expect: "not-verified",
        because: SIGNATURE_DOC + " The type is there, spelled as an alias.",
      },
      {
        shape: "false-and-provable", from: "request", to: "count",
        expect: "red", because: SIGNATURE_DOC + " The signature names nothing but numbers.",
      },
      {
        shape: "false-and-unprovable", from: "request", to: "opaque",
        expect: "not-verified",
        because: SIGNATURE_DOC + " A renamed import in the file could be hiding it.",
      },
      {
        shape: "alias-in-file", from: "request", to: "local",
        expect: "not-verified",
        because: SIGNATURE_DOC + " The alias is declared beside the signature.",
      },
      {
        shape: "wrong-half", from: "request", to: "other",
        expect: "not-verified",
        because: "SKILL.md: claim the wrong half and you are told the type is on the other "
          + "side, which is not a red.",
      },
      {
        shape: "wrong-kind-of-end", from: "request", to: "response",
        expect: "red", because: WRONG_KIND_DOC,
      },
    ],
  };
}


const HOLDS_DOC =
  "SKILL.md: a type's fields can be listed in full, so a type absent from all of them is "
  + "genuinely absent; nothing is reported when a field's type could be written under "
  + "another name.";

const HOLDS_FILES: Record<Language, { model: string; holder: string }> = {
  rust: { model: "src/model.rs", holder: "src/holder.rs" },
  python: { model: "model.py", holder: "holder.py" },
  typescript: { model: "model.ts", holder: "holder.ts" },
};

function holdsFixture(language: Language): Fixture {
  const dir = `bench/fixtures/holds/${language}`;
  const files = HOLDS_FILES[language];
  const held = (name: string) => `${dir}/${files.holder}#${name}`;
  return {
    claim: "holds",
    language,
    dir,
    nodes: [
      { id: "request", label: "Request", ref: `${dir}/${files.model}#Request` },
      { id: "config", label: "Config", ref: held("Config") },
      { id: "wrapper", label: "Wrapper", ref: held("Wrapper") },
      { id: "aliased", label: "Aliased", ref: held("Aliased") },
      { id: "localAliased", label: "LocalAliased", ref: held("LocalAliased") },
      { id: "empty", label: "Empty", ref: held("Empty") },
      { id: "opaque", label: "Opaque", ref: held("Opaque") },
    ],
    edges: [
      { shape: "plainly-true", from: "config", to: "request", expect: "confirmed", because: HOLDS_DOC },
      {
        shape: "generic-wrapper", from: "wrapper", to: "request", expect: "confirmed",
        because: "SKILL.md: `Vec<RouteInfo>`, `Promise<Response>`, `list[Route]`, `Client[]` all confirm.",
      },
      {
        shape: "true-but-hidden", from: "aliased", to: "request", expect: "not-verified",
        because: HOLDS_DOC + " The type is there, imported under an alias.",
      },
      {
        shape: "alias-in-file", from: "localAliased", to: "request", expect: "not-verified",
        because: HOLDS_DOC + " The alias is declared beside the field list.",
      },
      {
        shape: "false-and-provable", from: "empty", to: "request", expect: "red",
        because: HOLDS_DOC + " The field list names nothing but a number.",
      },
      {
        shape: "false-and-unprovable", from: "opaque", to: "request", expect: "not-verified",
        because: HOLDS_DOC + " A renamed import in the file could be hiding it.",
      },
      {
        shape: "wrong-kind-of-end", from: "config", to: "wrapper", expect: "not-verified",
        open: "SKILL.md says both ends of a `holds` arrow must name a type, and does not say "
          + "what happens when the `to` end names a type that is nowhere in the `from` end's "
          + "fields *and* is itself a container of the right thing. Recorded as a question.",
        because: "nothing documented",
      },
    ],
  };
}


const BUILDS_FILES: Record<Language, { model: string; make: string }> = {
  rust: { model: "src/model.rs", make: "src/make.rs" },
  python: { model: "model.py", make: "make.py" },
  typescript: { model: "model.ts", make: "make.ts" },
};

function buildsFixture(dialect: Dialect): Fixture {
  const language = dialect.language;
  const dir = `bench/fixtures/builds/${language}`;
  const files = BUILDS_FILES[language];
  const made = (snake: string) => `${dir}/${files.make}#${dialect.name(snake)}`;
  /*
   * SKILL.md: "Python gets no verdict at all, in either direction" -- so the
   * backwards arrow that is red in Rust and TypeScript is silent there.
   */
  const backwards: Verdict = language === "python" ? "not-verified" : "red";
  return {
    claim: "builds",
    language,
    dir,
    nodes: [
      { id: "request", label: "Request", ref: `${dir}/${files.model}#Request` },
      { id: "build", label: "build", ref: made("build") },
      { id: "viaFactory", label: "build via factory", ref: made("build_via_factory") },
      { id: "unrelated", label: "unrelated", ref: made("unrelated") },
    ],
    edges: [
      {
        shape: "plainly-true", from: "build", to: "request", expect: "confirmed",
        because: "SKILL.md: finding the construction is evidence the arrow is right.",
      },
      {
        shape: "true-but-hidden", from: "viaFactory", to: "request", expect: "not-verified",
        because: "SKILL.md: a routine that never writes `new Widget` can still hand you one "
          + "by calling a factory, so not finding the construction says nothing.",
      },
      {
        shape: "false-and-provable", from: "request", to: "build", expect: backwards,
        because: language === "python"
          ? "SKILL.md: Python gets no verdict at all from `@builds`, in either direction."
          : "SKILL.md: if the construction is found at the far end and only there, the arrow "
            + "is drawn backwards and you get told, with a file and a line.",
      },
      {
        shape: "false-and-unprovable", from: "unrelated", to: "request", expect: "not-verified",
        because: "SKILL.md: `@builds` cannot be red for an absence, and that is deliberate.",
      },
      {
        shape: "wrong-kind-of-end", from: "build", to: "unrelated", expect: "not-verified",
        open: "SKILL.md says the `to` end of a `builds` arrow is what comes out, and does not "
          + "say what happens when it names a routine instead of a type.",
        because: "nothing documented",
      },
    ],
  };
}

const CALLS_FILE: Record<Language, string> = {
  rust: "src/run.rs",
  python: "run.py",
  typescript: "run.ts",
};

function callsFixture(dialect: Dialect): Fixture {
  const language = dialect.language;
  const dir = `bench/fixtures/calls/${language}`;
  const at = (snake: string) => `${dir}/${CALLS_FILE[language]}#${dialect.name(snake)}`;
  return {
    claim: "calls",
    language,
    dir,
    nodes: [
      { id: "render", label: "render", ref: at("render") },
      { id: "run", label: "run", ref: at("run") },
      { id: "viaCallback", label: "run via callback", ref: at("run_via_callback") },
      { id: "unrelated", label: "unrelated", ref: at("unrelated") },
      { id: "config", label: "Config", ref: `${dir}/${CALLS_FILE[language]}#Config` },
    ],
    edges: [
      {
        shape: "plainly-true", from: "run", to: "render", expect: "confirmed",
        because: "SKILL.md: the `from` end is the caller, and the call is in its body.",
      },
      {
        shape: "true-but-hidden", from: "viaCallback", to: "render", expect: "not-verified",
        because: "SKILL.md: a routine can reach another through a callback, a trait object or "
          + "a dispatch table, so not finding the call says nothing about the arrow.",
      },
      {
        shape: "false-and-provable", from: "render", to: "run", expect: "red",
        because: "SKILL.md: if the call is found at the far end and only there, the arrow is "
          + "drawn backwards and you get told, with a file and a line.",
      },
      {
        shape: "false-and-unprovable", from: "unrelated", to: "render", expect: "not-verified",
        because: "SKILL.md: `@calls` cannot be red for an absence.",
      },
      {
        shape: "wrong-kind-of-end", from: "run", to: "config", expect: "not-verified",
        because: "SKILL.md: an arrow into a symbol standing for data comes back unconfirmed, "
          + "and it is information, never a refusal.",
      },
    ],
  };
}


const ACCESSES_FILES: Record<Language, { model: string; helper: string; reader: string }> = {
  rust: { model: "src/model.rs", helper: "src/helper.rs", reader: "src/reader.rs" },
  python: { model: "model.py", helper: "helper.py", reader: "reader.py" },
  typescript: { model: "model.ts", helper: "helper.ts", reader: "reader.ts" },
};

function accessesFixture(dialect: Dialect): Fixture {
  const language = dialect.language;
  const dir = `bench/fixtures/accesses/${language}`;
  const files = ACCESSES_FILES[language];
  const at = (snake: string) => `${dir}/${files.reader}#${dialect.name(snake)}`;
  return {
    claim: "accesses",
    language,
    dir,
    nodes: [
      { id: "config", label: "Config", ref: `${dir}/${files.model}#Config` },
      { id: "draw", label: "draw", ref: at("draw") },
      { id: "viaHelper", label: "draw via helper", ref: at("draw_via_helper") },
      { id: "unrelated", label: "unrelated", ref: at("unrelated") },
      { id: "measure", label: "measure", ref: at("measure") },
    ],
    edges: [
      {
        shape: "plainly-true", from: "draw", to: "config", label: "width", expect: "confirmed",
        because: "SKILL.md: a green needs both halves -- the type declares it and the routine "
          + "can be seen reading it. Both hold here.",
      },
      {
        shape: "true-but-hidden", from: "viaHelper", to: "config", label: "width", expect: "not-verified",
        because: "SKILL.md: \"a function the routine calls that visibly reads the member keeps it "
          + "quiet: draw --calls--> paint --accesses--> Config is the right board, and draw "
          + "--accesses--> Config is that board drawn one level too high rather than wrong.\"",
      },
      {
        // A separate `from` box (`measure`, not `draw`) so this arrow's node
        // pair does not collide with the plainly-true one above -- two
        // findings can share a `from -> to` pair internally, but this
        // runner's lookup (bench-claims.mts) cannot tell them apart, only the
        // engine can.
        shape: "false-and-provable", from: "measure", to: "config", label: "depth", expect: "red",
        because: "SKILL.md: the type end can come back red -- a type's members can be listed in "
          + "full, so a member absent from all of them is genuinely absent.",
      },
      {
        shape: "false-and-unprovable", from: "unrelated", to: "config", label: "width", expect: "not-verified",
        because: "SKILL.md: it can never come back red about the routine -- not seeing a body "
          + "read `width` is not evidence it does not.",
      },
    ],
  };
}

const CONFORMS_FILES: Record<Language, { local: string; hidden: string; unprovable: string; wrongEnd?: string }> = {
  rust: { local: "src/types.rs", hidden: "src/types.rs", unprovable: "src/types.rs" },
  python: { local: "model.py", hidden: "aliased.py", unprovable: "computed.py" },
  typescript: { local: "model.ts", hidden: "aliased.ts", unprovable: "computed.ts", wrongEnd: "model.ts" },
};

const CONFORMS_DOC =
  "SKILL.md: a base list is written in the declaration and can be read in full, so a type "
  + "absent from it is genuinely absent -- except in Rust, where `impl Trait for Type` may sit "
  + "anywhere in the crate, so an absence is a fact about where the reader looked rather than "
  + "about the type.";

function conformsFixture(language: Language): Fixture {
  const dir = `bench/fixtures/conforms/${language}`;
  const files = CONFORMS_FILES[language];
  const neverRed: Verdict = language === "rust" ? "not-verified" : "red";
  const edges: FixtureEdge[] = [
    {
      shape: "plainly-true", from: "local", to: "base", expect: "confirmed",
      because: language === "rust"
        ? CONFORMS_DOC + " `impl Handler for Local` is in Local's own file."
        : CONFORMS_DOC,
    },
    {
      shape: "true-but-hidden", from: "hidden", to: "base", expect: "not-verified",
      because: language === "rust"
        ? "SKILL.md: `impl Handler for Remote` is real and true, and lives in another file -- "
          + "the reader only reads the `from` end's own file, so a genuinely true impl declared "
          + "elsewhere never confirms."
        : "SKILL.md: \"nothing is reported either way when a base could stand for another "
          + "name (`import { Base as B }`)\".",
    },
    {
      shape: "false-and-provable", from: language === "rust" ? "never" : "neverExtends", to: "base",
      expect: neverRed,
      because: language === "rust"
        ? "SKILL.md: \"It can never come back red in Rust\" -- an absence is a fact about "
          + "where the reader looked."
        : CONFORMS_DOC,
    },
  ];
  if (language !== "rust") {
    edges.push({
      shape: "false-and-unprovable", from: "computed", to: "base", expect: "not-verified",
      because: "SKILL.md: \"an expression rather than a name (`extends mixin(B)`)\" is one of "
        + "the two things this word cannot read at all.",
    });
  }
  if (language === "typescript") {
    edges.push({
      shape: "wrong-kind-of-end", from: "handle", to: "base", expect: "not-verified",
      because: "SKILL.md: \"structural conformance is not on offer... an arrow from or at a "
        + "function is reported as a claim nothing can read, not as one that passed.\"",
    });
  }
  const nodes: GraphNode[] = language === "rust"
    ? [
      { id: "base", label: "Handler", ref: `${dir}/${files.local}#Handler` },
      { id: "local", label: "Local", ref: `${dir}/${files.local}#Local` },
      { id: "hidden", label: "Remote", ref: `${dir}/${files.hidden}#Remote` },
      { id: "never", label: "NeverImplements", ref: `${dir}/${files.unprovable}#NeverImplements` },
    ]
    : [
      { id: "base", label: "Base", ref: `${dir}/${files.local}#Base` },
      { id: "local", label: "Local", ref: `${dir}/${files.local}#Local` },
      { id: "hidden", label: "Aliased", ref: `${dir}/${files.hidden}#Aliased` },
      { id: "neverExtends", label: "NeverExtends", ref: `${dir}/${files.local}#NeverExtends` },
      { id: "computed", label: "Computed", ref: `${dir}/${files.unprovable}#Computed` },
      ...(language === "typescript"
        ? [{ id: "handle", label: "handle", ref: `${dir}/${files.wrongEnd}#handle` } satisfies GraphNode]
        : []),
    ];
  return { claim: "conforms", language, dir, nodes, edges };
}


const FEEDS_FILE: Record<Language, string> = {
  rust: "src/pipeline.rs",
  python: "pipeline.py",
  typescript: "pipeline.ts",
};

function feedsFixture(dialect: Dialect): Fixture {
  const language = dialect.language;
  const dir = `bench/fixtures/feeds/${language}`;
  const stagesFile = language === "rust" ? "src/stages.rs" : language === "python" ? "stages.py" : "stages.ts";
  const stage = (snake: string) => `${dir}/${stagesFile}#${dialect.name(snake === "format_" && language !== "python" ? "format" : snake)}`;
  const at = (snake: string) => `${dir}/${FEEDS_FILE[language]}#${dialect.name(snake)}`;
  const formatName = language === "python" ? "format_" : "format";
  return {
    claim: "feeds",
    language,
    dir,
    nodes: [
      { id: "parse", label: "parse", ref: stage("parse") },
      { id: "render", label: "render", ref: stage("render") },
      { id: "collect", label: "collect", ref: stage("collect") },
      { id: "format", label: "format", ref: `${dir}/${stagesFile}#${formatName}` },
      { id: "run", label: "run", ref: at("run") },
      { id: "viaField", label: "run via field", ref: at("run_via_field") },
      { id: "unrelated", label: "unrelated", ref: at("unrelated") },
    ],
    edges: [
      {
        shape: "plainly-true", from: "parse", to: "render", expect: "confirmed",
        because: "SKILL.md: checked by finding one function that binds the first call's "
          + "result and passes it into the second -- `run` does exactly that.",
      },
      {
        shape: "true-but-hidden", from: "collect", to: "format", expect: "not-verified",
        because: "SKILL.md: \"a value can reach the other end through a callback, a struct "
          + "field, a builder chain -- places no reader follows\" -- `run_via_field` is exactly "
          + "that shape, and \"an unfound flow is a count in --details, not a verdict.\" A "
          + "separate symbol pair from plainly-true's, so this arrow has no other wiring "
          + "routine to be confirmed by.",
      },
      {
        shape: "false-and-unprovable", from: "unrelated", to: "render", expect: "not-verified",
        because: "SKILL.md: \"it can never come back red\" -- failing to find the flow is not "
          + "evidence the arrow is wrong.",
      },
    ],
  };
}

export const FIXTURES: Fixture[] = [
  {
    claim: "needs",
    language: "rust",
    dir: "bench/fixtures/needs/rust",
    nodes: [
      { id: "model", label: "model", ref: "bench/fixtures/needs/rust/src/model.rs" },
      { id: "server", label: "server", ref: "bench/fixtures/needs/rust/src/server.rs" },
      { id: "macro_user", label: "macro user", ref: "bench/fixtures/needs/rust/src/macro_user.rs" },
      { id: "alone", label: "alone", ref: "bench/fixtures/needs/rust/src/alone.rs" },
    ],
    edges: [
      {
        shape: "plainly-true", from: "server", to: "model", label: "reads a request",
        expect: "confirmed", because: NEEDS_DOC + " `use crate::model::Request` is the line.",
      },
      {
        shape: "true-but-hidden", from: "macro_user", to: "model", label: "expands to a request",
        expect: "not-verified",
        because: "deps.ts `macro-expansion`: a `use` inside a macro body is a token tree, so the reader withholds.",
      },
      {
        shape: "false-and-provable", from: "model", to: "server", label: "drawn backwards",
        expect: "red", because: "SKILL.md: get `needs` backwards and the next check says so in red.",
      },
      {
        shape: "false-and-unprovable", from: "alone", to: "model", label: "no import either way",
        expect: "not-verified", because: NEEDS_DOC,
      },
    ],
  },
  {
    claim: "needs",
    language: "python",
    dir: "bench/fixtures/needs/python",
    nodes: [
      { id: "model", label: "model", ref: "bench/fixtures/needs/python/model.py" },
      { id: "server", label: "server", ref: "bench/fixtures/needs/python/server.py" },
      { id: "lazy", label: "lazy", ref: "bench/fixtures/needs/python/lazy.py" },
      { id: "alone", label: "alone", ref: "bench/fixtures/needs/python/alone.py" },
    ],
    edges: [
      {
        shape: "plainly-true", from: "server", to: "model", label: "reads a request",
        expect: "confirmed", because: NEEDS_DOC + " `from .model import Request` is the line.",
      },
      {
        shape: "true-but-hidden", from: "lazy", to: "model", label: "imports by name",
        expect: "not-verified",
        because: "SKILL.md: a file that reaches out at runtime is withheld. `import_module` takes a string.",
      },
      {
        shape: "false-and-provable", from: "model", to: "server", label: "drawn backwards",
        expect: "red", because: "SKILL.md: get `needs` backwards and the next check says so in red.",
      },
      {
        shape: "false-and-unprovable", from: "alone", to: "model", label: "no import either way",
        expect: "not-verified", because: NEEDS_DOC,
      },
    ],
  },
  {
    claim: "needs",
    language: "typescript",
    dir: "bench/fixtures/needs/typescript",
    nodes: [
      { id: "model", label: "model", ref: "bench/fixtures/needs/typescript/model.ts" },
      { id: "server", label: "server", ref: "bench/fixtures/needs/typescript/server.ts" },
      { id: "lazy", label: "lazy", ref: "bench/fixtures/needs/typescript/lazy.ts" },
      { id: "alone", label: "alone", ref: "bench/fixtures/needs/typescript/alone.ts" },
    ],
    edges: [
      {
        shape: "plainly-true", from: "server", to: "model", label: "reads a request",
        expect: "confirmed", because: NEEDS_DOC + " `import { makeRequest } from \"./model\"` is the line.",
      },
      {
        shape: "true-but-hidden", from: "lazy", to: "model", label: "imports at runtime",
        expect: "not-verified",
        because: "deps.ts `dynamic-import`: the specifier may be built at runtime, so the reader withholds.",
      },
      {
        shape: "false-and-provable", from: "model", to: "server", label: "drawn backwards",
        expect: "red", because: "SKILL.md: get `needs` backwards and the next check says so in red.",
      },
      {
        shape: "false-and-unprovable", from: "alone", to: "model", label: "no import either way",
        expect: "not-verified", because: NEEDS_DOC,
      },
    ],
  },
  ...DIALECTS.map((dialect) => signatureFixture("takes", dialect)),
  ...DIALECTS.map((dialect) => signatureFixture("returns", dialect)),
  ...DIALECTS.map((dialect) => holdsFixture(dialect.language)),
  ...DIALECTS.map(buildsFixture),
  ...DIALECTS.map(callsFixture),
  ...DIALECTS.map(accessesFixture),
  ...(["rust", "python", "typescript"] as const).map(conformsFixture),
  ...DIALECTS.map(feedsFixture),
];
