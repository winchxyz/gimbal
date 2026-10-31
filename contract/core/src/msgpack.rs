//! The msgpack Hyperliquid hashes an L1 action as, and the JSON the relayer posts the same action as.
//!
//! Hyperliquid hashes `msgpack(action)` with the map keys in the order its SDKs write them, so a
//! [`Value`] keeps its entries in the order they were built. The same value serialises to JSON in
//! that order too, so the bytes signed and the action posted come from one place.
//!
//! The writer knows only what actions contain: nil, bool, unsigned integers (always the smallest
//! form: positive fixint, uint 8/16/32/64; never a float or a signed int), strings (fixstr, str 8,
//! 16, 32), arrays and maps (fix, 16, 32).

use std::fmt;

use serde::de::{self, MapAccess, SeqAccess, Visitor};
use serde::ser::{SerializeMap, SerializeSeq};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Value {
    /// JSON `null` (`vaultAddress`); never part of a signed action.
    Nil,
    Bool(bool),
    UInt(u64),
    Str(String),
    Array(Vec<Value>),
    /// Entries in the order written; that order is part of what is signed.
    Map(Vec<(String, Value)>),
}

impl Value {
    /// A map with these entries, in this order.
    pub fn map<'a>(entries: impl IntoIterator<Item = (&'a str, Value)>) -> Self {
        Value::Map(
            entries
                .into_iter()
                .map(|(k, v)| (k.to_owned(), v))
                .collect(),
        )
    }

    pub fn str(s: impl Into<String>) -> Self {
        Value::Str(s.into())
    }

    /// The value of `key` in a map, if it is one and has it.
    pub fn get(&self, key: &str) -> Option<&Value> {
        match self {
            Value::Map(entries) => entries.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    /// The msgpack bytes of the value.
    pub fn to_msgpack(&self) -> Vec<u8> {
        let mut out = Vec::new();
        self.write(&mut out);
        out
    }

    fn write(&self, out: &mut Vec<u8>) {
        match self {
            Value::Nil => out.push(0xc0),
            Value::Bool(b) => out.push(if *b { 0xc3 } else { 0xc2 }),
            Value::UInt(n) => write_uint(out, *n),
            Value::Str(s) => write_str(out, s),
            Value::Array(items) => {
                write_len(out, items.len(), [0x90, 0xdc, 0xdd]);
                for item in items {
                    item.write(out);
                }
            }
            Value::Map(entries) => {
                write_len(out, entries.len(), [0x80, 0xde, 0xdf]);
                for (key, value) in entries {
                    write_str(out, key);
                    value.write(out);
                }
            }
        }
    }
}

fn write_uint(out: &mut Vec<u8>, n: u64) {
    if n < 0x80 {
        out.push(n as u8);
    } else if let Ok(n) = u8::try_from(n) {
        out.extend([0xcc, n]);
    } else if let Ok(n) = u16::try_from(n) {
        out.push(0xcd);
        out.extend(n.to_be_bytes());
    } else if let Ok(n) = u32::try_from(n) {
        out.push(0xce);
        out.extend(n.to_be_bytes());
    } else {
        out.push(0xcf);
        out.extend(n.to_be_bytes());
    }
}

fn write_str(out: &mut Vec<u8>, s: &str) {
    let len = s.len();
    if len < 32 {
        out.push(0xa0 | len as u8);
    } else if let Ok(len) = u8::try_from(len) {
        out.extend([0xd9, len]);
    } else if let Ok(len) = u16::try_from(len) {
        out.push(0xda);
        out.extend(len.to_be_bytes());
    } else {
        out.push(0xdb);
        out.extend(u32_len(len).to_be_bytes());
    }
    out.extend_from_slice(s.as_bytes());
}

/// The header of an array or a map: `[fix, 16-bit, 32-bit]` markers; the fix form holds up to 15.
fn write_len(out: &mut Vec<u8>, len: usize, [fix, m16, m32]: [u8; 3]) {
    if len < 16 {
        out.push(fix | len as u8);
    } else if let Ok(len) = u16::try_from(len) {
        out.push(m16);
        out.extend(len.to_be_bytes());
    } else {
        out.push(m32);
        out.extend(u32_len(len).to_be_bytes());
    }
}

/// msgpack lengths stop at 2^32 − 1; the contract builds nothing near that (wasm32 memory is 4 GiB).
fn u32_len(len: usize) -> u32 {
    u32::try_from(len).unwrap_or(u32::MAX)
}

impl Serialize for Value {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Value::Nil => serializer.serialize_unit(),
            Value::Bool(b) => serializer.serialize_bool(*b),
            Value::UInt(n) => serializer.serialize_u64(*n),
            Value::Str(s) => serializer.serialize_str(s),
            Value::Array(items) => {
                let mut seq = serializer.serialize_seq(Some(items.len()))?;
                for item in items {
                    seq.serialize_element(item)?;
                }
                seq.end()
            }
            Value::Map(entries) => {
                let mut map = serializer.serialize_map(Some(entries.len()))?;
                for (key, value) in entries {
                    map.serialize_entry(key, value)?;
                }
                map.end()
            }
        }
    }
}

/// Reads JSON back in the same shape and order, so a callback can take a built action as an
/// argument. Floats and negative numbers are refused: no action has them.
impl<'de> Deserialize<'de> for Value {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(ValueVisitor)
    }
}

struct ValueVisitor;

impl<'de> Visitor<'de> for ValueVisitor {
    type Value = Value;

    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("null, a bool, an unsigned integer, a string, an array or a map")
    }

    fn visit_unit<E>(self) -> Result<Value, E> {
        Ok(Value::Nil)
    }

    fn visit_none<E>(self) -> Result<Value, E> {
        Ok(Value::Nil)
    }

    fn visit_bool<E>(self, b: bool) -> Result<Value, E> {
        Ok(Value::Bool(b))
    }

    fn visit_u64<E>(self, n: u64) -> Result<Value, E> {
        Ok(Value::UInt(n))
    }

    fn visit_i64<E: de::Error>(self, n: i64) -> Result<Value, E> {
        u64::try_from(n)
            .map(Value::UInt)
            .map_err(|_| E::custom("negative integer"))
    }

    fn visit_str<E>(self, s: &str) -> Result<Value, E> {
        Ok(Value::Str(s.to_owned()))
    }

    fn visit_string<E>(self, s: String) -> Result<Value, E> {
        Ok(Value::Str(s))
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Value, A::Error> {
        let mut items = Vec::new();
        while let Some(item) = seq.next_element()? {
            items.push(item);
        }
        Ok(Value::Array(items))
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Value, A::Error> {
        let mut entries = Vec::new();
        while let Some(entry) = map.next_entry()? {
            entries.push(entry);
        }
        Ok(Value::Map(entries))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bytes(v: &Value) -> String {
        hex::encode(v.to_msgpack())
    }

    #[test]
    fn integers_take_the_smallest_unsigned_form() {
        for (n, want) in [
            (0, "00"),
            (77, "4d"),
            (127, "7f"),
            (128, "cc80"),
            (150, "cc96"),
            (255, "ccff"),
            (256, "cd0100"),
            (300, "cd012c"),
            (65_535, "cdffff"),
            (65_536, "ce00010000"),
            (110_003, "ce0001adb3"),
            (4_294_967_295, "ceffffffff"),
            (4_294_967_296, "cf0000000100000000"),
            (123_456_789_012, "cf0000001cbe991a14"),
            (u64::MAX, "cfffffffffffffffff"),
        ] {
            assert_eq!(bytes(&Value::UInt(n)), want, "{n}");
        }
    }

    #[test]
    fn strings_bools_and_nil() {
        assert_eq!(bytes(&Value::str("")), "a0");
        assert_eq!(bytes(&Value::str("na")), "a26e61");
        assert_eq!(
            bytes(&Value::str("a".repeat(31))),
            format!("bf{}", "61".repeat(31))
        );
        assert_eq!(
            bytes(&Value::str("a".repeat(32))),
            format!("d920{}", "61".repeat(32))
        );
        assert_eq!(
            bytes(&Value::str("a".repeat(255))),
            format!("d9ff{}", "61".repeat(255))
        );
        assert_eq!(
            bytes(&Value::str("a".repeat(256))),
            format!("da0100{}", "61".repeat(256))
        );
        assert_eq!(
            bytes(&Value::str("a".repeat(65_536))),
            format!("db00010000{}", "61".repeat(65_536))
        );
        assert_eq!(bytes(&Value::Bool(true)), "c3");
        assert_eq!(bytes(&Value::Bool(false)), "c2");
        assert_eq!(bytes(&Value::Nil), "c0");
    }

    #[test]
    fn arrays_and_maps_keep_their_order() {
        let map = Value::map([("b", Value::UInt(1)), ("a", Value::UInt(2))]);
        assert_eq!(bytes(&map), "82a16201a16102");
        assert_eq!(serde_json::to_string(&map).unwrap(), r#"{"b":1,"a":2}"#);
        assert_eq!(bytes(&Value::Array(vec![])), "90");
        let fifteen = Value::Array(vec![Value::UInt(1); 15]);
        assert_eq!(bytes(&fifteen), format!("9f{}", "01".repeat(15)));
        let sixteen = Value::Array(vec![Value::UInt(1); 16]);
        assert_eq!(bytes(&sixteen), format!("dc0010{}", "01".repeat(16)));
        let big = Value::Array(vec![Value::Nil; 65_536]);
        assert_eq!(&bytes(&big)[..10], "dd00010000");
        let keys: Vec<String> = (0..16).map(|i| format!("k{i:02}")).collect();
        let wide = Value::map(keys.iter().map(|k| (k.as_str(), Value::Nil)));
        assert!(bytes(&wide).starts_with("de0010a36b3030c0"));
        let huge = Value::Map((0..65_536).map(|i| (i.to_string(), Value::Nil)).collect());
        assert_eq!(&bytes(&huge)[..10], "df00010000");
    }

    #[test]
    fn json_round_trips_in_order() {
        let v = Value::map([
            ("type", Value::str("order")),
            (
                "orders",
                Value::Array(vec![Value::map([("a", Value::UInt(1))])]),
            ),
            ("r", Value::Bool(false)),
            ("vaultAddress", Value::Nil),
        ]);
        let json = serde_json::to_string(&v).unwrap();
        assert_eq!(
            json,
            r#"{"type":"order","orders":[{"a":1}],"r":false,"vaultAddress":null}"#
        );
        assert_eq!(serde_json::from_str::<Value>(&json).unwrap(), v);
        assert_eq!(v.get("r"), Some(&Value::Bool(false)));
        assert_eq!(v.get("x"), None);
        assert!(serde_json::from_str::<Value>("1.5").is_err());
        assert!(serde_json::from_str::<Value>("-1").is_err());
    }
}
