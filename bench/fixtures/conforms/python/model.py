"""The base class, and the subclasses that do (or do not) extend it.

Class shape from .corpus/pallets-flask/src/flask/app.py:110 (`class Flask(App):`).
"""


class Base:
    pass


class Local(Base):
    """PLAINLY TRUE: the base list names Base directly."""


class NeverExtends:
    """FALSE AND PROVABLE: the base list is written in full and Base is not in it."""
