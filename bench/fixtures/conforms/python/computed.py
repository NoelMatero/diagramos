"""FALSE AND UNPROVABLE: the base is an expression, not a name -- a class
factory. SKILL.md: "an expression rather than a name (`extends mixin(B)`)" is
one of the two things `@conforms` cannot read at all, so an absence here is a
fact about a name the reader never saw.

Shape from Python's own class-factory idiom: `class X(make_base()):`.
"""


def make_base() -> type:
    class _Base:
        pass
    return _Base


class Computed(make_base()):
    pass
