//! Sessions in a git worktree of their own (New session › In a new worktree), so agents working
//! on one repo in parallel don't edit the same files.
//!
//! The worktree goes next to the repo, never inside it: `<repo's parent>/.inyon-worktrees/<repo>-<name>`,
//! on a new branch from what the chosen folder has checked out (or the branch itself, when it
//! already exists and isn't checked out anywhere). The hub keeps a record of each one it made, so
//! a pane working in it shows its branch, and ending the session can remove the worktree too:
//! only when nothing would be lost (no uncommitted changes, no commits that are on no other branch
//! or remote). The branch goes with it only when git calls it merged (`git branch -d`).
//!
//! Everything runs as POSIX shell on the session's machine (busybox sh on Windows), with every
//! path and name quoted.

use std::cell::RefCell;

pub use inyon_protocol::worktree::{check_branch, default_branch, folder_slug, slug};
use inyon_protocol::{PaneWorktree, SessionInfo};
use serde::{Deserialize, Serialize};

use crate::clock::now_ms;
use crate::hosts::host::{shq, ExecOptions, Host};
use crate::hosts::http_error::{http, HubResult};
use crate::hosts::registry::registry;
use crate::js::text::JsStr;
use crate::platform::store::kv;

/// The folder next to a repo that holds its worktrees.
pub const FOLDER: &str = ".inyon-worktrees";

/// git that never asks for a password or takes optional locks, with plain output.
const GIT: &str = "GIT_TERMINAL_PROMPT=0 GIT_OPTIONAL_LOCKS=0 git -c core.quotepath=off -c color.ui=false";

/// The records kept: plenty for anyone, and old ones go first.
const KEEP: usize = 200;

// ---------- names ----------

/// Now as MMDD-HHMM in UTC, for a branch the hub names itself.
fn utc_stamp() -> String {
    let iso = crate::js::date::to_iso(now_ms() as f64).unwrap_or_default();
    if iso.len() < 16 {
        return "0000-0000".into();
    }
    format!("{}{}-{}{}", &iso[5..7], &iso[8..10], &iso[11..13], &iso[14..16])
}

// ---------- shell ----------

/// The shell that makes the worktree for the folder `dir` (a shell word, already quoted; `shown`
/// is how errors name it) on `branch`, which `check_branch` passed. Prints the worktree's path,
/// the main checkout's path, "new" or "existing" (the branch) and where `dir` is inside the repo
/// (`web/` for a subfolder, empty at the top), a line each; a reason on stderr with exit code 3
/// when it can't.
pub fn add_command(dir: &str, shown: &str, branch: &str) -> String {
    let b = shq(branch);
    let r = shq(&format!("refs/heads/{branch}"));
    let s = shq(&folder_slug(branch));
    let shown = shq(shown);
    format!(
        r#"d={dir}; [ -d "$d" ] || {{ echo "No such folder: "{shown} >&2; exit 3; }}
command -v git >/dev/null 2>&1 || {{ echo "git isn't installed on this machine" >&2; exit 3; }}
main=$({GIT} -C "$d" worktree list --porcelain 2>/dev/null | sed -n '1s/^worktree //p')
[ -n "$main" ] || {{ echo "That folder isn't in a git repository" >&2; exit 3; }}
base="$(dirname "$main")/{FOLDER}"; name="$(basename "$main")-"{s}; p="$base/$name"; i=2
while [ -e "$p" ]; do p="$base/$name-$i"; i=$((i+1)); done
mkdir -p "$base" || {{ echo "Could not make $base" >&2; exit 3; }}
if {GIT} -C "$d" show-ref --verify --quiet {r}; then k=existing; {GIT} -C "$d" worktree add -q "$p" {b}; else k=new; {GIT} -C "$d" worktree add -q -b {b} "$p"; fi </dev/null >&2 || exit 4
pre=$({GIT} -C "$d" rev-parse --show-prefix 2>/dev/null)
printf '%s\n%s\n%s\n%s\n' "$p" "$main" "$k" "$pre""#
    )
}

/// What `add_command` printed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Made {
    pub path: String,
    pub repo: String,
    pub branch: String,
    /// the branch was made for it, rather than an existing one checked out
    pub new_branch: bool,
    /// where the session starts: the same subfolder of the worktree as the folder picked was of the repo
    pub start: String,
}

pub fn parse_add(stdout: &str, branch: &str) -> Option<Made> {
    let mut lines = stdout.lines().map(|l| l.trim_end_matches('\r'));
    let path = lines.next().filter(|l| !l.is_empty())?.to_owned();
    let repo = lines.next().filter(|l| !l.is_empty())?.to_owned();
    let new_branch = match lines.next()? {
        "new" => true,
        "existing" => false,
        _ => return None,
    };
    // only a plain relative path inside it: anything else starts at the top
    let pre = lines.next().unwrap_or("").trim_end_matches('/');
    let start = if pre.is_empty() || pre.starts_with('/') || pre.split('/').any(|p| p == ".." || p.is_empty()) { path.clone() } else { format!("{path}/{pre}") };
    Some(Made { path, repo, branch: branch.to_owned(), new_branch, start })
}

/// git's own words for a failure, without its "fatal: " or "error: ".
fn git_error(stderr: &str, fallback: &str) -> String {
    let lines: Vec<&str> = stderr.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with("hint:")).collect();
    let line = lines.iter().rev().find(|l| l.starts_with("fatal:") || l.starts_with("error:")).or(lines.last()).copied().unwrap_or("");
    let msg = line.trim_start_matches("fatal:").trim_start_matches("error:").trim();
    if msg.is_empty() {
        fallback.to_owned()
    } else {
        let mut c = msg.chars();
        c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
    }
}

/// Makes the worktree on `host` for the folder `dir` (see `add_command`).
pub async fn create(host: &Host, dir: &str, shown: &str, branch: &str) -> HubResult<Made> {
    check_branch(branch).map_err(|e| http(400, e))?;
    let r = host.exec(&add_command(dir, shown, branch), ExecOptions::timeout(120_000)).await?;
    if r.code == 0 {
        if let Some(m) = parse_add(&r.stdout, branch) {
            return Ok(m);
        }
    }
    Err(http(400, git_error(&r.stderr, "Could not make the worktree")))
}

/// Takes back a worktree just made, when its session couldn't start.
async fn undo(host: &Host, m: &Made) {
    let drop_branch = if m.new_branch { format!("; {GIT} -C {} branch -D {} >/dev/null 2>&1", shq(&m.repo), shq(&m.branch)) } else { String::new() };
    let _ = host.run(&format!("{GIT} -C {} worktree remove --force {} >/dev/null 2>&1{drop_branch}; true", shq(&m.repo), shq(&m.path))).await;
}

/// The repo a folder is in, for New session: its top folder and the branch checked out there.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RepoInfo {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
}

pub fn repo_command(dir: &str) -> String {
    format!(
        r#"cd {dir} 2>/dev/null && command -v git >/dev/null 2>&1 || exit 3; {GIT} rev-parse --show-toplevel 2>/dev/null || exit 3; {GIT} symbolic-ref --short -q HEAD 2>/dev/null; true"#
    )
}

pub fn parse_repo(code: i32, stdout: &str) -> RepoInfo {
    let mut lines = stdout.lines().map(|l| l.trim_end_matches('\r'));
    match lines.next().filter(|l| code == 0 && !l.is_empty()) {
        Some(root) => RepoInfo { root: Some(root.to_owned()), branch: lines.next().filter(|l| !l.is_empty()).map(str::to_owned) },
        None => RepoInfo { root: None, branch: None },
    }
}

/// A folder as the app's New session sheet sends it, as a shell word: `~` and `~/…` start at the
/// machine's home folder.
pub fn folder_word(cwd: &str) -> String {
    let cwd = cwd.jtrim();
    let cwd = if cwd.is_empty() { "~" } else { cwd };
    if cwd == "~" || cwd.starts_with("~/") {
        format!("\"$HOME\"{}", shq(&cwd[1..]))
    } else {
        shq(cwd)
    }
}

/// `GET /api/hosts/:id/repo?path=`: whether a folder is in a git repo, and which.
pub async fn repo_of(host_id: &str, cwd: &str) -> HubResult<RepoInfo> {
    let host = registry().host(host_id)?;
    let r = host.exec(&repo_command(&folder_word(cwd)), ExecOptions::timeout(15_000)).await?;
    Ok(parse_repo(r.code, &r.stdout))
}

/// A worktree as ending its session sees it: whether removing it would lose anything.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeState {
    /// the folder is still there
    pub exists: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    /// files changed, added or not yet tracked; None when git couldn't say
    #[serde(skip_serializing_if = "Option::is_none")]
    pub changes: Option<u32>,
    /// commits on no other branch and no remote; None when git couldn't say
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unpushed: Option<u32>,
    /// other sessions still working in it
    pub sessions: u32,
}

impl WorktreeState {
    /// Nothing would be lost by removing it, as far as git can tell.
    pub fn clean(&self) -> bool {
        self.exists && self.changes == Some(0) && self.unpushed == Some(0) && self.sessions == 0
    }

    /// Why it stays, in a sentence, or None when it can go.
    pub fn keep_reason(&self) -> Option<String> {
        let n = |k: u32, one: &str, many: &str| if k == 1 { format!("1 {one}") } else { format!("{k} {many}") };
        Some(if !self.exists {
            "The worktree folder is already gone".into()
        } else if self.sessions > 0 {
            format!("{} still working in it", n(self.sessions, "other session is", "other sessions are"))
        } else if let Some(c) = self.changes.filter(|c| *c > 0) {
            format!("It has {}", n(c, "uncommitted change", "uncommitted changes"))
        } else if let Some(u) = self.unpushed.filter(|u| *u > 0) {
            format!("It has {} that no other branch or remote has", n(u, "commit", "commits"))
        } else if self.changes.is_none() || self.unpushed.is_none() {
            "Git couldn't say whether it's clean".into()
        } else {
            return None;
        })
    }
}

pub fn state_command(path: &str) -> String {
    format!(
        r#"cd {} 2>/dev/null || {{ echo gone; exit 0; }}; command -v git >/dev/null 2>&1 || exit 3
b=$({GIT} symbolic-ref --short -q HEAD 2>/dev/null); echo "branch $b"
c=$({GIT} status --porcelain=v1 --untracked-files=normal 2>/dev/null) && echo "changes $(printf '%s' "$c" | grep -c '')"
if [ -n "$b" ]; then u=$({GIT} rev-list --count HEAD --not --exclude="$b" --branches --remotes 2>/dev/null); else u=$({GIT} rev-list --count HEAD --not --branches --remotes 2>/dev/null); fi && echo "unpushed $u""#,
        shq(path)
    )
}

/// What `state_command` printed; `sessions` is filled in by the caller.
pub fn parse_state(stdout: &str) -> WorktreeState {
    let mut s = WorktreeState { exists: true, branch: None, changes: None, unpushed: None, sessions: 0 };
    for line in stdout.lines().map(|l| l.trim_end_matches('\r')) {
        if line == "gone" {
            s.exists = false;
        }
        let (k, v) = line.split_once(' ').unwrap_or((line, ""));
        let v = v.trim();
        match k {
            "branch" => s.branch = Some(v.to_owned()).filter(|b| !b.is_empty()),
            "changes" => s.changes = v.parse().ok(),
            "unpushed" => s.unpushed = v.parse().ok(),
            _ => {}
        }
    }
    s
}

/// Removes the worktree (git refuses one with changes, as a second check) and its branch when git
/// calls it merged. Prints "kept" when the branch stayed.
pub fn remove_command(repo: &str, path: &str, branch: &str) -> String {
    format!(r#"{GIT} -C {r} worktree remove {p} </dev/null || exit 4; {GIT} -C {r} branch -d {b} >/dev/null 2>&1 || echo kept"#, r = shq(repo), p = shq(path), b = shq(branch))
}

// ---------- records ----------

/// A worktree Inyon made, kept in `worktrees.json` on the hub.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub host: String,
    pub path: String,
    pub branch: String,
    /// the main checkout, where git commands about it run
    pub repo: String,
    pub created: u64,
}

thread_local! {
    static RECORDS: RefCell<Option<Vec<Record>>> = const { RefCell::new(None) };
}

fn with<R>(f: impl FnOnce(&mut Vec<Record>) -> R) -> R {
    RECORDS.with(|r| {
        let mut r = r.borrow_mut();
        f(r.get_or_insert_with(|| kv::get("worktrees").unwrap_or_default()))
    })
}

fn save(all: &[Record]) {
    let _ = kv::set("worktrees", all);
}

/// Paths the same way on every system: forward slashes, no slash at the end, and Windows drive
/// paths (`C:/…`) without case.
fn norm(p: &str) -> String {
    let s = p.replace('\\', "/");
    let s = s.trim_end_matches('/');
    let b = s.as_bytes();
    if b.len() >= 2 && b[1] == b':' && b[0].is_ascii_alphabetic() {
        s.to_ascii_lowercase()
    } else {
        s.to_owned()
    }
}

/// `cwd` is the worktree's folder or one inside it.
pub fn within(cwd: &str, path: &str) -> bool {
    let (c, p) = (norm(cwd), norm(path));
    !p.is_empty() && (c == p || c.starts_with(&format!("{p}/")))
}

pub fn remember(host: &str, m: &Made) {
    with(|all| {
        all.retain(|r| !(r.host == host && norm(&r.path) == norm(&m.path)));
        all.push(Record { host: host.to_owned(), path: m.path.clone(), branch: m.branch.clone(), repo: m.repo.clone(), created: now_ms() });
        let over = all.len().saturating_sub(KEEP);
        all.drain(..over);
        save(all);
    })
}

pub fn forget(host: &str, path: &str) {
    with(|all| {
        let before = all.len();
        all.retain(|r| !(r.host == host && norm(&r.path) == norm(path)));
        if all.len() != before {
            save(all);
        }
    })
}

/// The worktree Inyon made that holds `cwd` on this machine, if any.
pub fn find(host: &str, cwd: &str) -> Option<Record> {
    with(|all| all.iter().rev().find(|r| r.host == host && within(cwd, &r.path)).cloned())
}

/// The worktrees Inyon made on this machine, newest first.
pub fn list(host: &str) -> Vec<Record> {
    with(|all| all.iter().rev().filter(|r| r.host == host).cloned().collect())
}

/// Marks every pane working in a worktree Inyon made with its branch and folder.
pub fn mark(host_id: &str, sessions: &mut [SessionInfo]) {
    let mine = list(host_id);
    for p in sessions.iter_mut().flat_map(|s| s.windows.iter_mut().flat_map(|w| w.panes.iter_mut())) {
        p.worktree = mine.iter().find(|r| within(&p.cwd, &r.path)).map(|r| PaneWorktree { branch: r.branch.clone(), path: r.path.clone() });
    }
}

/// Live panes on the machine working in the worktree, leaving out `except` (the session being ended).
fn sessions_in(host_id: &str, path: &str, except: Option<&str>) -> u32 {
    let Some(rt) = registry().get(host_id) else { return 0 };
    let r = rt.borrow();
    r.state.sessions.iter().flat_map(|s| s.windows.iter().flat_map(|w| w.panes.iter())).filter(|p| !p.dead && Some(p.id.as_str()) != except && within(&p.cwd, path)).count() as u32
}

fn record(host_id: &str, path: &str) -> HubResult<Record> {
    list(host_id).into_iter().find(|r| norm(&r.path) == norm(path)).ok_or_else(|| http(404, "Inyon didn't make that worktree"))
}

/// `GET /api/hosts/:id/worktree?path=&pane=`: whether ending the session `pane` could remove its
/// worktree too. A worktree whose folder has gone is forgotten.
pub async fn state(host_id: &str, path: &str, except: Option<&str>) -> HubResult<WorktreeState> {
    let rec = record(host_id, path)?;
    let host = registry().host(host_id)?;
    let r = host.exec(&state_command(&rec.path), ExecOptions::timeout(20_000)).await?;
    let mut s = if r.code == 0 { parse_state(&r.stdout) } else { WorktreeState { exists: true, branch: None, changes: None, unpushed: None, sessions: 0 } };
    if !s.exists {
        forget(host_id, &rec.path);
    }
    s.sessions = sessions_in(host_id, &rec.path, except);
    Ok(s)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Removed {
    /// the branch was merged, so it went too
    pub branch_deleted: bool,
}

/// `POST /api/hosts/:id/worktree/remove { path, pane }`: removes a worktree Inyon made, once its
/// session has ended, only when nothing would be lost. Otherwise 409 with the reason.
pub async fn remove(host_id: &str, path: &str, except: Option<&str>) -> HubResult<Removed> {
    let rec = record(host_id, path)?;
    let s = state(host_id, path, except).await?;
    if let Some(why) = s.keep_reason() {
        return Err(http(409, format!("{why}, so it stays")));
    }
    let host = registry().host(host_id)?;
    let r = host.exec(&remove_command(&rec.repo, &rec.path, &rec.branch), ExecOptions::timeout(60_000)).await?;
    if r.code != 0 {
        return Err(http(409, git_error(&r.stderr, "Could not remove the worktree")));
    }
    forget(host_id, &rec.path);
    registry().refresh(host_id, 300);
    Ok(Removed { branch_deleted: !r.stdout.contains("kept") })
}

/// For `launch`: the worktree to start a session in, made from the folder `cwd`, on `branch` or
/// the suggested one.
pub async fn for_launch(host: &Host, cwd: &str, branch: Option<&str>, prompt: Option<&str>, agent: &str) -> HubResult<Made> {
    let branch = match branch.map(JsStr::jtrim).filter(|b| !b.is_empty()) {
        Some(b) => b.to_owned(),
        None => default_branch(prompt, agent, &utc_stamp()),
    };
    let shown = cwd.replace(['"', '$', '`', '\\'], "");
    create(host, &folder_word(cwd), &shown, &branch).await
}

/// For `launch`: the session started, so its worktree is kept on record; or it didn't, so the
/// worktree goes again.
pub async fn settle(host_id: &str, host: &Host, m: &Made, started: bool) {
    if started {
        remember(host_id, m);
    } else {
        undo(host, m).await;
    }
}

#[cfg(test)]
#[path = "worktrees_tests.rs"]
mod tests;
