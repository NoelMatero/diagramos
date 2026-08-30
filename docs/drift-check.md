# Drift check: keeping a diagram honest about the code

Status: **missing files, symbols, and edge mismatches are built** — `src/engine/drift.ts`,
the `check_drift` tool, `scripts/check-drift.mjs`, and a `Stop` hook in
`.claude/settings.json`. All three kinds are now built; the rest of this file is the
reasoning behind the complete picture.

Fixing is a `/update-diagram` command, and deliberately not automatic. See
"Reporting is not the same as being actionable" below for why the exit-2
auto-fix was designed and then not built. Saying the *diagram* was right — the
one act that changes what a board claims — is `/accept-arrow`, one arrow at a
time; see "Accepting a backwards arrow".

What changed while building it:

- **Labels that are unambiguously paths are read as refs**, reported as
  `inferred`. Without this, every diagram drawn before `ref` existed was
  invisible to the check. The pattern demands a slash and a file extension, so
  `Auth` and `POST /api/file` are still skipped.
- **`Stop`, not `PostToolUse`.** One run per turn instead of dozens, output
  arriving when the model could act on it, and no debounce logic to get wrong.
- **Silent when clean**, which matters more than it sounds: a check that
  announces good news thirty times an hour gets switched off.
- **The plugin ships the hook** (`hooks/hooks.json` + `hooks/drift.sh`), which
  reverses an earlier decision. It was opt-in because a plugin hook fires in
  every project someone installs into and most have no diagrams — sound, and it
  left the one feature that keeps a diagram honest as the one feature every user
  had to wire up by hand after reading this file. Nobody was going to. See
  "Shipping the hook" below for the measurement that made the objection cheap to
  answer.
- **Refs are confined like board paths.** They are model-authored strings that
  become filesystem reads, so they resolve inside the root and are re-checked
  after realpath; a symlink out of the tree cannot be used to probe for files.

A committed diagram is documentation, and documentation rots. The point of
diagram-driven development is that the picture stays true, so the board needs a
way to notice when the code has moved out from under it.

## What makes this tractable here

Generated elements carry `customData` (`{ node, edge, role, origin }`), so
`readGraph()` returns an exact node and edge list rather than something
re-derived from geometry. An edge's label is bound to its arrow the way
Excalidraw binds any label to its container, so editing it on the canvas edits
the arrow's label rather than the arrow's shape. Boards written before that was
true carry the label as a free text element tagged `edgeLabelFor`, and it is
still read -- but a label typed on the arrow itself wins, because it is the
newer of the two. Drift detection is therefore a real set comparison,
not fuzzy matching against rectangles.

Hand-drawn elements are reported as `provenance: "inferred"`. They must be
treated differently: a box you sketched is an *intention*, not a claim about
current code, and reporting it as drift would be noise.

Arrows are the exception, and the distinction is not authorship. Each edge also
reports `endpoints`: `declared` (from its own `customData`), `bound` (from
Excalidraw's bindings on both ends), or `nearest` (at least one end matched to
whichever shape it landed close to). The first two are exact — a binding keeps
pointing at a shape when either one moves, whoever drew the arrow — so the arrow
check trusts them and skips only `nearest`. Keying that decision on `provenance`
instead meant "Claude didn't draw it", which silently skipped the diagram-driven
case: a connection you sketched between two components that already exist.

## What the diagram says about time

A ref that does not resolve means one of two opposite things, and the filesystem
cannot tell them apart: either the code has not caught up yet, or the code moved
out from under the diagram. Nothing could distinguish them, so everything was
reported as the second one — which is why a diagram could not be used as a spec.

A node (and an edge) can now declare `state`:

| state | meaning | drawn |
| --- | --- | --- |
| `built` | it exists now. The default, so every board drawn before this field means exactly what it meant | solid |
| `planned` | it is meant to exist | **dashed** |
| `external` | deliberately not code in this repo — a browser, a third-party service, another project | solid, for now |

`planned` boxes and arrows are drawn dashed, so what exists and what does not can
be told apart by looking rather than by running the check. Dashed rather than a
colour: it survives greyscale and colour-blindness, and it is already what "not
real yet" looks like everywhere else.

![built is solid, planned is dashed, external is solid](../assets/state-legend.png)

That picture is generated, not a screenshot:
`npm run diagram:render docs/diagrams/state-legend.excalidraw assets/state-legend.png`.
Regenerate it if the styling ever changes, so the legend cannot quietly start
lying about what the tool draws.

`external` is drawn like `built` on purpose. It means "real, but not ours" rather
than "not real yet", so it wants a treatment of its own rather than being folded
into the same one — an open question, not an oversight.

Crossed with what the filesystem observes, every combination has one honest
reading:

| declared | observed | report |
| --- | --- | --- |
| `planned` | missing | **work item** — go build it |
| `planned` | exists | **promotion** — the code caught up, the board can be advanced |
| `planned` | exists, running the other way | **work item** — something landed, and it is not this |
| `built` | missing | **regression** — real drift |
| `built` | exists | nothing |

The third row is `built-backwards` and is described under
[a plan the code went the other way on](#a-plan-the-code-went-the-other-way-on).
The fourth is the only one that fails a build. Work items and promotions are
kept out of `clean` and out of the exit code on purpose: CI reads that code, and
a repository is not broken because somebody sketched next week's work.

**A claim on a planned thing is a specification, and nothing grades it.** Both
claims — `@needs` on an arrow, `@closed` on a directory box — are gated on
`built`, so a plan can state which way a dependency will run and what boundary a
subsystem will hold without any of it being read against today's code. That is
the inversion the plan-first workflow rests on: everywhere else a claim is a
transcription of a line somebody read, and here there is no line to read yet.
Writing one therefore costs nothing and can accuse nobody.

The gate releases itself — the code landing promotes the thing to `built`, and
the claim goes live. A `@needs` arrow's *direction* is read one step earlier than
that, on the way in rather than the run after, and the section below says why.

**Nothing grades it, and it is still counted.** Not grading a plan's claim used
to mean saying nothing at all about it, and the two are different: a claim
nobody could evaluate has to be visible, or a quiet report stands in for an
answer. So a `planned` arrow whose ends could not be read — the file is not
written yet, the end is not snapped to its box, the language has no measured
reader — lands in `plannedWithheld`, and `--details` says
`1 of this plan's claims cannot be checked yet: 1 not written yet`.

Its own line, dim, and never in the per-turn notice or the exit code. It reads
as coverage rather than as a problem because that is what it is: the arrows of a
plan pointing at files that do not exist is the plan working, and it would be
true for a whole design session. What it replaces is the silence, which was the
one thing that could be mistaken for a pass — a feature finished under a
different name left every claim on the plan unread, and the board reported no
findings and exited 0. A `planned` arrow that *was* read is not in this number
whatever the answer was: it got one, and what to do about it is the work item.

**`missing` is deliberately not a state.** State is declared by whoever draws the
box; existence is observed, free, every run. Recording "missing" would put a fact
with a shelf life into a committed file, which is the rot this check exists to
catch. Never store what you can measure.

**A promotion opens the notice; a work item does not.** Both come from a `planned`
box, and the difference is which side is behind. A work item is the sketch being
ahead on purpose — it would sit unchanged for a whole design session, and a notice
repeating it every turn is one nobody reads. A promotion means the board is now
wrong: it says planned, the code says built. That is drift in the mild direction,
and it is one edit from going away. Work items still show up in the tally
(`1 gone  1 planned`), so they are discoverable, and `--details` lists them in
full — being quiet is not the same as withholding.

One work item does open the notice: `built-backwards`. It is not the sketch being
ahead — something landed between one turn and the next and it runs against the
plan, which is news exactly once, at the moment it is cheapest to fix.

**The hook makes that one edit itself.** On the per-turn path a promotion is
applied, not just announced: the box is flipped to exactly what regenerating it
as `built` would write — solid stroke, no state key, version bumped so the live
page redraws it — and the notice says `promoted` once instead of `is built now`
forever. Two deliberate limits: a box only partly landed — several anchors, some
still missing — is held, because flipping it would erase the remaining work from
the picture; and only the hook applies, never the bare `drift` command, because a
check that mutates the working tree breaks every `git diff --exit-code` that CI
runs after it. The applied edit is an ordinary change to a file in git, so
undoing it is one checkout.

**While a board is open, the box turns solid before the turn ends.** The hook is
the end of a turn, and a turn is minutes; the loop this field exists for is
"you write code and the diagram moves". So the board service watches the
repository whenever a page is holding its stream open, re-checks on every burst
of changes, and flips a promotable box to a solid stroke straight away —
measured at about 390ms from the file being written to the box being redrawn
(#130).

What it does *not* do is record the promotion. `state` still says `planned`, and
that division is the whole reason this is safe to do mid-turn. Applying a real
promotion deletes the `state` key, which is a one-way door: mid-turn a file is
created empty and filled two seconds later, a rename lands as three edits, and
walking through that door on half-written evidence would erase something the
author typed with nothing able to put it back. A stroke can simply be put back.
So the preview writes a stroke and a marker, nothing in the engine reads a
stroke, and every check returns exactly what it would have returned. If the code
goes away again the flip is undone; if it is still there at the end of the turn,
the hook settles it for real and the picture does not change, because it already
looked right.

Three consequences worth knowing:

- **The preview is visible as a preview.** The chip carries a dashed `N early`
  count, so a mid-turn screenshot is not mistaken for a settled verdict.
- **Only good news travels this fast.** The page applies a preview without
  refetching its status, so a half-written tree cannot make the board flash red
  at work that is merely unfinished. Bad news keeps the cadence it already had:
  a focus, a board write, the slow timer.
- **Nobody looking, nothing watching.** The watcher starts on the first page to
  open a stream and stops with the last one to close, so a board no page has
  asked about costs nothing. An abandoned preview — a service killed mid-turn —
  is cleaned up by the next hook run.

`external` earns its place separately. Measured: 106 of 117 nodes in this repo's
diagrams carry no ref, and some of that is deliberate — the telecom boards
describe a protocol, not this repository. Without a way to say so, "not code" and
"somebody forgot" are the same output.

That distinction is mostly a property of a whole board rather than a box, so a
board can also carry `describes: "concept"`, recorded on its **title element**.
Not `appState`: the viewer pushes `appState: {}` on every browser edit, so
anything kept there is destroyed the first time someone touches the canvas.
Element `customData` is the only store that survives, which is why a concept
board needs a title.

## What the board stopped saying

Every check above reads the board as it is, so deleting a box deletes the findings
about it. Measured: removing one box from `board-internals.excalidraw` — the
`layout` box, whose file is 23KB and imported by three modules including this
checker — dropped the refs checked from 12 to 11 and the edges from 13 to 11, and
reported **nothing**. Taken to its conclusion, the least honest diagram is the
quietest one, and an empty board is clean forever.

So one finding comes from a comparison against the *committed* board rather than
against the code: a box that was there, is gone, and whose file is still in the
tree.

**Committing the diagram is the mute.** There is no flag to remember and no
per-box suppression, because the act that means "yes, I meant to remove that" is
one people already perform. It also means CI can never trip this: a fresh checkout
has nothing uncommitted to find.

Tombstones were the cheaper design and were rejected. Excalidraw soft-deletes, so
the removed element is still in the file with `isDeleted: true` and its
`customData` intact — but a tombstone lives forever, so an old deliberate deletion
and a fresh accidental one look identical, it would need a mute of its own, and
exporting from another editor prunes them.

Matching is on the semantic node id, never the element id: regeneration writes
fresh elements and keeps node ids, so anything keyed on elements would report
every redraw as a mass deletion. A node still present with a different ref is not
a deletion either — the ordinary checks own that.

Three silences, each load-bearing:

| situation | why nothing is said |
| --- | --- |
| the file went with the box | the deletion tracks the code, so the board is telling the truth |
| no git, untracked board, or board unmodified | nothing to compare against. A project without git is not a broken one |
| the box was `external` | it never claimed anything about this repo |

The cheap path is the common one: `git status --porcelain` on the board runs
first, and an unmodified board stops there without reading a baseline.

### Deleted arrows

When an arrow is removed from the board, the check can detect if the code still supports that connection. If both endpoints exist in the code and have corroboration (one imports the other, they share an importer, or they share a route string), the removal is reported as a quiet note beside the deleted boxes, never a finding.

A deleted arrow is not reported when the connection had no corroboration anyway — removing an uncorroborated arrow is cleanup, not loss.

### Stray arrows

An arrow that fails to resolve at one or both ends is an incomplete stroke, not a specification. These arrows never make it into the graph's edge list — they drop out when both binding and proximity matching fail to find a target, which is exactly the "never surfaces anywhere" silence described by the issue.

They are counted and reported as a dim note when `--details` is asked for, so an incomplete sketch does not clutter the main notice. Arrows that resolve at both ends, whether through Excalidraw bindings or explicit declaration, are specifications and are checked normally.

### What the board started saying — the green line

The same committed-board comparison, read the other way (#67). Bad news always
reached the per-turn notice; a board that *improved* — a box added, a box or
arrow flipped from planned to built by a redraw rather than by the hook — said
nothing, because the check found nothing to promote. Now it says so, in green
and in one line: `arch.excalidraw improved: +1 box · 1 built`.

Announced **once**. The comparison point is git and boards go uncommitted for
whole sessions, so the same news would otherwise repeat every turn until the
commit — and a notice repeating good news thirty times an hour is one somebody
turns off. What has been announced is remembered per board in `.diagramos/`
(gitignored, beside the expand/shrink mode), and committing the board clears it,
so the next improvement is heard fresh.

The quiet rules carry over: hook only (a terminal run already has its summary
line), recorded elements only (a hand-drawn doodle is not announced back at its
author), never an `external` box, never a move, restyle, or relabel. A flip the
hook applies itself keeps its existing "promoted" line and is never repeated as
news.

## Code the diagram does not show

Every other check reads a claim and asks whether it still holds. This one asks the
opposite: what does the code have that the board leaves out?

It was the oldest open question here, and it was stuck on one thing — **without a
relevance bar, every file in the repository is drift.** Picking a bar (line count,
export count, directory depth) means inventing a definition of "important" and
being wrong about it in someone else's project.

The bar is inherited instead of invented:

> A candidate has to be imported by a file the board already points at.

Relevance was decided by whoever drew the diagram. Cost scales with the diagram
rather than the repository, nothing searches the tree, and the machinery already
existed — the arrow check builds the same neighbourhood for its shared-importer
channel.

The frontier moves with the board. Draw a suggested module and its own imports
become the next candidates, so the check keeps proposing the next ring outward
instead of emptying once and going quiet. That is also why it stops at one hop:
following further is the walk this was avoiding.

A directory ref covers everything beneath it, so one box for `src/engine/` excuses
the subsystem rather than nominating all of it.

**Suggestions, never drift.** They stay out of `clean` and out of the exit code,
they need `--coverage` on the CLI or `coverage: true` on the tool, and the `Stop`
hook never passes either. Whether a module deserves a box is a judgement about
what is worth showing; a check that nagged about it every turn would be switched
off, and that would take the quiet, correct missing-file check with it.

Measured on `board-internals.excalidraw` — 12 boxes, the only ref'd board here —
it suggests **7 files in 15 ms**, ranked by how many boxes import them:

| suggested | imported by |
| --- | --- |
| `src/engine/normalize.ts` | 4 |
| `src/engine/config.ts` | 2 |
| `src/engine/font.ts` | 2 |
| `src/engine/contrast.ts`, `src/engine/excalidraw-assets.ts`, `src/viewer/reveal.ts`, `src/viewer/sync.ts` | 1 each |

No threshold is applied, and that is a deliberate omission rather than an
oversight: every one of those seven is a real module (58–256 lines), so there is
no obvious noise to filter, and any cutoff picked from a single 12-box board would
be a guess dressed as a rule. Ranking puts the module four boxes depend on first
and lets the reader stop whenever they like. If a real diagram drowns in these,
that is the measurement that earns a threshold.

## Silence had two meanings

The check is quiet when nothing is wrong, which is what keeps it switched on. But
it was equally quiet when there was nothing it could read, and the output was
identical. So a clean report was not evidence of anything: you could not tell a
verified diagram from an unreadable one.

Measured on this repo, which had been reporting clean every turn for months:

| | |
| --- | --- |
| boxes checked | **12 of 117** |
| arrows checked | **12 of 153** |
| boards with anything checkable | **1 of 7** |

Every check now records *why* something went unread, not just how many. Two
reasons for a box (`no-ref`, `ref-outside-repo`) and nine for an arrow — the one
that matters most being `ends-not-bound`, because an arrow that was never snapped
to its boxes looks exactly like one that was.

Three things stay separate, because they are not the same claim:

- **skipped** — there was something here and it could not be read.
- **excused** — declared as not about this repo (`external`, or a concept board).
- **hand-drawn** — a sketch, never a claim about code.

`--details` prints this even when everything is clean, since a question deserves
an answer:

```
┌─ ims.excalidraw  nothing here points at code yet ─────────────┐
│ 19 boxes skipped: 19 no ref                                   │
│ 25 arrows skipped: 25 an end has no ref                       │
└─ silence means these agreed · not that everything was read ───┘
```

**An unread arrow is named, not just counted.** A reason with no subject cannot
be acted on — "4 arrows skipped: an end is marked external" leaves a reader no way
to learn *which* four short of opening `drift.ts`:

```
┌─ example.excalidraw  checked 3 boxes and 2 arrows ────────────┐
│ 3 boxes outside this repo by declaration                      │
│ 4 arrows skipped: 4 an end is marked external                 │
│   Claude Code → Board MCP server  tool call                   │
│   Board MCP server → board.excalidraw  writes                 │
│   board.excalidraw → Board MCP server  reads back             │
│   You → board.excalidraw  edits                               │
└─ silence means these agreed · not that everything was read ───┘
```

This is the argument `unannotated` already won for boxes, applied to arrows,
which never got the same treatment. It measures nothing new and catches nothing
by itself: silence had two meanings — *this agreed with the code* and *nobody
looked* — and from outside the tool they were indistinguishable. The cost of that
is not hypothetical. `example.excalidraw` carried an arrow reading **ELK layout
engine → board.excalidraw, "writes"** from the first commit. It was false —
`writeBoard` is called in `src/mcp/server.ts`, and nothing in `layout.ts`'s
import chain touches `node:fs` — and every run said nothing, because an arrow
onto an `external` box is dropped before anything looks at it. It was found by
reading this file, which is not a route a user has.

Named unconditionally, unlike `unannotated` and `unrepresented`. Those two go
looking for something and wait to be asked; this only writes down a decision the
check already made, so deferring it would buy nothing and would leave `--details`
— the flag whose whole job is saying what was not read — unable to answer its own
question. The list stops at eight per reason and says how many it held back: a
list that quietly stopped would read as "that is all of them", which is the
failure being fixed rather than a smaller version of it.

**What it still cannot do.** Naming the arrow does not check it. The claim in
that arrow was the word *"writes"*, and labels are decoration to this tool —
nothing in `drift.ts` reads `edge.label`. Every channel the arrow check has asks
*does the code at this end reach the code at that end*, and with a person or a
drawing file at one end there is no other end to reach. So the honest position is
that these arrows carry no claim this check can test, and the fix is to say so
out loud rather than to guess. What to do about it is tracked separately.

**The per-turn notice does not change.** It stays quiet, because a notice that
reported coverage every turn is one that gets switched off — and that would take
the quiet, correct missing-file check with it. The audit is a question you ask.

**A bare run answers in one line.** The silence above was applied to both callers,
and only one of them deserved it. Typing the command and getting zero bytes back
is indistinguishable from a broken install, and was read as exactly that:

```
7 boards · 12 boxes and 12 arrows checked · nothing drifted · 12 unread, --details says why
```

It names what went unread rather than implying everything was verified, because
that conflation is the thing this section exists to undo, and a summary line that
forgot it would put the confusion back in a shorter form. Work items ride along as
`· 2 planned` — in the tally, never in an alarm.

The asymmetry is the point: the hook fires unbidden and stays silent, a command
someone chose to run gets an answer. The same line `--details` already draws.

`check_drift` returns `skippedWhy` and `edgesSkippedWhy` alongside the counts, so
a model deciding whether a diagram is trustworthy has the same information, and
`coverage: true` adds `unreadEdges` — the same arrows by name. That one is gated
where the CLI's is not, because the MCP response is read every turn and the
counts already answer the per-turn question.

Most of the 105 unread boxes are the telecom boards, which describe a protocol
rather than this repository. Marking them `describes: "concept"` turns them from
*skipped* into *excused*, which is the honest resolution — see #32.

## What a box is allowed to say

A ref used to be one of two things: this file exists, or this file mentions this
name. Measured across the seven committed diagrams, the second had **never been
used once in 117 nodes** — the check was strongest at the claim people least
wanted to make, and had nothing to offer for the ones they actually draw.

Six forms now, four of them new:

| form | example | claim |
| --- | --- | --- |
| file | `src/engine/drift.ts` | this file exists |
| symbol | `src/engine/drift.ts#checkDrift` | the file mentions this name |
| directory | `src/engine/` | this directory exists and is not empty |
| dir symbol | `src/engine/#Workspace` | some file directly inside mentions it |
| glob | `src/engine/*.ts` | at least one file matches |
| several | `refs: ["src/lib.rs#LOGGER", "src/lib.rs#log_line"]` | all of these hold |

A trailing slash **says** directory. That is the point of allowing it: what
`src/engine` means should not depend on what happens to be on disk the day it is
read, and `src/engine/layout.ts/` is now a finding rather than a coincidence.

`refs` sits beside `ref`, never replacing it. Each anchor is checked and reported
on its own, and the box is clean when all of them hold — so #18's real case, one
box meaning a static *and* the macro that uses it, goes loud when either
disappears, which neither single-ref option could do. `ref` stays primary because
the arrow check needs one endpoint per box, not a set.

One new finding: `empty-ref`, for a directory with nothing in it or a glob that
matches nothing. It is loud, because it is a claim that has stopped being true.

### A number written on the box, checked against the code

Everything above stops at the **ref**. A ref goes stale and the engine says so; a
**label** goes stale and nothing says anything, ever. Change a slab from 2048 to
4096 and the box still reading `Slab(2048)` is lying — the ref resolves, the
arrows hold, the report is clean. Ordinary documentation rot, living inside a
tool built to prevent documentation rot.

The tempting fix is to scan labels for numbers and compare them to the file.
Don't: a label saying `Token(2)..Token(2050)` also contains `2`, and pattern-
matching facts out of prose produces false accusations — the one thing this
engine has never done, spent on the least important check in it.

So the claim is **declared**, not discovered:

```
conns: Slab<Client>
Token(2)..Token(2050)      ← prose, never checked
Slab @cap=2048             ← the claim
full slab = backpressure   ← prose, never checked
```

Nothing is inferred out of a sentence, so nothing can be misread out of one. And
the prose beside it is the argument for that: 2050 is the author's own arithmetic
— 2 plus 2048 — and appears in no file in the repository. A checker clever enough
to find it would have been wrong about it.

**The `=` is what keeps it safe, and it was measured rather than chosen.** Across
the seventeen boards here, sixteen text elements carry an `@` token and every one
is a vocabulary word — `@needs`, `@declared`, `@used`. One of them is a *box*
label, on the board documenting this very feature: `what a ref claims · @declared
· @used`. Read a bare `@word` in a box label as a claim and that box reports two
garbled claims the day this ships, on our own diagram, about the syntax it is
explaining. Not one `@` token anywhere contains an `=`. So `@word` stays
vocabulary and stays prose in a box label; `@name=value` is the new grammar and
cannot collide with a board already drawn — which is also why this is additive
rather than loudening, and needs no `BOARD_SCHEMA` bump.

The name is for the person. Nothing checks what `cap` *means*, because what a
number means is not a question the code can be asked. The number is the whole of
the claim.

**Read from the parse, never from the text.** `src/lib.rs` says "255 chefs" in a
doc comment nine lines above the `ThreadPool::new(255)` that means it. A text
search cannot tell those apart, so a comment would keep a claim green after the
real number changed. Numeric literals are nodes; a number in a comment is not a
node, and a number in a string is string content. Same trick as everywhere else
here — `number`, `integer` and `float` name the numeric leaf in every grammar, so
there is one pattern and no per-language table. `2_048`, `0x800` and `2048u32`
are one number.

**Scoped to the narrowest thing the box points at**, and this is the difference
between catching the motivating case and missing it. `src/lib.rs` writes `2048`
five times over — a slab, two read buffers, a comment — so a file-wide question
stays green after the one number the box is about becomes 4096. Anchored at a
symbol, the claim is checked against that declaration and its body, and fails the
moment the number does. A box pointing at a bare file gets the weaker answer it
asked for, which is the same bargain `missing-symbol` has always struck.

It is refutable, so it may say *wrong*, in red, with the box and the number: the
numeric literals in a declaration are enumerable, so not finding one is proof
rather than absence of evidence — the same standing `missing-route` has. Nobody
gets a red for prose, only for a number they marked on purpose.

`@name=` followed by something that is not a number is **garbled and loud**, not
ignored. A claim nothing judges reads exactly like a claim that passed, so a
board saying `@default=utf-8` is told that nothing is checking it. The other
kinds the issue sketched — string literals, variant sets — each arrive with their
own checker or not at all.

#### What it does not catch

A name declared more than once in a file widens the scope back out. On the board
this came from, `new` is both `Client::new` and `Orangutan::new`; a claim of
`@cap=2048` anchored at `src/lib.rs#new` is answered by whichever of them holds
2048, so changing the slab alone does not fail it. Refs have no way to say
`Orangutan::new` today. The engine already tells an author when a name is
declared in several places, so the weakness is visible rather than silent — but
it is a real ceiling, and it is where a type-qualified ref would pay for itself.

### The glob restriction is the security design

`*` is allowed in the **last segment only**, and `**` never. The directory prefix
stays literal, so expansion is one listing of one directory, through `Workspace`,
which confines to the root and re-checks after `realpath`.

Refs are model-authored strings that become filesystem reads. A syntax able to
express "search the repo" is a disk-probe surface, not merely a cost problem, and
`src/*/layout.ts` is refused for that reason rather than because it would be hard
to support.

Directory and glob anchors also stop at **50 entries**. Past that the anchor is
skipped and counted rather than guessed at: a box standing for a thousand files is
not making a checkable claim, and reading them on every turn is not a per-turn
budget.

### The migration, and what it was worth

Five boards were marked `describes: "concept"` — the telecom ones, plus
`auth.excalidraw`, which despite its name is titled *"Wiley / board-ai
architecture"* and describes a different software project. They were picked by
reading titles and node labels, not filenames, which mislead here:
`architecture.excalidraw` is the IMS diagram.

| | before | after |
| --- | --- | --- |
| boxes checked | 12 | 12 |
| boxes **unexplained** | **105** | **5** |
| boxes excused by declaration | 0 | 100 |

Nothing new is checked. What changed is that the check no longer implies 105
boxes are missing annotations someone forgot: 100 of them were never claims about
this repository. The remaining five are `example.excalidraw`, which is genuinely
mixed — "Board MCP server" and "ELK layout engine" are this repo, "Claude Code"
and "You" are not — and needs per-box work rather than a board-level flag.

That per-box work has since been done, by following `/annotate-diagram`: two
boxes anchored, three declared `external`, and no box left unexplained. It cost
one box on the diagram. Anchoring both ends of "Board MCP server → ELK layout
engine" made that arrow flag, correctly — the server calls `diagram.ts`, which
calls the layout engine — so the board gained a "Diagram builder" box rather than
a looser anchor. The board now contributes 3 refs and 2 arrows to the check that
it contributed nothing to before.

## What an arrow is allowed to say

An arrow says "these two are related, somehow". Nothing can disprove "somehow":
the check looks for a connection in the code, and failing to find one is never
proof there is none. So a plain arrow has no negative verdict available to it,
and an arrow drawn backwards survives every run. That is a ceiling in the claim,
not in the checker.

### Three states, and only one of them is news

For most of this project's life there were two: confirmed, and amber. Amber was
rendered like a finding — painted on the board, listed in the notice, counted in
the headline, exit 1 — while meaning *nothing was found either way*. Absence of
evidence, dressed as evidence.

What that costs was measured on the first Rust board an agent drew here: 50
arrows, 17 amber, and **15 of the 17 carried a descriptive label and no claim at
all** — `owns`, `populates`, `fills i_buf`, `drains o_buf`. Eleven of them
pointed at a struct, while the body search walks function bodies looking for a
call. A board where 12% of the amber is actionable is a check somebody switches
off, and that is the same argument this tool already makes about good news
thirty times an hour, pointed the other way.

So an arrow now lands in one of three states:

| state | meaning | how it reads |
| --- | --- | --- |
| **confirmed** | a channel found the connection | silent |
| **unconfirmed** | read, and nothing found either way | a count, and a name under `--details`. No colour, no row on the canvas, no exit code |
| **unread** | nobody looked — an external end, a directory ref, a language with no reader | a count, as before |

And a finding is what is left: **a claim the code contradicts**. `backwards-edge`
for a `needs` pointing the wrong way, `broken-chain` for a `via` route that stops
holding. Both are things somebody wrote down on purpose, and both come with the
line of code that refutes them.

This is the converse of the rule `claim.ts` already stated. A word gets into the
vocabulary on the day something can call it wrong; an arrow that says nothing
checkable is, by the same rule, not something to be judged at all.

**Unconfirmed still has to be visible**, or this trades one dishonesty for
another — "checked 30 arrows · nothing drifted" reads as *30 arrows verified*. So
the count rides in three places: the closing line of a bare run (`17
unconfirmed, 20 unread, --details says why`), the board page's clean chip (`— 17
arrows were read and not confirmed`), and the `--details` audit, which names each
arrow by both box labels and groups them by reason:

| reason | what it means |
| --- | --- |
| `no-call-either-way` | both ends name something with a body, both bodies were read, neither reaches the other. The sharpest "nothing found" available here |
| `an-end-is-data` | an end names a struct, a static or a field, so there is no body on that side to search from — and the declarations were read too (below), so the signature, the field's own type and the enclosing block name nothing either. **Anchor that end at file level** and the import channels can answer instead |
| `nothing-connects-them` | the file-level channels came up empty: no import either way, no shared importer, no shared route, nothing in the code graph |

The second one is the only line in this report that can be acted on into
*better* coverage rather than a fix, which is why it carries the instruction in
the sentence rather than in a doc. It is also the one the measurement was mostly
made of: 11 of the 17 — five of which have since stopped being unconfirmed at
all, for the reason below.

#### Where a relationship to data is written

Five of those eleven were not a coverage ceiling. They were the search reading
the wrong lines.

A call search reads function bodies, and a data relationship is not written in
one. It is written in a return type (`-> &mut Client`), in a parameter type
(`fn(&Request) -> Response`), in the field's own declaration (`conns:
Slab<Client>`), or in the header of the block a method sits in (`impl Client`).
The engine parses all four; it just never read them.

It does now, and only when one end of the arrow names data. The gate is the
design, not a caution: between two functions "nothing calls the other" is a
question with an answer, and letting a shared parameter type confirm those
arrows would trade the sharpest sentence in the report for a much weaker one.
Where one end holds no code there is nothing sharp to lose — the alternative
reading is not *these are unrelated*, it is *we read the wrong lines*.

It is token-level and confirm-only like everything else: a name inside a string
or a comment is not a use, the declared name cannot confirm itself, and finding
nothing means nothing.

Measured on the same 50-arrow Rust board: **5 arrows moved from counted to
confirmed, 12 stayed counted, 0 new findings** — `an-end-is-data` from 11 to 6,
`no-call-either-way` untouched at 6, which is the gate visible in a number. A
stricter reading — types only, ignoring the rest of a signature — was measured
against the same seventeen and confirmed exactly the same five, so the reading
with no list of grammar field names in it was kept.

What generalises and what does not: the type-in-a-declaration half is every
language, because a declaration is a node with a name and a body is a field. The
enclosing-block half earns its keep where a language writes methods outside the
type they belong to — Rust's `impl`, and the same shape in Go, C++ and
Objective-C. A TypeScript class already holds its methods, so the body search
answered that one before any of this.

What this deliberately costs: two of those 17 arrows were genuine diagram
errors — a parse hop hung off the wrong function, and an arrow from a function
that never touches the collection it points at. Neither is a finding any more.
They are named under `--details`, in the `no-call-either-way` group, which is
kept as its own reason precisely so it can be promoted back to news cheaply if a
confirm-only vocabulary (#127) makes that worth doing. Judging an arrow that
claims nothing was catching them by accident, at a cost of thirteen false alarms
each.

An arrow can carry a word instead:

| word | on | claim | can it say *wrong*? |
| --- | --- | --- | --- |
| `needs` | arrows | the `from` end declares a dependency on the `to` end | yes |
| `feeds` | arrows | the `from` end's result goes into the `to` end | no — confirm-only |

`needs` means the narrow, textual, per-language fact of a dependency
declaration — an `import`, a `require`, an `#include`. It deliberately does not
mean "calls", "sends data to", or "depends on conceptually". That narrowness is
the whole point: a direction has an opposite, and an opposite is falsifiable.

`feeds` is the other thing an arrow usually means, and the two are not the same
fact — they frequently point opposite ways, because the file holding a result
imports the one that produced it. It has its own section below.

### A backwards arrow is the one thing on a board that can be wrong

This is the only verdict in the tool that refutes rather than confirms, and it
exists because `needs` has a direction. Draw `A → B` with `needs`, and if the
dependency runs from B to A **and only from B to A**, the arrow is not
unconfirmed — it is wrong, and the report says so in red, names the file and
line, and fails the build.

Five gates, all required:

| gate | why |
| --- | --- |
| the arrow carries `needs` | an unclaimed arrow means "related somehow", which has no opposite |
| its state is `built` | sketching a dependency that currently runs the other way is a thing people do on purpose |
| the language is licensed | `licence.ts` — TypeScript against the compiler over 12,824 edges, Rust against rust-analyzer over 2,539 |
| both ends are files of this repository | something other than our own reader has to agree the file is source at all — see the ledger below |
| neither end is dynamic or half-read | a file that reaches out at runtime, or that we could not parse to the end, cannot support *absence* |

And one more that is not a gate but a rule: **if the dependency exists both ways,
say nothing.** Cycles are legal in TypeScript and in Rust, and in a cycle neither arrow is
more correct than the other. The rule is not "ties do not happen" — this
repository has no cycles today, and that is luck rather than law.

Everything that is not `backwards` falls straight through to the checks it always
went through. A confirmed `needs` gets confirmed again a moment later by the
ordinary channels; one nothing corroborates is counted as unconfirmed, exactly
like an arrow that claimed nothing. The only row in the table that accuses
anybody is the wrong one.

That last part fixed a straight contradiction. A `needs` the direction check
declined to answer — one end reaching out at runtime, say — used to be counted
as withheld *and* painted amber by the corroboration channel, so one board said
"I could not check this" and "this looks wrong" about the same arrow at the same
time. Both of the claimed arrows on the Rust board were in exactly that state.

**A claim written this turn gets its own sentence.** The next turn's check is the
first one to see a `needs` an agent wrote a moment ago, and a bare "this is
wrong" then reads as the tool telling somebody off for something the tool itself
wrote. So when the committed board did not carry the claim and the working one
does, the message opens with *a claim written this turn is already wrong*.

**What was not checked is said out loud, in the default report.** A claim that
passed and a claim that was never checked look identical in a clean report, and
only one of them means the diagram is being held to anything. So the notice —
not just `--details` — names them by reason: in a cycle, in a language with no
measured reader, with an end that reaches out at runtime, with an end that could
not be parsed to the end, with an end no source index has ever read.

That list has a second half, and it is the one that caught the project owner
out (#113). The reasons above are `checkNeeds` reading two files and declining
to answer. An arrow can also be dropped *before* it ever gets there — an end not
snapped to its box, an end with no ref, an end marked external, an end that refs
a directory. Skipping an arrow is ordinarily right and ordinarily quiet, because
an arrow the checker cannot read is not news. A *claimed* arrow is the
exception: writing `@needs` is somebody asking a question out loud, and a report
that says nothing back reads as "checked, and fine".

The unsnapped case is the one worth knowing about, because it is invisible: an
arrow whose ends merely touch its boxes looks exactly like one snapped to them,
and both `startBinding` and `endBinding` are null. The report says so and says
what to do — *drag each end onto its box until the box highlights*.

It never changes the exit code. Nothing is failing; the claim was never tried.

**Where it lives.** `customData.edge.claim` is authoritative, and the word is
written onto the arrow's label as `@needs` — the same form a human can type onto
an arrow in the app. One syntax, both directions: a generated claim and a
hand-typed one are the same claim, and a board stripped of its `customData` still
says what it claimed. A claim you cannot see is a claim you cannot refuse, which
is why it is not metadata only.

**The whitelist is closed.** `@need`, `@depends`, `@sends` are errors the turn
they are written — red in the notice, non-zero exit, named in `create_diagram`'s
own answer before the turn ends. This follows `assert.ts`, which carries exactly
two words and refuses the rest: a vocabulary that accepts what it does not check
becomes decoration, and a claim nothing evaluates looks exactly like a claim that
passed.

### A box can be wrong too: `closed`

An arrow got a direction. A box gets a boundary.

| word | on | claim |
| --- | --- | --- |
| `closed` | boxes standing for a directory | nothing outside this directory imports anything inside it, except through the doors the box lists |

This is what an architecture diagram actually asserts. You draw a ring round a
subsystem, put the rest of the system outside it, and what you mean is *the rest
of the system does not reach in here*. Until now that ring meant nothing a check
could read.

```
Engine · src/server/board-server.ts:21 reaches in (+36 more)
```

**One import refutes it; nothing less than everything confirms it.** That
asymmetry is the whole design, because `needs` is about one pair of files and
`closed` is about every file there is:

- **Refuting is cheap and sound.** One import from outside, read out of the
  source text, and the claim is false. Nothing else has to be readable — we saw
  the line. A breach is reported even if half the repository could not be parsed.
- **Confirming is expensive and gated.** "Nothing reaches in" is a statement
  about every file, so it holds only if every file was read to the end. One file
  that could import at runtime and the honest answer is *no breach found* — which
  is a different sentence from *closed*, and is reported as a gap rather than as
  a pass or a failure.

Getting that backwards is the failure worth naming: a walk that quietly skipped
what it could not read would paint a green box over a subsystem it never opened.

**Three of the five escape flags count here.** `needs` withholds on all of them,
because any of them makes the text an incomplete account of what a file does.
`closed` asks something narrower — *could there be an import in here we did not
see?* — and the answer splits them:

| flag | hides an import? |
| --- | --- |
| `dynamic-import`, `eval` | yes, at runtime |
| `macro-expansion` | yes: a macro at item position is exactly where a `use` can be written and not read |
| `computed-call`, `mutable-function` | no. You cannot import through `table[key]()`, and no *call* creates a module dependency that is not already declared somewhere in the text |

The reader does better on macros than the flag suggests — it reassembles
`::`-joined runs out of token trees and reads `macro_rules!` bodies where they
are defined — but a macro from another crate can still expand to a path no file
here spells, and a claim that everything was read cannot be built on a file that
says it does not know what it declares. The split is by what an escape can hide,
not by how alarming it sounds, and it costs a confirmation only where a
confirmation would have been a guess.

**Tests are exempt, and the exemption is loud.** Tests reach into everything and
have to: testing a private function means importing it. Counting them would make
`closed` unclaimable in every repository that has a suite, which is a check
nobody would ever switch on. So they are held apart — and *counted in the
report*, never filtered out upstream:

```
80 imports into a closed box from tests, which do not break the claim
```

Renaming a file to `foo.test.ts` moves a breach from one list to the other, in
public. It does not make it disappear. That visibility is the only thing standing
between an exclusion and a loophole.

**A stale door is reported too.** A door nobody came through is not a failure —
a subsystem being tidier than it promised — but it is usually a door that *was*
used until the import that needed it moved, and a door nobody removes silently
widens the claim.

**It only walks when you ask.** Every other check here is bounded by the diagram:
a box names a file, an arrow names two. A `closed` box makes a claim about the
whole repository, so proving it means walking the tree — and that walk happens
only on boards that carry the claim. No `closed` box, no walk; one walk covers
however many a board carries.

**Measured on this repo.** No directory here is closed. `src/engine` is reached
by 37 imports from outside once `drift.ts` is listed as a door, and `src/viewer`
has no breach at all but cannot be *confirmed*, because 7 files elsewhere import
at runtime. Both of those are facts nobody knew before the claim existed, which
is the point.

### What drew this board: the stamp

A board outlives the release that drew it. It sits in a repository for months
while the tool around it changes, and until recently it recorded nothing at all
about which version produced it — so a board drawn a year ago and a board drawn
this morning were byte-for-byte indistinguishable, and any change to what
something on a board *means* had to be applied blind to both.

Generated boards now carry a stamp at the top level of the file:

```json
{
  "type": "excalidraw",
  "version": 2,
  "source": "diagramos",
  "diagramos": { "version": "0.2.0-rc.2", "schema": 1 },
  "elements": [ ... ]
}
```

Two numbers, because they answer different questions at different rates.
`version` is the npm version — it moves on every release, says nothing about
meaning, and exists for forensics: *which build wrote this*, when a bug report
arrives with a board attached. `schema` is the one that carries meaning, bumped
only when what a board *says* changes, so a difference in it is worth reading.

**Absence is a reading, not a gap.** No stamp means the board predates stamping,
which is **schema 1** — the meaning in force the day it began. That is correct
for every board drawn to date and it is the only answer available for a
hand-drawn file, which has nothing generated to stamp.

**Nothing backfills it.** The stamp is written by `create_diagram`, at the one
moment it is true. If `readBoard` supplied it as a default then opening an old
board and saving it would quietly relabel it as current — destroying the exact
signal the stamp exists to carry, for every board anybody touched. Every other
writer edits a board somebody else generated and leaves the stamp alone, so
"drawn by 0.1.0" does not become "drawn by 0.3.0" because a box got dragged.

**Top level, not on an element.** It is a fact about the file rather than about
anything drawn in it, and two of this repository's own boards have no title
element to hang it from. That placement has one cost, and it had to be paid:
the live board's browser rebuilds the file object from the canvas with a fixed
set of keys, so anything else at the top level was dropped the first time
somebody dragged a box. The save path now merges onto what is on disk instead of
writing over it — the browser still wins on everything it actually sends, and
keys it has no opinion about survive.

**When `schema` gets bumped** is decided in `claim.ts`, beside the rule about
what a word has to earn. Additive and quieting changes leave it alone and apply
to every board at once; only a change that makes a board *louder* needs to know
its age. A bump nothing reads differently is a number for its own sake.

### A board can be wrong by omission: `complete`

Every word above is **local**. `needs` is about one arrow, `closed` about one
directory's boundary, and each is refuted by reading the one thing it names.
Which means none of them can catch what a board *leaves out*: delete a box and
no check notices, grow the code a module the picture never had and the report
stays clean. The absence of a box has carried no information at all.

| word | on | claim |
| --- | --- | --- |
| `complete` | the board, scoped to a directory | every module under it that this board reaches has a box of its own |

That is the weaker half of drift and the half a diagram-driven workflow actually
needs. The point of drawing the design first is that the code should not quietly
grow past it.

**The computation is not new; the standing to report it is.** `unrepresented`
has computed exactly this for most of the project's life — modules a box imports
that no box covers — and it has always been a suggestion, off unless
`coverage: true` was asked for. Not because it was wrong. Because nobody asked
it. Whether a module deserves a box is a judgement about what is worth showing,
and an engine that volunteers one every turn is one that gets switched off,
taking the quiet correct checks with it.

A claim changes the speaker. The author says the picture is complete here, the
engine reads it, and a module nobody drew is that person's own assertion coming
back wrong. Silence means it held.

```
The engine · @complete says this board shows every module under src/engine that
it reaches. src/engine/feeds.ts has no box and src/engine/drift.ts imports it,
and 3 more modules are missing too. Draw them, or narrow the claim.
```

One row per board, not per module, for the reason `closed` gives one row per
box: twelve undrawn modules under one directory is one incomplete picture, and
twelve rows saying so is how a report stops being read. The full list is in
`undrawn`.

**The bound, which is what usually sinks a completeness claim.** *"Everything
that touches `Orangutan`"* is checkable; *"everything that touches `parse`"* is
not, because the name is everywhere and the walk returns the repository. This
claim never faces that. Its target is a directory rather than a symbol, and its
candidates are the ones `unrepresented` already bounds: a module has to be
connected to something already drawn before it can count as missing, so
relevance is inherited from whoever drew the diagram rather than invented. A
helper no box imports is never nominated.

**Three things it refuses rather than answers.** A scope that is not a
directory. A scope with no files in it. And — the one worth stating — a scope
that a single box already covers whole:

```
@complete about src/engine cannot be checked while a box on this board covers
that whole directory: everything inside it is drawn by that one box, so nothing
could ever come back missing.
```

A directory ref covers everything beneath it, so a box standing for the scope
excuses every module inside from ever being unrepresented. The claim could then
only come back green, which is precisely the guaranteed-green that `claim.ts`
admits no word for. Refusing is the only honest answer.

**And one it declines to answer.** A scope holding files in a language no reader
is measured for is reported *unproven*, never held — the same third state
`closed` takes, for the same reason. Nothing was read, so nothing was proved,
and a clean bill earned by a walk that opened nothing is the one thing this tool
exists not to print. (#131 widened the gate from TypeScript to every licensed
language, so this is now narrower than it was, but it is still reachable.)

**A concept board cannot claim it.** The board is not about this repository, so
there is no directory here for the claim to be about. Refused at creation rather
than ignored at check time, while the author is still present.

### The coverage ledger: is this a file of the repository at all?

Every gate above asks something about a file's *contents* — is the language
measured, did the parse finish, does the code reach out at runtime. None of them
asks the prior question. The reader will parse a 13 MB generated bundle in
`vendor/`, or a minified chunk under `out/viewer/assets/`, exactly as cheerfully
as it parses `src/engine/drift.ts`, and hand back a confident list of
dependencies from something nobody wrote or maintains.

**Measured on this repo: 142 such files clear every other gate.** They are static,
they parse to the end, they are in a licensed language. Only this stops them.

So a verdict now needs a second opinion that the file is source, from somewhere
that is not our own reader. Two places already hold one, and a file only has to
satisfy **either**:

| authority | what it knows | where it is right |
| --- | --- | --- |
| git | everything tracked, plus everything untracked that no ignore rule covers | a file you created one second ago |
| `graphify-out/manifest.json` | every file graphify walked, with an mtime and an AST hash | a tree with no `.git`, and directories git ignores |

**Either, not both, and the reason is a number.** The manifest alone vouches for
70 of this repository's 92 source files, because it is built at commit time and
the files you are working on are the newest ones. Gate on it by itself and the
check goes quiet on 41 files somebody wrote — which is a gate that switches
itself off exactly when you are using it. Somebody already wrote down which files
are build output; it is called `.gitignore`, and `--exclude-standard` is what
reads it.

**It does not answer freshness, and must not be read as if it does.** The ledger
says a file *is* source, not that any index of it is current. Our own reader
always reads the file on disk as it is right now, so a file edited since graphify
last ran is still perfectly readable. Gating on the AST hash would silence the
check on every file you touched. Staleness is a question about the *graph*, and
the code-graph channel already answers it there.

**The two claims use it in opposite directions**, which is the part worth being
careful about:

- **`needs` subtracts.** It is a claim about two named files, and the accusation
  says one of them contains no such dependency. An end nothing vouches for is an
  end at the edge of the repository, and the verdict is withheld — reported as
  *with an end no source index has ever read*.
- **`closed` adds.** The tree walk behind it refuses to enter dotted and vendored
  directories and says nothing about having done so. A script in one of them can
  import straight into the box, and the box would go green on a walk that never
  opened the file. The ledger names what is in there, so those files get read
  after all. A file the ledger has *not* heard of is never held against `closed`:
  we read the text ourselves, and the absence of an import in it is our own
  evidence.

**Absent means off.** No git and no manifest, unparseable JSON, a shape we do not
recognise, a ledger vouching for nothing: all of those switch the gate off
entirely. A second opinion nobody gave is not a second opinion that said no. On
this repository every board produces a byte-identical report with the ledger and
without it — what changed is what would happen if somebody drew an arrow at
`vendor/excalidraw-headless.mjs`.

**Claims are authored, never inferred.** The measurement in `assert.ts` is the
standing answer: applied blindly to all 121 exports in this repo, `@declared` /
`@used` flagged 35 — 29% noise. Applied where an author wrote it: zero false
alarms. The rule for a model writing `needs` follows from that — write it only
when you have read the dependency in the code, so the claim is a transcription
and not a hypothesis. A later "wrong" then means *this was true when drawn, and
the code has moved*.

The same rule governs `@declared` / `@used` on a box, and it costs nothing to
follow: setting a symbol ref already means having that file open, so the
declaration and the call sites were on screen when the ref was written.
Transcribing them is free; guessing them is what produces the 29%. A symbol
declared in one file and called only from others takes `@declared` alone, and a
file nobody read takes no suffix at all — the smaller claim, not the worse one.

## Reading dependencies ourselves

Confirming and refuting want opposite evidence, so they get different readers.

**Confirming** wants breadth: any connection at all, found any way. That is the
five channels in `drift.ts` plus the code graph, and it can afford to be
generous, because being generous only ever produces silence.

**Refuting** wants the tightest evidence there is: one dependency declaration,
read out of the source text of a file we know we parsed completely, in a
language somebody measured. It is the verdict that can cost trust, so it does
not rest on anything we cannot measure end to end. `src/engine/deps.ts` is that
reader. Nothing calls it yet.

Per file it answers three things, and the second and third exist to stop the
first being over-trusted:

| answer | what it is for |
| --- | --- |
| dependencies | what the file declares, resolved to files in this repo |
| complete | false when the parse recovered from an error, so nothing can be proved *absent* in it |
| dynamic | the ways it reaches out at runtime, where no reader can follow |

### Why not graphify's

Graphify keeps confirming and is good at it. Its JS/TS pass reaches
`import('x')` only through a regex rescue whose docstring says it has false
positives in comments and strings, because its own walker never visits calls at
module scope. That trade is right for breadth and fatal for refutation: a false
positive there is a false accusation about somebody's diagram. This reader walks
the whole tree, so a dynamic import at module scope is an ordinary node and
there is nothing to rescue.

The same argument runs the other way for one piece, and that piece was taken:
**graphify's import resolution rules**, ported into `src/engine/resolve.ts` with
attribution. `import { x } from "@/engine/foo"` is a nickname, and what `@/`
stands for lives in a tsconfig that may be JSONC, may extend three others, and
may set `baseUrl`. Our resolver read none of that, and this repository declares
no nicknames — so the hole was invisible from inside our own tree and would only
ever have surfaced in somebody else's, as a dependency we could not find and
therefore an arrow we called backwards.

### What it measures on this repo

`npm run measure:deps` runs both channels over the tree and prints the
difference. When this was written, over 103 files:

- **240 dependency edges** from the regex channel, **239** from the reader.
- **One** edge only the regex found:
  `path.join(import.meta.dirname, "../docs/diagrams/board-internals.excalidraw")`,
  which reads to a pattern as an import of a diagram and to a grammar as an
  argument to a function.
- **None** the other way. The reader never invents an edge the channel missed.
- **One file cannot be read to the end**: `font.ts`, which builds a cache key
  with a literal NUL byte. Recovery is local, so its dependencies are still
  found — it just cannot support a claim that something is *absent*.
- **9 of 103 files escape statically.** Flagged per file, never per repo, so one
  dynamic corner does not cost a whole codebase its verdicts.

Finding all of that also fixed a disagreement inside the engine: `languageOf`
did not recognise `.mts` or `.cts` while `drift.ts` already counted them as
TypeScript, so five of this repo's own script files parsed as nothing at all.

## The licence: earning the right to say "wrong"

A "wrong" verdict is an accusation. It says the arrow points one way and the
code points the other, and it rests on two claims at once: the dependency exists
in the direction the code has it, and it does *not* exist in the direction the
board drew. Both kinds of reader error turn into a false accusation. An edge
invented makes the tool accuse on evidence that was never there. An edge missed
makes it accuse because it mistook its own blindness for an absence. Neither is
recoverable once somebody has stopped believing the tool.

So no language gets to say "wrong" until the misses have been counted, and the
count lives in `src/engine/licence.ts` where it can be argued with.

### The referee is not us

The two channels agreeing was never the evidence it looked like. `deps.ts` finds
specifiers with a grammar and the regex channel finds them with a pattern, but
**both hand what they find to `resolve.ts`** to turn into a file. Their agreement
says nothing at all about the step they share — and that shared step is where the
tsconfig and package.json nicknames live, which is the part most likely to be
wrong and the part this repository, declaring none of its own, could never
exercise.

The referee is the TypeScript compiler: `ts.createSourceFile` for the
specifiers, `ts.resolveModuleName` for the files. Not our parse, not our
resolver, not our idea of what an import is. Disagreeing with it is our bug by
definition.

`scripts/lib/licence.ts` runs both over the same tree.
`npm run measure:licence` reproduces the number; `--check` fails if it has
moved.

### What it cost, and what it bought

The first run found **121 dependencies the compiler saw and the reader did
not** — none of them visible from inside this repository. Each one turned into a
rule:

| what was missing | found in |
| --- | --- |
| a type-only module: `./utils` where the only file is `utils.d.ts` | vue, excalidraw, vite |
| package.json `imports`: `#dep-types/connect` | vite, 77 edges by itself |
| conditional targets — taking the first branch offered instead of the one every reader shares | vite |
| a `#` nickname declared in tsconfig `paths` rather than package.json | vite |
| a directory whose own package.json names an entry other than `index` | vite |
| a package importing itself by its published name | vite, TanStack |
| a specifier in backticks with nothing interpolated into it | vite |
| `.cjs` meaning `.cts`, where `.js` and `.mjs` were already handled | vite |

Two of those were bugs introduced *while* fixing the others, and the referee
caught both in the same run: reserving `#` for Node lost a tsconfig alias, and
self-reference without an `exports` field asserted an edge Node itself refuses.

### The number

Measured 2026-08-21 over five repositories at pinned commits — vue, vite,
TanStack Query, Excalidraw and NestJS, chosen because all five declare nicknames
and this repository does not:

| | |
| --- | --- |
| files | 5,759 |
| dependency edges | 12,824 |
| missed — the compiler saw it, the reader did not | **2** |
| invented — the reader saw it, the compiler did not | **1** |
| recall | **99.984%** |
| precision | **99.992%** |

The three that remain are named in the licence rather than rounded away:

- A package importing itself through a condition only its own build defines.
  TanStack Query routes `.` to `src/index.ts` via a custom tsconfig condition;
  every condition a reader can know about points at build output that is not in
  a fresh clone.
- `./x.js` where both `x.js` and `x.ts` exist. The compiler takes the TypeScript
  file, the reader takes the one actually named, and there is no third answer in
  the text. One vite fixture does this, and it is both the miss and the
  invention.

This repository is deliberately **not** in the corpus: its file count moves with
every commit, so a pinned row would be wrong by the next one. It is measured
continuously instead — `tests/engine-licence.test.ts` runs the same harness over
the working tree and fails on any disagreement at all, which is stricter than a
number in a table and runs in CI where the corpus cannot.

### A second language, to find out whether this is a mechanism

A fair question about all of the above: is the licence a mechanism, or is it a
story told about TypeScript? The way to find out is to put through a language
that shares nothing with TypeScript except the idea of one file needing another
— and Rust does not even share the word. A TypeScript specifier is a path with
half the answer written in it. A Rust path names a position in a *module tree*
that no single file contains: `crate::ptr::Own` is meaningless until the `mod`
declarations scattered across the crate have said where `ptr` lives.

**The referee is rust-analyzer**, asked for an LSIF dump — the same name
resolution an editor does, and neither a nightly toolchain nor a successful
build is needed, which is what made measuring five repositories practical. A
path counts as naming a file when what it resolves to is a *module*, which
rust-analyzer states itself in the hover text on every result, so both sides
mean the same thing by an edge.

It went the way step 3 went, which is the point:

| what was missing | found in |
| --- | --- |
| `[[bin]] path = "crates/core/main.rs"` — a crate root nowhere near a `src/` | ripgrep, 95 edges by itself |
| `autotests = false` — with it, `tests/*.rs` are modules; without, each is its own crate | ripgrep, regex |
| `super` inside an inline `mod tests`, which is the file itself and not its parent | ripgrep, 11 false edges |
| a short name the file bound with `use crate::args;` and then wrote as `args::syntax` | regex, 110 edges |
| `pub extern crate grep_printer as printer;` — a crate re-exported under another name | ripgrep, 30 edges |
| uniform paths: `pub use generator::*;` beside `mod generator;` | clap |
| `#[path = "../src/lexical/mod.rs"]`, which puts one file in two crates at once | serde_json |
| paths inside a macro's token tree, where `write!(f, "{:?}", crate::util::escape::X)` has no path node at all | regex |
| `quote! { .. }`, which is the *opposite* — code being written, not code being run | clap, 7 false edges |

None of those were guessable from a repository with no Rust in it, which is the
argument for the licence in one paragraph.

| | TypeScript | Rust |
| --- | --- | --- |
| repositories | 5 | 5 |
| files | 5,759 | 662 |
| dependency edges | 12,824 | 2,539 |
| missed | 2 | 5 |
| invented | 1 | 29 |
| recall | 99.984% | **99.803%** |
| precision | 99.992% | **98.869%** |
| source files left out of the measurement | 0 | **113 of 775 (15%)** |

**Rust's sample is 85% of its corpus, and the last row is why.** A file no crate
declares is a file rustc never compiles, so rust-analyzer never opens it and has
no opinion to disagree with. Those files are excluded from both sides, so the
percentages are honest about the sample they describe — but the sample is not the
tree, and the files a referee fails to load are not a random 15%: they are the
awkward ones. Clap alone accounts for 69 of the 113. The count is recorded per
repository in `licence.ts` and `--check` fails if it moves, because a number
whose denominator you cannot see is a number you cannot argue with.

Rust's precision is the weaker number and the licence says why rather than
rounding it away. Nineteen of the twenty-nine are one shape: a file compiled
into two crates at once, where `crate::` means a different file in each build.
The reader gives both answers; rust-analyzer files each source file under a
single crate and gives that one. It is the same reason the referee has no edge
for serde_json's own `mod lexical;`, a line plainly there in the text.

### What is not licensed

Everything else. The licence names extensions, and a file whose extension no
licence covers is a file no verdict may be built on — the same silence an
unsupported language already gets everywhere else in the engine. Graphify's
per-language extractors sit at visibly different maturities and publish no
recall figure anywhere, so these numbers transfer to nothing but the languages
they name.

The licence is consulted by `needs` (`needs.ts`) and by `closed` (`closed.ts`),
and by the walk that feeds `closed`: it looks for every file a licence covers,
so a Rust file reaching into a closed box is found rather than passed over. A
file with no licence is not skipped there — it is recorded as unread, which
costs the box its confirmation.

## Two jobs, deliberately separate

| | Cost | Needs a model | When to run |
| --- | --- | --- | --- |
| **Detection** — does the diagram disagree with the code? | milliseconds | no | every edit, pre-commit, CI |
| **Regeneration** — what should the diagram now say? | a model call | yes | when a human or the drift report asks |

Keeping these apart is the whole design. Detection is deterministic and safe to
run constantly; regeneration is a judgement call about what is worth showing and
should not fire on every keystroke.

## What "drift" means concretely

A diagram node claims a thing exists. Drift is a mismatch between that claim and
the repository. Three kinds, in descending confidence:

1. **Missing** — a node names a module, file, or symbol that no longer exists.
   High confidence, almost always actionable.
2. **Unrepresented** — a significant module exists in the code but appears
   nowhere on the board. Built, on demand only; see "Code the diagram does not
   show" for how the relevance question was answered.
3. **Edge mismatch** — the diagram draws `A → B` but nothing in `A` imports or
   calls `B`, or a real dependency is undrawn. The most valuable signal and the
   most likely to produce false positives.

Start with (1). It is nearly free and nearly always right. Add (2) and (3) only
once (1) is quiet in practice.

## Binding nodes to code

Detection needs to know what a node refers to. Guessing from the label is
unreliable ("Auth" could be anything). Better: let a node record its referent
explicitly.

```jsonc
// customData on a generated node
{ "node": "layout", "ref": "src/engine/layout.ts" }
```

Add an optional `ref` to the `create_diagram` node schema — a repo-relative path
or a `path#symbol`. Nodes without a `ref` are simply skipped by detection rather
than guessed at. Opt-in keeps false positives near zero, which is what decides
whether anyone leaves the check switched on.

## Tool and script surface

- `check_drift(path)` — MCP tool. Returns `{ boards[], clean: boolean, findings[], edges[] }`,
  plus `deleted[]`, `workItems[]`, `promotions[]`, `conceptBoards[]`, `unannotated[]`,
  `unreadEdges[]`,
  `unrepresented[]`, `skippedWhy`, `edgesSkippedWhy` and `assertions` when non-empty.
  A new `DriftKind` is a new member of `findings[]`, not a new array: the handler
  spreads each finding generically, so it needs no change beyond its description.
  Read-only; never edits the board.
- `scripts/check-drift.mjs <board>` — same logic, CLI, non-zero exit when drift
  is found. This is what hooks and CI call.
- `npm run measure:deps` — both dependency channels over this tree, and the
  difference between them.
- `npm run measure:licence` — the reader against each language's referee over
  the pinned corpus, cloning what is missing into `.corpus/`. `--check` exits
  non-zero if the committed number has moved; `--only=rust` measures one
  language; a path argument measures one tree of your own instead. Needs the
  network, and Rust needs `rust-analyzer` on the PATH — without it that half
  fails loudly rather than scoring nothing against a referee that never ran.

Sharing one implementation in `src/engine/drift.ts` keeps the tool and the
script from disagreeing.

## Wiring it to fire automatically

MCP is pull-only: a tool sits there until the model calls it. Automatic
behaviour has to come from the harness.

- **Soft** — a line in the plugin skill: regenerate the affected diagram after
  changing module structure. Usually works, not guaranteed.
- **Hard** — a `Stop` hook runs `check-drift.mjs` once per turn. The harness
  executes it whether or not the model remembered. This is what is built.
- **Hardest** — pre-commit or CI, catching drift introduced without Claude. The
  script's exit code is there for it, and the README now carries the one-line
  recipe. Nothing in this repository's own CI runs it yet.

## Shipping the hook

The `Stop` hook lived in this repository's `.claude/settings.json` and nowhere
else, so the check ran here and for nobody else. The stated objection to shipping
it — a subprocess on every turn in projects with no diagrams — turned out to be
cheap to answer, once measured in a git repo with no diagrams at all:

| path | cold | warm |
| --- | --- | --- |
| `node out/cli/diagramos.mjs drift --hook` | 320 ms | 60 ms |
| `npx -y diagramos drift --hook` (what a plugin user pays) | 540 ms | **260 ms** |

Silent, exit 0. And nearly all of that is npx and node starting up rather than
work: the script already finds no diagram directory and stops. So there was
nothing left to optimise inside it, and the saving had to happen *before* it is
launched. `hooks/drift.sh` is that guard, and it is two tests:

```sh
[ -d docs/diagrams ] || [ -f .diagramos.json ] || exit 0
```

Both are needed. The diagram directory is configurable, so testing only the
default would silently skip every project that moved it — checking nothing while
appearing to work, which is the failure this whole area exists to catch.

Three details that are each one bug:

- **A shell script invoked through `sh`, not an inline command.** Installing a
  plugin copies files into a cache, and relying on the executable bit surviving
  that is a guess; `sh path` needs no `+x`. It also puts this reasoning next to
  the guard rather than inside a JSON string.
- **Not `exec npx`.** `exec` replaces the shell, so npx's exit status would
  become the hook's and the `|| exit 0` after it would never run.
- **A launch failure is swallowed.** `--hook` exits 0 once it has delivered its
  notice, so a non-zero status from npx means it could not fetch or run the
  package at all — offline, a broken cache. Passing that through would put
  "Stop hook error: Failed" on every turn of a project that simply has no
  network, and that is how a check gets switched off for good.

`tests/plugin-hook.test.ts` pins all of it with a fake `npx` first on `PATH`, so
the assertions are about whether the real command *would have been launched* and
never about what it would have said. It also pins the version in three places at
once — `package.json`, the plugin manifest, and the hook script — because nothing
else checked that they agreed, and a pin that has drifted is worse than none.

The config shape was worth confirming twice, since a wrong key fails silently:
the published docs say `Stop` ignores matchers, while the plugin-dev validator
rejects a hook without one. `"matcher": "*"` satisfies both.

Every reporting channel was measured on a real `Stop` hook, in three rounds:

| Script behaviour | What the user sees |
| --- | --- |
| stderr, exit 1 | `Stop hook error: Failed with non-blocking status code:` then the full report |
| plain text on stdout, exit 0 | nothing at all |
| **JSON on stdout with `systemMessage`, exit 0** | **the message, rendered as an ordinary notice** |

The third row is what the check now uses, behind `--hook`. For most of this
project's life the first row was believed to be the only channel that worked, and
the report was written to apologise for the "Stop hook error" framing — a check
that had to explain it was not broken every time it spoke. It isn't necessary.

What survives inside a `systemMessage`, measured the same way: newlines,
indentation, box-drawing characters, symbols, **and ANSI colour**. Markdown
arrives literally, so `**bold**` shows its asterisks.

Colour took two rounds to establish, and the first answer was wrong. A probe put
escapes in a notice and the reply came back as pasted text — where colour is
invisible either way — which was read as "stripped". It is not: red and yellow
render. The report therefore carries severity in colour, not in emoji, which
matters for more than looks: an escape sequence occupies zero cells, while `⚠️` is
*ambiguous* width (one cell in some terminals, two in others) and sheared every
padded row it appeared in.

`/expand-report` leaves the notice expanded from then on, and `/shrink-report` puts
it back. That is a mode, which is normally the wrong answer — but a command runs
*during* a turn and the notice is written by the hook *after* it, so affecting a
later notice can only be done by leaving something behind. It is a marker file in
`.diagramos/` (gitignored, so it is one person's preference and not the repo's), and
the objection to modes is answered by the notice itself: while expanded, its footer
names `/shrink-report`. Nothing is remembered that the notice does not say out loud.
`--details` remains the one-off that changes nothing.

The notice is a box, kept to four lines for a single stale diagram: the diagram and
its counts ride in the top border, `/update-diagram` rides in the bottom, and there
is no legend — a symbol needing a footnote every turn is the wrong symbol. Several
stale diagrams get a line each with their own counts rather than a box each.

The message begins with a newline. Claude Code prefixes the first line
("Stop says: …"), which pushed the top border right by the width of that prefix and
left the box visibly crooked.

Long names are cut with an ellipsis rather than allowed to stretch the border, and
`tests/box.test.ts` pins the arithmetic: every line of a rendered box comes out the
same display width, colour counts as zero cells, and arrows and box-drawing
characters count as one.

Exit 2 was considered and not used: it puts the text in front of the model and
blocks the turn from ending. See "Reporting is not the same as being actionable".

The exit code now depends on the caller, which is the one thing to be careful
about: `--hook` exits 0 because the notice has already been delivered, while a
bare run exits non-zero so CI and pre-commit can fail on it. Both are pinned by
tests; getting them backwards either loses the report or fails a build over a
diagram.

## Reporting is not the same as being actionable

The check reported the problem and stopped short of the one thing a reader needs:
that anything can be done about it. The guidance line existed, but it was gated on
`process.stderr.isTTY` — true in a terminal, false from a hook, which is the way
it actually runs. So in normal use nobody ever saw it. Measured against the old
script from a pipe: findings, then nothing.

Fixed by printing one line that names `/update-diagram`, unconditionally. The earlier
reasoning for the gate — that from a hook this is a third line nobody asked to
read — was right about noise and wrong about which line was noise.

**`/update-diagram` is a command, not an automatic behaviour.** The alternative was
designed and rejected: exit **2** instead of 1 puts the report in front of the
model and blocks the turn from ending, which is precisely "go and fix the
diagram". It was not built, for two reasons.

- **Regeneration is not free.** It replaces what was generated before, so a board
  someone arranged by hand comes back arranged by the engine. Doing that silently,
  possibly while they are looking at it, is hostile.
- **A fix that cannot succeed blocks the turn.** Exit 2 loops until the model
  gets it right, and a box pointing at code that genuinely no longer exists has
  no correct redraw the model can guess. `stop_hook_active` in the hook's stdin
  is the documented escape, and the docs have already been wrong twice in this
  project — about matchers, and about stdout visibility — so it would need
  measuring, not trusting, before anything shipped that depends on it.

A command costs one thing to type when the reader decides it is worth it, and
carries none of that risk. If the automatic version is ever wanted, it belongs
behind a flag on the script, off by default, with `stop_hook_active` verified
empirically first.

## The report says where the code went

A finding that says "this points at nothing" is true and hands the reader a
search. Most of the time the search has a written-down answer: the file moved and
the design did not change, and git recorded the move at the time it happened.
Asking a model to go looking for that is the expensive, non-reproducible way to
get an answer the repository can state.

So a stale anchor is followed, and the report carries the destination next to the
finding:

```
Layout → src/old-layout.ts
  ↳ moved to src/engine/layout.ts — git recorded the rename.
Renderer → render in src/renderer.ts
  ↳ render is declared in src/engine/render.ts now, and nowhere else.
```

**Two channels, and the third was thrown out on the measurement.**
`docs/rebind-measurement.md` replayed 281 broken anchors across two histories and
sorted every answer by where it came from.

- **rename** — git recorded the move. 119 answers, no wrong ones found.
- **symbol** — the name is *declared* in exactly one file in the tree now.
  Declared, not mentioned: a call site is not a place to re-aim a box. 18
  answers, no wrong ones found.
- **filename** — a file elsewhere with the same basename. Not asked. It produced
  every wrong answer in both histories, all three of them on a file called
  `index.ts` or `__init__.py`, and its wrong answers are indistinguishable from
  its right ones: one candidate, stated confidently. A name every directory has
  identifies nothing.

More than one candidate and the follower declines and says why, which is a better
report than silence and still not an instruction.

**Nothing is rewritten.** The suggestion sits under the finding; the finding still
counts, `clean` is still false, and the exit code does not move. That restraint is
the conclusion of the measurement rather than caution for its own sake: a wrong
rebind is silent, and a board that quietly re-aims itself at the wrong function is
worse than one that says "come and look". Whether an `--apply` ever exists is a
separate decision, and the thing that would earn it is a season of suggestions a
person accepted every time.

**It costs nothing when nothing is wrong.** Git is not asked anything until a box
is already a finding, so the clean report — the one that fires at the end of every
turn — never shells out at all. `create_diagram` and `edit_diagram` answer the
same way, at the moment the ref is written, which is the cheapest time to fix it.

The live board page does not show this yet. It reads the same report, so the field
is there for it whenever the viewer bundle catches up.

### And can write it back, when asked

`diagramos drift --repair` applies the answers that have exactly one address and
prints every one of them, old ref and new:

```
┌─ arch.excalidraw  2 repaired ───────────────────────────────────┐
│ Layout · src/old-layout.ts → src/engine/layout.ts               │
│ Renderer · src/renderer.ts#render → src/engine/render.ts#render │
└─ refs rewritten from git · check the diff before committing ────┘
```

Then it re-checks, so the run that repaired a board reports the board it left
behind rather than the one it found.

**It is a flag and not a behaviour, and `--hook` refuses it outright.** The
per-turn path runs unattended, and an unattended rebind is precisely the silent
failure the measurement warned about. A repair somebody typed and can read in
their diff is a different thing from one that happened while they were looking
elsewhere, and the difference is the whole safety argument.

What it will not touch, all of it enforced rather than documented:

- **An answer with more than one candidate.** Only `becomes` is applied.
- **Hand-drawn elements**, by construction — a repair is matched back to its
  element through the *recorded* graph, and an `inferred` anchor never reaches
  the follower at all.
- **A ref that changed under the report.** The old string has to still be on the
  box; if it is not, the entry is held and said so.
- **Anything but the address.** Position, size, label, state, bindings and the
  box's other anchors come out identical. `version` moves, because something did
  change and a live viewer has to notice.

The order matters: repairs run before promotions, so a box whose ref this fixes
is judged again on its new address rather than promoted on the strength of the
old one.

## A plan the code went the other way on

You draw the plan first, mark the arrow `planned`, and Claude goes and writes the
code. Every run the check asks one question about that arrow — has this been
built yet — and when the answer is yes it says so and advances the board. That
green line is the only good news the tool produces.

It was answering the wrong question. "Built yet" asks whether the two ends are
connected, and connected has no direction: if the arrow plans `A needs B` and
what landed is B depending on A, the two files are connected all the same. The
answer came back yes, the plan was reported as done, and the board was rewritten.
The direction was read on the run *after* — once the arrow was `built`, which is
where the wrong verdict is gated — and said the opposite:

```
run 1   Two → One is built now — board updated
run 2   Two → (should be ←) One · drawn backwards
```

Two runs, opposite answers about the same arrow, nothing changed in between. The
first is the one people act on.

**The question is asked before the promotion now.** A `planned` arrow carrying
`@needs` gets the same direction check a `built` one gets, with the same four
gates — both ends in a measured language, both vouched for by a source index,
both parsed to the end, neither reaching out at runtime, and no cycle. Only one
verdict is acted on. `backwards` holds the promotion back and files a work item;
confirmed, withheld and cycle all fall through to the ordinary channels exactly
as before, because each of those is the tool being unable to tell, and *cannot
tell* must never become *did not land*.

```
One → Two · built the other way round
  ↳ code right? /accept-arrow "one -> two"
```

**Amber, and never red.** This is the one place the `planned` safety rule was
worth re-deriving rather than reusing. `backwards-edge` on a built arrow is an
accusation, and here it would be a lie: sketching an arrow that inverts a
dependency existing today is a thing people do on purpose, and from inside the
check that plan and a plan an agent implemented backwards are the same two files
pointing the same way. Git history does not separate them either — a turn touches
unrelated files, a human adds the import by hand, a rebase brings one in.

So the row states what the code does, names the file and the line, and draws no
conclusion about who is wrong. It does not touch the exit code, it is not in
`findings`, and a plan still cannot fail a build. What it does establish is the
half that was never in doubt: **the arrow that was drawn is not the one that was
built**, so the plan has not landed and the board must not say it has.

**It shows without `--details`.** Every other work item waits to be asked for, on
the grounds that a sketch the code has not reached would sit there unchanged for
a whole design session. This one replaces a line that was green and appeared by
default, and a fix whose only visible effect is that the good news stopped is not
a fix.

**The promotion stopped carrying a warning about `@needs`.** It used to say the
claim would be read for the first time on the next check, which existed to stop
the two contradicting runs above from reading as the tool changing its mind. That
sequence can no longer happen: a promoted `@needs` is one whose direction either
confirmed or is one nothing can answer. `@feeds` keeps the line — it has no
direction to be wrong about and no check on the way in.

**`/accept-arrow` answers it too.** If the plan was transcribed backwards, the way
out is the same act on the same arrow, and leaving it to hand-edited JSON would
put back exactly the gap the section below closed, one state over. Nothing is
promoted by the accept: the arrow now runs the way the code does, so the next
check corroborates and promotes it through the ordinary path.

## Accepting a backwards arrow

Every write above either corrects an *address* or releases a plan gate the code
already opened. Neither changes what a diagram claims. `--accept` does, and it
is the only thing here that does.

For a long time it did not exist, and the finding it answers was the loudest one
in the tool: `check_drift` would tell you an arrow was drawn backwards, in red,
with the file and line that proved it, and the only two exits were to change the
code or to hand-edit the `.excalidraw` file. `/update-diagram` did not cover it
and said so — that command is scoped to anchors that went stale, not to claims
that were false. So the most valuable verdict the engine produces was also the
only one nobody could act on (#141).

The reason it was missing is a good one and it survives intact. A board that
rewrote itself whenever the code disagreed would be a **mirror rather than a
spec** — right every time, and therefore never informative. That is the rot this
whole check exists to prevent. But the argument rules out *silent* rewriting, not
rewriting on request, and conflating the two is what left the gap.

Three situations produce one finding, and nothing in the engine can tell them
apart:

| situation | what it means |
| --- | --- |
| the claim was transcribed wrong, nobody meant it | accept: turn the arrow round |
| the architecture deliberately changed | accept — and it is a design decision worth seeing in a diff |
| the code drifted and is wrong | reject: fix the code. **The default, and the common case.** |

Only a person can pick, so accepting is an act a person performs:

```
diagramos drift --accept "boards -> engine"
```

```
┌─ arch.excalidraw  arrow turned round ──────────────────────────────┐
│ Boards → Engine  becomes  Engine → Boards                          │
│ boards -> engine  becomes  engine -> boards                        │
└─ the diagram now says the dependency runs the other way · read the… ┘
```

Four rules, and each is a guard rather than a note:

- **Never silently.** `--hook` refuses it outright, the same way it refuses
  `--repair` and for a sharper reason: the per-turn path runs with nobody
  watching, and this is the one edit that decides something.
- **One arrow, named.** There is no bulk form. "Accept everything" is silent
  rewriting wearing a command's clothes. If the same id is drawn on two boards
  the run refuses before writing anything and asks which board — settled up
  front, because the loop writes each board as it reaches it.
- **Only what this run accuses.** The finding has to be in the report in hand. A
  stale terminal cannot flip an arrow that stopped being wrong ten minutes ago.
- **As a visible diff.** One arrow element changes and nothing else, so the
  commit reads as the decision it is. A relayout would bury that under a
  thousand coordinates.

Nothing is written onto the board to record that a correction happened. The git
diff is the record; a board carrying a history of its own corrections is exactly
the rot above.

**Both halves of the arrow move.** The recorded direction, the two bindings, and
the route the line takes, walked backwards — so the picture agrees with the file.
A flip that swapped only the stored direction would leave the arrowhead pointing
at the old box: the file saying one thing and the canvas showing another, which
is worse than the finding it answered. The route itself is reused rather than
recomputed. The same line still touches the same two boxes at the same two
places, and an arrow that now points *up* a board laid out top-down is the news,
not a defect to correct.

What it will not touch:

- **A hand-drawn arrow.** Its direction was read off bindings or off where the
  line happens to sit, never written down, so turning it round means redrawing
  somebody's sketch. The check still accuses one — being hand-drawn is no
  defence against the code disagreeing — so this refusal does real work.
- **An arrow carrying `via`.** The named hops describe a path that only exists
  one way round. Reversed, the check would be wrong in a new way rather than
  quiet.
- **The rest of the board.** No other element is read or rewritten.

A `planned` arrow reaches it by the other door, described below: it is never
accused, but the code can still have gone the other way on it, and turning it
round is the same act on the same arrow.

**The finding carries the way out.** A backwards row in the notice gets one dim
line under the findings naming the command and an id to paste — once per report,
not once per arrow, and added after the rows are trimmed. Counted as a finding it
ate into the six that get listed and inflated "and N more", so a notice about
twelve arrows claimed twenty-one. An affordance nobody can see from the finding
is not an affordance.

## The board page grades the report, and can be older than it

The live board shows the same report as a chip in the corner, and it is the one
reader of this check that is *compiled separately*. `out/viewer` is a prebuilt
bundle; nothing rebuilds it and nothing used to notice it was old. So after a
pull that adds a finding kind, the CLI and `GET /api/drift` are current and the
page is not — and it looks completely normal being so.

Measured on this machine (#116), two days after `backwards-edge` shipped:

| | built from | knows `backwards-edge`? |
| --- | --- | --- |
| `npm run check:drift` | source, via tsx | yes |
| `GET /api/drift` | source, via tsx | yes — returns `"kind": "backwards-edge"` |
| the board page | `out/viewer/`, two days old | **no** |

The page had no branch for the kind, so it fell into the leftover arrow count:
shown as *1 arrow* in amber, when it was *1 arrow backwards* in red. A hard
refresh does not help — the stale artefact is on disk, not in the browser cache
— which is what made it hard to see from the outside.

Two defences, and they are deliberately not the same one.

- **The page refuses to guess.** A `kind` it has no branch for gets its own row,
  a neutral tone, and the engine's own `detail` quoted verbatim — never folded
  into a category it does not belong to. Counting by subtraction was the bug:
  a remainder cannot tell *not one of the ones I separated out* from *not one of
  the ones I know*, and those are the two states the panel exists to keep apart.
  This holds for every kind added from here on, with no coordination.
- **The report says what words it knows.** Every report carries `vocabulary` —
  the full list of verdict words the engine can emit, whether or not it used
  any. The page compares it against its own and, on a word it lacks, says *this
  page is out of date · restart the board to rebuild it*. A compile-time
  exhaustiveness check makes adding a kind without listing it an error, which is
  the only reason that list can be trusted.

Rebuilding on serve was considered and rejected: the viewer build takes ~38 s,
which is not something to put in front of opening a diagram, and the published
package has no sources to rebuild from. Instead `diagramos board` compares
`src/viewer` mtimes against the bundle and prints one line when it is behind —
cheap, in-repo only, and silent where there are no sources.

## `feeds`: the pipeline arrow, and the first confirm-only word

The gap, measured (#127): on `claim-path.excalidraw` — the first board an agent
drew here unprompted, with nobody looking for this — **every** arrow that could
never be confirmed was one shape. `readBoard → readGraph`, and neither function
calls the other:

```js
const sibling = await readBoard(siblingPath);   // readBoard's result...
const siblingGraph = readGraph(sibling);        // ...goes into readGraph
```

The arrow is completely correct. The wiring is deterministic, quotable, and
lives in a **third** function — `gaps.ts` — which is the one place a body-scoped
search never looks. Four out of four unconfirmable arrows on that board were
this, and the author had done nothing wrong and had nothing they could do.

`feeds` says it: *the tail's result goes into the head*. The check goes and
finds the flow.

### Two shapes count, and deliberately no more

```
B(A(x))                  A's result is handed straight to B
const v = A(x); B(v)     A's result is bound, and the binding is passed
```

The binding form requires the name to be passed as a **direct argument**, in a
scope that can see the binding, after it. `B(v.field)`, `B({ v })`,
`B(list.map(...))`, a reassignment, a value out of a destructure, `[A()]` — none
of them count. Each is a judgement call, and each wrong judgement would be the
tool telling somebody their correct diagram is wrong. `await A()`, `(A())`,
`A()?` and `&A()` do count: those wrappers do not change whose result it is.

Scope is enforced rather than approximated, because ignoring it is a real false
positive: two functions in one file can each hold `const result = ...`, and
reading the binding in the first as the value passed in the second would confirm
an arrow out of two unrelated lines.

### Where it looks

The two endpoint files, and every source file in the repository — the same walk
`closed` boxes get, bounded the same way, and for the same reason: the evidence
is somewhere the board does not point. A file that never writes either name is
skipped before it is parsed. It runs once per board, only when a board carries a
`feeds` arrow, and only on `built` ones.

That is the one place this check reads outside the diagram, so the same rule
applies as everywhere else: the *walk* is fixed and takes no input. The two
symbol names only filter what it found, so no model-authored string turns into a
search of the disk.

### Confirm-only, and why that is not a weakness

There is no `feeds`-is-wrong verdict and there will not be one. A value can
reach the other end through a callback, a struct field, a builder chain — so
*not finding* a flow says close to nothing, and a red built on that absence
would be a false accusation waiting for its first callback. `needs` earns its
red because a file's dependency declarations are enumerable; dataflow is not.

So the report has three answers, and every one of them is honest:

| what happened | what the report says |
| --- | --- |
| the flow was found | the arrow is confirmed, silently, and `--details` counts it as *confirmed by a flow* |
| no flow either way | counted, and the arrow falls through to the ordinary channels — an import can still confirm it |
| the only flow runs the other way | named, with the file and line, as `the only flow found runs the other way` — **not** a finding |

That last row is the most specific thing this engine can say about an arrow
without accusing anybody, and it exists because #133 made "unconfirmed" a count
instead of a colour. Before that, a word that could not go red would still have
painted every arrow it failed to confirm — which is exactly the rot the old
admission rule was written to prevent.

Which is the other half of what this landed: **the vocabulary's admission rule
changed.** It used to be *a word goes in on the day something can call it
wrong*. What that rule actually guards against is a claim whose green is
guaranteed — "some function calls both of these" is symmetric, so it confirms
whichever way the arrow was drawn and says nothing about what was asserted. The
rule is now: a word is admissible when confirming it is evidence of **the
specific thing it asserts**. Refutable words may go red; confirm-only words
never do. `claim.ts` carries the argument in full.

## The code graph: a fifth way to confirm an arrow

The arrow check has always had four ways to confirm a connection: one file
imports the other, a third file imports both, both name the same HTTP route,
or a function body reaches the other end. All four read the two endpoint
files, fresh, on every check — which bounds what they can see.

The fifth is different: a map of the whole repo, built once per commit and
read at check time as plain JSON. The map is built by
[Graphify](https://pypi.org/project/graphifyy/), whose code pass is local and
deterministic — tree-sitter parsing, no model, nothing leaves the machine. The
build records which commit and which Graphify version made the map, which is
what lets a later check decide whether to trust it.

### Getting it, without having to think about it

**The check builds the map itself when the project has none.** That is the
whole answer, and it took a wrong one first. The map used to be built only by
a post-commit hook that `npm install` wires up — which works in the repo that
develops this tool and nowhere else, because `prepare` never runs for a project
that merely installs the tool: it arrives as a marketplace clone plus `npx`.
So the project that most needed a map was the one project that never got one,
and the single line mentioning it told the reader to run two `npm run` scripts
out of *diagramos's* `package.json` (#132). Correct advice, wrong reader.

The guard on building it is cheap, and every part of it is a file test, a
`--version`, or a walk over elements already in memory:

- only when arrows are being checked, and only when a board draws one — an
  arrow is the only thing the map can help with;
- only when the map is missing or a commit behind. An *uncommitted* edit does
  not count as behind: the reader already falls back to the live channels for
  any file touched since the map was built, so an edit costs a little coverage
  and no correctness, while rebuilding per edit would mean rebuilding every
  turn;
- only when Graphify is already installed. The check installs nothing;
- at most one attempt per commit, recorded before the build runs, so a repo
  where extraction fails or runs past the 60-second cap pays for it once
  rather than on every turn.

In practice that is one build per commit, at the first check after it, on the
run that needed it — 0.5 s on a ten-file repo, ~6 s on this one. The
post-commit hook stays where it is wired: a build that already happened is
better than one somebody waits for.

The output directory is made invisible to git on the way out — `graphify-out/`
gets a `.gitignore` holding `*`, which ignores its contents and itself. A
project that never asked for a megabyte of derived JSON does not get it in a
`git status`, and nobody has to edit their own `.gitignore` for us.

Installing Graphify is the one part left, and `npm install` does it in a repo
where `prepare` runs: it installs Graphify if the machine already has a Python
tool installer (`uv`, else `pipx`), using only an installer already present,
never installing an installer, and never failing an `npm install`. Elsewhere
the check says one line, once, when an arrow actually went unread — and it
names `uv tool install graphifyy` only if this machine has `uv` or `pipx` to
run it with. A Rust repo with no Python toolchain is told the truth instead:
some arrows cannot be checked here. `DIAGRAMOS_SKIP_GRAPHIFY=1` turns all of
it off, the install and the build both, and then the check says nothing at all;
`CI` skips the install too, where a per-machine tool install is not wanted.

An arrow is confirmed when the map shows a chain of at most three steps —
calls, imports, re-exports, dynamic imports, each read directly from source —
**all pointing the same way**, from one end to the other (either direction).
That last clause is the safety of the whole thing. Without it, two files that
merely import the same helper would "connect" through it, and one big file
that imports everything would connect all of its imports to each other. A
chain whose edges all point one way means the dependency genuinely flows end
to end.

The chain also has to go somewhere. Two ends that overlap in the map —
two boxes on the same file, or a subsystem box pointing at a file inside
itself — are refused before the search starts, because the walk would begin
already standing on its goal and "confirm" the arrow against a map holding no
edge between them at all. *A reaches A* says nothing about two different
things drawn on a board. Those arrows stay unconfirmed, and stay uncounted.

The map also answers two questions the live channels never could:

- **A box that anchors a directory.** The directory means everything under
  it, and the map can say whether anything in there reaches the other end.
  These arrows used to be skipped as "an end refs a directory".
- **Files the channels cannot read.** The import channels need TypeScript;
  Graphify parses ~40 languages, so an arrow between two Python or Rust files
  can now be confirmed at file level. These used to be skipped as "not
  TypeScript or JavaScript".

### What turns it off — always silently

The channel only ever *confirms*. It never creates a finding, and every way
it can fail is silence — the check then behaves exactly as it did before the
channel existed:

- No `graphify-out/graph.json` or sidecar, and no way to make one: Graphify
  not installed, no git to date the map against, or an extraction that failed.
  The CLI says so once, quietly, then never again.
- A Graphify version outside the tested range (0.9.x today; a new release is
  adopted deliberately, after re-testing).
- A map the loader does not fully understand.
- **Anything edited since the map was built.** The map describes a commit; a
  file changed after it (staged, unstaged, or in later commits) falls back to
  the live channels, so a stale map can never confirm a connection you just
  removed. A directory endpoint goes stale as soon as anything under it does.

### What it cannot see

- Configuration-carried wiring: package.json scripts, hook registrations,
  `.mcp.json`. Graphify reads config files as generic key trees, not as
  "this entry runs that file".
- Route methods (`#GET` versus `#POST` on the same path).
- Anything its extractor missed — it is a parser, not a compiler.

A miss means silence, not an alarm: the arrow stays unconfirmed ("could not
confirm"), never red.

## Open questions

- ~~Should drift auto-regenerate, or only report?~~ **Report only.** Silent
  redrawing while someone is reading the board is hostile, and regeneration
  discards layout intent.
- ~~What is the relevance threshold for "unrepresented"?~~ **Inherited, not
  invented.** A candidate has to be imported by a file the board already points
  at, so relevance was decided by whoever drew the diagram.
- Should `ref` support globs (`src/engine/*`) so one node can stand for a
  subsystem? Probably yes, and it makes (2) far more useful.
- How does this interact with hand-drawn nodes? Current answer: ignore them
  entirely. Revisit if that proves too conservative.

## Rough order of work

1. ~~`src/engine/drift.ts` with the missing-ref check only.~~ Done, plus symbols.
2. ~~`ref` on the `create_diagram` node schema, threaded through `customData`.~~
3. ~~`check_drift` MCP tool and `scripts/check-drift.mjs`.~~
4. ~~Tests.~~ `tests/engine-drift.test.ts`, plus the round trip through a real
   stdio server in `tests/mcp-server.test.ts`.
5. ~~Edge mismatches: arrows grounded in four corroboration channels.~~ Done, behind
   its own `edges` flag so a noisy check can be turned off without losing the quiet
   missing-file check.
6. ~~Unrepresented modules, when the relevance threshold is settled.~~ Done, on
   demand only, scoped to the diagram's own neighbourhood.

The three checks are built in descending order of confidence and cost: missing files
(milliseconds, almost always actionable), edge mismatches (import resolution, measurably
quiet), then unrepresented modules (a suggestion, so it never runs per-turn).
