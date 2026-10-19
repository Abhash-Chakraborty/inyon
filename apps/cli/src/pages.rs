//! `inyon pages`: the sites agents make (Blueprint plans, mockups), listed in the Inyon app under
//! Pages. The list is `~/.inyon/pages.json`, which this command, Blueprint's publish script and the
//! hub all write, and which the hub reads again whenever it changes, so adding a page needs no hub
//! running. Each site also gets `.inyon-page.json` in its own folder, so it keeps its slug and name.
//!
//!   ~/.inyon/pages.json     {"v":1,"pages":[{"slug","name","path","project","by","added"}]}
//!   <site>/.inyon-page.json {"v":1,"slug","name","kind":"blueprint","created"}
//!
//! The rules (slugs, which folders may be pages, the messages) are the hubs' own, from
//! apps/hub/src/features/pages-core.ts; tests/pages.rs checks them against fixtures/pages/rules.json.
//! pages.json is changed while holding `pages.json.lock` (created exclusively, taken over once it is
//! 10 s old), by writing a temp file and renaming it over the old one. Entries this program can't
//! read are kept as they are.

use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};

use crate::commands::Outcome;
use crate::paths;

/// The host id of the hub's own machine: app links are /pages/<host>/<slug>.
pub const LOCAL_HOST: &str = "local";
pub const BAD_SLUG: &str = "A slug is lowercase letters, digits and dashes, up to 63 characters, starting with a letter or digit";
pub const NOT_ABSOLUTE: &str = "The folder must be an absolute path";
pub const TOO_WIDE: &str = "Pick the site's own folder, not / or your home folder";
pub const PRIVATE_FOLDER: &str = "Folders under ~/.ssh and ~/.inyon can't be pages";
pub const NO_INDEX: &str = "That folder has no index.html";
pub const BROKEN_FILE: &str = "~/.inyon/pages.json isn't a page list Inyon can read. Fix it or delete it, then try again.";
pub const LOCKED: &str = "Another program is changing ~/.inyon/pages.json. Try again in a moment.";
/// A lock older than this was left by a writer that died, and is taken over.
pub const LOCK_STALE: Duration = Duration::from_secs(10);
/// How long to wait for another writer before giving up.
const LOCK_WAIT: Duration = Duration::from_secs(5);
/// Names are cut to this many characters, as the hub cuts them.
const NAME_MAX: usize = 200;
/// How much of index.html is read for its <title>.
const TITLE_READ: usize = 256 * 1024;

// ---------- the shared rules ----------

/// `^[a-z0-9][a-z0-9-]{0,62}$`
pub fn is_slug(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty() && b.len() <= 63 && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit()) && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

/// ASCII letters lowercased, every other run one dash, no dash at either end, at most 63
/// characters; "page" when nothing is left.
pub fn slugify(text: &str) -> String {
    let mut s = String::new();
    let mut dash = false;
    for c in text.chars() {
        let c = c.to_ascii_lowercase();
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            if dash && !s.is_empty() {
                s.push('-');
            }
            dash = false;
            s.push(c);
        } else {
            dash = true;
        }
    }
    s.truncate(63);
    let s = s.trim_end_matches('-').to_string();
    if s.is_empty() {
        "page".into()
    } else {
        s
    }
}

/// `base`, or `base-2`, `base-3`… (cut so the whole stays 63 characters), whichever is free first.
pub fn unique_slug(base: &str, taken: impl Fn(&str) -> bool) -> String {
    if !taken(base) {
        return base.to_string();
    }
    for i in 2u64.. {
        let suffix = format!("-{i}");
        let keep: String = base.chars().take(63usize.saturating_sub(suffix.len())).collect();
        let s = format!("{}{suffix}", keep.trim_end_matches('-'));
        if !taken(&s) {
            return s;
        }
    }
    unreachable!("an endless range ran out")
}

/// What is wrong with a folder as a page, before the disk is asked (the caller still checks for
/// index.html). None when it may be one. Paths are compared as written, trailing slashes dropped;
/// a Windows path (`C:\…`) counts as absolute.
pub fn site_path_problem(p: &str, home: &str) -> Option<&'static str> {
    let b = p.as_bytes();
    let win = b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/');
    if !(p.starts_with('/') || win) || p.contains('\0') {
        return Some(NOT_ABSOLUTE);
    }
    let parts = |s: &str| -> Vec<String> {
        if win {
            s.split(['\\', '/']).filter(|x| !x.is_empty()).map(String::from).collect()
        } else {
            s.split('/').filter(|x| !x.is_empty()).map(String::from).collect()
        }
    };
    let segs = parts(p);
    if segs.iter().any(|s| s == "." || s == "..") {
        return Some(NOT_ABSOLUTE);
    }
    let home_segs = parts(home);
    if segs.is_empty() || (win && segs.len() == 1) || (!home_segs.is_empty() && segs == home_segs) {
        return Some(TOO_WIDE);
    }
    let under = |dir: &str| {
        let mut d = home_segs.clone();
        d.push(dir.to_string());
        segs.len() >= d.len() && segs[..d.len()] == d[..]
    };
    if !home_segs.is_empty() && (under(".ssh") || under(".inyon")) {
        return Some(PRIVATE_FOLDER);
    }
    None
}

/// The rules above, and on Windows (where names don't care about case) the same again lowercased.
fn folder_problem(p: &str, home: &str) -> Option<&'static str> {
    site_path_problem(p, home).or_else(|| if cfg!(windows) { site_path_problem(&p.to_lowercase(), &home.to_lowercase()) } else { None })
}

// ---------- paths ----------

/// A path with `.` and `..` worked out from the text, as a shell does (symlinks stay).
pub fn lexical(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// The folder someone typed, as an absolute path.
fn absolute(dir: &Path) -> Result<PathBuf, String> {
    #[cfg(windows)]
    {
        std::path::absolute(dir).map(|p| lexical(&p)).map_err(|e| format!("{}: {e}", dir.display()))
    }
    #[cfg(not(windows))]
    {
        let cwd = std::env::current_dir().map_err(|e| format!("Can't tell which folder this is: {e}"))?;
        Ok(lexical(&cwd.join(dir)))
    }
}

/// A path Windows gave back as `\\?\C:\…` (or `\\?\UNC\server\…`), in the form people type.
pub fn strip_verbatim(p: &str) -> String {
    if let Some(rest) = p.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = p.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        p.to_string()
    }
}

fn text_of(p: &Path) -> Result<String, String> {
    p.to_str().map(String::from).ok_or_else(|| format!("{} isn't a name Inyon can store (it isn't UTF-8)", p.display()))
}

/// Where a path really leads, symlinks followed, as text.
fn real(p: &Path) -> Option<String> {
    fs::canonicalize(p).ok().and_then(|r| r.to_str().map(strip_verbatim))
}

/// What is wrong with where a folder really leads. A drive letter that is a mapped network drive
/// really leads to `\\server\share\…`, which the rules don't take as a path typed by hand. There the
/// share stands in for the drive (`Z:\…`), and so does the home folder when it is on the same share:
/// the share itself is too wide, and its home folder's `.ssh` stays private.
fn real_problem(path: &str, real_path: &str, real_home: &str) -> Option<&'static str> {
    let b = path.as_bytes();
    let drive = b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':';
    if let (true, Some((share, rest))) = (drive, unc_parts(real_path)) {
        let as_drive = |rest: &str| format!("{}:\\{rest}", b[0] as char);
        let home = match unc_parts(real_home) {
            Some((home_share, home_rest)) if home_share.eq_ignore_ascii_case(&share) => as_drive(&home_rest),
            _ => real_home.to_string(),
        };
        return folder_problem(&as_drive(&rest), &home);
    }
    folder_problem(real_path, real_home)
}

/// `\\server\share\rest` as (`\\server\share`, `rest`), for a UNC path.
fn unc_parts(p: &str) -> Option<(String, String)> {
    let body = p.strip_prefix(r"\\")?;
    let mut it = body.splitn(3, ['\\', '/']);
    let (server, share) = (it.next().filter(|s| !s.is_empty())?, it.next().filter(|s| !s.is_empty())?);
    Some((format!(r"\\{server}\{share}"), it.next().unwrap_or("").to_string()))
}

/// `~/.inyon/pages.json`: always under the home folder (not INYON_DATA_DIR), where the hub reads it.
pub fn pages_file() -> PathBuf {
    paths::home().join(".inyon").join("pages.json")
}

/// A path under the home folder as `~/…`.
fn short(p: &str) -> String {
    let home = paths::home();
    match Path::new(p).strip_prefix(&home) {
        Ok(rest) if !rest.as_os_str().is_empty() => format!("~/{}", rest.display()).replace('\\', "/"),
        _ => p.to_string(),
    }
}

// ---------- what a site says about itself ----------

/// The agent running this command, from the variables each one sets for its shell; "cli" otherwise.
pub fn agent(env: impl Fn(&str) -> Option<String>) -> &'static str {
    let set = |k: &str| env(k).is_some_and(|v| !v.is_empty());
    if set("CLAUDECODE") {
        "claude"
    } else if set("CODEX_SANDBOX") || set("CODEX_SANDBOX_NETWORK_DISABLED") || set("CODEX_THREAD_ID") {
        "codex"
    } else if set("GEMINI_CLI") {
        "gemini"
    } else if set("OPENCODE") {
        "opencode"
    } else {
        "cli"
    }
}

/// The text of the first `<title>` in an HTML page, entities decoded and spaces collapsed.
pub fn title_of(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let mut from = 0;
    let open = loop {
        let at = from + lower[from..].find("<title")?;
        let next = lower.as_bytes().get(at + 6).copied();
        if matches!(next, Some(b'>' | b' ' | b'\t' | b'\n' | b'\r')) {
            break at;
        }
        from = at + 6;
    };
    let start = open + lower[open..].find('>')? + 1;
    let end = start + lower[start..].find("</title")?;
    let text = decode_entities(&html[start..end]);
    let clean = text.split_whitespace().collect::<Vec<_>>().join(" ");
    (!clean.is_empty()).then(|| clean.chars().take(NAME_MAX).collect())
}

fn decode_entities(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        rest = &rest[i..];
        // by bytes: ';' is ASCII, so where it is found is always a character boundary
        let Some(semi) = rest.as_bytes()[..rest.len().min(12)].iter().position(|b| *b == b';') else {
            out.push('&');
            rest = &rest[1..];
            continue;
        };
        let name = &rest[1..semi];
        let ch = match name {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            "nbsp" => Some(' '),
            _ => name
                .strip_prefix("#x")
                .or_else(|| name.strip_prefix("#X"))
                .and_then(|h| u32::from_str_radix(h, 16).ok())
                .or_else(|| name.strip_prefix('#').and_then(|d| d.parse().ok()))
                .and_then(char::from_u32),
        };
        match ch {
            Some(c) => {
                out.push(c);
                rest = &rest[semi + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

fn page_title(site: &Path) -> Option<String> {
    let bytes = fs::read(site.join("index.html")).ok()?;
    let head = &bytes[..bytes.len().min(TITLE_READ)];
    title_of(&String::from_utf8_lossy(head))
}

/// A name as given: trimmed, at most 200 characters, None when empty.
fn clean_name(s: &str) -> Option<String> {
    let t = s.trim();
    (!t.is_empty()).then(|| t.chars().take(NAME_MAX).collect())
}

struct Marker {
    name: Option<String>,
    slug: Option<String>,
    raw: Option<Map<String, Value>>,
}

fn read_marker(site: &Path) -> Marker {
    let raw = fs::read_to_string(site.join(".inyon-page.json")).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|v| match v {
        Value::Object(m) => Some(m),
        _ => None,
    });
    let name = raw.as_ref().and_then(|m| m.get("name")).and_then(Value::as_str).and_then(clean_name);
    let slug = raw.as_ref().and_then(|m| m.get("slug")).and_then(Value::as_str).filter(|s| is_slug(s)).map(String::from);
    Marker { name, slug, raw }
}

/// Writes `<site>/.inyon-page.json`, keeping its first `created`. False when the folder can't be
/// written; the page is listed anyway.
fn write_marker(site: &Path, old: &Marker, slug: &str, name: &str, now: u64) -> bool {
    let created = old.raw.as_ref().and_then(|m| m.get("created")).and_then(Value::as_u64).filter(|n| *n < (1u64 << 53)).unwrap_or(now);
    let want = json!({ "v": 1, "slug": slug, "name": name, "kind": "blueprint", "created": created });
    if old.raw.as_ref().is_some_and(|m| Value::Object(m.clone()) == want) {
        return true;
    }
    write_atomic(&site.join(".inyon-page.json"), &format!("{want}\n"), 0o644).is_ok()
}

/// The git top level of a folder (for a linked worktree, the repo's main checkout), or the folder itself.
fn project_of(folder: &str) -> String {
    let git = |args: &[&str]| {
        let mut c = std::process::Command::new("git");
        c.args(["-C", folder, "rev-parse"]).args(args).stdin(std::process::Stdio::null()).stderr(std::process::Stdio::null());
        crate::sys::quiet(&mut c).output().ok().filter(|o| o.status.success()).map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
    };
    // git older than 2.31 has no --path-format: then the top level as it is
    let top = match git(&["--path-format=absolute", "--show-toplevel", "--git-common-dir", "--git-dir"]) {
        Some(out) => {
            let l: Vec<&str> = out.lines().map(str::trim).collect();
            main_tree(l.first().copied().unwrap_or(""), l.get(1).copied().unwrap_or(""), l.get(2).copied().unwrap_or(""))
        }
        None => git(&["--show-toplevel"]).map(|o| o.trim().to_string()).unwrap_or_default(),
    };
    if top.is_empty() {
        folder.to_string()
    } else if cfg!(windows) {
        top.replace('/', "\\")
    } else {
        top
    }
}

/// The repo's main working tree, from git's top level, common dir and own dir. In a linked worktree
/// (an agent's `.claude/worktrees/<name>`, removed once its branch merges) the common dir is the
/// main tree's `.git`, so the page is grouped under the repo, not the worktree. A submodule or a
/// bare repo's worktree keeps its own top level.
fn main_tree(top: &str, common: &str, own: &str) -> String {
    let c = Path::new(common);
    if !common.is_empty() && common != own && c.file_name().is_some_and(|n| n == ".git") {
        if let Some(parent) = c.parent().and_then(Path::to_str).filter(|p| !p.is_empty()) {
            return parent.to_string();
        }
    }
    top.to_string()
}

// ---------- the list file ----------

/// Runs `f` holding `<file>.lock`, made with an exclusive create; a lock older than LOCK_STALE is
/// taken over. The lock holds this process's id and a random tag, and is removed afterwards only
/// while it still holds them. A failure other than "someone else has it" (a folder an agent's
/// sandbox keeps read-only) is reported at once with the sandbox hint, never waited on.
fn with_lock<T>(file: &Path, f: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    struct Held(PathBuf, String);
    impl Drop for Held {
        fn drop(&mut self) {
            if fs::read_to_string(&self.0).is_ok_and(|t| t == self.1) {
                let _ = fs::remove_file(&self.0);
            }
        }
    }
    let lock = lock_of(file);
    let until = Instant::now() + LOCK_WAIT;
    let mine = format!("{} {}\n", std::process::id(), random_tag());
    let _held = loop {
        match OpenOptions::new().write(true).create_new(true).open(&lock) {
            Ok(mut fh) => {
                let _ = fh.write_all(mine.as_bytes());
                break Held(lock, mine);
            }
            Err(e) if e.kind() == ErrorKind::AlreadyExists => {}
            Err(e) => return Err(cant_write(file, &e)),
        }
        if take_over_stale(&lock).map_err(|e| cant_write(file, &e))? {
            continue;
        }
        if Instant::now() >= until {
            return Err(LOCKED.into());
        }
        std::thread::sleep(Duration::from_millis(25));
    };
    f()
}

fn lock_of(file: &Path) -> PathBuf {
    let mut name = file.as_os_str().to_owned();
    name.push(".lock");
    PathBuf::from(name)
}

/// 16 hex digits, different for every lock this program takes.
fn random_tag() -> String {
    use std::hash::{BuildHasher, Hasher};
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos()));
    format!("{:016x}", h.finish())
}

/// The file's identity, to tell a lock judged stale from a new one made in its place.
fn identity(m: &fs::Metadata) -> (u64, Option<std::time::SystemTime>) {
    #[cfg(unix)]
    let ino = std::os::unix::fs::MetadataExt::ino(m);
    #[cfg(not(unix))]
    let ino = m.len();
    (ino, m.modified().ok())
}

/// Removes a lock left by a writer that died (older than LOCK_STALE); true when the caller should
/// try to take it again at once.
fn take_over_stale(lock: &Path) -> std::io::Result<bool> {
    let old = match fs::metadata(lock) {
        Ok(m) => m,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(true),
        Err(e) => return Err(e),
    };
    if !old.modified().ok().and_then(|t| t.elapsed().ok()).is_some_and(|age| age > LOCK_STALE) {
        return Ok(false);
    }
    remove_judged(lock, &old)?;
    Ok(true)
}

/// Removes the lock that was judged stale as `old`, and only that one: renamed aside, then put back
/// if it turns out to be a new lock another writer made since (two writers can judge one lock stale
/// at once, and the first makes its own before the second acts).
pub fn remove_judged(lock: &Path, old: &fs::Metadata) -> std::io::Result<()> {
    let mut aside = lock.as_os_str().to_owned();
    aside.push(format!(".{}.{}.stale", std::process::id(), &random_tag()[..8]));
    let aside = PathBuf::from(aside);
    match fs::rename(lock, &aside) {
        Ok(()) => {}
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    }
    if fs::metadata(&aside).map(|m| identity(&m)).ok() != Some(identity(old)) {
        // another writer's new lock: back where it was, unless a third has made one since
        let _ = fs::hard_link(&aside, lock);
    }
    let _ = fs::remove_file(&aside);
    Ok(())
}

fn cant_write(file: &Path, e: &std::io::Error) -> String {
    format!("Can't write {}: {e}. If an agent's sandbox stopped it, run the same command in your own terminal.", file.display())
}

/// Writes beside the file, flushes, and renames over it, so a reader never sees half a file.
fn write_atomic(file: &Path, text: &str, mode: u32) -> std::io::Result<()> {
    let mut name = file.as_os_str().to_owned();
    name.push(format!(".{}.tmp", std::process::id()));
    let tmp = PathBuf::from(name);
    let mut o = OpenOptions::new();
    o.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(mode);
    }
    #[cfg(not(unix))]
    let _ = mode;
    let result = (|| {
        let mut fh = o.open(&tmp)?;
        fh.write_all(text.as_bytes())?;
        fh.sync_all()?;
        drop(fh);
        fs::rename(&tmp, file)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// The file as `{v: 1, pages: [...]}` (other keys kept), an empty list when it isn't there.
fn read_list(file: &Path) -> Result<Map<String, Value>, String> {
    let text = match fs::read_to_string(file) {
        Ok(t) => t,
        Err(e) if e.kind() == ErrorKind::NotFound => {
            let mut m = Map::new();
            m.insert("v".into(), json!(1));
            m.insert("pages".into(), json!([]));
            return Ok(m);
        }
        Err(e) => return Err(format!("Can't read {}: {e}", file.display())),
    };
    match serde_json::from_str::<Value>(&text) {
        Ok(Value::Object(m)) if m.get("v").and_then(Value::as_f64) == Some(1.0) && m.get("pages").is_some_and(Value::is_array) => Ok(m),
        _ => Err(BROKEN_FILE.into()),
    }
}

fn write_list(file: &Path, list: &Map<String, Value>) -> Result<(), String> {
    let text = serde_json::to_string_pretty(&Value::Object(list.clone())).unwrap_or_default() + "\n";
    write_atomic(file, &text, 0o600).map_err(|e| cant_write(file, &e))
}

/// Makes ~/.inyon when it isn't there, readable only by this user.
fn ensure_dir(file: &Path) -> Result<(), String> {
    let Some(dir) = file.parent() else { return Ok(()) };
    if dir.is_dir() {
        return Ok(());
    }
    fs::create_dir_all(dir).map_err(|e| cant_write(file, &e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(dir, fs::Permissions::from_mode(0o700));
    }
    Ok(())
}

/// One entry as the hub reads it: every field with its type and the slug a slug.
fn readable(v: &Value) -> bool {
    let Some(m) = v.as_object() else { return false };
    let s = |k: &str| m.get(k).is_some_and(Value::is_string);
    m.get("slug").and_then(Value::as_str).is_some_and(is_slug) && s("name") && s("path") && s("project") && s("by") && m.get("added").is_some_and(Value::is_number)
}

fn field<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

// ---------- the commands ----------

pub struct Added {
    pub page: Value,
    /// false when the folder was listed already, just as asked
    pub changed: bool,
    /// whether `.inyon-page.json` in the site's folder is up to date
    pub marker: bool,
}

/// Adds a site's folder to `file`, or updates its entry when the folder is there already, so
/// adding again is safe. `home` is the user's home folder; `by` who is adding it; `now` ms since 1970.
pub fn add(file: &Path, home: &Path, dir: &Path, name: Option<&str>, slug: Option<&str>, by: &str, now: u64) -> Result<Added, String> {
    let folder = absolute(dir)?;
    let path = text_of(&folder)?;
    let home_text = text_of(home)?;
    if let Some(p) = folder_problem(&path, &home_text) {
        return Err(p.into());
    }
    let meta = fs::metadata(&folder).map_err(|_| format!("{path} doesn't exist"))?;
    if !meta.is_dir() {
        return Err(format!("{path} isn't a folder"));
    }
    let real_path = real(&folder).unwrap_or_else(|| path.clone());
    let real_home = real(home).unwrap_or_else(|| home_text.clone());
    if let Some(p) = real_problem(&path, &real_path, &real_home) {
        return Err(p.into());
    }
    if !folder.join("index.html").is_file() {
        return Err(format!("{NO_INDEX}: {path}"));
    }
    if let Some(s) = slug {
        if !is_slug(s) {
            return Err(BAD_SLUG.into());
        }
    }
    let asked = name.and_then(clean_name);
    let marker = read_marker(&folder);
    ensure_dir(file)?;

    let (page, changed) = with_lock(file, || {
        let mut list = read_list(file)?;
        let pages = list.get_mut("pages").and_then(Value::as_array_mut).ok_or(BROKEN_FILE)?;
        let at = pages.iter().position(|p| {
            let p = field(p, "path");
            !p.is_empty() && (p == path || real(Path::new(p)).is_some_and(|r| r == real_path))
        });
        let taken = |s: &str| pages.iter().enumerate().any(|(i, p)| Some(i) != at && field(p, "slug") == s);
        let old = at.map(|i| pages[i].clone());
        let old_slug = old.as_ref().map(|o| field(o, "slug")).filter(|s| is_slug(s));
        let slug = match (slug, old_slug) {
            (Some(s), _) => {
                if taken(s) {
                    let other = pages.iter().find(|p| field(p, "slug") == s).map(|p| field(p, "path")).unwrap_or("");
                    return Err(format!("The slug \"{s}\" is taken by {other}. Pick another with --slug"));
                }
                s.to_string()
            }
            (None, Some(s)) => s.to_string(),
            (None, None) => {
                let base = marker.slug.clone().unwrap_or_else(|| slugify(crate::paths::basename(&path)));
                unique_slug(&base, taken)
            }
        };
        let old_name = old.as_ref().map(|o| field(o, "name")).and_then(clean_name);
        let name = asked.clone().or(old_name).or_else(|| marker.name.clone()).or_else(|| page_title(&folder)).unwrap_or_else(|| crate::paths::basename(&path).to_string());
        let mut entry = match &old {
            Some(Value::Object(m)) => m.clone(),
            _ => Map::new(),
        };
        entry.insert("slug".into(), json!(slug));
        entry.insert("name".into(), json!(name));
        if !entry.get("path").is_some_and(Value::is_string) {
            entry.insert("path".into(), json!(path));
        }
        if !entry.get("project").and_then(Value::as_str).is_some_and(|p| !p.is_empty()) {
            entry.insert("project".into(), json!(project_of(&path)));
        }
        if !entry.get("by").and_then(Value::as_str).is_some_and(|b| !b.is_empty()) {
            entry.insert("by".into(), json!(by));
        }
        if !entry.get("added").is_some_and(Value::is_number) {
            entry.insert("added".into(), json!(now));
        }
        let page = Value::Object(entry);
        let changed = old.as_ref() != Some(&page);
        if changed {
            match at {
                Some(i) => pages[i] = page.clone(),
                None => pages.push(page.clone()),
            }
            write_list(file, &list)?;
        }
        Ok((page, changed))
    })?;
    let marker = write_marker(&folder, &marker, field(&page, "slug"), field(&page, "name"), now);
    Ok(Added { page, changed, marker })
}

/// Takes every entry with this slug out of `file`, and returns them.
pub fn remove(file: &Path, slug: &str) -> Result<Vec<Value>, String> {
    let missing = || format!("There's no page called \"{slug}\" on this machine. See them with: inyon pages ls");
    if !file.exists() {
        return Err(missing());
    }
    with_lock(file, || {
        let mut list = read_list(file)?;
        let pages = list.get_mut("pages").and_then(Value::as_array_mut).ok_or(BROKEN_FILE)?;
        let (gone, keep): (Vec<Value>, Vec<Value>) = pages.drain(..).partition(|p| field(p, "slug") == slug);
        *pages = keep;
        if gone.is_empty() {
            return Err(missing());
        }
        write_list(file, &list)?;
        Ok(gone)
    })
}

/// What keeps a listed page from opening in the app, when something does.
fn trouble(page: &Value, home: &str, real_home: &str) -> Option<String> {
    let path = field(page, "path");
    if let Some(p) = folder_problem(path, home) {
        return Some(p.into());
    }
    if !Path::new(path).is_dir() {
        return Some("the folder is gone".into());
    }
    if let Some(p) = real(Path::new(path)).and_then(|r| real_problem(path, &r, real_home)) {
        return Some(p.into());
    }
    if !Path::new(path).join("index.html").is_file() {
        return Some("it has no index.html".into());
    }
    None
}

fn app_link(slug: &str) -> String {
    format!("/pages/{LOCAL_HOST}/{slug}")
}

/// The hub's machine is the only one whose pages the app shows for now.
fn not_hub_note() -> &'static str {
    "This machine doesn't run a hub. For now the app shows pages from the hub's own machine only."
}

/// What `add` says. Without a hub here the app can't open the page, so there's no app path to hand
/// over: only where it's listed and why it can't be shown yet.
fn added_lines(name: &str, machine: &str, project: &str, slug: &str, changed: bool, hub: bool) -> Vec<String> {
    let again = if changed { "" } else { " (already listed)" };
    if hub {
        vec![format!("\"{name}\" is in Inyon: Pages > {machine} > {project}{again}"), format!("Open it in the app at {}", app_link(slug))]
    } else {
        vec![format!("\"{name}\" is listed on {machine}, under {project}{again}."), format!("{} The app can't open this page yet.", not_hub_note())]
    }
}

pub fn add_command(dir: &Path, name: Option<&str>, slug: Option<&str>) -> Outcome {
    let by = agent(|k| std::env::var(k).ok());
    let now = crate::state::now_ms() as u64;
    let a = add(&pages_file(), &paths::home(), dir, name, slug, by, now)?;
    let machine = inyon_engine::hostname();
    let slug = field(&a.page, "slug").to_string();
    let project = paths::basename(field(&a.page, "project").trim_end_matches(['/', '\\'])).to_string();
    let hub = crate::engine::hub_here();
    let lines = added_lines(field(&a.page, "name"), &machine, &project, &slug, a.changed, hub);
    Ok(json!({
        "page": a.page,
        "host": LOCAL_HOST,
        "machine": machine,
        "app": app_link(&slug),
        "changed": a.changed,
        "marker": a.marker,
        "hub": hub,
        "message": lines.join("\n"),
    }))
}

pub fn remove_command(slug: &str) -> Outcome {
    let gone = remove(&pages_file(), slug)?;
    let first = &gone[0];
    Ok(json!({
        "removed": gone,
        "message": format!("Removed \"{}\" from Inyon. Its folder stays where it is: {}", field(first, "name"), short(field(first, "path"))),
    }))
}

pub fn list_command() -> Outcome {
    let file = pages_file();
    let list = read_list(&file)?;
    let home = paths::home();
    let home_text = home.to_string_lossy().into_owned();
    let real_home = real(&home).unwrap_or_else(|| home_text.clone());
    let all = list.get("pages").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut seen = std::collections::HashSet::new();
    let mut pages = Vec::new();
    let mut skipped = 0;
    for p in &all {
        if !readable(p) || !seen.insert(field(p, "slug").to_string()) {
            skipped += 1;
            continue;
        }
        let mut row = p.clone();
        row["app"] = json!(app_link(field(p, "slug")));
        if let Some(t) = trouble(p, &home_text, &real_home) {
            row["problem"] = json!(t);
        }
        pages.push(row);
    }
    let machine = inyon_engine::hostname();
    let hub = crate::engine::hub_here();
    let mut lines = Vec::new();
    if pages.is_empty() {
        lines.push("No pages on this machine yet. Add a site's folder with: inyon pages add <folder>".to_string());
    } else {
        lines.push(format!("Pages on {machine}:"));
        let w_slug = pages.iter().map(|p| field(p, "slug").chars().count()).max().unwrap_or(0);
        let w_name = pages.iter().map(|p| field(p, "name").chars().count()).max().unwrap_or(0).min(40);
        for p in &pages {
            let name: String = field(p, "name").chars().take(40).collect();
            let mut line = format!("  {:<w_slug$}  {:<w_name$}  {}", field(p, "slug"), name, short(field(p, "path")));
            if let Some(t) = p.get("problem").and_then(Value::as_str) {
                line.push_str(&format!("  ! {t}"));
            }
            lines.push(line);
        }
        lines.push(format!("Open one in the app under Pages, or at {}", app_link("<slug>")));
    }
    if skipped > 0 {
        lines.push(format!(
            "{skipped} {} in {} can't be read and {} left out.",
            if skipped == 1 { "entry" } else { "entries" },
            short(&file.to_string_lossy()),
            if skipped == 1 { "is" } else { "are" }
        ));
    }
    if !hub && !pages.is_empty() {
        lines.push(not_hub_note().into());
    }
    Ok(json!({ "pages": pages, "host": LOCAL_HOST, "machine": machine, "hub": hub, "skipped": skipped, "message": lines.join("\n") }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn titles() {
        assert_eq!(title_of("<html><head><title>Plan</title>").as_deref(), Some("Plan"));
        assert_eq!(title_of("<TITLE lang=en>\n  Inyon &amp; co &#8212; plan\n</TITLE>").as_deref(), Some("Inyon & co \u{2014} plan"));
        assert_eq!(title_of("<titlex>no</titlex><title>yes</title>").as_deref(), Some("yes"));
        assert_eq!(title_of("<title>   </title>"), None);
        assert_eq!(title_of("<title>never closed"), None);
        assert_eq!(title_of("no title"), None);
        assert_eq!(title_of("<title>a &bogus; b & c</title>").as_deref(), Some("a &bogus; b & c"));
    }

    #[test]
    fn an_ampersand_before_text_of_more_than_one_byte_a_character_does_not_panic() {
        // from the '&', byte 12 falls inside 'の'
        assert_eq!(title_of("<title>設計 & 日本語の計画</title>").as_deref(), Some("設計 & 日本語の計画"));
        assert_eq!(title_of("<title>Café &amp; crème brûlée &éé</title>").as_deref(), Some("Café & crème brûlée &éé"));
        assert_eq!(title_of("<title>&日本語の計画&#x8a08;</title>").as_deref(), Some("&日本語の計画\u{8a08}"));
    }

    #[test]
    fn a_mapped_network_drive_is_judged_with_its_share_as_the_drive() {
        // Z: is \\server\share: canonicalize leads there, and the rules don't take a UNC path typed by hand
        assert_eq!(real_problem(r"Z:\work\site", r"\\server\share\work\site", r"C:\Users\a"), None);
        assert_eq!(site_path_problem(r"Z:\work\site", r"C:\Users\a"), None);
        // the share itself is as wide as a drive
        assert_eq!(real_problem(r"Z:\", r"\\server\share", r"C:\Users\a"), Some(TOO_WIDE));
        assert_eq!(real_problem(r"Z:\", r"\\server\share\", r"C:\Users\a"), Some(TOO_WIDE));
        // a home folder on the same share (a roaming profile) keeps its private folders and itself
        assert_eq!(real_problem(r"Z:\a\.ssh\x", r"\\server\share\a\.ssh\x", r"\\SERVER\share\a"), Some(PRIVATE_FOLDER));
        assert_eq!(real_problem(r"Z:\a", r"\\server\share\a", r"\\server\share\a"), Some(TOO_WIDE));
        assert_eq!(real_problem(r"Z:\a\.ssh", r"\\server\share\a\.ssh", r"\\server\other\a"), None);
        // a drive letter that leads into the home folder's .ssh is still refused
        assert_eq!(real_problem(r"D:\x", r"C:\Users\a\.ssh\x", r"C:\Users\a"), Some(PRIVATE_FOLDER));
        // a UNC path typed as such stays refused, and so does a Unix path that leads somewhere odd
        assert_eq!(real_problem(r"\\server\share\site", r"\\server\share\site", r"C:\Users\a"), Some(NOT_ABSOLUTE));
        assert_eq!(real_problem("/home/a/site", "/home/a/.ssh", "/home/a"), Some(PRIVATE_FOLDER));
        assert_eq!(real_problem(r"Z:\x", r"\\server", r"C:\Users\a"), Some(NOT_ABSOLUTE));
    }

    #[test]
    fn a_stale_lock_two_writers_judged_leaves_the_fresh_one_made_in_between_in_its_place() {
        let dir = std::env::temp_dir().join(format!("inyon-cli-lock-{}-{}", std::process::id(), random_tag()));
        fs::create_dir_all(&dir).unwrap();
        let lock = dir.join("pages.json.lock");
        fs::write(&lock, "1 stale\n").unwrap();
        let old = std::time::SystemTime::now() - Duration::from_secs(11);
        OpenOptions::new().write(true).open(&lock).unwrap().set_modified(old).unwrap();
        let judged = fs::metadata(&lock).unwrap();
        fs::remove_file(&lock).unwrap();
        fs::write(&lock, "2 fresh\n").unwrap();
        remove_judged(&lock, &judged).unwrap();
        assert_eq!(fs::read_to_string(&lock).unwrap(), "2 fresh\n");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn a_stale_lock_that_cannot_be_removed_says_so_at_once_instead_of_waiting() {
        use std::os::unix::fs::PermissionsExt;
        if unsafe { libc::geteuid() } == 0 {
            return; // root ignores the folder's mode
        }
        let dir = std::env::temp_dir().join(format!("inyon-cli-lock-ro-{}-{}", std::process::id(), random_tag()));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("pages.json");
        let lock = dir.join("pages.json.lock");
        fs::write(&lock, "1\n").unwrap();
        OpenOptions::new().write(true).open(&lock).unwrap().set_modified(std::time::SystemTime::now() - Duration::from_secs(11)).unwrap();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o500)).unwrap();
        let started = Instant::now();
        let r = with_lock(&file, || Ok(()));
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).unwrap();
        let _ = fs::remove_dir_all(&dir);
        let err = r.unwrap_err();
        assert!(err.contains("If an agent's sandbox stopped it"), "{err}");
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn a_linked_worktree_belongs_to_the_main_checkout() {
        assert_eq!(main_tree("/r/.claude/worktrees/x", "/r/.git", "/r/.git/worktrees/x"), "/r");
        assert_eq!(main_tree("/r", "/r/.git", "/r/.git"), "/r");
        // a submodule, and a bare repo's worktree, keep their own top level
        assert_eq!(main_tree("/r/sub", "/r/.git/modules/sub", "/r/.git/modules/sub"), "/r/sub");
        assert_eq!(main_tree("/w/x", "/w/repo.git", "/w/repo.git/worktrees/x"), "/w/x");
        assert_eq!(main_tree("/r", "", ""), "/r");
    }

    #[test]
    fn verbatim_paths_lose_their_prefix() {
        assert_eq!(strip_verbatim(r"\\?\C:\Users\a\site"), r"C:\Users\a\site");
        assert_eq!(strip_verbatim(r"\\?\UNC\server\share\site"), r"\\server\share\site");
        assert_eq!(strip_verbatim("/home/a/site"), "/home/a/site");
    }

    #[cfg(unix)]
    #[test]
    fn dots_are_worked_out_from_the_text() {
        assert_eq!(lexical(Path::new("/a/b/../c/./d/")), PathBuf::from("/a/c/d"));
        assert_eq!(lexical(Path::new("/../..")), PathBuf::from("/"));
    }

    #[test]
    fn agents_from_their_variables() {
        let env = |pairs: &'static [(&'static str, &'static str)]| move |k: &str| pairs.iter().find(|(n, _)| *n == k).map(|(_, v)| v.to_string());
        assert_eq!(agent(env(&[("CLAUDECODE", "1")])), "claude");
        assert_eq!(agent(env(&[("CODEX_THREAD_ID", "x")])), "codex");
        assert_eq!(agent(env(&[("GEMINI_CLI", "1")])), "gemini");
        assert_eq!(agent(env(&[("OPENCODE", "1")])), "opencode");
        assert_eq!(agent(env(&[("CLAUDECODE", "")])), "cli");
        assert_eq!(agent(env(&[])), "cli");
    }

    #[test]
    fn windows_folders_are_judged_too() {
        assert_eq!(site_path_problem(r"C:\Users\a\site", r"C:\Users\a"), None);
        assert_eq!(site_path_problem(r"C:\Users\a", r"C:\Users\a"), Some(TOO_WIDE));
        assert_eq!(site_path_problem(r"C:\Users\a\.inyon\x", r"C:\Users\a"), Some(PRIVATE_FOLDER));
        assert_eq!(site_path_problem("C:/Users/a/.ssh", r"C:\Users\a"), Some(PRIVATE_FOLDER));
        assert_eq!(site_path_problem(r"C:\", r"C:\Users\a"), Some(TOO_WIDE));
        assert_eq!(site_path_problem(r"\\server\share\site", r"C:\Users\a"), Some(NOT_ABSOLUTE));
    }
}
