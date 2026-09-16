//! `impl Handler for Remote` lives here, away from both `Handler` and `Remote`.
use crate::types::{Handler, Remote};

impl Handler for Remote {
    fn handle(&self) {}
}
