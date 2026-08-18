# Brief: is a diagram better than a `.md` file as agent context?

**Status: measured 2026-08-18, answered — complement, not replacement. #52.**

Everything measurable below was measured in this repo on 2026-08-18; where
something is opinion it says so. If a claim here disagrees with the code, trust
the code and fix this file. The cost half is reproducible:

```
npx tsx scripts/audit-context.mts
```

The accuracy half was three agent runs, described below, and **it was run once**.
Treat it as a strong hint, not a statistic.

## The answer in one paragraph

**The board lost.** It is about 38x cheaper than the prose and it found the one
file everybody finds anyway. The half of the work that is easy to miss — the
reporting path — is invisible on the board, because the files that do that job
have no box. The agent given both sources said so unprompted: everything past
the first file came from the prose. So a board is not a replacement for
`AGENTS.md` and `docs/`, and on this evidence it is not close. What it is good
at is different, and worth keeping: see "What the board was actually better at".

## What was measured

**The task.** "I want to add a new kind of drift finding — a new category of
problem the drift checker can report about a diagram. Where would I add it, and
what else would need to change for it to work end to end?"

Chosen because it needs a map rather than cleverness, and because the correct
answer spans two subsystems, only one of which is drawn.

**The three arms.** Same question, same output format, each forbidden from
reading anything outside its own context:

| arm | context | ~tokens |
| --- | --- | --- |
| prose | `AGENTS.md`, `README.md`, `docs/*.md` | 38,757 |
| diagram | one `read_diagram` on `board-internals.excalidraw` | 1,015 |
| both | both of the above | 39,772 |

**Ground truth**, established by reading the code, not by asking a model:

1. `src/engine/drift.ts` — the `DriftKind` union and the detection site.
2. `scripts/check-drift.mjs` — `target()` switches on kind; a new kind silently
   falls through to a bare filename. **This file has no box on any board.**
3. A test — `tests/engine-drift.test.ts`, `tests/check-drift-cli.test.ts`.

Plus two traps, both of which a plausible answer walks into:

- `src/mcp/server.ts` needs its **tool description** updated and nothing else.
  The handler spreads findings generically, so claiming the response shape
  changes is wrong.
- `REASONS` and `EDGE_REASON` in `scripts/check-drift.mjs` are **dead code** —
  declared, never read. Claiming they must be updated is wrong.

## The result

| | prose | diagram | both |
| --- | --- | --- | --- |
| `drift.ts` | yes | yes | yes |
| `scripts/check-drift.mjs` | yes | **no** | yes |
| tests, by real path | yes | no — guessed `src/engine/drift.test.ts` | yes |
| trap: `server.ts` structural | **failed** | **failed** | **failed** |
| trap: dead `REASONS` | avoided | avoided | avoided |
| files named | ~20 | 5 | ~20 |
| ~token cost | 38,757 | 1,015 | 39,772 |

Three things in that table matter more than the ticks.

**The diagram missed the reporting half, and the "both" agent said why.** Its own
words: *"Answering from the diagram alone I would have said `drift.ts`,
`graph.ts`, `server.ts` and stopped, missing the whole reporting half, which is
where most of the work actually is. Everything past step 1 came from the prose."*
That is the finding. The board points at the module that owns the concept and
stops, because pointing at the module that owns the concept is all a 12-box board
of the MCP path can do.

**Every arm failed the same trap.** All three claimed `check_drift`'s response
shape must change. Prose did not prevent it and the diagram did not cause it.
Neither kind of context stops an agent inventing a plausible seam — which is an
argument against believing any of this too hard, in either direction.

**Cheap is not the same as wrong.** The diagram named 5 files and 4 were
defensible; the prose named ~20 and a good third were speculative
(`skills/diagram/SKILL.md`, `scripts/build-cli.mjs`, `.claude/settings.json`).
Precision was not the diagram's problem. Coverage was.

## What the board was actually better at

Worth recording, because it is the thing prose cannot do and it did not show up
as a tick in the table.

The diagram-only agent could not name `scripts/check-drift.mjs`, but it
**correctly deduced that the file existed and that the board was missing it**:
*"a report/formatter module that isn't on the diagram … the diagram shows no such
node, which means either it's inside `drift.ts`/`server.ts`, or the diagram is
incomplete here."* It knew the shape of its own blind spot. The prose agent, by
contrast, could not confirm the notice renderer's path and said so — an equivalent
honesty, arrived at differently.

A board's boxes are a closed set, so "there is no box for this" is a statement an
agent can make. Prose has no such edge; nothing in `docs/` announces what it
omits. That is a real property and it is the one worth building on.

## The cost numbers

From `scripts/audit-context.mts`, 2026-08-18:

```
  board-internals: 12 nodes, 12 of them anchored at a real path.
  diagram as context      1015 tokens
  prose, floor            2945 tokens   2.9x the diagram
  prose, everything      38757 tokens   38.2x the diagram
```

The honest denominator is the middle one. `AGENTS.md` + `README.md` are what load
unprompted; the other 36k tokens only load if an agent goes looking. Against that
floor the board is 2.9x cheaper, not 38x — and `AGENTS.md` is 34 lines of house
rules that do not overlap with a board at all. **They are not substitutes. The
diagram competes with `docs/`, not with `AGENTS.md`.**

Two side results from the same run:

- **The `read_diagram` geometry doubt in #52 is already fixed.** `src/mcp/server.ts`
  strips `x`/`y`/`width`/`height` before the response crosses to the model. Had it
  not, the cost would be +12% — not the "doubles" the tool description claims.
  That description overstates it, and also says edges carry geometry, which they
  never have. A small honest fix, not filed here.
- **Raw file versus semantic payload is 15–16x on every board in the repo.** An
  agent that `cat`s an `.excalidraw` pays 16x for the same graph. That is the
  biggest single number in the whole measurement and it is already banked.

## What this does not settle

- **n=1.** One task, one model, one run per arm. A different task — "why is it
  built this way", "what talks to what" — would plausibly favour the board, and
  the task here was picked to need a file map, which is prose's home ground.
- **The prose arm had a design document for exactly this subsystem.**
  `docs/drift-check.md` is 565 lines about the drift checker. That is a large
  advantage and most repos do not have one. Read the prose win as "prose plus a
  good design doc beats a partial board", not "prose beats boards".
- **Measured on the repo's only anchored board, which is also its best.**
  `board-internals` is 12/12 anchored and clean. It is also the only board here
  with a single ref on it — the `refs` column of the harness reads 12 for it and
  0 for all six others. A scruffier board would do worse, not better.

## The follow-on — diagnosed here, fixed in the same branch

**Coverage was blind to standalone entry points.** `check_drift --coverage`
reported `unrepresented` modules by walking the imports of files that already
had a box. That direction grows the board outward, so it only ever reached code
*downstream* of a box. An entry point is upstream — it imports the boxes and
nothing imports it back — so no amount of drawing would ever surface one.
`scripts/check-drift.mjs`, the single most important file for this task, was
structurally unreachable, and coverage's 10 suggestions were every one of them a
`src/engine` or `src/viewer` leaf.

That was the concrete reason the board lost, so it is now fixed. Coverage runs
both ways round the import graph: a module the boxes lean on still arrives with
`importedBy`, and an entry point that calls in arrives with `imports` instead.
The relevance bar is unchanged — a candidate still has to have a real import
edge to a box, so relevance stays inherited rather than invented. Only the
search changed, from following edges to enumerating source files and keeping the
ones with such an edge.

Two things fell out of building it:

- **Tests had to be excluded, or the signal drowned.** Left in, test files were
  12 of 20 rows on this repo's board — a suite importing four boxes is the suite
  working, not a box anybody forgot. That is the kind of noise that gets a
  suggestion switched off along with the quiet checks around it.
- **It costs nothing measurable here.** 60 source files; `--coverage` times the
  same as a bare run. The per-turn hook does not pass `--coverage` and is
  untouched.

`board-internals` now reports six entry points, every one a genuine surface of
this tool, `scripts/check-drift.mjs` among them.

**What this does and does not buy.** The board is not better yet — it still has
12 boxes and still has no box for the CLI. What changed is that the instrument
can now *say so*. "12/12 anchored and clean" still means every box that exists
is honest; it now also comes with a list of the boxes that should exist. Re-
running the three arms before those boxes are drawn would just reproduce the
same loss, so the real re-measurement waits on the drawing.

## Recommendation

1. **Do not replace `docs/` with a board.** On the one task measured it loses,
   and the agent holding both sources attributes almost everything to the prose.
2. **Keep the board for what only it can do** — the checkable half. Anchors that
   resolve, states that distinguish planned from built, and a closed set of boxes
   that lets an agent notice its own gap. None of that is a token-cost argument.
3. ~~Fix coverage's blind spot before re-running this.~~ Done, above.
4. **Draw the surfaces coverage now names, then re-measure.** The cost table is
   the argument for doing it: the largest board here is 33 nodes and 2,854
   tokens, so boards covering the check path, the CLI and the live board would
   together still cost under a tenth of the prose. The board did not lose because
   a diagram is a weak way to carry structure. It lost because twelve boxes were
   asked to describe a repository and only described the MCP path.
