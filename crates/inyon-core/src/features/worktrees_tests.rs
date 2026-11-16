//! features/worktrees: names, the shell it runs, and a real repo end to end.

use serde_json::json;

use super::*;
use crate::claude::actions::{launch, LaunchOpts};
use crate::test_support::rt::run;
use crate::test_support::sandbox::Sandbox;
use crate::test_support::{machine, sh, TempDir};

#[test]
fn a_slug_is_the_first_words_in_lowercase() {
    assert_eq!(slug("Fix the login test on Safari"), "fix-the-login-test");
    assert_eq!(slug("  README: typo!! "), "readme-typo");
    assert_eq!(slug("Übersetze die Hilfe"), "bersetze-die-hilfe");
    assert_eq!(slug("日本語"), "");
    assert_eq!(slug(""), "");
    // at most 32 characters, cut at a word
    assert_eq!(slug("internationalisation localisation everything"), "internationalisation");
    assert_eq!(slug(&"a".repeat(40)), "a".repeat(32));
}

#[test]
fn the_suggested_branch_comes_from_the_message_or_the_agent_and_time() {
    assert_eq!(default_branch(Some("Fix the login test"), "claude", "1115-1432"), "inyon/fix-the-login-test");
    assert_eq!(default_branch(Some("  "), "claude", "1115-1432"), "inyon/claude-1115-1432");
    assert_eq!(default_branch(None, "shell", "0101-0000"), "inyon/shell-0101-0000");
    assert_eq!(default_branch(None, "", "0101-0000"), "inyon/session-0101-0000");
    for b in [default_branch(Some("Fix it"), "x", "1"), default_branch(None, "codex", "1115-1432")] {
        assert_eq!(check_branch(&b), Ok(()), "{b}");
    }
}

#[test]
fn branch_names_follow_git_check_ref_format() {
    for ok in ["inyon/fix-login", "main", "feature/a.b", "x_y", "v1.2", "a/b/c", "émoji-ok"] {
        assert_eq!(check_branch(ok), Ok(()), "{ok}");
    }
    for bad in [
        "",
        "@",
        "HEAD",
        "-x",
        "/x",
        "x/",
        "a//b",
        "x.",
        "a..b",
        "a@{b",
        "a b",
        "a~b",
        "a^b",
        "a:b",
        "a?b",
        "a*b",
        "a[b",
        "a\\b",
        "a\tb",
        "a\u{7f}b",
        ".x",
        "a/.b",
        "x.lock",
        "a/b.lock/c",
    ] {
        assert!(check_branch(bad).is_err(), "{bad:?} should be refused");
    }
    assert_eq!(check_branch("a b").unwrap_err(), "A branch name can't contain spaces");
    assert_eq!(check_branch(&"a".repeat(201)).unwrap_err(), "That branch name is too long");
}

#[test]
fn agrees_with_git_itself() {
    // ("@" isn't asked: `--branch` reads it as the branch checked out, which `git branch @` refuses)
    let names = ["inyon/fix-login", "a..b", "x.lock", "a b", "-x", "a//b", "a@{b", "ok/.x", "x.", "feat/ü", "a$b;c", "it's"];
    for n in names {
        let (code, _, _) = sh(&format!("git check-ref-format --branch {}", shq(n)), None, &[]);
        assert_eq!(check_branch(n).is_ok(), code == 0, "{n:?}: git says {code}");
    }
}

#[test]
fn the_folder_is_named_after_the_branch() {
    assert_eq!(folder_slug("inyon/fix-login"), "fix-login");
    assert_eq!(folder_slug("feature/a b"), "feature-a-b");
    assert_eq!(folder_slug("a$b;c'd"), "a-b-c-d");
    assert_eq!(folder_slug("inyon/"), "worktree");
    assert_eq!(folder_slug(".hidden."), "hidden");
    assert!(folder_slug(&"x".repeat(80)).len() <= 48);
    assert_eq!(inyon_protocol::worktree::worktree_folder("/home/me/code/api", "inyon/fix"), "../.inyon-worktrees/api-fix");
    assert_eq!(inyon_protocol::worktree::worktree_folder(r"C:\demo\billing-api", "feat/x"), "../.inyon-worktrees/billing-api-feat-x");
}

#[test]
fn the_command_quotes_every_name_it_was_given() {
    let cmd = add_command("\"$HOME\"'/code/my repo'", "~/code/my repo", "feat/it's$(rm -rf ~)");
    assert!(cmd.starts_with("d=\"$HOME\"'/code/my repo';"), "{cmd}");
    // the branch only ever appears quoted
    assert!(cmd.contains(r"-b 'feat/it'\''s$(rm -rf ~)' "), "{cmd}");
    assert!(cmd.contains(r"'refs/heads/feat/it'\''s$(rm -rf ~)'"), "{cmd}");
    assert!(cmd.contains("/.inyon-worktrees\""), "{cmd}");
    assert_eq!(folder_word("~"), "\"$HOME\"''");
    assert_eq!(folder_word("~/a b"), "\"$HOME\"'/a b'");
    assert_eq!(folder_word("/srv/x'y"), r"'/srv/x'\''y'");
}

#[test]
fn what_the_commands_print_is_read_back() {
    assert_eq!(
        parse_add("/c/.inyon-worktrees/r-x\n/c/r\nnew\n\n", "inyon/x"),
        Some(Made { path: "/c/.inyon-worktrees/r-x".into(), repo: "/c/r".into(), branch: "inyon/x".into(), new_branch: true, start: "/c/.inyon-worktrees/r-x".into() })
    );
    assert_eq!(parse_add("/w\n/c/r\nnew\nweb/app/\n", "x").map(|m| m.start), Some("/w/web/app".into()));
    assert_eq!(parse_add("/w\n/c/r\nnew\n../x/\n", "x").map(|m| m.start), Some("/w".into()));
    assert_eq!(parse_add("C:/d/.inyon-worktrees/r-x\r\nC:/d/r\r\nexisting\r\n", "x").map(|m| (m.path, m.new_branch)), Some(("C:/d/.inyon-worktrees/r-x".into(), false)));
    assert_eq!(parse_add("/c/x\n", "x"), None);
    assert_eq!(parse_repo(0, "/c/r\nmain\n"), RepoInfo { root: Some("/c/r".into()), branch: Some("main".into()) });
    assert_eq!(parse_repo(0, "/c/r\n"), RepoInfo { root: Some("/c/r".into()), branch: None });
    assert_eq!(parse_repo(3, ""), RepoInfo { root: None, branch: None });
    assert_eq!(git_error("Preparing\nfatal: 'x' is already used by worktree at '/a'\n", "no"), "'x' is already used by worktree at '/a'");
    assert_eq!(git_error("", "Could not"), "Could not");
}

#[test]
fn clean_and_dirty_worktrees_are_told_apart() {
    let clean = parse_state("branch inyon/x\nchanges 0\nunpushed 0\n");
    assert_eq!(clean, WorktreeState { exists: true, branch: Some("inyon/x".into()), changes: Some(0), unpushed: Some(0), sessions: 0 });
    assert!(clean.clean());
    assert_eq!(clean.keep_reason(), None);
    let dirty = parse_state("branch inyon/x\nchanges 3\nunpushed 0\n");
    assert_eq!(dirty.keep_reason().as_deref(), Some("It has 3 uncommitted changes"));
    assert_eq!(parse_state("branch x\nchanges 1\nunpushed 0").keep_reason().as_deref(), Some("It has 1 uncommitted change"));
    assert_eq!(parse_state("branch x\nchanges 0\nunpushed 2").keep_reason().as_deref(), Some("It has 2 commits that no other branch or remote has"));
    // git failed on a count: not sure, so it stays
    let unsure = parse_state("branch x\nchanges 0\n");
    assert!(!unsure.clean());
    assert_eq!(unsure.keep_reason().as_deref(), Some("Git couldn't say whether it's clean"));
    let gone = parse_state("gone\n");
    assert!(!gone.exists && !gone.clean());
    // detached: no branch, still counted
    assert_eq!(parse_state("branch \nchanges 0\nunpushed 0\n").branch, None);
    let busy = WorktreeState { sessions: 2, ..clean };
    assert_eq!(busy.keep_reason().as_deref(), Some("2 other sessions are still working in it"));
}

#[test]
fn panes_in_a_worktree_are_marked_with_its_branch() {
    run(|| async { marks() });
}

fn marks() {
    assert!(within("/c/.inyon-worktrees/r-x", "/c/.inyon-worktrees/r-x/"));
    assert!(within("/c/.inyon-worktrees/r-x/src", "/c/.inyon-worktrees/r-x"));
    assert!(!within("/c/.inyon-worktrees/r-xy", "/c/.inyon-worktrees/r-x"));
    assert!(within(r"C:\Demo\.inyon-worktrees\r-x", "c:/demo/.inyon-worktrees/r-x"));
    assert!(!within("/a", ""));
    let m = Made { path: "/c/.inyon-worktrees/r-x".into(), repo: "/c/r".into(), branch: "inyon/x".into(), new_branch: true, start: "/c/.inyon-worktrees/r-x".into() };
    remember("box", &m);
    remember("box", &m);
    assert_eq!(list("box").len(), 1);
    assert_eq!(find("box", "/c/.inyon-worktrees/r-x/src").map(|r| r.branch), Some("inyon/x".into()));
    assert_eq!(find("other", "/c/.inyon-worktrees/r-x"), None);
    let mut sessions: Vec<SessionInfo> =
        serde_json::from_value(json!([{ "id": "$1", "name": "w", "attached": 0, "windows": [{ "id": "@1", "index": 0, "name": "", "active": true, "activity": 0, "panes": [
        { "id": "%1", "index": 0, "active": true, "command": "claude", "cwd": "/c/.inyon-worktrees/r-x", "title": "", "width": 80, "height": 24, "dead": false },
        { "id": "%2", "index": 1, "active": false, "command": "zsh", "cwd": "/c/r", "title": "", "width": 80, "height": 24, "dead": false },
    ] }] }]))
        .unwrap();
    mark("box", &mut sessions);
    let panes = &sessions[0].windows[0].panes;
    assert_eq!(panes[0].worktree, Some(PaneWorktree { branch: "inyon/x".into(), path: "/c/.inyon-worktrees/r-x".into() }));
    assert_eq!(panes[1].worktree, None);
    forget("box", "/c/.inyon-worktrees/r-x/");
    mark("box", &mut sessions);
    assert_eq!(sessions[0].windows[0].panes[0].worktree, None);
}

/// git with an identity of its own and no global config.
const GIT_ENV: &str = "export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_AUTHOR_NAME=T GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=T GIT_COMMITTER_EMAIL=t@t; ";

fn git(dir: &str, cmd: &str) -> String {
    let (code, out, err) = sh(&format!("{GIT_ENV}cd '{dir}' && git -c commit.gpgsign=false {cmd}"), None, &[]);
    assert_eq!(code, 0, "git {cmd}: {err}");
    out
}

/// A repo at <tmp>/code/my repo with one commit, the machine "wt" working in it.
fn repo(tmp: &TempDir) -> String {
    let dir = format!("{}/code/my repo", tmp.s());
    std::fs::create_dir_all(&dir).unwrap();
    git(&dir, "init -q -b main");
    std::fs::write(format!("{dir}/a.txt"), "a\n").unwrap();
    git(&dir, "add a.txt");
    git(&dir, "commit -q -m first");
    Sandbox::install_with(&tmp.s(), GIT_ENV);
    machine("wt", "local", json!([{ "id": "%1", "cwd": dir }]));
    dir
}

#[test]
fn a_worktree_is_made_next_to_the_repo_and_removed_only_when_clean() {
    run(|| async {
        let tmp = TempDir::new("worktrees");
        let dir = repo(&tmp);
        let host = registry().host("wt").unwrap();
        let m = for_launch(&host, &dir, Some("inyon/fix-login"), None, "claude").await.unwrap();
        let path = format!("{}/code/.inyon-worktrees/my repo-fix-login", tmp.s());
        assert_eq!((m.path.as_str(), m.repo.as_str(), m.new_branch), (path.as_str(), dir.as_str(), true));
        assert_eq!(git(&path, "symbolic-ref --short HEAD").trim(), "inyon/fix-login");
        // not part of the repo's own tree
        assert_eq!(git(&dir, "status --porcelain"), "");
        // the same branch again is refused by git, in its words; another name gets the next folder
        let again = for_launch(&host, &dir, Some("inyon/fix-login"), None, "claude").await.unwrap_err();
        assert_eq!(again.status, Some(400));
        assert!(again.message.contains("inyon/fix-login"), "{}", again.message);
        let two = for_launch(&host, "~/code/my repo", Some("fix/login"), None, "claude").await.unwrap();
        assert_eq!(two.path, format!("{}/code/.inyon-worktrees/my repo-fix-login-2", tmp.s()));
        // an existing branch not checked out anywhere is checked out, not made
        git(&dir, "branch old-work");
        let old = for_launch(&host, &dir, Some("old-work"), None, "claude").await.unwrap();
        assert!(!old.new_branch);

        // not a repo, or a bad name: refused before anything is made
        let plain = tmp.path("plain");
        std::fs::create_dir_all(&plain).unwrap();
        assert_eq!(for_launch(&host, &plain.to_string_lossy(), Some("x"), None, "claude").await.unwrap_err().message, "That folder isn't in a git repository");
        assert_eq!(for_launch(&host, &dir, Some("a b"), None, "claude").await.unwrap_err().message, "A branch name can't contain spaces");
        assert_eq!(repo_of("wt", &plain.to_string_lossy()).await.unwrap().root, None);
        assert_eq!(repo_of("wt", "~/code/my repo").await.unwrap(), RepoInfo { root: Some(dir.clone()), branch: Some("main".into()) });

        remember("wt", &m);
        let s = state("wt", &m.path, None).await.unwrap();
        assert!(s.clean(), "{s:?}");
        // a change keeps it
        std::fs::write(format!("{path}/new.txt"), "x\n").unwrap();
        assert_eq!(state("wt", &m.path, None).await.unwrap().changes, Some(1));
        let kept = remove("wt", &m.path, None).await.unwrap_err();
        assert_eq!((kept.status, kept.message.as_str()), (Some(409), "It has 1 uncommitted change, so it stays"));
        // committed but on no other branch: kept too
        git(&path, "add new.txt");
        git(&path, "commit -q -m second");
        assert_eq!(remove("wt", &m.path, None).await.unwrap_err().message, "It has 1 commit that no other branch or remote has, so it stays");
        // merged into main: removed, and the branch with it
        git(&dir, "merge -q --ff-only inyon/fix-login");
        assert_eq!(remove("wt", &m.path, None).await.unwrap(), Removed { branch_deleted: true });
        assert!(!std::path::Path::new(&path).exists());
        assert_eq!(git(&dir, "branch --list inyon/fix-login"), "");
        assert_eq!(list("wt").len(), 0);
        // only worktrees Inyon made can be removed this way
        assert_eq!(remove("wt", &dir, None).await.unwrap_err().status, Some(404));
    });
}

#[test]
fn a_session_in_the_worktree_keeps_it() {
    run(|| async {
        let tmp = TempDir::new("worktrees-busy");
        let dir = repo(&tmp);
        let host = registry().host("wt").unwrap();
        let m = for_launch(&host, &dir, Some("inyon/busy"), None, "claude").await.unwrap();
        remember("wt", &m);
        machine("wt", "local", json!([{ "id": "%1", "cwd": dir }, { "id": "%2", "cwd": format!("{}/src", m.path) }, { "id": "%3", "cwd": m.path }]));
        assert_eq!(state("wt", &m.path, Some("%3")).await.unwrap().sessions, 1);
        assert_eq!(remove("wt", &m.path, Some("%3")).await.unwrap_err().message, "1 other session is still working in it, so it stays");
    });
}

#[test]
fn launch_starts_the_session_in_the_worktree() {
    run(|| async {
        let tmp = TempDir::new("worktrees-launch");
        let dir = repo(&tmp);
        // tmux is a stand-in that prints a pane id and where it was asked to open
        let bin = tmp.path("bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(
            bin.join("tmux"),
            "#!/bin/sh\ncase \" $* \" in *\" has-session \"*) exit 1 ;; esac\nfor a; do [ \"$p\" = -c ] && echo \"$a\" > \"$HOME/opened\"; p=$a; done\necho %9\n",
        )
        .unwrap();
        sh(&format!("chmod +x '{}/tmux'", bin.display()), None, &[]);
        Sandbox::install_with(&tmp.s(), &format!("{GIT_ENV}PATH='{}':$PATH; ", bin.display()));
        let opts = LaunchOpts { cwd: Some(dir.clone()), agent: Some("shell".into()), worktree: true, branch: Some("inyon/from-launch".into()), ..Default::default() };
        assert_eq!(launch("wt", &opts).await.unwrap(), "%9");
        let path = format!("{}/code/.inyon-worktrees/my repo-from-launch", tmp.s());
        assert_eq!(tmp.read("opened").trim(), path);
        assert_eq!(list("wt").first().map(|r| (r.path.clone(), r.branch.clone(), r.repo.clone())), Some((path, "inyon/from-launch".into(), dir.clone())));
        // from a subfolder of the repo it starts in the same subfolder of the worktree
        std::fs::create_dir_all(format!("{dir}/web")).unwrap();
        std::fs::write(format!("{dir}/web/i.txt"), "i\n").unwrap();
        git(&dir, "add web");
        git(&dir, "commit -q -m web");
        let opts = LaunchOpts { cwd: Some(format!("{dir}/web")), agent: Some("shell".into()), worktree: true, branch: Some("inyon/sub".into()), ..Default::default() };
        launch("wt", &opts).await.unwrap();
        assert_eq!(tmp.read("opened").trim(), format!("{}/code/.inyon-worktrees/my repo-sub/web", tmp.s()));
        assert_eq!(list("wt")[0].path, format!("{}/code/.inyon-worktrees/my repo-sub", tmp.s()));
        // with no branch given it takes the suggested one
        let opts = LaunchOpts { cwd: Some(dir.clone()), agent: Some("shell".into()), worktree: true, ..Default::default() };
        launch("wt", &opts).await.unwrap();
        assert!(list("wt")[0].branch.starts_with("inyon/shell-"), "{:?}", list("wt")[0]);
    });
}

#[test]
fn a_session_that_fails_to_start_takes_its_worktree_back() {
    run(|| async {
        let tmp = TempDir::new("worktrees-undo");
        let dir = repo(&tmp);
        let bin = tmp.path("bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(bin.join("tmux"), "#!/bin/sh\necho 'no server' >&2\nexit 1\n").unwrap();
        sh(&format!("chmod +x '{}/tmux'", bin.display()), None, &[]);
        Sandbox::install_with(&tmp.s(), &format!("{GIT_ENV}PATH='{}':$PATH; ", bin.display()));
        let opts = LaunchOpts { cwd: Some(dir.clone()), agent: Some("shell".into()), worktree: true, branch: Some("inyon/undo".into()), ..Default::default() };
        assert_eq!(launch("wt", &opts).await.unwrap_err().message, "no server");
        assert!(!tmp.exists("code/.inyon-worktrees/my repo-undo"));
        assert_eq!(git(&dir, "branch --list inyon/undo"), "");
        assert!(list("wt").is_empty());
    });
}
