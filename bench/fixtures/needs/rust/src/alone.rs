//! FALSE AND UNPROVABLE: this module declares no dependency on `model`, and
//! `model` declares none on it. `@needs` refutes from the *presence* of the
//! opposite import, so an absence at both ends settles nothing.

pub fn zero() -> usize {
    0
}
