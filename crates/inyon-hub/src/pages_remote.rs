//! Pages on the hub's other machines: a laptop joined to it, a server it reaches over SSH. Their
//! own `inyon` does the reading, as for Temp files (features/temp.rs): `inyon pages --json` lists a
//! machine's pages with their progress, and `inyon pages get --json` says what one request for a
//! page's file needs to know and sends the file. The hub decides every answer with the same
//! `decide_view` as for its own pages, over what the machine listed, so the rules (dot names,
//! symlinks out of the site, folders and their slash, the cache) are the same on every machine.
//!
//! A machine with an inyon from before 0.22 lists no pages here: its list doesn't say `serves`.

use std::cell::RefCell;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use futures_util::future::{join_all, LocalBoxFuture};
use inyon_core::features::pages_core::{FileStat, ViewFs};
use inyon_core::features::temp::{read_answer, INYON_PAGES};
use inyon_core::hosts::host::{shq, ExecOptions, Host};
use inyon_core::hosts::http_error::{http, HubResult};
use inyon_core::hosts::registry::registry;
use inyon_protocol::{HostKind, HostStatus};
use serde_json::{Map, Value};

use crate::pages::{as_record, Record};

/// How long a machine's list is kept before it's read again.
pub const REMOTE_TTL_MS: u64 = 15_000;
/// The biggest file the hub fetches from another machine; a bigger one is a 413. It comes back as
/// base64 inside one JSON message, so it has to stay well under the sockets' 16 MiB.
pub const REMOTE_FILE_MAX: u64 = 8 * 1024 * 1024;
/// How long the hub waits on the machine, in ms.
const LIST_WAIT: u64 = 20_000;
const GET_WAIT: u64 = 60_000;

/// A page on another machine, as its list says.
#[derive(Debug, Clone, PartialEq)]
pub struct RemotePage {
    pub record: Record,
    /// what its progress.json counts, as the machine read it
    pub progress: Option<Value>,
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
/// to serve them. Entries with a problem (the folder gone, no index.html) are left out, as the
/// hub leaves out its own.
pub async fn read_list(id: &str) -> Option<Vec<RemotePage>> {
    let m = run(id, "--json", LIST_WAIT).await.ok()?;
    if m.get("serves") != Some(&Value::Bool(true)) {
        return Some(vec![]);
    }
    let mut out: Vec<RemotePage> = vec![];
    for p in m.get("pages").and_then(Value::as_array).into_iter().flatten() {
        let Some(record) = as_record(p).filter(|_| p.get("problem").is_none()) else { continue };
        if out.iter().any(|x| x.record.slug == record.slug) {
            continue;
        }
        out.push(RemotePage { record, progress: p.get("progress").filter(|v| v.is_object()).cloned() });
    }
    Some(out)
}

/// Each machine's list as last read, and when.
#[derive(Default)]
pub struct RemoteLists(RefCell<HashMap<String, (u64, Vec<RemotePage>)>>);

impl RemoteLists {
    /// One machine's pages, read again when older than REMOTE_TTL_MS. A machine that doesn't
    /// answer keeps its last list until the next try. `saw` hears each list read.
    pub async fn of(&self, id: &str, now: u64, saw: &dyn Fn(&str, &[Record])) -> Vec<RemotePage> {
        let cached = self.0.borrow().get(id).cloned();
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
        self.0.borrow_mut().insert(id.to_owned(), (now, list.clone()));
        list
    }

    /// Every connected machine's pages, those due read at the same time.
    pub async fn all(&self, now: u64, saw: &dyn Fn(&str, &[Record])) -> Vec<(String, Vec<RemotePage>)> {
        let ids = machines();
        self.0.borrow_mut().retain(|k, _| ids.contains(k));
        let lists = join_all(ids.iter().map(|id| self.of(id, now, saw))).await;
        ids.into_iter().zip(lists).collect()
    }

    pub async fn find(&self, id: &str, slug: &str, now: u64, saw: &dyn Fn(&str, &[Record])) -> Option<RemotePage> {
        machine(id)?;
        self.of(id, now, saw).await.into_iter().find(|p| p.record.slug == slug)
    }

    /// Reads the machine's list again next time (after adding or removing a page there).
    pub fn forget(&self, id: &str) {
        self.0.borrow_mut().remove(id);
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
    Ok(RemotePage { record, progress: None })
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
        if let (Some(data), Some((real, _))) = (m.get("data").and_then(Value::as_str), last.filter(|(_, st)| st.file)) {
            use base64::Engine;
            if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(data) {
                l.file = Some((real, bytes));
            }
        }
        l
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
