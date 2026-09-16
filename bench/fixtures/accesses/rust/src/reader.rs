//! Routines that read (or do not read) `Config::width`, one per shape.
//!
//! Field-read shape from .corpus/ripgrep/crates/searcher/src/searcher/mod.rs:316
//! — `self.config.bom_sniffing`, a routine reading a member off a value it holds.

use crate::helper::read_width;
use crate::model::Config;

/// PLAINLY TRUE: `width` is read directly in this body.
pub fn draw(config: &Config) -> usize {
    config.width
}

/// TRUE BUT HIDDEN: this reads `width` only through a call to a helper that
/// does. SKILL.md: a call nobody could see into does not keep it quiet, but a
/// call the reader *can* see into and that itself reads the member does.
pub fn draw_via_helper(config: &Config) -> usize {
    read_width(config)
}

/// FALSE AND UNPROVABLE (routine end): this reads nothing off Config at all.
pub fn unrelated(config: &Config) -> usize {
    config.height
}

/// A second routine reading `width`, so the type-end absence test (`depth`)
/// can use its own arrow rather than share `draw`'s.
pub fn measure(config: &Config) -> usize {
    config.width
}
