//! Inyon's app in Rust, on Dioxus 0.7: one codebase for the browser, desktop and Android. This first
//! slice is the browser copy the hub serves at /next: sign-in and the Overview, over the same API
//! and `/ws` protocol as the React app (apps/web), which keeps `/` until this one reaches parity.

// only the browser build reaches a hub so far, so elsewhere its wire code goes unused until the
// desktop transport lands
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
mod api;
mod format;
mod model;
mod platform;
mod socket;
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
mod state;
mod ui;

fn main() {
    platform::follow_theme();
    dioxus::launch(ui::App);
}
