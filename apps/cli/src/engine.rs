//! The engine: today's program, `inyon-engine` next to this one, which runs the link, the hub
//! connection and the hub, and is the only thing that writes pairings and keys. `link`,
//! `connect`, `hub` and the old `https://…` form go straight to it; `pair`, `forget`, `push` and
//! the hub's commands run it with `--json` and draw its answer.

use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};

use serde_json::Value;

use crate::paths::{env_var, installed_engine, saved_hub, ENGINE};
use crate::signing;
use crate::sys::{quiet, Libc, Platform};
use crate::update::{self, Arch};

/// Where the engine is: INYON_ENGINE, next to this program, or in ~/.inyon/bin.
pub fn find() -> Option<PathBuf> {
    if let Some(p) = env_var("INYON_ENGINE").map(PathBuf::from).filter(|p| p.is_file()) {
        return Some(p);
    }
    if let Ok(me) = std::env::current_exe() {
        let beside = update::engine_beside(&me);
        if beside.is_file() {
            return Some(beside);
        }
    }
    let installed = installed_engine();
    installed.is_file().then_some(installed)
}

/// The engine, downloaded when it isn't here yet. `say` gets the lines about that.
pub fn ensure(say: &dyn Fn(&str)) -> Result<PathBuf, String> {
    if let Some(p) = find() {
        return Ok(p);
    }
    let to = installed_engine();
    download_to(&to, say)?;
    Ok(to)
}

/// Where the engine comes from: INYON_DOWNLOAD (a mirror of the releases), the hub this machine
/// was added to (so a machine without GitHub still works), or the newest release.
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

/// Hands the process over to the engine with `args`. On Unix this process becomes the engine
/// (same pid, same signals, which the service managers count on); on Windows it waits for it
/// and passes the exit code on.
pub fn forward(args: &[String]) -> ! {
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
        match c.status() {
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
    let engine = ensure(&|l| eprintln!("{l}"))?;
    let mut c = command(&engine);
    c.args(args).stdin(Stdio::inherit()).stdout(Stdio::inherit()).stderr(Stdio::inherit());
    c.status().map_err(|e| format!("Couldn't start {} ({e}).", engine.display()))
}

/// Runs the engine and collects what it printed.
pub fn capture(args: &[&str]) -> Result<(ExitStatus, String), String> {
    let engine = find().ok_or_else(|| format!("{ENGINE} isn't installed yet. Run `inyon setup`."))?;
    let mut c = command(&engine);
    c.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    quiet(&mut c);
    let out = c.output().map_err(|e| format!("Couldn't start {} ({e}).", engine.display()))?;
    Ok((out.status, format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr))))
}

/// The engine's version, if it's here and answers.
pub fn version() -> Option<String> {
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
    let engine = ensure(&|l| eprintln!("{l}"))?;
    let mut c = command(&engine);
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

/// Runs `pair` (with `args`) and calls `show` with the engine's answer as soon as it comes. The
/// engine keeps running when it had to start the link itself, so this waits for it to end
/// afterwards; Ctrl-C reaches both. Nothing shown means the engine failed, and this says why.
pub fn pair(args: &[String], show: &mut dyn FnMut(&Value)) -> Result<(), String> {
    let engine = ensure(&|l| eprintln!("{l}"))?;
    let mut c = command(&engine);
    c.arg("pair").args(args).arg("--json").stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
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
            if answered.is_none() {
                if let Some(v) = last_json(&line) {
                    show(&v);
                    answered = Some(v);
                }
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

    #[test]
    fn the_answer_is_the_last_json_line() {
        assert_eq!(last_json("noise\n{\"v\":1,\"ok\":true,\"link\":\"x\"}\n").unwrap()["link"], "x");
        assert!(last_json("no json here").is_none());
    }
}
