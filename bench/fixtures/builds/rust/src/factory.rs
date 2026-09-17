//! A factory in another file, so a caller of it writes no construction of its own.
//! Shape from .corpus/ripgrep/crates/globset/src/glob.rs:284 —
//! `GlobBuilder::new(glob).build()`, where the construction happens elsewhere.

use crate::model::Request;

pub fn make() -> Request {
    Request { path: String::new() }
}
