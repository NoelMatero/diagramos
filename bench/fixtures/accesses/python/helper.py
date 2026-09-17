"""A routine a reader can be called through."""

from .model import Config


def read_width(config: Config) -> int:
    return config.width
