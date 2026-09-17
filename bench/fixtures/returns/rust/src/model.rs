//! The types the signatures name, and the alias that hides one.
//!
//! Struct shape from .corpus/ripgrep/crates/searcher/src/searcher/mod.rs:151.
//! Alias shape from .corpus/ripgrep/crates/globset/src/lib.rs:979 —
//! `pub type ... = Box<dyn Fn() -> PatternSet + ...>`, a `pub type` standing in
//! for a type written elsewhere.

pub struct Request {
    pub path: String,
}

pub struct Response {
    pub code: u16,
}

/// A type written elsewhere under another name.
pub struct Thing {
    pub tag: u8,
}

/// The alias. A signature naming `Req` names `Request` and does not say so.
pub type Req = Request;
