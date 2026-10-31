//! The one WebSocket to the hub (`/ws`, protocol v1), as apps/web/src/lib/socket.ts runs it for
//! the overview: subscribe on open, a ping every 25 s, a socket that went quiet for 55 s is dead,
//! reconnect with backoff, and come back at once when the page is shown again or the network
//! returns. After 15 s in the background it asks for overviews only when an agent's state changes.

/// What the socket tells the app.
#[derive(Debug)]
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub enum Event {
    Up,
    /// the connection closed; the app checks whether the session ended with it
    Down,
    Frame(String),
}

#[cfg(target_arch = "wasm32")]
pub use imp::run;

#[cfg(not(target_arch = "wasm32"))]
pub async fn run(_on: impl FnMut(Event)) {
    // only the browser build has a hub to reach so far
    std::future::pending::<()>().await
}

#[cfg(target_arch = "wasm32")]
mod imp {
    use super::Event;
    use crate::platform::{now, random};
    use crate::state::{attempt_after, backoff, wire};
    use futures_channel::mpsc::{unbounded, UnboundedReceiver, UnboundedSender};
    use futures_util::future::{select, Either};
    use futures_util::StreamExt;
    use gloo_timers::future::TimeoutFuture;
    use inyon_protocol::{compat::CATALOG, ClientMsg};
    use wasm_bindgen::{closure::Closure, JsCast};

    const PING_MS: f64 = 25_000.0;
    const DEAD_MS: f64 = 55_000.0;
    const QUIET_AFTER_MS: f64 = 15_000.0;

    enum Raw {
        Open(u32),
        Message(u32, String),
        Close(u32),
        /// the page was shown (true) or hidden
        Visible(bool),
        Online,
    }

    /// The open socket and its handlers; dropping it closes the socket without hearing back.
    struct Conn {
        ws: web_sys::WebSocket,
        _handlers: Vec<Closure<dyn FnMut(web_sys::Event)>>,
    }

    impl Drop for Conn {
        fn drop(&mut self) {
            self.ws.set_onopen(None);
            self.ws.set_onmessage(None);
            self.ws.set_onclose(None);
            let _ = self.ws.close();
        }
    }

    fn url() -> String {
        let loc = web_sys::window().map(|w| w.location());
        let https = loc.as_ref().and_then(|l| l.protocol().ok()).is_some_and(|p| p == "https:");
        let host = loc.and_then(|l| l.host().ok()).unwrap_or_default();
        format!("{}://{host}/ws?catalog={CATALOG}", if https { "wss" } else { "ws" })
    }

    fn open(id: u32, tx: &UnboundedSender<Raw>) -> Option<Conn> {
        let ws = web_sys::WebSocket::new(&url()).ok()?;
        let on = |f: Box<dyn FnMut(web_sys::Event)>| Closure::wrap(f);
        let t = tx.clone();
        let opened = on(Box::new(move |_| drop(t.unbounded_send(Raw::Open(id)))));
        let t = tx.clone();
        let message = on(Box::new(move |e: web_sys::Event| {
            if let Some(text) = e.dyn_ref::<web_sys::MessageEvent>().and_then(|m| m.data().as_string()) {
                let _ = t.unbounded_send(Raw::Message(id, text));
            }
        }));
        let t = tx.clone();
        let closed = on(Box::new(move |_| drop(t.unbounded_send(Raw::Close(id)))));
        ws.set_onopen(Some(opened.as_ref().unchecked_ref()));
        ws.set_onmessage(Some(message.as_ref().unchecked_ref()));
        ws.set_onclose(Some(closed.as_ref().unchecked_ref()));
        Some(Conn { ws, _handlers: vec![opened, message, closed] })
    }

    fn visible() -> bool {
        web_sys::window().and_then(|w| w.document()).is_none_or(|d| d.visibility_state() != web_sys::VisibilityState::Hidden)
    }

    /// Page visibility and the network coming back, while the socket runs; dropping it takes the
    /// listeners off again, since a closure the page still calls must not be freed.
    struct Listeners {
        vis: Closure<dyn FnMut(web_sys::Event)>,
        online: Closure<dyn FnMut(web_sys::Event)>,
    }

    impl Listeners {
        fn new(tx: &UnboundedSender<Raw>) -> Self {
            let t = tx.clone();
            let vis = Closure::<dyn FnMut(web_sys::Event)>::new(move |_| drop(t.unbounded_send(Raw::Visible(visible()))));
            let t = tx.clone();
            let online = Closure::<dyn FnMut(web_sys::Event)>::new(move |_| drop(t.unbounded_send(Raw::Online)));
            if let Some(win) = web_sys::window() {
                if let Some(doc) = win.document() {
                    let _ = doc.add_event_listener_with_callback("visibilitychange", vis.as_ref().unchecked_ref());
                }
                let _ = win.add_event_listener_with_callback("online", online.as_ref().unchecked_ref());
            }
            Listeners { vis, online }
        }
    }

    impl Drop for Listeners {
        fn drop(&mut self) {
            if let Some(win) = web_sys::window() {
                if let Some(doc) = win.document() {
                    let _ = doc.remove_event_listener_with_callback("visibilitychange", self.vis.as_ref().unchecked_ref());
                }
                let _ = win.remove_event_listener_with_callback("online", self.online.as_ref().unchecked_ref());
            }
        }
    }

    fn send(conn: &Conn, msg: &ClientMsg) {
        if conn.ws.ready_state() == web_sys::WebSocket::OPEN {
            let _ = conn.ws.send_with_str(&wire(msg));
        }
    }

    /// The next event, or None once `ms` passed without one.
    async fn next_within(rx: &mut UnboundedReceiver<Raw>, ms: f64) -> Option<Raw> {
        let wait = TimeoutFuture::new(ms.clamp(0.0, 2_147_483_000.0) as u32);
        match select(rx.next(), wait).await {
            Either::Left((ev, _)) => ev,
            Either::Right(_) => None,
        }
    }

    /// Runs until the task is dropped (the app signs out or closes).
    pub async fn run(mut on: impl FnMut(Event)) {
        let (tx, mut rx) = unbounded::<Raw>();
        let _listeners = Listeners::new(&tx);
        let mut id = 0u32;
        let mut retry = 0u32;
        let mut quiet = false;
        let mut hidden_since = if visible() { None } else { Some(now()) };
        loop {
            id += 1;
            let conn = open(id, &tx);
            let mut opened_at: Option<f64> = None;
            let mut heard = now();
            let mut next_ping = now() + PING_MS;
            // one connection, until it closes or goes quiet
            while let Some(conn) = &conn {
                let quiet_at = hidden_since.filter(|_| !quiet).map(|t| t + QUIET_AFTER_MS);
                let deadline = quiet_at.map_or(next_ping, |q| q.min(next_ping));
                match next_within(&mut rx, deadline - now()).await {
                    Some(Raw::Open(i)) if i == id => {
                        opened_at = Some(now());
                        heard = now();
                        next_ping = now() + PING_MS;
                        on(Event::Up);
                        send(conn, &ClientMsg::SubOverview);
                        if quiet {
                            send(conn, &ClientMsg::Quiet { on: true });
                        }
                    }
                    Some(Raw::Message(i, text)) if i == id => {
                        heard = now();
                        on(Event::Frame(text));
                    }
                    Some(Raw::Close(i)) if i == id => break,
                    Some(Raw::Visible(true)) | Some(Raw::Online) => {
                        hidden_since = None;
                        if quiet {
                            quiet = false;
                            send(conn, &ClientMsg::Quiet { on: false });
                        }
                        // a phone drops sockets in the background: check on this one now
                        if opened_at.is_some() && now() - heard > 30_000.0 {
                            break;
                        }
                        send(conn, &ClientMsg::Ping);
                    }
                    Some(Raw::Visible(false)) => hidden_since = Some(now()),
                    // an older connection's last words
                    Some(_) => {}
                    None => {
                        if now() - heard > DEAD_MS {
                            break;
                        }
                        if now() >= next_ping {
                            send(conn, &ClientMsg::Ping);
                            next_ping = now() + PING_MS;
                        }
                        if quiet_at.is_some_and(|q| now() >= q) {
                            quiet = true;
                            send(conn, &ClientMsg::Quiet { on: true });
                        }
                    }
                }
            }
            drop(conn);
            on(Event::Down);
            retry = attempt_after(retry, opened_at, now());
            let wait = backoff(retry, 400.0, 8000.0, random());
            retry += 1;
            // the wait ends early when the page comes back or the network returns
            let until = now() + wait;
            while now() < until {
                match next_within(&mut rx, until - now()).await {
                    Some(Raw::Visible(true)) | Some(Raw::Online) => {
                        hidden_since = None;
                        retry = 0;
                        break;
                    }
                    Some(Raw::Visible(false)) => hidden_since = Some(now()),
                    _ => {}
                }
            }
        }
    }
}
