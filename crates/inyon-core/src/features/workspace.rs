//! Port of features/workspace.ts.
//!
//! The folder a session works in, as the Files and Changes tabs see it: its files, read only, and
//! its git working tree (what changed since the last commit, whoever changed it), with stage,
//! unstage, discard, a drafted commit message, commit and push. Everything runs as one short shell command on the pane's machine, in the agent's folder.

use serde::Serialize;
use serde_json::Value;

use crate::hosts::host::{shq, ExecOptions, Host};
use crate::hosts::http_error::{http, HubResult};
use crate::hosts::registry::registry;
use crate::js::text::{locale_compare, JsStr};
use crate::js::to_number;
use crate::re;

/// The agent's folder (where it was started), or the pane's shell folder when there's no agent.
pub(crate) fn folder(host_id: &str, pane_id: &str) -> HubResult<(Host, String)> {
    let reg = registry();
    let rt = reg.get(host_id).ok_or_else(|| http(404, "Unknown machine"))?;
    let f = reg.find_pane(host_id, pane_id).ok_or_else(|| http(404, "Pane not found"))?;
    let cwd = reg.agent_proc(host_id, pane_id).and_then(|p| p.cwd).unwrap_or(f.pane.cwd);
    if cwd.is_empty() {
        return Err(http(409, "Unknown working folder"));
    }
    let host = rt.borrow().host.clone();
    Ok((host, cwd))
}

/// A path inside the folder, relative to it: no "..", no absolute paths, nothing a shell line would split.
pub fn inside(rel: &str) -> HubResult<String> {
    let p = re!(r"^\.?\/+").replace(rel, "");
    let p = re!(r"\/+$").replace(&p, "").into_owned();
    if re!(r"[\0\n\r]").is_match(&p) || p.split('/').any(|s| s == "..") || p.starts_with('/') {
        return Err(http(400, "Bad path"));
    }
    Ok(p)
}

/// `Number(s) || 0` for a count a command printed.
fn count(s: &str) -> u64 {
    let n = to_number(s);
    if n.is_finite() && n > 0.0 {
        n as u64
    } else {
        0
    }
}

// ---------- files ----------

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DirEntry {
    pub name: String,
    pub dir: bool,
    pub size: u64,
    /// seconds since 1970
    pub mtime: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DirListing {
    pub cwd: String,
    pub path: String,
    pub entries: Vec<DirEntry>,
}

const HIDE: [&str; 3] = [".git", "node_modules", ".DS_Store"];

/// One folder's entries, folders first, up to 2000.
pub async fn list_dir(host_id: &str, pane_id: &str, rel: &str) -> HubResult<DirListing> {
    let (host, cwd) = folder(host_id, pane_id)?;
    let path = inside(rel)?;
    let dir = if path.is_empty() { cwd.clone() } else { format!("{cwd}/{path}") };
    // "d|f size mtime name" per entry; GNU stat or BSD stat, whichever is there
    let r = host
        .exec(
            &format!(
                "cd {} 2>/dev/null || {{ echo 'No such folder' >&2; exit 3; }}; for f in .[!.]* ..?* *; do [ -e \"$f\" ] || [ -L \"$f\" ] || continue; if [ -d \"$f\" ]; then t=d; else t=f; fi; s=$(stat -c '%s %Y' -- \"$f\" 2>/dev/null || stat -f '%z %m' -- \"$f\" 2>/dev/null || echo '0 0'); printf '%s %s %s\\n' \"$t\" \"$s\" \"$f\"; done | head -2000",
                shq(&dir)
            ),
            ExecOptions::timeout(15000),
        )
        .await?;
    if r.code == 3 {
        return Err(http(404, "No such folder"));
    }
    let mut entries = vec![];
    for line in r.stdout.split('\n') {
        let Some(m) = re!(r"^([df]) (\d+) (\d+) (.+)$").captures(line) else { continue };
        if HIDE.contains(&&m[4]) {
            continue;
        }
        entries.push(DirEntry { name: m[4].to_owned(), dir: &m[1] == "d", size: count(&m[2]), mtime: count(&m[3]) });
    }
    entries.sort_by(|a, b| b.dir.cmp(&a.dir).then_with(|| locale_compare(&a.name, &b.name)));
    Ok(DirListing { cwd, path, entries })
}

const TEXT_MAX: u64 = 512 * 1024;
const IMAGE_MAX: u64 = 8 * 1024 * 1024;

fn image_type(ext: &str) -> Option<&'static str> {
    Some(match ext {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "avif" => "image/avif",
        _ => return None,
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum FileView {
    Text {
        path: String,
        text: String,
        size: u64,
        truncated: bool,
    },
    Image {
        path: String,
        #[serde(rename = "type")]
        mime: String,
        data: String,
        size: u64,
    },
    Binary {
        path: String,
        size: u64,
    },
    Large {
        path: String,
        size: u64,
    },
}

/// A file to look at: text (the first 512 KB), an image (up to 8 MB), or just its size.
pub async fn read_file(host_id: &str, pane_id: &str, rel: &str) -> HubResult<FileView> {
    let (host, cwd) = folder(host_id, pane_id)?;
    let path = inside(rel)?;
    if path.is_empty() {
        return Err(http(400, "Bad path"));
    }
    let file = shq(&format!("{cwd}/{path}"));
    let st = host.exec(&format!("[ -f {file} ] || exit 3; wc -c < {file}"), ExecOptions::timeout(10000)).await?;
    if st.code == 3 {
        return Err(http(404, "No such file"));
    }
    let size = count(st.stdout.jtrim());
    let ext = path.rsplit('.').next().unwrap_or("").to_lowercase();
    if let Some(mime) = image_type(&ext) {
        if size > IMAGE_MAX {
            return Ok(FileView::Large { path, size });
        }
        let r = host.exec(&format!("base64 < {file} | tr -d '\\n'"), ExecOptions::timeout(30000)).await?;
        return Ok(FileView::Image { path, mime: mime.into(), data: r.stdout.jtrim().to_owned(), size });
    }
    // a NUL byte in the first 8 KB: not text
    let bin = host.exec(&format!("head -c 8192 {file} | tr -d '\\000' | wc -c"), ExecOptions::timeout(10000)).await?;
    if to_number(bin.stdout.jtrim()) < size.min(8192) as f64 {
        return Ok(FileView::Binary { path, size });
    }
    let r = host.exec(&format!("head -c {TEXT_MAX} {file}"), ExecOptions::timeout(30000)).await?;
    Ok(FileView::Text { path, text: r.stdout, size, truncated: size > TEXT_MAX })
}

// ---------- git ----------

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GitFile {
    pub path: String,
    /// where it was before a rename
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    /// M modified, A added, D deleted, R renamed, ? not tracked yet
    pub status: &'static str,
    pub add: u64,
    pub del: u64,
    /// some of its changes are in the index, ready to commit
    pub staged: bool,
    /// it has changes the index doesn't have yet (always, for a file git doesn't track)
    pub unstaged: bool,
}

/// What `parseStatus` reads: the changed files, then the branch and how far from its upstream
/// (in the order the TS object gets its keys).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize)]
pub struct ParsedStatus {
    pub files: Vec<GitFile>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upstream: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ahead: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub behind: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GitState {
    pub repo: bool,
    /// the repository's top folder
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root: Option<String>,
    /// it has somewhere to push to
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote: Option<bool>,
    #[serde(flatten)]
    pub status: ParsedStatus,
}

pub(crate) const GIT: &str = "GIT_TERMINAL_PROMPT=0 GIT_OPTIONAL_LOCKS=0 git -c core.quotepath=off -c color.ui=false";
/// git for commands that name files: a path is a file name, never a pattern (`*.md`, `:(top)x`).
const GITP: &str = "GIT_TERMINAL_PROMPT=0 GIT_LITERAL_PATHSPECS=1 git -c core.quotepath=off -c color.ui=false";

/// The letter a file shows from git's two status columns (index, then working tree).
fn status_letter(x: char, y: char) -> &'static str {
    if x == '?' {
        "?"
    } else if x == 'R' || y == 'R' || x == 'C' || y == 'C' {
        "R"
    } else if x == 'D' || y == 'D' {
        "D"
    } else if x == 'A' || y == 'A' {
        "A"
    } else {
        "M"
    }
}

/// Line counts from `git diff --numstat -z`, by path (a rename counts under its new path).
fn numstat_counts(numstat: &str) -> std::collections::HashMap<String, (u64, u64)> {
    let mut counts = std::collections::HashMap::new();
    let ns: Vec<&str> = numstat.split('\0').collect();
    let mut i = 0;
    while i < ns.len() {
        if let Some(m) = re!(r"^(-|\d+)\t(-|\d+)\t(.*)$", "s").captures(ns[i]) {
            // a rename is "add\tdel\t" then the old and new paths as their own fields
            let path = if m[3].is_empty() {
                i += 2;
                ns.get(i).map(|s| s.to_string())
            } else {
                Some(m[3].to_owned())
            };
            if let Some(path) = path {
                counts.insert(path, (count(&m[1]), count(&m[2])));
            }
        }
        i += 1;
    }
    counts
}

/// Reads `git status --porcelain=v2 -z --branch` (or v1, from a git older than 2.11) and
/// `git diff --numstat -z` into a list.
pub fn parse_status(status: &str, numstat: &str) -> ParsedStatus {
    if !status.starts_with("# ") && !status.is_empty() {
        return parse_status_v1(status, numstat);
    }
    let counts = numstat_counts(numstat);
    let mut out = ParsedStatus::default();
    let parts: Vec<&str> = status.split('\0').collect();
    let mut file = |path: &str, from: Option<String>, xy: &str| {
        let mut c = xy.chars();
        let (x, y) = (c.next().unwrap_or('.'), c.next().unwrap_or('.'));
        let (add, del) = counts.get(path).copied().unwrap_or((0, 0));
        let untracked = x == '?';
        out.files.push(GitFile {
            path: path.to_owned(),
            from: from.filter(|f| !f.is_empty()),
            status: status_letter(x, y),
            add,
            del,
            staged: !untracked && x != '.',
            unstaged: untracked || y != '.',
        });
    };
    let (mut branch, mut upstream, mut ab) = (None, None, None);
    let mut i = 0;
    while i < parts.len() {
        let e = parts[i];
        i += 1;
        if let Some(h) = e.strip_prefix("# ") {
            if let Some(b) = h.strip_prefix("branch.head ") {
                branch = Some(if b == "(detached)" { "detached".to_owned() } else { b.to_owned() });
            } else if let Some(u) = h.strip_prefix("branch.upstream ") {
                upstream = Some(u.to_owned());
            } else if let Some(m) = h.strip_prefix("branch.ab ").and_then(|v| re!(r"^\+(\d+) -(\d+)$").captures(v)) {
                ab = Some((count(&m[1]), count(&m[2])));
            }
            continue;
        }
        match e.split(' ').next() {
            // "1 XY sub mH mI mW hH hI path"
            Some("1") => {
                let f: Vec<&str> = e.splitn(9, ' ').collect();
                if f.len() == 9 {
                    file(f[8], None, f[1]);
                }
            }
            // "2 XY sub mH mI mW hH hI Xscore path", then where it was as the next field
            Some("2") => {
                let f: Vec<&str> = e.splitn(10, ' ').collect();
                let from = parts.get(i).map(|s| s.to_string());
                i += 1;
                if f.len() == 10 {
                    file(f[9], from, f[1]);
                }
            }
            // a conflict, "u XY sub m1 m2 m3 mW h1 h2 h3 path": not resolved until it's staged
            Some("u") => {
                let f: Vec<&str> = e.splitn(11, ' ').collect();
                if f.len() == 11 {
                    file(f[10], None, ".M");
                }
            }
            Some("?") => file(&e[2..], None, "??"),
            _ => {}
        }
    }
    if let Some(b) = branch {
        out.branch = Some(b);
        out.upstream = upstream;
        let (a, b) = ab.unwrap_or((0, 0));
        out.ahead = Some(a);
        out.behind = Some(b);
    }
    out
}

/// `git status --porcelain=v1 -z --branch`, for a git without v2.
fn parse_status_v1(status: &str, numstat: &str) -> ParsedStatus {
    let mut parts: Vec<&str> = status.split('\0').collect();
    let mut out = ParsedStatus::default();
    let head = if parts.first().is_some_and(|p| p.starts_with("## ")) { parts.remove(0)[3..].to_owned() } else { String::new() };
    if let Some(hm) = re!(r"^(?:No commits yet on |Initial commit on )?(.+?)(?:\.\.\.(\S+))?(?: \[(.+)\])?$").captures(&head) {
        out.branch = Some(if &hm[1] == "HEAD (no branch)" { "detached".into() } else { hm[1].to_owned() });
        out.upstream = hm.get(2).map(|m| m.as_str().to_owned());
        let track = hm.get(3).map(|m| m.as_str()).unwrap_or("");
        out.ahead = Some(re!(r"ahead (\d+)").captures(track).map_or(0, |c| count(&c[1])));
        out.behind = Some(re!(r"behind (\d+)").captures(track).map_or(0, |c| count(&c[1])));
    }
    let counts = numstat_counts(numstat);
    let mut i = 0;
    while i < parts.len() {
        let e = parts[i];
        if e.len16() < 4 {
            i += 1;
            continue;
        }
        let xy = e.to16(2);
        let path = e.from16(3).to_owned();
        let from = if xy.contains('R') || xy.contains('C') {
            i += 1;
            parts.get(i).map(|s| s.to_string())
        } else {
            None
        };
        let mut c = xy.chars().map(|c| if c == ' ' { '.' } else { c });
        let (x, y) = (c.next().unwrap_or('.'), c.next().unwrap_or('.'));
        let (add, del) = counts.get(&path).copied().unwrap_or((0, 0));
        out.files.push(GitFile { path, from: from.filter(|f| !f.is_empty()), status: status_letter(x, y), add, del, staged: x != '?' && x != '.', unstaged: x == '?' || y != '.' });
        i += 1;
    }
    out
}

/// The working tree against the last commit: branch, how far from its upstream, and every changed file.
pub async fn git_status(host_id: &str, pane_id: &str) -> HubResult<GitState> {
    let (host, cwd) = folder(host_id, pane_id)?;
    let sep = "\u{1}INYON\u{1}";
    let r = host
        .exec(
            &format!(
                "cd {} 2>/dev/null && command -v git >/dev/null && {GIT} rev-parse --show-toplevel 2>/dev/null || exit 3; printf '{sep}'; {{ {GIT} status --porcelain=v2 -z --branch --untracked-files=all 2>/dev/null || {GIT} status --porcelain=v1 -z --branch --untracked-files=all 2>/dev/null; }} | head -c 1000000; printf '{sep}'; {{ {GIT} diff HEAD --numstat -z 2>/dev/null || {GIT} diff --cached --numstat -z 2>/dev/null; }} | head -c 1000000; printf '{sep}'; {GIT} remote 2>/dev/null | head -1",
                shq(&cwd)
            ),
            ExecOptions::timeout(20000),
        )
        .await?;
    if r.code == 3 || !r.stdout.contains(sep) {
        return Ok(GitState { repo: false, root: None, remote: None, status: ParsedStatus::default() });
    }
    let parts: Vec<&str> = r.stdout.split(sep).collect();
    let s = parse_status(parts.get(1).copied().unwrap_or(""), parts.get(2).copied().unwrap_or(""));
    Ok(GitState { repo: true, root: Some(parts[0].jtrim().to_owned()), remote: Some(!parts.get(3).copied().unwrap_or("").jtrim().is_empty()), status: s })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hunk {
    pub old_start: u64,
    pub old_lines: u64,
    pub new_start: u64,
    pub new_lines: u64,
    pub lines: Vec<String>,
}

/// A unified diff's hunks, in the shape the app's diff view draws.
pub fn parse_hunks(diff: &str) -> Vec<Hunk> {
    let mut hunks: Vec<Hunk> = vec![];
    for line in diff.split('\n') {
        if let Some(m) = re!(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@").captures(line) {
            let n = |i: usize| m.get(i).map_or(1, |g| count(g.as_str()));
            hunks.push(Hunk { old_start: count(&m[1]), old_lines: n(2), new_start: count(&m[3]), new_lines: n(4), lines: vec![] });
        } else if let Some(cur) = hunks.last_mut() {
            if re!(r"^[ +\-\\]").is_match(line) {
                cur.lines.push(line.to_owned());
            }
        }
    }
    hunks
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GitDiff {
    pub path: String,
    pub binary: bool,
    pub hunks: Vec<Hunk>,
}

/// One file's changes since the last commit; a file git doesn't track yet shows as all new.
pub async fn git_diff(host_id: &str, pane_id: &str, rel: &str) -> HubResult<GitDiff> {
    let (host, cwd) = folder(host_id, pane_id)?;
    let path = inside(rel)?;
    if path.is_empty() {
        return Err(http(400, "Bad path"));
    }
    let p = shq(&path);
    let r = host
        .exec(
            &format!(
                "{}; if {GITP} ls-files --error-unmatch -- {p} >/dev/null 2>&1; then {GITP} diff HEAD --no-ext-diff -U3 -- {p} 2>/dev/null || {GITP} diff --cached --no-ext-diff -U3 -- {p}; else {GITP} diff --no-index --no-ext-diff -U3 -- /dev/null {p}; fi | head -c 2000000",
                to_top(&cwd)
            ),
            ExecOptions::timeout(20000),
        )
        .await?;
    if r.code == 3 {
        return Err(http(409, "Not a git repository"));
    }
    Ok(GitDiff { path, binary: re!(r"^Binary files ", "m").is_match(&r.stdout), hunks: parse_hunks(&r.stdout) })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GitCommitted {
    pub commit: String,
}

/// The last few lines of what git said, or `fallback` when it said nothing.
pub(crate) fn last_lines(text: &str, fallback: &str) -> String {
    let lines: Vec<&str> = text.jtrim().split('\n').collect();
    let tail = lines[lines.len().saturating_sub(6)..].join("\n");
    if tail.is_empty() {
        fallback.to_owned()
    } else {
        tail
    }
}

/// What a commit takes: what's staged, everything, or (when the app doesn't say) what's staged
/// if anything is and everything otherwise.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommitWhat {
    Staged,
    All,
    Auto,
}

impl CommitWhat {
    /// The request's `staged` field: true, false, or left out.
    pub fn from_field(v: Option<&Value>) -> Self {
        match v {
            Some(Value::Bool(true)) => Self::Staged,
            Some(Value::Bool(false)) => Self::All,
            _ => Self::Auto,
        }
    }
}

/// The shell line that commits, with the message on stdin, and prints the new commit's short hash.
pub fn commit_command(cwd: &str, what: CommitWhat) -> String {
    let add = match what {
        CommitWhat::All => format!("{GIT} add -A && "),
        // exit 1 from diff --quiet means something is staged
        CommitWhat::Staged => format!("if {GIT} diff --cached --quiet; then echo 'Nothing is staged' >&2; exit 5; fi; "),
        CommitWhat::Auto => format!("if {GIT} diff --cached --quiet; then {GIT} add -A || exit 1; fi; "),
    };
    format!("cd {} || exit 3; {add}{GIT} commit -q -F - && {GIT} log -1 --format=%h", shq(cwd))
}

/// Commits with your message, as `git commit` would: what's staged when you say so (or when
/// anything is), otherwise everything, as `git add -A && git commit`. Git's own hooks and signing
/// run as usual; one that needs a password typed fails instead of waiting.
/// `message` is the request's field as it came (`String(message ?? '')`).
pub async fn git_commit(host_id: &str, pane_id: &str, message: Option<&Value>, what: CommitWhat) -> HubResult<GitCommitted> {
    let (host, cwd) = folder(host_id, pane_id)?;
    let raw = match message {
        None | Some(Value::Null) => String::new(),
        Some(v) => crate::js::json::value_string(v),
    };
    let msg = raw.jtrim();
    if msg.is_empty() {
        return Err(http(400, "Write a commit message"));
    }
    if msg.len16() > 10000 || msg.contains('\0') {
        return Err(http(400, "That message is too long"));
    }
    let r = host.exec(&commit_command(&cwd, what), ExecOptions::input(msg).with_timeout(60000)).await?;
    if r.code != 0 {
        let said = if r.stderr.is_empty() { &r.stdout } else { &r.stderr };
        return Err(http(409, last_lines(said, "Could not commit")));
    }
    Ok(GitCommitted { commit: r.stdout.jtrim().split('\n').next_back().unwrap_or("").to_owned() })
}

/// What a push answers: nothing (`{}`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GitPushed {}

/// Pushes the branch to its upstream, or to origin under the same name when it has none yet.
pub async fn git_push(host_id: &str, pane_id: &str) -> HubResult<GitPushed> {
    let (host, cwd) = folder(host_id, pane_id)?;
    let r = host
        .exec(
            &format!(
                "cd {} && if {GIT} rev-parse --abbrev-ref --symbolic-full-name '@{{u}}' >/dev/null 2>&1; then {GIT} push -q; else {GIT} push -q -u origin HEAD; fi < /dev/null",
                shq(&cwd)
            ),
            ExecOptions::timeout(90000),
        )
        .await?;
    if r.code != 0 {
        return Err(http(409, last_lines(&r.stderr, "Could not push")));
    }
    Ok(GitPushed {})
}

// ---------- one file at a time: stage, unstage, discard ----------

/// `cd` to the top of the repository the folder is in, or exit 3 when there's none.
pub(crate) fn to_top(cwd: &str) -> String {
    format!("top=$({GIT} -C {} rev-parse --show-toplevel 2>/dev/null) && [ -n \"$top\" ] && cd \"$top\" || exit 3", shq(cwd))
}

/// The most files one request names; "all" covers more.
const PATHS_MAX: usize = 1000;

/// The request's `paths`: each inside the repository, none empty, at most PATHS_MAX.
pub fn paths_of(v: Option<&Value>) -> HubResult<Vec<String>> {
    let list = match v {
        Some(Value::Array(a)) => a,
        None | Some(Value::Null) => return Ok(vec![]),
        _ => return Err(http(400, "paths is a list of files")),
    };
    if list.len() > PATHS_MAX {
        return Err(http(400, format!("At most {PATHS_MAX} files at a time")));
    }
    let mut out = vec![];
    for p in list {
        let Value::String(p) = p else { return Err(http(400, "paths is a list of files")) };
        let p = inside(p)?;
        if p.is_empty() {
            return Err(http(400, "Bad path"));
        }
        if !out.contains(&p) {
            out.push(p);
        }
    }
    Ok(out)
}

fn quoted(paths: &[String]) -> String {
    paths.iter().map(|p| shq(p)).collect::<Vec<_>>().join(" ")
}

/// What `git_stage` does to the index.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stage {
    /// put the files' changes in the index, deletions too
    Add,
    /// take them out again, leaving the files as they are
    Remove,
}

/// The shell line that stages or unstages `paths` (every change, with `paths` empty).
pub fn stage_command(cwd: &str, how: Stage, paths: &[String]) -> String {
    let files = if paths.is_empty() { String::new() } else { format!(" -- {}", quoted(paths)) };
    let run = match how {
        Stage::Add if paths.is_empty() => format!("{GITP} add -A"),
        Stage::Add => format!("{GITP} add -A{files}"),
        // reset works before the first commit too, where restore --staged has no HEAD to go back to
        Stage::Remove => format!("{GITP} reset -q{files}"),
    };
    format!("{}; {run}", to_top(cwd))
}

/// The shell line that throws away every change to `paths`: a file the last commit has goes back
/// to it (index and working tree), a file added since is taken out of the index and deleted, and a
/// file git doesn't track is deleted. A path with nothing to discard (an ignored file, a file with
/// no changes) stops it before anything changes, with exit 4.
pub fn discard_command(cwd: &str, paths: &[String]) -> String {
    let mut s = to_top(cwd);
    for p in paths {
        let q = shq(p);
        s += &format!("; [ -n \"$({GITP} status --porcelain=v1 -z --untracked-files=all -- {q} 2>/dev/null | tr '\\000' '\\n')\" ] || {{ printf 'Nothing to discard in %s\\n' {q} >&2; exit 4; }}");
    }
    for p in paths {
        let q = shq(p);
        s += &format!(
            "; if {GIT} cat-file -e HEAD:{q} 2>/dev/null; then {GITP} restore --source=HEAD --staged --worktree -- {q} 2>/dev/null || {GITP} checkout -q HEAD -- {q} || exit 1; elif {GITP} ls-files --error-unmatch -- {q} >/dev/null 2>&1; then {GITP} rm -q -f -- {q} || exit 1; else {GITP} clean -q -f -- {q} || exit 1; fi"
        );
    }
    s
}

/// Stages or unstages files (`paths`), or every change (`all`), and answers with the new status.
pub async fn git_stage(host_id: &str, pane_id: &str, how: Stage, paths: Vec<String>, all: bool) -> HubResult<GitState> {
    if paths.is_empty() && !all {
        return Err(http(400, "Pick a file"));
    }
    let (host, cwd) = folder(host_id, pane_id)?;
    let r = host.exec(&stage_command(&cwd, how, if all { &[] } else { &paths }), ExecOptions::timeout(30000)).await?;
    if r.code == 3 {
        return Err(http(409, "Not a git repository"));
    }
    if r.code != 0 {
        return Err(http(409, last_lines(&r.stderr, if how == Stage::Add { "Could not stage" } else { "Could not unstage" })));
    }
    git_status(host_id, pane_id).await
}

/// Throws away the changes to `paths` (a renamed file names both its paths) and answers with the new status.
pub async fn git_discard(host_id: &str, pane_id: &str, paths: Vec<String>) -> HubResult<GitState> {
    if paths.is_empty() {
        return Err(http(400, "Pick a file"));
    }
    let (host, cwd) = folder(host_id, pane_id)?;
    let r = host.exec(&discard_command(&cwd, &paths), ExecOptions::timeout(30000)).await?;
    match r.code {
        0 => git_status(host_id, pane_id).await,
        3 => Err(http(409, "Not a git repository")),
        4 => Err(http(409, last_lines(&r.stderr, "Nothing to discard"))),
        _ => Err(http(409, last_lines(&r.stderr, "Could not discard"))),
    }
}

// ---------- a draft commit message ----------

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GitDraft {
    pub message: String,
}

/// The most files a draft lists by name.
const DRAFT_LIST: usize = 20;

/// The folder every path is in ("" when they share none), at most two levels deep.
fn common_dir(paths: &[&str]) -> String {
    let mut dirs = paths.iter().map(|p| p.rsplit_once('/').map_or("", |(d, _)| d));
    let Some(first) = dirs.next() else { return String::new() };
    let mut common: Vec<&str> = if first.is_empty() { vec![] } else { first.split('/').collect() };
    for d in dirs {
        let segs: Vec<&str> = if d.is_empty() { vec![] } else { d.split('/').collect() };
        let same = common.iter().zip(&segs).take_while(|(a, b)| a == b).count();
        common.truncate(same);
    }
    common.truncate(2);
    common.join("/")
}

fn name_of(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

/// A commit message to start from, made from the changed files alone: a short summary line
/// ("Update 3 files in apps/web") and, for more than one file, a list of them. It describes what
/// would be committed: the staged files when any are staged, otherwise all of them.
pub fn draft_message(files: &[GitFile]) -> String {
    let staged: Vec<&GitFile> = files.iter().filter(|f| f.staged).collect();
    let list: Vec<&GitFile> = if staged.is_empty() { files.iter().collect() } else { staged };
    let verb = |s: &str| match s {
        "A" | "?" => "Add",
        "D" => "Remove",
        "R" => "Rename",
        _ => "Update",
    };
    let short = |p: &str| if p.chars().count() > 50 { name_of(p).to_owned() } else { p.to_owned() };
    match list.as_slice() {
        [] => String::new(),
        [f] if f.status == "R" && f.from.is_some() => {
            let from = f.from.as_deref().unwrap_or("");
            format!("Rename {} to {}", name_of(from), short(&f.path))
        }
        [f] => format!("{} {}", verb(f.status), short(&f.path)),
        many => {
            let v = verb(many[0].status);
            let v = if many.iter().all(|f| verb(f.status) == v) { v } else { "Update" };
            let paths: Vec<&str> = many.iter().map(|f| f.path.as_str()).collect();
            let dir = common_dir(&paths);
            let mut s = format!("{v} {} files{}", many.len(), if dir.is_empty() { String::new() } else { format!(" in {dir}") });
            s += "\n";
            for f in many.iter().take(DRAFT_LIST) {
                let note = match f.status {
                    "A" | "?" if v != "Add" => " (new)".to_owned(),
                    "D" if v != "Remove" => " (deleted)".to_owned(),
                    "R" => f.from.as_ref().map_or(String::new(), |from| format!(" (was {from})")),
                    _ => String::new(),
                };
                s += &format!("\n- {}{note}", f.path);
            }
            if many.len() > DRAFT_LIST {
                s += &format!("\n- and {} more", many.len() - DRAFT_LIST);
            }
            s
        }
    }
}

/// A draft commit message for what the working tree would commit now.
pub async fn git_draft(host_id: &str, pane_id: &str) -> HubResult<GitDraft> {
    let s = git_status(host_id, pane_id).await?;
    if !s.repo {
        return Err(http(409, "Not a git repository"));
    }
    Ok(GitDraft { message: draft_message(&s.status.files) })
}

#[cfg(test)]
#[path = "workspace_tests.rs"]
mod tests;
