//! The Inyon window on Windows, opened from the tray icon: the control panel for this computer.
//! The link and how phones reach it, a pairing code drawn as a picture, the paired phones, the
//! service, updates, the last checks and the agents found, in one window of a fixed size. It's a
//! window of its own, so no terminal opens or flashes. `inyon window <role> [--pair]` starts it;
//! a second start brings the open one to the front instead. What it does goes to
//! ~/.inyon/node/window.log.
//!
//! [`layout`] places every control from the DPI and the work area alone, [`model`] works out
//! what each place says, and the Win32 code only draws that. The Dioxus desktop app replaces this
//! window at 1.0.

#[cfg(any(test, windows))]
mod demo;
pub mod layout;
pub mod model;
#[cfg(test)]
mod svg;
#[cfg(windows)]
mod win;

use crate::service::Role;

/// The window's class: the app finds an open window by it and brings it to the front.
pub const CLASS: &str = "InyonWindow";

/// Has the open window at `hwnd` show a pairing code.
#[cfg(windows)]
pub fn pair_now(hwnd: usize) {
    win::pair_now(hwnd);
}

#[cfg(not(windows))]
pub fn run(_role: Role, _pair: bool) -> i32 {
    eprintln!("The Inyon window is only on Windows.");
    2
}

#[cfg(windows)]
pub fn run(role: Role, pair: bool) -> i32 {
    win::run(role, pair)
}

/// What the code card shows for one of the engine's answers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CodeCard {
    /// it couldn't make one
    Failed(String),
    /// no code worth scanning yet: the tunnel is starting
    Starting(&'static str),
    /// the QR code and the typed-in code, with a note while the tunnel still starts
    Code { note: &'static str },
}

pub fn code_card(v: &serde_json::Value) -> CodeCard {
    use inyon_engine::output::{TUNNEL_SLOW, TUNNEL_STARTING};
    if let Some(e) = v.get("error").and_then(serde_json::Value::as_str) {
        return CodeCard::Failed(e.to_string());
    }
    let waiting = v.get("waiting").is_some();
    let none = |k: &str| v.get(k).and_then(serde_json::Value::as_array).is_none_or(|a| a.is_empty());
    match (waiting, v.get("qr").is_some(), none("urls") && none("relays")) {
        (true, false, _) => CodeCard::Starting(TUNNEL_STARTING),
        (true, true, true) => CodeCard::Starting(TUNNEL_SLOW),
        (true, true, false) => CodeCard::Code { note: "The tunnel is still starting: until it's up, this works on the same network or VPN." },
        _ => CodeCard::Code { note: "It works once, within 10 minutes." },
    }
}

/// What the window shows when the pairing's engine ends, given how it ended and whether the last
/// answer shown was only "the tunnel is starting" (None: nothing was shown). A usable code stays
/// on screen; a card still waiting for the tunnel is replaced by why it never came.
pub fn pairing_ended(r: Result<(), String>, last_starting: Option<bool>) -> Option<String> {
    match (r, last_starting) {
        (Err(e), None | Some(true)) => Some(e),
        (Ok(()), None) => Some("The engine gave no code.".to_string()),
        (Ok(()), Some(true)) => Some("The engine stopped before the tunnel came up. `inyon logs` shows what it said.".to_string()),
        (_, Some(false)) => None,
    }
}

/// The typed-in code as the app wants it: "ZS5C-3EPG" and "801 356".
pub fn short_code(v: &serde_json::Value) -> Option<(String, String)> {
    let short = v.get("short")?;
    let id = short.get("id").and_then(serde_json::Value::as_str)?;
    let code = short.get("code").and_then(serde_json::Value::as_str)?;
    let (a, b) = id.split_at(id.len().min(4));
    let (c, d) = code.split_at(code.len().min(3));
    Some((format!("{a}-{b}"), format!("{c} {d}")))
}

/// A line in window.log, with the time, for `inyon logs` and support; on stderr too, for a run
/// from a terminal.
pub fn trace(what: &str) {
    use std::io::Write;
    eprintln!("window: {what}");
    let dir = crate::paths::node_dir();
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("window.log")) {
        let _ = writeln!(f, "{} {what}", crate::state::format_time(crate::state::now_ms()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_code_card_waits_for_the_tunnel_and_then_shows_the_code() {
        let starting = serde_json::json!({ "waiting": "tunnel", "service": false });
        assert!(matches!(code_card(&starting), CodeCard::Starting(t) if t.starts_with("Starting the tunnel")));
        let slow = serde_json::json!({ "waiting": "tunnel", "qr": "https://x/#pair", "urls": [], "relays": [] });
        assert!(matches!(code_card(&slow), CodeCard::Starting(t) if t.contains("still starting")));
        let lan = serde_json::json!({ "waiting": "tunnel", "qr": "https://x/#pair", "urls": ["ws://192.168.1.20:4780/link"], "relays": [] });
        assert!(matches!(code_card(&lan), CodeCard::Code { note } if note.contains("same network")));
        let up = serde_json::json!({ "qr": "https://x/#pair", "urls": ["wss://a.trycloudflare.com/link"], "relays": [] });
        assert_eq!(code_card(&up), CodeCard::Code { note: "It works once, within 10 minutes." });
        assert_eq!(code_card(&serde_json::json!({ "error": "no" })), CodeCard::Failed("no".into()));
    }

    #[test]
    fn a_pairing_that_ends_while_the_tunnel_starts_says_why_and_a_shown_code_stays() {
        assert_eq!(pairing_ended(Err("no engine".into()), None).as_deref(), Some("no engine"));
        assert_eq!(pairing_ended(Ok(()), None).as_deref(), Some("The engine gave no code."));
        // only "Starting the tunnel…" was on screen: it doesn't stay there for good
        assert_eq!(pairing_ended(Err("killed".into()), Some(true)).as_deref(), Some("killed"));
        assert!(pairing_ended(Ok(()), Some(true)).is_some_and(|w| w.contains("before the tunnel came up")));
        // a code the phone can use stays
        assert_eq!(pairing_ended(Err("killed".into()), Some(false)), None);
        assert_eq!(pairing_ended(Ok(()), Some(false)), None);
    }

    #[test]
    fn the_typed_code_is_split_the_way_the_app_shows_it() {
        let v = serde_json::json!({ "short": { "id": "ZS5C3EPG", "code": "801356" } });
        assert_eq!(short_code(&v), Some(("ZS5C-3EPG".to_string(), "801 356".to_string())));
        assert_eq!(short_code(&serde_json::json!({})), None);
    }
}
