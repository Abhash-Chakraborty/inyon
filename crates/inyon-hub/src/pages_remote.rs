//! Pages on the hub's other machines: a laptop joined to it, a server it reaches over SSH. Their
//! own `inyon` does the reading, as for Temp files (features/temp.rs): `inyon pages --json` lists a
//! machine's pages with their progress, and `inyon pages get --json` says what one request for a
//! page's file needs to know and sends the file. The hub decides every answer with the same
//! `decide_view` as for its own pages, over what the machine listed, so the rules (dot names,
//! symlinks out of the site, folders and their slash, the cache) are the same on every machine.
//!
//! A machine with an inyon from before 0.22 lists no pages here: its list doesn't say `serves`.
//!
//! From 0.22.3 the machine's inyon also runs `inyon pages watch` for the hub while pages are being
//! looked at: it prints the list again only when something changes, with a stamp per site, so the
//! hub stops reading the list every 15 s and serves a file it already has until its site's stamp
//! moves on. Files then come as base64 lines over a stream (`pages get --lines`), which lifts the
//! 8 MB cap to 64 MB. A machine whose inyon has no `watch` is asked the old way.

use std::cell::{Cell, RefCell};
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::rc::Rc;

use futures_util::future::{join_all, LocalBoxFuture};
use inyon_core::features::pages_core::{FileStat, ViewFs};
use inyon_core::features::temp::{read_answer, INYON_PAGES};
use inyon_core::hosts::host::{shq, ExecOptions, Host, StreamHandle};
use inyon_core::hosts::http_error::{http, HubResult};
use inyon_core::hosts::registry::registry;
use inyon_core::platform::rt;
use inyon_protocol::{HostKind, HostStatus};
use serde_json::{Map, Value};

use crate::pages::{as_record, Record};

/// How long a machine's list is kept before it's read again.
pub const REMOTE_TTL_MS: u64 = 15_000;
/// The biggest file the hub fetches from another machine; a bigger one is a 413. It comes back as
/// base64 inside one JSON message, so it has to stay well under the sockets' 16 MiB.
pub const REMOTE_FILE_MAX: u64 = 8 * 1024 * 1024;
/// The biggest file the hub fetches from a machine that streams it (`pages get --lines`).
pub const STREAM_FILE_MAX: u64 = 64 * 1024 * 1024;
/// How long the hub waits on the machine, in ms.
const LIST_WAIT: u64 = 20_000;
const GET_WAIT: u64 = 60_000;
/// A machine's watch stops after this long with nobody asking for its pages, in ms.
pub const WATCH_IDLE_MS: u64 = 5 * 60_000;
/// How long the hub waits before trying `pages watch` again on a machine whose inyon didn't have it.
pub const NO_WATCH_MS: u64 = 10 * 60_000;
/// The most bytes of other machines' files the hub keeps.
pub const FILE_CACHE_MAX: usize = 64 * 1024 * 1024;

/// A page on another machine, as its list says.
#[derive(Debug, Clone, PartialEq)]
pub struct RemotePage {
    pub record: Record,
    /// what its progress.json counts, as the machine read it
    pub progress: Option<Value>,
    /// the Markdown files in its `research/` folder, as the machine listed them
    pub notes: Vec<String>,
}

/// A path from another machine as the hub joins and compares paths: Windows' backslashes as slashes.
pub fn slashed(p: &str) -> PathBuf {
    PathBuf::from(p.replace('\\', "/"))
}

/// The machines whose pages the hub shows besides its own: connected, and not the hub's machine.
pub fn machines() -> Vec<String> {
    registry().configs().into_iter().filter(|c| c.kind != HostKind::Local && machine(&c.id).is_some()).map(|c| c.id).collect()
}

/// A connected machine's connection and name.
fn machine(id: &str) -> Option<(Host, String)> {
    let rt = registry().get(id)?;
    let r = rt.borrow();
    let connected = r.state.status == HostStatus::Online && r.probe.as_ref().is_some_and(|p| !p.borrow().home.is_empty());
    connected.then(|| (r.host.clone(), r.host.config().name))
}

async fn run(id: &str, args: &str, wait: u64) -> HubResult<Map<String, Value>> {
    let (host, name) = machine(id).ok_or_else(|| http(503, "Machine is not connected yet"))?;
    let r = host.exec(&format!("{INYON_PAGES} {args}"), ExecOptions { input: None, timeout_ms: Some(wait) }).await?;
    let m = read_answer(&name, &r)?;
    if m.get("ok") == Some(&Value::Bool(false)) {
        let e = m.get("error").and_then(Value::as_str).unwrap_or("The machine refused");
        return Err(http(400, e));
    }
    Ok(m)
}

/// A machine's pages, read now. None when it couldn't be asked; empty when its inyon is too old
/// to serve them.
pub async fn read_list(id: &str) -> Option<Vec<RemotePage>> {
    let m = run(id, "--json", LIST_WAIT).await.ok()?;
    Some(pages_in(&m).into_iter().map(|(p, _)| p).collect())
}

/// The pages in a machine's list (`pages --json` or a `pages watch` line), each with its site's
/// stamp when the line has one. Empty when its inyon is too old to serve them. Entries with a
/// problem (the folder gone, no index.html) are left out, as the hub leaves out its own.
pub fn pages_in(m: &Map<String, Value>) -> Vec<(RemotePage, Option<String>)> {
    if m.get("serves") != Some(&Value::Bool(true)) {
        return vec![];
    }
    let mut out: Vec<(RemotePage, Option<String>)> = vec![];
    for p in m.get("pages").and_then(Value::as_array).into_iter().flatten() {
        let Some(record) = as_record(p).filter(|_| p.get("problem").is_none()) else { continue };
        if out.iter().any(|(x, _)| x.record.slug == record.slug) {
            continue;
        }
        let stamp = p.get("stamp").and_then(Value::as_str).map(str::to_owned);
        // a name the hub wouldn't list for its own pages is left out
        let notes = p
            .get("notes")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .filter(|n| crate::pages::is_note(n))
            .take(crate::pages::NOTES_MAX)
            .map(str::to_owned)
            .collect();
        out.push((RemotePage { record, progress: p.get("progress").filter(|v| v.is_object()).cloned(), notes }, stamp));
    }
    out
}

/// What a machine's `inyon pages watch` has said so far.
#[derive(Default)]
pub struct Watched {
    /// its last list, once it printed one
    pub list: Option<Vec<RemotePage>>,
    /// each page's site stamp, when the site is small enough to have one
    pub stamps: HashMap<String, String>,
    /// it has stopped (the machine went, the hub stopped it, or its inyon has no `watch`)
    pub ended: bool,
    /// when the hub last asked for this machine's pages
    pub used: u64,
}

impl Watched {
    /// One line the watch printed.
    pub fn line(&mut self, line: &str) {
        let Ok(Value::Object(m)) = serde_json::from_str::<Value>(line) else { return };
        let pages = pages_in(&m);
        self.stamps = pages.iter().filter_map(|(p, st)| Some((p.record.slug.clone(), st.clone()?))).collect();
        self.list = Some(pages.into_iter().map(|(p, _)| p).collect());
    }
}

struct Watch {
    handle: StreamHandle,
    state: Rc<RefCell<Watched>>,
}

/// Files other machines sent for pages they watch, each with its site's stamp when it came: kept
/// while the stamp stays the same, oldest dropped first past FILE_CACHE_MAX.
#[derive(Default)]
struct Files {
    entries: VecDeque<(String, String, Rc<Listing>)>,
    bytes: usize,
}

impl Files {
    fn size(l: &Listing) -> usize {
        l.file.as_ref().map_or(0, |(_, b)| b.len())
    }

    fn get(&self, key: &str, stamp: &str) -> Option<Rc<Listing>> {
        self.entries.iter().find(|(k, st, _)| k == key && st == stamp).map(|(_, _, l)| l.clone())
    }

    fn put(&mut self, key: String, stamp: String, l: Rc<Listing>) {
        self.drop_where(|k| k == key);
        let size = Files::size(&l);
        if size > FILE_CACHE_MAX {
            return;
        }
        while self.bytes + size > FILE_CACHE_MAX {
            let Some((_, _, old)) = self.entries.pop_front() else { break };
            self.bytes -= Files::size(&old);
        }
        self.bytes += size;
        self.entries.push_back((key, stamp, l));
    }

    fn drop_where(&mut self, gone: impl Fn(&str) -> bool) {
        let bytes = &mut self.bytes;
        self.entries.retain(|(k, _, l)| {
            let keep = !gone(k);
            if !keep {
                *bytes -= Files::size(l);
            }
            keep
        });
    }
}

/// The cache key for one request's file: the machine, the page and the path asked for.
pub fn file_key(id: &str, slug: &str, segments: &[String], slash: bool) -> String {
    format!("{id}\0{slug}\0{}\0{slash}", segments.join("/"))
}

/// Each machine's list as last read, and when; the watches running; the files kept.
#[derive(Default)]
pub struct RemoteLists {
    read: RefCell<HashMap<String, (u64, Vec<RemotePage>)>>,
    watches: RefCell<HashMap<String, Watch>>,
    /// machines whose inyon had no `pages watch`, and until when the hub doesn't ask again
    no_watch: RefCell<HashMap<String, u64>>,
    files: RefCell<Files>,
    /// how many watches were started, for the tests
    started: Cell<u32>,
}

impl RemoteLists {
    /// One machine's pages: its watch's latest list while one runs, else read again when older
    /// than REMOTE_TTL_MS. A machine that doesn't answer keeps its last list until the next try.
    /// `saw` hears each list.
    pub async fn of(&self, id: &str, now: u64, saw: &dyn Fn(&str, &[Record])) -> Vec<RemotePage> {
        self.watch(id, now);
        if let Some(list) = self.watched_list(id, now) {
            saw(id, &list.iter().map(|p| p.record.clone()).collect::<Vec<_>>());
            return list;
        }
        let cached = self.read.borrow().get(id).cloned();
        if let Some((at, list)) = &cached {
            if now.saturating_sub(*at) < REMOTE_TTL_MS {
                return list.clone();
            }
        }
        let list = match read_list(id).await {
            Some(l) => {
                saw(id, &l.iter().map(|p| p.record.clone()).collect::<Vec<_>>());
                l
            }
            None => cached.map(|(_, l)| l).unwrap_or_default(),
        };
        self.read.borrow_mut().insert(id.to_owned(), (now, list.clone()));
        list
    }

    /// Starts the machine's `pages watch` unless one runs, or its inyon recently had none.
    fn watch(&self, id: &str, now: u64) {
        if self.watches.borrow().contains_key(id) || self.no_watch.borrow().get(id).is_some_and(|until| now < *until) {
            return;
        }
        let Some((host, _)) = machine(id) else { return };
        let state = Rc::new(RefCell::new(Watched { used: now, ..Watched::default() }));
        let heard = state.clone();
        let Ok(handle) = host.stream(&format!("{INYON_PAGES} watch --json"), move |line| heard.borrow_mut().line(&line), false) else { return };
        self.started.set(self.started.get() + 1);
        let (ended, exited) = (state.clone(), handle.exited.clone());
        rt::spawn(async move {
            exited.wait().await;
            ended.borrow_mut().ended = true;
        });
        // nobody looking for a while: stop it, so the machine doesn't keep looking for nothing
        let (idle, stop) = (state.clone(), handle.clone());
        rt::spawn(async move {
            loop {
                rt::sleep(60_000).await;
                if idle.borrow().ended {
                    return;
                }
                if inyon_core::clock::now_ms().saturating_sub(idle.borrow().used) > WATCH_IDLE_MS {
                    stop.kill();
                    return;
                }
            }
        });
        self.watches.borrow_mut().insert(id.to_owned(), Watch { handle, state });
    }

    /// The running watch's list, once it has one. A watch that ended is cleared away here (with
    /// the files kept for its pages); one that ended without printing anything means the
    /// machine's inyon has no `watch`, and the hub doesn't try again for NO_WATCH_MS.
    fn watched_list(&self, id: &str, now: u64) -> Option<Vec<RemotePage>> {
        let ended = {
            let w = self.watches.borrow();
            let w = w.get(id)?;
            let mut st = w.state.borrow_mut();
            if !st.ended {
                st.used = now;
                return st.list.clone();
            }
            st.list.is_none()
        };
        self.watches.borrow_mut().remove(id);
        let prefix = format!("{id}\0");
        self.files.borrow_mut().drop_where(|k| k.starts_with(&prefix));
        if ended {
            self.no_watch.borrow_mut().insert(id.to_owned(), now + NO_WATCH_MS);
        }
        None
    }

    /// The machine's watch runs and has said what it serves: its inyon has `pages get --lines` too.
    pub fn watching(&self, id: &str) -> bool {
        self.watches.borrow().get(id).is_some_and(|w| {
            let st = w.state.borrow();
            !st.ended && st.list.is_some()
        })
    }

    /// A watched page's site stamp, when its site is small enough to have one.
    pub fn stamp(&self, id: &str, slug: &str) -> Option<String> {
        let w = self.watches.borrow();
        let st = w.get(id)?.state.borrow();
        if st.ended {
            return None;
        }
        st.stamps.get(slug).cloned()
    }

    /// A file kept for this request while its site's stamp is still `stamp`.
    pub fn kept(&self, key: &str, stamp: &str) -> Option<Rc<Listing>> {
        self.files.borrow().get(key, stamp)
    }

    pub fn keep(&self, key: String, stamp: String, l: Rc<Listing>) {
        self.files.borrow_mut().put(key, stamp, l);
    }

    /// How many `pages watch` were started.
    pub fn watches_started(&self) -> u32 {
        self.started.get()
    }

    /// Every connected machine's pages, those due read at the same time.
    pub async fn all(&self, now: u64, saw: &dyn Fn(&str, &[Record])) -> Vec<(String, Vec<RemotePage>)> {
        let ids = machines();
        self.read.borrow_mut().retain(|k, _| ids.contains(k));
        let gone: Vec<String> = self.watches.borrow().keys().filter(|k| !ids.contains(k)).cloned().collect();
        for id in gone {
            if let Some(w) = self.watches.borrow_mut().remove(&id) {
                w.handle.kill();
            }
        }
        let lists = join_all(ids.iter().map(|id| self.of(id, now, saw))).await;
        ids.into_iter().zip(lists).collect()
    }

    pub async fn find(&self, id: &str, slug: &str, now: u64, saw: &dyn Fn(&str, &[Record])) -> Option<RemotePage> {
        machine(id)?;
        self.of(id, now, saw).await.into_iter().find(|p| p.record.slug == slug)
    }

    /// Reads the machine's list again next time (after adding or removing a page there).
    pub fn forget(&self, id: &str) {
        self.read.borrow_mut().remove(id);
        if let Some(w) = self.watches.borrow_mut().remove(id) {
            w.handle.kill();
        }
    }
}

/// Adds a folder on another machine as a page, with its own `inyon pages add`. The new entry.
pub async fn add(id: &str, folder: &str, name: Option<&str>, slug: Option<&str>) -> HubResult<RemotePage> {
    let mut args = String::from("add --json");
    if let Some(n) = name.filter(|n| !n.is_empty()) {
        args.push_str(&format!(" --name {}", shq(n)));
    }
    if let Some(s) = slug {
        args.push_str(&format!(" --slug {}", shq(s)));
    }
    args.push_str(&format!(" -- {}", shq(folder)));
    let m = run(id, &args, LIST_WAIT).await?;
    let record = m.get("page").and_then(as_record).ok_or_else(|| http(500, "The machine added the page but didn't say how"))?;
    Ok(RemotePage { record, progress: None, notes: vec![] })
}

/// Adds the Blueprint sites under `dirs` on a machine (the hub's own too) that aren't listed there
/// yet, with its own `inyon pages find`, as added by agent `by`. How many it added; an error when
/// it couldn't be asked or its inyon is from before 0.22.4.
pub async fn find(id: &str, by: &str, dirs: &[String]) -> HubResult<usize> {
    let mut args = format!("find --json --by {} --", shq(by));
    for d in dirs {
        args.push_str(&format!(" {}", shq(d)));
    }
    let m = run(id, &args, LIST_WAIT).await?;
    m.get("found").and_then(Value::as_array).map(Vec::len).ok_or_else(|| http(501, "This machine's inyon can't find pages"))
}

/// Takes a page off another machine's list, with its own `inyon pages rm`.
pub async fn remove(id: &str, slug: &str) -> HubResult<()> {
    run(id, &format!("rm --json -- {}", shq(slug)), LIST_WAIT).await.map(|_| ())
}

/// What `inyon pages get` said for one request, as the disk `decide_view` looks at, and the file.
#[derive(Debug, Default)]
pub struct Listing {
    real: HashMap<PathBuf, PathBuf>,
    stats: HashMap<PathBuf, FileStat>,
    /// the file the machine sent, and the real path it read it from
    pub file: Option<(PathBuf, Vec<u8>)>,
    /// the file is bigger than REMOTE_FILE_MAX
    pub big: bool,
    /// the file the request ends at (its real path), when the machine listed one
    ends: Option<PathBuf>,
    /// fewer bytes came than the machine said it would send, so this answer isn't kept
    pub short: bool,
}

impl ViewFs for Listing {
    fn stat<'a>(&'a self, p: &'a Path) -> LocalBoxFuture<'a, Option<FileStat>> {
        Box::pin(async move { self.stats.get(p).copied() })
    }
    fn realpath<'a>(&'a self, p: &'a Path) -> LocalBoxFuture<'a, Option<PathBuf>> {
        Box::pin(async move { self.real.get(p).cloned() })
    }
}

impl Listing {
    /// Reads the machine's answer for the site at `root` (slashed): the site's real folder, then
    /// the asked path and its index.html, keyed by the paths decide_view will ask about.
    pub fn from_answer(root: &Path, segments: &[String], m: &Map<String, Value>) -> Listing {
        let mut l = Listing { big: m.get("big") == Some(&Value::Bool(true)), ..Listing::default() };
        let Some(site) = m.get("root").and_then(Value::as_str) else { return l };
        l.real.insert(root.to_owned(), slashed(site));
        let items = m.get("items").and_then(Value::as_array).cloned().unwrap_or_default();
        let mut asked = segments.iter().fold(root.to_owned(), |p, s| p.join(s));
        let mut last = None;
        for item in items.iter().take(2) {
            let Some(real) = item.get("real").and_then(Value::as_str).map(slashed) else { break };
            let flag = |k: &str| item.get(k) == Some(&Value::Bool(true));
            let stat = FileStat {
                file: flag("file"),
                dir: flag("dir"),
                size: item.get("size").and_then(Value::as_u64).unwrap_or(0),
                mtime_ms: item.get("mtime").and_then(Value::as_f64).unwrap_or(0.0),
            };
            l.real.insert(asked, real.clone());
            l.stats.insert(real.clone(), stat);
            asked = real.join("index.html");
            last = Some((real, stat));
        }
        l.ends = last.filter(|(_, st)| st.file).map(|(real, _)| real);
        if let (Some(data), Some(real)) = (m.get("data").and_then(Value::as_str), l.ends.clone()) {
            use base64::Engine;
            if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(data) {
                l.file = Some((real, bytes));
            }
        }
        l
    }

    /// The machine answered about the site (a page it still lists).
    pub fn answered(&self) -> bool {
        !self.real.is_empty()
    }

    /// The bytes for the file decide_view picked, when they're the ones the machine sent.
    pub fn bytes_for(&self, path: &Path) -> Option<&[u8]> {
        self.file.as_ref().filter(|(p, _)| p == path).map(|(_, b)| b.as_slice())
    }
}

/// Asks the machine about one request for a file of its page `slug` (the site at `root`, slashed).
/// None when it couldn't be asked; decide_view then finds nothing and answers 404.
pub async fn get(id: &str, slug: &str, root: &Path, segments: &[String], slash: bool, if_none_match: Option<&str>) -> Option<Listing> {
    let mut args = format!("get --json --max {REMOTE_FILE_MAX}");
    if slash {
        args.push_str(" --slash");
    }
    if let Some(e) = if_none_match.filter(|e| !e.is_empty()) {
        // = so a value can't be taken for an option
        args.push_str(&format!(" --etag={}", shq(e)));
    }
    args.push_str(&format!(" -- {}", shq(slug)));
    for s in segments {
        args.push_str(&format!(" {}", shq(s)));
    }
    let m = run(id, &args, GET_WAIT).await.ok()?;
    Some(Listing::from_answer(root, segments, &m))
}

/// Asks a machine that streams files (`pages get --lines`, from 0.22.3) about one request, and
/// takes the file as base64 lines after the answer: up to STREAM_FILE_MAX, since no one message
/// has to hold it. The browser's If-None-Match isn't passed on, so the file comes even when the
/// browser has it and the hub can keep it; decide_view still answers that browser with a 304.
pub async fn get_lines(id: &str, slug: &str, root: &Path, segments: &[String], slash: bool) -> Option<Listing> {
    use base64::Engine;
    let (host, _) = machine(id)?;
    let mut args = format!("get --json --lines --max {STREAM_FILE_MAX}");
    if slash {
        args.push_str(" --slash");
    }
    args.push_str(&format!(" -- {}", shq(slug)));
    for s in segments {
        args.push_str(&format!(" {}", shq(s)));
    }
    let lines: Rc<RefCell<Vec<String>>> = Rc::default();
    let into = lines.clone();
    let handle = host.stream(&format!("{INYON_PAGES} {args}"), move |l| into.borrow_mut().push(l), false).ok()?;
    let exited = handle.exited.wait();
    futures_util::pin_mut!(exited);
    let timeout = rt::sleep(GET_WAIT);
    if let futures_util::future::Either::Right(_) = futures_util::future::select(exited, timeout).await {
        handle.kill();
        return None;
    }
    let lines = std::mem::take(&mut *lines.borrow_mut());
    let mut it = lines.into_iter();
    let Ok(Value::Object(m)) = serde_json::from_str::<Value>(&it.next()?) else { return None };
    if m.get("ok") == Some(&Value::Bool(false)) {
        return None;
    }
    let mut l = Listing::from_answer(root, segments, &m);
    if let (Some(sends), Some(real)) = (m.get("sends").and_then(Value::as_u64), l.ends.clone()) {
        let mut bytes = Vec::with_capacity(sends.min(STREAM_FILE_MAX) as usize);
        for line in it {
            bytes.extend(base64::engine::general_purpose::STANDARD.decode(line.trim_end()).ok()?);
        }
        // fewer than it said: the file changed or went while it was read
        if bytes.len() as u64 == sends {
            l.file = Some((real, bytes));
        } else {
            l.short = true;
        }
    }
    Some(l)
}
