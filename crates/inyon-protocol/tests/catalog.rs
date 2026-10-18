//! The AGENTS catalog: agents.json reads into the Rust types without losing anything, and the
//! helpers behave like their TypeScript counterparts in agents.ts.

use inyon_protocol::*;

#[test]
fn every_agent_is_in_the_catalog_in_order() {
    assert_eq!(agents().keys().copied().collect::<Vec<_>>(), AGENT_KINDS);
    for (kind, def) in agents() {
        assert_eq!(def.kind, *kind);
        assert_eq!(serde_json::to_value(kind).unwrap(), kind.as_str());
    }
}

#[test]
fn the_catalog_reads_back_unchanged() {
    let source: serde_json::Value = serde_json::from_str(include_str!("../src/agents.json")).unwrap();
    assert_eq!(serde_json::to_value(agents()).unwrap(), source);
}

#[test]
fn commands_fill_their_templates() {
    let claude = AgentKind::Claude.def();
    assert_eq!(claude.model_command("opus", None).as_deref(), Some("/model opus"));
    assert_eq!(claude.effort_command("xhigh").as_deref(), Some("/effort xhigh"));
    assert_eq!(claude.goal_command("tests pass").as_deref(), Some("/goal tests pass"));
    assert_eq!(claude.ultracode_command(true), Some("/effort ultracode on"));
    assert_eq!(claude.ultracode_command(false), Some("/effort ultracode off"));
    assert_eq!(claude.set.clear_goal.as_deref(), Some("/goal clear"));
    let agy = AgentKind::Antigravity.def();
    assert_eq!(agy.model_command("gemini-3.8-flash", Some("low")).as_deref(), Some("/model gemini-3.8-flash-low"));
    assert_eq!(agy.model_command("gemini-3.1-pro", Some("medium")).as_deref(), Some("/model gemini-3.1-pro-high"));
    assert_eq!(agy.model_command("claude-sonnet-4-6", Some("low")).as_deref(), Some("/model claude-sonnet-4-6"));
    assert_eq!(agy.ultracode_command(true), None);
    let gemini = AgentKind::Gemini.def();
    assert_eq!(gemini.model_command("gemini-2.5-pro", None), None);
    assert_eq!(gemini.set.compact.as_deref(), Some("/compress"));
}

#[test]
fn agy_model_ids_name_the_effort() {
    assert_eq!(agy_model_id("gemini-3.8-flash", None), "gemini-3.8-flash-high");
    assert_eq!(agy_model_id("gemini-3.8-flash", Some("medium")), "gemini-3.8-flash-medium");
    assert_eq!(agy_model_id("gemini-3.1-pro", Some("low")), "gemini-3.1-pro-low");
    assert_eq!(agy_model_id("gemini-3.1-pro", Some("max")), "gemini-3.1-pro-high");
    assert_eq!(agy_model_id("gemini-3.8-flash-low", Some("high")), "gemini-3.8-flash-low");
    assert_eq!(agy_model_id("gpt-oss-120b-medium", Some("low")), "gpt-oss-120b-medium");
}

#[test]
fn agents_are_spotted_by_process_name_or_command_line() {
    assert_eq!(detect_agent("claude", ""), Some(AgentKind::Claude));
    assert_eq!(detect_agent("node", "node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js"), Some(AgentKind::Claude));
    assert_eq!(detect_agent("node", "/usr/bin/node /home/me/.npm/bin/codex --yolo"), Some(AgentKind::Codex));
    assert_eq!(detect_agent("bun", "bun /x/opencode-ai/bin/opencode"), Some(AgentKind::Opencode));
    assert_eq!(detect_agent("agy", ""), Some(AgentKind::Antigravity));
    assert_eq!(detect_agent("python3", "python3 -m http.server"), None);
    // a shell whose command line mentions an agent isn't one
    assert_eq!(detect_agent("zsh", "zsh -c claude"), None);
    assert_eq!(detect_agent("-bash", "codex"), None);
}
