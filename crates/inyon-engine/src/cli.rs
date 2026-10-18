//! The engine's commands, as inyon-engine answered them (inyon.ts). The `inyon` command runs them
//! in-process; a program started under the engine's name (`inyon-engine`, which old commands,
//! services and the Windows sign-in task run) answers them the same way. Only `hub` isn't here:
//! the caller hands it to the Bun engine.
//!
//!   pair [options]      make a pairing code (starts the link here if none runs)
//!   link [options]      run the phone link
//!   phones              list paired phones
//!   forget <name|key>   unpair a phone
//!   push …              the browsers this machine sends notifications to
//!   join <hub-url>      save a hub's address and the token in INYON_TOKEN
//!   connect             run the connection to that hub
//!   version             print the version
//!   hidden <program> …  run a program with no window and wait for it

use std::io::IsTerminal;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use inyon_link::PairInfo;
use serde_json::{json, Value};

use crate::link::{self, LinkConfig};
use crate::output::{emit, fail, log, pair_result, say, PairOutput};
use crate::paths::{self, env_var, node_dir, Role};
use crate::{ops, push, tidy, usage, INSTALL_URL, VERSION, WEB_URL, WIN};

static BACKGROUND: AtomicBool = AtomicBool::new(false);

/// Run in the background (a service, the sign-in task) there's no console to print to, so log
/// lines go to a file. Commands people run (pair, phones…) always print, even from a script, so
/// the pairing code shows, and so does what the inyon command runs in a terminal (it sets
/// INYON_CONSOLE).
pub fn background() -> bool {
    BACKGROUND.load(Ordering::Relaxed)
}

const INTERACTIVE: [&str; 11] = ["pair", "join", "phones", "forget", "push", "update", "version", "--version", "help", "--help", "-h"];

/// Notes whether this runs in the background on Windows, and sends the log there if so.
pub fn setup_background(first: Option<&str>) {
    let bg = WIN && !std::io::stdout().is_terminal() && env_var("INYON_CONSOLE").is_none() && !first.is_some_and(|f| INTERACTIVE.contains(&f));
    BACKGROUND.store(bg, Ordering::Relaxed);
    if bg {
        crate::output::log_to(paths::log_file(if first == Some("link") { Role::Link } else { Role::Node }));
    }
}

/// Ends the process the way the Bun engine did on a signal: what it started stops with it.
pub fn shutdown(code: i32) -> ! {
    link::stop_children();
    ops::kill_everything();
    std::process::exit(code)
}

/// Stops what this process started when it's told to stop (Ctrl-C, a service stopping).
fn on_signals() {
    tokio::spawn(async {
        #[cfg(unix)]
        {
            use tokio::signal::unix::{signal, SignalKind};
            let (Ok(mut int), Ok(mut term), Ok(mut hup)) = (signal(SignalKind::interrupt()), signal(SignalKind::terminate()), signal(SignalKind::hangup())) else { return };
            tokio::select! {
                _ = int.recv() => {}
                _ = term.recv() => {}
                _ = hup.recv() => {}
            }
        }
        #[cfg(not(unix))]
        {
            let _ = tokio::signal::ctrl_c().await;
        }
        shutdown(0);
    });
}

/// The Inyon icon in the Windows notification area while this runs in the background, so you can
/// see it runs and reach it without a terminal. The inyon command draws it and removes it once this
/// process has gone.
fn show_tray(role: &str) {
    let Some(cli) = paths::inyon_command() else { return };
    if !background() {
        return;
    }
    let mut c = std::process::Command::new(cli);
    c.args(["tray", role, "--pid", &std::process::id().to_string()]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    ops::hide_window_std(&mut c);
    if let Err(e) = c.spawn() {
        log(&format!("! no tray icon: {e}"));
    }
}

/// Reads link options; what you pass is saved, so the service keeps them on its next start.
pub fn link_options(args: &[String]) -> LinkConfig {
    let mut c = link::load_config();
    let (mut urls_given, mut relays_given) = (false, false);
    let mut i = 0;
    while i < args.len() {
        let a = args[i].as_str();
        let next = args.get(i + 1).filter(|n| !n.is_empty());
        match a {
            "--lan" | "--no-lan" => c.lan = a == "--lan",
            "--vpn" | "--no-vpn" => c.vpn = a == "--vpn",
            "--url" if next.is_some() => {
                i += 1;
                let u = &args[i];
                let ok = (u.starts_with("ws://") || u.starts_with("wss://")) && u.ends_with("/link") && {
                    let rest = u.split_once("://").map(|(_, r)| r).unwrap_or("");
                    let host = &rest[..rest.len() - "/link".len()];
                    !host.is_empty() && !host.contains('/')
                };
                if !ok {
                    fail(&format!("--url needs a WebSocket address ending in /link, like wss://laptop.tail1234.ts.net:8443/link, not {u}"), 2);
                }
                if !urls_given {
                    c.urls.clear();
                }
                urls_given = true;
                c.urls.push(u.clone());
            }
            "--no-url" => c.urls.clear(),
            "--tunnel" | "--no-tunnel" => c.tunnel = a == "--tunnel",
            "--port" if next.is_some_and(|n| n.bytes().all(|b| b.is_ascii_digit())) && next.and_then(|n| n.parse::<u16>().ok()).is_some() => {
                i += 1;
                c.port = args[i].parse().unwrap_or(4780);
            }
            "--relay" if next.is_some() => {
                i += 1;
                let r = args[i].trim_end_matches('/').to_string();
                if !(r.starts_with("http://") || r.starts_with("https://")) {
                    fail(&format!("--relay needs an http(s) address, not {r}"), 2);
                }
                if !relays_given {
                    c.relays.clear();
                }
                relays_given = true;
                c.relays.push(r);
            }
            "--no-relay" => c.relays.clear(),
            _ => fail(&format!("unknown option {a}"), 2),
        }
        i += 1;
    }
    link::save_config(&c);
    c
}

/// What `pair` found: its answer (as `pair --json` prints it), and whether a link runs elsewhere,
/// so this process has nothing left to do once the code is shown.
pub struct Paired {
    pub answer: Value,
    pub service: bool,
}

/// Makes a pairing code; starts the link here first if it isn't running yet. Prints nothing.
pub async fn make_pairing(args: &[String]) -> Paired {
    let config = link_options(args);
    let service = link::link_running(Some(config.port)).await;
    if !service {
        if let Err(e) = link::start_link(config.clone()) {
            fail(&e, 1);
        }
        tidy::start_tidying(paths::home());
    }
    let pairing = link::new_pairing().unwrap_or_else(|e| fail(&e, 1));
    // wait for an address the phone can use (the tunnel takes a few seconds to come up). A private
    // network's ws:// address comes first, but browsers only open wss://, so wait for the tunnel too
    let wanted = config.tunnel || config.lan || config.vpn || !config.urls.is_empty() || !config.relays.is_empty();
    let enough = |s: &link::State| !s.relays.is_empty() || if config.tunnel { s.urls.iter().any(|u| u.starts_with("wss://")) } else { !s.urls.is_empty() };
    for _ in 0..60 {
        if !wanted {
            break;
        }
        if let Some(s) = link::current_state() {
            if enough(&s) && (service || s.pid == std::process::id()) {
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    let s = link::current_state();
    let (urls, relays) = s.map(|s| (s.urls, s.relays)).unwrap_or_default();
    let id = link::identity().id;
    let info = PairInfo { id: id.clone(), secret: pairing.secret.clone(), name: crate::hostname(), urls: urls.clone(), relays: relays.clone() };
    let link_text = inyon_link::pair_link(&info, None);
    // the QR code opens the web app when scanned with a phone's camera; the Inyon app reads it too.
    // INYON_WEB_URL points it at a copy of the web app you host yourself
    let web = env_var("INYON_WEB_URL").unwrap_or_else(|| WEB_URL.into());
    let qr = inyon_link::pair_link(&info, Some(&web));
    // the typed-in code needs the relays to know this ID; without them there's still the QR code
    let typed = tokio::time::timeout(Duration::from_secs(8), link::publish_short_code(&pairing.short, &id, &crate::hostname(), &urls, &relays)).await.is_ok_and(|r| r.is_ok());
    let out = PairOutput { link: link_text, qr, short: Some((pairing.short.id.clone(), pairing.short.code.clone())), urls, relays, service };
    Paired { answer: pair_result(&out, typed), service }
}

/// `pair`: shows the code the way the Bun engine printed it. True when the link runs elsewhere.
async fn pair(args: &[String]) -> bool {
    let p = make_pairing(args).await;
    let a = &p.answer;
    let text = |k: &str| a.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    say("\nScan this with your phone's camera, or in the Inyon app (Add a computer → Scan the code), within 10 minutes:\n");
    say(&crate::qr::render(&text("qr")).unwrap_or_else(|e| format!("(no QR code: {e})")));
    if let Some(short) = a.get("short") {
        let id = short.get("id").and_then(Value::as_str).unwrap_or("");
        let code = short.get("code").and_then(Value::as_str).unwrap_or("");
        let (c1, c2) = code.split_at(code.len().min(3));
        say(&format!("\nCan't scan it? Choose \"Type a code\" in the app and enter\n\n    ID    {}\n    Code  {c1} {c2}\n", inyon_link::format_short_id(id)));
    }
    say(&format!("\nOr paste this link into the app:\n{}\n", text("link")));
    let none = |k: &str| a.get(k).and_then(Value::as_array).is_none_or(|l| l.is_empty());
    if none("urls") && none("relays") {
        say("No address yet: the phone will look this machine up once its tunnel is up.\n");
    }
    emit(a.clone(), None);
    if p.service {
        return true;
    }
    say("Keep this running so the phone can connect, or run `inyon service install` to keep it running in the background.");
    false
}

fn phones() {
    let all = link::list_phones().0;
    let list: Vec<Value> = all
        .iter()
        .map(|(key, p)| {
            let mut v = json!({ "key": key, "name": p.name, "pairedAt": p.paired_at });
            if let Some(seen) = &p.last_seen {
                v["lastSeen"] = json!(seen);
            }
            v
        })
        .collect();
    if all.is_empty() {
        return emit(json!({ "phones": list }), Some("No phones paired yet. Run `inyon pair`."));
    }
    let when = |n: &serde_json::Number| crate::iso(n.as_f64().unwrap_or(0.0) as u64);
    let lines: Vec<String> = all
        .iter()
        .map(|(key, p)| {
            let seen = p.last_seen.as_ref().map(|s| when(s)[..16].replace('T', " ")).unwrap_or_else(|| "never".into());
            format!("{} {}  paired {}, last seen {seen}", push::pad_end(&p.name, 24), &key[..key.len().min(12)], &when(&p.paired_at)[..10])
        })
        .collect();
    emit(json!({ "phones": list }), Some(&lines.join("\n")));
}

/// `forget <name|key>`: unpairs one phone. The answer is its key and name.
pub fn forget(which: Option<&str>) -> Result<(String, String), String> {
    let Some(which) = which.filter(|w| !w.is_empty()) else { return Err("usage: inyon forget <name|key>".into()) };
    let lower = which.to_lowercase();
    let matches: Vec<(String, link::Phone)> = link::list_phones().0.into_iter().filter(|(key, p)| key.starts_with(&lower) || p.name == which).collect();
    if matches.len() != 1 {
        return Err(if matches.is_empty() { format!("No paired phone matches \"{which}\"") } else { format!("\"{which}\" matches {} phones; use more of the key", matches.len()) });
    }
    let Some((key, phone)) = matches.into_iter().next() else { return Err(format!("No paired phone matches \"{which}\"")) };
    link::forget_phone(&key);
    Ok((key, phone.name))
}

/// `update`: the inyon command owns updates since 0.14, so this only hands the call on. It's still
/// answered because the app asks the program it knows: the hub runs "$INYON_EXE" update
/// --background on a machine, and INYON_EXE names the engine on older installs.
fn update_shim(args: &[String]) -> ! {
    if let Some(cli) = paths::inyon_command() {
        let mut c = std::process::Command::new(cli);
        c.arg("update").args(args);
        if crate::output::json() {
            c.arg("--json");
        }
        let code = c.status().map(|s| s.code().unwrap_or(1)).unwrap_or(1);
        std::process::exit(code);
    }
    let how = if WIN { format!("irm {INSTALL_URL}/get.ps1 | iex") } else { format!("curl -fsSL {INSTALL_URL}/get.sh | sh") };
    let message = format!("This copy of inyon can't update itself. Install the new version with: {how}");
    if std::fs::create_dir_all(node_dir()).is_ok() {
        let _ = std::fs::write(node_dir().join("update-status"), format!("failed: {message}\n"));
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(node_dir().join("update.log")) {
            let _ = writeln!(f, "{} failed: {message}", crate::iso_now());
        }
    }
    fail(&message, 1)
}

/// Runs for as long as the process does (the link, the hub connection).
async fn forever() -> ! {
    loop {
        tokio::time::sleep(Duration::from_secs(3600)).await;
    }
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().expect("couldn't start the async runtime")
}

/// Answers one engine command. `args` come without the program's name; `--json` may be anywhere.
/// `hub` goes to `hub`, which runs the Bun engine. Returns the exit code for commands that end.
pub fn run(args: &[String], hub: impl FnOnce(&[String]) -> i32) -> i32 {
    let argv = crate::output::take_json(args);
    let cmd = argv.first().map(String::as_str);
    let rest: Vec<String> = argv.iter().skip(1).cloned().collect();
    setup_background(cmd);
    let joined = paths::saved_hub().is_some();
    match cmd {
        Some("pair") => runtime().block_on(async {
            if let Err(e) = ops::ensure_shell() {
                fail(&e, 1);
            }
            on_signals();
            if pair(&rest).await {
                std::process::exit(0);
            }
            forever().await
        }),
        Some("link") => runtime().block_on(async {
            let config = link_options(&rest);
            if link::link_running(Some(config.port)).await {
                let pid = link::current_state().map(|s| s.pid).filter(|p| *p != 0);
                fail(&format!("The link is already running{}.", pid.map(|p| format!(" (pid {p})")).unwrap_or_else(|| format!(" on port {}", config.port))), 2);
            }
            if let Err(e) = ops::ensure_shell() {
                fail(&e, 1);
            }
            on_signals();
            if let Err(e) = link::start_link(config) {
                fail(&e, 1);
            }
            tidy::start_tidying(paths::home());
            show_tray("link");
            forever().await
        }),
        Some("join") => {
            crate::connect::join(rest.first().map(String::as_str));
            0
        }
        // tether-node's installers started the hub connection with no arguments
        Some("connect") | None if cmd.is_some() || joined => runtime().block_on(async {
            if let Err(e) = ops::ensure_shell() {
                log(&format!("! {e}"));
            }
            on_signals();
            tidy::start_tidying(paths::home());
            show_tray("node");
            crate::connect::connect_mode(rest.first().cloned(), None).await;
            0
        }),
        Some("hub") => hub(&rest),
        Some("update") => update_shim(&rest),
        // a program run with no window, which this one has none of on Windows either: the inyon
        // command's one-off update task starts `inyon update` through it
        Some("hidden") => {
            if rest.is_empty() {
                fail("usage: inyon-engine hidden <program> [arguments…]", 2);
            }
            let mut c = std::process::Command::new(&rest[0]);
            c.args(&rest[1..]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
            ops::hide_window_std(&mut c);
            match c.status() {
                Ok(s) => s.code().unwrap_or(1),
                Err(e) => fail(&e.to_string(), 1),
            }
        }
        Some("phones") => {
            phones();
            0
        }
        Some("forget") => match forget(rest.first().map(String::as_str)) {
            Ok((key, name)) => {
                emit(json!({ "forgotten": { "key": key, "name": name } }), Some(&format!("Forgot {name}. It can't connect until it pairs again.")));
                0
            }
            Err(e) => fail(&e, 2),
        },
        Some("push") => {
            runtime().block_on(push::push_command(&rest));
            0
        }
        Some("version" | "--version") => {
            emit(json!({ "version": VERSION, "engine": true }), Some(VERSION));
            0
        }
        Some("help" | "--help" | "-h") => {
            log(&usage());
            0
        }
        // the form tether-node's installers used: a hub address, with the token in the environment
        Some(url) if url.starts_with("http://") || url.starts_with("https://") => {
            let (url, token) = (url.to_string(), rest.first().cloned());
            runtime().block_on(async move {
                on_signals();
                tidy::start_tidying(paths::home());
                crate::connect::connect_mode(Some(url), token).await;
                0
            })
        }
        _ => fail(&usage(), 2),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_usage_names_every_command_and_the_version() {
        let u = usage();
        assert!(u.starts_with(&format!("inyon-engine {VERSION}: ")));
        for c in ["pair", "link", "phones", "forget", "push", "join", "connect", "hub", "version"] {
            assert!(u.contains(&format!("inyon-engine {c}")), "{c}");
        }
    }

    #[test]
    fn link_options_are_saved_for_the_service() {
        let _h = crate::paths::testing::home("cli-options");
        let s = |v: &[&str]| v.iter().map(|a| a.to_string()).collect::<Vec<_>>();
        let c = link_options(&s(&[
            "--no-tunnel",
            "--lan",
            "--port",
            "4791",
            "--url",
            "wss://a.example:8443/link",
            "--url",
            "ws://10.0.0.2:4780/link",
            "--relay",
            "https://relay.example/",
        ]));
        assert_eq!((c.tunnel, c.lan, c.port), (false, true, 4791));
        assert_eq!(c.urls, ["wss://a.example:8443/link", "ws://10.0.0.2:4780/link"]);
        assert_eq!(c.relays, ["https://relay.example"]);
        assert_eq!(link::load_config(), c);
        // a new --url replaces the saved ones; nothing given keeps them
        let c = link_options(&s(&["--url", "wss://b.example/link"]));
        assert_eq!(c.urls, ["wss://b.example/link"]);
        assert_eq!(link_options(&[]).urls, ["wss://b.example/link"]);
    }
}
