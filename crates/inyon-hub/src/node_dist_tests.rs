//! node-dist.test.ts, pair-command.test.ts (the one-liner run against the real install.sh) and
//! node-update-scripts.test.ts's checks of hub-update.ps1, which this hub still sends.

use std::cell::RefCell;
use std::rc::Rc;

use super::*;

fn q(s: &str) -> Query {
    Query(s.to_owned())
}

fn block<F: std::future::Future>(f: F) -> F::Output {
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    tokio::task::LocalSet::new().block_on(&rt, async {
        inyon_core::platform::rt::install(Rc::new(inyon_backends::runtime::TokioRuntime));
        f.await
    })
}

#[test]
fn a_download_names_its_system_windows_on_arm_gets_its_own_command_but_the_x64_engine() {
    assert_eq!(target_of(&q("os=linux&arch=arm64")).unwrap(), "linux-arm64");
    assert_eq!(target_of(&q("os=darwin&arch=x64")).unwrap(), "darwin-x64");
    assert_eq!(target_of(&q("os=windows&arch=arm64")).unwrap(), "windows-x64");
    assert_eq!(cli_target_of(&q("os=windows&arch=arm64")).unwrap(), "windows-arm64");
    assert_eq!(cli_target_of(&q("os=linux&arch=x64")).unwrap(), "linux-x64");
    // what tether-node's Windows installer asked with: no os at all
    assert_eq!(target_of(&q("arch=x64")).unwrap(), "windows-x64");
    assert_eq!(cli_target_of(&q("arch=x64")).unwrap(), "windows-x64");
    assert!(target_of(&q("os=plan9&arch=x64")).unwrap_err().message.starts_with("os must be"));
    assert!(cli_target_of(&q("os=plan9&arch=x64")).unwrap_err().message.starts_with("os must be"));
    assert!(target_of(&q("os=linux&arch=x86")).unwrap_err().message.starts_with("arch must be"));
}

#[test]
fn the_pinned_busybox_checksum_is_served_per_architecture_without_a_download() {
    let (x64, arm64) = (busybox_pin(&arch_of(&q("os=windows&arch=x64")).unwrap()).1, busybox_pin(&arch_of(&q("arch=arm64")).unwrap()).1);
    assert!(x64.len() == 64 && arm64.len() == 64 && x64 != arm64);
    assert_eq!(busybox_pin(&arch_of(&q("")).unwrap()).1, x64);
    assert_eq!(arch_of(&q("arch=x86")).unwrap_err().status, Some(400));
}

#[test]
fn tether_node_on_linux_is_told_to_run_add_a_machine_again() {
    let dir = std::env::temp_dir().join(format!("inyon-node-dist-{}", crate::http::random_hex(6)));
    let d = Dist::new(None, &dir);
    let e = block(d.update_script("linux", "x64")).unwrap_err();
    assert!(e.message.contains("Add a machine"));
    assert!(REPLACED.contains("Copy the \"Add a machine\" command from the hub again"));
}

#[test]
fn the_installers_are_served_as_they_are_in_the_repository() {
    assert!(INSTALL_SH.starts_with("#!/bin/sh\n"));
    assert!(INSTALL_PS1.contains("$TaskName = 'Inyon node'"));
}

#[test]
fn earlier_builds_go_with_their_gz_and_sha256_this_build_this_release_and_busybox_stay() {
    let dir = std::env::temp_dir().join(format!("inyon-node-dist-{}", crate::http::random_hex(6)));
    std::fs::create_dir_all(&dir).unwrap();
    let d = Dist::new(None, &dir);
    // a hub run as the program: its tag is its release
    let tag = d.tag().to_owned();
    let stale = [
        "v0.12.0-inyon-engine-linux-x64",
        "v0.12.0-inyon-engine-linux-x64.gz",
        "v0.12.0-inyon-engine-linux-x64.sha256",
        "v0.12.0-inyon-windows-x64.exe",
        "0123456789abcdef-inyon-engine-darwin-arm64",
        "inyon-0123456789abcdef-inyon-engine-linux-x64",
        "tether-node-0123456789abcdef.js",
    ];
    let mut kept = vec![
        format!("{tag}-inyon-engine-linux-x64"),
        format!("{tag}-inyon-engine-linux-x64.gz"),
        format!("{tag}-inyon-engine-linux-x64.sha256"),
        format!("{tag}-inyon-engine-windows-x64.exe.tmp"),
        format!("v{VERSION}-inyon-windows-arm64.exe"),
        "busybox-w64u-FRP-6075-g169694ebd.exe".to_owned(),
        "notes.txt".to_owned(),
    ];
    for f in stale.iter().map(|s| s.to_string()).chain(kept.clone()) {
        std::fs::write(dir.join(&f), &f).unwrap();
    }
    d.prune_old(&dir);
    let mut left: Vec<String> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    left.sort();
    kept.sort();
    let _ = std::fs::remove_dir_all(&dir);
    assert_eq!(left, kept);
}

/// A stand-in for the GitHub release the hub takes the program from: names asked are noted.
fn release(asked: Rc<RefCell<Vec<String>>>, gz: Vec<u8>) -> Get {
    Rc::new(move |url: String| {
        let name = url.rsplit('/').next().unwrap_or("").to_owned();
        asked.borrow_mut().push(name.clone());
        let gz = gz.clone();
        Box::pin(async move {
            if url.contains("/gone/") {
                return Ok((404, b"no".to_vec()));
            }
            Ok(match name.as_str() {
                "inyon-linux-x64" => (200, BUILD.as_bytes().to_vec()),
                "inyon-linux-x64.gz" => (200, gz),
                _ => (404, b"no".to_vec()),
            })
        })
    })
}
const BUILD: &str = "the linux build";

#[test]
fn the_hub_takes_the_gzipped_release_file_when_sha256sums_lists_one_and_keeps_the_plain_bytes() {
    let gz = gzip(BUILD.as_bytes()).unwrap();
    let asked = Rc::new(RefCell::new(vec![]));
    let sums = format!("{}  inyon-linux-x64\n{}  inyon-linux-x64.gz\n", digest(BUILD.as_bytes()), digest(&gz));
    assert_eq!(block(release_file("inyon-linux-x64", &sums, "http://r", release(asked.clone(), gz.clone()))).unwrap(), BUILD.as_bytes());
    assert_eq!(*asked.borrow(), ["inyon-linux-x64.gz"]);
    // a release from before 0.11: the plain file
    asked.borrow_mut().clear();
    let plain_sums = format!("{}  inyon-linux-x64\n", digest(BUILD.as_bytes()));
    assert_eq!(block(release_file("inyon-linux-x64", &plain_sums, "http://r", release(asked.clone(), gz))).unwrap(), BUILD.as_bytes());
    assert_eq!(*asked.borrow(), ["inyon-linux-x64"]);
}

#[test]
fn both_the_gz_and_what_it_unpacks_to_are_checked_and_a_file_not_listed_is_refused() {
    let gz = gzip(BUILD.as_bytes()).unwrap();
    let get = || release(Rc::default(), gz.clone());
    let err = |name: &str, sums: String, base: &str| block(release_file(name, &sums, base, get())).unwrap_err().message;
    let (b, g, o) = (digest(BUILD.as_bytes()), digest(&gz), digest(b"other"));
    assert!(err("inyon-linux-x64", format!("{b}  inyon-linux-x64\n{o}  inyon-linux-x64.gz\n"), "http://r").contains("inyon-linux-x64.gz did not match"));
    assert!(err("inyon-linux-x64", format!("{o}  inyon-linux-x64\n{g}  inyon-linux-x64.gz\n"), "http://r").contains("inyon-linux-x64 did not match"));
    assert!(err("inyon-darwin-x64", format!("{b}  inyon-linux-x64\n"), "http://r").contains("has no inyon-darwin-x64"));
    assert_eq!(err("inyon-linux-x64", format!("{b}  inyon-linux-x64\n{g}  inyon-linux-x64.gz\n"), "http://r/gone"), "Could not download inyon-linux-x64.gz (404)");
}

#[test]
fn gzip_writes_the_bytes_nodes_zlib_does() {
    // zlib.gzipSync(…, { level: 6 }) in Bun, for the conformance harness's placeholder engine
    let gz = gzip(b"placeholder inyon-engine-linux-x64 for the conformance harness\n").unwrap();
    assert_eq!(digest(&gz), "6e053e6f46ad8c4e81d14ffa8a5fd73835ad6f5ef9a791a048569389d7f66e78");
}

#[test]
fn checksum_lists_are_read_as_sha256sum_writes_them() {
    let sums = "AB12  inyon-linux-x64\r\ncd34 *inyon-linux-x64.gz\n";
    assert_eq!(sum_for(sums, "inyon-linux-x64").as_deref(), Some("ab12"));
    assert_eq!(sum_for(sums, "inyon-linux-x64.gz").as_deref(), Some("cd34"));
    assert_eq!(sum_for(sums, "inyon"), None);
}

#[test]
fn the_unix_one_liner_carries_the_token_in_the_environment_and_both_checksums() {
    // unixPairCommand('http://hub:4777', 'tok', 'aaa', 'bbb') in Bun
    assert_eq!(
        unix_pair_command("http://hub:4777", "tok", "aaa", "bbb"),
        r#"INYON_TOKEN=tok INYON_SUMS_SHA256=bbb sh -c 'f=$(mktemp) && curl -fsSL "$1/node/install.sh" -o "$f" && if [ "$( (sha256sum "$f" 2>/dev/null || shasum -a 256 "$f") | cut -c1-64)" = "$2" ]; then sh "$f" "$1"; else echo "install.sh did not match its checksum; get a new command from the hub" >&2; false; fi; s=$?; rm -f "$f"; exit $s' inyon http://hub:4777 aaa"#
    );
}

#[test]
fn the_build_tag_is_the_bun_hubs() {
    let Some(repo) = crate::hub_update::checkout() else { return };
    let out = std::process::Command::new("bun")
        .args(["-e", "import { tag } from './apps/hub/src/features/node-dist.ts'; console.log(tag())"])
        .current_dir(&repo)
        .env("NODE_ENV", "test")
        .output();
    let Some(out) = out.ok().filter(|o| o.status.success()) else { return };
    let line = String::from_utf8_lossy(&out.stdout).trim().lines().last().unwrap_or("").to_owned();
    assert_eq!(source_hash(&repo), line);
}

#[cfg(unix)]
#[test]
fn a_checkouts_windows_engine_is_served_though_bun_adds_exe_to_its_name() {
    use std::os::unix::fs::PermissionsExt;
    let dir = std::env::temp_dir().join(format!("inyon-node-dist-{}", crate::http::random_hex(6)));
    let repo = dir.join("repo");
    std::fs::create_dir_all(repo.join("apps/node")).unwrap();
    // Bun.build with a windows target: the outfile gets .exe on the end
    let bun = dir.join("bun");
    std::fs::write(
        &bun,
        "#!/bin/sh\nout=$(printf '%s' \"$2\" | sed -n 's/.*outfile: \"\\([^\"]*\\)\".*/\\1/p')\ncase \"$out\" in *windows*) out=\"$out.exe\";; esac\nprintf 'engine' > \"$out\"\n",
    )
    .unwrap();
    std::fs::set_permissions(&bun, std::fs::Permissions::from_mode(0o755)).unwrap();
    let d = Dist::with_bun(Some(repo), &dir.join("data"), bun);
    let (win, linux) = block(async { (d.engine("windows-x64").await, d.engine("linux-x64").await) });
    let _ = std::fs::remove_dir_all(&dir);
    let win = win.unwrap();
    assert!(win.to_string_lossy().ends_with("-inyon-engine-windows-x64.exe"), "{}", win.display());
    assert!(linux.unwrap().to_string_lossy().ends_with("-inyon-engine-linux-x64"));
}

/// A hub built in a throwaway checkout whose engines a fake bun builds, with nothing in its
/// apps/cli/dist.
#[cfg(unix)]
fn checkout_dist() -> (std::path::PathBuf, Rc<Dist>) {
    use std::os::unix::fs::PermissionsExt;
    let dir = std::env::temp_dir().join(format!("inyon-node-dist-{}", crate::http::random_hex(6)));
    let repo = dir.join("repo");
    std::fs::create_dir_all(repo.join("apps/node")).unwrap();
    let bun = dir.join("bun");
    std::fs::write(
        &bun,
        "#!/bin/sh\nout=$(printf '%s' \"$2\" | sed -n 's/.*outfile: \"\\([^\"]*\\)\".*/\\1/p')\ncase \"$out\" in *windows*) out=\"$out.exe\";; esac\nprintf 'engine' > \"$out\"\n",
    )
    .unwrap();
    std::fs::set_permissions(&bun, std::fs::Permissions::from_mode(0o755)).unwrap();
    let d = Rc::into_inner(Dist::with_bun(Some(repo), &dir.join("data"), bun)).unwrap();
    (dir.clone(), Rc::new(Dist { cli_dist: dir.join("cli-dist"), ..d }))
}

/// The release's checksums, as a release that can't be had answers.
fn sums_fail(d: &Dist) {
    let f: LocalBoxFuture<'static, Result<String, HubError>> = Box::pin(async { Err(http(502, "Could not get the checksums of Inyon 0.17.0 (404)")) });
    *d.sums.borrow_mut() = Some(f.shared());
}

#[cfg(unix)]
#[test]
fn a_checkout_without_a_built_command_hands_windows_the_release_command_and_the_engine_only_when_that_fails() {
    let (dir, d) = checkout_dist();
    std::fs::create_dir_all(&d.out).unwrap();
    let release = d.out.join(format!("v{VERSION}-{}", cli_file("windows-x64")));
    std::fs::write(&release, "release").unwrap();
    // anything that asks the release for its checksums trips this
    let asked = Rc::new(std::cell::Cell::new(false));
    let a = asked.clone();
    let f: LocalBoxFuture<'static, Result<String, HubError>> = Box::pin(async move {
        a.set(true);
        Err(http(502, "the release was asked"))
    });
    *d.sums.borrow_mut() = Some(f.shared());
    let (win, linux) = block(async { (d.source_command("windows-x64").await, d.source_command("linux-x64").await) });
    assert!(!asked.get(), "Linux, or Windows with the release's command already here, asked the release");
    assert_eq!(win.unwrap(), release);
    // Linux and macOS keep the engine standing in for both (install.sh reads that from SHA256SUMS)
    assert_eq!(linux.unwrap(), d.out.join(format!("{}-{}", d.tag(), engine_file("linux-x64"))));
    let built: Vec<String> = std::fs::read_dir(&d.out).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    assert!(!built.iter().any(|f| f.contains("engine-windows")), "{built:?}");
    std::fs::create_dir_all(&d.cli_dist).unwrap();
    std::fs::write(d.cli_dist.join(cli_file("windows-x64")), "built").unwrap();
    assert_eq!(block(d.source_command("windows-x64")).unwrap(), d.cli_dist.join(cli_file("windows-x64")));

    let (dir2, offline) = checkout_dist();
    let warned = Rc::new(RefCell::new(vec![]));
    let w = warned.clone();
    let (win, arm) = block(async {
        let sink: inyon_core::platform::console::Sink = Rc::new(move |_, l: &str| w.borrow_mut().push(l.to_owned()));
        inyon_core::platform::console::set_sink(Some(sink));
        sums_fail(&offline);
        let win = offline.source_command("windows-x64").await;
        sums_fail(&offline);
        let arm = offline.source_command("windows-arm64").await;
        inyon_core::platform::console::set_sink(None);
        (win, arm)
    });
    let _ = (std::fs::remove_dir_all(&dir), std::fs::remove_dir_all(&dir2));
    assert_eq!(win.unwrap(), offline.out.join(format!("{}-{}", offline.tag(), engine_file("windows-x64"))));
    assert!(warned.borrow()[0].contains("handing out the engine instead"), "{:?}", warned.borrow());
    let e = arm.unwrap_err();
    assert_eq!(e.status, Some(503));
    assert!(e.message.contains("has no inyon command for windows-arm64"), "{}", e.message);
}

#[test]
fn a_checkouts_build_and_this_release_both_stay_when_their_tags_differ() {
    let dir = std::env::temp_dir().join(format!("inyon-node-dist-{}", crate::http::random_hex(6)));
    let repo = dir.join("repo");
    std::fs::create_dir_all(repo.join("apps/node")).unwrap();
    std::fs::write(repo.join("apps/node/main.ts"), "the engine").unwrap();
    let out = dir.join("out");
    std::fs::create_dir_all(&out).unwrap();
    let d = Dist::new(Some(repo), &dir);
    // a hub run from a checkout: its tag is the source's hash, not the release
    let tag = d.tag().to_owned();
    assert_ne!(tag, format!("v{VERSION}"));
    let stale = [
        "v0.12.0-inyon-engine-linux-x64",
        "v0.12.0-inyon-engine-linux-x64.gz",
        "v0.12.0-inyon-engine-linux-x64.sha256",
        "v0.12.0-inyon-windows-x64.exe",
        "0123456789abcdef-inyon-engine-darwin-arm64",
        "inyon-0123456789abcdef-inyon-engine-linux-x64",
        "tether-node-0123456789abcdef.js",
    ];
    let mut kept = vec![
        format!("{tag}-inyon-engine-linux-x64"),
        format!("{tag}-inyon-engine-linux-x64.gz"),
        format!("{tag}-inyon-engine-linux-x64.sha256"),
        format!("{tag}-inyon-engine-windows-x64.exe.tmp"),
        format!("v{VERSION}-inyon-linux-x64"),
        format!("v{VERSION}-inyon-windows-arm64.exe"),
        "busybox-w64u-FRP-6075-g169694ebd.exe".to_owned(),
        "notes.txt".to_owned(),
    ];
    for f in stale.iter().map(|s| s.to_string()).chain(kept.clone()) {
        std::fs::write(out.join(&f), &f).unwrap();
    }
    d.prune_old(&out);
    let mut left: Vec<String> = std::fs::read_dir(&out).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    left.sort();
    kept.sort();
    let _ = std::fs::remove_dir_all(&dir);
    assert_eq!(left, kept);
}

// ---------- pair-command.test.ts: the one-liner run against the real install.sh ----------

/// A local stand-in for a hub: answers every request (its path and query) with `answer`.
fn serve(answer: impl Fn(&str) -> (u16, Vec<u8>) + Send + 'static) -> String {
    use std::io::{Read, Write};
    let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = l.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for s in l.incoming() {
            let Ok(mut s) = s else { continue };
            let (mut buf, mut b) = (vec![], [0u8; 4096]);
            while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
                match s.read(&mut b) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => buf.extend_from_slice(&b[..n]),
                }
            }
            let target = String::from_utf8_lossy(&buf).split_whitespace().nth(1).unwrap_or("/").to_owned();
            let (status, body) = answer(&target);
            let _ = write!(s, "HTTP/1.1 {status} X\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
            let _ = s.write_all(&body);
        }
    });
    format!("http://127.0.0.1:{port}")
}

const PROGRAM: &str = "#!/bin/sh\nprintf \"%s\\n\" \"$*\" \"$INYON_TOKEN\" > \"$HOME/ran\"\n";
const ENGINE: &str = "#!/bin/sh\necho engine\n";

/// What the stand-in hub serves: a program that writes down how it was run, and (`split`, a hub
/// from 0.13 on) the engine as a file of its own. `fixed_list` is served whatever the program is.
#[derive(Clone)]
struct PairHub {
    program: String,
    split: bool,
    fixed_list: Option<String>,
}

fn my_target() -> (&'static str, &'static str) {
    (if cfg!(target_os = "macos") { "darwin" } else { "linux" }, if cfg!(target_arch = "aarch64") { "arm64" } else { "x64" })
}

impl PairHub {
    fn sums(&self) -> String {
        let (os, arch) = my_target();
        let engine = if self.split { format!("{}  inyon-engine-{os}-{arch}\n", digest(ENGINE.as_bytes())) } else { String::new() };
        format!("{}  inyon-{os}-{arch}\n{}  inyon-other-x64\n{engine}", digest(self.program.as_bytes()), digest(b"another build"))
    }
}

fn pair_hub(split: bool) -> (String, std::sync::Arc<std::sync::Mutex<PairHub>>) {
    let state = std::sync::Arc::new(std::sync::Mutex::new(PairHub { program: PROGRAM.into(), split, fixed_list: None }));
    let s = state.clone();
    let hub = serve(move |target| {
        let h = s.lock().unwrap().clone();
        let (os, arch) = my_target();
        let (path, query) = target.split_once('?').unwrap_or((target, ""));
        let mine = query.split('&').any(|p| p == format!("os={os}")) && query.split('&').any(|p| p == format!("arch={arch}"));
        match path {
            "/node/install.sh" => (200, INSTALL_SH.as_bytes().to_vec()),
            "/node/SHA256SUMS" => (200, h.fixed_list.clone().unwrap_or_else(|| h.sums()).into_bytes()),
            "/node/inyon" if mine => (200, h.program.into_bytes()),
            "/node/inyon-engine" if mine && h.split => (200, ENGINE.as_bytes().to_vec()),
            _ => (404, b"not found".to_vec()),
        }
    });
    (hub, state)
}

struct Ran {
    code: i32,
    err: String,
    ran: Option<String>,
    bin: std::path::PathBuf,
}

/// Runs `cmd` to its end, killing it and failing the test once it has run `secs` seconds.
fn run_for(cmd: &mut std::process::Command, secs: u64) -> std::process::Output {
    let mut child = cmd.spawn().unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(secs);
    while child.try_wait().unwrap().is_none() {
        if std::time::Instant::now() > deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("{cmd:?} still ran after {secs}s");
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    child.wait_with_output().unwrap()
}

/// Runs a one-liner as a machine would, under a throwaway HOME.
fn run_pair(cmd: &str, env: &[(&str, &str)]) -> Ran {
    let home = std::env::temp_dir().join(format!("inyon-pair-{}", crate::http::random_hex(6)));
    std::fs::create_dir_all(&home).unwrap();
    let o = run_for(
        std::process::Command::new("sh")
            .arg("-c")
            .arg(cmd)
            .env_clear()
            .env("HOME", &home)
            .env("PATH", "/usr/local/bin:/usr/bin:/bin")
            .envs(env.iter().copied())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped()),
        30,
    );
    Ran {
        code: o.status.code().unwrap_or(-1),
        err: String::from_utf8_lossy(&o.stderr).into_owned(),
        ran: std::fs::read_to_string(home.join("ran")).ok(),
        bin: home.join(".inyon/bin"),
    }
}

impl Drop for Ran {
    fn drop(&mut self) {
        if let Some(home) = self.bin.parent().and_then(Path::parent) {
            let _ = std::fs::remove_dir_all(home);
        }
    }
}

fn sha(s: &str) -> String {
    digest(s.as_bytes())
}

#[cfg(unix)]
#[test]
fn the_one_liner_installs_what_the_hub_vouched_for_and_has_it_join_with_the_token_kept_out_of_argv() {
    let (hub, state) = pair_hub(false);
    let cmd = unix_pair_command(&hub, "tok_123-abc", &sha(INSTALL_SH), &sha(&state.lock().unwrap().sums()));
    assert!(!cmd.split(" sh -c '").nth(1).unwrap().contains("tok_123-abc"));
    let r = run_pair(&cmd, &[]);
    assert!(!r.err.contains("checksum"), "{}", r.err);
    assert_eq!(r.code, 0, "{}", r.err);
    assert_eq!(std::fs::read_to_string(r.bin.join("inyon")).unwrap(), PROGRAM);
    assert_eq!(r.ran.as_deref(), Some(format!("join {hub}\ntok_123-abc\n").as_str()));
    assert!(!r.bin.join("inyon.download").exists());
}

#[cfg(unix)]
#[test]
fn a_swapped_install_sh_checksum_list_or_program_is_refused_and_nothing_runs() {
    let (hub, state) = pair_hub(false);
    let sums = state.lock().unwrap().sums();
    let swapped_installer = run_pair(&unix_pair_command(&hub, "tok", &sha("something else"), &sha(&sums)), &[]);
    assert_ne!(swapped_installer.code, 0);
    assert!(swapped_installer.err.contains("install.sh did not match"), "{}", swapped_installer.err);
    assert_eq!(swapped_installer.ran, None);

    let swapped_sums = run_pair(&unix_pair_command(&hub, "tok", &sha(INSTALL_SH), &sha("a different list")), &[]);
    assert_ne!(swapped_sums.code, 0);
    assert!(swapped_sums.err.contains("The hub's checksums did not match"), "{}", swapped_sums.err);
    assert_eq!(swapped_sums.ran, None);

    // the list as vouched for, but the program swapped on the way
    let fixed = {
        let mut h = state.lock().unwrap();
        h.fixed_list = Some(h.sums());
        h.program = "#!/bin/sh\necho \"not what the hub built\" > \"$HOME/ran\"\n".into();
        h.fixed_list.clone().unwrap()
    };
    let swapped_program = run_pair(&unix_pair_command(&hub, "tok", &sha(INSTALL_SH), &sha(&fixed)), &[]);
    assert_ne!(swapped_program.code, 0);
    assert!(swapped_program.err.contains("inyon did not match its checksum"), "{}", swapped_program.err);
    assert_eq!(swapped_program.ran, None);
    assert!(!swapped_program.bin.join("inyon").exists());
}

#[cfg(unix)]
#[test]
fn from_0_19_a_machine_joins_with_the_command_alone_though_the_hub_lists_the_engine() {
    let (hub, state) = pair_hub(true);
    let sums = state.lock().unwrap().sums();
    let r = run_pair(&unix_pair_command(&hub, "tok_789", &sha(INSTALL_SH), &sha(&sums)), &[]);
    assert_eq!(r.code, 0, "{}", r.err);
    assert_eq!(std::fs::read_to_string(r.bin.join("inyon")).unwrap(), PROGRAM);
    assert!(!r.bin.join("inyon-engine").exists());
    assert_eq!(r.ran.as_deref(), Some(format!("join {hub}\ntok_789\n").as_str()));
}

#[cfg(unix)]
#[test]
fn with_inyon_legacy_engine_1_the_engine_comes_from_the_hub_too_checked_the_same_way_and_the_command_joins() {
    let (hub, state) = pair_hub(true);
    let legacy = [("INYON_LEGACY_ENGINE", "1")];
    let sums = state.lock().unwrap().sums();
    let r = run_pair(&unix_pair_command(&hub, "tok_456", &sha(INSTALL_SH), &sha(&sums)), &legacy);
    assert!(!r.err.contains("checksum"), "{}", r.err);
    assert_eq!(r.code, 0, "{}", r.err);
    assert_eq!(std::fs::read_to_string(r.bin.join("inyon")).unwrap(), PROGRAM);
    assert_eq!(std::fs::read_to_string(r.bin.join("inyon-engine")).unwrap(), ENGINE);
    assert_eq!(r.ran.as_deref(), Some(format!("join {hub}\ntok_456\n").as_str()));
    assert!(!r.bin.join("inyon.download").exists());

    // an engine swapped on the way is refused before anything joins
    let fixed = sums.replace(&sha(ENGINE), &sha("other engine"));
    state.lock().unwrap().fixed_list = Some(fixed.clone());
    let swapped = run_pair(&unix_pair_command(&hub, "tok", &sha(INSTALL_SH), &sha(&fixed)), &legacy);
    assert_ne!(swapped.code, 0);
    assert!(swapped.err.contains("engine did not match its checksum"), "{}", swapped.err);
    assert_eq!(swapped.ran, None);
}

// ---------- node-update-scripts.test.ts: the Windows script this hub still sends ----------

#[test]
fn the_windows_script_plain_ascii_launches_as_its_own_task_checks_the_download_before_touching_the_exe() {
    let ps1 = HUB_UPDATE_PS1;
    // Windows PowerShell 5.1 reads a file without a BOM as the local code page
    assert!(ps1.is_ascii());
    let at = |s: &str| ps1.find(s).unwrap_or_else(|| panic!("no {s:?} in hub-update.ps1"));
    // -Launch only re-starts it as a one-off task, then ends
    let launch = at("if ($Launch) {");
    assert!(at("Register-ScheduledTask -TaskName $UpdateTask") > launch);
    assert!(at("exit 0") < at("function Get-Hub"));
    // download, then the checksum, and only then the swap and restart
    let download = at("Get-File \"$hub/node/tether-node.exe.gz?arch=$Arch\" $gz");
    let check = at("(Get-FileHash -Algorithm SHA256 $new).Hash.ToLower() -ne $Want");
    let swap = at("Move-Retry $Exe $old");
    assert!(download < check && check < swap);
    assert!(at("Stop-Node\n  Start-Node") > swap);
    // a new copy that doesn't come up, or anything failing after the swap, brings the old one back,
    // and tether-node is left running
    let failed = at("} catch {\n  $msg");
    assert!(failed > at("if (-not (Test-Started)) { throw"));
    assert!(at("Move-Retry $old $Exe") > failed);
    assert!(at("if (-not (Get-Node)) { try { Start-Node }") > at("Move-Retry $old $Exe"));
    // the task removes itself, however it ended
    assert!(at("Unregister-ScheduledTask -TaskName $UpdateTask") > at("} finally {"));
    // the hub address comes from install.ps1's .env; nothing from the hub is put into a command
    assert!(ps1.contains("Get-Content (Join-Path $Dir '.env')"));
}

// Windows-only cmdlets as stubs that log what they're asked. Starting tether-node writes node.json
// for the new copy when NEW_STARTS=1, and throws when FAIL_START=1.
const PS_STUBS: &str = r#"
function Node-Started {
  $d = Join-Path $env:USERPROFILE '.tether-node'
  $isNew = (Get-Content (Join-Path $d 'tether-node.exe') -Raw) -match 'new'
  if ($isNew -and $env:FAIL_START -eq '1') { throw 'task start blocked' }
  if ($isNew -and $env:NEW_STARTS -eq '1') { Set-Content (Join-Path $d 'node.json') ('{"pid":' + $PID + ',"version":"0.6.3"}') }
}
function Get-ScheduledTask { param($TaskName, $ErrorAction) if ($TaskName -eq 'Tether node') { 'task' } }
function Stop-ScheduledTask { param($TaskName, $ErrorAction) Add-Content $env:CALLS "stop $TaskName" }
function Start-ScheduledTask { param($TaskName) Add-Content $env:CALLS "start $TaskName"; if ($TaskName -eq 'Tether node') { Node-Started } }
function Start-Process { param($FilePath, $ArgumentList, $WorkingDirectory, $WindowStyle) Add-Content $env:CALLS "start-process $FilePath" }
function Register-ScheduledTask { param($TaskName, $Action, $Principal, $Settings, [switch]$Force) Add-Content $env:CALLS "register $TaskName $($Action.Argument)" }
function New-ScheduledTaskAction { param($Execute, $Argument) [pscustomobject]@{ Execute = $Execute; Argument = $Argument } }
function New-ScheduledTaskPrincipal { param($UserId, $LogonType, $RunLevel) 'principal' }
function New-ScheduledTaskSettingsSet { param([switch]$AllowStartIfOnBatteries, [switch]$DontStopIfGoingOnBatteries, $ExecutionTimeLimit) 'settings' }
function Unregister-ScheduledTask { param($TaskName, $Confirm, $ErrorAction) Add-Content $env:CALLS "unregister $TaskName" }
function Get-Process { param($Name, $Id, $ErrorAction) if ($Id -and $Id -eq $PID) { [pscustomobject]@{ Id = $PID } } }
function Stop-Process { param([switch]$Force, $ErrorAction) }
function Start-Sleep { param($Seconds, $Milliseconds) }
"#;

/// PowerShell, where one is installed (PWSH=<path>, or pwsh on PATH); these tests skip without it.
fn pwsh() -> Option<std::path::PathBuf> {
    if let Some(p) = std::env::var_os("PWSH").filter(|p| !p.is_empty()) {
        return Some(p.into());
    }
    std::env::split_paths(&std::env::var_os("PATH")?).map(|d| d.join("pwsh")).find(|p| p.is_file())
}

struct Ps1Run {
    exe: String,
    status: String,
    files: Vec<String>,
    calls: Vec<String>,
}

/// Runs the filled-in Windows script under a throwaway USERPROFILE whose tether-node.exe is "old
/// exe", against a local server standing in for the hub. Nothing touches a real service.
fn run_ps1(pwsh: &Path, want: Option<&str>, env: &[(&str, &str)], launch: bool) -> Ps1Run {
    let gz = gzip(b"new exe").unwrap();
    let hub = serve(move |target| if target == "/node/tether-node.exe.gz?arch=x64" { (200, gz.clone()) } else { (404, b"no".to_vec()) });
    let root = std::env::temp_dir().join(format!("inyon-hub-update-{}", crate::http::random_hex(6)));
    // a home with a space and a quote in it: everything must stay quoted
    let home = root.join("home dir/o'brien");
    let profile = home.join("profile");
    let dir = profile.join(".tether-node");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("tether-node.exe"), "old exe").unwrap();
    std::fs::write(dir.join(".env"), format!("TETHER_HUB={hub}/\r\nTETHER_TOKEN=secret\r\n")).unwrap();
    std::fs::write(dir.join("update-status"), "running\n").unwrap();
    std::fs::write(root.join("stubs.ps1"), PS_STUBS).unwrap();
    let script = dir.join("update.ps1");
    let sum = want.map_or_else(|| sha("new exe"), str::to_owned);
    std::fs::write(&script, inyon_core::hosts::node_update::fill_update_script(HUB_UPDATE_PS1, &sum, "0.6.3", "x64").unwrap()).unwrap();
    let q = |p: &Path| p.to_string_lossy().replace('\'', "''");
    let cmd = format!(". '{}'; & '{}'{}", q(&root.join("stubs.ps1")), q(&script), if launch { " -Launch" } else { "" });
    // the TS gives a run 30 s, and the one that restores the old exe 60
    run_for(
        std::process::Command::new(pwsh)
            .args(["-NoProfile", "-NonInteractive", "-Command", &cmd])
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .env("HOME", &home)
            .env("USERPROFILE", &profile)
            .env("CALLS", root.join("calls"))
            .envs(env.iter().copied())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null()),
        60,
    );
    let read = |f: &str| std::fs::read_to_string(dir.join(f)).unwrap().trim().to_owned();
    let mut files: Vec<String> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    files.sort();
    let calls = std::fs::read_to_string(root.join("calls")).unwrap_or_default().trim().split('\n').map(str::to_owned).collect();
    let r = Ps1Run { exe: read("tether-node.exe"), status: read("update-status"), files, calls };
    let _ = std::fs::remove_dir_all(&root);
    r
}

#[test]
fn windows_script_under_powershell_a_mismatched_download_changes_nothing() {
    let Some(pwsh) = pwsh() else {
        eprintln!("no PowerShell here: skipped");
        return;
    };
    let r = run_ps1(&pwsh, Some(&sha("what the hub meant to send")), &[("NEW_STARTS", "1")], false);
    assert_eq!(r.exe, "old exe");
    assert_eq!(r.status, "failed: The download didn't match the hub's checksum, so nothing was changed");
    assert_eq!(r.files, [".env", "tether-node.exe", "update-status", "update.log", "update.ps1"]);
    assert!(!r.calls.iter().any(|c| c == "stop Tether node"));
}

#[test]
fn windows_script_under_powershell_replaced_restarted_and_done_once_the_new_version_runs() {
    let Some(pwsh) = pwsh() else {
        eprintln!("no PowerShell here: skipped");
        return;
    };
    let r = run_ps1(&pwsh, None, &[("NEW_STARTS", "1")], false);
    assert_eq!(r.exe, "new exe");
    assert_eq!(r.status, "done 0.6.3");
    assert!(!r.files.iter().any(|f| f.contains(".old-") || f.ends_with(".new") || f.ends_with(".gz")), "{:?}", r.files);
    assert_eq!(r.calls, ["stop Tether node", "start Tether node", "unregister Tether update"]);
}

#[test]
fn windows_script_under_powershell_a_new_version_that_doesnt_start_or_a_restart_that_throws_puts_the_old_one_back() {
    let Some(pwsh) = pwsh() else {
        eprintln!("no PowerShell here: skipped");
        return;
    };
    let failed = regex::Regex::new(r"^failed: (The new version didn't start, so the previous one is running again|task start blocked)$").unwrap();
    for env in [&[][..], &[("NEW_STARTS", "1"), ("FAIL_START", "1")][..]] {
        let r = run_ps1(&pwsh, None, env, false);
        assert_eq!(r.exe, "old exe");
        assert!(failed.is_match(&r.status), "{}", r.status);
        assert!(!r.files.iter().any(|f| f.contains(".old-")), "{:?}", r.files);
        assert_eq!(r.calls[r.calls.len() - 2], "start Tether node", "{:?}", r.calls);
    }
}

#[test]
fn windows_script_under_powershell_launch_only_starts_itself_as_a_one_off_task() {
    let Some(pwsh) = pwsh() else {
        eprintln!("no PowerShell here: skipped");
        return;
    };
    let r = run_ps1(&pwsh, None, &[], true);
    assert_eq!(r.exe, "old exe");
    assert_eq!(r.status, "running");
    assert_eq!(r.calls.len(), 2, "{:?}", r.calls);
    assert!(
        regex::Regex::new(r#"^register Tether update -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File ".*update\.ps1"$"#)
            .unwrap()
            .is_match(&r.calls[0]),
        "{}",
        r.calls[0]
    );
    assert_eq!(r.calls[1], "start Tether update");
}
