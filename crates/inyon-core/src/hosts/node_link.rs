//! Port of hosts/node-link.ts.
//!
//! Machines running `inyon` keep one outbound WebSocket to the hub. Commands travel over it as
//! JSON frames, so the machine never has to accept incoming connections.
//!
//!   hub → node   { ..., id } with op 'exec' | 'stream' | 'pty' | 'write' | 'resize' | 'kill'
//!   node → hub   { id, type: 'exit' | 'line' | 'data' | 'error', ... }
//!
//! The registry lives on the core's thread, one per thread as the TS module is one per process.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use indexmap::IndexMap;
use serde_json::{json, Map, Value};

use super::http_error::{HubError, HubResult};
use crate::clock::now_ms;

/// The hub's WebSocket from a node, or the phone's encrypted channel to a laptop.
pub trait NodeSocket {
    fn send(&self, data: &str);
    fn close(&self, code: u16, reason: &str);
}

pub type Socket = Rc<dyn NodeSocket>;
type Handler = Rc<RefCell<dyn FnMut(&Value)>>;

/// An operation stays with the socket it started on; a newer connection doesn't inherit it.
struct Op {
    ws: Socket,
    on_msg: Handler,
}

/// What a node said about itself.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct NodeInfo {
    pub version: Option<String>,
    pub os: Option<String>,
    pub connected_at: u64,
}

type Listener = Rc<dyn Fn(&str, bool)>;

#[derive(Default)]
struct NodeLinks {
    sockets: HashMap<String, Socket>,
    errors: HashMap<String, String>,
    // in the order they started, as the TS Map keeps them
    handlers: IndexMap<String, Op>,
    seq: u64,
    listeners: Vec<Listener>,
    info: HashMap<String, NodeInfo>,
}

thread_local! {
    static LINKS: RefCell<NodeLinks> = RefCell::new(NodeLinks::default());
}

fn with<R>(f: impl FnOnce(&mut NodeLinks) -> R) -> R {
    LINKS.with(|l| f(&mut l.borrow_mut()))
}

fn notify(host_id: &str, up: bool) {
    for l in with(|n| n.listeners.clone()) {
        l(host_id, up);
    }
}

pub fn on_change(f: impl Fn(&str, bool) + 'static) {
    with(|n| n.listeners.push(Rc::new(f)));
}

pub fn info(host_id: &str) -> Option<NodeInfo> {
    with(|n| n.info.get(host_id).cloned())
}

pub fn attach(host_id: &str, ws: Socket) {
    let old = with(|n| {
        n.errors.remove(host_id);
        n.sockets.get(host_id).cloned()
    });
    if let Some(old) = old.filter(|o| !Rc::ptr_eq(o, &ws)) {
        // its close callback comes later and finds the new socket in place, so end its work now
        fail_ops(host_id, &old);
        old.close(4000, "replaced by a newer connection");
    }
    with(|n| {
        n.sockets.insert(host_id.to_owned(), ws);
        n.info.insert(host_id.to_owned(), NodeInfo { version: None, os: None, connected_at: now_ms() });
    });
    notify(host_id, true);
}

pub fn detach(host_id: &str, ws: &Socket) {
    let mine = with(|n| {
        if n.sockets.get(host_id).is_some_and(|s| Rc::ptr_eq(s, ws)) {
            n.sockets.remove(host_id);
            true
        } else {
            false
        }
    });
    if !mine {
        return;
    }
    fail_ops(host_id, ws);
    notify(host_id, false);
}

/// Fails everything still waiting on this socket.
fn fail_ops(host_id: &str, ws: &Socket) {
    let prefix = format!("{host_id}:");
    let failed: Vec<Handler> = with(|n| {
        let keys: Vec<String> = n.handlers.iter().filter(|(k, op)| Rc::ptr_eq(&op.ws, ws) && k.starts_with(&prefix)).map(|(k, _)| k.clone()).collect();
        keys.into_iter().filter_map(|k| n.handlers.shift_remove(&k).map(|op| op.on_msg)).collect()
    });
    let msg = json!({ "type": "error", "error": "The machine disconnected" });
    for h in failed {
        if let Ok(mut h) = h.try_borrow_mut() {
            h(&msg);
        }
    }
}

/// Couldn't connect (the phone's side): say why until it does.
pub fn fail(host_id: &str, error: &str) {
    let changed = with(|n| {
        if n.sockets.contains_key(host_id) || n.errors.get(host_id).map(String::as_str) == Some(error) {
            return false;
        }
        n.errors.insert(host_id.to_owned(), error.to_owned());
        true
    });
    if changed {
        notify(host_id, false);
    }
}

pub fn clear_error(host_id: &str) {
    with(|n| n.errors.remove(host_id));
}

/// Why the machine isn't connected, when something more specific than "waiting" is known.
pub fn why(host_id: &str) -> Option<String> {
    with(|n| n.errors.get(host_id).cloned())
}

pub fn is_up(host_id: &str) -> bool {
    with(|n| n.sockets.contains_key(host_id))
}

pub fn disconnect(host_id: &str) {
    if let Some(ws) = with(|n| n.sockets.get(host_id).cloned()) {
        ws.close(4001, "removed from Inyon");
    }
}

pub fn message(host_id: &str, raw: &str) {
    if let Some(msg) = crate::js::json::parse(raw) {
        receive(host_id, &msg);
    }
}

pub fn receive(host_id: &str, msg: &Value) {
    use crate::js::json::Js;
    let m = Some(msg);
    if m.at("type").str() == Some("hello") {
        let s = |k: &str| m.at(k).str().map(str::to_owned);
        with(|n| n.info.insert(host_id.to_owned(), NodeInfo { version: s("version"), os: s("os"), connected_at: now_ms() }));
        return;
    }
    // `${hostId}:${msg.id}`: a number or a missing id is written as JavaScript would
    let id = match m.at("id") {
        Some(Value::String(s)) => s.clone(),
        None => "undefined".into(),
        Some(v) => crate::js::json::value_string(v),
    };
    let handler = with(|n| n.handlers.get(&format!("{host_id}:{id}")).map(|op| op.on_msg.clone()));
    if let Some(h) = handler {
        // a handler that is already running (a frame that arrives from inside it) is not entered twice
        if let Ok(mut h) = h.try_borrow_mut() {
            h(msg);
        }
    }
}

/// An operation started on a node: what's sent for it goes only to the socket it started on.
#[derive(Clone)]
pub struct NodeOp {
    pub id: String,
    host_id: String,
    ws: Socket,
}

impl NodeOp {
    /// only to the socket it started on, and only while that one is still the machine's
    pub fn send(&self, extra: Value) {
        let current = with(|n| n.sockets.get(&self.host_id).is_some_and(|s| Rc::ptr_eq(s, &self.ws)));
        if current {
            self.ws.send(&frame(extra, &self.id));
        }
    }

    pub fn done(&self) {
        with(|n| n.handlers.shift_remove(&format!("{}:{}", self.host_id, self.id)));
    }
}

/// `JSON.stringify({ ...op, id })`
fn frame(op: Value, id: &str) -> String {
    let mut m = match op {
        Value::Object(m) => m,
        _ => Map::new(),
    };
    m.insert("id".into(), Value::String(id.to_owned()));
    crate::js::stringify(&Value::Object(m))
}

/// Starts an operation; `on_msg` receives its frames until you call the returned `done`.
pub fn start(host_id: &str, op: Value, on_msg: impl FnMut(&Value) + 'static) -> HubResult<NodeOp> {
    // the hub is fine, the machine isn't there: 503, which the app shows and may retry
    let (ws, id) = with(|n| {
        let ws = n.sockets.get(host_id).cloned().ok_or_else(|| HubError::http(503, "This machine is not connected. Is inyon running on it?"))?;
        n.seq += 1;
        let id = n.seq.to_string();
        let handler: Handler = Rc::new(RefCell::new(on_msg));
        n.handlers.insert(format!("{host_id}:{id}"), Op { ws: ws.clone(), on_msg: handler });
        Ok::<_, HubError>((ws, id))
    })?;
    ws.send(&frame(op, &id));
    Ok(NodeOp { id, host_id: host_id.to_owned(), ws })
}

#[cfg(test)]
#[path = "node_link_tests.rs"]
mod tests;
