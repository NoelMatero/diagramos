---
description: Give a ref to the boxes that have none, so the drift check can see them
allowed-tools: Bash(npm run check:drift -- --coverage), Bash(npx -y diagramos drift --coverage), mcp__diagramos__check_drift, mcp__diagramos__read_diagram, mcp__diagramos__edit_diagram, mcp__diagramos__create_diagram, Read, Grep, Glob
---

A box with no `ref` is invisible. Every check in this tool works off anchors, so
a box that names nothing is never verified and never will be — it is not a
passing box, it is an unread one. This command finds those boxes and proposes an
anchor for each, for a human to approve before anything is written.

Nothing is written until the user says so. That is the whole shape of this
command, and the reason is below.

## Find them

Run `check_drift` with `coverage: true` (or `npx -y diagramos drift --coverage`)
and read `unannotated`: the boxes that claim to be about this repo and say
nothing about where. Each one gives you a node id and a label.

Boxes on a concept board, and boxes already marked `external`, are not in that
list — they have already said they are not about this repo, which is a complete
answer. If the list is empty, say so in one line and stop.

## Work out what each box means

The label is the only evidence of intent, and it is weak evidence. Use the rest:

- **Read the diagram** (`read_diagram`). A box's arrows say who it talks to, and
  a neighbour that already has a ref narrows the search a lot. If the box you are
  anchoring points at one already anchored to `src/engine/layout.ts`, then a
  candidate that imports `layout.ts` is corroborated rather than guessed — and a
  candidate that does not is worth a second look before you propose it.
- **Search the repo** for the label's words as filenames and as symbols. Glob
  and Grep, not intuition.

Then pick **one of three answers**. The third one is not a failure, and a
command that could not give it would be worse than useless:

| the box is | write |
| --- | --- |
| code in this repo | a `ref` — the narrowest anchor that is actually true |
| real, but not in this repo | `state: "external"` and no ref |
| not something you can establish | nothing — list it as unresolved and say why |

`state: "external"` is the honest answer for a person, another product, a
protocol, or a file that is not code. A box labelled "You" is not `src/user.ts`.

## The rule that matters

**Never invent a ref to make the number go down.** A wrong ref is worse than no
ref: it is a false claim that produces a finding every turn until somebody
tracks it down, and it teaches the user that the check cries wolf. An unanchored
box costs one line in a report that only appears when asked for.

So if the honest answer is "I do not know what this box means", that is the
answer. Say it and move on.

Prefer the narrowest anchor that is *true*, not the narrowest anchor available.
`src/engine/layout.ts` beats `src/engine/` when the box means that module — but
do not anchor to `layout.ts#planLayout` unless the box really means that one
function, because then a healthy rename inside the module becomes a false alarm.

Three costs that are not obvious, all of them measured on this repo:

- **A directory anchor disables the arrows touching that box.** `docs/diagrams/`
  looks like a safe, modest claim, and it silently took two arrows out of the
  check. A file is better; `external` is better than a directory you picked
  because you were unsure.
- **Arrows are checked against `ref`, not `refs`.** Adding a second anchor to a
  box does not give its arrows a second chance. If an arrow matters, the primary
  `ref` is the one that has to be right.
- **A new anchor can make an arrow flag, and the arrow may be the thing that is
  wrong.** On this repo's `example.excalidraw`, anchoring "Board MCP server" and
  "ELK layout engine" correctly made the arrow between them flag — because the
  server does not call the layout engine, it calls `diagram.ts`, which does. The
  diagram was a simplification and the check was right.

  When that happens, **say so**. Do not re-point an anchor at a module that
  makes the arrow pass, because that is the same failure as inventing a ref:
  anchoring "ELK layout engine" at `src/engine/diagram.ts` turns the board green
  and makes it lie. Offer the honest options — draw the missing middle box, or
  leave the finding — and let the user choose.

## While you are in there: the claims you can prove

Anchoring a box means you already had the file open. That is the only moment
where a claim is a transcription rather than a guess, so it is the right moment
to offer one — under the same approval gate, in the same table, never written
on your own say-so.

Two, and only where the evidence was actually in front of you:

- **`claim: "needs"` on an arrow.** You anchored both ends, and while reading
  one of them you saw the import of the other. Then the arrow's direction is
  something you read, and it is worth recording: without a claim the arrow can
  never be shown to be backwards, and with one a reversal is caught by file and
  line. Offer it only for arrows where you saw the line. "It must import it"
  does not qualify, and an arrow with no claim is the normal case.
- **`closed` on a box you anchored to a directory.** Only worth raising when
  the directory looks like a real boundary and you can say what reaches in.
  Check before offering: `check_drift` returns `closedBreaches`, and a `closed`
  proposal that fires red on the first run after the user approved it is your
  mistake landing on their board.

Do not go looking. This command's job is anchors; a claim is a thing you
noticed, and a pass spent hunting for claims to propose is how the transcription
rule quietly becomes a guessing rule. If you saw nothing worth claiming, propose
nothing — that is the common outcome and it is not a shortfall.

Put them in the same table as the anchors, marked as claims, each with the file
and line you read. A claim with no line beside it is a claim you should not be
proposing.

## Propose, then wait

Show every proposal in one table before writing anything: the box, what you
propose, and the evidence you found. All of them at once, not one at a time — a
sixteen-box board reviewed box by box is a worse job for the user than a list
they can read in one pass, and the point of this command is one review.

Then stop and wait. The user may take all of them, reject some, or correct one.
Do not write on the strength of your own confidence.

## Write

Write the approved anchors with `edit_diagram`, one entry per box:

```json
{"path": "docs/diagrams/architecture.excalidraw",
 "updates": [{"id": "api", "ref": "src/server/board-server.ts"},
             {"id": "store", "state": "external"}]}
```

Nothing you did not name changes. The boxes keep their positions, the board
keeps its layout, and every other box keeps whatever it already claimed.

**Do not regenerate the board to do this.** It was the old instruction here and
it is the expensive way to say a short thing: four anchors sent as a
`create_diagram` call meant re-sending thirty-four nodes and forty-four edges,
about 1,900 tokens to communicate four strings — and it threw away the layout of
a board somebody may have been happy with. Regeneration is for structure: boxes
appearing or disappearing. Anchors are not structure.

Finish by re-running the check and reporting in a sentence or two: how many
boxes now carry an anchor, how many were marked external, how many claims went
on, and what you left unresolved.

If a new anchor made the board go loud, name it and say which of the two things
you think happened, because they need opposite fixes: either the anchor is wrong
and should be corrected, or the anchor is right and the *diagram* was a
simplification. Do not decide it silently by picking whichever anchor made the
report green.
