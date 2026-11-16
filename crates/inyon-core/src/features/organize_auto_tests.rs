//! What the hub does on its own: messages sent later go once, and once only across a restart;
//! idle agents sleep after their rule's minutes and not before; sessions close once done; and the
//! saved prompts' limits.

use std::cell::RefCell;
use std::rc::Rc;

use serde_json::{json, Value};

use super::auto::{self, Act, CARRIED_ON, CLOSE_SETTLE_MS};
use super::*;
use crate::clock::set_now;
use crate::hosts::host::Host;
use crate::hosts::registry::HostRuntime;
use crate::test_support::rt::run;
use inyon_protocol::SendAuto;

const T: u64 = 1_790_000_000_000;
const MIN: u64 = 60_000;

/// A pane: its id, folder, agent's conversation (None: a plain shell) and the agent's state.
type Pane<'a> = (&'a str, &'a str, Option<&'a str>, &'a str);

/// A machine "box" with one tmux session `$1` holding `panes`.
fn machine(panes: &[Pane]) -> HostState {
    let panes: Vec<Value> = panes
        .iter()
        .enumerate()
        .map(|(i, (pane, cwd, conv, state))| {
            let mut p =
                json!({ "id": pane, "index": i, "active": i == 0, "command": "claude", "cwd": cwd, "title": format!("✳ Task {pane}"), "width": 100, "height": 30, "dead": false });
            if let Some(c) = conv {
                p["agent"] = json!({ "kind": "claude", "pid": 1, "state": state });
                if !c.is_empty() {
                    p["agent"]["sessionId"] = json!(c);
                }
            }
            p
        })
        .collect();
    serde_json::from_value(
        json!({ "config": { "id": "box", "name": "Box", "kind": "ssh" }, "status": "online", "integration": "unknown", "tmux": "ok", "agents": [], "updatedAt": 0,
        "sessions": [{ "id": "$1", "name": "work", "attached": 0, "windows": [{ "id": "@1", "index": 0, "name": "w", "active": true, "activity": 0, "panes": panes }] }] }),
    )
    .unwrap()
}

/// The machine as the registry has it now; returns it for the checks that take the machines.
fn put(panes: &[Pane]) -> Vec<HostState> {
    put_state(machine(panes))
}

/// The same, with more on one pane's agent (`extra`: a failure, live numbers, another kind).
fn put_agent(panes: &[Pane], pane: &str, extra: Value) -> Vec<HostState> {
    let mut v = serde_json::to_value(machine(panes)).unwrap();
    for p in v["sessions"][0]["windows"][0]["panes"].as_array_mut().unwrap() {
        if p["id"] == pane {
            for (k, x) in extra.as_object().unwrap() {
                p["agent"][k] = x.clone();
            }
        }
    }
    put_state(serde_json::from_value(v).unwrap())
}

fn put_state(state: HostState) -> Vec<HostState> {
    let rt = Rc::new(RefCell::new(HostRuntime::new(Host::new(state.config.clone()), state.clone())));
    rt.borrow_mut().hold_polls();
    registry().insert_runtime("box", rt);
    reconcile(std::slice::from_ref(&state));
    vec![state]
}

/// A fresh record, and every hand-off written down instead of done; `fail` makes them fail.
fn fresh(fail: Option<&'static str>) -> Rc<RefCell<Vec<Act>>> {
    reset();
    kv::del(KEY);
    set_now(Some(T));
    let acts = Rc::new(RefCell::new(vec![]));
    let a = acts.clone();
    auto::set_actions(Some(Rc::new(move |x: &Act| {
        a.borrow_mut().push(x.clone());
        fail.map_or(Ok(()), |m| Err(http(409, m)))
    })));
    acts
}

fn hold(pane: &str, text: &str) -> Act {
    Act::Hold { host: "box".into(), pane: pane.into(), text: text.into() }
}

#[test]
fn a_message_sent_later_goes_once_at_its_time_and_never_again_after_a_restart() {
    run(|| async {
        let acts = fresh(None);
        let hosts = put(&[("%3", "/w/inyon", Some("conv-a"), "idle")]);
        let s = auto::add_send("box", "%3", &json!({ "text": "run the tests\n", "at": T + 10 * MIN }), T).unwrap();
        assert_eq!((s.text.as_str(), s.conv.as_deref(), s.tmux_id.as_deref()), ("run the tests", Some("conv-a"), Some("$1")));
        assert!(for_overview().sends.is_some(), "the v1 overview has them, so an app can show them");

        assert!(!auto::send_due(T + 9 * MIN, &hosts));
        assert!(acts.borrow().is_empty(), "not before its time");
        // the hand-off sees it gone from the record already: stopping right after can't send it twice
        auto::set_actions(Some(Rc::new({
            let acts = acts.clone();
            move |x: &Act| {
                assert!(kv::get_value(KEY).unwrap().get("sends").is_none(), "written down before it's handed on");
                acts.borrow_mut().push(x.clone());
                Ok(())
            }
        })));
        assert!(auto::send_due(T + 10 * MIN, &hosts));
        assert_eq!(*acts.borrow(), vec![hold("%3", "run the tests")]);

        // the hub restarts: nothing goes again
        reset();
        auto::send_due(T + 20 * MIN, &hosts);
        auto::send_due(T + 30 * MIN, &hosts);
        assert_eq!(acts.borrow().len(), 1);
        assert_eq!(get().sends, None);
    });
}

#[test]
fn a_message_follows_its_conversation_and_waits_with_the_reason_when_it_cant_go() {
    run(|| async {
        let acts = fresh(None);
        put(&[("%3", "/w/inyon", Some("conv-a"), "idle"), ("%4", "/w", Some("conv-b"), "idle")]);
        auto::add_send("box", "%3", &json!({ "text": "a", "at": T + MIN }), T).unwrap();
        auto::add_send("box", "%4", &json!({ "text": "b", "at": T + MIN }), T).unwrap();
        // conv-a was resumed in %9; conv-b's agent is gone, and %4 with it
        let hosts = put(&[("%9", "/w/inyon", Some("conv-a"), "idle")]);
        auto::send_due(T + MIN, &hosts);
        assert_eq!(*acts.borrow(), vec![hold("%9", "a")]);
        let left = get().sends.unwrap();
        assert_eq!((left.len(), left[0].error.as_deref()), (1, Some("The session isn't there any more")));
        // kept to edit or dismiss, never tried again by itself
        auto::send_due(T + 2 * MIN, &hosts);
        assert_eq!(acts.borrow().len(), 1);
        auto::remove_send(&left[0].id).unwrap();
        assert_eq!(get().sends, None);
    });
}

#[test]
fn a_message_the_held_queue_refuses_comes_back_with_the_reason() {
    run(|| async {
        let acts = fresh(Some("50 messages are held for this session already. Send or drop some first."));
        let hosts = put(&[("%3", "/w/inyon", Some("conv-a"), "idle")]);
        let s = auto::add_send("box", "%3", &json!({ "text": "a", "at": T + MIN }), T).unwrap();
        auto::send_due(T + MIN, &hosts);
        let left = get().sends.unwrap();
        assert_eq!((left[0].id.as_str(), left[0].error.as_deref()), (s.id.as_str(), Some("50 messages are held for this session already. Send or drop some first.")));
        auto::send_due(T + 2 * MIN, &hosts);
        assert_eq!(acts.borrow().len(), 1);
        // edited: it can go again at the new time
        auto::update_send(&s.id, &json!({ "at": T + 5 * MIN }), T + 2 * MIN).unwrap();
        assert_eq!(get().sends.unwrap()[0].error, None);
    });
}

#[test]
fn messages_sent_later_are_checked() {
    run(|| async {
        fresh(None);
        put(&[("%3", "/w/inyon", Some("conv-a"), "idle"), ("%4", "/w", None, "idle")]);
        let err = |b: Value, pane: &str| auto::add_send("box", pane, &b, T).unwrap_err();
        assert_eq!(err(json!({ "text": "a", "at": T }), "%3").message, "Pick a time in the future to send it");
        assert_eq!(err(json!({ "text": "a", "at": T + 367 * 24 * 60 * MIN }), "%3").message, "A message can wait a year at most");
        assert_eq!(err(json!({ "text": "  ", "at": T + MIN }), "%3").message, "Message is empty");
        assert_eq!(err(json!({ "text": "x".repeat(4_001), "at": T + MIN }), "%3").message, "A message can be at most 4000 characters");
        assert_eq!(err(json!({ "text": "a", "at": T + MIN }), "%4").status, Some(409));
        assert_eq!(err(json!({ "text": "a", "at": T + MIN }), "%99").status, Some(404));
        for _ in 0..inyon_protocol::MAX_SENDS {
            auto::add_send("box", "%3", &json!({ "text": "a", "at": T + MIN }), T).unwrap();
        }
        assert_eq!(err(json!({ "text": "a", "at": T + MIN }), "%3").status, Some(409));
    });
}

#[test]
fn an_idle_agent_sleeps_after_its_rules_minutes_and_only_once() {
    run(|| async {
        let acts = fresh(None);
        let sleep = |pane: &str| Act::Sleep { host: "box".into(), pane: pane.into() };
        let panes = [("%3", "/w/inyon", Some("conv-a"), "idle"), ("%4", "/w/other", Some("conv-b"), "idle"), ("%5", "/w", Some(""), "idle")];
        let hosts = put(&panes);
        // off unless asked for
        auto::check_agents(T, &hosts);
        auto::check_agents(T + 600 * MIN, &hosts);
        assert!(acts.borrow().is_empty());

        assert_eq!(auto::set_sleep(&json!({ "minutes": 3 })).unwrap_err().message, "Pick between 5 minutes and 24 hours");
        auto::set_sleep(&json!({ "scope": "all", "minutes": 10 })).unwrap();
        let p = add_project(&json!({ "name": "Inyon", "roots": [{ "host": "box", "path": "/w/inyon" }] })).unwrap();
        auto::set_sleep(&json!({ "scope": p.id, "minutes": 30 })).unwrap();
        // idle since T: past 10 minutes, so %4 sleeps at the first look; %5 has no conversation to
        // come back to, so it stays, and %3's project gives it 30 minutes
        let hosts = put(&[("%3", "/w/inyon", Some("conv-a"), "working"), panes[1], panes[2]]);
        auto::check_agents(T + 601 * MIN, &hosts);
        assert_eq!(*acts.borrow(), vec![sleep("%4")]);
        auto::check_agents(T + 602 * MIN, &hosts);
        assert_eq!(acts.borrow().len(), 1, "once");
        let hosts = put(&panes);
        auto::check_agents(T + 610 * MIN, &hosts);
        auto::check_agents(T + 639 * MIN, &hosts);
        assert_eq!(acts.borrow().len(), 1, "not before its project's 30 minutes");
        auto::check_agents(T + 640 * MIN, &hosts);
        assert_eq!(*acts.borrow(), vec![sleep("%4"), sleep("%3")]);

        // work starts the count again, and a pinned session stays awake
        acts.borrow_mut().clear();
        mark_pane("box", "%4", &SessionPatch { pinned: Some(true), ..Default::default() }).unwrap();
        let busy = put(&[("%3", "/w/inyon", Some("conv-a"), "working"), ("%4", "/w/other", Some("conv-b"), "idle")]);
        auto::check_agents(T + 640 * MIN, &busy);
        let hosts = put(&panes);
        auto::check_agents(T + 650 * MIN, &hosts);
        auto::check_agents(T + 679 * MIN, &hosts);
        assert!(acts.borrow().is_empty());
        auto::check_agents(T + 680 * MIN, &hosts);
        assert_eq!(*acts.borrow(), vec![sleep("%3")]);

        // a project that goes takes its rule with it
        remove_project(&p.id).unwrap();
        assert_eq!(get().sleep.unwrap(), vec![inyon_protocol::SleepRule { scope: "all".into(), minutes: 10 }]);
    });
}

#[test]
fn a_session_closes_once_its_next_work_is_done_even_across_a_restart() {
    run(|| async {
        let acts = fresh(None);
        let end = Act::End { host: "box".into(), pane: "%3".into() };
        let idle = put(&[("%3", "/w/inyon", Some("conv-a"), "idle")]);
        let m = mark_pane("box", "%3", &SessionPatch::read(&json!({ "closeWhenDone": true }), T).unwrap()).unwrap().unwrap();
        assert_eq!((m.close_when_done, m.close_saw_work), (Some(true), None));
        // idle already: it waits for the next piece of work
        auto::check_agents(T, &idle);
        auto::check_agents(T + MIN, &idle);
        assert!(acts.borrow().is_empty());

        let working = put(&[("%3", "/w/inyon", Some("conv-a"), "working")]);
        auto::check_agents(T + 2 * MIN, &working);
        assert_eq!(kv::get_value(KEY).unwrap()["sessions"][0]["closeSawWork"], json!(true), "written down");

        // the hub restarts while the agent works; it finishes after
        reset();
        let idle = put(&[("%3", "/w/inyon", Some("conv-a"), "idle")]);
        auto::check_agents(T + 3 * MIN, &idle);
        assert!(acts.borrow().is_empty(), "idle for a moment first");
        auto::check_agents(T + 3 * MIN + CLOSE_SETTLE_MS, &idle);
        assert_eq!(*acts.borrow(), vec![end.clone()]);
        assert!(get().sessions.is_empty(), "nothing else was kept on it");
        auto::check_agents(T + 4 * MIN, &idle);
        assert_eq!(acts.borrow().len(), 1, "once");
    });
}

#[test]
fn saved_prompts_are_kept_ordered_and_checked() {
    run(|| async {
        fresh(None);
        let p = add_project(&json!({ "name": "Inyon" })).unwrap();
        let a = auto::add_prompt(&json!({ "name": "Review", "text": "Review the diff", "starred": true })).unwrap();
        let b = auto::add_prompt(&json!({ "name": "Ship", "text": "Open a PR", "project": p.id })).unwrap();
        assert_eq!((a.starred, b.project.as_deref()), (Some(true), Some(p.id.as_str())));
        assert_eq!(auto::add_prompt(&json!({ "text": "x" })).unwrap_err().message, "Give the prompt a name");
        assert_eq!(auto::add_prompt(&json!({ "name": "x", "text": "" })).unwrap_err().message, "Message is empty");
        assert_eq!(auto::add_prompt(&json!({ "name": "x", "text": "y", "project": "p-nope" })).unwrap_err().status, Some(404));
        auto::update_prompt(&a.id, &json!({ "starred": false, "text": "Review it" })).unwrap();
        set_order(&json!({ "prompts": [b.id] })).unwrap();
        let ids: Vec<String> = get().prompts.unwrap().into_iter().map(|q| q.id).collect();
        assert_eq!(ids, vec![b.id.clone(), a.id.clone()]);
        assert!(for_overview().prompts.is_none());
        // a removed project's prompts stay, for every session
        remove_project(&p.id).unwrap();
        assert_eq!(get().prompts.unwrap()[0].project, None);
        auto::remove_prompt(&a.id).unwrap();
        auto::remove_prompt(&b.id).unwrap();
        assert_eq!(get().prompts, None, "an empty list isn't written");
    });
}

#[test]
fn nothing_is_done_to_a_machine_that_is_not_online_until_it_is_back() {
    run(|| async {
        let acts = fresh(None);
        let panes = [("%3", "/w", Some("conv-a"), "idle")];
        let hosts = put(&panes);
        auto::add_send("box", "%3", &json!({ "text": "go on", "at": T + MIN }), T).unwrap();
        auto::set_sleep(&json!({ "scope": "all", "minutes": 10 })).unwrap();
        // it drops off, still listing the idle agent it had
        let mut away = hosts.clone();
        away[0].status = HostStatus::Error;
        auto::send_due(T + 30 * MIN, &away);
        auto::check_agents(T + 30 * MIN, &away);
        auto::check_agents(T + 60 * MIN, &away);
        assert!(acts.borrow().is_empty(), "no message, no sleep");
        assert_eq!(get().sends.unwrap()[0].error, None, "the message waits, without an error");
        // back: the message goes
        assert!(auto::send_due(T + 61 * MIN, &hosts));
        assert_eq!(*acts.borrow(), vec![hold("%3", "go on")]);
    });
}

#[test]
fn a_message_whose_conversation_is_gone_never_goes_to_another_one_in_its_pane() {
    run(|| async {
        let acts = fresh(None);
        put(&[("%3", "/w", Some("conv-a"), "idle")]);
        let s = auto::add_send("box", "%3", &json!({ "text": "for a", "at": T + MIN }), T).unwrap();
        // another conversation was started in %3
        let hosts = put(&[("%3", "/w", Some("conv-z"), "idle")]);
        auto::send_due(T + MIN, &hosts);
        assert!(acts.borrow().is_empty());
        assert_eq!(get().sends.unwrap()[0].error.as_deref(), Some("The session isn't there any more"));
        // Send now says the same
        assert_eq!(auto::send_now(&s.id).unwrap_err().status, Some(409));
        assert!(acts.borrow().is_empty());
    });
}

#[test]
fn a_waiting_message_moves_with_its_conversation_and_keeps_that_agent_awake() {
    run(|| async {
        let acts = fresh(None);
        put(&[("%3", "/w", Some("conv-a"), "idle")]);
        auto::add_send("box", "%3", &json!({ "text": "go on", "at": T + 600 * MIN }), T).unwrap();
        auto::set_sleep(&json!({ "minutes": 10 })).unwrap();
        // resumed in %9: the chat there shows it, and the agent there isn't put to sleep before it goes
        let hosts = put(&[("%9", "/w", Some("conv-a"), "idle")]);
        assert!(auto::follow_sends(&hosts));
        assert_eq!(get().sends.unwrap()[0].pane, "%9");
        assert!(!auto::follow_sends(&hosts), "once");
        auto::check_agents(T, &hosts);
        auto::check_agents(T + 60 * MIN, &hosts);
        assert!(acts.borrow().is_empty());
    });
}

#[test]
fn send_now_takes_it_off_the_list_and_holds_it_in_one_step() {
    run(|| async {
        let acts = fresh(None);
        put(&[("%3", "/w", Some("conv-a"), "idle")]);
        let s = auto::add_send("box", "%3", &json!({ "text": "now", "at": T + 600 * MIN }), T).unwrap();
        assert_eq!(auto::send_now(&s.id).unwrap(), "%3");
        assert_eq!(*acts.borrow(), vec![hold("%3", "now")]);
        assert_eq!(get().sends, None);
        assert_eq!(auto::send_now(&s.id).unwrap_err().status, Some(404));
    });
}

#[test]
fn one_put_back_keeps_the_conversation_it_was_for() {
    run(|| async {
        fresh(None);
        put(&[("%3", "/w", Some("conv-b"), "idle")]);
        let s = auto::add_send("box", "%3", &json!({ "text": "a", "at": T + MIN, "conv": "conv-a" }), T).unwrap();
        assert_eq!(s.conv.as_deref(), Some("conv-a"));
        assert_eq!(auto::add_send("box", "%3", &json!({ "text": "a", "at": T + MIN, "conv": 7 }), T).unwrap_err().status, Some(400));
    });
}

/// A store whose writes of the record fail while `failing` is set, as on a full disk.
struct Flaky {
    inner: crate::platform::store::MemoryStore,
    failing: std::cell::Cell<bool>,
}

impl crate::platform::store::Store for Flaky {
    fn get(&self, key: &str) -> Option<Value> {
        self.inner.get(key)
    }
    fn set(&self, key: &str, value: &Value) -> Result<(), String> {
        if key == KEY && self.failing.get() {
            return Err("No space left on device".into());
        }
        self.inner.set(key, value)
    }
    fn del(&self, key: &str) {
        self.inner.del(key)
    }
    fn keys(&self, prefix: &str) -> Vec<String> {
        self.inner.keys(prefix)
    }
}

#[test]
fn a_refused_message_that_cant_be_written_back_is_still_kept() {
    run(|| async {
        fresh(None);
        let store = Rc::new(Flaky { inner: crate::platform::store::MemoryStore::new(), failing: std::cell::Cell::new(false) });
        crate::platform::store::use_store(store.clone());
        reset();
        let hosts = put(&[("%3", "/w", Some("conv-a"), "idle")]);
        let s = auto::add_send("box", "%3", &json!({ "text": "a", "at": T + MIN }), T).unwrap();
        // the held queue refuses it, and the disk is full by then
        let st = store.clone();
        auto::set_actions(Some(Rc::new(move |_: &Act| {
            st.failing.set(true);
            Err(http(409, "No room in the held queue"))
        })));
        auto::send_due(T + MIN, &hosts);
        let kept = get().sends.unwrap();
        assert_eq!((kept[0].id.as_str(), kept[0].error.as_deref()), (s.id.as_str(), Some("No room in the held queue")), "still there to retry or dismiss");
        // written down with the next save that works
        store.failing.set(false);
        auto::update_send(&s.id, &json!({ "at": T + 5 * MIN }), T + 2 * MIN).unwrap();
        assert_eq!(kv::get_value(KEY).unwrap()["sends"][0]["id"], json!(s.id));
        crate::platform::store::use_store(Rc::new(crate::platform::store::MemoryStore::new()));
    });
}

#[test]
fn a_new_agent_in_the_same_pane_starts_its_own_idle_time() {
    run(|| async {
        let acts = fresh(None);
        auto::set_sleep(&json!({ "minutes": 10 })).unwrap();
        let hosts = put(&[("%3", "/w", Some("conv-a"), "idle")]);
        auto::check_agents(T, &hosts);
        // the agent exits and another one, with its own conversation, is idle in %3 by the next look
        let hosts = put(&[("%3", "/w", Some("conv-b"), "idle")]);
        auto::check_agents(T + 9 * MIN, &hosts);
        auto::check_agents(T + 11 * MIN, &hosts);
        assert!(acts.borrow().is_empty(), "idle 2 minutes, not 11");
        auto::check_agents(T + 19 * MIN, &hosts);
        assert_eq!(*acts.borrow(), vec![Act::Sleep { host: "box".into(), pane: "%3".into() }]);
    });
}

#[test]
fn a_session_that_could_not_be_ended_is_tried_again_after_a_while() {
    run(|| async {
        let acts = fresh(Some("tmux didn't answer"));
        let end = Act::End { host: "box".into(), pane: "%3".into() };
        put(&[("%3", "/w", Some("conv-a"), "idle")]);
        mark_pane("box", "%3", &SessionPatch::read(&json!({ "closeWhenDone": true }), T).unwrap()).unwrap();
        auto::check_agents(T, &put(&[("%3", "/w", Some("conv-a"), "working")]));
        let idle = put(&[("%3", "/w", Some("conv-a"), "idle")]);
        auto::check_agents(T + MIN, &idle);
        auto::check_agents(T + MIN + CLOSE_SETTLE_MS, &idle);
        assert_eq!(*acts.borrow(), vec![end.clone()]);
        let m = get().sessions.into_iter().find(|m| m.pane == "%3").unwrap();
        assert_eq!((m.close_when_done, m.close_saw_work), (Some(true), Some(true)), "still to close");
        auto::check_agents(T + MIN + CLOSE_SETTLE_MS + 5_000, &idle);
        assert_eq!(acts.borrow().len(), 1, "not again at once");
        auto::check_agents(T + 2 * MIN + CLOSE_SETTLE_MS, &idle);
        assert_eq!(*acts.borrow(), vec![end.clone(), end]);
    });
}

// ---------- plan limits and full contexts ----------

/// The notices the apps hear, as (pane, body).
fn notices() -> Rc<RefCell<Vec<(String, String)>>> {
    let heard = Rc::new(RefCell::new(vec![]));
    let h = heard.clone();
    on_event(move |e| {
        if let Event::Notice { pane, body, .. } = e {
            h.borrow_mut().push((pane.clone(), body.clone()));
        }
    });
    heard
}

/// The plan limit resets two hours after T, unix seconds.
const RESET: u64 = T / 1000 + 2 * 3600;
const ONE: [Pane; 1] = [("%3", "/w/inyon", Some("conv-a"), "idle")];

/// %3 stopped on the plan limit: `resets` known or not, its agent in `state`.
fn limited(state: &str, resets: bool) -> Vec<HostState> {
    let failure = if resets { json!({ "error": "rate_limit", "resetsAt": RESET }) } else { json!({ "error": "rate_limit" }) };
    put_agent(&ONE, "%3", json!({ "state": state, "failure": failure }))
}

fn carry_ons() -> Vec<inyon_protocol::DelayedSend> {
    get().sends.unwrap_or_default().into_iter().filter(|s| s.auto == Some(SendAuto::CarryOn)).collect()
}

#[test]
fn a_carry_on_goes_a_minute_after_the_limit_resets() {
    let f = |error: &str, resets_at: Option<u64>| inyon_protocol::TurnFailure { error: error.into(), resets_at };
    assert_eq!(auto::carry_on_at(&f("rate_limit", Some(RESET))), Some(RESET * 1000 + MIN));
    assert_eq!(auto::carry_on_at(&f("rate_limit", None)), None, "not when the reset isn't known");
    assert_eq!(auto::carry_on_at(&f("overloaded", Some(RESET))), None, "only a plan limit");
}

#[test]
fn a_session_stopped_on_a_plan_limit_carries_on_once_after_the_reset() {
    run(|| async {
        let acts = fresh(None);
        let heard = notices();
        let hosts = limited("idle", true);
        assert!(!auto::plan_carry_on(&hosts), "off unless asked for");
        assert_eq!(get().sends, None);

        mark_pane("box", "%3", &SessionPatch::read(&json!({ "carryOn": true }), T).unwrap()).unwrap();
        assert!(auto::plan_carry_on(&hosts));
        let s = carry_ons();
        assert_eq!(s.len(), 1);
        assert_eq!((s[0].text.as_str(), s[0].at, s[0].conv.as_deref(), s[0].pane.as_str()), ("continue", RESET * 1000 + MIN, Some("conv-a"), "%3"));
        assert!(!auto::plan_carry_on(&hosts), "planned once");

        auto::send_due(RESET * 1000, &hosts);
        assert!(acts.borrow().is_empty(), "not before its time");
        // past the reset the limit no longer says when it resets, but the turn still stopped on it
        let after = limited("idle", false);
        assert!(!auto::plan_carry_on(&after));
        assert!(auto::send_due(RESET * 1000 + MIN, &after));
        assert_eq!(*acts.borrow(), vec![hold("%3", "continue")]);
        assert_eq!(*heard.borrow(), vec![("%3".to_owned(), CARRIED_ON.to_owned())], "a notice when it carries on");
        assert!(carry_ons().is_empty());

        // it works again: the next stop on a limit is planned afresh, and the switch stays
        auto::plan_carry_on(&put(&[("%3", "/w/inyon", Some("conv-a"), "working")]));
        let m = get().sessions.into_iter().find(|m| m.pane == "%3").unwrap();
        assert_eq!((m.carry_on, m.carried_reset), (Some(true), None));
    });
}

#[test]
fn a_carry_on_you_cancel_stays_cancelled_even_across_a_restart() {
    run(|| async {
        fresh(None);
        let hosts = limited("idle", true);
        mark_pane("box", "%3", &SessionPatch::read(&json!({ "carryOn": true }), T).unwrap()).unwrap();
        auto::plan_carry_on(&hosts);
        auto::remove_send(&carry_ons()[0].id).unwrap();
        assert!(!auto::plan_carry_on(&hosts));
        reset();
        assert!(!auto::plan_carry_on(&limited("idle", true)));
        assert!(carry_ons().is_empty());
        assert_eq!(get().sessions[0].carried_reset, Some(RESET), "written down with the session");
    });
}

#[test]
fn no_carry_on_once_you_typed_or_the_session_is_busy() {
    run(|| async {
        let acts = fresh(None);
        let heard = notices();
        put(&ONE);
        mark_pane("box", "%3", &SessionPatch::read(&json!({ "carryOn": true }), T).unwrap()).unwrap();
        let working = || put(&[("%3", "/w/inyon", Some("conv-a"), "working")]);

        // you sent something before the reset: the agent works, and the carry-on goes
        auto::plan_carry_on(&limited("idle", true));
        assert_eq!(carry_ons().len(), 1);
        auto::plan_carry_on(&working());
        assert!(carry_ons().is_empty(), "you carried on yourself");

        // stopped again: at the time it's idle but on no limit any more (a turn of yours finished)
        auto::plan_carry_on(&limited("idle", true));
        assert_eq!(carry_ons().len(), 1);
        assert!(auto::send_due(RESET * 1000 + MIN, &put(&ONE)));
        assert!(carry_ons().is_empty() && get().sends.is_none(), "dropped, not kept with an error");

        // or asking you something then
        auto::plan_carry_on(&working());
        auto::plan_carry_on(&limited("idle", true));
        assert_eq!(carry_ons().len(), 1);
        auto::send_due(RESET * 1000 + MIN, &limited("waiting", false));
        assert!(carry_ons().is_empty());

        assert!(acts.borrow().is_empty(), "nothing was typed in");
        assert!(heard.borrow().is_empty());
    });
}

#[test]
fn every_session_carries_on_by_the_hubs_rule_unless_its_own_switch_says_otherwise() {
    run(|| async {
        fresh(None);
        let two: [Pane; 2] = [ONE[0], ("%4", "/w", Some("conv-b"), "idle")];
        let failure = json!({ "error": "rate_limit", "resetsAt": RESET });
        let mut v = serde_json::to_value(machine(&two)).unwrap();
        for p in v["sessions"][0]["windows"][0]["panes"].as_array_mut().unwrap() {
            p["agent"]["failure"] = failure.clone();
        }
        let hosts = put_state(serde_json::from_value(v).unwrap());

        assert_eq!(auto::set_auto(&json!({ "carryOn": true })).unwrap().carry_on, Some(true));
        auto::plan_carry_on(&hosts);
        assert_eq!(carry_ons().iter().map(|s| s.pane.as_str()).collect::<Vec<_>>(), ["%3", "%4"]);
        // a session turned off loses its carry-on at once; the other keeps its own
        mark_pane("box", "%3", &SessionPatch::read(&json!({ "carryOn": false }), T).unwrap()).unwrap();
        assert_eq!(carry_ons().iter().map(|s| s.pane.as_str()).collect::<Vec<_>>(), ["%4"]);
        // the rule turned off takes the rest
        auto::set_auto(&json!({ "carryOn": false })).unwrap();
        assert!(carry_ons().is_empty());
        assert_eq!(get().auto, None, "off is kept as nothing");
        // a session switched on carries on whatever the rule
        mark_pane("box", "%3", &SessionPatch::read(&json!({ "carryOn": true }), T).unwrap()).unwrap();
        auto::plan_carry_on(&hosts);
        assert_eq!(carry_ons().iter().map(|s| s.pane.as_str()).collect::<Vec<_>>(), ["%3"]);
        // null goes back to the rule
        mark_pane("box", "%3", &SessionPatch::read(&json!({ "carryOn": null }), T).unwrap()).unwrap();
        assert!(carry_ons().is_empty());

        assert_eq!(auto::set_auto(&json!({ "compactAt": 40 })).unwrap_err().message, "Pick between 50 and 95 percent");
        assert_eq!(auto::set_auto(&json!({ "carryOn": "yes" })).unwrap_err().status, Some(400));
    });
}

#[test]
fn the_context_switch_compacts_once_per_fill() {
    let at = 85.0;
    // under the threshold: nothing, and armed again
    assert_eq!(auto::compact_step(true, Some(40.0), at, true), (false, false));
    // over it and ready: once
    assert_eq!(auto::compact_step(false, Some(86.0), at, true), (true, true));
    assert_eq!(auto::compact_step(true, Some(90.0), at, true), (false, true));
    // over it but busy: waits, still armed
    assert_eq!(auto::compact_step(false, Some(90.0), at, false), (false, false));
    // the size unknown (just compacted): nothing changes
    assert_eq!(auto::compact_step(true, None, at, true), (false, true));
    assert_eq!(auto::compact_step(false, None, at, true), (false, false));
}

#[test]
fn a_session_compacts_before_its_context_fills_and_not_again_until_it_drops() {
    run(|| async {
        let acts = fresh(None);
        let at = |pct: f64, state: &str| put_agent(&ONE, "%3", json!({ "state": state, "status": { "contextPct": pct, "updatedAt": 0 } }));
        auto::compact_full(T, &at(90.0, "idle"));
        assert!(acts.borrow().is_empty(), "off unless asked for");

        auto::set_auto(&json!({ "autoCompact": true })).unwrap();
        auto::compact_full(T, &at(80.0, "idle"));
        assert!(acts.borrow().is_empty(), "under 85%");
        auto::compact_full(T, &at(88.0, "working"));
        assert!(acts.borrow().is_empty(), "not while it works");
        auto::compact_full(T, &at(88.0, "idle"));
        assert_eq!(*acts.borrow(), vec![hold("%3", "/compact")]);
        auto::compact_full(T, &at(89.0, "idle"));
        let stale = put_agent(&ONE, "%3", json!({ "status": { "contextPct": 89, "stale": { "context": "compacted" }, "updatedAt": 0 } }));
        auto::compact_full(T, &stale);
        assert_eq!(acts.borrow().len(), 1, "once until it drops");

        auto::compact_full(T, &at(22.0, "idle"));
        auto::compact_full(T, &at(91.0, "idle"));
        assert_eq!(acts.borrow().len(), 2, "again after it dropped");

        // its own switch wins over the rule, and the threshold is the hub's
        mark_pane("box", "%3", &SessionPatch::read(&json!({ "autoCompact": false }), T).unwrap()).unwrap();
        auto::compact_full(T, &at(10.0, "idle"));
        auto::compact_full(T, &at(95.0, "idle"));
        assert_eq!(acts.borrow().len(), 2);
        mark_pane("box", "%3", &SessionPatch::read(&json!({ "autoCompact": null }), T).unwrap()).unwrap();
        auto::set_auto(&json!({ "compactAt": 70 })).unwrap();
        auto::compact_full(T, &at(72.0, "idle"));
        assert_eq!(acts.borrow().len(), 3, "at the hub's 70%");

        // stopped on a plan limit, a compaction can't run either
        auto::compact_full(T, &at(10.0, "idle"));
        auto::compact_full(T, &put_agent(&ONE, "%3", json!({ "status": { "contextPct": 90, "updatedAt": 0 }, "failure": { "error": "rate_limit" } })));
        assert_eq!(acts.borrow().len(), 3);

        // each agent's own command
        auto::compact_full(T, &put_agent(&ONE, "%3", json!({ "kind": "gemini", "pid": 2, "status": { "contextPct": 90, "updatedAt": 0 } })));
        assert_eq!(acts.borrow().last(), Some(&hold("%3", "/compress")));
    });
}

// ---------- repeating messages (from 0.27) ----------

const DAY: u64 = 24 * 60 * MIN;

/// Every day at 9:00 UTC (T is Monday 21 September 2026, 14:13 UTC).
fn daily(more: Value) -> Value {
    let mut b = json!({ "text": "check the nightly build", "repeat": { "every": "day", "minute": 540, "tz": "UTC", "offset": 0 } });
    b.as_object_mut().unwrap().extend(more.as_object().unwrap().clone());
    b
}

#[test]
fn a_repeating_message_goes_at_each_time_and_writes_the_next_down_before_it_goes() {
    run(|| async {
        let acts = fresh(None);
        let hosts = put(&[("%3", "/w", Some("conv-a"), "idle")]);
        let s = auto::add_send("box", "%3", &daily(json!({})), T).unwrap();
        let first = s.at;
        assert_eq!(first, 1_790_067_600_000, "9:00 the next morning");
        assert_eq!(get().v, 4, "a record a 0.26 hub only reads");
        assert!(!auto::send_due(first - 1, &hosts));
        auto::set_actions(Some(Rc::new({
            let acts = acts.clone();
            move |x: &Act| {
                let next = kv::get_value(KEY).unwrap()["sends"][0]["at"].as_u64().unwrap();
                assert!(next > first && (next - first).is_multiple_of(DAY), "the next time is written down first");
                acts.borrow_mut().push(x.clone());
                Ok(())
            }
        })));
        assert!(auto::send_due(first, &hosts));
        assert_eq!(*acts.borrow(), vec![hold("%3", "check the nightly build")]);
        // the hub restarts: nothing again until tomorrow, and the rule is still there
        reset();
        auto::send_due(first + MIN, &hosts);
        assert_eq!(acts.borrow().len(), 1);
        let kept = get().sends.unwrap();
        assert_eq!((kept[0].at, kept[0].repeat.as_ref().map(|r| r.minute)), (first + DAY, Some(Some(540))));
        auto::send_due(first + DAY, &hosts);
        assert_eq!(acts.borrow().len(), 2);
        // the hub was off for three days: one late time, not three
        auto::send_due(first + 4 * DAY + 3 * 60 * MIN, &hosts);
        auto::send_due(first + 4 * DAY + 4 * 60 * MIN, &hosts);
        assert_eq!(acts.borrow().len(), 3);
        assert_eq!(get().sends.unwrap()[0].at, first + 5 * DAY);
    });
}

#[test]
fn a_busy_agent_is_tried_again_a_few_times_then_that_time_is_skipped_with_a_notice() {
    run(|| async {
        let acts = fresh(None);
        let heard = notices();
        put(&[("%3", "/w", Some("conv-a"), "idle")]);
        let s = auto::add_send("box", "%3", &daily(json!({})), T).unwrap();
        let first = s.at;
        let busy = put(&[("%3", "/w", Some("conv-a"), "working")]);
        auto::send_due(first, &busy);
        let w = get().sends.unwrap().remove(0);
        assert_eq!((w.at, w.due, w.tries), (first + auto::REPEAT_RETRY_MS, Some(first), Some(1)));
        // tried at its time and five more times, five minutes apart; a restart in between loses no count
        reset();
        for i in 1..auto::REPEAT_TRIES as u64 {
            assert!(!auto::send_due(first + i * auto::REPEAT_RETRY_MS - 1, &busy), "not before the retry");
            auto::send_due(first + i * auto::REPEAT_RETRY_MS, &busy);
        }
        assert!(acts.borrow().is_empty());
        let w = get().sends.unwrap().remove(0);
        assert_eq!((w.at, w.due, w.tries, w.skipped), (first + DAY, None, None, Some(first)));
        assert_eq!(*heard.borrow(), vec![("%3".to_owned(), "Skipped “check the nightly build”: the agent was busy".to_owned())]);
        // free the next morning: it goes, and the skip is forgotten
        let idle = put(&[("%3", "/w", Some("conv-a"), "idle")]);
        auto::send_due(first + DAY, &idle);
        assert_eq!(*acts.borrow(), vec![hold("%3", "check the nightly build")]);
        assert_eq!(get().sends.unwrap()[0].skipped, None);
    });
}

#[test]
fn a_repeating_message_waits_for_an_empty_box_and_an_empty_held_queue() {
    run(|| async {
        let acts = fresh(None);
        let hosts = put(&[("%3", "/w", Some("conv-a"), "idle")]);
        let first = auto::add_send("box", "%3", &daily(json!({})), T).unwrap().at;
        // half a message typed in the app
        crate::claude::drafts::set_draft(
            "box:%3",
            Some(crate::claude::drafts::Draft { text: "and also".into(), source: inyon_protocol::DraftSource::App, at: 0.0, mirrored: None }),
        );
        auto::send_due(first, &hosts);
        assert!(acts.borrow().is_empty());
        assert_eq!(get().sends.unwrap()[0].tries, Some(1));
        crate::claude::drafts::set_draft("box:%3", None);
        // asking a question counts as busy as well
        let mut asking = put(&[("%3", "/w", Some("conv-a"), "idle")]);
        asking[0].sessions[0].windows[0].panes[0].agent.as_mut().unwrap().waiting_for = Some("permission".into());
        auto::send_due(first + auto::REPEAT_RETRY_MS, &asking);
        assert!(acts.borrow().is_empty());
        auto::send_due(first + 2 * auto::REPEAT_RETRY_MS, &hosts);
        assert_eq!(*acts.borrow(), vec![hold("%3", "check the nightly build")]);
    });
}

#[test]
fn a_paused_one_doesnt_go_and_resumes_at_its_next_time_after_now() {
    run(|| async {
        let acts = fresh(None);
        let hosts = put(&[("%3", "/w", Some("conv-a"), "idle")]);
        let s = auto::add_send("box", "%3", &daily(json!({})), T).unwrap();
        let p = auto::update_send(&s.id, &json!({ "paused": true }), T).unwrap();
        assert_eq!(p.paused, Some(true));
        auto::send_due(s.at + 2 * DAY, &hosts);
        assert!(acts.borrow().is_empty());
        let r = auto::update_send(&s.id, &json!({ "paused": false }), s.at + 2 * DAY + MIN).unwrap();
        assert_eq!((r.paused, r.at), (None, s.at + 3 * DAY), "the missed ones don't go late");
        // a one-off can't be paused
        let once = auto::add_send("box", "%3", &json!({ "text": "x", "at": T + MIN }), T).unwrap();
        assert_eq!(auto::update_send(&once.id, &json!({ "paused": true }), T).unwrap_err().status, Some(400));
    });
}

#[test]
fn a_new_rule_or_none_reschedules_it() {
    run(|| async {
        fresh(None);
        put(&[("%3", "/w", Some("conv-a"), "idle")]);
        let s = auto::add_send("box", "%3", &daily(json!({})), T).unwrap();
        let hours = auto::update_send(&s.id, &json!({ "repeat": { "every": "hours", "hours": 2, "tz": "UTC", "offset": 0 } }), T).unwrap();
        assert_eq!((hours.at, hours.repeat.unwrap().hours), (T + 120 * MIN, Some(2)));
        // weekly on Wednesday at 8:30
        let week = auto::update_send(&s.id, &json!({ "repeat": { "every": "week", "day": 3, "minute": 510, "tz": "UTC", "offset": 0 }, "notify": true }), T).unwrap();
        assert_eq!((week.at, week.notify), (1_790_065_800_000 + DAY, Some(true)));
        let once = auto::update_send(&s.id, &json!({ "repeat": null, "text": "only once" }), T).unwrap();
        assert_eq!((once.repeat, once.at, once.text.as_str()), (None, week.at, "only once"));
        assert_eq!(auto::add_send("box", "%3", &json!({ "text": "x", "repeat": { "every": "fortnight", "tz": "UTC", "offset": 0 } }), T).unwrap_err().status, Some(400));
    });
}

#[test]
fn a_notice_says_when_each_time_goes_if_asked() {
    run(|| async {
        fresh(None);
        let heard = notices();
        let hosts = put(&[("%3", "/w", Some("conv-a"), "idle")]);
        let quiet = auto::add_send("box", "%3", &daily(json!({})), T).unwrap();
        auto::send_due(quiet.at, &hosts);
        assert!(heard.borrow().is_empty(), "none unless asked");
        auto::remove_send(&quiet.id).unwrap();
        let loud = auto::add_send("box", "%3", &daily(json!({ "notify": true, "text": "\n  summarise the night\nin three lines" })), T).unwrap();
        auto::send_due(loud.at, &hosts);
        assert_eq!(*heard.borrow(), vec![("%3".to_owned(), "Scheduled: summarise the night".to_owned())]);
    });
}

#[test]
fn a_repeating_message_goes_on_in_its_pane_when_the_conversation_there_changes() {
    run(|| async {
        let acts = fresh(None);
        put(&[("%3", "/w", Some("conv-a"), "idle")]);
        let s = auto::add_send("box", "%3", &daily(json!({})), T).unwrap();
        // /clear: a new conversation in the same pane
        let hosts = put(&[("%3", "/w", Some("conv-b"), "idle")]);
        auto::send_due(s.at, &hosts);
        assert_eq!(*acts.borrow(), vec![hold("%3", "check the nightly build")]);
        assert_eq!(get().sends.unwrap()[0].conv.as_deref(), Some("conv-b"), "and follows the new one from now on");
        // the pane is gone: it waits with the reason
        let gone = put(&[("%5", "/w", Some("conv-c"), "idle")]);
        auto::send_due(s.at + DAY, &gone);
        assert_eq!(get().sends.unwrap()[0].error.as_deref(), Some("The session isn't there any more"));
    });
}

#[test]
fn one_that_starts_a_new_session_launches_the_agent_in_the_folder_each_time() {
    run(|| async {
        let acts = fresh(None);
        let hosts = put(&[("%3", "/w/inyon", Some("conv-a"), "working")]);
        let s = auto::add_send("box", "%3", &daily(json!({ "newSession": true })), T).unwrap();
        assert_eq!((s.new_session.as_ref().map(|n| n.cwd.as_str()), s.conv.as_deref()), (Some("/w/inyon"), None));
        // a busy agent in the pane it was set on doesn't matter
        auto::send_due(s.at, &hosts);
        let launch = Act::Launch {
            host: "box".into(),
            agent: inyon_protocol::AgentKind::Claude,
            cwd: "/w/inyon".into(),
            text: "check the nightly build".into(),
            send: s.id.clone(),
            notify: false,
        };
        assert_eq!(*acts.borrow(), vec![launch.clone()]);
        // nor does that pane being gone
        let gone = put(&[]);
        auto::send_due(s.at + DAY, &gone);
        assert_eq!(*acts.borrow(), vec![launch.clone(), launch.clone()]);
        assert_eq!(get().sends.unwrap()[0].at, s.at + 2 * DAY);
        // Send now starts one more, and keeps the rule
        auto::send_now(&s.id).unwrap();
        assert_eq!(acts.borrow().len(), 3);
        assert_eq!(get().sends.unwrap()[0].at, s.at + 2 * DAY);
        // it doesn't keep the agent it was set on awake
        auto::set_sleep(&json!({ "minutes": 10 })).unwrap();
        let idle = put(&[("%3", "/w/inyon", Some("conv-a"), "idle")]);
        auto::check_agents(T, &idle);
        auto::check_agents(T + 11 * MIN, &idle);
        assert_eq!(acts.borrow().last(), Some(&Act::Sleep { host: "box".into(), pane: "%3".into() }));
    });
}

#[test]
fn a_new_session_needs_an_agent_that_takes_a_first_message() {
    run(|| async {
        fresh(None);
        let Some(kind) = inyon_protocol::AGENT_KINDS.iter().copied().find(|k| !k.chat()) else { return };
        let mut hosts = put(&[("%3", "/w", Some("conv-a"), "idle")]);
        hosts[0].sessions[0].windows[0].panes[0].agent.as_mut().unwrap().kind = kind;
        let rt = Rc::new(RefCell::new(HostRuntime::new(Host::new(hosts[0].config.clone()), hosts[0].clone())));
        rt.borrow_mut().hold_polls();
        registry().insert_runtime("box", rt);
        let e = auto::add_send("box", "%3", &daily(json!({ "newSession": true })), T).unwrap_err();
        assert_eq!(e.status, Some(400));
        assert!(e.message.ends_with("starts without a first message, so it can't start a session for one"), "{}", e.message);
    });
}

#[test]
fn a_carry_on_cant_be_made_to_repeat() {
    run(|| async {
        fresh(None);
        let hosts = limited("idle", true);
        mark_pane("box", "%3", &SessionPatch::read(&json!({ "carryOn": true }), T).unwrap()).unwrap();
        auto::plan_carry_on(&hosts);
        let id = carry_ons()[0].id.clone();
        let e = auto::update_send(&id, &json!({ "repeat": { "every": "day", "minute": 540, "tz": "UTC", "offset": 0 } }), T).unwrap_err();
        assert_eq!(e.status, Some(400));
        assert_eq!(auto::update_send(&id, &json!({ "newSession": true }), T).unwrap_err().status, Some(400));
        assert_eq!(carry_ons()[0].repeat, None);
    });
}
