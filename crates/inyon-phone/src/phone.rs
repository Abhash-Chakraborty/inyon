//! Port of apps/hub/src/phone/index.ts: the phone app runs Inyon's core itself, with no hub and no
//! password. The web app hands it a store and calls it in-process: `answer` for what would be an
//! /api request, `connect` for what would be the hub's WebSocket.
//!
//! Still to come over from the TS: SSH into servers through the native plugin, the link to paired
//! computers and the phone's own routes for both (adding, pairing, editing and removing them),
//! and push. Until then the phone's machine list is read and shown, but nothing reaches them.

use std::rc::Rc;

use inyon_api::clients::{self, ClientRef};
use inyon_api::http::{json, ok, ok_json, Req, Resp};
use inyon_api::routes::{raw, Route, Routes};
use inyon_core::claude::{drafts, watcher::watchers};
use inyon_core::hosts::registry::registry;
use inyon_core::platform::fetch::{use_fetcher, Fetcher};
use inyon_core::platform::store::{use_store, Store};
use serde_json::json;

use crate::tables::{find, Lookup};

/// What the platform gives the core; its runtime has to be installed on this thread first.
pub struct Options {
    pub store: Rc<dyn Store>,
    pub fetcher: Option<Rc<dyn Fetcher>>,
}

pub struct Phone {
    tables: Rc<[Routes; 2]>,
}

/// Starts the core: the records come from `store`, then the machines are watched and the
/// housekeeping timers run, as `startPhone` does.
pub fn start(o: Options) -> Phone {
    // records some modules read as they load, so the store goes in before anything else
    use_store(o.store);
    // the phone is no machine of its own: every machine on its list is reached from it
    inyon_core::config::set_local_host(None);
    use_fetcher(o.fetcher);
    let mut core = Routes::default();
    inyon_api::core_routes::add(&mut core);
    inyon_api::core_routes::start_core();
    Phone { tables: Rc::new([phone_routes(), core]) }
}

/// The routes the phone answers itself, ahead of the core's.
fn phone_routes() -> Routes {
    let mut r = Routes::default();
    // nothing to sign in to: the phone is the hub
    r.add("/api/session", Route::Any(raw(|_| async { ok_json(&json!({ "authed": true, "phone": true })) })));
    r.add("/api/logout", Route::Any(raw(|_| async { ok() })));
    r
}

impl Phone {
    /// Answers an /api request the way the hub would.
    pub async fn answer(&self, mut req: Req) -> Resp {
        match find(&self.tables[..], &req.path, &req.method) {
            Lookup::Handler(h, params) => {
                req.params = params;
                h(req).await
            }
            Lookup::NotAllowed => json(405, &json!({ "error": "Method not allowed" })),
            Lookup::NotFound => json(404, &json!({ "error": "Not found" })),
        }
    }

    /// A screen of the app connecting: it hears what it subscribes to through `send`, as JSON text.
    pub fn connect(&self, send: impl Fn(String) + 'static) -> ClientRef {
        let c = clients::new_client(move |msg| send(clients::wire(msg)));
        clients::add(&c);
        c
    }

    /// The app went to the background (true) or came back (false): poll less while hidden.
    pub fn background(&self, hidden: bool) {
        registry().quiet(hidden);
        watchers().quiet(hidden);
        registry().hold_alerts(hidden);
        // Android may close the app from the background: keep what each open chat has read,
        // drafts and how each machine looked
        drafts::save_drafts_at_once(hidden);
        if hidden {
            inyon_api::core_routes::save_everything();
        }
    }

    /// The app is back in the foreground: check connections now, don't wait out a backoff.
    pub fn resume(&self) {
        registry().quiet(false);
        watchers().quiet(false);
        registry().hold_alerts(false);
        // connections that died in the background fail their next command; probe now, not at the
        // next poll
        for c in registry().configs() {
            registry().refresh(&c.id, 0);
        }
    }
}

#[cfg(test)]
#[path = "phone_tests.rs"]
mod tests;
