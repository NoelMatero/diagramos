# The same logging feature as logging.rs, in Python.
#
# Python has no declaration table and no lexer, and this fixture exists to hold
# that promise honest: every claim written against it must fall back to a plain
# mention and be counted, rather than guessing or going loud.

LOGGER = []


def log_line(message):
    """Mentions log_line and LOGGER in a docstring, which is not a use."""
    LOGGER.append(f"[log] {message}")


def serve_request(path):
    log_line(f"serving {path}")
    return len(path)


def parse_header(raw):
    name, _, _ = raw.partition(":")
    return name or None


def emit_batch(lines):
    for line in lines:
        log_line(line)


def handle_logging(message):
    emit_batch([message])


def handle_fail(message):
    handle_logging(message)
