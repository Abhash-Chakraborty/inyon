//! The last overview and the last few chats, kept in the browser so a reload paints real content
//! in its first frame and the live data then replaces it in place (lib/snapshot.ts, under the same
//! keys, so the two apps on one hub share them). Nothing here is trusted beyond drawing: every
//! action still goes to the hub, and the next message from it wins.

use inyon_chat_core::chat_list::ChatSnapshot;
use inyon_protocol::HostState;
use serde::{de::DeserializeOwned, Deserialize, Serialize};

pub const OVERVIEW_KEY: &str = "inyon.overview.v1";
pub const CHAT_PREFIX: &str = "inyon.chat.v1.";
pub const CHAT_INDEX: &str = "inyon.chats.v1";
/// older than this and the picture is more misleading than helpful
pub const MAX_AGE_MS: f64 = 7.0 * 24.0 * 3_600_000.0;
/// a kept page is at most this long
pub const MAX_BYTES: usize = 300_000;
/// chats kept, most recently shown first
pub const CHATS_KEPT: usize = 3;
/// how long after a change the overview and a chat are written
pub const OVERVIEW_MS: u32 = 1000;
pub const CHAT_MS: u32 = 1500;

#[derive(Serialize)]
struct Out<'a, T> {
    at: f64,
    data: &'a T,
}

#[derive(Deserialize)]
struct In<T> {
    at: f64,
    data: T,
}

/// The stored form, `{at, data}`; none when it's too long to keep.
pub fn encode<T: Serialize>(data: &T, now: f64) -> Option<String> {
    let raw = serde_json::to_string(&Out { at: now, data }).ok()?;
    (raw.len() <= MAX_BYTES).then_some(raw)
}

/// What was kept, unless it's too old or can't be read.
pub fn decode<T: DeserializeOwned>(raw: &str, now: f64) -> Option<T> {
    let v: In<T> = serde_json::from_str(raw).ok()?;
    (now - v.at <= MAX_AGE_MS).then_some(v.data)
}

/// The chats kept after `key` was written: the index to store and the chats to forget.
pub fn chat_index(saved: Option<&str>, key: &str) -> (Vec<String>, Vec<String>) {
    let old: Vec<String> =
        saved.and_then(|s| serde_json::from_str::<Vec<serde_json::Value>>(s).ok()).unwrap_or_default().into_iter().filter_map(|v| v.as_str().map(str::to_owned)).collect();
    let mut all = vec![key.to_string()];
    all.extend(old.into_iter().filter(|k| k != key));
    let gone = all.split_off(CHATS_KEPT.min(all.len()));
    (all, gone)
}

/// What waits to be written.
pub enum Kept {
    Overview(Vec<HostState>),
    Chat(Box<ChatSnapshot>),
}

/// A sign-out in one tab, for the others: its time, so every sign-out changes it.
pub const SIGNED_OUT: &str = "inyon.signed-out.v1";

/// Queues a write: the newest data for a key, moved to the end, so the list is written in the
/// order things changed (and the chat changed last stays among the kept ones). True when the key
/// wasn't waiting yet.
pub fn queue<T>(list: &mut Vec<(String, T)>, key: &str, data: T) -> bool {
    let was = list.iter().position(|(k, _)| k == key).map(|i| list.remove(i)).is_some();
    list.push((key.to_string(), data));
    !was
}

#[cfg(target_arch = "wasm32")]
mod imp {
    use super::*;
    use std::cell::RefCell;
    use wasm_bindgen::{closure::Closure, JsCast};

    thread_local! {
        static WAITING: RefCell<Vec<(String, Kept)>> = const { RefCell::new(Vec::new()) };
    }

    fn storage() -> Option<web_sys::Storage> {
        web_sys::window()?.local_storage().ok().flatten()
    }

    fn read<T: DeserializeOwned>(key: &str) -> Option<T> {
        let raw = storage()?.get_item(key).ok().flatten()?;
        decode(&raw, js_sys::Date::now())
    }

    /// Whether it was kept (not when it's too long, or the browser is out of room).
    fn write<T: Serialize>(key: &str, data: &T) -> bool {
        let (Some(s), Some(raw)) = (storage(), encode(data, js_sys::Date::now())) else { return false };
        s.set_item(key, &raw).is_ok()
    }

    fn put(key: &str, kept: Kept) {
        match kept {
            Kept::Overview(hosts) => {
                write(key, &hosts);
            }
            // only the last few chats stay; the rest load from the hub as before. One that couldn't
            // be kept takes no other's place.
            Kept::Chat(chat) if write(key, &chat) => {
                let Some(s) = storage() else { return };
                let id = key.strip_prefix(CHAT_PREFIX).unwrap_or(key);
                let (index, gone) = chat_index(s.get_item(CHAT_INDEX).ok().flatten().as_deref(), id);
                for k in gone {
                    let _ = s.remove_item(&format!("{CHAT_PREFIX}{k}"));
                }
                let _ = s.set_item(CHAT_INDEX, &serde_json::to_string(&index).unwrap_or_default());
            }
            Kept::Chat(_) => {}
        }
    }

    fn take(key: &str) -> Option<Kept> {
        WAITING.with(|w| {
            let mut w = w.borrow_mut();
            let i = w.iter().position(|(k, _)| k == key)?;
            Some(w.remove(i).1)
        })
    }

    /// Writes a little after a change, at most once per wait, with the newest data then.
    fn later(key: String, ms: u32, kept: Kept) {
        if !WAITING.with(|w| queue(&mut w.borrow_mut(), &key, kept)) {
            return;
        }
        wasm_bindgen_futures::spawn_local(async move {
            gloo_timers::future::TimeoutFuture::new(ms).await;
            if let Some(kept) = take(&key) {
                put(&key, kept);
            }
        });
    }

    pub fn overview() -> Option<Vec<HostState>> {
        read(OVERVIEW_KEY)
    }

    pub fn save_overview(hosts: Vec<HostState>) {
        later(OVERVIEW_KEY.into(), OVERVIEW_MS, Kept::Overview(hosts));
    }

    pub fn chat(key: &str) -> Option<ChatSnapshot> {
        read(&format!("{CHAT_PREFIX}{key}"))
    }

    pub fn save_chat(key: &str, chat: ChatSnapshot) {
        later(format!("{CHAT_PREFIX}{key}"), CHAT_MS, Kept::Chat(Box::new(chat)));
    }

    /// Writes everything that is waiting now, in the order it changed (the page going away).
    pub fn flush() {
        let all: Vec<(String, Kept)> = WAITING.with(|w| std::mem::take(&mut *w.borrow_mut()));
        for (key, kept) in all {
            put(&key, kept);
        }
    }

    /// Signing out takes the pictures with it: every kept chat, listed or not (two tabs can each
    /// write the list), and what other tabs were about to write.
    pub fn clear() {
        WAITING.with(|w| w.borrow_mut().clear());
        let Some(s) = storage() else { return };
        let n = s.length().unwrap_or(0);
        let chats: Vec<String> = (0..n).filter_map(|i| s.key(i).ok().flatten()).filter(|k| k.starts_with(CHAT_PREFIX)).collect();
        for k in chats.iter().map(String::as_str).chain([CHAT_INDEX, OVERVIEW_KEY, "inyon.organize.v1"]) {
            let _ = s.remove_item(k);
        }
        let _ = s.set_item(SIGNED_OUT, &js_sys::Date::now().to_string());
    }

    /// A page hidden or going away writes what it was about to keep (a phone may close a hidden
    /// page without telling it); a sign-out in another tab drops it instead.
    pub fn install() {
        let Some(win) = web_sys::window() else { return };
        let leave = Closure::<dyn Fn(web_sys::Event)>::new(|e: web_sys::Event| {
            let hidden = web_sys::window().and_then(|w| w.document()).is_some_and(|d| d.visibility_state() == web_sys::VisibilityState::Hidden);
            if e.type_() == "pagehide" || hidden {
                flush();
            }
        });
        let _ = win.add_event_listener_with_callback("pagehide", leave.as_ref().unchecked_ref());
        if let Some(d) = win.document() {
            let _ = d.add_event_listener_with_callback("visibilitychange", leave.as_ref().unchecked_ref());
        }
        leave.forget();
        let other = Closure::<dyn Fn(web_sys::Event)>::new(|e: web_sys::Event| {
            let key = js_sys::Reflect::get(&e, &"key".into()).ok().and_then(|k| k.as_string());
            if key.as_deref() == Some(SIGNED_OUT) {
                WAITING.with(|w| w.borrow_mut().clear());
            }
        });
        let _ = win.add_event_listener_with_callback("storage", other.as_ref().unchecked_ref());
        other.forget();
    }
}

#[cfg(not(target_arch = "wasm32"))]
mod imp {
    use super::*;

    // the phone's core is in the app and answers at once; nothing to keep there
    pub fn overview() -> Option<Vec<HostState>> {
        None
    }
    pub fn save_overview(_hosts: Vec<HostState>) {}
    pub fn chat(_key: &str) -> Option<ChatSnapshot> {
        None
    }
    pub fn save_chat(_key: &str, _chat: ChatSnapshot) {}
    #[allow(dead_code)]
    pub fn flush() {}
    pub fn clear() {}
    pub fn install() {}
}

pub use imp::*;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_kept_copy_reads_back_until_it_is_a_week_old() {
        let raw = encode(&vec![1, 2, 3], 1000.0).unwrap();
        assert_eq!(raw, r#"{"at":1000.0,"data":[1,2,3]}"#);
        assert_eq!(decode::<Vec<u32>>(&raw, 1000.0 + MAX_AGE_MS), Some(vec![1, 2, 3]));
        assert_eq!(decode::<Vec<u32>>(&raw, 1001.0 + MAX_AGE_MS), None);
        // as the web app writes it (a whole number of ms)
        assert_eq!(decode::<Vec<u32>>(r#"{"at":5,"data":[4]}"#, 10.0), Some(vec![4]));
        assert_eq!(decode::<Vec<u32>>("not json", 0.0), None);
        assert_eq!(decode::<Vec<u32>>(r#"{"data":[4]}"#, 0.0), None);
    }

    #[test]
    fn a_page_too_long_to_keep_is_not_kept() {
        assert!(encode(&"x".repeat(MAX_BYTES), 0.0).is_none());
        assert!(encode(&"x".repeat(1000), 0.0).is_some());
    }

    #[test]
    fn only_the_last_three_chats_stay() {
        assert_eq!(chat_index(None, "a:%1"), (vec!["a:%1".into()], vec![]));
        let (index, gone) = chat_index(Some(r#"["b:%1","c:%1","d:%1"]"#), "a:%1");
        assert_eq!(index, vec!["a:%1", "b:%1", "c:%1"]);
        assert_eq!(gone, vec!["d:%1"]);
        // shown again: to the front, nothing forgotten
        let (index, gone) = chat_index(Some(r#"["b:%1","c:%1","a:%1"]"#), "a:%1");
        assert_eq!(index, vec!["a:%1", "b:%1", "c:%1"]);
        assert!(gone.is_empty());
        assert_eq!(chat_index(Some("{}"), "a").0, vec!["a"]);
    }

    #[test]
    fn writes_wait_in_the_order_things_changed() {
        let mut q: Vec<(String, u32)> = vec![];
        assert!(queue(&mut q, "a", 1));
        assert!(queue(&mut q, "b", 2));
        // a changed again: its newest data, and now the last to be written
        assert!(!queue(&mut q, "a", 3));
        assert_eq!(q, vec![("b".to_string(), 2), ("a".to_string(), 3)]);
    }

    #[test]
    fn the_web_apps_chat_page_reads() {
        let raw = r#"{"at":1,"data":{"items":[{"kind":"user","seq":0,"uuid":"u0","ts":"2026-10-31T12:00:00.000Z","text":"fix the build","images":0}],"hasMore":true}}"#;
        let chat: ChatSnapshot = decode(raw, 2.0).unwrap();
        assert_eq!(chat.items.len(), 1);
        assert!(chat.has_more);
        assert!(encode(&chat, 3.0).unwrap().contains(r#""hasMore":true"#));
    }
}
