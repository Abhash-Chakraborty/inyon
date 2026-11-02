//! The page operations the screens need beyond what Dioxus does for them: reading and setting a
//! scroll position, focus, the clipboard, the page title. The browser build uses the page; other
//! builds do nothing for now.

#[cfg(target_arch = "wasm32")]
mod imp {
    use wasm_bindgen::closure::Closure;
    use wasm_bindgen::JsCast;

    fn el(id: &str) -> Option<web_sys::HtmlElement> {
        web_sys::window()?.document()?.get_element_by_id(id)?.dyn_into().ok()
    }

    /// `scrollTop`, `scrollHeight` and `clientHeight` of an element.
    pub fn scroll_metrics(id: &str) -> Option<(f64, f64, f64)> {
        let e = el(id)?;
        Some((e.scroll_top() as f64, e.scroll_height() as f64, e.client_height() as f64))
    }

    pub fn set_scroll_top(id: &str, top: f64) {
        if let Some(e) = el(id) {
            e.set_scroll_top(top.round() as i32);
        }
    }

    /// How far down its offset parent an element starts.
    pub fn offset_top(id: &str) -> Option<f64> {
        Some(el(id)?.offset_top() as f64)
    }

    pub fn focus(id: &str) {
        if let Some(e) = el(id) {
            let _ = e.focus();
        }
    }

    pub fn blur(id: &str) {
        if let Some(e) = el(id) {
            let _ = e.blur();
        }
    }

    /// A text box grows with its text up to `max_vh` of the screen, then scrolls.
    pub fn autosize(id: &str, max_vh: f64) {
        let Some(e) = el(id) else { return };
        let max = web_sys::window().and_then(|w| w.inner_height().ok()).and_then(|h| h.as_f64()).unwrap_or(800.0) * max_vh;
        let style = e.style();
        let _ = style.set_property("height", "0px");
        let h = e.scroll_height() as f64;
        let _ = style.set_property("height", &format!("{}px", h.min(max)));
        // phones round line heights, which leaves a 1px overflow and a pointless scrollbar
        let _ = style.set_property("overflow-y", if h > max + 1.0 { "auto" } else { "hidden" });
    }

    /// The window's inner width and height.
    pub fn viewport() -> (f64, f64) {
        let w = web_sys::window();
        let get = |v: Option<Result<wasm_bindgen::JsValue, wasm_bindgen::JsValue>>| v.and_then(|v| v.ok()).and_then(|v| v.as_f64());
        (get(w.as_ref().map(|w| w.inner_width())).unwrap_or(1024.0), get(w.as_ref().map(|w| w.inner_height())).unwrap_or(768.0))
    }

    /// The id of the element that has focus.
    pub fn active_id() -> Option<String> {
        let id = web_sys::window()?.document()?.active_element()?.id();
        (!id.is_empty()).then_some(id)
    }

    pub fn set_title(t: &str) {
        if let Some(d) = web_sys::window().and_then(|w| w.document()) {
            d.set_title(t);
        }
    }

    /// A phone or tablet: a touch screen as the main pointer.
    pub fn coarse() -> bool {
        web_sys::window().and_then(|w| w.match_media("(pointer: coarse)").ok().flatten()).is_some_and(|m| m.matches())
    }

    pub async fn copy(text: &str) -> bool {
        let Some(nav) = web_sys::window().map(|w| w.navigator()) else { return false };
        wasm_bindgen_futures::JsFuture::from(nav.clipboard().write_text(text)).await.is_ok()
    }

    /// The clipboard's text, when the browser lets the page read it.
    pub async fn paste() -> Option<String> {
        let nav = web_sys::window()?.navigator();
        wasm_bindgen_futures::JsFuture::from(nav.clipboard().read_text()).await.ok()?.as_string()
    }

    /// The page is on screen (not a background tab or a phone app in the background).
    pub fn visible() -> bool {
        web_sys::window().and_then(|w| w.document()).is_none_or(|d| d.visibility_state() != web_sys::VisibilityState::Hidden)
    }

    /// A short random id (a send's request id, a terminal's).
    pub fn random_id() -> String {
        let n = (js_sys::Math::random() * 2f64.powi(52)) as u64;
        format!("{n:x}")
    }

    /// An element's box on screen: left, top, right, bottom.
    pub fn rect(id: &str) -> Option<(f64, f64, f64, f64)> {
        let r = el(id)?.get_bounding_client_rect();
        Some((r.left(), r.top(), r.right(), r.bottom()))
    }

    /// Moves focus into a sheet that just opened: to the element marked `data-autofocus`, or the
    /// sheet itself, unless focus is in it already.
    pub fn focus_into(id: &str) {
        let Some(panel) = el(id) else { return };
        let doc = web_sys::window().and_then(|w| w.document());
        if doc.as_ref().and_then(|d| d.active_element()).is_some_and(|a| panel.contains(Some(&a))) {
            return;
        }
        let target = panel.query_selector("[data-autofocus]").ok().flatten().and_then(|e| e.dyn_into::<web_sys::HtmlElement>().ok());
        let _ = target.unwrap_or(panel).focus();
    }

    const FOCUSABLE: &str = "a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

    /// Tab and Shift+Tab go round inside a sheet: true when focus was moved here, so the key's own
    /// move must not happen.
    pub fn trap_tab(id: &str, back: bool) -> bool {
        let Some(panel) = el(id) else { return false };
        let Ok(list) = panel.query_selector_all(FOCUSABLE) else { return false };
        let all: Vec<web_sys::HtmlElement> = (0..list.length()).filter_map(|i| list.get(i)).filter_map(|n| n.dyn_into().ok()).collect();
        let active = web_sys::window().and_then(|w| w.document()).and_then(|d| d.active_element());
        let (Some(first), Some(last)) = (all.first(), all.last()) else {
            let _ = panel.focus();
            return true;
        };
        let at = |e: &web_sys::HtmlElement| active.as_ref().is_some_and(|a| a == e.unchecked_ref::<web_sys::Element>());
        let inside = active.as_ref().is_some_and(|a| panel.contains(Some(a)));
        let on_panel = active.as_ref().is_some_and(|a| a == panel.unchecked_ref::<web_sys::Element>());
        if !inside || (back && (at(first) || on_panel)) {
            let _ = if back { last.focus() } else { first.focus() };
            return true;
        }
        if !back && at(last) {
            let _ = first.focus();
            return true;
        }
        false
    }

    thread_local! {
        static OPENERS: std::cell::RefCell<Vec<web_sys::HtmlElement>> = const { std::cell::RefCell::new(Vec::new()) };
    }

    /// Remembers what had focus as a sheet opens…
    pub fn push_focus() {
        let el = web_sys::window().and_then(|w| w.document()).and_then(|d| d.active_element()).and_then(|e| e.dyn_into::<web_sys::HtmlElement>().ok());
        if let Some(el) = el {
            OPENERS.with(|o| o.borrow_mut().push(el));
        }
    }

    /// …and hands focus back to it as the sheet closes, if it's still on the page.
    pub fn pop_focus() {
        if let Some(el) = OPENERS.with(|o| o.borrow_mut().pop()) {
            if el.is_connected() {
                let _ = el.focus();
            }
        }
    }

    pub fn open_tab(url: &str) {
        if let Some(w) = web_sys::window() {
            let _ = w.open_with_url_and_target_and_features(url, "_blank", "noopener");
        }
    }

    /// This page's origin ("https://hub.example:4777") and host ("hub.example:4777").
    pub fn origin() -> String {
        web_sys::window().and_then(|w| w.location().origin().ok()).unwrap_or_default()
    }

    pub fn host() -> String {
        web_sys::window().and_then(|w| w.location().host().ok()).unwrap_or_default()
    }

    pub fn user_agent() -> String {
        web_sys::window().and_then(|w| w.navigator().user_agent().ok()).unwrap_or_default()
    }

    /// The browser thinks it has a network.
    pub fn online() -> bool {
        web_sys::window().is_none_or(|w| w.navigator().on_line())
    }

    /// Windows, going by the browser: only a guess at what the machine being added runs.
    pub fn windows() -> bool {
        user_agent().contains("Windows")
    }

    /// The theme on screen: what /theme.js and [`crate::platform::follow_theme`] put on the root.
    pub fn theme() -> &'static str {
        let t = web_sys::window().and_then(|w| w.document()).and_then(|d| d.document_element()).and_then(|r| r.get_attribute("data-theme"));
        if t.as_deref() == Some("dark") {
            "dark"
        } else {
            "light"
        }
    }

    fn post_theme_to(win: &web_sys::Window) {
        let msg = js_sys::Object::new();
        let _ = js_sys::Reflect::set(&msg, &"type".into(), &"theme".into());
        let _ = js_sys::Reflect::set(&msg, &"value".into(), &theme().into());
        let _ = win.post_message(&msg, "*");
    }

    fn page_frames() -> Vec<web_sys::HtmlIFrameElement> {
        let Some(list) = web_sys::window().and_then(|w| w.document()).and_then(|d| d.query_selector_all("iframe.page-frame").ok()) else { return vec![] };
        (0..list.length()).filter_map(|i| list.get(i)).filter_map(|n| n.dyn_into().ok()).collect()
    }

    /// Tells every page frame the app's theme; a page that knows the message follows it.
    pub fn post_theme_all() {
        for f in page_frames() {
            if let Some(w) = f.content_window() {
                post_theme_to(&w);
            }
        }
    }

    /// Tells one page frame the theme, as it loads a new document.
    pub fn post_theme(id: &str) {
        let f = web_sys::window().and_then(|w| w.document()).and_then(|d| d.get_element_by_id(id)).and_then(|e| e.dyn_into::<web_sys::HtmlIFrameElement>().ok());
        if let Some(w) = f.and_then(|f| f.content_window()) {
            post_theme_to(&w);
        }
    }

    /// Whether a message a page sent asks for the theme: `{ type: 'theme?' }` and nothing else
    /// counts (lib/pages.ts's frameMessage).
    pub fn asks_theme(data: &wasm_bindgen::JsValue) -> bool {
        data.is_object() && !js_sys::Array::is_array(data) && js_sys::Reflect::get(data, &"type".into()).ok().and_then(|t| t.as_string()).as_deref() == Some("theme?")
    }

    thread_local! {
        static LISTENING: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
        static SLASH: std::cell::RefCell<Option<String>> = const { std::cell::RefCell::new(None) };
        static WAKE: std::cell::RefCell<Vec<Box<dyn Fn()>>> = std::cell::RefCell::new(Vec::new());
        static RESIZE: std::cell::RefCell<Vec<Box<dyn Fn()>>> = std::cell::RefCell::new(Vec::new());
    }

    /// The page-wide listeners Pages needs, added once: a page frame asking for the theme (answered
    /// only when the message came from that frame's own window, never a frame inside it or another
    /// window), "/" to the filter, coming back into view, and the window's size.
    fn listen() {
        if LISTENING.with(|l| l.replace(true)) {
            return;
        }
        let Some(win) = web_sys::window() else { return };
        let msg = Closure::<dyn Fn(web_sys::MessageEvent)>::new(|e: web_sys::MessageEvent| {
            if !asks_theme(&e.data()) {
                return;
            }
            let Some(src) = e.source() else { return };
            for f in page_frames() {
                if let Some(w) = f.content_window() {
                    if wasm_bindgen::JsValue::from(w.clone()) == wasm_bindgen::JsValue::from(src.clone()) {
                        post_theme_to(&w);
                    }
                }
            }
        });
        let _ = win.add_event_listener_with_callback("message", msg.as_ref().unchecked_ref());
        msg.forget();
        let key = Closure::<dyn Fn(web_sys::KeyboardEvent)>::new(|e: web_sys::KeyboardEvent| {
            if e.key() != "/" || e.meta_key() || e.ctrl_key() || e.alt_key() {
                return;
            }
            let Some(target) = SLASH.with(|s| s.borrow().clone()) else { return };
            let typing = e.target().and_then(|t| t.dyn_into::<web_sys::Element>().ok()).is_some_and(|el| el.closest("input, textarea, [contenteditable]").ok().flatten().is_some());
            if typing {
                return;
            }
            e.prevent_default();
            focus(&target);
        });
        let _ = win.add_event_listener_with_callback("keydown", key.as_ref().unchecked_ref());
        key.forget();
        let wake = Closure::<dyn Fn()>::new(|| {
            if visible() {
                WAKE.with(|w| w.borrow().iter().for_each(|f| f()));
            }
        });
        let _ = win.add_event_listener_with_callback("focus", wake.as_ref().unchecked_ref());
        if let Some(d) = win.document() {
            let _ = d.add_event_listener_with_callback("visibilitychange", wake.as_ref().unchecked_ref());
        }
        wake.forget();
        let resize = Closure::<dyn Fn()>::new(|| RESIZE.with(|r| r.borrow().iter().for_each(|f| f())));
        let _ = win.add_event_listener_with_callback("resize", resize.as_ref().unchecked_ref());
        resize.forget();
    }

    /// Starts answering page frames that ask for the theme.
    pub fn answer_frames() {
        listen();
    }

    /// "/" focuses the element with this id, while one is set (the Pages filter on a wide screen).
    pub fn slash_focuses(id: Option<&str>) {
        listen();
        SLASH.with(|s| *s.borrow_mut() = id.map(str::to_string));
    }

    /// Calls `f` whenever the app comes back into view (window focus, the tab shown again).
    pub fn on_wake(f: impl Fn() + 'static) {
        listen();
        WAKE.with(|w| w.borrow_mut().push(Box::new(f)));
    }

    /// Calls `f` whenever the window changes size.
    pub fn on_resize(f: impl Fn() + 'static) {
        listen();
        RESIZE.with(|r| r.borrow_mut().push(Box::new(f)));
    }

    /// A tab opened at once, before the address it goes to is known: a browser blocks one opened
    /// after a wait (Open in browser mints a link first).
    pub struct PendingTab(Option<web_sys::Window>);

    impl PendingTab {
        pub fn open() -> PendingTab {
            let w = web_sys::window().and_then(|w| w.open_with_url_and_target("", "_blank").ok().flatten());
            if let Some(w) = &w {
                // the page can't reach back into the app
                let _ = js_sys::Reflect::set(w, &"opener".into(), &wasm_bindgen::JsValue::NULL);
            }
            PendingTab(w)
        }

        pub fn go(self, url: &str) {
            match self.0 {
                Some(w) => {
                    let _ = w.location().set_href(url);
                }
                None => open_tab(url),
            }
        }

        pub fn close(self) {
            if let Some(w) = self.0 {
                let _ = w.close();
            }
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
mod imp {
    pub fn scroll_metrics(_id: &str) -> Option<(f64, f64, f64)> {
        None
    }
    pub fn set_scroll_top(_id: &str, _top: f64) {}
    pub fn offset_top(_id: &str) -> Option<f64> {
        None
    }
    pub fn focus(_id: &str) {}
    pub fn blur(_id: &str) {}
    pub fn autosize(_id: &str, _max_vh: f64) {}
    pub fn viewport() -> (f64, f64) {
        (1024.0, 768.0)
    }
    pub fn active_id() -> Option<String> {
        None
    }
    pub fn set_title(_t: &str) {}
    pub fn coarse() -> bool {
        false
    }
    pub async fn copy(_text: &str) -> bool {
        false
    }
    // the terminal's paste, which only the browser build has
    #[allow(dead_code)]
    pub async fn paste() -> Option<String> {
        None
    }
    pub fn visible() -> bool {
        true
    }
    pub fn random_id() -> String {
        use std::sync::atomic::{AtomicU64, Ordering};
        static N: AtomicU64 = AtomicU64::new(1);
        format!("{:x}", N.fetch_add(1, Ordering::Relaxed))
    }
    pub fn rect(_id: &str) -> Option<(f64, f64, f64, f64)> {
        None
    }
    pub fn focus_into(_id: &str) {}
    pub fn trap_tab(_id: &str, _back: bool) -> bool {
        false
    }
    pub fn push_focus() {}
    pub fn pop_focus() {}
    pub fn open_tab(_url: &str) {}
    pub fn origin() -> String {
        String::new()
    }
    pub fn host() -> String {
        String::new()
    }
    pub fn user_agent() -> String {
        String::new()
    }
    pub fn online() -> bool {
        true
    }
    pub fn windows() -> bool {
        false
    }
    pub fn theme() -> &'static str {
        "light"
    }
    pub fn post_theme(_id: &str) {}
    pub fn answer_frames() {}
    pub fn slash_focuses(_id: Option<&str>) {}
    pub fn on_wake(_f: impl Fn() + 'static) {}
    pub fn on_resize(_f: impl Fn() + 'static) {}
    pub struct PendingTab;
    impl PendingTab {
        pub fn open() -> PendingTab {
            PendingTab
        }
        pub fn go(self, _url: &str) {}
        pub fn close(self) {}
    }
}

pub use imp::*;
