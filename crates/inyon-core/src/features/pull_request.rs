//! Pull requests for the Working tree, through the machine's own GitHub CLI (`gh`, signed in
//! there): the branch's pull request with its checks, and opening one once the branch is pushed.
//! Each is one short shell command in the session's repository, like the rest of the Working
//! tree. Nothing about GitHub is kept on the hub.

use serde::Serialize;
use serde_json::Value;

use super::workspace::{folder, last_lines, to_top, GIT};
use crate::hosts::host::ExecOptions;
use crate::hosts::http_error::{http, HubResult};
use crate::js::text::JsStr;
use crate::re;

/// gh with no questions, colour, spinner or update notice.
const GH: &str = "GH_PROMPT_DISABLED=1 GH_NO_UPDATE_NOTIFIER=1 GH_SPINNER_DISABLED=1 NO_COLOR=1 CLICOLOR=0 gh";
const SEP: &str = "\u{1}INYON\u{1}";
/// What `gh pr view --json` is asked for. `gh pr checks --json` came later (2.41), so the checks
/// come from `statusCheckRollup`, which older versions have too.
const FIELDS: &str = "number,title,state,url,isDraft,mergeable,statusCheckRollup";
/// The commits a draft is made from: subject, unit separator, body, record separator.
const LOG: &str = "--format=%s%x1f%b%x1e";

/// The branch and the repository's default branch (from `origin/HEAD`; empty when git doesn't know it).
const BRANCHES: &str = "br=$(GIT symbolic-ref -q --short HEAD 2>/dev/null); base=$(GIT symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null); base=${base#origin/}";

fn branches() -> String {
    BRANCHES.replace("GIT", GIT)
}

/// When git doesn't know the default branch, gh asks GitHub (status and creation both, so a new
/// pull request goes where the app said it would).
fn default_from_gh() -> String {
    format!("[ -n \"$base\" ] || base=$({GH} repo view --json defaultBranchRef --jq .defaultBranchRef.name)")
}

/// The shell line that reads the branch's pull request. It prints, between separators: the
/// branch, the default branch, `missing` or `ready` (gh is installed), then, on a branch that
/// isn't the default one, gh's JSON, its exit code, and the commits not on the default branch yet
/// (or just the last one) for a draft. gh's errors go to stderr. gh is asked about the branch it
/// recorded by name, so a checkout in between can't pass another branch's pull request off as this one's.
pub fn status_command(cwd: &str) -> String {
    format!(
        "{top}; {branches}; if ! command -v gh >/dev/null 2>&1; then printf '%s{SEP}%s{SEP}missing' \"$br\" \"$base\"; exit 0; fi; \
         {default}; \
         printf '%s{SEP}%s{SEP}ready' \"$br\" \"$base\"; [ -n \"$br\" ] && [ \"$br\" != \"$base\" ] || exit 0; printf '{SEP}'; \
         {GH} pr view --json {FIELDS} -- \"$br\"; printf '{SEP}%s{SEP}' $?; \
         {GIT} log {LOG} -n 50 \"origin/$base..HEAD\" 2>/dev/null || {GIT} log {LOG} -n 1 2>/dev/null",
        top = to_top(cwd),
        branches = branches(),
        default = default_from_gh(),
    )
}

/// The shell line that opens a pull request from the pushed branch into the default branch. The
/// title is the first line on stdin, which gh then gets as its `--title` argument, and the body
/// is the rest of stdin; neither is ever part of the command's text. The default branch is found
/// the way the status found it and named with `--base`, so gh's own per-branch setting can't
/// send it elsewhere.
pub fn create_command(cwd: &str) -> String {
    format!(
        "{top}; command -v gh >/dev/null 2>&1 || exit 6; IFS= read -r title; {branches}; {default}; \
         {GH} pr create --title \"$title\" --body-file - ${{base:+--base \"$base\"}}",
        top = to_top(cwd),
        branches = branches(),
        default = default_from_gh(),
    )
}

// ---------- what gh said ----------

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Check {
    pub name: String,
    /// where its log is, when gh gave one
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

/// A pull request's checks, summed up: how many passed or were skipped, and which failed or are still running.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Checks {
    pub passed: u64,
    pub skipped: u64,
    pub failed: Vec<Check>,
    pub running: Vec<Check>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PullRequest {
    pub number: u64,
    pub title: String,
    /// open, closed or merged
    pub state: String,
    pub draft: bool,
    pub url: String,
    /// it can't be merged as it is (GitHub found conflicts)
    pub conflicts: bool,
    pub checks: Checks,
}

/// A pull request to start from: the last commit's subject and the commits' bodies.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PrDraft {
    pub title: String,
    pub body: String,
}

/// What the Working tree shows about pull requests.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PrState {
    /// `ready`; `missing` (gh isn't installed); `signed-out`; `not-github` (no GitHub remote,
    /// nothing to show); `error` (see `message`)
    pub gh: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    /// the repository's default branch, where a new pull request goes
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pr: Option<PullRequest>,
    /// a title and body to start from, when the branch has no pull request yet
    #[serde(skip_serializing_if = "Option::is_none")]
    pub draft: Option<PrDraft>,
}

/// The check's state as `gh pr checks` reads it: a status context's state, a finished check
/// run's conclusion, or the run's status while it isn't finished.
fn check_state(c: &Value) -> &str {
    let s = |k: &str| c.get(k).and_then(Value::as_str).unwrap_or("");
    if c.get("context").is_some() || s("__typename") == "StatusContext" {
        s("state")
    } else if s("status") == "COMPLETED" {
        s("conclusion")
    } else {
        s("status")
    }
}

/// The latest run of each check: a check run again on the same commit (a re-run after a failure)
/// is listed once per run, and only the newest counts, as `gh pr checks` reads it. Runs are
/// told apart by name and workflow, newest by `startedAt`; the order is the first run's.
fn latest_runs(rollup: &Value) -> Vec<(String, &Value)> {
    let mut out: Vec<(String, &Value)> = vec![];
    let mut started: Vec<String> = vec![];
    for c in rollup.as_array().into_iter().flatten() {
        let s = |k: &str| c.get(k).and_then(Value::as_str).unwrap_or("").jtrim().to_owned();
        let (name, workflow) = if c.get("context").is_some() { (s("context"), String::new()) } else { (s("name"), s("workflowName")) };
        // two workflows can each have a job called "check"
        let name = if workflow.is_empty() || workflow == name { name } else { format!("{workflow} / {name}") };
        // ISO times sort as text; a run not started yet has none, or the zero time
        let at = s("startedAt");
        match out.iter().position(|(n, _)| *n == name) {
            Some(i) if at > started[i] => {
                out[i].1 = c;
                started[i] = at;
            }
            Some(_) => {}
            None => {
                out.push((name, c));
                started.push(at);
            }
        }
    }
    out
}

/// `statusCheckRollup` summed up: the latest run of each check, as passed, skipped, failed or still running.
pub fn summarize_checks(rollup: &Value) -> Checks {
    let mut out = Checks::default();
    for (name, c) in latest_runs(rollup) {
        let s = |k: &str| c.get(k).and_then(Value::as_str).unwrap_or("").jtrim().to_owned();
        let url = [s("detailsUrl"), s("targetUrl")].into_iter().find(|u| u.starts_with("https://") || u.starts_with("http://"));
        let check = Check { name, url };
        match check_state(c) {
            "SUCCESS" => out.passed += 1,
            "SKIPPED" | "NEUTRAL" => out.skipped += 1,
            "ERROR" | "FAILURE" | "CANCELLED" | "TIMED_OUT" | "ACTION_REQUIRED" | "STARTUP_FAILURE" => out.failed.push(check),
            _ => out.running.push(check),
        }
    }
    out
}

/// `gh pr view --json number,title,state,url,isDraft,mergeable,statusCheckRollup`, read.
pub fn parse_pr(json: &str) -> Option<PullRequest> {
    let v: Value = serde_json::from_str(json.jtrim()).ok()?;
    let s = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_owned();
    let number = v.get("number").and_then(Value::as_u64)?;
    Some(PullRequest {
        number,
        title: s("title"),
        state: s("state").to_lowercase(),
        draft: v.get("isDraft").and_then(Value::as_bool).unwrap_or(false),
        url: s("url"),
        conflicts: s("mergeable") == "CONFLICTING",
        checks: summarize_checks(v.get("statusCheckRollup").unwrap_or(&Value::Null)),
    })
}

/// `git log --format=%s%x1f%b%x1e`, newest first, as a pull request to start from: the newest
/// subject as the title, and the bodies, oldest first, as its body. Commits with no bodies give a
/// list of their subjects instead, when there's more than one.
pub fn draft_from_log(log: &str) -> Option<PrDraft> {
    let commits: Vec<(&str, &str)> = log
        .split('\u{1e}')
        .filter_map(|r| {
            let (subject, body) = r.split_once('\u{1f}')?;
            let subject = subject.jtrim();
            (!subject.is_empty()).then(|| (subject, body.jtrim()))
        })
        .collect();
    let (title, _) = *commits.first()?;
    let bodies: Vec<&str> = commits.iter().rev().map(|c| c.1).filter(|b| !b.is_empty()).collect();
    let body = if !bodies.is_empty() {
        bodies.join("\n\n")
    } else if commits.len() > 1 {
        commits.iter().rev().map(|c| format!("- {}", c.0)).collect::<Vec<_>>().join("\n")
    } else {
        String::new()
    };
    Some(PrDraft { title: title.to_owned(), body })
}

/// gh can't reach GitHub until someone signs in on that machine (it exits 4 then).
fn signed_out(code: Option<i32>, stderr: &str) -> bool {
    code == Some(4) || stderr.contains("gh auth login") || stderr.contains("not logged in")
}

/// The repository's remotes aren't on GitHub (or there are none).
fn not_github(stderr: &str) -> bool {
    stderr.contains("none of the git remotes configured for this repository") || stderr.contains("no git remotes found") || stderr.contains("not a GitHub")
}

/// Reads what `status_command` printed.
pub fn parse_status(stdout: &str, stderr: &str) -> PrState {
    let parts: Vec<&str> = stdout.split(SEP).collect();
    let part = |i: usize| parts.get(i).map(|s| s.jtrim()).unwrap_or("");
    let opt = |s: &str| (!s.is_empty()).then(|| s.to_owned());
    let mut out = PrState { gh: "ready", message: None, branch: opt(part(0)), base: opt(part(1)), pr: None, draft: None };
    if part(2) == "missing" {
        out.gh = "missing";
        return out;
    }
    if parts.len() < 6 {
        // the default branch, or no branch at all: nothing to ask GitHub
        return out;
    }
    let code: Option<i32> = part(4).parse().ok();
    if code == Some(0) {
        match parse_pr(part(3)) {
            Some(pr) => out.pr = Some(pr),
            None => {
                out.gh = "error";
                out.message = Some("gh answered with something Inyon couldn't read".into());
            }
        }
        return out;
    }
    if stderr.contains("no pull requests found") {
        out.draft = draft_from_log(parts[5]);
    } else if not_github(stderr) {
        out.gh = "not-github";
    } else if signed_out(code, stderr) {
        out.gh = "signed-out";
    } else {
        out.gh = "error";
        out.message = Some(last_lines(stderr, "gh couldn't read the pull request"));
    }
    out
}

/// The branch's pull request and its checks, or a draft for one, through gh on the session's machine.
pub async fn pr_status(host_id: &str, pane_id: &str) -> HubResult<PrState> {
    let (host, cwd) = folder(host_id, pane_id)?;
    let r = host.exec(&status_command(&cwd), ExecOptions::timeout(30000)).await?;
    if r.code == 3 {
        return Err(http(409, "Not a git repository"));
    }
    Ok(parse_status(&r.stdout, &r.stderr))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PrOpened {
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub number: Option<u64>,
}

pub const TITLE_MAX: usize = 256;
pub const BODY_MAX: usize = 65536;

/// The request's title and body as gh gets them on stdin: one line of title, then the body.
pub fn pr_input(title: Option<&Value>, body: Option<&Value>) -> HubResult<String> {
    let text = |v: Option<&Value>| match v {
        None | Some(Value::Null) => String::new(),
        Some(v) => crate::js::json::value_string(v),
    };
    let title = re!(r"\s+").replace_all(text(title).jtrim(), " ").into_owned();
    let body = text(body).replace("\r\n", "\n");
    if title.is_empty() {
        return Err(http(400, "Write a title"));
    }
    if title.chars().count() > TITLE_MAX || title.contains('\0') {
        return Err(http(400, "That title is too long"));
    }
    if body.chars().count() > BODY_MAX || body.contains('\0') {
        return Err(http(400, "That description is too long"));
    }
    Ok(format!("{title}\n{}", body.jtrim()))
}

pub const GH_MISSING: &str = "The GitHub CLI (gh) isn't installed on this machine. Install it from cli.github.com, then run gh auth login there.";
pub const GH_SIGNED_OUT: &str = "gh isn't signed in to GitHub on this machine. Run gh auth login there, then try again.";

/// Opens a pull request for the branch into the default branch, with gh on the session's machine.
pub async fn pr_create(host_id: &str, pane_id: &str, title: Option<&Value>, body: Option<&Value>) -> HubResult<PrOpened> {
    let input = pr_input(title, body)?;
    let (host, cwd) = folder(host_id, pane_id)?;
    let r = host.exec(&create_command(&cwd), ExecOptions::input(input).with_timeout(60000)).await?;
    match r.code {
        0 => {}
        3 => return Err(http(409, "Not a git repository")),
        6 => return Err(http(409, GH_MISSING)),
        c if signed_out(Some(c), &r.stderr) && !not_github(&r.stderr) => return Err(http(409, GH_SIGNED_OUT)),
        _ => return Err(http(409, last_lines(&r.stderr, "Could not open the pull request"))),
    }
    let url = r.stdout.lines().rev().map(str::trim).find(|l| l.starts_with("https://") || l.starts_with("http://")).unwrap_or("").to_owned();
    let number = re!(r"/pull/(\d+)").captures(&url).and_then(|m| m[1].parse().ok());
    Ok(PrOpened { url, number })
}

#[cfg(test)]
#[path = "pull_request_tests.rs"]
mod tests;
