//! agents/opencode-keys.test.ts, test for test. Each test's name in the TS file is its doc
//! comment.

use super::*;
use serde_json::json;

fn k(v: &[&str]) -> Option<Vec<String>> {
    Some(v.iter().map(|s| s.to_string()).collect())
}

fn binds(v: &[(&str, &str)]) -> IndexMap<String, String> {
    v.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect()
}

/// describe("OpenCode's key bindings")
mod opencodes_key_bindings {
    use super::*;

    /// OpenCode's key names become tmux's
    #[test]
    fn opencodes_key_names_become_tmuxs() {
        assert_eq!(tmux_keys("tab", None), k(&["Tab"]));
        assert_eq!(tmux_keys("shift+tab", None), k(&["BTab"]));
        assert_eq!(tmux_keys("ctrl+t", None), k(&["C-t"]));
        assert_eq!(tmux_keys("escape", None), k(&["Escape"]));
        assert_eq!(tmux_keys("<leader>m", None), k(&["C-x", "m"]));
        assert_eq!(tmux_keys("<leader>m", Some("ctrl+a")), k(&["C-a", "m"]));
        assert_eq!(tmux_keys("f2", None), k(&["F2"]));
        assert_eq!(tmux_keys("ctrl+alt+g", None), k(&["C-M-g"]));
        assert_eq!(tmux_keys("shift+a", None), k(&["A"]));
        // the first alternative tmux can send
        assert_eq!(tmux_keys("super+k,ctrl+k", None), k(&["C-k"]));
        assert_eq!(tmux_keys("none", None), None);
        assert_eq!(tmux_keys("super+k", None), None);
        assert_eq!(tmux_keys("shift+escape", None), None);
    }

    /// the defaults are what OpenCode 1.19 ships with
    #[test]
    fn the_defaults_are_what_opencode_1_19_ships_with() {
        let keys = keys_from(&IndexMap::new());
        assert_eq!(
            serde_json::to_value(keys).unwrap(),
            json!({ "agent_cycle": ["Tab"], "agent_cycle_reverse": ["BTab"], "variant_cycle": ["C-t"], "model_list": ["C-x", "m"], "session_interrupt": ["Escape"] })
        );
        assert_eq!(DEFAULT_KEYS[0], ("leader", "ctrl+x"));
    }

    /// a config rebinding a key (or the leader) changes what is pressed; one tmux cannot send falls back
    #[test]
    fn a_config_rebinding_a_key_or_the_leader_changes_what_is_pressed_one_tmux_cannot_send_falls_back() {
        let keys = keys_from(&binds(&[("leader", "ctrl+a"), ("agent_cycle", "f2"), ("variant_cycle", "super+v"), ("session_interrupt", "ctrl+c,escape")]));
        assert_eq!(Some(keys.agent_cycle), k(&["F2"]));
        assert_eq!(Some(keys.model_list), k(&["C-a", "m"]));
        assert_eq!(Some(keys.variant_cycle), k(&["C-t"]));
        assert_eq!(Some(keys.session_interrupt), k(&["C-c"]));
    }

    /// opencode.jsonc with comments and trailing commas, user then project
    #[test]
    fn opencode_jsonc_with_comments_and_trailing_commas_user_then_project() {
        assert_eq!(
            parse_jsonc("{ // leader\n \"keybinds\": { \"leader\": \"ctrl+a\", /* block */ \"agent_cycle\": \"f2\", }, \"url\": \"http://x//y\" }"),
            Some(json!({ "keybinds": { "leader": "ctrl+a", "agent_cycle": "f2" }, "url": "http://x//y" }))
        );
        assert_eq!(parse_jsonc("not json"), None);
        assert_eq!(
            merge_keybinds(&["{\"keybinds\":{\"leader\":\"ctrl+a\",\"agent_cycle\":\"f2\"}}", "{\"keybinds\":{\"agent_cycle\":\"f3\"}}", "{\"theme\":\"x\"}"]),
            binds(&[("leader", "ctrl+a"), ("agent_cycle", "f3")])
        );
    }

    /// a comma before a brace or bracket inside a string stays
    #[test]
    fn a_comma_before_a_brace_or_bracket_inside_a_string_stays() {
        assert_eq!(
            parse_jsonc(r#"{ "keybinds": { "leader": ",}", "agent_cycle": "a, ]", "quote": "\",}", }, "list": [1, 2, ], }"#),
            Some(json!({ "keybinds": { "leader": ",}", "agent_cycle": "a, ]", "quote": "\",}" }, "list": [1, 2] }))
        );
        assert_eq!(parse_jsonc("{ \"a\": \"b\" , // note\n /* more */ }"), Some(json!({ "a": "b" })));
    }

    /// reads the user's and the project's files on the machine, and keeps the answer a minute
    ///
    /// (the keeping is the caller's now: this checks the command and how its output reads)
    #[test]
    fn reads_the_users_and_the_projects_files_on_the_machine_and_keeps_the_answer_a_minute() {
        let keys = opencode_keys("@@FILE\n{\"keybinds\":{\"agent_cycle\":\"f2\"}}\n@@FILE\n{\"keybinds\":{\"variant_cycle\":\"f3\"}}\n");
        assert_eq!(Some(keys.agent_cycle), k(&["F2"]));
        assert_eq!(Some(keys.variant_cycle), k(&["F3"]));
        assert_eq!(Some(keys.model_list), k(&["C-x", "m"]));
        let cmd = opencode_keys_command(Some("/work/a b"));
        assert!(cmd.contains("opencode/opencode.jsonc"));
        assert!(cmd.contains("'/work/a b'/.opencode/opencode.json"));
        // a machine that can't be asked gets the defaults
        assert_eq!(Some(opencode_keys("").agent_cycle), k(&["Tab"]));
    }
}

#[test]
fn a_binding_stacking_thousands_of_leaders_falls_back_like_the_ts_without_overflowing() {
    // 12,000 still resolve in Bun: the leader's keys that many times, then the key
    let deep = format!("{}m", "<leader>".repeat(MAX_LEADERS));
    let keys = tmux_keys(&deep, None).unwrap();
    assert_eq!((keys.len(), keys[0].as_str(), keys.last().unwrap().as_str()), (MAX_LEADERS + 1, "C-x", "m"));
    // 20,000 overflow Bun's stack; opencodeKeys catches it and uses the defaults for every key.
    // On a small stack: the recursive version ran out of it long before
    let config = format!("@@FILE\n{{\"keybinds\":{{\"variant_cycle\":\"f3\",\"agent_cycle\":\"{}m\"}}}}\n", "<leader>".repeat(20_000));
    let keys = std::thread::Builder::new().stack_size(256 * 1024).spawn(move || opencode_keys(&config)).unwrap().join().unwrap();
    assert_eq!(keys, keys_from(&IndexMap::new()));
    // a leader that is itself stacked counts towards the same limit
    let leader = "<leader>".repeat(MAX_LEADERS);
    assert_eq!(keys_from(&binds(&[("leader", &format!("{leader}a")), ("agent_cycle", "<leader>m")])), keys_from(&IndexMap::new()));
    assert_eq!(tmux_keys("<leader> m", None), k(&["C-x", "m"]));
    assert_eq!(tmux_keys("<leader>none,f2", None), k(&["F2"]));
}
