//! How sessions travel through a relay. A machine keeps one WebSocket to the relay at /m/<id>;
//! each phone opens its own at /p/<id>. On the machine's socket, binary frames carry a 4-byte
//! session number before the bytes, and text frames are control messages. The relay never sees
//! anything but Noise ciphertext.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "lowercase")]
pub enum RelayToMachine {
    Challenge { nonce: String },
    Ready,
    Open { sid: u32 },
    Close { sid: u32 },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "lowercase")]
pub enum MachineToRelay {
    Auth { id: String, sig: String },
    Close { sid: u32 },
}

/// What the machine signs to prove to the relay it owns its id (a wire id from before the rename
/// to Inyon).
pub fn auth_message(nonce: &str) -> Vec<u8> {
    format!("tether-relay-auth:{nonce}").into_bytes()
}

pub fn frame(sid: u32, data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + data.len());
    out.extend_from_slice(&sid.to_be_bytes());
    out.extend_from_slice(data);
    out
}

/// None if the frame is too short to carry a session number.
pub fn unframe(buf: &[u8]) -> Option<(u32, &[u8])> {
    let (sid, data) = buf.split_first_chunk::<4>()?;
    Some((u32::from_be_bytes(*sid), data))
}

pub fn machine_path(id: &str) -> String {
    format!("/m/{id}")
}

pub fn phone_path(id: &str) -> String {
    format!("/p/{id}")
}

/// "https://relay.example.com" → its WebSocket URL for a path.
pub fn relay_ws(relay: &str, path: &str) -> String {
    let ws = match relay.strip_prefix("http") {
        Some(rest) => format!("ws{rest}"),
        None => relay.to_string(),
    };
    format!("{}{path}", ws.trim_end_matches('/'))
}
