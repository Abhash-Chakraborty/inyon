//! The hub's side of features/hub-update.ts: is there an update, and start one from Settings.
//!
//! Run as the inyon program, the hub looks for a new release on the website and `inyon update
//! --background` swaps it in and restarts the hub. Built in a checkout (a hub you run with `cargo
//! run`), it pulls with the same script the Bun hub starts (apps/hub/src/cli/update.ts, run by
//! Bun). Nothing here runs by itself: the hub only looks for a new release, at most every half
//! hour, when the app asks.

use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::rc::Rc;

use futures_util::future::{FutureExt, LocalBoxFuture, Shared};
use inyon_core::clock::now_ms;
use inyon_protocol::{newer_release, newest_release, LATEST_URL, VERSION};
use serde_json::{json, Map, Value};

use crate::http::{json as answer_json, Req, Resp};
use crate::server::{raw, Routes};

/// at most this often the hub asks for new tags, unless Settings asks for a check
pub const CHECK_EVERY: u64 = 30 * 60_000;

/// the systemd user unit, under its name from before the rename to Inyon too
pub type Exec = Rc<dyn Fn(Vec<String>, PathBuf) -> LocalBoxFuture<'static, (i32, String)>>;
pub type Spawn = Rc<dyn Fn(Vec<String>, &Path, &Path) -> Option<u32>>;
pub type Get = Rc<dyn Fn(&str) -> LocalBoxFuture<'static, Result<(u16, String), String>>>;

/// The checkout this program was built in, when it's still there: then the hub runs "from source",
/// as the Bun hub does from a checkout (its build tag, its update by git pull).
pub fn checkout() -> Option<PathBuf> {
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let repo = std::fs::canonicalize(&repo).unwrap_or(repo);
    repo.join("apps/node/targets.ts").is_file().then_some(repo)
}

/// PATH with the places Bun installs itself. A systemd user unit starts with a short PATH that
/// often doesn't have it.
pub fn tool_path() -> String {
    let home = std::env::var("HOME").ok().filter(|h| !h.is_empty()).unwrap_or_else(|| inyon_engine::paths::home().to_string_lossy().into_owned());
    let exe_dir = std::env::current_exe().ok().and_then(|e| e.parent().map(|p| p.to_string_lossy().into_owned())).unwrap_or_default();
    let mut seen: Vec<String> = vec![];
    let path = std::env::var("PATH").unwrap_or_default();
    for p in path.split(':').map(str::to_owned).chain([exe_dir, format!("{home}/.bun/bin"), format!("{home}/.local/bin"), "/usr/local/bin".to_owned()]) {
        if !p.is_empty() && !seen.contains(&p) {
            seen.push(p);
        }
    }
    seen.join(":")
}

/// Runs a command with the tool PATH; its exit code and its output and errors together, trimmed.
pub fn exec() -> Exec {
    Rc::new(|cmd: Vec<String>, cwd: PathBuf| {
        Box::pin(async move {
            let Some((prog, args)) = cmd.split_first() else { return (127, String::new()) };
            let out = tokio::process::Command::new(prog).args(args).current_dir(&cwd).env("PATH", tool_path()).stdin(std::process::Stdio::null()).output().await;
            match out {
                Ok(o) => {
                    let text = format!("{}{}", String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr));
                    (o.status.code().unwrap_or(1), text.trim().to_owned())
                }
                // not installed
                Err(e) => (127, e.to_string()),
            }
        })
    })
}

fn real(p: &Path) -> PathBuf {
    std::fs::canonicalize(p).unwrap_or_else(|_| p.to_owned())
}

fn v(cmd: &[&str]) -> Vec<String> {
    cmd.iter().map(|s| (*s).to_owned()).collect()
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Checkout {
    pub git: bool,
    pub branch: Option<String>,
    pub reason: Option<String>,
}

/// Whether `repo` can be updated with a fast-forward pull, and the branch it's on.
pub async fn check_checkout(repo: &Path, run: &Exec) -> Checkout {
    let top = run(v(&["git", "rev-parse", "--show-toplevel"]), repo.to_owned()).await;
    if top.0 != 0 || real(Path::new(&top.1)) != real(repo) {
        return Checkout {
            git: false,
            branch: None,
            reason: Some(format!("{} isn't a git checkout, so it can't update itself. Install Inyon with git clone to get updates.", repo.display())),
        };
    }
    let branch = run(v(&["git", "symbolic-ref", "--short", "-q", "HEAD"]), repo.to_owned()).await.1;
    if branch.is_empty() {
        return Checkout { git: true, branch: None, reason: Some("The checkout is on a tag or commit, not a branch. Run git checkout main in it first.".into()) };
    }
    let status = run(v(&["git", "status", "--porcelain", "--untracked-files=no"]), repo.to_owned()).await;
    if status.0 != 0 || !status.1.is_empty() {
        return Checkout { git: true, branch: Some(branch), reason: Some("The checkout has local changes. Commit or stash them first.".into()) };
    }
    if run(v(&["git", "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]), repo.to_owned()).await.0 != 0 {
        let reason = format!("The {branch} branch doesn't follow a remote branch, so there's nothing to pull.");
        return Checkout { git: true, branch: Some(branch), reason: Some(reason) };
    }
    Checkout { git: true, branch: Some(branch), reason: None }
}

/// The commit the hub runs: built from (the inyon program), or checked out (a checkout's build).
pub fn head_commit(repo: Option<&Path>) -> String {
    match repo {
        Some(repo) => std::process::Command::new("git")
            .args(["rev-parse", "--short", "HEAD"])
            .current_dir(repo)
            .stdin(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned())
            .unwrap_or_default(),
        None => option_env!("INYON_BUILD_COMMIT").map(str::to_owned).or_else(|| std::env::var("INYON_BUILD_COMMIT").ok()).unwrap_or_default(),
    }
}

/// What a hub needs to check for and start its update.
pub struct Options {
    /// the checkout, or None when run as the inyon program
    pub repo: Option<PathBuf>,
    pub data_dir: PathBuf,
    pub version: String,
    pub commit: String,
    pub run: Exec,
    pub spawn: Spawn,
    pub now: Rc<dyn Fn() -> u64>,
    pub alive: Rc<dyn Fn(u32) -> bool>,
    /// the inyon program's update status file (see apps/cli/src/update.rs)
    pub status_file: PathBuf,
    /// the program whose `update --background` is run
    pub program: String,
    pub get: Get,
}

impl Options {
    pub fn new(repo: Option<PathBuf>, data_dir: PathBuf, commit: String) -> Self {
        Options {
            repo,
            data_dir,
            version: VERSION.to_owned(),
            commit,
            run: exec(),
            spawn: Rc::new(spawn_detached),
            now: Rc::new(now_ms),
            alive: Rc::new(pid_alive),
            status_file: inyon_engine::paths::node_dir().join("update-status"),
            // the inyon command owns updates
            program: inyon_engine::paths::inyon_command().or_else(|| std::env::current_exe().ok()).map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|| "inyon".into()),
            get: Rc::new(|url: &str| {
                let url = url.to_owned();
                Box::pin(async move {
                    let r = inyon_engine::http::fetch("GET", url, vec![], None, std::time::Duration::from_secs(20)).await?;
                    Ok((r.status, String::from_utf8_lossy(&r.body).into_owned()))
                })
            }),
        }
    }
}

/// Starts the update script on its own, in a session of its own, so it outlives the hub.
fn spawn_detached(cmd: Vec<String>, cwd: &Path, log: &Path) -> Option<u32> {
    use std::os::unix::fs::OpenOptionsExt;
    use std::os::unix::process::CommandExt;
    let out = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(log).ok()?;
    let err = out.try_clone().ok()?;
    let (prog, args) = cmd.split_first()?;
    let mut c = std::process::Command::new(prog);
    c.args(args).current_dir(cwd).env("PATH", tool_path()).stdin(std::process::Stdio::null()).stdout(out).stderr(err);
    // SAFETY: setsid is async-signal-safe and touches nothing of this process
    unsafe {
        c.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    c.spawn().ok().map(|child| child.id())
}

fn pid_alive(pid: u32) -> bool {
    // SAFETY: signal 0 only asks whether the process exists
    let r = unsafe { libc::kill(pid as i32, 0) };
    r == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[derive(Clone, Debug, Default, PartialEq)]
struct Check {
    latest: Option<String>,
    behind: Option<u64>,
    can_update: bool,
    reason: Option<String>,
    checked_at: u64,
    binary: bool,
}

/// What `start` refused, with the status the route answers with.
#[derive(Debug, PartialEq)]
pub struct Refused(pub u16, pub String);

pub struct HubUpdater {
    o: Options,
    pub job_file: PathBuf,
    pub log_file: PathBuf,
    cache: RefCell<Option<Check>>,
    checking: RefCell<Option<Shared<LocalBoxFuture<'static, Check>>>>,
}

fn read_json(p: &Path) -> Option<Map<String, Value>> {
    std::fs::read_to_string(p).ok().and_then(|t| inyon_core::js::json::parse(&t)).and_then(|v| v.as_object().cloned())
}

fn write_private(p: &Path, text: &str) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut f = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(p)?;
    f.write_all(text.as_bytes())
}

/// Updates the update script's progress in the job file (`writeJob`).
pub fn write_job(file: &Path, patch: Value) {
    let mut job = read_json(file).unwrap_or_else(|| {
        let mut m = Map::new();
        m.insert("started".into(), json!(now_ms()));
        m
    });
    if let Value::Object(p) = patch {
        for (k, v) in p {
            job.insert(k, v);
        }
    }
    let _ = write_private(file, &inyon_core::js::stringify(&Value::Object(job)));
}

impl HubUpdater {
    pub fn new(o: Options) -> Rc<Self> {
        let job_file = o.data_dir.join("hub-update.json");
        let log_file = if o.repo.is_none() { o.status_file.parent().unwrap_or(Path::new(".")).join("update.log") } else { o.data_dir.join("hub-update.log") };
        Rc::new(HubUpdater { o, job_file, log_file, cache: RefCell::new(None), checking: RefCell::new(None) })
    }

    fn binary(&self) -> bool {
        self.o.repo.is_none()
    }

    fn read_job(&self) -> Option<Map<String, Value>> {
        read_json(&self.job_file)
    }

    /// the newest release, from latest.json on the website
    async fn check_release(o: (Get, String, u64)) -> Check {
        let (get, version, now) = o;
        let latest = match get(LATEST_URL).await {
            Ok((status, body)) => inyon_core::hosts::node_update::latest_release_from(status, &body).ok().filter(|n| newer_release(n, &version)),
            Err(_) => None,
        };
        Check { latest, behind: None, can_update: true, reason: None, checked_at: now, binary: true }
    }

    fn check(self: &Rc<Self>) -> LocalBoxFuture<'static, Check> {
        let me = self.clone();
        Box::pin(async move {
            let now = (me.o.now)();
            let Some(repo) = me.o.repo.clone() else { return Self::check_release((me.o.get.clone(), me.o.version.clone(), now)).await };
            let run = me.o.run.clone();
            let co = check_checkout(&repo, &run).await;
            let (mut latest, mut behind) = (None, None);
            if co.git {
                run(v(&["git", "fetch", "--tags", "--force", "--quiet"]), repo.clone()).await;
                let tags = run(v(&["git", "tag", "--list", "v*"]), repo.clone()).await.1;
                latest = newest_release(tags.split('\n'), &me.o.version);
                let count = run(v(&["git", "rev-list", "--count", "HEAD..@{u}"]), repo.clone()).await;
                if count.0 == 0 && !count.1.is_empty() && count.1.bytes().all(|b| b.is_ascii_digit()) {
                    behind = count.1.parse().ok();
                }
            }
            Check { latest, behind, can_update: co.reason.is_none(), reason: co.reason, checked_at: (me.o.now)(), binary: false }
        })
    }

    /// what an update from Settings is doing, or how the last one ended
    async fn job_state(&self) -> Map<String, Value> {
        let mut out = Map::new();
        let now = (self.o.now)();
        let started = |j: &Map<String, Value>| j.get("started").and_then(Value::as_f64).unwrap_or(f64::NAN);
        let s = |j: &Map<String, Value>, k: &str| j.get(k).filter(|v| crate::http::truthy(Some(v))).map(crate::http::js_string);
        let log = Value::String(self.log_file.to_string_lossy().into_owned());
        if self.binary() {
            let job = self.read_job();
            let line = std::fs::read_to_string(&self.o.status_file).map(|t| t.trim().to_owned()).unwrap_or_default();
            let Some(job) = job.filter(|j| !crate::http::truthy(j.get("done"))) else { return out };
            if let Some(e) = s(&job, "error") {
                out.insert("error".into(), json!(e));
                out.insert("log".into(), log);
            } else if let Some(why) = line.strip_prefix("failed:") {
                out.insert("error".into(), json!(why.trim()));
                out.insert("log".into(), log);
            } else if line == "running" || (now as f64 - started(&job)) < 10_000.0 {
                // `inyon update` restarts this hub when it's done; until then it says running
                out.insert("running".into(), json!(true));
            }
            return out;
        }
        let Some(job) = self.read_job() else { return out };
        if let Some(e) = s(&job, "error") {
            out.insert("error".into(), json!(e));
            out.insert("log".into(), log);
            return out;
        }
        if crate::http::truthy(job.get("done")) {
            // updated without a unit to restart: the hub still runs the code it started with
            let repo = self.o.repo.clone().unwrap_or_default();
            let head = (self.o.run)(v(&["git", "rev-parse", "--short", "HEAD"]), repo).await.1;
            if !crate::http::truthy(job.get("restarted")) && !self.o.commit.is_empty() && !head.is_empty() && head != self.o.commit {
                out.insert("restartNeeded".into(), json!(true));
            }
            return out;
        }
        let pid = job.get("pid").and_then(Value::as_f64).filter(|p| *p > 0.0);
        let running = match pid {
            Some(p) => (self.o.alive)(p as u32),
            None => (now as f64 - started(&job)) < 10_000.0,
        };
        if running {
            out.insert("running".into(), json!(true));
        } else if job.get("step").and_then(Value::as_str) != Some("restart") {
            // the restart stops the script along with the old hub; earlier than that it was cut short
            out.insert("error".into(), json!("The last update stopped before it finished."));
            out.insert("log".into(), log);
        }
        out
    }

    pub async fn status(self: &Rc<Self>, refresh: bool) -> Value {
        let stale = self.cache.borrow().as_ref().is_none_or(|c| (self.o.now)().saturating_sub(c.checked_at) > CHECK_EVERY);
        if refresh || stale {
            let shared = {
                let mut checking = self.checking.borrow_mut();
                checking.get_or_insert_with(|| self.check().shared()).clone()
            };
            let c = shared.await;
            *self.checking.borrow_mut() = None;
            *self.cache.borrow_mut() = Some(c);
        }
        let c = self.cache.borrow().clone().unwrap_or_default();
        let mut m = Map::new();
        m.insert("current".into(), json!(self.o.version));
        if let Some(l) = &c.latest {
            m.insert("latest".into(), json!(l));
        }
        if let Some(b) = c.behind {
            m.insert("behind".into(), json!(b));
        }
        m.insert("canUpdate".into(), json!(c.can_update));
        if let Some(r) = &c.reason {
            m.insert("reason".into(), json!(r));
        }
        m.insert("checkedAt".into(), json!(c.checked_at));
        for (k, v) in self.job_state().await {
            m.insert(k, v);
        }
        Value::Object(m)
    }

    pub async fn start(self: &Rc<Self>) -> Result<Option<u32>, Refused> {
        if self.job_state().await.contains_key("running") {
            return Err(Refused(409, "An update is already running.".into()));
        }
        let fresh = || inyon_core::js::stringify(&json!({ "started": (self.o.now)(), "step": "start" }));
        let Some(repo) = self.o.repo.clone() else {
            let _ = std::fs::create_dir_all(&self.o.data_dir);
            let _ = write_private(&self.job_file, &fresh());
            // runs on its own (see detach in apps/cli/src/service.rs), since it restarts this hub
            let r = (self.o.run)(vec![self.o.program.clone(), "update".into(), "--background".into()], self.o.data_dir.clone()).await;
            if r.0 != 0 {
                let why = if r.1.is_empty() { "Couldn't start the update.".to_owned() } else { r.1 };
                write_job(&self.job_file, json!({ "error": why }));
                return Err(Refused(500, why));
            }
            *self.cache.borrow_mut() = None;
            return Ok(None);
        };
        let co = check_checkout(&repo, &self.o.run).await;
        if let Some(why) = co.reason {
            return Err(Refused(409, why));
        }
        let _ = std::fs::create_dir_all(&self.o.data_dir);
        // written before the script starts, which then adds its progress
        let _ = write_private(&self.job_file, &fresh());
        let script = repo.join("apps/hub/src/cli/update.ts").to_string_lossy().into_owned();
        let cmd = vec!["bun".to_owned(), script, "--repo".into(), repo.to_string_lossy().into_owned(), "--job".into(), self.job_file.to_string_lossy().into_owned()];
        let Some(pid) = (self.o.spawn)(cmd, &repo, &self.log_file) else {
            write_job(&self.job_file, json!({ "error": "Couldn't start the update." }));
            return Err(Refused(500, "Couldn't start the update.".into()));
        };
        write_job(&self.job_file, json!({ "pid": pid }));
        *self.cache.borrow_mut() = None;
        Ok(Some(pid))
    }

    pub async fn post(self: &Rc<Self>) -> Resp {
        match self.start().await {
            Ok(_) => answer_json(202, &json!({ "started": true })),
            Err(Refused(status, why)) => answer_json(status, &json!({ "error": why })),
        }
    }

    /// The route, behind sign-in.
    pub fn add(self: &Rc<Self>, routes: &mut Routes) {
        let (a, b) = (self.clone(), self.clone());
        let get = raw(move |r: Req| {
            let u = a.clone();
            async move { answer_json(200, &u.status(r.query_has("refresh")).await) }
        });
        let post = raw(move |_r: Req| {
            let u = b.clone();
            async move { u.post().await }
        });
        crate::server::guarded_raw(routes, "/api/hub/update", vec![(axum::http::Method::GET, get), (axum::http::Method::POST, post)]);
    }
}

#[cfg(test)]
#[path = "hub_update_tests.rs"]
mod tests;
