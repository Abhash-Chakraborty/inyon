//! Nothing real is touched: home is a throwaway folder, a local server stands in for the GitHub
//! releases and the hub, and restarting the services is a fake that records what it was asked.

mod common;

use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use common::{lock, Home};
use inyon_cli::service::{Installed, Role};
use inyon_cli::sys::{Platform, RealProc};
use inyon_cli::update::{
    self, cleanup_old, find_install, latest_version, reinstall_command, release_names, swap_back, swap_in, wait_started, Arch, Error, Files, Host, Kind, RealFiles, WaitOptions,
};

fn sha(b: &[u8]) -> String {
    update::sha256(b)
}

fn gzip(b: &[u8]) -> Vec<u8> {
    let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    e.write_all(b).unwrap();
    e.finish().unwrap()
}

/// A release: each file is attached plain and gzipped too, and SHA256SUMS lists both (or whatever
/// `sums` says). Files in `missing` are listed but not there to download.
#[derive(Clone)]
struct Release {
    version: String,
    files: BTreeMap<String, String>,
    gz: bool,
    sums: String,
    missing: Vec<String>,
}

impl Release {
    fn assets(&self) -> BTreeMap<String, Vec<u8>> {
        let mut a = BTreeMap::new();
        for (name, body) in &self.files {
            a.insert(name.clone(), body.as_bytes().to_vec());
            if self.gz {
                a.insert(format!("{name}.gz"), gzip(body.as_bytes()));
            }
        }
        a
    }
    fn sums(&self) -> String {
        if !self.sums.is_empty() {
            return self.sums.clone();
        }
        self.assets().iter().map(|(name, body)| format!("{}  {name}\n", sha(body))).collect()
    }
}

struct HubBuilds {
    builds: BTreeMap<String, String>,
    sum_override: String,
}

struct Server {
    base: String,
    release: Arc<Mutex<Release>>,
    hub: Arc<Mutex<HubBuilds>>,
    requests: Arc<Mutex<Vec<String>>>,
}

impl Server {
    fn start() -> Server {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let release = Arc::new(Mutex::new(Release { version: "9.9.9".into(), files: BTreeMap::new(), gz: true, sums: String::new(), missing: Vec::new() }));
        let hub = Arc::new(Mutex::new(HubBuilds {
            builds: [("linux-x64", "new linux build"), ("windows-x64", "new exe")].into_iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
            sum_override: String::new(),
        }));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let (r, h, q) = (release.clone(), hub.clone(), requests.clone());
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut s) = stream else { continue };
                let mut buf = Vec::new();
                let mut chunk = [0u8; 4096];
                while let Ok(n) = s.read(&mut chunk) {
                    buf.extend_from_slice(&chunk[..n]);
                    if n == 0 || buf.windows(4).any(|w| w == b"\r\n\r\n") {
                        break;
                    }
                }
                let head = String::from_utf8_lossy(&buf).into_owned();
                let target = head.lines().next().and_then(|l| l.split_whitespace().nth(1)).unwrap_or("/").to_string();
                q.lock().unwrap().push(target.clone());
                let (path, query) = target.split_once('?').map(|(p, q)| (p.to_string(), q.to_string())).unwrap_or((target.clone(), String::new()));
                let param = |k: &str| query.split('&').find_map(|kv| kv.strip_prefix(&format!("{k}=")).map(String::from)).unwrap_or_default();
                let (status, extra, body): (&str, String, Vec<u8>) = {
                    let rel = r.lock().unwrap();
                    let hb = h.lock().unwrap();
                    if path == "/releases/latest" {
                        ("302 Found", format!("Location: https://github.com/x/y/releases/tag/v{}\r\n", rel.version), Vec::new())
                    } else if path == "/releases/latest/download/SHA256SUMS" {
                        ("200 OK", String::new(), rel.sums().into_bytes())
                    } else if let Some(asset) = path.strip_prefix("/releases/latest/download/") {
                        match (!rel.missing.iter().any(|m| m == asset)).then(|| rel.assets().get(asset).cloned()).flatten() {
                            Some(b) => ("200 OK", String::new(), b),
                            None => ("404 Not Found", String::new(), b"not found".to_vec()),
                        }
                    } else {
                        let build = hb.builds.get(&format!("{}-{}", param("os"), param("arch"))).cloned();
                        match (path.as_str(), build) {
                            ("/node/inyon.sha256", Some(b)) => {
                                ("200 OK", String::new(), if hb.sum_override.is_empty() { sha(b.as_bytes()) } else { hb.sum_override.clone() }.into_bytes())
                            }
                            ("/node/inyon.gz", Some(b)) => ("200 OK", String::new(), gzip(b.as_bytes())),
                            _ => ("404 Not Found", String::new(), b"not found".to_vec()),
                        }
                    }
                };
                let _ = write!(s, "HTTP/1.1 {status}\r\n{extra}Content-Length: {}\r\nConnection: close\r\n\r\n", body.len());
                let _ = s.write_all(&body);
                let _ = s.flush();
            }
        });
        Server { base: format!("http://127.0.0.1:{port}"), release, hub, requests }
    }

    fn release(&self, f: impl FnOnce(&mut Release)) {
        f(&mut self.release.lock().unwrap());
    }

    fn requests(&self) -> Vec<String> {
        self.requests.lock().unwrap().clone()
    }

    fn clear_requests(&self) {
        self.requests.lock().unwrap().clear();
    }

    fn downloads(&self) -> Vec<String> {
        self.requests().iter().filter(|r| r.starts_with("/releases/latest/download/") && !r.ends_with("SHA256SUMS")).map(|r| r.rsplit('/').next().unwrap().to_string()).collect()
    }
}

struct FakeHost {
    base: String,
    version: String,
    roles: Vec<Role>,
    restarts: RefCell<Vec<(Role, Vec<String>)>>,
    waited: RefCell<Vec<Role>>,
    started_ok: Cell<bool>,
    platform: Platform,
    arch: Arch,
}

impl FakeHost {
    fn new(server: &Server, roles: &[Role]) -> FakeHost {
        FakeHost {
            base: format!("{}/releases/latest/download", server.base),
            version: "0.6.3".into(),
            roles: roles.to_vec(),
            restarts: RefCell::new(Vec::new()),
            waited: RefCell::new(Vec::new()),
            started_ok: Cell::new(true),
            platform: Platform::current(),
            arch: Arch::current(),
        }
    }
    fn restarted_roles(&self) -> Vec<Role> {
        self.restarts.borrow().iter().map(|(r, _)| *r).collect()
    }
}

impl Host for FakeHost {
    fn version(&self) -> String {
        self.version.clone()
    }
    fn roles(&self) -> Vec<Role> {
        self.roles.clone()
    }
    fn restart(&self, role: Role, cmd: &[String]) -> Installed {
        self.restarts.borrow_mut().push((role, cmd.to_vec()));
        Installed { ok: true, how: "fake".into() }
    }
    fn started(&self, role: Role, _version: Option<&str>, _before: Option<u32>) -> bool {
        self.waited.borrow_mut().push(role);
        self.started_ok.get()
    }
    fn log(&self, _line: &str) {}
    fn platform(&self) -> Platform {
        self.platform
    }
    fn arch(&self) -> Arch {
        self.arch
    }
    fn download_base(&self) -> String {
        self.base.clone()
    }
}

struct Fixture {
    home: Home,
    server: Server,
    cli_name: String,
    engine_name: String,
}

impl Fixture {
    fn new() -> Fixture {
        let home = Home::new(&[]);
        let server = Server::start();
        let names = release_names(Platform::current(), Arch::current()).unwrap();
        fs::create_dir_all(home.dir.join(".inyon/bin")).unwrap();
        fs::write(home.dir.join(".inyon/bin/inyon"), "old build").unwrap();
        let (cli, engine) = (names.cli.clone(), names.engine.clone());
        server.release(|r| {
            r.files.insert(cli.clone(), "cli build".into());
            r.files.insert(engine.clone(), "engine build".into());
            r.files.insert("inyon-other".into(), "other".into());
        });
        Fixture { home, server, cli_name: names.cli, engine_name: names.engine }
    }
    fn installed(&self) -> PathBuf {
        self.home.dir.join(".inyon/bin/inyon")
    }
    fn engine(&self) -> PathBuf {
        self.home.dir.join(".inyon/bin/inyon-engine")
    }
    fn bin_names(&self) -> Vec<String> {
        let mut v: Vec<String> = fs::read_dir(self.home.dir.join(".inyon/bin")).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        v.sort();
        v
    }
    fn run(&self, host: &FakeHost) -> Result<update::Outcome, Error> {
        update::update(&find_install(&self.installed(), None), host, &RealFiles)
    }
    fn read(&self, p: &Path) -> String {
        fs::read_to_string(p).unwrap_or_default()
    }
}

#[test]
fn the_newest_version_comes_from_where_releases_latest_redirects_or_from_a_pinned_tag() {
    let _g = lock();
    let f = Fixture::new();
    f.server.release(|r| r.version = "0.7.1".into());
    assert_eq!(latest_version(&format!("{}/releases/latest/download", f.server.base)).unwrap(), "0.7.1");
    assert_eq!(latest_version("https://example.invalid/x/releases/download/v0.6.9").unwrap(), "0.6.9");
    assert!(matches!(latest_version(&format!("{}/nothing-here/download", f.server.base)), Err(Error::Update(_))));
}

#[test]
fn a_release_installs_the_engine_next_to_inyon_then_the_new_inyon_and_restarts_each_job() {
    let _g = lock();
    let f = Fixture::new();
    let host = FakeHost::new(&f.server, &[Role::Link, Role::Hub]);
    let r = f.run(&host).unwrap();
    assert!(r.changed);
    assert_eq!(r.version.as_deref(), Some("9.9.9"));
    assert_eq!(f.read(&f.installed()), "cli build");
    assert_eq!(f.read(&f.engine()), "engine build");
    let cmd = vec![f.installed().to_string_lossy().into_owned()];
    assert_eq!(*host.restarts.borrow(), vec![(Role::Link, cmd.clone()), (Role::Hub, cmd)]);
    assert_eq!(*host.waited.borrow(), vec![Role::Link, Role::Hub]);
    // the old copy is gone once the new one runs, and no download is left behind
    assert_eq!(f.bin_names(), vec!["inyon", "inyon-engine"]);
    // the gzipped copies, since the release lists them, the engine first
    assert_eq!(f.server.downloads(), vec![format!("{}.gz", f.engine_name), format!("{}.gz", f.cli_name)]);
}

#[test]
fn a_release_without_gzipped_files_is_downloaded_plain() {
    let _g = lock();
    let f = Fixture::new();
    f.server.release(|r| r.gz = false);
    let host = FakeHost::new(&f.server, &[Role::Link]);
    assert!(f.run(&host).unwrap().changed);
    assert_eq!(f.read(&f.installed()), "cli build");
    assert_eq!(f.server.downloads(), vec![f.engine_name.clone(), f.cli_name.clone()]);
}

#[test]
fn a_release_from_before_the_split_has_no_engine_so_nothing_is_changed_and_it_says_so() {
    let _g = lock();
    let f = Fixture::new();
    let cli = f.cli_name.clone();
    f.server.release(|r| {
        r.files = [(cli, "new build".to_string())].into_iter().collect();
    });
    let host = FakeHost::new(&f.server, &[Role::Link]);
    let r = f.run(&host).unwrap();
    assert!(!r.changed);
    assert!(r.message.contains(&f.engine_name), "{}", r.message);
    assert!(r.message.contains("nothing was changed"));
    assert_eq!(f.read(&f.installed()), "old build");
    assert!(f.server.downloads().is_empty());
    assert!(host.restarts.borrow().is_empty());
}

#[test]
fn a_download_that_does_not_match_sha256sums_changes_nothing() {
    let _g = lock();
    let f = Fixture::new();
    let (cli, engine) = (f.cli_name.clone(), f.engine_name.clone());
    f.server.release(|r| {
        r.gz = false;
        r.sums = format!("{}  {engine}\n{}  {cli}\n", sha(b"something else"), sha(b"cli build"));
    });
    let host = FakeHost::new(&f.server, &[Role::Link]);
    let err = f.run(&host).unwrap_err().to_string();
    assert!(err.contains("didn't match the release's checksum"), "{err}");
    assert_eq!(f.read(&f.installed()), "old build");
    assert_eq!(f.bin_names(), vec!["inyon"]);
    assert!(host.restarts.borrow().is_empty());
}

#[test]
fn the_gzipped_file_is_checked_before_it_is_unpacked_and_the_unpacked_file_after() {
    let _g = lock();
    let f = Fixture::new();
    let (cli, engine) = (f.cli_name.clone(), f.engine_name.clone());
    let plain = sha(b"engine build");
    let gz = sha(&gzip(b"engine build"));
    let cli_sums = format!("{}  {cli}\n{}  {cli}.gz\n", sha(b"cli build"), sha(&gzip(b"cli build")));
    // a .gz that isn't the one listed
    let s = format!("{plain}  {engine}\n{}  {engine}.gz\n{cli_sums}", sha(b"tampered"));
    f.server.release(|r| r.sums = s);
    let host = FakeHost::new(&f.server, &[Role::Link]);
    assert!(f.run(&host).unwrap_err().to_string().contains("didn't match the release's checksum"));
    assert_eq!(f.read(&f.installed()), "old build");
    // the right .gz, but it unpacks to something other than the plain file listed
    let s = format!("{}  {engine}\n{gz}  {engine}.gz\n{cli_sums}", sha(b"tampered"));
    f.server.release(|r| r.sums = s);
    assert!(f.run(&host).unwrap_err().to_string().contains("didn't match the release's checksum"));
    assert_eq!(f.read(&f.installed()), "old build");
    assert_eq!(f.server.downloads(), vec![format!("{engine}.gz"), format!("{engine}.gz")]);
    assert_eq!(f.bin_names(), vec!["inyon"]);
}

#[test]
fn a_file_missing_from_sha256sums_is_refused_too() {
    let _g = lock();
    let f = Fixture::new();
    let engine = f.engine_name.clone();
    f.server.release(|r| r.sums = format!("{}  {engine}\n{}  inyon-some-other-build\n", sha(b"engine build"), sha(b"cli build")));
    let host = FakeHost::new(&f.server, &[Role::Link]);
    let err = f.run(&host).unwrap_err().to_string();
    assert!(err.contains("doesn't list"), "{err}");
    assert_eq!(f.read(&f.installed()), "old build");
    assert_eq!(f.bin_names(), vec!["inyon"]);
}

#[test]
fn a_release_where_either_file_is_bad_changes_nothing_and_says_how_to_install_instead() {
    let _g = lock();
    let f = Fixture::new();
    let cli_gz = format!("{}.gz", f.cli_name);
    f.server.release(|r| r.missing = vec![cli_gz]);
    let host = FakeHost::new(&f.server, &[Role::Link]);
    let err = f.run(&host).unwrap_err().to_string();
    assert!(err.ends_with("\n  curl -fsSL https://inyon.abhashchakraborty.tech/get.sh | sh"), "{err}");
    assert!(err.contains("Couldn't download"), "{err}");
    assert_eq!(f.read(&f.installed()), "old build");
    assert_eq!(f.bin_names(), vec!["inyon"]);
    assert!(host.restarts.borrow().is_empty());

    // the engine doesn't match: nothing is downloaded after it
    let (cli, engine) = (f.cli_name.clone(), f.engine_name.clone());
    f.server.release(|r| {
        r.missing.clear();
        r.sums = format!("{}  {engine}\n{}  {cli}\n", sha(b"wrong"), sha(b"cli build"));
    });
    f.server.clear_requests();
    let err = f.run(&host).unwrap_err().to_string();
    assert!(err.contains("didn't match the release's checksum"), "{err}");
    assert_eq!(f.server.downloads(), vec![engine.clone()]);
    assert_eq!(f.bin_names(), vec!["inyon"]);

    // on Windows the line is the PowerShell one
    f.server.release(|r| {
        r.sums.clear();
        r.missing = vec!["inyon-windows-x64.exe.gz".into()];
        r.files = [("inyon-windows-x64.exe", "cli"), ("inyon-engine-windows-x64.exe", "engine")].into_iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
    });
    let mut win = FakeHost::new(&f.server, &[Role::Link]);
    win.platform = Platform::Windows;
    win.arch = Arch::X64;
    let err = f.run(&win).unwrap_err().to_string();
    assert!(err.ends_with("\n  irm https://inyon.abhashchakraborty.tech/get.ps1 | iex"), "{err}");
    assert_eq!(reinstall_command(Platform::Darwin), "curl -fsSL https://inyon.abhashchakraborty.tech/get.sh | sh");
}

#[test]
fn a_release_that_does_not_start_goes_back_to_the_old_inyon_alone_and_says_how_to_install() {
    let _g = lock();
    let f = Fixture::new();
    let host = FakeHost::new(&f.server, &[Role::Link]);
    host.started_ok.set(false);
    let err = f.run(&host).unwrap_err().to_string();
    assert!(err.contains("the previous version is running again"), "{err}");
    assert!(err.ends_with(&reinstall_command(Platform::current())), "{err}");
    assert_eq!(f.read(&f.installed()), "old build");
    assert_eq!(host.restarted_roles(), vec![Role::Link, Role::Link]);
    // the engine went too, since nothing of the old version starts it
    assert!(!f.engine().exists());
}

#[test]
fn already_on_the_newest_version_says_so_and_downloads_nothing() {
    let _g = lock();
    let f = Fixture::new();
    f.server.release(|r| r.version = "0.6.3".into());
    let host = FakeHost::new(&f.server, &[Role::Link]);
    let r = f.run(&host).unwrap();
    assert_eq!(r, update::Outcome { changed: false, message: "inyon 0.6.3 is up to date.".into(), version: Some("0.6.3".into()) });
    assert_eq!(f.server.requests(), vec!["/releases/latest"]);
    assert!(host.restarts.borrow().is_empty());
}

#[test]
fn a_new_version_that_does_not_start_is_swapped_back_out_and_every_job_restarted_on_the_old_one() {
    let _g = lock();
    let f = Fixture::new();
    fs::write(f.engine(), "old engine").unwrap();
    let host = FakeHost::new(&f.server, &[Role::Link, Role::Node]);
    host.started_ok.set(false);
    let err = f.run(&host).unwrap_err().to_string();
    assert!(err.contains("the previous version is running again"), "{err}");
    assert_eq!(f.read(&f.installed()), "old build");
    assert_eq!(f.read(&f.engine()), "old engine");
    assert_eq!(host.restarted_roles(), vec![Role::Link, Role::Node, Role::Link, Role::Node]);
}

#[test]
fn nothing_running_in_the_background_the_new_file_is_in_place_for_the_next_start() {
    let _g = lock();
    let f = Fixture::new();
    let host = FakeHost::new(&f.server, &[]);
    let r = f.run(&host).unwrap();
    assert!(r.message.contains("isn't running as a background service"), "{}", r.message);
    assert_eq!(f.read(&f.installed()), "cli build");
    assert_eq!(f.read(&f.engine()), "engine build");
}

#[test]
fn a_machine_added_to_a_hub_takes_the_hub_build_when_it_differs_checked_against_the_hub_sha256() {
    let _g = lock();
    let f = Fixture::new();
    let install = find_install(&f.installed(), Some(f.server.base.clone()));
    assert_eq!(install.kind, Kind::Hub(f.server.base.clone()));
    let mut linux = FakeHost::new(&f.server, &[Role::Node]);
    linux.platform = Platform::Linux;
    linux.arch = Arch::X64;
    assert!(update::update(&install, &linux, &RealFiles).unwrap().changed);
    // the hub serves the engine; this program stays as it is
    assert_eq!(f.read(&f.engine()), "new linux build");
    assert_eq!(f.read(&f.installed()), "old build");
    assert_eq!(*linux.restarts.borrow(), vec![(Role::Node, vec![f.installed().to_string_lossy().into_owned()])]);
    assert!(f.server.requests().contains(&"/node/inyon.gz?os=linux&arch=x64".to_string()));

    // the same file as the hub's: nothing to do
    linux.restarts.borrow_mut().clear();
    assert!(!update::update(&install, &linux, &RealFiles).unwrap().changed);
    assert!(linux.restarts.borrow().is_empty());

    // a checksum that doesn't match leaves the running copy alone
    {
        let mut hub = f.server.hub.lock().unwrap();
        hub.builds.insert("linux-x64".into(), "tampered".into());
        hub.sum_override = sha(b"what the hub meant");
    }
    let err = update::update(&install, &linux, &RealFiles).unwrap_err().to_string();
    assert!(err.contains("didn't match the hub's checksum"), "{err}");
    assert_eq!(f.read(&f.engine()), "new linux build");
}

#[test]
fn a_windows_machine_asks_its_hub_for_the_windows_build_whatever_its_processor() {
    let _g = lock();
    let f = Fixture::new();
    let install = find_install(&f.installed(), Some(f.server.base.clone()));
    let mut win = FakeHost::new(&f.server, &[Role::Node]);
    win.platform = Platform::Windows;
    win.arch = Arch::Arm64;
    assert!(update::update(&install, &win, &RealFiles).unwrap().changed);
    assert_eq!(f.read(&f.engine()), "new exe");
    assert!(f.server.requests().contains(&"/node/inyon.gz?os=windows&arch=x64".to_string()));
}

#[test]
fn which_install_is_running() {
    let _g = lock();
    let f = Fixture::new();
    assert_eq!(find_install(&f.installed(), None).kind, Kind::Binary);
    assert_eq!(find_install(&f.installed(), Some("http://hub".into())).kind, Kind::Hub("http://hub".into()));
    // tether-node's old place, before it has moved
    assert_eq!(find_install(&f.home.dir.join(".tether-node/tether-node.exe"), Some("http://hub".into())).kind, Kind::Hub("http://hub".into()));
}

/// Acts like Windows: a running program can be renamed, but not deleted or overwritten.
struct WindowsFiles {
    locked: RefCell<HashSet<PathBuf>>,
    block_from: Option<PathBuf>,
}

impl Files for WindowsFiles {
    fn rename(&self, from: &Path, to: &Path) -> std::io::Result<()> {
        if self.block_from.as_deref() == Some(from) {
            return Err(std::io::Error::other("EPERM: blocked by antivirus"));
        }
        if self.locked.borrow().contains(to) {
            return Err(std::io::Error::other(format!("EPERM: {}", to.display())));
        }
        fs::rename(from, to)?;
        // the lock follows the running file to its new name
        let mut l = self.locked.borrow_mut();
        if l.remove(from) {
            l.insert(to.to_path_buf());
        }
        Ok(())
    }
    fn remove(&self, f: &Path) -> std::io::Result<()> {
        if self.locked.borrow().contains(f) {
            return Err(std::io::Error::other(format!("EBUSY: {}", f.display())));
        }
        RealFiles.remove(f)
    }
    fn exists(&self, f: &Path) -> bool {
        f.exists()
    }
    fn list(&self, dir: &Path) -> std::io::Result<Vec<String>> {
        RealFiles.list(dir)
    }
}

#[test]
fn windows_the_running_exe_is_renamed_aside_the_new_one_takes_its_name_the_old_one_goes_later() {
    let _g = lock();
    let f = Fixture::new();
    let exe = f.installed();
    let fresh = PathBuf::from(format!("{}.download", exe.display()));
    fs::write(&fresh, "new build").unwrap();
    let files = WindowsFiles { locked: RefCell::new([exe.clone()].into_iter().collect()), block_from: None };
    let t0: u64 = 1_000_000_000_000;
    let old = swap_in(&files, &exe, &fresh, t0).unwrap().unwrap();
    assert_eq!(old, PathBuf::from(format!("{}.old-{t0}", exe.display())));
    assert_eq!(f.read(&exe), "new build");
    assert!(files.locked.borrow().contains(&old));

    // still running: cleaning up leaves it, quietly
    cleanup_old(&files, &exe, t0 + 11 * 60_000);
    assert!(old.exists());
    // stopped, but from an update that may still be going on: kept for going back to
    files.locked.borrow_mut().clear();
    cleanup_old(&files, &exe, t0 + 5 * 60_000);
    assert!(old.exists());
    cleanup_old(&files, &exe, t0 + 11 * 60_000);
    assert!(!old.exists());
    assert!(exe.exists());
}

#[test]
fn windows_if_the_new_file_cannot_take_the_name_the_old_one_gets_it_back() {
    let _g = lock();
    let f = Fixture::new();
    let exe = f.installed();
    let fresh = PathBuf::from(format!("{}.download", exe.display()));
    fs::write(&fresh, "new build").unwrap();
    let files = WindowsFiles { locked: RefCell::new(HashSet::new()), block_from: Some(fresh.clone()) };
    let err = swap_in(&files, &exe, &fresh, 5).unwrap_err();
    assert!(err.to_string().contains("EPERM"));
    assert_eq!(f.read(&exe), "old build");
}

#[test]
fn windows_going_back_renames_the_new_copy_aside_too_in_case_it_is_still_running() {
    let _g = lock();
    let f = Fixture::new();
    let exe = f.installed();
    let fresh = PathBuf::from(format!("{}.download", exe.display()));
    fs::write(&fresh, "new build").unwrap();
    let old = swap_in(&RealFiles, &exe, &fresh, 1).unwrap().unwrap();
    let files = WindowsFiles { locked: RefCell::new([exe.clone()].into_iter().collect()), block_from: None };
    swap_back(&files, &exe, &old, 2).unwrap();
    assert_eq!(f.read(&exe), "old build");
    assert_eq!(f.read(&PathBuf::from(format!("{}.old-2", exe.display()))), "new build");
}

#[test]
fn the_restarted_copy_counts_once_it_names_the_new_version_is_a_new_process_and_stays_up() {
    let _g = lock();
    let f = Fixture::new();
    let state = f.home.dir.join(".inyon/node/state.json");
    fs::create_dir_all(state.parent().unwrap()).unwrap();
    let fast = WaitOptions { tries: 3, every_ms: 1, settle_ms: 1 };
    let me = std::process::id();
    fs::write(&state, format!(r#"{{"pid":{me},"version":"9.9.9"}}"#)).unwrap();
    assert!(wait_started(&RealProc, Role::Link, Some("9.9.9"), None, &fast));
    // still the copy from before the restart
    assert!(!wait_started(&RealProc, Role::Link, Some("9.9.9"), Some(me), &fast));
    assert!(!wait_started(&RealProc, Role::Link, Some("9.9.10"), None, &fast));
    fs::write(&state, format!(r#"{{"pid":{},"version":"9.9.9"}}"#, (1u32 << 22) + 12345)).unwrap();
    assert!(!wait_started(&RealProc, Role::Link, Some("9.9.9"), None, &fast));
}
