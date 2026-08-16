// A logging feature, in the shape the checks are meant to catch.
//
// Same cast in every fixture language, so one table of expectations can be run
// against all of them:
//
//   STORE           the thing being written to        LOGGER
//   EMITTER         what callers actually call        log_line
//   DIRECT          calls the emitter itself          serve_request
//   SILENT          never logs, however close it sits parse_header
//   DEEP / MID / TOP a three-layer chain to the emitter
//
// Only the shape matters. None of this is meant to be good Rust.

use std::sync::Mutex;

lazy_static! {
    static ref LOGGER: Mutex<Vec<String>> = Mutex::new(Vec::new());
}

macro_rules! log_line {
    ($($arg:tt)*) => {{
        if let Ok(mut sink) = LOGGER.lock() {
            sink.push(format!($($arg)*));
        }
    }};
}

pub fn serve_request(path: &str) -> usize {
    log_line!("serving {}", path);
    path.len()
}

pub fn parse_header(raw: &str) -> Option<&str> {
    raw.split_once(':').map(|(name, _)| name)
}

pub fn emit_batch(lines: &[String]) {
    for line in lines {
        log_line!("{}", line);
    }
}

pub fn handle_logging(message: &str) {
    emit_batch(&[message.to_string()]);
}

pub fn handle_fail(message: &str) {
    handle_logging(message);
}
