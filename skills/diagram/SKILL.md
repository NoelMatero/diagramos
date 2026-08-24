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
| an HTTP endpoint | `src/server/board-server.ts#/api/board`, or `#GET /api/board` |

An endpoint box is the one anchor that is not a name. It asks whether the route
literal is still served by that file or something it imports, which is the only
mechanically checkable thing about an endpoint — the method token is there for
the reader and is never verified. A file that writes no route literals at all is
counted as unread rather than reported as broken, so pointing this at a helper
module is quiet, not a false alarm.

When one box stands for several things — a feature spread over files, a constant
and the function using it — add `refs: [...]` beside `ref`. Every anchor is
checked, and the box is loud when any of them breaks. Pick `ref` for the main one;
arrows between boxes are checked against it.

### Claiming a symbol is still wired in

A plain `path#symbol` asks only whether the name appears in the file, so a file
holding nothing but a comment mentioning it passes. Add `@` to record what you
actually read there:

| what the file showed you | write |
| --- | --- |
| the symbol is declared here | `src/lib.rs#log_line@declared` |
| something here calls it | `src/server.rs#log_line@used` |
| both — it lives here and is wired in | `src/lib.rs#log_line@declared+used` |

**Transcribe it, never infer it.** Setting a symbol ref means you already had
that file open to find the symbol, so both answers were on screen: you saw the
`fn`, the `def`, the `export function` — that is `@declared`; you saw the name
again somewhere that was not its declaration — that is `@used`. Write the ones
you saw and stop. Do not add `@used` because a box labelled "logging" is
obviously called from somewhere: that is a hypothesis, and a hypothesis that
ages badly is indistinguishable from real drift later.

A symbol declared here but called only by other files gets `@declared` alone,
and that is the common case, not a shortfall. If you did not look, leave the
suffix off entirely — a plain `path#symbol` is a smaller claim, not a worse one.

The cost of guessing instead is measured: applied blindly to all 121 exports in
this repo, "declared and used" flags 35 of them — 29% noise — because an export
used only by its importers looks unused where it is written. Applied where
someone had actually read the file, it was quiet.

Those two words are the whole vocabulary; anything else after `@` is a broken
ref and says so immediately. TypeScript, TSX, JavaScript, Rust and Python are
read properly; in any other language the claim quietly falls back to a plain
mention.

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
lives in `reset_connection`. It works in every language above, not only
TypeScript.

So anchor an arrow's endpoints at the granularity you mean. If the arrow means
"this function calls that one", give both ends `path#symbol`. If it means
something looser — orchestration, ownership, "these belong together" — anchor
at file level and let the import channels answer, because a body-scoped search
will not find a relationship that was never a call.

When a box stands for a concept rather than one function, list in `refs` **the
symbols whose invocation counts as using it** — the interface, not just the
implementation. Any one of them being reached settles the arrow, so fifty
callers need one claim.

Membership is checked in one direction too: every listed symbol that *runs*
must name another one. A box that lists a helper which has stopped doing
anything with the concept is reported, because otherwise the callers keep
calling a listed name and every arrow stays green while the concept is hollow.
Data — a `static`, a `struct`, a `const` — is exempt: that is the ground the
rest of the concept reaches to.

### When the route itself is worth writing down

The body check follows calls as far as they go inside the file, so a chain like

```
handle_fail → handle_logging → emit_batch → log_line!
```

is found on its own. You do **not** need to do anything for depth.

`via` is for when the *path* is part of what the diagram is claiming:

```
via: ["handle_logging", "emit_batch"]
```

That says the connection goes this way, through these names. Each consecutive
pair is checked inside one body, so a break reports **which hop** stopped
holding instead of shrugging at the whole arrow — and it is the only shape that
can say that. It is also a stronger claim than the arrow alone, so a `via`
arrow never falls back to a looser channel: get the route wrong on a connection
that is genuinely there and it says so, in those words.

Use `via` when the route matters — a path you want protected from refactors, or
a hand-off you want documented. Leave it off when only the destination does.

Only for things that exist in the repository. Inventing a path is worse than
leaving it off — but say *why* it is off, because a missing ref otherwise reads
as an oversight:

- **A box for something you are about to build**: keep the ref and set
  `state: "planned"`. `check_drift` then reports it as work to do rather than as
  drift — and once the code catches up, the end-of-turn check flips the box to
  `built` on its own. **Do not flip it by hand or redraw the box just to update
  its state**: the automatic promotion is deterministic, waits until *every*
  anchor on the box resolves, and reports itself as `promoted`. Editing the
  state yourself preempts it for no gain. (Setting `built` naturally as part of
  a redraw you are doing for other reasons is fine.) When the user wants a whole
  piece of work planned as a board before building it, that is `/plan-diagram`.
- **A box that is not code in this repo** — a browser, a vendor API, another
  project: `state: "external"`. Never checked, and distinct from a forgotten ref.
- **A whole board that is not about this codebase** — a protocol, a standard,
  someone else's system: pass `describes: "concept"` to `create_diagram`. That
  excuses every box at once, and it needs a title, since that is where it is
  recorded.

Same field on an edge. A connection you intend but have not wired yet is
`state: "planned"`, which is the honest way to draw the arrow before the import
exists.

### The two claims that can come back wrong

Everything above can be *unconfirmed*. These two can be **refuted** — reported
in red, with a file and a line, as a thing the diagram states and the code
contradicts. That is the point of them, and it is also why they are the only
two places here where guessing has a real cost.

Both are optional. An arrow with no claim and a box with no claim are the
normal case, not a shortfall.

#### `claim: "needs"` — this arrow's direction is a fact

A plain arrow means "these two are related, somehow". Nothing can disprove
*somehow*: the check looks for any connection and failing to find one is never
proof there is none, so a plain arrow's worst verdict is amber forever, and an
arrow drawn the wrong way round survives every run.

`needs` is the way out. It says **the `from` end declares a dependency on the
`to` end** — an import, a require, a `use`, an include. A direction has an
opposite, and an opposite can be shown to be the only one present:

```
edges: [{ from: "server", to: "logging", claim: "needs" }]
```

Get it backwards and the next check says so in red, naming the line that proves
it, and tells you to turn the arrow round. That is the whole feature.

It is written onto the arrow's label as `@needs`, after the reader's own words,
because a claim nobody can see on the board is a claim nobody can refuse. That
also makes it the one claim a person can write without any tool: `@needs` typed
into an arrow's label is read back as the same claim, and so is the tick in the
board page's panel. Expect to find claims on a board you did not put there.

**Transcribe it, never infer it.** Write `needs` only when you have read the
line that declares the dependency — the same rule as `@declared`, for the same
reason. "The server obviously imports the logger" is a hypothesis. A wrong
`needs` is not a harmless decoration: it is a false statement read back to the
user, on their diagram, in red, and the report can tell it was written this
turn — it says *a claim written this turn is already wrong*, which is the tool
reporting your mistake to somebody who did not make it.

If you did not read the line, draw the arrow with no claim. That is a smaller
statement, not a worse one.

The check withholds rather than guesses when it cannot see enough to refute:
a language with no measured reader, a parse that recovered from an error, a
file that reaches out at runtime, an end anchored at a directory, both ends the
same file. The claim is then recorded and unverified, which costs nothing —
so a `needs` you actually read is always worth writing, even where you cannot
be sure it will be checked.

#### `closed: {}` — nothing outside reaches into this box

This is the claim architecture diagrams actually make and could never say: you
draw a box round a subsystem, put the rest of the system outside it, and what
you mean is *the rest of the system does not reach in here*.

Only for a box whose `ref` is a **directory**. `through` lists the front doors
— repo-relative paths of files **inside** the directory that outside code is
allowed to import:

```
{ id: "engine", label: "the engine", ref: "src/engine",
  closed: { through: ["src/engine/index.ts"] } }
```

An empty or omitted `through` claims total isolation. Unusual, and real: this
repository's own `src/viewer` is exactly that shape.

**The two halves are wildly unequal, and you should expect that.** Refuting is
cheap — one import from outside, read out of the source, and the claim is false.
Confirming is a statement about every file in the repository, so it holds only
if every file was read to the end. One file the reader could not finish and the
honest answer is *no breach found*, which the report prints as unproven rather
than as a pass.

**Check before you claim.** Claiming `closed` on a subsystem everything reaches
into produces an immediate red failure that is your mistake, not the user's.
`check_drift` returns `closedBreaches` — every import in, by file and line — so
the way to find out is to claim it on a scratch board and read the list, or to
look at what imports the directory before you write it.

**The test-file trap.** Tests reach into everything, and they have to: testing
a private function means importing it. Test breaches are held apart and do not
refute the claim — but they are counted and shown, never filtered out. Renaming
a file to `foo.test.ts` moves a breach from one list to the other in public; it
does not make it disappear. So a `closed` box in a repo with a suite is normal
and readable, and nobody can quietly widen it by naming a file cleverly.

A door nobody used is reported too. Not a failure — a subsystem being tidier
than it promised — but usually a door that *was* used until the import moved,
and a stale door silently widens the claim.

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

Selecting a box or an arrow on that page opens a panel showing what it means —
its files, its state, its claim, and the findings about it — and every field is
editable there. So the user can anchor a box, mark one `planned`, or claim an
arrow's direction without asking you, and a board can come back changed in ways
no tool call of yours explains. Read the board before assuming your last write is
what is on it. A box the user sketched and anchored themselves is `recorded` like
any other, and is checked like any other.

`board_status` says what is running: every open board with its own URL, and which
one the bare address is currently following. Never give the user a localhost URL
you did not get back from one of those two tools in this session — an address that
answers nothing is worse than none.

## Model choice

The model's job here is to emit a node and edge list; the engine does the
drawing. This does not need a frontier model. If the user is on one and mentions
cost or speed, saying so is more useful than optimising the prompt.
