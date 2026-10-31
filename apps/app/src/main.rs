//! Inyon's app in Rust, on Dioxus 0.7: one codebase for the browser, desktop and Android. So far it
//! is the browser copy the hub serves at /next: sign-in, the Overview and a session's chat, over the same API as the React app (apps/web) and the hub's `/ws2` protocol. The React
//! app keeps `/` until this one reaches parity.

// only the browser build reaches a hub so far, so elsewhere its wire code goes unused until the
// desktop transport lands
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
mod api;
mod dom;
mod format;
mod list;
mod markdown;
mod model;
mod platform;
mod prompt;
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
mod route;
mod socket;
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
mod state;
mod ui;

fn main() {
    platform::follow_theme();
    dioxus::launch(ui::App);
}
