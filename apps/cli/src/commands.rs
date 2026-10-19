//! What each command does, apart from drawing. Everything here prints plain text, or JSON with
//! `--json` (`{"v":1,…}`), so scripts and the app can read it.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::engine;
use crate::http;
use crate::networks;
use crate::paths::{self, bin_dir, data_dir, node_dir, read_env_file, saved_env, saved_hub};
use crate::service::{self, Installed, Role, Sys, ROLES};
use crate::state;
use crate::sys::{self, which, Platform, RealProc};
use crate::ui::setup::{Bind, Plan, RoleChoice};
use crate::ui::{self, Theme, VERSION};
use crate::update;

pub type Outcome = Result<Value, String>;

/// A command's result as text or JSON, and the exit code it ends with.
pub fn finish(r: Outcome, json: bool) -> i32 {
    match r {
        Ok(v) => {
            if json {
                println!("{}", serde_json::to_string(&with_v(v)).unwrap_or_default());
            } else if let Some(text) = v.get("message").and_then(|m| m.as_str()) {
                if !text.is_empty() {
                    println!("{text}");
                }
            }
            0
        }
        Err(e) => {
            if json {
                println!("{}", json!({ "v": 1, "ok": false, "error": e }));
            } else {
                eprintln!("{e}");
            }
            1
        }
    }
}

fn with_v(mut v: Value) -> Value {
    if let Value::Object(m) = &mut v {
        m.insert("v".into(), json!(1));
        m.entry("ok").or_insert(json!(true));
    }
    v
}

fn installed(r: &Installed) -> Value {
    json!({ "ok": r.ok, "how": r.how })
}

/// Runs `name` as if typed, from the dashboard's shortcuts.
pub fn run_named(name: &str) {
    let proc = RealProc;
    let sys = Sys::new(&proc);
    let theme = Theme::detect(true);
    match name {
        "setup" => {
            let code = finish(setup(&sys, theme, None, false), false);
            std::process::exit(code);
        }
        "pair" => {
            let code = finish(pair(&[], false), false);
            std::process::exit(code);
        }
        _ => {}
    }
}

// ---------- version, phones, pair, forget, push ----------

pub fn version(json: bool) -> Outcome {
    if json {
        return Ok(json!({ "cli": VERSION, "engine": engine::version(), "message": format!("inyon {VERSION}") }));
    }
    Ok(json!({ "message": format!("inyon {VERSION}") }))
}

pub fn phones() -> Outcome {
    let all = state::phones();
    if all.is_empty() {
        return Ok(json!({ "phones": [], "message": "No phones paired yet. Run `inyon pair`." }));
    }
    let mut lines = Vec::new();
    let mut list = Vec::new();
    for (key, p) in &all {
        let seen = p.last_seen.map(state::format_time).unwrap_or_else(|| "never".into());
        lines.push(format!("{:<24} {}  paired {}, last seen {seen}", p.name, key.chars().take(12).collect::<String>(), state::format_date(p.paired_at)));
        list.push(json!({ "key": key, "name": p.name, "pairedAt": p.paired_at, "lastSeen": p.last_seen }));
    }
    Ok(json!({ "phones": list, "message": lines.join("\n") }))
}

/// Runs the engine's command and passes its output through; the exit code is the engine's.
fn through(args: Vec<String>) -> Outcome {
    let status = engine::run_through(&args)?;
    if status.success() {
        Ok(json!({ "message": "" }))
    } else {
        Err(format!("inyon-engine {} ended with {}", args.first().cloned().unwrap_or_default(), status.code().unwrap_or(1)))
    }
}

/// The pairing code as the terminal shows it: the engine's answer (`pair --json`) drawn here.
pub fn render_pair(v: &Value) -> String {
    let text = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let list = |k: &str| v.get(k).and_then(Value::as_array).map(|a| a.len()).unwrap_or(0);
    let mut out = String::new();
    out.push_str("\nScan this with your phone's camera, or in the Inyon app (Add a computer → Scan the code), within 10 minutes:\n\n");
    match crate::qr::render(&text("qr")) {
        Ok(code) => out.push_str(&code),
        Err(e) => out.push_str(&format!("(no QR code: {e})")),
    }
    out.push('\n');
    if let Some(short) = v.get("short") {
        let id = short.get("id").and_then(Value::as_str).unwrap_or("");
        let code = short.get("code").and_then(Value::as_str).unwrap_or("");
        let (a, b) = id.split_at(id.len().min(4));
        let (c, d) = code.split_at(code.len().min(3));
        out.push_str(&format!("\nCan't scan it? Choose \"Type a code\" in the app and enter\n\n    ID    {a}-{b}\n    Code  {c} {d}\n\n"));
    }
    out.push_str(&format!("\nOr paste this link into the app:\n{}\n\n", text("link")));
    if list("urls") == 0 && list("relays") == 0 {
        out.push_str("No address yet: the phone will look this machine up once its tunnel is up.\n\n");
    }
    if v.get("service").and_then(Value::as_bool) == Some(false) {
        out.push_str("Keep this running so the phone can connect, or run `inyon service install` to keep it running in the background.\n");
    }
    out
}

/// `inyon pair`: the engine makes the secret and publishes it; the code is drawn here. With
/// `json` the engine's answer is passed on as it is.
pub fn pair(args: &[String], json: bool) -> Outcome {
    let mut answer = None;
    engine::pair(args, &mut |v| {
        if json {
            answer = Some(v.clone());
        } else {
            print!("{}", render_pair(v));
            use std::io::Write;
            let _ = std::io::stdout().flush();
        }
    })?;
    Ok(answer.unwrap_or_else(|| json!({ "message": "" })))
}

pub fn forget(which: &str) -> Outcome {
    let mut v = engine::ask(&["forget", which], &[])?;
    let name = v.get("forgotten").and_then(|f| f.get("name")).and_then(Value::as_str).unwrap_or(which).to_string();
    v["message"] = json!(format!("Forgot {name}. It can't connect until it pairs again."));
    Ok(v)
}

/// `inyon push`: the list is drawn here; `set` and `test` carry the app's JSON on stdin, so they
/// go straight through to the engine.
pub fn push(args: &[String]) -> Outcome {
    if args.first().is_some_and(|a| a == "set" || a == "test") {
        let mut all = vec!["push".to_string()];
        all.extend(args.iter().cloned());
        return through(all);
    }
    let mut v = engine::ask(&["push", "list"], &[])?;
    let browsers: Vec<Value> = v.get("browsers").and_then(Value::as_array).cloned().unwrap_or_default();
    let lines: Vec<String> = browsers
        .iter()
        .map(|b| {
            let name = b.get("name").and_then(Value::as_str).unwrap_or("forgotten phone");
            let done = b.get("done").and_then(Value::as_bool).unwrap_or(true);
            format!("{:<24} {}{}", name, b.get("endpoint").and_then(Value::as_str).unwrap_or(""), if done { "" } else { " (needs-you only)" })
        })
        .collect();
    v["message"] = json!(if lines.is_empty() { "No browser gets notifications from this machine yet.".to_string() } else { lines.join("\n") });
    Ok(v)
}

/// `inyon hub code`: the setup code a new hub asks for, from the engine.
pub fn hub_code() -> Outcome {
    engine::ask(&["hub", "code"], &[])
}

/// `inyon hub reset-password [password]`: asked for here when not given, handed to the engine in
/// its environment rather than on the process list. The engine writes it; a hub running in the
/// background is restarted here to pick it up.
pub fn hub_reset_password(sys: &Sys, password: Option<&str>) -> Outcome {
    let pw = match password {
        Some(p) => p.to_string(),
        None => ui::ask_hidden("New Inyon password: ")?,
    };
    if pw.is_empty() {
        return Err("No password given.".into());
    }
    let mut v = engine::ask(&["hub", "reset-password"], &[("INYON_NEW_PASSWORD", &pw)])?;
    if !service::has_service(sys, Role::Hub) {
        return Ok(v);
    }
    let r = service::restart_service(sys, Role::Hub, &[paths::installed_binary().to_string_lossy().into_owned()]);
    v["restarted"] = json!(r.ok);
    v["message"] = json!(if r.ok {
        "Password updated; everyone was signed out. The hub restarted.".to_string()
    } else {
        format!("Password updated; everyone was signed out. Restart the hub to use it ({}).", r.how)
    });
    Ok(v)
}

// ---------- join, disconnect ----------

/// Whether a hub address is on a private network, where plain http is accepted.
pub fn is_private(host: &str) -> bool {
    let h = host.to_lowercase();
    if let Some(inner) = h.strip_prefix('[') {
        // loopback, unique-local (fc00::/7, Tailscale uses fd7a:115c:a1e0::/48), link-local
        return inner.starts_with("::1")
            || inner.starts_with("fc")
            || inner.starts_with("fd")
            || inner.starts_with("fe8")
            || inner.starts_with("fe9")
            || inner.starts_with("fea")
            || inner.starts_with("feb");
    }
    if h == "localhost" || h == "::1" {
        return true;
    }
    // an address only when every part is a number: 10.0.0.1.attacker.com is a name
    let p: Vec<u8> = h.split('.').map(|o| o.parse().ok()).collect::<Option<Vec<_>>>().unwrap_or_default();
    if p.len() == 4 {
        if p[0] == 127 || p[0] == 10 || (p[0] == 192 && p[1] == 168) || (p[0] == 172 && (16..=31).contains(&p[1])) {
            return true;
        }
        // the CGNAT range Tailscale and NetBird use
        if p[0] == 100 && (64..=127).contains(&p[1]) {
            return true;
        }
    }
    if [".ts.net", ".netbird.cloud", ".netbird.selfhosted", ".local", ".lan", ".internal"].iter().any(|s| h.ends_with(s)) {
        return true;
    }
    // single-label names on your private network
    !h.contains('.')
}

/// Checks a hub address; refuses to send a token over plain http to a public address.
pub fn check_hub_url(hub: &str) -> Result<(), String> {
    let (scheme, rest) = hub.split_once("://").ok_or_else(|| format!("{hub} isn't a web address."))?;
    if scheme != "http" && scheme != "https" {
        return Err(format!("{hub} isn't a web address."));
    }
    let host = rest.split('/').next().unwrap_or("");
    let host = host.rsplit_once('@').map(|(_, h)| h).unwrap_or(host);
    let host = if host.starts_with('[') { host.split(']').next().map(|h| format!("{h}]")).unwrap_or_default() } else { host.split(':').next().unwrap_or("").to_string() };
    if host.is_empty() {
        return Err(format!("{hub} isn't a web address."));
    }
    if scheme == "http" && !is_private(&host) && paths::env_var("INYON_ALLOW_INSECURE").is_none() {
        return Err(format!("Refusing to send the token over plain http to {host}. Use https, or a private network address."));
    }
    Ok(())
}

/// `inyon join <hub-url>`, what the hub's "Add a machine" command runs: saves the hub and token
/// (readable only by you) and runs the connection in the background.
pub fn join(sys: &Sys, hub: &str, token: &str, autostart: bool) -> Outcome {
    let hub = hub.trim_end_matches('/');
    if hub.is_empty() || token.is_empty() {
        return Err("usage: INYON_TOKEN=<token> inyon join <hub-url>".into());
    }
    check_hub_url(hub)?;
    let dir = paths::ensure_node_dir().map_err(|e| e.to_string())?;
    let win = sys.platform == Platform::Windows;
    let mut lines = vec![format!("INYON_HUB={hub}"), format!("INYON_TOKEN={token}")];
    if win {
        if let Some(sh) = paths::env_var("INYON_SH") {
            lines.push(format!("INYON_SH={sh}"));
        }
    }
    let file = dir.join(if win { ".env" } else { "env" });
    write_secret(&file, &format!("{}\n", lines.join("\n"))).map_err(|e| e.to_string())?;
    // the other file name may hold a token from an earlier pairing
    let _ = fs::remove_file(dir.join(if win { "env" } else { ".env" }));
    if win {
        sys::run(&["icacls", &file.to_string_lossy(), "/inheritance:r", "/grant:r", &format!("{}:(R,W)", sys::username()), "SYSTEM:(F)"]);
    }
    for role in service::old_services(sys) {
        if role == Role::Node {
            service::move_old_service(sys, role);
        }
    }
    // with the kill switch the engine comes from the hub just saved, so a machine that can only
    // reach its hub still works; otherwise the connection is built in
    engine::ready("connect", &|l| eprintln!("{l}"))?;
    let mut notes = Vec::new();
    if let Some(m) = service::missing_mux(sys.platform) {
        notes.push(format!("Note: {m}"));
    }
    if !autostart {
        notes.push(format!("Saved. Run `inyon connect` to connect to {}.", http::host_of(hub)));
        return Ok(json!({ "hub": hub, "message": notes.join("\n") }));
    }
    let r = service::install_service(sys, Role::Node, true);
    if !r.ok {
        return Err(format!("Couldn't run the connection in the background ({}). Run `inyon connect` to connect now.", r.how));
    }
    notes.push(format!("inyon is connecting to {}. It runs as {}.", http::host_of(hub), r.how));
    Ok(json!({ "hub": hub, "service": installed(&r), "message": notes.join("\n") }))
}

/// Leaves the hub: the connection stops and the saved address and token go.
pub fn disconnect(sys: &Sys) -> Outcome {
    let hub = saved_hub();
    // the hub is forgotten first: run by a node the hub removed, stopping the service last may
    // stop this process with it
    let dir = node_dir();
    for name in ["env", ".env"] {
        let _ = fs::remove_file(dir.join(name));
    }
    let _ = fs::remove_file(dir.join("node.json"));
    let r = service::uninstall_service(sys, Role::Node);
    let what = hub.as_deref().map(http::host_of).unwrap_or_else(|| "the hub".into());
    if !r.ok {
        return Err(format!("Left {what}, but couldn't remove everything: {}.", r.how));
    }
    Ok(json!({ "hub": hub, "message": format!("Left {what}; {}.", r.how) }))
}

// ---------- services ----------

/// The job `service install` or `uninstall` is about: the one named, or the one this machine has.
pub fn role_arg(sys: &Sys, arg: Option<&str>, installing: bool) -> Result<Role, String> {
    if let Some(a) = arg {
        return Role::parse(a).ok_or_else(|| format!("{a} isn't one of link, node, hub"));
    }
    if saved_hub().is_some() {
        return Ok(Role::Node);
    }
    if !installing {
        let have: Vec<Role> = ROLES.iter().copied().filter(|r| service::has_service(sys, *r)).collect();
        if have.len() == 1 {
            return Ok(have[0]);
        }
    }
    Ok(Role::Link)
}

pub fn service_install(sys: &Sys, role: Option<&str>) -> Outcome {
    let role = role_arg(sys, role, true)?;
    if hub_impl_follows(role) {
        if let Some(e) = engine::hub_impl_clash() {
            return Err(e);
        }
    }
    // run without INYON_LEGACY_ENGINE, this is how the machine goes back to the built-in engine
    engine::remember_legacy(true);
    if hub_impl_follows(role) {
        engine::remember_hub_impl(true);
        // back on the Bun hub: its engine is fetched here, where a failure shows, not by the
        // service, which would only try again every few seconds
        if sys.platform != Platform::Windows {
            engine::ready("hub", &|l| eprintln!("{l}"))?;
        }
    }
    let r = service::install_service(sys, role, true);
    if !r.ok {
        return Err(format!("Couldn't install the service: {}", r.how));
    }
    Ok(json!({ "role": role.name(), "service": installed(&r), "message": format!("inyon {role} runs as {}.", r.how) }))
}

/// Which service's setup decides the hub's INYON_HUB_IMPL note: the hub's only, so putting the
/// link back in place never undoes how the hub was set up.
fn hub_impl_follows(role: Role) -> bool {
    role == Role::Hub
}

pub fn service_uninstall(sys: &Sys, role: Option<&str>) -> Outcome {
    let role = role_arg(sys, role, false)?;
    let r = service::uninstall_service(sys, role);
    // the link started without a service manager (or by hand): stop the copy that's still running
    if role == Role::Link {
        if let Some(pid) = state::link_state().and_then(|s| s.pid).filter(|p| *p != sys.pid && sys.proc.alive(*p)) {
            sys.proc.signal(pid, sys::Signal::Term);
        }
    }
    let kept = if role == Role::Link { " Your pairings are kept." } else { "" };
    if !r.ok {
        return Err(format!("Couldn't remove everything: {}.{kept}", r.how));
    }
    Ok(json!({ "role": role.name(), "service": installed(&r), "message": format!("inyon {role} stopped; {}.{kept}", r.how) }))
}

pub fn service_status(sys: &Sys) -> Outcome {
    let jobs: Vec<Value> = ROLES.iter().map(|r| json!({ "role": r.name(), "service": service::has_service(sys, *r), "running": update::is_running(sys.proc, *r) })).collect();
    let lines: Vec<String> = jobs
        .iter()
        .map(|j| {
            format!(
                "{:<5} {}{}",
                j["role"].as_str().unwrap_or(""),
                if j["service"].as_bool().unwrap_or(false) { "set up" } else { "not set up" },
                if j["running"].as_bool().unwrap_or(false) { ", running" } else { "" }
            )
        })
        .collect();
    Ok(json!({ "jobs": jobs, "message": lines.join("\n") }))
}

// ---------- the hub ----------

pub fn hub_env_file() -> PathBuf {
    data_dir().join("hub.env")
}

fn hub_env() -> std::collections::BTreeMap<String, String> {
    let mut env = read_env_file(&hub_env_file());
    // the hub's settings are text; a variable that isn't (in any locale) is none of them
    for (k, v) in std::env::vars_os() {
        if let (Ok(k), Ok(v)) = (k.into_string(), v.into_string()) {
            env.insert(k, v);
        }
    }
    env
}

/// The hub's own address on this machine, for asking it questions.
pub fn hub_local_url(env: &std::collections::BTreeMap<String, String>) -> String {
    let tls = env.get("TLS_CERT").is_some_and(|v| !v.is_empty()) && env.get("TLS_KEY").is_some_and(|v| !v.is_empty());
    let bind = env.get("BIND").cloned().filter(|b| !b.is_empty()).unwrap_or_else(|| "127.0.0.1".into());
    let host = if bind == "0.0.0.0" || bind == "::" || bind == "127.0.0.1" { "127.0.0.1".to_string() } else { bind };
    format!("{}://{host}:{}", if tls { "https" } else { "http" }, env.get("PORT").cloned().filter(|p| !p.is_empty()).unwrap_or_else(|| "4777".into()))
}

fn ask_hub(url: &str) -> Option<Value> {
    let res = http::get_local(&format!("{url}/api/session")).ok()?;
    serde_json::from_slice(&res.body).ok()
}

/// How to open a hub that answers on this machine only from a phone.
pub fn reach_advice(nets: &[networks::Network], port: u16, env_file: &str) -> Vec<String> {
    let private: Vec<&networks::Network> = nets.iter().filter(|n| n.kind != networks::Kind::Lan).collect();
    if private.is_empty() {
        return vec![format!("It answers on this machine only. To open it from your phone, put it behind HTTPS (Caddy, a tunnel) or set BIND in {env_file}.")];
    }
    let mut lines = vec!["To open it from your phone:".to_string()];
    for n in private {
        lines.push(format!(
            "  {}: add BIND={} and INYON_ALLOW_HTTP=1 to {env_file}, run `inyon hub start` again, then open http://{}:{port}",
            n.kind.label(),
            n.ip,
            n.name.as_deref().unwrap_or(&n.ip)
        ));
    }
    // the network encrypts it either way; browsers still treat plain http as unsafe
    lines.push("Over plain http the browser won't install the app or show notifications; HTTPS lets it.".into());
    lines
}

/// Sets the hub up as a background service and says where to open it, with the setup code.
pub fn hub_start(sys: &Sys) -> Outcome {
    if sys.platform == Platform::Windows {
        return Err("The Inyon hub runs on Linux and macOS. On Windows, install it inside WSL.".into());
    }
    if let Some(e) = engine::hub_impl_clash() {
        return Err(e);
    }
    // the Rust hub is built in; only the Bun one is downloaded
    if engine::needs_bun("hub") {
        engine::ensure(&|l| eprintln!("{l}"))?;
    }
    let env = hub_env();
    let r = service::install_service(sys, Role::Hub, true);
    if !r.ok {
        return Err(format!("Couldn't run the hub in the background: {}. Run `inyon hub` to start it here.", r.how));
    }
    let tls = env.get("TLS_CERT").is_some_and(|v| !v.is_empty()) && env.get("TLS_KEY").is_some_and(|v| !v.is_empty());
    let bind = env.get("BIND").cloned().filter(|b| !b.is_empty()).unwrap_or_else(|| "127.0.0.1".into());
    let port: u16 = env.get("PORT").and_then(|p| p.parse().ok()).unwrap_or(4777);
    let local_host = bind.starts_with("127.") || bind == "::1" || bind == "localhost" || bind == "0.0.0.0" || bind == "::";
    let where_ = format!("{}://{}:{port}", if tls { "https" } else { "http" }, if local_host { "localhost".to_string() } else { bind.clone() });
    let mut lines = vec![format!("The Inyon hub runs as {}.", r.how)];
    // a new hub writes a one-time code for choosing its password as it starts
    let local = hub_local_url(&env);
    let mut code = String::new();
    let answered = ui::with_motif("waiting for the hub", Theme::detect(true), move || {
        for _ in 0..60 {
            if let Some(session) = ask_hub(&local) {
                return Some(session);
            }
            std::thread::sleep(std::time::Duration::from_millis(250));
        }
        None
    });
    if answered.as_ref().and_then(|s| s.get("setup")).and_then(|v| v.as_bool()) == Some(true) {
        code = fs::read_to_string(data_dir().join("setup-code")).map(|c| c.trim().to_string()).unwrap_or_default();
    }
    lines.push(String::new());
    lines.push(if code.is_empty() {
        format!("Open {where_} in a browser and sign in.")
    } else {
        format!("Open {where_} in a browser and enter the setup code {code} to choose a password (`inyon hub code` shows it again).")
    });
    if bind == "127.0.0.1" && !tls {
        lines.push(String::new());
        lines.extend(reach_advice(&networks::detect(), port, &hub_env_file().to_string_lossy()));
    }
    Ok(json!({ "service": installed(&r), "address": where_, "code": code, "message": lines.join("\n") }))
}

pub fn hub_stop(sys: &Sys) -> Outcome {
    let r = service::uninstall_service(sys, Role::Hub);
    if !r.ok {
        return Err(format!("Couldn't remove everything: {}.", r.how));
    }
    Ok(json!({ "service": installed(&r), "message": format!("The hub stopped; {}. Its records stay in {}.", r.how, data_dir().display()) }))
}

pub fn hub_restart(sys: &Sys) -> Outcome {
    // nothing to restart: say so before fetching anything
    if !service::can_restart(sys, Role::Hub) {
        return Err("Couldn't restart the hub: no background service or process found.".into());
    }
    // back on the Bun hub (INYON_HUB_IMPL=bun), its engine may have been tidied away meanwhile:
    // fetch it here, where a failure shows, not inside the service
    if sys.platform != Platform::Windows && engine::needs_bun("hub") {
        engine::ensure(&|l| eprintln!("{l}"))?;
    }
    let r = service::restart_service(sys, Role::Hub, &[paths::installed_binary().to_string_lossy().into_owned()]);
    if !r.ok {
        return Err(format!("Couldn't restart the hub: {}.", r.how));
    }
    Ok(json!({ "service": installed(&r), "message": format!("The hub restarted ({}).", r.how) }))
}

// ---------- logs, doctor ----------

pub fn logs(sys: &Sys, role: Option<&str>, lines: usize, follow: bool) -> Outcome {
    let role = match role {
        Some(r) => Role::parse(r).ok_or_else(|| format!("{r} isn't one of link, node, hub"))?,
        None => {
            let active = service::active_roles(sys);
            active.first().copied().unwrap_or(Role::Link)
        }
    };
    let file = service::log_file(role);
    let unit = format!("inyon-{role}");
    // a systemd unit logs to the journal, not the file
    if sys.platform == Platform::Linux && service::unit_file(&unit).exists() && which("journalctl").is_some() {
        let n = lines.to_string();
        let mut args = vec!["journalctl", "--user", "-u", &unit, "-n", &n, "--no-pager", "-o", "cat"];
        if follow {
            args.push("-f");
        }
        let status = std::process::Command::new(args[0]).args(&args[1..]).status().map_err(|e| e.to_string())?;
        return if status.success() { Ok(json!({ "message": "" })) } else { Err("journalctl couldn't show the log".into()) };
    }
    let text = fs::read_to_string(&file).unwrap_or_default();
    let all: Vec<&str> = text.lines().collect();
    let tail: Vec<String> = all.iter().rev().take(lines).rev().map(|l| l.to_string()).collect();
    if !follow {
        if tail.is_empty() {
            return Ok(json!({ "file": file, "lines": [], "message": format!("Nothing in {} yet.", file.display()) }));
        }
        return Ok(json!({ "file": file, "lines": tail, "message": tail.join("\n") }));
    }
    println!("{}", tail.join("\n"));
    let mut seen = text.len() as u64;
    loop {
        std::thread::sleep(std::time::Duration::from_millis(500));
        let Ok(now) = fs::read(&file) else { continue };
        if (now.len() as u64) < seen {
            seen = 0;
        }
        if (now.len() as u64) > seen {
            print!("{}", String::from_utf8_lossy(&now[seen as usize..]));
            seen = now.len() as u64;
        }
    }
}

fn port_open(port: u16) -> bool {
    std::net::TcpStream::connect_timeout(&std::net::SocketAddr::from(([127, 0, 0, 1], port)), std::time::Duration::from_millis(300)).is_ok()
}

pub fn doctor(sys: &Sys) -> Outcome {
    let mut checks: Vec<(bool, String, String)> = Vec::new();
    // the Bun engine, for a hub or with the kill switch; everything else is built in
    let bun = engine::find();
    let bun_line = |p: &Path| {
        format!("{} ({})", p.display(), engine::capture(&["version"]).ok().filter(|(s, _)| s.success()).map(|(_, v)| v.trim().to_string()).unwrap_or_else(|| "no version".into()))
    };
    if engine::legacy() {
        match &bun {
            Some(p) => checks.push((true, "engine".into(), format!("{}, the Bun engine (INYON_LEGACY_ENGINE is set)", bun_line(p)))),
            None => checks.push((false, "engine".into(), "INYON_LEGACY_ENGINE is set but the Bun engine isn't here; run `inyon service install`".into())),
        }
        if engine::hub_impl_wanted() {
            checks.push((false, "hub engine".into(), "the Bun hub: INYON_HUB_IMPL=rust doesn't count while INYON_LEGACY_ENGINE is set".into()));
        }
    } else {
        checks.push((true, "engine".into(), format!("built in ({VERSION})")));
        if engine::rust_hub() {
            checks.push((true, "hub engine".into(), "the Rust hub, built in (INYON_HUB_IMPL=rust)".into()));
        } else if service::has_service(sys, Role::Hub) || engine::hub_here() {
            match &bun {
                Some(p) => checks.push((true, "hub engine".into(), bun_line(p))),
                None => checks.push((false, "hub engine".into(), "not here yet; `inyon hub start` downloads it".into())),
            }
        }
    }
    checks.push((true, "inyon".into(), format!("{VERSION} at {}", std::env::current_exe().map(|p| p.display().to_string()).unwrap_or_default())));
    match service::missing_mux(sys.platform) {
        None => checks.push((true, if sys.platform == Platform::Windows { "psmux" } else { "tmux" }.into(), "installed".into())),
        Some(m) => checks.push((false, "tmux".into(), m)),
    }
    let agents: Vec<&str> = ["claude", "codex", "gemini", "opencode"].into_iter().filter(|a| which(a).is_some()).collect();
    checks.push((!agents.is_empty(), "agents".into(), if agents.is_empty() { "none of claude, codex, gemini, opencode on PATH".into() } else { agents.join(", ") }));
    for r in ROLES {
        let has = service::has_service(sys, r);
        let running = update::is_running(sys.proc, r);
        if has || running {
            checks.push((running || !has, format!("{r}"), format!("{}{}", if has { "set up" } else { "started by hand" }, if running { ", running" } else { ", not running" })));
        }
    }
    let old = service::old_services(sys);
    if !old.is_empty() {
        checks.push((
            false,
            "old services".into(),
            format!("{} still set up as tether-node; `inyon migrate` moves them", old.iter().map(|r| r.name()).collect::<Vec<_>>().join(", ")),
        ));
    }
    if sys.platform != Platform::Windows {
        let link_port = state::link_config().port.unwrap_or(4780);
        checks.push((true, "link port".into(), format!("{link_port}: {}", if port_open(link_port) { "answers" } else { "nothing listens" })));
    }
    if service::has_service(sys, Role::Hub) {
        let port: u16 = read_env_file(&hub_env_file()).get("PORT").and_then(|p| p.parse().ok()).unwrap_or(4777);
        checks.push((port_open(port), "hub port".into(), format!("{port}: {}", if port_open(port) { "answers" } else { "nothing listens" })));
    }
    let nets = networks::detect();
    checks.push((
        true,
        "networks".into(),
        if nets.is_empty() { "no LAN or VPN address found".into() } else { nets.iter().map(|n| format!("{} {}", n.kind.label(), n.ip)).collect::<Vec<_>>().join(", ") },
    ));
    let cloudflared = which("cloudflared").is_some() || bin_dir().join("cloudflared").exists() || bin_dir().join("cloudflared.exe").exists();
    checks.push((true, "tunnel".into(), if cloudflared { "cloudflared is here".into() } else { "cloudflared isn't here yet; the link fetches it on first use".into() }));
    checks.push((true, "clock".into(), format!("{} UTC", state::format_utc(state::now_ms()))));
    if let Ok(s) = fs::read_to_string(update::status_file()) {
        let s = s.trim().to_string();
        checks.push((!s.starts_with("failed"), "last update".into(), s));
    }
    let lines: Vec<String> = checks.iter().map(|(ok, name, detail)| format!("{} {:<12} {detail}", if *ok { "✓" } else { "!" }, name)).collect();
    let list: Vec<Value> = checks.iter().map(|(ok, name, detail)| json!({ "ok": ok, "check": name, "detail": detail })).collect();
    let all_ok = checks.iter().all(|c| c.0);
    Ok(json!({ "ok": all_ok, "checks": list, "message": lines.join("\n") }))
}

// ---------- update ----------

struct RealHost<'a> {
    sys: &'a Sys<'a>,
    quiet: bool,
}

impl update::Host for RealHost<'_> {
    fn version(&self) -> String {
        VERSION.to_string()
    }
    fn roles(&self) -> Vec<Role> {
        service::active_roles(self.sys)
    }
    fn wants_engine(&self) -> bool {
        engine::legacy() || ((self.roles().contains(&Role::Hub) || engine::hub_here()) && !engine::rust_hub())
    }
    fn restart(&self, role: Role, cmd: &[String]) -> Installed {
        service::restart_service(self.sys, role, cmd)
    }
    fn started(&self, role: Role, version: Option<&str>, before: Option<u32>) -> bool {
        update::wait_started(self.sys.proc, role, version, before, &update::WaitOptions::default())
    }
    fn old_roles(&self) -> Vec<Role> {
        service::old_services(self.sys)
    }
    fn move_old(&self, role: Role) -> Installed {
        service::move_old_service(self.sys, role)
    }
    fn log(&self, line: &str) {
        if !self.quiet {
            println!("{line}");
        }
    }
    fn platform(&self) -> Platform {
        self.sys.platform
    }
}

/// Gets the newest version and restarts what runs in the background with it. With --background
/// (how the app asks for it) the update runs on its own, since the restart ends the process that asked.
pub fn update_command(sys: &Sys, background: bool, json: bool) -> Outcome {
    update::set_status("running");
    if background {
        let r = service::detach_update(sys, &sys.program);
        if !r.ok {
            update::set_status(&format!("failed: {}", r.how));
            return Err(format!("Couldn't start the update: {}", r.how));
        }
        return Ok(
            json!({ "background": true, "how": r.how, "message": format!("Updating inyon in the background ({}). Progress goes to {}.", r.how, node_dir().join("update.log").display()) }),
        );
    }
    let mut me = PathBuf::from(sys.program.first().cloned().unwrap_or_default());
    // npm's copy stays as npm installed it: update the one the services run from instead
    let npm = update::from_npm(&me);
    if npm {
        me = paths::installed_binary();
        if !me.exists() {
            update::set_status("failed: installed with npm");
            return Err(format!("This inyon came from npm. Update it with:\n  {}", update::NPM_UPDATE));
        }
    }
    let install = update::find_install(&me, saved_hub());
    let host = RealHost { sys, quiet: json };
    let result = update::update(&install, &host, &update::RealFiles);
    service::forget_task(sys, service::UPDATE_TASK);
    match result {
        Ok(mut r) => {
            update::set_status(&if r.changed { format!("done {}", r.version.clone().unwrap_or_default()).trim().to_string() } else { format!("current {VERSION}") });
            if npm {
                r.message = format!("{} The inyon command itself came from npm. Update it with:\n  {}", r.message, update::NPM_UPDATE);
            }
            if r.changed {
                // the version Settings → Apps shows on Windows
                service::register_app(sys);
            }
            Ok(json!({ "changed": r.changed, "version": r.version, "message": r.message }))
        }
        Err(e) => {
            let m = e.to_string();
            update::set_status(&format!("failed: {m}"));
            Err(m)
        }
    }
}

/// `inyon migrate`: moves every job from its tether-node service to inyon's own, and from the Bun
/// engine to the one built in (0.19): Windows' logon tasks get the windowless copy of this program
/// in place of the Bun engine, and a Bun engine nothing needs any more goes. With `background` it
/// runs on its own and returns at once, as the tray icon starts it from inside a service.
pub fn migrate(sys: &Sys, background: bool) -> Outcome {
    if background {
        let mut args = sys.program.clone();
        args.push("migrate".into());
        let r = service::detach(sys, &args, service::HAND_OVER_TASK);
        return if r.ok { Ok(json!({ "background": true, "message": format!("Moving the services in the background ({}).", r.how) })) } else { Err(r.how) };
    }
    let dir = paths::ensure_node_dir().map_err(|e| e.to_string())?;
    let lock = dir.join("migrate.lock");
    if fs::OpenOptions::new().write(true).create_new(true).open(&lock).is_err() {
        return Ok(json!({ "message": "another copy is moving the old services already" }));
    }
    let mut lines = Vec::new();
    for role in service::old_services(sys) {
        let r = service::move_old_service(sys, role);
        lines.push(format!("{role}: {}", if r.ok { format!("moved; it runs as {}", r.how) } else { format!("not moved ({})", r.how) }));
    }
    lines.extend(to_builtin_engine(sys));
    let _ = fs::remove_file(&lock);
    service::forget_task(sys, service::HAND_OVER_TASK);
    if lines.is_empty() {
        lines.push("nothing to move".into());
    }
    Ok(json!({ "message": lines.join("\n") }))
}

/// Moves what still runs on the Bun engine to the engine built into this program, unless
/// INYON_LEGACY_ENGINE asks for the Bun engine. What it did, a line each.
fn to_builtin_engine(sys: &Sys) -> Vec<String> {
    if engine::legacy() {
        return Vec::new();
    }
    let mut lines = Vec::new();
    if sys.platform == Platform::Windows {
        let installed = paths::installed_engine();
        if !installed.is_file() || engine::is_builtin_copy(&installed) {
            return lines;
        }
        // an update from 0.18 checks for a few seconds that the engine it restarted stays up, and
        // puts the old version back if it has gone: the move waits until no update is restarting anything
        if !updates_settled(sys, 300, 2000) {
            lines.push("engine: an update is still running, so the move to the built-in engine waits for the next start".into());
            return lines;
        }
        let program = vec![paths::installed_binary().to_string_lossy().into_owned()];
        for role in [Role::Link, Role::Node] {
            if service::has_service(sys, role) {
                // registered again, the task runs the windowless copy, made in place of the Bun engine
                let r = service::restart_service(sys, role, &program);
                lines.push(format!("{role}: {}", if r.ok { "runs on the built-in engine now".to_string() } else { format!("still on the Bun engine ({})", r.how) }));
            }
        }
        if lines.is_empty() {
            if let Err(e) = engine::refresh_copy(&paths::installed_binary()) {
                lines.push(format!("engine: couldn't make the windowless copy ({e})"));
            }
        }
        // it ran: if it didn't take, the tray icon tries again an hour from now at the soonest
        let _ = fs::write(node_dir().join(HAND_OVER_RAN), state::now_ms().to_string());
    } else if let Some(stale) = engine::stale_engine() {
        if fs::remove_file(&stale).is_ok() {
            lines.push(format!("engine: removed {}, which nothing needs any more", stale.display()));
        }
    }
    lines
}

/// When the move to the built-in engine last ran, and when a tray icon last asked for it.
const HAND_OVER_RAN: &str = "engine-hand-over";
const HAND_OVER_ASKED: &str = "engine-hand-over-asked";

/// Whether no update is under way and the jobs that run are on this version, checked `tries`
/// times `every_ms` apart until it's so.
fn updates_settled(sys: &Sys, tries: u32, every_ms: u64) -> bool {
    let settled = || {
        !update::under_way()
            && [Role::Link, Role::Node].into_iter().all(|r| match update::read_running(r) {
                Some(s) => s.version.as_deref() == Some(VERSION) || !s.pid.is_some_and(|p| sys.proc.alive(p)),
                None => true,
            })
    };
    for _ in 1..tries {
        if settled() {
            return true;
        }
        sys.proc.sleep_ms(every_ms);
    }
    settled()
}

/// Whether the tray icon should move this machine to the built-in engine: on Windows, when the
/// logon task still starts the Bun engine (set up by 0.18 or earlier, updated by it). Once an hour
/// at most after a move that ran, in case it fails, and not twice at once (the link's and the hub
/// connection's icons start together).
pub fn wants_hand_over(sys: &Sys) -> bool {
    if sys.platform != Platform::Windows || engine::legacy() {
        return false;
    }
    let installed = paths::installed_engine();
    if !installed.is_file() || engine::is_builtin_copy(&installed) {
        return false;
    }
    let now = state::now_ms() as u64;
    let since = |name: &str| now.saturating_sub(fs::read_to_string(node_dir().join(name)).ok().and_then(|t| t.trim().parse::<u64>().ok()).unwrap_or(0));
    if since(HAND_OVER_RAN) < 3_600_000 || since(HAND_OVER_ASKED) < 900_000 {
        return false;
    }
    let _ = paths::ensure_node_dir();
    let _ = fs::write(node_dir().join(HAND_OVER_ASKED), now.to_string());
    true
}

/// Takes inyon off this machine: every service, the programs, and with `purge` the pairings too.
/// With `ask`, a terminal is there to answer whether tmux that setup installed goes as well.
pub fn uninstall_all(sys: &Sys, purge: bool, ask: bool) -> Outcome {
    let mut lines = Vec::new();
    // asked first, while the record of what setup installed is still there
    let mux = service::remove_mux(sys, ask);
    for r in ROLES {
        if service::has_service(sys, r) || update::is_running(sys.proc, r) {
            let u = service::uninstall_service(sys, r);
            lines.push(format!("{r}: {}", u.how));
        }
    }
    if let Some(pid) = state::link_state().and_then(|s| s.pid).filter(|p| *p != sys.pid && sys.proc.alive(*p)) {
        sys.proc.signal(pid, sys::Signal::Term);
    }
    // on Windows the engines, the tray icons and the tunnel keep their files open until they stop
    service::stop_programs(sys);
    lines.extend(service::remove_firewall_rule(sys));
    service::unregister_app(sys);
    lines.extend(mux);
    let bin = bin_dir();
    let mut later = Vec::new();
    if bin.exists() {
        let me = std::env::current_exe().ok().and_then(|m| fs::canonicalize(m).ok());
        let mut left = Vec::new();
        for entry in fs::read_dir(&bin).into_iter().flatten().flatten() {
            let p = entry.path();
            if sys.platform == Platform::Windows && me.is_some() && fs::canonicalize(&p).ok() == me {
                // a running .exe can't be deleted: it goes once this command has ended
                later.push(p);
                continue;
            }
            let gone = if p.is_dir() { fs::remove_dir_all(&p) } else { fs::remove_file(&p) };
            if gone.is_err() && p.exists() {
                left.push(p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default());
            }
        }
        let _ = fs::remove_dir(&bin);
        if left.is_empty() {
            lines.push(format!("removed {}", bin.display()));
        } else {
            lines.push(format!("couldn't remove {} in {} (in use; close it and run this again)", left.join(", "), bin.display()));
        }
    }
    // the PATH entry the installer added for it
    if sys.platform == Platform::Windows {
        let o = sys::run(&["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", crate::shellpath::WINDOWS_SCRIPT]);
        if o.ok && o.out.contains("removed") {
            lines.push(format!("took {} off your Path", bin.display()));
        }
    } else {
        lines.extend(crate::shellpath::remove_unix(&paths::home(), std::env::var_os("ZDOTDIR").map(PathBuf::from)));
    }
    if purge {
        // Claude Code and Antigravity stop calling Inyon's scripts before they're deleted
        lines.extend(crate::unhook::unhook(&paths::home()));
        let _ = fs::remove_dir_all(node_dir());
        // one entry at a time: a file something still has open (on Windows) stops only itself,
        // and bin, where this program runs from, goes after it has ended
        let mut left = Vec::new();
        for entry in fs::read_dir(home_inyon()).into_iter().flatten().flatten() {
            let p = entry.path();
            if p == bin {
                continue;
            }
            let gone = if p.is_dir() { fs::remove_dir_all(&p) } else { fs::remove_file(&p) };
            if gone.is_err() && p.exists() {
                left.push(p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default());
            }
        }
        if !left.is_empty() {
            lines.push(format!("couldn't remove {} in {} (in use; close it and delete the folder)", left.join(", "), home_inyon().display()));
        }
        // what older versions and the SSH connections kept: the ~/.tether link, its folder, sockets
        for old in [".tether", ".tether-node", ".cache/inyon-ssh"] {
            let p = paths::home().join(old);
            if fs::symlink_metadata(&p).is_ok_and(|m| m.file_type().is_symlink()) {
                let _ = fs::remove_file(&p);
            } else {
                let _ = fs::remove_dir_all(&p);
            }
        }
        // the folder itself, now empty (on Windows it goes with bin once this command has ended)
        if sys.platform != Platform::Windows {
            let _ = fs::remove_dir(home_inyon());
        }
        lines.push("removed the pairings, keys, uploads and logs".into());
    } else {
        lines.push(format!("Your pairings stay in {}; add --purge to remove them too.", node_dir().display()));
    }
    service::delete_after_exit(sys, &later, &if purge { home_inyon() } else { bin });
    Ok(json!({ "message": lines.join("\n") }))
}

fn home_inyon() -> PathBuf {
    paths::home().join(".inyon")
}

// ---------- setup ----------

/// The plan from the flags, for a script or a terminal that can't draw.
pub struct SetupFlags {
    pub yes: bool,
    pub role: Option<String>,
    pub network: Option<String>,
    pub port: Option<u16>,
    pub autostart: Option<bool>,
    pub hub: Option<String>,
}

pub fn plan_from_flags(platform: Platform, nets: Vec<networks::Network>, f: &SetupFlags) -> Result<Plan, String> {
    let mut plan = Plan::new(platform, nets);
    if let Some(r) = &f.role {
        plan.role = RoleChoice::parse(r).ok_or_else(|| format!("--role must be hub, node or join, not {r}"))?;
        if plan.role == RoleChoice::Hub {
            plan.port = "4777".into();
        }
    }
    if let Some(h) = &f.hub {
        plan.hub_url = h.clone();
        if f.role.is_none() {
            plan.role = RoleChoice::Join;
        }
    }
    if let Some(n) = &f.network {
        plan.set_network(n)?;
    }
    if let Some(p) = f.port {
        plan.port = p.to_string();
    }
    if let Some(a) = f.autostart {
        plan.autostart = a;
    }
    if plan.role == RoleChoice::Hub && platform == Platform::Windows {
        return Err("The Inyon hub runs on Linux and macOS. On Windows, install it inside WSL.".into());
    }
    if plan.role == RoleChoice::Join && plan.hub_url.is_empty() {
        return Err("--hub <url> says which hub to join (with the token in INYON_TOKEN).".into());
    }
    Ok(plan)
}

/// `inyon setup`: the screens when there's a terminal, the flags otherwise, then the plan is
/// carried out and the engine shows the pairing code.
pub fn setup(sys: &Sys, theme: Theme, flags: Option<&SetupFlags>, interactive: bool) -> Outcome {
    let nets = networks::detect();
    let plan = match flags {
        Some(f) => plan_from_flags(sys.platform, nets, f)?,
        None => Plan::new(sys.platform, nets),
    };
    let ask = interactive && !flags.is_some_and(|f| f.yes);
    let progress = std::sync::Arc::new(std::sync::Mutex::new(None::<String>));
    // the engine comes down behind the screens (or with a progress line, when there are none),
    // so it's here by the time the pairing code is wanted
    let fetch = {
        let progress = progress.clone();
        std::thread::spawn(move || {
            // built in from 0.19: only the kill switch wants the Bun engine now (a hub gets it as it starts)
            if !engine::legacy() || engine::find().is_some() {
                return Ok(());
            }
            let say = |l: &str| {
                if ask {
                    if let Ok(mut p) = progress.lock() {
                        *p = Some(l.to_string());
                    }
                } else {
                    ui::progress_line(l);
                }
            };
            let r = engine::download_to(&paths::installed_engine(), &say);
            let last = match &r {
                Ok(()) => "The engine is here.".to_string(),
                Err(e) => format!("! {e}"),
            };
            say(&last);
            if !ask {
                eprintln!();
            }
            r
        })
    };
    let plan = if ask {
        match ui::setup::run_interactive(plan, theme, progress.clone()).map_err(|e| e.to_string())? {
            Some(p) => p,
            None => return Ok(json!({ "message": "Nothing changed." })),
        }
    } else {
        plan
    };
    if !ask {
        for (k, v) in plan.summary() {
            println!("{k:<12}{v}");
        }
    }
    if fetch.join().map_err(|_| "the engine download stopped".to_string())?.is_err() {
        // the first command that needs it says so in full
        eprintln!("! The engine couldn't be downloaded yet; it's fetched again on the next command that needs it.");
    }
    apply(sys, &plan, ask, interactive)
}

/// Carries the plan out. `ask` says whether to ask before installing tmux; `interactive` whether
/// a terminal is there at all (sudo can ask for a password).
pub fn apply(sys: &Sys, plan: &Plan, ask: bool, interactive: bool) -> Outcome {
    let mut lines = vec![service::install_mux(sys, ask, interactive)];
    // Windows lists it under Settings → Apps, with Uninstall there running `inyon uninstall`
    lines.extend(service::register_app(sys));
    // and finds `inyon` by name in new windows, whichever way this copy got into ~/.inyon/bin
    let installed_here = std::env::current_exe().ok().and_then(|e| fs::canonicalize(e).ok()).is_some_and(|e| Some(e) == fs::canonicalize(paths::installed_binary()).ok());
    if sys.platform == Platform::Windows && installed_here && paths::env_var("INYON_NO_MODIFY_PATH").is_none() {
        let o = sys::run(&["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", crate::shellpath::WINDOWS_ADD_SCRIPT]);
        if o.ok && o.out.contains("added") {
            lines.push("✓ Put inyon on your Path: new windows find it by name".into());
        }
    }
    match plan.role {
        RoleChoice::Join => {
            let token = paths::env_var("INYON_TOKEN").unwrap_or_default();
            let r = join(sys, &plan.hub_url, &token, plan.autostart)?;
            lines.push(r["message"].as_str().unwrap_or("").to_string());
            Ok(json!({ "role": "join", "message": lines.join("\n") }))
        }
        RoleChoice::Hub => {
            let file = hub_env_file();
            let mut env = read_env_file(&file);
            let bind = match &plan.bind {
                Bind::Localhost => "127.0.0.1".to_string(),
                Bind::Lan => "0.0.0.0".to_string(),
                Bind::Vpn(ip) => ip.clone(),
                Bind::Own(a) => a.clone(),
            };
            env.insert("BIND".into(), bind.clone());
            env.insert("PORT".into(), plan.port_number().to_string());
            if bind != "127.0.0.1" && !(env.contains_key("TLS_CERT") && env.contains_key("TLS_KEY")) {
                env.insert("INYON_ALLOW_HTTP".into(), "1".into());
            }
            let _ = fs::create_dir_all(data_dir());
            fs::write(&file, env.iter().map(|(k, v)| format!("{k}={v}\n")).collect::<String>()).map_err(|e| e.to_string())?;
            if !plan.autostart {
                lines.push("Starting the hub here; keep this window open.".into());
                println!("{}", lines.join("\n"));
                engine::forward(&["hub".to_string()]);
            }
            let r = hub_start(sys)?;
            lines.push(r["message"].as_str().unwrap_or("").to_string());
            Ok(json!({ "role": "hub", "address": r["address"], "code": r["code"], "message": lines.join("\n") }))
        }
        RoleChoice::Node => {
            // the link reads its settings as it starts; setup is the one time this program writes them
            let mut cfg = state::link_config();
            cfg.tunnel = Some(plan.tunnel);
            cfg.lan = Some(plan.lan);
            cfg.vpn = Some(plan.vpn);
            cfg.urls = Some(if plan.own_url.is_empty() { Vec::new() } else { vec![plan.own_url.clone()] });
            cfg.port = Some(plan.port_number());
            state::write_json("link.json", &cfg).map_err(|e| e.to_string())?;
            engine::ready("link", &|l| eprintln!("{l}"))?;
            if plan.lan || plan.vpn {
                lines.extend(service::allow_link_through_firewall(sys, plan.port_number()));
            }
            if plan.autostart {
                let running = state::link_state().and_then(|s| s.pid).filter(|p| *p != sys.pid).is_some_and(|p| sys.proc.alive(p));
                let (svc, note) = if service::old_services(sys).contains(&Role::Link) {
                    // set up before the rename to Inyon: the link moves to inyon's own service
                    (service::move_old_service(sys, Role::Link), format!("✓ Restarted with version {VERSION}."))
                } else {
                    let stale = running && update::stale_link(state::link_state().as_ref(), &engine::version().unwrap_or_default());
                    if running && !stale {
                        (Installed { ok: true, how: String::new() }, "✓ Already running in the background".to_string())
                    } else {
                        let r = service::install_service(sys, Role::Link, stale);
                        let note = if stale { "✓ Restarted with the new version.".to_string() } else { format!("✓ Runs as {}.", r.how) };
                        (r, note)
                    }
                };
                if svc.ok {
                    lines.push(note);
                    for _ in 0..20 {
                        if state::link_state().and_then(|s| s.pid).is_some_and(|p| sys.proc.alive(p)) {
                            break;
                        }
                        sys.proc.sleep_ms(500);
                    }
                } else {
                    lines.push(format!("! Couldn't set up a background service ({}). Keep this window open instead.", svc.how));
                }
            }
            println!("{}", lines.join("\n"));
            // the engine makes the secret and publishes it; the code is drawn here
            pair(&[], false)?;
            if plan.autostart {
                println!("Paired phones connect by themselves from now on. To pair another phone later, run `inyon pair`.");
            }
            Ok(json!({ "role": "node", "message": "" }))
        }
    }
}

/// Everything the engine still has to say, for `inyon hub …` forms this program doesn't handle.
pub fn hub_other(args: &[String]) -> ! {
    let mut all = vec!["hub".to_string()];
    all.extend(args.iter().cloned());
    engine::forward(&all)
}

/// The saved hub, for the dashboard and `doctor`.
pub fn joined() -> bool {
    saved_hub().is_some() || saved_env().contains_key("INYON_HUB")
}

/// Writes a file only you can read, from its first byte: it holds the hub token.
fn write_secret(file: &std::path::Path, content: &str) -> std::io::Result<()> {
    use std::io::Write;
    let mut o = fs::OpenOptions::new();
    o.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        o.mode(0o600);
        // an older file keeps its mode when opened, so set it too
        let _ = fs::set_permissions(file, fs::Permissions::from_mode(0o600));
    }
    o.open(file)?.write_all(content.as_bytes())
}

// ---------- skill ----------

/// `~/…` for a path under the home folder, so the lines stay short.
fn home_short(p: &std::path::Path) -> String {
    let home = paths::home();
    match p.strip_prefix(&home) {
        Ok(rest) => format!("~/{}", rest.display()).replace('\\', "/"),
        Err(_) => p.display().to_string(),
    }
}

fn skill_dirs(to: Option<PathBuf>) -> Vec<PathBuf> {
    to.map(|d| vec![d]).unwrap_or_else(|| crate::skills::targets(&paths::home()))
}

pub fn skill_list() -> Outcome {
    let (_, sums) = crate::skills::release(Platform::current())?;
    let dirs = skill_dirs(None);
    let names = crate::skills::available(&sums);
    if names.is_empty() {
        return Ok(json!({ "skills": [], "message": "This release has no skills to install." }));
    }
    let rows: Vec<Value> = names
        .iter()
        .map(|n| {
            let at: Vec<String> = crate::skills::installed(&dirs, n).iter().map(|p| home_short(p)).collect();
            json!({ "name": n, "installed": at })
        })
        .collect();
    let lines: Vec<String> = rows
        .iter()
        .map(|r| {
            let at: Vec<&str> = r["installed"].as_array().map(|a| a.iter().filter_map(|x| x.as_str()).collect()).unwrap_or_default();
            format!("  {:<12} {}", r["name"].as_str().unwrap_or(""), if at.is_empty() { "not installed".to_string() } else { format!("in {}", at.join(", ")) })
        })
        .collect();
    Ok(json!({ "skills": rows, "message": format!("Skills in this release:\n{}\nInstall one with: inyon skill add <name>", lines.join("\n")) }))
}

pub fn skill_add(name: &str, to: Option<PathBuf>, force: bool, json: bool) -> Outcome {
    if !crate::skills::valid_name(name) {
        return Err(format!("\"{name}\" isn't a skill name. See them with: inyon skill list"));
    }
    let (base, sums) = crate::skills::release(Platform::current())?;
    let log = |l: &str| {
        if !json {
            eprint!("{l}");
        }
    };
    let gz = crate::skills::download(&base, &sums, name, &log)?;
    let files = crate::skills::read_tarball(&gz, name)?;
    let version = update::latest_version(&base).unwrap_or_default();
    let mut done = Vec::new();
    for dir in skill_dirs(to) {
        done.push(home_short(&crate::skills::install(&dir, name, &files, &version, force)?));
    }
    Ok(json!({
        "name": name,
        "installed": done,
        "message": format!("Installed the {name} skill in:\n  {}\nYour agents pick it up in their next session.", done.join("\n  ")),
    }))
}

pub fn skill_remove(name: &str, to: Option<PathBuf>) -> Outcome {
    let mut gone = Vec::new();
    for dir in skill_dirs(to) {
        if crate::skills::remove(&dir, name)? {
            gone.push(home_short(&dir.join(name)));
        }
    }
    if gone.is_empty() {
        return Err(format!("No copy of {name} that Inyon installed was found. A skill you added yourself stays where you put it."));
    }
    Ok(json!({ "name": name, "removed": gone, "message": format!("Removed {name} from:\n  {}", gone.join("\n  ")) }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_setting_up_the_hub_touches_its_inyon_hub_impl_note() {
        assert!(hub_impl_follows(Role::Hub));
        assert!(!hub_impl_follows(Role::Link));
        assert!(!hub_impl_follows(Role::Node));
    }

    #[cfg(unix)]
    #[test]
    fn a_variable_that_is_not_utf8_does_not_stop_the_hub_commands() {
        use std::os::unix::ffi::OsStrExt;
        // SAFETY: a name nothing else reads
        unsafe { std::env::set_var("INYON_TEST_LATIN1", std::ffi::OsStr::from_bytes(b"caf\xe9")) };
        assert!(!hub_env().contains_key("INYON_TEST_LATIN1"));
    }

    #[test]
    fn private_addresses_may_use_plain_http() {
        for h in ["localhost", "127.0.0.1", "10.1.2.3", "192.168.0.4", "172.20.0.1", "100.100.1.1", "laptop.tail1234.ts.net", "box", "[fd7a:115c:a1e0::1]", "[::1]"] {
            assert!(is_private(h), "{h}");
        }
        for h in ["example.com", "8.8.8.8", "100.200.1.1", "172.32.0.1", "[2001:db8::1]"] {
            assert!(!is_private(h), "{h}");
        }
        // a public name that starts like a private address is still a public name
        for h in ["10.0.0.1.attacker.com", "127.0.0.1.evil.io", "192.168.1.5.example.com"] {
            assert!(!is_private(h), "{h}");
        }
        for h in ["10.0.0.1", "192.168.1.5", "100.64.0.1"] {
            assert!(is_private(h), "{h}");
        }
        assert!(check_hub_url("http://192.168.1.2:4777").is_ok());
        assert!(check_hub_url("https://hub.example.com").is_ok());
        assert!(check_hub_url("http://hub.example.com").unwrap_err().contains("plain http"));
        assert!(check_hub_url("hub.example.com").unwrap_err().contains("isn't a web address"));
    }

    #[test]
    fn the_pairing_code_is_drawn_from_the_engines_answer() {
        let v = json!({ "link": "inyon://pair?m=abc&s=secret&n=box", "qr": "https://inyon.abhashchakraborty.tech/#pair?m=abc&s=secret&n=box", "short": { "id": "K7Q4MX2T", "code": "493812" }, "urls": ["wss://a.example/link"], "relays": [], "service": true });
        let out = render_pair(&v);
        assert!(out.contains("Scan this with your phone's camera"));
        assert!(out.contains("    ID    K7Q4-MX2T\n    Code  493 812\n"));
        assert!(out.contains("Or paste this link into the app:\ninyon://pair?m=abc&s=secret&n=box\n"));
        assert!(out.contains('█') && out.contains('▄'));
        assert!(!out.contains("No address yet"));
        assert!(!out.contains("Keep this running"));
        // no short code when the relays didn't take it; no address yet; the link runs here
        let v = json!({ "link": "inyon://pair?m=abc", "qr": "https://x/#pair?m=abc", "urls": [], "relays": [], "service": false });
        let out = render_pair(&v);
        assert!(!out.contains("Type a code"));
        assert!(out.contains("No address yet"));
        assert!(out.ends_with("Keep this running so the phone can connect, or run `inyon service install` to keep it running in the background.\n"));
    }

    #[test]
    fn reach_advice_names_each_private_network() {
        let none = reach_advice(&[], 4777, "/h/.inyon/hub.env");
        assert!(none[0].contains("answers on this machine only"));
        let nets = vec![networks::Network { kind: networks::Kind::Tailscale, ip: "100.64.0.9".into(), name: Some("laptop.tail1.ts.net".into()) }];
        let lines = reach_advice(&nets, 4777, "/h/.inyon/hub.env");
        assert!(lines[1].contains("BIND=100.64.0.9"));
        assert!(lines[1].contains("http://laptop.tail1.ts.net:4777"));
    }

    #[test]
    fn flags_make_the_same_plan_as_the_screens() {
        let f = SetupFlags { yes: true, role: Some("hub".into()), network: Some("lan".into()), port: Some(8443), autostart: Some(false), hub: None };
        let p = plan_from_flags(Platform::Linux, Vec::new(), &f).unwrap();
        assert_eq!(p.role, RoleChoice::Hub);
        assert_eq!(p.bind, Bind::Lan);
        assert_eq!(p.port_number(), 8443);
        assert!(!p.autostart);
        let f = SetupFlags { yes: true, role: None, network: Some("tunnel,vpn,wss://me.example/link".into()), port: None, autostart: None, hub: None };
        let p = plan_from_flags(Platform::Linux, Vec::new(), &f).unwrap();
        assert!(p.tunnel && p.vpn && !p.lan);
        assert_eq!(p.own_url, "wss://me.example/link");
        let f = SetupFlags { yes: true, role: None, network: None, port: None, autostart: None, hub: Some("https://hub".into()) };
        assert_eq!(plan_from_flags(Platform::Linux, Vec::new(), &f).unwrap().role, RoleChoice::Join);
        let f = SetupFlags { yes: true, role: Some("join".into()), network: None, port: None, autostart: None, hub: None };
        assert!(plan_from_flags(Platform::Linux, Vec::new(), &f).is_err());
        let f = SetupFlags { yes: true, role: Some("hub".into()), network: None, port: None, autostart: None, hub: None };
        assert!(plan_from_flags(Platform::Windows, Vec::new(), &f).unwrap_err().contains("WSL"));
    }
}
