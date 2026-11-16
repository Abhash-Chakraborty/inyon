//! Searching saved conversations: the command each machine runs (with ripgrep, with grep, and
//! with busybox's tools as Windows has them), what it prints, and the answer from every machine.

use std::rc::Rc;

use inyon_protocol::AgentKind::{Claude, Codex, Copilot, Opencode};
use inyon_protocol::HostConfig;
use serde_json::{json, Value};

use super::*;
use crate::hosts::host::{set_host_backends, ExecResult, HostBackend, OnData, OnLine, PtyHandle, StreamHandle};
use crate::platform::rt::Deferred;
use crate::test_support::rt::run;
use crate::test_support::sandbox::Sandbox;
use crate::test_support::{host, machine, sh, TempDir};

const CWD: &str = "/work/app";
const OTHER: &str = "/work/other";

fn id(n: u32) -> String {
    format!("00000000-0000-4000-8000-{n:012}")
}

fn day() -> u64 {
    crate::js::date::parse("2026-10-12T00:00:00Z") as u64 / 1000
}

fn file(home: &TempDir, path: &str, lines: &[Value], mtime: u64) {
    let text: Vec<String> = lines.iter().map(|l| l.as_str().map(str::to_owned).unwrap_or_else(|| l.to_string())).collect();
    home.write(path, &(text.join("\n") + "\n"));
    let f = std::fs::File::options().write(true).open(home.path(path)).unwrap();
    f.set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(mtime)).unwrap();
}

/// A Claude Code line as it writes them: the folder first, the message after.
fn claude_line(kind: &str, cwd: &str, text: &str) -> Value {
    json!({ "parentUuid": null, "isSidechain": false, "cwd": cwd, "sessionId": "x", "type": kind, "message": { "role": kind, "content": text } })
}

fn sqlite(db: &std::path::Path, sql: &str) {
    std::fs::create_dir_all(db.parent().unwrap()).unwrap();
    let (code, _, err) = sh(&format!("sqlite3 '{}'", db.display()), Some(sql.as_bytes()), &[]);
    assert_eq!(code, 0, "{err}");
}

/// A throwaway home with each agent's transcripts; the real ones are never read.
fn fixture() -> TempDir {
    let home = TempDir::new("inyon-search-");
    let d = day();
    let claude = |dir: &str, n: u32| format!(".claude/projects/{dir}/{}.jsonl", id(n));

    // Claude Code: the match is in Claude's reply; renamed with /rename
    file(
        &home,
        &claude("-work-app", 1),
        &[
            json!({ "type": "mode" }),
            claude_line("user", CWD, "Fix the login page"),
            claude_line("assistant", CWD, "We fixed the OAuth token refresh in auth.ts, and the tests pass."),
            json!({ "type": "custom-title", "customTitle": "Auth work" }),
        ],
        d + 300,
    );
    file(&home, &claude("-work-app", 2), &[claude_line("user", CWD, "Write the README"), json!({ "type": "ai-title", "aiTitle": "Readme draft" })], d + 200);
    // another folder, in capitals
    file(&home, &claude("-work-other", 3), &[claude_line("user", OTHER, "Make OAUTH errors friendlier")], d + 400);
    // a subagent's transcript belongs to its conversation, not one of its own
    file(&home, &format!(".claude/projects/-work-app/{}/subagents/agent-a.jsonl", id(1)), &[claude_line("user", CWD, "oauth subtask")], d + 500);
    // nothing was said: can't be resumed
    file(&home, &claude("-work-app", 4), &[json!({ "type": "summary", "summary": "oauth" })], d + 600);
    // words a shell, grep or awk would read as more than text
    file(
        &home,
        &claude("-work-app", 5),
        &[claude_line("user", CWD, "Why does $(touch $HOME/pwned) and `id` print '; echo hi; ' in .* [abc] -v %s @QUERY@ line one\nline two")],
        d + 100,
    );
    // a file Claude keeps next to them that isn't a transcript
    home.write(".claude/projects/-work-app/memory/notes.md", "oauth notes\n");

    // Codex
    let meta = |n: u32, cwd: &str, source: &str| json!({ "type": "session_meta", "payload": { "id": id(n), "cwd": cwd, "source": source, "instructions": "x".repeat(500) } });
    let msg = |role: &str, text: &str| json!({ "type": "response_item", "payload": { "type": "message", "role": role, "content": [{ "type": "input_text", "text": text }] } });
    let roll = |n: u32, seg: &str| format!(".codex/sessions/2026/10/12/rollout-2026-10-12T00-00-00-{}{seg}.jsonl", id(n));
    file(&home, &roll(10, ""), &[meta(10, CWD, "cli"), msg("user", "Add a login screen"), msg("assistant", "Done: OAuth buttons for GitHub and Google.")], d + 50);
    file(&home, &roll(11, ""), &[meta(11, CWD, "vscode"), msg("user", "Speed up oauth checks")], d + 60);
    file(&home, &roll(11, &format!("_{}", id(99))), &[meta(11, CWD, "vscode"), msg("user", "Rewound oauth")], d + 90);
    // `codex exec` runs aren't in Codex's own picker
    file(&home, &roll(12, ""), &[meta(12, CWD, "exec"), msg("user", "oauth from a script")], d + 70);
    file(&home, ".codex/session_index.jsonl", &[json!({ "id": id(10), "thread_name": "Login screen" })], d);

    // GitHub Copilot
    let s = ".copilot/session-state";
    file(&home, &format!("{s}/{}/workspace.yaml", id(20)), &[json!(format!("id: {}", id(20))), json!(format!("cwd: {CWD}")), json!("name: Token work")], d + 20);
    file(&home, &format!("{s}/{}/events.jsonl", id(20)), &[json!({ "type": "user.message", "data": { "content": "rotate the oauth secret" } })], d + 20);

    // OpenCode
    let ms = |s: u64| s * 1000;
    sqlite(
        &home.path(".local/share/opencode/opencode.db"),
        &format!(
            "create table session (id text primary key, title text, directory text, parent_id text, time_created integer, time_updated integer, agent text, model text, time_archived integer);
create table part (id text primary key, message_id text, session_id text, time_created integer, time_updated integer, data text);
insert into session values ('ses_auth', 'Refactor parser', '{CWD}', null, 1, {}, null, null, null);
insert into session values ('ses_title', 'OAuth cleanup', '{OTHER}', null, 1, {}, null, null, null);
insert into session values ('ses_child', 'Subtask', '{CWD}', 'ses_auth', 1, {}, null, null, null);
insert into session values ('ses_gone', 'Archived oauth', '{CWD}', null, 1, {}, null, null, 5);
insert into part values ('p1', 'm1', 'ses_auth', 1, 1, '{{\"type\":\"text\",\"text\":\"the OAuth callback breaks\"}}');
insert into part values ('p2', 'm2', 'ses_child', 1, 1, '{{\"type\":\"text\",\"text\":\"oauth\"}}');",
            ms(d + 10),
            ms(d + 5),
            ms(d + 700),
            ms(d + 800)
        ),
    );
    home
}

/// Runs the files part of the search on the fixture with this finder; `path` replaces PATH.
fn files(home: &TempDir, q: &str, finder: Finder, path: Option<&str>) -> (Vec<ConversationHit>, bool) {
    let prefix = path.map(|p| format!("PATH='{p}'; export PATH\n")).unwrap_or_default();
    let (code, out, err) = sh(&format!("{prefix}{}", search_script(&clean_query(q).unwrap(), finder)), None, &[("HOME", &home.s())]);
    assert_eq!(code, 0, "{err}");
    parse_search(&out, &clean_query(q).unwrap())
}

/// A folder of busybox's tools under their own names, as Windows runs Inyon's commands with.
fn busybox_path() -> Option<TempDir> {
    let (code, bb, _) = sh("command -v busybox", None, &[]);
    if code != 0 {
        return None;
    }
    let dir = TempDir::new("inyon-bb-");
    for tool in ["grep", "awk", "stat", "xargs", "sort", "head", "tail", "cut", "tr", "timeout", "cat"] {
        std::os::unix::fs::symlink(bb.trim(), dir.path(tool)).unwrap();
    }
    Some(dir)
}

fn ids(hits: &[ConversationHit]) -> Vec<(AgentKind, String)> {
    hits.iter().map(|h| (h.agent, h.id.clone())).collect()
}

// ---------- the words ----------

#[test]
fn the_words_lose_control_characters_and_extra_spaces_and_must_be_long_enough() {
    assert_eq!(clean_query("  fixed\n\tauth\0 bug  ").unwrap(), "fixed auth bug");
    assert_eq!(clean_query(&"a".repeat(500)).unwrap().len(), MAX_QUERY);
    assert_eq!(clean_query(" ab ").unwrap_err().status, Some(400));
    assert!(clean_query("\n\n").unwrap_err().message.contains("at least 3"));
}

#[test]
fn the_words_reach_the_shell_as_one_quoted_argument_and_nowhere_else() {
    for q in ["$(touch x)", "`id`", "it's \"here\"", "; rm -rf ~", "@QUERY@ @FIND@", "-e x", "a\\b"] {
        let script = search_script(q, Finder::Auto);
        let first = format!("q={}\n", shq(q));
        assert!(script.starts_with(&first), "{script}");
        // given to the tools only through "$q", never written into the command
        assert!(!script[first.len()..].contains(q), "{q} appears outside its quotes");
    }
}

// ---------- each machine's search ----------

fn expect_fixture_hits(hits: &[ConversationHit], more: bool) {
    let d = day();
    assert_eq!(ids(hits), [(Claude, id(3)), (Claude, id(1)), (Codex, id(11)), (Codex, id(10)), (Copilot, id(20))], "{hits:#?}");
    assert!(!more);
    let auth = &hits[1];
    assert_eq!((auth.title.as_str(), auth.cwd.as_deref(), auth.at), ("Auth work", Some(CWD), (d + 300) * 1000));
    // the reply holding the words, not the folder every line names
    assert!(auth.snippet.starts_with("We fixed the OAuth token refresh"), "{}", auth.snippet);
    assert_eq!(hits[0].cwd.as_deref(), Some(OTHER));
    assert_eq!(hits[0].snippet, "Make OAUTH errors friendlier");
    // a rewound Codex thread is one conversation, as new as its newest file
    assert_eq!((hits[2].title.as_str(), hits[2].at), ("Speed up oauth checks", (d + 90) * 1000));
    assert_eq!((hits[3].title.as_str(), hits[3].cwd.as_deref()), ("Login screen", Some(CWD)));
    assert_eq!(hits[3].snippet, "Done: OAuth buttons for GitHub and Google.");
    assert_eq!((hits[4].title.as_str(), hits[4].cwd.as_deref(), hits[4].snippet.as_str()), ("Token work", Some(CWD), "rotate the oauth secret"));
}

#[test]
fn ripgrep_finds_the_conversations_newest_first_with_titles_folders_and_snippets() {
    let home = fixture();
    let (hits, more) = files(&home, "oauth", Finder::Ripgrep, None);
    expect_fixture_hits(&hits, more);
}

#[test]
fn grep_finds_the_same_ones() {
    let home = fixture();
    let (hits, more) = files(&home, "OAuth", Finder::Grep, None);
    expect_fixture_hits(&hits, more);
}

#[test]
fn busyboxs_tools_find_the_same_ones_and_without_ripgrep_grep_is_used() {
    let Some(bb) = busybox_path() else { return eprintln!("no busybox here: skipped") };
    let home = fixture();
    let (hits, more) = files(&home, "oauth", Finder::Auto, Some(&bb.s()));
    expect_fixture_hits(&hits, more);
    let (_, out, _) = sh(&format!("PATH='{}'\n{}", bb.s(), search_script("oauth", Finder::Auto)), None, &[("HOME", &home.s())]);
    assert!(out.contains("\u{1e}@@TOOL\tgrep\n"), "{out}");
}

#[test]
fn hostile_words_are_searched_for_as_text_and_run_nothing() {
    let bb = busybox_path();
    let home = fixture();
    let mut finders = vec![(Finder::Ripgrep, None), (Finder::Grep, None)];
    if let Some(bb) = &bb {
        finders.push((Finder::Auto, Some(bb.s())));
    }
    for (finder, path) in finders {
        for q in ["$(touch $HOME/pwned)", "`id`", "'; echo hi; '", "in .*", "[abc]", "-v %s", "@QUERY@", "one\\nline"] {
            let (hits, _) = files(&home, q, finder, path.as_deref());
            assert_eq!(ids(&hits), [(Claude, id(5))], "{q} with {finder:?}");
            assert!(!hits[0].snippet.is_empty(), "{q} with {finder:?}: no snippet");
            assert!(!home.exists("pwned"), "{q} ran something");
        }
        // as a pattern, ".*" would have matched every transcript
        assert!(files(&home, "nothing like this", finder, path.as_deref()).0.is_empty());
    }
}

#[test]
fn a_machine_with_no_transcripts_answers_with_nothing() {
    let home = TempDir::new("inyon-search-empty-");
    assert_eq!(files(&home, "oauth", Finder::Auto, None), (vec![], false));
}

#[test]
fn past_the_limit_the_newest_are_kept_and_more_is_said() {
    let home = TempDir::new("inyon-search-many-");
    for n in 0..(PER_MACHINE as u32 + 3) {
        file(&home, &format!(".claude/projects/-w/{}.jsonl", id(100 + n)), &[claude_line("user", "/w", &format!("oauth {n}"))], day() + n as u64);
    }
    let (hits, more) = files(&home, "oauth", Finder::Auto, None);
    assert_eq!(hits.len(), PER_MACHINE);
    assert!(more);
    assert_eq!(hits[0].id, id(100 + PER_MACHINE as u32 + 2));
}

#[test]
fn opencode_finds_top_level_sessions_by_their_parts_or_title() {
    let home = fixture();
    Sandbox::install(&home.s());
    run(|| async {
        let r = host("m", "local").exec(&ocdb_query_command(&opencode_search_sql("oauth", PER_MACHINE)), ExecOptions::default()).await.unwrap();
        let hits = parse_opencode(&ocdb_query_rows(&r.stdout), "oauth");
        let got: Vec<(&str, &str, &str)> = hits.iter().map(|h| (h.id.as_str(), h.title.as_str(), h.snippet.as_str())).collect();
        assert_eq!(got, [("ses_auth", "Refactor parser", "the OAuth callback breaks"), ("ses_title", "OAuth cleanup", "OAuth cleanup")]);
        assert_eq!(hits[0].cwd.as_deref(), Some(CWD));
    });
}

#[test]
fn opencodes_query_keeps_the_words_inside_a_string() {
    let sql = opencode_search_sql("it's'); drop table session; --", 5);
    assert!(sql.contains("'it''s''); drop table session; --'"), "{sql}");
    let home = fixture();
    Sandbox::install(&home.s());
    run(|| async {
        let h = host("m", "local");
        let r = h.exec(&ocdb_query_command(&sql), ExecOptions::default()).await.unwrap();
        assert!(parse_opencode(&ocdb_query_rows(&r.stdout), "x").is_empty());
        // still there
        let again = h.exec(&ocdb_query_command(&opencode_search_sql("oauth", 5)), ExecOptions::default()).await.unwrap();
        assert_eq!(ocdb_query_rows(&again.stdout).len(), 2);
    });
}

#[test]
fn one_machine_searches_files_and_opencode_together_newest_first() {
    let home = fixture();
    Sandbox::install(&home.s());
    run(|| async {
        let (hits, more) = search_machine(&host("m", "local"), "oauth").await.unwrap();
        assert_eq!(ids(&hits)[..3], [(Claude, id(3)), (Claude, id(1)), (Codex, id(11))]);
        assert_eq!(hits.iter().filter(|h| h.agent == Opencode).count(), 2);
        assert!(hits.windows(2).all(|w| w[0].at >= w[1].at));
        assert!(!more);
    });
}

// ---------- what a machine printed ----------

#[test]
fn printed_results_parse_and_what_doesnt_fit_is_left_out() {
    let out = [
        "noise before",
        "\u{1e}@@TOOL\trg",
        &format!("\u{1e}claude\t1790000000\t/h/.claude/projects/-w/{}.jsonl", id(1)),
        "@@S",
        r#"rt":"text","text":"We fixed \"auth\" today\nfor good"}]}"#,
        "@@C",
        r#""cwd":"C:\\code\\app""#,
        "@@T",
        r#"{"type":"ai-title","aiTitle":"Old title"}"#,
        r#"{"type":"ai-title","aiTitle":"Auth fix"}"#,
        "@@U",
        r#"{"type":"user","message":{"role":"user","content":"hello"}}"#,
        "\u{1e}claude\t1790000000\t/h/.claude/projects/-w/not-a-uuid.jsonl",
        "@@U",
        r#"{"type":"user","message":{"role":"user","content":"hello"}}"#,
        &format!("\u{1e}gemini\t1\t/h/{}.jsonl", id(2)),
        &format!("\u{1e}codex\t1790000100\t/h/.codex/sessions/rollout-x-{}.jsonl", id(3)),
        "@@C",
        r#""cwd":"/w""#,
        "@@U",
        r#"{"type":"response_item","payload":{"role":"user","content":[{"type":"input_text","text":"Start"}]}}"#,
        "\u{1e}@@MORE",
        "\u{1e}@@INDEX",
        &json!({ "id": id(3), "thread_name": "Named thread" }).to_string(),
        "",
    ]
    .join("\n");
    let (hits, more) = parse_search(&out, "auth");
    assert!(more);
    assert_eq!(
        hits,
        [
            ConversationHit {
                agent: Claude,
                id: id(1),
                cwd: Some("C:\\code\\app".into()),
                title: "Auth fix".into(),
                at: 1_790_000_000_000,
                snippet: "We fixed \"auth\" today for good".into()
            },
            ConversationHit { agent: Codex, id: id(3), cwd: Some("/w".into()), title: "Named thread".into(), at: 1_790_000_100_000, snippet: String::new() },
        ]
    );
}

#[test]
fn snippets_are_the_text_around_the_words() {
    // inside a string: its text, unescaped, on one line
    assert_eq!(snippet_of(r#"{"type":"text","text":"Line one\nwe fixed AUTH\there"}"#, "auth"), "Line one we fixed AUTH here");
    // cut short on the machine at either end
    assert_eq!(snippet_of(r#"so the auth flow works","n":1}"#, "auth"), "…so the auth flow works");
    assert_eq!(snippet_of(r#"{"text":"so the auth flow wo"#, "auth"), "so the auth flow wo…");
    // a long string is cut around the words, starting on a word
    let long = format!(r#"{{"text":"{} auth {}"}}"#, "word ".repeat(40), "tail ".repeat(60));
    let s = snippet_of(&long, "auth");
    assert!(s.starts_with('…') && s.ends_with('…') && s.contains(" auth "), "{s}");
    assert!(s.chars().count() <= BEFORE + AFTER + 6, "{}", s.chars().count());
    assert!(s[3..].starts_with("word"), "{s}");
    // a character cut in two at the edge is dropped
    assert_eq!(snippet_of("\u{fffd}\"text\":\"café auth\"\u{fffd}", "auth"), "café auth");
}

// ---------- every machine ----------

/// A machine that never answers.
struct Silent;

impl HostBackend for Silent {
    fn exec(&self, _: &HostConfig, _: &str, _: ExecOptions) -> futures_util::future::LocalBoxFuture<'static, HubResult<ExecResult>> {
        Box::pin(futures_util::future::pending())
    }
    fn stream(&self, _: &HostConfig, _: &str, _: OnLine, _: bool) -> StreamHandle {
        StreamHandle::new(|| {}, Deferred::resolved(0))
    }
    fn pty(&self, _: &HostConfig, _: &str, _: u16, _: u16, _: OnData) -> HubResult<PtyHandle> {
        Ok(PtyHandle::new(|_| {}, |_, _| {}, || {}, Deferred::resolved(0)))
    }
}

fn named(id: &str, name: &str) -> crate::hosts::registry::Rt {
    let rt = machine(id, "local", json!([]));
    rt.borrow_mut().state.config.name = name.into();
    rt
}

#[test]
fn every_online_machine_is_searched_at_once_a_silent_one_times_out_and_an_offline_one_is_skipped() {
    let home = fixture();
    let sandbox = Rc::new(Sandbox { home: home.s(), prefix: String::new() });
    set_host_backends(move |c| if c.id == "slow" { Rc::new(Silent) as Rc<dyn HostBackend> } else { sandbox.clone() });
    run(|| async {
        named("slow", "Slow box");
        named("laptop", "Laptop");
        named("off", "Old server").borrow_mut().state.status = HostStatus::Error;
        let r = search_conversations_within("  oauth ", 5_000).await.unwrap();
        assert_eq!(r.query, "oauth");
        let order: Vec<(&str, usize, Option<&str>, Option<&str>)> = r.machines.iter().map(|m| (m.name.as_str(), m.hits.len(), m.error.as_deref(), m.skipped.as_deref())).collect();
        assert_eq!(order, [("Laptop", 7, None, None), ("Slow box", 0, Some("Took too long to answer"), None), ("Old server", 0, None, Some("Offline"))]);
        assert_eq!(r.machines[0].host, "laptop");
        assert!(search_conversations_within("x", 5_000).await.is_err());
    });
}

fn hit(at: u64) -> ConversationHit {
    ConversationHit { agent: Claude, id: id(at as u32), cwd: None, title: "t".into(), at, snippet: String::new() }
}

fn m(name: &str, hits: Vec<ConversationHit>) -> ConversationSearchMachine {
    ConversationSearchMachine { host: name.to_lowercase(), name: name.into(), hits, more: None, error: None, skipped: None }
}

#[test]
fn machines_with_the_newest_matches_come_first_then_empty_failed_and_skipped_ones() {
    let failed = ConversationSearchMachine { error: Some("ssh: refused".into()), ..m("Failed", vec![]) };
    let off = ConversationSearchMachine { skipped: Some("Offline".into()), ..m("Asleep", vec![]) };
    let many = m("Many", (1..=PER_MACHINE as u64 + 2).map(hit).collect());
    let merged = merge(vec![off, m("empty", vec![]), failed, m("Old", vec![hit(5), hit(9)]), many, m("Empty too", vec![])]);
    let names: Vec<&str> = merged.iter().map(|m| m.name.as_str()).collect();
    assert_eq!(names, ["Many", "Old", "empty", "Empty too", "Failed", "Asleep"]);
    // each machine's newest first, cut to the limit
    assert_eq!(merged[1].hits.iter().map(|h| h.at).collect::<Vec<_>>(), [9, 5]);
    assert_eq!(merged[0].hits.len(), PER_MACHINE);
    assert_eq!(merged[0].hits[0].at, PER_MACHINE as u64 + 2);
    assert_eq!(merged[0].more, Some(true));
}
