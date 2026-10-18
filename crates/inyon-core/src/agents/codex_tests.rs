//! agents/codex.test.ts, test for test. Each test's name in the TS file is its doc comment. The
//! tests of codexHistory (it reads files) and of the model list (codex-models.ts) stay in TS.

use super::*;
use crate::claude::transcript::new_meta;
use crate::test_support::assert_match;
use serde_json::json;

fn rec(t: &str, payload: Value) -> Value {
    json!({ "timestamp": "2026-10-17T17:00:30.000Z", "type": t, "payload": payload })
}

fn item(item: Value) -> Value {
    rec("event_msg", json!({ "type": "item_completed", "thread_id": "t", "turn_id": "turn-1", "item": item }))
}

/// `ev`: a payload as the record type it comes in
fn ev(meta: &mut TranscriptMeta, payload: Value) -> Vec<ChatItem> {
    let t = if payload["type"] == "item_completed" { "event_msg" } else { "response_item" };
    normalize_codex(&json!({ "type": t, "timestamp": "t", "payload": payload }), meta)
}

fn to_json(items: &[ChatItem]) -> Value {
    serde_json::to_value(items).unwrap()
}

/// Codex permission presets are read from current and legacy settings
#[test]
fn codex_permission_presets_are_read_from_current_and_legacy_settings() {
    assert_eq!(codex_permission(&json!({ "permission_profile": { "type": "disabled" } })).as_deref(), Some("full-access"));
    assert_eq!(codex_permission(&json!({ "approvals_reviewer": "auto_review" })).as_deref(), Some("auto-review"));
    assert_eq!(codex_permission(&json!({ "permission_profile": { "type": "managed", "file_system": { "entries": [{ "access": "read" }] } } })).as_deref(), Some("read-only"));
    assert_eq!(codex_permission(&json!({ "permission_profile": { "type": "managed", "file_system": { "entries": [{ "access": "write" }] } } })).as_deref(), Some("default"));
    assert_eq!(codex_permission(&json!({ "thread_settings": { "sandbox_policy": { "type": "read-only" } } })).as_deref(), Some("read-only"));
    assert_eq!(codex_permission(&json!({})), None);
}

/// describe('codex exec scripts')
mod codex_exec_scripts {
    use super::*;

    /// one shell command reads as Bash
    #[test]
    fn one_shell_command_reads_as_bash() {
        let code = "const r = await tools.exec_command({cmd:\"curl -sI https://example.com | head -1\", yield_time_ms:30000});\ntext(r.output);\n";
        assert_eq!(codex_script(code), ("Bash".into(), json!({ "command": "curl -sI https://example.com | head -1" })));
    }

    /// a patch held in a variable reads as ApplyPatch
    #[test]
    fn a_patch_held_in_a_variable_reads_as_applypatch() {
        let code = "const p = \"*** Begin Patch\\n*** Update File: calc.py\\n@@\\n+def subtract(a, b):\\n*** End Patch\";\ntext(await tools.apply_patch(p));\n";
        assert_eq!(codex_script(code), ("ApplyPatch".into(), json!({ "patch": "*** Begin Patch\n*** Update File: calc.py\n@@\n+def subtract(a, b):\n*** End Patch" })));
    }

    /// mixed calls show the script
    #[test]
    fn mixed_calls_show_the_script() {
        assert_eq!(codex_script("await tools.exec_command({cmd:\"ls\"}); await tools.view_image({path:\"a.png\"})").0, "Script");
    }

    /// script output drops the header and reads the exit code
    #[test]
    fn script_output_drops_the_header_and_reads_the_exit_code() {
        let mut meta = new_meta();
        let mut out = |texts: &[&str]| {
            let output: Vec<Value> = texts.iter().map(|t| json!({ "type": "input_text", "text": t })).collect();
            to_json(&normalize_codex(
                &json!({ "type": "response_item", "timestamp": "t", "payload": { "type": "custom_tool_call_output", "call_id": "c1", "output": output } }),
                &mut meta,
            ))[0]
                .clone()
        };
        let ok = out(&["Script completed\nWall time 0.1 seconds\nOutput:\n", "HTTP/2 200\n", "exit_code=0"]);
        assert_eq!(ok["text"], "HTTP/2 200");
        assert_eq!(ok["isError"], false);
        let bad = out(&["Script completed\nWall time 0.1 seconds\nOutput:\n", "curl: (6) Could not resolve host\n", "exit_code=6"]);
        assert_eq!(bad["isError"], true);
        assert_eq!(bad["text"], "curl: (6) Could not resolve host");
    }
}

/// describe('codex terminal title')
mod codex_terminal_title {
    use super::*;

    /// keeps the thread name
    #[test]
    fn keeps_the_thread_name() {
        assert_eq!(codex_title("[!] Action Required | Use gpt-6-luna high | codex", Some("/tmp/qa/codex")), "Use gpt-6-luna high");
        assert_eq!(codex_title("Respond to greeting | custom-tmux", Some("/home/u/custom-tmux")), "Respond to greeting");
        assert_eq!(codex_title("⠋ Working | Fix the parser | app", Some("/src/app")), "Fix the parser");
    }

    /// no thread name yet is no title
    #[test]
    fn no_thread_name_yet_is_no_title() {
        assert_eq!(codex_title("codex", Some("/src/app")), "");
        assert_eq!(codex_title("app", Some("/src/app")), "");
    }
}

/// describe('codex goals')
mod codex_goals {
    use super::*;

    /// set from the goal event, met from update_goal output; the bookkeeping call is hidden
    #[test]
    fn set_from_the_goal_event_met_from_update_goal_output_the_bookkeeping_call_is_hidden() {
        let mut meta = new_meta();
        let goal = json!({ "objective": "Create goal.txt", "status": "active" });
        let set = normalize_codex(&json!({ "type": "event_msg", "timestamp": "t1", "payload": { "type": "thread_goal_updated", "goal": goal } }), &mut meta);
        assert_match(&set, json!([{ "kind": "goal", "condition": "Create goal.txt", "met": false }]));
        let call = normalize_codex(
            &json!({ "type": "response_item", "timestamp": "t2", "payload": { "type": "custom_tool_call", "name": "exec", "call_id": "g", "input": "text(await tools.update_goal({status:\"complete\"}));\n" } }),
            &mut meta,
        );
        assert_eq!(call, vec![]);
        let done = json!({ "goal": { "objective": "Create goal.txt", "status": "complete" } });
        let out = json!([{ "type": "input_text", "text": "Script completed\nWall time 0.0 seconds\nOutput:\n" }, { "type": "input_text", "text": stringify(&done) }]);
        let met =
            normalize_codex(&json!({ "type": "response_item", "timestamp": "t3", "payload": { "type": "custom_tool_call_output", "call_id": "g", "output": out } }), &mut meta);
        assert_match(&met, json!([{ "kind": "goal", "condition": "Create goal.txt", "met": true }]));
        assert_match(&meta.goal, json!({ "condition": "Create goal.txt", "met": true }));
    }

    /// Codex's internal goal context is not a user message
    #[test]
    fn codexs_internal_goal_context_is_not_a_user_message() {
        let text = "<codex_internal_context source=\"goal\">\nContinue working toward the active thread goal.\n</codex_internal_context>";
        assert_eq!(
            normalize_codex(
                &json!({ "type": "response_item", "timestamp": "t", "payload": { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": text }] } }),
                &mut new_meta()
            ),
            vec![]
        );
    }
}

/// describe('codex file changes')
mod codex_file_changes {
    use super::*;

    /// the reported diff becomes the patch result
    #[test]
    fn the_reported_diff_becomes_the_patch_result() {
        assert_eq!(
            serde_json::to_value(unified_hunks("@@ -2 +2,5 @@\n     return a + b\n+\n+\n+def subtract(a, b):\n+    return a - b\n")).unwrap(),
            json!([{ "oldStart": 2, "oldLines": 1, "newStart": 2, "newLines": 5, "lines": ["     return a + b", "+", "+", "+def subtract(a, b):", "+    return a - b"] }])
        );
        let mut meta = new_meta();
        ev(
            &mut meta,
            json!({ "type": "custom_tool_call", "name": "exec", "call_id": "p1", "input": "const p = \"*** Begin Patch\\n*** Update File: a.py\\n@@\\n+x\\n*** End Patch\";\ntext(await tools.apply_patch(p));" }),
        );
        ev(
            &mut meta,
            json!({ "type": "item_completed", "item": { "type": "FileChange", "changes": { "/w/a.py": { "type": "update", "unified_diff": "@@ -1 +1,2 @@\n a\n+x\n" } } } }),
        );
        let r = ev(
            &mut meta,
            json!({ "type": "custom_tool_call_output", "call_id": "p1", "output": [{ "type": "input_text", "text": "Script completed\nWall time 0.1 seconds\nOutput:\n" }, { "type": "input_text", "text": "{}" }] }),
        );
        assert_eq!(to_json(&r)[0]["meta"]["patch"], json!([{ "oldStart": 1, "oldLines": 1, "newStart": 1, "newLines": 2, "lines": [" a", "+x"] }]));
    }
}

/// describe('codex rollout matching')
mod codex_rollout_matching {
    use super::*;

    fn row(id: &str, created: f64, mtime: f64, cwd: &str) -> CodexRollout {
        CodexRollout { path: format!("/s/rollout-{id}.jsonl"), id: Some(id.into()), cwd: Some(cwd.into()), created, mtime }
    }
    fn p(pid: i64, started_at: f64) -> CodexProc {
        CodexProc { pid, cwd: Some("/w".into()), started_at, ..Default::default() }
    }
    fn names(e: &[(&str, &str)]) -> HashMap<String, String> {
        e.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect()
    }
    fn path(id: &str) -> Option<String> {
        Some(format!("/s/rollout-{id}.jsonl"))
    }

    /// two sessions in one folder each keep their own thread
    #[test]
    fn two_sessions_in_one_folder_each_keep_their_own_thread() {
        let (a, b) = (p(1, 100.0), p(2, 200.0));
        // A's thread was written most recently, B's was created after B started
        let rows = [row("ta", 101.0, 500.0, "/w"), row("tb", 201.0, 400.0, "/w")];
        let both = [a.clone(), b.clone()];
        assert_eq!(pick_codex_rollout(&rows, &a, &both, &names(&[])), path("ta"));
        assert_eq!(pick_codex_rollout(&rows, &b, &both, &names(&[])), path("tb"));
    }

    /// a thread picked with /resume is found by the name Codex shows
    #[test]
    fn a_thread_picked_with_resume_is_found_by_the_name_codex_shows() {
        let (a, b) = (p(1, 1000.0), p(2, 1100.0));
        let n = names(&[("greet", "Respond to greeting")]);
        // made two days earlier, written again since this Codex started
        let rows = [row("greet", 100.0, 1200.0, "/w"), row("other", 150.0, 1150.0, "/w")];
        let titled = CodexProc { title: Some("Respond to greeting".into()), ..a.clone() };
        assert_eq!(pick_codex_rollout(&rows, &titled, std::slice::from_ref(&a), &n), path("greet"));
        assert_eq!(pick_codex_rollout(&rows, &titled, &[a.clone(), b], &n), path("greet"));
        // without the name it can't be told from a thread another Codex is writing
        assert_eq!(pick_codex_rollout(&rows, &a, std::slice::from_ref(&a), &names(&[])), None);
    }

    /// /new in a lone session moves to the new thread
    #[test]
    fn new_in_a_lone_session_moves_to_the_new_thread() {
        let a = p(1, 100.0);
        assert_eq!(pick_codex_rollout(&[row("old", 101.0, 300.0, "/w"), row("new", 400.0, 450.0, "/w")], &a, std::slice::from_ref(&a), &names(&[])), path("new"));
    }

    /// the thread name in the title settles it; a resume id beats everything
    #[test]
    fn the_thread_name_in_the_title_settles_it_a_resume_id_beats_everything() {
        let a = CodexProc { title: Some("Fix parser | w".into()), ..p(1, 100.0) };
        let b = p(2, 200.0);
        let rows = vec![row("ta", 101.0, 300.0, "/w"), row("tb", 201.0, 400.0, "/w")];
        // A ran /new after B started: only the name says which thread is A's
        let mut later = rows.clone();
        later.push(row("ta2", 250.0, 500.0, "/w"));
        let both = [a.clone(), b.clone()];
        assert_eq!(pick_codex_rollout(&later, &a, &both, &names(&[("ta2", "Fix parser")])), path("ta2"));
        assert_eq!(pick_codex_rollout(&rows, &CodexProc { resume: Some("ta".into()), ..b }, &both, &names(&[])), path("ta"));
    }

    /// other folders and threads from before the process started are ignored
    #[test]
    fn other_folders_and_threads_from_before_the_process_started_are_ignored() {
        let a = p(1, 100.0);
        assert_eq!(pick_codex_rollout(&[row("x", 101.0, 900.0, "/elsewhere"), row("old", 50.0, 800.0, "/w")], &a, std::slice::from_ref(&a), &names(&[])), None);
    }
}

/// completed Codex patches accumulate session lines once; failed patches do not
#[test]
fn completed_codex_patches_accumulate_session_lines_once_failed_patches_do_not() {
    let mut meta = new_meta();
    let event = |id: &str, status: &str| json!({ "type": "event_msg", "payload": { "type": "item_completed", "item": { "type": "FileChange", "id": id, "status": status, "changes": { "/tmp/a": { "type": "update", "unified_diff": "@@ -1,2 +1,3 @@\n same\n-old\n+new\n+extra\n" } } } } });
    normalize_codex(&event("a", "completed"), &mut meta);
    normalize_codex(&event("a", "completed"), &mut meta);
    normalize_codex(&event("b", "failed"), &mut meta);
    assert_match(&meta.stats, json!({ "linesAdded": 2, "linesRemoved": 1 }));
    normalize_codex(&event("c", "completed"), &mut meta);
    assert_match(&meta.stats, json!({ "linesAdded": 4, "linesRemoved": 2 }));
}

/// Codex default and nested explicit reasoning effort are preserved
#[test]
fn codex_default_and_nested_explicit_reasoning_effort_are_preserved() {
    let mut meta = new_meta();
    normalize_codex(&json!({ "type": "turn_context", "payload": { "model": "gpt-6.1-sol", "collaboration_mode": { "settings": { "reasoning_effort": "high" } } } }), &mut meta);
    assert_eq!(meta.effort.as_deref(), Some("high"));
    normalize_codex(&json!({ "type": "turn_context", "payload": { "model": "gpt-6.1-sol", "collaboration_mode": { "settings": { "reasoning_effort": null } } } }), &mut meta);
    assert_eq!(meta.effort.as_deref(), Some("default"));
}

/// direct shell commands render input and output without an assistant turn
#[test]
fn direct_shell_commands_render_input_and_output_without_an_assistant_turn() {
    let rows = normalize_codex(
        &json!({ "type": "event_msg", "timestamp": "2026-10-10T12:00:00Z", "payload": { "type": "item_completed", "item": { "type": "CommandExecution", "source": "user_shell", "command": ["/bin/sh", "-lc", "printf hello"], "aggregated_output": "hello" } } }),
        &mut new_meta(),
    );
    assert_match(&rows[0], json!({ "kind": "user", "text": "printf hello", "shell": true }));
    assert_match(&rows[1], json!({ "kind": "command", "name": "!", "output": "hello" }));
}

/// describe('codex records keep their own ids')
mod codex_records_keep_their_own_ids {
    use super::*;

    /// a reply's item id is the app-server's, so a live copy can be matched to it
    #[test]
    fn a_replys_item_id_is_the_app_servers_so_a_live_copy_can_be_matched_to_it() {
        let mut meta = new_meta();
        let a = to_json(&normalize_codex(
            &rec(
                "response_item",
                json!({ "type": "message", "status": "completed", "id": "msg_05b5d60b8898bebc016ad3a9afaa7c81919a0a99b324450b29", "role": "assistant", "content": [{ "type": "output_text", "text": "Hi again!" }], "phase": "final_answer" }),
            ),
            &mut meta,
        ));
        assert_eq!(a[0]["uuid"], "msg_05b5d60b8898bebc016ad3a9afaa7c81919a0a99b324450b29");
        assert_eq!(a[0]["msgId"], a[0]["uuid"]);
        let r = to_json(&normalize_codex(
            &rec("response_item", json!({ "type": "reasoning", "id": "rs_1", "summary": [{ "type": "summary_text", "text": "Thinking it over" }] })),
            &mut meta,
        ));
        assert_eq!(r[0]["uuid"], "rs_1");
        assert_eq!(r[0]["block"], json!({ "type": "thinking", "text": "Thinking it over" }));
    }
}

/// describe('codex turns')
mod codex_turns {
    use super::*;

    /// task_started marks the turn under way; task_complete ends it with its duration
    #[test]
    fn task_started_marks_the_turn_under_way_task_complete_ends_it_with_its_duration() {
        let mut meta = new_meta();
        assert_eq!(
            normalize_codex(&rec("event_msg", json!({ "type": "task_started", "turn_id": "turn-1", "started_at": 1792256430u64, "model_context_window": 258400 })), &mut meta),
            vec![]
        );
        assert_eq!(meta.turn, Some(Turn { id: Some("turn-1".into()), started_at: 1792256430000 }));
        let out = normalize_codex(
            &rec(
                "event_msg",
                json!({ "type": "task_complete", "turn_id": "turn-1", "last_agent_message": "Hi again!", "started_at": 1792256430u64, "completed_at": 1792256431u64, "duration_ms": 1239, "time_to_first_token_ms": 1104 }),
            ),
            &mut meta,
        );
        assert_match(&out, json!([{ "kind": "turn_end", "durationMs": 1239 }]));
        assert_eq!(meta.turn, None);
        assert_eq!(meta.stats.turns, 1);
    }

    /// a turn that ends with an error says so
    #[test]
    fn a_turn_that_ends_with_an_error_says_so() {
        let out = normalize_codex(
            &rec("event_msg", json!({ "type": "task_complete", "turn_id": "t", "duration_ms": 50, "error": { "message": "Rate limit reached" } })),
            &mut new_meta(),
        );
        assert_match(&out, json!([{ "kind": "notice", "level": "error", "text": "Rate limit reached" }, { "kind": "turn_end", "durationMs": 50 }]));
    }

    /// an interrupted turn is over too
    #[test]
    fn an_interrupted_turn_is_over_too() {
        let mut meta = new_meta();
        normalize_codex(&rec("event_msg", json!({ "type": "task_started", "turn_id": "t", "started_at": 1 })), &mut meta);
        assert_match(&normalize_codex(&rec("event_msg", json!({ "type": "turn_aborted", "turn_id": "t" })), &mut meta), json!([{ "kind": "notice", "subtype": "interrupted" }]));
        assert_eq!(meta.turn, None);
    }
}

/// describe('codex questions')
mod codex_questions {
    use super::*;

    /// request_user_input_async becomes a question card; the reply answers it instead of showing as a bubble
    #[test]
    fn request_user_input_async_becomes_a_question_card_the_reply_answers_it_instead_of_showing_as_a_bubble() {
        let mut meta = new_meta();
        let call = to_json(&normalize_codex(
            &rec(
                "response_item",
                json!({ "type": "function_call", "status": "completed", "id": "fc_q", "name": "request_user_input_async", "arguments": "{\"questions\":[{\"title\":\"Colour\",\"options\":[\"Red\",\"Blue\"]}]}", "call_id": "call_32ce" }),
            ),
            &mut meta,
        ));
        assert_eq!(
            call[0]["block"],
            json!({ "type": "tool_use", "id": "call_32ce", "name": "AskUserQuestion", "input": { "questions": [{ "question": "Colour", "options": [{ "label": "Red" }, { "label": "Blue" }] }] } })
        );
        // the async form only acknowledges here
        assert_eq!(
            normalize_codex(&rec("response_item", json!({ "type": "function_call_output", "id": "fco_q", "call_id": "call_32ce", "output": "{\"accepted\":true}" })), &mut meta),
            vec![]
        );
        // Codex sleeps until the answer; nothing to show for that
        assert_eq!(
            normalize_codex(
                &rec(
                    "response_item",
                    json!({ "type": "function_call", "id": "fc_s", "name": "sleep", "namespace": "clock", "arguments": "{\"duration_ms\":3600000}", "call_id": "call_548b" })
                ),
                &mut meta
            ),
            vec![]
        );
        assert_eq!(normalize_codex(&rec("response_item", json!({ "type": "function_call_output", "id": "fco_s", "call_id": "call_548b", "output": "{}" })), &mut meta), vec![]);
        let reply = "<send_user_message_question_reply>\n[{\"answer\":\"Red\",\"question\":\"Colour\",\"questionItemId\":\"[\\\"request_user_input_async\\\",\\\"call_32ce\\\",0]\"}]\n</send_user_message_question_reply>";
        let out = normalize_codex(
            &rec("response_item", json!({ "type": "message", "id": "msg_reply", "role": "user", "content": [{ "type": "input_text", "text": reply }] })),
            &mut meta,
        );
        assert_match(&out, json!([{ "kind": "tool_result", "toolUseId": "call_32ce", "isError": false, "text": "Colour: Red", "meta": { "answers": { "Colour": "Red" } } }]));
    }

    /// the blocking request_user_input gets its answers from the tool output
    #[test]
    fn the_blocking_request_user_input_gets_its_answers_from_the_tool_output() {
        let mut meta = new_meta();
        let args = stringify(
            &json!({ "questions": [{ "id": "q1", "header": "Scope", "question": "Which files?", "options": [{ "label": "All", "description": "Every file" }, { "label": "Some", "description": "" }], "isOther": true }] }),
        );
        normalize_codex(&rec("response_item", json!({ "type": "function_call", "id": "fc", "name": "request_user_input", "arguments": args, "call_id": "call_b" })), &mut meta);
        let output = stringify(&json!({ "answers": { "q1": { "answers": ["All"] } } }));
        let r = normalize_codex(&rec("response_item", json!({ "type": "function_call_output", "id": "fco", "call_id": "call_b", "output": output })), &mut meta);
        assert_match(&r[0], json!({ "kind": "tool_result", "toolUseId": "call_b", "text": "Which files?: All", "meta": { "answers": { "Which files?": "All" } } }));
    }
}

/// describe('codex plans')
mod codex_plans {
    use super::*;

    /// a proposed plan is a plan card, not a tagged message
    #[test]
    fn a_proposed_plan_is_a_plan_card_not_a_tagged_message() {
        let mut meta = new_meta();
        let text = "<proposed_plan>\n## Add a Folder File List to README\n\n### Steps\n1. Add a section.\n</proposed_plan>";
        let a = to_json(&normalize_codex(
            &rec(
                "response_item",
                json!({ "type": "message", "id": "msg_plan", "role": "assistant", "content": [{ "type": "output_text", "text": text }], "phase": "final_answer" }),
            ),
            &mut meta,
        ));
        assert_eq!(
            a[0]["block"],
            json!({ "type": "tool_use", "id": "msg_plan", "name": "ExitPlanMode", "input": { "plan": "## Add a Folder File List to README\n\n### Steps\n1. Add a section." } })
        );
        assert_eq!(normalize_codex(&item(json!({ "type": "Plan", "id": "turn-1-plan", "text": "## Add…" })), &mut meta), vec![]);
    }
}

/// describe('codex scripts with several steps')
mod codex_scripts_with_several_steps {
    use super::*;

    const PATCH_SCRIPT: &str = "const r = await tools.apply_patch(\"*** Begin Patch\\n*** Update File: notes2.txt\\n@@\\n three\\n+four\\n*** End Patch\");\ntext(r);\n";

    fn step(tool: &str, arg: Option<&str>) -> ScriptStep {
        ScriptStep { tool: tool.into(), arg: arg.map(str::to_owned) }
    }

    /// a patch followed by a command reads as a script with both steps
    #[test]
    fn a_patch_followed_by_a_command_reads_as_a_script_with_both_steps() {
        let code = "const r = await tools.apply_patch(\"*** Begin Patch\\n*** Add File: a.txt\\n+a\\n*** End Patch\");\nconst t = await tools.exec_command({cmd:\"bun test\", yield_time_ms: 30000});\ntext(r + t.output);\n";
        let (name, input) = codex_script(code);
        assert_eq!(name, "Script");
        assert_eq!(
            input["steps"],
            json!([{ "tool": "apply_patch", "arg": "*** Begin Patch\n*** Add File: a.txt\n+a\n*** End Patch" }, { "tool": "exec_command", "arg": "bun test" }])
        );
        assert_eq!(
            script_steps("await tools.view_image({path:\"shot.png\"}); await tools.write_stdin({session_id: 3, chars: \"y\\n\"}); tools.mystery(42)"),
            vec![step("view_image", Some("shot.png")), step("write_stdin", Some("y\n")), step("mystery", None)]
        );
    }

    /// the diffs Codex reported go with the script output, whatever the script was
    #[test]
    fn the_diffs_codex_reported_go_with_the_script_output_whatever_the_script_was() {
        let mut meta = new_meta();
        ev(
            &mut meta,
            json!({ "type": "custom_tool_call", "id": "ctc_1", "name": "exec", "call_id": "call_1", "input": "await tools.apply_patch(\"*** Begin Patch\\n*** Add File: a.txt\\n+a\\n*** End Patch\"); const t = await tools.exec_command({cmd:\"cat a.txt\"}); text(t.output)" }),
        );
        ev(
            &mut meta,
            json!({ "type": "item_completed", "item": { "type": "FileChange", "id": "exec-1", "status": "completed", "changes": { "/w/a.txt": { "type": "add", "content": "a\n" } } } }),
        );
        let r = ev(
            &mut meta,
            json!({ "type": "custom_tool_call_output", "id": "ctco_1", "call_id": "call_1", "output": [{ "type": "input_text", "text": "Script completed\nWall time 0.1 seconds\nOutput:\n" }, { "type": "input_text", "text": "a\n" }] }),
        );
        assert_match(
            &r[0],
            json!({ "kind": "tool_result", "toolUseId": "call_1", "text": "a", "meta": { "patch": [{ "oldStart": 0, "oldLines": 0, "newStart": 1, "newLines": 1, "lines": ["+a"] }] } }),
        );
        assert_match(&meta.stats, json!({ "linesAdded": 1 }));
    }

    /// a script still running when it answers is finished by the wait that reads its cell
    #[test]
    fn a_script_still_running_when_it_answers_is_finished_by_the_wait_that_reads_its_cell() {
        let mut meta = new_meta();
        let call = to_json(&ev(&mut meta, json!({ "type": "custom_tool_call", "id": "ctc_2", "name": "exec", "call_id": "call_361a", "input": PATCH_SCRIPT })));
        assert_eq!(call[0]["block"]["name"], "ApplyPatch");
        // approval pending: the script hasn't finished when its output line is written
        assert_eq!(
            ev(
                &mut meta,
                json!({ "type": "custom_tool_call_output", "id": "ctco_2", "call_id": "call_361a", "output": "Script running with cell ID 8\nWall time 31.0 seconds\nOutput:\n" })
            ),
            vec![]
        );
        ev(
            &mut meta,
            json!({ "type": "item_completed", "item": { "type": "FileChange", "id": "exec-65b8", "status": "completed", "changes": { "/w/notes2.txt": { "type": "update", "unified_diff": "@@ -3 +3,2 @@\n three\n+four\n" } } } }),
        );
        assert_eq!(
            ev(&mut meta, json!({ "type": "function_call", "id": "fc_w", "name": "wait", "arguments": "{\"cell_id\":\"8\",\"yield_time_ms\":30000}", "call_id": "call_6f1b" })),
            vec![]
        );
        let r = ev(
            &mut meta,
            json!({ "type": "function_call_output", "id": "fco_w", "call_id": "call_6f1b", "output": [{ "type": "input_text", "text": "Script completed\nWall time 0.0 seconds\nOutput:\n" }, { "type": "input_text", "text": "{}" }] }),
        );
        assert_match(
            &r[0],
            json!({ "kind": "tool_result", "toolUseId": "call_361a", "isError": false, "meta": { "patch": [{ "oldStart": 3, "oldLines": 1, "newStart": 3, "newLines": 2, "lines": [" three", "+four"] }] } }),
        );
    }
}

/// describe('codex sub-agents')
mod codex_sub_agents {
    use super::*;

    /// spawn, activity and the message back are listed and shown
    #[test]
    fn spawn_activity_and_the_message_back_are_listed_and_shown() {
        let mut meta = new_meta();
        let child = "01a14ae4-8cfb-7252-9639-34db58c5b1c9";
        let args = stringify(
            &json!({ "task_name": "pong_only", "fork_turns": "none", "message": "gAAAAABq068-Nm8JQY-ZkjyflSH4UWwPULkZEMWxdyRXFnUiFRmABLWf1b6hvrb0teOqmIUvFkNCnPPueIaAwrY0rDoGQAJOJRibh9YvCePKmuJ6r4-0D9gnde95yS1FOYTePwmC4qncvLXGKrdZ4KKNUfiT0kAmjj7R9rrlwj0Gaxj4l-qbXA8=" }),
        );
        let spawn = to_json(&normalize_codex(
            &rec("response_item", json!({ "type": "function_call", "id": "fc_sp", "name": "spawn_agent", "namespace": "collaboration", "arguments": args, "call_id": "call_2d3" })),
            &mut meta,
        ));
        assert_match(&spawn[0]["block"], json!({ "type": "tool_use", "id": "call_2d3", "name": "spawn_agent", "input": { "task_name": "pong_only", "message": "[encrypted]" } }));
        normalize_codex(
            &item(json!({ "type": "SubAgentActivity", "model": "gpt-6-luna", "id": "call_2d3", "kind": "started", "agent_thread_id": child, "agent_path": "/root/pong_only" })),
            &mut meta,
        );
        assert_match(&meta.subagents.values().collect::<Vec<_>>(), json!([{ "toolUseId": child, "type": "codex", "description": "pong_only", "status": "running" }]));
        let waited = to_json(&normalize_codex(
            &rec(
                "response_item",
                json!({ "type": "function_call", "id": "fc_wa", "name": "wait_agent", "namespace": "collaboration", "arguments": "{\"timeout_ms\":30000}", "call_id": "call_c74" }),
            ),
            &mut meta,
        ));
        assert_eq!(waited[0]["block"]["name"], "wait_agent");
        normalize_codex(
            &item(json!({ "type": "SubAgentActivity", "id": "subagent-completed-x", "kind": "completed", "agent_thread_id": child, "agent_path": "/root/pong_only" })),
            &mut meta,
        );
        assert_eq!(meta.subagents[child].status, SubagentStatus::Done);
        let msg = normalize_codex(
            &rec(
                "response_item",
                json!({ "type": "agent_message", "id": "amsg_1", "author": "/root/pong_only", "recipient": "/root", "content": [{ "type": "input_text", "text": "Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/pong_only\nPayload:\npong" }] }),
            ),
            &mut meta,
        );
        assert_match(&msg[0], json!({ "kind": "notice", "subtype": "task", "level": "info", "text": "pong_only: pong" }));
    }
}

/// a record without an id gets the same id on every read, and two records get two
#[test]
fn a_record_without_an_id_gets_the_same_id_on_every_read_and_two_records_get_two() {
    let said = |text: &str, ts: &str| json!({ "timestamp": ts, "type": "response_item", "payload": { "type": "message", "role": "assistant", "content": [{ "type": "output_text", "text": text }] } });
    let id_of = |e: Value| normalize_codex(&e, &mut new_meta()).first().map(|i| i.uuid().to_owned());
    let t0 = "2026-01-12T09:00:00.000Z";
    let first = id_of(said("Done.", t0));
    assert!(first.is_some());
    assert_eq!(id_of(said("Done.", t0)), first);
    assert_ne!(id_of(said("Done, and the tests pass.", t0)), first);
    assert_ne!(id_of(said("Done.", "2026-01-12T09:00:01.000Z")), first);
    // a record with its own id keeps it
    let mut own = said("Done.", t0);
    own["payload"]["id"] = json!("msg_1");
    assert_eq!(id_of(own).as_deref(), Some("msg_1"));
    // and the hash is the TS one, integer keys and big numbers included (worked out with bun)
    let mut odd = said("Done.", t0);
    odd["payload"]["2"] = json!("x");
    odd["payload"]["é"] = json!(1.5e21);
    assert_eq!(id_of(odd).as_deref(), Some("2026-01-12T09:00:00.000Z:message:6953a93e"));
}

#[test]
fn the_status_reads_the_last_token_count_and_drops_what_is_stale() {
    let line = |v: Value| stringify(&v);
    let out = [
        "1792000000".to_owned(),
        line(json!({ "type": "turn_context", "timestamp": "2026-10-17T17:00:00.000Z", "payload": { "model": "gpt-6", "effort": "high", "permission_profile": { "type": "disabled" } } })),
        line(json!({ "type": "event_msg", "timestamp": "2026-10-17T17:00:30.000Z", "payload": { "type": "token_count", "info": { "model_context_window": 1000, "last_token_usage": { "input_tokens": 400, "output_tokens": 100 } }, "rate_limits": { "primary": { "used_percent": 10, "window_minutes": 300 } } } })),
        line(json!({ "type": "compacted", "timestamp": "2026-10-17T17:01:00.000Z", "payload": {} })),
    ]
    .join("\n");
    let (status, permission) = codex_status(&out);
    let st = status.unwrap();
    assert_eq!(permission.as_deref(), Some("full-access"));
    assert_eq!((st.model_id.as_deref(), st.effort.as_deref()), (Some("gpt-6"), Some("high")));
    assert_eq!(st.context_pct, None);
    assert_eq!(st.stale.as_ref().unwrap().context, Some(StaleContext::Compacted));
    // auth.json is older than the count: the limits stand
    assert!(st.five_hour.is_some());
    let newer = out.replacen("1792000000", "1892000000", 1);
    let st = codex_status(&newer).0.unwrap();
    assert_eq!(st.five_hour, None);
    assert_eq!(st.stale.unwrap().limits, Some(StaleLimits::Account));
}

#[test]
fn rollouts_and_names_are_read_from_the_listing() {
    let out = "1700000100\t/s/rollout-a.jsonl\t{\"timestamp\":\"2026-10-17T17:00:00.000Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"a\",\"cwd\":\"/w/\\u00e9\"\n1700000200\t/s/rollout-b.jsonl\tcut off\n---\n{\"id\":\"a\",\"thread_name\":\"Old\"}\n{\"id\":\"a\",\"thread_name\":\"New\"}\nnot json";
    let (rows, names) = codex_rollouts(out);
    assert_eq!(rows.len(), 2);
    assert_eq!((rows[0].id.as_deref(), rows[0].cwd.as_deref(), rows[0].created), (Some("a"), Some("/w/é"), 1_792_256_400.0));
    assert_eq!((rows[1].id.as_deref(), rows[1].created), (None, 1_700_000_200.0));
    assert_eq!(names["a"], "New");
    assert_eq!(
        codex_history_base("{\"payload\":{\"history_base\":{\"thread_id\":\"01a1255b-fbc5-7371-ab05-ee0aa808a95d\",\"end_ordinal_exclusive\":1,\"end_byte_offset\":42}}}"),
        Some(("01a1255b-fbc5-7371-ab05-ee0aa808a95d".into(), 42))
    );
}
