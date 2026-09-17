"""Routines that read (or do not read) `Config.width`, one per shape."""

from .helper import read_width
from .model import Config


def draw(config: Config) -> int:
    """PLAINLY TRUE: `width` is read directly in this body."""
    return config.width


def draw_via_helper(config: Config) -> int:
    """TRUE BUT HIDDEN: reads `width` only through a helper that does."""
    return read_width(config)


def unrelated(config: Config) -> int:
    """FALSE AND UNPROVABLE (routine end): reads nothing off Config at all."""
    return config.height


def measure(config: Config) -> int:
    """A second routine reading `width`, so the type-end absence test (`depth`)
    can use its own arrow rather than share `draw`'s."""
    return config.width
