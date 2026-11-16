//! The session side panel's model, as the web app keeps it in Panels.tsx, Workspace.tsx,
//! chat/Diff.tsx, lib/review.ts and lib/compose.ts: the files this conversation edited, an edit's
//! hunks, a diff's numbered lines, comments on diff lines, the dev servers the chat mentions, and
//! what's running. Plain data, so it's tested natively.

use inyon_protocol::{AssistantBlock, ChatInfo, ChatItem, SubagentStatus, TaskStatus, TaskType, ToolResultMeta};
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
    /// its result has come
    pub done: bool,
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

/// The lines `s` holds: none when it's empty, and a last newline doesn't start another.
fn lines_of(s: &str) -> u64 {
    s.lines().count() as u64
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
            patch_files(input.get("patch").and_then(Value::as_str).unwrap_or(""))
        } else {
            input.get("file_path").or_else(|| input.get("notebook_path")).and_then(Value::as_str).filter(|p| !p.is_empty()).map(str::to_string).into_iter().collect()
        };
        for p in paths {
            let mut f = match files.iter().position(|f| f.path == p) {
                Some(at) => files.remove(at),
                None => FileChange { path: p.clone(), edits: vec![], add: 0, del: 0, created: false },
            };
            f.edits.push(Edit { name: name.clone(), input: input.clone(), meta: meta.cloned(), ts: ts.clone(), done: r.is_some() });
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
            } else if name == "MultiEdit" {
                // without the result's patch, each of its edits counts as an Edit would
                for e in input.get("edits").and_then(Value::as_array).into_iter().flatten() {
                    let s = |k: &str| e.get(k).and_then(Value::as_str).unwrap_or("");
                    f.add += lines_of(s("new_string"));
                    f.del += lines_of(s("old_string"));
                }
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

/// The files a patch leaves changed: each one it names, and for one it moves (`*** Move to:`
/// after its `*** Update File:`), where it went.
fn patch_files(patch: &str) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    for l in patch.lines() {
        if let Some(to) = l.strip_prefix("*** Move to: ").map(str::trim).filter(|t| !t.is_empty()) {
            if let Some(last) = out.last_mut() {
                *last = to.to_string();
            }
        } else if let Some(p) = patch_file(l) {
            out.push(p);
        }
    }
    out
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

// ---------- diff lines ----------

pub use crate::diff::Hunk;
use crate::diff::Sign;

/// An edit's hunks, as the chat's own diffs draw them (diff.rs).
pub fn hunks(meta: Option<&ToolResultMeta>, input: &Value) -> Vec<Hunk> {
    crate::diff::of_call(meta.and_then(|m| m.patch.as_deref()), input)
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
    pub no: u32,
    pub add: bool,
    pub removed: bool,
    pub text: String,
}

/// The rows a diff draws (diff.rs numbers them), at most `max` lines, and how many more there are.
pub fn rows(hunks: &[Hunk], max: usize) -> (Vec<Row>, usize) {
    let d = crate::diff::rows(hunks, max);
    let rows = d
        .rows
        .into_iter()
        .map(|r| match r {
            crate::diff::Row::Gap => Row::Gap,
            crate::diff::Row::Line { no, sign, text } => Row::Line(Line { no, add: sign == Sign::Add, removed: sign == Sign::Del, text }),
        })
        .collect();
    (rows, d.hidden)
}

// ---------- comments ----------

/// A comment on one line of a diff, waiting to go to the agent with the others.
#[derive(Debug, Clone, PartialEq)]
pub struct Note {
    pub file: String,
    pub line: u32,
    /// the line was taken out (its number is in the old file)
    pub removed: bool,
    pub code: String,
    pub text: String,
}

impl Note {
    pub fn on(&self, file: &str, line: u32, removed: bool) -> bool {
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

// ---------- activity ----------

/// The tasks and subagents running, counted once each (a background subagent is also listed as a
/// task of the kind the transcript can't name).
pub fn running(info: Option<&ChatInfo>) -> usize {
    info.map_or(0, |i| {
        i.tasks.iter().filter(|t| t.status == TaskStatus::Running && t.r#type != TaskType::Other).count()
            + i.subagents.iter().filter(|a| a.status == SubagentStatus::Running).count()
    })
}

// ---------- the working tree's actions (lib/worktree.ts) ----------

/// The hub reports what's staged (from 0.27); an older hub gets no staging controls.
pub fn can_stage(files: &[crate::api::GitFile]) -> bool {
    files.iter().any(|f| f.staged.is_some())
}

/// The staged files, and the files with changes not staged yet; a file can be in both.
pub fn tree_groups(files: &[crate::api::GitFile]) -> (Vec<crate::api::GitFile>, Vec<crate::api::GitFile>) {
    let staged = files.iter().filter(|f| f.staged == Some(true)).cloned().collect();
    let changes = files.iter().filter(|f| f.unstaged.unwrap_or(true)).cloned().collect();
    (staged, changes)
}

/// What the commit button says, its tooltip, and the `staged` the commit sends.
pub fn commit_plan(files: &[crate::api::GitFile]) -> (String, String, Option<bool>) {
    if !can_stage(files) {
        return ("Commit all".into(), "Commit every change shown here".into(), None);
    }
    match files.iter().filter(|f| f.staged == Some(true)).count() {
        0 => ("Commit all".into(), "Commit every change shown here".into(), Some(false)),
        1 => ("Commit 1 staged".into(), "Commit the staged file only".into(), Some(true)),
        n => (format!("Commit {n} staged"), format!("Commit the {n} staged files only"), Some(true)),
    }
}

/// The paths a discard names: a renamed file goes back to where it was, so both.
pub fn discard_paths(f: &crate::api::GitFile) -> Vec<String> {
    let mut v = vec![f.path.clone()];
    v.extend(f.from.clone());
    v
}

/// The confirm sheet's title and line before a discard.
pub fn discard_ask(f: &crate::api::GitFile) -> (String, String) {
    let name = f.path.rsplit('/').next().unwrap_or(&f.path);
    let what = match (f.status.as_str(), &f.from) {
        ("?" | "A", _) => "It's a new file, so it's deleted. ".to_string(),
        ("R", Some(from)) => format!("It goes back to {from}. "),
        ("D", _) => "The file comes back as it was in the last commit. ".to_string(),
        _ => String::new(),
    };
    (format!("Discard your changes to {name}?"), format!("{what}This can't be undone."))
}

// ---------- pull requests (lib/pullRequest.ts) ----------

/// What the Working tree shows about pull requests: the branch's pull request, an offer to open
/// one, a note on what gh needs first (with the command to run), or nothing.
#[derive(Debug, Clone, PartialEq)]
pub enum PrView {
    None,
    Pr(crate::api::PullRequest),
    Open { base: Option<String> },
    Notice { text: String, command: Option<&'static str> },
}

/// Names a default branch usually has, for when git and gh can't say which it is.
const USUAL_DEFAULTS: [&str; 3] = ["main", "master", "trunk"];

pub fn pr_view(s: &crate::api::GitState, st: Option<&crate::api::PrState>) -> PrView {
    let Some(st) = st.filter(|_| s.repo) else { return PrView::None };
    if let Some(pr) = &st.pr {
        return PrView::Pr(pr.clone());
    }
    if st.gh == "not-github" {
        return PrView::None;
    }
    let branch = s.branch.as_deref().unwrap_or("");
    let is_default = match st.base.as_deref() {
        Some(b) => branch == b,
        None => USUAL_DEFAULTS.contains(&branch),
    };
    // pushed: the branch has an upstream and nothing left to push
    let pushed = s.upstream.is_some() && s.ahead.unwrap_or(0.0) == 0.0;
    if branch.is_empty() || branch == "detached" || is_default || s.remote != Some(true) || !pushed {
        return PrView::None;
    }
    match st.gh.as_str() {
        "missing" => {
            PrView::Notice { text: "To open a pull request from here, install the GitHub CLI on this machine (cli.github.com), then run".into(), command: Some("gh auth login") }
        }
        "signed-out" => PrView::Notice { text: "To open a pull request from here, sign gh in to GitHub on this machine:".into(), command: Some("gh auth login") },
        "error" => PrView::Notice { text: st.message.clone().filter(|m| !m.is_empty()).unwrap_or_else(|| "gh couldn't read the pull request.".into()), command: None },
        _ => PrView::Open { base: st.base.clone() },
    }
}

/// The checks in one line, and its tone: failing, running, passing or none.
pub fn checks_summary(pr: &crate::api::PullRequest) -> (&'static str, String) {
    let c = &pr.checks;
    let (failed, running) = (c.failed.len(), c.running.len());
    if c.passed == 0 && c.skipped == 0 && failed == 0 && running == 0 {
        return ("none", "No checks".into());
    }
    let tone = if failed > 0 {
        "failing"
    } else if running > 0 {
        "running"
    } else {
        "passing"
    };
    let mut parts = vec![];
    if failed > 0 {
        parts.push(format!("{failed} failing"));
    }
    if running > 0 {
        parts.push(format!("{running} running"));
    }
    if c.passed > 0 {
        parts.push(format!("{} passing", c.passed));
    } else if tone == "passing" {
        // skipped checks only count when nothing else ran
        parts.push(format!("{} skipped", c.skipped));
    }
    (tone, parts.join(" · "))
}

/// How the pull request's state reads on its chip.
pub fn pr_state_label(pr: &crate::api::PullRequest) -> &'static str {
    match pr.state.as_str() {
        "merged" => "Merged",
        "closed" => "Closed",
        _ if pr.draft => "Draft",
        _ => "Open",
    }
}

/// What "Send to agent" puts in the message box (not sent).
pub fn failing_prompt(pr: &crate::api::PullRequest) -> String {
    let names: Vec<&str> = pr.checks.failed.iter().map(|c| c.name.as_str()).collect();
    let n = pr.number;
    let at = format!("pull request #{n} ({})", pr.url);
    if let [one] = names.as_slice() {
        return format!("The check \"{one}\" failed on {at}. Find out why with gh pr checks {n} and fix it.");
    }
    let list: Vec<String> = names.iter().map(|x| format!("- {x}")).collect();
    format!("These checks failed on {at}:\n{}\n\nFind out why with gh pr checks {n} and fix them.", list.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use inyon_protocol::PatchHunk;
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
    fn a_moved_file_is_listed_where_it_went() {
        assert_eq!(
            patch_files("*** Begin Patch\n*** Update File: src/old.rs\n*** Move to: src/new.rs\n@@\n-a\n+b\n*** Add File: c.txt\n+hi\n*** End Patch"),
            ["src/new.rs", "c.txt"]
        );
    }

    #[test]
    fn an_edit_without_a_recorded_patch_is_worked_out() {
        let h = hunks(None, &json!({ "old_string": "a\nb\nc\nd\ne\nf\ng\nh\ni\nj", "new_string": "a\nb\nc\nd\nE\nf\ng\nh\ni\nj" }));
        assert_eq!(h.len(), 1);
        assert_eq!(h[0].lines, [" b", " c", " d", "-e", "+E", " f", " g", " h"]);
        // a file written whole is all added
        let h = hunks(None, &json!({ "content": "x\ny" }));
        assert_eq!(h, [Hunk { old_start: 0, new_start: 1, lines: vec!["+x".into(), "+y".into()] }]);
    }

    #[test]
    fn counts_without_a_patch_take_no_empty_last_line_and_add_up_a_multiedit() {
        let items = vec![
            call(1, "t1", "Edit", json!({ "file_path": "a.rs", "old_string": "gone\n", "new_string": "" })),
            call(2, "t2", "MultiEdit", json!({ "file_path": "b.rs", "edits": [{ "old_string": "a", "new_string": "b\nc" }, { "old_string": "d\ne", "new_string": "f" }] })),
            result(3, "t2", false, None),
        ];
        let c = changes(&items);
        let of = |p: &str| c.iter().find(|f| f.path == p).map(|f| (f.add, f.del));
        assert_eq!(of("a.rs"), Some((0, 1)));
        assert_eq!(of("b.rs"), Some((3, 3)));
        // an edit whose result hasn't come yet is still under way
        assert_eq!(c.iter().map(|f| (f.path.as_str(), f.edits[0].done)).collect::<Vec<_>>(), [("b.rs", true), ("a.rs", false)]);
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
        // past the limit: no gap before a hunk that shows nothing
        let (rows, hidden) = super::rows(&h, 2);
        assert_eq!((rows.len(), hidden), (2, 3));
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

    fn gf(path: &str, status: &str, staged: Option<bool>, unstaged: Option<bool>) -> crate::api::GitFile {
        crate::api::GitFile { path: path.into(), from: None, status: status.into(), add: 1.0, del: 0.0, staged, unstaged }
    }

    #[test]
    fn working_tree_groups_commit_and_discard_read_as_the_web_app_does() {
        let files = [gf("a.ts", "M", Some(true), Some(false)), gf("b.ts", "M", Some(true), Some(true)), gf("c.md", "?", Some(false), Some(true))];
        let (staged, changes) = tree_groups(&files);
        assert_eq!(staged.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), ["a.ts", "b.ts"]);
        assert_eq!(changes.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), ["b.ts", "c.md"]);
        assert_eq!(commit_plan(&files), ("Commit 2 staged".into(), "Commit the 2 staged files only".into(), Some(true)));
        assert_eq!(commit_plan(&files[2..]).2, Some(false));
        let old = [gf("a.ts", "M", None, None)];
        assert!(!can_stage(&old));
        assert_eq!(commit_plan(&old), ("Commit all".into(), "Commit every change shown here".into(), None));
        assert_eq!(tree_groups(&old).1.len(), 1);

        assert_eq!(discard_ask(&gf("src/a b.ts", "M", Some(false), Some(true))), ("Discard your changes to a b.ts?".into(), "This can't be undone.".into()));
        assert_eq!(discard_ask(&gf("n.md", "?", Some(false), Some(true))).1, "It's a new file, so it's deleted. This can't be undone.");
        let mut r = gf("new.ts", "R", Some(true), Some(false));
        r.from = Some("old.ts".into());
        assert_eq!(discard_ask(&r).1, "It goes back to old.ts. This can't be undone.");
        assert_eq!(discard_paths(&r), ["new.ts", "old.ts"]);
    }

    fn pr(failed: &[&str], running: &[&str], passed: u64, skipped: u64) -> crate::api::PullRequest {
        let c = |v: &[&str]| v.iter().map(|n| crate::api::PrCheck { name: (*n).into(), url: None }).collect();
        crate::api::PullRequest {
            number: 42,
            title: "Fix the cart".into(),
            state: "open".into(),
            url: "https://github.com/o/r/pull/42".into(),
            checks: crate::api::PrChecks { passed, skipped, failed: c(failed), running: c(running) },
            ..Default::default()
        }
    }

    #[test]
    fn pull_requests_read_as_the_web_app_does() {
        let pushed = crate::api::GitState {
            repo: true,
            root: None,
            branch: Some("fix/cart".into()),
            remote: Some(true),
            upstream: Some("origin/fix/cart".into()),
            ahead: Some(0.0),
            behind: Some(0.0),
            files: vec![],
        };
        let ready = crate::api::PrState { gh: "ready".into(), branch: Some("fix/cart".into()), base: Some("main".into()), ..Default::default() };
        assert_eq!(pr_view(&pushed, Some(&ready)), PrView::Open { base: Some("main".into()) });
        assert_eq!(pr_view(&crate::api::GitState { ahead: Some(1.0), ..pushed.clone() }, Some(&ready)), PrView::None);
        assert_eq!(pr_view(&crate::api::GitState { branch: Some("main".into()), ..pushed.clone() }, Some(&ready)), PrView::None);
        assert_eq!(
            pr_view(&crate::api::GitState { branch: Some("master".into()), ..pushed.clone() }, Some(&crate::api::PrState { gh: "missing".into(), ..Default::default() })),
            PrView::None
        );
        assert_eq!(pr_view(&pushed, None), PrView::None);
        let with = crate::api::PrState { pr: Some(pr(&[], &[], 1, 0)), ..ready.clone() };
        assert_eq!(pr_view(&crate::api::GitState { ahead: Some(1.0), ..pushed.clone() }, Some(&with)), PrView::Pr(pr(&[], &[], 1, 0)));
        let signed_out = crate::api::PrState { gh: "signed-out".into(), ..Default::default() };
        assert!(matches!(pr_view(&pushed, Some(&signed_out)), PrView::Notice { command: Some("gh auth login"), .. }));
        assert_eq!(pr_view(&pushed, Some(&crate::api::PrState { gh: "not-github".into(), ..Default::default() })), PrView::None);

        assert_eq!(checks_summary(&pr(&["CI / check"], &["docs", "apk"], 3, 0)), ("failing", "1 failing · 2 running · 3 passing".into()));
        assert_eq!(checks_summary(&pr(&[], &["docs"], 3, 0)), ("running", "1 running · 3 passing".into()));
        assert_eq!(checks_summary(&pr(&[], &[], 3, 2)), ("passing", "3 passing".into()));
        assert_eq!(checks_summary(&pr(&[], &[], 0, 2)), ("passing", "2 skipped".into()));
        assert_eq!(checks_summary(&pr(&[], &[], 0, 0)), ("none", "No checks".into()));
        assert_eq!(pr_state_label(&crate::api::PullRequest { draft: true, ..pr(&[], &[], 0, 0) }), "Draft");
        assert_eq!(pr_state_label(&crate::api::PullRequest { state: "merged".into(), ..pr(&[], &[], 0, 0) }), "Merged");
        assert_eq!(
            failing_prompt(&pr(&["Android / apk"], &[], 0, 0)),
            "The check \"Android / apk\" failed on pull request #42 (https://github.com/o/r/pull/42). Find out why with gh pr checks 42 and fix it."
        );
        assert_eq!(
            failing_prompt(&pr(&["a", "b"], &[], 0, 0)),
            "These checks failed on pull request #42 (https://github.com/o/r/pull/42):\n- a\n- b\n\nFind out why with gh pr checks 42 and fix them."
        );
    }
}
