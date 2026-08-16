# The same logging feature as logging.rs, in Ruby.
#
# Ruby has no grammar loaded, and this fixture exists to hold that promise
# honest: every claim written against it must fall back to a plain mention and
# be counted, rather than guessing or going loud. Python used to be this
# fixture; it is a supported language now, so the promise needs a new witness.

LOGGER = []

def log_line(message)
  LOGGER.push("[log] #{message}")
end

def serve_request(path)
  log_line("serving #{path}")
  path.length
end

def parse_header(raw)
  name, _, _ = raw.partition(":")
  name.empty? ? nil : name
end

def emit_batch(lines)
  lines.each do |line|
    log_line(line)
  end
end

def handle_logging(message)
  emit_batch([message])
end

def handle_fail(message)
  handle_logging(message)
end
