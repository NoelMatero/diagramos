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
| `check_drift` | Compare every board against the tree: what has gone stale, what is still to build, what the code has caught up with. |
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
npx -y diagramos stop --list              # every board service running here
npx -y diagramos stop                     # stop them
```

Working inside this repo, `npm run board` is the same command.

A local page on `127.0.0.1:4747` showing the file. Anything that writes it — a tool, your editor, `git checkout` — appears immediately over SSE, and anything you draw is written straight back. Both sides edit one artifact.

The command does not hold your terminal. It makes sure a background board service is running and gives you back the prompt, so closing that window — or ending the Claude session that opened the board — leaves the boards up.

**One service, however many projects.** Open a board in a second repository and it joins the service already running rather than starting another on another port. You can also name a board that lives somewhere else — `diagramos board ../other-repo/docs/diagrams/architecture.excalidraw` — and that project joins the same service. So `diagramos stop --list` is one line rather than a list, and `127.0.0.1:4747/boards` shows everything you have open, grouped by project, with a button that stops the lot. The board name in the corner of any board links there.

A service still only serves directories you actually opened, and only `.excalidraw` files inside them — that confinement is what stops a page in your browser reading a file it was never shown, and it did not go away to make this work. Paths are compared with every symlink resolved, so a link inside a project pointing out of it is not a way past. Adding a project to a running service takes a token from the service's own registry entry, which is readable by nobody but you, so a web page cannot ask for it however hard it tries.

Conflicts resolve in your favour. A save carrying a stale revision is refused with the current board attached, so an agent write cannot discard a stroke you just made.

**Stopping one.** A board you or Claude opens outlives the thing that opened it — a diagram you are reading should not vanish because a terminal closed or a session ended. `diagramos stop --list` says what is running, where it came from and how long it has been up, and `diagramos stop` stops it. That works from any terminal, including one with nothing to do with the session that started the service, which is the point: a service takes a free port when 4747 is busy, and finding one used to mean `lsof`.

It also stops itself. After twelve hours with no page open and no request, a service shuts down; an open page holds a live stream, so a board you are actually using is never idle. Set `DIAGRAMOS_IDLE_HOURS` to change that, or to `0` to keep a service until you stop it yourself. Nothing is lost when it fires — a board is a file in your repository, and the next `diagramos board` has a service back in under a second.

That combination is what ended the original bug: nine board servers were once found running on one machine, on eight different ports, the oldest five days old and four still serving test directories that had been deleted. They accumulated because each one belonged to whatever process happened to start it, and none of them could be seen. Now a project has one service, it is in a registry that `stop` reads, and it does not sit there forever.

Stopping a server closes the live page and nothing else. The board is a file in your repository; it is still there, still in git, still openable in any Excalidraw editor.

**Several diagrams at once.** One server serves them all; the page says which board it wants:

```
127.0.0.1:4747/?file=docs/diagrams/ims.excalidraw
127.0.0.1:4747/?file=docs/diagrams/volte.excalidraw
```

Open two and they stay put — writing one diagram, or asking Claude to open a third, never drags a page onto a different file. That is what makes splitting a large system across diagrams workable rather than a constant flick between them. `open_board` returns the pinned URL for whatever it opened, and `board_status` lists every open board with its own address.

The bare `127.0.0.1:4747` follows whichever board was opened or written last, which is what you want when you are working on one diagram and letting Claude drive.

**The board shows its own status.** A chip in the corner carries the same tally the end-of-turn notice does — boxes whose code is gone in red, questionable arrows in amber, planned work in grey. Click it and every finding is a row; click a row and the canvas jumps to the box or arrow it is about. When there is nothing to say it reads as what was checked, not just "in sync", because a board nobody could read and a board that agrees are different kinds of quiet. It refreshes when the board changes and when you come back to the tab.

**The board tells its recent past.** A `history` chip next to the status one lists what changed the board while the service has been up — each save with when, what it did to the element count, and who did it: drawn on the page, or written to the file by a tool, an editor, or git. Held in memory on purpose and the panel says so: the board itself is the artifact, git is the durable history, and this is the working session's timeline rather than a second file claiming to be the past.

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

A box carrying no `ref` at all is a different problem: it is not stale, it is unread, and every check here is blind to it. `/annotate-diagram` finds those boxes, proposes an anchor for each — or `external`, when the box is a person or another product — and writes nothing until you approve the list. A wrong ref is worse than none, so it is allowed to answer "I cannot tell what this box means".

The report arrives at the end of every turn on its own — the plugin installs the hook, and there is nothing to switch on. In a project with no diagrams it costs a directory test and never starts node, so installing this does not make your other repositories slower.

If you are using the MCP server directly rather than the plugin, this is the same thing by hand, in your project's `.claude/settings.json`:

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

`/expand-report` lists every finding and leaves the notice that way until `/shrink-report`.

Run it yourself with `npx -y diagramos drift`, which answers in one line when nothing has drifted and says how much went unread. In CI it exits non-zero for a diagram that has stopped matching the code, and zero for one describing work that has not landed yet — a repository is not broken because somebody sketched next week:

```yaml
- run: npx -y diagramos drift
```

**A diagram can describe the future.** Mark a box or arrow `planned` and it is drawn dashed: a sketch of what is meant to exist, not a claim that it does. The check then reports its missing code as work to do rather than drift — and the moment the code lands, the per-turn hook advances the board itself: the box turns solid on the live page, the notice says `promoted` once, and the next turn is quiet. A box that stands for several files stays dashed until all of them exist. The edit is an ordinary change to a file in git, so undoing it is one checkout; the bare `drift` command never applies it, because a check that mutates the working tree is a check CI cannot trust.

**An arrow can say what it means.** An arrow means "these two are related, somehow", and nothing can disprove "somehow" — so an arrow drawn backwards passes every check forever. An arrow can carry one word instead: `needs`, the box at the tail declares a dependency on the box at the head. It is written on the arrow as `@needs`, so you can see it and delete it. Nothing judges it yet — a board with claims checks identically to the same board without them — but a word outside the vocabulary is an error the turn it is written, because a claim no check can read looks exactly like one that passed. The verdict it exists for is next: [the design](docs/handoff/sharper-claims-design.md).

That makes planning a front door rather than an afterthought: `/plan-diagram` draws the plan for something before any of it is written — the pieces that exist as solid boxes, the work to come dashed, every dashed box anchored to the exact path its code will live at. The board is the to-do list, you bend it into shape by drawing on it, and it ticks itself off as the work lands. `create_diagram` checks every board as it writes it and tells the model, not you, about a box pointing at nothing — a typo gets fixed before it ever reaches your notice as red.

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

**Your drawings are never redrawn.** Generated elements carry a `customData` marker; anything without one is yours. Regeneration replaces only what it made before, and `read_diagram` labels every fact `recorded` (drawn by a tool, exact) or `inferred` (hand-drawn, derived from geometry), so a caller knows what to trust. `recorded` is the default and is left out of the response rather than repeated on every box — along with `rectangle`, `built` and `declared`, which together were 58% of what a read cost. Every response opens with `omittedWhenDefault` saying what each absence means, so a lean board still teaches a reader which fields exist.
