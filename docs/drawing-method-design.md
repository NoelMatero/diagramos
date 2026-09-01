# Design: a method for drawing a diagram, not a bigger dictionary

**Answers the open question in #186.** That issue measured that this toolkit has
2,030 lines telling an author what every field *means* and nothing telling them
how to turn a repository into a board, deliberately left no proposal, and named
three things to settle first. This is the answer to all three, with the
measurements behind it. Every number here comes from `npm run measure:survey`, so
it can be re-run and argued with.

**Status: built.** `src/engine/survey.ts`, `survey_scope` in the MCP server, the
procedure at the top of `skills/diagram/SKILL.md`, and 33 tests across
`tests/engine-survey.test.ts`, `tests/mcp-server.test.ts` and
`tests/authoring-guidance.test.ts`. `npm run measure:survey` reproduces every
number below.

## The finding, which is not the one the issue expected

#186 reads as a documentation gap: 553 lines of dictionary, no procedure, so
write the procedure. That framing is wrong, and following it would have produced
a sixth document nobody reads.

**Every fact needed to decide the shape of a board already exists in this engine,
and every one of them is only reachable after a board exists.**

| the decision a session invents | the engine already knows | reachable only via |
| --- | --- | --- |
| how many boxes fit | `viewable.ts` (#183/#185) | a graph, i.e. after drawing |
| what the board omits | `boardCoverage`, `coverage: true` | a board with boxes |
| what a sibling board covers | `gaps.ts` | a board with refs |
| whether a ref is real | `drift.ts` | a board with refs |
| whether an arrow holds | `deps.ts`, `body.ts` | a board with arrows |

So the only way to learn the shape of a board was to draw one. The
`draw → render → relayout → render → split → render` transcript in #183 is not a
session being careless; it is the *only* available procedure. That is why five
issues (#161, #163, #180, #183, #185) each fixed the step that happened to be
under measurement and the loop survived all five: they were fixing steps in a
sequence that existed because nothing could answer a question before the fact.

The fix is not to write the loop down. It is to make the questions answerable
from a **directory** instead of from a board.

**And that answer is deterministic, which the drawing itself can never be.** The
graph on a board comes from a model, so two runs of the same request give two
different boards — the skill says so, and it stays true. What a survey computes
is not that: it is the import graph read out of source by `deps.ts`, plus
arithmetic over layouts. No model, no sampling, no clock. Two runs of a survey on
one commit are byte-identical, and so are two people's on two machines: the file
walk goes through `Workspace` and is sorted, every tie-break is total on ids that
`identifier` has already reduced to ASCII, and nothing calls `localeCompare`,
whose answer depends on the host's ICU build. `tests/engine-survey.test.ts` holds
all three — including surveying the same scope through four shuffled directory
listings, since entry order differs by filesystem and would otherwise hand two
people different boards with no way to tell why.

The model is still what makes it a diagram. It just no longer has to invent the
shape first.

## What was built

`survey_scope` takes a directory and returns a draft graph — before any code is
read, and before a box is drawn.

- **How many boxes** is not a convention and not a guess. Candidate boards are
  laid out through the same `planDiagramLayout` `create_diagram` uses and measured
  through the same `viewability`, and the board keeps whatever detail still comes
  out legible. Starting from the scope's immediate children, the busiest box is
  opened into its own children while that holds, and boxes are dropped when it
  does not.
- **What a box stands for** is therefore decided *per box*, not once per board.
  A board comes back as a mixture of files and directories. #186 asks whether this
  has a defensible answer or is per-codebase; it is per-*box*, and it is
  arithmetic.
- **When one board should be two** falls out of the same walk. A box the picture
  could not afford to open is returned as `separateBoards`. No new rule was
  needed: declining to expand a box *is* the split criterion.
- **When the diagram is done** is now statable: every box anchored, the draw-time
  response says legible, `check_drift` clean, and `separateBoards` either drawn
  or declined out loud. That is written at the top of the skill.

Every box comes back anchored at a path that exists. Every arrow comes back with
the `file:line` the dependency was read from, and with `claim: "needs"` wherever
that line is one a reader would recognise as an import — which is what makes
writing it a transcription rather than the hypothesis SKILL.md forbids.

**The evidence is chosen, not taken.** Several files in one box may justify the
same arrow, and the one quoted is the one that reads as a declaration. That
matters more than it sounds: taking the first justification found put lines like
`dfa: &crate::dfa::dense::DFA<..>` and `let mut builder = grep::regex::RegexMatcherBuilder::new()`
next to `claim: "needs"` — real Rust dependencies with no `use` anywhere, which
`deps.ts` reports correctly and the `needs` check would confirm, but which look to
a reader like the tool inventing a claim. Quoting the first justification found
gave 227 of 268 recognisable lines (85%) over eight of these scopes. Preferring a
declaration gives **every claim recognisable** across all eleven, with the rest
left unclaimed rather than claiming something whose evidence looks invented. Claim
rate 97%, against 4% across this repo's own boards. An unclaimed
arrow is the normal case, not a shortfall.

`measure:survey` re-reads every quoted line off disk and judges it with its own
copy of the rule, so the claim rate is checked rather than asserted, and it prints
any line it disagrees with.

## Two things the size measure does not measure

Both were found by drawing the survey's own draft and *looking at the PNG* — the
one call the rest of this design argues against paying for. Worth it once, for the
tool itself: each of these shipped a board the survey had already called legible.

**A survey was measuring the wrong labels.** The grain is chosen by laying
candidate boards out, and the only labels available then are filenames. But the
survey's very next instruction is to replace them, and a real label is much
bigger: over the 209 labels on this repository's boards the widest line is a
median of **18 characters** and 71% run to more than one line, median 2. A
filename stem in `src/engine` is a median of **6 characters on one line**. So
boards were being sized at about a third of their eventual width. Measured on
filenames, 19 boxes of `src/engine` came back `legible` — and rendered `cramped`
at 9.2px once the labels said what the boxes did. The survey was breaking its own
promise on the step it asks for. It now measures against the allowance, and the
board it promises is the board that gets drawn: `legible` at 11px predicted,
`legible` at 11.2px delivered.

**`viewable.ts` measures whether text is big enough, and nothing about arrows.**
Optimising boxes subject to label size produced 16 boxes and 48 arrows of
`src/engine`: every arrow a real import, all 48 confirmed by the checker, 0
findings — and a hairball, long connectors crossing the full width, unfollowable.
The measurement that settles it is unusually clean: across all 16 boards in this
repository the arrows-per-box ratio runs 0.25 to **1.43**, and not one exceeds it;
among the eight that render legibly the median is 1.0 and the max 1.22. A person
drawing at 1.21 was not drawing every dependency — they were selecting. So a
survey selects too, keeps each box's heaviest arrow so nothing is left floating,
and returns `arrowsOmitted` rather than thinning in silence.

The same measurement caps the boxes. Among the eight boards here that render
legibly the counts are 3, 4, 5, 6, 8, 9, 14, 14 — **14 is the most any legible
board holds**, and every board above it (16, 18, 19, 21, 33) is cramped or
unviewable. Refining to the last legible box gave 31-box boards at 11px, twice
what anyone has drawn here. Anything past 14 becomes the next board instead.

## Measured, across eleven scopes in nine repositories

`npm run measure:survey`, 2026-09-01. Every scope legible, every box anchored,
every claim's quoted line re-read and judged by the script itself, and the drafted
board comes back with **zero findings from the engine's own checker**.

| scope | files | boxes | arrows | a/box | needs | conf | findings | label | next | files omitted | arrows omitted | survey tk | reading tk | ratio |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| board-ai/src | 61 | 13 | 17 | 1.31 | 17 | 9 | 0 | 18.5px | 2 | 0 | 0 | 628 | 27,598 | 43.9× |
| board-ai/src/engine | 43 | 14 | 21 | 1.50 | 21 | 19 | 0 | 18.9px | 0 | 29 | 13 | 745 | 6,627 | 8.9× |
| ripgrep/crates | 86 | 11 | 16 | 1.45 | 13 | 0 | 0 | 20px | 1 | 0 | 8 | 569 | 25,298 | 44.5× |
| clap_builder | 57 | 14 | 21 | 1.50 | 20 | 0 | 0 | 13.2px | 2 | 0 | 36 | 826 | 15,447 | 18.7× |
| regex-automata | 72 | 13 | 19 | 1.46 | 18 | 1 | 0 | 18px | 4 | 0 | 38 | 785 | 30,165 | 38.4× |
| serde_json | 37 | 14 | 21 | 1.50 | 20 | 4 | 0 | 16.7px | 2 | 0 | 30 | 631 | 10,270 | 16.3× |
| anyhow | 12 | 12 | 18 | 1.50 | 17 | 2 | 0 | 16.7px | 0 | 0 | 13 | 557 | 3,148 | 5.7× |
| vue runtime-core | 65 | 14 | 21 | 1.50 | 21 | 2 | 0 | 17.1px | 0 | 23 | 54 | 969 | 10,443 | 10.8× |
| vite/node | 117 | 14 | 21 | 1.50 | 21 | 0 | 0 | 18.3px | 2 | 33 | 53 | 900 | 25,306 | 28.1× |
| nest/core | 187 | 14 | 21 | 1.50 | 21 | 2 | 0 | 14.4px | 14 | 32 | 34 | 971 | 31,042 | 32.0× |
| query-core | 30 | 14 | 21 | 1.50 | 21 | 14 | 0 | 18.9px | 0 | 10 | 47 | 928 | 5,731 | 6.2× |
| graphify (python) | 82 | — | — | — | — | — | — | — | — | — | — | **refused** | | |

Totals, printed by the same script:

| | this repo's 16 boards | a survey |
| --- | --- | --- |
| boxes carrying an anchor | 89/209 (43%) | 147/147 (100%) |
| arrows carrying a claim | 11/254 (4%) | 210/217 (97%) |
| claims whose quoted line reads as one | — | 210/210 (100%) |
| boards that render legibly | 8/16 (50%) | 11/11 (100%) |
| arrows per box | 0.25–1.43 | 1.48 mean, none over 1.5 |
| findings on the drafted board | — | 0 |

**On the cost column.** `reading tk` is the first 40 lines of every file the board
anchors or cites: the least a session could read and still transcribe rather than
infer. It is a floor, not a session — a real one does not know which files to
open, which is the thing it is trying to find out. Even against that floor the
survey is 5.7–44.5× cheaper, median ~19×.

**On time.** 0.1–0.8s on most scopes and 3.2–4.7s on ripgrep, clap and
regex-automata, which are the ones with the most files to read. Paid once per
board, against a redraw that costs a graph payload and a render.

## The three things #186 said to settle first

**"Whether the 5% claim rate is under-use of a good vocabulary or evidence that
most of it should not exist."** Under-use, and the cause is structural rather
than cultural. SKILL.md is right that a claim must be transcribed from a line you
read — a guessed `needs` is a false statement printed on the user's diagram in
red. But that rule prices every claim at a file read, so a session drawing 30
arrows will not pay 30 reads for something optional, and it writes none. The
engine had already read those lines. Handing the line over with the arrow makes
the claim free *and keeps it honest*: 210 claims, every one quotable, 0 findings,
across eleven scopes. The vocabulary was fine. The cost of using it honestly was the problem.

The 3% that stay unclaimed are the other half of the answer, and they matter: a
vocabulary used at 100% by a tool that picks whichever justification it found
first would be worse than one used at 4%, because the wrong ones look exactly
like the right ones.

**"Whether 'how many boxes' has a defensible answer or is genuinely
per-codebase."** Neither. It is per *box*, and it is measurable. There is no
number to publish — `src/engine` holds 19 boxes at 11.6px and `nest/core` holds 8
at 13.4px, because what fits depends on label lengths and arrow count, not box
count. Anything written as a convention would have been wrong for most repos.

**"Whether any of this can be checked mechanically or is irreducibly a judgment
call."** Split cleanly, and the seam is sharp. Structure is mechanical:
membership, granularity, arrows, direction, size, split, remainder — all
derivable, all deterministic, same answer twice. Naming is irreducibly judgment,
and it is the whole remaining value. This repo's own best boards say "ELK layout
/ real font metrics" and "PNG via Chromium" where a survey says `layout` and
`render`. That is the boundary, and the skill says whose job each half is.

## Rejected, with the measurement

**A procedure written into SKILL.md and nothing else.** The premise of #186 is
that 21 sessions ignored 553 precise lines. A 554th line is the same bet. The
procedure *is* now in SKILL.md — it has to be, or the tool goes unused exactly as
`needs` and `closed` did in #110 — but it is three sentences pointing at a tool
that answers, not a method to be followed by hand.

**Naming boxes from each module's own opening comment.** Would have closed the
one remaining gap for free. Measured: usable headline present for 76% of files in
this repo and serde_json, and **3–13%** in vue, nest, vite, ripgrep and
regex-automata — and among the hits are `istanbul ignore file`,
`!/usr/bin/env node` and `[cfg(feature = "alloc")]`. It does not generalise and
it fails noisily where it fails. Not built.

**Deriving flow boards from the call graph.** `graphify-out/graph.json` holds
10,955 `calls` edges, so "how does a request become a picture" looks derivable.
It is not: `createDiagram → viewable` and `checkDrift → body` are both real
relationships and neither is in the graph. `codegraph.ts` documents this — the
channel only ever confirms — which is right for checking and fatal for drafting.
So a survey draws the structural board and says so, and flows stay hand-drawn.

**Folding the survey into `create_diagram` as a `scope` argument.** One call
instead of two, and it removes the model from the only step that needed it. A
board of filenames is not a diagram.

**Surveying both flows and handing over the winner.** Built, measured, removed.
It doubled the layouts — ripgrep 3.2s → 6.4s — and across eleven scopes it
changed the box count on **none** of them, because the box ceiling binds long
before the flow does. `create_diagram` already picks the flow at draw time from
the *real* labels, which is strictly better information than a survey holding
filenames has; every one of those eleven boards came out legible when it chose.
Keeping it would have been paying double for a worse answer.

## Known gaps

**Python is refused.** `deps.ts` reads TypeScript, TSX, JavaScript and Rust. The
82 Python files in graphify produce 0 edges, so a survey there would be a board of
unconnected boxes with confident-looking anchors — the false confidence this
engine is built to avoid. It refuses and names the language instead. This is the
largest gap: Python is a target language, and the survey does not cover it. A
Python `readDependencies` arm is the single highest-value follow-up.

**Directory-anchored arrows cannot be confirmed, and that is most of them on a
big repo.** `SURVEY_WHY=1 npm run measure:survey` prints why each claim was
withheld, and `directory-ref` dominates everywhere the scope is large: vite 20 of
21, nest 19 of 21, vue 16 of 21, ripgrep 13 of 13. The `needs` check declines when
an end is a directory, which is correct, but it means **the grain that fits a big
picture is the grain the checker cannot read** — `src/engine`, drawn at file
level, confirms 19 of 21, and nest, drawn at directory level, confirms 2. Those
withheld claims are recorded and honest and buy nothing. Nothing in the docs said
these two pressures pull opposite ways, and it is a real part of why this repo's
own boards claim so little. Not addressed here.

**The 14 boxes are chosen by traffic, not by narrative.** Coarsening drops the
least-connected boxes, so `src/engine` comes back with `damage`, `accept` and
`closed` on the board and `diagram`, `layout` and `render` among the 29 omitted —
defensible by import degree and not what a person would pick as the engine's
story. Merging and dropping is explicitly the caller's half, and the draft makes
that work smaller rather than unnecessary.

**A survey is scope-bounded; good boards are not.** `board-internals.excalidraw`
draws boxes from `src/mcp`, `src/engine`, `src/server`, `src/viewer` and
`docs/diagrams` on one board. No directory survey produces that. Surveying two
scopes and merging is the manual answer; a multi-scope survey is unbuilt.

**The tool costs context in every session.** Measured off `listTools`:
`survey_scope`'s schema serialises to 2,612 characters, ~653 tokens, 8% of the
7,810 the thirteen tools now cost together — charged on every request
whether it is called or not. Worth it if it removes one redraw of one board; a
real cost if most diagram requests turn out to be flows, where it does not apply.
Worth re-measuring against real usage before the description grows again.
