//! Where the app is: the Overview, a session at `/m/<machine>/p/<pane>`, the machines at
//! `/machines`, one machine at `/machines/<id>`, the blueprints at `/blueprints[/<machine>/<slug>]`
//! (and `/pages/…`, their address before 0.25), Settings at
//! `/settings` and the temp files at `/temp[/<machine>]`, as the web app routes them (App.tsx), under the
//! `/next` base path while both apps run side by side. Links are plain hrefs;
//! a click on one inside the app changes the route without loading the page again.

use inyon_chat_core::overview::PaneView;

/// The page base path the hub serves this app under (Dioxus.toml's `base_path`).
pub const BASE: &str = "/next";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Route {
    Overview,
    /// a session; `view` when `?view=chat` or `?view=terminal` asks for one, otherwise the pane's
    /// own (its chat, or its terminal for a plain shell or an agent that stays in its terminal)
    Session {
        host: String,
        pane: String,
        view: Option<PaneView>,
    },
    /// the machines; `add` opens the Add sheet (`?add=1`, from "Pair again" in Can't connect?)
    Machines {
        add: bool,
    },
    Machine {
        id: String,
    },
    /// the blueprints, with one open (`/blueprints/<machine>/<slug>`, or `/pages/…`)
    Pages {
        page: Option<(String, String)>,
    },
    Settings,
    /// a machine's temp files (`/temp/<machine>`), or the first online machine's (`/temp`)
    Temp {
        host: Option<String>,
    },
}

/// `decodeURIComponent`, keeping what isn't valid percent-encoded UTF-8 as it was.
pub fn decode(s: &str) -> String {
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
            let view = query.trim_start_matches('?').split('&').find_map(|kv| match kv {
                "view=terminal" => Some(PaneView::Terminal),
                "view=chat" => Some(PaneView::Chat),
                _ => None,
            });
            return Route::Session { host, pane, view };
        }
        match parts.as_slice() {
            ["machines"] => Route::Machines { add: query.trim_start_matches('?').split('&').any(|kv| kv == "add=1" || kv.starts_with("add=")) },
            ["machines", id] => Route::Machine { id: decode(id) },
            ["blueprints" | "pages"] => Route::Pages { page: None },
            ["blueprints" | "pages", host, slug] => Route::Pages { page: Some((decode(host), decode(slug))) },
            ["settings"] => Route::Settings,
            ["temp"] => Route::Temp { host: None },
            ["temp", host] => Route::Temp { host: Some(decode(host)) },
            _ => Route::Overview,
        }
    }

    /// The path in the address bar, base path included.
    pub fn href(&self) -> String {
        match self {
            Route::Overview => format!("{BASE}/"),
            Route::Session { host, pane, view } => format!("{BASE}{}", inyon_chat_core::overview::pane_href(host, pane, *view)),
            Route::Machines { add } => format!("{BASE}/machines{}", if *add { "?add=1" } else { "" }),
            Route::Machine { id } => format!("{BASE}/machines/{}", inyon_chat_core::js::encode_uri_component(id)),
            Route::Pages { page: None } => format!("{BASE}/blueprints"),
            Route::Pages { page: Some((host, slug)) } => {
                format!("{BASE}/blueprints/{}/{}", inyon_chat_core::js::encode_uri_component(host), inyon_chat_core::js::encode_uri_component(slug))
            }
            Route::Settings => format!("{BASE}/settings"),
            Route::Temp { host: None } => format!("{BASE}/temp"),
            Route::Temp { host: Some(h) } => format!("{BASE}/temp/{}", inyon_chat_core::js::encode_uri_component(h)),
        }
    }
}

/// A path inside the app with the base path in front (`/machines` → `/next/machines`), for the
/// few links that aren't a [`Route`]. Every link goes through this or [`Route::href`], so moving
/// the app to another base path is a change to [`BASE`] alone.
pub fn app_href(path: &str) -> String {
    format!("{BASE}{path}")
}

/// A link inside the app: one that leads under the base path, opened with a plain click.
pub fn internal(href: &str) -> Option<Route> {
    let path = href.strip_prefix(BASE)?;
    if !(path.is_empty() || path.starts_with('/')) {
        return None;
    }
    let path = path.split_once('#').map_or(path, |(p, _)| p);
    let (path, query) = path.split_once('?').unwrap_or((path, ""));
    Some(Route::parse(path, query))
}

/// The address a link into the app leads to: its route's, with the link's `#section` kept (a
/// section of Settings).
pub fn link_href(r: &Route, href: &str) -> String {
    match href.split_once('#') {
        Some((_, hash)) if !hash.is_empty() => format!("{}#{hash}", r.href()),
        _ => r.href(),
    }
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
        if !replace {
            record(&r.href());
            return;
        }
        let Some(h) = web_sys::window().and_then(|w| w.history().ok()) else { return };
        // the entry keeps its mark: a layer's, when a sheet the address opened tidies the address
        let st = h.state().unwrap_or(wasm_bindgen::JsValue::NULL);
        let _ = h.replace_state_with_url(&st, "", Some(&r.href()));
    }

    /// A new entry for a move to another screen, or one in place of a layer's spent entry (see
    /// ui/back.rs).
    fn record(href: &str) {
        let Some(h) = web_sys::window().and_then(|w| w.history().ok()) else { return };
        let (replace, mark) = crate::ui::back::page();
        let st = crate::ui::back::state(mark);
        let _ = if replace { h.replace_state_with_url(&st, "", Some(href)) } else { h.push_state_with_url(&st, "", Some(href)) };
    }

    /// Back and forward, and clicks on links into the app (any `a` under the base path, without a
    /// modifier key or a target), reported as routes.
    pub fn listen(tx: UnboundedSender<Route>) {
        let Some(win) = web_sys::window() else { return };
        let t = tx.clone();
        // a back that only closed a layer leaves the screen as it is
        let pop = Closure::<dyn FnMut(web_sys::Event)>::new(move |_| {
            if crate::ui::back::popped(crate::ui::back::current()) {
                let _ = t.unbounded_send(current());
            }
        });
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
            let Some(href) = a.get_attribute("href") else { return };
            let Some(route) = super::internal(&href) else { return };
            e.prevent_default();
            record(&super::link_href(&route, &href));
            let _ = tx.unbounded_send(route);
        });
        if let Some(doc) = win.document() {
            let _ = doc.add_event_listener_with_callback("click", click.as_ref().unchecked_ref());
        }
        click.forget();
    }
}

#[cfg(target_arch = "wasm32")]
pub use imp::{current, listen, push};

/// The Android build's page (the `phone` feature): the same rules, kept by a script in the page,
/// since Rust there runs outside it. Each link into the app adds a history entry, so Android's back
/// button walks back through them.
#[cfg(all(not(target_arch = "wasm32"), feature = "phone"))]
mod imp {
    use super::Route;
    use dioxus::prelude::spawn;
    use futures_channel::mpsc::UnboundedSender;

    /// Clicks on links into the app (taken before Dioxus's own handler, which would hand every
    /// link to the system browser), and back and forward, reported as hrefs.
    const LISTEN: &str = r#"
        if (window.interpreter) window.interpreter.intercept_link_redirects = false;
        window.addEventListener('click', (e) => {
            if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            const a = e.target instanceof Element ? e.target.closest('a[href]') : null;
            if (!a) return;
            const t = a.getAttribute('target');
            if ((t && t !== '_self') || a.hasAttribute('download')) return;
            const href = a.getAttribute('href');
            if (href !== '__BASE__' && !href.startsWith('__BASE__/') && !href.startsWith('__BASE__?')) return;
            e.preventDefault();
            dioxus.send({ go: href });
        }, true);
        window.addEventListener('popstate', () => dioxus.send({ pop: location.pathname + location.search, layer: (history.state && history.state.inyonLayer) || null }));
        await new Promise(() => {});
    "#;

    pub fn current() -> Route {
        Route::Overview
    }

    /// The script that records a route in the page's history: a new entry marked `mark` (see
    /// ui/back.rs), one in place of the entry the page is at (`replace`), or, with `keep`, the same
    /// entry at the new address with its mark kept.
    pub(super) fn history_js(r: &Route, replace: bool, keep: bool, mark: Option<u64>) -> String {
        let method = if replace || keep { "replaceState" } else { "pushState" };
        let state = match (keep, mark) {
            (true, _) => "history.state".to_string(),
            (false, Some(id)) => format!("{{inyonLayer: {id}}}"),
            (false, None) => "null".to_string(),
        };
        format!("history.{method}({state}, '', {})", serde_json::to_string(&r.href()).unwrap_or_default())
    }

    /// A move inside the app, in the page's history, so Android's back button steps back through it.
    pub fn push(r: &Route, replace: bool) {
        let js = if replace {
            history_js(r, false, true, None)
        } else {
            let (spent, mark) = crate::ui::back::page();
            history_js(r, spent, false, mark)
        };
        let _ = dioxus::document::eval(&js);
    }

    pub fn listen(tx: UnboundedSender<Route>) {
        let mut page = dioxus::document::eval(&LISTEN.replace("__BASE__", super::BASE));
        let t = tx.clone();
        spawn(async move {
            while let Ok(msg) = page.recv::<serde_json::Value>().await {
                let parse = |href: &str| {
                    let (path, query) = href.split_once('?').unwrap_or((href, ""));
                    Route::parse(path, query)
                };
                if let Some(href) = msg["go"].as_str() {
                    let route = parse(href);
                    push(&route, false);
                    let _ = t.unbounded_send(route);
                } else if let Some(href) = msg["pop"].as_str() {
                    // a back that only closed a layer leaves the screen as it is
                    if crate::ui::back::popped(msg["layer"].as_u64()) {
                        let _ = t.unbounded_send(parse(href));
                    }
                }
            }
        });
        // a tapped notification opens its session
        spawn(async move {
            let mut opened = crate::phone::opened();
            while opened.changed().await.is_ok() {
                opened.borrow_and_update();
                let Some(href) = crate::phone::take_opened() else { continue };
                let (path, query) = href.split_once('?').unwrap_or((&href, ""));
                let route = Route::parse(path, query);
                push(&route, false);
                let _ = tx.unbounded_send(route);
            }
        });
    }
}

#[cfg(all(not(target_arch = "wasm32"), feature = "phone"))]
pub use imp::{current, listen, push};

#[cfg(all(not(target_arch = "wasm32"), not(feature = "phone")))]
pub fn current() -> Route {
    Route::Overview
}

#[cfg(all(not(target_arch = "wasm32"), not(feature = "phone")))]
pub fn push(_r: &Route, _replace: bool) {}

/// Goes to a route inside the app: a new history entry, and the screen follows.
pub fn go(here: &mut dioxus::prelude::Signal<Route>, r: Route) {
    use dioxus::prelude::WritableExt;
    push(&r, false);
    here.set(r);
}

/// Changes the address without a new history entry (a sheet that was opened by the address closed).
pub fn replace(here: &mut dioxus::prelude::Signal<Route>, r: Route) {
    use dioxus::prelude::WritableExt;
    push(&r, true);
    here.set(r);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(host: &str, pane: &str, terminal: bool) -> Route {
        Route::Session { host: host.into(), pane: pane.into(), view: terminal.then_some(PaneView::Terminal) }
    }

    #[test]
    fn sessions_route_as_the_web_app_does() {
        assert_eq!(Route::parse("/next/m/box/p/12", ""), session("box", "%12", false));
        assert_eq!(Route::parse("/m/box/p/12", "?view=terminal"), session("box", "%12", true));
        assert_eq!(Route::parse("/next/m/hub%3Ah1%2Flaptop/p/%253", ""), session("hub:h1/laptop", "%3", false));
        assert_eq!(Route::parse("/next/m/box%20one/p/7/", "?a=1&view=terminal"), session("box one", "%7", true));
        // a terminal-first agent's chat is asked for by name
        assert_eq!(Route::parse("/next/m/box/p/4", "?view=chat"), Route::Session { host: "box".into(), pane: "%4".into(), view: Some(PaneView::Chat) });
        for other in ["/next", "/next/", "/next/m/box", "/nextcloud/m/a/p/1", "/next/machines/a/b"] {
            assert_eq!(Route::parse(other, ""), Route::Overview, "{other}");
        }
    }

    #[cfg(all(not(target_arch = "wasm32"), feature = "phone"))]
    #[test]
    fn the_android_page_records_each_move_in_its_history() {
        let r = Route::Machine { id: "box \"one\"".into() };
        assert_eq!(imp::history_js(&r, false, false, None), r#"history.pushState(null, '', "/next/machines/box%20%22one%22")"#);
        assert_eq!(imp::history_js(&Route::Overview, true, false, None), format!("history.replaceState(null, '', {:?})", Route::Overview.href()));
        // over a layer's entry the move is marked, and a tidied address keeps the entry's mark
        assert_eq!(imp::history_js(&Route::Settings, false, false, Some(7)), r#"history.pushState({inyonLayer: 7}, '', "/next/settings")"#);
        assert_eq!(imp::history_js(&Route::Settings, false, true, None), r#"history.replaceState(history.state, '', "/next/settings")"#);
    }

    #[test]
    fn machines_route_as_the_web_app_does() {
        assert_eq!(Route::parse("/next/machines", ""), Route::Machines { add: false });
        assert_eq!(Route::parse("/next/machines/", "?add=1"), Route::Machines { add: true });
        assert_eq!(Route::parse("/next/machines/hub%3Ah1%2Flaptop", ""), Route::Machine { id: "hub:h1/laptop".into() });
        assert_eq!(Route::Machine { id: "box one".into() }.href(), "/next/machines/box%20one");
        assert_eq!(internal("/next/machines?add=1"), Some(Route::Machines { add: true }));
    }

    #[test]
    fn pages_route_as_the_web_app_does() {
        assert_eq!(Route::parse("/next/blueprints", ""), Route::Pages { page: None });
        assert_eq!(Route::parse("/next/blueprints/hub%3Ah1%2Flocal/my-plan", ""), Route::Pages { page: Some(("hub:h1/local".into(), "my-plan".into())) });
        assert_eq!(Route::Pages { page: Some(("box one".into(), "plan".into())) }.href(), "/next/blueprints/box%20one/plan");
        assert_eq!(Route::Pages { page: None }.href(), "/next/blueprints");
        assert_eq!(Route::parse("/next/blueprints/a/b/c", ""), Route::Overview);
        // the address before 0.25 still opens them
        assert_eq!(Route::parse("/next/pages", ""), Route::Pages { page: None });
        assert_eq!(Route::parse("/next/pages/local/my-plan", ""), Route::Pages { page: Some(("local".into(), "my-plan".into())) });
        assert_eq!(Route::parse("/next/pages/a/b/c", ""), Route::Overview);
    }

    #[test]
    fn hrefs_go_back_to_the_same_route() {
        let chat = Route::Session { host: "box".into(), pane: "%4".into(), view: Some(PaneView::Chat) };
        for r in [
            Route::Overview,
            session("box 1", "%12", false),
            session("hub:h1/laptop", "%3", true),
            chat,
            Route::Machines { add: false },
            Route::Machine { id: "a/b c".into() },
            Route::Pages { page: None },
            Route::Pages { page: Some(("hub:h1/local".into(), "plan".into())) },
            Route::Settings,
            Route::Temp { host: None },
            Route::Temp { host: Some("hub:h1/box".into()) },
        ] {
            let href = r.href();
            assert!(href.starts_with("/next/"), "{href}");
            assert_eq!(internal(&href), Some(r));
        }
        assert_eq!(session("box", "%12", true).href(), "/next/m/box/p/12?view=terminal");
        // a section of Settings is the same screen, scrolled to it
        assert_eq!(internal("/next/settings#notifications"), Some(Route::Settings));
        // and the address keeps the section, so the screen scrolls to it
        assert_eq!(link_href(&Route::Settings, "/next/settings#blueprints"), "/next/settings#blueprints");
        assert_eq!(link_href(&Route::Settings, "/next/settings#"), "/next/settings");
        assert_eq!(link_href(&Route::Pages { page: None }, "/next/pages"), "/next/blueprints");
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
