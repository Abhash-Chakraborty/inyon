//! node-dist.test.ts and pair-command.test.ts's command line.

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
