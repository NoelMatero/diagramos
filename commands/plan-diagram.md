---
description: Draw the plan for something before building it — dashed boxes that turn solid as the code lands
allowed-tools: mcp__diagramos__create_diagram, mcp__diagramos__read_diagram, mcp__diagramos__check_drift, mcp__diagramos__open_board, mcp__diagramos__board_status, mcp__diagramos__connect_nodes, Read, Grep, Glob
---

The user wants to plan work as a diagram: draw what *should* exist, before any
of it is written. The board you produce is not an illustration of a plan — it
**is** the plan. Its dashed boxes are the to-do list, the end-of-turn check
tracks them, and each one turns solid on its own the moment its code lands.
This command draws that board. It does not start building; that is a separate
ask, made against the board once the user has bent it into shape.

## Ground the plan in what exists

A plan floating free of the code cannot be checked, so start by reading enough
of the repo to know two things: **what existing pieces the plan touches**, and
**where new code would live** — the project's real conventions for paths,
naming and module layout, not generic ones.

Draw the existing pieces the plan connects to as ordinary boxes with real refs.
They are the ground the plan stands on, and the arrows from them into the new
work are half of what the plan is saying.

## Draw the future dashed

Every box for code that does not exist yet:

- `state: "planned"` — drawn dashed, reported as work to do rather than drift,
  and flipped to `built` automatically when its code lands.
- `ref` set to **the exact path the code will live at**. This is the contract:
  the promotion fires when that path exists. A plausible-but-wrong path means
  the box stays dashed forever after the work lands — a plan that silently
  stopped being true. Choose the path the repo's conventions actually imply,
  and when you genuinely cannot know, say so and ask rather than inventing one.
- The same for arrows: a connection that is not wired yet is `state: "planned"`
  on the edge, which is the honest way to draw an import that does not exist.

A box that stands for something outside this repo — a browser, a vendor API —
is `state: "external"`, not planned: no code of ours will ever land for it.

## Claims on a plan are specifications, not transcriptions

Everywhere else in this tool a claim is a **transcription**: you write it only
when you have read the line in the code that makes it true. That rule exists
because a claim can come back *wrong* — in red, naming a file and a line — and
a claim you guessed is the tool reporting your mistake to somebody who did not
make it.

A plan is the one place the rule does not apply, because there is nothing to
read. `state: "planned"` says *this is the future*, and a claim on a planned
thing is a **specification**: when this is built, it will work this way. That
inversion is the whole of drawing a plan first, and it is why both claims are
worth writing here even though nothing can confirm them yet.

Writing one costs nothing and accuses nobody. Every verdict that can say
"wrong" is gated on `built`, so a planned box and a planned arrow are never
graded — a plan that contradicts today's code is a plan, not drift, and CI
stays green. The gate releases itself: the moment the code lands, the thing
promotes to `built` and the claim it was carrying is checked for the first
time.

### `claim: "needs"` on a planned arrow — which way the dependency will run

`needs` says **the `from` end will declare a dependency on the `to` end** — an
import, a require, a `use`. On the board it reads as `@needs` on the arrow's
label, after your own words.

```
edges: [{ from: "scheduler", to: "queue", state: "planned", claim: "needs" }]
```

Worth writing because dependency direction is the part of a plan that gets
built backwards, and a plain arrow can never catch that: "these two are
related" has no opposite to be caught by. When the connection lands, the arrow
promotes and the claim goes live — and if the import ended up running the other
way, the next check says so in red, naming the line, instead of the board
quietly agreeing with whatever got built.

Those two runs are one event, not a reversal. Promotion establishes that the
connection now exists; it never said which way it runs, and the report says so
where it announces the promotion. A "backwards" the turn after "built now" is
the first answer to the question the plan asked, not a change of mind.

Write it on the arrows where the direction is a real decision. Leave it off the
ones where "these two talk" is all you meant; a planned arrow with no claim is
still a planned arrow.

### `claim: "feeds"` on a planned arrow — the pipeline you are about to build

`feeds` says **the `from` end's result will go into the `to` end**. It reads as
`@feeds` on the label, and it is a different fact from `needs` — often pointing
the opposite way, because the file holding the result frequently imports the one
producing it.

```
edges: [{ from: "parse", to: "render", state: "planned", claim: "feeds" }]
```

This is the claim for a plan that is a *sequence*: read, then transform, then
write. When the code lands, the arrow promotes and the check goes looking for
the flow — one function binding the first result and passing it to the second —
in any file that can see both ends, including the wiring file the board does not
draw.

It cannot come back red, ever, and that is deliberate: a value can reach the
other end through a callback or a field no reader follows, so failing to find
the flow says nothing about the arrow. Finding it does. Both ends need to name a
symbol (`path#symbol`), because a file has no result.

### `closed: {}` on a planned directory box — the boundary it will hold

`closed` says **nothing outside this box reaches into it**. Only for a box
whose `ref` is a directory, and on a plan that directory does not exist yet, so
what the claim states is the boundary the subsystem is *meant* to hold once
built:

```
{ id: "scheduler", label: "the scheduler", ref: "src/scheduler",
  state: "planned", closed: { through: ["src/scheduler/index.ts"] } }
```

`through` is the list of front doors — the files inside that outside code will
be allowed to import. An empty or omitted `through` claims total isolation.

This is the design decision most likely to be quietly abandoned while the work
is built, because nothing about writing a file inside the directory reminds you
that the directory was supposed to have one way in. Writing it down at plan
time is what makes the first import that goes round the front door a red
finding rather than an afternoon's archaeology a year later. Nothing is checked
while the box is planned; the walk starts the run after it promotes.

Do not claim it on a subsystem you already know everything reaches into — that
is a boundary you would have to build first, and the claim will be red from the
day the box turns solid.

## Check the board you just drew

`create_diagram` checks the board as it writes it. If the result names boxes
that point at nothing, those are your mistakes to fix **now** — a typo in a
ref, or a future box you forgot to mark planned — before the user ever sees a
red notice about a board you just drew. A correct plan board comes back with
`plannedWork` and nothing else.

## Hand the plan over as a thing to bend

The plan's first draft is wrong somewhere; the point of drawing it is that the
user can see where. Offer `open_board` and give the URL back: their edits —
moved boxes, new boxes, an arrow you got wrong — are the spec, arrive as
hand-drawn elements, and are never redrawn. Say what you inferred and what you
were unsure about, in a sentence or two, and stop. Do not follow the board
with an essay about the plan.

## What happens next, so the user knows

After drawing, run `check_drift` on the board and report its work items as the
plan's checklist — that is the same list the end-of-turn notice will keep
showing. Then, as the work is built (by you when asked, or by anyone else):

- each planned box turns solid on its own when its code lands — never flip one
  by hand;
- the live board's status chip counts the plan down;
- CI stays green throughout, because planned work is not drift.

When the user says build, build **from the board**: read it back, take the
work items in dependency order, and let the promotions confirm progress.

## When the plan changes, the board changes in the same turn

Plans change while being built: a piece lands at a different path than the
box promised, a piece turns out unnecessary, a new piece appears. The decision
and the board edit are **one action, not two** — repoint the ref, remove the
box, or add the new dashed box in the same turn the plan actually changed.
"I'll update the diagram after" is how a plan becomes a picture of last week.

The safety net when that is forgotten is deliberate nagging, not silence: a
dashed box whose work landed somewhere else never promotes, so the end-of-turn
notice keeps counting it as work to do forever. A planned count that refuses
to fall while the work is visibly landing means the board and the plan have
parted — treat it as a signal to reconcile them, in whichever direction is
true.
