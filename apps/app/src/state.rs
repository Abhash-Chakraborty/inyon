//! What the app holds from the hub's `/ws2` (protocol v2, see inyon-protocol's `v2.md`): the
//! machines from the `overview` stream, each open chat from its own stream, and whether the
//! socket is up. Frames go through chat-core (`v2::decode`, `Overview2`, `Chat::apply2`), which
//! turns them into the same overview and chat rows the v1 messages build.

use std::collections::HashMap;

use inyon_chat_core::v2::{decode, Overview2};
use inyon_chat_core::{Chat, Context, Store};
use inyon_protocol::v2::{Zip, OVERVIEW};
use inyon_protocol::{ClientMsg, ClientMsg2, HostState, ServerMsg, ServerMsg2};

use crate::list::VList;

/// A message from the hub, as far as this app reads them.
#[derive(Debug, PartialEq)]
#[allow(clippy::large_enum_variant)]
pub enum Incoming {
    /// a stream's frame (the overview, a chat) or the answer to `hello`
    Frame(ServerMsg2),
    /// a message from outside the streams, as v1 sends it (`term.data`, `notify`, `pong`): its `t`
    /// and its text, for the screen that reads that kind to parse (so the app only carries the
    /// readers it uses)
    Hub { t: String, text: String },
    /// one this build can't read (a newer hub's)
    Other,
}

/// Reads one WebSocket message, text or compressed binary.
pub fn read(text: Option<&str>, binary: Option<&[u8]>) -> Incoming {
    match decode(text, binary) {
        Ok(f) => Incoming::Frame(f),
        Err(Some(text)) => match serde_json::from_str::<Tag>(&text) {
            Ok(Tag { t }) => Incoming::Hub { t, text },
            Err(_) => Incoming::Other,
        },
        Err(None) => Incoming::Other,
    }
}

#[derive(serde::Deserialize)]
struct Tag {
    t: String,
}

pub fn wire(msg: &ClientMsg) -> String {
    serde_json::to_string(msg).expect("client messages serialise")
}

pub fn wire2(msg: &ClientMsg2) -> String {
    serde_json::to_string(msg).expect("client messages serialise")
}

/// The first message on a new socket: protocol 2, and large frames compressed.
pub fn hello() -> String {
    wire2(&ClientMsg2::Hello { v: 2, zip: Some(vec![Zip::DeflateRaw]) })
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Hub {
    pub hosts: Vec<HostState>,
    /// the first overview arrived (until then the screen shows placeholders)
    pub loaded: bool,
    pub connected: bool,
}

impl Hub {
    pub fn set_hosts(&mut self, hosts: Vec<HostState>) {
        self.hosts = hosts;
        self.loaded = true;
    }

    pub fn set_connected(&mut self, up: bool) -> bool {
        let changed = self.connected != up;
        self.connected = up;
        changed
    }
}

/// The overview stream as it comes in: its place in the stream, and the store that turns the
/// machines into the list the screens show. Kept out of the screens' state, so a frame that
/// changes nothing on screen redraws nothing.
#[derive(Debug, Default)]
pub struct Feed {
    overview: Overview2,
    store: Store,
}

impl Feed {
    /// An overview frame: the machines when they changed from `shown`, and a message for the hub
    /// when the stream needs bringing up to date.
    pub fn overview(&mut self, f: &ServerMsg2, shown: &Hub, now: u64) -> (Option<Vec<HostState>>, Option<ClientMsg2>) {
        let (hosts, resync) = self.overview.apply(f);
        let hosts = hosts.and_then(|hosts| {
            let ctx = Context { route: "/", terminal_view: false, visible: true, native: false, browser_notices: false };
            self.store.apply(&ServerMsg::Overview { hosts }, None, &ctx, now);
            let all = &self.store.overview.hosts;
            (!shown.loaded || shown.hosts != *all).then(|| all.clone())
        });
        (hosts, resync)
    }

    /// What to follow on a new connection: the overview from where it was left.
    pub fn sub(&self) -> ClientMsg2 {
        ClientMsg2::Sub { stream: OVERVIEW.into(), at: self.overview.cursor.at() }
    }
}

/// One open conversation: chat-core's chat and the heights its list keeps.
#[derive(Debug, Default)]
pub struct ChatEntry {
    pub chat: Chat,
    pub list: VList,
    /// on screen, so followed on every connection
    pub followed: bool,
    /// earlier messages were asked for and haven't come back
    pub loading_more: bool,
}

impl ChatEntry {
    fn splice(&mut self, splices: &[inyon_chat_core::Splice]) {
        self.list.splice(splices);
    }
}

/// The chats this app has opened, by key (`host:pane`).
#[derive(Debug, Default)]
pub struct Chats {
    pub map: HashMap<String, ChatEntry>,
}

impl Chats {
    pub fn get(&self, key: &str) -> Option<&ChatEntry> {
        self.map.get(key)
    }

    pub fn entry(&mut self, key: &str) -> &mut ChatEntry {
        self.map.entry(key.to_string()).or_default()
    }

    /// A chat stream's frame (or `more`). Returns a message for the hub when the stream needs
    /// bringing up to date; frames for a chat nobody opened are dropped.
    pub fn apply(&mut self, f: &ServerMsg2, now: u64) -> Option<ClientMsg2> {
        let key = f.stream()?;
        let e = self.map.get_mut(key)?;
        if matches!(f, ServerMsg2::More { .. }) {
            e.loading_more = false;
        }
        let applied = e.chat.apply2(f, now);
        e.splice(&applied.splices);
        applied.resync
    }

    /// Changes a chat directly: a message sent, retried or dismissed.
    pub fn patch(&mut self, key: &str, now: u64, f: impl FnOnce(&mut inyon_chat_core::ChatData)) {
        let e = self.entry(key);
        let splices = e.chat.patch(now, f);
        e.splice(&splices);
    }

    /// Time passing (a send that never landed says so after ten minutes); true when a row changed.
    pub fn tick(&mut self, key: &str, now: u64) -> bool {
        let Some(e) = self.map.get_mut(key) else { return false };
        let splices = e.chat.tick(now);
        e.splice(&splices);
        !splices.is_empty()
    }

    /// What to follow on a new connection: every open chat, from where it was left.
    pub fn subs(&self) -> Vec<ClientMsg2> {
        let mut keys: Vec<&String> = self.map.iter().filter(|(_, e)| e.followed).map(|(k, _)| k).collect();
        keys.sort();
        keys.into_iter().map(|k| ClientMsg2::Sub { stream: k.clone(), at: self.map[k].chat.position() }).collect()
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
    use inyon_protocol::StreamPos;
    use serde_json::json;

    fn host_json() -> serde_json::Value {
        json!({ "config": { "id": "box", "name": "studio", "kind": "local" }, "status": "online",
            "integration": "installed", "tmux": "ok", "agents": ["claude"], "sessions": [], "updatedAt": 1 })
    }

    fn frame(v: serde_json::Value) -> ServerMsg2 {
        match read(Some(&v.to_string()), None) {
            Incoming::Frame(f) => f,
            other => panic!("not a frame: {other:?}"),
        }
    }

    #[test]
    fn the_overview_stream_replaces_the_machines() {
        let mut feed = Feed::default();
        let mut hub = Hub::default();
        let snap = frame(json!({ "t": "snapshot", "stream": "overview", "epoch": 5, "seq": 1, "rows": { "hosts": [host_json()] } }));
        let (hosts, resync) = feed.overview(&snap, &hub, 0);
        assert_eq!(resync, None);
        hub.set_hosts(hosts.expect("the first overview"));
        assert_eq!(hub.hosts[0].config.name, "studio");
        // the same machines again change nothing on screen
        let same = frame(json!({ "t": "delta", "stream": "overview", "epoch": 5, "from": 1, "seq": 2, "replace": { "hosts": [host_json()] } }));
        assert_eq!(feed.overview(&same, &hub, 0).0, None);
        let gone = frame(json!({ "t": "delta", "stream": "overview", "epoch": 5, "from": 2, "seq": 3, "remove": { "hosts": ["box"] } }));
        assert_eq!(feed.overview(&gone, &hub, 0).0, Some(vec![]));
        // a reconnect asks for what it missed since seq 3
        assert_eq!(wire2(&feed.sub()), r#"{"t":"sub","stream":"overview","at":{"epoch":5,"seq":3}}"#);
        // a gap: the stream is asked for again from where it was
        let late = frame(json!({ "t": "delta", "stream": "overview", "epoch": 5, "from": 9, "seq": 10, "remove": { "hosts": [] } }));
        assert_eq!(feed.overview(&late, &hub, 0).1, Some(ClientMsg2::Sub { stream: "overview".into(), at: Some(StreamPos { epoch: 5, seq: 3 }) }));
    }

    #[test]
    fn other_messages_pass_as_v1_or_not_at_all() {
        assert_eq!(read(Some(r#"{"t":"pong"}"#), None), Incoming::Hub { t: "pong".into(), text: r#"{"t":"pong"}"#.into() });
        assert!(matches!(read(Some(r#"{"t":"term.data","id":"a","d":"$ "}"#), None), Incoming::Hub { t, .. } if t == "term.data"));
        assert_eq!(read(Some(r#"[1,2]"#), None), Incoming::Other);
        assert_eq!(read(Some("not json"), None), Incoming::Other);
        assert!(matches!(read(Some(r#"{"t":"hello","v":2,"zip":"deflate-raw"}"#), None), Incoming::Frame(ServerMsg2::Hello { .. })));
        // a compressed frame
        let raw = json!({ "t": "snapshot", "stream": "overview", "epoch": 1, "seq": 1, "rows": { "hosts": [] } }).to_string();
        let zipped = miniz_oxide::deflate::compress_to_vec(raw.as_bytes(), 6);
        assert!(matches!(read(None, Some(&zipped)), Incoming::Frame(ServerMsg2::Snapshot(_))));
    }

    #[test]
    fn chats_follow_their_streams_and_resume_where_they_left_off() {
        let mut chats = Chats::default();
        let snap = frame(json!({ "t": "snapshot", "stream": "box:%1", "epoch": 7, "seq": 4,
            "rows": { "items": [{ "kind": "user", "seq": 0, "uuid": "u0", "ts": "2026-10-31T12:00:00.000Z", "text": "fix the build", "images": 0 }] },
            "state": { "info": { "hostId": "box", "paneId": "%1", "running": true, "queue": [], "tasks": [], "subagents": [], "artifacts": [], "stats": { "turns": 1, "compactions": 0 } },
                "hasMore": false, "loaded": true } }));
        // nobody opened it: dropped
        assert_eq!(chats.apply(&snap, 0), None);
        assert!(chats.get("box:%1").is_none());
        chats.entry("box:%1").followed = true;
        assert_eq!(chats.apply(&snap, 0), None);
        let e = chats.get("box:%1").unwrap();
        assert_eq!(e.chat.rows().len(), 1);
        assert_eq!(e.list.len(), 1);
        assert_eq!(chats.subs(), vec![ClientMsg2::Sub { stream: "box:%1".into(), at: Some(StreamPos { epoch: 7, seq: 4 }) }]);
        // earlier messages end the wait for them
        chats.entry("box:%1").loading_more = true;
        chats.apply(&frame(json!({ "t": "more", "stream": "box:%1", "items": [], "hasMore": false })), 0);
        assert!(!chats.get("box:%1").unwrap().loading_more);
        // a message sent from here is a row until the transcript has it
        chats.patch("box:%1", 0, |c| c.pending.push(inyon_chat_core::pending::PendingMessage::new("p1", "and the tests", inyon_chat_core::pending::PendingStatus::Sending, 0)));
        assert_eq!(chats.get("box:%1").unwrap().list.len(), 2);
    }

    #[test]
    fn messages_go_out_as_v2_has_them() {
        assert_eq!(hello(), r#"{"t":"hello","v":2,"zip":["deflate-raw"]}"#);
        assert_eq!(wire2(&ClientMsg2::More { stream: "box:%1".into(), before: 40 }), r#"{"t":"more","stream":"box:%1","before":40}"#);
        assert_eq!(wire2(&ClientMsg2::Sub { stream: "box:%1".into(), at: None }), r#"{"t":"sub","stream":"box:%1"}"#);
        assert_eq!(wire(&ClientMsg::Ping), r#"{"t":"ping"}"#);
        assert_eq!(wire(&ClientMsg::Quiet { on: true }), r#"{"t":"quiet","on":true}"#);
        assert_eq!(
            wire(&ClientMsg::Draft { host: "box".into(), pane: "%1".into(), text: "  keep\n    this".into() }),
            r#"{"t":"draft","host":"box","pane":"%1","text":"  keep\n    this"}"#
        );
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
