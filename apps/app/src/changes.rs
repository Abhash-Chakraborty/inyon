//! The session side panel's model, as the web app keeps it in Panels.tsx, Workspace.tsx,
//! chat/Diff.tsx, lib/review.ts and lib/compose.ts: the files this conversation edited, an edit's
//! hunks, a diff's numbered lines, comments on diff lines, the dev servers the chat mentions, and
//! what's running. Plain data, so it's tested natively.

use inyon_protocol::{AssistantBlock, ChatInfo, ChatItem, PatchHunk, SubagentStatus, TaskStatus, TaskType, ToolResultMeta};
use serde_json::Value;

/// The tools whose calls change a file.
const EDIT_TOOLS: [&str; 5] = ["Edit", "MultiEdit", "Write", "NotebookEdit", "ApplyPatch"];

/// One edit of a file: the call, what its result recorded, and when.
#[derive(Debug, Clone, PartialEq)]
pub struct Edit {
    pub name: String,
    pub input: Value,
    pub meta: Option<ToolResultMeta>,
    pub ts: String,
}

/// A file the agent edited in this conversation, with every edit in the order made.
#[derive(Debug, Clone, PartialEq)]
pub struct FileChange {
    pub path: String,
    pub edits: Vec<Edit>,
    pub add: u64,
    pub del: u64,
    pub created: bool,
}

fn lines_of(s: &str) -> u64 {
    s.split('\n').count() as u64
}

/// Every file the agent edited in this conversation, the one edited last first. A failed edit
/// doesn't count.
pub fn changes(items: &[ChatItem]) -> Vec<FileChange> {
    let mut results: std::collections::HashMap<&str, (bool, Option<&ToolResultMeta>)> = std::collections::HashMap::new();
    for i in items {
        if let ChatItem::ToolResult { tool_use_id, is_error, meta, .. } = i {
            results.insert(tool_use_id, (*is_error, meta.as_ref()));
        }
    }
    let mut files: Vec<FileChange> = vec![];
    for i in items {
        let ChatItem::Assistant { ts, block: AssistantBlock::ToolUse { id, name, input }, .. } = i else { continue };
        if !EDIT_TOOLS.contains(&name.as_str()) {
            continue;
        }
        let r = results.get(id.as_str());
        if r.is_some_and(|r| r.0) {
            continue;
        }
        let meta = r.and_then(|r| r.1);
        let paths: Vec<String> = if name == "ApplyPatch" {
            input.get("patch").and_then(Value::as_str).unwrap_or("").lines().filter_map(patch_file).collect()
        } else {
            input.get("file_path").or_else(|| input.get("notebook_path")).and_then(Value::as_str).filter(|p| !p.is_empty()).map(str::to_string).into_iter().collect()
        };
        for p in paths {
            let mut f = match files.iter().position(|f| f.path == p) {
                Some(at) => files.remove(at),
                None => FileChange { path: p.clone(), edits: vec![], add: 0, del: 0, created: false },
            };
            f.edits.push(Edit { name: name.clone(), input: input.clone(), meta: meta.cloned(), ts: ts.clone() });
            let s = |k: &str| input.get(k).and_then(Value::as_str);
            if let Some(patch) = meta.and_then(|m| m.patch.as_ref()).filter(|p| !p.is_empty()) {
                for h in patch {
                    for l in &h.lines {
                        if l.starts_with('+') {
                            f.add += 1;
                        } else if l.starts_with('-') {
                            f.del += 1;
                        }
                    }
                }
            } else if name == "Write" && s("content").is_some() {
                f.add += lines_of(s("content").unwrap_or(""));
            } else if name == "Edit" && s("new_string").is_some() {
                f.add += lines_of(s("new_string").unwrap_or(""));
                f.del += lines_of(s("old_string").unwrap_or(""));
            }
            if meta.and_then(|m| m.created) == Some(true) {
                f.created = true;
            }
            files.push(f);
        }
    }
    files.reverse();
    files
}

/// `*** Update File: a.rs` (and Add, Delete) in a patch: the file it names.
fn patch_file(line: &str) -> Option<String> {
    let rest = line.strip_prefix("*** ")?;
    let (word, path) = rest.split_once(" File: ")?;
    (!word.is_empty() && word.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') && !path.is_empty()).then(|| path.to_string())
}

/// What an edit's heading says: Created or Rewrote for a whole file written, else Edited.
pub fn edit_word(e: &Edit) -> &'static str {
    match (e.name.as_str(), e.meta.as_ref().and_then(|m| m.created)) {
        ("Write", Some(true)) => "Created",
        ("Write", _) => "Rewrote",
        _ => "Edited",
    }
}

// ---------- hunks ----------

/// One stretch of a diff: where it starts in the old and the new file, and its lines with `+`, `-`
/// or a space in front.
#[derive(Debug, Clone, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hunk {
    pub old_start: u64,
    pub new_start: u64,
    pub lines: Vec<String>,
}

impl From<&PatchHunk> for Hunk {
    fn from(h: &PatchHunk) -> Self {
        Hunk { old_start: h.old_start.0.max(0.0) as u64, new_start: h.new_start.0.max(0.0) as u64, lines: h.lines.clone() }
    }
}

/// The lines of context a computed hunk keeps around a change, as `structuredPatch` does.
const CONTEXT: usize = 3;
/// Past this many lines on a side, an edit shows as all out and all in instead of a line diff.
const DIFF_MAX: usize = 2000;

/// An edit's hunks: those the agent recorded, else worked out from the edit itself (the old and
/// new text of each change, or a whole file written).
pub fn hunks(meta: Option<&ToolResultMeta>, input: &Value) -> Vec<Hunk> {
    if let Some(p) = meta.and_then(|m| m.patch.as_ref()).filter(|p| !p.is_empty()) {
        return p.iter().map(Hunk::from).collect();
    }
    let s = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let edits: Vec<(String, String)> = if let Some(list) = input.get("edits").and_then(Value::as_array) {
        list.iter().map(|e| (s(e, "old_string"), s(e, "new_string"))).collect()
    } else if input.get("old_string").is_some() {
        vec![(s(input, "old_string"), s(input, "new_string"))]
    } else {
        vec![]
    };
    if !edits.is_empty() {
        return edits.iter().flat_map(|(a, b)| line_diff(a, b)).collect();
    }
    if let Some(content) = input.get("content").and_then(Value::as_str) {
        return vec![Hunk { old_start: 0, new_start: 1, lines: content.split('\n').map(|l| format!("+{l}")).collect() }];
    }
    vec![]
}

/// A text's lines as a diff counts them: a last newline ends the last line rather than starting one.
fn split(s: &str) -> Vec<&str> {
    if s.is_empty() {
        return vec![];
    }
    let mut v: Vec<&str> = s.split('\n').collect();
    if s.ends_with('\n') {
        v.pop();
    }
    v
}

/// The hunks between two texts, with three lines of context.
pub fn line_diff(old: &str, new: &str) -> Vec<Hunk> {
    let (a, b) = (split(old), split(new));
    let ops = ops(&a, &b);
    group(&ops)
}

/// The longest common run of lines, as a list of kept, removed and added lines.
fn ops<'a>(a: &[&'a str], b: &[&'a str]) -> Vec<(char, &'a str)> {
    // the same start and end need no table
    let pre = a.iter().zip(b).take_while(|(x, y)| x == y).count();
    let suf = a[pre..].iter().rev().zip(b[pre..].iter().rev()).take_while(|(x, y)| x == y).count();
    let (am, bm) = (&a[pre..a.len() - suf], &b[pre..b.len() - suf]);
    let mut out: Vec<(char, &str)> = a[..pre].iter().map(|l| (' ', *l)).collect();
    if am.len() > DIFF_MAX || bm.len() > DIFF_MAX {
        out.extend(am.iter().map(|l| ('-', *l)));
        out.extend(bm.iter().map(|l| ('+', *l)));
    } else {
        let (n, m) = (am.len(), bm.len());
        // lcs[i][j]: the longest common run of am[i..] and bm[j..]
        let mut lcs = vec![vec![0u32; m + 1]; n + 1];
        for i in (0..n).rev() {
            for j in (0..m).rev() {
                lcs[i][j] = if am[i] == bm[j] { lcs[i + 1][j + 1] + 1 } else { lcs[i + 1][j].max(lcs[i][j + 1]) };
            }
        }
        let (mut i, mut j) = (0, 0);
        while i < n || j < m {
            if i < n && j < m && am[i] == bm[j] {
                out.push((' ', am[i]));
                i += 1;
                j += 1;
            } else if i < n && (j == m || lcs[i + 1][j] >= lcs[i][j + 1]) {
                out.push(('-', am[i]));
                i += 1;
            } else {
                out.push(('+', bm[j]));
                j += 1;
            }
        }
    }
    out.extend(a[a.len() - suf..].iter().map(|l| (' ', *l)));
    out
}

/// Changed lines with their context, split where more than twice the context lies between.
fn group(ops: &[(char, &str)]) -> Vec<Hunk> {
    let changed: Vec<usize> = ops.iter().enumerate().filter(|(_, o)| o.0 != ' ').map(|(i, _)| i).collect();
    let mut out = vec![];
    let mut k = 0;
    while k < changed.len() {
        let start = changed[k].saturating_sub(CONTEXT);
        let mut end = changed[k];
        while k + 1 < changed.len() && changed[k + 1] - end <= 2 * CONTEXT + 1 {
            k += 1;
            end = changed[k];
        }
        let end = (end + CONTEXT + 1).min(ops.len());
        let (mut o, mut n) = (1u64, 1u64);
        for op in &ops[..start] {
            if op.0 != '+' {
                o += 1;
            }
            if op.0 != '-' {
                n += 1;
            }
        }
        let lines: Vec<String> = ops[start..end].iter().map(|(c, l)| format!("{c}{l}")).collect();
        let olds = lines.iter().filter(|l| !l.starts_with('+')).count();
        let news = lines.iter().filter(|l| !l.starts_with('-')).count();
        // a side with no lines starts before where it would be, as unified diffs write it
        out.push(Hunk { old_start: if olds == 0 { o - 1 } else { o }, new_start: if news == 0 { n - 1 } else { n }, lines });
        k += 1;
    }
    out
}

/// A row of a drawn diff: a line, or the gap between two hunks.
#[derive(Debug, Clone, PartialEq)]
pub enum Row {
    Gap,
    Line(Line),
}

/// A diff line someone can comment on: its number (in the old file for a removed line), whether
/// it was added or taken out, and its text.
#[derive(Debug, Clone, PartialEq)]
pub struct Line {
    pub no: u64,
    pub add: bool,
    pub removed: bool,
    pub text: String,
}

/// The rows a diff draws, at most `max` lines, and how many more there are.
pub fn rows(hunks: &[Hunk], max: usize) -> (Vec<Row>, usize) {
    let (mut out, mut shown, mut hidden) = (vec![], 0, 0);
    for (hi, h) in hunks.iter().enumerate() {
        let (mut o, mut n) = (h.old_start, h.new_start);
        if hi > 0 {
            out.push(Row::Gap);
        }
        for l in &h.lines {
            // "\ No newline at end of file" is not a line of the file
            if l.starts_with('\\') {
                continue;
            }
            if shown >= max {
                hidden += 1;
                continue;
            }
            shown += 1;
            let (add, del) = (l.starts_with('+'), l.starts_with('-'));
            let text = l.get(1..).unwrap_or("").to_string();
            let no = if del { o } else { n };
            if !add {
                o += 1;
            }
            if !del {
                n += 1;
            }
            out.push(Row::Line(Line { no, add, removed: del, text }));
        }
    }
    (out, hidden)
}

// ---------- comments ----------

/// A comment on one line of a diff, waiting to go to the agent with the others.
#[derive(Debug, Clone, PartialEq)]
pub struct Note {
    pub file: String,
    pub line: u64,
    /// the line was taken out (its number is in the old file)
    pub removed: bool,
    pub code: String,
    pub text: String,
}

impl Note {
    pub fn on(&self, file: &str, line: u64, removed: bool) -> bool {
        self.file == file && self.line == line && self.removed == removed
    }
}

/// `n` in place of any comment on the same line, last.
pub fn add_note(list: &mut Vec<Note>, n: Note) {
    list.retain(|x| !x.on(&n.file, n.line, n.removed));
    list.push(n);
}

/// The comments as one message, file by file, each under the line it's about.
pub fn review_message(list: &[Note]) -> String {
    let mut files: Vec<&str> = vec![];
    for n in list {
        if !files.contains(&n.file.as_str()) {
            files.push(&n.file);
        }
    }
    let mut parts = vec!["Comments on your changes:".to_string()];
    for f in files {
        let mut ns: Vec<&Note> = list.iter().filter(|n| n.file == f).collect();
        ns.sort_by_key(|n| n.line);
        for n in ns {
            let code = if n.code.trim().is_empty() { "(empty line)" } else { n.code.trim() };
            let removed = if n.removed { " (removed line)" } else { "" };
            parts.push(format!("{}:{}{removed}\n> {code}\n{}", n.file, n.line, n.text.trim()));
        }
    }
    parts.join("\n\n")
}

/// `text` added after what's in the box already: on its own paragraph when either has several lines.
pub fn append_to(draft: &str, text: &str) -> String {
    if draft.trim().is_empty() {
        return text.to_string();
    }
    let sep = if draft.contains('\n') || text.contains('\n') { "\n\n" } else { " " };
    format!("{}{sep}{text}", draft.trim_end())
}

// ---------- preview ----------

/// The dev servers the chat's last 400 items mention (`localhost:5173`, `my-box:3000`), as
/// addresses on `hostname`, the six mentioned last.
pub fn preview_suggestions(items: &[ChatItem], hostname: &str) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    for i in &items[items.len().saturating_sub(400)..] {
        let t = match i {
            ChatItem::ToolResult { text, .. } => text.as_str(),
            ChatItem::Assistant { block: AssistantBlock::Text { text }, .. } => text.as_str(),
            _ => continue,
        };
        for port in ports(t) {
            if (3000..=5999).contains(&port) || (8000..=8009).contains(&port) {
                let u = format!("http://{hostname}:{port}");
                if !out.contains(&u) {
                    out.push(u);
                }
            }
        }
    }
    let skip = out.len().saturating_sub(6);
    out.split_off(skip)
}

/// The ports of every `http(s)://name:port` in `t`, where the name is `localhost`, `127.0.0.1` or
/// one word (letters, digits, `_` and `-`).
fn ports(t: &str) -> Vec<u32> {
    let word = |c: char| c.is_ascii_alphanumeric() || c == '_';
    let mut out = vec![];
    let mut rest = t;
    while let Some(at) = rest.find("http") {
        let s = &rest[at..];
        rest = &rest[at + 4..];
        let Some(after) = s.strip_prefix("https://").or_else(|| s.strip_prefix("http://")) else { continue };
        let name_len = if after.starts_with("127.0.0.1") { 9 } else { after.find(|c: char| !(word(c) || c == '-')).unwrap_or(after.len()) };
        if name_len == 0 {
            continue;
        }
        let Some(digits) = after[name_len..].strip_prefix(':') else { continue };
        let n = digits.find(|c: char| !c.is_ascii_digit()).unwrap_or(digits.len());
        if !(4..=5).contains(&n) || digits[n..].starts_with(word) {
            continue;
        }
        if let Ok(p) = digits[..n].parse() {
            out.push(p);
        }
    }
    out
}

/// What the Preview tab loads for what was typed: as it is with a scheme, else on http.
pub fn preview_address(typed: &str) -> String {
    let t = typed.trim();
    if t.is_empty() || t.starts_with("http://") || t.starts_with("https://") {
        t.to_string()
    } else {
        format!("http://{t}")
    }
}

/// `scheme://host[:port]` of a link, lower case and without a default port; None when it isn't one.
pub fn origin(url: &str) -> Option<String> {
    let (scheme, rest) = url.split_once("://")?;
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return None;
    }
    let host = rest.split(['/', '?', '#']).next()?.rsplit('@').next()?.to_ascii_lowercase();
    if host.is_empty() {
        return None;
    }
    let host = match (scheme.as_str(), host.strip_suffix(":80"), host.strip_suffix(":443")) {
        ("http", Some(h), _) | ("https", _, Some(h)) => h.to_string(),
        _ => host,
    };
    Some(format!("{scheme}://{host}"))
}

/// Why the Preview tab won't show an address: it is Inyon itself (this app, or a hub it's paired
/// with), where a frame with the app's rights could act as you.
pub const PREVIEW_REFUSAL: &str = "That address is Inyon itself, and a preview of it could act as you. Sites an agent made open under Blueprints.";

pub fn preview_refused(url: &str, app_origins: &[String]) -> bool {
    origin(url).is_some_and(|o| app_origins.iter().any(|a| origin(a).as_deref() == Some(o.as_str())))
}

// ---------- activity ----------

/// The tasks and subagents running, counted once each (a background subagent is also listed as a
/// task of the kind the transcript can't name).
pub fn running(info: Option<&ChatInfo>) -> usize {
    info.map_or(0, |i| {
        i.tasks.iter().filter(|t| t.status == TaskStatus::Running && t.r#type != TaskType::Other).count()
            + i.subagents.iter().filter(|a| a.status == SubagentStatus::Running).count()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn call(seq: i64, id: &str, name: &str, input: Value) -> ChatItem {
        ChatItem::Assistant {
            seq,
            uuid: format!("u{seq}"),
            ts: "2026-11-05T10:00:00Z".into(),
            msg_id: "m".into(),
            model: None,
            block: AssistantBlock::ToolUse { id: id.into(), name: name.into(), input },
        }
    }

    fn result(seq: i64, id: &str, error: bool, meta: Option<ToolResultMeta>) -> ChatItem {
        ChatItem::ToolResult {
            seq,
            uuid: format!("r{seq}"),
            ts: "2026-11-05T10:00:01Z".into(),
            tool_use_id: id.into(),
            is_error: error,
            text: String::new(),
            truncated: None,
            meta,
        }
    }

    fn meta(patch: Option<Vec<PatchHunk>>, created: Option<bool>) -> ToolResultMeta {
        serde_json::from_value(json!({ "patch": patch, "created": created })).unwrap()
    }

    #[test]
    fn the_files_an_agent_edited_come_newest_first_with_their_counts() {
        let patch = vec![PatchHunk {
            old_start: inyon_protocol::Num(1.0),
            old_lines: inyon_protocol::Num(2.0),
            new_start: inyon_protocol::Num(1.0),
            new_lines: inyon_protocol::Num(3.0),
            lines: vec![" a".into(), "-b".into(), "+c".into(), "+d".into()],
        }];
        let items = vec![
            call(1, "t1", "Edit", json!({ "file_path": "/p/src/a.rs", "old_string": "x", "new_string": "y\nz" })),
            result(2, "t1", false, None),
            call(3, "t2", "Write", json!({ "file_path": "/p/new.md", "content": "1\n2\n3" })),
            result(4, "t2", false, Some(meta(None, Some(true)))),
            call(5, "t3", "Edit", json!({ "file_path": "/p/broken.rs", "old_string": "a", "new_string": "b" })),
            result(6, "t3", true, None),
            call(7, "t4", "MultiEdit", json!({ "file_path": "/p/src/a.rs", "edits": [] })),
            result(8, "t4", false, Some(meta(Some(patch), None))),
            call(9, "t5", "Read", json!({ "file_path": "/p/other.rs" })),
        ];
        let c = changes(&items);
        assert_eq!(c.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), ["/p/src/a.rs", "/p/new.md"]);
        assert_eq!((c[0].add, c[0].del, c[0].created, c[0].edits.len()), (4, 2, false, 2));
        assert_eq!((c[1].add, c[1].del, c[1].created), (3, 0, true));
        assert_eq!(edit_word(&c[1].edits[0]), "Created");
        assert_eq!(edit_word(&c[0].edits[0]), "Edited");
    }

    #[test]
    fn a_patch_names_every_file_it_touches() {
        let items = vec![call(1, "t", "ApplyPatch", json!({ "patch": "*** Begin Patch\n*** Update File: src/a.rs\n@@\n-x\n+y\n*** Add File: b.txt\n+hi\n*** End Patch" }))];
        let c = changes(&items);
        assert_eq!(c.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), ["b.txt", "src/a.rs"]);
    }

    #[test]
    fn an_edit_without_a_recorded_patch_gets_a_line_diff() {
        let h = hunks(None, &json!({ "old_string": "a\nb\nc\nd\ne\nf\ng\nh\ni\nj", "new_string": "a\nb\nc\nd\nE\nf\ng\nh\ni\nj" }));
        assert_eq!(h.len(), 1);
        assert_eq!((h[0].old_start, h[0].new_start), (2, 2));
        assert_eq!(h[0].lines, [" b", " c", " d", "-e", "+E", " f", " g", " h"]);
        // two changes far apart are two hunks
        let old = (1..=20).map(|n| n.to_string()).collect::<Vec<_>>().join("\n");
        let new = old.replace("\n2\n", "\ntwo\n").replace("\n19\n", "\nnineteen\n");
        let h = line_diff(&old, &new);
        assert_eq!(h.len(), 2);
        assert_eq!((h[1].old_start, h[1].new_start), (16, 16));
        // a file written whole is all added
        let h = hunks(None, &json!({ "content": "x\ny" }));
        assert_eq!(h, [Hunk { old_start: 0, new_start: 1, lines: vec!["+x".into(), "+y".into()] }]);
    }

    #[test]
    fn a_diffs_lines_are_numbered_in_their_own_file() {
        let h = vec![
            Hunk { old_start: 10, new_start: 12, lines: vec![" a".into(), "-b".into(), "+c".into(), "\\ No newline at end of file".into(), " d".into()] },
            Hunk { old_start: 40, new_start: 42, lines: vec!["+e".into()] },
        ];
        let (rows, hidden) = rows(&h, 400);
        let nos: Vec<_> = rows.iter().map(|r| if let Row::Line(l) = r { (l.no, l.removed) } else { (0, false) }).collect();
        assert_eq!(nos, [(12, false), (11, true), (13, false), (14, false), (0, false), (42, false)]);
        assert_eq!(hidden, 0);
        let (rows, hidden) = super::rows(&h, 2);
        assert_eq!((rows.len(), hidden), (3, 3));
    }

    #[test]
    fn comments_go_out_file_by_file_under_their_lines() {
        let n = |file: &str, line, removed, text: &str| Note { file: file.into(), line, removed, code: "  let x = 1;".into(), text: text.into() };
        let mut list = vec![];
        add_note(&mut list, n("b.rs", 9, false, "later"));
        add_note(&mut list, n("a.rs", 3, true, "why?"));
        add_note(&mut list, n("b.rs", 2, false, "first"));
        add_note(&mut list, n("b.rs", 9, false, "rename it"));
        assert_eq!(list.len(), 3);
        assert_eq!(
            review_message(&list),
            // a changed comment moves to the end, so a.rs leads (lib/review.ts does the same)
            "Comments on your changes:\n\na.rs:3 (removed line)\n> let x = 1;\nwhy?\n\nb.rs:2\n> let x = 1;\nfirst\n\nb.rs:9\n> let x = 1;\nrename it"
        );
    }

    #[test]
    fn text_joins_the_box_on_its_own_paragraph_when_long() {
        assert_eq!(append_to("", "@a.rs"), "@a.rs");
        assert_eq!(append_to("look at  ", "@a.rs"), "look at @a.rs");
        assert_eq!(append_to("one\ntwo", "@a.rs"), "one\ntwo\n\n@a.rs");
    }

    #[test]
    fn the_chats_dev_servers_become_suggestions() {
        let text =
            |seq, t: &str| ChatItem::Assistant { seq, uuid: format!("u{seq}"), ts: String::new(), msg_id: "m".into(), model: None, block: AssistantBlock::Text { text: t.into() } };
        let items = vec![
            text(1, "Running on http://localhost:5173/ and http://127.0.0.1:8000"),
            text(2, "see https://my-box:3000, not http://localhost:22 or http://localhost:9000 or http://a.b:3000 or http://localhost:30001x"),
        ];
        assert_eq!(preview_suggestions(&items, "studio"), ["http://studio:5173", "http://studio:8000", "http://studio:3000"]);
    }

    #[test]
    fn the_preview_refuses_inyon_itself() {
        let apps = vec!["https://hub.example:443".to_string(), "http://100.1.2.3:7680".into()];
        assert!(preview_refused("https://hub.example/next/", &apps));
        assert!(preview_refused("http://100.1.2.3:7680", &apps));
        assert!(!preview_refused("http://100.1.2.3:5173", &apps));
        assert!(!preview_refused("not a link", &apps));
        assert_eq!(preview_address("box:3000"), "http://box:3000");
        assert_eq!(preview_address("https://x"), "https://x");
        assert_eq!(origin("HTTP://Box:80/a?b"), Some("http://box".into()));
    }

    #[test]
    fn whats_running_counts_a_background_subagent_once() {
        let info: ChatInfo = serde_json::from_value(json!({
            "hostId": "h", "paneId": "%1", "running": true, "queue": [], "artifacts": [], "stats": { "turns": 0, "compactions": 0 },
            "tasks": [
                { "id": "a", "type": "shell", "description": "build", "status": "running" },
                { "id": "b", "type": "other", "description": "agent", "status": "running" },
                { "id": "c", "type": "monitor", "description": "watch", "status": "completed" }
            ],
            "subagents": [{ "toolUseId": "s", "description": "look", "status": "running" }]
        }))
        .unwrap();
        assert_eq!(running(Some(&info)), 2);
        assert_eq!(running(None), 0);
    }
}
