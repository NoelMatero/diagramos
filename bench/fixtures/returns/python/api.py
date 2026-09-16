"""Return types, one per shape.

Annotated-signature shape from .corpus/pallets-flask/src/flask/app.py:1068.
"""

from .model import Req, Request, Response

# The renamed import, which SKILL.md names as a reason to withhold on a signature.
from .model import Thing as Other


def produce() -> Request:
    """PLAINLY TRUE: the return type is Request."""
    return Request("")


def produce_alias() -> Req:
    """TRUE BUT HIDDEN: `Req` *is* Request, written under an alias."""
    return Request("")


def count() -> int:
    """FALSE AND PROVABLE: the return type is written in full and is not Request."""
    return 0


def produce_opaque() -> Other:
    """FALSE AND UNPROVABLE: a renamed import in this file could be hiding it."""
    return Other(0)


# An alias declared in *this* file, which is the shape SKILL.md's alias rule
# reads as written.
LocalReq = Request


def handle(request: Request) -> int:
    """WRONG HALF: Request is in the parameter list, not the return type."""
    return len(request.path)


def respond(code: int) -> Response:
    """Keeps Response used."""
    return Response(code)


def produce_local_alias() -> LocalReq:
    """TRUE BUT HIDDEN, the other way: the alias is declared in this same file."""
    return Request("")
