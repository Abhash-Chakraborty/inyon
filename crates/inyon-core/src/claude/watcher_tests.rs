//! claude/draft-sent.test.ts and claude/watcher-limits.test.ts. The TS spies on the registry; here
//! the machine is put in this thread's registry instead.

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use serde_json::json;

use super::*;
use crate::claude::transcript::Base;
use crate::test_support::fake::{ok, Fake};
use crate::test_support::rt::{run, wait};
use crate::test_support::{assert_match, machine};

/// A subscriber that keeps what it's sent.
#[derive(Default)]
struct Phone {
    got: RefCell<Vec<ServerMsg>>,
}

impl Subscriber for Phone {
    fn send(&self, msg: &ServerMsg) {
        self.got.borrow_mut().push(msg.clone());
    }
}

impl Phone {
    fn drafts(&self) -> Vec<(String, DraftSource)> {
        self.got
            .borrow()
            .iter()
            .filter_map(|m| match m {
                ServerMsg::ChatDraft { text, source, .. } => Some((text.clone(), *source)),
                _ => None,
            })
            .collect()
    }
}

const KEY: &str = "draft-test:%9";

fn draft_box() -> (Rc<Fake>, Rc<ChatWatcher>) {
    let fake = Fake::install(|_, _, _| ok(""));
    machine("draft-test", "local", json!([{ "id": "%9", "agent": { "kind": "claude", "pid": 7, "state": "idle" } }]));
    (fake, watchers().get("draft-test", "%9"))
}

fn draft(text: &str, at: f64, mirrored: Option<&str>) -> Option<Draft> {
    Some(Draft { text: text.into(), source: DraftSource::App, at, mirrored: mirrored.map(str::to_owned) })
}

// draft-sent.test.ts

#[test]
fn a_phone_keyboard_putting_a_sent_message_back_in_the_box_doesnt_make_it_a_draft_again() {
    run(|| async {
        let (_fake, w) = draft_box();
        let phone = Rc::new(Phone::default());
        let sub: Sub = phone.clone();
        w.subscribe(sub.clone());

        w.draft_from_app("I see only problem when I send", Some(&sub));
        w.draft_sent(Some("I see only problem when I send"), now_ms() - 1000);
        assert_eq!(get_draft(KEY), None);

        // a moment later the keyboard puts the message (or its last word) back, and the app passes it on
        phone.got.borrow_mut().clear();
        w.draft_from_app("I see only problem when I send", Some(&sub));
        w.draft_from_app("send", Some(&sub));
        assert_eq!(get_draft(KEY), None);
        // and that app is told the box is empty, so its own copy clears too
        assert_eq!(phone.drafts().into_iter().map(|d| d.0).collect::<Vec<_>>(), ["", ""]);

        // a new message is a draft as usual
        w.draft_from_app("and another thing", Some(&sub));
        assert_eq!(get_draft(KEY).map(|d| d.text).as_deref(), Some("and another thing"));
        watchers().stop(KEY);
    });
}

#[test]
fn finishing_a_send_keeps_a_new_draft_typed_meanwhile_even_one_that_starts_the_same_way() {
    run(|| async {
        let (_fake, w) = draft_box();
        let started_at = now_ms() - 2000;
        set_draft(KEY, draft("Fix", (started_at + 1) as f64, None));
        w.draft_sent(Some("Fix the login bug"), started_at);
        assert_eq!(get_draft(KEY).map(|d| d.text).as_deref(), Some("Fix"));
        // but the message itself, pushed just before the send and arriving after it began, goes
        set_draft(KEY, draft("Fix the login bug", (started_at + 1) as f64, None));
        w.draft_sent(Some("Fix the login bug\n\nAttached files:\n/x/a.png"), started_at);
        assert_eq!(get_draft(KEY), None);
        watchers().stop(KEY);
    });
}

#[test]
fn emptying_the_box_isnt_undone_by_a_screen_read_from_before_the_terminal_caught_up() {
    run(|| async {
        let (_fake, w) = draft_box();
        let phone = Rc::new(Phone::default());
        w.subscribe(phone.clone());
        set_draft(KEY, draft("old text here", now_ms() as f64, Some("old text here")));
        let read = |d: Option<&str>| {
            // a busy agent redraws all the time, so the screen is read again before the box is cleared
            let mut screen = blank_screen();
            screen.working = true;
            screen.width = 120;
            screen.input_visible = Some(true);
            screen.draft = d.map(str::to_owned);
            {
                let mut st = w.st.borrow_mut();
                st.screen = screen;
                st.mirroring_until = 0;
                st.sending_until = 0;
            }
            w.sync_draft_from_screen();
        };
        w.draft_from_app("", None);
        read(Some("old text here"));
        assert_eq!(get_draft(KEY).map(|d| d.text).unwrap_or_default(), "");
        assert!(phone.drafts().iter().all(|d| d.1 != DraftSource::Terminal));
        // once the terminal's box is empty too, nothing is left over
        read(None);
        assert_eq!(get_draft(KEY), None);
        // and typing at the terminal is still picked up
        read(Some("typed on the laptop"));
        assert_match(&get_draft(KEY), json!({ "text": "typed on the laptop", "source": "terminal" }));
        watchers().stop(KEY);
    });
}

// watcher-limits.test.ts

#[test]
fn in_the_background_an_open_chat_reads_its_screen_rarely_and_again_at_once_on_return() {
    run(|| async {
        let reads = Rc::new(Cell::new(0));
        let r = reads.clone();
        let _fake = Fake::install(move |_, cmd, _| {
            if cmd.contains("capture-pane") {
                r.set(r.get() + 1);
            }
            ok("")
        });
        machine("quiet-test", "local", json!([{ "id": "%7", "agent": { "kind": "claude", "pid": 7, "state": "idle" } }]));
        watchers().get("quiet-test", "%7");
        wait(2300).await;
        // in the foreground it's every 2 s
        assert!(reads.get() >= 2, "{}", reads.get());

        watchers().quiet(true);
        wait(100).await;
        reads.set(0);
        wait(2300).await;
        assert_eq!(reads.get(), 0);

        watchers().quiet(false);
        wait(100).await;
        assert_eq!(reads.get(), 1);
        watchers().stop("quiet-test:%7");
    });
}

#[test]
fn a_very_long_gemini_or_antigravity_chat_keeps_only_its_latest_messages_like_the_others() {
    run(|| async {
        let _fake = Fake::install(|_, _, _| ok(""));
        machine("quiet-test", "local", json!([{ "id": "%7", "agent": { "kind": "claude", "pid": 7, "state": "idle" } }]));
        let w = watchers().get("quiet-test", "%7");
        let base = Base::new("u", "t");
        let items: Vec<ChatItem> = (0..5000).map(|i| with_seq(base.with_uuid(format!("u{i}")).user(format!("message {i}"), 0), i)).collect();
        w.publish_snapshot(items);
        let held = w.items();
        assert_eq!(held.len(), 4000);
        assert!(matches!(held.last(), Some(ChatItem::User { text, .. }) if text == "message 4999"));
        watchers().stop("quiet-test:%7");
    });
}

// new-agent.test.ts

const NEW_KEY: &str = "new-agent-test:%5";

/// Claude as it is right after starting: no transcript until something is said.
fn new_agent_box(pid: u32, started_at: u64) {
    machine(
        "new-agent-test",
        "local",
        json!([{ "id": "%5", "title": "claude", "width": 100, "agent": { "kind": "claude", "pid": pid, "startedAt": started_at, "state": "idle" } }]),
    )
    .borrow_mut()
    .hold_polls();
}

fn said() -> Vec<ChatItem> {
    let base = Base::new("u", "t");
    vec![
        with_seq(base.with_uuid("u1").user("Hello", 0), 1),
        with_seq(base.with_uuid("a1").assistant("m1", None, inyon_protocol::AssistantBlock::Text { text: "Hi Abhash, what are you working on today?".into() }), 2),
    ]
}

/// A chat on this pane showing the first Claude's conversation.
fn chat_of_first() -> Rc<ChatWatcher> {
    new_agent_box(100, 1_000);
    let w = watchers().get("new-agent-test", "%5");
    {
        let mut st = w.st.borrow_mut();
        st.transcript = Some("/home/abhash/.claude/projects/x/old.jsonl".into());
        st.proc = Some("100:1000".into());
        st.reader = Some(crate::claude::transcript_tail::TranscriptReader::new(400));
        st.older_from = Some(0);
        st.items = said();
        st.ready = true;
    }
    w
}

fn texts(w: &ChatWatcher) -> Vec<String> {
    w.items()
        .iter()
        .filter_map(|i| match i {
            ChatItem::User { text, .. } => Some(text.clone()),
            ChatItem::Assistant { block: inyon_protocol::AssistantBlock::Text { text }, .. } => Some(text.clone()),
            _ => None,
        })
        .collect()
}

fn fresh_new_agent() {
    watchers().stop(NEW_KEY);
    WATCHERS.with(|w| w.parked.borrow_mut().shift_remove(NEW_KEY));
}

#[test]
fn a_chat_left_open_while_claude_exits_and_starts_again_empties_instead_of_showing_the_old_conversation() {
    run(|| async {
        let _fake = Fake::install(|_, _, _| ok(""));
        fresh_new_agent();
        let w = chat_of_first();
        let phone = Rc::new(Phone::default());
        w.subscribe(phone.clone());
        // the same Claude, its transcript not known for a moment: nothing changes
        w.sync();
        assert_eq!(texts(&w), ["Hello", "Hi Abhash, what are you working on today?"]);
        // a new Claude in the pane, nothing said to it yet
        new_agent_box(200, 2_000);
        phone.got.borrow_mut().clear();
        w.sync();
        assert!(texts(&w).is_empty());
        let resets: Vec<usize> = phone.got.borrow().iter().filter_map(|m| if let ServerMsg::ChatReset { items, .. } = m { Some(items.len()) } else { None }).collect();
        assert_eq!(resets, [0]);
        watchers().stop(NEW_KEY);
    });
}

#[test]
fn reopening_the_chat_later_shows_the_new_claude_empty_from_the_saved_copy_as_from_a_recently_closed_one() {
    run(|| async {
        let _fake = Fake::install(|_, _, _| ok(""));
        for from in ["recently closed", "saved copy"] {
            fresh_new_agent();
            chat_of_first().save();
            watchers().stop(NEW_KEY);
            if from == "saved copy" {
                WATCHERS.with(|w| w.parked.borrow_mut().shift_remove(NEW_KEY));
            }
            new_agent_box(200, 2_000);
            assert_eq!((from, texts(&watchers().get("new-agent-test", "%5"))), (from, vec![]));
            watchers().stop(NEW_KEY);
        }
    });
}

#[test]
fn the_same_claude_reopened_still_shows_its_conversation() {
    run(|| async {
        let _fake = Fake::install(|_, _, _| ok(""));
        for from in ["recently closed", "saved copy"] {
            fresh_new_agent();
            chat_of_first().save();
            watchers().stop(NEW_KEY);
            if from == "saved copy" {
                WATCHERS.with(|w| w.parked.borrow_mut().shift_remove(NEW_KEY));
            }
            new_agent_box(100, 1_000);
            assert_eq!((from, texts(&watchers().get("new-agent-test", "%5"))), (from, vec!["Hello".to_owned(), "Hi Abhash, what are you working on today?".to_owned()]));
            watchers().stop(NEW_KEY);
        }
    });
}
