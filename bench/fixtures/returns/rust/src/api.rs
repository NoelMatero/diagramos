//! Return types, one per shape.
//!
//! Signature shape from .corpus/ripgrep/crates/globset/src/glob.rs:283 —
//! `pub fn new(glob: &str) -> Result<Glob, Error>`.

use crate::model::{Req, Request, Response};
// The renamed import, which is one of the two things SKILL.md names as a reason
// to withhold on a signature. Shape from .corpus/ripgrep/crates/pcre2/src/lib.rs:8.
use crate::model::Thing as Other;

/// An alias declared in *this* file, which is the shape SKILL.md's alias rule
/// reads as written. Shape from .corpus/vuejs-core/packages/runtime-core/src/component.ts:106
/// (`export type Attrs = Data & AllowedAttrs`) — an alias beside the code using it.
pub type LocalReq = Request;

/// PLAINLY TRUE: the return type is Request.
pub fn produce() -> Request {
    Request { path: String::new() }
}

/// TRUE BUT HIDDEN: `Req` *is* Request, written under an alias.
pub fn produce_alias() -> Req {
    Request { path: String::new() }
}

/// FALSE AND PROVABLE: the return type is written in full and Request is not it.
pub fn count() -> usize {
    0
}

/// FALSE AND UNPROVABLE: Request is genuinely absent, but a renamed import in
/// this file could have been hiding it, so the return type proves nothing.
pub fn produce_opaque() -> Other {
    Other { tag: 0 }
}

/// WRONG HALF: Request is in the parameter list, not the return type.
pub fn handle(request: &Request) -> usize {
    request.path.len()
}

/// Keeps Response used.
pub fn respond(code: u16) -> Response {
    Response { code }
}

/// TRUE BUT HIDDEN, the other way: the alias is declared in this same file.
pub fn produce_local_alias() -> LocalReq {
    Request { path: String::new() }
}
