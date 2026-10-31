//! The MPC contract: `derived_public_key`, which `create_desk` asks for a desk's two keys before it
//! stores the desk (docs/interfaces.md §1.2), and `sign`, which every action method calls with
//! 1 yoctoNEAR from the contract's balance before `on_signed` checks the answer (§1.4).

use gimbal_core::errors::{shown, Refusal, E_ARGS, E_MPC};
use gimbal_core::ids::{
    decode_base58_32, decode_mpc_ed25519, decode_mpc_secp256k1, evm_address_from_keccak, evm_path,
    sol_path, MPC_DOMAIN_ED25519, MPC_DOMAIN_SECP256K1,
};
use near_sdk::{env, near, serde_json, AccountId, Gas, GasWeight, NearToken, Promise};

/// The `request` of the MPC contract's `sign({request})`: `{path, payload_v2: {Ecdsa: hex} or
/// {Eddsa: hex}, domain_id}`, derived for this contract as predecessor.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SignRequest {
    pub path: String,
    pub payload_v2: SignPayload,
    pub domain_id: u32,
}

/// What the key signs, as lowercase hex without `0x`.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SignPayload {
    /// A 32-byte digest, for the secp256k1 key (domain 0).
    Ecdsa(String),
    /// The whole message, for the Ed25519 key (domain 1), which signs it as it is: a Solana
    /// message, or an Orderly request's text (13 bytes for a WebSocket login, a few hundred for a
    /// request; the MPC contract signs messages of up to 1232 bytes).
    Eddsa(String),
}

impl SignRequest {
    /// `digest` signed by the desk's EVM key, `gimbal/<desk_id>/evm` in domain 0: its Hyperliquid
    /// master address.
    pub fn evm(desk_id: &str, digest: &[u8; 32]) -> Self {
        Self {
            path: evm_path(desk_id),
            payload_v2: SignPayload::Ecdsa(hex::encode(digest)),
            domain_id: MPC_DOMAIN_SECP256K1,
        }
    }

    /// `message` signed by the desk's Solana key, `gimbal/<desk_id>/sol` in domain 1: its Solana
    /// authority (and Orderly key).
    pub fn sol(desk_id: &str, message: &[u8]) -> Self {
        Self {
            path: sol_path(desk_id),
            payload_v2: SignPayload::Eddsa(hex::encode(message)),
            domain_id: MPC_DOMAIN_ED25519,
        }
    }
}

/// The least gas the MPC contract's `sign` gets; it also gets all the gas the action call leaves
/// unused (weight 1), which pays for the signature's yield and resume.
pub const SIGN_GAS: Gas = Gas::from_tgas(50);

/// Gas for `on_signed`: it parses an answer of at most [`SIGNATURE_MAX_LEN`] bytes and the action
/// (a Solana message of up to 1232 bytes, twice over), recovers or verifies one signature, logs
/// one event and returns the action.
pub const ON_SIGNED_GAS: Gas = Gas::from_tgas(15);

/// What an action method burns itself before the `sign` call, a bound: building and checking a
/// Solana message of 1232 bytes (three program address derivations) is the largest.
pub const ACTION_GAS: Gas = Gas::from_tgas(20);

/// The least prepaid gas an action method accepts (`E_ARGS` below it): its own cost, `sign` and
/// `on_signed`, 85 TGas. Clients attach 300 TGas, so the signature's yield never runs short.
pub const SIGN_MIN_GAS: Gas =
    Gas::from_gas(ACTION_GAS.as_gas() + SIGN_GAS.as_gas() + ON_SIGNED_GAS.as_gas());

/// What `sign` takes from the contract's balance per signature.
pub const SIGN_DEPOSIT: NearToken = NearToken::from_yoctonear(1);

/// Longest `sign` answer read: an Ed25519 answer (64 numbers up to 255) is about 300 bytes of
/// JSON, a secp256k1 one about 250.
pub const SIGNATURE_MAX_LEN: usize = 1024;

/// `sign({request})` on the MPC contract with [`SIGN_DEPOSIT`].
pub fn sign(mpc: &AccountId, request: &SignRequest) -> Promise {
    let args = serde_json::json!({ "request": request });
    Promise::new(mpc.clone()).function_call_weight(
        "sign",
        args.to_string().into_bytes(),
        SIGN_DEPOSIT,
        SIGN_GAS,
        GasWeight(1),
    )
}

/// `E_ARGS` when an action call came with less than [`SIGN_MIN_GAS`].
pub fn check_sign_gas(prepaid: Gas) -> Result<(), Refusal> {
    if prepaid >= SIGN_MIN_GAS {
        return Ok(());
    }
    Err(Refusal::new(
        E_ARGS,
        format!(
            "an action call needs at least {} TGas attached for the MPC signature (300 TGas \
             recommended), not {}",
            SIGN_MIN_GAS.as_tgas(),
            prepaid.as_tgas()
        ),
    ))
}

/// The MPC contract's answer to `sign`, as it writes it and as the SignedAction carries it.
#[near(serializers = [json])]
#[serde(tag = "scheme")]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MpcSignature {
    /// Domain 0: `big_r` the compressed point R (`02`/`03` ‖ r, hex), `s` the scalar (hex) and the
    /// recovery id 0 or 1 (v = 27 + it for Ethereum).
    Secp256k1 {
        big_r: AffinePoint,
        s: Scalar,
        recovery_id: u8,
    },
    /// Domain 1: the 64 bytes R ‖ S.
    Ed25519 { signature: Vec<u8> },
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AffinePoint {
    pub affine_point: String,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Scalar {
    pub scalar: String,
}

/// The signature the `sign` call returned as promise result 0, or `E_MPC` when it failed (the MPC
/// network did not answer in time, or refused) or returned something else.
pub fn signature() -> Result<MpcSignature, Refusal> {
    let bytes = env::promise_result_checked(0, SIGNATURE_MAX_LEN).map_err(|e| {
        Refusal::new(
            E_MPC,
            format!("the MPC contract did not return a signature: {e}"),
        )
    })?;
    serde_json::from_slice(&bytes).map_err(|_| {
        Refusal::new(
            E_MPC,
            format!(
                "the MPC contract returned no signature, but {} bytes of something else",
                bytes.len()
            ),
        )
    })
}

/// secp256k1's group order n, and n / 2 rounded down (the largest low s), big-endian hex.
const SECP256K1_N: &str = "fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141";
const SECP256K1_HALF_N: &str = "7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0";

fn bytes32(hex_digits: &str) -> [u8; 32] {
    let mut out = [0u8; 32];
    hex::decode_to_slice(hex_digits, &mut out).expect("a 32-byte hex constant");
    out
}

/// `signature` with a low s: a secp256k1 signature whose s is over n / 2 becomes (r, n − s) with
/// the recovery id flipped, which recovers to the same key; anything else is returned as it is
/// (a malformed s or recovery id is left for [`check_signature`] to refuse). Circle's FiatToken
/// (EIP-3009) and every EIP-2 check refuse a high s, so every consumer gets the canonical form.
/// The MPC network already answers with a low s (each testnet signature seen had one, with the
/// recovery id flipped to match), so this is a guard. `big_r` stays as the MPC wrote it:
/// consumers take only its x coordinate, r.
pub fn low_s(signature: MpcSignature) -> MpcSignature {
    let MpcSignature::Secp256k1 {
        big_r,
        s,
        recovery_id,
    } = signature
    else {
        return signature;
    };
    let mut value = [0u8; 32];
    let parsed = !s.scalar.is_empty()
        && s.scalar.len() <= 64
        && hex::decode_to_slice(format!("{:0>64}", s.scalar), &mut value).is_ok();
    let n = bytes32(SECP256K1_N);
    if !parsed || recovery_id > 1 || value <= bytes32(SECP256K1_HALF_N) || value >= n {
        return MpcSignature::Secp256k1 {
            big_r,
            s,
            recovery_id,
        };
    }
    // n − s, byte by byte from the low end.
    let mut low = [0u8; 32];
    let mut borrow = 0u16;
    for i in (0..32).rev() {
        let take = u16::from(value[i]) + borrow;
        let have = u16::from(n[i]);
        (low[i], borrow) = if have >= take {
            ((have - take) as u8, 0)
        } else {
            ((have + 256 - take) as u8, 1)
        };
    }
    MpcSignature::Secp256k1 {
        big_r,
        s: Scalar {
            scalar: hex::encode(low),
        },
        recovery_id: recovery_id ^ 1,
    }
}

/// The lowercase `0x` address whose key made the 64-byte `rs` with recovery id `v` (0 or 1) over
/// `digest`, if any. High-s signatures are accepted, as Ethereum's `ecrecover` accepts them.
pub fn recover_evm(digest: &[u8; 32], rs: &[u8; 64], v: u8) -> Option<String> {
    let key = env::ecrecover(digest, rs, v, false)?;
    Some(evm_address_from_keccak(&env::keccak256_array(key)))
}

/// The answer is a signature by `signer` of what `request` asked to sign (`E_MPC`): for domain 0
/// a secp256k1 signature of the digest that recovers to `signer`, the desk's EVM address; for
/// domain 1 an Ed25519 signature of the message that verifies under `signer`, the desk's base58
/// Solana authority.
pub fn check_signature(
    signature: &MpcSignature,
    request: &SignRequest,
    signer: &str,
) -> Result<(), Refusal> {
    let bad = |what: &str| Refusal::new(E_MPC, format!("the MPC signature {what}"));
    match (signature, &request.payload_v2) {
        (
            MpcSignature::Secp256k1 {
                big_r,
                s,
                recovery_id,
            },
            SignPayload::Ecdsa(digest),
        ) => {
            let mut point = [0u8; 33];
            let compressed = big_r.affine_point.len() == 66
                && hex::decode_to_slice(&big_r.affine_point, &mut point).is_ok()
                && (point[0] == 2 || point[0] == 3);
            if !compressed {
                return Err(bad("has no compressed point big_r"));
            }
            let mut rs = [0u8; 64];
            rs[..32].copy_from_slice(&point[1..]);
            let digits = s.scalar.len();
            let padded = format!("{:0>64}", s.scalar);
            if digits == 0 || digits > 64 || hex::decode_to_slice(&padded, &mut rs[32..]).is_err() {
                return Err(bad("has no 32-byte scalar s"));
            }
            if *recovery_id > 1 {
                return Err(bad(&format!("has recovery id {recovery_id}, not 0 or 1")));
            }
            let mut hash = [0u8; 32];
            hex::decode_to_slice(digest, &mut hash).map_err(|_| bad("request has no digest"))?;
            match recover_evm(&hash, &rs, *recovery_id) {
                Some(address) if address == signer => Ok(()),
                Some(address) => Err(bad(&format!(
                    "recovers to {address}, not the desk's address {signer}"
                ))),
                None => Err(bad("recovers to no key")),
            }
        }
        (MpcSignature::Ed25519 { signature }, SignPayload::Eddsa(message)) => {
            let sig: &[u8; 64] = signature
                .as_slice()
                .try_into()
                .map_err(|_| bad(&format!("has {} bytes, not 64", signature.len())))?;
            let key = decode_base58_32(signer).ok_or_else(|| bad("has no signer key"))?;
            let message = hex::decode(message).map_err(|_| bad("request is not hex"))?;
            if env::ed25519_verify(sig, message, &key) {
                Ok(())
            } else {
                Err(bad(&format!(
                    "does not verify under the desk's key {signer}"
                )))
            }
        }
        (MpcSignature::Secp256k1 { .. }, SignPayload::Eddsa(_)) => {
            Err(bad("is secp256k1 for an Ed25519 request"))
        }
        (MpcSignature::Ed25519 { .. }, SignPayload::Ecdsa(_)) => {
            Err(bad("is Ed25519 for a secp256k1 request"))
        }
    }
}

/// Gas for one `derived_public_key` call. Measured on `v1.signer-prod.testnet` on 2026-10-30 as a
/// transaction: 5.37 TGas for domain 0, 5.29 TGas for domain 1.
pub const DERIVE_GAS: Gas = Gas::from_tgas(15);

/// Longest answer read: `"secp256k1:<base58 of 64 bytes>"` is at most 100 bytes of JSON, so a longer
/// one is not a key and is not read into memory.
pub const ANSWER_MAX_LEN: usize = 256;

/// The promise result index of each key in the callback: the order of [`desk_keys`].
pub const EVM_RESULT: u64 = 0;
pub const SOL_RESULT: u64 = 1;

/// `derived_public_key({path, predecessor, domain_id})` on the MPC contract.
pub fn derived_public_key(
    mpc: &AccountId,
    path: String,
    predecessor: &AccountId,
    domain_id: u32,
) -> Promise {
    let args = serde_json::json!({
        "path": path,
        "predecessor": predecessor,
        "domain_id": domain_id,
    });
    Promise::new(mpc.clone()).function_call(
        "derived_public_key",
        args.to_string().into_bytes(),
        NearToken::from_yoctonear(0),
        DERIVE_GAS,
    )
}

/// Both keys of a desk, derived for `contract`: the EVM key (result 0) and the Solana key (result 1).
pub fn desk_keys(mpc: &AccountId, desk_id: &str, contract: &AccountId) -> Promise {
    derived_public_key(mpc, evm_path(desk_id), contract, MPC_DOMAIN_SECP256K1).and(
        derived_public_key(mpc, sol_path(desk_id), contract, MPC_DOMAIN_ED25519),
    )
}

/// The string the MPC contract returned as promise result `index`, or `E_MPC` when the call failed
/// or returned something else. `what` names the key in the message.
pub fn answer(index: u64, what: &str) -> Result<String, Refusal> {
    let bytes = env::promise_result_checked(index, ANSWER_MAX_LEN).map_err(|e| {
        Refusal::new(
            E_MPC,
            format!("the MPC contract did not return the desk's {what} key: {e}"),
        )
    })?;
    serde_json::from_slice::<String>(&bytes).map_err(|_| {
        Refusal::new(
            E_MPC,
            format!(
                "the MPC contract returned no {what} key, but {} bytes of something else",
                bytes.len()
            ),
        )
    })
}

/// The EVM address of a domain 0 answer: the last 20 bytes of keccak256 of the 64-byte key.
pub fn evm_address(answer: &str) -> Result<String, Refusal> {
    let key = decode_mpc_secp256k1(answer).ok_or_else(|| {
        Refusal::new(
            E_MPC,
            format!(
                "the MPC contract's EVM key {} is not secp256k1:<64 bytes>",
                shown(answer)
            ),
        )
    })?;
    Ok(evm_address_from_keccak(&env::keccak256_array(key)))
}

/// The 32 bytes of a domain 1 answer: the desk's Solana authority.
pub fn sol_authority(answer: &str) -> Result<[u8; 32], Refusal> {
    decode_mpc_ed25519(answer).ok_or_else(|| {
        Refusal::new(
            E_MPC,
            format!(
                "the MPC contract's Solana key {} is not ed25519:<32 bytes>",
                shown(answer)
            ),
        )
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::{testing_env, PromiseResult};

    /// What `v1.signer-prod.testnet` answered on 2026-10-30 for desk `c2-measure` of the testnet
    /// contract account, and the address and authority they give.
    pub const MPC_EVM: &str = "secp256k1:5SycFGui1Kswp8ivPpv3TNEeYbB7X3tCRUtxL2MtbdNhkggr2JsKrdPjzzzCsoHCCmsFf7pyg6xu1AKyB5SWEAbr";
    pub const MPC_SOL: &str = "ed25519:31wj7NJqAnKJYF9cZu7XR7xdCPxxcLKYkc2sh8ZExcJd";

    fn results(results: Vec<PromiseResult>) {
        testing_env!(
            VMContextBuilder::new().build(),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            results
        );
    }

    fn json(s: &str) -> PromiseResult {
        PromiseResult::Successful(serde_json::to_vec(s).unwrap())
    }

    #[test]
    fn the_testnet_answers_give_the_desk_addresses() {
        results(vec![]);
        assert_eq!(
            evm_address(MPC_EVM).unwrap(),
            "0x77cf7951f48ed15194825e2fe0908a6aa486d45a"
        );
        assert_eq!(
            bs58::encode(sol_authority(MPC_SOL).unwrap()).into_string(),
            "31wj7NJqAnKJYF9cZu7XR7xdCPxxcLKYkc2sh8ZExcJd"
        );
    }

    #[test]
    fn keys_of_the_wrong_kind_are_e_mpc() {
        results(vec![]);
        assert_eq!(evm_address(MPC_SOL).unwrap_err().code, E_MPC);
        assert_eq!(sol_authority(MPC_EVM).unwrap_err().code, E_MPC);
    }

    #[test]
    fn answers_are_json_strings_of_bounded_length() {
        results(vec![
            json(MPC_EVM),
            PromiseResult::Failed,
            PromiseResult::Successful(b"42".to_vec()),
            json(&"1".repeat(ANSWER_MAX_LEN)),
        ]);
        assert_eq!(answer(0, "EVM").unwrap(), MPC_EVM);
        let failed = answer(1, "Solana").unwrap_err();
        assert_eq!(failed.code, E_MPC);
        assert!(
            failed
                .msg
                .starts_with("the MPC contract did not return the desk's Solana key"),
            "{failed}"
        );
        let other = answer(2, "EVM").unwrap_err();
        assert_eq!(
            other.msg,
            "the MPC contract returned no EVM key, but 2 bytes of something else"
        );
        assert_eq!(answer(3, "EVM").unwrap_err().code, E_MPC);
    }
}
