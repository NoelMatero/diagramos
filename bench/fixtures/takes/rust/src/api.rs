//! Parameter lists, one per shape.
//!
//! Signature shape from .corpus/ripgrep/crates/globset/src/glob.rs:283 —
//! `pub fn new(glob: &str) -> Result<Glob, Error>`.

use crate::model::{Req, Request, Response};
// The renamed import, which is one of the two things SKILL.md names as a reason
// to withhold on a signature. Shape from .corpus/ripgrep/crates/pcre2/src/lib.rs:8
// (`pub use pcre2::{...}`) — a name arriving under a spelling of this file's choosing.
use crate::model::Thing as Other;

/// An alias declared in *this* file, which is the shape SKILL.md's alias rule
/// reads as written. Shape from .corpus/vuejs-core/packages/runtime-core/src/component.ts:106
/// (`export type Attrs = Data & AllowedAttrs`) — an alias beside the code using it.
pub type LocalReq = Request;

/// PLAINLY TRUE: the parameter list names Request.
pub fn handle(request: &Request) -> usize {
    request.path.len()
}

/// TRUE BUT HIDDEN: `Req` *is* Request, written under an alias.
pub fn handle_alias(request: &Req) -> usize {
    request.path.len()
}

/// FALSE AND PROVABLE: the whole parameter list is here and Request is not in it.
pub fn count(n: usize) -> usize {
    n
}

/// FALSE AND UNPROVABLE: Request is genuinely absent, but a renamed import in
/// this file could have been hiding it, so the list proves nothing.
pub fn handle_opaque(thing: &Other) -> u8 {
    thing.tag
}

/// WRONG HALF: Request is in the return type, not the parameters.
pub fn produce() -> Request {
    Request { path: String::new() }
}

/// Keeps Response used, so nothing here is dead in a way that reads as a mistake.
pub fn respond(code: u16) -> Response {
    Response { code }
}

/// TRUE BUT HIDDEN, the other way: the alias is declared in this same file.
pub fn handle_local_alias(request: &LocalReq) -> usize {
    request.path.len()
}
