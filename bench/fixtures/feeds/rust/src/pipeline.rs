//! The wiring. SKILL.md: "that function is usually in neither endpoint --
//! the wiring lives in a third file the board often does not draw at all",
//! so this file, not `stages.rs`, is where the flow actually lives.

use crate::stages::{collect, format, parse, render};

/// PLAINLY TRUE: parse's result is bound and passed straight into render.
pub fn run(text: &str) -> String {
    let value = parse(text);
    render(value)
}

/// FALSE AND UNPROVABLE: nothing here connects the two. `@feeds` can never
/// come back red -- a value can reach the other end through a callback, a
/// struct field or a builder chain no reader follows, so not finding the flow
/// is not evidence there is none.
pub fn unrelated() -> usize {
    0
}

/// TRUE BUT HIDDEN: collect's result really does reach format, through a
/// struct field -- SKILL.md's own example of a place "no reader follows".
/// `collect`/`format` have no *other* wiring routine, so this is the only
/// evidence there is to find, and the checker still cannot find it.
pub struct Held {
    pub value: usize,
}

pub fn run_via_field(text: &str) -> String {
    let held = Held { value: collect(text) };
    format(held.value)
}
