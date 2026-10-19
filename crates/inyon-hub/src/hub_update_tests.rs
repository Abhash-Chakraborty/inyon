//! hub-update.test.ts, the hub's half ("the hub checks for updates and starts one", "a hub run as
//! the inyon program", and the checkout checks the status shares with the script). The update
//! script's own steps stay in TS (apps/hub/src/cli/update.ts), and so do their tests. Every checkout here is a throwaway repository in a temp folder.

use std::cell::{Cell, RefCell};
use std::path::{Path, PathBuf};
use std::rc::Rc;

use super::*;

fn block<F: std::future::Future>(f: F) -> F::Output {
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    tokio::task::LocalSet::new().block_on(&rt, async {
        inyon_core::platform::rt::install(Rc::new(inyon_backends::runtime::TokioRuntime));
        f.await
    })
}

struct Tmp(PathBuf);
impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn tmp() -> Tmp {
    let d = std::env::temp_dir().join(format!("inyon-hub-update-{}", crate::http::random_hex(6)));
    std::fs::create_dir_all(&d).unwrap();
    Tmp(d)
}

fn git(cwd: &Path, args: &[&str]) -> String {
    let o = std::process::Command::new("git")
        .args(args)
        .current_dir(cwd)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_AUTHOR_NAME", "t")
        .env("GIT_AUTHOR_EMAIL", "t@example.com")
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@example.com")
        .output()
        .unwrap();
    assert!(o.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&o.stderr));
    String::from_utf8_lossy(&o.stdout).trim().to_owned()
}

/// An "origin" with one commit and a clone of it, the way a hub is installed.
fn checkout(root: &Path, name: &str, tags: &[&str]) -> (PathBuf, PathBuf) {
    let dir = root.join(name);
    let origin = root.join(format!("{name}-origin"));
    std::fs::create_dir_all(&origin).unwrap();
    git(&origin, &["init", "-q", "-b", "main"]);
    std::fs::write(origin.join("package.json"), r#"{"version":"0.6.3"}"#).unwrap();
    git(&origin, &["add", "."]);
    git(&origin, &["commit", "-qm", "first"]);
    for t in tags {
        git(&origin, &["tag", t]);
    }
    git(root, &["clone", "-q", origin.to_str().unwrap(), dir.to_str().unwrap()]);
    (dir, origin)
}

fn commit(cwd: &Path, file: &str) {
    std::fs::write(cwd.join(file), file).unwrap();
    git(cwd, &["add", "."]);
    git(cwd, &["commit", "-qm", file]);
}

fn opts(repo: Option<PathBuf>, data: PathBuf, version: &str) -> Options {
    let mut o = Options::new(repo, data.clone(), String::new());
    o.version = version.into();
    o.status_file = data.join("update-status");
    o.spawn = Rc::new(|_, _, _| None);
    o.get = Rc::new(|_| Box::pin(async { Err("no network in tests".to_owned()) }));
    o
}

/// counts how often the remote is asked
fn counting() -> (Rc<Cell<u32>>, Exec) {
    let seen = Rc::new(Cell::new(0));
    let s = seen.clone();
    let real = exec();
    let run: Exec = Rc::new(move |cmd: Vec<String>, cwd: PathBuf| {
        if cmd[0] == "git" && cmd[1] == "fetch" {
            s.set(s.get() + 1);
        }
        real(cmd, cwd)
    });
    (seen, run)
}

#[test]
fn a_folder_inside_some_other_repository_is_not_a_checkout_of_inyon() {
    let root = tmp();
    let (dir, _) = checkout(&root.0, "r7", &[]);
    std::fs::create_dir_all(dir.join("apps")).unwrap();
    let co = block(check_checkout(&dir.join("apps"), &exec()));
    assert!(!co.git);
    assert!(co.reason.as_deref().unwrap().contains("isn't a git checkout"));
    let s = block(HubUpdater::new(opts(Some(dir.join("apps")), root.0.join("data7"), "0.6.3")).status(false));
    assert_eq!(s["canUpdate"], json!(false));
}

#[test]
fn a_detached_checkout() {
    let root = tmp();
    let (dir, _) = checkout(&root.0, "r8", &[]);
    git(&dir, &["checkout", "-q", "--detach"]);
    let s = block(HubUpdater::new(opts(Some(dir), root.0.join("data8"), "0.6.3")).status(false));
    assert!(s["reason"].as_str().unwrap().contains("not a branch"));
    assert_eq!(s["canUpdate"], json!(false));
}

#[test]
fn reports_the_newest_release_tag_and_asks_the_remote_at_most_every_half_hour() {
    let root = tmp();
    let (dir, origin) = checkout(&root.0, "r1", &["v0.6.3"]);
    for t in ["v0.6.4", "v0.6.10", "v0.7.0-rc.1"] {
        git(&origin, &["tag", t]);
    }
    commit(&origin, "next.txt");
    let t = Rc::new(Cell::new(1_000_000u64));
    let (seen, run) = counting();
    let mut o = opts(Some(dir), root.0.join("data1"), "0.6.3");
    o.run = run;
    let tc = t.clone();
    o.now = Rc::new(move || tc.get());
    let u = HubUpdater::new(o);
    block(async {
        let first = u.status(false).await;
        assert_eq!(
            (first["current"].as_str(), first["latest"].as_str(), first["behind"].as_u64(), first["canUpdate"].as_bool()),
            (Some("0.6.3"), Some("0.6.10"), Some(1), Some(true))
        );
        assert_eq!(seen.get(), 1);
        t.set(t.get() + CHECK_EVERY - 1000);
        u.status(false).await;
        assert_eq!(seen.get(), 1);
        t.set(t.get() + 2000);
        u.status(false).await;
        assert_eq!(seen.get(), 2);
        // "Check now" in Settings
        u.status(true).await;
        assert_eq!(seen.get(), 3);
    });
}

#[test]
fn two_requests_at_once_share_one_check() {
    let root = tmp();
    let (dir, _) = checkout(&root.0, "r2", &[]);
    let (seen, run) = counting();
    let mut o = opts(Some(dir), root.0.join("data2"), "0.6.3");
    o.run = run;
    let u = HubUpdater::new(o);
    block(async {
        futures_util::future::join3(u.status(false), u.status(false), u.status(false)).await;
    });
    assert_eq!(seen.get(), 1);
}

#[test]
fn says_why_it_cannot_update_and_up_to_date_has_no_latest() {
    let root = tmp();
    let (dir, _) = checkout(&root.0, "r3", &["v0.6.3"]);
    std::fs::write(dir.join("package.json"), "{}").unwrap();
    let u = HubUpdater::new(opts(Some(dir), root.0.join("data3"), "0.6.3"));
    let s = block(u.status(false));
    assert_eq!(s["canUpdate"], json!(false));
    assert_eq!(s["reason"], json!("The checkout has local changes. Commit or stash them first."));
    assert_eq!(s["behind"], json!(0));
    assert!(s.get("latest").is_none());
}

#[test]
fn post_starts_the_script_on_its_own_and_answers_at_once() {
    let root = tmp();
    let (dir, _) = checkout(&root.0, "r4", &[]);
    type Spawned = Rc<RefCell<Vec<(Vec<String>, PathBuf, PathBuf)>>>;
    let spawned: Spawned = Rc::default();
    let alive = Rc::new(Cell::new(true));
    let mut o = opts(Some(dir.clone()), root.0.join("data4"), "0.6.3");
    let sp = spawned.clone();
    o.spawn = Rc::new(move |cmd, cwd, log| {
        sp.borrow_mut().push((cmd, cwd.to_owned(), log.to_owned()));
        Some(4242)
    });
    let al = alive.clone();
    o.alive = Rc::new(move |pid| pid == 4242 && al.get());
    let u = HubUpdater::new(o);
    block(async {
        let res = u.post().await;
        assert_eq!(res.status(), 202);
        assert_eq!(spawned.borrow().len(), 1);
        let (cmd, cwd, log) = spawned.borrow()[0].clone();
        let job = u.job_file.to_string_lossy().into_owned();
        assert_eq!(cmd[1..], [dir.join("apps/hub/src/cli/update.ts").to_string_lossy().into_owned(), "--repo".into(), dir.to_string_lossy().into_owned(), "--job".into(), job]);
        assert_eq!((cwd, log), (dir.clone(), u.log_file.clone()));
        let written = read_json(&u.job_file).unwrap();
        assert_eq!((written["pid"].as_u64(), written["step"].as_str()), (Some(4242), Some("start")));
        assert_eq!(u.status(false).await["running"], json!(true));
        // a second tap while it runs
        assert_eq!(u.post().await.status(), 409);
        assert_eq!(spawned.borrow().len(), 1);

        // the script got as far as the restart, which took it down with the old hub: that's success
        alive.set(false);
        std::fs::write(&u.job_file, r#"{"pid":4242,"started":1,"step":"restart"}"#).unwrap();
        let after = u.status(false).await;
        assert!(after.get("running").is_none() && after.get("error").is_none());
        // cut short earlier than that
        std::fs::write(&u.job_file, r#"{"pid":4242,"started":1,"step":"install"}"#).unwrap();
        let s = u.status(false).await;
        assert_eq!(s["error"], json!("The last update stopped before it finished."));
        assert_eq!(s["log"], json!(u.log_file.to_string_lossy()));
        // failed, as the script wrote it down
        std::fs::write(&u.job_file, r#"{"pid":4242,"started":1,"step":"build","error":"Building the web app failed."}"#).unwrap();
        let s = u.status(false).await;
        assert_eq!(s["error"], json!("Building the web app failed."));
        assert_eq!(s["log"], json!(u.log_file.to_string_lossy()));
    });
}

#[test]
fn post_refuses_a_checkout_with_local_changes_without_starting_anything() {
    let root = tmp();
    let (dir, _) = checkout(&root.0, "r5", &[]);
    std::fs::write(dir.join("package.json"), "{}").unwrap();
    let spawned = Rc::new(Cell::new(0));
    let mut o = opts(Some(dir), root.0.join("data5"), "0.6.3");
    let sp = spawned.clone();
    o.spawn = Rc::new(move |_, _, _| {
        sp.set(sp.get() + 1);
        Some(1)
    });
    let u = HubUpdater::new(o);
    let r = block(u.start());
    assert_eq!(r, Err(Refused(409, "The checkout has local changes. Commit or stash them first.".into())));
    assert_eq!(spawned.get(), 0);
}

#[test]
fn an_update_without_a_unit_to_restart_says_the_hub_needs_a_restart() {
    let root = tmp();
    let (dir, origin) = checkout(&root.0, "r6", &[]);
    let before = git(&dir, &["rev-parse", "--short", "HEAD"]);
    commit(&origin, "new.txt");
    git(&dir, &["pull", "-q", "--ff-only"]);
    let mut o = opts(Some(dir), root.0.join("data6"), "0.6.3");
    o.commit = before;
    let u = HubUpdater::new(o);
    std::fs::create_dir_all(u.job_file.parent().unwrap()).unwrap();
    std::fs::write(&u.job_file, r#"{"pid":1,"started":1,"step":"build","done":true,"restarted":false}"#).unwrap();
    assert_eq!(block(u.status(false))["restartNeeded"], json!(true));
}

/// latest.json on the website naming `version`; the addresses asked are noted
fn releases(version: Value, status: u16, urls: Rc<RefCell<Vec<String>>>) -> Get {
    Rc::new(move |url: &str| {
        urls.borrow_mut().push(url.to_owned());
        let body = inyon_core::js::stringify(&json!({ "version": version, "files": [] }));
        Box::pin(async move { Ok((status, body)) })
    })
}

fn no_run(asked: Rc<RefCell<Vec<Vec<String>>>>, code: i32, out: &'static str) -> Exec {
    Rc::new(move |cmd: Vec<String>, _| {
        asked.borrow_mut().push(cmd);
        Box::pin(async move { (code, out.to_owned()) })
    })
}

#[test]
fn looks_for_a_new_release_on_the_website_not_in_a_checkout() {
    let root = tmp();
    let data = root.0.join("bin1");
    let (asked, urls) = (Rc::new(RefCell::new(vec![])), Rc::new(RefCell::new(vec![])));
    let mut o = opts(None, data.clone(), "0.7.0");
    o.run = no_run(asked.clone(), 0, "");
    o.get = releases(json!("0.7.2"), 200, urls.clone());
    let s = block(HubUpdater::new(o).status(false));
    assert_eq!((s["current"].as_str(), s["latest"].as_str(), s["canUpdate"].as_bool()), (Some("0.7.0"), Some("0.7.2"), Some(true)));
    assert!(asked.borrow().is_empty());
    assert_eq!(*urls.borrow(), [LATEST_URL]);
    let mut same = opts(None, data, "0.7.2");
    same.get = releases(json!("0.7.2"), 200, urls);
    assert!(block(HubUpdater::new(same).status(false)).get("latest").is_none());
}

#[test]
fn a_website_that_is_down_or_names_no_release_means_no_update_rather_than_an_error() {
    let root = tmp();
    let urls = Rc::new(RefCell::new(vec![]));
    let html: Get = Rc::new(|_| Box::pin(async { Ok((200, "<html>".to_owned())) }));
    for get in [releases(json!("0.9.0"), 503, urls.clone()), releases(json!("0.9.0-rc.1"), 200, urls.clone()), releases(Value::Null, 200, urls.clone()), html] {
        let mut o = opts(None, root.0.join("bin1b"), "0.7.0");
        o.get = get;
        let s = block(HubUpdater::new(o).status(false));
        assert_eq!((s["current"].as_str(), s.get("latest"), s["canUpdate"].as_bool()), (Some("0.7.0"), None, Some(true)));
    }
}

#[test]
fn post_runs_the_programs_own_update_on_its_own_and_its_status_file_says_how_it_went() {
    let root = tmp();
    let data = root.0.join("bin2");
    let status_file = data.join("node").join("update-status");
    std::fs::create_dir_all(status_file.parent().unwrap()).unwrap();
    let asked = Rc::new(RefCell::new(vec![]));
    let mut o = opts(None, data.clone(), "0.7.0");
    o.run = no_run(asked.clone(), 0, "");
    o.status_file = status_file.clone();
    o.program = "/home/me/.inyon/bin/inyon".into();
    o.get = releases(json!("0.7.2"), 200, Rc::default());
    let u = HubUpdater::new(o);
    block(async {
        assert_eq!(u.post().await.status(), 202);
        assert_eq!(*asked.borrow(), [vec!["/home/me/.inyon/bin/inyon".to_owned(), "update".into(), "--background".into()]]);
        std::fs::write(&status_file, "running\n").unwrap();
        assert_eq!(u.status(false).await["running"], json!(true));
        assert_eq!(u.post().await.status(), 409);
        std::fs::write(&status_file, "failed: The download didn't match the release's checksum, so nothing was changed. Try again.\n").unwrap();
        let s = u.status(false).await;
        assert_eq!(s["error"], json!("The download didn't match the release's checksum, so nothing was changed. Try again."));
        assert_eq!(s["log"], json!(data.join("node").join("update.log").to_string_lossy()));
    });
}

#[test]
fn an_update_that_cant_start_says_why() {
    let root = tmp();
    let mut o = opts(None, root.0.join("bin3"), "0.7.0");
    o.run = no_run(Rc::default(), 1, "systemd-run: not found");
    let u = HubUpdater::new(o);
    block(async {
        assert_eq!(u.start().await, Err(Refused(500, "systemd-run: not found".into())));
        assert_eq!(u.status(false).await["error"], json!("systemd-run: not found"));
    });
}

#[test]
fn an_update_script_that_ends_without_a_word_is_not_counted_as_running() {
    let dir = std::env::temp_dir().join(format!("inyon-detached-{}", crate::http::random_hex(6)));
    std::fs::create_dir_all(&dir).unwrap();
    let pid = spawn_detached(vec!["sh".into(), "-c".into(), "exit 3".into()], &dir, &dir.join("log")).unwrap();
    let end = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while pid_alive(pid) && std::time::Instant::now() < end {
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    let _ = std::fs::remove_dir_all(&dir);
    assert!(!pid_alive(pid), "the script ended, yet its pid still answers (a zombie)");
}

#[test]
fn a_release_build_is_the_program_even_with_its_checkout_still_on_disk() {
    let here = Path::new(env!("CARGO_MANIFEST_DIR"));
    assert!(checkout_at(here, true).is_some(), "a development build in this checkout runs from source");
    assert_eq!(checkout_at(here, false), None);
}
