"""The member list, and the case that leaves it open.

Annotated-attribute shape from .corpus/encode-httpx/httpx/_config.py:159.
"""


class Config:
    width: int
    height: int


class Extends(Config):
    """SKILL.md: a type that extends another leaves the member list open —
    nothing is reported either way, because the base's members might hold it."""

    depth: int
