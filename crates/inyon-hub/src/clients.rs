//! The app's live connections (core.ts's WebSocket clients): what each one watches, its open
//! terminals, and the registry's events sent on to them.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;

use indexmap::IndexSet;
use inyon_core::claude::last_reply::last_reply;
use inyon_core::claude::watcher::{watchers, Sub, Subscriber};
use inyon_core::features::companion;
use inyon_core::hosts::host::PtyHandle;
use inyon_core::hosts::registry::{registry, NotifyKind as Kind, RegistryEvent};
use inyon_core::platform::rt::{set_timeout, spawn};
use inyon_core::terminal::terminal::open_terminal;
use inyon_protocol::{NotifyKind, ServerMsg};
use serde_json::Value;

/// One connected app; it hears updates once it's in the list (see `add`).
pub struct Client {
    overview: Cell<bool>,
    chats: RefCell<IndexSet<String>>,
    terms: RefCell<HashMap<String, Rc<PtyHandle>>>,
    out: Box<dyn Fn(&ServerMsg)>,
}

impl Subscriber for Client {
    fn send(&self, msg: &ServerMsg) {
        (self.out)(msg)
    }
}

pub type ClientRef = Rc<Client>;
type Sink = Rc<dyn Fn(&ServerMsg)>;
type Off = Rc<RefCell<Option<Box<dyn Fn()>>>>;

thread_local! {
    static CLIENTS: RefCell<Vec<ClientRef>> = const { RefCell::new(Vec::new()) };
    static SINKS: RefCell<Vec<Sink>> = const { RefCell::new(Vec::new()) };
}

/// `JSON.stringify(msg)` for a message to the app.
pub fn wire(msg: &ServerMsg) -> String {
    serde_json::to_value(msg).map(|v| inyon_core::js::stringify(&v)).unwrap_or_default()
}

pub fn new_client(out: impl Fn(&ServerMsg) + 'static) -> ClientRef {
    Rc::new(Client { overview: Cell::new(false), chats: RefCell::new(IndexSet::new()), terms: RefCell::new(HashMap::new()), out: Box::new(out) })
}

pub fn add(c: &ClientRef) {
    CLIENTS.with(|l| l.borrow_mut().push(c.clone()));
}

fn listed(c: &ClientRef) -> bool {
    CLIENTS.with(|l| l.borrow().iter().any(|x| Rc::ptr_eq(x, c)))
}

fn all() -> Vec<ClientRef> {
    CLIENTS.with(|l| l.borrow().clone())
}

fn as_sub(c: &ClientRef) -> Sub {
    c.clone()
}

/// Others that hear each notification with its final text: the hub's Web Push.
pub fn on_notice(f: impl Fn(&ServerMsg) + 'static) {
    SINKS.with(|s| s.borrow_mut().push(Rc::new(f)));
}

/// Sends the registry's overview and notifications on to the apps (core.ts's `registry.on`).
pub fn listen() {
    let _ = registry().on(|e| match e {
        RegistryEvent::Overview => {
            let msg = ServerMsg::Overview { hosts: registry().overview() };
            for c in all() {
                if c.overview.get() {
                    c.send(&msg);
                }
            }
        }
        RegistryEvent::Notify { host, pane, kind, title, body, agent } => {
            let sent = Rc::new(Cell::new(false));
            let n = {
                let (host, pane, title, agent, kind) = (host.clone(), pane.clone(), title.clone(), *agent, *kind);
                let sent = sent.clone();
                Rc::new(move |body: String| {
                    if sent.replace(true) {
                        return;
                    }
                    let kind = match kind {
                        Kind::Waiting => NotifyKind::Waiting,
                        Kind::Done => NotifyKind::Done,
                        Kind::Offline => NotifyKind::Offline,
                        Kind::Online => NotifyKind::Online,
                    };
                    let msg = ServerMsg::Notify { host: host.clone(), pane: pane.clone(), kind, title: title.clone(), body, agent };
                    for c in all() {
                        c.send(&msg);
                    }
                    for sink in SINKS.with(|s| s.borrow().clone()) {
                        sink(&msg);
                    }
                })
            };
            if *kind != Kind::Done {
                return n(body.clone());
            }
            // "Claude finished" says little: show the start of its reply instead, if it's quick to find
            let (late, b) = (n.clone(), body.clone());
            let _timer = set_timeout(2500, move || late(b));
            let (host, pane, body) = (host.clone(), pane.clone(), body.clone());
            spawn(async move {
                match last_reply(&host, &pane).await {
                    Ok(Some(reply)) if !reply.is_empty() => n(reply),
                    _ => n(body),
                }
            });
        }
        // the companion agent's reply goes to every app and companion app (companion_frame picks)
        RegistryEvent::CompanionDone { host, pane, failure } => {
            let (host, pane, failure) = (host.clone(), pane.clone(), failure.clone());
            spawn(async move {
                let msg = companion::reply(&host, &pane, failure).await;
                for c in all() {
                    c.send(&msg);
                }
                // a phone with the app closed hears it as a notification
                let ServerMsg::CompanionReply { text, .. } = &msg else { return };
                let body = inyon_core::claude::last_reply::plain_line(text, 180);
                let notice = ServerMsg::Notify { host, pane, kind: NotifyKind::Done, title: "Companion".into(), body, agent: companion::agent() };
                for sink in SINKS.with(|s| s.borrow().clone()) {
                    sink(&notice);
                }
            });
        }
        _ => {}
    });
}

/// chats one app can watch at once
const MAX_CHATS: usize = 64;

/// Runs `f` once the machine reports the pane, now if it already does; gives up after 30 s.
fn when_pane(host: &str, pane: &str, f: impl FnOnce() + 'static) {
    if registry().find_pane(host, pane).is_some() {
        return f();
    }
    let f = Rc::new(RefCell::new(Some(f)));
    let off: Off = Rc::new(RefCell::new(None));
    let timer: Rc<RefCell<Option<inyon_core::platform::rt::Timer>>> = Rc::new(RefCell::new(None));
    let (h, p, o, t) = (host.to_owned(), pane.to_owned(), off.clone(), timer.clone());
    let unlisten = registry().on(move |e| {
        if *e != RegistryEvent::Overview || registry().find_pane(&h, &p).is_none() {
            return;
        }
        if let Some(off) = o.borrow_mut().take() {
            off();
        }
        if let Some(t) = t.borrow_mut().take() {
            t.clear();
        }
        if let Some(f) = f.borrow_mut().take() {
            f();
        }
    });
    *off.borrow_mut() = Some(Box::new(unlisten));
    let o = off.clone();
    *timer.borrow_mut() = Some(set_timeout(30_000, move || {
        if let Some(off) = o.borrow_mut().take() {
            off();
        }
    }));
}

fn s<'a>(m: &'a Value, k: &str) -> Option<&'a str> {
    m.get(k).and_then(Value::as_str)
}

/// `String(m.k)` for keys the TS uses unchecked in a template (`${m.host}:${m.pane}`).
fn raw(m: &Value, k: &str) -> String {
    crate::http::str_raw(m.get(k))
}

/// One message from an app (raw JSON text).
pub fn client_message(c: &ClientRef, text: &str) {
    let Some(m) = inyon_core::js::json::parse(text) else { return };
    let Some(t) = m.get("t").and_then(Value::as_str) else { return };
    match t {
        "ping" => c.send(&ServerMsg::Pong),
        "sub.overview" => {
            c.overview.set(true);
            c.send(&ServerMsg::Overview { hosts: registry().overview() });
        }
        "sub.chat" => {
            let key = format!("{}:{}", raw(&m, "host"), raw(&m, "pane"));
            let host = raw(&m, "host");
            let pane_ok = s(&m, "pane").is_some_and(|p| inyon_core::re!(r"^%\d+(\.\d+)?$").is_match(p));
            if c.chats.borrow().contains(&key) || registry().get(&host).is_none() || !pane_ok || c.chats.borrow().len() >= MAX_CHATS {
                return;
            }
            c.chats.borrow_mut().insert(key.clone());
            let pane = s(&m, "pane").unwrap_or_default().to_owned();
            // only a pane the machine has gets a watcher; one just launched may show up a moment later
            let (c2, h2, p2) = (c.clone(), host.clone(), pane.clone());
            when_pane(&host, &pane, move || {
                if listed(&c2) && c2.chats.borrow().contains(&key) {
                    watchers().get(&h2, &p2).subscribe(as_sub(&c2));
                }
            });
        }
        "unsub.chat" => {
            let key = format!("{}:{}", raw(&m, "host"), raw(&m, "pane"));
            if !c.chats.borrow_mut().shift_remove(&key) {
                return;
            }
            if let Some(w) = watchers().peek(&raw(&m, "host"), &raw(&m, "pane")) {
                w.unsubscribe(&as_sub(c));
            }
        }
        "chat.more" => {
            if let Some(w) = watchers().peek(&raw(&m, "host"), &raw(&m, "pane")) {
                let before = crate::http::js_number(m.get("before"));
                let sub = as_sub(c);
                spawn(async move { w.more(&sub, if before.is_finite() { before as i64 } else { i64::MAX }).await });
            }
        }
        "draft" => {
            let Some(text) = s(&m, "text") else { return };
            if text.encode_utf16().count() > 100_000 || registry().get(&raw(&m, "host")).is_none() {
                return;
            }
            // only for a chat this client watches: a bare draft must not start a watcher nobody stops
            if let Some(w) = watchers().peek(&raw(&m, "host"), &raw(&m, "pane")) {
                w.draft_from_app(text, Some(&as_sub(c)));
            }
        }
        "term.open" => {
            let id = raw(&m, "id");
            if c.terms.borrow().contains_key(&id) || c.terms.borrow().len() >= 8 {
                return;
            }
            let num = |k: &str| crate::http::js_number(m.get(k));
            let dim = |x: f64| if x.is_finite() && x > 0.0 { x.min(u16::MAX as f64) as u16 } else { 0 };
            // one streaming decoder per terminal so multi-byte characters split across chunks survive
            let decoder = RefCell::new(Utf8Stream::default());
            let (weak, tid) = (Rc::downgrade(c), id.clone());
            let opened = open_terminal(&raw(&m, "host"), &raw(&m, "pane"), dim(num("cols")), dim(num("rows")), move |d: Vec<u8>| {
                if let Some(c) = weak.upgrade() {
                    let text = decoder.borrow_mut().decode(&d);
                    c.send(&ServerMsg::TermData { id: tid.clone(), d: text });
                }
            });
            match opened {
                Ok(term) => {
                    let term = Rc::new(term);
                    c.terms.borrow_mut().insert(id.clone(), term.clone());
                    let (c2, exited) = (c.clone(), term.exited.clone());
                    spawn(async move {
                        exited.wait().await;
                        let mine = c2.terms.borrow().get(&id).is_some_and(|t| Rc::ptr_eq(t, &term));
                        if mine {
                            c2.terms.borrow_mut().remove(&id);
                            c2.send(&ServerMsg::TermExit { id, reason: None });
                        }
                    });
                }
                Err(e) => c.send(&ServerMsg::TermExit { id, reason: Some(e.message) }),
            }
        }
        "term.in" => {
            let term = c.terms.borrow().get(&raw(&m, "id")).cloned();
            if let Some(t) = term {
                t.write(&raw(&m, "d"));
            }
        }
        "term.resize" => {
            let term = c.terms.borrow().get(&raw(&m, "id")).cloned();
            if let Some(t) = term {
                let n = |k: &str| crate::http::to_int32(crate::http::js_number(m.get(k)));
                let clamp = |x: i32, min: i32| x.max(min).min(u16::MAX as i32) as u16;
                t.resize(clamp(n("cols"), 10), clamp(n("rows"), 4));
            }
        }
        "term.close" => {
            let t = c.terms.borrow_mut().remove(&raw(&m, "id"));
            if let Some(t) = t {
                t.kill();
            }
        }
        _ => {}
    }
}

/// The app went away: stop everything it was watching.
pub fn close_client(c: &ClientRef) {
    CLIENTS.with(|l| l.borrow_mut().retain(|x| !Rc::ptr_eq(x, c)));
    let chats: Vec<String> = c.chats.borrow().iter().cloned().collect();
    for key in chats {
        let (host, pane) = key.split_once(':').unwrap_or((&key, ""));
        if let Some(w) = watchers().peek(host, pane) {
            w.unsubscribe(&as_sub(c));
        }
    }
    let terms: Vec<Rc<PtyHandle>> = c.terms.borrow().values().cloned().collect();
    for t in terms {
        t.kill();
    }
}

/// `new TextDecoder().decode(chunk, { stream: true })`: bad bytes become U+FFFD, and a character
/// cut off at the end of a chunk waits for the rest.
#[derive(Default)]
pub struct Utf8Stream {
    pending: Vec<u8>,
}

impl Utf8Stream {
    pub fn decode(&mut self, chunk: &[u8]) -> String {
        let mut bytes = std::mem::take(&mut self.pending);
        bytes.extend_from_slice(chunk);
        // keep an incomplete sequence at the very end for the next chunk
        let mut cut = bytes.len();
        for back in 1..=3.min(bytes.len()) {
            let b = bytes[bytes.len() - back];
            if b & 0xC0 == 0x80 {
                continue;
            }
            let need = if (0xF0..=0xF4).contains(&b) {
                4
            } else if b >= 0xE0 {
                3
            } else if (0xC2..0xE0).contains(&b) {
                2
            } else {
                1
            };
            if need > back && b >= 0xC2 && std::str::from_utf8(&bytes[bytes.len() - back..]).is_err() && valid_prefix(&bytes[bytes.len() - back..]) {
                cut = bytes.len() - back;
            }
            break;
        }
        self.pending = bytes.split_off(cut);
        String::from_utf8_lossy(&bytes).into_owned()
    }
}

/// Whether `b` could still become one valid character with more bytes.
fn valid_prefix(b: &[u8]) -> bool {
    let first = b[0];
    let second_ok = |s: u8| match first {
        0xE0 => (0xA0..=0xBF).contains(&s),
        0xED => (0x80..=0x9F).contains(&s),
        0xF0 => (0x90..=0xBF).contains(&s),
        0xF4 => (0x80..=0x8F).contains(&s),
        _ => (0x80..=0xBF).contains(&s),
    };
    b.len() < 2 || second_ok(b[1]) && b[2..].iter().all(|x| x & 0xC0 == 0x80)
}

#[cfg(test)]
mod tests {
    use super::*;

    // caches.test.ts
    #[test]
    fn watching_a_chat_starts_a_watcher_only_for_a_pane_the_machine_has() {
        crate::test_util::block(async {
            let state: inyon_protocol::HostState = serde_json::from_value(serde_json::json!({
                "config": { "id": "h", "name": "h", "kind": "ssh" }, "status": "online", "integration": "unknown", "tmux": "ok", "agents": [], "sessions": [], "updatedAt": 0,
            }))
            .unwrap();
            let rt = Rc::new(RefCell::new(inyon_core::hosts::registry::HostRuntime::new(inyon_core::hosts::host::Host::new(state.config.clone()), state)));
            rt.borrow_mut().hold_polls();
            registry().insert_runtime("h", rt.clone());
            let c = new_client(|_| {});
            add(&c);
            client_message(&c, r#"{"t":"sub.chat","host":"h","pane":"%7"}"#);
            client_message(&c, r#"{"t":"sub.chat","host":"h","pane":"not-a-pane"}"#);
            assert!(watchers().peek("h", "%7").is_none());
            assert_eq!(c.chats.borrow().iter().collect::<Vec<_>>(), ["h:%7"]);
            // the pane shows up (a session that was just launched): now it's watched
            rt.borrow_mut().state.sessions = serde_json::from_value(
                serde_json::json!([{ "id": "$1", "name": "work", "attached": 0, "windows": [{ "id": "@1", "index": 0, "name": "w", "active": true, "activity": 0, "panes": [
                { "id": "%7", "index": 0, "active": true, "command": "claude", "cwd": "/w", "title": "claude", "width": 100, "height": 30, "dead": false }
            ] }] }]),
            )
            .unwrap();
            registry().emit_for_test(RegistryEvent::Overview);
            inyon_core::platform::rt::sleep(300).await;
            assert_eq!(watchers().peek("h", "%7").expect("a watcher for h/%7").subscribers(), 1);
            close_client(&c);
        });
    }

    #[test]
    fn a_character_split_across_chunks_comes_out_whole() {
        let mut d = Utf8Stream::default();
        let s = "aé€😀".as_bytes();
        let mut out = String::new();
        for b in s {
            out += &d.decode(&[*b]);
        }
        assert_eq!(out, "aé€😀");
        assert_eq!(Utf8Stream::default().decode(b"\xffok"), "\u{fffd}ok");
        let mut d = Utf8Stream::default();
        assert_eq!(d.decode(b"x\xe2\x82"), "x");
        assert_eq!(d.decode(b"\xacy"), "€y");
    }
}
