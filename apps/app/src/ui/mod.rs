//! The screens. The root asks the hub whether this browser is signed in, then shows the sign-in
//! form or the app with its socket.

mod add;
pub(crate) mod back;
mod chat;
mod composer;
mod connect;
mod controls;
mod conversations;
mod icons;
mod kit;
mod login;
mod machines;
mod md;
mod menu;
mod notices;
mod organize;
mod overview;
mod pages;
mod panel;
mod phone;
mod prompt;
mod quick;
mod rows;
mod session;
mod session_menu;
mod settings;
mod setup;
mod share;
mod shell;
mod sidebar;
// xterm.js and the page's events reach it only in the browser build
mod companion;
mod intro;
mod temp;
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
mod terminal;
pub mod toast;
mod usage;

use dioxus::prelude::*;
use inyon_protocol::v2::{ORGANIZE, OVERVIEW, PAGES};

use crate::route;
#[cfg(any(target_arch = "wasm32", feature = "phone"))]
use crate::route::Route;
use crate::socket::{self, Outbox};
use crate::state::{self, Chats, Hub, Incoming};
use crate::{api, platform};

// in index.html's head, so the first paint is styled (the link Dioxus adds would come after the wasm)
const CSS: Asset = asset!("/assets/app.css", AssetOptions::css().with_static_head(true));
const GEIST: Asset = asset!("/assets/fonts/geist-latin-wght-normal.woff2");
const GEIST_MONO: Asset = asset!("/assets/fonts/geist-mono-latin-wght-normal.woff2");
/// the serif replies are set in (Claude's); the browser fetches it only when a reply uses it
const SERIF: Asset = asset!("/assets/fonts/source-serif-4-latin-wght-normal.woff2");

/// Where the app is with the hub's sign-in.
#[derive(Debug, Clone, PartialEq)]
pub enum Auth {
    Checking,
    /// `setup` when the hub has no password yet; `code` when making one needs the setup code
    SignedOut {
        setup: bool,
        code: bool,
    },
    SignedIn,
}

fn fonts() -> String {
    // the Latin subsets only, as apps/web/src/fonts.css, under the names styles.css uses
    let face = |family: &str, weights: &str, url: &Asset| {
        format!("@font-face{{font-family:'{family}';font-style:normal;font-display:swap;font-weight:{weights};src:url({url}) format('woff2-variations');unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}}")
    };
    face("Geist Variable", "100 900", &GEIST) + &face("Geist Mono Variable", "100 900", &GEIST_MONO) + &face("Source Serif 4 Variable", "200 900", &SERIF)
}

async fn check(mut auth: Signal<Auth>) {
    let next = match api::session().await {
        Ok(s) if s.authed => Auth::SignedIn,
        Ok(s) => {
            signed_out();
            Auth::SignedOut { setup: s.setup, code: s.setup_code }
        }
        // the hub didn't answer: the app drawn from the browser's copy stays, saying it's
        // reconnecting (the socket asks again once it's up); otherwise the form, whose submit says
        // why it can't go on
        Err(_) if *auth.peek() == Auth::SignedIn => Auth::SignedIn,
        Err(_) => Auth::SignedOut { setup: false, code: false },
    };
    // already drawn from the kept copy: a confirmed sign-in changes nothing on screen
    if *auth.peek() != next {
        auth.set(next);
    }
}

/// Signed out: the copies kept in this browser go with the sign-in.
pub fn signed_out() {
    crate::snapshot::clear();
    // the next one to sign in mustn't see what this sign-in's agents did
    notices::ACTIVITY.write().clear();
}

#[component]
pub fn App() -> Element {
    // with a copy of the last overview to show, the app draws it before the hub confirms the
    // sign-in; a session that ran out turns into the sign-in form a moment later
    let auth = use_signal(|| if crate::snapshot::overview().is_some() { Auth::SignedIn } else { Auth::Checking });
    use_hook(move || {
        crate::snapshot::install();
        spawn(check(auth))
    });
    // the intro once per tab session, over the page as it loads; the mark lands on the header's
    let intro = use_hook(intro::due);
    rsx! {
        document::Stylesheet { href: CSS }
        document::Link { rel: "preload", href: GEIST, r#as: "font", r#type: "font/woff2", crossorigin: "anonymous" }
        style { {fonts()} }
        match auth() {
            // the Overview's shape, where it lands once the sign-in check answers
            Auth::Checking => rsx! {
                div { class: "opening", kit::Waiting { label: "Opening Inyon" } }
            },
            Auth::SignedOut { setup, code } => rsx! {
                login::Login { setup, needs_code: code, on_done: move |_| { spawn(check(auth)); } }
            },
            Auth::SignedIn => rsx! { Connected { auth } },
        }
        if intro {
            intro::Intro {}
        }
    }
}

/// The signed-in app: the hub's state, fed by the socket for as long as this is on screen, and the
/// route.
#[component]
fn Connected(auth: Signal<Auth>) -> Element {
    // the machines as this browser last saw them paint first; the hub's overview replaces them
    let mut hub = use_context_provider(|| Signal::new(Hub::kept(crate::snapshot::overview())));
    let mut chats = use_context_provider(|| Signal::new(Chats::default()));
    #[cfg_attr(not(any(target_arch = "wasm32", feature = "phone")), allow(unused_mut, unused_variables))]
    let mut here = use_context_provider(|| Signal::new(route::current()));
    use_context_provider(|| Signal::new(None::<menu::Menu>));
    // "Sign in" in Can't connect? goes back to the form
    use_context_provider(|| auth);
    #[cfg(any(target_arch = "wasm32", feature = "phone"))]
    use_hook(move || {
        let (tx, mut rx) = futures_channel::mpsc::unbounded::<Route>();
        route::listen(tx);
        spawn(async move {
            use futures_util::StreamExt;
            while let Some(r) = rx.next().await {
                here.set(r);
            }
        });
    });
    let outbox = use_hook(move || {
        // a new sign-in: the screens start empty, so the streams start over
        state::reset_feed();
        pages::PAGES.write().reset();
        organize::reset();
        if hub.peek().stale {
            if let Some(org) = crate::snapshot::organize() {
                organize::kept(org);
            }
        }
        let (outbox, inbox) = socket::channel();
        let out = outbox.clone();
        // a first connection that neither opens nor fails for a while says it's reconnecting
        spawn(async move {
            platform::sleep(SETTLE_MS).await;
            if !hub.peek().settled {
                hub.write().settled = true;
            }
        });
        spawn(socket::run(inbox, move |ev| match ev {
            socket::Event::Up => {
                connect::record_up();
                // a hub that restarted comes back on a new connection, maybe running newer code
                notices::check_build();
                if !hub.peek().connected {
                    hub.write().set_connected(true);
                }
                // follow the overview, the pages and every open chat from where they were left
                for sub in state::with_feed(|f| f.subs()) {
                    out.send(state::wire2(&sub));
                }
                for sub in chats.peek().subs() {
                    out.send(state::wire2(&sub));
                }
                // earlier messages asked for while no socket was open never went; each chat
                // starts over from its snapshot anyway
                if chats.peek().map.values().any(|e| e.loading_more) {
                    for e in chats.write().map.values_mut() {
                        e.loading_more = false;
                    }
                }
            }
            socket::Event::Down(why) => {
                connect::record_down(&why);
                if hub.peek().connected || !hub.peek().settled {
                    hub.write().set_connected(false);
                }
                // the hub refuses the socket once the session has expired
                spawn(async move {
                    if let Ok(s) = api::session().await {
                        if !s.authed {
                            signed_out();
                            auth.set(Auth::SignedOut { setup: s.setup, code: s.setup_code });
                        }
                    }
                });
            }
            socket::Event::Message { text, binary } => match state::read(text.as_deref(), binary.as_deref()) {
                Incoming::Frame(f) if f.stream() == Some(OVERVIEW) => {
                    // read without subscribing, so an unchanged overview doesn't redraw the screen
                    let (hosts, resync) = state::with_feed(|feed| feed.overview(&f, &hub.peek(), now()));
                    if let Some(hosts) = hosts {
                        crate::snapshot::save_overview(hosts.clone());
                        hub.write().set_hosts(hosts);
                    }
                    if let Some(m) = resync {
                        out.send(state::wire2(&m));
                    }
                }
                Incoming::Frame(f) if f.stream() == Some(PAGES) => {
                    let (list, resync) = state::with_feed(|feed| feed.pages(&f));
                    if let Some(list) = list {
                        pages::PAGES.write().streamed(list);
                    }
                    if let Some(m) = resync {
                        out.send(state::wire2(&m));
                    }
                }
                Incoming::Frame(f) if f.stream() == Some(ORGANIZE) => {
                    let (org, resync) = state::with_feed(|feed| feed.organize(&f));
                    if let Some(org) = org {
                        crate::snapshot::save_organize(org.clone());
                        organize::set(org);
                    }
                    if let Some(m) = resync {
                        out.send(state::wire2(&m));
                    }
                }
                Incoming::Frame(f) => {
                    // a chat nobody has open is dropped without a redraw
                    if let Some(k) = f.stream().filter(|k| chats.peek().get(k).is_some()) {
                        let resync = chats.write().apply(&f, now());
                        if let Some(m) = resync {
                            out.send(state::wire2(&m));
                        }
                        // its last page, kept for the next time the app opens
                        let kept = chats.peek().get(k).and_then(|e| e.chat.snapshot());
                        if let Some(kept) = kept {
                            crate::snapshot::save_chat(k, kept);
                        }
                    }
                }
                // a terminal's output goes straight to its drawing; notices become toasts
                Incoming::Hub { t, text } if t.starts_with("term.") => crate::term::dispatch(&text),
                Incoming::Hub { t, text } => {
                    if let Some(m) = state::notice_msg(&t, &text) {
                        notices::handle(&m, &here.peek(), &hub.peek().hosts);
                    }
                }
                Incoming::Other => {}
            },
        }));
        outbox
    });
    use_context_provider(|| outbox);
    rsx! {
        shell::Shell {}
        notices::PushWatch {}
    }
}

/// How long the first connection may take before the screens say it's reconnecting.
const SETTLE_MS: u32 = 2500;

/// Unix ms, for the chat model.
pub fn now() -> u64 {
    platform::clock().now as u64
}

/// The outbox for messages to the hub.
pub fn outbox() -> Outbox {
    use_context::<Outbox>()
}
