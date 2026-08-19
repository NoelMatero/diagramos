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
