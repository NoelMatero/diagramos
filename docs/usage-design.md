# Design: is this feature still actually used?

Answer to `docs/usage-brief.md`, measured on 2026-08-16 against the real Rust
file the brief describes (`orangutan/src/lib.rs`, 640 lines, 29 `log_line`
occurrences) and against every export in this repo's own `src/`. A design, not
code. If this file disagrees with the code once something ships, trust the code
and fix this file.

A follow-up question arrived while this was being written and is answered in
"The arrow, at function granularity" below: the diagram says
`failure_handle_database → log`, and the logging call sits in a *different*
function — can that be caught? Measured: yes.

**Revised 2026-08-16, after review:** source-code markers are cut from this
plan and moved to their own issue, and the crate/npm form of them is refused
permanently on measurements. The chain problem is solved by membership and
`via`, both of which live in the diagram file. See "Markers in the source,
measured and deferred".

**Built 2026-08-16, steps 1-3:** assertions, both strippers, both declaration
tables. Where the numbers below were re-measured against the shipped code they
have been replaced and the original is noted — see "What shipped, and what the
numbers were on the real thing".

## The finding first

**Usage is deterministically checkable — inside the files the box itself
names.** The brief's predicate is right, and it survives every removal variant
including three the mention check can structurally never see (call sites
commented out, mentions surviving only inside strings, raw strings). What makes
it safe is not the predicate but two fences around it:

1. **It is a claim an author writes, never an inference.** Measured below:
   auto-applying declared-and-used to every export in this repo would flag 35
   of 121 — a 29% false-alarm rate. Applied only where an author wrote the
   claim, the measured false-alarm rate on eleven variants of the real file is
   zero. The entire difference between those two numbers is opt-in.
2. **Every lexical doubt collapses to silence.** The stripper bails on anything
   unterminated or confusing, and a bailed file falls back to today's
   raw-mention semantics. Errors can only make the check quieter — the same
   asymmetry `mentions()` already commits to.

What stays out of mechanical reach, said plainly: whether the code is used
**correctly**. Right arguments, right order, right behavior — those oracles
already exist and are called `cargo check`, `tsc`, and the test suite. They
cost a build step and seconds, both banned per-turn, and re-running them from
a diagram checker would duplicate what the editor and CI already do. The
division of labor is: **this check verifies presence of a claimed
relationship; the compiler verifies well-formedness; tests verify behavior.**
A diagram check that pretends to do all three does none reliably.

And the question behind the brief — "the model could write checks at diagram
time; is that enough?" — has a precise answer: it is not only enough, it is
already the architecture. Refs are model-authored claims verified mechanically
forever after. This design extends the claim *vocabulary*, not the division of
labor. The model chooses **which** claims to make, from a closed list; it never
gets to decide **how** they are verified, so its nondeterminism cannot leak
into detection. And because the `Stop` hook runs the check in the same turn the
claim is written, a wrong claim flags immediately, while the author who wrote
it is still there — bad claims cannot survive their first turn, let alone rot.

## The syntax

Assertions ride the symbol half of an anchor, after `@`:

| anchor | claim |
| --- | --- |
| `src/lib.rs#log_line` | the file mentions it *(today, unchanged — comments count)* |
| `src/lib.rs#log_line@declared` | the file declares it (declaration table, stripped text) |
| `src/lib.rs#log_line@used` | the file contains ≥ 1 occurrence outside comments and strings, beyond any declaration |
| `src/lib.rs#log_line@declared+used` | both — the brief's predicate |

Rules that keep a model-authored string honest:

- The words are a closed whitelist (`declared`, `used`), order-free around `+`.
  Anything else after `@` is `unresolvable-ref` — loud, immediately, so a
  garbled assertion fails the turn it is written instead of becoming a silent
  claim that checks nothing.
- A symbol starting with `/` is a route claim (per `docs/ref-design.md`) and is
  never parsed for assertions, so `#/api/users/@me` stays a literal route.
  Measured: no existing ref in any committed diagram contains `@`, so the
  suffix collides with nothing.
- Cross-file usage is the `refs` list doing what it already does. The logging
  box whose macro lives in one file and call sites in others writes:

  ```
  refs: ["src/logging.rs#log_line@declared",
         "src/server.rs#log_line@used",
         "src/worker.rs#log_line@used"]
  ```

  The author names the files; each anchor is a single-file check. That is the
  whole answer to "does this need a usage graph": no — **the box carries the
  graph**, one hop of it, the hop the author cares about. It costs reading
  exactly the files the box names, in any language the table knows.

Composition with states (#33): on a `planned` box, `@used` failing while
`@declared` holds reads "declared but not wired up yet" — a work item — and
its later success is a promotion, the diagram noticing the wiring landed. Same
detection, different sentence, exactly like `missing-file`.

## The predicate, exactly

One formula, no modes:

```
usedCount = occurrences(symbol, stripped) − occurrences(symbol, declaration matches)
declared  = declaration-table regex hits in stripped text
@declared fails when declared is false; @used fails when usedCount < 1
```

Subtracting declaration-consumed occurrences (rather than requiring a total
count > 1) is what lets `@used` stand alone on a consumer file, where nothing
is declared and one clean mention is the evidence. It also keeps the
`TryRead` trap honest — imported, then used only as a method name that never
mentions it: `#TryRead@used` is quiet (the `use` line counts), while
`#TryRead@declared+used` flags the moment it is written, which is correct — it
is a false claim, and the author is told while still holding the pen.

**There are no count floors.** `@used>=28` was considered and refused: 28 call
sites consolidated into 3 wrappers is a healthy refactor that would flag
forever. "At least one use beyond the declaration" is the only threshold that
survives every refactor that keeps the feature. Recording observed counts was
already rejected by the brief for the same reason: never store what you can
measure, and never alarm on what an author might legitimately change.

## The strip, and the bail rule

Stripping exists because the doc-comment row is unwinnable without it, and it
is the one component whose bugs point in the dangerous direction (eating real
code makes the check louder). Two defenses, both measured:

- **Per-language lexers, small and honest.** Rust: line comments, *nested*
  block comments, strings, raw strings (`r#"…"#`, byte forms), and the
  char-literal-versus-lifetime distinction (`'"'` is a char, `'static` is not).
  TypeScript/JavaScript: both comment kinds, all three string kinds, template
  literals with `${…}` expressions kept (uses inside them are real uses), and
  regex literals detected by the expression-position heuristic — this repo's
  own `drift.ts` is full of regexes containing quote characters and is the
  test that matters.
- **Bail to mention.** Any unterminated state at end of file, or anything the
  lexer cannot classify, abandons stripping for that file; the anchor is then
  judged on raw text (mention semantics) and the downgrade is counted in the
  skip breakdown that #35 just built. A stripper bug can cost precision, never
  add an alarm.

Measured: all 19 `src/` TypeScript files strip clean, zero bails, and **zero
of 121 declarations are lost by stripping** — the regex-literal handling
survives contact with the checker's own source.

## Language degradation

A declaration table exists per extension: TypeScript/JavaScript and Rust ship
first, because they are the corpus. On any other extension, `@declared` and
`@used` are **skipped and counted** — surfaced in the coverage line as
"asserted, not checkable here" — and the anchor still gets the plain mention
check. Silent, the house default. Adding a language is one table row and one
fixture file of removal variants, not a parser.

## Findings and tiers

| finding | trigger | tier | channel |
| --- | --- | --- | --- |
| `missing-declaration` | `@declared` fails | near-certain | per-turn, loud |
| `unused-symbol` | `@used` fails | near-certain | per-turn, loud |
| garbled assertion | unknown word after `@` | near-certain | per-turn, loud (`unresolvable-ref`) |
| stripped-check downgraded | lexer bailed | information | skip breakdown, on-demand |
| assertion on unknown language | no table for extension | information | coverage, on-demand |

Loud is justified by the numbers: zero false alarms across eleven variants of
the real file, and the one systematic hazard — blind application — is fenced
off by refusing inference entirely. A declaration moved to another file does
flag, and should: the *claim as written* is stale, the same way `missing-file`
fires on a moved file, and `/update-diagram` is the fix. Both findings sit
behind the feature's own flag, so a surprise in the field switches off the
newcomer without costing the quiet checks.

## Measured results

Eleven variants of the real `lib.rs`, box = `{#LOGGER@declared+used,
#log_line@declared+used}`:

| variant | verdict | note |
| --- | --- | --- |
| untouched | quiet | 28 uses seen for `log_line`, 1 for `LOGGER` |
| call sites removed, macro kept | **flag** | brief row 2 |
| macro removed, calls kept | **flag** | brief row 3 |
| `LOGGER` static removed | **flag** | brief row 4 |
| whole feature removed | **flag** | brief row 5 |
| only a doc comment survives | **flag** | brief row 6 — the worst case, now caught |
| call sites commented out | **flag** | raw mentions still 29; invisible to `mentions()` |
| mentions only inside a string | **flag** | string strip |
| calls inside a nested block comment | **flag** | Rust nesting handled |
| mentions only in a raw string | **flag** | `r#"…"#` handled |
| used only under `#[cfg(test)]` | quiet | a use is a use — deliberate, see refusals |

**10 of 10 removals caught; the healthy file stays quiet.** The brief's
predicate scored 5 of 5 on its own table; the last five rows are cases it had
not measured.

The census that set the tier rule: every export in this repo's `src/`
(121 of them), predicate applied blindly to its own file → **35 would flag**.
Searching the rest of `src/` recovers 31 (used elsewhere — exactly the
exported-symbol hole the brief predicted). The remaining 4, checked against
`tests/` and `scripts/` too: **3 are genuinely dead exports**
(`fontSizeOf`, `NodeShape`, `snapModelSize`) and 1 is used only by tests
(`evaluateDiagramPlan`). So the predicate blind is 29% noise; the predicate
where an author claims it is, on everything measured here, zero noise — and it
found three real pieces of dead code along the way.

Rust declaration table: 21 of 21 declarations in `lib.rs` found (functions in
`impl` blocks, structs, the macro, the `static ref`, the `mod`). Honest
caveat: the inventory of 21 was itself derived by regex over stripped text,
not by a compiler, so this measures self-consistency plus by-hand spot checks,
not compiler-grade recall.

Corpus: no committed ref contains `@`, so nothing changes on the seven boards
by construction — the new checks exist only where the new syntax is written.

**Cost:** the two-anchor Rust box, full pipeline (read, strip, judge twice):
**1.06 ms per turn**. Stripping all 19 `src/` TypeScript files wholesale:
6.1 ms. Stripped text is cacheable per file within a run; nothing is cached
across runs, because stored observations rot.

## The arrow, at function granularity

The file-level checks above cannot answer the sharpest question a diagram
asks: `failure_1 → log` is drawn, the logging call lives in `failure_2`, and
every file-level channel is satisfied — same file, shared importers, the lot.
The arrow is wrong and everything is quiet. Catching this needs the search
scoped to **one function's body**, and that is deterministic:

1. Find the symbol's declaration (the table above).
2. From the declaration, walk to the body's opening brace **on stripped
   text** — strings and comments are already blanked, so brace-balancing
   cannot be fooled — and take the balanced extent as the span. Expression 
   statements run to their depth-zero semicolon. A signature with no body
   (trait method, overload) yields no span and the arrow is skipped and
   counted, never guessed.
3. Search for the other endpoint's symbol inside that span only.

**No new "box kind" field is needed, and one is refused below.** The anchor
already declares what a box is: a bare path is a file box, `path#fn@declared`
is a function box, a `refs` list is a feature box, and `state: external` /
`describes: concept` are the not-code boxes. The arrow check picks its
granularity from what the anchors can support: **both ends symbol-anchored in
a language with a table → function granularity; anything less → today's
file-level channels.** You get the check whose precision matches the claim you
wrote — which also means an arrow that *means* orchestration rather than
calling should anchor at file level, and that is guidance for the skill text,
not a heuristic in the checker.

Two channels back a symbol→symbol arrow, both directions tried, any evidence
suffices:

- **Direct:** either endpoint's body names the other symbol.
- **One call hop:** the caller's body calls a same-file function whose body
  names the target. Only bare calls (`foo(…)`, `foo!(…)`) and explicit
  `self.foo(…)` / `this.foo(…)` are followed. `Type::foo(…)` and
  `other.foo(…)` are somebody else's `foo` — following them is how the first
  version of this measurement blessed two false arrows, below.

### Measured, on the real file

The log box carries `refs: [#LOGGER, #log_line]`; arrows drawn from seven
functions:

| arrow from | actually logs? | verdict |
| --- | --- | --- |
| `handle_request` | yes | quiet (direct) |
| `ready` | yes | quiet (direct) |
| `reset_connection` | yes | quiet (direct) |
| `register` | **no** | **flag** — the brief's failure-1-vs-failure-2 case |
| `get_client` | **no** | **flag** |
| `send` | **no** | **flag** |
| `receive` | **no** | **flag** |

**7 of 7 correct: every true arrow quiet, every false arrow flagged**, wording
"worth a look", never "wrong". Three measurements shaped the channels:

- **The one-hop channel earns its place:** doctoring `readable` to log only
  via its call to `self.handle_request` — a healthy refactor — keeps the true
  arrow `readable → log` quiet. Without the hop it becomes a false alarm.
- **The receiver rule earns its place:** before it, `register → log` and
  `receive → log` were wrongly blessed because their bodies call
  `EventSet::readable()` — mio's method — and the text-level hop confused it
  with the local `readable`, which logs. Restricting to bare/`self.`/`this.`
  calls fixed both without losing the transitive save.
- **A shared-caller channel is rejected, by measurement.** The file-level
  check blesses an edge when some C imports both ends; the function-level
  analog — some function naming both symbols — would bless the *false*
  `register → log` arrow, because `ready` calls `self.register` and also
  logs. The channel that saved the file-level check whitewashes exactly the
  case this granularity exists to catch.

TypeScript side: body extraction succeeds on **123 of 123** function
declarations in this repo's `src/`, and the spot checks behave (`checkDrift`'s
body names `inspect`; `parseRef`'s does not). Corpus exposure: **zero**
committed edges have symbol anchors at both ends, so nothing changes on the
seven boards until someone draws the first function-level arrow — the same
by-construction safety the `@` assertions have. Cost: **0.5 ms** per arrow
with the strip cached, 1.2 ms with a fresh strip of the 640-line file.

### Known blindnesses, all in the silent direction

A bare local call that shadows a same-named import is still followed; calls
through variables (`handler(&request)` where `handler` came out of a routing
table) are not followed, so an arrow true only through a handler table needs
the hop's target named somewhere in the body or a file-level anchor;
macro-generated call sites do not contain the name. Each of these makes the
check quieter, never louder. The hop stays at one, same-file — following it
across files re-imports the usage-graph problem refused above.

## Deep chains and concepts: naming beats walking

The one-hop limit has an obvious objection: indirection is the most common
thing in programming. `handle_fail_2 → handle_logging →
bunch_of_logging_stuff → log_line!` is a perfectly ordinary chain, and —
measured, with exactly that chain constructed inside the real `lib.rs` — the
*true* arrow `handle_fail_2 → log` **flags** under direct-plus-one-hop.
Walking deeper is not the fix: reachability blesses everything (measured at
file level in the arrow brief) and the shared-caller channel blesses the false
arrow this granularity exists to catch (measured above). The resolution is a
distinction: an unnamed chain is undetectable, but a **named** chain is just a
list of one-hop checks, and one-hop checks are the thing this design has
proven. So the question is never "how deep can the checker see" — it is "who
names the links, and where does the name live." Three shapes were measured on
the constructed chain; **two ship**, and both keep the name in the diagram
file. The third put it in the source and is deferred — see "Markers in the
source, measured and deferred" below.

### Membership — the concept box lists its interface

The "log" box's `refs` gains `handle_logging`. The arrow check already
accepts any-of-the-box's-symbols, so `handle_fail_2 → log` goes quiet (its
body names a member directly) while `handle_fail_1 → log` and
`register → log` stay correctly flagged. **Zero new machinery.** The design
guidance is the deliverable: a concept box's refs are *the symbols whose
invocation constitutes using the concept* — the interface, not just the
implementation. Fifty callers, one claim.

### `via` — the path itself is the claim

An arrow may carry `via: ["handle_logging", "bunch_of_logging_stuff"]`. Each
consecutive pair is one direct body check; the last link must reach a member
or ground anchor. Measured: the intact chain is quiet; cutting the deepest
link (the log call inside `bunch_of_logging_stuff`) flags with a **localized**
message — "chain breaks at `bunch_of_logging_stuff` → concept" — which is the
one thing membership cannot say. Use `via` when the route matters; use
membership when only the destination does.

### The self-support rule — closing the hollow-concept hole

Membership has a blind spot, measured: cut the deepest log call and callers
still call listed members, so everything stays green while the concept is
hollow. The rule that closes it: **every member must itself show a trace of
the concept** — its body names a ground anchor or another member.
Measured on the intact chain: no unsupported members. After the cut:
`bunch_of_logging_stuff` is flagged as claiming `logging` while showing no
trace of it. This rule is also the answer to "can model-written claims be
trusted": they are not trusted, they are **validated** — a claim must be
internally traceable, re-checked every turn like everything else.

### New findings this adds

`broken-chain` (a named `via` hop no longer holds — near-certain, loud, names
the hop) and `unsupported-member` (a listed member shows no trace of its
concept — near-certain, loud). Both behind the same feature flag as the rest
of this design. Corpus exposure: no committed diagram carries a `via`, so
nothing changes on the seven boards by construction.

### The division of labor, stated once

Every shape above is the same architecture: **a model (or a human) names a
relationship once, at write time or in an on-demand annotate pass, and the
machine verifies every named link forever after.** The model chooses *which*
claims exist; it never influences *how* they are judged, so its nondeterminism
cannot reach detection. Claims are committed, diffable artifacts — a wrong
claim can be audited and reverted, which a wrong per-turn judgment never can.
The per-turn flags are the annotate pass's worklist, and each flag names its
own fix: add the member, or name the path. That loop —
machine flags, model claims, machine verifies — is the practical answer to
"is diagram-driven development possible without a model in the checker": yes,
because the model's intelligence compiles down to claims the deterministic
layer holds forever.

## What shipped, and what the numbers were on the real thing

Steps 1-3 are built: assertion parsing, both strippers, both declaration
tables, and the two findings. Re-measured against the code rather than a
scratch script, on 2026-08-16. Where a number here contradicts one above, this
section is the one to trust.

| claim above | re-measured | note |
| --- | --- | --- |
| all `src/` TypeScript strips clean, zero bails | **24 files, zero bails** | but only after a fix, below |
| blind `@used` flags 35 of 121 exports (29%) | **42 of 134 (31%)** | same conclusion, bigger repo |
| declaration recall | **134 of 134**, no misses | a miss here is a false alarm, so this is the number that matters |
| two-anchor Rust box, full pipeline | **0.04 ms** | 1.6 ms per anchor on a 1248-line TypeScript file |
| corpus exposure | **zero**, confirmed by running it | no committed ref contains `@` |

Three things the design did not anticipate, all found by measuring:

- **JSX bails.** `</div>` is indistinguishable from an unterminated regex, and
  an apostrophe in JSX text from an unterminated string, so both `.tsx` files
  in `src/` abandoned stripping outright. Bailing is safe but throws away the
  whole file. Fixed by recovering rather than bailing: with no closing
  delimiter before the line ends, the character is treated as ordinary code.
  In TypeScript an unterminated string really is a syntax error, so the
  recovery cannot be wrong about valid source, and treating text as code only
  ever makes the check quieter.
- **Rust strings may span lines and TypeScript strings may not**, so the two
  lexers cannot share one quote scanner.
- **Two accidental quadratics**, both caught by timing rather than reading.
  Scanning the whole emitted output to decide whether `/` opens a regex cost
  89 ms to strip `src/`, against 15 ms with the lookback bounded to 24
  characters. And `\s` in the method-declaration pattern let it wander across
  newlines: 6.2 ms per anchor on a 1248-line file, against 1.6 ms with every
  gap bounded to `[ \t]`.

Also unplanned, and kept: a per-run cache of stripped text, because a box that
names a static and the macro using it reads the same file twice. It is never
persisted between runs -- a stored observation is a fact with a shelf life,
which is the rot this tool exists to catch.

**Step 5 is built too: function-granularity arrows.** Re-measured against the
real `~/orangutan/src/lib.rs` (641 lines, 29 `log_line` occurrences), with the
log box carrying `refs: [#LOGGER, #log_line]`:

| arrow from | logs? | verdict |
| --- | --- | --- |
| `handle_request` | yes | quiet |
| `ready` | yes | quiet |
| `reset_connection` | yes | quiet |
| `readable` | yes | quiet |
| `run` | yes | quiet |
| `accept` | yes | quiet |
| `notify` | yes | quiet |
| `register` | **no** | **flag** |
| `get_client` | **no** | **flag** |
| `send` | **no** | **flag** |
| `receive` | **no** | **flag** |

**11 of 11 correct.** Both channels reproduce: doctoring `readable` so it logs
only through its call to `self.handle_request` keeps that true arrow quiet, and
`register` stays flagged despite `ready` calling it and logging — the
shared-caller whitewash the design refused. **0.36 ms per arrow** on a fresh
strip of the 640-line file.

Two corrections to the section above, both from measuring against the real
file rather than a variant of it:

- **The original seven-arrow table was wrong about which functions log.** It
  listed `handle_request`, `ready` and `reset_connection` as logging and the
  rest as not. All three do log, and so do `readable`, `run`, `accept` and
  `notify`; the four that do not are `register`, `get_client`, `send` and
  `receive`. The conclusion survives — every true arrow quiet, every false one
  flagged — but the table did not.
- **The hop reaches through a macro's own body**, which the design did not
  say. `handle_request` never writes `LOGGER`; it calls `log_line!`, whose body
  does. So a box anchored on the static alone is still corroborated by a caller
  of the macro. This is correct and useful, and it is now pinned by a test.

Still to build: step 4 (skill guidance beyond the ref table), step 6
(membership guidance — the arrow check already accepts any of a box's symbols,
so this is prose), and step 7 (`via`).

**Steps 6 and 7 are built. The design is complete.** Membership needed no code,
as predicted: the arrow check already accepts any of a box's symbols, so step 6
is guidance in `skills/diagram/SKILL.md`. `via` and the self-support rule are
measured on the design's own chain experiment, reconstructed as a fixture:

| what was checked | result |
| --- | --- |
| the intact three-layer chain, no `via` | **flags** — the false alarm `via` exists to remove |
| the same chain with `via: ["handle_logging", "emit_batch"]` | quiet |
| cut the deepest call, same `via` | flags, and names `emit_batch` |
| a route that is wrong in the middle | flags, and names the middle hop |
| a hop with no body in this file | unreadable, skipped and counted, not a break |
| self-support, intact chain, four members | no complaints |
| self-support, after the cut | `emit_batch` flagged as hollow |
| self-support on `[LOGGER, log_line]` | quiet, before and after |

That last row is the one that shaped the rule. `LOGGER` is a `static` and never
names anything; requiring every member to reach another would flag it, and
flag the equivalent in every well-formed box. So the rule applies to members
that **run** — a `fn`, a `function`, a `macro_rules!`, a method — and exempts
data, which is the ground the rest of the concept reaches to. The declaration
table already matched the keyword, so telling them apart costs nothing.

Two smaller decisions worth recording:

- **A `via` arrow never falls back to a looser channel.** Naming the route is a
  stronger claim than drawing the arrow, and falling back on failure would
  throw away the localized message, which is the only thing this shape has that
  the other two do not.
- **The walk stops at the first hop that fails**, rather than continuing to
  find a hop that does not exist. `handle_logging → vanished` reports
  `handle_logging`, because that is where the route as written stopped being
  true.

## Markers in the source, measured and deferred

The third chain shape put the name in the code — a comment on the line before
a declaration, `// diagram: logging`, with the box saying `#concept:logging`
and the member set derived by scanning the files the box's anchors already
name (never the repo; same confinement, same caps). It worked: scan cost
0.09 ms, verdicts identical to membership, and one thing membership cannot do
— rename `handle_logging → emit_log` and the marker travels with the code, the
set re-derives, and the true arrow stays quiet with zero diagram edits.

**Deferred anyway, filed separately.** It is the only mechanism in this design
that puts anything into someone else's source. Every other claim — `ref`,
`refs`, `@declared`, `@used`, `via`, membership — lives in the `.excalidraw`
file, and "DiagramOS touches no lines of your code" is a property worth more
than rename convenience. And rename convenience is all it buys: the tool
already accepts rename-breaks-the-claim everywhere else. Move a file and
`missing-file` goes loud; `/update-diagram` fixes it. Concept members do not
get an exception, and the `Stop` hook fires in the same turn as the rename, so
the fix lands while the author is still there.

### The crate/npm alternative, measured

Asked whether a language-native form — `#[diagram::part_of("logging")]` from a
crate, a decorator from an npm package — would beat comments, since comments
are intrusive and a format change would invalidate every annotation. Measured
on 2026-08-16 with a dependency-free proc-macro crate (`rustc` 1.93.0) and this
repo's own `tsc` 5.9.3:

| position | Rust attribute | TS decorator |
| --- | --- | --- |
| plain function | ok | **`TS1206: Decorators are not valid here`** |
| `export const` | ok | **`TS1206`** |
| class / method | ok | ok |
| `macro_rules!` definition | ok | — |
| item inside another macro's body | ok | — |
| statement inside a function body | **`E0658`** | **not valid** |

Rust does well. TypeScript does not: decorators attach to classes and class
members only, and this repo's `src/` is 40 `export function`, 15
`export async function`, 9 `export const`, 54 types and interfaces, and
**2 classes** — so a decorator package could annotate 2 of 120 exports here. A
comment goes on any line in any language.

**The format-rot argument runs the other way.** Renaming
`#[diagram::part_of]` to `#[diagram::member]` stops every annotated file from
*compiling*, and the target repo is broken until it upgrades in lockstep.
Changing the comment convention leaves an unrecognised comment: the concept
loses a member, the diagram side goes loud, and the code still builds and
ships — the silent direction, same as everything else here. The asymmetry that
decides it: the comment parser lives in this repo, versioned with the checker,
so it can accept every form ever shipped for the cost of one more regex. A
crate's API lives in the target's lockfile, where we control nothing.

The one thing a crate genuinely adds is the compiler catching a misspelled
marker — and the deterministic layer already catches that, because a typo'd
marker means the concept loses a member and the diagram flags.

So: if markers are ever built, they are comments. The crate is refused
permanently, not deferred.

## Refused, with reasons

- **Auto-applying `@used` to plain `#symbol` anchors.** Measured: 35 of 121
  would flag, 29% noise. This is the load-bearing rejection; everything loud
  in this design is loud only because this inference is refused.
- **Count floors** (`@used>=28`). A consolidation refactor flags forever;
  observed counts are observations, and observations rot (brief hard part 5).
- **A usage graph for Rust** (rust-analyzer or any parser). Build step,
  dependency, hundreds of milliseconds — three constraint violations. The
  `refs` list is the author-scoped substitute and costs only the files the
  box already names.
- **Auto-widening TS usage search to importers.** Reverse imports need a repo
  scan — the security surface the glob design just closed. The 31-of-35
  recovery number shows a board-neighborhood tier could exist *on-demand*
  someday; it is not v1 and not per-turn.
- **Flagging test-only usage.** `evaluateDiagramPlan` is real and test-only;
  calling it unused would be a judgment about what tests are for, which is not
  a lexical fact. Silence, per the house default. An author who wants the
  distinction can anchor the claim in a non-test file.
- **Shelling out to `tsc` / `cargo check` / the tests, even on-demand.** It
  answers "used correctly", which is the one thing this check honestly cannot
  — but it duplicates the editor and CI, needs a toolchain present, takes
  seconds, and its failures would arrive blamed on the diagram checker. Out of
  scope, permanently, and said here so it is not re-proposed.
- **Any language table without a corpus to measure it against.** Python and Go
  tables are one row each — when a diagram in those languages exists to
  measure on. Shipping them unmeasured is how quiet wrongness accumulates.
- **A `kind` field on boxes** (`function` / `file` / `concept`). The anchor
  grammar already encodes it, so a declared kind would be a second copy of the
  same fact — and two copies drift, which is the disease this whole tool
  treats. The one kind the anchors cannot express, "deliberately not code",
  already has a home in `state: external` and `describes: concept`.
- **A shared-caller channel for function-level arrows.** Measured above:
  `ready` names both `register` and `log_line`, so the channel blesses the
  false arrow it exists to catch. The file-level shared-importer channel stays;
  its function-level analog does not get built.
- **Automatic transitive closure, at any depth.** The chain section's whole
  point: every extension of trust is a *written* claim (a member or a `via`
  hop). A checker that walks the graph on its own re-imports the
  measured whitewash, just deeper. One hop is the ceiling forever; depth comes
  from names, not walking.
- **A crate or npm package for markers, in any role.** Measured above: a
  decorator reaches 2 of this repo's 120 exports, and a marker format change
  becomes a compile error in the target project rather than a quiet loss on the
  diagram side. Comments fail safe and their parser ships with the checker.
  Refused permanently, not deferred.
- **Markers in v1 at all.** Deferred to its own issue with the measurements
  intact. They are the only mechanism that writes into someone else's source,
  and all they buy over membership is surviving a rename without a diagram
  edit — an exception the rest of the tool does not grant.

## Order of work, if this ships

1. Assertion parsing (`@declared`, `@used`, whitelist, route exemption,
   `unresolvable-ref` on garble) — loud only on syntax errors, no new checks.
2. The TS/JS stripper + declaration table (the table already exists in
   `docs/ref-design.md` step 3 terms), behind the feature flag; fixtures from
   the eleven-variant table, ported to TS.
3. The Rust stripper + table, with the eleven variants as committed fixtures.
4. Skill and tool-description text teaching the model when to write the
   claims — a box that *means* "this feature is wired in" should say
   `@declared+used`; a box that means "this exists" should not. The census
   number (29%) is the reason the guidance matters.
5. Function-granularity arrows: body extraction on the stripped text, the
   direct and one-hop channels, engaged only when both endpoints carry symbol
   anchors. Rides the existing `edges` flag and the existing
   "worth a look" wording; the eleven-variant fixtures gain the seven-arrow
   table.
6. Concept membership needs no code — it is skill-text guidance: a concept
   box's refs list its interface, not just its implementation.
7. `via` on arrows (customData, checked pairwise, `broken-chain` finding) and
   the self-support rule (`unsupported-member`). Fixtures from the chain
   experiments: the intact chain and the deep cut.
8. The annotate/audit command: the model walks the current flags and coverage,
   proposes members and via-paths, a human approves, and the deterministic
   layer holds the result. This is the ratchet that grows coverage without
   ever putting the model in the per-turn path.

Not measured, and worth saying: one 640-line file with hand-made variants is
not a corpus; no committed diagram carries an `@` anchor yet, so real-world
noise is unmeasured until someone draws one — which is why every new finding
sits behind its own flag.
