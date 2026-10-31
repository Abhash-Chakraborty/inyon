//! Where the app is: the Overview, or a session at `/m/<machine>/p/<pane>` as the web app routes it
//! (App.tsx), under the `/next` base path while both apps run side by side. Links are plain hrefs;
//! a click on one inside the app changes the route without loading the page again.

/// The page base path the hub serves this app under (Dioxus.toml's `base_path`).
pub const BASE: &str = "/next";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Route {
    Overview,
    /// a session; `terminal` when `?view=terminal` asks for its terminal instead of its chat
    Session {
        host: String,
        pane: String,
        terminal: bool,
    },
}

/// `decodeURIComponent`, keeping what isn't valid percent-encoded UTF-8 as it was.
fn decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() && b[i + 1].is_ascii_hexdigit() && b[i + 2].is_ascii_hexdigit() {
            let hex = |c: u8| (c as char).to_digit(16).unwrap_or(0) as u8;
            out.push(hex(b[i + 1]) * 16 + hex(b[i + 2]));
            i += 3;
            continue;
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| s.to_string())
}

impl Route {
    /// The route for a path and query, with or without the base path in front.
    pub fn parse(path: &str, query: &str) -> Route {
        let path = path.strip_prefix(BASE).filter(|r| r.is_empty() || r.starts_with('/')).unwrap_or(path);
        let parts: Vec<&str> = path.split('/').filter(|p| !p.is_empty()).collect();
        if let ["m", host, "p", pane] = parts.as_slice() {
            let host = decode(host);
            let slug = decode(pane);
            // pane ids travel without their "%" (api.ts paneFromSlug)
            let pane = if slug.starts_with('%') { slug } else { format!("%{slug}") };
            let terminal = query.trim_start_matches('?').split('&').any(|kv| kv == "view=terminal");
            return Route::Session { host, pane, terminal };
        }
        Route::Overview
    }

    /// The path in the address bar, base path included.
    pub fn href(&self) -> String {
        match self {
            Route::Overview => format!("{BASE}/"),
            Route::Session { host, pane, terminal } => {
                let view = if *terminal { Some(inyon_chat_core::overview::PaneView::Terminal) } else { None };
                format!("{BASE}{}", inyon_chat_core::overview::pane_href(host, pane, view))
            }
        }
    }
}

/// A link inside the app: one that leads under the base path, opened with a plain click.
pub fn internal(href: &str) -> Option<Route> {
    let path = href.strip_prefix(BASE)?;
    if !(path.is_empty() || path.starts_with('/')) {
        return None;
    }
    let (path, query) = path.split_once('?').unwrap_or((path, ""));
    Some(Route::parse(path, query))
}

#[cfg(target_arch = "wasm32")]
mod imp {
    use super::Route;
    use futures_channel::mpsc::UnboundedSender;
    use wasm_bindgen::{closure::Closure, JsCast};

    pub fn current() -> Route {
        let loc = web_sys::window().map(|w| w.location());
        let path = loc.as_ref().and_then(|l| l.pathname().ok()).unwrap_or_default();
        let query = loc.and_then(|l| l.search().ok()).unwrap_or_default();
        Route::parse(&path, &query)
    }

    /// Puts the route in the address bar: a new history entry, or in place of this one.
    pub fn push(r: &Route, replace: bool) {
        let Some(h) = web_sys::window().and_then(|w| w.history().ok()) else { return };
        let href = r.href();
        let _ =
            if replace { h.replace_state_with_url(&wasm_bindgen::JsValue::NULL, "", Some(&href)) } else { h.push_state_with_url(&wasm_bindgen::JsValue::NULL, "", Some(&href)) };
    }

    /// Back and forward, and clicks on links into the app (any `a` under the base path, without a
    /// modifier key or a target), reported as routes.
    pub fn listen(tx: UnboundedSender<Route>) {
        let Some(win) = web_sys::window() else { return };
        let t = tx.clone();
        let pop = Closure::<dyn FnMut(web_sys::Event)>::new(move |_| drop(t.unbounded_send(current())));
        let _ = win.add_event_listener_with_callback("popstate", pop.as_ref().unchecked_ref());
        pop.forget();
        let click = Closure::<dyn FnMut(web_sys::MouseEvent)>::new(move |e: web_sys::MouseEvent| {
            if e.default_prevented() || e.button() != 0 || e.meta_key() || e.ctrl_key() || e.shift_key() || e.alt_key() {
                return;
            }
            let Some(a) = e.target().and_then(|t| t.dyn_into::<web_sys::Element>().ok()).and_then(|el| el.closest("a[href]").ok().flatten()) else { return };
            if a.get_attribute("target").is_some_and(|t| !t.is_empty() && t != "_self") || a.has_attribute("download") {
                return;
            }
            let Some(route) = a.get_attribute("href").and_then(|h| super::internal(&h)) else { return };
            e.prevent_default();
            push(&route, false);
            let _ = tx.unbounded_send(route);
        });
        if let Some(doc) = win.document() {
            let _ = doc.add_event_listener_with_callback("click", click.as_ref().unchecked_ref());
        }
        click.forget();
    }
}

#[cfg(target_arch = "wasm32")]
pub use imp::{current, listen};

#[cfg(not(target_arch = "wasm32"))]
pub fn current() -> Route {
    Route::Overview
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(host: &str, pane: &str, terminal: bool) -> Route {
        Route::Session { host: host.into(), pane: pane.into(), terminal }
    }

    #[test]
    fn sessions_route_as_the_web_app_does() {
        assert_eq!(Route::parse("/next/m/box/p/12", ""), session("box", "%12", false));
        assert_eq!(Route::parse("/m/box/p/12", "?view=terminal"), session("box", "%12", true));
        assert_eq!(Route::parse("/next/m/hub%3Ah1%2Flaptop/p/%253", ""), session("hub:h1/laptop", "%3", false));
        assert_eq!(Route::parse("/next/m/box%20one/p/7/", "?a=1&view=terminal"), session("box one", "%7", true));
        for other in ["/next", "/next/", "/next/machines", "/next/m/box", "/nextcloud/m/a/p/1"] {
            assert_eq!(Route::parse(other, ""), Route::Overview, "{other}");
        }
    }

    #[test]
    fn hrefs_go_back_to_the_same_route() {
        for r in [Route::Overview, session("box 1", "%12", false), session("hub:h1/laptop", "%3", true)] {
            let href = r.href();
            assert!(href.starts_with("/next/"), "{href}");
            assert_eq!(internal(&href), Some(r));
        }
        assert_eq!(session("box", "%12", true).href(), "/next/m/box/p/12?view=terminal");
        // links out of the app load their page
        assert_eq!(internal("/machines"), None);
        assert_eq!(internal("/nextcloud"), None);
        assert_eq!(internal("https://example.com/next/"), None);
    }

    #[test]
    fn broken_escapes_are_kept_as_written() {
        assert_eq!(decode("a%2"), "a%2");
        assert_eq!(decode("a%zz"), "a%zz");
        assert_eq!(decode("%E2%9C%B3"), "✳");
    }
}
