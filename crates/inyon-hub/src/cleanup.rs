//! Cleaning up old blueprints: a page whose tmux session and conversation are both gone, and that
//! hasn't changed for the days Settings gives (`pagesCleanupDays`, [`DEFAULT_DAYS`] unless set; 0
//! keeps every page), leaves the list as Remove takes it off: its links end and its folder stays.
//! The hub looks while an app is open, at most every [`EVERY_MS`], and keeps a note of what went
//! for the list to show (`GET /api/pages-cleaned`) until someone dismisses it. `POST
//! /api/pages-cleanup` does the same at once.
//!
//! Only a page whose session Inyon knows can go, and only while its machine is connected: a page
//! added by hand outside tmux, or one on a machine that's away, stays.

use axum::http::Method;
use inyon_core::config::load_settings;
use inyon_core::features::pages_core::LOCAL_HOST;
use inyon_core::features::pages_remote::tmux_of;
use inyon_core::hosts::http_error::HubResult;
use inyon_core::hosts::registry::registry;
use inyon_core::platform::store::kv;
use inyon_protocol::{HostState, HostStatus};
use serde_json::{json, Value};

use crate::http::{ok, ok_json, Req, Resp};
use crate::server::{guarded, h, Routes};

/// The store key that keeps the last clean-up's note, `{"at": ms, "days": n, "pages": [{host, slug, name, folder}]}`.
pub const CLEANED_KEY: &str = "page-cleaned";
/// Days a page with no session left stays unchanged before it goes, unless Settings says otherwise.
pub const DEFAULT_DAYS: u64 = 14;
/// The longest Settings may ask for.
pub const MAX_DAYS: u64 = 365;
/// How often the hub looks, at most, in ms.
pub const EVERY_MS: u64 = 60 * 60 * 1000;
/// How long after the hub starts it first looks, in ms, so its machines have said what runs on them.
pub const SETTLE_MS: u64 = 10 * 60 * 1000;
/// The most pages a note names.
const NOTE_MAX: usize = 50;
const DAY_MS: u64 = 24 * 60 * 60 * 1000;

/// The days from Settings: [`DEFAULT_DAYS`] when it isn't set, 0 when cleaning up is off.
pub fn days() -> u64 {
    days_of(load_settings().0.get("pagesCleanupDays"))
}

pub fn days_of(v: Option<&Value>) -> u64 {
    match v.and_then(Value::as_f64) {
        Some(n) if n.is_finite() && n >= 0.0 => (n.trunc() as u64).min(MAX_DAYS),
        _ => DEFAULT_DAYS,
    }
}

/// When a page last changed, as the app tells: its board's time, else when it was added.
pub fn changed_at(page: &Value) -> u64 {
    let added = page.get("added").and_then(Value::as_u64).unwrap_or(0);
    let board = page.get("progress").and_then(|p| p.get("updated")).and_then(Value::as_str).map(inyon_core::js::date::parse).filter(|t| t.is_finite() && *t > 0.0);
    board.map_or(added, |t| added.max(t as u64))
}

/// Whether a page's session is gone from its machine, as `state` (the machine now) shows it: its
/// conversation runs in no pane, and no tmux session has its name or its id (one under its id may
/// be the same session, renamed while the hub wasn't looking, so it counts). None when Inyon can't
/// tell: the page has no known session, or the machine isn't connected.
pub fn session_gone(page: &Value, state: &HostState) -> Option<bool> {
    if state.status != HostStatus::Online {
        return None;
    }
    let text = |k: &str| page.get(k).and_then(Value::as_str).filter(|s| !s.is_empty());
    let (session, tmux, tmux_id) = (text("session"), text("tmux"), text("tmuxId"));
    if session.is_none() && tmux.is_none() {
        return None;
    }
    let talking = session.is_some_and(|s| tmux_of(state, s, None).is_some());
    let running = state.sessions.iter().any(|t| tmux == Some(t.name.as_str()) || tmux_id == Some(t.id.as_str()));
    Some(!talking && !running)
}

/// The pages to clean up out of the list the API gives, by their machines now (`state_of`).
pub fn old(entries: &[Value], state_of: impl Fn(&str) -> Option<HostState>, now: u64, days: u64) -> Vec<Value> {
    if days == 0 {
        return vec![];
    }
    entries
        .iter()
        .filter(|p| now.saturating_sub(changed_at(p)) >= days * DAY_MS)
        .filter(|p| {
            let host = p.get("host").and_then(Value::as_str).unwrap_or(LOCAL_HOST);
            state_of(host).and_then(|s| session_gone(p, &s)) == Some(true)
        })
        .map(|p| json!({ "host": p["host"], "slug": p["slug"], "name": p["name"], "folder": p["folder"] }))
        .collect()
}

fn machine(host: &str) -> Option<HostState> {
    registry().get(host).map(|rt| rt.borrow().state.clone())
}

/// Takes the old pages off their lists, and answers with those that went.
pub async fn clean(days: u64, now: u64) -> Vec<Value> {
    let p = crate::pages::pages();
    let entries = crate::pages::entries(&p).await;
    let mut gone = vec![];
    for page in old(&entries, machine, now, days) {
        let (Some(host), Some(slug)) = (page["host"].as_str(), page["slug"].as_str()) else { continue };
        match crate::pages::take_off(&p, host, slug).await {
            Ok(()) => gone.push(page),
            Err(e) => inyon_core::platform::console::error(&format!("couldn't clean up {host}/{slug}: {}", e.message)),
        }
    }
    if !gone.is_empty() {
        crate::pages_stream::read();
    }
    gone
}

/// Adds what went to the note the list shows, newest first, with the days it went by.
pub fn note(gone: &[Value], now: u64, days: u64) {
    if gone.is_empty() {
        return;
    }
    let mut pages: Vec<Value> = gone.to_vec();
    if let Some(old) = kv::get_value(CLEANED_KEY).and_then(|v| v.get("pages").and_then(Value::as_array).cloned()) {
        pages.extend(old);
    }
    pages.truncate(NOTE_MAX);
    if let Err(e) = kv::set_value(CLEANED_KEY, &json!({ "at": now, "days": days, "pages": pages })) {
        inyon_core::platform::console::error(&format!("couldn't save the clean-up note: {e}"));
    }
}

/// The time to start [`auto`]'s clock from when the hub starts at `now`: the first look comes
/// [`SETTLE_MS`] later.
pub fn started(now: u64) -> u64 {
    now.saturating_sub(EVERY_MS - SETTLE_MS)
}

/// The automatic clean-up, from the hub's loop: every [`EVERY_MS`] at most, with a note.
pub async fn auto(last: &mut u64, now: u64) {
    if now.saturating_sub(*last) < EVERY_MS {
        return;
    }
    *last = now;
    let days = days();
    let gone = clean(days, now).await;
    note(&gone, now, days);
}

/// GET /api/pages-cleaned: the note, `{"at": ms, "days": n, "pages": [...]}`, or `{"pages": []}`.
pub(crate) async fn cleaned(_req: Req) -> HubResult<Resp> {
    Ok(ok_json(&kv::get_value(CLEANED_KEY).filter(Value::is_object).unwrap_or_else(|| json!({ "pages": [] }))))
}

/// DELETE /api/pages-cleaned: dismisses the note.
pub(crate) async fn dismiss(_req: Req) -> HubResult<Resp> {
    kv::del(CLEANED_KEY);
    Ok(ok())
}

/// POST /api/pages-cleanup: Settings' "Clean up now". Uses the days from Settings, or
/// [`DEFAULT_DAYS`] while the automatic clean-up is off, and answers with the pages that went.
pub(crate) async fn cleanup(_req: Req) -> HubResult<Resp> {
    let days = match days() {
        0 => DEFAULT_DAYS,
        n => n,
    };
    let gone = clean(days, inyon_core::clock::now_ms()).await;
    Ok(ok_json(&json!({ "pages": gone, "days": days })))
}

pub fn add(r: &mut Routes) {
    guarded(r, "/api/pages-cleaned", vec![(Method::GET, h(cleaned)), (Method::DELETE, h(dismiss))]);
    guarded(r, "/api/pages-cleanup", vec![(Method::POST, h(cleanup))]);
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 1_800_000_000_000;

    fn machine(status: &str) -> HostState {
        let pane = |conv: &str| {
            json!({ "id": "%1", "index": 0, "active": true, "command": "claude", "cwd": "/home/sam/shop", "title": "", "width": 80, "height": 24, "dead": false,
                "agent": { "kind": "claude", "pid": 1, "state": "idle", "sessionId": conv } })
        };
        serde_json::from_value(json!({
            "config": { "id": "laptop", "name": "laptop", "kind": "node" }, "status": status, "integration": "unknown", "tmux": "ok", "agents": [], "updatedAt": 0,
            "sessions": [{ "id": "$2", "name": "shop", "attached": 0, "windows": [{ "id": "@1", "index": 0, "name": "w", "active": true, "activity": 0, "panes": [pane("chat-live")] }] }]
        }))
        .unwrap()
    }

    fn page(slug: &str, days_ago: u64, owner: Value) -> Value {
        let mut p = json!({ "host": "laptop", "slug": slug, "name": slug, "folder": format!("/home/sam/{slug}"), "added": NOW - days_ago * DAY_MS });
        for (k, v) in owner.as_object().unwrap() {
            p[k] = v.clone();
        }
        p
    }

    #[test]
    fn a_blueprint_goes_once_its_session_is_gone_and_it_sat_unchanged_long_enough() {
        let on = |_: &str| Some(machine("online"));
        let gone = json!({ "session": "chat-old", "tmux": "cardboard", "tmuxId": "$9" });
        let pages = vec![
            page("old", 20, gone.clone()),
            page("recent", 3, gone.clone()),
            // its conversation still runs, or its tmux session does
            page("talking", 30, json!({ "session": "chat-live" })),
            page("tmux-alive", 30, json!({ "session": "chat-old", "tmux": "shop", "tmuxId": "$2" })),
            // a session under its id, or its name, may be the same one renamed: it stays
            page("id-alive", 30, json!({ "tmux": "cardboard", "tmuxId": "$2" })),
            page("name-alive", 30, json!({ "tmux": "shop", "tmuxId": "$7" })),
            // no session Inyon knows: added by hand, so it stays
            page("by-hand", 90, json!({})),
        ];
        let slugs = |v: Vec<Value>| v.iter().map(|p| p["slug"].as_str().unwrap().to_owned()).collect::<Vec<_>>();
        assert_eq!(slugs(old(&pages, on, NOW, 14)), ["old"]);
        assert_eq!(slugs(old(&pages, on, NOW, 2)), ["old", "recent"]);
        // off, or the machine away
        assert!(old(&pages, on, NOW, 0).is_empty());
        assert!(old(&pages, |_| Some(machine("error")), NOW, 14).is_empty());
        assert!(old(&pages, |_| None, NOW, 14).is_empty());
        // what the note keeps of each
        assert_eq!(old(&pages[..1], on, NOW, 14), [json!({ "host": "laptop", "slug": "old", "name": "old", "folder": "/home/sam/old" })]);
    }

    #[test]
    fn a_board_that_moved_counts_as_a_change() {
        let on = |_: &str| Some(machine("online"));
        let mut p = page("plan", 40, json!({ "session": "chat-old" }));
        p["progress"] = json!({ "done": 3, "total": 8, "updated": "2027-01-14T00:00:00Z" });
        // a day and 8 hours before NOW (2027-01-15 08:00 UTC)
        assert_eq!(changed_at(&p), NOW - DAY_MS - 8 * 60 * 60 * 1000);
        assert!(old(&[p.clone()], on, NOW, 14).is_empty());
        p["progress"]["updated"] = json!("not a time");
        assert_eq!(changed_at(&p), NOW - 40 * DAY_MS);
        assert_eq!(old(&[p], on, NOW, 14).len(), 1);
    }

    #[test]
    fn the_first_look_waits_for_the_machines_to_report() {
        let last = started(NOW);
        assert!(NOW + SETTLE_MS - last >= EVERY_MS);
        assert!(NOW + SETTLE_MS - 1 - last < EVERY_MS);
    }

    #[test]
    fn the_days_come_from_settings_with_a_default() {
        assert_eq!(days_of(None), DEFAULT_DAYS);
        assert_eq!(days_of(Some(&json!(30))), 30);
        assert_eq!(days_of(Some(&json!(0))), 0);
        assert_eq!(days_of(Some(&json!(7.9))), 7);
        assert_eq!(days_of(Some(&json!(-1))), DEFAULT_DAYS);
        assert_eq!(days_of(Some(&json!("x"))), DEFAULT_DAYS);
        assert_eq!(days_of(Some(&json!(1e9))), MAX_DAYS);
    }
}
