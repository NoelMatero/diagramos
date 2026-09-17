"""Calls, one per shape.

Direct-call shape from .corpus/django-django/django/utils/module_loading.py:15.
Callback shape from .corpus/pallets-flask/src/flask/app.py:1068 —
`def ensure_sync(self, func: t.Callable[..., t.Any])`, a routine reached through
a value rather than by name.
"""


def render(n: int) -> int:
    return n


def run() -> int:
    """PLAINLY TRUE: the call is written here."""
    return render(1)


def run_via_callback(f) -> int:
    """TRUE BUT HIDDEN: this really does reach `render`, through a value."""
    return f(1)


def wire() -> int:
    """The wiring that makes the hidden one true. Kept off the board on purpose."""
    return run_via_callback(render)


def unrelated() -> int:
    """FALSE AND UNPROVABLE: this calls nothing."""
    return 0


class Config:
    """WRONG KIND OF END: data. There is no body here to read."""

    width: int
