//! The member list, and the case that leaves it open.
//! Field-list shape from .corpus/ripgrep/crates/searcher/src/searcher/mod.rs:151.

pub struct Config {
    pub width: usize,
    pub height: usize,
}

/// SKILL.md: Rust reads a struct's fields *and* its methods before it will
/// call a member list closed, so a struct with no `impl` in the same file
/// never gets a "genuinely absent" verdict -- see `helper.rs`'s `External`
/// for the documented case (impl in another file) and this one for the
/// undocumented extreme of it (no impl anywhere the reader looked).
impl Config {
    pub fn area(&self) -> usize {
        self.width * self.height
    }
}

/// A struct whose `impl` block lives in another file. SKILL.md: "a Rust
/// struct whose `impl` block is in another file" is a member list that might
/// be hiding the name, so the type end must withhold rather than accuse.
pub struct External {
    pub tag: u8,
}
