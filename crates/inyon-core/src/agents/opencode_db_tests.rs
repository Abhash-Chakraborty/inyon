//! agents/opencode-db.test.ts runs the reader's shell script against a real SQLite file; that
//! part is the caller's now. These check the same cases on the rows such a database gives back:
//! the cache, the session picker, the stamp, the shape and the session row.

use super::*;
use serde_json::json;

const S: &str = "ses_test0000000000000000001";
const OLDER: &str = "ses_test0000000000000000002";

fn sessions() -> Vec<Value> {
    vec![
        json!({ "id": OLDER, "title": "Older talk", "directory": "/work", "parent_id": null, "time_created": 500, "time_updated": 900, "agent": null, "model": null }),
        json!({ "id": S, "title": "Greeting", "directory": "/work", "parent_id": null, "time_created": 1000, "time_updated": 5000, "agent": "build", "model": "x/y" }),
    ]
}

/// a conversation is read in milliseconds, whatever its diff summaries weigh
#[test]
fn a_conversation_is_read_in_milliseconds_whatever_its_diff_summaries_weigh() {
    // the rows as the two queries return them (the summary was left in the database)
    let messages = vec![
        json!({ "id": "msg_1", "time_created": 1000, "time_updated": 1000, "data": "{\"role\":\"user\",\"time\":{\"created\":1000}}" }),
        json!({ "id": "msg_2", "time_created": 2000, "time_updated": 5000, "data": "{\"role\":\"assistant\",\"time\":{\"created\":2000},\"modelID\":\"y\",\"providerID\":\"x\",\"cost\":0.5}" }),
    ];
    let parts = vec![
        json!({ "id": "prt_2", "message_id": "msg_2", "time_created": 2000, "time_updated": 2000, "data": "{\"type\":\"text\",\"text\":\"hello \\\"there\\\"\\nline | two\"}" }),
        json!({ "id": "prt_1", "message_id": "msg_1", "time_created": 1000, "time_updated": 1000, "data": "{\"type\":\"text\",\"text\":\"hi\"}" }),
        json!({ "id": "prt_bad", "message_id": "msg_1", "time_created": 1, "time_updated": 1, "data": "not json" }),
    ];
    let mut cache = OcdbCache::new();
    cache.merge(&messages, &parts);
    assert_eq!(cache.stamp, 5000.0);
    let list = cache.list(None);
    let texts: Vec<&str> = list.iter().map(|m| m["parts"][0]["text"].as_str().unwrap()).collect();
    assert_eq!(texts, ["hi", "hello \"there\"\nline | two"]);
    assert_eq!(list[1]["info"], json!({ "role": "assistant", "time": { "created": 2000 }, "modelID": "y", "providerID": "x", "cost": 0.5, "id": "msg_2" }));
    assert_eq!(list[0]["parts"][0]["messageID"], "msg_1");
    // /undo back to msg_2 hides it and what came after
    assert_eq!(cache.list(Some("msg_2")).len(), 1);
    cache.retain(&HashSet::from(["msg_2".to_owned()]));
    assert_eq!(cache.list(None).len(), 1);
    let (m, p) = ocdb_rows_queries(S, 2000.7).unwrap();
    assert!(m.contains("json_remove(data, '$.summary')") && m.contains("time_updated >= 2000 "));
    assert!(p.starts_with("select json_group_array(json_object('id', id, 'message_id', message_id, "));
}

/// the folder's conversations come newest first, and the pane title names the one on screen
#[test]
fn the_folders_conversations_come_newest_first_and_the_pane_title_names_the_one_on_screen() {
    let rows = ocdb_sessions(&sessions());
    assert_eq!(rows.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), [S, OLDER]);
    let proc = OpenCodeProc { cwd: Some("/work".into()), started_at: 0.0, args: None };
    assert_eq!(guess_open_code_session(&proc, &rows, None, Some("OC | Older talk")), Some(format!("{OCDB}{OLDER}")));
    assert_eq!(guess_open_code_session(&proc, &rows, None, Some("OpenCode")).as_deref(), Some(OCDB));
    assert!(ocdb_sessions_query("/it's", 30).contains("directory = '/it''s'"));
}

#[test]
fn without_a_title_it_goes_by_the_session_flag_the_screen_and_what_moved() {
    let rows = ocdb_sessions(&sessions());
    let proc = |args: &str, started_at: f64| OpenCodeProc { cwd: Some("/work".into()), started_at, args: Some(args.into()) };
    assert_eq!(guess_open_code_session(&OpenCodeProc { cwd: None, ..proc("", 0.0) }, &rows, None, None), None);
    assert_eq!(guess_open_code_session(&proc("opencode -s ses_abc", 0.0), &rows, None, None), Some(format!("{OCDB}ses_abc")));
    let screen = vec!["  Older talk".to_owned(), "> ".to_owned()];
    assert_eq!(guess_open_code_session(&proc("", 0.0), &rows, Some(&screen), None), Some(format!("{OCDB}{OLDER}")));
    // nothing on screen: the one that moved since the process started
    assert_eq!(guess_open_code_session(&proc("", 4.0), &rows, None, None), Some(format!("{OCDB}{S}")));
    assert_eq!(guess_open_code_session(&proc("", 100.0), &rows, None, None).as_deref(), Some(OCDB));
    assert_eq!(guess_open_code_session(&proc("opencode -c", 100.0), &rows, None, None), Some(format!("{OCDB}{S}")));
}

/// stamp, shape and the session row (title, cost, lines changed, share link)
#[test]
fn stamp_shape_and_the_session_row_title_cost_lines_changed_share_link() {
    assert_eq!(ocdb_stamp(&[json!({ "t": 5000 })]), 5000.0);
    let shape = ocdb_shape(&[json!({ "id": "msg_1" }), json!({ "id": "msg_2" })], &[json!({ "revert": null })]);
    assert_eq!(shape.ids, HashSet::from(["msg_1".to_owned(), "msg_2".to_owned()]));
    assert_eq!(shape.revert, None);
    assert_eq!(ocdb_shape(&[], &[json!({ "revert": "{\"messageID\":\"msg_2\"}" })]).revert.as_deref(), Some("msg_2"));
    let info = ocdb_session_info(&[
        json!({ "title": "Greeting", "cost": 0.5, "summary_additions": 3, "summary_deletions": 1, "summary_files": 2, "share_url": "https://opencode.ai/s/abc" }),
    ]);
    assert_eq!(
        info,
        Some(OcdbSessionInfo {
            title: Some("Greeting".into()),
            cost: Some(0.5),
            additions: Some(3.0),
            deletions: Some(1.0),
            files: Some(2.0),
            share: Some("https://opencode.ai/s/abc".into())
        })
    );
    let older = ocdb_session_info(&[json!({ "title": "Older talk", "cost": 0, "summary_additions": null, "summary_deletions": null, "summary_files": null, "share_url": null })]);
    assert_eq!(older, Some(OcdbSessionInfo { title: Some("Older talk".into()), cost: Some(0.0), ..Default::default() }));
    assert_eq!(ocdb_rows_queries("ses_nothing'; drop", 0.0), None);
    assert_eq!(ocdb_stamp_query("nope"), None);
}

/// a machine without the database answers with nothing, not an error
#[test]
fn a_machine_without_the_database_answers_with_nothing_not_an_error() {
    assert_eq!(ocdb_query_rows("@@NODB\n"), Vec::<Value>::new());
    assert_eq!(ocdb_query_rows(""), Vec::<Value>::new());
    assert_eq!(ocdb_sessions(&ocdb_query_rows("@@NODB")), vec![]);
    assert_eq!(ocdb_stamp(&[]), 0.0);
    // `opencode db` wraps the array in a result set
    assert_eq!(ocdb_query_rows("[{\"rows\":\"[{\\\"t\\\":7}]\"}]"), vec![json!({ "t": 7 })]);
    assert_eq!(ocdb_query_rows("[{\"t\":7}]"), vec![json!({ "t": 7 })]);
    assert!(ocdb_query_command("select 1").starts_with("Q='select 1'\n"));
    assert!(is_ocdb(Some("opencode-db:ses_a")) && !is_ocdb(None));
    assert_eq!(ocdb_session("opencode-db:ses_a1"), Some("ses_a1"));
    assert_eq!(ocdb_session("opencode-db:"), None);
}
