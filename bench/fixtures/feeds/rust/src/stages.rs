//! The pipeline stages, in two independent pairs so the plain and hidden
//! flow tests do not share a candidate pool. Shape from
//! .corpus/ripgrep/crates/globset/src/glob.rs:284 -- one call's result handed
//! straight to the next.

pub fn parse(text: &str) -> usize {
    text.len()
}

pub fn render(n: usize) -> String {
    n.to_string()
}

pub fn collect(text: &str) -> usize {
    text.len()
}

pub fn format(n: usize) -> String {
    n.to_string()
}
