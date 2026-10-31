//! `pending.ts`: messages sent from this device that the conversation doesn't show yet, and when
//! they can go.

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use inyon_protocol::{ChatItem, SendState, SendStatus};
use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::js::{cut16, len16, parse_date, squash_spaces, trim};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum PendingStatus {
    Sending,
    #[default]
    Sent,
    Failed,
}

/// Field names as the web app keeps them in session storage, so either app reads the other's.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingMessage {
    pub id: String,
    pub text: String,
    #[serde(default)]
    pub status: PendingStatus,
    /// unix ms
    pub at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// failed because the connection dropped, not because it was refused: sent again once it's back
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub retryable: bool,
    /// in the agent's queue: shown as a queued bubble instead
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub queued: bool,
    /// sent from another device; this one can only watch it
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub remote: bool,
}

impl PendingMessage {
    pub fn new(id: impl Into<String>, text: impl Into<String>, status: PendingStatus, at: u64) -> Self {
        PendingMessage { id: id.into(), text: text.into(), status, at, error: None, retryable: false, queued: false, remote: false }
    }
}

/// Whitespace collapsed and trimmed.
pub fn norm(s: &str) -> String {
    trim(&squash_spaces(s)).to_string()
}

static IMAGE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"<image\s+name=(\[Image #[0-9]+\])\s+path="([^"]+)">[\s\S]*?</image>"#).unwrap());
static ATTACHED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(Attached files:\s*)([\s\S]*)$").unwrap());
static LABEL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\[Image #[0-9]+\]").unwrap());
// `</?pasted_content\b[^>]*>` with JavaScript's ASCII word boundary
static PASTE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"</?pasted_content(?:[^A-Za-z0-9_>][^>]*)?>").unwrap());
static NOT_WORDS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[^\p{L}\p{N}!/]+").unwrap());

fn clean(s: &str) -> String {
    // Codex expands attachment paths into image envelopes and substitutes numbered labels.
    // Restore their paths before comparing; the full text and each attachment must still match.
    let mut images: HashMap<String, String> = HashMap::new();
    let s = IMAGE.replace_all(s, |c: &regex::Captures| {
        images.insert(c[1].to_string(), c[2].to_string());
        String::new()
    });
    let s = ATTACHED.replace(&s, |c: &regex::Captures| {
        let files = LABEL.replace_all(&c[2], |l: &regex::Captures| images.get(&l[0]).cloned().unwrap_or_else(|| l[0].to_string()));
        format!("{}{files}", &c[1])
    });
    let s = norm(&PASTE.replace_all(&s, ""));
    // "! ls" and "!ls" are the same shell command
    match s.strip_prefix('!') {
        Some(rest) => format!("!{}", rest.trim_start_matches(crate::js::is_space)),
        None => s,
    }
}

/// What two messages are compared by: the cleaned text, up to 400 characters.
pub fn msg_key(s: &str) -> String {
    cut16(&clean(s), 400).to_string()
}

/// A sent message the conversation still doesn't show after this long is marked failed.
pub const PENDING_MS: u64 = 10 * 60_000;

// A receipt and its message share their words. Spacing, quotes and markup can differ: agents
// rewrap pastes, and some swap straight quotes for curly ones.
fn loose(s: &str) -> String {
    NOT_WORDS.replace_all(&clean(s).to_lowercase(), "").into_owned()
}

// The transcript is stamped by the agent's machine and the message by this device; phones and
// laptops can be several seconds apart.
const SKEW_MS: f64 = 30_000.0;

/// Which of `pending` the items don't confirm, by index.
fn unconfirmed<'a>(pending: impl Iterator<Item = (usize, &'a PendingMessage)>, items: &[ChatItem]) -> HashSet<usize> {
    let mut receipts: Vec<(String, f64)> = items
        .iter()
        .filter_map(|item| match item {
            ChatItem::User { text, shell, ts, .. } => {
                let t = if *shell == Some(true) { format!("!{text}") } else { text.clone() };
                Some((loose(&t), parse_date(ts)))
            }
            ChatItem::Command { name, args, ts, .. } if !name.is_empty() => Some((loose(&format!("/{} {args}", name.trim_start_matches('/'))), parse_date(ts))),
            _ => None,
        })
        .collect();
    let mut left = HashSet::new();
    for (i, message) in pending {
        let text = loose(&message.text);
        // very long messages are cut short in some transcripts
        let found = receipts.iter().position(|(r, at)| *at >= message.at as f64 - SKEW_MS && (*r == text || (len16(r) >= 20_000 && text.starts_with(r.as_str()))));
        match found {
            Some(r) => {
                receipts.remove(r);
            }
            None => {
                left.insert(i);
            }
        }
    }
    left
}

/// Only a new transcript entry can confirm a send; consume each receipt at most once.
pub fn reconcile(pending: &[PendingMessage], items: &[ChatItem]) -> Vec<PendingMessage> {
    let left = unconfirmed(pending.iter().enumerate(), items);
    pending.iter().enumerate().filter(|(i, _)| left.contains(i)).map(|(_, p)| p.clone()).collect()
}

/// This device's sends that still need a bubble. The hub's ledger decides (it matched each send by
/// id against the agent's own record); comparing text with the conversation is only the fallback
/// for a send the hub isn't tracking, such as one from before a hub restart.
pub fn settle(pending: &[PendingMessage], items: &[ChatItem], sends: &[SendState]) -> Vec<PendingMessage> {
    let by_id: HashMap<&str, &SendState> = sends.iter().map(|s| (s.id.as_str(), s)).collect();
    let untracked = unconfirmed(pending.iter().enumerate().filter(|(_, p)| !by_id.contains_key(p.id.as_str())), items);
    pending
        .iter()
        .enumerate()
        .filter_map(|(i, p)| {
            let Some(s) = by_id.get(p.id.as_str()) else { return untracked.contains(&i).then(|| p.clone()) };
            match s.state {
                SendStatus::Delivered => None,
                SendStatus::Queued => Some(PendingMessage { queued: true, status: PendingStatus::Sent, ..p.clone() }),
                // the reply to the request can be lost (a phone asleep); the ledger still knows
                SendStatus::Failed if p.status == PendingStatus::Sent => Some(PendingMessage { status: PendingStatus::Failed, error: s.error.clone(), ..p.clone() }),
                _ => Some(PendingMessage { queued: false, ..p.clone() }),
            }
        })
        .collect()
}

/// Sends from other devices that haven't reached the agent yet, so every screen shows them.
pub fn others_sends(sends: &[SendState], mine: &[PendingMessage], now: u64) -> Vec<PendingMessage> {
    let ids: HashSet<&str> = mine.iter().map(|p| p.id.as_str()).collect();
    sends
        .iter()
        .filter(|s| !ids.contains(s.id.as_str()) && s.setting != Some(true) && matches!(s.state, SendStatus::Sending | SendStatus::Sent) && now.saturating_sub(s.at) < 5 * 60_000)
        .map(|s| {
            let status = if s.state == SendStatus::Sending { PendingStatus::Sending } else { PendingStatus::Sent };
            PendingMessage { remote: true, ..PendingMessage::new(&s.id, &s.text, status, s.at) }
        })
        .collect()
}

/// After a reload, the messages kept in session storage: a send that was still in flight may or
/// may not have arrived, so it says so; a failure keeps its reason, and anything older than the
/// pending window is dropped. `saved` is the stored JSON; anything malformed in it is skipped.
pub fn recover_pending(saved: &str, now: u64) -> Vec<PendingMessage> {
    let Ok(serde_json::Value::Array(list)) = serde_json::from_str::<serde_json::Value>(saved) else { return Vec::new() };
    list.into_iter()
        .filter_map(|v| serde_json::from_value::<PendingMessage>(v).ok())
        .filter(|p| now.saturating_sub(p.at) < PENDING_MS)
        .map(|p| match p.status {
            PendingStatus::Sending => PendingMessage { status: PendingStatus::Failed, error: Some("Delivery was interrupted. Check the terminal before retrying.".into()), ..p },
            _ => p,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{iso, item, T0};

    const T: u64 = T0 as u64;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static ID: AtomicUsize = AtomicUsize::new(0);
    fn msg(text: &str) -> PendingMessage {
        msg_at(text, T)
    }
    fn msg_at(text: &str, at: u64) -> PendingMessage {
        PendingMessage::new(format!("p{}", ID.fetch_add(1, Ordering::Relaxed) + 1), text, PendingStatus::Sent, at)
    }
    fn said(text: &str) -> ChatItem {
        said_at(text, T + 1000)
    }
    fn said_at(text: &str, at: u64) -> ChatItem {
        item::user_at(text, &iso(at as f64))
    }
    fn left(pending: &[PendingMessage], items: &[ChatItem]) -> Vec<String> {
        reconcile(pending, items).into_iter().map(|p| p.text).collect()
    }

    #[test]
    fn the_transcript_entry_confirms_the_bubble() {
        assert!(left(&[msg("fix the login bug")], &[said("fix the login bug")]).is_empty());
    }

    #[test]
    fn different_text_stays_pending() {
        assert_eq!(left(&[msg("fix the login bug")], &[said("fix the signup bug")]), ["fix the login bug"]);
    }

    #[test]
    fn an_older_identical_message_does_not_confirm_a_new_send() {
        assert_eq!(left(&[msg("yes")], &[said_at("yes", T - 60_000)]), ["yes"]);
    }

    #[test]
    fn clocks_a_few_seconds_apart_still_match() {
        assert!(left(&[msg("yes")], &[said_at("yes", T - 20_000)]).is_empty());
    }

    #[test]
    fn each_receipt_confirms_one_bubble_only() {
        let p = [msg("continue"), msg("continue")];
        assert_eq!(reconcile(&p, &[said("continue")]).iter().map(|m| m.id.clone()).collect::<Vec<_>>(), [p[1].id.clone()]);
        assert!(reconcile(&p, &[said("continue"), said_at("continue", T + 2000)]).is_empty());
    }

    #[test]
    fn spacing_case_quotes_and_paste_markup_do_not_matter() {
        let items = [said("Don’t   touch\n\n\"main\""), said("<pasted_content id=1>a long paste</pasted_content>")];
        assert!(left(&[msg("don't touch “main”"), msg("a long paste")], &items).is_empty());
    }

    #[test]
    fn shell_commands_match_with_or_without_the_space_after_the_bang() {
        let items = [item::shell_at("ls -la", &iso(T0 + 1000.0)), item::shell_at("pwd", &iso(T0 + 1000.0))];
        assert!(left(&[msg("!ls -la"), msg("! pwd")], &items).is_empty());
        // the same words without the shell flag are a different message
        assert_eq!(left(&[msg("!ls")], &[said("ls")]), ["!ls"]);
    }

    #[test]
    fn slash_commands_are_confirmed_by_command_entries() {
        let items = [item::command_at("model", "opus", None, &iso(T0 + 500.0)), item::command_at("/compact", "", None, &iso(T0 + 500.0))];
        assert!(left(&[msg("/model opus"), msg("/compact")], &items).is_empty());
    }

    #[test]
    fn nameless_command_output_confirms_nothing() {
        assert_eq!(left(&[msg("/")], &[item::command_at("", "", Some("out"), &iso(T0 + 500.0))]), ["/"]);
    }

    #[test]
    fn assistant_text_that_repeats_the_message_confirms_nothing() {
        let echo = item::text_at("repeat after me", &iso(T0 + 1000.0));
        assert_eq!(left(&[msg("repeat after me")], &[echo]), ["repeat after me"]);
    }

    #[test]
    fn a_very_long_message_cut_short_in_the_transcript_still_matches() {
        let long = "word ".repeat(10_000);
        assert!(left(&[msg(&long)], &[said(&long[..30_000])]).is_empty());
        // a short prefix is not enough (the cut is at 20k letters, spaces aside)
        assert_eq!(left(&[msg(&long)], &[said(&long[..500])]), [long]);
    }

    #[test]
    fn codex_image_envelopes_are_put_back_to_the_paths_that_were_sent() {
        let sent = "look at this\n\nAttached files:\n/tmp/uploads/a.png\n/tmp/uploads/b.txt";
        let codex = "<image name=[Image #1] path=\"/tmp/uploads/a.png\">\n</image>look at this\n\nAttached files:\n[Image #1]\n/tmp/uploads/b.txt";
        assert!(left(&[msg(sent)], &[said(codex)]).is_empty());
        let other = codex.replace("a.png\">", "z.png\">");
        assert_eq!(left(&[msg(sent)], &[said(&other)]), [sent]);
    }

    #[test]
    fn nothing_pending_nothing_to_do() {
        assert!(reconcile(&[], &[said("hi")]).is_empty());
    }

    #[test]
    fn norm_collapses_whitespace() {
        assert_eq!(norm("  a \n\t b  "), "a b");
    }

    #[test]
    fn msg_key_ignores_paste_markup_and_shell_spacing_and_caps_the_length() {
        assert_eq!(msg_key("<pasted_content>hi\nthere</pasted_content>"), "hi there");
        assert_eq!(msg_key("!  ls"), "!ls");
        assert_eq!(msg_key(&"x".repeat(1000)).len(), 400);
    }

    fn ledger(p: &PendingMessage, state: SendStatus) -> SendState {
        SendState { id: p.id.clone(), text: p.text.clone(), at: p.at, state, uuid: None, error: None, setting: None }
    }
    fn with_status(p: PendingMessage, status: PendingStatus) -> PendingMessage {
        PendingMessage { status, ..p }
    }

    #[test]
    fn delivered_drops_the_bubble_even_with_no_transcript_entry_yet() {
        let p = msg("ship it");
        assert!(settle(std::slice::from_ref(&p), &[], &[SendState { uuid: Some("x".into()), ..ledger(&p, SendStatus::Delivered) }]).is_empty());
    }

    #[test]
    fn a_delivered_send_drops_a_bubble_that_had_given_up() {
        let p = PendingMessage { error: Some("timed out".into()), ..with_status(msg("ship it"), PendingStatus::Failed) };
        assert!(settle(std::slice::from_ref(&p), &[], &[ledger(&p, SendStatus::Delivered)]).is_empty());
    }

    #[test]
    fn queued_marks_the_bubble_as_queued() {
        let p = with_status(msg("next"), PendingStatus::Sending);
        assert_eq!(settle(std::slice::from_ref(&p), &[], &[ledger(&p, SendStatus::Queued)]), [PendingMessage { status: PendingStatus::Sent, queued: true, ..p }]);
    }

    #[test]
    fn leaving_the_queue_unmarks_it() {
        let p = PendingMessage { queued: true, ..msg("next") };
        assert_eq!(settle(std::slice::from_ref(&p), &[], &[ledger(&p, SendStatus::Sent)]), [PendingMessage { queued: false, ..p }]);
    }

    #[test]
    fn failed_in_the_ledger_fails_a_bubble_that_thought_it_was_sent_with_the_reason() {
        let p = msg("do it");
        let s = SendState { error: Some("pane is gone".into()), ..ledger(&p, SendStatus::Failed) };
        assert_eq!(settle(std::slice::from_ref(&p), &[], &[s]), [PendingMessage { status: PendingStatus::Failed, error: Some("pane is gone".into()), ..p }]);
    }

    #[test]
    fn a_send_still_in_flight_keeps_its_bubble_as_it_is() {
        let p = with_status(msg("do it"), PendingStatus::Sending);
        assert_eq!(settle(std::slice::from_ref(&p), &[], &[ledger(&p, SendStatus::Sending)]), std::slice::from_ref(&p));
        let s = SendState { error: Some("x".into()), ..ledger(&p, SendStatus::Failed) };
        assert_eq!(settle(std::slice::from_ref(&p), &[], &[s]), [p]);
    }

    #[test]
    fn the_ledger_wins_over_matching_text() {
        let p = msg("yes");
        assert_eq!(settle(std::slice::from_ref(&p), &[said("yes")], &[ledger(&p, SendStatus::Sent)]), [p]);
    }

    #[test]
    fn a_send_the_ledger_does_not_track_falls_back_to_matching_text() {
        let (tracked, old, other) = (msg("one"), msg("two"), msg("three"));
        let kept = settle(&[tracked.clone(), old.clone(), other], &[said("two")], &[ledger(&tracked, SendStatus::Sent)]);
        assert_eq!(kept.iter().map(|p| p.text.as_str()).collect::<Vec<_>>(), ["one", "three"]);
        // no ledger at all (an older hub)
        assert!(settle(&[old], &[said("two")], &[]).is_empty());
    }

    #[test]
    fn a_tracked_send_does_not_use_up_anothers_transcript_entry() {
        let (a, b) = (msg("same"), msg("same"));
        // a is delivered by id; b is untracked and has its own receipt
        assert!(settle(&[a.clone(), b], &[said("same")], &[ledger(&a, SendStatus::Delivered)]).is_empty());
    }

    fn send(id: &str, state: SendStatus, age_ms: u64) -> SendState {
        SendState { id: id.into(), text: format!("text {id}"), at: T - age_ms, state, uuid: None, error: None, setting: None }
    }

    #[test]
    fn shows_other_devices_sends_that_havent_arrived_marked_remote() {
        let got = others_sends(&[send("a", SendStatus::Sending, 0), send("b", SendStatus::Sent, 60_000)], &[], T);
        assert_eq!(
            got,
            [
                PendingMessage { remote: true, ..PendingMessage::new("a", "text a", PendingStatus::Sending, T) },
                PendingMessage { remote: true, ..PendingMessage::new("b", "text b", PendingStatus::Sent, T - 60_000) },
            ]
        );
    }

    #[test]
    fn not_this_devices_own_nor_queued_delivered_or_failed_ones() {
        let mine = PendingMessage { id: "m".into(), ..msg("mine") };
        let sends = [send("m", SendStatus::Sending, 0), send("q", SendStatus::Queued, 0), send("d", SendStatus::Delivered, 0), send("f", SendStatus::Failed, 0)];
        assert!(others_sends(&sends, &[mine], T).is_empty());
    }

    #[test]
    fn a_setting_changed_with_the_apps_controls_is_never_shown_as_a_message() {
        let setting = SendState { text: "/model gpt-6.1-sol".into(), setting: Some(true), ..send("s", SendStatus::Sending, 0) };
        let ids: Vec<_> = others_sends(&[setting, send("a", SendStatus::Sending, 0)], &[], T).into_iter().map(|p| p.id).collect();
        assert_eq!(ids, ["a"]);
    }

    #[test]
    fn forgets_sends_older_than_five_minutes() {
        let ids: Vec<_> = others_sends(&[send("old", SendStatus::Sent, 5 * 60_000), send("new", SendStatus::Sent, 5 * 60_000 - 1)], &[], T).into_iter().map(|p| p.id).collect();
        assert_eq!(ids, ["new"]);
    }

    #[test]
    fn no_ledger_nothing_to_show() {
        assert!(others_sends(&[], &[], T).is_empty());
    }

    // store.test.ts: "pending messages"
    #[test]
    fn they_survive_a_reload_and_one_that_was_mid_send_says_delivery_was_interrupted() {
        let p = |text: &str, status: PendingStatus, error: Option<&str>| PendingMessage { error: error.map(str::to_string), ..PendingMessage::new(text, text, status, T) };
        let saved =
            serde_json::to_string(&[p("sending", PendingStatus::Sending, None), p("failed", PendingStatus::Failed, Some("boom")), p("sent", PendingStatus::Sent, None)]).unwrap();
        let got: Vec<_> = recover_pending(&saved, T + 60_000).into_iter().map(|m| (m.text, m.status, m.error)).collect();
        assert_eq!(
            got,
            [
                ("sending".to_string(), PendingStatus::Failed, Some("Delivery was interrupted. Check the terminal before retrying.".to_string())),
                ("failed".into(), PendingStatus::Failed, Some("boom".into())),
                ("sent".into(), PendingStatus::Sent, None),
            ]
        );
    }

    #[test]
    fn old_or_malformed_saved_messages_are_dropped() {
        let saved = serde_json::json!([
            { "id": "stale", "text": "stale", "status": "sent", "at": T },
            { "id": 1, "text": "bad" },
            null,
            { "id": "fresh", "text": "fresh", "status": "sent", "at": T + PENDING_MS },
        ]);
        let got: Vec<_> = recover_pending(&saved.to_string(), T + PENDING_MS + 1).into_iter().map(|m| m.text).collect();
        assert_eq!(got, ["fresh"]);
        assert!(recover_pending("{not json", T).is_empty());
    }

    #[test]
    fn the_saved_json_is_what_the_web_app_writes() {
        let p = PendingMessage { queued: true, ..PendingMessage::new("a", "hi", PendingStatus::Sent, 5) };
        assert_eq!(serde_json::to_string(&p).unwrap(), r#"{"id":"a","text":"hi","status":"sent","at":5,"queued":true}"#);
    }
}
