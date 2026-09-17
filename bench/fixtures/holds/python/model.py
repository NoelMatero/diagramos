"""The field types, and the alias that hides one.

Class shape from .corpus/encode-httpx/httpx/_models.py:382.
"""


class Request:
    def __init__(self, path: str) -> None:
        self.path = path


class Thing:
    def __init__(self, tag: int) -> None:
        self.tag = tag


# The alias, declared beside the type it stands for.
Req = Request
