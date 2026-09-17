//! The field types, and the alias that hides one.
//! Shapes from .corpus/ripgrep/crates/searcher/src/searcher/mod.rs:151.

pub struct Request {
    pub path: String,
}

pub struct Thing {
    pub tag: u8,
}

/// The alias, declared beside the type it stands for.
pub type Req = Request;
