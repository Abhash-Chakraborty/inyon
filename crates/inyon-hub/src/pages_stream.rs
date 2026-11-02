//! The `/ws2` pages stream's side in the hub: every machine's pages, read again when an app starts
//! following them, after a page is added or removed here, and every [`EVERY_MS`] while anyone
//! follows them, so `inyon pages add` and a moving board show up without the app asking.

use std::cell::Cell;

use inyon_api::streams;
use inyon_core::platform::rt::{sleep, spawn};
use inyon_protocol::PageEntry;
use serde_json::Value;

/// How often the pages are read again while an app follows them, in ms.
pub const EVERY_MS: u64 = 15_000;

thread_local! {
    /// reads started, so one that finishes after a later one is dropped
    static READS: Cell<u64> = const { Cell::new(0) };
}

/// The list as the API gives it, as the stream's rows: an entry this build can't read is left out.
pub fn rows(entries: Vec<Value>) -> Vec<PageEntry> {
    entries.into_iter().filter_map(|v| serde_json::from_value(v).ok()).collect()
}

/// Reads every machine's pages and hands them to the stream, while anyone follows it.
pub fn read() {
    if !streams::pages_followed() {
        return;
    }
    let n = READS.with(|r| {
        r.set(r.get() + 1);
        r.get()
    });
    spawn(async move {
        let entries = crate::pages::entries(&crate::pages::pages()).await;
        if READS.with(Cell::get) == n {
            streams::pages_changed(rows(entries));
        }
    });
}

/// Hooks the stream up: read when followed, and on a timer while it is.
pub fn start() {
    streams::on_pages_wanted(read);
    spawn(async {
        loop {
            sleep(EVERY_MS).await;
            read();
        }
    });
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    #[test]
    fn the_list_becomes_rows_and_an_entry_this_build_cant_read_is_left_out() {
        let ok = json!({ "host": "local", "slug": "plan", "name": "Plan", "project": "/p", "by": "cli", "added": 5, "folder": "/p/plan", "notes": ["a.md"] });
        let rows = super::rows(vec![ok, json!({ "host": "local" })]);
        assert_eq!(rows.len(), 1);
        assert_eq!((rows[0].slug.as_str(), rows[0].notes.clone()), ("plan", Some(vec!["a.md".to_string()])));
    }
}
