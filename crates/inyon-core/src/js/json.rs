//! JSON values read the way the TS readers read `any`: `a?.b` on anything, JavaScript's
//! truthiness, `typeof` checks and `String(v)`, plus `JSON.stringify` byte for byte (the Codex
//! reader hashes it).

use serde_json::{Map, Value};

use super::num::fmt_number;

/// `JSON.stringify(v)`: no spaces, keys in insertion order except integer keys, which come first
/// in ascending order (JavaScript objects keep them that way), and numbers as JavaScript prints them.
pub fn stringify(v: &Value) -> String {
    let mut out = String::new();
    write(&mut out, v);
    out
}

fn write(out: &mut String, v: &Value) {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => out.push_str(&fmt_number(n.as_f64().unwrap_or(0.0))),
        Value::String(s) => quote(out, s),
        Value::Array(a) => {
            out.push('[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write(out, x);
            }
            out.push(']');
        }
        Value::Object(o) => {
            out.push('{');
            for (i, (k, x)) in ordered(o).into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                quote(out, k);
                out.push(':');
                write(out, x);
            }
            out.push('}');
        }
    }
}

/// An array index key ("0" up to 2^32 - 2, no leading zeros).
fn index_key(k: &str) -> Option<u32> {
    if k.is_empty() || (k.len() > 1 && k.starts_with('0')) || !k.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    k.parse::<u32>().ok().filter(|n| *n < u32::MAX)
}

/// An object's keys in the order JavaScript enumerates them.
pub fn ordered(o: &Map<String, Value>) -> Vec<(&String, &Value)> {
    let mut ints: Vec<(u32, (&String, &Value))> = Vec::new();
    let mut rest = Vec::new();
    for (k, v) in o {
        match index_key(k) {
            Some(n) => ints.push((n, (k, v))),
            None => rest.push((k, v)),
        }
    }
    ints.sort_by_key(|(n, _)| *n);
    ints.into_iter().map(|(_, kv)| kv).chain(rest).collect()
}

fn quote(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

/// `JSON.parse(s)`, or None where it throws. JavaScript also takes a `\uD83D` escape without the other
/// half of its pair (a transcript line cut in the middle of an emoji has one); a Rust string can't
/// hold half a pair, so it reads as U+FFFD here.
pub fn parse(s: &str) -> Option<Value> {
    match serde_json::from_str(s) {
        Ok(v) => Some(v),
        Err(_) if s.contains("\\u") => serde_json::from_str(&lone_surrogates(s)).ok(),
        Err(_) => None,
    }
}

/// The text with every `\uXXXX` escape of an unpaired surrogate written as `\uFFFD`.
fn lone_surrogates(s: &str) -> String {
    let b = s.as_bytes();
    let hex = |i: usize| -> Option<u16> { s.get(i..i + 4).and_then(|h| u16::from_str_radix(h, 16).ok()) };
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    let mut last = 0;
    while i < b.len() {
        if b[i] == b'\\' && i + 1 < b.len() {
            if b[i + 1] == b'u' {
                if let Some(u) = hex(i + 2) {
                    let paired_high =
                        (0xd800..0xdc00).contains(&u) && b.get(i + 6) == Some(&b'\\') && b.get(i + 7) == Some(&b'u') && hex(i + 8).is_some_and(|l| (0xdc00..0xe000).contains(&l));
                    if paired_high {
                        i += 12;
                        continue;
                    }
                    if (0xd800..0xe000).contains(&u) {
                        out.push_str(&s[last..i]);
                        out.push_str("\\uFFFD");
                        i += 6;
                        last = i;
                        continue;
                    }
                }
            }
            i += 2;
            continue;
        }
        i += 1;
    }
    out.push_str(&s[last..]);
    out
}

/// A value the TS reads as `any`: `None` is `undefined`.
#[allow(clippy::wrong_self_convention)] // the receiver is an Option<&Value>, which is Copy
pub trait Js<'a> {
    /// `v?.[key]`
    fn at(self, key: &str) -> Option<&'a Value>;
    /// `v?.[i]`
    fn idx(self, i: usize) -> Option<&'a Value>;
    /// `v ?? other`: undefined and null fall through
    fn or(self, other: Option<&'a Value>) -> Option<&'a Value>;
    /// neither undefined nor null
    fn present(self) -> Option<&'a Value>;
    /// JavaScript truthiness
    fn truthy(self) -> bool;
    /// `typeof v === 'string'`
    fn str(self) -> Option<&'a str>;
    /// a string that isn't empty (`typeof v === 'string' && v`, or `v` as a truthy string)
    fn nonempty(self) -> Option<&'a str>;
    /// `typeof v === 'number'` (finite: JSON has no other kind)
    fn num(self) -> Option<f64>;
    /// `Array.isArray(v)`
    fn arr(self) -> Option<&'a Vec<Value>>;
    /// a plain object
    fn obj(self) -> Option<&'a Map<String, Value>>;
    /// `typeof v === 'object' && v !== null` (arrays included)
    fn is_object(self) -> bool;
    /// `v === true`
    fn is_true(self) -> bool;
    /// `String(v)`, with undefined as "undefined"
    fn to_js_string(self) -> String;
    /// `String(v ?? '')`
    fn string_or_empty(self) -> String;
    /// the value as it would be copied into another object (`{ x: v }`), dropped when undefined
    fn cloned_value(self) -> Option<Value>;
}

impl<'a> Js<'a> for Option<&'a Value> {
    fn at(self, key: &str) -> Option<&'a Value> {
        match self? {
            Value::Object(o) => o.get(key),
            Value::Array(a) => index_key(key).and_then(|i| a.get(i as usize)),
            _ => None,
        }
    }
    fn idx(self, i: usize) -> Option<&'a Value> {
        match self? {
            Value::Array(a) => a.get(i),
            Value::Object(o) => o.get(&i.to_string()),
            _ => None,
        }
    }
    fn or(self, other: Option<&'a Value>) -> Option<&'a Value> {
        self.present().or(other)
    }
    fn present(self) -> Option<&'a Value> {
        self.filter(|v| !v.is_null())
    }
    fn truthy(self) -> bool {
        match self {
            None | Some(Value::Null) => false,
            Some(Value::Bool(b)) => *b,
            Some(Value::Number(n)) => n.as_f64().is_some_and(|x| x != 0.0 && !x.is_nan()),
            Some(Value::String(s)) => !s.is_empty(),
            Some(_) => true,
        }
    }
    fn str(self) -> Option<&'a str> {
        self.and_then(Value::as_str)
    }
    fn nonempty(self) -> Option<&'a str> {
        self.str().filter(|s| !s.is_empty())
    }
    fn num(self) -> Option<f64> {
        self.and_then(Value::as_f64)
    }
    fn arr(self) -> Option<&'a Vec<Value>> {
        self.and_then(Value::as_array)
    }
    fn obj(self) -> Option<&'a Map<String, Value>> {
        self.and_then(Value::as_object)
    }
    fn is_object(self) -> bool {
        matches!(self, Some(Value::Object(_)) | Some(Value::Array(_)))
    }
    fn is_true(self) -> bool {
        matches!(self, Some(Value::Bool(true)))
    }
    fn to_js_string(self) -> String {
        match self {
            None => "undefined".into(),
            Some(v) => value_string(v),
        }
    }
    fn string_or_empty(self) -> String {
        match self.present() {
            None => String::new(),
            Some(v) => value_string(v),
        }
    }
    fn cloned_value(self) -> Option<Value> {
        self.cloned()
    }
}

/// `String(v)` for a JSON value.
pub fn value_string(v: &Value) -> String {
    match v {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => fmt_number(n.as_f64().unwrap_or(0.0)),
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().map(|x| if x.is_null() { String::new() } else { value_string(x) }).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// A JSON number from an f64, written as JavaScript would (whole values as integers).
pub fn number(x: f64) -> Value {
    if x.is_finite() && x.fract() == 0.0 && x.abs() < 9_007_199_254_740_992.0 {
        Value::from(x as i64)
    } else {
        serde_json::Number::from_f64(x).map(Value::Number).unwrap_or(Value::Null)
    }
}

/// An object literal: `obj([("command", v), ...])`, leaving out the entries that are undefined
/// (None), as `JSON.stringify` and the wire would.
pub fn obj<const N: usize>(entries: [(&str, Option<Value>); N]) -> Value {
    let mut m = Map::new();
    for (k, v) in entries {
        if let Some(v) = v {
            m.insert(k.to_owned(), v);
        }
    }
    Value::Object(m)
}

/// A string as a JSON value.
pub fn s(v: impl Into<String>) -> Value {
    Value::String(v.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn half_a_surrogate_pair_still_parses() {
        assert_eq!(parse(r#"{"t":"a\ud83d"}"#).unwrap()["t"], "a\u{fffd}");
        assert_eq!(parse(r#"{"t":"\ud83d\ude42 \\ud83d"}"#).unwrap()["t"], "🙂 \\ud83d");
        assert_eq!(parse("{"), None);
    }

    #[test]
    fn stringifies_like_javascript() {
        let v: Value = serde_json::from_str(r#"{"b":1,"2":2,"a":[1.5e-7,1e21,"\u001f\u2028"],"1":0,"c":3.0}"#).unwrap();
        assert_eq!(stringify(&v), "{\"1\":0,\"2\":2,\"b\":1,\"a\":[1.5e-7,1e+21,\"\\u001f\u{2028}\"],\"c\":3}");
    }
}
