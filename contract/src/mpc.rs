//! The MPC contract's `derived_public_key`, which `create_desk` asks for a desk's two keys before it
//! stores the desk (docs/interfaces.md §1.2).

use gimbal_core::errors::{shown, Refusal, E_MPC};
use gimbal_core::ids::{
    decode_mpc_ed25519, decode_mpc_secp256k1, evm_address_from_keccak, evm_path, sol_path,
    MPC_DOMAIN_ED25519, MPC_DOMAIN_SECP256K1,
};
use near_sdk::{env, serde_json, AccountId, Gas, NearToken, Promise};

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
