---
name: diagram
description: Draw, read, or update an Excalidraw diagram in this repo — architecture, flows, data models, sequence overviews. Use when the user asks for a diagram or asks about one that already exists, and when a hand-drawn sketch should drive what gets built.
---

# Diagrams that live in the repo

Diagrams are `.excalidraw` files next to the code they describe. They are the
artifact, not a picture of one: they diff in git, open in any Excalidraw editor,
and are read back as a graph so a sketch can act as a specification.

## Draw it, don't lecture about it

The diagram is the deliverable. After writing one, say what changed in **a
sentence or two** and stop.

Do not follow a diagram with an essay explaining the domain it depicts. If the
user wants the concepts explained they will ask, and a diagram they can look at
is the reason they asked for a diagram. A paragraph per node is the single
largest cost of a diagram task and almost never what was wanted.

Worth mentioning after a write: anything you inferred rather than were told,
anything you left out, and the live URL if you started a board. Nothing else.

## Path

Write to `docs/diagrams/<topic>.excalidraw`. `create_diagram` refuses anywhere
else, because `check_drift` and the board CLI find diagrams by looking in that
one directory — a board outside it is never checked and never served, and the
check reports clean rather than admitting it never saw the file.

If the user wants their diagrams somewhere else, that is a property of the
project rather than of one diagram: write `{"diagrams": "docs/architecture"}`
into `.diagramos.json` at the repo root, once, and everything reads it
afterwards. Do not work around a refusal by picking a different path.

One diagram per file — `create_diagram` replaces what it generated last time,
which is how you update a board.

## Give meaning, never geometry

`create_diagram` takes nodes and edges. Layout, node sizing, connector routing,
arrow binding and label contrast are all decided by the engine using real font
metrics. Passing coordinates is not possible and not wanted; if a layout comes
out wrong, that is a bug worth reporting, not something to hand-place around.

Pass all edges to `create_diagram` in one call. `connect_nodes` draws straight
arrows between existing shapes and does not re-run layout, so using it to build a
graph incrementally produces connectors that cut across boxes. It is for joining
things that already exist — especially shapes the user drew.

Colour carries meaning cheaply: give each subsystem its own `backgroundColor`,
and set `strokeColor` on edges in the same call rather than patching arrows
afterwards, since the next regenerate would revert a patch.

Keep edge labels to one or two words. `direction: "DOWN"` suits a sequence or a
pipeline; the default `RIGHT` suits most architecture.

## Point nodes at the code they stand for

When a node is real code in this repo, set `ref` on it. That is what lets
`check_drift` say later that a diagram has gone stale.

| you mean | write |
| --- | --- |
| a file | `src/engine/layout.ts` |
| one function in it | `src/engine/layout.ts#planLayout` |
| a whole directory | `src/engine/` — the trailing slash says so, and it must not be empty |
| something inside a directory | `src/engine/#Workspace` |
| some files in one directory | `src/engine/*.ts` — `*` in the last segment only, never `**` |

When one box stands for several things — a feature spread over files, a constant
and the function using it — add `refs: [...]` beside `ref`. Every anchor is
checked, and the box is loud when any of them breaks. Pick `ref` for the main one;
arrows between boxes are checked against it.

### Claiming a symbol is still wired in

A plain `path#symbol` asks only whether the name appears in the file, so a file
holding nothing but a comment mentioning it passes. Add `@` when the box means
something stronger:

| you mean | write |
| --- | --- |
| this file defines it | `src/lib.rs#log_line@declared` |
| something here calls it | `src/server.rs#log_line@used` |
| it lives here and is wired in | `src/lib.rs#log_line@declared+used` |

Those two words are the whole vocabulary; anything else after `@` is a broken
ref and says so immediately. TypeScript, JavaScript and Rust are read properly;
in any other language the claim quietly falls back to a plain mention.

**Write `@declared+used` only when the box means "this feature is wired in".**
For a box that means "this thing exists", leave it off. The distinction is not
cosmetic: applied blindly to all 134 exports in this repo, "declared and used"
flags 42 of them, because a module used only by its importers looks unused where
it is written. Applied where it is actually meant, it is quiet.

For a feature spread across files, name the files — the box carries the graph:

```
refs: ["src/logging.rs#log_line@declared",
       "src/server.rs#log_line@used"]
```

### Arrows get sharper when both ends name a symbol

An arrow between two boxes that both anchor on a **file** is checked by imports
and shared route strings. When both ends anchor on a **symbol**, the check
narrows to one function's body: does this function name the other, directly or
through a call it makes in the same file?

That is how `handle_request → log` gets caught when the logging call actually
lives in `reset_connection`. It works in Rust as well as TypeScript.

So anchor an arrow's endpoints at the granularity you mean. If the arrow means
"this function calls that one", give both ends `path#symbol`. If it means
something looser — orchestration, ownership, "these belong together" — anchor
at file level and let the import channels answer, because a body-scoped search
will not find a relationship that was never a call.

When a box stands for a concept rather than one function, list in `refs` **the
symbols whose invocation counts as using it** — the interface, not just the
implementation. Any one of them being reached settles the arrow, so fifty
callers need one claim.

Only for things that exist in the repository. Inventing a path is worse than
leaving it off — but say *why* it is off, because a missing ref otherwise reads
as an oversight:

- **A box for something you are about to build**: keep the ref and set
  `state: "planned"`. `check_drift` then reports it as work to do rather than as
  drift, and tells you once the code catches up so you can flip it to `built`.
- **A box that is not code in this repo** — a browser, a vendor API, another
  project: `state: "external"`. Never checked, and distinct from a forgotten ref.
- **A whole board that is not about this codebase** — a protocol, a standard,
  someone else's system: pass `describes: "concept"` to `create_diagram`. That
  excuses every box at once, and it needs a title, since that is where it is
  recorded.

Same field on an edge. A connection you intend but have not wired yet is
`state: "planned"`, which is the honest way to draw the arrow before the import
exists.

Run `check_drift` after changing module structure, and regenerate the diagram it
complains about — `/update-diagram` does exactly that if the user asks for it by name.
A clean report with `checked: 0` means no node had a ref, not that the diagram is
right. `clean` covers regressions only: `workItems` and `promotions` sit beside it
because neither is a broken diagram.

To ask the opposite question — what does the code have that this diagram does not
show? — call `check_drift` with `coverage: true`. It names modules the board's own
boxes import but no box covers, most-imported first. Suggestions, not drift: worth
running when deciding what a diagram is missing, not on every pass.

When a box has drifted, work out whether its code *moved* or *went*: repoint the
first, remove the second. Deleting a box because a path changed loses a real part
of the picture.

## Check your work once

`render_diagram` returns an image you can actually look at — use it to catch
overlap, crowding, or an unreadable label. Once, after the diagram is finished.
Rendering after every tweak costs an image each time and rarely changes anything.

## Reading, and honouring, what is already there

`read_diagram` marks every fact `recorded` (drawn by a tool, exact) or `inferred`
(hand-drawn, derived from geometry). Keep that distinction when you report:
an inferred label is a guess about someone's sketch.

Never redraw a user's drawing. Their rectangles, their arrows, their handwriting
are the spec. Label them, connect to them, build from them — `create_diagram`
preserves them automatically, and `connect_nodes` and `edit_diagram` both accept
hand-drawn elements by id.

By default `read_diagram` omits positions and sizes. Ask for `geometry: true`
when you need to fix layout, and `includeElements: true` only when you need to
address individual elements in `edit_diagram`.

## The live board

`open_board` starts a local page that follows the file: your writes appear as the
diagram being drawn, and anything the user draws is saved back. Offer it when
someone wants to watch or join in.

Each board gets its own URL, served by one local server. Opening a second diagram
leaves the first page where it is, so a project split across several diagrams can
have them open side by side — call `open_board` once per diagram and give the user
both addresses rather than one that changes under them.

`board_status` says what is running: every open board with its own URL, and which
one the bare address is currently following. Never give the user a localhost URL
you did not get back from one of those two tools in this session — an address that
answers nothing is worse than none.

## Model choice

The model's job here is to emit a node and edge list; the engine does the
drawing. This does not need a frontier model. If the user is on one and mentions
cost or speed, saying so is more useful than optimising the prompt.
