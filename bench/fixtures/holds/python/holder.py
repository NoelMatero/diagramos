"""Field lists, one per shape.

Annotated-attribute shape from .corpus/encode-httpx/httpx/_config.py:159
(`class Limits:` with documented attributes) and from pydantic's own models,
which declare fields as class-level annotations.
"""

from .model import Req, Request
from .model import Thing as Other

# An alias declared in this same file.
LocalReq = Request


class Config:
    """PLAINLY TRUE: a field of type Request."""

    request: Request


class Wrapper:
    """GENERIC WRAPPER: a collection of the thing still holds the thing."""

    requests: list[Request]


class Aliased:
    """TRUE BUT HIDDEN: `Req` *is* Request, imported under an alias."""

    request: Req


class LocalAliased:
    """TRUE BUT HIDDEN, the other way: the alias is declared in this same file."""

    request: LocalReq


class Empty:
    """FALSE AND PROVABLE: the field list is written in full and Request is not in it."""

    n: int


class Opaque:
    """FALSE AND UNPROVABLE: a renamed import in this file could be hiding it."""

    thing: Other
