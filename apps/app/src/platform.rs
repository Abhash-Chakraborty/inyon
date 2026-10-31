//! The few things the app asks of where it runs: the clock, saved settings, the theme. The browser
//! build uses the page; other builds (desktop, later Android) get plain stand-ins for now.

use crate::format::Clock;

#[cfg(target_arch = "wasm32")]
mod imp {
    use wasm_bindgen::{closure::Closure, JsCast};

    pub fn now() -> f64 {
        js_sys::Date::now()
    }

    pub fn tz_minutes() -> i32 {
        // getTimezoneOffset is UTC minus local
        -(js_sys::Date::new_0().get_timezone_offset() as i32)
    }

    pub fn random() -> f64 {
        js_sys::Math::random()
    }

    pub async fn sleep(ms: u32) {
        gloo_timers::future::TimeoutFuture::new(ms).await
    }

    fn storage() -> Option<web_sys::Storage> {
        web_sys::window()?.local_storage().ok().flatten()
    }

    pub fn load(key: &str) -> Option<String> {
        storage()?.get_item(key).ok().flatten()
    }

    pub fn save(key: &str, value: &str) {
        if let Some(s) = storage() {
            let _ = s.set_item(key, value);
        }
    }

    /// The theme the web app's setting asks for (`inyon.settings.v2`), or the system's.
    fn resolved(mq: &web_sys::MediaQueryList) -> &'static str {
        let setting =
            load("inyon.settings.v2").and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok()).and_then(|v| v.get("theme").and_then(|t| t.as_str()).map(str::to_owned));
        match setting.as_deref() {
            Some("light") => "light",
            Some("dark") => "dark",
            _ if mq.matches() => "dark",
            _ => "light",
        }
    }

    /// /theme.js (shared with the web app) sets the theme before the first paint; this keeps it in
    /// step when the system switches between light and dark.
    pub fn follow_theme() {
        let Some(win) = web_sys::window() else { return };
        let Ok(Some(mq)) = win.match_media("(prefers-color-scheme: dark)") else { return };
        let apply = {
            let mq = mq.clone();
            move || {
                let Some(root) = web_sys::window().and_then(|w| w.document()).and_then(|d| d.document_element()) else { return };
                let t = resolved(&mq);
                let _ = root.set_attribute("data-theme", t);
                if let Some(el) = root.dyn_ref::<web_sys::HtmlElement>() {
                    let _ = el.style().set_property("background", if t == "dark" { "#1b1a18" } else { "#e9e8e4" });
                }
            }
        };
        apply();
        let cb = Closure::<dyn Fn()>::new(apply);
        let _ = mq.add_event_listener_with_callback("change", cb.as_ref().unchecked_ref());
        cb.forget();
    }
}

#[cfg(not(target_arch = "wasm32"))]
mod imp {
    pub fn now() -> f64 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0.0, |d| d.as_millis() as f64)
    }

    pub fn tz_minutes() -> i32 {
        0
    }

    pub fn load(_key: &str) -> Option<String> {
        None
    }

    pub fn save(_key: &str, _value: &str) {}

    pub fn follow_theme() {}

    pub async fn sleep(_ms: u32) {}
}

pub use imp::{follow_theme, load, save, sleep};
#[cfg(target_arch = "wasm32")]
pub use imp::{now, random};

pub fn clock() -> Clock {
    Clock { now: imp::now(), tz_minutes: imp::tz_minutes() }
}
