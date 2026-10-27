use inyon_protocol::AgentKind;

use super::*;
use crate::test_support::screen_fixture;

fn reply(agent: &str, name: &str, kind: AgentKind) -> Option<ScreenReply> {
    screen_reply(&screen_fixture(agent, name), kind, Some(100))
}

#[test]
fn claude_streams_its_reply_under_your_prompt() {
    let r = reply("claude", "reply-streaming", AgentKind::Claude).unwrap();
    assert!(r.whole);
    assert!(r.text.starts_with("Tea likely began in southwestern China, where people chewed or boiled wild leaves. A legend credits"), "{}", r.text);
    // the spinner under it isn't part of it
    assert!(!r.text.contains("Julienning") && !r.text.contains('\n'), "{}", r.text);
}

#[test]
fn claude_keeps_paragraphs_and_leaves_out_the_token_count() {
    let r = reply("claude", "reply-long", AgentKind::Claude).unwrap();
    let paragraphs: Vec<&str> = r.text.split("\n\n").collect();
    assert_eq!(paragraphs.len(), 5, "{}", r.text);
    assert!(paragraphs[1].starts_with("During the Tang and Song dynasties"));
    assert!(paragraphs[4].starts_with("In the 1800s, Britain broke"));
    assert!(!r.text.contains("tokens"));
}

#[test]
fn nothing_while_it_only_thinks() {
    assert_eq!(reply("claude", "reply-thinking", AgentKind::Claude), None);
    assert_eq!(reply("copilot", "reply-thinking", AgentKind::Copilot), None);
}

#[test]
fn copilot_streams_after_its_thinking_row() {
    let r = reply("copilot", "reply-streaming", AgentKind::Copilot).unwrap();
    assert!(r.whole);
    assert!(r.text.starts_with("Tea originated in ancient China, where legend credits Emperor Shen Nong"), "{}", r.text);
    assert!(r.text.ends_with("Tea spread from China to Japan, Korea, and other parts of"), "{}", r.text);
    assert!(!r.text.contains("Session:") && !r.text.contains("Thinking"));
}

#[test]
fn copilots_finished_reply_keeps_its_bullets_and_not_the_notice_after_it() {
    let r = reply("copilot", "reply-done", AgentKind::Copilot);
    // a notice row after the reply ends the run: there's no reply being written
    assert_eq!(r, None, "{r:?}");
}

#[test]
fn antigravity_text_has_no_mark() {
    let r = reply("antigravity", "reply-streaming", AgentKind::Antigravity).unwrap();
    assert!(r.whole);
    assert!(r.text.starts_with("According to legend, the story of tea began in ancient China"), "{}", r.text);
    assert!(!r.text.contains("Generating") && !r.text.contains("bulleted list of tea types"), "{}", r.text);
}

#[test]
fn antigravity_scrolled_past_its_prompt_carries_on() {
    let r = reply("antigravity", "reply-scrolled", AgentKind::Antigravity).unwrap();
    assert!(!r.whole);
    assert!(r.text.contains("- Green Tea: Minimally processed and unoxidized"), "{}", r.text);
    let before = reply("antigravity", "reply-streaming", AgentKind::Antigravity).unwrap().text;
    let earlier = "According to legend, the story of tea began in ancient China around 2737 BCE when Emperor Shennong, known as the divine farmer, was resting beneath a wild tree.\n\nOver subsequent centuries, tea evolved from a medicinal tonic into a refined cultural ritual. By the seventeenth century, maritime trade brought tea to European shores via Dutch and";
    let now = "By the seventeenth century, maritime trade brought tea to European shores via Dutch and Portuguese merchants.";
    assert_eq!(carry_on(earlier, now), format!("{}{now}", &earlier[..earlier.find("By the seventeenth").unwrap()]));
    // nothing in common: what's on screen now
    assert_eq!(carry_on(&before, "Something else entirely, long enough to compare."), "Something else entirely, long enough to compare.");
}

#[test]
fn other_agents_are_not_read() {
    assert_eq!(screen_reply(&screen_fixture("codex", "reasoning"), AgentKind::Codex, None), None);
}

#[test]
fn recorded_paragraphs_leave_the_live_text() {
    let live = "Tea likely began in **southwestern** China, where people chewed or boiled wild leaves.\n\nDuring the Tang and Song dynasties, tea was pressed into bricks.";
    let record = "Tea likely began in southwestern China, where people chewed or boiled wild leaves. A legend";
    assert_eq!(unrecorded(live, &[record]), "During the Tang and Song dynasties, tea was pressed into bricks.");
    assert_eq!(unrecorded(live, &[]), live);
    assert_eq!(unrecorded(live, &[record, "During the Tang and Song dynasties, tea was pressed into bricks or cakes"]), "");
}

#[test]
fn a_folded_thought_isnt_part_of_antigravitys_reply() {
    let mut lines = screen_fixture("antigravity", "reply-streaming");
    let at = lines.iter().position(|l| l.contains("According")).unwrap();
    lines.insert(at, String::new());
    lines.insert(at, "  ▸ Thought for 7s".into());
    let r = screen_reply(&lines, AgentKind::Antigravity, Some(100)).unwrap();
    assert!(r.text.starts_with("According to legend"), "{}", r.text);
}

#[test]
fn the_end_of_a_prompt_left_at_the_top_isnt_carried_on() {
    let before = "The story of coffee begins in the ancient coffee forests of the Ethiopian plateau, where a goat herder named Kaldi noticed.";
    let now = "bulleted list of coffee drinks.\n\nforests of the Ethiopian plateau, where a goat herder named Kaldi noticed. Legend says more.";
    assert_eq!(
        carry_on(before, now),
        "The story of coffee begins in the ancient coffee forests of the Ethiopian plateau, where a goat herder named Kaldi noticed. Legend says more."
    );
}

#[test]
fn a_paragraph_the_last_read_caught_half_written_still_carries_on() {
    let before = "The opening paragraph, scrolled away by now.\n\nBy the seventeenth century, mar";
    let now = "By the seventeenth century, maritime trade brought tea to Europe.";
    assert_eq!(carry_on(before, now), "The opening paragraph, scrolled away by now.\n\nBy the seventeenth century, maritime trade brought tea to Europe.");
    // a start that only looks alike isn't taken
    assert_eq!(carry_on("Earlier text.\n\nBy the seventeenth century, few", now), now);
}

/// Ghostex #252: chat lost the leading indent of a reply's lines. The live copy takes off only the
/// indent every row shares, so a nested list and a code sample keep theirs.
#[test]
fn a_reply_keeps_the_indent_of_its_nested_lines() {
    let rule = "─".repeat(100);
    let lines: Vec<String> = ["❯ show me", "", "● Steps:", "  - build", "    - with --release", "  - test", "", "  fn main() {", "      run();", "  }", "", &rule, "❯ ", &rule]
        .map(str::to_owned)
        .to_vec();
    let r = screen_reply(&lines, AgentKind::Claude, Some(100)).unwrap();
    assert_eq!(r.text, "Steps:\n- build\n  - with --release\n- test\n\nfn main() {\n    run();\n}");
}
