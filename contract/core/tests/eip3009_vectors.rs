//! `vectors/eip3009.json` against the EIP-3009 builder: the type hash and both USDC domains as read
//! on chain, every nonce case, and the struct hash, digest and payload of every case.

use gimbal_core::eip3009::{domain_separator, nonce, usdc_token, Authorization, TYPE, VALIDITY_S};
use gimbal_core::network::Network;
use serde_json::Value;
use sha3::{Digest, Keccak256};

const VECTORS: &str = include_str!("vectors/eip3009.json");

fn keccak(data: &[u8]) -> [u8; 32] {
    Keccak256::digest(data).into()
}

fn h(bytes: &[u8]) -> String {
    format!("0x{}", hex::encode(bytes))
}

fn s(v: &Value) -> &str {
    v.as_str().unwrap_or_else(|| panic!("not a string: {v}"))
}

fn network(v: &Value) -> Network {
    match s(v) {
        "mainnet" => Network::Mainnet,
        "testnet" => Network::Testnet,
        other => panic!("network {other}"),
    }
}

fn bytes<const N: usize>(hex_str: &str) -> [u8; N] {
    let mut out = [0u8; N];
    hex::decode_to_slice(hex_str.strip_prefix("0x").unwrap(), &mut out).unwrap();
    out
}

fn authorization(m: &Value) -> Authorization {
    Authorization {
        from: bytes(&s(&m["from"]).to_ascii_lowercase()),
        to: bytes(&s(&m["to"]).to_ascii_lowercase()),
        value: s(&m["value"]).parse().unwrap(),
        valid_after: s(&m["validAfter"]).parse().unwrap(),
        valid_before: s(&m["validBefore"]).parse().unwrap(),
        nonce: bytes(s(&m["nonce"])),
    }
}

#[test]
fn the_type_and_both_domains() {
    let v: Value = serde_json::from_str(VECTORS).unwrap();
    assert_eq!(s(&v["type_string"]), TYPE);
    assert_eq!(h(&keccak(TYPE.as_bytes())), s(&v["typehash"]));
    for (name, net) in [("mainnet", Network::Mainnet), ("testnet", Network::Testnet)] {
        let token = &v["tokens"][name];
        assert_eq!(s(&token["token"]).to_ascii_lowercase(), usdc_token(net));
        assert_eq!(token["chainId"].as_u64().unwrap(), net.arbitrum_chain_id());
        assert_eq!(
            h(&domain_separator(keccak, net)),
            s(&v["onchain"][name]["DOMAIN_SEPARATOR"]),
            "{name}"
        );
    }
}

#[test]
fn every_nonce_case() {
    let v: Value = serde_json::from_str(VECTORS).unwrap();
    for c in v["nonce_cases"].as_array().unwrap() {
        let counter: u64 = s(&c["counter"]).parse().unwrap();
        let mut preimage = s(&c["desk_id"]).as_bytes().to_vec();
        preimage.extend_from_slice(&counter.to_be_bytes());
        assert_eq!(h(&preimage), s(&c["preimage_hex"]));
        assert_eq!(h(&nonce(keccak, s(&c["desk_id"]), counter)), s(&c["nonce"]));
    }
}

/// The digest arithmetic of every case, the older ones (now + 1800) and the contract's own.
#[test]
fn every_case_hashes_as_viem_does() {
    let v: Value = serde_json::from_str(VECTORS).unwrap();
    let cases = v["cases"].as_array().unwrap();
    let contract = v["contract_cases"].as_array().unwrap();
    assert_eq!((cases.len(), contract.len()), (6, 3));
    for c in cases.iter().chain(contract) {
        let name = s(&c["name"]);
        let net = network(&c["network"]);
        let a = authorization(&c["message"]);
        let counter: u64 = s(&c["counter"]).parse().unwrap();
        assert_eq!(a.nonce, nonce(keccak, s(&c["desk_id"]), counter), "{name}");
        assert_eq!(h(&a.struct_hash(keccak)), s(&c["struct_hash"]), "{name}");
        assert_eq!(h(&a.digest(keccak, net)), s(&c["digest"]), "{name}");
    }
}

/// The contract's cases: valid for exactly [`VALIDITY_S`] from the block, and the payload the
/// relayer gets, key for key.
#[test]
fn the_contract_cases_and_their_payload() {
    let v: Value = serde_json::from_str(VECTORS).unwrap();
    for c in v["contract_cases"].as_array().unwrap() {
        let name = s(&c["name"]);
        let a = authorization(&c["message"]);
        assert_eq!(a.valid_after, 0, "{name}");
        assert_eq!(
            a.valid_before,
            c["now_s"].as_u64().unwrap() + VALIDITY_S,
            "{name}"
        );
        let payload = serde_json::to_string(&a.payload(network(&c["network"]))).unwrap();
        let parsed: Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(parsed, c["payload"], "{name}");
        // The keys in the order the file lists them (serde_json's map here may sort them).
        let keys = [
            "\"from\"",
            "\"to\"",
            "\"value\"",
            "\"validAfter\"",
            "\"validBefore\"",
            "\"nonce\"",
            "\"token\"",
            "\"chainId\"",
        ];
        let at: Vec<usize> = keys.iter().map(|k| payload.find(k).unwrap()).collect();
        assert!(at.windows(2).all(|w| w[0] < w[1]), "{name}: {payload}");
    }
}
