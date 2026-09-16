//! PLAINLY TRUE: the dependency is a `use` line at the top of the file.
//! Shape from .corpus/ripgrep/crates/searcher/src/searcher/mod.rs:18 —
//! `use std::{cell::RefCell, ...}` / `use crate::...` at item position.

use crate::model::Request;

pub fn handle(request: &Request) -> usize {
    request.path.len()
}
