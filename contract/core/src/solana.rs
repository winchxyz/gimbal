//! Solana for the desk's authority key: the program and mint addresses the policy names, the
//! desk's derived accounts (associated token accounts and the Phoenix trader PDA), and the message
//! parser `sol_sign` and `sol_sign_register` read before [`crate::phoenix`] checks what a message
//! does.
//!
//! The derived accounts come from the authority alone. Every check derives them again and never
//! trusts the `SolanaAccounts` an owner registered: desks created before the derivation check kept
//! whatever was typed.

use crate::ed25519::is_on_curve;
use crate::errors::{Refusal, E_ARGS, E_SOL_MESSAGE};

/// sha256, which the derivations take as a function (the contract passes the host's).
pub type Sha256 = fn(&[u8]) -> [u8; 32];

/// A Solana address.
pub type Pubkey = [u8; 32];

/// `11111111111111111111111111111111`.
pub const SYSTEM_PROGRAM: Pubkey = [0; 32];
/// `ComputeBudget111111111111111111111111111111`.
pub const COMPUTE_BUDGET_PROGRAM: Pubkey = [
    0x03, 0x06, 0x46, 0x6f, 0xe5, 0x21, 0x17, 0x32, 0xff, 0xec, 0xad, 0xba, 0x72, 0xc3, 0x9b, 0xe7,
    0xbc, 0x8c, 0xe5, 0xbb, 0xc5, 0xf7, 0x12, 0x6b, 0x2c, 0x43, 0x9b, 0x3a, 0x40, 0x00, 0x00, 0x00,
];
/// `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`, the SPL Token program.
pub const TOKEN_PROGRAM: Pubkey = [
    0x06, 0xdd, 0xf6, 0xe1, 0xd7, 0x65, 0xa1, 0x93, 0xd9, 0xcb, 0xe1, 0x46, 0xce, 0xeb, 0x79, 0xac,
    0x1c, 0xb4, 0x85, 0xed, 0x5f, 0x5b, 0x37, 0x91, 0x3a, 0x8c, 0xf5, 0x85, 0x7e, 0xff, 0x00, 0xa9,
];
/// `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL`, the associated token account program.
pub const ATA_PROGRAM: Pubkey = [
    0x8c, 0x97, 0x25, 0x8f, 0x4e, 0x24, 0x89, 0xf1, 0xbb, 0x3d, 0x10, 0x29, 0x14, 0x8e, 0x0d, 0x83,
    0x0b, 0x5a, 0x13, 0x99, 0xda, 0xff, 0x10, 0x84, 0x04, 0x8e, 0x7b, 0xd8, 0xdb, 0xe9, 0xf8, 0x59,
];
/// `EtrnLzgbS7nMMy5fbD42kXiUzGg8XQzJ972Xtk1cjWih`, Phoenix perpetuals.
pub const PHOENIX_PROGRAM: Pubkey = [
    0xce, 0x70, 0xd6, 0xfb, 0x56, 0x8e, 0x43, 0xeb, 0xfc, 0x96, 0x4a, 0x90, 0x15, 0x6c, 0x3b, 0xe9,
    0x56, 0x3b, 0x08, 0x17, 0x06, 0x7c, 0xab, 0x69, 0x4e, 0xbc, 0x83, 0xef, 0xdd, 0xb3, 0x7e, 0x86,
];
/// `EMBERpYNE6ehWmXymZZS2skiFmCa9V5dp14e1iduM5qy`, which converts USDC and PhUSD.
pub const EMBER_PROGRAM: Pubkey = [
    0xc6, 0x53, 0x1d, 0x73, 0x00, 0xb4, 0x55, 0x0c, 0xe0, 0x01, 0xa6, 0x14, 0x3a, 0xea, 0x2b, 0x08,
    0x3f, 0x1e, 0xb0, 0x71, 0xb8, 0x56, 0x7d, 0x76, 0x0e, 0xcc, 0x12, 0x57, 0x03, 0xc4, 0x67, 0xc8,
];
/// `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`, USDC.
pub const USDC_MINT: Pubkey = [
    0xc6, 0xfa, 0x7a, 0xf3, 0xbe, 0xdb, 0xad, 0x3a, 0x3d, 0x65, 0xf3, 0x6a, 0xab, 0xc9, 0x74, 0x31,
    0xb1, 0xbb, 0xe4, 0xc2, 0xd2, 0xf6, 0xe0, 0xe4, 0x7c, 0xa6, 0x02, 0x03, 0x45, 0x2f, 0x5d, 0x61,
];
/// `PhUsd11YkbjSaWjFncfAAmatntsjx3MgDR9B6g1ks3A`, Phoenix's collateral token.
pub const PHUSD_MINT: Pubkey = [
    0x05, 0xd0, 0x8c, 0xa0, 0x43, 0x7e, 0xe7, 0x56, 0x2b, 0x66, 0x48, 0xe7, 0x6d, 0x50, 0x94, 0xaf,
    0x35, 0x0b, 0x57, 0xc3, 0x82, 0x0b, 0x67, 0x16, 0xfc, 0x96, 0xe7, 0x77, 0xd4, 0x49, 0xa9, 0xdd,
];
/// `6ur7v6AXNpnHeEb6xuk7PyezvZ1i5GrgYyWZkNCpzbRz`, the only delegate a desk token account may
/// approve: Ember's authority, for an unwrap.
pub const EMBER_AUTHORITY: Pubkey = [
    0x57, 0xd4, 0x2d, 0x0d, 0xee, 0xf8, 0x12, 0x82, 0x63, 0xa3, 0x38, 0x77, 0xbe, 0x4a, 0x4a, 0x8d,
    0xa4, 0x05, 0xe9, 0xe0, 0x05, 0x78, 0x4a, 0xf2, 0x6a, 0xd2, 0x9f, 0xae, 0xe4, 0x8f, 0xcb, 0xe9,
];
/// `EzkM8YbCkBLaCqX2cdxtMyxfTLpKui3mWQWnhe5w2P4Z`, Phoenix's trader onboarder, the second signer
/// of a registration (the same key for every trader).
pub const PHOENIX_ONBOARDER: Pubkey = [
    0xcf, 0xf3, 0x0c, 0x81, 0x56, 0xc4, 0x3b, 0xcc, 0xeb, 0x93, 0xe4, 0xfd, 0x5d, 0x61, 0x1f, 0x35,
    0xf5, 0x19, 0xbc, 0x1f, 0x70, 0x57, 0xf0, 0x16, 0xfd, 0x7e, 0xa6, 0x92, 0x9e, 0x87, 0x42, 0x2e,
];

/// The most bytes a signed transaction may have on the wire (Solana's packet size).
pub const MAX_TRANSACTION_BYTES: usize = 1232;

/// What Solana hashes after the seeds and the program id.
const PDA_MARKER: &[u8] = b"ProgramDerivedAddress";

/// `create_program_address`: sha256(seeds ‖ program ‖ "ProgramDerivedAddress"), or `None` when
/// that lands on the curve (a key could sign for it).
pub fn create_program_address(sha256: Sha256, seeds: &[&[u8]], program: &Pubkey) -> Option<Pubkey> {
    let mut buf = Vec::with_capacity(seeds.iter().map(|s| s.len()).sum::<usize>() + 32 + 21);
    for seed in seeds {
        buf.extend_from_slice(seed);
    }
    buf.extend_from_slice(program);
    buf.extend_from_slice(PDA_MARKER);
    let address = sha256(&buf);
    (!is_on_curve(&address)).then_some(address)
}

/// `find_program_address`: the first bump from 255 down to 1 (Solana never tries 0) whose address
/// is off the curve. `None` only if all 255 land on it, which Solana treats as unreachable.
pub fn find_program_address(
    sha256: Sha256,
    seeds: &[&[u8]],
    program: &Pubkey,
) -> Option<(Pubkey, u8)> {
    let mut buf = seeds.concat();
    let seeds_len = buf.len();
    for bump in (1..=u8::MAX).rev() {
        buf.truncate(seeds_len);
        buf.push(bump);
        buf.extend_from_slice(program);
        buf.extend_from_slice(PDA_MARKER);
        let address = sha256(&buf);
        if !is_on_curve(&address) {
            return Some((address, bump));
        }
    }
    None
}

/// The associated token account of `owner` for `mint` (classic SPL Token).
pub fn associated_token_address(sha256: Sha256, owner: &Pubkey, mint: &Pubkey) -> Option<Pubkey> {
    let seeds: [&[u8]; 3] = [owner, &TOKEN_PROGRAM, mint];
    find_program_address(sha256, &seeds, &ATA_PROGRAM).map(|(a, _)| a)
}

/// The Phoenix trader account of `authority`: seeds `["trader", authority, [pda_index],
/// [subaccount]]`, index 0 and subaccount 0, as the Phoenix SDK derives it.
pub fn phoenix_trader_address(sha256: Sha256, authority: &Pubkey) -> Option<Pubkey> {
    let seeds: [&[u8]; 4] = [b"trader", authority, &[0], &[0]];
    find_program_address(sha256, &seeds, &PHOENIX_PROGRAM).map(|(a, _)| a)
}

/// The spline collection of a Phoenix market: seeds `["spline", orderbook]`, as the Phoenix SDK
/// derives it when the market metadata names none (it names none for ETH, SOL and BTC).
pub fn phoenix_spline_address(sha256: Sha256, orderbook: &Pubkey) -> Option<Pubkey> {
    let seeds: [&[u8]; 2] = [b"spline", orderbook];
    find_program_address(sha256, &seeds, &PHOENIX_PROGRAM).map(|(a, _)| a)
}

/// The desk's Solana accounts, all derived from its authority (the MPC Ed25519 key).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SolDesk {
    pub authority: Pubkey,
    pub usdc_ata: Pubkey,
    pub phusd_ata: Pubkey,
    pub trader: Pubkey,
}

impl SolDesk {
    pub fn derive(sha256: Sha256, authority: Pubkey) -> Result<SolDesk, Refusal> {
        let derived = |what: &str, address: Option<Pubkey>| {
            address.ok_or_else(|| {
                Refusal::new(
                    E_ARGS,
                    format!(
                        "no {what} address for authority {}",
                        bs58::encode(authority).into_string()
                    ),
                )
            })
        };
        Ok(SolDesk {
            usdc_ata: derived(
                "USDC token account",
                associated_token_address(sha256, &authority, &USDC_MINT),
            )?,
            phusd_ata: derived(
                "PhUSD token account",
                associated_token_address(sha256, &authority, &PHUSD_MINT),
            )?,
            trader: derived("Phoenix trader", phoenix_trader_address(sha256, &authority))?,
            authority,
        })
    }

    /// One of the desk's own token accounts (USDC or PhUSD).
    pub fn is_token_account(&self, account: &Pubkey) -> bool {
        *account == self.usdc_ata || *account == self.phusd_ata
    }
}

/// How a message is encoded.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Format {
    Legacy,
    /// Version 0 (first byte 0x80) with no address-table lookups.
    V0,
}

/// A parsed message. Accounts are resolved to their addresses.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Message<'a> {
    pub format: Format,
    pub num_required_signatures: u8,
    pub num_readonly_signed: u8,
    pub num_readonly_unsigned: u8,
    pub keys: Vec<Pubkey>,
    pub recent_blockhash: Pubkey,
    pub instructions: Vec<Instruction<'a>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Instruction<'a> {
    pub program_index: u8,
    pub program: Pubkey,
    pub account_indexes: Vec<u8>,
    pub accounts: Vec<Pubkey>,
    pub data: &'a [u8],
}

fn refuse(msg: impl Into<String>) -> Refusal {
    Refusal::new(E_SOL_MESSAGE, msg)
}

struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize, what: &str) -> Result<&'a [u8], Refusal> {
        let end = self
            .at
            .checked_add(n)
            .filter(|&end| end <= self.bytes.len())
            .ok_or_else(|| {
                refuse(format!(
                    "the message ends at byte {} inside {what}",
                    self.bytes.len()
                ))
            })?;
        let out = &self.bytes[self.at..end];
        self.at = end;
        Ok(out)
    }

    fn byte(&mut self, what: &str) -> Result<u8, Refusal> {
        Ok(self.take(1, what)?[0])
    }

    fn key(&mut self, what: &str) -> Result<Pubkey, Refusal> {
        let mut key = [0u8; 32];
        key.copy_from_slice(self.take(32, what)?);
        Ok(key)
    }

    /// Solana's compact-u16 (`short_vec`): 7 bits a byte, at most 3 bytes, no longer spelling than
    /// needed, at most 65535.
    fn compact_u16(&mut self, what: &str) -> Result<usize, Refusal> {
        let mut value = 0u32;
        for i in 0..3 {
            let byte = self.byte(what)?;
            if i > 0 && byte == 0 {
                return Err(refuse(format!(
                    "{what} is not in its shortest compact-u16 form"
                )));
            }
            value |= u32::from(byte & 0x7f) << (7 * i);
            if byte & 0x80 == 0 {
                return u16::try_from(value)
                    .map(usize::from)
                    .map_err(|_| refuse(format!("{what} is over 65535")));
            }
        }
        Err(refuse(format!("{what} is longer than 3 bytes")))
    }
}

/// Parses a message: header (3 bytes), compact-u16 key count and 32-byte keys, recent blockhash,
/// compact-u16 instruction count, and per instruction a program index, compact-u16 account indexes
/// and compact-u16 data. A legacy message starts with the header (first byte below 0x80); a
/// version 0 one with 0x80, and ends with a compact-u16 count of address-table lookups, which must
/// be 0 (keys loaded from a table could be anything). Other versions, a short message and
/// trailing bytes are `E_SOL_MESSAGE`, and so is anything Solana's own sanitizing refuses: an
/// index outside the keys, a program at index 0 (the fee payer), a read-only fee payer, more
/// signers and read-only accounts than keys, or a key listed twice. Which format a method takes
/// is the caller's check.
pub fn parse_message(bytes: &[u8]) -> Result<Message<'_>, Refusal> {
    let mut r = Reader { bytes, at: 0 };
    let format = match bytes.first() {
        Some(&b) if b & 0x80 != 0 => {
            if b != 0x80 {
                return Err(refuse(format!(
                    "a version {} message; only legacy and version 0 messages are read",
                    b & 0x7f
                )));
            }
            r.at = 1;
            Format::V0
        }
        _ => Format::Legacy,
    };
    let num_required_signatures = r.byte("the header")?;
    let num_readonly_signed = r.byte("the header")?;
    let num_readonly_unsigned = r.byte("the header")?;
    let num_keys = r.compact_u16("the key count")?;
    let keys = (0..num_keys)
        .map(|_| r.key("the account keys"))
        .collect::<Result<Vec<_>, _>>()?;
    let recent_blockhash = r.key("the recent blockhash")?;
    let num_instructions = r.compact_u16("the instruction count")?;
    let mut instructions = Vec::with_capacity(num_instructions.min(64));
    for n in 0..num_instructions {
        let program_index = r.byte("an instruction")?;
        let num_accounts = r.compact_u16("an account count")?;
        let account_indexes = r.take(num_accounts, "account indexes")?.to_vec();
        let data_len = r.compact_u16("a data length")?;
        let data = r.take(data_len, "instruction data")?;
        let key = |i: u8| {
            keys.get(usize::from(i)).copied().ok_or_else(|| {
                refuse(format!(
                    "instruction {n}: account index {i} is outside the {num_keys} keys"
                ))
            })
        };
        if program_index == 0 {
            return Err(refuse(format!(
                "instruction {n}: the program is keys[0], the fee payer"
            )));
        }
        let program = key(program_index)?;
        let accounts = account_indexes
            .iter()
            .map(|&i| key(i))
            .collect::<Result<Vec<_>, _>>()?;
        instructions.push(Instruction {
            program_index,
            program,
            account_indexes,
            accounts,
            data,
        });
    }
    if format == Format::V0 {
        let lookups = r.compact_u16("the address-table lookup count")?;
        if lookups != 0 {
            return Err(refuse(format!(
                "{lookups} address-table lookup(s); only messages that list every key are read"
            )));
        }
    }
    if r.at != bytes.len() {
        return Err(refuse(format!(
            "{} trailing bytes after the last instruction",
            bytes.len() - r.at
        )));
    }
    if num_readonly_signed >= num_required_signatures {
        return Err(refuse(
            "the fee payer must sign and be writable: num_readonly_signed is not below \
             num_required_signatures",
        ));
    }
    if usize::from(num_required_signatures) + usize::from(num_readonly_unsigned) > keys.len() {
        return Err(refuse(format!(
            "{num_required_signatures} signers and {num_readonly_unsigned} read-only accounts \
             do not fit {} keys",
            keys.len()
        )));
    }
    for (i, key) in keys.iter().enumerate() {
        if keys[..i].contains(key) {
            return Err(refuse(format!(
                "{} is listed twice in the account keys",
                bs58::encode(key).into_string()
            )));
        }
    }
    Ok(Message {
        format,
        num_required_signatures,
        num_readonly_signed,
        num_readonly_unsigned,
        keys,
        recent_blockhash,
        instructions,
    })
}

/// A message for `signers` signatures must leave room for them in one transaction: compact-u16
/// count, 64 bytes each, then the message, at most [`MAX_TRANSACTION_BYTES`].
pub fn check_transaction_size(message_len: usize, signers: usize) -> Result<(), Refusal> {
    let size = 1 + 64 * signers + message_len;
    if size > MAX_TRANSACTION_BYTES {
        return Err(refuse(format!(
            "a {message_len}-byte message with {signers} signature(s) is a {size}-byte \
             transaction, over {MAX_TRANSACTION_BYTES}"
        )));
    }
    Ok(())
}

/// Base58 of an address, for messages.
pub fn b58(key: &Pubkey) -> String {
    bs58::encode(key).into_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One instruction, `prog` with `accounts` and `data`, over `keys`.
    fn message(header: [u8; 3], keys: &[Pubkey], ixs: &[(u8, &[u8], &[u8])]) -> Vec<u8> {
        let mut m = header.to_vec();
        m.push(keys.len() as u8);
        for k in keys {
            m.extend_from_slice(k);
        }
        m.extend_from_slice(&[7; 32]);
        m.push(ixs.len() as u8);
        for (prog, accounts, data) in ixs {
            m.push(*prog);
            m.push(accounts.len() as u8);
            m.extend_from_slice(accounts);
            m.push(data.len() as u8);
            m.extend_from_slice(data);
        }
        m
    }

    fn code(r: Result<Message<'_>, Refusal>) -> String {
        r.unwrap_err().msg
    }

    #[test]
    fn a_minimal_message_parses() {
        let m = message([1, 0, 1], &[[1; 32], [2; 32]], &[(1, &[0], &[9, 9])]);
        let p = parse_message(&m).unwrap();
        assert_eq!(p.keys, vec![[1; 32], [2; 32]]);
        assert_eq!(p.recent_blockhash, [7; 32]);
        assert_eq!(p.instructions[0].program, [2; 32]);
        assert_eq!(p.instructions[0].accounts, vec![[1; 32]]);
        assert_eq!(p.instructions[0].data, &[9, 9]);
    }

    #[test]
    fn sanitizing_refuses_what_solana_refuses() {
        let keys = [[1; 32], [2; 32]];
        let msg = code(parse_message(&message([1, 0, 1], &keys, &[(0, &[], &[])])));
        assert!(msg.contains("the fee payer"), "{msg}");
        let msg = code(parse_message(&message([1, 0, 1], &keys, &[(2, &[], &[])])));
        assert!(
            msg.contains("account index 2 is outside the 2 keys"),
            "{msg}"
        );
        let msg = code(parse_message(&message([1, 0, 1], &keys, &[(1, &[5], &[])])));
        assert!(msg.contains("account index 5"), "{msg}");
        let msg = code(parse_message(&message([1, 1, 0], &keys, &[])));
        assert!(msg.contains("num_readonly_signed"), "{msg}");
        let msg = code(parse_message(&message([0, 0, 0], &keys, &[])));
        assert!(msg.contains("num_readonly_signed"), "{msg}");
        let msg = code(parse_message(&message([1, 0, 2], &keys, &[])));
        assert!(msg.contains("do not fit 2 keys"), "{msg}");
        let msg = code(parse_message(&message([1, 0, 0], &[[1; 32], [1; 32]], &[])));
        assert!(msg.contains("listed twice"), "{msg}");
    }

    #[test]
    fn short_versioned_and_padded_messages_are_refused() {
        let m = message([1, 0, 1], &[[1; 32], [2; 32]], &[(1, &[], &[])]);
        for cut in 0..m.len() {
            let r = parse_message(&m[..cut]).unwrap_err();
            assert_eq!(r.code, E_SOL_MESSAGE, "cut at {cut}");
        }
        let mut long = m.clone();
        long.push(0);
        assert!(code(parse_message(&long)).contains("1 trailing bytes"));
        assert_eq!(parse_message(&m).unwrap().format, Format::Legacy);
    }

    #[test]
    fn version_0_is_read_only_without_lookups() {
        let legacy = message([1, 0, 1], &[[1; 32], [2; 32]], &[(1, &[0], &[5])]);
        let mut v0 = vec![0x80];
        v0.extend_from_slice(&legacy);
        // The lookup count is missing.
        assert!(code(parse_message(&v0)).contains("address-table lookup count"));
        v0.push(0);
        let p = parse_message(&v0).unwrap();
        assert_eq!(p.format, Format::V0);
        assert_eq!(p.instructions, parse_message(&legacy).unwrap().instructions);
        let mut lookup = v0.clone();
        *lookup.last_mut().unwrap() = 1;
        assert!(code(parse_message(&lookup)).contains("1 address-table lookup(s)"));
        let mut v1 = v0;
        v1[0] = 0x81;
        assert!(code(parse_message(&v1)).contains("a version 1 message"));
    }

    #[test]
    fn compact_u16_takes_only_its_shortest_form() {
        let read = |b: &[u8]| Reader { bytes: b, at: 0 }.compact_u16("n");
        assert_eq!(read(&[0x00]).unwrap(), 0);
        assert_eq!(read(&[0x7f]).unwrap(), 127);
        assert_eq!(read(&[0x80, 0x01]).unwrap(), 128);
        assert_eq!(read(&[0xff, 0xff, 0x03]).unwrap(), 65535);
        assert!(read(&[0x80, 0x00]).unwrap_err().msg.contains("shortest"));
        assert!(read(&[0xff, 0xff, 0x04])
            .unwrap_err()
            .msg
            .contains("over 65535"));
        assert!(read(&[0x80, 0x80, 0x80])
            .unwrap_err()
            .msg
            .contains("longer than 3"));
        assert!(read(&[0x80]).is_err());
    }

    #[test]
    fn the_transaction_size_counts_the_signatures() {
        check_transaction_size(1232 - 65, 1).unwrap();
        assert_eq!(
            check_transaction_size(1232 - 64, 1)
                .unwrap_err()
                .to_string(),
            "E_SOL_MESSAGE: a 1168-byte message with 1 signature(s) is a 1233-byte transaction, \
             over 1232"
        );
        check_transaction_size(1232 - 129, 2).unwrap();
        assert!(check_transaction_size(1232 - 128, 2).is_err());
    }
}
