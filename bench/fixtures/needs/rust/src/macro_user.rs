//! TRUE BUT HIDDEN: the only `use crate::model` in this file sits inside a
//! `macro_rules!` body, which the grammar parses as one token tree. The
//! dependency is real; no reader of the text can see it.
//!
//! Shape from .corpus/ripgrep/crates/core/messages.rs:35 — `use std::io::Write;`
//! written inside a `macro_rules! eprintln_locked` body.

#[macro_export]
macro_rules! path_len {
    ($p:expr) => {{
        use crate::model::Request;
        Request::new($p).path.len()
    }};
}
