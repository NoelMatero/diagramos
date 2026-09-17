//! Routines that make a Request, one per shape.
//!
//! Struct-literal shape from .corpus/ripgrep/crates/globset/src/glob.rs:53 —
//! `MatchStrategy::BasenameLiteral(lit)` built inline in a constructor.

use crate::factory::make;
use crate::model::Request;

/// PLAINLY TRUE: the construction is written here.
pub fn build() -> Request {
    Request { path: String::new() }
}

/// TRUE BUT HIDDEN: this hands you a Request and never writes one, because a
/// factory in another file does the making.
pub fn build_via_factory() -> Request {
    make()
}

/// FALSE AND UNPROVABLE: this makes no Request, and SKILL.md says not finding a
/// construction proves nothing.
pub fn unrelated() -> usize {
    0
}
