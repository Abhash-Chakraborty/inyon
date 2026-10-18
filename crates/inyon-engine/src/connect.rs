//! The hub connection: one outbound WebSocket to the hub, running what it asks for as this user.
//! (inyon.ts's connectMode, hubUrl, join and leave)

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::Message;
use url::Url;

use crate::output::{emit, error, fail, log, say};
use crate::paths::{self, env_var, node_dir, running_file, saved_env, Role};
use crate::{ops, VERSION, WIN};

/// Checks a hub address; refuses to send a token over plain http to a public address.
pub fn hub_url(hub: &str) -> Url {
    checked_hub(hub, env_var("INYON_ALLOW_INSECURE").is_some()).unwrap_or_else(|e| fail(&e, 2))
}

/// Whether the hub is reached with TLS: https and wss are, http and ws aren't.
fn secure(url: &Url) -> bool {
    matches!(url.scheme(), "https" | "wss")
}

fn checked_hub(hub: &str, insecure_ok: bool) -> Result<Url, String> {
    let url = Url::parse(hub).map_err(|_| format!("{hub} isn't a web address."))?;
    if !secure(&url) && !crate::hub::private_host(&url) && !insecure_ok {
        return Err(format!("Refusing to send the token over plain http to {}. Use https, or a private network address.", url.host_str().unwrap_or("")));
    }
    Ok(url)
}

/// The hub's WebSocket and its plain address for `/node`, from any of http, https, ws or wss.
fn node_urls(url: &Url) -> (String, String) {
    let host = host_of(url);
    let (ws, http) = if secure(url) { ("wss", "https") } else { ("ws", "http") };
    (format!("{ws}://{host}/node"), format!("{http}://{host}/node"))
}

/// `host[:port]` as `URL.host` gives it (no port when it's the scheme's own).
fn host_of(url: &Url) -> String {
    let host = url.host_str().unwrap_or("");
    match url.port() {
        Some(p) => format!("{host}:{p}"),
        None => host.to_string(),
    }
}

/// The connection to a hub. Never returns: it ends the process when the hub removes this machine
/// or rejects its token.
pub async fn connect_mode(hub_arg: Option<String>, token_arg: Option<String>) {
    // the installers keep the hub address and token in the node's folder (readable only by you), so
    // the token never sits in the process list where other users could read it
    let saved = saved_env();
    let hub = hub_arg.or_else(|| env_var("INYON_HUB")).or_else(|| saved.get("INYON_HUB").cloned()).unwrap_or_default().trim_end_matches('/').to_string();
    let token = token_arg.clone().or_else(|| env_var("INYON_TOKEN")).or_else(|| saved.get("INYON_TOKEN").cloned()).unwrap_or_default();
    if env_var("INYON_SH").is_none() {
        if let Some(sh) = saved.get("INYON_SH").filter(|s| !s.is_empty()) {
            paths::set_env("INYON_SH", sh);
        }
    }
    if hub.is_empty() || token.is_empty() {
        error(&crate::usage());
        std::process::exit(2);
    }
    if token_arg.is_some() {
        error("Note: a token given as an argument shows in the process list. Prefer INYON_TOKEN=<token> inyon join <hub-url>.");
    }
    let url = hub_url(&hub);
    let host = host_of(&url);
    let (ws_url, http_url) = node_urls(&url);
    // who's running, for `inyon update` and the hub's update script: they wait for this file to name
    // the new version, and stop the copy it names when there's no service manager
    if std::fs::create_dir_all(node_dir()).is_ok() {
        let _ = std::fs::write(running_file(Role::Node), json!({ "pid": std::process::id(), "version": VERSION }).to_string());
    }
    let bearer = format!("Bearer {token}");
    let mut attempt: u32 = 0;
    loop {
        let (code, opened) = session(&ws_url, &host, &bearer, &mut attempt).await;
        if code == 4001 || (!opened && removed_there(&http_url, &bearer).await) {
            leave(&format!("This machine was removed from {host}.")).await;
        }
        if code == 4003 {
            error("The hub rejected the token. Pair this machine again from the hub.");
            std::process::exit(1);
        }
        let delay = Duration::from_millis(30_000.min(1000u64 << attempt.min(15)));
        log(&format!("disconnected ({code}); retrying in {}s", (delay.as_millis() + 500) / 1000));
        tokio::time::sleep(delay).await;
        attempt += 1;
    }
}

/// One connection, from opening to closing: the close code, and whether it ever opened.
async fn session(ws_url: &str, host: &str, bearer: &str, attempt: &mut u32) -> (u16, bool) {
    let socket = match crate::ws::connect(ws_url, &[("authorization", bearer)]).await {
        Ok(s) => s,
        Err((code, _)) => return (code, false),
    };
    *attempt = 0;
    log(&format!("connected to {host}"));
    let (mut write, mut read) = socket.split();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Message>();
    let send: ops::Sender = {
        let tx = tx.clone();
        Arc::new(move |m: Value| {
            let _ = tx.send(Message::Text(m.to_string().into()));
        })
    };
    let ops = ops::Ops::new(send.clone());
    send(
        json!({ "type": "hello", "version": VERSION, "os": format!("{} {}", crate::platform(), crate::arch()), "hostname": crate::hostname(), "platform": crate::platform(), "mux": if WIN { "psmux" } else { "tmux" } }),
    );
    let writer = tokio::spawn(async move {
        while let Some(m) = rx.recv().await {
            if write.send(m).await.is_err() {
                break;
            }
        }
        let _ = write.close().await;
    });
    let mut code = 1006;
    while let Some(next) = read.next().await {
        match next {
            Ok(Message::Text(t)) => {
                if let Ok(m) = serde_json::from_str::<Value>(t.as_str()) {
                    ops.message(m);
                }
            }
            Ok(Message::Binary(b)) => {
                if let Ok(m) = serde_json::from_slice::<Value>(&b) {
                    ops.message(m);
                }
            }
            Ok(Message::Close(frame)) => {
                code = frame.map(|f| u16::from(f.code)).unwrap_or(1005);
                break;
            }
            Ok(_) => {}
            Err(_) => break,
        }
    }
    ops.close();
    drop(tx);
    drop(ops);
    drop(send);
    writer.abort();
    (code, true)
}

/// A hub answers 410 to a machine removed while it was off (a token it never knew gets 403).
async fn removed_there(target: &str, bearer: &str) -> bool {
    crate::http::fetch("GET", target.to_string(), vec![("authorization".into(), bearer.to_string())], None, Duration::from_secs(30)).await.is_ok_and(|r| r.status == 410)
}

/// The hub removed this machine. `inyon disconnect` takes the background service down and forgets
/// the hub, so nothing starts this again and calls the hub for ever. It runs in a session of its
/// own: stopping the service may stop everything started from this process.
async fn leave(why: &str) -> ! {
    log(&format!("{why} Removing the background service."));
    let Some(cli) = paths::inyon_command() else {
        for name in ["env", ".env"] {
            let _ = std::fs::remove_file(node_dir().join(name));
        }
        std::process::exit(0)
    };
    let mut c = tokio::process::Command::new(cli);
    c.arg("disconnect");
    ops::hide_window(&mut c);
    #[cfg(unix)]
    // SAFETY: setsid is async-signal-safe and touches nothing but the child
    unsafe {
        c.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    if let Ok(mut child) = c.spawn() {
        let _ = child.wait().await;
    }
    std::process::exit(0)
}

/// `join <hub-url>`: saves the hub and token (readable only by you) in the node's folder, where
/// `connect` reads them. The inyon command's own `join` writes the same file and then sets up the
/// background service; this one is for starting the connection by hand.
pub fn join(hub_arg: Option<&str>) {
    let hub = hub_arg.unwrap_or("").trim_end_matches('/').to_string();
    let token = env_var("INYON_TOKEN").unwrap_or_default();
    if hub.is_empty() || token.is_empty() {
        fail("usage: INYON_TOKEN=<token> inyon-engine join <hub-url>", 2);
    }
    let url = hub_url(&hub);
    if let Err(e) = ops::ensure_shell() {
        say(&format!("! {e}"));
    }
    let dir = node_dir();
    let _ = std::fs::create_dir_all(&dir);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    }
    let mut lines = vec![format!("INYON_HUB={hub}"), format!("INYON_TOKEN={token}")];
    if WIN {
        if let Some(sh) = env_var("INYON_SH") {
            lines.push(format!("INYON_SH={sh}"));
        }
    }
    let file: PathBuf = dir.join(if WIN { ".env" } else { "env" });
    if let Err(e) = write_private(&file, format!("{}\n", lines.join("\n")).as_bytes()) {
        fail(&e.to_string(), 1);
    }
    // the other file name may hold a token from an earlier pairing
    let _ = std::fs::remove_file(dir.join(if WIN { "env" } else { ".env" }));
    if WIN {
        let user = std::env::var("USERNAME").unwrap_or_default();
        let mut c = std::process::Command::new("icacls");
        c.arg(&file).args(["/inheritance:r", "/grant:r", &format!("{user}:(R,W)"), "SYSTEM:(F)"]).stdout(Stdio::null()).stderr(Stdio::null());
        ops::hide_window_std(&mut c);
        let _ = c.status();
    }
    emit(json!({ "hub": hub }), Some(&format!("Saved the hub {}. Run `inyon connect` to connect, or `inyon service install node` to connect in the background.", host_of(&url))));
}

/// A file only this user can read (mode 0600 from the start on Unix).
pub fn write_private(file: &std::path::Path, data: &[u8]) -> std::io::Result<()> {
    let mut o = std::fs::OpenOptions::new();
    o.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(0o600);
    }
    use std::io::Write;
    o.open(file)?.write_all(data)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_ws_address_is_plain_and_a_wss_one_is_tls_like_http_and_https() {
        let urls = |h: &str| node_urls(&checked_hub(h, false).unwrap());
        assert_eq!(urls("https://hub.example.com"), ("wss://hub.example.com/node".into(), "https://hub.example.com/node".into()));
        assert_eq!(urls("wss://hub.example.com"), ("wss://hub.example.com/node".into(), "https://hub.example.com/node".into()));
        assert_eq!(urls("ws://100.64.1.2:4777"), ("ws://100.64.1.2:4777/node".into(), "http://100.64.1.2:4777/node".into()));
        // plain ws to a public address carries the token in the clear, as http would
        for plain in ["http://hub.example.com", "ws://hub.example.com"] {
            assert!(checked_hub(plain, false).unwrap_err().starts_with("Refusing to send the token over plain http"), "{plain}");
            assert!(checked_hub(plain, true).is_ok());
        }
    }
}
