//! The action tests: claude/send.test.ts, answer.test.ts, empty-send.test.ts, ultracode.test.ts,
//! fork.test.ts, the session id checks of features/paths.test.ts, resumeCommand from
//! integration.test.ts and the psmux commands of hosts/win-prelude.test.ts. The TS spies on the
//! registry; here the pane is put in this thread's registry, with polls held as the stubbed
//! `registry.refresh` did, and the machine is a fake that answers like the agent would.

use std::cell::RefCell;
use std::rc::Rc;

use indexmap::IndexMap;
use inyon_protocol::{prompt_key, AgentKind, IntegrationState};
use regex::Regex;
use serde_json::json;

use super::*;
use crate::hosts::host::ExecResult;
use crate::test_support::fake::{ok, Fake};
use crate::test_support::rt::run;
use crate::test_support::{machine, sh, TempDir};
use crate::tmux::tmux::{AgentProc, ProbeResult, TmuxProbe};

const R100: usize = 100;

fn rule(n: usize) -> String {
    "─".repeat(n)
}

/// send-keys' own quoting taken off
fn unq(s: &str) -> String {
    let s = s.strip_prefix('\'').unwrap_or(s);
    let s = s.strip_suffix('\'').unwrap_or(s);
    s.replace(r"'\''", "'")
}

fn keys_re() -> Regex {
    Regex::new(r"send-keys -t \S+ (?:-l -- (.*)|(\S+))$").unwrap()
}

/// A pane in this thread's registry that no poll reads again.
fn pane(host: &str, panes: serde_json::Value) -> crate::hosts::registry::Rt {
    let rt = machine(host, "local", panes);
    rt.borrow_mut().hold_polls();
    rt
}

/// What the last probe found in a pane (`registry.agentProc`).
fn with_proc(rt: &crate::hosts::registry::Rt, pane: &str, pid: f64, cwd: &str, args: &str) {
    let mut procs = IndexMap::new();
    procs.insert(pane.to_owned(), AgentProc { kind: AgentKind::Claude, pid, started_at: 0.0, cwd: Some(cwd.into()), resume: None, args: args.into(), pane_pid: 0.0 });
    let probe = ProbeResult {
        hostname: "box".into(),
        home: "/home/u".into(),
        os: "Linux".into(),
        now: 0.0,
        latency_ms: 0.0,
        tmux: TmuxProbe::Ok,
        integration: IntegrationState::Missing,
        sessions: vec![],
        agent_procs: procs,
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
    };
    rt.borrow_mut().probe = Some(Rc::new(RefCell::new(probe)));
}

// ---------- send.test.ts ----------

#[derive(Clone)]
enum Piece {
    Text(String),
    Paste(String),
}

#[derive(Default)]
struct ClaudeBox {
    pieces: Vec<Piece>,
    pastes: usize,
    sent: Vec<String>,
}

/// Claude's input box as far as a send can tell: a long paste shows as "[Pasted text #N]" and Enter
/// submits what's behind it, so a preview left over from an older draft looks like any other.
fn fake_claude(start: Vec<Piece>) -> Rc<RefCell<ClaudeBox>> {
    let pastes = start.iter().filter(|p| matches!(p, Piece::Paste(_))).count();
    let b = Rc::new(RefCell::new(ClaudeBox { pieces: start, pastes, sent: vec![] }));
    let state = b.clone();
    let re = keys_re();
    Fake::install(move |_, cmd, input| {
        let mut b = state.borrow_mut();
        if cmd.contains("@@CAP") {
            let pastes = b.pastes;
            let shown: String = b.pieces.iter().enumerate().map(|(i, p)| if let Piece::Text(t) = p { t.clone() } else { format!("[Pasted text #{}]", i + pastes) }).collect();
            let r = rule(R100);
            return ok(&format!("@@CAP %9\n● Done.\n{r}\n❯ {shown}\n{r}\n  ⏵⏵ bypass permissions on (shift+tab to cycle)\n"));
        }
        if cmd.contains("paste-buffer") {
            b.pastes += 1;
            let input = input.unwrap_or("").to_owned();
            b.pieces.push(if input.encode_utf16().count() > 800 { Piece::Paste(input) } else { Piece::Text(input) });
        } else {
            for part in cmd.split(" && ") {
                let Some(k) = re.captures(part) else { continue };
                if let Some(t) = k.get(1) {
                    b.pieces.push(Piece::Text(unq(t.as_str())));
                } else {
                    match &k[2] {
                        "C-u" => b.pieces.clear(),
                        "BSpace" => {
                            b.pieces.pop();
                        }
                        "Enter" => {
                            let all: String = b
                                .pieces
                                .iter()
                                .map(|p| match p {
                                    Piece::Text(t) | Piece::Paste(t) => t.clone(),
                                })
                                .collect();
                            b.sent.push(all);
                            b.pieces.clear();
                        }
                        _ => {}
                    }
                }
            }
        }
        ok("")
    });
    pane("local", json!([{ "id": "%9", "width": 100, "agent": { "kind": "claude", "pid": 7, "state": "idle" } }]));
    b
}

#[test]
fn a_paste_preview_left_by_an_older_draft_is_replaced_not_sent() {
    run(|| async {
        let message = format!("Hey so I have one problem with how we load messages. {}", "and then some more words ".repeat(60));
        // the mirror pasted the draft while it was still being dictated: a shorter start of the message
        let b = fake_claude(vec![Piece::Paste(message[..918].to_owned())]);
        send_message_to_pane("local", "%9", &message, true, false).await.unwrap();
        assert_eq!(b.borrow().sent, [message]);
    });
}

#[test]
fn a_short_message_typed_into_an_empty_box_goes_in_as_typed() {
    run(|| async {
        let b = fake_claude(vec![]);
        send_message_to_pane("local", "%9", "hello there", true, false).await.unwrap();
        assert_eq!(b.borrow().sent, ["hello there"]);
    });
}

#[test]
fn an_old_draft_that_differs_only_in_whitespace_is_replaced_not_sent() {
    run(|| async {
        let b = fake_claude(vec![Piece::Text(r#"print("A B")"#.into())]);
        send_message_to_pane("local", "%9", r#"print("AB")"#, true, false).await.unwrap();
        assert_eq!(b.borrow().sent, [r#"print("AB")"#]);
    });
}

#[test]
fn a_new_session_with_an_unknown_agent_is_refused_before_anything_is_created() {
    run(|| async {
        let fake = Fake::install(|_, _, _| ok("%5\n"));
        pane("local", json!([]));
        let opts = LaunchOpts { agent: Some("nonsense".into()), ..Default::default() };
        assert_eq!(launch("local", &opts).await.unwrap_err().message, "Unknown agent");
        assert!(fake.cmds().is_empty());
    });
}

// ---------- answer.test.ts ----------

fn screen_for(body: &str) -> Vec<String> {
    [body, "", "Do you want to proceed?", "❯ 1. Yes", "  2. No", "", "Esc to cancel"].map(str::to_owned).to_vec()
}

#[test]
fn an_answer_meant_for_a_question_already_answered_elsewhere_never_lands_on_the_next_one() {
    run(|| async {
        let seen = screen_for("Allow reading README.md?");
        let now = screen_for("Allow replacing the deployment configuration?");
        let keys = Rc::new(RefCell::new(Vec::<String>::new()));
        let k = keys.clone();
        let shown = now.join("\n");
        let _fake = Fake::install(move |_, cmd, _| {
            if cmd.contains("capture-pane") {
                return ok(&format!("@@CAP %7\n{shown}"));
            }
            if cmd.contains("send-keys") {
                k.borrow_mut().push(cmd.to_owned());
            }
            ok("")
        });
        pane("box", json!([{ "id": "%7", "width": 120, "agent": { "kind": "claude", "pid": 7, "state": "idle" } }]));
        let key = |lines: &[String]| {
            let p = parse_screen(lines, Some(120), AgentKind::Claude).prompt.unwrap();
            prompt_key(&p.body, &p.options)
        };

        // the card showed the README question; the screen now asks about the deployment config
        let err = answer("box", "%7", 1, None, Some(&key(&seen))).await.unwrap_err();
        assert!(err.message.contains("another one is waiting"), "{}", err.message);
        assert!(keys.borrow().is_empty());
        // answering the question that's actually there works
        answer("box", "%7", 1, None, Some(&key(&now))).await.unwrap();
        assert_eq!(keys.borrow().len(), 1);
        assert!(keys.borrow()[0].ends_with(" 1"), "{}", keys.borrow()[0]);
    });
}

// ---------- empty-send.test.ts ----------

#[test]
fn an_empty_message_is_refused_before_it_counts_as_a_send() {
    run(|| async {
        let _fake = Fake::install(|_, _, _| ok(""));
        pane("empty-send", json!([{ "id": "%9", "title": "claude", "agent": { "kind": "claude", "pid": 7, "state": "idle" } }]));
        let err = send_message("empty-send", "%9", "   ", true, Some("app-empty"), false, false).await.unwrap_err();
        assert_eq!((err.status, err.message.as_str()), (Some(400), "Message is empty"));
        // nothing is followed, so the next thing the agent writes isn't taken for it
        let w = watchers().get("empty-send", "%9");
        assert_eq!(w.delivery("app-empty"), None);
        watchers().stop("empty-send:%9");
    });
}

// ---------- ultracode.test.ts ----------

#[derive(Default)]
struct UltraPane {
    on: bool,
    text: String,
    said: String,
    sent: Vec<String>,
}

/// A Claude pane as far as the switch can tell: its box, the "ultracode" label on the box's rule
/// while the switch is on, and what Claude prints under `/effort ultracode` when it can't.
fn fake_ultra(on: bool, refuse: Option<&str>) -> Rc<RefCell<UltraPane>> {
    let p = Rc::new(RefCell::new(UltraPane { on, ..Default::default() }));
    let state = p.clone();
    let refuse = refuse.map(str::to_owned);
    let re = keys_re();
    let toggle = Regex::new(r"^/effort ultracode (on|off)$").unwrap();
    Fake::install(move |_, cmd, _| {
        let mut p = state.borrow_mut();
        if cmd.contains("@@CAP") {
            let r = rule(R100);
            let top = if p.on { format!("{} ultracode ─", rule(88)) } else { r.clone() };
            let answer = if p.said.is_empty() { String::new() } else { format!("❯ /effort ultracode on\n  ⎿  {}\n", p.said) };
            return ok(&format!("@@CAP %9\n● Done.\n{answer}{top}\n❯ {}\n{r}\n  ⏵⏵ bypass permissions on (shift+tab to cycle)\n", p.text));
        }
        for part in cmd.split(" && ") {
            let Some(k) = re.captures(part) else { continue };
            if let Some(t) = k.get(1) {
                let t = unq(t.as_str());
                p.text.push_str(&t);
            } else {
                match &k[2] {
                    "C-u" => p.text.clear(),
                    "BSpace" => {
                        p.text.pop();
                    }
                    "Enter" => {
                        let text = std::mem::take(&mut p.text);
                        if let Some(m) = toggle.captures(&text) {
                            match &refuse {
                                Some(r) => p.said = r.clone(),
                                None => p.on = &m[1] == "on",
                            }
                        }
                        p.sent.push(text);
                    }
                    _ => {}
                }
            }
        }
        ok("")
    });
    pane("local", json!([{ "id": "%9", "width": 100, "agent": { "kind": "claude", "pid": 7, "state": "idle" } }]));
    p
}

#[test]
fn turning_ultracode_on_types_the_command_and_the_label_on_the_box_confirms_it() {
    run(|| async {
        let p = fake_ultra(false, None);
        set_ultracode("local", "%9", true).await.unwrap();
        assert_eq!(p.borrow().sent, ["/effort ultracode on"]);
    });
}

#[test]
fn turning_ultracode_off_the_same_way() {
    run(|| async {
        let p = fake_ultra(true, None);
        set_ultracode("local", "%9", false).await.unwrap();
        assert_eq!(p.borrow().sent, ["/effort ultracode off"]);
    });
}

#[test]
fn ultracode_already_as_wanted_nothing_is_typed() {
    run(|| async {
        let p = fake_ultra(true, None);
        set_ultracode("local", "%9", true).await.unwrap();
        assert!(p.borrow().sent.is_empty());
    });
}

#[test]
fn when_claude_cant_its_own_answer_is_the_error() {
    run(|| async {
        fake_ultra(false, Some("Ultracode needs dynamic workflows enabled (see /config). Valid options are: on, off"));
        let err = set_ultracode("local", "%9", true).await.unwrap_err();
        assert!(err.message.contains("Ultracode needs dynamic workflows enabled (see /config)"), "{}", err.message);
    });
}

#[test]
fn ultracode_not_a_claude_pane_refused_before_anything_is_typed() {
    run(|| async {
        let fake = Fake::install(|_, _, _| ok(""));
        pane("local", json!([{ "id": "%9", "width": 100, "agent": { "kind": "codex", "pid": 7, "state": "idle" } }]));
        let err = set_ultracode("local", "%9", true).await.unwrap_err();
        assert!(err.message.contains("Claude Code"), "{}", err.message);
        assert!(fake.cmds().is_empty());
    });
}

// ---------- fork.test.ts ----------

const FORK_ID: &str = "0b6e2a52-3c1d-4f7a-9e44-5d1f0c2b7a19";

fn fork_host() -> Rc<Fake> {
    Fake::install(|_, cmd, _| -> ExecResult {
        if cmd.starts_with("test -s") {
            return ok("yes\n");
        }
        if cmd.contains("new-window") {
            return ok("%9\n");
        }
        if cmd.contains("capture-pane") {
            return ok("@@CAP %9\nuser@box ~/app $ \n");
        }
        if cmd.contains("/cmdline") {
            let bin = if cmd.contains("/41/") { "codex" } else { "claude" };
            return ok(&format!("/usr/bin/node\n/home/u/.local/bin/{bin}\n--model\nopus\n"));
        }
        ok("")
    })
}

fn fork_pane(kind: &str, session: Option<&str>) -> crate::hosts::registry::Rt {
    pane("h", json!([{ "id": "%1", "cwd": "/home/u/app", "agent": { "kind": kind, "pid": 7, "state": "idle", "sessionId": session, "transcriptPath": "/t.jsonl" } }]))
}

/// what was typed, with send-keys' own quoting taken off
fn typed(fake: &Fake) -> String {
    fake.cmds().iter().filter(|c| c.contains("send-keys")).map(|c| c.replace(r"'\''", "'")).collect::<Vec<_>>().join("\n")
}

#[test]
fn a_claude_conversation_forks_into_a_new_window_same_folder_and_flags() {
    run(|| async {
        let fake = fork_host();
        let rt = fork_pane("claude", Some(FORK_ID));
        with_proc(&rt, "%1", 40.0, "/home/u/app", "claude --model opus");
        assert_eq!(fork_conversation("h", "%1").await.unwrap(), "%9");
        assert_eq!(fake.cmds().into_iter().find(|c| c.contains("new-window")).unwrap(), "tmux new-window -t 'work' -c '/home/u/app' -P -F '#{pane_id}'");
        let t = typed(&fake);
        assert!(t.contains(&format!("-t '%9' -l -- 'claude --resume {FORK_ID} '--model' 'opus' --fork-session'")), "{t}");
    });
}

#[test]
fn codex_uses_its_fork_command() {
    run(|| async {
        let fake = fork_host();
        let rt = fork_pane("codex", Some(FORK_ID));
        with_proc(&rt, "%1", 41.0, "/home/u/app", "codex --model opus");
        fork_conversation("h", "%1").await.unwrap();
        let t = typed(&fake);
        assert!(t.contains(&format!("codex fork {FORK_ID} '--model' 'opus'")), "{t}");
    });
}

#[test]
fn nothing_to_fork_before_the_first_message_and_not_every_agent_forks() {
    run(|| async {
        let _fake = fork_host();
        fork_pane("claude", None);
        assert!(fork_conversation("h", "%1").await.unwrap_err().message.contains("No conversation to fork yet"));
        fork_pane("antigravity", Some(FORK_ID));
        assert!(fork_conversation("h", "%1").await.unwrap_err().message.contains("Only Claude Code, Codex and OpenCode"));
    });
}

// ---------- features/paths.test.ts: session ids ----------

#[test]
fn a_resumed_session_id_must_be_a_uuid_before_it_is_typed_into_a_shell() {
    for good in [None, Some(json!(null)), Some(json!("")), Some(json!("7409eef9-d507-4808-a592-0bfabe896e3a"))] {
        assert!(is_session_id(good.as_ref(), None), "{good:?}");
    }
    for bad in [json!("7409eef9-d507-4808-a592-0bfabe896e3a; rm -rf ~"), json!("$(id)"), json!("latest"), json!(["7409eef9-d507-4808-a592-0bfabe896e3a"]), json!(42)] {
        assert!(!is_session_id(Some(&bad), None), "{bad}");
    }
}

#[test]
fn opencodes_own_session_ids_resume_it_only_opencodes_and_nothing_a_shell_reads_as_more() {
    assert!(is_session_id_str(Some("ses_0123456789abcdef"), Some(AgentKind::Opencode)));
    assert!(!is_session_id_str(Some("ses_0123456789abcdef"), Some(AgentKind::Claude)));
    for bad in ["ses_; id", "ses_$(id)", "ses_", "ses_a b"] {
        assert!(!is_session_id_str(Some(bad), Some(AgentKind::Opencode)), "{bad}");
    }
}

// ---------- integration.test.ts: resumeCommand ----------

#[test]
fn resume_keeps_launch_flags_drops_the_old_session_and_any_prompt() {
    let id = "7409eef9-d507-4808-a592-0bfabe896e3a";
    let s = Some(id);
    assert_eq!(resume_command(AgentKind::Claude, s, "claude --dangerously-skip-permissions"), format!("claude --resume {id} '--dangerously-skip-permissions'"));
    assert_eq!(
        resume_command(AgentKind::Claude, s, "/home/u/.local/bin/claude --resume 11111111-2222-3333-4444-555555555555 --model opus fix it"),
        format!("claude --resume {id} '--model' 'opus'")
    );
    assert_eq!(resume_command(AgentKind::Claude, s, "claude -c --permission-mode plan"), format!("claude --resume {id} '--permission-mode' 'plan'"));
    assert_eq!(resume_command(AgentKind::Codex, s, "node /usr/lib/node_modules/@openai/codex/bin/codex.js -m gpt-5 --yolo"), format!("codex resume {id} '-m' 'gpt-5' '--yolo'"));
    assert_eq!(
        resume_command(AgentKind::Antigravity, s, "/home/u/.local/bin/agy --conversation 11111111-2222-3333-4444-555555555555 --mode plan -p hi --dangerously-skip-permissions"),
        format!("agy --conversation {id} '--mode' 'plan' '--dangerously-skip-permissions'")
    );
    assert_eq!(resume_command(AgentKind::Antigravity, None, "agy -c --effort low"), "agy '--effort' 'low'");
}

// ---------- end-session.test.ts: what closing a pane takes ----------

#[test]
fn what_closing_a_pane_takes_with_it() {
    let found = |windows: usize, panes: usize| -> FoundPane {
        let pane = json!({ "id": "%1", "index": 0, "active": true, "command": "sh", "cwd": "/", "title": "", "width": 80, "height": 24, "dead": false });
        let window = json!({ "id": "@1", "index": 0, "name": "w", "active": true, "activity": 0, "panes": vec![pane.clone(); panes] });
        let session = json!({ "id": "$1", "name": "s", "attached": 0, "windows": vec![window.clone(); windows] });
        FoundPane { session: serde_json::from_value(session).unwrap(), window: serde_json::from_value(window).unwrap(), pane: serde_json::from_value(pane).unwrap(), home: None }
    };
    assert_eq!(closes(&found(2, 2)), Closes::Pane);
    assert_eq!(closes(&found(2, 1)), Closes::Window);
    assert_eq!(closes(&found(1, 1)), Closes::Session);
}

// ---------- hosts/win-prelude.test.ts: psmux ----------
// The first four check apps/node/win-prelude.sh on its own, with no hub code, and the sign-in one
// is features/signin.ts; they stay with the TS.

const PRELUDE: &str = include_str!("../../../../apps/node/win-prelude.sh");

#[test]
fn an_agent_that_exits_on_windows_leaves_powershell_behind_and_remain_on_exit_is_set_on_the_window() {
    // a stand-in for psmux's tmux.exe: logs its argv
    let bin = TempDir::new("psmux-");
    let log = bin.path("argv");
    bin.write("tmux", &format!("#!/bin/sh\nfor a in \"$@\"; do printf '[%s]' \"$a\" >> \"{}\"; done; echo >> \"{}\"\n", log.display(), log.display()));
    std::fs::set_permissions(bin.path("tmux"), std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    bin.write("argv", "");
    let cmd = format!("{}; {}; {}", remain_on_exit(true, "'%14.1'", true), respawn_shell(true, "'%14.1'", None), remain_on_exit(true, "'%14.1'", false));
    let path = format!("{}:/usr/bin:/bin", bin.s());
    sh(&format!("{PRELUDE}\n{cmd}"), None, &[("PATH", &path)]);
    assert_eq!(
        bin.read("argv"),
        "[set-option][-w][-t][$14:.%1][remain-on-exit][on]\n[respawn-pane][-k][-t][$14:.%1][powershell.exe]\n[set-option][-w][-t][$14:.%1][-u][remain-on-exit]\n"
    );
}

#[test]
fn a_paste_loads_its_buffer_into_the_panes_own_psmux_server_since_each_session_has_its_own() {
    let bin = TempDir::new("psmux-");
    let log = bin.path("argv");
    bin.write("tmux", &format!("#!/bin/sh\nfor a in \"$@\"; do printf '[%s]' \"$a\" >> \"{}\"; done; echo >> \"{}\"\n", log.display(), log.display()));
    std::fs::set_permissions(bin.path("tmux"), std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    let cmd = crate::tmux::tmux::paste_command("b1", "%14.1");
    let path = format!("{}:/usr/bin:/bin", bin.s());
    let tmp = Regex::new(r"\[[^\]]*tmp[^\]]*\]").unwrap();
    let go = |env: &[(&str, &str)]| {
        bin.write("argv", "");
        let mut all = vec![("PATH", path.as_str())];
        all.extend_from_slice(env);
        sh(&format!("{PRELUDE}\n{cmd}"), Some(b"x\ny"), &all);
        tmp.replace(&bin.read("argv"), "[file]").into_owned()
    };
    assert_eq!(go(&[("OS", "Windows_NT")]), "[-t][$14:.%1][load-buffer][-b][b1][file]\n[paste-buffer][-d][-p][-b][b1][-t][$14:.%1]\n");
    // tmux has one server, and no -t before the command
    assert_eq!(go(&[]), "[load-buffer][-b][b1][file]\n[paste-buffer][-d][-p][-b][b1][-t][$14:.%1]\n");
}
