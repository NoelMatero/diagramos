//! `impl External` lives here, away from the struct's own file.
use crate::model::External;

impl External {
    pub fn tag_value(&self) -> u8 {
        self.tag
    }
}

/// A routine a reader can be called through, so a caller of it reads `width`
/// without doing so itself.
pub fn read_width(config: &crate::model::Config) -> usize {
    config.width
}
