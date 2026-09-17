"""A factory in another file, so a caller of it writes no construction of its own."""

from .model import Request


def make() -> Request:
    return Request("")
