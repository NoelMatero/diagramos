//! Calls, one per shape.
//!
//! Direct-call shape from .corpus/ripgrep/crates/globset/src/glob.rs:284 —
//! `GlobBuilder::new(glob).build()`.
//! Callback shape from .corpus/ripgrep/crates/globset/src/lib.rs:979 —
//! `Box<dyn Fn() -> PatternSet + Send + Sync + UnwindSafe + RefUnwindSafe>`,
//! a routine reached through a value rather than by name.

pub fn render(n: usize) -> usize {
    n
}

/// PLAINLY TRUE: the call is written here.
pub fn run() -> usize {
    render(1)
}

/// TRUE BUT HIDDEN: this really does reach `render`, through a value. Nothing in
/// this body names it.
pub fn run_via_callback(f: fn(usize) -> usize) -> usize {
    f(1)
}

/// The wiring that makes the hidden one true. Kept out of the board on purpose:
/// SKILL.md says the routine doing the wiring is usually in neither endpoint.
pub fn wire() -> usize {
    run_via_callback(render)
}

/// FALSE AND UNPROVABLE: this calls nothing, and not finding a call proves nothing.
pub fn unrelated() -> usize {
    0
}

/// WRONG KIND OF END: data. There is no body here to read.
pub struct Config {
    pub width: usize,
}
