use inyon_protocol::{AgentKind, ChatItem, PromptOption, SessionInfo};
use serde_json::{json, Value};

use super::*;

fn sessions(v: Value) -> Vec<SessionInfo> {
    serde_json::from_value(v).unwrap()
}

fn pane(id: &str, agent: Option<&str>) -> Value {
    let mut p = json!({ "id": id, "index": 0, "active": true, "command": "x", "cwd": "/", "title": "", "width": 80, "height": 24, "dead": false });
    if let Some(k) = agent {
        p["agent"] = json!({ "kind": k, "pid": 1, "state": "idle" });
    }
    p
}

fn session(name: &str, panes: Vec<Value>) -> Value {
    json!({ "id": "$1", "name": name, "attached": 0, "windows": [{ "id": "@1", "index": 0, "name": "w", "active": true, "activity": 0, "panes": panes }] })
}

fn marked(s: &[SessionInfo]) -> Vec<String> {
    s.iter().flat_map(|s| s.windows.iter().flat_map(|w| w.panes.iter())).filter(|p| p.companion == Some(true)).map(|p| p.id.clone()).collect()
}

#[test]
fn only_the_first_agent_pane_of_the_companion_session_on_the_hubs_machine_is_marked() {
    let all = || {
        sessions(json!([session("main", vec![pane("%1", Some("claude"))]), session("companion", vec![pane("%2", None), pane("%3", Some("claude")), pane("%4", Some("codex"))])]))
    };
    let mut s = all();
    mark("local", &mut s, true);
    assert_eq!(marked(&s), ["%3"]);
    // turned off, or another machine's session of that name: nothing
    let mut s = all();
    mark("local", &mut s, false);
    assert!(marked(&s).is_empty());
    let mut s = all();
    mark("laptop", &mut s, true);
    assert!(marked(&s).is_empty());
    // a mark from an earlier poll goes once the agent has quit
    let mut s = all();
    mark("local", &mut s, true);
    for p in s[1].windows[0].panes.iter_mut() {
        p.agent = None;
    }
    mark("local", &mut s, true);
    assert!(marked(&s).is_empty());
    assert!(s[1].windows[0].panes.iter().all(|p| p.companion.is_none()));
}

fn opts(labels: &[&str]) -> Vec<PromptOption> {
    labels.iter().enumerate().map(|(i, l)| PromptOption { n: i as u64 + 1, label: (*l).into(), detail: None, selected: false, checked: None, current: None }).collect()
}

#[test]
fn a_choice_is_picked_by_its_number_or_its_words() {
    let o = opts(&["Yes", "Yes, and don't ask again for git push", "No, and tell Claude what to do differently"]);
    assert_eq!(pick_choice(&o, "2").unwrap().0, 2);
    assert_eq!(pick_choice(&o, " yes ").unwrap().0, 1);
    assert_eq!(pick_choice(&o, "no").unwrap().0, 3);
    assert_eq!(pick_choice(&o, "don't ask").unwrap().0, 2);
    // more than one starts with it, or nothing matches: the choices are listed
    let o2 = opts(&["Yes, once", "Yes, always"]);
    let e = pick_choice(&o2, "yes").unwrap_err();
    assert!(e.contains("More than one") && e.contains("1. Yes, once, 2. Yes, always"), "{e}");
    assert!(pick_choice(&o, "4").unwrap_err().contains("no choice 4"));
    assert!(pick_choice(&o, "maybe").unwrap_err().contains("no choice like \"maybe\""));
    assert!(pick_choice(&o, "  ").unwrap_err().starts_with("Name a choice"));
}

fn items(v: Value) -> Vec<ChatItem> {
    serde_json::from_value(v).unwrap()
}

#[test]
fn a_conversation_reads_as_who_said_what_with_the_last_entries_kept() {
    let base = |seq: i64| json!({ "seq": seq, "uuid": format!("u{seq}"), "ts": "" });
    let mut list = vec![];
    let mut add = |extra: Value| {
        let mut v = base(list.len() as i64);
        v.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        list.push(v);
    };
    add(json!({ "kind": "user", "text": "port the **parser**", "images": 0 }));
    add(json!({ "kind": "assistant", "msgId": "m", "block": { "type": "thinking", "text": "hmm" } }));
    add(json!({ "kind": "assistant", "msgId": "m", "block": { "type": "tool_use", "id": "t", "name": "Bash", "input": { "command": "cargo test\n-q" } } }));
    add(json!({ "kind": "tool_result", "toolUseId": "t", "isError": false, "text": "ok" }));
    add(json!({ "kind": "tool_result", "toolUseId": "t", "isError": true, "text": "boom" }));
    add(json!({ "kind": "assistant", "msgId": "m", "block": { "type": "text", "text": "## Done\n- `parse` works" } }));
    add(json!({ "kind": "turn_end", "durationMs": 5 }));
    let out = condense(&items(Value::Array(list)), 20);
    assert_eq!(
        out,
        vec![
            json!({ "role": "you", "text": "port the parser" }),
            json!({ "role": "tool", "text": "Bash: cargo test -q" }),
            json!({ "role": "error", "text": "boom" }),
            json!({ "role": "agent", "text": "Done\nparse works" }),
        ]
    );
}

#[test]
fn condense_keeps_only_the_last_entries_asked_for() {
    let list: Vec<Value> = (0..5).map(|i| json!({ "kind": "user", "seq": i, "uuid": "u", "ts": "", "text": format!("m{i}"), "images": 0 })).collect();
    let out = condense(&items(Value::Array(list)), 2);
    assert_eq!(out, vec![json!({ "role": "you", "text": "m3" }), json!({ "role": "you", "text": "m4" })]);
}

#[test]
fn the_instructions_start_with_the_line_that_lets_inyon_rewrite_them() {
    let text = instructions();
    assert_eq!(text.lines().next(), Some(MARK));
    // start() looks for this phrase in the first line
    assert!(MARK.contains("Inyon rewrites this file"));
    for cmd in ["inyon sessions", "inyon read", "inyon send", "inyon answer"] {
        assert!(text.contains(cmd), "{cmd}");
    }
    // reading runs without asking; sending and answering ask first
    let allow = claude_settings()["permissions"]["allow"].clone();
    assert!(allow.as_array().unwrap().iter().all(|a| !a.as_str().unwrap().contains("send") && !a.as_str().unwrap().contains("answer")));
    assert!(launch_flags(AgentKind::Codex).iter().any(|f| f.contains("network_access=true")));
    assert!(launch_flags(AgentKind::Claude).is_empty());
}

#[test]
fn the_agent_setting_is_read_once_and_written_through() {
    crate::test_support::rt::run(|| async {
        crate::platform::store::kv::set_value("settings", &json!({ "companion": { "agent": "codex" } })).unwrap();
        AGENT.with(|a| *a.borrow_mut() = None);
        assert_eq!(agent(), Some(AgentKind::Codex));
        set_agent(None).unwrap();
        assert_eq!(agent(), None);
        assert!(crate::platform::store::kv::get_value("settings").unwrap().get("companion").is_none());
        set_agent(Some(AgentKind::Claude)).unwrap();
        AGENT.with(|a| *a.borrow_mut() = None);
        assert_eq!(agent(), Some(AgentKind::Claude));
        assert_eq!(status()["agent"], json!("claude"));
    });
}
