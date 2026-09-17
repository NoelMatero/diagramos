//! The trait, and the types that do (or do not) implement it.
//! `impl Trait for Type` shape from .corpus/ripgrep/crates/searcher/src/sink.rs
//! -- an impl block declared away from both the trait and the type.

pub trait Handler {
    fn handle(&self);
}

/// PLAINLY TRUE: `impl Handler for Local` lives in this same file.
pub struct Local;

impl Handler for Local {
    fn handle(&self) {}
}

/// TRUE BUT HIDDEN: this really does implement Handler -- the `impl` is in
/// `other.rs`, and SKILL.md says the reader may sit anywhere in the crate. The
/// checker reads only the `from` end's own file, so a genuinely true `impl`
/// declared elsewhere never confirms.
pub struct Remote;

/// FALSE, AND RUST CAN NEVER SAY SO: never implements Handler anywhere in the
/// crate. SKILL.md: "It can never come back red in Rust" -- an absence here is
/// a fact about where the reader looked, not about the type.
pub struct NeverImplements;
