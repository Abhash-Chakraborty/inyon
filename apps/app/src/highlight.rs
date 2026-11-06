//! Colour for the code blocks in replies (Markdown.tsx with highlight.ts): highlight.js, from
//! hl/hl.ts, loaded the first time a block names a language, with each language's grammar fetched
//! the first time a block in it shows. A block in a language that isn't shipped, or one that's too
//! big, stays plain, and so does every block until its language is here.

use dioxus::prelude::*;

/// Above this many characters a block stays plain: highlighting it would hold up the page.
const MAX_CHARS: usize = 200_000;

/// How many grammars have arrived. Every block reads it, so one left plain because its own load
/// failed is coloured when another block brings the same language in, without fetching again.
pub static ARRIVED: GlobalSignal<u32> = Signal::global(|| 0);

/// The fence's language when a block of `code` in it should be coloured.
pub fn wanted<'a>(lang: Option<&'a str>, code: &str) -> Option<&'a str> {
    // characters, not bytes, so a block in another script gets the same room
    lang.map(str::trim).filter(|l| !l.is_empty() && !code.is_empty() && code.chars().count() <= MAX_CHARS)
}

/// The block's markup (escaped text in `hljs-*` spans) when highlight.js and the language are
/// already loaded; None otherwise, and then [`load`] fetches them.
pub fn now(lang: &str, code: &str) -> Option<String> {
    #[cfg(target_arch = "wasm32")]
    {
        js::now(lang, code)
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        let _ = (lang, code);
        None
    }
}

/// Fetches highlight.js and the language's grammar; true once [`now`] can colour a block in it.
pub async fn load(lang: &str) -> bool {
    #[cfg(target_arch = "wasm32")]
    {
        js::load(lang).await
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        let _ = lang;
        false
    }
}

#[cfg(target_arch = "wasm32")]
mod js {
    use wasm_bindgen::{JsCast, JsValue};

    /// `window.inyonHighlight`, once hl.ts has run.
    fn api() -> Option<JsValue> {
        let win: JsValue = web_sys::window()?.into();
        js_sys::Reflect::get(&win, &"inyonHighlight".into()).ok().filter(|v| !v.is_undefined())
    }

    fn method(api: &JsValue, name: &str) -> Option<js_sys::Function> {
        js_sys::Reflect::get(api, &name.into()).ok()?.dyn_into().ok()
    }

    pub fn now(lang: &str, code: &str) -> Option<String> {
        let api = api()?;
        method(&api, "now")?.call2(&api, &lang.into(), &code.into()).ok()?.as_string()
    }

    /// hl.ts, added to the page once; the page names its file (build.sh puts it in a meta tag).
    async fn script() -> Option<JsValue> {
        if let Some(a) = api() {
            return Some(a);
        }
        let doc = web_sys::window()?.document()?;
        let src = doc.query_selector("meta[name=inyon-hl]").ok().flatten()?.get_attribute("content")?;
        let script: web_sys::HtmlScriptElement = match doc.query_selector("script[data-inyon-hl]").ok().flatten() {
            Some(s) => s.unchecked_into(),
            None => {
                let s: web_sys::HtmlScriptElement = doc.create_element("script").ok()?.unchecked_into();
                s.set_type("module");
                s.set_src(&src);
                let _ = s.set_attribute("data-inyon-hl", "");
                // a script that fails is taken out by the page itself, so the next block tries
                // again even if the block that added it is gone before the error comes
                let gone = s.clone();
                let drop_it = wasm_bindgen::closure::Closure::once_into_js(move || gone.remove());
                let _ = s.add_event_listener_with_callback("error", drop_it.unchecked_ref());
                doc.head()?.append_child(&s).ok()?;
                s
            }
        };
        if let Some(a) = api() {
            return Some(a);
        }
        let done = js_sys::Promise::new(&mut |resolve, reject| {
            let _ = script.add_event_listener_with_callback("load", &resolve);
            let _ = script.add_event_listener_with_callback("error", &reject);
        });
        let _ = wasm_bindgen_futures::JsFuture::from(done).await;
        api()
    }

    pub async fn load(lang: &str) -> bool {
        let Some(api) = script().await else { return false };
        let Some(p) = method(&api, "load").and_then(|f| f.call1(&api, &lang.into()).ok()) else { return false };
        let Ok(p) = p.dyn_into::<js_sys::Promise>() else { return false };
        wasm_bindgen_futures::JsFuture::from(p).await.ok().and_then(|v| v.as_bool()).unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_named_language_and_a_block_of_sensible_size_get_colour() {
        assert_eq!(wanted(Some("rust"), "fn main() {}"), Some("rust"));
        assert_eq!(wanted(Some(" ts "), "let a = 1"), Some("ts"));
        assert_eq!(wanted(None, "plain"), None);
        assert_eq!(wanted(Some(""), "plain"), None);
        assert_eq!(wanted(Some("rust"), ""), None);
        assert_eq!(wanted(Some("json"), &"1".repeat(MAX_CHARS)), Some("json"));
        assert_eq!(wanted(Some("json"), &"1".repeat(MAX_CHARS + 1)), None);
        // counted in characters: 200,000 of a 3-byte one still fit
        assert_eq!(wanted(Some("text"), &"語".repeat(MAX_CHARS)), Some("text"));
        // nothing loads outside a browser, so a block there stays plain
        assert_eq!(now("rust", "fn main() {}"), None);
    }
}
