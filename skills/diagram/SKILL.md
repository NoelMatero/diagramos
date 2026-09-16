---
name: diagram
description: Draw, read, or update an Excalidraw diagram in this repo — architecture, flows, data models, sequence overviews. Use when the user asks for a diagram or asks about one that already exists, and when a hand-drawn sketch should drive what gets built.
---

# Diagrams that live in the repo

Diagrams are `.excalidraw` files in `docs/diagrams/`. Each box can point at the
code it stands for, and `check_drift` then says when the picture stops matching
the code.

## Rules that break a board

Follow these every time.

1. **Every box points at code, or says why not.** Give it a `ref`, or
   `state: "planned"` (not built yet), or `state: "external"` (not code in this
   repo: a browser, a database, another project).
2. **After `#` goes one plain name, as the code spells it.** Write
   `src/lib.rs#dispatch`. Never line numbers (`src/lib.rs#578-636`,
   `src/lib.rs:254`), which are refused, and never a qualified path
   (`src/lib.rs#Server::dispatch`, `src/lib.rs#Server#dispatch`), which is not text in the file and reads as
   missing.
3. **Leave `describes` off.** `describes: "concept"` is only for a board about
   something outside this repo, such as a protocol or another project, and it
   switches all checking off. A flow through this code is never concept. Never
   use it to make red boxes go away; fix the refs instead.
4. **Point at source, never build output** (`target/`, `dist/`, `out/`,
   `build/`, `node_modules/`).
5. **Write a claim only from code you read.** `@declared`, `@used` and every
   `claim` below are transcriptions. If you did not read the line, leave the
   claim off; an arrow or box with no claim is normal.
6. **Read every draw and edit response, and fix what it names in the same
   turn** with `edit_diagram`: `pointsAtNothing`, `pointsAtLineNumbers`,
   `pointsAtQualifiedNames`, `pointsAtBuildOutput`, `conceptPointsHere`,
   `garbledClaims`, an unviewable size. Correct the ref; never delete a ref to
   make a finding go away.
7. **Do not render to find out whether it worked.** The draw response already
   says whether the board is legible. Render once, at the end, to show a person.
8. **Never redraw what the user drew.** Hand-drawn elements are the spec.
   `create_diagram` keeps them.
9. **Afterwards, say what changed in a sentence or two.** No essay about the
   domain.

## How to draw one

1. **Survey first, for a structural board.** `survey_scope` on a directory
   returns a draft: how many boxes, each anchored at a real path, the arrows
   with `claim: "needs"`, and `separateBoards` for parts that belong on a board
   of their own. Skip it when the user already named the boxes, or the board is
   about something outside this repo.
2. **Rename the boxes. That is your job.** The draft's labels are filenames.
   Say what each box does, merge boxes that are one idea, drop what was not
   asked about. Keep `ref` and `claim` exactly as they came.
3. **Draw it in one `create_diagram` call**, edges included. Leave
   `direction` off on a first draw; the engine picks the flow that reads.
4. **A flow is different.** "The lifeline of a request" is a path through the
   code, not a directory, and no survey drafts it. Read the code, name the boxes
   yourself, and anchor each at the function it stands for
   (`src/lib.rs#handle_request`).

**When it is done:** every box has a `ref` or a `state`, the draw response says
legible and names nothing to fix, and `check_drift` is clean. If
`separateBoards` was not empty, say which boards are still undrawn.

One diagram per file, in `docs/diagrams/<topic>.excalidraw`. Another directory
is refused. If the project keeps diagrams elsewhere, write
`{"diagrams": "docs/architecture"}` to `.diagramos.json` once.

Give nodes and edges, never coordinates. Keep edge labels to a word or two, and
give each subsystem its own `backgroundColor`.

## Pointing a box at code

| you mean | write |
| --- | --- |
| a file | `src/engine/layout.ts` |
| one function or type in it | `src/engine/layout.ts#planLayout` |
| a whole directory | `src/engine/` (must not be empty) |
| something inside a directory | `src/engine/#Workspace` |
| some files in one directory | `src/engine/*.ts` (`*` in the last segment only) |
| an HTTP endpoint | `src/server/board-server.ts#/api/board` or `#GET /api/board` |

A box that stands for several things takes `refs: [...]` beside `ref`; every one
is checked. Arrows are checked against `ref`.

A symbol ref can also say what you saw in that file:

| the file showed you | write |
| --- | --- |
| the symbol is declared here | `src/lib.rs#log_line@declared` |
| something here uses it | `src/server.rs#log_line@used` |
| both | `src/lib.rs#log_line@declared+used` |

A symbol declared here and used only by other files gets `@declared` alone. If
you did not look, write no suffix.

**Anchor arrow ends at what the arrow means.** "This function calls that one":
both ends `path#symbol`, and the check reads that one function body. Looser
meanings (ownership, orchestration): anchor at file level. A box for data (a
struct, a table, a buffer) has no body to read, so an arrow into it is
checkable only at file level; the draw response says which arrows those are.

`via: ["handle_logging", "emit_batch"]` on an arrow names the route it takes,
and a break names the hop. Use it only when the route itself matters.

## States

| `state` | means | drawn |
| --- | --- | --- |
| `built` | exists now; the default, never written | solid |
| `planned` | meant to exist; its ref is work to do, not drift | dashed |
| `external` | real, not code in this repo | dotted |

A `planned` box turns `built` on its own once every ref on it resolves. Do not
flip it by hand. Arrows take `state` too. For planning a whole piece of work as
a board first, use `/plan-diagram`.

## Changing a board that exists

Read it first with `read_diagram` and address boxes by the node ids it gives.

| what changed | call |
| --- | --- |
| a ref, a state, a colour, a claim, a closed claim | `edit_diagram` |
| the whole board's `describes` | `edit_diagram` with top-level `describes` |
| the layout flow | `relayout_diagram` |
| boxes added or removed, a subsystem reworked | `create_diagram` |

```json
{"path": "docs/diagrams/architecture.excalidraw",
 "updates": [{"id": "api", "ref": "src/server/board-server.ts"},
             {"id": "store", "state": "planned"}]}
```

```json
{"path": "docs/diagrams/routing.excalidraw", "describes": "repo"}
```

`edit_diagram` changes only what you name. Re-sending a whole board to
`create_diagram` costs far more and is for structure only.

Two runs of the same request draw different boards, so say so before redrawing
one the user liked. When a box goes stale, work out whether its code moved
(repoint it) or went (remove it).

## Claims

All optional. Most arrows carry none. Each arrow carries at most one, set with
`claim` on the edge. Both ends name a symbol (`path#symbol`) unless the table
says otherwise. Read `claims.md` in this skill before writing one you have not
used before.

| claim | the arrow says | direction | can be red when |
| --- | --- | --- | --- |
| `needs` | from imports to | importer → imported; ends may be files | the import runs only the other way |
| `feeds` | from's result goes into to | producer → consumer | never |
| `takes` | the function has a parameter of this type | type → function | the type is not a parameter |
| `returns` | the function returns this type | type → function | the type is not the return type |
| `holds` | the type has a field of that type | container → field type | no field has that type |
| `builds` | from makes a value of that type | maker → type made | the arrow is backwards |
| `calls` | from calls to | caller → callee | the arrow is backwards |
| `accesses` | from reads a member of to; the member name is the `label` | reader → type | the type has no such member |
| `conforms` | from extends or implements to | subtype → base | the base is not listed (not in Rust) |

```
edges: [
  { from: "server", to: "logging", claim: "needs" },
  { from: "request", to: "handler", claim: "takes" },
  { from: "client", to: "get_client", claim: "returns" },
  { from: "renderer", to: "config", label: "width", claim: "accesses" },
]
```

On a box:

- `handles: ["GET", "POST"]` on a box whose ref names one routine: every case it
  dispatches on. Red when the code has a case the list lacks, or the reverse.
- `closed: { through: ["src/engine/index.ts"] }` on a box whose ref is a
  directory: nothing outside imports into it except through those files. Red on
  the first outside import. Check `check_drift`'s `closedBreaches` before
  claiming it.
- `complete: "src/engine"`, passed to `create_diagram` beside `title`: every
  module there that the board reaches has a box. Off by default; add it only
  when the user wants the board held to that.

A claim on a `planned` box or arrow is a specification: nothing checks it until
the code lands.

## Reading, checking and the live board

- `read_diagram` marks each fact `recorded` (drawn by a tool) or `inferred`
  (read off a hand drawing). Say which when you report. Ask for
  `geometry: true` only to fix layout.
- `check_drift` checks every board. A clean report with `checked: 0` means no
  box had a ref, not that the board is right. `coverage: true` lists code no
  box covers.
- `open_board` starts a live page that follows the file; the user can draw and
  edit there too, so read a board again before assuming your last write is
  what is on it. `board_status` lists open boards. Only give the user a
  localhost URL one of those two returned in this session.
