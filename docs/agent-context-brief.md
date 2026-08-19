# Brief: is a diagram better than a `.md` file as agent context?

**Status: measured twice on 2026-08-18, answered — complement, not replacement. #52.**

Everything measurable below was measured in this repo on 2026-08-18; where
something is opinion it says so. If a claim here disagrees with the code, trust
the code and fix this file. The cost half is reproducible:

```
npx tsx scripts/audit-context.mts
```

The accuracy half was agent runs, described below. **The first run was three
arms, once. The second was four arms, once.** Two runs of n=1 is not a
statistic. Treat all of it as a strong hint.

## The answer in one paragraph

**A board does not replace `docs/`, and after redrawing it still does not.**
What changed between the two runs is worth more than the verdict: the first
time, the agent holding both sources said every file past the first came from
the prose. After four boards were drawn instead of one, the same arm attributed
five paths to the boards alone and could not have got them from the prose at
all. So the board went from carrying nothing unique to carrying a real share.
It is still worse than prose at one thing — naming a test file — for the plain
reason that no board draws tests. And on this run the prose was, for the first
time, **actively wrong** about something the board simply did not claim.

## What was measured

**The task**, identical across both runs. "I want to add a new kind of drift
finding — a new category of problem the drift checker can report about a
diagram. Where would I add it, and what else would need to change for it to work
end to end?"

Chosen because it needs a map rather than cleverness, and because the correct
answer spans two subsystems, only one of which was drawn at the time.

**Ground truth**, established by reading the code, not by asking a model:

1. `src/engine/drift.ts` — the `DriftKind` union and the detection site.
2. `scripts/check-drift.mjs` — `target()` switches on kind; a new kind silently
   falls through to a bare filename.
3. A test, by real path — `tests/engine-drift.test.ts`,
   `tests/check-drift-cli.test.ts`.

Plus two traps, both of which a plausible answer walks into:

- `src/mcp/server.ts` needs its **tool description** updated and nothing else.
  The handler does `for (const finding of report.findings) findings.push({ board, ...finding })`,
  so a new kind needs no structural change. Claiming the response shape changes
  is wrong.
- `REASONS` and `EDGE_REASON` in `scripts/check-drift.mjs` are **dead code** —
  declared, never read. Claiming they must be updated is wrong.

## Run one — one board, and it lost

Three arms, each sealed to its own context.

| | prose | diagram | both |
| --- | --- | --- | --- |
| `drift.ts` | yes | yes | yes |
| `scripts/check-drift.mjs` | yes | **no** | yes |
| a test, by real path | yes | no — guessed `src/engine/drift.test.ts` | yes |
| trap: `server.ts` structural | **failed** | **failed** | **failed** |
| trap: dead `REASONS` | avoided | avoided | avoided |
| files named | ~20 | 5 | ~20 |
| ~token cost | 38,757 | 1,015 | 39,772 |

The diagram missed the reporting half and the "both" agent said why, unprompted:
*"Answering from the diagram alone I would have said `drift.ts`, `graph.ts`,
`server.ts` and stopped, missing the whole reporting half, which is where most
of the work actually is. Everything past step 1 came from the prose."*

That sentence is the reason for everything below it.

## What was fixed in between

Two things, in this order.

**Coverage was blind to standalone entry points.** `check_drift --coverage`
reported `unrepresented` modules by walking the imports of files that already
had a box. That direction grows the board outward, so it only ever reached code
*downstream* of a box. An entry point is upstream — it imports the boxes and
nothing imports it back — so no amount of drawing would ever surface one.
`scripts/check-drift.mjs`, the single most important file for this task, was
structurally unreachable. Coverage now runs both ways: a module the boxes lean
on arrives with `importedBy`, an entry point that calls in arrives with
`imports`. The relevance bar is unchanged — a candidate still needs a real
import edge to a box — so relevance stays inherited rather than invented. Test
files are excluded from the upstream pass; left in they were 12 of 20 rows, and
a suite importing four boxes is the suite working, not a box anybody forgot.

**Then the surfaces it named were drawn.** Four new boards, 42 boxes, every one
anchored, every arrow the checker can back:

| board | what it covers | nodes | ~tokens |
| --- | --- | --- | --- |
| `drift-check` | the check path, hook to notice | 14 | 1,166 |
| `live-board` | the board server and the browser canvas | 11 | 955 |
| `picture-path` | the example board and PNG rendering | 9 | 819 |
| `published-cli` | what ships as `diagramos` | 8 | 481 |

Files with a box went from 12 to 26. `npm run check:drift` reports 11 boards,
54 refs, 49 arrows checked, nothing drifted.

## Run two — four boards, and it splits the work

Four arms this time. The old single board was re-run unchanged as a control, to
check that the first result reproduces rather than having been a bad draw.

| | old board (control) | all boards | prose | both |
| --- | --- | --- | --- | --- |
| `drift.ts` | yes | yes | yes | yes |
| `scripts/check-drift.mjs` | **no** | **yes** | yes | yes |
| a test, by real path | no | **no** | yes | yes |
| trap: `server.ts` structural | failed | failed | failed | failed |
| trap: dead `REASONS` | avoided | avoided | avoided | avoided |
| files named | 4 | 7 | 12 | 16 |
| ~token cost | 1,015 | 4,436 | 38,757 | 43,193 |

**The control reproduced.** Given only `board-internals`, the agent again named
`drift.ts` and again could not find the reporting half — and again said so in
its own words: *"Any report/formatting layer. I can't confirm whether drift
findings are rendered into text somewhere separate from `drift.ts`. If one
exists, it's a fifth file and it isn't in my context."* The first run was not a
fluke, and the redraw is what moved the number.

**The board arm went from 1 of 3 to 2 of 3**, and named the missing file for the
right reason: *"the CLI that drives the check and owns `render`, the function
that prints the notice. A new category is invisible until `render` prints it."*

**The remaining miss is structural, not a tuning problem.** The board arm still
cannot name a test, and knew why: *"There is certainly a drift test somewhere;
the boards just don't draw it."* No board in this repo draws a test file, so no
board can name one. That is a drawing decision, not a limit of diagrams.

## What the boards carried that the prose could not

The "both" arm was asked to attribute every file it named. This is the part that
changed most between runs.

**Boards only** — five paths the prose arm did not produce:

- `scripts/lib/box.mjs` — *"Prose talks about the notice being a box but never
  gives this path."* The prose arm listed this as an explicit unknown: *"The
  four-line box … clearly lives in a module of its own … but none of the nine
  files names that source file."*
- `src/engine/assert.ts`, `src/engine/body.ts`, `src/engine/parse.ts` — the
  prose mentions these bare, without directories; the boards carry the full
  paths as refs.
- `.claude/settings.json` — the hook that runs the check every turn.

**Prose only** — the four test files, `commands/`, `skills/diagram/SKILL.md`,
`hooks/drift.sh`. Every one of these is a file no board draws.

Compare that against run one's *"everything past step 1 came from the prose."*
The split is now real in both directions.

## Where the prose was wrong and the board was not

`docs/drift-check.md` documented the `check_drift` result as
`{ missing[], unrepresented[], edgeMismatches[], clean }`. The tool has not
returned that shape in some time — it returns `{ boards, clean, findings, edges, … }`,
and `edgeMismatches` appears nowhere in the source at all. **Both prose-reading
arms confidently reproduced the dead shape**, and one built its whole
recommendation for `server.ts` on top of it.

The boards record no field names, so they made no claim here and got nothing
wrong. That is not the board being clever; it is the board being narrower. But
it is the exact failure #52 predicts — prose rots silently and nothing checks
it — caught in the wild, by accident, during a measurement of something else.

Fixed in the same commit as this file. **The arms ran against the pre-fix text**,
so the run above is not reproducible against the current tree without reverting
that line.

## Both traps, both runs

**Seven arms out of seven have now failed the `server.ts` trap.** Prose does not
prevent it, the diagram does not cause it, more diagram does not help. Every arm
claimed the `check_drift` response shape must grow. Neither kind of context
stops an agent inventing a plausible seam, and that is an argument against
believing any of this too hard, in either direction.

Nothing has ever failed the dead-code trap.

## The cost numbers

From `scripts/audit-context.mts`, 2026-08-18, after the redraw:

```
  board-internals.excalidraw    12 nodes,  12 anchored     1015 tokens
  drift-check.excalidraw        14 nodes,  14 anchored     1204 tokens
  live-board.excalidraw         11 nodes,  11 anchored      955 tokens
  picture-path.excalidraw        9 nodes,   9 anchored      819 tokens
  published-cli.excalidraw       8 nodes,   8 anchored      481 tokens
                                                    -------
  every anchored board                          4474 tokens

  prose, floor            2945 tokens   0.7x the boards
  prose, everything      38838 tokens   8.7x the boards
```

These are current-tree figures and they are **not** exactly what the arms were
handed. Run two used 4,436 board tokens and 38,757 prose tokens; since then one
verified arrow was added to `drift-check` (+38) and the stale `check_drift`
shape in `docs/drift-check.md` was corrected (+81). Neither moves any ratio.

The harness now sums every anchored board rather than quoting one. A repository
is documented by all of its boards the way it is documented by all of its prose,
and comparing one board against the whole of `docs/` flattered the board while
it was losing anyway.

**The cheapness argument got weaker, and should be dropped.** Four boards are
still 8.7x cheaper than every tracked `.md`, but they are now *1.5x more
expensive* than the honest floor — `AGENTS.md` + `README.md`, the 2,945 tokens
that load unprompted. Boards are no longer free. The case for them has to rest
on the checkable half, not the price.

Two side results, unchanged from run one and still true:

- **The `read_diagram` geometry doubt in #52 is already fixed.** `src/mcp/server.ts`
  strips `x`/`y`/`width`/`height` before the response crosses to the model. Had
  it not, the cost would be +12% — not the "doubles" the tool description
  claims. That description overstates it, and also says edges carry geometry,
  which they never have.
- **Raw file versus semantic payload is 12–16x on every board.** An agent that
  `cat`s an `.excalidraw` pays that multiple for the same graph.

### Price, revisited (2026-08-18)

The paragraph above stands as what was measured on the day, and the arms above
were handed the payload it describes. It no longer describes what the tool
sends.

Asking where the tokens actually went turned up an answer that had nothing to
do with diagrams. Of a `read_diagram` response, **58% was packaging**: `shape`
said `rectangle`, `provenance` said `recorded`, `state` said `built`,
`endpoints` said `declared` — the same four words repeated on every box and
every arrow of every response — plus an `elementId` only an edit needs.
`projectGraph` now omits a field sitting at its default, the read_diagram
description states each default once per session instead, and `applyEdits`
resolves semantic node ids so nothing needs the withheld handle.

| | before | after |
|---|---|---|
| the same six anchored boards | 4,917 tokens | **2,060** |
| against the prose floor | 1.5x more | **1.6x less** |
| against every tracked `.md` | 8.0x less | **19.2x less** |

The shipped total reads 2,100 rather than 2,060 because the same change added a
`projection.ts` box to `board-internals`: a module inside a subsystem this repo
draws should be drawn. Its one arrow is import-backed and checked.

So the cheapness argument is back, and this time it is not doing any work it
should not: nothing was dropped that a caller cannot ask for, and the recorded
accuracy result above is untouched. The honest framing is that boards were
never expensive — the envelope was.

One unmeasured effect, stated as the guess it is: a lean payload reads
differently. A `planned` box is now the only annotated thing on a board of
plain ones, where before it was one `"state"` among sixty. Whether that helps
an agent is exactly the kind of claim this brief exists to refuse until it is
graded, and it has not been graded.

The same refusal applies in the other direction and is the reason for
`omittedWhenDefault`. The fields are not equally safe to drop, and pricing them
separately across the 61 nodes and 63 edges on these boards shows why:

| omitted field | cost | carries meaning? |
|---|---|---|
| `elementId` | 986 tokens (19.8%) | no — a handle, not a fact |
| `provenance` | 744 (15.0%) | **yes** — recorded vs inferred |
| `state` | 484 (9.7%) | **yes** — built vs planned vs external |
| `endpoints` | 362 (7.3%) | **yes** — how much to trust an arrow |
| `shape` | 300 (6.0%) | barely |

A quarter of the payload was `elementId` and `shape`, which no reader reasons
with. The other three do carry meaning, and on these boards they were carrying
almost none of it: across 61 nodes and 63 edges the only non-default values are
three `external` boxes and one ellipse. Zero `inferred`, zero `bound`, zero
`nearest`, zero `planned`.

That cuts both ways, and the second way is the risk. A board where everything
agrees with every default now mentions `provenance`, `state` and `endpoints`
**nowhere at all** — so a reader of the payload cannot learn from it that those
fields exist, and an agent that does not know a concept exists cannot think to
ask about it. Stating the defaults in the tool description does not fix that: it
relies on the description having been read and retained.

So every response opens with `omittedWhenDefault`, naming each field and what
its absence means. It costs ~27 tokens per board against the ~1,590 the fields
cost spread across every item, taking the saving from 58% to 55%. Three points
to keep the vocabulary in the data was not a close call.

### Does the trim cost comprehension? (2026-08-18, graded)

The paragraph above said this was ungraded. It has now been run, and the answer
is no — with one honest caveat that limits how far it generalises.

Four arms, built from one synthetic graph by
`scripts/bench-default-fields.mts` so they differ only in packaging. Synthetic
because a sealed agent handed a real board could answer from this repo's code
instead of from the payload.

| arm | payload | where the defaults are explained |
| --- | --- | --- |
| verbose | 1,050 tok | nothing is omitted |
| lean | 493 | tool description enumerates them |
| legend | 546 | tool description points at `omittedWhenDefault`, which is in the payload — **what ships** |
| naive | 493 | **nowhere** — the control |

Two sealed runs per arm, eight runs. Four questions, ground truth written by
hand first. Three of them have a default value as the answer — *which boxes are
not built yet* (none), *which were hand-drawn and might be wrong* (none), *is
this arrow precise or a positional guess* (precise). The fourth asks the same
things about a board whose values are non-default, as a control on the control.

**32 of 32 answers correct. Every arm, every question. Nothing was wrong and
nothing said "cannot tell".**

The only thing that moved was stated confidence, and it moved perfectly
consistently:

| arm | correct | confidence on the three default-valued questions |
| --- | --- | --- |
| verbose | 8/8 | `certain` 6/6 |
| lean | 8/8 | `certain` 6/6 |
| legend | 8/8 | `certain` 6/6 |
| naive | 8/8 | **`fairly sure` 6/6** |

So: dropping the fields did not cost accuracy, and explaining them bought
*certainty* rather than correctness.

**Two things this does not say, and they matter more than what it does.**

First, **the caveat that limits it.** Both naive runs got there by comparing the
two boards — *"BOARD TWO uses `state:"planned"` when something isn't written
yet, so the absence here is meaningful."* They recovered the convention from a
sibling board that happened to be in the same prompt. That is an artefact of the
test design, not a property of the payload. An agent holding only an
all-default board has nothing to compare against, and that case was not tested.
The naive arm's success is partly the test being generous, and it still only
reached `fairly sure`.

Second, **`omittedWhenDefault` bought no measured gain over the tool
description.** Both reached `certain`. It is kept anyway, and that is a
judgement call rather than a validated one: the description sits far from the
payload in a real session and may not be retained, whereas a legend travels
with the data. The measured cost of keeping it is 3 percentage points of the
saving. Recorded as a choice, not as a result.

**The test is also too easy to discriminate much.** An eight-node board, the
documentation immediately adjacent, and four metadata questions in a row that
cue careful reading. A harder version would separate the documentation from the
payload by a long session, use a board with no sibling to compare against, and
ask the question incidentally rather than as an exam. Read the 32/32 as *no
evidence of harm at this scale*, not as *proved safe*.

### Found by accident: the payload used words the docs never defined

Every arm hedged on exactly one thing — `state: "external"` — and one said why
outright: *"external is not defined in the tool docs I was given; I'm reading it
as third-party."*

It was right to hedge. The `read_diagram` description defined `recorded`,
`inferred`, `declared`, `bound` and `nearest`, and defined **neither `built`,
`planned` nor `external`** — while `omittedWhenDefault` named `built` as a
default without ever saying what a state is. The three agents guessed correctly
from the labels, which is luck, not documentation.

Fixed: the description now says a state is built, planned (drawn as intent, not
written yet) or external (real, and not yours to change).

This is the third time this line of work has turned up documentation making a
claim the code does not support, and the second found purely by accident. That
pattern is now better evidence for #52's premise than any of the deliberate
measurements.

A further ~15 points sits in dropping JSON for a plain-text outline (1,317
tokens). That is **not** free: it flattens multi-line labels and needs escaping
rules. It was measured, not shipped.

## What the redraw broke or could not do

Reported because they are real and neither is fixed.

- **Coverage is per board, and boards do not know about each other.**
  `drift-check.excalidraw` is now told it is missing `scripts/board.mjs`, which
  has a box on `live-board.excalidraw`. Splitting a repository across
  complementary boards makes the suggestion list noisier, not quieter. Only
  `--coverage` is affected, so the per-turn hook is untouched — but this is the
  next thing to fix if boards are going to multiply.
- **The published CLI cannot draw its own shape.** `scripts/diagramos.mjs`
  dispatches with `import(new URL(...))` at runtime, and `build-cli.mjs` names
  its entry points as strings. No static channel — import, shared importer,
  shared route literal — can see either. Drawn honestly, five arrows came back
  as unsupported; the board now ships as a labelled list of eight anchored boxes
  with the dispatch written in the node text and only two arrows. It is the
  weakest of the four for that reason.
- **Test files are excluded upstream but not downstream.** `tests/helpers/excalifont.ts`
  still appears in the `importedBy` direction. Inconsistent; small.

## What this still does not settle

- **n=1, twice.** One task, one model, one run per arm per round. A different
  task — "why is it built this way", "what talks to what" — would plausibly
  favour the board, and this task was picked to need a file map, which is
  prose's home ground.
- **The prose arm has a design document for exactly this subsystem.**
  `docs/drift-check.md` is 565 lines about the drift checker. Most repos do not
  have one. Read the prose result as "prose plus a good design doc", not "prose".
- **"Wins most of the time" is still unmeasured.** That is a claim about a
  distribution and this is two points. It needs a task set — roughly eight real
  questions with ground truth written by hand once — before any further board
  change can be called an improvement rather than a guess.

## Recommendation

1. **Do not replace `docs/` with a board.** Two runs, and prose still names more
   of the ground truth. It also owns the things no board draws: tests, commands,
   skills, hooks.
2. **Stop arguing the cost saving.** Four boards cost more than the prose that
   actually loads unprompted. The argument for a board is that its claims are
   checked and prose's are not — demonstrated above, where the only wrong answer
   about `check_drift` came from the file nothing checks.
3. ~~Fix coverage's blind spot.~~ Done.
4. ~~Draw the surfaces coverage names, then re-measure.~~ Done; that is run two.
5. **Draw the tests, or accept the miss permanently.** It is the one ground-truth
   item the board has never reached, in either run, and the reason is that no
   board has a box for a test file.
6. **Make coverage aware of sibling boards** before drawing any more. Per-board
   suggestions get worse with every board added, and a suggestion list that grows
   noisier as the documentation improves is one somebody switches off.
7. **Build the task set before the next board.** Eight questions, hand-written
   ground truth, all arms re-run. Without it every further change is a guess with
   a good story attached.

## Honest gaps: what a board does not show — 2026-08-18

The recommendation above said "make coverage aware of sibling boards" before drawing more. This session shipped it.

**What shipped:** When `read_diagram` is called on an anchored board, the response now carries `notShown`, a single sentence describing two truths: files related to the board that ARE drawn on a sibling board in the diagram directory (listing board names), and files related to the board that are on NO board in the directory (listing paths, capped at 8). Omitted entirely when there are no gaps, when the board is a concept board, when it has no anchored refs, or when the walk gives up. Always silent on error: a computation failure just means the field is absent, never an exception.

**Measured behaviour on this repo's 12 boards:**
- 82 total unrepresented files across all boards
- 62 (76%) drawn on other boards → now named in notShown (e.g., "13 related files are drawn on other boards (drift-check.excalidraw, live-board.excalidraw)")
- 20 (24%) on no board at all → listed in notShown with paths; deduped across boards that is six files, one of which is `src/engine/gaps.ts` itself — the module shipped today, correctly reported as not yet drawn
- 0 test files appearing (TEST_FILE filter fixed: was only applied upstream, now applies downstream too)

**Cost:** Measured on the real sentences (chars/4): 37–67 tokens per board read, only on the six boards that have gaps, nothing on the six that do not. Against the ~400-token baseline read that is roughly 10–17%. The raw `unrepresented` payload this replaces was priced at ~300–420 tokens and called a covered file "missing" four times in five; the sentence is the deduplicated, sibling-aware reading of the same data. Whether the line actually helps a reading agent is ungraded — the task-set recommendation above still stands.

**Design rules followed:**
- Default ON with cheap guard: coverage computation runs, result is silent when nothing to report
- Degrades gracefully: any error returns undefined (field omitted), never throws
- Engine stays independent of MCP: coverage logic extracted to `boardCoverage()` helper in drift.ts, reused by both checkDrift and computeHonestGaps
- Silence is fallback: field only appears when there are gaps to report
- Covers recommendation #6: sibling awareness built, coverage no longer per-board only
