//! The engine: what runs the link, the hub connection and the hub, and writes pairings and keys.
//! From 0.19 all of it but the hub is built into this program (the inyon-engine crate): `link`,
//! `connect` and the old `https://…` form run here, and `pair`, `forget` and `push` run this
//! program as `inyon engine … --json` and draw its answer. The hub still comes from the Bun
//! engine, `inyon-engine` next to this one, downloaded the first time a hub needs it.
//! INYON_LEGACY_ENGINE=1 sends everything to the Bun engine, as 0.18 did.

use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};

use serde_json::Value;

use crate::paths::{env_var, installed_engine, saved_hub, ENGINE};
use crate::signing;
use crate::sys::{quiet, Libc, Platform};
use crate::update::{self, Arch};

/// The kill switch: INYON_LEGACY_ENGINE=1 runs everything through the downloaded Bun engine, as
/// 0.18 did, in case the built-in engine misbehaves somewhere. Without the variable, the note
/// `inyon service install` left when it set the machine up that way still counts: a link started
/// from a terminal or an update started on its own keeps to the Bun engine the services run.
pub fn legacy() -> bool {
    legacy_asked().unwrap_or_else(|| legacy_note().exists())
}

/// What INYON_LEGACY_ENGINE says when it's set: the Bun engine, or (0, false) the built-in one.
pub fn legacy_asked() -> Option<bool> {
    env_var("INYON_LEGACY_ENGINE").map(|v| v != "0" && !v.eq_ignore_ascii_case("false"))
}

/// The note that this machine's services run on the Bun engine.
pub fn legacy_note() -> PathBuf {
    crate::paths::node_dir().join("legacy-engine")
}

/// Writes or removes the note as INYON_LEGACY_ENGINE says. With `unset_forgets` (`inyon service
/// install`, how you go back) the variable not being set removes it too; otherwise that leaves it.
pub fn remember_legacy(unset_forgets: bool) {
    match legacy_asked() {
        Some(true) => {
            let _ = crate::paths::ensure_node_dir();
            let _ = std::fs::write(legacy_note(), "INYON_LEGACY_ENGINE=1 when the services were set up\n");
        }
        Some(false) => {
            let _ = std::fs::remove_file(legacy_note());
        }
        None if unset_forgets => {
            let _ = std::fs::remove_file(legacy_note());
        }
        None => {}
    }
}

/// The hub in Rust, an opt-in test of what 0.20 makes the default: INYON_HUB_IMPL=rust runs the
/// hub built into this program instead of the Bun engine's, and `bun` goes back. Set in the
/// environment or in hub.env; without either, the note `INYON_HUB_IMPL=rust inyon hub start` left
/// still counts, so the service keeps to the hub it was set up with. Linux and macOS only, as the
/// hub is. The kill switch (INYON_LEGACY_ENGINE) puts everything back on the Bun engine, the hub
/// included.
pub fn rust_hub() -> bool {
    picks_rust_hub(cfg!(unix), legacy(), hub_impl_wanted())
}

fn picks_rust_hub(unix: bool, legacy: bool, wanted: bool) -> bool {
    unix && !legacy && wanted
}

/// Whether INYON_HUB_IMPL (or the note) asks for the Rust hub, the kill switch aside.
pub fn hub_impl_wanted() -> bool {
    hub_impl_asked().unwrap_or_else(|| hub_impl_note().exists())
}

/// INYON_HUB_IMPL in hub.env, when it's there.
fn hub_impl_in_file() -> Option<bool> {
    crate::paths::read_env_file(&crate::paths::data_dir().join("hub.env")).remove("INYON_HUB_IMPL").filter(|v| !v.is_empty()).map(|v| says_rust(&v))
}

/// What INYON_HUB_IMPL says when it's set, here or in hub.env: the Rust hub, or (bun) the Bun one.
pub fn hub_impl_asked() -> Option<bool> {
    env_var("INYON_HUB_IMPL").map(|v| says_rust(&v)).or_else(hub_impl_in_file)
}

/// When this shell's INYON_HUB_IMPL and hub.env's line disagree, what to tell the user. The
/// hub's service reads hub.env and never this shell's variable, so setting the hub up from here
/// would leave it running the other one.
pub fn hub_impl_clash() -> Option<String> {
    let shell = env_var("INYON_HUB_IMPL").map(|v| says_rust(&v))?;
    let file = hub_impl_in_file()?;
    let name = |rust: bool| if rust { "rust" } else { "bun" };
    (shell != file).then(|| {
        format!(
            "{} says INYON_HUB_IMPL={}, and the hub's service goes by that, not by INYON_HUB_IMPL={} here. Change the line there (or delete it) and run `inyon hub restart`.",
            crate::paths::data_dir().join("hub.env").display(),
            name(file),
            name(shell)
        )
    })
}

/// `rust` (any case) is the Rust hub; `bun`, and anything else, the Bun one.
fn says_rust(value: &str) -> bool {
    value.trim().eq_ignore_ascii_case("rust")
}

/// The note that this machine's hub service runs the Rust hub.
pub fn hub_impl_note() -> PathBuf {
    crate::paths::node_dir().join("hub-impl")
}

#[derive(Debug, PartialEq, Eq)]
enum NoteChange {
    Write,
    Remove,
    Keep,
}

/// What setting up the hub does to the note. Only the shell's variable is written down: a line in
/// hub.env is read by the service itself, so deleting it later works as anyone would expect.
fn note_change(from_env: Option<bool>, from_file: Option<bool>, unset_forgets: bool) -> NoteChange {
    match (from_env, from_file) {
        (Some(true), _) => NoteChange::Write,
        (Some(false), _) | (None, Some(false)) => NoteChange::Remove,
        (None, None) if unset_forgets => NoteChange::Remove,
        _ => NoteChange::Keep,
    }
}

/// Writes or removes the note as INYON_HUB_IMPL says, as `remember_legacy` does for the kill
/// switch. Called when the hub's service is set up.
pub fn remember_hub_impl(unset_forgets: bool) {
    match note_change(env_var("INYON_HUB_IMPL").map(|v| says_rust(&v)), hub_impl_in_file(), unset_forgets) {
        NoteChange::Write => {
            let _ = crate::paths::ensure_node_dir();
            let _ = std::fs::write(hub_impl_note(), "INYON_HUB_IMPL=rust when the hub was set up\n");
        }
        NoteChange::Remove => {
            let _ = std::fs::remove_file(hub_impl_note());
        }
        NoteChange::Keep => {}
    }
}

/// Whether an engine command needs the Bun engine: the hub unless it's the Rust one, everything
/// with the kill switch.
pub fn needs_bun(first: &str) -> bool {
    legacy() || (first == "hub" && !rust_hub())
}

/// Answers an engine command with the engine built into this program, as `inyon-engine` would.
/// `hub` goes on to the Bun engine, or runs the Rust hub with INYON_HUB_IMPL=rust.
pub fn run_builtin(args: &[String]) -> i32 {
    inyon_engine::cli::run(args, |rest| {
        if cfg!(windows) {
            eprintln!("The Inyon hub runs on Linux and macOS. On Windows, install it inside WSL.");
            return 2;
        }
        #[cfg(unix)]
        if rust_hub() {
            return inyon_hub::run(rest);
        }
        let mut all = vec!["hub".to_string()];
        all.extend(rest.iter().cloned());
        forward_bun(&all)
    })
}

/// What only the built-in engine's windowless copy holds (see `make_copy`), so it's never taken
/// for the Bun engine.
pub const COPY_MARK: &str = "inyon: the built-in engine, windowless copy";

/// The PE header's subsystem field of a Windows program: 3 is a console program, 2 one without.
fn subsystem_at(exe: &[u8]) -> Option<usize> {
    let pe = u32::from_le_bytes(exe.get(0x3c..0x40)?.try_into().ok()?) as usize;
    (exe.get(pe..pe + 4)? == b"PE\0\0").then_some(pe + 4 + 20 + 68).filter(|at| *at + 2 <= exe.len())
}

/// This program as a Windows program without a console, the bytes of `inyon-engine.exe`: logon
/// tasks start it with no window, and named inyon-engine it answers the engine's commands. Tasks,
/// the firewall rule and older inyon commands keep the path they know.
/// Only inyon 0.19 or later can be the copy: an older one doesn't answer to the engine's name and
/// would start itself again and again.
pub fn make_copy(program: &[u8]) -> Result<Vec<u8>, String> {
    if !marked(program) {
        return Err("That inyon is from before 0.19 and has no engine built in, so it can't stand in for the engine.".into());
    }
    let mut out = program.to_vec();
    let at = subsystem_at(&out).ok_or("inyon isn't a Windows program, so there's no copy to make.")?;
    out[at..at + 2].copy_from_slice(&2u16.to_le_bytes());
    Ok(out)
}

/// Whether a program's bytes carry COPY_MARK: inyon 0.19 or later, or its windowless copy.
fn marked(program: &[u8]) -> bool {
    program.windows(COPY_MARK.len()).any(|w| w == COPY_MARK.as_bytes())
}

/// Whether `file` has the engine built in: inyon 0.19 or later, or its windowless copy (both carry
/// COPY_MARK), rather than the Bun engine or an inyon from before 0.19, which still runs it.
pub fn has_engine_built_in(file: &Path) -> bool {
    // the Bun engine is upwards of 40 MB; this program is a fraction of that
    let small = std::fs::metadata(file).is_ok_and(|m| m.len() < 40 << 20);
    small && std::fs::read(file).is_ok_and(|d| marked(&d))
}

/// Whether `file`, where the engine goes, is a copy `make_copy` made (of any version) rather than
/// the Bun engine.
pub fn is_builtin_copy(file: &Path) -> bool {
    has_engine_built_in(file)
}

/// Writes the windowless copy of `program` next to it (Windows), unless one of this exact
/// program is there already. A running copy is renamed aside first, as an update does.
pub fn refresh_copy(program: &Path) -> Result<PathBuf, String> {
    let to = update::engine_beside(program);
    let fresh = make_copy(&std::fs::read(program).map_err(|e| e.to_string())?)?;
    if std::fs::read(&to).is_ok_and(|d| d == fresh) {
        return Ok(to);
    }
    let tmp = PathBuf::from(format!("{}.download", to.to_string_lossy()));
    std::fs::write(&tmp, &fresh).map_err(|e| e.to_string())?;
    update::swap_in(&update::RealFiles, &to, &tmp, crate::state::now_ms() as u64).map_err(|e| e.to_string())?;
    Ok(to)
}

/// Where the Bun engine is: INYON_ENGINE, next to this program, or in ~/.inyon/bin. The
/// windowless copy of this program that Windows keeps under the same name doesn't count.
/// INYON_ENGINE on its own counts too, but never inyon itself.
pub fn find() -> Option<PathBuf> {
    match named_engine() {
        Ok(Some(p)) => return Some(p),
        Err(_) => return None,
        Ok(None) => {}
    }
    let bun = |p: &Path| p.is_file() && !is_builtin_copy(p);
    if let Ok(me) = std::env::current_exe() {
        let beside = update::engine_beside(&me);
        if bun(&beside) {
            return Some(beside);
        }
    }
    let installed = installed_engine();
    bun(&installed).then_some(installed)
}

/// The engine INYON_ENGINE names, when it names a file. inyon itself (0.19 or later, or its
/// windowless copy) is refused: asked for the hub, it would hand over to itself forever.
fn named_engine() -> Result<Option<PathBuf>, String> {
    let Some(p) = env_var("INYON_ENGINE").map(PathBuf::from).filter(|p| p.is_file()) else {
        return Ok(None);
    };
    if has_engine_built_in(&p) {
        return Err(format!(
            "INYON_ENGINE points at {}, which is inyon itself: the engine is built into inyon from 0.19. Point INYON_ENGINE at the Bun engine (inyon-engine from a release), or unset it.",
            p.display()
        ));
    }
    Ok(Some(p))
}

/// Makes sure what `first` needs is here: the Bun engine (downloaded when missing) for the hub
/// or with the kill switch, nothing otherwise.
pub fn ready(first: &str, say: &dyn Fn(&str)) -> Result<(), String> {
    if needs_bun(first) {
        ensure(say)?;
    }
    Ok(())
}

/// The Bun engine on a machine that doesn't need it any more: neither a hub nor the kill switch
/// asks for it. Linux and macOS only; on Windows the file under that name is the windowless copy.
pub fn stale_engine() -> Option<PathBuf> {
    let file = installed_engine();
    if cfg!(windows) || legacy() || !file.is_file() || is_builtin_copy(&file) {
        return None;
    }
    // a hub on the Rust hub doesn't run it either
    (!hub_here() || rust_hub()).then_some(file)
}

/// Whether this machine runs a hub, or did: set up as a service, started by hand, or configured.
pub fn hub_here() -> bool {
    crate::paths::data_dir().join("hub.env").exists() || crate::paths::node_dir().join("hub.json").exists() || crate::service::hub_set_up()
}

/// The engine, downloaded when it isn't here yet. `say` gets the lines about that.
pub fn ensure(say: &dyn Fn(&str)) -> Result<PathBuf, String> {
    named_engine()?;
    if let Some(p) = find() {
        return Ok(p);
    }
    let to = installed_engine();
    download_to(&to, say)?;
    Ok(to)
}

/// Where the engine comes from: INYON_DOWNLOAD (a mirror of the releases), the hub this machine
/// was added to (so a machine that can only reach its hub still works), or the newest release on
/// the website.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Source {
    Release(String),
    Hub(String),
}

pub fn source() -> Source {
    if let Some(base) = env_var("INYON_DOWNLOAD") {
        return Source::Release(base.trim_end_matches('/').to_string());
    }
    if let Some(hub) = saved_hub() {
        return Source::Hub(hub);
    }
    Source::Release(update::RELEASES.to_string())
}

/// Fetches the engine for this platform into `to`, checked like an update is (gz first, both
/// checksums from a release's signed list; the hub's own checksum from a hub), with a progress
/// line through `say`.
pub fn download_to(to: &Path, say: &dyn Fn(&str)) -> Result<(), String> {
    let names = update::release_names(Platform::current(), Arch::current(), Libc::current()).map_err(|e| e.to_string())?;
    if let Some(dir) = to.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = PathBuf::from(format!("{}.download", to.to_string_lossy()));
    let _ = std::fs::remove_file(&tmp);
    let progress = |l: &str| say(l.trim_start_matches('\r').trim());
    match source() {
        Source::Release(base) => {
            let sums = update::release_sums(&base, &signing::signing_key(&base), Platform::current()).map_err(|e| e.to_string())?;
            if update::sum_for(&sums, &names.engine).is_none() {
                return Err(format!("The newest release has no {} in it. Install with:\n  {}", names.engine, update::reinstall_command(Platform::current())));
            }
            say(&format!("Getting the Inyon engine ({})…", names.engine));
            update::fetch_release(&base, &names.engine, &sums, &tmp, &progress).map_err(|e| e.to_string())?;
        }
        Source::Hub(hub) => {
            let t = update::target(Platform::current(), Arch::current()).map_err(|e| e.to_string())?;
            let q = format!("?os={}&arch={}", t.os, t.arch);
            let want = update::hub_sum(&hub, "inyon-engine", &q)
                .map_err(|e| e.to_string())?
                .ok_or_else(|| format!("{hub} hands out one program, from before the engine and inyon were split. Update the hub first."))?;
            say(&format!("Getting the Inyon engine from {}…", crate::http::host_of(&hub)));
            update::fetch_hub_file(&hub, "inyon-engine", &q, &want, &tmp, &progress).map_err(|e| e.to_string())?;
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755));
    }
    if Platform::current() == Platform::Darwin {
        crate::sys::run(&["codesign", "--force", "--sign", "-", &tmp.to_string_lossy()]);
    }
    std::fs::rename(&tmp, to).map_err(|e| e.to_string())
}

fn command(engine: &Path) -> Command {
    let mut c = Command::new(engine);
    c.env("INYON_CLI", std::env::current_exe().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default());
    c
}

/// The engine commands that may run the link: `link`, and `pair`, which starts the link itself
/// when none is running and stays on as it.
fn may_run_link(first: &str) -> bool {
    matches!(first, "link" | "pair")
}

/// On Windows the link runs from the windowless copy, `inyon-engine.exe`, even when started from a
/// terminal: the firewall rule "Inyon link" lets that program in, and only that one.
fn windows_copy(first: &str) -> Option<PathBuf> {
    if !cfg!(windows) || !may_run_link(first) {
        return None;
    }
    let me = std::env::current_exe().ok()?;
    [update::engine_beside(&me), installed_engine()].into_iter().find(|p| is_builtin_copy(p))
}

/// The program that answers engine command `first`: this one as `inyon engine` (the windowless
/// copy for the link on Windows), or the Bun engine (downloaded when missing) for the hub and
/// with the kill switch.
fn engine_command(first: &str, download: bool) -> Result<(Command, PathBuf), String> {
    if let Some(copy) = windows_copy(first).filter(|_| !needs_bun(first)) {
        return Ok((command(&copy), copy));
    }
    if !needs_bun(first) {
        let me = std::env::current_exe().map_err(|e| e.to_string())?;
        let mut c = Command::new(&me);
        c.arg("engine");
        return Ok((c, me));
    }
    let engine = if download {
        ensure(&|l| eprintln!("{l}"))?
    } else {
        find().ok_or_else(|| named_engine().err().unwrap_or_else(|| format!("{ENGINE} isn't installed yet. Run `inyon setup`.")))?
    };
    Ok((command(&engine), engine))
}

/// Runs engine command `args` in this process (built in) or hands the process over to the Bun
/// engine (the hub, the kill switch).
pub fn forward(args: &[String]) -> ! {
    let first = args.first().map(String::as_str).unwrap_or("");
    if !needs_bun(first) {
        if let Some(copy) = windows_copy(first) {
            let mut c = command(&copy);
            c.args(args);
            match relayed(c) {
                Ok(s) => std::process::exit(s.code().unwrap_or(1)),
                Err(err) => eprintln!("Couldn't start {} ({err}); running the link here.", copy.display()),
            }
        }
        std::process::exit(run_builtin(args));
    }
    forward_bun(args)
}

/// Hands the process over to the Bun engine with `args`. On Unix this process becomes the engine
/// (same pid, same signals, which the service managers count on); on Windows it waits for it
/// and passes the exit code on.
pub fn forward_bun(args: &[String]) -> ! {
    let say = |l: &str| eprintln!("{l}");
    let engine = match ensure(&say) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    };
    let mut c = command(&engine);
    c.args(args);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let err = c.exec();
        eprintln!("Couldn't start {} ({err}).", engine.display());
        std::process::exit(1);
    }
    #[cfg(not(unix))]
    {
        match relayed(c) {
            Ok(s) => std::process::exit(s.code().unwrap_or(1)),
            Err(err) => {
                eprintln!("Couldn't start {} ({err}).", engine.display());
                std::process::exit(1);
            }
        }
    }
}

/// Runs the engine with `args`, its output going to this terminal, and returns how it ended.
pub fn run_through(args: &[String]) -> Result<ExitStatus, String> {
    let (mut c, engine) = engine_command(args.first().map(String::as_str).unwrap_or(""), true)?;
    c.args(args);
    relayed(c).map_err(|e| format!("Couldn't start {} ({e}).", engine.display()))
}

/// Runs the engine with this terminal. On Windows the engine has no console of its own (so the
/// sign-in task starts it with no window), so what it prints comes through pipes and is passed
/// on here, INYON_CONSOLE tells it to print rather than log, and it runs in a job that ends it
/// with this program (Ctrl-C, a closed window).
fn relayed(mut c: Command) -> std::io::Result<ExitStatus> {
    if !cfg!(windows) {
        return c.stdin(Stdio::inherit()).stdout(Stdio::inherit()).stderr(Stdio::inherit()).status();
    }
    c.env("INYON_CONSOLE", "1").stdin(Stdio::inherit()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = c.spawn()?;
    #[cfg(windows)]
    let _job = inyon_engine::winjob::ends_with_me(&child);
    let out = child.stdout.take().map(|mut o| std::thread::spawn(move || std::io::copy(&mut o, &mut std::io::stdout())));
    let err = child.stderr.take().map(|mut e| std::thread::spawn(move || std::io::copy(&mut e, &mut std::io::stderr())));
    let status = child.wait();
    for t in [out, err].into_iter().flatten() {
        let _ = t.join();
    }
    status
}

/// Runs the engine and collects what it printed.
pub fn capture(args: &[&str]) -> Result<(ExitStatus, String), String> {
    let (mut c, engine) = engine_command(args.first().copied().unwrap_or(""), false)?;
    c.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    quiet(&mut c);
    let out = c.output().map_err(|e| format!("Couldn't start {} ({e}).", engine.display()))?;
    Ok((out.status, format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr))))
}

/// The engine's version, if it's here and answers: this program's own when it's built in.
pub fn version() -> Option<String> {
    if !legacy() {
        return Some(inyon_engine::VERSION.to_string());
    }
    let (status, out) = capture(&["version"]).ok()?;
    status.success().then(|| out.trim().to_string()).filter(|v| !v.is_empty())
}

/// The last line of JSON in what a command printed (`{"v":1,…}`).
fn last_json(text: &str) -> Option<Value> {
    text.lines().rev().find_map(|l| {
        let l = l.trim();
        l.starts_with('{').then(|| serde_json::from_str::<Value>(l).ok()).flatten()
    })
}

/// Runs an engine command with `--json` (and `envs` in its environment) and returns its answer;
/// an answer with `ok: false`, or none at all, is the error it gave.
pub fn ask(args: &[&str], envs: &[(&str, &str)]) -> Result<Value, String> {
    let (mut c, engine) = engine_command(args.first().copied().unwrap_or(""), true)?;
    c.args(args).arg("--json").stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    for (k, v) in envs {
        c.env(k, v);
    }
    quiet(&mut c);
    let out = c.output().map_err(|e| format!("Couldn't start {} ({e}).", engine.display()))?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    answer(last_json(&stdout), out.status, &stderr, args.first().copied().unwrap_or(""))
}

fn answer(v: Option<Value>, status: ExitStatus, stderr: &str, what: &str) -> Result<Value, String> {
    match v {
        Some(v) if v.get("ok").and_then(Value::as_bool) == Some(false) => Err(v.get("error").and_then(Value::as_str).unwrap_or("the engine said no").to_string()),
        Some(v) => Ok(v),
        None => {
            let said = stderr.trim();
            let mut m = if said.is_empty() { format!("{ENGINE} {what} ended with {} and said nothing.", status.code().unwrap_or(1)) } else { said.to_string() };
            // on a fresh Alpine the engine stops before it says anything: its loader wants libstdc++
            if let Some(hint) = update::alpine_hint(Libc::current(), &update::RealFiles) {
                m = format!("{m} {hint}");
            }
            Err(m)
        }
    }
}

/// Runs `pair` (with `args`) and calls `show` with each of the engine's answers as soon as it
/// comes: one that says the tunnel is starting (`"waiting": "tunnel"`), then the code, and the code
/// again once the tunnel's address arrives. The engine keeps running when it had to start the
/// link itself, so this waits for it to end afterwards; Ctrl-C reaches both. Nothing shown means
/// the engine failed, and this says why.
pub fn pair(args: &[String], show: &mut dyn FnMut(&Value)) -> Result<(), String> {
    let (mut c, engine) = engine_command("pair", true)?;
    c.arg("pair").args(args).arg("--json").stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    // asked from the Inyon window, which has no console, the engine mustn't open one of its own
    quiet(&mut c);
    let mut child = c.spawn().map_err(|e| format!("Couldn't start {} ({e}).", engine.display()))?;
    let stderr = child.stderr.take().map(|mut e| {
        std::thread::spawn(move || {
            let mut text = String::new();
            let _ = e.read_to_string(&mut text);
            text
        })
    });
    let mut answered = None;
    if let Some(out) = child.stdout.take() {
        for line in BufReader::new(out).lines().map_while(Result::ok) {
            if let Some(v) = last_json(&line) {
                // a failure is the engine's last word; it's said below
                if v.get("ok").and_then(Value::as_bool) != Some(false) {
                    show(&v);
                }
                answered = Some(v);
            }
        }
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    let said = stderr.and_then(|t| t.join().ok()).unwrap_or_default();
    answer(answered, status, &said, "pair").map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A Windows program's first bytes: the DOS header pointing at a PE header, the subsystem in it.
    fn fake_exe(subsystem: u16) -> Vec<u8> {
        let mut exe = vec![0u8; 512];
        exe[..2].copy_from_slice(b"MZ");
        exe[0x3c..0x40].copy_from_slice(&0x80u32.to_le_bytes());
        exe[0x80..0x84].copy_from_slice(b"PE\0\0");
        let at = 0x80 + 4 + 20 + 68;
        exe[at..at + 2].copy_from_slice(&subsystem.to_le_bytes());
        exe
    }

    #[test]
    fn the_windowless_copy_differs_only_in_its_subsystem() {
        let console = fake_inyon(3);
        let copy = make_copy(&console).unwrap();
        assert_eq!(copy, fake_inyon(2));
        assert_eq!(console.iter().zip(&copy).filter(|(a, b)| a != b).count(), 1);
        assert!(make_copy(format!("#!/bin/sh\n{COPY_MARK}").as_bytes()).is_err());
    }

    #[test]
    fn an_inyon_from_before_0_19_is_never_made_the_copy() {
        // it doesn't know the engine's name, so as the engine it would start itself again and again
        let err = make_copy(&fake_exe(3)).unwrap_err();
        assert!(err.contains("before 0.19"), "{err}");
        let dir = std::env::temp_dir().join(format!("inyon-old-copy-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let old = dir.join("inyon.exe");
        std::fs::write(&old, fake_exe(3)).unwrap();
        assert!(refresh_copy(&old).is_err());
        assert!(!update::engine_beside(&old).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// inyon 0.19 or later: a Windows program carrying the mark.
    fn fake_inyon(subsystem: u16) -> Vec<u8> {
        let mut exe = fake_exe(subsystem);
        exe.extend_from_slice(COPY_MARK.as_bytes());
        exe
    }

    #[test]
    fn inyon_engine_naming_inyon_itself_is_refused_rather_than_run_forever() {
        let dir = std::env::temp_dir().join(format!("inyon-named-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let me = dir.join("inyon");
        std::fs::write(&me, fake_inyon(3)).unwrap();
        std::env::set_var("INYON_ENGINE", &me);
        let found = find();
        let err = ensure(&|_| {}).unwrap_err();
        std::env::remove_var("INYON_ENGINE");
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(found, None);
        assert!(err.contains("INYON_ENGINE points at") && err.contains("inyon itself"), "{err}");
    }

    #[test]
    fn the_copy_is_told_from_the_bun_engine_by_its_mark() {
        let dir = std::env::temp_dir().join(format!("inyon-copy-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (copy, bun) = (dir.join("copy.exe"), dir.join("bun.exe"));
        let mut bytes = fake_exe(2);
        bytes.extend_from_slice(COPY_MARK.as_bytes());
        std::fs::write(&copy, &bytes).unwrap();
        std::fs::write(&bun, fake_exe(2)).unwrap();
        assert!(is_builtin_copy(&copy));
        assert!(!is_builtin_copy(&bun));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn pairing_runs_where_the_link_does_as_it_may_start_the_link() {
        // on Windows that's the windowless copy, the one program the firewall rule lets in
        assert!(may_run_link("link"));
        assert!(may_run_link("pair"));
        assert!(!may_run_link("forget"));
        assert!(!may_run_link("push"));
    }

    #[test]
    fn only_the_shells_variable_is_written_down_and_bun_anywhere_forgets_it() {
        use NoteChange::*;
        assert_eq!(note_change(Some(true), None, false), Write);
        assert_eq!(note_change(Some(true), Some(false), true), Write);
        // a hub.env line stays where the service reads it: deleting it later switches back
        assert_eq!(note_change(None, Some(true), false), Keep);
        assert_eq!(note_change(None, Some(true), true), Keep);
        assert_eq!(note_change(None, Some(false), false), Remove);
        assert_eq!(note_change(Some(false), Some(true), false), Remove);
        assert_eq!(note_change(None, None, true), Remove);
        assert_eq!(note_change(None, None, false), Keep);
    }

    #[test]
    fn the_kill_switch_puts_the_hub_back_on_bun_too() {
        assert!(picks_rust_hub(true, false, true));
        assert!(!picks_rust_hub(true, true, true));
        assert!(!picks_rust_hub(false, false, true));
        assert!(!picks_rust_hub(true, false, false));
    }

    #[test]
    fn only_rust_picks_the_rust_hub() {
        assert!(says_rust("rust") && says_rust(" Rust\n"));
        assert!(!says_rust("bun") && !says_rust("rs") && !says_rust(""));
    }

    #[test]
    fn the_answer_is_the_last_json_line() {
        assert_eq!(last_json("noise\n{\"v\":1,\"ok\":true,\"link\":\"x\"}\n").unwrap()["link"], "x");
        assert!(last_json("no json here").is_none());
    }
}
