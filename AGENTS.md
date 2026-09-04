# Board AI agent instructions

How to *report* your work — summaries and PR descriptions — is a separate file:
[CLAUDE.md](CLAUDE.md). Read that before writing either.

This repository is a diagram-driven-development toolkit: an MCP server that gives
a coding agent read/write access to `.excalidraw` files that live in the repo,
plus a live local board for editing them alongside a human.

## Ground rules

- **The file is the source of truth.** Every operation is a read-modify-write on a
  `.excalidraw` file. Never hold diagram state in memory across a session.
- **Never destroy hand-drawn work.** Elements without a `customData` marker were
  drawn by a human. Regeneration replaces only what the engine generated; a
  sketch is a specification, not a draft to be redrawn.
- **Supply meaning, not geometry.** Callers pass nodes and edges. Layout, sizing,
  connector routing, and bindings are the engine's job. If a diagram needs manual
  coordinates, the layout has a bug worth fixing instead.
- **Keep output deterministic.** Ids and seeds are hashed from stable ids so an
  unchanged diagram regenerates byte-identically. Anything introducing randomness
  or timestamps into a board file breaks git diffs and the tests that guard them.
- **Confine every path.** Tool inputs resolve through `src/mcp/paths.ts`, which
  refuses anything outside the workspace root, symlinks included.

## Working on this repo

- Report provenance honestly: `readGraph` marks each fact `recorded` or
  `inferred`, and callers depend on that distinction. Never present a geometric
  guess as a recorded fact.
- Prefer reproducing a bug over reasoning about it. Both wrong diagnoses in this
  codebase's history came from theorising; the fixes came from a probe or a test.
- Assertions should check the thing a user sees. The board sync bug hid behind a
  test that asserted on an HTTP response instead of the rendered canvas.
- A tool that cannot report its own state forces the caller to guess. When a
  failure comes from an agent misusing a tool, first ask whether the tool made
  the truth observable.
- **Before touching a claim word, read
  [docs/claim-vocabulary.md](docs/claim-vocabulary.md).** It carries the part
  that does not fit in a header: which words may say *wrong* and on which of
  three footings, why two of them point the opposite way from the other two,
  what each language has earned the right to accuse about, and the six times a
  measurement contradicted the design. Four of those six were found by
  building one word or one reader rather than by reviewing the plan.
- **Before writing a reader that matches tree-sitter node types, read
  [docs/reading-a-grammar.md](docs/reading-a-grammar.md).** One reader made the
  same mistake four times in a sitting, three of them while fixing it, and every
  instance was a hand-written list of node names that one language spelled
  differently. It never throws — it produces a number that is wrong in one
  language and right in the rest, which reads as a finding about that language.
  Read the *field*, and where there is none read the structure: an operator
  token is anonymous, so its type is its own text.
  which (word, language) pairs have earned the right to accuse and which have
  not, and the times a measurement contradicted the design. Most of those were
  found by building one word or one reader rather than by reviewing the plan --
  including the two empty squares on that grid, which nobody saw until the
  squares had to be filled in one at a time.

## Finishing a piece of work

**Every issue carries a definition of done, and every item on it is something a
person could watch happen.** Not "the reader handles `Self`" — that is a
description of code. "A `-> Self` constructor no longer goes red on a correct
board" is the same change stated as the thing that stopped being wrong, and the
difference is that one of them can be checked by somebody who has not read the
diff.

Four items, and #193 is the worked example of all four:

1. **The bad outcome is gone**, written the way the person who hit it would
   describe it.
2. **A test per shape.** Not per code path — per *distinct way the thing occurs
   in real source*. `Self` appears inside `impl Foo`, inside `impl<T> Foo<T>`,
   and in a trait default method, and those are three different problems wearing
   one word. A single test on the easy shape is how a fix ships half-done and
   reads as finished.
3. **The measurement re-run, with the cost on the record.** Whatever the fix
   spends — a higher refusal rate, an answer withheld more often — goes in the
   issue as a number, per language. A fix whose cost nobody wrote down cannot be
   argued with later.
4. **The thing that found it now shows it fixed.** If a probe or a script
   surfaced the bug, name the command and the number it should print. A bug
   found by hand and fixed by hand is a bug that comes back.

An item nothing can observe is not an item. Delete it rather than tick it.

### Write the failing test first, one at a time

The test that reproduces the bad outcome comes before the fix, and it must fail
for the stated reason before anything is changed — a test that passes on the
unfixed code is testing something else, and you will not find that out later.

**One test, one fix, repeat.** Writing every test and then every fix produces
tests of imagined behaviour: they end up asserting the shape of things rather
than what a person sees, and they survive changes that break the product. Each
test should be written knowing what the last one taught you.

This is also why item 2 above is per shape rather than per branch. Shapes come
from reading real source; branches come from reading your own diff.

### The measurement gate, which outranks all of this

**Nothing new may say "wrong" until a script has measured how often its reader
is mistaken, against a referee that shares no machinery with it.** A false
accusation is not recoverable by being right afterwards, which is the whole
argument of `licence.ts` and the reason `needs.ts` is written almost entirely as
reasons not to answer.

The pattern is `scripts/measure-*.mts`: count the shape one way, count it again
by a completely different mechanism, and report the disagreement. It is not
ceremony. #169's measurement found three reader bugs that no amount of reasoning
would have, two of them false-red generators. The referee in
`measure-vocabulary.mts` found three more in its own census on the first run,
one of which was #169's bug repeated by somebody who had read that file the same
hour.

A word that confirms and stays quiet needs no licence. A word that accuses needs
a number first, and the number goes in the repository where it can be argued
with.

### Reading a number, which is where the gate is usually lost

The gate is about producing numbers. These two rules are about consuming them,
and both were broken in one sentence of one summary, which is why they are here.

**Check that a number is a measurement before you quote it.** A script that
prints `the corpus carries 0 @feeds arrows` may be counting arrows, or it may be
a `console.log` somebody wrote by hand when it happened to be true. That one was
the second kind: `measure-dataflow.mts` reads no boards at all. It was quoted
into an issue as a finding, and a recommendation was built on top of it, before
anybody opened the file. If you did not see the line that computes it, you have
read a claim and not a number.

**A zero has two causes and they look identical.** The thing did not happen, or
nothing could have made it happen. Before concluding anything from an absence,
ask what would have had to occur for the count to be non-zero, and check whether
it had the chance.

The example worth remembering: `@holds`, `@builds` and `@calls` appear on zero
boards. Read as preference, that says nobody wants them. In fact every board
here predates the words, and no board has been redrawn since. The zero is a fact
about drawing dates. Reading it as a verdict on the vocabulary -- and then
recommending against confirm-only words on that basis -- is the shape of the
mistake, and it is easy to make because the number is real, the source is this
repository, and it points somewhere convenient.

This is the same error the gate exists to prevent, one step later. The gate stops
a reader accusing on evidence it does not have. Nothing stops a person doing it
from a table, so it has to be a habit: **name the mechanism that would have made
the number different, or do not draw the conclusion.**

## Running the tests

`npm test` is a three-minute command. It is the gate before you hand work over,
not a thing to reach for after every edit — a session that runs it eight times
has spent half an hour watching files it never touched.

- **While you are working, run the files you are working on.** `npm run
  build:cli` once, then `npx vitest run tests/<file>.test.ts` for as many
  targeted runs as you like. The build is what `pretest` does; without it four
  files fail on a stale `out/cli` and the failures look like real ones.
- **Run the whole suite once**, when the change is finished.
- **`npm run test:e2e:board` needs `npm run build:viewer` first**, or it tests
  the last bundle instead of yours. Two minutes, and it drives a real browser —
  worth it for anything touching `src/viewer`, wasted on anything else.

### A red suite is not always a broken change

Several sessions share this checkout and its worktrees, and vitest saturates the
machine. Under that load the 30-second timeout in `vitest.config.ts` starts
firing on files that pass alone: a run measured at 93 seconds idle took 340 with
four other vitest processes going, and reported eleven failures, every one of
them a timeout in a file the change never touched.

So before blaming your change, look at *how* it failed. `Test timed out in
30000ms` in unrelated files is the machine, and re-running costs three more
minutes to learn the same thing. An assertion failure is yours. If you genuinely
cannot tell, run the one suspect file alone rather than the suite again, and say
plainly in your summary what you ran and what you saw.
