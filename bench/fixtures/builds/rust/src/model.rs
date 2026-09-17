//! What gets made.
//!
//! `Request` carries one inherent routine on purpose: `@builds`'s backwards
//! check reads the `from` end's own body for a construction, and a struct
//! with no routine at all is "no-body" (withheld) before that check can even
//! run, which would hide the direction question rather than answer it. Shape
//! from .corpus/ripgrep/crates/globset/src/glob.rs:283 — a struct with a
//! plain accessor method beside its fields.

pub struct Request {
    pub path: String,
}

impl Request {
    pub fn path_len(&self) -> usize {
        self.path.len()
    }
}
