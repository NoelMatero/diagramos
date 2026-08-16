# Brief: is this feature still actually used?

> **2026-08-17:** the strippers and declaration tables this brief measures
> were superseded by tree-sitter. The measurements below are still what drove
> the design; the mechanism they describe is gone. See
> "The strippers were replaced" in `docs/usage-design.md`.

**Status: answered in `docs/usage-design.md` (2026-08-16). Steps 1-3 of that
design are built — `@declared`, `@used`, both strippers, both declaration
tables. The measured results are in the design's "What shipped" section, and
they replace the numbers below where the two disagree.**

A design problem, handed over deliberately unsolved. Same format as
`docs/arrow-check-brief.md` and `docs/ref-brief.md`, both of which worked.
Everything measurable below was measured on 2026-08-16; where something is
opinion it says so. If a claim here disagrees with the code, trust the code and
fix this file.

**We want a design, not code.** Say plainly which parts cannot be done
deterministically — that is a finding, not a failure.

## The case, in the words it arrived in

A Rust `lib.rs` — an event-loop HTTP server, about 500 lines. Someone adds
logging to it. That means four things at once:

- crate imports: `std::io::Write`, `std::fs::OpenOptions`, `std::sync::Mutex`,
  `lazy_static`
- a `LOGGER` static, `lazy_static!` wrapping a `Mutex<File>`
- a `log_line!` macro, `macro_rules!`
- **28 call sites**, scattered through `ready`, `notify`, `accept`, `readable`,
  `run`, `handle_request`, `reset_connection`

A box on the diagram says "logging". The question:

> Can a mechanical check tell when that box has stopped being true?

Not "is the logging good". Not "does it cover the right paths". Only: has this
stopped being present in the code?

## What the check does today, measured on that file

A ref can name a symbol, and the check asks a word-boundary regex whether the
file mentions it. Two anchors on the box — `src/lib.rs#LOGGER` and
`src/lib.rs#log_line` — against every realistic way the logging could be removed:

| what was removed | `LOGGER` | `log_line` | caught? |
| --- | --- | --- | --- |
| nothing | found | found | quiet, correct |
| all 28 call sites, macro kept | found | found | **no** |
| the macro, calls kept | found | found | **no** |
| the `LOGGER` static | found | found | **no** |
| the whole feature | gone | gone | yes |
| everything but a doc comment mentioning both | found | found | **no** |

**One of five caught.** The last row is the worst: a file containing nothing but
`/// Logs a message via log_line! and LOGGER.` passes both anchors. The rest fail
for a structural reason — a symbol's own declaration mentions it, and so does
every call site, so "is it mentioned" cannot distinguish *declared*, *used*, and
*talked about in a comment*.

## A predicate that does work, also measured

Two regexes and a crude comment strip. Require the symbol to be **declared here
and used somewhere other than its own declaration**:

```js
const DECLARES = (sym) => new RegExp(
  `(?:macro_rules!\\s*|static\\s+ref\\s+`
  + `|(?:pub\\s+)?(?:async\\s+)?(?:fn|struct|enum|trait|type|const|static|mod)\\s+`
  + `|(?:export\\s+)?(?:async\\s+)?(?:function|class|const|let|var)\\s+)${esc(sym)}\\b`,
);
// clean when: DECLARES(sym).test(code) && occurrences(code, sym) > 1
```

Same six variants, same file:

| what was removed | `LOGGER` | `log_line` | verdict |
| --- | --- | --- | --- |
| nothing | declared, 2 uses | declared, 5 uses | quiet |
| all call sites, macro kept | declared, 2 | declared, **1** | flag |
| the macro, calls kept | declared, 1 | **not declared**, 4 | flag |
| the `LOGGER` static | **not declared**, 1 | declared, 5 | flag |
| the whole feature | not declared, 0 | not declared, 0 | flag |
| everything but the doc comment | not declared, 0 | not declared, 0 | flag |

**Five of five, and the untouched file stays quiet.** That is the starting point,
not the answer — see what it does not survive, below.

## What is already settled — please do not relitigate

- **Detection stays mechanical, and a model is only involved in fixing.** This
  runs on every turn via a `Stop` hook. Static checks cost nothing and repeat;
  a model call does neither.
- **Silence when clean.** A check that announces good news thirty times an hour
  gets switched off — and switching it off costs the quiet, correct
  missing-file check too. That shared fate is the real risk.
- **Quiet beats clever.** Where it cannot be sure: "worth a look", or nothing.
  Never "wrong". A miss is invisible; a false alarm costs the whole check.
- **Errors must fall in the silent direction.** `mentions()` already commits to
  this on purpose: a missed rename is invisible, while a wrong "this is gone"
  costs trust in everything. Any new tier inherits that.
- **Two channels exist.** Per-turn is milliseconds and must stay quiet;
  on-demand (`--details`, `check_drift`, `--coverage`) can afford more. A
  plausible-but-uncertain finding belongs in the second, and there is precedent:
  the unrepresented-modules check is on-demand only.
- **Reports, never auto-fixes.**

## What exists to build on

- `src/engine/drift.ts` — `mentions()`, `inspect()`, the anchor forms, the
  `Workspace` abstraction (`resolve` / `stat` / `read` / `list`), which confines
  paths to the root and re-checks after `realpath`. Anything new goes through it.
- Anchors already support a file, `path#symbol`, a directory, `dir/#symbol`, a
  glob over one directory, and `refs: string[]` for several at once. So the
  logging box can already *say* `refs: ["src/lib.rs#LOGGER", "src/lib.rs#log_line"]`.
  What it cannot do is check the claim properly.
- `docs/ref-design.md` step 3 proposes a **declaration tier** for TypeScript,
  measured at 109/109 recall with 13 of 71 discrimination errors, all falling in
  the quiet direction. This brief is the same idea meeting a harder language and
  a harder question — usage, not just declaration. Read it first; do not redo it.

## The hard parts, honestly

1. **Language.** Everything syntax-aware in this project is TypeScript and
   JavaScript: import resolution, route literals, the shared-importer channel.
   Existence checks are language-agnostic; nothing else is. The corpus now has
   Rust in it. A per-language declaration table is the obvious move and the
   obvious way to accumulate quiet wrongness — say how it fails safe.
2. **Comments and strings.** The doc-comment row above is only caught because the
   probe strips comments, and it strips them crudely: line comments, non-nested
   block comments. Rust has nested block comments and raw strings (`r#"..."#`);
   every language has a string that can contain `//`. Getting this wrong makes
   the check *louder*, which is the dangerous direction.
3. **Cross-file usage.** The case above is one file, which is why it works. If
   `log_line!` were declared in `logging.rs` and used across twelve modules,
   "used elsewhere" needs a usage graph. For TS/JS there is one import hop
   available. For Rust there is nothing without a real parser, and rust-analyzer
   is a build step, a dependency, and hundreds of milliseconds.
4. **Macro-generated and conditional code.** `#[cfg(...)]`, `macro_rules!`
   producing call sites, `#[macro_export]`, re-exports through `pub use`. A
   symbol can be genuinely used by code that does not contain its name.
5. **The count threshold is a claim, not an observation.** `> 1` says "used at
   least once beyond its declaration". Recording "there were 28 call sites on
   Tuesday" would be storing a fact with a shelf life — exactly the rot this
   check exists to catch, and the reason `missing` is not one of the node states.
   If a count belongs anywhere it is as a floor the author declares, and that
   needs justifying.

## What we are asking for

1. **The predicate, or a better one.** Is declared-and-used right? What about a
   symbol legitimately declared and not yet used, or one used only in tests?
2. **Which tier it reports in.** Near-certain and loud per-turn, plausible and
   on-demand, or information only. Justify it with the false-positive number.
3. **How language support degrades.** What happens on a language with no
   declaration table — silent, or existence-only? Silent is the house default
   and needs no defence; anything else does.
4. **Whether a box should be able to say "used across these files"**, and what
   that costs outside TS/JS.
5. **What you would refuse to build.** The most valuable section of both previous
   briefs was the measured rejections.

## How to evaluate — measure, do not argue

1. **Run it on the real corpus**: the seven committed diagrams, where the only
   ref'd board is `board-internals.excalidraw`. Every new flag is a false
   positive unless the box is genuinely wrong. The bar to beat is zero.
2. **Construct true positives**: reproduce the six-variant table above, and add
   the cases it misses.
3. **Report both numbers together**, and say what you did not measure. Six
   hand-made variants of one file is not a corpus, and this brief does not
   pretend otherwise.
4. **State the cost** in milliseconds and files read, per turn.

## Constraints on any implementation

- Deterministic, milliseconds on the per-turn path, no network, no build step,
  no model, no new runtime dependency.
- Through `Workspace`, so path confinement holds.
- Behind its own flag, so a noisy newcomer can be switched off without losing
  the quiet checks.
- Silent rather than wrong on any language it does not understand.
- Where it cannot be sure: "worth a look", or nothing. Never "wrong".

## Reading order

- `docs/ref-design.md` — the anchor forms and the declaration tier for TS.
- `src/engine/drift.ts` — `mentions`, `inspect`, `Workspace`.
- `docs/arrow-check-brief.md` — the same exercise done well, with its
  measurements and its four measured rejections.
- `docs/drift-check.md` — why detection and regeneration are separate, and how a
  report reaches a human without becoming noise.
