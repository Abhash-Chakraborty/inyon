//! `inyon pages` end to end: the real binary with HOME a throwaway folder, and the slug and folder
//! rules checked against the vectors both hubs are tested with (fixtures/pages/rules.json).

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};

use inyon_cli::pages;
use serde_json::Value;

const AGENT_VARS: [&str; 7] = ["CLAUDECODE", "CODEX_SANDBOX", "CODEX_SANDBOX_NETWORK_DISABLED", "CODEX_THREAD_ID", "GEMINI_CLI", "OPENCODE", "INYON_DATA_DIR"];

struct Home {
    dir: PathBuf,
}

impl Home {
    fn new(tag: &str) -> Home {
        static N: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!("inyon-pages-{tag}-{}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        // the real path, so the folders below compare equal to what the command writes (macOS's /tmp is a link)
        Home { dir: fs::canonicalize(&dir).unwrap() }
    }

    /// A site folder under the home, with an index.html titled `title`.
    fn site(&self, rel: &str, title: &str) -> PathBuf {
        let d = self.dir.join(rel);
        fs::create_dir_all(&d).unwrap();
        fs::write(d.join("index.html"), format!("<!doctype html><html><head><title>{title}</title></head><body></body></html>")).unwrap();
        d
    }

    fn file(&self) -> PathBuf {
        self.dir.join(".inyon").join("pages.json")
    }

    fn list(&self) -> Value {
        serde_json::from_str(&fs::read_to_string(self.file()).unwrap()).unwrap()
    }

    fn cmd(&self, args: &[&str]) -> Command {
        let mut c = Command::new(env!("CARGO_BIN_EXE_inyon"));
        c.args(args).env("HOME", &self.dir).env("USERPROFILE", &self.dir).current_dir(&self.dir);
        for v in AGENT_VARS {
            c.env_remove(v);
        }
        c
    }

    fn run(&self, args: &[&str]) -> (i32, String, String) {
        out(self.cmd(args))
    }

    fn json(&self, args: &[&str]) -> (i32, Value) {
        let mut a = args.to_vec();
        a.push("--json");
        let (code, stdout, _) = self.run(&a);
        (code, serde_json::from_str(stdout.trim()).unwrap_or_else(|_| panic!("not JSON: {stdout}")))
    }
}

impl Drop for Home {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn out(mut c: Command) -> (i32, String, String) {
    let o = c.output().unwrap();
    (o.status.code().unwrap_or(-1), String::from_utf8_lossy(&o.stdout).into_owned(), String::from_utf8_lossy(&o.stderr).into_owned())
}

fn s(p: &Path) -> &str {
    p.to_str().unwrap()
}

fn rules() -> Value {
    let f = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/pages/rules.json");
    serde_json::from_str(&fs::read_to_string(f).unwrap()).unwrap()
}

#[test]
fn slugs_and_folders_follow_the_shared_rules() {
    let r = rules();
    for c in r["slugify"].as_array().unwrap() {
        assert_eq!(pages::slugify(c["text"].as_str().unwrap()), c["slug"].as_str().unwrap(), "slugify {c}");
    }
    for c in r["isSlug"].as_array().unwrap() {
        assert_eq!(pages::is_slug(c["s"].as_str().unwrap()), c["ok"].as_bool().unwrap(), "isSlug {c}");
    }
    for c in r["uniqueSlug"].as_array().unwrap() {
        let taken: Vec<&str> = c["taken"].as_array().unwrap().iter().map(|t| t.as_str().unwrap()).collect();
        assert_eq!(pages::unique_slug(c["base"].as_str().unwrap(), |x| taken.contains(&x)), c["slug"].as_str().unwrap(), "uniqueSlug {c}");
    }
    for c in r["sitePath"].as_array().unwrap() {
        assert_eq!(pages::site_path_problem(c["path"].as_str().unwrap(), c["home"].as_str().unwrap()), c["problem"].as_str(), "sitePath {c}");
    }
    // and the messages are the hubs' own
    let core = fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../apps/hub/src/features/pages-core.ts")).unwrap();
    for m in [pages::BAD_SLUG, pages::NOT_ABSOLUTE, pages::TOO_WIDE, pages::PRIVATE_FOLDER, pages::NO_INDEX] {
        let quoted = if m.contains('\'') { format!("\"{m}\"") } else { format!("'{m}'") };
        assert!(core.contains(&quoted), "{m} isn't in pages-core.ts");
    }
}

#[test]
fn adding_a_folder_lists_it_and_marks_it() {
    let h = Home::new("add");
    let site = h.site("work/handy-redesign", "Handy &amp; redesign");
    let (code, stdout, stderr) = h.run(&["pages", "add", "work/handy-redesign/"]);
    assert_eq!(code, 0, "{stderr}");
    // no hub on this machine: where it's listed, and no app path that would open nothing
    assert!(stdout.contains("\"Handy & redesign\" is listed on "), "{stdout}");
    assert!(stdout.contains(", under handy-redesign.\n"), "{stdout}");
    assert!(stdout.contains("This machine doesn't run a hub"), "{stdout}");
    assert!(stdout.contains("The app can't open this page yet."), "{stdout}");
    assert!(!stdout.contains("/pages/local/"), "{stdout}");
    assert!(!stdout.contains("/v/"), "{stdout}");

    let list = h.list();
    assert_eq!(list["v"], 1);
    let p = &list["pages"][0];
    assert_eq!(p["slug"], "handy-redesign");
    assert_eq!(p["name"], "Handy & redesign");
    assert_eq!(p["path"], s(&site));
    assert_eq!(p["project"], s(&site));
    assert_eq!(p["by"], "cli");
    assert!(p["added"].as_u64().unwrap() > 1_700_000_000_000);
    assert_eq!(p.as_object().unwrap().keys().collect::<Vec<_>>(), ["slug", "name", "path", "project", "by", "added"]);
    assert!(!h.dir.join(".inyon/pages.json.lock").exists());

    let marker: Value = serde_json::from_str(&fs::read_to_string(site.join(".inyon-page.json")).unwrap()).unwrap();
    assert_eq!(marker["v"], 1);
    assert_eq!(marker["slug"], "handy-redesign");
    assert_eq!(marker["name"], "Handy & redesign");
    assert_eq!(marker["kind"], "blueprint");
    assert_eq!(marker["created"], p["added"]);

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(fs::metadata(h.file()).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(fs::metadata(h.dir.join(".inyon")).unwrap().permissions().mode() & 0o777, 0o700);
    }
}

#[test]
fn adding_again_changes_nothing_unless_asked() {
    let h = Home::new("again");
    let site = h.site("plans/ghostex", "Plan");
    assert_eq!(h.run(&["pages", "add", s(&site)]).0, 0);
    let before = fs::read(h.file()).unwrap();
    let marker_before = fs::read(site.join(".inyon-page.json")).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(5));

    let (code, stdout, _) = h.run(&["pages", "add", s(&site)]);
    assert_eq!(code, 0);
    assert!(stdout.contains("\"Plan\" is listed on ") && stdout.contains("(already listed)"), "{stdout}");
    assert_eq!(fs::read(h.file()).unwrap(), before);
    assert_eq!(fs::read(site.join(".inyon-page.json")).unwrap(), marker_before);

    // a new name and slug: the entry keeps its place, its added time and who added it
    let (code, v) = h.json(&["pages", "add", s(&site), "--name", "  Inyon plan  ", "--slug", "inyon"]);
    assert_eq!(code, 0, "{v}");
    assert_eq!(v["changed"], true);
    assert_eq!(v["app"], "/pages/local/inyon");
    let list = h.list();
    assert_eq!(list["pages"].as_array().unwrap().len(), 1);
    assert_eq!(list["pages"][0]["name"], "Inyon plan");
    assert_eq!(list["pages"][0]["slug"], "inyon");
    let old: Value = serde_json::from_slice(&before).unwrap();
    assert_eq!(list["pages"][0]["added"], old["pages"][0]["added"]);
    let marker: Value = serde_json::from_str(&fs::read_to_string(site.join(".inyon-page.json")).unwrap()).unwrap();
    assert_eq!(marker["slug"], "inyon");
    assert_eq!(marker["name"], "Inyon plan");
    assert_eq!(marker["created"], old["pages"][0]["added"]);
}

#[test]
fn the_marker_names_the_page_and_keeps_its_slug() {
    let h = Home::new("marker");
    let site = h.site("plans/site", "Plan");
    fs::write(site.join(".inyon-page.json"), r#"{"v":1,"slug":"ghostex","name":"Inyon plan","kind":"blueprint","created":1792320000000}"#).unwrap();
    let (code, v) = h.json(&["pages", "add", s(&site)]);
    assert_eq!(code, 0, "{v}");
    assert_eq!(v["page"]["slug"], "ghostex");
    assert_eq!(v["page"]["name"], "Inyon plan");
    let marker: Value = serde_json::from_str(&fs::read_to_string(site.join(".inyon-page.json")).unwrap()).unwrap();
    assert_eq!(marker["created"], 1792320000000u64);
    assert_eq!(v["marker"], true);
}

#[test]
fn slugs_stay_unique_on_the_machine() {
    let h = Home::new("unique");
    let a = h.site("a/plan", "A");
    let b = h.site("b/plan", "B");
    assert_eq!(h.json(&["pages", "add", s(&a)]).1["page"]["slug"], "plan");
    assert_eq!(h.json(&["pages", "add", s(&b)]).1["page"]["slug"], "plan-2");
    let c = h.site("c/other", "C");
    let (code, _, stderr) = h.run(&["pages", "add", s(&c), "--slug", "plan"]);
    assert_eq!(code, 1);
    assert!(stderr.contains("The slug \"plan\" is taken by ") && stderr.contains("Pick another with --slug"), "{stderr}");
    let (code, _, stderr) = h.run(&["pages", "add", s(&c), "--slug", "Not_A_Slug"]);
    assert_eq!(code, 1);
    assert!(stderr.contains(pages::BAD_SLUG), "{stderr}");
    assert_eq!(h.list()["pages"].as_array().unwrap().len(), 2);
}

#[test]
fn folders_that_cannot_be_pages_are_refused() {
    let h = Home::new("refuse");
    fs::write(h.dir.join("index.html"), "<title>home</title>").unwrap();
    let cases: Vec<(PathBuf, &str)> = vec![
        (h.dir.clone(), pages::TOO_WIDE),
        (h.site(".ssh/site", "x"), pages::PRIVATE_FOLDER),
        (h.site(".inyon/site", "x"), pages::PRIVATE_FOLDER),
        (h.dir.join("missing"), "doesn't exist"),
    ];
    let empty = h.dir.join("empty");
    fs::create_dir_all(&empty).unwrap();
    for (dir, want) in cases.iter().chain([(empty.clone(), pages::NO_INDEX)].iter()) {
        let (code, _, stderr) = h.run(&["pages", "add", s(dir)]);
        assert_eq!(code, 1, "{}", dir.display());
        assert!(stderr.contains(want), "{}: {stderr}", dir.display());
    }
    let (code, v) = h.json(&["pages", "add", s(&empty)]);
    assert_eq!(code, 1);
    assert_eq!(v["ok"], false);
    assert!(v["error"].as_str().unwrap().starts_with(pages::NO_INDEX));
    assert!(!h.file().exists() || h.list()["pages"].as_array().unwrap().is_empty());
}

#[cfg(unix)]
#[test]
fn a_link_into_a_private_folder_is_refused() {
    let h = Home::new("link");
    let hidden = h.site(".ssh/keys", "x");
    std::os::unix::fs::symlink(&hidden, h.dir.join("innocent")).unwrap();
    let (code, _, stderr) = h.run(&["pages", "add", "innocent"]);
    assert_eq!(code, 1);
    assert!(stderr.contains(pages::PRIVATE_FOLDER), "{stderr}");
}

#[cfg(unix)]
#[test]
fn the_same_folder_through_a_link_is_one_page() {
    let h = Home::new("same");
    let site = h.site("real/site", "Site");
    std::os::unix::fs::symlink(&site, h.dir.join("alias")).unwrap();
    assert_eq!(h.run(&["pages", "add", s(&site)]).0, 0);
    let (code, stdout, _) = h.run(&["pages", "add", "alias"]);
    assert_eq!(code, 0);
    assert!(stdout.contains("(already listed)"), "{stdout}");
    assert_eq!(h.list()["pages"].as_array().unwrap().len(), 1);
}

#[test]
fn the_agent_that_added_it_is_recorded() {
    let h = Home::new("agent");
    let site = h.site("s", "S");
    let mut c = h.cmd(&["pages", "add", s(&site), "--json"]);
    c.env("CLAUDECODE", "1");
    let (code, stdout, _) = out(c);
    assert_eq!(code, 0, "{stdout}");
    assert_eq!(h.list()["pages"][0]["by"], "claude");
}

#[test]
fn the_project_is_the_git_top_level() {
    if Command::new("git").arg("--version").output().is_err() {
        return;
    }
    let h = Home::new("git");
    let repo = h.dir.join("my-repo");
    fs::create_dir_all(&repo).unwrap();
    assert!(Command::new("git").args(["init", "-q"]).current_dir(&repo).status().unwrap().success());
    let site = h.site("my-repo/private/plans/plan", "Plan");
    let (code, stdout, _) = h.run(&["pages", "add", s(&site)]);
    assert_eq!(code, 0, "{stdout}");
    assert!(stdout.contains("under my-repo"), "{stdout}");
    let project = h.list()["pages"][0]["project"].as_str().unwrap().to_string();
    assert_eq!(fs::canonicalize(project).unwrap(), repo);
}

#[test]
fn the_project_of_a_folder_in_a_linked_worktree_is_the_main_checkout() {
    if Command::new("git").arg("--version").output().is_err() {
        return;
    }
    let h = Home::new("worktree");
    let repo = h.dir.join("my-repo");
    fs::create_dir_all(&repo).unwrap();
    let git = |args: &[&str]| assert!(Command::new("git").args(args).current_dir(&repo).status().unwrap().success(), "git {args:?}");
    git(&["init", "-q"]);
    git(&["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x"]);
    git(&["worktree", "add", "-q", ".claude/worktrees/feature"]);
    let site = h.site("my-repo/.claude/worktrees/feature/private/plans/plan", "Plan");
    let (code, stdout, _) = h.run(&["pages", "add", s(&site)]);
    assert_eq!(code, 0, "{stdout}");
    assert!(stdout.contains("under my-repo."), "{stdout}");
    let project = h.list()["pages"][0]["project"].as_str().unwrap().to_string();
    assert_eq!(fs::canonicalize(project).unwrap(), repo);
}

#[test]
fn on_the_hub_machine_there_is_no_note() {
    let h = Home::new("hub");
    fs::create_dir_all(h.dir.join(".inyon")).unwrap();
    fs::write(h.dir.join(".inyon/hub.env"), "PORT=4777\n").unwrap();
    let site = h.site("s", "S");
    let (code, v) = h.json(&["pages", "add", s(&site)]);
    assert_eq!(code, 0);
    assert_eq!(v["hub"], true);
    let m = v["message"].as_str().unwrap();
    assert!(!m.contains("doesn't run a hub"), "{m}");
    // the app's path, never a link with a token in it
    assert!(m.contains("\"S\" is in Inyon: Pages > ") && m.contains(" > s\n"), "{m}");
    assert!(m.contains("Open it in the app at /pages/local/s"), "{m}");
    assert!(!m.contains("/v/"), "{m}");
}

#[test]
fn the_list_stays_in_the_home_folder_with_a_data_dir_set() {
    let h = Home::new("datadir");
    let site = h.site("s", "S");
    let mut c = h.cmd(&["pages", "add", s(&site)]);
    c.env("INYON_DATA_DIR", h.dir.join("elsewhere"));
    assert_eq!(out(c).0, 0);
    assert!(h.file().exists());
    assert!(!h.dir.join("elsewhere/pages.json").exists());
}

#[test]
fn removing_a_page_leaves_its_folder() {
    let h = Home::new("rm");
    let a = h.site("a", "Alpha");
    let b = h.site("b", "Beta");
    h.run(&["pages", "add", s(&a)]);
    h.run(&["pages", "add", s(&b)]);
    let (code, stdout, _) = h.run(&["pages", "rm", "a"]);
    assert_eq!(code, 0);
    assert!(stdout.contains("Removed \"Alpha\" from Inyon. Its folder stays where it is: ~/a"), "{stdout}");
    assert!(a.join("index.html").exists());
    let list = h.list();
    assert_eq!(list["pages"].as_array().unwrap().len(), 1);
    assert_eq!(list["pages"][0]["slug"], "b");
    let (code, _, stderr) = h.run(&["pages", "rm", "a"]);
    assert_eq!(code, 1);
    assert!(stderr.contains("There's no page called \"a\" on this machine"), "{stderr}");
    assert_eq!(h.run(&["pages", "remove", "b"]).0, 0);
    assert!(h.list()["pages"].as_array().unwrap().is_empty());
}

#[test]
fn the_list_shows_each_page_and_what_is_wrong() {
    let h = Home::new("ls");
    let (code, stdout, _) = h.run(&["pages"]);
    assert_eq!(code, 0);
    assert!(stdout.contains("No pages on this machine yet"), "{stdout}");

    let a = h.site("sites/alpha", "Alpha");
    let b = h.site("sites/beta", "Beta");
    h.run(&["pages", "add", s(&a)]);
    h.run(&["pages", "add", s(&b)]);
    fs::remove_dir_all(&b).unwrap();
    // an entry this version can't read stays in the file and is counted
    let mut list = h.list();
    list["pages"].as_array_mut().unwrap().push(serde_json::json!({ "slug": "Broken!", "future": true }));
    list["extra"] = serde_json::json!("kept");
    fs::write(h.file(), serde_json::to_string(&list).unwrap()).unwrap();

    let (code, stdout, _) = h.run(&["pages", "ls"]);
    assert_eq!(code, 0);
    assert!(stdout.contains("alpha  Alpha  ~/sites/alpha"), "{stdout}");
    assert!(stdout.contains("beta   Beta   ~/sites/beta  ! the folder is gone"), "{stdout}");
    assert!(stdout.contains("1 entry in ~/.inyon/pages.json can't be read and is left out."), "{stdout}");

    let (code, v) = h.json(&["pages", "list"]);
    assert_eq!(code, 0);
    assert_eq!(v["ok"], true);
    assert_eq!(v["host"], "local");
    assert_eq!(v["skipped"], 1);
    let rows = v["pages"].as_array().unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["app"], "/pages/local/alpha");
    assert!(rows[0].get("problem").is_none());
    assert_eq!(rows[1]["problem"], "the folder is gone");

    // writes keep what they don't understand
    let c = h.site("sites/gamma", "Gamma");
    h.run(&["pages", "add", s(&c)]);
    let list = h.list();
    assert_eq!(list["extra"], "kept");
    assert_eq!(list["pages"][2]["future"], true);
    assert_eq!(list["pages"][3]["slug"], "gamma");
}

#[test]
fn a_broken_list_is_never_overwritten() {
    let h = Home::new("broken");
    fs::create_dir_all(h.dir.join(".inyon")).unwrap();
    fs::write(h.file(), "{not json").unwrap();
    let site = h.site("s", "S");
    let (code, _, stderr) = h.run(&["pages", "add", s(&site)]);
    assert_eq!(code, 1);
    assert!(stderr.contains(pages::BROKEN_FILE), "{stderr}");
    assert_eq!(fs::read_to_string(h.file()).unwrap(), "{not json");
    assert_eq!(h.run(&["pages", "ls"]).0, 1);
    fs::write(h.file(), r#"{"v":2,"pages":[]}"#).unwrap();
    assert_eq!(h.run(&["pages", "add", s(&site)]).0, 1);
}

#[test]
fn a_lock_left_by_a_dead_writer_is_taken_over() {
    let h = Home::new("stale");
    fs::create_dir_all(h.dir.join(".inyon")).unwrap();
    let lock = h.dir.join(".inyon/pages.json.lock");
    fs::write(&lock, "99999\n").unwrap();
    let old = std::time::SystemTime::now() - std::time::Duration::from_secs(60);
    fs::File::options().write(true).open(&lock).unwrap().set_modified(old).unwrap();
    let site = h.site("s", "S");
    let (code, _, stderr) = h.run(&["pages", "add", s(&site)]);
    assert_eq!(code, 0, "{stderr}");
    assert!(!lock.exists());
}

#[test]
fn a_lock_held_by_another_writer_is_waited_for_then_refused() {
    let h = Home::new("held");
    fs::create_dir_all(h.dir.join(".inyon")).unwrap();
    let lock = h.dir.join(".inyon/pages.json.lock");
    fs::write(&lock, "1\n").unwrap();
    let site = h.site("s", "S");
    let start = std::time::Instant::now();
    let (code, _, stderr) = h.run(&["pages", "add", s(&site)]);
    assert_eq!(code, 1);
    assert!(stderr.contains(pages::LOCKED), "{stderr}");
    assert!(start.elapsed() >= std::time::Duration::from_secs(4));
    assert!(lock.exists(), "someone else's lock stays");
    assert!(!h.file().exists());
}
