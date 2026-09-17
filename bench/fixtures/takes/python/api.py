"""Parameter lists, one per shape.

Annotated-signature shape from .corpus/pallets-flask/src/flask/app.py:1068 —
`def ensure_sync(self, func: t.Callable[..., t.Any]) -> t.Callable[..., t.Any]`.
"""

from .model import Req, Request, Response

# The renamed import, which SKILL.md names as a reason to withhold on a
# signature. Shape from .corpus/django-django/django/utils/module_loading.py,
# which imports `import_module` under the name it wants locally.
from .model import Thing as Other


# An alias declared in *this* file, which is the shape SKILL.md's alias rule
# reads as written.
LocalReq = Request


def handle(request: Request) -> int:
    """PLAINLY TRUE: the parameter list names Request."""
    return len(request.path)


def handle_alias(request: Req) -> int:
    """TRUE BUT HIDDEN: `Req` *is* Request, written under an alias."""
    return len(request.path)


def count(n: int) -> int:
    """FALSE AND PROVABLE: the whole parameter list is here and Request is not."""
    return n


def handle_opaque(thing: Other) -> int:
    """FALSE AND UNPROVABLE: a renamed import in this file could be hiding it."""
    return thing.tag


def produce() -> Request:
    """WRONG HALF: Request is in the return type, not the parameters."""
    return Request("")


def respond(code: int) -> Response:
    """Keeps Response used."""
    return Response(code)


def handle_local_alias(request: LocalReq) -> int:
    """TRUE BUT HIDDEN, the other way: the alias is declared in this same file."""
    return len(request.path)
