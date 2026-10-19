//! The hub's two WebSockets: `/ws`, where the app gets live updates (core.ts's clients), and
//! `/node`, where paired machines keep their connection (hosts/node-link). The upgrade is checked
//! and answered on the core thread like any request; the socket itself then runs as a task on the
//! same thread, handing each message to the core in the order it came, and sending what the core
//! queues for it.
//!
//! As Bun's server did: a client that falls 4 MB behind is closed rather than silently losing
//! messages (the app reconnects and gets a fresh copy of what it watches), and a connection that
//! says nothing for 120 seconds is closed, with pings in between to keep a quiet one open.

use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::time::{Duration, Instant};

use axum::http::{header, HeaderValue, Method, Response, StatusCode};
use futures_util::{SinkExt, StreamExt};
use hyper_util::rt::TokioIo;
use inyon_core::clock::now_ms;
use inyon_core::hosts::node_link::{self, NodeSocket};
use inyon_core::hosts::registry::{registry, token_expired};
use inyon_core::hosts::removed_nodes::was_removed;
use inyon_core::platform::rt::sleep;
use inyon_protocol::HostKind;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::handshake::derive_accept_key;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::{CloseFrame, Role, WebSocketConfig};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;

use crate::auth::{hold_socket, is_authed, Closer};
use crate::clients::{add, client_message, close_client, new_client, wire};
use crate::http::{same, sha256, text, Req, Resp};
use crate::phones::{has_bearer, hold_phone_socket, phone_for, redeem_ticket};
use crate::server::same_origin;

/// how far behind a client may fall before it's closed
const BACKPRESSURE: usize = 4 * 1024 * 1024;
/// a connection that says nothing for this long is closed
const IDLE: Duration = Duration::from_secs(120);
/// Bun's largest message
const MAX_MESSAGE: usize = 16 * 1024 * 1024;

enum Out {
    Text(String),
    Close(u16, String),
}

/// The core's side of one socket: what it sends goes into the socket task's queue.
pub struct Socket {
    tx: mpsc::UnboundedSender<Out>,
    queued: Rc<Cell<usize>>,
    closed: Cell<bool>,
}

impl Socket {
    fn new() -> (Rc<Socket>, mpsc::UnboundedReceiver<Out>, Rc<Cell<usize>>) {
        let (tx, rx) = mpsc::unbounded_channel();
        let queued = Rc::new(Cell::new(0));
        (Rc::new(Socket { tx, queued: queued.clone(), closed: Cell::new(false) }), rx, queued)
    }

    pub fn send_text(&self, s: String) {
        if self.closed.get() {
            return;
        }
        let n = self.queued.get() + s.len();
        if n > BACKPRESSURE {
            return self.close_with(1009, "Too far behind");
        }
        self.queued.set(n);
        let _ = self.tx.send(Out::Text(s));
    }

    pub fn close_with(&self, code: u16, reason: &str) {
        if self.closed.replace(true) {
            return;
        }
        let _ = self.tx.send(Out::Close(code, reason.to_owned()));
    }
}

impl NodeSocket for Socket {
    fn send(&self, data: &str) {
        self.send_text(data.to_owned());
    }
    fn close(&self, code: u16, reason: &str) {
        self.close_with(code, reason);
    }
}

/// The 101 answer to a well-formed WebSocket request, or None (Bun's `upgrade` returning false).
fn handshake(req: &Req) -> Option<Resp> {
    let has = |name: &str, token: &str| req.header(name).is_some_and(|v| v.split(',').any(|p| p.trim().eq_ignore_ascii_case(token)));
    if req.method != Method::GET || !has("upgrade", "websocket") || !has("connection", "upgrade") || req.header("sec-websocket-version").as_deref() != Some("13") {
        return None;
    }
    let key = req.header("sec-websocket-key").filter(|k| !k.is_empty())?;
    let mut r = Response::new(axum::body::Body::empty());
    *r.status_mut() = StatusCode::SWITCHING_PROTOCOLS;
    r.headers_mut().insert(header::UPGRADE, HeaderValue::from_static("websocket"));
    r.headers_mut().insert(header::CONNECTION, HeaderValue::from_static("Upgrade"));
    r.headers_mut().insert(header::SEC_WEBSOCKET_ACCEPT, HeaderValue::from_str(&derive_accept_key(key.as_bytes())).ok()?);
    Some(r)
}

/// Runs one socket: frames in go to `on_text`, the queue goes out, until either side ends it.
async fn pump(
    on: hyper::upgrade::OnUpgrade,
    mut rx: mpsc::UnboundedReceiver<Out>,
    queued: Rc<Cell<usize>>,
    on_open: impl FnOnce(),
    on_text: impl Fn(&str),
    on_close: impl FnOnce(),
) {
    let Ok(upgraded) = on.await else { return on_close() };
    let mut config = WebSocketConfig::default();
    config.max_message_size = Some(MAX_MESSAGE);
    config.max_frame_size = Some(MAX_MESSAGE);
    let ws = WebSocketStream::from_raw_socket(TokioIo::new(upgraded), Role::Server, Some(config)).await;
    let (mut sink, mut stream) = ws.split();
    on_open();
    let mut last = Instant::now();
    let mut tick = tokio::time::interval(IDLE / 4);
    tick.tick().await;
    loop {
        tokio::select! {
            got = stream.next() => match got {
                Some(Ok(Message::Text(t))) => {
                    last = Instant::now();
                    on_text(t.as_str());
                }
                Some(Ok(Message::Binary(b))) => {
                    last = Instant::now();
                    on_text(&String::from_utf8_lossy(&b));
                }
                Some(Ok(Message::Ping(_) | Message::Pong(_) | Message::Frame(_))) => last = Instant::now(),
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
            },
            out = rx.recv() => match out {
                Some(Out::Text(s)) => {
                    let n = s.len();
                    let sent = sink.send(Message::text(s)).await;
                    queued.set(queued.get().saturating_sub(n));
                    if sent.is_err() {
                        break;
                    }
                }
                Some(Out::Close(code, reason)) => {
                    let _ = sink.send(Message::Close(Some(CloseFrame { code: CloseCode::from(code), reason: reason.into() }))).await;
                    // the other side's close reply, briefly
                    let _ = tokio::time::timeout(Duration::from_secs(2), async { while let Some(Ok(m)) = stream.next().await { if m.is_close() { break } } }).await;
                    break;
                }
                None => break,
            },
            _ = tick.tick() => {
                if last.elapsed() >= IDLE {
                    break;
                }
                if last.elapsed() >= IDLE / 4 && sink.send(Message::Ping(Vec::new().into())).await.is_err() {
                    break;
                }
            }
        }
    }
    let _ = sink.close().await;
    on_close();
}

/// `/ws`: the app. A phone connects with a ticket (a page can't set a header on a WebSocket) or its
/// bearer; either one is judged alone, never a cookie sent along with it.
pub fn app_upgrade(mut req: Req) -> Resp {
    let ticket = req.query_get("ticket");
    let as_phone = ticket.is_some() || has_bearer(&req);
    let phone = match &ticket {
        Some(t) => redeem_ticket(t, now_ms()),
        None if as_phone => phone_for(&req),
        None => None,
    };
    if as_phone && phone.is_none() {
        return text(401, "Not signed in");
    }
    if !as_phone && !same_origin(&req) {
        return text(403, "Cross-site connection refused");
    }
    if !as_phone && !is_authed(&req) {
        return text(401, "Not signed in");
    }
    let (Some(res), Some(on)) = (handshake(&req), req.upgrade.take()) else { return text(400, "Upgrade failed") };
    let (sock, rx, queued) = Socket::new();
    let s = sock.clone();
    let client = new_client(move |msg| s.send_text(wire(msg)));
    let s = sock.clone();
    let closer: Closer = Rc::new(move |code, reason| s.close_with(code, reason));
    let release: Box<dyn Fn()> = match &phone {
        Some(p) => Box::new(hold_phone_socket(&p.id, closer)),
        None => Box::new(hold_socket(&req, closer)),
    };
    let (c1, c2, c3) = (client.clone(), client.clone(), client);
    tokio::task::spawn_local(pump(
        on,
        rx,
        queued,
        move || add(&c1),
        move |t| client_message(&c2, t),
        move || {
            release();
            close_client(&c3);
        },
    ));
    res
}

/// `/node`: machines running inyon authenticate with their pairing token.
pub async fn node_upgrade(mut req: Req) -> Resp {
    let auth = req.header("authorization").unwrap_or_default();
    let token = inyon_core::re!(r"(?i)^Bearer\s+").replace(&auth, "").into_owned();
    let hash = if token.is_empty() { String::new() } else { sha256(&token) };
    let cfg = (!hash.is_empty())
        .then(|| registry().configs().into_iter().find(|c| c.kind == HostKind::Node && c.token_hash.as_deref().is_some_and(|h| !h.is_empty() && same(h, &hash))))
        .flatten();
    let cfg = match cfg {
        Some(c) if !token_expired(&c, now_ms()) => c,
        other => {
            sleep(500).await;
            // 410: the machine was removed here and should stop calling; it takes its service down
            if other.is_none() && was_removed(&hash) {
                return text(410, "This machine was removed from the hub");
            }
            return text(403, if other.is_some() { "This pairing command expired; get a new one from the hub" } else { "Unknown token" });
        }
    };
    let (Some(res), Some(on)) = (handshake(&req), req.upgrade.take()) else { return text(400, "Upgrade failed") };
    let (sock, rx, queued) = Socket::new();
    let id = cfg.id.clone();
    let (a, b, c) = (id.clone(), id.clone(), id.clone());
    let as_node: node_link::Socket = sock;
    let (s1, s2) = (as_node.clone(), as_node);
    let attached = Rc::new(RefCell::new(false));
    let at = attached.clone();
    tokio::task::spawn_local(pump(
        on,
        rx,
        queued,
        move || {
            *at.borrow_mut() = true;
            node_link::attach(&a, s1);
        },
        move |t| node_link::message(&b, t),
        move || {
            if *attached.borrow() {
                node_link::detach(&c, &s2);
            }
        },
    ));
    let _ = registry().mark_paired(&id);
    res
}
