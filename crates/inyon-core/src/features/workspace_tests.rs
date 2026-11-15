//! features/workspace.test.ts

use serde_json::json;

use super::*;
use crate::test_support::rt::run;
use crate::test_support::sandbox::Sandbox;
use crate::test_support::{machine, sh, TempDir};

/// git with an identity of its own and no global config, as the TS test's helper runs it.
const GIT_ENV: &str = "export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_AUTHOR_NAME=T GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=T GIT_COMMITTER_EMAIL=t@t; ";

fn git(dir: &TempDir, cmd: &str) -> (i32, String, String) {
    sh(&format!("{GIT_ENV}cd '{}' && git -c user.name=T -c user.email=t@t -c commit.gpgsign=false {cmd}", dir.s()), None, &[])
}

/// The machine "ws" with one pane, %1, working in `dir`; its commands run in a sandbox there.
fn setup(dir: &TempDir) {
    Sandbox::install_with(&dir.s(), GIT_ENV);
    machine("ws", "local", json!([{ "id": "%1", "cwd": dir.s() }]));
}

#[test]
fn paths_stay_inside_the_session_folder() {
    assert_eq!(inside("src/a.ts").unwrap(), "src/a.ts");
    assert_eq!(inside("./src/").unwrap(), "src");
    assert_eq!(inside("").unwrap(), "");
    for bad in ["../x", "a/../../b", "a\nb"] {
        assert_eq!(inside(bad).unwrap_err().message, "Bad path", "{bad}");
    }
    // a leading slash means the session folder, not the machine's root
    assert_eq!(inside("/etc/passwd").unwrap(), "etc/passwd");
}

#[test]
fn git_status_renames_and_counts_are_read_from_porcelain_v2_output() {
    let status = [
        "# branch.oid 1234567890abcdef1234567890abcdef12345678",
        "# branch.head main",
        "# branch.upstream origin/main",
        "# branch.ab +2 -1",
        "1 .M N... 100644 100644 100644 aaaa bbbb src/a file.ts",
        "1 MM N... 100644 100644 100644 aaaa bbbb both.ts",
        "2 R. N... 100644 100644 100644 aaaa aaaa R100 new.ts",
        "old.ts",
        "1 D. N... 100644 000000 000000 aaaa 0000 gone.txt",
        "1 A. N... 000000 100644 100644 0000 aaaa -dash.md",
        "u UU N... 100644 100644 100644 100644 aaaa bbbb cccc clash.rs",
        "? notes 'quoted'.md",
        "! ignored.log",
        "",
    ]
    .join("\0");
    let numstat = "3\t1\tsrc/a file.ts\0".to_owned() + "0\t0\t\0old.ts\0new.ts\0" + "0\t4\tgone.txt\0" + "2\t0\t-dash.md\0";
    assert_eq!(
        serde_json::to_value(parse_status(&status, &numstat)).unwrap(),
        json!({
            "branch": "main", "upstream": "origin/main", "ahead": 2, "behind": 1,
            "files": [
                { "path": "src/a file.ts", "status": "M", "add": 3, "del": 1, "staged": false, "unstaged": true },
                { "path": "both.ts", "status": "M", "add": 0, "del": 0, "staged": true, "unstaged": true },
                { "path": "new.ts", "from": "old.ts", "status": "R", "add": 0, "del": 0, "staged": true, "unstaged": false },
                { "path": "gone.txt", "status": "D", "add": 0, "del": 4, "staged": true, "unstaged": false },
                { "path": "-dash.md", "status": "A", "add": 2, "del": 0, "staged": true, "unstaged": false },
                { "path": "clash.rs", "status": "M", "add": 0, "del": 0, "staged": false, "unstaged": true },
                { "path": "notes 'quoted'.md", "status": "?", "add": 0, "del": 0, "staged": false, "unstaged": true },
            ],
        })
    );
    // before the first commit, and on a detached HEAD with no upstream
    let fresh = parse_status("# branch.oid (initial)\0# branch.head main\0? a.txt\0", "");
    assert_eq!((fresh.branch.as_deref(), fresh.upstream, fresh.ahead, fresh.files.len()), (Some("main"), None, Some(0), 1));
    assert_eq!(parse_status("# branch.oid abc\0# branch.head (detached)\0", "").branch.as_deref(), Some("detached"));
}

#[test]
fn git_status_still_reads_porcelain_v1_from_an_older_git() {
    let status = "## main...origin/main [ahead 2, behind 1]\0 M src/a.ts\0R  new.ts\0old.ts\0?? notes.md\0D  gone.txt\0";
    let numstat = "3\t1\tsrc/a.ts\0".to_owned() + "0\t0\t\0old.ts\0new.ts\0" + "0\t4\tgone.txt\0";
    assert_eq!(
        serde_json::to_value(parse_status(status, &numstat)).unwrap(),
        json!({
            "branch": "main", "upstream": "origin/main", "ahead": 2, "behind": 1,
            "files": [
                { "path": "src/a.ts", "status": "M", "add": 3, "del": 1, "staged": false, "unstaged": true },
                { "path": "new.ts", "from": "old.ts", "status": "R", "add": 0, "del": 0, "staged": true, "unstaged": false },
                { "path": "notes.md", "status": "?", "add": 0, "del": 0, "staged": false, "unstaged": true },
                { "path": "gone.txt", "status": "D", "add": 0, "del": 4, "staged": true, "unstaged": false },
            ],
        })
    );
    assert_eq!(parse_status("## No commits yet on main\0", "").branch.as_deref(), Some("main"));
}

#[test]
fn git_commands_quote_every_path_after_a_double_dash() {
    let paths: Vec<String> = ["a b.ts", "it's.md", "-rf", "*.md"].iter().map(|s| s.to_string()).collect();
    let q = r#" -- 'a b.ts' 'it'\''s.md' '-rf' '*.md'"#;
    let add = stage_command("/w/my repo", Stage::Add, &paths);
    assert!(add.starts_with("top=$(") && add.contains("-C '/w/my repo' rev-parse --show-toplevel"), "{add}");
    assert!(add.ends_with(&format!("GIT_LITERAL_PATHSPECS=1 git -c core.quotepath=off -c color.ui=false add -A{q}")), "{add}");
    assert!(stage_command("/w", Stage::Remove, &paths).ends_with(&format!("reset -q{q}")));
    // every change: no paths at all
    assert!(stage_command("/w", Stage::Add, &[]).ends_with("add -A"));
    assert!(stage_command("/w", Stage::Remove, &[]).ends_with("reset -q"));
    let discard = discard_command("/w", &paths[2..3]);
    assert!(discard.contains("status --porcelain=v1 -z --untracked-files=all -- '-rf'"), "{discard}");
    assert!(discard.contains("cat-file -e HEAD:'-rf'"), "{discard}");
    assert!(discard.contains("restore --source=HEAD --staged --worktree -- '-rf'"), "{discard}");
    assert!(discard.contains("rm -q -f -- '-rf'") && discard.contains("clean -q -f -- '-rf'"), "{discard}");

    assert!(commit_command("/w", CommitWhat::All).contains("add -A && "));
    assert!(commit_command("/w", CommitWhat::Staged).contains("diff --cached --quiet; then echo 'Nothing is staged' >&2; exit 5"));
    assert!(commit_command("/w", CommitWhat::Auto).contains("diff --cached --quiet; then GIT_TERMINAL_PROMPT=0 GIT_OPTIONAL_LOCKS=0 git -c core.quotepath=off -c color.ui=false add -A"));
    assert_eq!(CommitWhat::from_field(Some(&json!(true))), CommitWhat::Staged);
    assert_eq!(CommitWhat::from_field(Some(&json!(false))), CommitWhat::All);
    assert_eq!(CommitWhat::from_field(None), CommitWhat::Auto);
}

#[test]
fn request_paths_stay_inside_and_are_named_once() {
    assert_eq!(paths_of(Some(&json!(["a.ts", "./a.ts", "b c/d.md"]))).unwrap(), ["a.ts", "b c/d.md"]);
    assert!(paths_of(None).unwrap().is_empty());
    assert_eq!(paths_of(Some(&json!(["../x"]))).unwrap_err().message, "Bad path");
    assert_eq!(paths_of(Some(&json!([""]))).unwrap_err().message, "Bad path");
    assert_eq!(paths_of(Some(&json!("a.ts"))).unwrap_err().message, "paths is a list of files");
    assert_eq!(paths_of(Some(&json!([1]))).unwrap_err().message, "paths is a list of files");
    let many: Vec<String> = (0..1001).map(|i| format!("f{i}")).collect();
    assert_eq!(paths_of(Some(&json!(many))).unwrap_err().message, "At most 1000 files at a time");
}

fn gf(path: &str, status: &'static str, staged: bool) -> GitFile {
    GitFile { path: path.into(), from: None, status, add: 1, del: 0, staged, unstaged: !staged }
}

#[test]
fn a_draft_message_sums_up_what_would_be_committed() {
    assert_eq!(draft_message(&[]), "");
    assert_eq!(draft_message(&[gf("apps/web/src/a.ts", "M", false)]), "Update apps/web/src/a.ts");
    assert_eq!(draft_message(&[gf("notes.md", "?", false)]), "Add notes.md");
    assert_eq!(draft_message(&[gf("old.txt", "D", false)]), "Remove old.txt");
    let long = "apps/web/src/components/session/some/deeply/nested/Workspace.tsx";
    assert_eq!(draft_message(&[gf(long, "M", false)]), "Update Workspace.tsx");
    let mut r = gf("src/new.ts", "R", true);
    r.from = Some("src/old.ts".into());
    assert_eq!(draft_message(&[r.clone()]), "Rename old.ts to src/new.ts");

    let three = [gf("apps/web/src/a.ts", "M", false), gf("apps/web/b.ts", "A", false), gf("apps/web/src/c.ts", "D", false)];
    assert_eq!(draft_message(&three), "Update 3 files in apps/web\n\n- apps/web/src/a.ts\n- apps/web/b.ts (new)\n- apps/web/src/c.ts (deleted)");
    // anything staged: only that
    let mixed = [gf("apps/web/a.ts", "M", true), gf("crates/x.rs", "M", false), gf("apps/web/b.ts", "?", false), gf("apps/app/c.rs", "M", true)];
    assert_eq!(draft_message(&mixed), "Update 2 files in apps\n\n- apps/web/a.ts\n- apps/app/c.rs");
    assert_eq!(draft_message(&[gf("a.md", "?", false), gf("b.md", "A", false)]), "Add 2 files\n\n- a.md\n- b.md");
    assert_eq!(draft_message(&[gf("x/a.rs", "M", true), r]), "Update 2 files\n\n- x/a.rs\n- src/new.ts (was src/old.ts)");
    let many: Vec<GitFile> = (0..23).map(|i| gf(&format!("src/f{i}.ts"), "M", false)).collect();
    let d = draft_message(&many);
    assert!(d.starts_with("Update 23 files in src\n\n- src/f0.ts\n"), "{d}");
    assert!(d.ends_with("- src/f19.ts\n- and 3 more"), "{d}");
}

#[test]
fn unified_diff_hunks_keep_their_line_numbers() {
    let h = parse_hunks("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,3 @@ fn\n a\n-b\n+c\n+d\n@@ -10 +11 @@\n-x\n+y\n\\ No newline at end of file\n");
    assert_eq!(
        serde_json::to_value(h).unwrap(),
        json!([
            { "oldStart": 1, "oldLines": 2, "newStart": 1, "newLines": 3, "lines": [" a", "-b", "+c", "+d"] },
            { "oldStart": 10, "oldLines": 1, "newStart": 11, "newLines": 1, "lines": ["-x", "+y", "\\ No newline at end of file"] },
        ])
    );
}

#[test]
fn a_folder_that_is_not_a_repository_says_so() {
    let dir = TempDir::new("inyon-ws-");
    run(|| async move {
        setup(&dir);
        assert_eq!(serde_json::to_value(git_status("ws", "%1").await.unwrap()).unwrap(), json!({ "repo": false, "files": [] }));
    });
}

#[test]
fn files_the_working_tree_and_a_commit_on_a_real_repository() {
    let dir = TempDir::new("inyon-ws-");
    run(|| async move {
        setup(&dir);
        git(&dir, "init -q -b main");
        dir.write("a.txt", "one\ntwo\n");
        dir.write("src/b.ts", "export {}\n");
        std::fs::write(dir.path("pic.png"), [137u8, 80, 78, 71]).unwrap();
        std::fs::write(dir.path("blob.bin"), [1u8, 0, 2, 0]).unwrap();
        git(&dir, "add -A && git -c user.name=T -c user.email=t@t -c commit.gpgsign=false commit -q -m first");

        let root = list_dir("ws", "%1", "").await.unwrap();
        let names: Vec<String> = root.entries.iter().map(|e| format!("{} {}", if e.dir { "d" } else { "f" }, e.name)).collect();
        assert_eq!(names, ["d src", "f a.txt", "f blob.bin", "f pic.png"]);
        let src = list_dir("ws", "%1", "src").await.unwrap();
        assert_eq!((src.entries[0].name.as_str(), src.entries[0].dir, src.entries[0].size), ("b.ts", false, 10));
        assert_eq!(list_dir("ws", "%1", "nope").await.unwrap_err().message, "No such folder");

        assert_eq!(
            serde_json::to_value(read_file("ws", "%1", "a.txt").await.unwrap()).unwrap(),
            json!({ "kind": "text", "path": "a.txt", "text": "one\ntwo\n", "size": 8, "truncated": false })
        );
        let pic = serde_json::to_value(read_file("ws", "%1", "pic.png").await.unwrap()).unwrap();
        assert_eq!((pic["kind"].as_str(), pic["type"].as_str(), pic["data"].as_str()), (Some("image"), Some("image/png"), Some("iVBORw==")));
        let blob = serde_json::to_value(read_file("ws", "%1", "blob.bin").await.unwrap()).unwrap();
        assert_eq!((blob["kind"].as_str(), blob["size"].as_u64()), (Some("binary"), Some(4)));

        dir.write("a.txt", "one\n2\nthree\n");
        dir.write("new file.md", "# hi\n");
        let s = git_status("ws", "%1").await.unwrap();
        assert_eq!((s.repo, s.status.branch.as_deref(), s.remote), (true, Some("main"), Some(false)));
        assert_eq!(
            serde_json::to_value(&s.status.files).unwrap(),
            json!([
                { "path": "a.txt", "status": "M", "add": 2, "del": 1, "staged": false, "unstaged": true },
                { "path": "new file.md", "status": "?", "add": 0, "del": 0, "staged": false, "unstaged": true },
            ])
        );
        assert_eq!(git_diff("ws", "%1", "a.txt").await.unwrap().hunks[0].lines, [" one", "-two", "+2", "+three"]);
        let added = &git_diff("ws", "%1", "new file.md").await.unwrap().hunks[0];
        assert_eq!((added.new_start, added.lines.clone()), (1, vec!["+# hi".to_owned()]));

        assert_eq!(git_commit("ws", "%1", Some(&json!("  ")), CommitWhat::Auto).await.unwrap_err().message, "Write a commit message");
        let c = git_commit("ws", "%1", Some(&json!("Second commit\n\nWith a body")), CommitWhat::Auto).await.unwrap();
        assert!(crate::re!(r"^[0-9a-f]{7,}$").is_match(&c.commit), "{}", c.commit);
        assert!(git_status("ws", "%1").await.unwrap().status.files.is_empty());
        assert_eq!(git(&dir, "log -1 --format=%B").1.trim(), "Second commit\n\nWith a body");
        assert_eq!(dir.read("new file.md"), "# hi\n");
    });
}

/// The files `git status` lists, as "XY path" lines (porcelain v1), for checking what an action did.
fn porcelain(dir: &TempDir) -> Vec<String> {
    let out = git(dir, "status --porcelain=v1 -z --untracked-files=all").1;
    let mut v: Vec<String> = out.split('\0').filter(|s| !s.is_empty()).map(str::to_owned).collect();
    v.sort();
    v
}

#[test]
fn stage_unstage_and_discard_files_with_awkward_names() {
    let dir = TempDir::new("inyon-ws-");
    run(|| async move {
        setup(&dir);
        git(&dir, "init -q -b main");
        let names = ["a b.txt", "it's.md", "-dash.txt", "*.md", "keep.txt"];
        for n in names {
            dir.write(n, "one\n");
        }
        dir.write("gone.txt", "bye\n");
        git(&dir, "add -A && git -c user.name=T -c user.email=t@t -c commit.gpgsign=false commit -q -m first");
        for n in names {
            dir.write(n, "one\ntwo\n");
        }
        std::fs::remove_file(dir.path("gone.txt")).unwrap();
        dir.write("new dir/fresh file.txt", "new\n");

        // staging names the file only: "*.md" isn't a pattern for it's.md
        let s = git_stage("ws", "%1", Stage::Add, vec!["*.md".into(), "-dash.txt".into()], false).await.unwrap();
        let by = |p: &str| s.status.files.iter().find(|f| f.path == p).cloned().unwrap();
        assert!(by("*.md").staged && !by("*.md").unstaged);
        assert!(by("-dash.txt").staged);
        assert!(!by("it's.md").staged && by("it's.md").unstaged);
        assert!(!by("new dir/fresh file.txt").staged);

        // commit takes only what's staged once anything is
        git_commit("ws", "%1", Some(&json!("Two files")), CommitWhat::Auto).await.unwrap();
        assert_eq!(git(&dir, "show --name-only --format= HEAD").1.trim(), "*.md\n-dash.txt");
        assert_eq!(git_commit("ws", "%1", Some(&json!("None")), CommitWhat::Staged).await.unwrap_err().message, "Nothing is staged");

        git_stage("ws", "%1", Stage::Add, vec!["it's.md".into()], false).await.unwrap();
        let s = git_stage("ws", "%1", Stage::Remove, vec!["it's.md".into()], false).await.unwrap();
        assert!(s.status.files.iter().all(|f| !f.staged), "{:?}", s.status.files);
        assert_eq!(git_stage("ws", "%1", Stage::Add, vec![], false).await.unwrap_err().message, "Pick a file");

        // discard: a tracked file goes back to the last commit, staged or not
        git_stage("ws", "%1", Stage::Add, vec!["a b.txt".into()], false).await.unwrap();
        git_discard("ws", "%1", vec!["a b.txt".into(), "it's.md".into()]).await.unwrap();
        assert_eq!(dir.read("a b.txt"), "one\n");
        assert_eq!(dir.read("it's.md"), "one\n");
        // a deleted one comes back
        git_discard("ws", "%1", vec!["gone.txt".into()]).await.unwrap();
        assert_eq!(dir.read("gone.txt"), "bye\n");
        // a file git doesn't track is deleted, even in a folder git doesn't track either
        git_discard("ws", "%1", vec!["new dir/fresh file.txt".into()]).await.unwrap();
        assert!(!dir.path("new dir/fresh file.txt").exists());
        // one added since the last commit is taken out of the index and deleted
        dir.write("added.txt", "x\n");
        git(&dir, "add added.txt");
        git_discard("ws", "%1", vec!["added.txt".into()]).await.unwrap();
        assert!(!dir.path("added.txt").exists());
        assert_eq!(porcelain(&dir), [" M keep.txt"]);

        // a staged rename names both paths
        git(&dir, "mv keep.txt kept.txt");
        let s = git_status("ws", "%1").await.unwrap();
        let r = s.status.files.iter().find(|f| f.status == "R").cloned().unwrap();
        assert_eq!((r.path.as_str(), r.from.as_deref()), ("kept.txt", Some("keep.txt")));
        git_discard("ws", "%1", vec![r.path, r.from.unwrap()]).await.unwrap();
        assert_eq!(dir.read("keep.txt"), "one\n");
        assert!(!dir.path("kept.txt").exists());
        assert!(porcelain(&dir).is_empty(), "{:?}", porcelain(&dir));

        // nothing to discard: an unchanged file, or one git ignores, stays as it is
        dir.write(".gitignore", "*.log\n");
        dir.write("x.log", "log\n");
        assert_eq!(git_discard("ws", "%1", vec!["keep.txt".into()]).await.unwrap_err().message, "Nothing to discard in keep.txt");
        assert_eq!(git_discard("ws", "%1", vec!["x.log".into()]).await.unwrap_err().message, "Nothing to discard in x.log");
        assert_eq!(dir.read("x.log"), "log\n");

        // stage every change, then commit everything with staged: false
        dir.write("keep.txt", "changed\n");
        let s = git_stage("ws", "%1", Stage::Add, vec![], true).await.unwrap();
        assert!(s.status.files.iter().all(|f| f.staged));
        assert_eq!(git_draft("ws", "%1").await.unwrap().message, "Update 2 files\n\n- .gitignore (new)\n- keep.txt");
        git_stage("ws", "%1", Stage::Remove, vec![], true).await.unwrap();
        git_commit("ws", "%1", Some(&json!("Everything")), CommitWhat::All).await.unwrap();
        assert!(porcelain(&dir).is_empty());
    });
}

#[test]
fn before_the_first_commit_files_stage_unstage_and_discard() {
    let dir = TempDir::new("inyon-ws-");
    run(|| async move {
        setup(&dir);
        git(&dir, "init -q -b main");
        dir.write("a.txt", "a\n");
        dir.write("b.txt", "b\n");
        let s = git_stage("ws", "%1", Stage::Add, vec!["a.txt".into()], false).await.unwrap();
        assert_eq!((s.status.branch.as_deref(), s.status.files.iter().filter(|f| f.staged).count()), (Some("main"), 1));
        let s = git_stage("ws", "%1", Stage::Remove, vec!["a.txt".into()], false).await.unwrap();
        assert!(s.status.files.iter().all(|f| !f.staged && f.status == "?"));
        git_stage("ws", "%1", Stage::Add, vec!["a.txt".into()], false).await.unwrap();
        git_discard("ws", "%1", vec!["a.txt".into()]).await.unwrap();
        assert!(!dir.path("a.txt").exists());
        assert_eq!(dir.read("b.txt"), "b\n");
    });
}
