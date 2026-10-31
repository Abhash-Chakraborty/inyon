//! The screens. The root asks the hub whether this browser is signed in, then shows the sign-in
//! form or the app with its socket.

mod icons;
mod login;
mod overview;
mod shell;

use dioxus::prelude::*;

use crate::{api, socket, state::Hub};

const CSS: Asset = asset!("/assets/app.css");
const GEIST: Asset = asset!("/assets/fonts/geist-latin-wght-normal.woff2");
const GEIST_MONO: Asset = asset!("/assets/fonts/geist-mono-latin-wght-normal.woff2");

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
    let face = |family: &str, url: &Asset| {
        format!("@font-face{{font-family:'{family}';font-style:normal;font-display:swap;font-weight:100 900;src:url({url}) format('woff2-variations');unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}}")
    };
    face("Geist Variable", &GEIST) + &face("Geist Mono Variable", &GEIST_MONO)
}

async fn check(mut auth: Signal<Auth>) {
    auth.set(match api::session().await {
        Ok(s) if s.authed => Auth::SignedIn,
        Ok(s) => Auth::SignedOut { setup: s.setup, code: s.setup_code },
        // the hub didn't answer: the form, whose submit says why it can't go on
        Err(_) => Auth::SignedOut { setup: false, code: false },
    });
}

#[component]
pub fn App() -> Element {
    let auth = use_signal(|| Auth::Checking);
    use_hook(move || spawn(check(auth)));
    rsx! {
        document::Stylesheet { href: CSS }
        document::Link { rel: "preload", href: GEIST, r#as: "font", r#type: "font/woff2", crossorigin: "anonymous" }
        style { {fonts()} }
        match auth() {
            Auth::Checking => rsx! {},
            Auth::SignedOut { setup, code } => rsx! {
                login::Login { setup, needs_code: code, on_done: move |_| { spawn(check(auth)); } }
            },
            Auth::SignedIn => rsx! { Connected { auth } },
        }
    }
}

/// The signed-in app: the hub's state, fed by the socket for as long as this is on screen.
#[component]
fn Connected(auth: Signal<Auth>) -> Element {
    let mut hub = use_context_provider(|| Signal::new(Hub::default()));
    use_hook(move || {
        spawn(socket::run(move |ev| match ev {
            socket::Event::Up => {
                if !hub.peek().connected {
                    hub.write().set_connected(true);
                }
            }
            socket::Event::Down => {
                if hub.peek().connected {
                    hub.write().set_connected(false);
                }
                // the hub refuses the socket once the session has expired
                spawn(async move {
                    if let Ok(s) = api::session().await {
                        if !s.authed {
                            auth.set(Auth::SignedOut { setup: s.setup, code: s.setup_code });
                        }
                    }
                });
            }
            socket::Event::Frame(text) => {
                // read without subscribing, so an unchanged overview doesn't redraw the screen
                let hosts = hub.peek().changed_hosts(&text);
                if let Some(hosts) = hosts {
                    hub.write().set_hosts(hosts);
                }
            }
        }))
    });
    rsx! { shell::Shell {} }
}
