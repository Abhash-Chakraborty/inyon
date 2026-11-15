//! `inyon notify` (from 0.27): a program or coding agent on the hub's machine or a joined one
//! tells you something, and every app and browser that hears this hub's notices gets it, titled
//! with the session it ran in. Tapping it opens that session, or the machine when it ran outside
//! one. The machine is the one whose token the request carries, never one the request names, and
//! each machine may send a few a minute.

use std::cell::RefCell;
use std::collections::{HashMap, VecDeque};

use inyon_core::clock::now_ms;
use inyon_core::hosts::http_error::{http, HubResult};
use inyon_core::hosts::registry::registry;
use inyon_protocol::{NotifyKind, ServerMsg};
use serde_json::{json, Value};

use crate::http::{json as answer_json, ok_json, Req, Resp};
use crate::machines::Caller;
use crate::server::{guarded, h, Routes};

/// How many notices one machine may send a minute.
pub const PER_MINUTE: usize = 5;
const WINDOW_MS: u64 = 60_000;
/// The longest message and title shown; longer ones are cut with an ellipsis.
pub const TEXT_MAX: usize = 500;
pub const TITLE_MAX: usize = 80;

thread_local! {
    /// when each machine's latest notices were sent, oldest first
    static SENT: RefCell<HashMap<String, VecDeque<u64>>> = RefCell::new(HashMap::new());
}

/// The machine a caller speaks for: the hub's own is `local`.
pub fn host_of(who: &Caller) -> &str {
    match who {
        Caller::Local => "local",
        Caller::Machine(id) => id,
    }
}

/// Counts one notice from `host` at `now`, or says how many ms until the next one may go.
pub fn take_turn(host: &str, now: u64) -> Result<(), u64> {
    SENT.with(|s| {
        let mut s = s.borrow_mut();
        let sent = s.entry(host.to_owned()).or_default();
        while sent.front().is_some_and(|at| *at + WINDOW_MS <= now) {
            sent.pop_front();
        }
        if sent.len() >= PER_MINUTE {
            return Err(sent.front().map_or(WINDOW_MS, |at| at + WINDOW_MS - now));
        }
        sent.push_back(now);
        Ok(())
    })
}

/// Text as a notification shows it: no control characters but line breaks (a tab is a space),
/// no space around it, and at most `max` characters, the last of them an ellipsis when it was cut.
pub fn clean(text: &str, max: usize) -> String {
    let kept: String = text.chars().map(|c| if c == '\t' { ' ' } else { c }).filter(|c| *c == '\n' || !c.is_control()).collect();
    let kept = kept.trim();
    if kept.chars().count() <= max {
        return kept.to_owned();
    }
    let cut: String = kept.chars().take(max - 1).collect();
    format!("{}…", cut.trim_end())
}

/// A pane id from what the command sent: `%12` from its `TMUX_PANE`, or `%2.12` for psmux, which
/// numbers panes per session; None for anything else.
pub fn pane_id(v: Option<&str>) -> Option<String> {
    let v = v?.trim();
    let id = v.strip_prefix('%').unwrap_or(v);
    let digits = |s: &str| !s.is_empty() && s.len() <= 9 && s.bytes().all(|b| b.is_ascii_digit());
    let ok = match id.split_once('.') {
        Some((s, p)) => digits(s) && digits(p),
        None => digits(id),
    };
    ok.then(|| format!("%{id}"))
}

/// The session a pane is in, as the app names it: the name you gave it in Inyon, else tmux's.
pub struct Where {
    pub pane: String,
    pub session: String,
}

/// The notice: titled with `title`, else the session, else the machine's name.
pub fn notice(host: &str, machine: &str, at: Option<&Where>, title: Option<&str>, text: &str) -> ServerMsg {
    let title = title.map(|t| clean(t, TITLE_MAX)).filter(|t| !t.is_empty());
    let title = title.or_else(|| at.map(|w| clean(&w.session, TITLE_MAX)).filter(|t| !t.is_empty())).unwrap_or_else(|| clean(machine, TITLE_MAX));
    ServerMsg::Notify { host: host.to_owned(), pane: at.map(|w| w.pane.clone()).unwrap_or_default(), kind: NotifyKind::Message, title, body: clean(text, TEXT_MAX), agent: None }
}

/// Where the pane is on `host`, if the hub knows it.
fn find(host: &str, pane: &str) -> Option<Where> {
    let f = registry().find_pane(host, pane)?;
    let session = f.pane.label.clone().filter(|l| !l.trim().is_empty()).unwrap_or(f.session.name.clone());
    Some(Where { pane: f.pane.id, session })
}

fn machine_name(host: &str) -> String {
    registry().configs().into_iter().find(|c| c.id == host).map(|c| c.name).filter(|n| !n.is_empty()).unwrap_or_else(|| host.to_owned())
}

/// `POST /api/notify` from the inyon command: `{ text, title?, pane? }`.
pub async fn route(req: &mut Req, who: &Caller) -> HubResult<Resp> {
    let b = req.json_body(16 * 1024).await?;
    let s = |k: &str| b.get(k).and_then(Value::as_str);
    let text = s("text").unwrap_or_default();
    if clean(text, TEXT_MAX).is_empty() {
        return Err(http(400, "Say what to tell you: inyon notify \"text\""));
    }
    let host = host_of(who);
    if let Err(wait) = take_turn(host, now_ms()) {
        let secs = wait.div_ceil(1000).max(1);
        return Ok(answer_json(
            429,
            &json!({ "error": format!("Too many notifications from this machine: {PER_MINUTE} a minute at most. Try again in {secs} s."), "reason": "rate", "retryAfter": secs }),
        ));
    }
    let at = pane_id(s("pane")).and_then(|p| find(host, &p));
    let msg = notice(host, &machine_name(host), at.as_ref(), s("title"), text);
    crate::clients::announce(&msg);
    let ServerMsg::Notify { pane, title, body, .. } = &msg else { unreachable!() };
    Ok(ok_json(&json!({
        "title": title,
        "body": body,
        "pane": (!pane.is_empty()).then_some(pane),
        "browsers": crate::push::registrations().len(),
        "apps": crate::clients::any(),
    })))
}

/// The route, so a request for it gets as far as the inyon command's checks (machines.rs), which
/// answer it; a browser or phone signed in to the hub is refused here.
pub fn add(routes: &mut Routes) {
    guarded(routes, "/api/notify", vec![(axum::http::Method::POST, h(|_r: Req| async move { Err(http(403, "Only the inyon command sends notifications: run inyon notify on the machine.")) }))]);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_is_cut_to_what_a_notification_shows() {
        assert_eq!(clean("  Deploy finished\tcheck staging \n", TEXT_MAX), "Deploy finished check staging");
        assert_eq!(clean("two\nlines\u{1b}[31m", TEXT_MAX), "two\nlines[31m");
        assert_eq!(clean("\u{7}\u{0}", TEXT_MAX), "");
        let long = "é".repeat(TEXT_MAX + 20);
        let cut = clean(&long, TEXT_MAX);
        assert_eq!(cut.chars().count(), TEXT_MAX);
        assert!(cut.ends_with('…'));
        assert_eq!(clean("abcdef", 4), "abc…");
        assert_eq!(clean("abcd", 4), "abcd");
    }

    #[test]
    fn only_a_pane_id_is_a_pane() {
        assert_eq!(pane_id(Some("%12")).as_deref(), Some("%12"));
        assert_eq!(pane_id(Some("7")).as_deref(), Some("%7"));
        assert_eq!(pane_id(Some("%2.12")).as_deref(), Some("%2.12"));
        for bad in ["", "%", "%1a", "$1", "%1;rm", "%12345678901", "%2.", "%.3", "%1.2.3"] {
            assert_eq!(pane_id(Some(bad)), None, "{bad}");
        }
        assert_eq!(pane_id(None), None);
    }

    #[test]
    fn the_notice_is_titled_with_the_session_else_the_machine() {
        let at = Where { pane: "%3".into(), session: "work".into() };
        let n = notice("laptop", "Laptop", Some(&at), None, "Deploy finished, check staging");
        assert_eq!(
            serde_json::to_value(&n).unwrap(),
            json!({ "t": "notify", "host": "laptop", "pane": "%3", "kind": "message", "title": "work", "body": "Deploy finished, check staging" })
        );
        let ServerMsg::Notify { pane, title, .. } = notice("laptop", "Laptop", None, None, "x") else { panic!() };
        assert_eq!((pane.as_str(), title.as_str()), ("", "Laptop"));
        let ServerMsg::Notify { title, .. } = notice("laptop", "Laptop", Some(&at), Some(" Build "), "x") else { panic!() };
        assert_eq!(title, "Build");
        // an empty --title is no title
        let ServerMsg::Notify { title, .. } = notice("laptop", "Laptop", Some(&at), Some(""), "x") else { panic!() };
        assert_eq!(title, "work");
        // the push the browsers get opens the session, or the machine
        let p = crate::push::payload_for("laptop", "%3", "message", "work", "x");
        assert_eq!((p["tag"].as_str(), p["href"].as_str()), (Some("laptop:%3"), Some("/m/laptop/p/3")));
        assert_eq!(crate::push::payload_for("laptop", "", "message", "Laptop", "x")["href"], "/machines/laptop");
    }

    #[test]
    fn each_machine_may_send_five_a_minute() {
        let t = 1_000_000;
        for i in 0..PER_MINUTE as u64 {
            assert_eq!(take_turn("pi", t + i * 1000), Ok(()));
        }
        assert_eq!(take_turn("pi", t + 10_000), Err(50_000));
        // another machine has its own count
        assert_eq!(take_turn("laptop", t + 10_000), Ok(()));
        // a minute after the first, one more may go
        assert_eq!(take_turn("pi", t + WINDOW_MS), Ok(()));
        assert_eq!(take_turn("pi", t + WINDOW_MS), Err(1000));
    }
}
