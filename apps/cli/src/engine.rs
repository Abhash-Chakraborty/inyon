//! The engine: today's program, `inyon-engine` next to this one, which runs the link, the hub
//! connection and the hub, and is the only thing that writes pairings and keys. `link`,
//! `connect`, `hub` and the old `https://…` form go straight to it; `pair`, `forget` and `push`
//! run it and pass its output through.

use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};

use crate::paths::{env_var, installed_engine, ENGINE};
use crate::sys::{quiet, Platform};
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

/// The engine, downloaded from the newest release when it isn't here yet. `say` gets the one
/// line about that.
pub fn ensure(say: &dyn Fn(&str)) -> Result<PathBuf, String> {
    if let Some(p) = find() {
        return Ok(p);
    }
    let to = installed_engine();
    download_to(&to, say)?;
    Ok(to)
}

/// Fetches the engine for this platform into `to` (gz first, both checksums, like the updater).
pub fn download_to(to: &Path, say: &dyn Fn(&str)) -> Result<(), String> {
    let base = env_var("INYON_DOWNLOAD").unwrap_or_else(|| update::RELEASES.to_string()).trim_end_matches('/').to_string();
    let names = update::release_names(Platform::current(), Arch::current()).map_err(|e| e.to_string())?;
    let sums = {
        let url = format!("{base}/SHA256SUMS");
        let res = crate::http::get(&url).map_err(|e| format!("Couldn't reach {url} ({e})."))?;
        if !res.ok() {
            return Err(format!("{url} answered {}.", res.status));
        }
        String::from_utf8_lossy(&res.body).into_owned()
    };
    if update::sum_for(&sums, &names.engine).is_none() {
        return Err(format!("The newest release has no {} in it. Install with:\n  {}", names.engine, update::reinstall_command(Platform::current())));
    }
    if let Some(dir) = to.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    say(&format!("Getting the Inyon engine ({})…", names.engine));
    let tmp = PathBuf::from(format!("{}.download", to.to_string_lossy()));
    let quiet_log = |_: &str| {};
    update::fetch_release(&base, &names.engine, &sums, &tmp, &quiet_log).map_err(|e| e.to_string())?;
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
    let mut c = Command::new(&engine);
    c.args(args).env("INYON_CLI", std::env::current_exe().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default());
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
    let mut c = Command::new(&engine);
    c.args(args).stdin(Stdio::inherit()).stdout(Stdio::inherit()).stderr(Stdio::inherit());
    c.status().map_err(|e| format!("Couldn't start {} ({e}).", engine.display()))
}

/// Runs the engine and collects what it printed.
pub fn capture(args: &[&str]) -> Result<(ExitStatus, String), String> {
    let engine = find().ok_or_else(|| format!("{ENGINE} isn't installed yet. Run `inyon setup`."))?;
    let mut c = Command::new(&engine);
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
