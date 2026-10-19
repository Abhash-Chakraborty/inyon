//! Port of features/pages.ts: the sites agents make (Blueprint plans, mockups) listed from
//! ~/.inyon/pages.json and served from this machine's disk under `/v/<token>/<path>`.
//!
//! inyon-core's `features::pages_core` holds the rules both hubs share (tokens, paths, headers);
//! this file adds what only a running hub has: the list file, the epochs that revoke links,
//! progress summaries, the API the app calls, and the `/v/` answer. The list file is the source of
//! truth. `inyon pages add` and Blueprint's publish script write it with no hub running, and the
//! hub reads it again whenever it changes.
//!
//! Threading. The core thread checks the token and resolves the path (with `tokio::fs`, whose
//! reads run on the blocking pool); the answer for a file leaves the core carrying only its path,
//! and the axum handler streams it (`file_body`), so a multi-MB image never holds up the core.

use std::cell::RefCell;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::rc::Rc;

use axum::body::{Body, Bytes};
use axum::http::{header, HeaderName, HeaderValue, Method, StatusCode};
use inyon_core::features::pages_core::{
    decide_view, is_slug, mint_token, pages_key, progress_summary, site_path_problem, slugify, unique_slug, view_origin, FileStat, VerifyContext, ViewContext, ViewDecision,
    ViewFs, ViewRequest, BAD_SLUG, LOCAL_HOST, NO_INDEX,
};
use inyon_core::hosts::http_error::{http, HubError, HubResult};
use inyon_core::js::text::JsStr;
use inyon_core::platform::store::kv;
use inyon_protocol::PageProgress;
use serde_json::{json, Map, Number, Value};

use crate::http::{ok, ok_json, Req, Resp};
use crate::server::{guarded, h, Routes};

/// The store key (a file in the hub's data folder) that keeps each site's epoch, `{"<host>/<slug>": n}`.
pub const EPOCHS_KEY: &str = "page-epochs";
/// The store key that keeps what pages.json listed at the last read, `{"<host>/<slug>": added}`.
pub const LISTED_KEY: &str = "page-listed";
/// A lock older than this was left by a writer that died, and is taken over.
pub const LOCK_STALE_MS: u64 = 10_000;
/// How long a progress summary is kept before progress.json is read again.
pub const PROGRESS_TTL_MS: u64 = 30_000;
/// Bigger progress files aren't read for the list.
const PROGRESS_MAX: u64 = 1024 * 1024;

pub const UNKNOWN_PAGE: &str = "Unknown page";
pub const OTHER_MACHINE: &str = "Pages can only be added on the hub's own machine for now";
pub const BROKEN_FILE: &str = "~/.inyon/pages.json isn't a page list Inyon can read. Fix it or delete it, then try again.";
pub const LOCKED: &str = "Another program is changing ~/.inyon/pages.json. Try again in a moment.";

/// `~/.inyon/pages.json`: always under the home folder (not INYON_DATA_DIR), where the CLI and Blueprint write it.
pub fn pages_file(home: &Path) -> PathBuf {
    home.join(".inyon").join("pages.json")
}

/// One entry of the list as the file has it, when every field has its type and the slug is a slug.
#[derive(Debug, Clone, PartialEq)]
pub struct Record {
    pub slug: String,
    pub name: String,
    pub path: String,
    pub project: String,
    pub by: String,
    /// unix ms, kept as the file wrote it
    pub added: Number,
}

fn as_record(v: &Value) -> Option<Record> {
    let o = v.as_object()?;
    let s = |k: &str| o.get(k).and_then(Value::as_str).map(str::to_owned);
    let slug = s("slug").filter(|x| is_slug(x))?;
    let added = match o.get("added") {
        Some(Value::Number(n)) if n.as_f64().is_some_and(f64::is_finite) => n.clone(),
        _ => return None,
    };
    Some(Record { slug, name: s("name")?, path: s("path")?, project: s("project")?, by: s("by")?, added })
}

fn record_json(r: &Record) -> Value {
    json!({ "slug": r.slug, "name": r.name, "path": r.path, "project": r.project, "by": r.by, "added": Value::Number(r.added.clone()) })
}

fn real_or(p: &str) -> String {
    std::fs::canonicalize(p).map(|r| r.to_string_lossy().into_owned()).unwrap_or_else(|_| p.to_owned())
}

/// The file's text as `{v: 1, pages: [...]}`, or None when it isn't one.
fn parse(text: &str) -> Option<Map<String, Value>> {
    let v = inyon_core::js::json::parse(text)?;
    let o = v.as_object()?;
    (o.get("v").and_then(Value::as_f64) == Some(1.0) && o.get("pages").is_some_and(Value::is_array)).then(|| o.clone())
}

fn now_wall() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

// ---------- the list file ----------

/// What a `Registry` calls with the list each time it reads it again.
pub type OnList = Box<dyn Fn(&[Record])>;

/// ~/.inyon/pages.json, read when its size, mtime or inode changed since the last read. Only the
/// pages that may be served come out of `records()`: well-formed entries whose folder passes the
/// path rules, written and real, with the first of any repeated slug. A missing file is an empty
/// list. Writes go through `update()`, under `pages.json.lock` (created exclusively, taken over
/// after LOCK_STALE_MS), to a temp file renamed over the old one, keeping entries this hub can't
/// read as they were.
///
/// `on_list` hears the list each time it is read again (`Listed` keeps track of what went away).
pub struct Registry {
    pub file: PathBuf,
    home: String,
    real_home: String,
    seen: RefCell<String>,
    cached: RefCell<Vec<Record>>,
    broken: RefCell<bool>,
    on_list: OnList,
}

impl Registry {
    pub fn new(file: PathBuf, home: &Path) -> Registry {
        Registry::watched(file, home, Box::new(|_| {}))
    }

    pub fn watched(file: PathBuf, home: &Path, on_list: OnList) -> Registry {
        let home = home.to_string_lossy().into_owned();
        Registry { file, real_home: real_or(&home), home, seen: RefCell::new(String::new()), cached: RefCell::new(vec![]), broken: RefCell::new(false), on_list }
    }

    fn settle(&self, next: Vec<Record>) {
        *self.cached.borrow_mut() = next;
        (self.on_list)(&self.cached.borrow());
    }

    /// What is wrong with a folder as a page, by the path as written and by where it really leads.
    pub fn folder_problem(&self, p: &str) -> Option<&'static str> {
        site_path_problem(p, &self.home).or_else(|| site_path_problem(&real_or(p), &self.real_home))
    }

    fn load(&self) {
        let Ok(st) = std::fs::metadata(&self.file) else {
            self.seen.borrow_mut().clear();
            *self.broken.borrow_mut() = false;
            self.settle(vec![]);
            return;
        };
        let stamp = format!("{}:{}:{:?}", ino(&st), st.len(), st.modified().ok());
        if *self.seen.borrow() == stamp {
            return;
        }
        *self.seen.borrow_mut() = stamp;
        let text = std::fs::read(&self.file).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default();
        let parsed = parse(&text);
        *self.broken.borrow_mut() = parsed.is_none();
        let mut out: Vec<Record> = vec![];
        let pages = parsed.as_ref().and_then(|p| p.get("pages")).and_then(Value::as_array).cloned().unwrap_or_default();
        for raw in &pages {
            let Some(r) = as_record(raw) else { continue };
            if out.iter().any(|x| x.slug == r.slug) || self.folder_problem(&r.path).is_some() {
                continue;
            }
            out.push(r);
        }
        self.settle(out);
    }

    pub fn records(&self) -> Vec<Record> {
        self.load();
        self.cached.borrow().clone()
    }

    pub fn find(&self, slug: &str) -> Option<Record> {
        self.records().into_iter().find(|r| r.slug == slug)
    }

    /// Whether the file is there but isn't a list this hub can read (writes are refused then).
    pub fn broken(&self) -> bool {
        self.load();
        *self.broken.borrow()
    }

    /// Changes the file under its lock. `change` gets every entry as written (readable or not) and
    /// returns the new list, or None to leave the file alone, with its result.
    pub async fn update<T>(&self, change: impl FnOnce(&[Value]) -> HubResult<(Option<Vec<Value>>, T)>) -> HubResult<T> {
        let file = self.file.clone();
        with_lock(&lock_of(&self.file), 3000, move || {
            let current = match std::fs::read(&file) {
                Ok(b) => parse(&String::from_utf8_lossy(&b)).ok_or_else(|| http(500, BROKEN_FILE))?,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => json!({ "v": 1, "pages": [] }).as_object().cloned().unwrap_or_default(),
                Err(e) => return Err(HubError::plain(e.to_string())),
            };
            let pages = current.get("pages").and_then(Value::as_array).cloned().unwrap_or_default();
            let (next, result) = change(&pages)?;
            if let Some(next) = next {
                let mut out = current;
                out.insert("v".into(), json!(1));
                out.insert("pages".into(), Value::Array(next));
                write_atomic(&file, &format!("{}\n", inyon_core::js::json::stringify_pretty(&Value::Object(out)))).map_err(|e| HubError::plain(e.to_string()))?;
            }
            Ok(result)
        })
        .await
    }
}

#[cfg(unix)]
fn ino(m: &std::fs::Metadata) -> u64 {
    std::os::unix::fs::MetadataExt::ino(m)
}
#[cfg(not(unix))]
fn ino(_: &std::fs::Metadata) -> u64 {
    0
}

fn lock_of(file: &Path) -> PathBuf {
    let mut s = file.as_os_str().to_owned();
    s.push(".lock");
    PathBuf::from(s)
}

fn private_dir(dir: &Path) -> std::io::Result<()> {
    let mut b = std::fs::DirBuilder::new();
    b.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut b, 0o700);
    b.create(dir)
}

fn create_private(p: &Path, exclusive: bool) -> std::io::Result<std::fs::File> {
    let mut o = std::fs::OpenOptions::new();
    o.write(true);
    if exclusive {
        o.create_new(true);
    } else {
        o.create(true).truncate(true);
    }
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut o, 0o600);
    o.open(p)
}

/// Writes beside the file and renames over it, so a reader never sees half a list.
fn write_atomic(file: &Path, text: &str) -> std::io::Result<()> {
    use std::io::Write;
    if let Some(dir) = file.parent() {
        private_dir(dir)?;
    }
    let mut tmp = file.as_os_str().to_owned();
    tmp.push(format!(".{}.tmp", std::process::id()));
    let tmp = PathBuf::from(tmp);
    let r = (|| {
        create_private(&tmp, false)?.write_all(text.as_bytes())?;
        std::fs::rename(&tmp, file)
    })();
    let _ = std::fs::remove_file(&tmp);
    r
}

/// Runs `f` holding `lock`: an exclusive create, waiting up to `wait` ms, taking over a lock older than LOCK_STALE_MS.
pub async fn with_lock<T>(lock: &Path, wait: u64, f: impl FnOnce() -> HubResult<T>) -> HubResult<T> {
    use std::io::Write;
    if let Some(dir) = lock.parent() {
        private_dir(dir).map_err(|e| HubError::plain(e.to_string()))?;
    }
    let until = now_wall() + wait;
    loop {
        match create_private(lock, true) {
            Ok(mut fd) => {
                let _ = fd.write_all(format!("{}\n", std::process::id()).as_bytes());
                break;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(HubError::plain(e.to_string())),
        }
        match std::fs::metadata(lock).and_then(|m| m.modified()) {
            Ok(t) => {
                let age = std::time::SystemTime::now().duration_since(t).map_or(0, |d| d.as_millis() as u64);
                if age > LOCK_STALE_MS {
                    let _ = std::fs::remove_file(lock);
                    continue;
                }
            }
            Err(_) => continue,
        }
        if now_wall() >= until {
            return Err(http(503, LOCKED));
        }
        inyon_core::platform::rt::sleep(25).await;
    }
    let r = f();
    let _ = std::fs::remove_file(lock);
    r
}

// ---------- epochs ----------

/// Each site's epoch, kept in the hub's data folder. A token carries the epoch it was made at, so
/// moving it on (Revoke, or removing the page) ends every link made before.
pub struct Epochs(RefCell<Map<String, Value>>);

impl Epochs {
    pub fn load() -> Epochs {
        let mut m = Map::new();
        if let Some(Value::Object(raw)) = kv::get_value(EPOCHS_KEY) {
            for (k, v) in raw {
                if let Some(n) = safe_int(&v) {
                    m.insert(k, json!(n));
                }
            }
        }
        Epochs(RefCell::new(m))
    }

    pub fn of(&self, host: &str, slug: &str) -> u64 {
        self.0.borrow().get(&format!("{host}/{slug}")).and_then(Value::as_u64).unwrap_or(0)
    }

    pub fn bump(&self, host: &str, slug: &str) -> u64 {
        let n = self.of(host, slug) + 1;
        let all = {
            let mut m = self.0.borrow_mut();
            m.insert(format!("{host}/{slug}"), json!(n));
            Value::Object(m.clone())
        };
        if let Err(e) = kv::set_value(EPOCHS_KEY, &all) {
            inyon_core::platform::console::error(&format!("couldn't save the page epochs: {e}"));
        }
        n
    }
}

/// `Number.isSafeInteger(v) && v >= 0`
fn safe_int(v: &Value) -> Option<u64> {
    let n = v.as_f64()?;
    (n.fract() == 0.0 && (0.0..=9_007_199_254_740_991.0).contains(&n)).then_some(n as u64)
}

/// What the list held when the hub last read it, `{"<host>/<slug>": added}`, kept in the hub's data
/// folder. The CLI and Blueprint take pages off the list without the hub, even while it is stopped;
/// when a slug has gone, or now names a page added at another time, `gone` hears of it so its old
/// links end before a page added again under the same slug could open them.
pub struct Listed {
    last: RefCell<Map<String, Value>>,
    gone: Box<dyn Fn(&str)>,
}

impl Listed {
    pub fn load(gone: Box<dyn Fn(&str)>) -> Listed {
        let mut last = Map::new();
        if let Some(Value::Object(raw)) = kv::get_value(LISTED_KEY) {
            for (k, v) in raw {
                if v.is_number() {
                    last.insert(k, v);
                }
            }
        }
        Listed { last: RefCell::new(last), gone }
    }

    pub fn saw(&self, records: &[Record]) {
        let mut next = Map::new();
        for r in records {
            next.insert(format!("{LOCAL_HOST}/{}", r.slug), Value::Number(r.added.clone()));
        }
        let gone: Vec<String> = {
            let last = self.last.borrow();
            let mut changed = next.len() != last.len();
            let mut gone = vec![];
            for (k, added) in last.iter() {
                if next.get(k).is_some_and(|n| same_number(n, added)) {
                    continue;
                }
                changed = true;
                if let Some(slug) = k.strip_prefix(&format!("{LOCAL_HOST}/")) {
                    gone.push(slug.to_owned());
                }
            }
            if !changed {
                return;
            }
            gone
        };
        for slug in gone {
            (self.gone)(&slug);
        }
        if let Err(e) = kv::set_value(LISTED_KEY, &Value::Object(next.clone())) {
            inyon_core::platform::console::error(&format!("couldn't save the pages listed: {e}"));
        }
        *self.last.borrow_mut() = next;
    }
}

/// `===` on two JSON numbers, as JavaScript compares them.
fn same_number(a: &Value, b: &Value) -> bool {
    a.as_f64().is_some_and(|x| b.as_f64() == Some(x))
}

// ---------- progress ----------

/// progress.json summaries by folder, each read at most once every PROGRESS_TTL_MS.
#[derive(Default)]
pub struct ProgressCache(RefCell<HashMap<String, (u64, Option<PageProgress>)>>);

impl ProgressCache {
    pub fn of(&self, folder: &str, now: u64) -> Option<PageProgress> {
        if let Some((at, v)) = self.0.borrow().get(folder) {
            if now.saturating_sub(*at) < PROGRESS_TTL_MS {
                return v.clone();
            }
        }
        let file = Path::new(folder).join("progress.json");
        let value = std::fs::metadata(&file)
            .ok()
            .filter(|m| m.len() <= PROGRESS_MAX)
            .and_then(|_| std::fs::read(&file).ok())
            .and_then(|b| inyon_core::js::json::parse(&String::from_utf8_lossy(&b)))
            .and_then(|d| progress_summary(&d));
        self.0.borrow_mut().insert(folder.to_owned(), (now, value.clone()));
        value
    }

    pub fn drop_folder(&self, folder: &str) {
        self.0.borrow_mut().remove(folder);
    }
}

// ---------- disk ----------

/// decide_view's disk through tokio::fs (its calls run on the blocking pool); both follow symlinks.
pub struct DiskFs;

/// Node's `mtimeMs`: seconds times 1000 plus nanoseconds over a million, as a double.
pub fn mtime_ms(m: &std::fs::Metadata) -> f64 {
    match m.modified().ok().map(|t| t.duration_since(std::time::UNIX_EPOCH)) {
        Some(Ok(d)) => d.as_secs() as f64 * 1e3 + f64::from(d.subsec_nanos()) / 1e6,
        Some(Err(e)) => -(e.duration().as_secs_f64() * 1e3),
        None => 0.0,
    }
}

impl ViewFs for DiskFs {
    fn stat<'a>(&'a self, p: &'a Path) -> futures_util::future::LocalBoxFuture<'a, Option<FileStat>> {
        Box::pin(async move {
            let m = tokio::fs::metadata(p).await.ok()?;
            Some(FileStat { file: m.is_file(), dir: m.is_dir(), size: m.len(), mtime_ms: mtime_ms(&m) })
        })
    }
    fn realpath<'a>(&'a self, p: &'a Path) -> futures_util::future::LocalBoxFuture<'a, Option<PathBuf>> {
        Box::pin(async move { tokio::fs::canonicalize(p).await.ok() })
    }
}

/// The git top level of a folder, or the folder itself.
async fn project_of(folder: &str) -> String {
    let out = tokio::process::Command::new("git")
        .args(["-C", folder, "rev-parse", "--show-toplevel"])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .output()
        .await;
    match out {
        Ok(o) if o.status.success() => {
            let top = String::from_utf8_lossy(&o.stdout).jtrim().to_owned();
            if top.is_empty() {
                folder.to_owned()
            } else {
                top
            }
        }
        _ => folder.to_owned(),
    }
}

/// The name and slug in a site's `.inyon-page.json`, when it has usable ones.
fn marker_of(folder: &str) -> (Option<String>, Option<String>) {
    let Some(Value::Object(m)) = std::fs::read(Path::new(folder).join(".inyon-page.json")).ok().and_then(|b| inyon_core::js::json::parse(&String::from_utf8_lossy(&b))) else {
        return (None, None);
    };
    let name = m.get("name").and_then(Value::as_str).map(|n| n.jtrim()).filter(|n| !n.is_empty()).map(|n| n.to16(200).to_owned());
    let slug = m.get("slug").and_then(Value::as_str).filter(|s| is_slug(s)).map(str::to_owned);
    (name, slug)
}

// ---------- the feature ----------

/// What the feature keeps, on the core thread.
pub struct Pages {
    pub home: PathBuf,
    pub registry: Registry,
    pub epochs: Rc<Epochs>,
    pub progress: ProgressCache,
    pub now: Rc<dyn Fn() -> u64>,
}

impl Pages {
    pub fn new(home: PathBuf, now: Rc<dyn Fn() -> u64>) -> Pages {
        let epochs = Rc::new(Epochs::load());
        let bump = epochs.clone();
        // a page taken off the list by anyone (the CLI, Blueprint, a hand edit) ends its links
        let listed = Listed::load(Box::new(move |slug| {
            bump.bump(LOCAL_HOST, slug);
        }));
        let registry = Registry::watched(pages_file(&home), &home, Box::new(move |records| listed.saw(records)));
        Pages { registry, home, epochs, progress: ProgressCache::default(), now }
    }

    fn entry(&self, r: &Record) -> Value {
        let mut v = json!({ "host": LOCAL_HOST, "slug": r.slug, "name": r.name, "project": r.project, "by": r.by, "added": Value::Number(r.added.clone()), "folder": r.path });
        if let Some(p) = self.progress.of(&r.path, (self.now)()) {
            v["progress"] = serde_json::to_value(p).unwrap_or(Value::Null);
        }
        v
    }

    fn page(&self, host: &str, slug: &str) -> HubResult<Record> {
        let r = if host == LOCAL_HOST && is_slug(slug) { self.registry.find(slug) } else { None };
        r.ok_or_else(|| http(404, UNKNOWN_PAGE))
    }
}

thread_local! {
    static PAGES: RefCell<Option<Rc<Pages>>> = const { RefCell::new(None) };
}

/// The feature for this thread's hub: pages.json under `home`, epochs from the records.
pub fn init(home: PathBuf) {
    install(Pages::new(home, Rc::new(inyon_core::clock::now_ms)));
}

pub fn install(p: Pages) {
    PAGES.with(|x| *x.borrow_mut() = Some(Rc::new(p)));
}

pub fn pages() -> Rc<Pages> {
    PAGES.with(|x| x.borrow().clone()).expect("pages::init has run on this thread")
}

/// `readBody`: a JSON object of at most 16 KB ("{}" when empty).
async fn read_body(req: &mut Req) -> HubResult<Map<String, Value>> {
    const LIMIT: usize = 16 * 1024;
    // the TS counts the decoded text, in UTF-16 units; four bytes a unit is the most that can be
    let bytes = req.read_limited(LIMIT * 4, "Request too large").await.map_err(|e| if e.status == Some(413) { e } else { http(400, "Invalid JSON") })?;
    if req.header("content-length").is_some_and(|v| inyon_core::js::to_number(&v) > LIMIT as f64) {
        return Err(http(413, "Request too large"));
    }
    let text = String::from_utf8_lossy(&bytes);
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    if text.len16() > LIMIT {
        return Err(http(413, "Request too large"));
    }
    match inyon_core::js::json::parse(if text.is_empty() { "{}" } else { text }) {
        Some(Value::Object(m)) => Ok(m),
        _ => Err(http(400, "Invalid JSON")),
    }
}

pub async fn list(_req: Req) -> HubResult<Resp> {
    let p = pages();
    let all: Vec<Value> = p.registry.records().iter().map(|r| p.entry(r)).collect();
    Ok(ok_json(&json!({ "pages": all })))
}

pub async fn open(req: Req) -> HubResult<Resp> {
    let p = pages();
    let r = p.page(&req.param("host"), &req.param("slug"))?;
    let phone = crate::phones::phone_for(&req).map(|ph| ph.id);
    let (token, expires) = mint_token(&pages_key(&crate::password::session_secret()), LOCAL_HOST, &r.slug, p.epochs.of(LOCAL_HOST, &r.slug), phone.as_deref(), (p.now)());
    Ok(ok_json(&json!({ "url": format!("/v/{token}/"), "expires": expires })))
}

pub async fn revoke(req: Req) -> HubResult<Resp> {
    let p = pages();
    let r = p.page(&req.param("host"), &req.param("slug"))?;
    p.epochs.bump(LOCAL_HOST, &r.slug);
    Ok(ok())
}

pub async fn register(mut req: Req) -> HubResult<Resp> {
    let b = read_body(&mut req).await?;
    if req.param("host") != LOCAL_HOST {
        return Err(http(404, OTHER_MACHINE));
    }
    let p = pages();
    let given = b.get("path").and_then(Value::as_str).map(|s| s.jtrim().to_owned()).unwrap_or_default();
    let folder = if given.len16() > 1 { given.trim_end_matches(['/', '\\']).to_owned() } else { given };
    if let Some(problem) = p.registry.folder_problem(&folder) {
        return Err(http(400, problem));
    }
    let asked_slug = match b.get("slug") {
        None => None,
        Some(Value::String(s)) if is_slug(s) => Some(s.clone()),
        Some(_) => return Err(http(400, BAD_SLUG)),
    };
    let asked = match b.get("name") {
        None => None,
        Some(Value::String(n)) => Some(n.jtrim().to16(200).to_owned()),
        Some(_) => return Err(http(400, "The name must be text")),
    };
    if !std::fs::metadata(Path::new(&folder).join("index.html")).is_ok_and(|m| m.is_file()) {
        return Err(http(400, NO_INDEX));
    }
    let (marker_name, marker_slug) = marker_of(&folder);
    let asked = asked.filter(|a| !a.is_empty());
    let basename = folder.rsplit('/').next().unwrap_or("").to_owned();
    let name = asked.clone().or(marker_name).unwrap_or_else(|| basename.clone());
    let project = project_of(&folder).await;
    let now = (p.now)();
    let record = p
        .registry
        .update(|pages| {
            let records: Vec<Option<Record>> = pages.iter().map(as_record).collect();
            if let Some(i) = records.iter().position(|r| r.as_ref().is_some_and(|r| r.path == folder)) {
                let same = records[i].clone().expect("found");
                if asked_slug.as_ref().is_some_and(|s| *s != same.slug) {
                    return Err(http(409, format!("That folder is already a page, as \"{}\"", same.slug)));
                }
                let Some(asked) = asked.filter(|a| *a != same.name) else { return Ok((None, same)) };
                let mut next = pages.to_vec();
                if let Some(o) = next[i].as_object_mut() {
                    o.insert("name".into(), json!(asked));
                }
                return Ok((Some(next), Record { name: asked, ..same }));
            }
            let taken = |s: &str| records.iter().flatten().any(|r| r.slug == s) || pages.iter().any(|p| p.get("slug").and_then(Value::as_str) == Some(s));
            let slug = match &asked_slug {
                Some(s) if taken(s) => return Err(http(409, format!("There is already a page called \"{s}\" on this machine"))),
                Some(s) => s.clone(),
                None => unique_slug(&marker_slug.clone().unwrap_or_else(|| slugify(&basename)), taken),
            };
            let added = Record { slug, name: name.clone(), path: folder.clone(), project: project.clone(), by: "app".into(), added: Number::from(now) };
            let mut next = pages.to_vec();
            next.push(record_json(&added));
            Ok((Some(next), added))
        })
        .await?;
    p.progress.drop_folder(&record.path);
    Ok(ok_json(&p.entry(&record)))
}

pub async fn remove(req: Req) -> HubResult<Resp> {
    let (host, slug) = (req.param("host"), req.param("slug"));
    if host != LOCAL_HOST || !is_slug(&slug) {
        return Err(http(404, UNKNOWN_PAGE));
    }
    let p = pages();
    let gone = p
        .registry
        .update(|pages| {
            let keep: Vec<Value> = pages.iter().filter(|v| !(v.is_object() && v.get("slug").and_then(Value::as_str) == Some(slug.as_str()))).cloned().collect();
            if keep.len() == pages.len() {
                return Err(http(404, UNKNOWN_PAGE));
            }
            let gone: Vec<Record> = pages.iter().filter_map(as_record).filter(|r| r.slug == slug).collect();
            Ok((Some(keep), gone))
        })
        .await?;
    // links made before stay dead if the slug is used again (reading the list now reports the slug
    // gone, which moves the epoch on)
    p.registry.records();
    for r in gone {
        p.progress.drop_folder(&r.path);
    }
    Ok(ok())
}

/// The API routes, behind sign-in (a cookie, or a paired phone's bearer).
pub fn add(r: &mut Routes) {
    guarded(r, "/api/pages", vec![(Method::GET, h(list))]);
    guarded(r, "/api/pages/:host", vec![(Method::POST, h(register))]);
    guarded(r, "/api/pages/:host/:slug", vec![(Method::DELETE, h(remove))]);
    guarded(r, "/api/pages/:host/:slug/open", vec![(Method::POST, h(open))]);
    guarded(r, "/api/pages/:host/:slug/revoke", vec![(Method::POST, h(revoke))]);
}

// ---------- /v/ ----------

/// A 200's file, for the axum handler to stream once the answer is off the core thread.
#[derive(Debug, Clone)]
pub struct ViewFile {
    pub path: PathBuf,
    pub size: u64,
}

/// The answer to a `/v/` request. It never reads the Cookie or Authorization header and never
/// sets a cookie: the token in the path is the only credential. The Host is checked against the
/// names the hub answers to directly, since right_host() would let a signed-in cookie through.
pub async fn view(req: Req) -> Resp {
    let c = crate::server::ctx();
    let host = req.header("host");
    let forwarded = req.header("x-forwarded-host");
    let mut names: Vec<String> = host.iter().cloned().collect();
    if let Some(f) = &forwarded {
        names.extend(f.split(',').map(|h| h.trim().to_owned()));
    }
    let answered = !names.is_empty() && names.iter().all(|h| c.answers_to(h));
    let origin = if answered { view_origin(forwarded.as_deref().or(host.as_deref()), crate::index::secure_request(&req)) } else { None };
    let target = if req.query.is_empty() { req.path.clone() } else { format!("{}?{}", req.path, req.query) };
    let p = pages();
    let key = pages_key(&crate::password::session_secret());
    let epoch_of = |h: &str, s: &str| p.epochs.of(h, s);
    let phone_paired = |id: &str| crate::phones::phone_paired(id);
    let site_root = |h: &str, s: &str| if h == LOCAL_HOST { p.registry.find(s).map(|r| PathBuf::from(r.path)) } else { None };
    // read the list first, so a page removed since the last request has its epoch moved on before
    // its token is checked
    p.registry.records();
    let ctx = ViewContext { verify: VerifyContext { key: &key, now: (p.now)(), epoch_of: &epoch_of, phone_paired: &phone_paired }, site_root: &site_root, fs: &DiskFs };
    let inm = req.header("if-none-match");
    let method = req.method.as_str().to_owned();
    let d = decide_view(&ViewRequest { method: &method, target: &target, origin: origin.as_deref(), if_none_match: inm.as_deref() }, &ctx).await;
    respond(d, req.method == Method::HEAD)
}

fn respond(d: ViewDecision, head: bool) -> Resp {
    let mut res = Resp::new(Body::empty());
    *res.status_mut() = StatusCode::from_u16(d.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    for (k, v) in &d.headers {
        if let Ok(v) = HeaderValue::from_str(v) {
            res.headers_mut().append(HeaderName::from_static(k), v);
        }
    }
    match d.file {
        Some((path, size)) => {
            res.headers_mut().insert(header::CONTENT_LENGTH, HeaderValue::from(size));
            if !head {
                res.extensions_mut().insert(ViewFile { path, size });
            }
        }
        None if !head && !d.body.is_empty() => *res.body_mut() = Body::from(d.body),
        None => {}
    }
    res
}

/// A file's bytes as a body, read with tokio::fs in 64 KB pieces, at most `size` of them. A file
/// that went away or got shorter since it was checked ends the connection, as a failed stream
/// does in the Bun hub.
pub fn file_body(path: PathBuf, size: u64) -> Body {
    use tokio::io::AsyncReadExt;
    let s = futures_util::stream::unfold((None::<tokio::fs::File>, path, size), |(f, path, left)| async move {
        if left == 0 {
            return None;
        }
        let mut f = match f {
            Some(f) => f,
            None => match tokio::fs::File::open(&path).await {
                Ok(f) => f,
                Err(e) => return Some((Err(e), (None, path, 0))),
            },
        };
        let mut buf = vec![0u8; left.min(64 * 1024) as usize];
        match f.read(&mut buf).await {
            Ok(0) => Some((Err(std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "the file got shorter")), (None, path, 0))),
            Ok(n) => {
                buf.truncate(n);
                Some((Ok(Bytes::from(buf)), (Some(f), path, left - n as u64)))
            }
            Err(e) => Some((Err(e), (None, path, 0))),
        }
    });
    Body::from_stream(s)
}

#[cfg(test)]
#[path = "pages_tests.rs"]
mod tests;
