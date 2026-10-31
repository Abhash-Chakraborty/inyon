//! What the app holds from the hub's `/ws` (protocol v1), kept thin on purpose: the machines from
//! the last `overview`, whether that has arrived, and whether the socket is up. The chat state
//! will come from crates/inyon-chat-core; this only reads the messages the overview needs.

use inyon_protocol::{ClientMsg, HostState};
use serde::Deserialize;

/// A message from the hub, as far as this app reads them.
#[derive(Debug, PartialEq)]
pub enum Incoming {
    Overview(Vec<HostState>),
    Pong,
    /// a message this screen doesn't follow (chat, terminal, alerts)
    Other,
}

#[derive(Deserialize)]
struct Tag {
    t: String,
}

#[derive(Deserialize)]
struct Overview {
    hosts: Vec<HostState>,
}

/// Reads one frame. Only the `t` is read first, so a chat or terminal frame costs a few bytes of
/// parsing and a newer hub's message types pass as [`Incoming::Other`].
pub fn parse(text: &str) -> Result<Incoming, String> {
    let tag: Tag = serde_json::from_str(text).map_err(|e| e.to_string())?;
    Ok(match tag.t.as_str() {
        "overview" => Incoming::Overview(serde_json::from_str::<Overview>(text).map_err(|e| e.to_string())?.hosts),
        "pong" => Incoming::Pong,
        _ => Incoming::Other,
    })
}

pub fn wire(msg: &ClientMsg) -> String {
    serde_json::to_string(msg).expect("client messages serialise")
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Hub {
    pub hosts: Vec<HostState>,
    /// the first overview arrived (until then the screen shows placeholders)
    pub loaded: bool,
    pub connected: bool,
}

impl Hub {
    /// The machines in a frame, when it is an overview that changes what the screen shows. A frame
    /// this build can't read keeps the last good overview on screen.
    pub fn changed_hosts(&self, text: &str) -> Option<Vec<HostState>> {
        match parse(text) {
            Ok(Incoming::Overview(hosts)) if !self.loaded || self.hosts != hosts => Some(hosts),
            _ => None,
        }
    }

    pub fn set_hosts(&mut self, hosts: Vec<HostState>) {
        self.hosts = hosts;
        self.loaded = true;
    }

    /// Takes one frame in; true when what the screen shows changed.
    #[cfg(test)]
    pub fn apply(&mut self, text: &str) -> bool {
        match self.changed_hosts(text) {
            Some(hosts) => {
                self.set_hosts(hosts);
                true
            }
            None => false,
        }
    }

    pub fn set_connected(&mut self, up: bool) -> bool {
        let changed = self.connected != up;
        self.connected = up;
        changed
    }
}

/// How long to wait before reconnecting: capped exponential backoff with full jitter, as
/// packages/protocol/src/backoff.ts. `random` is in [0, 1).
pub fn backoff(attempt: u32, base_ms: f64, cap_ms: f64, random: f64) -> f64 {
    (random * cap_ms.min(base_ms * 2f64.powi(attempt.min(30) as i32))).floor()
}

/// How long a connection has to stay up before its backoff starts from the first step again.
pub const STABLE_MS: f64 = 30_000.0;

/// The next attempt number after a connection that was up since `opened_at` closed.
pub fn attempt_after(attempt: u32, opened_at: Option<f64>, now: f64) -> u32 {
    match opened_at {
        Some(t) if now - t >= STABLE_MS => 0,
        _ => attempt,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn overview() -> String {
        json!({ "t": "overview", "hosts": [{ "config": { "id": "box", "name": "studio", "kind": "local" }, "status": "online",
            "integration": "installed", "tmux": "ok", "agents": ["claude"], "sessions": [], "updatedAt": 1 }] })
        .to_string()
    }

    #[test]
    fn an_overview_replaces_the_machines() {
        let mut hub = Hub::default();
        assert!(hub.apply(&overview()));
        assert!(hub.loaded);
        assert_eq!(hub.hosts[0].config.name, "studio");
        // the same overview again changes nothing on screen
        assert!(!hub.apply(&overview()));
        assert!(hub.apply(r#"{"t":"overview","hosts":[]}"#));
        assert!(hub.hosts.is_empty() && hub.loaded);
    }

    #[test]
    fn other_frames_and_broken_ones_keep_the_last_overview() {
        let mut hub = Hub::default();
        hub.apply(&overview());
        for frame in
            [r#"{"t":"pong"}"#, r#"{"t":"chat.live","key":"box:%1","items":[]}"#, r#"{"t":"something.new","x":1}"#, "not json", r#"{"t":"overview","hosts":[{"config":{}}]}"#]
        {
            assert!(!hub.apply(frame), "{frame}");
            assert_eq!(hub.hosts.len(), 1, "{frame}");
        }
        assert_eq!(parse(r#"{"t":"pong"}"#), Ok(Incoming::Pong));
    }

    #[test]
    fn messages_go_out_as_the_web_app_sends_them() {
        assert_eq!(wire(&ClientMsg::SubOverview), r#"{"t":"sub.overview"}"#);
        assert_eq!(wire(&ClientMsg::Ping), r#"{"t":"ping"}"#);
        assert_eq!(wire(&ClientMsg::Quiet { on: true }), r#"{"t":"quiet","on":true}"#);
    }

    #[test]
    fn the_connection_flag_reports_changes() {
        let mut hub = Hub::default();
        assert!(hub.set_connected(true));
        assert!(!hub.set_connected(true));
        assert!(hub.set_connected(false));
    }

    #[test]
    fn reconnects_back_off_until_a_connection_holds() {
        assert_eq!(backoff(0, 400.0, 8000.0, 0.999), 399.0);
        assert_eq!(backoff(3, 400.0, 8000.0, 0.5), 1600.0);
        assert_eq!(backoff(10, 400.0, 8000.0, 0.5), 4000.0);
        assert_eq!(backoff(99, 400.0, 8000.0, 0.0), 0.0);
        assert_eq!(attempt_after(5, Some(0.0), 40_000.0), 0);
        assert_eq!(attempt_after(5, Some(0.0), 1_000.0), 5);
        assert_eq!(attempt_after(5, None, 1_000.0), 5);
    }
}
