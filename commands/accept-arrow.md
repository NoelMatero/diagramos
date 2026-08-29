---
description: The code is right and the arrow was wrong — turn one arrow round
argument-hint: "[from -> to]"
allowed-tools: Bash(npm run check:drift), Bash(npm run check:drift -- --accept:*), Bash(npx -y diagramos drift), Bash(npx -y diagramos drift --accept:*), mcp__diagramos__check_drift, mcp__diagramos__read_diagram, Read, Grep
---

The check says an arrow on a diagram runs against the code. This command is the
answer *"no — the code is right, and the arrow was wrong."* It turns that one
arrow round in the board file.

Two rows say it, and this command answers both. **`drawn backwards`** is a built
arrow the code contradicts. **`built the other way round`** is a planned one: the
connection you drew has landed, running the opposite way, so the plan was left
planned rather than marked built.

It is the only thing in this tool that changes what a diagram **claims**, so it
happens only when a person asks, one arrow at a time, and it lands as a diff
somebody can read. Nothing here runs on its own.

## Before you turn anything round

**The default answer is the other one.** A backwards arrow usually means the
code drifted and the diagram was right all along — which is the entire reason
the check exists. Three situations produce this one finding and only the user
can tell them apart:

| what happened | what to do |
|---|---|
| The claim was transcribed wrong; nobody ever meant it | turn the arrow round |
| The architecture deliberately changed | turn the arrow round — and say so, it is a design decision |
| The code drifted and is wrong | **fix the code.** Leave the diagram alone |

On a **planned** arrow the same three apply, plus a fourth that is not on the
list: the plan may be a deliberate inversion of a dependency that exists today,
and the refactor simply has not happened. Then nothing is wrong and nothing
should be turned round — the row is the tool reporting where the code is, and it
goes away when the refactor lands. Ask before assuming the plan was a mistake.

So do not accept a finding just because the user pasted it at you. Read the
dependency the finding names — it gives a file and a line — and say which of the
three this is in one sentence. If it is the third, say so and stop: the fix is
in the code, not on the board.

If the user has already told you the code is correct, that settles it. Turn the
arrow round without re-litigating.

## Turn it round

Run the check first if you do not already have the arrow's id:

```
npx -y diagramos drift
```

Either row carries the id under it, in the form `from -> to`. Then:

```
npx -y diagramos drift --accept "from -> to"
```

From inside this repository, `npm run check:drift -- --accept "from -> to"` does
the same. The command re-checks the board afterwards, so a clean report is the
confirmation that it landed. A turned-round **planned** arrow now runs the way
the code does, so the next check marks it built through the ordinary path —
nothing extra to do.

It will refuse, and say why, when:

- **this run does not say that arrow runs against the code.** Something changed
  since the report you are working from. Re-run the check and read it again.
- **the arrow was drawn by hand.** Its direction was never written down, so
  turning it round means redrawing somebody's sketch. Ask the user to drag the
  end across on the live board instead.
- **the arrow names the route it takes.** Reversed, that route describes a path
  that does not exist. The route has to be rewritten with the arrow, by hand.
- **the same arrow is drawn on more than one board.** Name the board:
  `npx -y diagramos drift docs/diagrams/that-one.excalidraw --accept "from -> to"`.

There is no way to accept more than one arrow at a time, and that is deliberate.
Accepting everything at once is the board rewriting itself with extra steps, and
a board that always agrees with the code cannot tell anybody anything.

## Report

Say which arrow you turned round, and **which of the three situations it was** —
that is the part worth reading. If the architecture changed on purpose, say that
outright; it is the sentence that makes the diff make sense to whoever reviews
it later.

Then remind the user, in half a line, that the change is sitting uncommitted and
the diff is the record of the decision. Do not commit it yourself unless asked.
