<h1 align="center">Diagramos</h1>

<p align="center">
  <b>Diagram-driven development.</b><br/>
  Diagrams live in your repo. Claude draws them, reads them back, and writes code from them.
</p>

---

A diagram is usually a screenshot in a wiki that stopped being true six months ago. This makes it a file in the repo instead — `docs/diagrams/architecture.excalidraw`, next to the code it describes, diffable in git, openable in any Excalidraw editor.

Claude gets that file as a first-class artifact. It can draw a diagram, read one back as a graph, edit it, and treat what you sketched as the specification for what it builds. You can open the same file in a live local page and draw on it at the same time.

<p align="center">
  <img src="assets/board.png" alt="A board holding a generated architecture diagram, a hand-drawn wireframe with its labels filled in, and a screenshot placed beside it" width="920" />
</p>

## Install

It is a Claude Code plugin. From inside Claude Code:

```
/plugin marketplace add NoelMatero/diagramos
/plugin install diagramos@diagramos
```

That brings the eleven diagram tools and a `diagram` skill. Diagrams are written into whichever project you are working in, never into the plugin's own directory.

The server itself comes from npm (`npx -y diagramos`), which npm fetches once and caches — the first session after installing takes a few seconds longer to connect. Exporting a PNG additionally needs a headless browser; `render_diagram` prints the one command to install it the first time you ask for one. Nothing else does.

Then just ask: *"Draw how this project works to docs/diagrams/architecture.excalidraw and open the board."*

## Tools

| Tool | What it does |
| --- | --- |
| `create_diagram` | Lay out nodes and edges into a file. Replaces what it generated before. |
| `read_diagram` | Read a board back as a graph, with provenance on every fact. |
| `edit_diagram` | Patch or delete elements by id, hand-drawn ones included. |
| `delete_diagram` | Remove a named diagram, keeping hand-drawn work. |
| `check_drift` | Report nodes pointing at code that no longer exists. |
| `connect_nodes` | Draw bound arrows between existing shapes, including ones you drew. |
| `render_diagram` | Rasterise to PNG, so the model can look at what it made. |
| `place_image` | Put an image on the board, beside the diagram that specified it. |
| `open_board` / `board_status` | Start the live page, or ask whether one is running. |
| `new_board` | Empty a board and start over. |

Every path is confined to the workspace root: symlinks are resolved, and a path that escapes is refused.

## The live board

Ask Claude to open a board, or start one yourself in any project:

```bash
npx -y diagramos board                    # every board in docs/diagrams
npx -y diagramos board docs/diagrams/architecture.excalidraw
```

Working inside this repo, `npm run board` is the same command.

A local page on `127.0.0.1:4747` showing the file. One port serves every project, so if a board from somewhere else already holds it, `diagramos board` says whose it is and moves to a free port rather than failing to start. A board already serving *this* project is shared instead of duplicated. Anything that writes it — a tool, your editor, `git checkout` — appears immediately over SSE, and anything you draw is written straight back. Both sides edit one artifact.

Conflicts resolve in your favour. A save carrying a stale revision is refused with the current board attached, so an agent write cannot discard a stroke you just made.

**Several diagrams at once.** One server serves them all; the page says which board it wants:

```
127.0.0.1:4747/?file=docs/diagrams/ims.excalidraw
127.0.0.1:4747/?file=docs/diagrams/volte.excalidraw
```

Open two and they stay put — writing one diagram, or asking Claude to open a third, never drags a page onto a different file. That is what makes splitting a large system across diagrams workable rather than a constant flick between them. `open_board` returns the pinned URL for whatever it opened, and `board_status` lists every open board with its own address.

The bare `127.0.0.1:4747` follows whichever board was opened or written last, which is what you want when you are working on one diagram and letting Claude drive.

**Reading them offline.** `diagramos board` is an ordinary local server and the viewer it serves ships inside the package, fonts and all, so it needs no network and no Claude Code — on a plane, it is the same command. Or skip us entirely: a `.excalidraw` file opens in the [VS Code Excalidraw extension](https://marketplace.visualstudio.com/items?itemName=pomdtr.excalidraw-editor) and in Obsidian's Excalidraw plugin, both offline. That is the advantage of the diagram being a file.

## Keeping a diagram honest

A node can record what it stands for — a file, `path#symbol`, a directory, a `*.ts` glob, or an endpoint like `path#/api/board` — and `check_drift` compares those claims against the working tree:

```bash
npx -y diagramos drift                 # every board in docs/diagrams
npx -y diagramos drift docs/diagrams/architecture.excalidraw
```

Working inside this repo, `npm run check:drift` is the same command.

Silent when nothing has drifted, exit 1 with a report when a node points at a file or symbol that is gone — which is what CI and pre-commit want. Silent only for that reason: when there was nothing to check it says so, and names any boards it found outside the diagram directory, because a check that goes quiet by looking in the wrong place is worse than one that fails.

**Where diagrams live.** `docs/diagrams`, and `create_diagram` refuses to write anywhere else — a board somewhere else is never discovered, never checked, and never served. To keep them elsewhere, say so once at the repo root and every command follows:

```json
// .diagramos.json
{ "diagrams": "docs/architecture" }
```

Committed on purpose, so you, Claude and CI cannot disagree about it. Reading, serving and checking a board you name by hand still work anywhere in the repo, so nothing that already exists breaks.

When something has drifted, `/update-diagram` redraws it: Claude repoints the boxes whose code moved, removes the ones whose code is gone, and tells you which was which. Nothing is fixed automatically, because a diagram silently rewritten every turn is worse than one you know is stale.

To get the report at the end of every turn, add this to your project's `.claude/settings.json`:

```json
{ "hooks": { "Stop": [{ "matcher": "*", "hooks": [
  { "type": "command", "command": "npx -y diagramos@0.1.0 drift --hook" }
] }] } }
```

A stale diagram then arrives as an ordinary notice, four lines, counts in red and amber:

```
┌─ board-internals.excalidraw  2 gone  1 arrow ─┐
│ Old Cache → src/cache.ts                      │
│ Legacy sync → src/sync/legacy.ts              │
│ Contrast → Staggered reveal                   │
└─ /update-diagram updates the diagram ─────────┘
```

`/expand-report` lists every finding and leaves the notice that way until `/shrink-report`. The plugin does not install the hook for you, because a project with no diagrams should not pay for a subprocess on every turn.

Deliberately shallow. Missing files and symbols are checked by existence alone, which works in any language; the arrow check resolves imports and understands only TypeScript and JavaScript, so elsewhere every arrow is skipped. Nodes without a `ref` are skipped rather than guessed at. A clean report means nothing checkable disagreed — not that the diagram is correct. Reasoning in [docs/drift-check.md](docs/drift-check.md).

## Working on it

```bash
npm install    # builds the headless Excalidraw bundle and the viewer
npm test
```

The `.mcp.json` here registers the server for this project, so edits to `src/` take effect on the next reconnect. Releasing, and the rest of the internals, in [docs/](docs/).

## How it works

**Files are the source of truth.** Every tool is a read-modify-write on a `.excalidraw` file. Nothing lives in a session, so a diagram outlives the conversation that produced it.

**You supply meaning, never coordinates.** `create_diagram` takes nodes and edges; ELK decides the geometry, and node sizes come from real Excalifont metrics via `fontkit`, so a label never overflows the box drawn for it.

**Output is deterministic.** Element ids and seeds are derived by hashing stable ids, so regenerating an unchanged diagram produces a byte-identical file. Diagrams diff usefully instead of churning every line.

**Your drawings are never redrawn.** Generated elements carry a `customData` marker; anything without one is yours. Regeneration replaces only what it made before, and `read_diagram` labels every fact `recorded` (drawn by a tool, exact) or `inferred` (hand-drawn, derived from geometry), so a caller knows what to trust.
