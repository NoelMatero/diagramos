"""The thing other modules depend on.

Shape from .corpus/encode-httpx/httpx/_models.py:382 — a plain `class Request`.
"""


class Request:
    def __init__(self, path: str) -> None:
        self.path = path
