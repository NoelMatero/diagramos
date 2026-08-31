---
description: Bring diagrams that have gone out of date back in line with the code
allowed-tools: Bash(npm run check:drift), Bash(npx -y diagramos drift), mcp__diagramos__check_drift, mcp__diagramos__read_diagram, mcp__diagramos__create_diagram, mcp__diagramos__edit_diagram, mcp__diagramos__delete_diagram, Read, Grep, Glob
---

A diagram in this repo points at code that has moved or gone. Bring the diagram
back in line with what is actually there.

## Find what drifted

Run `check_drift` (no arguments checks every board under `docs/diagrams`). If the
MCP board tools are unavailable, run `npm run check:drift` instead.

If the report is clean, say so in one line and stop. Do not go looking for
problems it did not find, and do not redraw a diagram that is fine.

This command is for anchors that have gone *wrong*. A box carrying no anchor at
all is a different job — it is unread rather than stale, and giving it one means
proposing a claim rather than correcting one, which needs the user's approval.
`/annotate-diagram` does that.

An arrow reported as **drawn backwards** is a third job, and not this one. That
finding is not an anchor going stale — it is a claim about direction being
contradicted, and the usual answer is that the code drifted and the diagram was
right. If the user decides the opposite, `/accept-arrow` turns that one arrow
round. Do not redraw a backwards arrow here to make the report go quiet.

## Decide what each finding means

A finding says a box points at a file or symbol that no longer exists. That has
two possible causes and they need opposite treatment, so establish which before
changing anything:

- **The code moved or was renamed.** Point the box at the new location. **Read
  the answer before searching for it:** the report carries a `followed` entry for
  every stale box whose code the repository can place, and a `becomes` on that
  entry is the ref to write. It comes from git having recorded the move or from
  the name being declared in exactly one file, so it is not a guess and it does
  not need confirming. Search only for the boxes the report did not answer for.
- **The code is genuinely gone.** Remove the box. Also remove arrows that only
  existed to reach it, or the diagram keeps a dangling claim.

From a terminal, `npm run check:drift -- --repair` writes every `becomes` back
itself and prints what it changed; the boxes left over are the ones below.

A `followed` entry with `candidates` instead of `becomes` is the engine declining:
the name lives in more than one place now, or the file moved without it. Its
`detail` says which. Those are the ones worth your search, and the ones where a
wrong answer is easy — a box saying `src/engine/layout.ts` when the file is now
`src/engine/layout/index.ts` is a ref to update, not a subsystem to delete, and
matching on a filename is exactly how that goes wrong in the other direction.

When you do search, ignore anything under `target/`, `dist/`, `out/`, `build/` or
`node_modules/`. Build output quotes source: a Rust fingerprint log copies whole
function signatures into JSON, so a grep for a symbol returns one and it reads as
a hit. A ref there resolves forever and goes quiet about every change to the code
it was meant to describe, so the check now refuses one outright.

Boxes marked `inferred` were hand-drawn, and their ref was *guessed from the
label*. Treat those as the user's intention, not as a wrong claim: mention them
and ask, rather than deleting someone's sketch because a guessed path missed.

## Write the fix

Read the diagram first. Then pick by **what actually changed**, because the two
paths cost wildly different amounts and one of them throws away the layout.

**Refs moved, nothing else** — the common case, and most of what a drift report
ever asks for. Patch them with `edit_diagram`:

```json
{"path": "docs/diagrams/architecture.excalidraw",
 "updates": [{"id": "layout", "ref": "src/engine/layout/index.ts"},
             {"id": "store", "state": "planned"}]}
```

Everything you do not name stays as it was, the board keeps its layout, and a
box's other anchors and claims survive the edit. Do not regenerate a
thirty-four box board to correct three strings.

**Boxes appearing or disappearing** — then the shape of the picture changed and
`create_diagram` is right. Carry over every node and edge that is still correct.
Be honest about the cost when you report it: hand-drawn elements survive, but
the generated part is laid out fresh, so a board somebody arranged by hand comes
back arranged by the engine.

Either way, say which boxes you repointed, which you removed, and anything you
were unsure about. A diagram silently rewritten is worse than one left stale.

Finish by re-running the check to confirm it is clean, and report in a sentence
or two. No essay about the architecture.
