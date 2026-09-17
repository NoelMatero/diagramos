//! The thing other modules depend on.
//! Shape from .corpus/ripgrep/crates/searcher/src/searcher/mod.rs:151 —
//! a plain `pub struct` of configuration fields.

pub struct Request {
    pub path: String,
}

impl Request {
    pub fn new(path: String) -> Request {
        Request { path }
    }
}
