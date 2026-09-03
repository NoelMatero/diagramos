# Reading a grammar: the list that goes stale, and how it gets you

Written after a reader in this repository made the same mistake four times in
one sitting — **three of them while fixing it.** Read this before adding a
reader, or before extending one that matches on tree-sitter node types.

`parse.ts` states the rule this is all downstream of:

> a declaration is a node with a `name` field
> a function is one that also has a `body` field
> a call is a node with a `function` field
>
> So adding a language is one row and one fixture, not a new lexer.

The failure below is what happens when a reader ignores that and matches node
*names* instead.

## The shape of the bug

**A second list that has to agree with a first one, and silently does not.**

That is the whole of it. It never throws. It never logs. It produces a number
that is wrong in one language and right in the others, which reads as a fact
about that language rather than as a bug in the reader.

The four instances, in the order they happened:

1. **A node-type list missing one language's spelling.** The reader classified
   operators by matching `binary_expression|binary_operator|...`. Python spells
   comparison `comparison_operator`, which was not on it. 1,087 Python
   comparisons counted as a use nobody had looked at, and Python's containment
   reported **11.8% where it should have said 19.7%** — while TypeScript's went
   *up*, so the shape of the error looked like a finding about Python.

2. **A gate list beside a classification table.** The fix classified by operator
   symbol, and put a separate list in front deciding which tokens count as
   operators at all. `is not` was in the classification and not in the gate, so
   **1,071 Python comparisons came back as "not an operator"** — the same bug,
   committed inside the fix for it.

3. **The gate applied on one code path and not the other.** An operator can
   arrive from a grammar field or from a bare token, and only the token path was
   gated. TypeScript keeps `typeof` and `delete` on the field, so both walked
   straight through into a category that did not fit them.

4. **A guard that one grammar's shape did not satisfy.** The field reader
   required a childless node, on the reasoning that an operator is one token.
   Python wraps its two-word comparisons — `is not`, `not in` — in a node that
   *has* two children, so it was skipped, and then skipped again in the fallback
   for the same reason.

## Why the node type could not have worked anyway

Worth knowing before reaching for one. TypeScript calls all four of these
`binary_expression`:

```
a + b     makes a new value       the operands do not get out
a > b     makes a boolean         nor do they
a ?? b    hands back an operand   so it does get out
a && b    hands back an operand   so does this
```

Three different answers under one name. Python, helpfully, splits them into
`binary_operator`, `comparison_operator` and `boolean_operator` — so a reader
that trusts node names is precise in Python and wrong in TypeScript, and a
reader that reads the symbol is right in both.

**The node type was never sufficient. It was a second mechanism in front of the
one doing the work, and its only contribution was going stale.**

## What to do instead

**Read the field.** It is the grammar telling you, and it is the same question
in every language. `childForFieldName("operator")`, `("name")`, `("body")`,
`("function")`.

**Where there is no field, read the structure.** One fact carries a surprising
amount: a tree-sitter operator token is *anonymous*, so **its type is its own
text**. `>` is a node of type `>`; an identifier is a node of type `identifier`.
That is a property of the parser rather than of any one grammar, so it holds
wherever a grammar declines to name a field — Rust's unary, Python's `not`.

**Classify by the thing that is the same everywhere.** `>` is `>` in four
languages. A new grammar cannot introduce a new spelling of comparison. It can
introduce a new *symbol*, which is a different and much smaller problem.

## The rules that follow from those four failures

- **One list, never two.** If a gate and a table have to agree, derive the gate
  from the table. In `dataflow.ts` the set of word operators is computed from
  the three classification sets, so it cannot disagree with them, and a test
  asserts every member classifies.
- **A list that must exist gets a test that it is complete.** Not a test of the
  list's contents — a test that every entry has an answer, so the two halves
  cannot drift.
- **Apply a rule at one place, not at each call site.** Instance 3 existed
  because the same decision was written twice.
- **Never require a shape one grammar might not have.** Instance 4 assumed an
  operator is one token. Prefer the field's text over its children.
- **An unknown must be loud.** A shape the reader does not recognise counts
  against whatever the reader is trying to prove, *and names itself in the
  report* — by the symbol, not by the node type, because the node type is the
  same word for four different things.

## How to know it happened to you

**Run the measurement per language and look for one column disagreeing with the
others.** That is what this looks like from outside: not an error, a language
that seems worse at something. If a number moves in one language and not the
rest, suspect a list before you believe the finding.

The corpus has four languages throughout for exactly this reason — a
single-language corpus turns a stale list into a confident wrong answer, which
has now happened here several times.

## One that resists, and the evidence that it does

Not everything has a signature, and it is worth knowing which before spending an
afternoon looking for one. `dataflow.ts` keeps a second kind of list — the nodes
that *hold* a value without moving it: a parenthesis, an `await`, a cast, a
template string. The obvious candidate signature is **"exactly one child that is
not an anonymous token"**, and it fails in both directions at once:

```
await g()        one operand    a wrapper          ✓
(a)              one operand    a wrapper          ✓
a!               one operand    a wrapper          ✓
return a         one operand    NOT a wrapper      ✗ false positive
a as T           two operands   a wrapper          ✗ false negative
```

`return` is one operand and lets the value out; a cast is two operands — the
value and the type — and does not. Telling those apart means knowing that
`return` is a keyword and `as` is not, which is a list again.

**So that list stays a list.** What makes it survivable is the same thing as
below: it is already self-reporting. A shape it does not recognise counts
against whatever is being proved and prints its node type, which is how 470
unrecognised uses were found and reduced to 70 across four languages. The list
is not the problem. A list nobody can see the edge of is.

## What cannot be derived, and what to do about it

Some knowledge is not in the grammar at all:

- that `push` appends and `get` reads — a fact about a standard library
- that `[]` and `new Map()` make a collection — the same

No structural rule reaches those, and pretending otherwise is worse than a
table. What a table can do is **report its own gaps**: list every method called
on a value the reader believes is a collection that the table does not
classify, and the incompleteness becomes a number in the report rather than a
quietly wrong answer.

That is the difference the whole document is about. A list is not the problem.
A list nobody can see the edge of is.
