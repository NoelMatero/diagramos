"""Routines that make a Request, one per shape.

SKILL.md: Python gets no verdict at all from `@builds`, in either direction,
because `Response(body)` and `render(body)` are the same syntax.
"""

from .factory import make
from .model import Request


def build() -> Request:
    """PLAINLY TRUE: the construction is written here."""
    return Request("")


def build_via_factory() -> Request:
    """TRUE BUT HIDDEN: a factory in another file does the making."""
    return make()


def unrelated() -> int:
    """FALSE AND UNPROVABLE: this makes no Request."""
    return 0
