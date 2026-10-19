//! The registry's tests: hosts/pairing, background, overview-change, opencode-status,
//! offline-alert and mode-while-asked .test.ts, and the overview test of node-update.test.ts.

use std::cell::RefCell;
use std::rc::Rc;

use inyon_protocol::{AgentPaneInfo, HostState, ScreenState, VERSION};
use serde_json::{json, Value};

use super::*;
use crate::test_support::fake::{ok, Fake};
use crate::test_support::rt::{run, wait};
use crate::test_support::{assert_match, host, screen_fixture};

fn from<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

// pairing.test.ts

#[test]
fn an_unused_pairing_token_stops_working_after_a_day_a_used_one_keeps_working() {
    let now = 1_791_000_000_000u64;
    let node: HostConfig = from(json!({ "id": "n", "name": "N", "kind": "node", "tokenHash": "h", "tokenIssuedAt": now - PAIR_TOKEN_MS - 1 }));
    assert!(token_expired(&node, now));
    assert!(!token_expired(&HostConfig { token_issued_at: Some(now - PAIR_TOKEN_MS + 60_000), ..node.clone() }, now));
    assert!(!token_expired(&HostConfig { paired_at: Some(now - 2 * PAIR_TOKEN_MS), ..node.clone() }, now));
    assert!(!token_expired(&HostConfig { kind: HostKind::Ssh, ..node }, now));
}

// background.test.ts

const WAS: (u32, Option<&str>) = (7, Some("1 shell, 1 agent"));

#[test]
fn what_the_footer_says_wins_and_a_bare_footer_clears_it() {
    assert_eq!(background_after(Some(Some("2 agents")), Some(WAS), 7).as_deref(), Some("2 agents"));
    assert_eq!(background_after(Some(None), Some(WAS), 7), None);
}

#[test]
fn a_hidden_footer_keeps_what_it_last_said() {
    assert_eq!(background_after(None, Some(WAS), 7).as_deref(), Some("1 shell, 1 agent"));
    assert_eq!(background_after(None, Some((7, None)), 7), None);
}

#[test]
fn another_process_in_the_pane_starts_clean() {
    assert_eq!(background_after(None, Some(WAS), 8), None);
    assert_eq!(background_after(None, None, 7), None);
}

// overview-change.test.ts

fn state(over: Value) -> HostState {
    let mut s = json!({
        "config": { "id": "box", "name": "Box", "kind": "node" },
        "status": "online",
        "integration": "installed",
        "tmux": "ok",
        "agents": ["claude"],
        "sessions": [{ "id": "$1", "name": "work", "attached": 0, "windows": [] }],
        "updatedAt": 1000,
        "lastSeen": 1000,
        "latencyMs": 40,
    });
    for (k, v) in over.as_object().unwrap() {
        if v.is_null() {
            s.as_object_mut().unwrap().shift_remove(k);
        } else {
            s[k] = v.clone();
        }
    }
    from(s)
}

#[test]
fn a_poll_that_only_moves_the_clock_sends_no_overview() {
    // every 4 s poll stamps a new lastSeen; the app only shows it once the machine is offline,
    // and the overview sent when it goes offline carries the latest one
    assert!(!overview_changed(&state(json!({})), &state(json!({ "updatedAt": 5000, "lastSeen": 5000, "latencyMs": 55 }))));
}

#[test]
fn anything_the_app_shows_still_goes_out() {
    assert!(overview_changed(&state(json!({})), &state(json!({ "status": "connecting", "lastSeen": 5000 }))));
    assert!(overview_changed(&state(json!({})), &state(json!({ "sessions": [] }))));
    assert!(overview_changed(&state(json!({})), &state(json!({ "agents": ["claude", "codex"] }))));
    // the first time a machine answers, "Offline" becomes possible at all
    assert!(overview_changed(&state(json!({ "lastSeen": null })), &state(json!({}))));
}

// opencode-status.test.ts

fn oc_pane(more: Value) -> AgentPaneInfo {
    let mut p = json!({ "kind": "opencode", "pid": 7, "state": "idle", "transcriptPath": "opencode://127.0.0.1:1/ses_a" });
    for (k, v) in more.as_object().unwrap() {
        p[k] = v.clone();
    }
    from(p)
}

fn sc(v: Value) -> ScreenState {
    from(v)
}

/// no catalogue is known for this host, so names come straight off the footer
fn status_host() -> Host {
    host(&format!("status-test-{}", crate::ids::random_uuid()), "ssh")
}

#[test]
fn a_visible_footer_sets_model_variant_and_agent_no_variant_means_the_default() {
    run(|| async {
        let _fake = Fake::install(|_, _, _| ok(""));
        let h = status_host();
        let mut info = oc_pane(json!({}));
        apply_open_code_screen(
            &mut info,
            &sc(json!({ "working": false, "width": 120, "model": "Space Bunny Free OpenCode", "effort": "high", "mode": "plan" })),
            &h.id(),
            &h,
            None,
        );
        assert_match(&info.status, json!({ "model": "Space Bunny Free", "effort": "high" }));
        assert_eq!(info.mode.as_deref(), Some("plan"));
        apply_open_code_screen(&mut info, &sc(json!({ "working": false, "width": 120, "model": "Big Pickle OpenCode", "mode": "build" })), &h.id(), &h, None);
        assert_match(&info.status, json!({ "model": "Big Pickle" }));
        assert_eq!(info.status.as_ref().unwrap().effort, None);
        assert_eq!(info.mode.as_deref(), Some("build"));
    });
}

#[test]
fn a_menu_or_question_hiding_the_footer_keeps_the_last_values_for_the_same_process_not_for_a_new_one() {
    run(|| async {
        let _fake = Fake::install(|_, _, _| ok(""));
        let h = status_host();
        let was = oc_pane(
            json!({ "mode": "plan", "status": { "model": "Space Bunny Free", "modelId": "opencode/space-bunny-free", "effort": "high", "contextSize": 1048576, "updatedAt": 1 } }),
        );
        let mut next = oc_pane(json!({}));
        apply_open_code_screen(
            &mut next,
            &sc(json!({ "working": false, "width": 120, "prompt": { "body": ["Permission required"], "options": [], "multi": false } })),
            &h.id(),
            &h,
            Some(&was),
        );
        assert_match(&next.status, json!({ "model": "Space Bunny Free", "modelId": "opencode/space-bunny-free", "effort": "high", "contextSize": 1048576 }));
        assert_eq!(next.mode.as_deref(), Some("plan"));
        let mut restarted = oc_pane(json!({ "pid": 8 }));
        apply_open_code_screen(&mut restarted, &sc(json!({ "working": false, "width": 120 })), &h.id(), &h, Some(&was));
        assert_eq!(restarted.status.as_ref().and_then(|s| s.model.clone()), None);
        assert_eq!(restarted.mode, None);
    });
}

#[test]
fn the_sidebars_context_and_cost_ride_along_and_a_later_footer_keeps_them() {
    run(|| async {
        let _fake = Fake::install(|_, _, _| ok(""));
        let h = status_host();
        let mut info = oc_pane(json!({}));
        apply_open_code_screen(
            &mut info,
            &sc(json!({ "working": false, "width": 160, "model": "Big Pickle OpenCode", "mode": "build", "contextUsed": 36898, "contextPct": 18, "costUsd": 0 })),
            &h.id(),
            &h,
            None,
        );
        assert_match(&info.status, json!({ "contextUsed": 36898, "contextPct": 18, "costUsd": 0 }));
        apply_open_code_screen(&mut info, &sc(json!({ "working": true, "width": 160, "model": "Big Pickle OpenCode", "mode": "build" })), &h.id(), &h, None);
        assert_match(&info.status, json!({ "contextUsed": 36898, "contextPct": 18, "model": "Big Pickle" }));
    });
}

// offline-alert.test.ts

const BASE: OfflineAlert = OfflineAlert { since: Some(1000), notified: false, now: 1000 + 61_000, held: false, held_until: 0, online: true };

#[test]
fn a_machine_gone_for_a_minute_is_reported_once() {
    assert!(offline_alert_due(BASE));
    assert!(!offline_alert_due(OfflineAlert { notified: true, ..BASE }));
    assert!(!offline_alert_due(OfflineAlert { now: 1000 + 30_000, ..BASE }));
}

#[test]
fn no_alert_while_the_phone_app_is_in_the_background_or_the_phone_has_no_network() {
    assert!(!offline_alert_due(OfflineAlert { held: true, ..BASE }));
    assert!(!offline_alert_due(OfflineAlert { online: false, ..BASE }));
}

#[test]
fn coming_back_to_the_app_starts_the_minute_over() {
    // the outage began while the app was hidden; the app came back 10 s ago
    assert!(!offline_alert_due(OfflineAlert { now: 500_000, held_until: 490_000, ..BASE }));
    assert!(offline_alert_due(OfflineAlert { now: 551_000, held_until: 490_000, ..BASE }));
}

/// A machine with one Claude pane in this state, and a runtime holding it.
fn one_pane(id: &str, agent: &str, background: Option<&str>) -> HostState {
    let mut a = json!({ "kind": "claude", "pid": 7, "state": agent });
    if let Some(b) = background {
        a["background"] = json!(b);
    }
    from(json!({
        "config": { "id": id, "name": "Box", "kind": "ssh" },
        "status": "online", "integration": "unknown", "tmux": "ok", "agents": [], "updatedAt": 0,
        "sessions": [{ "id": "$1", "name": "main", "attached": 0, "windows": [{ "id": "@1", "index": 0, "name": "w", "active": true, "activity": 0, "panes": [
            { "id": "%1", "index": 0, "active": true, "command": "claude", "cwd": "/", "title": "Fix login", "width": 100, "height": 30, "dead": false, "agent": a }
        ] }] }],
    }))
}

fn runtime(_id: &str, state: HostState) -> Rt {
    let h = Host::new(state.config.clone());
    Rc::new(RefCell::new(HostRuntime::new(h, state)))
}

/// The kinds of notifications for this machine, as they come.
fn notifications(id: &'static str) -> (Rc<RefCell<Vec<&'static str>>>, impl Fn()) {
    let got: Rc<RefCell<Vec<&'static str>>> = Rc::default();
    let g = got.clone();
    let off = registry().on(move |e| {
        if let RegistryEvent::Notify { host, kind, .. } = e {
            if host == id {
                g.borrow_mut().push(kind.as_str());
            }
        }
    });
    (got, off)
}

fn first_agent(s: &HostState) -> AgentPaneInfo {
    s.sessions[0].windows[0].panes[0].agent.clone().unwrap()
}

#[test]
fn back_from_an_outage_a_turn_that_finished_meanwhile_is_reported_and_a_waiting_question_is_not_repeated() {
    run(|| async {
        const ID: &str = "reconnect-test";
        let rt = runtime(ID, one_pane(ID, "working", None));
        let (got, off) = notifications(ID);
        let me = registry();
        let outage = |after: &str| {
            me.mark_down(&rt, HostStatus::Error, "gone");
            // while away nothing is known to be running
            assert_eq!(first_agent(&rt.borrow().state).state, AgentState::Unknown);
            let away = rt.borrow().state.clone();
            rt.borrow_mut().state = one_pane(ID, after, None);
            me.diff_notify(&rt, &away);
        };
        outage("idle");
        assert_eq!(*got.borrow(), ["done"]);
        rt.borrow_mut().state = one_pane(ID, "waiting", None);
        outage("waiting");
        assert_eq!(*got.borrow(), ["done"]);
        // a question that came up while away is still news
        rt.borrow_mut().state = one_pane(ID, "working", None);
        outage("waiting");
        assert_eq!(*got.borrow(), ["done", "waiting"]);
        off();
    });
}

#[test]
fn a_turn_that_ends_with_agents_still_running_is_reported_finished_once_they_are_done() {
    run(|| async {
        const ID: &str = "bg-test";
        let rt = runtime(ID, one_pane(ID, "working", None));
        let (got, off) = notifications(ID);
        let me = registry();
        // the grace after the last agent is gone, shortened for the test
        let grace = me.done_grace.get();
        me.done_grace.set(20);
        let settle = || wait(40);
        let step = |agent: &str, background: Option<&str>| {
            let prev = rt.borrow().state.clone();
            rt.borrow_mut().state = one_pane(ID, agent, background);
            me.diff_notify(&rt, &prev);
        };
        // the main turn ends, but a subagent and a shell are still going
        step("idle", Some("1 shell, 1 agent"));
        assert!(got.borrow().is_empty());
        step("idle", Some("1 agent"));
        assert!(got.borrow().is_empty());
        step("idle", None);
        // not at once: when a subagent reports back, the main turn often goes on a moment later
        assert!(got.borrow().is_empty());
        // the timer looks the pane up in the registry, as the TS one reads rt.state
        settle().await;
        assert_eq!(*got.borrow(), ["done"]);
        // a new turn while an agent runs: the finish belongs to that turn's end
        step("working", Some("1 agent"));
        step("working", None);
        step("idle", None);
        assert_eq!(*got.borrow(), ["done", "done"]);
        // the agent is gone, Claude picks the result up within the grace: one finish, at the real end
        step("working", Some("1 agent"));
        step("idle", Some("1 agent"));
        step("idle", None);
        step("working", None);
        settle().await;
        assert_eq!(*got.borrow(), ["done", "done"]);
        step("idle", None);
        assert_eq!(*got.borrow(), ["done", "done", "done"]);
        // a question still comes through while agents run, and a plain turn still finishes as before
        step("working", Some("1 agent"));
        step("waiting", Some("1 agent"));
        step("working", Some("1 agent"));
        step("idle", Some("1 agent"));
        step("working", None);
        step("idle", None);
        assert_eq!(*got.borrow(), ["done", "done", "done", "waiting", "done"]);
        me.done_grace.set(grace);
        off();
    });
}

// mode-while-asked.test.ts

const MODE_ID: &str = "mode-test";

fn rule() -> String {
    "─".repeat(100)
}

fn idle(footer: &str) -> String {
    let r = rule();
    format!("● Done.\n{r}\n❯ \n{r}\n  {footer}")
}

fn mode_sessions() -> Vec<SessionInfo> {
    from(json!([{ "id": "$1", "name": "work", "attached": 0, "windows": [{ "id": "@1", "index": 0, "name": "claude", "active": true, "activity": 0, "panes": [
        { "id": "%9", "index": 0, "active": true, "command": "claude", "cwd": "/w", "title": "claude", "width": 100, "height": 30, "dead": false }
    ] }] }]))
}

fn mode_probe(now: f64) -> ProbeResult {
    let mut agent_procs = IndexMap::new();
    agent_procs.insert(
        "%9".to_owned(),
        AgentProc { kind: AgentKind::Claude, pid: 7.0, started_at: now - 100.0, cwd: Some("/w".into()), resume: None, args: "claude".into(), pane_pid: 7.0 },
    );
    ProbeResult {
        hostname: "box".into(),
        home: String::new(),
        os: "Linux".into(),
        now,
        latency_ms: 1.0,
        tmux: TmuxProbe::Ok,
        integration: IntegrationState::Missing,
        sessions: mode_sessions(),
        agent_procs,
        hook_panes: IndexMap::new(),
        status_panes: IndexMap::new(),
        account: None,
        compact_panes: IndexMap::new(),
        installed: vec![],
        signed_in: vec![],
        agy_conversations: IndexMap::new(),
        agy_status: IndexMap::new(),
        agy_titles: IndexMap::new(),
        agy_integration: None,
        machine_kind: None,
    }
}

/// One Claude pane on a machine whose screen is whatever the test last drew.
struct ModeBox {
    screen: Rc<RefCell<String>>,
    rt: Rt,
    _fake: Rc<Fake>,
}

impl ModeBox {
    fn new() -> ModeBox {
        let screen: Rc<RefCell<String>> = Rc::default();
        let s = screen.clone();
        let fake = Fake::install(move |_, cmd, _| ok(&if cmd.contains("@@CAP") { format!("@@CAP %9\n{}\n", s.borrow()) } else { String::new() }));
        let state: HostState = from(
            json!({ "config": { "id": MODE_ID, "name": "Box", "kind": "ssh" }, "status": "online", "integration": "missing", "tmux": "ok", "agents": [], "sessions": mode_sessions(), "updatedAt": 0 }),
        );
        let rt = runtime(MODE_ID, state);
        registry().insert_runtime(MODE_ID, rt.clone());
        ModeBox { screen, rt, _fake: fake }
    }

    fn draw(&self, s: &str) {
        *self.screen.borrow_mut() = s.to_owned();
    }

    fn mode(&self) -> Option<String> {
        registry().find_pane(MODE_ID, "%9").and_then(|f| f.pane.agent).and_then(|a| a.mode)
    }

    /// The 4 s poll: a fresh read of every agent pane.
    async fn poll(&self) -> Option<String> {
        let pr = Rc::new(RefCell::new(mode_probe(now_ms() as f64 / 1000.0)));
        self.rt.borrow_mut().probe = Some(pr.clone());
        registry().annotate_agents(&self.rt, &pr).await.unwrap();
        self.rt.borrow_mut().state.sessions = pr.borrow().sessions.clone();
        self.mode()
    }

    /// The quick re-read after the pane printed something.
    async fn refresh(&self) -> Option<String> {
        self.rt.borrow_mut().dirty.insert("%9".into());
        registry().flush_dirty(&self.rt).await;
        self.mode()
    }
}

fn asking() -> String {
    screen_fixture("claude", "permission-prompt").join("\n")
}

#[test]
fn while_claude_asks_the_poll_and_a_refresh_both_keep_the_mode_its_footer_showed_last() {
    run(|| async {
        let b = ModeBox::new();
        b.draw(&idle("⏵⏵ accept edits on (shift+tab to cycle)"));
        assert_eq!(b.poll().await.as_deref(), Some("accept edits"));
        b.draw(&asking());
        assert_eq!(b.poll().await.as_deref(), Some("accept edits"));
        assert_eq!(b.refresh().await.as_deref(), Some("accept edits"));
        assert_eq!(b.poll().await.as_deref(), Some("accept edits"));
    });
}

#[test]
fn once_the_footer_shows_again_without_a_mode_both_say_there_is_none() {
    run(|| async {
        let b = ModeBox::new();
        b.draw(&idle("⏵⏵ accept edits on (shift+tab to cycle)"));
        assert_eq!(b.poll().await.as_deref(), Some("accept edits"));
        b.draw(&idle("? for shortcuts"));
        assert_eq!(b.refresh().await, None);
        assert_eq!(b.poll().await, None);
    });
}

#[test]
fn a_footer_naming_another_mode_wins_over_the_one_kept() {
    run(|| async {
        let b = ModeBox::new();
        b.draw(&idle("⏵⏵ accept edits on (shift+tab to cycle)"));
        b.poll().await;
        b.draw(&asking());
        b.refresh().await;
        b.draw(&idle("⏸ plan mode on (shift+tab to cycle)"));
        assert_eq!(b.refresh().await.as_deref(), Some("plan"));
        assert_eq!(b.poll().await.as_deref(), Some("plan"));
    });
}

// node-update.test.ts: "the overview carries the update state"

#[test]
fn the_overview_carries_the_update_state() {
    crate::test_support::rt::run(|| async {
        let add: HostState = from(
            json!({ "config": { "id": "ov", "name": "ov", "kind": "node" }, "status": "online", "integration": "unknown", "tmux": "ok", "agents": [], "sessions": [], "updatedAt": 0, "nodeVersion": "0.3.0" }),
        );
        registry().insert_runtime("ov", runtime("ov", add));
        let got = registry().overview().into_iter().find(|h| h.config.id == "ov").and_then(|h| h.node_update);
        registry().hosts.borrow_mut().shift_remove("ov");
        assert_eq!(serde_json::to_value(got).unwrap(), json!({ "latest": VERSION, "supported": true }));
    });
}

// Not in the TS tests: the hook log is followed while the integration is installed.

#[test]
fn the_hook_log_is_followed_and_each_event_goes_to_listeners() {
    run(|| async {
        let fake = Fake::install(|_, _, _| ok(""));
        let mut s = one_pane("events-test", "idle", None);
        s.config.kind = HostKind::Local;
        let rt = runtime("events-test", s);
        let got: Rc<RefCell<Vec<(String, Value)>>> = Rc::default();
        let g = got.clone();
        let off = registry().on(move |e| {
            if let RegistryEvent::Hook { host, pane, event } = e {
                if host == "events-test" {
                    g.borrow_mut().push((pane.clone(), event.clone()));
                }
            }
        });
        registry().watch_events(&rt).unwrap();
        let stream = fake.streams.borrow()[0].clone();
        assert_eq!(stream.host, "events-test");
        assert!(stream.cmd.ends_with(r#"&& exec tail -n0 -F "$HOME/.inyon/events.jsonl" 2>/dev/null"#), "{}", stream.cmd);
        stream.line(r#"{"pane":"%1","data":{"hook_event_name":"Stop"}}"#);
        stream.line("not json");
        stream.line(r#"{"data":{}}"#);
        assert_eq!(*got.borrow(), [("%1".to_owned(), json!({ "hook_event_name": "Stop" }))]);
        // once it ends, the next poll starts it again
        rt.borrow().events.clone().unwrap().kill();
        wait(1).await;
        assert!(rt.borrow().events.is_none());
        off();
    });
}

// ---------- saving the machine list (review) ----------

/// A disk that's full: every record read is there, no record can be written.
struct FullDisk;

impl crate::platform::store::Store for FullDisk {
    fn get(&self, _key: &str) -> Option<Value> {
        None
    }
    fn set(&self, _key: &str, _value: &Value) -> Result<(), String> {
        Err("ENOSPC: no space left on device".into())
    }
    fn del(&self, _key: &str) {}
    fn keys(&self, _prefix: &str) -> Vec<String> {
        vec![]
    }
}

#[test]
fn a_machine_list_that_cant_be_saved_fails_the_change_that_needed_it() {
    run(|| async {
        let _fake = Fake::install(|_, _, _| ok(""));
        crate::test_support::machine("n", "node", json!([])).borrow_mut().hold_polls();
        crate::platform::store::use_store(Rc::new(FullDisk));
        let full = |r: HubResult<()>| assert_eq!(r.unwrap_err().message, "ENOSPC: no space left on device");
        full(registry().note("n", |c| c.name = "Renamed".into()));
        full(registry().set_node_token("n", "h2"));
        full(registry().mark_paired("n"));
        full(registry().set_keep_integration("n", false));
        full(registry().add(from(json!({ "id": "b", "name": "B", "kind": "ssh", "target": "b" })), true));
        // as in the TS: the machine is in the list, but nothing polls it or tells the app
        assert!(registry().get("b").is_some());
        full(registry().remove("b", true));
        full(registry().update("n", |c| c.name = "Again".into()));
    });
}

#[test]
fn the_cores_state_used_off_its_thread_is_caught_in_debug_builds() {
    let uses: [(&str, fn()); 4] = [
        ("the registry", || drop(registry())),
        ("the watchers", || drop(crate::claude::watcher::watchers().peek("h", "%1"))),
        ("the drafts", || drop(crate::claude::drafts::get_draft("h:%1"))),
        ("the store", || drop(crate::platform::store::kv::get_value("hosts"))),
    ];
    for (what, used) in uses {
        // a thread with no runtime: an HTTP worker, say, that should have handed the work over
        let caught = std::thread::spawn(used).join().is_err();
        assert_eq!(caught, cfg!(debug_assertions), "{what}");
    }
}

#[test]
fn the_tests_fake_machine_answers_on_a_later_turn_as_a_real_one_does() {
    run(|| async {
        let _fake = Fake::install(|_, _, _| ok("x"));
        let h = host("f", "local");
        let mut answer = Box::pin(h.run("echo x"));
        assert!(futures_util::FutureExt::now_or_never(&mut answer).is_none());
        assert_eq!(answer.await.unwrap().stdout, "x");
    });
}
