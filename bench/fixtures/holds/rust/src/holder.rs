//! Field lists, one per shape.
//!
//! Field-list shape from .corpus/ripgrep/crates/searcher/src/searcher/mod.rs:151
//! — `pub struct Config { line_term: LineTerminator, invert_match: bool, ... }`.
//! `Vec<T>` field shape from the same file's `matches: Vec<..>` collections.

use crate::model::{Req, Request, Thing as Other};

/// An alias declared in this same file.
pub type LocalReq = Request;

/// PLAINLY TRUE: a field of type Request.
pub struct Config {
    pub request: Request,
}

/// GENERIC WRAPPER: SKILL.md promises a field holding a collection of the thing
/// still holds the thing.
pub struct Wrapper {
    pub requests: Vec<Request>,
}

/// TRUE BUT HIDDEN: `Req` *is* Request, imported under an alias.
pub struct Aliased {
    pub request: Req,
}

/// TRUE BUT HIDDEN, the other way: the alias is declared in this same file.
pub struct LocalAliased {
    pub request: LocalReq,
}

/// FALSE AND PROVABLE: the field list is written in full and Request is not in it.
pub struct Empty {
    pub n: usize,
}

/// FALSE AND UNPROVABLE: Request is absent, and a renamed import in this file
/// could have been hiding it.
pub struct Opaque {
    pub thing: Other,
}
