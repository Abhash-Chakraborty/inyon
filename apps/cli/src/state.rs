//! The engine's state files in ~/.inyon/node, read directly so `inyon`, `phones` and `doctor`
//! answer without starting it. The engine is the only writer; link.json is the one exception,
//! which setup writes before the link's first start.

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::paths::node_dir;

/// A paired phone, as phones.json keeps it under the phone's key.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Phone {
    pub name: String,
    #[serde(rename = "pairedAt", default)]
    pub paired_at: f64,
    #[serde(rename = "lastSeen", default, skip_serializing_if = "Option::is_none")]
    pub last_seen: Option<f64>,
}

/// What the running link writes: its addresses, pid and version.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct LinkState {
    #[serde(default)]
    pub urls: Vec<String>,
    #[serde(default)]
    pub relays: Vec<String>,
    #[serde(rename = "updatedAt", default)]
    pub updated_at: f64,
    #[serde(default)]
    pub pid: Option<u32>,
    /// missing from links before `tether-node update` existed
    #[serde(default)]
    pub version: Option<String>,
}

/// The link's settings (link.json); what's missing takes the engine's default.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct LinkConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relays: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tunnel: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lan: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vpn: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub urls: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct Identity {
    #[serde(default)]
    pub id: Option<String>,
}

/// What a started copy writes with its pid and version: state.json (the link), node.json, hub.json.
#[derive(Debug, Clone, Deserialize, Default, PartialEq)]
pub struct Running {
    #[serde(default)]
    pub pid: Option<u32>,
    #[serde(default)]
    pub version: Option<String>,
}

fn file(name: &str) -> PathBuf {
    node_dir().join(name)
}

fn read_json<T: for<'de> Deserialize<'de>>(name: &str) -> Option<T> {
    let text = fs::read_to_string(file(name)).ok()?;
    serde_json::from_str(&text).ok()
}

pub fn identity() -> Option<Identity> {
    read_json("identity.json")
}

pub fn link_config() -> LinkConfig {
    read_json("link.json").unwrap_or_default()
}

pub fn link_state() -> Option<LinkState> {
    read_json("state.json")
}

pub fn phones() -> BTreeMap<String, Phone> {
    read_json("phones.json").unwrap_or_default()
}

/// Whether a pairing code is still open (pairing.json, which the engine removes once used).
pub fn pairing_open() -> bool {
    #[derive(Deserialize)]
    struct Pairing {
        #[serde(default)]
        expires: f64,
    }
    read_json::<Pairing>("pairing.json").is_some_and(|p| p.expires > now_ms())
}

/// Written whole or not at all, readable only by this user.
pub fn write_json<T: Serialize>(name: &str, value: &T) -> std::io::Result<()> {
    let dir = crate::paths::ensure_node_dir()?;
    let tmp = dir.join(format!("{name}.{}.tmp", std::process::id()));
    let text = serde_json::to_string_pretty(value).map_err(std::io::Error::other)?;
    fs::write(&tmp, text)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600));
    }
    fs::rename(&tmp, dir.join(name))
}

pub fn now_ms() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0)
}

/// A moment in milliseconds since 1970 as a local-looking date and time (UTC; the engine's
/// records carry no zone).
pub fn format_time(ms: f64) -> String {
    let secs = (ms / 1000.0) as i64;
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02} {:02}:{:02}", rem / 3600, (rem % 3600) / 60)
}

pub fn format_date(ms: f64) -> String {
    format_time(ms)[..10].to_string()
}

/// Howard Hinnant's days-to-civil, so no date crate is needed.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates_from_milliseconds() {
        assert_eq!(format_time(0.0), "1970-01-01 00:00");
        assert_eq!(format_time(1_760_313_600_000.0), "2025-10-13 00:00");
        assert_eq!(format_date(951_782_400_000.0), "2000-02-29");
    }

    #[test]
    fn phones_parse_the_engines_shape() {
        let text = r#"{"abc123":{"name":"Pixel","pairedAt":1700000000000,"lastSeen":1700000500000},"def":{"name":"iPhone","pairedAt":1700000000000}}"#;
        let all: BTreeMap<String, Phone> = serde_json::from_str(text).unwrap();
        assert_eq!(all["abc123"].name, "Pixel");
        assert_eq!(all["def"].last_seen, None);
    }
}
