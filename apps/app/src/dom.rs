//! The page operations the screens need beyond what Dioxus does for them: reading and setting a
//! scroll position, focus, the clipboard, the page title. The browser build uses the page; other
//! builds do nothing for now.

#[cfg(target_arch = "wasm32")]
mod imp {
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

    /// Loads another page in place of this one (no history entry).
    pub fn go(href: &str) {
        if let Some(w) = web_sys::window() {
            let _ = w.location().replace(href);
        }
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

    /// A short random id (a send's request id, a terminal's).
    pub fn random_id() -> String {
        let n = (js_sys::Math::random() * 2f64.powi(52)) as u64;
        format!("{n:x}")
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
    pub fn go(_href: &str) {}
    pub fn set_title(_t: &str) {}
    pub fn coarse() -> bool {
        false
    }
    pub async fn copy(_text: &str) -> bool {
        false
    }
    pub fn random_id() -> String {
        use std::sync::atomic::{AtomicU64, Ordering};
        static N: AtomicU64 = AtomicU64::new(1);
        format!("{:x}", N.fetch_add(1, Ordering::Relaxed))
    }
}

pub use imp::*;
