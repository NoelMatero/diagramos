# How to explain your work in this repo

Engineering ground rules are in [AGENTS.md](AGENTS.md). This file is about **how
to report what you did** — in chat and in pull request descriptions. Read it
before writing any summary.

It exists because the person reading owns this product but did not write it, and
is usually doing something else while you work.

## The one rule

**Explain the problem as a bad outcome, before you explain the machinery.**

This codebase writes in a dense house style — drift, corroboration, anchors,
claims, amber, refs, unconfirmed edges. That vocabulary is correct in the code
and useless in a summary. Repeating it back describes the *mechanism* and never
the *harm*, so a real fix reads as busywork.

If a sentence would only make sense to somebody who has read this repo, it does
not go in a summary or a PR description.

## The shape

1. **One plain sentence: what it does now**, in the reader's words. Always first.
2. **The problem, as something bad that was happening**, with a number if there
   is one.
3. **What is different for them next time.**
4. **Everything else below that**, where it can be skipped: measurements,
   rejected alternatives, testing, known gaps.

A direct question gets its answer in the first sentence — yes or no, then the
qualifier, never a paragraph that circles it.

## A worked example

The same change, described twice. The first was rejected with *"that text means
absolutely nothing and is empty for me… it does not look like a problem, so you
solved nothing it seems like."*

**Bad — the mechanism, in the repo's own words:**

> `create_diagram` already checks the board it just wrote and reports box
> findings, but it threw away the edge half on the grounds that unconfirmed
> arrows were a review matter. #133 removed the amber, so an uncorroborated
> arrow is no longer a finding — it is a fact about how the arrow was anchored.
> It now returns `arrowsNotConfirmed` with the reason words from the shared
> table.

Every word is true. None of it says what went wrong or why anyone should care.

**Good — the harm, in ordinary words:**

> Your diagrams have boxes that point at real code, and the checker verifies the
> arrows between them by searching the code for a connection. But that search
> only looks inside function bodies.
>
> So when Claude draws a box for a piece of data — a struct, a field, a
> collection — and anchors it at the wrong thing, the search has nothing to
> read. The arrow can never be confirmed. Ever.
>
> On that Rust board, 17 of 39 arrows were unverifiable and it still reported
> `0 findings · exit 0`. The diagram looked checked. Two-fifths of it was not.
>
> Now Claude gets told which arrows those are the moment it finishes drawing,
> while it can still fix them.

The difference is not length. The second one names a bad outcome, puts a number
on it, and says what changed.

## What produces the bad version

- Opening with the issue's framing. Issues here are written for somebody already
  deep in the problem; re-deriving the harm is your job, not quoting theirs.
- Quoting tool output as if it explains itself. `17 arrows read and not
  confirmed: 11 an end names data` is a thing the tool prints, not an
  explanation. Say what it means before showing it, or leave it out.
- Naming the mechanism in the first line. "Returns the edge half of the
  draw-time check" answers a question nobody asked.
- Explaining why the old behaviour was once reasonable before establishing that
  anything is wrong. That belongs in the commit message.

The dense style does belong in code comments, commit bodies, and design docs —
read by somebody already inside the problem. That is not an excuse to write a
summary the same way.
