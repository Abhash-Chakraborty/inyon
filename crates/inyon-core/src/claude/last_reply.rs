//! Port of claude/last-reply.ts: what a "finished" notification says.

use inyon_protocol::{AgentKind, AssistantBlock, ChatItem};

use super::transcript::{new_meta, normalize};
use super::transcript_tail::TranscriptReader;
use super::watcher::watchers;
use crate::agents::codex::normalize_codex;
use crate::hosts::host::{shq, ExecOptions};
use crate::hosts::http_error::HubResult;
use crate::hosts::registry::registry;
use crate::js::JsStr;
use crate::re;

/// The agent's last words in its latest turn (none once you've spoken since).
pub fn reply_of(items: &[ChatItem]) -> Option<String> {
    for it in items.iter().rev() {
        match it {
            ChatItem::User { .. } => return None,
            ChatItem::Assistant { block: AssistantBlock::Text { text }, .. } if !text.jtrim().is_empty() => return Some(text.clone()),
            _ => {}
        }
    }
    None
}

fn js_space(c: char) -> bool {
    c.is_whitespace() || c == '\u{feff}'
}

/// `s.replace(/(\*\*|__|\*|_|~~)(?=\S)([\s\S]*?\S)\1/g, '$2')`, which needs a lookahead and a
/// backreference the regex crate doesn't have: at each place the markers are tried in that order,
/// each with the shortest text that ends in a non-space right before the same marker.
fn strip_emphasis(s: &str) -> String {
    const MARKS: [&str; 5] = ["**", "__", "*", "_", "~~"];
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    'scan: while i < s.len() {
        let rest = &s[i..];
        for m in MARKS {
            let Some(body) = rest.strip_prefix(m) else { continue };
            if !body.chars().next().is_some_and(|c| !js_space(c)) {
                continue;
            }
            // the shortest run that ends in a non-space followed by the marker
            for (j, c) in body.char_indices() {
                let end = j + c.len_utf8();
                if !js_space(c) && body[end..].starts_with(m) {
                    out.push_str(&body[..end]);
                    i += m.len() + end + m.len();
                    continue 'scan;
                }
            }
        }
        let c = rest.chars().next().expect("a character");
        out.push(c);
        i += c.len_utf8();
    }
    out
}

/// Markdown to one plain line, cut at a word near `max` characters.
pub fn plain_line(md: &str, max: usize) -> String {
    let s = re!(r"```[\s\S]*?```").replace_all(md, " ");
    let s = re!(r"`([^`]*)`").replace_all(&s, "${1}");
    let s = re!(r"!?\[([^\]]*)\]\([^)]*\)").replace_all(&s, "${1}");
    let s = re!(r"^\s{0,3}(#{1,6}|[-*+]|\d+\.|>)\s+", "gm").replace_all(&s, "");
    let s = strip_emphasis(&s);
    let s = s.replace('|', " ");
    let s = re!(r"\s+").replace_all(&s, " ");
    let s = s.jtrim();
    if s.len16() <= max {
        return s.to_owned();
    }
    let cut = s.to16(max as isize);
    // `cut.lastIndexOf(' ')`, in UTF-16 units like the rest
    let last_space = cut.rfind(' ').map_or(-1, |b| cut.idx16(b) as isize);
    format!("{}…", cut.to16(last_space.max(max as isize - 30)).jtrim_end())
}

/// What a "finished" notification says: the start of the agent's reply. From the open chat when
/// there is one, otherwise from the end of its transcript file. None when it can't tell.
pub async fn last_reply(host_id: &str, pane_id: &str) -> HubResult<Option<String>> {
    if let Some(w) = watchers().peek(host_id, pane_id).filter(|w| w.following()) {
        return Ok(reply_of(&w.items()).map(|r| plain_line(&r, 180)));
    }
    let Some(agent) = registry().pane_agent(host_id, pane_id) else { return Ok(None) };
    let Some(path) = agent.transcript_path.clone().filter(|p| p.ends_with(".jsonl")) else { return Ok(None) };
    if agent.kind != AgentKind::Claude && agent.kind != AgentKind::Codex {
        return Ok(None);
    }
    let out = registry().host(host_id)?.exec(&format!("tail -c 262144 {} 2>/dev/null", shq(&path)), ExecOptions::timeout(4000)).await?;
    let mut meta = new_meta();
    let mut reader = TranscriptReader::new(0);
    let mut items = vec![];
    // the first line is usually cut short; it doesn't parse and is skipped
    for line in out.stdout.split('\n') {
        let Some(e) = reader.line(line).and_then(|r| r.entry) else { continue };
        items.extend(if agent.kind == AgentKind::Codex { normalize_codex(&e, &mut meta) } else { normalize(&e, &mut meta, false) });
    }
    Ok(reply_of(&items).map(|r| plain_line(&r, 180)))
}

#[cfg(test)]
#[path = "last_reply_tests.rs"]
mod tests;
