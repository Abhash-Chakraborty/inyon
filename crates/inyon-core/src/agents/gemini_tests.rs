//! agents/gemini.ts has no tests in TS. These check the reader against what the TS made of the
//! same records (printed with bun from agents/gemini.ts), and the session picker.

use super::*;
use crate::claude::transcript::new_meta;
use serde_json::json;

/// Records covering each kind of edit; `ITEMS` is the TS GeminiDoc's output for them.
const RECORDS: &str = r#"[{"sessionId": "s1", "projectHash": "h", "startTime": "2026-10-10T08:00:00Z", "kind": "main"}, {"id": "u1", "type": "user", "timestamp": "2026-10-10T08:00:01Z", "content": [{"text": "List the files"}, {"text": " please"}], "displayContent": [{"text": "List the files please"}]}, {"id": "g1", "type": "gemini", "timestamp": "2026-10-10T08:00:02Z", "model": "gemini-3-pro", "content": "", "thoughts": [{"subject": "Looking", "description": "at the folder"}, {"subject": "", "description": ""}], "tokens": {"input": 1200, "output": 40, "cached": 300}, "toolCalls": [{"id": "c1", "name": "run_shell_command", "args": {"command": "ls", "description": "List"}, "status": "executing"}, {"id": "c2", "name": "read_many_files", "args": {"paths": ["a.ts", "b.ts"]}}, {"id": "c3", "name": "write_todos", "args": {"todos": [{"description": "one", "status": "in_progress"}, {"content": "two", "status": "x"}]}}, {"id": "c4", "name": "mystery", "args": null}]}, {"$patch": {"id": "g1", "content": "Here they are", "toolCalls": [{"id": "c1", "result": [{"functionResponse": {"response": {"output": "a.ts\nb.ts"}}}]}, {"id": "c2", "result": [{"text": "contents"}]}]}}, {"$patch": {"updates": [{"id": "u1", "content": "ignored since displayContent"}], "orderIds": ["u1", "g1", "nope"]}}, {"id": "w1", "type": "warning", "content": "Quota low"}, {"id": "e1", "type": "error", "content": "  "}, {"id": "u2", "type": "user", "content": "gone soon"}, {"$rewindTo": "u2"}, {"$set": {"summary": "Listing files"}}]"#;
const ITEMS: &str = r#"[{"kind": "user", "uuid": "u1", "ts": "2026-10-10T08:00:01Z", "text": "List the files please", "images": 0, "seq": 0}, {"kind": "assistant", "uuid": "g1:t0", "ts": "2026-10-10T08:00:02Z", "msgId": "g1", "block": {"type": "thinking", "text": "Looking: at the folder"}, "seq": 1}, {"kind": "assistant", "uuid": "g1:x", "ts": "2026-10-10T08:00:02Z", "msgId": "g1", "model": "gemini-3-pro", "block": {"type": "text", "text": "Here they are"}, "seq": 2}, {"kind": "assistant", "uuid": "g1:c1", "ts": "2026-10-10T08:00:02Z", "msgId": "g1", "block": {"type": "tool_use", "id": "c1", "name": "Bash", "input": {"command": "ls", "description": "List"}}, "seq": 3}, {"kind": "tool_result", "uuid": "g1:c1:r", "ts": "2026-10-10T08:00:02Z", "toolUseId": "c1", "isError": false, "text": "a.ts\nb.ts", "meta": {"stdout": ""}, "seq": 4}, {"kind": "assistant", "uuid": "g1:c2", "ts": "2026-10-10T08:00:02Z", "msgId": "g1", "block": {"type": "tool_use", "id": "c2", "name": "Read", "input": {"file_path": "a.ts, b.ts"}}, "seq": 5}, {"kind": "tool_result", "uuid": "g1:c2:r", "ts": "2026-10-10T08:00:02Z", "toolUseId": "c2", "isError": false, "text": "contents", "seq": 6}, {"kind": "assistant", "uuid": "g1:c3", "ts": "2026-10-10T08:00:02Z", "msgId": "g1", "block": {"type": "tool_use", "id": "c3", "name": "TodoWrite", "input": {"todos": [{"content": "one", "activeForm": "one", "status": "in_progress"}, {"content": "two", "status": "pending"}]}}, "seq": 7}, {"kind": "assistant", "uuid": "g1:c4", "ts": "2026-10-10T08:00:02Z", "msgId": "g1", "block": {"type": "tool_use", "id": "c4", "name": "mystery", "input": {}}, "seq": 8}, {"kind": "notice", "uuid": "w1", "ts": "", "level": "warn", "subtype": "info", "text": "Quota low", "seq": 9}]"#;

#[test]
fn a_session_reads_as_the_ts_reads_it() {
    let mut doc = GeminiDoc::new();
    for r in serde_json::from_str::<Vec<Value>>(RECORDS).unwrap() {
        doc.apply(&r);
    }
    let mut meta = new_meta();
    let items = doc.items(&mut meta);
    assert_eq!(serde_json::to_value(&items).unwrap(), serde_json::from_str::<Value>(ITEMS).unwrap());
    assert_eq!(meta.title.as_deref(), Some("Listing files"));
    assert_eq!(meta.model.as_deref(), Some("gemini-3-pro"));
    assert_eq!(meta.stats.turns, 1);
    assert_eq!(meta.stats.context_tokens, Some(Num(1500.0)));
    assert_eq!(meta.status.as_ref().and_then(|s| s.context_used), Some(Num(1500.0)));
}

#[test]
fn the_session_is_the_newest_one_for_the_folder_since_the_process_started() {
    let hash = sha256_hex("/w/app");
    let line = |mtime: u64, path: &str, first: Value| format!("{mtime}\t{path}\t{first}");
    let out = [
        line(2000, "/h/.gemini/tmp/x/chats/session-sub.jsonl", json!({ "projectHash": hash, "kind": "subagent" })),
        line(1500, "/h/.gemini/tmp/x/chats/session-old.jsonl", json!({ "projectHash": hash })),
        line(1900, "/h/.gemini/tmp/y/chats/session-other.jsonl", json!({ "projectHash": "nope" })),
        line(1800, "/h/.gemini/tmp/app/chats/session-named.jsonl", json!("not an object")),
        "garbage".to_owned(),
    ]
    .join("\n");
    let proc = GeminiProc { cwd: Some("/w/app".into()), started_at: 1000.0 };
    // the sub-agent's file is skipped; the folder name in the path counts as a match
    assert_eq!(guess_gemini_session(&out, &proc).as_deref(), Some("/h/.gemini/tmp/app/chats/session-named.jsonl"));
    assert_eq!(guess_gemini_session(&out, &GeminiProc { started_at: 1850.0, ..proc.clone() }), None);
    assert_eq!(guess_gemini_session(&out, &GeminiProc { cwd: None, started_at: 1000.0 }).as_deref(), Some("/h/.gemini/tmp/y/chats/session-other.jsonl"));
    assert!(guess_gemini_session_command("/h", &proc, 1000.0 + 600.0).contains("-mmin -12 "));
}
