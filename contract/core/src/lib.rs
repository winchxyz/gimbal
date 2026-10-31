//! Pure logic of the Gimbal contract. Nothing here touches near-sdk or chain state, so every rule
//! runs and is tested natively; the `gimbal` crate calls into it and turns a [`Refusal`] into a panic.

pub mod decimal;
pub mod ed25519;
pub mod eip3009;
pub mod eip712;
pub mod errors;
pub mod hl;
pub mod ids;
pub mod limits;
pub mod msgpack;
pub mod network;
pub mod oneclick;
pub mod oracle;
pub mod orderly;
pub mod phoenix;
pub mod policy;
pub mod solana;

pub use errors::Refusal;
