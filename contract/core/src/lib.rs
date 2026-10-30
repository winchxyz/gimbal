//! Pure logic of the Gimbal contract. Nothing here touches near-sdk or chain state, so every rule
//! runs and is tested natively; the `gimbal` crate calls into it and turns a [`Refusal`] into a panic.

pub mod decimal;
pub mod errors;
pub mod ids;
pub mod policy;

pub use errors::Refusal;
