"""PLAINLY TRUE: the dependency is a `from . import` line at the top.

Shape from .corpus/pallets-flask/src/flask/app.py — `from .sansio.app import App`
style relative import at module top level.
"""

from .model import Request


def handle(request: Request) -> int:
    return len(request.path)
