//! Pull requests through gh: the commands, what gh prints, and runs on a real repository with a
//! stand-in `gh` that records what it was given.

use serde_json::json;

use super::*;
use crate::test_support::rt::run;
use crate::test_support::sandbox::Sandbox;
use crate::test_support::{machine, sh, TempDir};

/// `gh pr view --json number,title,state,url,isDraft,mergeable,statusCheckRollup` as gh 2.46
/// prints it (trimmed from a real pull request): two workflows with a job called "check", a
/// status context, a skipped job, a failure, a run in progress and one queued.
const VIEW: &str = r#"{"isDraft":false,"mergeable":"MERGEABLE","number":247,"state":"OPEN","statusCheckRollup":[
{"__typename":"CheckRun","completedAt":"2026-11-15T12:00:12Z","conclusion":"SUCCESS","detailsUrl":"https://github.com/o/r/actions/runs/1/job/11","name":"check","startedAt":"2026-11-15T11:56:46Z","status":"COMPLETED","workflowName":"CI"},
{"__typename":"CheckRun","completedAt":"2026-11-16T08:25:30Z","conclusion":"FAILURE","detailsUrl":"https://github.com/o/r/actions/runs/2/job/22","name":"apk","startedAt":"2026-11-16T08:22:30Z","status":"COMPLETED","workflowName":"Android"},
{"__typename":"CheckRun","completedAt":"0001-01-01T00:00:00Z","conclusion":"","detailsUrl":"https://github.com/o/r/actions/runs/3/job/33","name":"check","startedAt":"2026-11-16T08:22:31Z","status":"IN_PROGRESS","workflowName":"inyon cli"},
{"__typename":"CheckRun","completedAt":"0001-01-01T00:00:00Z","conclusion":"","detailsUrl":"","name":"docs","startedAt":"0001-01-01T00:00:00Z","status":"QUEUED","workflowName":"docs"},
{"__typename":"CheckRun","completedAt":"2026-11-15T11:57:55Z","conclusion":"SKIPPED","detailsUrl":"https://github.com/o/r/actions/runs/4/job/44","name":"release","startedAt":"2026-11-15T11:56:30Z","status":"COMPLETED","workflowName":"Release"},
{"__typename":"StatusContext","context":"CodeRabbit","startedAt":"2026-11-15T11:56:33Z","state":"SUCCESS","targetUrl":""},
{"__typename":"StatusContext","context":"ci/legacy","startedAt":"2026-11-15T11:56:33Z","state":"ERROR","targetUrl":"https://ci.example/7"}
],"title":"Open a \"pull request\" from the phone","url":"https://github.com/o/r/pull/247"}"#;

#[test]
fn checks_are_summed_up_as_gh_pr_checks_reads_them() {
    let pr = parse_pr(VIEW).unwrap();
    assert_eq!(
        serde_json::to_value(&pr).unwrap(),
        json!({
            "number": 247, "title": "Open a \"pull request\" from the phone", "state": "open", "draft": false,
            "url": "https://github.com/o/r/pull/247", "conflicts": false,
            "checks": {
                "passed": 2, "skipped": 1,
                "failed": [{ "name": "Android / apk", "url": "https://github.com/o/r/actions/runs/2/job/22" }, { "name": "ci/legacy", "url": "https://ci.example/7" }],
                "running": [{ "name": "inyon cli / check", "url": "https://github.com/o/r/actions/runs/3/job/33" }, { "name": "docs" }],
            },
        })
    );
}

#[test]
fn a_merged_draft_or_conflicting_pull_request_and_one_with_no_checks() {
    let pr =
        parse_pr(r#"{"isDraft":true,"mergeable":"CONFLICTING","number":3,"state":"MERGED","statusCheckRollup":[],"title":"t","url":"https://github.com/o/r/pull/3"}"#).unwrap();
    assert_eq!((pr.state.as_str(), pr.draft, pr.conflicts, pr.checks), ("merged", true, true, Checks::default()));
    // an older gh leaves fields out; a check run with no __typename is still a check run
    let pr = parse_pr(r#"{"number":4,"state":"OPEN","statusCheckRollup":[{"name":"x","status":"COMPLETED","conclusion":"TIMED_OUT"}]}"#).unwrap();
    assert_eq!(pr.checks.failed, [Check { name: "x".into(), url: None }]);
    assert!(parse_pr("not json").is_none());
    assert!(parse_pr("{}").is_none());
}

#[test]
fn a_draft_takes_the_last_subject_and_the_bodies_oldest_first() {
    let log = "Second \"quoted\" change\u{1f}Why the second.\n\u{1e}\nFirst change\u{1f}\u{1e}\nSetup\u{1f}Body one\nline two\n\u{1e}\n";
    assert_eq!(draft_from_log(log), Some(PrDraft { title: "Second \"quoted\" change".into(), body: "Body one\nline two\n\nWhy the second.".into() }));
    // no bodies: a list of the subjects
    assert_eq!(draft_from_log("B\u{1f}\u{1e}\nA\u{1f}\u{1e}\n").unwrap().body, "- A\n- B");
    assert_eq!(draft_from_log("Only\u{1f}\u{1e}\n").unwrap().body, "");
    assert_eq!(draft_from_log(""), None);
}

fn out(parts: &[&str]) -> String {
    parts.join(SEP)
}

#[test]
fn what_gh_said_becomes_a_state_the_app_can_show() {
    let missing = parse_status(&out(&["feat", "main", "missing"]), "");
    assert_eq!(serde_json::to_value(&missing).unwrap(), json!({ "gh": "missing", "branch": "feat", "base": "main" }));
    // on the default branch nothing is asked
    assert_eq!(serde_json::to_value(parse_status(&out(&["main", "main", "ready"]), "")).unwrap(), json!({ "gh": "ready", "branch": "main", "base": "main" }));

    let with_pr = parse_status(&out(&["feat", "main", "ready", VIEW, "0", "x\u{1f}\u{1e}"]), "");
    assert_eq!((with_pr.gh, with_pr.pr.as_ref().map(|p| p.number), with_pr.draft), ("ready", Some(247), None));

    let none = parse_status(&out(&["feat", "main", "ready", "", "1", "Fix it\u{1f}Because.\u{1e}\n"]), "no pull requests found for branch \"feat\"\n");
    assert_eq!(serde_json::to_value(&none).unwrap(), json!({ "gh": "ready", "branch": "feat", "base": "main", "draft": { "title": "Fix it", "body": "Because." } }));

    let auth = "To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.\n";
    assert_eq!(parse_status(&out(&["feat", "", "ready", "", "4", ""]), auth).gh, "signed-out");
    // a token that has expired or been revoked: gh exits 1 (seen on Windows, gh 2.x)
    let expired = "HTTP 401: Requires authentication (https://api.github.com/graphql)\nTry authenticating with:  gh auth login -h github.com\n";
    assert_eq!(parse_status(&out(&["auto-resume", "", "ready", "", "1", "Update a golden\u{1f}\u{1e}\r\n"]), expired).gh, "signed-out");
    let gitlab = "none of the git remotes configured for this repository point to a known GitHub host. To tell gh about a new GitHub host, please use `gh auth login`\n";
    assert_eq!(parse_status(&out(&["feat", "main", "ready", "", "1", ""]), gitlab).gh, "not-github");
    let other = parse_status(&out(&["feat", "main", "ready", "", "1", ""]), "HTTP 502: Bad Gateway\n");
    assert_eq!((other.gh, other.message.as_deref()), ("error", Some("HTTP 502: Bad Gateway")));
}

#[test]
fn the_commands_carry_no_title_or_body_and_quote_the_folder() {
    let s = status_command("/w/it's here");
    assert!(s.contains(r"'/w/it'\''s here'"), "{s}");
    assert!(s.contains(&format!("pr view --json {FIELDS}")), "{s}");
    assert!(s.contains("GH_PROMPT_DISABLED=1"), "{s}");
    let c = create_command("/w/a");
    assert!(c.contains("IFS= read -r title;"), "{c}");
    assert!(c.contains(r#"pr create --title "$title" --body-file - ${base:+--base "$base"}"#), "{c}");
    assert!(c.contains("|| exit 6"), "{c}");
}

#[test]
fn the_title_is_one_line_and_both_have_limits() {
    assert_eq!(pr_input(Some(&json!("  Fix\nthe   \"thing\"  ")), Some(&json!("Line one\r\nLine two\n"))).unwrap(), "Fix the \"thing\"\nLine one\nLine two");
    assert_eq!(pr_input(Some(&json!("t")), None).unwrap(), "t\n");
    assert_eq!(pr_input(Some(&json!(" \n ")), None).unwrap_err().message, "Write a title");
    assert_eq!(pr_input(None, None).unwrap_err().message, "Write a title");
    assert_eq!(pr_input(Some(&json!("x".repeat(TITLE_MAX + 1))), None).unwrap_err().message, "That title is too long");
    assert_eq!(pr_input(Some(&json!("t")), Some(&json!("y".repeat(BODY_MAX + 1)))).unwrap_err().message, "That description is too long");
}

// ---------- on a real repository, with a stand-in gh ----------

const GIT_ENV: &str = "export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_AUTHOR_NAME=T GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=T GIT_COMMITTER_EMAIL=t@t; ";

/// A `gh` that answers from files next to it: `view.json` for `pr view` (none: no pull
/// request), `signed-out` to answer as gh does before `gh auth login`; `pr create` keeps its
/// arguments, one per line, and what it read on stdin.
const FAKE_GH: &str = r#"#!/bin/sh
d=$(dirname "$0")
[ -f "$d/signed-out" ] && { echo 'To get started with GitHub CLI, please run:  gh auth login' >&2; exit 4; }
case "$1 $2" in
"pr view") [ -f "$d/view.json" ] && { cat "$d/view.json"; exit 0; }; echo 'no pull requests found for branch "x"' >&2; exit 1 ;;
"repo view") echo main ;;
"pr create") for a in "$@"; do printf '%s\n' "$a"; done > "$d/args"; cat > "$d/body"; echo 'Creating pull request' >&2; echo 'https://github.com/o/r/pull/7' ;;
*) exit 2 ;;
esac
"#;

fn git(dir: &str, cmd: &str) -> (i32, String, String) {
    sh(&format!("{GIT_ENV}cd '{dir}' && git -c commit.gpgsign=false {cmd}"), None, &[])
}

/// A repository in `w/repo` with an origin (`w/origin.git`) that knows its default branch, a
/// branch with an awkward name and two commits on it, pushed; `w/bin/gh` is the stand-in.
fn setup(w: &TempDir, with_gh: bool) -> String {
    let repo = w.path("repo").to_string_lossy().into_owned();
    std::fs::create_dir_all(&repo).unwrap();
    let origin = w.path("origin.git").to_string_lossy().into_owned();
    sh(&format!("git init -q --bare -b main '{origin}'"), None, &[]);
    git(&repo, "init -q -b main");
    w.write("repo/a.txt", "one\n");
    git(
        &repo,
        &format!("add -A && git -c commit.gpgsign=false commit -q -m first && git remote add origin '{origin}' && git push -q -u origin main && git remote set-head origin main"),
    );
    git(&repo, r#"checkout -q -b 'fix/it'"'"'s-"q"-$(id)'"#);
    w.write("repo/a.txt", "two\n");
    git(&repo, r#"commit -q -am 'Make it two' -m 'Because one was not enough.'"#);
    w.write("repo/a.txt", "three\n");
    git(
        &repo,
        r#"commit -q -am 'Fix "it'"'"'s" $(id) `id`' -m 'Line one
Line two'"#,
    );
    git(&repo, "push -q -u origin HEAD");
    let mut prefix = GIT_ENV.to_owned();
    if with_gh {
        w.write("bin/gh", FAKE_GH);
        sh(&format!("chmod +x '{}'", w.path("bin/gh").display()), None, &[]);
        prefix += &format!("export PATH='{}':\"$PATH\"; ", w.path("bin").display());
    } else {
        // a PATH with git and sh but no gh, whatever this computer has installed
        let tools = w.path("tools").to_string_lossy().into_owned();
        std::fs::create_dir_all(&tools).unwrap();
        for t in ["git", "sh", "cat", "head", "printf", "dirname"] {
            sh(&format!("p=$(command -v {t}) && ln -s \"$p\" '{tools}/{t}'"), None, &[]);
        }
        prefix += &format!("export PATH='{tools}'; ");
    }
    Sandbox::install_with(&w.s(), &prefix);
    machine("ws", "local", json!([{ "id": "%1", "cwd": repo }]));
    repo
}

#[test]
fn without_gh_the_app_is_told_how_to_get_it() {
    let w = TempDir::new("inyon-pr-");
    run(|| async move {
        setup(&w, false);
        let s = pr_status("ws", "%1").await.unwrap();
        assert_eq!((s.gh, s.branch.as_deref(), s.base.as_deref()), ("missing", Some(r#"fix/it's-"q"-$(id)"#), Some("main")));
        let e = pr_create("ws", "%1", Some(&json!("t")), None).await.unwrap_err();
        assert_eq!((e.status, e.message.as_str()), (Some(409), GH_MISSING));
    });
}

#[test]
fn a_branch_with_no_pull_request_gets_a_draft_and_opens_one_with_its_text_intact() {
    let w = TempDir::new("inyon-pr-");
    run(|| async move {
        setup(&w, true);
        let s = pr_status("ws", "%1").await.unwrap();
        assert_eq!(
            serde_json::to_value(&s).unwrap(),
            json!({
                "gh": "ready", "branch": "fix/it's-\"q\"-$(id)", "base": "main",
                "draft": { "title": "Fix \"it's\" $(id) `id`", "body": "Because one was not enough.\n\nLine one\nLine two" },
            })
        );
        let title = "Fix \"it's\" $(touch pwned) `touch pwned2`";
        let body = "First line\n\n- $(touch pwned3)\n'quoted' \"too\"\n";
        let opened = pr_create("ws", "%1", Some(&json!(title)), Some(&json!(body))).await.unwrap();
        assert_eq!(opened, PrOpened { url: "https://github.com/o/r/pull/7".into(), number: Some(7) });
        assert_eq!(w.read("bin/args"), format!("pr\ncreate\n--title\n{title}\n--body-file\n-\n--base\nmain\n"));
        assert_eq!(w.read("bin/body"), "First line\n\n- $(touch pwned3)\n'quoted' \"too\"");
        for f in ["repo/pwned", "repo/pwned2", "repo/pwned3", "pwned"] {
            assert!(!w.exists(f), "{f}");
        }
    });
}

#[test]
fn a_branch_with_a_pull_request_shows_it_and_a_signed_out_gh_says_so() {
    let w = TempDir::new("inyon-pr-");
    run(|| async move {
        setup(&w, true);
        w.write("bin/view.json", VIEW);
        let s = pr_status("ws", "%1").await.unwrap();
        let pr = s.pr.unwrap();
        assert_eq!((pr.number, pr.checks.failed.len(), pr.checks.running.len(), s.draft), (247, 2, 2, None));

        w.write("bin/signed-out", "");
        assert_eq!(pr_status("ws", "%1").await.unwrap().gh, "signed-out");
        let e = pr_create("ws", "%1", Some(&json!("t")), None).await.unwrap_err();
        assert_eq!(e.message, GH_SIGNED_OUT);
    });
}

#[test]
fn on_the_default_branch_gh_is_not_asked() {
    let w = TempDir::new("inyon-pr-");
    run(|| async move {
        let repo = setup(&w, true);
        git(&repo, "checkout -q main");
        w.write("bin/signed-out", "");
        let s = pr_status("ws", "%1").await.unwrap();
        assert_eq!((s.gh, s.branch.as_deref(), s.base.as_deref(), s.pr, s.draft), ("ready", Some("main"), Some("main"), None, None));
    });
}
