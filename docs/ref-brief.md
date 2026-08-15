# Brief: what a box refers to

**Status: design answered in `docs/ref-design.md` (2026-08-15), not yet built.**

A design problem, handed over deliberately unsolved. Same format as
`docs/arrow-check-brief.md`, which worked: everything measurable below was measured
in this repo on 2026-08-15, and where something is opinion it says so. If a claim
here disagrees with the code, trust the code and fix this file.

**We want a design, not code.** Say plainly which parts cannot be done
deterministically — that is a finding, not a failure.

## The goal this serves

Diagram-driven development. A committed `.excalidraw` file is the spec; the code
either satisfies it or does not; and a mechanical check tells you which, both ways:

- The diagram has something the code lacks → **not implemented yet**, a work item.
- The code has something the diagram lacks → **the diagram is behind**.

An AI agent can act on either the moment it is stated precisely. Nobody has got
this working, and the reason is not the agent. It is that **the diagram side is not
expressive enough to be compared against anything.** That is the problem in this
brief.

## The one sentence version

A box says it stands for something in the repository. Today it can only say
"this file", or "this file, and somewhere in it this word appears". Most boxes mean
something else. What should a box be able to say, such that a mechanical check can
still verify it in milliseconds without crying wolf?

## What is already settled — please do not relitigate

- **Detection stays mechanical, and a model is only involved in fixing.** Asking a
  model "does this diagram match the code?" costs tokens every turn, answers
  differently each time, and cannot run constantly. This constraint shapes
  everything.
- **The per-turn budget is milliseconds, and silence when clean.** This runs on
  every turn via a `Stop` hook. A check that announces good news thirty times an
  hour gets switched off — and switching it off costs the quiet, reliable checks
  too. Anything expensive or ambiguous belongs in an on-demand command instead.
  Both channels already exist; use them.
- **Quiet beats clever.** Where a check cannot be sure, it says "worth a look" or
  says nothing. Never "wrong". A miss is invisible; a false alarm costs the whole
  check.
- **Reports, never auto-fixes.** Fixing is a command a human invokes.
- **Measure, do not argue.** See "How to evaluate" at the end.

## What a ref is today, exactly

`src/engine/drift.ts`. A node may carry one string in `customData.ref`.

```ts
/** Splits `path#symbol`. Either half may be empty; the caller decides. */
export function parseRef(ref: string): { path: string; symbol?: string } {
  const hash = ref.indexOf("#");
  if (hash < 0) return { path: ref.trim() };
  return { path: ref.slice(0, hash).trim(), symbol: ref.slice(hash + 1).trim() || undefined };
}
```

Resolution, in order: empty path → `unresolvable-ref`; outside the repo →
`unresolvable-ref`; file missing → `missing-file`; no symbol → **ok**; path is a
directory but a symbol was given → `unresolvable-ref`; otherwise the symbol check:

```ts
/**
 * Word-boundary match, not a parse. A rename shows up; a mention in a comment
 * counts as still present. That asymmetry is deliberate: a missed rename is
 * invisible, while a wrong "this is gone" costs trust in the whole check.
 */
function mentions(source: string, symbol: string): boolean {
  return new RegExp(`\\b${symbol.replace(REGEX_SPECIAL, "\\$&")}\\b`).test(source);
}
```

A hand-drawn box gets a ref inferred from its label only if the label looks like a
path — a slash and an extension:

```ts
const PATH_LIKE = /^[\w@.-]+(?:\/[\w@.-]+)+\.\w{1,10}$/;
```

So `src/engine/layout.ts` is read as a ref. `Auth`, `login()`, and
`POST /api/file` are not.

Everything reaches disk through the `Workspace` abstraction (`resolve` / `stat` /
`read`), which confines paths to the root and re-checks after `realpath`. Refs are
model-authored strings that become filesystem reads, so **any new ref syntax must
go through `Workspace`** and must not become a way to probe the disk. A ref syntax
that can express "search the whole repo" is a security surface, not just a cost
problem.

## The corpus, measured — this is the damning part

Every diagram in this repo, today:

| diagram | nodes | with ref | with `#symbol` | directory ref |
| --- | --- | --- | --- | --- |
| architecture | 16 | 0 | 0 | 0 |
| auth | 33 | 0 | 0 | 0 |
| board-internals | 12 | 11 | 0 | 1 |
| example | 5 | 0 | 0 | 0 |
| ims-volte | 18 | 0 | 0 | 0 |
| ims | 19 | 0 | 0 | 0 |
| ims_2 | 14 | 0 | 0 | 0 |
| **total** | **117** | **11** | **0** | **1** |

Three facts worth sitting with:

1. **`#symbol` has never been used. Not once, in 117 nodes.** The feature has
   existed for the life of the project. Either it is not what people need, or
   nothing makes it worth reaching for. Both readings are useful.
2. **106 of 117 nodes carry no ref at all**, so they are invisible to every check.
3. **This project's own `architecture.excalidraw` — 16 nodes — has zero refs.** The
   flagship diagram of the repo that contains the checker is entirely unchecked.
   Whatever the reason is, "people will add refs if we ask them to" is not
   supported by the evidence.

The telecom diagrams (`ims*`, `auth`) have no refs **by design**: they describe a
protocol, not this repository, and inventing paths for them would be worse than
leaving refs off. Any design must let a box say "I am deliberately not code"
distinctly from "somebody forgot" — see the states section.

## Where the current ref actually fails

Real cases, from the person building this:

- **A box means a function, not a file.** `login` lives inside
  `src/auth/session.ts` alongside twenty other things. `session.ts#login` is
  expressible, but the check is a word-boundary regex over the whole file, so it
  matches a comment, a string, an unrelated variable, or the word in an import of
  something else. It cannot distinguish *declared here* from *mentioned here*.
- **A box means a change spread across existing files.** "Add logging" touches four
  files that all already exist. There is no new file to point at, so every
  existence check passes and the box is unverifiable — while being exactly the kind
  of work someone wants tracked.
- **A box means a subsystem.** "the engine" is `src/engine/*` — eleven files. One
  path cannot say it. A directory ref half-works: existence is checkable, but a
  symbol becomes `unresolvable-ref`, and the arrow check skips directory refs
  entirely, so a box like this silently disables the edges around it.
- **A box means something not in the repo.** "browser canvas", "Chromium", an S3
  bucket, a third-party API. Today: no ref, which is indistinguishable from an
  oversight.
- **A box means a route or a contract.** `POST /api/file` is a real, greppable,
  checkable thing — the arrow check already collects route literals — but no ref
  syntax can name it.

Note the pattern: the check is strongest at exactly the claim people least want to
make (this one file exists) and has nothing to offer for the claims they actually
draw.

## The intent axis, for context

Separately from *what* a box refers to, we are adding *when* it is claiming: a
declared state such as `planned` / `built` / `external`, so that "file missing"
means "go build it" for a planned box and "regression" for a built one. That axis is
not this brief's problem, but a ref design should compose with it — a `planned` box
referring to a symbol inside a file that exists is a meaningful, checkable thing
("the file is there, the function is not yet").

## What we are asking for

A design for what a box can say about the code, and how it is verified. Concretely:

1. **The syntax.** One string, a structured object, a list? What can be expressed —
   globs, symbol kinds, multiple targets, routes, "not code"? Keep in mind a model
   writes these, so ambiguity becomes nondeterminism.
2. **The verification.** For each thing that can be expressed, the mechanical check
   and its cost. Where a real parse is needed rather than a regex, say so and say
   what it costs — a TS parse of a handful of files per turn may be affordable; the
   repo is not.
3. **Which findings it produces**, and which of the three confidence tiers each sits
   in: near-certain (report loudly), plausible (worth a look), or unknowable (stay
   silent).
4. **Migration.** 106 refless nodes and a project that has never used `#symbol`
   once. A design requiring everyone to go back and annotate is a design that does
   not ship. What is the path where existing diagrams get more checkable without a
   person editing 117 boxes?
5. **What you would refuse to build**, and why. The most valuable section of the
   arrow-check brief was the measured rejections.

## Already measured and rejected — do not re-propose

From the arrow work (`docs/arrow-check-brief.md`), so this is not re-derived:

- **"Flag an arrow when A does not import B"** — 100% noise on the real corpus. Four
  flags, four correct arrows. Arrows mean *data flows to*, *serves*, *talks to*,
  *is orchestrated into* at least as often as *imports*.
- **Inverting to look for missing arrows** — nine flags, every one a real import the
  diagram deliberately abstracts away. Worse than the naive rule.
- **Reachability over the import graph** — flagged the same four. Bought nothing.
- **Bare path mentions in file text as corroboration** — whitewashes. A docstring
  example containing `src/engine/layout.ts` would bless a fabricated arrow. Route
  literals worked; bare path mentions did not.

What did work: several independent corroboration channels, where *any* trace of a
relationship is enough, and only a total absence of evidence is reported. That
philosophy is probably reusable here.

## How to evaluate whatever you design — measure, do not argue

1. **Run it on the real corpus.** Every flag on the seven committed diagrams is a
   false positive unless you can show the box is genuinely wrong.
2. **Construct a true positive.** Change the code so a box really is stale, and
   confirm it is caught. A rule that flags nothing achieves zero false positives
   trivially.
3. **Report both numbers together**, and say what you did not measure.
4. **State the cost per turn** in milliseconds and files read, not in adjectives.

## Constraints on any implementation

- Deterministic, milliseconds for the per-turn path, no network, no build step, no
  model in the loop.
- Through `Workspace`, so path confinement holds. No ref syntax that can be turned
  into a disk probe.
- Behind a flag, so a noisy new check can be switched off without losing the quiet
  ones.
- TypeScript and JavaScript for anything import- or syntax-aware; silent rather
  than wrong on other languages. Existence checks are language-agnostic.
- Where it cannot be sure: "worth a look", or nothing. Never "wrong".

## Reading order

- `src/engine/drift.ts` — refs, resolution, the four corroboration channels,
  `Workspace`.
- `src/engine/graph.ts` — what a board yields: nodes, edges, `provenance`,
  `endpoints`.
- `docs/arrow-check-brief.md` — the same exercise, done well, with its measurements.
- `docs/drift-check.md` — why detection and regeneration are separate, and how the
  report reaches a human.
