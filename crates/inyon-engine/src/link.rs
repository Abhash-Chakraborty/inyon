//! Lets the Inyon phone app reach this machine directly, with no hub. The phone pairs once by
//! scanning a code (`inyon pair`), then connects over an end-to-end encrypted link (Noise)
//! through whichever way works: a free Cloudflare quick tunnel this machine opens by itself (so
//! it works from any network), its address on a private network (Tailscale, NetBird, ZeroTier,
//! WireGuard), its LAN address, an address you publish yourself, or a relay you run. The tunnel and
//! the relay only ever carry ciphertext. The tunnel's address changes when it restarts, so the
//! machine publishes its current addresses under its own key (pkarr) and the phone looks them up.
//! (link.ts)

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use base64::engine::general_purpose::{STANDARD as B64, URL_SAFE_NO_PAD};
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use inyon_link::{Identity, LinkError, Record, ShortCode};
use regex::Regex;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tokio::io::AsyncReadExt;
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::{CloseFrame, WebSocketConfig};
use tokio_tungstenite::tungstenite::Message;

use crate::networks::detect_networks;
use crate::ops::{self, sha256_hex, which};
use crate::output::{error, log};
use crate::paths::{bin_dir, node_dir};
use crate::{VERSION, WIN};

/// How long a pairing code works.
pub const PAIR_MINUTES: u64 = 10;

fn file(name: &str) -> PathBuf {
    node_dir().join(name)
}

/// A file in the node's folder, or None when it's missing or not what was expected.
pub fn read_node_json<T: DeserializeOwned>(name: &str) -> Option<T> {
    serde_json::from_str(&std::fs::read_to_string(file(name)).ok()?).ok()
}

/// `JSON.stringify(value, null, 2)`, which every file in the node's folder is written as.
pub fn pretty(value: &impl Serialize) -> String {
    serde_json::to_string_pretty(value).unwrap_or_else(|_| "null".into())
}

/// Held around every read, change and write of a file in the node's folder. Phone sessions,
/// relays and the publisher run on several threads at once, and the phone tries every address
/// together, so without it two writers would lose each other's change: a guess not counted, a
/// forgotten phone back, a new pairing gone.
static NODE_FILES: Mutex<()> = Mutex::new(());

pub fn node_files() -> std::sync::MutexGuard<'static, ()> {
    NODE_FILES.lock().unwrap_or_else(|e| e.into_inner())
}

/// Each write gets a temporary file of its own, so two threads never rename each other's.
static TMP: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Written whole or not at all, readable only by this user (it holds keys and pairings). A file
/// that couldn't be saved is an error the caller acts on, as the Bun engine's throw was.
pub fn write_node_json(name: &str, value: &impl Serialize) -> Result<(), String> {
    let dir = node_dir();
    if !dir.exists() {
        let _ = std::fs::create_dir_all(&dir);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
        }
    }
    let target = file(name);
    let n = TMP.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp = PathBuf::from(format!("{}.{}.{n}.tmp", target.to_string_lossy(), std::process::id()));
    let saved = crate::connect::write_private(&tmp, pretty(value).as_bytes()).and_then(|()| std::fs::rename(&tmp, &target));
    saved.map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("couldn't save {name}: {e}")
    })
}

/// For files whose loss only costs a moment (the state the link shows, addresses, settings):
/// said in the log, and the work goes on.
fn save_or_say(name: &str, value: &impl Serialize) {
    if let Err(e) = write_node_json(name, value) {
        error(&e);
    }
}

/// How the link runs; what you pass to `link` or `pair` is saved in link.json, so the service
/// keeps it on its next start.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct LinkConfig {
    /// relays to keep a connection to, like https://relay.example.com
    pub relays: Vec<String>,
    /// open a Cloudflare quick tunnel so phones on any network can connect
    pub tunnel: bool,
    /// also listen on this machine's LAN addresses (otherwise only the tunnel and relays reach it)
    pub lan: bool,
    /// also listen on its private network addresses (Tailscale, NetBird, ZeroTier, WireGuard). Only
    /// devices the network lets in reach them. Off on Windows, where listening there asks the
    /// firewall each time.
    pub vpn: bool,
    /// addresses of your own to publish, like wss://laptop.tail1234.ts.net:8443/link
    pub urls: Vec<String>,
    pub port: u16,
    /// whatever else the file holds stays in it
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Default for LinkConfig {
    fn default() -> Self {
        LinkConfig { relays: Vec::new(), tunnel: true, lan: false, vpn: !WIN, urls: Vec::new(), port: 4780, extra: Map::new() }
    }
}

pub fn load_config() -> LinkConfig {
    read_node_json("link.json").unwrap_or_default()
}

pub fn save_config(c: &LinkConfig) {
    let _files = node_files();
    save_or_say("link.json", c)
}

/// This machine's identity, made on first use. Its id is what the phone pairs with.
pub fn identity() -> Identity {
    let _files = node_files();
    let saved: Option<Value> = read_node_json("identity.json");
    if let Some(seed) = saved.as_ref().and_then(|s| s.get("seed")).and_then(Value::as_str).filter(|s| !s.is_empty()) {
        let mut bytes = [0u8; 32];
        for (i, b) in bytes.iter_mut().enumerate() {
            *b = seed.get(i * 2..i * 2 + 2).and_then(|h| u8::from_str_radix(h, 16).ok()).unwrap_or(0);
        }
        return Identity::from_seed(bytes);
    }
    let id = Identity::generate().expect("the system has no randomness to give");
    let seed: String = id.seed.iter().map(|b| format!("{b:02x}")).collect();
    // an identity that isn't kept would be a new computer to every paired phone next time
    if let Err(e) = write_node_json("identity.json", &json!({ "seed": seed, "id": id.id })) {
        crate::output::fail(&e, 1);
    }
    id
}

/// A paired phone as phones.json keeps it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Phone {
    pub name: String,
    #[serde(rename = "pairedAt")]
    pub paired_at: serde_json::Number,
    #[serde(rename = "lastSeen", default, skip_serializing_if = "Option::is_none")]
    pub last_seen: Option<serde_json::Number>,
}

fn phones_raw() -> Map<String, Value> {
    match read_node_json::<Value>("phones.json") {
        Some(Value::Object(m)) => m,
        _ => Map::new(),
    }
}

/// The phone's model without the build number Android's browser adds ("A142 Build/BP2A.250605" is "A142").
pub fn phone_name(raw: Option<&Value>) -> String {
    let s = match raw {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(v) => v.to_string(),
    };
    let first = s.split(" Build/").next().unwrap_or("").trim();
    let mut units = 0;
    let name: String = first
        .chars()
        .take_while(|c| {
            units += c.len_utf16();
            units <= 64
        })
        .collect();
    if name.is_empty() {
        "Phone".into()
    } else {
        name
    }
}

/// Paired phones by key, in the order they paired.
#[derive(Debug, Clone, Default)]
pub struct Phones(pub Vec<(String, Phone)>);

impl Phones {
    pub fn get(&self, key: &str) -> Option<&Phone> {
        self.0.iter().find(|(k, _)| k == key).map(|(_, p)| p)
    }

    pub fn contains_key(&self, key: &str) -> bool {
        self.get(key).is_some()
    }
}

/// Phones paired before names were cleaned may still carry the build number.
pub fn list_phones() -> Phones {
    Phones(
        phones_raw()
            .into_iter()
            .filter_map(|(k, v)| {
                let mut p: Phone =
                    serde_json::from_value(v.clone()).ok().or_else(|| Some(Phone { name: String::new(), paired_at: v.get("pairedAt")?.as_number()?.clone(), last_seen: None }))?;
                p.name = phone_name(v.get("name"));
                Some((k, p))
            })
            .collect(),
    )
}

/// The pairing in progress: a long secret for the QR code, a short ID and code for typing in.
pub struct Pairing {
    pub secret: String,
    pub short: ShortCode,
}

/// Starts a pairing, good for a few minutes.
pub fn new_pairing() -> Result<Pairing, String> {
    let secret = URL_SAFE_NO_PAD.encode(crate::random_bytes(24));
    let short = inyon_link::new_short_code().expect("the system has no randomness to give");
    let _files = node_files();
    write_node_json("pairing.json", &json!({ "secret": secret, "short": inyon_link::short_secret(&short), "expires": crate::now_ms() + PAIR_MINUTES * 60_000 }))?;
    Ok(Pairing { secret, short })
}

/// The secret of the pairing that's open, if one is (a phone that pairs with it ends it).
pub fn pairing_secret() -> Option<String> {
    read_node_json::<Value>("pairing.json")?.get("secret")?.as_str().map(String::from)
}

/// What the running link last wrote: its addresses, pid and version.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct State {
    #[serde(default)]
    pub urls: Vec<String>,
    #[serde(default)]
    pub relays: Vec<String>,
    #[serde(rename = "updatedAt", default)]
    pub updated_at: u64,
    #[serde(default)]
    pub pid: u32,
    /// missing from links before `tether-node update` existed
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// the seq of the last address record published, so the next is newer even if the clock went back
    #[serde(rename = "lastSeq", default, skip_serializing_if = "Option::is_none")]
    pub last_seq: Option<u64>,
}

pub fn current_state() -> Option<State> {
    read_node_json("state.json")
}

/// A process that has exited but wasn't collected yet (in a container whose first process doesn't
/// collect them, say) still answers kill(pid, 0). Linux shows it as Z.
pub fn exited(pid: u32) -> bool {
    let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else { return false };
    // "<pid> (<name>) Z …": the name can hold spaces and parentheses, so look after the last ")"
    stat.rfind(") ").is_some_and(|at| stat[at + 2..].starts_with('Z')) && stat.starts_with(&format!("{pid} ("))
}

/// Whether a process with this pid runs and is ours to signal (kill(pid, 0) as Node does it). A
/// pid owned by someone else (EPERM) counts as gone, as Node's throw did: a stale pid that now
/// belongs to root mustn't keep the link from starting; the port check after it still sees a link.
pub fn alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        // SAFETY: signal 0 only checks that the process exists
        unsafe { libc::kill(pid as i32, 0) == 0 }
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
        use windows_sys::Win32::System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
        // SAFETY: a handle opened here and closed before returning
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if h.is_null() {
                return false;
            }
            let mut code = 0u32;
            let ok = GetExitCodeProcess(h, &mut code) != 0 && code == STILL_ACTIVE as u32;
            CloseHandle(h);
            ok
        }
    }
}

/// Whether a link other than this process runs: the pid state.json names is still alive, or
/// something answers on the link's port the way a link does. The pid alone isn't enough: a link
/// that ended with the terminal it was started in leaves its pid behind, and a pid check doesn't
/// see every process on every platform. A second link on the same computer would publish an
/// address of its own and leave the phone pointing at it once it ends, so this errs towards "yes".
pub async fn link_running(port: Option<u16>) -> bool {
    if let Some(pid) = current_state().map(|s| s.pid).filter(|p| *p != 0 && *p != std::process::id()) {
        if alive(pid) && !exited(pid) {
            return true;
        }
    }
    let Some(port) = port else { return false };
    match crate::http::fetch("GET", format!("http://127.0.0.1:{port}/"), Vec::new(), None, Duration::from_millis(700)).await {
        Ok(r) => r.ok() && String::from_utf8_lossy(&r.body).trim() == "inyon",
        Err(_) => false,
    }
}

pub fn forget_phone(key: &str) {
    {
        let _files = node_files();
        let mut all = phones_raw();
        all.shift_remove(key);
        save_or_say("phones.json", &Value::Object(all));
    }
    end_sessions(key);
    crate::push::forget_pushes(key);
}

// ---------- sessions ----------

/// Open phone sessions by the phone's key, so forgetting a phone also ends what it has open.
type Ends = HashMap<String, Vec<(u64, Arc<tokio::sync::Notify>)>>;
static ACTIVE: Mutex<Option<Ends>> = Mutex::new(None);
static NEXT_SESSION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
static PHONES_STAMP: Mutex<Option<Option<std::time::SystemTime>>> = Mutex::new(None);

fn end_sessions(key: &str) {
    let ends = ACTIVE.lock().unwrap_or_else(|e| e.into_inner()).as_mut().and_then(|a| a.remove(key));
    for (_, end) in ends.unwrap_or_default() {
        end.notify_one();
    }
}

/// `inyon forget` runs as a process of its own: notice phones.json changing and drop who's gone.
fn drop_forgotten() {
    let stamp = std::fs::metadata(file("phones.json")).and_then(|m| m.modified()).ok();
    {
        let mut last = PHONES_STAMP.lock().unwrap_or_else(|e| e.into_inner());
        if last.as_ref() == Some(&stamp) {
            return;
        }
        *last = Some(stamp);
    }
    let all = phones_raw();
    let keys: Vec<String> = ACTIVE.lock().unwrap_or_else(|e| e.into_inner()).as_ref().map(|a| a.keys().cloned().collect()).unwrap_or_default();
    for key in keys {
        if !all.contains_key(&key) {
            end_sessions(&key);
        }
    }
}

/// Everything a phone session can do once it's in.
fn welcome() -> Value {
    let s = current_state();
    json!({
        "ok": true,
        "version": VERSION,
        "hostname": crate::hostname(),
        "os": format!("{} {}", crate::platform(), crate::arch()),
        "platform": crate::platform(),
        "mux": if WIN { "psmux" } else { "tmux" },
        "urls": s.as_ref().map(|s| s.urls.clone()).unwrap_or_default(),
        "relays": s.map(|s| s.relays).unwrap_or_default(),
    })
}

fn same_text(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// A short code is a 1-in-a-million guess, so it's dropped after this many wrong ones.
const SHORT_TRIES: u64 = 5;

/// Who may come in: a phone paired before, or one bringing the secret from the code on screen.
pub fn check(remote_static: &[u8; 32], hello: &Value) -> Result<Value, LinkError> {
    let key: String = remote_static.iter().map(|b| format!("{b:02x}")).collect();
    let _files = node_files();
    let mut all = phones_raw();
    let now = crate::now_ms();
    if let Some(Value::Object(p)) = all.get_mut(&key) {
        p.insert("lastSeen".into(), json!(now));
        save_or_say("phones.json", &Value::Object(all));
        return Ok(welcome());
    }
    let host = crate::hostname();
    let mut pairing = match read_node_json::<Value>("pairing.json") {
        Some(Value::Object(m)) => m,
        _ => Map::new(),
    };
    let live = pairing.get("expires").and_then(Value::as_f64).unwrap_or(0.0) > now as f64;
    let pair = hello.get("pair").and_then(Value::as_str).filter(|p| !p.is_empty());
    let matches = |want: Option<&Value>| match (want.and_then(Value::as_str).filter(|w| !w.is_empty()), pair) {
        (Some(w), Some(p)) => same_text(p, w),
        _ => false,
    };
    if pair.is_some() && live && (matches(pairing.get("secret")) || matches(pairing.get("short"))) {
        let name = phone_name(hello.get("name"));
        all.insert(key, json!({ "name": name, "pairedAt": now, "lastSeen": now }));
        // not saved, not paired: the phone is told, and the code stays good for another try
        if let Err(e) = write_node_json("phones.json", &Value::Object(all)) {
            error(&e);
            return Err(LinkError::Refused(format!("{host} couldn't save the pairing ({e}). Check the space and permissions of ~/.inyon/node, then try again.")));
        }
        // one code, one phone
        let _ = std::fs::remove_file(file("pairing.json"));
        log(&format!("paired with {name}"));
        return Ok(welcome());
    }
    let has_short = pairing.get("short").and_then(Value::as_str).is_some_and(|s| !s.is_empty());
    if pair.is_some() && live && has_short {
        // a wrong code: count it, and stop taking short codes before guessing could pay off
        let failures = pairing.get("failures").and_then(Value::as_u64).unwrap_or(0) + 1;
        if failures >= SHORT_TRIES {
            pairing.shift_remove("short");
        }
        pairing.insert("failures".into(), json!(failures));
        // a guess that can't be counted mustn't be free: the code stops working
        if let Err(e) = write_node_json("pairing.json", &Value::Object(pairing)) {
            error(&e);
            let _ = std::fs::remove_file(file("pairing.json"));
        }
        if failures >= SHORT_TRIES {
            return Err(LinkError::NotPaired(format!("Too many wrong codes, so that one no longer works. Run `inyon pair` on {host} for a new one.")));
        }
        return Err(LinkError::NotPaired(format!("That code doesn't match. Check it against the one on {host} and try again.")));
    }
    if pair.is_some() {
        return Err(LinkError::NotPaired(format!("That pairing code has expired or was already used. Run `inyon pair` on {host} for a new one.")));
    }
    Err(LinkError::NotPaired(format!("This phone isn't paired with {host} any more. Run `inyon pair` there and scan the code again.")))
}

/// What comes in over a wire: one binary message, or its end.
pub enum WireIn {
    Data(Vec<u8>),
    Closed(u16, String),
}

/// What goes out over a wire: a WebSocket straight to the machine, or a session through a relay.
pub trait WireOut: Send + Sync {
    fn send(&self, data: Vec<u8>);
    fn close(&self, code: u16, reason: &str);
}

/// What a session answers with: each message sealed and queued in one go. Every sealed frame
/// takes the next Noise nonce, so the frames must reach the wire in the order they were sealed;
/// they're queued while the channel is still held, or two senders (a terminal's output, a
/// command's result, a pong) could swap them and the phone would drop the connection.
fn sealing_sender(channel: Arc<Mutex<inyon_link::Channel>>, out: Arc<dyn WireOut>, open: Arc<std::sync::atomic::AtomicBool>) -> ops::Sender {
    Arc::new(move |m: Value| {
        if !open.load(std::sync::atomic::Ordering::Relaxed) {
            return;
        }
        let mut channel = channel.lock().unwrap_or_else(|e| e.into_inner());
        for f in channel.seal(m.to_string().as_bytes()).unwrap_or_default() {
            out.send(f);
        }
    })
}

/// One phone session: the encrypted handshake, then the same commands the hub sends.
pub async fn session(id: Arc<Identity>, mut rx: mpsc::UnboundedReceiver<WireIn>, out: Arc<dyn WireOut>, via: String) {
    let first = match tokio::time::timeout(Duration::from_millis(inyon_link::channel::HANDSHAKE_MS), rx.recv()).await {
        Ok(Some(WireIn::Data(d))) => d,
        Ok(_) => return,
        Err(_) => return out.close(4408, "handshake timeout"),
    };
    let accepting = match inyon_link::accept(&id.noise, &first) {
        Ok(a) => a,
        Err(e) => {
            out.close(4401, "bad handshake");
            return log(&format!("refused a connection via {via}: {e}"));
        }
    };
    let hello: Value = match serde_json::from_slice(accepting.hello()) {
        Ok(h) => h,
        Err(e) => {
            out.close(4401, "bad handshake");
            return log(&format!("refused a connection via {via}: {e}"));
        }
    };
    let remote = *accepting.remote_static();
    let welcome = match check(&remote, &hello) {
        Ok(w) => w,
        Err(e) => {
            if let Ok(msg) = accepting.refuse(&e) {
                out.send(msg);
            }
            let out = out.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(200)).await;
                out.close(4403, "refused");
            });
            return;
        }
    };
    let Ok((channel, msg2)) = accepting.welcome(welcome.to_string().as_bytes()) else { return out.close(4401, "bad handshake") };
    out.send(msg2);
    let key: String = remote.iter().map(|b| format!("{b:02x}")).collect();
    // forgotten while the handshake finished
    if !phones_raw().contains_key(&key) {
        return out.close(4403, "unpaired");
    }
    let channel = Arc::new(Mutex::new(channel));
    let open = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let send = sealing_sender(channel.clone(), out.clone(), open.clone());
    let ops = ops::Ops::new(send.clone());
    let end = Arc::new(tokio::sync::Notify::new());
    let me = NEXT_SESSION.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    ACTIVE.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert_with(HashMap::new).entry(key.clone()).or_default().push((me, end.clone()));
    // a stream can run with nothing coming in, so check now and then too, not only per message
    start_watching();
    let closing = |code: u16, reason: &str| {
        open.store(false, std::sync::atomic::Ordering::Relaxed);
        out.close(code, reason);
    };
    loop {
        tokio::select! {
            _ = end.notified() => {
                closing(4403, "unpaired");
                break;
            }
            next = rx.recv() => match next {
                Some(WireIn::Data(frame)) => {
                    let opened = channel.lock().unwrap_or_else(|e| e.into_inner()).open(&frame);
                    let whole = match opened {
                        Ok(Some(w)) => w,
                        Ok(None) => continue,
                        Err(e) => {
                            closing(e.close_code(), e.reason());
                            break;
                        }
                    };
                    let Ok(m) = serde_json::from_slice::<Value>(&whole) else { continue };
                    drop_forgotten();
                    if !open.load(std::sync::atomic::Ordering::Relaxed) {
                        break;
                    }
                    match m.get("op").and_then(Value::as_str) {
                        Some("ping") => {
                            let mut pong = json!({ "type": "pong" });
                            if let Some(t) = m.get("t") {
                                pong["t"] = t.clone();
                            }
                            send(pong);
                        }
                        // the phone removed this computer: it stops being trusted here too, as `inyon forget` would
                        Some("unpair") => {
                            log(&format!("a phone removed this computer; it is no longer paired ({}…)", &key[..12]));
                            forget_phone(&key);
                        }
                        _ => ops.message(m),
                    }
                }
                Some(WireIn::Closed(..)) | None => break,
            }
        }
    }
    open.store(false, std::sync::atomic::Ordering::Relaxed);
    ops.close();
    let mut active = ACTIVE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(a) = active.as_mut() {
        if let Some(mine) = a.get_mut(&key) {
            mine.retain(|(n, _)| *n != me);
            if mine.is_empty() {
                a.remove(&key);
            }
        }
    }
}

fn start_watching() {
    static WATCHING: OnceLock<()> = OnceLock::new();
    WATCHING.get_or_init(|| {
        tokio::spawn(async {
            let mut tick = tokio::time::interval(Duration::from_secs(2));
            loop {
                tick.tick().await;
                let any = ACTIVE.lock().unwrap_or_else(|e| e.into_inner()).as_ref().is_some_and(|a| !a.is_empty());
                if any {
                    drop_forgotten();
                }
            }
        });
    });
}

// ---------- the local listener (behind the tunnel, on private networks, on the LAN if asked) ----------

/// A WebSocket the listener took, as a wire.
struct SocketOut(mpsc::UnboundedSender<Message>);

impl WireOut for SocketOut {
    fn send(&self, data: Vec<u8>) {
        let _ = self.0.send(Message::Binary(data.into()));
    }

    fn close(&self, code: u16, reason: &str) {
        let _ = self.0.send(Message::Close(Some(CloseFrame { code: CloseCode::from(code), reason: reason.to_string().into() })));
    }
}

/// How long the listener keeps a socket that sends nothing (not even an answer to a ping).
const IDLE: Duration = Duration::from_secs(120);

/// Reads the request's head without taking it off the socket, so a WebSocket handshake can still
/// read it whole: the path, and whether it asks for an upgrade.
async fn peek_head(stream: &TcpStream) -> Option<(String, bool)> {
    let mut buf = vec![0u8; 16384];
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let n = tokio::time::timeout_at(deadline, stream.peek(&mut buf)).await.ok()?.ok()?;
        if n == 0 {
            return None;
        }
        if let Some(end) = buf[..n].windows(4).position(|w| w == b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&buf[..end]).into_owned();
            let mut lines = head.split("\r\n");
            let path = lines.next()?.split(' ').nth(1)?.to_string();
            let upgrade = lines.any(|l| l.split_once(':').is_some_and(|(k, v)| k.trim().eq_ignore_ascii_case("upgrade") && v.trim().eq_ignore_ascii_case("websocket")));
            return Some((path, upgrade));
        }
        if n == buf.len() || tokio::time::Instant::now() >= deadline {
            return None;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

async fn answer_http(mut stream: TcpStream, status: &str, body: &str) {
    use tokio::io::AsyncWriteExt;
    // take the request off the socket first, so closing it doesn't reset the connection
    let mut buf = vec![0u8; 16384];
    let _ = tokio::time::timeout(Duration::from_millis(200), stream.read(&mut buf)).await;
    let res = format!("HTTP/1.1 {status}\r\nContent-Type: text/plain;charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
    let _ = stream.write_all(res.as_bytes()).await;
    let _ = stream.shutdown().await;
}

async fn serve(id: Arc<Identity>, stream: TcpStream) {
    let Some((path, upgrade)) = peek_head(&stream).await else { return };
    let path = path.split('?').next().unwrap_or("").to_string();
    if path != "/link" {
        return answer_http(stream, "200 OK", "inyon\n").await;
    }
    if !upgrade {
        return answer_http(stream, "400 Bad Request", "Upgrade failed").await;
    }
    let config = WebSocketConfig::default().max_message_size(Some(1 << 20)).max_frame_size(Some(1 << 20));
    let Ok(ws) = tokio_tungstenite::accept_async_with_config(stream, Some(config)).await else { return };
    let (mut sink, mut source) = ws.split();
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Message>();
    let (in_tx, in_rx) = mpsc::unbounded_channel::<WireIn>();
    let ping_tx = out_tx.clone();
    tokio::spawn(async move {
        while let Some(m) = out_rx.recv().await {
            let last = matches!(m, Message::Close(_));
            if sink.send(m).await.is_err() || last {
                break;
            }
        }
        let _ = sink.close().await;
    });
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(30));
        tick.tick().await;
        let mut heard = tokio::time::Instant::now();
        loop {
            tokio::select! {
                _ = tick.tick() => {
                    if heard.elapsed() > IDLE {
                        let _ = in_tx.send(WireIn::Closed(1006, String::new()));
                        let _ = ping_tx.send(Message::Close(None));
                        break;
                    }
                    let _ = ping_tx.send(Message::Ping(Vec::new().into()));
                }
                next = source.next() => {
                    heard = tokio::time::Instant::now();
                    match next {
                        Some(Ok(Message::Binary(b))) => {
                            let _ = in_tx.send(WireIn::Data(b.to_vec()));
                        }
                        Some(Ok(Message::Close(f))) => {
                            let (code, reason) = f.map(|f| (u16::from(f.code), f.reason.to_string())).unwrap_or((1005, String::new()));
                            let _ = in_tx.send(WireIn::Closed(code, reason));
                            break;
                        }
                        Some(Ok(_)) => {}
                        Some(Err(_)) | None => {
                            let _ = in_tx.send(WireIn::Closed(1006, String::new()));
                            break;
                        }
                    }
                }
            }
        }
    });
    session(id, in_rx, Arc::new(SocketOut(out_tx)), "direct".into()).await;
}

/// Listens on one address; the task ends (and the port is freed) when it's aborted.
fn listen(id: Arc<Identity>, host: &str, port: u16) -> std::io::Result<tokio::task::JoinHandle<()>> {
    let std_listener = std::net::TcpListener::bind((host, port))?;
    std_listener.set_nonblocking(true)?;
    let listener = tokio::net::TcpListener::from_std(std_listener)?;
    Ok(tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else { continue };
            let _ = stream.set_nodelay(true);
            tokio::spawn(serve(id.clone(), stream));
        }
    }))
}

/// Container and VM bridges only reach this machine's own guests, never a phone.
fn is_virtual(name: &str) -> bool {
    // vEthernet (Windows' Hyper-V switches) starts like veth
    const VIRTUAL: [&str; 13] = ["docker", "br-", "veth", "virbr", "vmnet", "vboxnet", "cni", "flannel", "podman", "lxc", "lxd", "kube", "cali"];
    let name = name.to_ascii_lowercase();
    VIRTUAL.iter().any(|p| name.starts_with(p))
}

fn lan_urls(port: u16) -> Vec<String> {
    crate::networks::interfaces().into_iter().filter(|i| !is_virtual(&i.name) && !i.internal).map(|i| format!("ws://{}:{port}/link", i.ip)).collect()
}

// ---------- the Cloudflare quick tunnel ----------

/// The cloudflared release that gets downloaded, with the sha256 of each file, checked against
/// Cloudflare's release notes (for a .tgz, `inner` is the binary inside, the hash the notes list).
/// To update: `gh release view <tag> -R cloudflare/cloudflared`, then download and hash each asset.
pub const CLOUDFLARED_VERSION: &str = "2026.9.3";

/// (asset, sha256, sha256 of the binary inside a .tgz)
pub const CLOUDFLARED: [(&str, &str, Option<&str>); 6] = [
    ("cloudflared-linux-amd64", "77e26d8d900e0b8469f416239d14b5f296525fdf79fee6f511ef55609e3fbac2", None),
    ("cloudflared-linux-arm64", "aaeb2d7d0da3614634c7e03ab13487a1522c2e79165ed2929cfe23d5e95b326d", None),
    ("cloudflared-linux-arm", "967dc371a3fedbf09e881c13ee7ba317155ebc336cbd4afb756b46fc6785e5af", None),
    ("cloudflared-darwin-amd64.tgz", "d1155d0837487f261183b15c1eab6c4ebcad9dc49b94675f1524c3564cea3977", Some("ab588b3b4db9cdb4476c30a3db2a72635b1d8327d44741fee6799a0f37b0ec07")),
    ("cloudflared-darwin-arm64.tgz", "587c2cfb1c230fe36c7fa7727da78be459dae028cabe8c001291999350f07095", Some("5472c1a01c84bc31b3021056a73b4e5774ddddefc572124ea8fdf6c340639f32")),
    // there is no Windows arm64 build; the x64 one runs under emulation
    ("cloudflared-windows-amd64.exe", "f096265ec2fcbe9bb6e2d64268db167ced3fcbb83d894bdb9e2fcdb26f2ea7e2", None),
];

pub fn cloudflared_asset(platform: &str, cpu: &str) -> String {
    let arch = match cpu {
        "arm64" => "arm64",
        "arm" => "arm",
        _ => "amd64",
    };
    match platform {
        "win32" => "cloudflared-windows-amd64.exe".into(),
        "darwin" => format!("cloudflared-darwin-{}.tgz", if arch == "arm64" { "arm64" } else { "amd64" }),
        _ => format!("cloudflared-linux-{arch}"),
    }
}

/// cloudflared from PATH, or the pinned release downloaded once into ~/.inyon/bin.
async fn cloudflared() -> Result<PathBuf, String> {
    tokio::task::spawn_blocking(ensure_cloudflared).await.map_err(|e| e.to_string())?
}

/// cloudflared, if it's here already: on PATH or in ~/.inyon/bin.
pub fn cloudflared_here() -> Option<PathBuf> {
    which("cloudflared").or_else(|| Some(bin_dir().join(if WIN { "cloudflared.exe" } else { "cloudflared" })).filter(|b| b.exists()))
}

/// cloudflared, downloaded now when it isn't here. Setup and `inyon service install` call this, so
/// the first pairing doesn't wait for a 40 MB download before the tunnel can start.
pub fn ensure_cloudflared() -> Result<PathBuf, String> {
    if let Some(p) = cloudflared_here() {
        return Ok(p);
    }
    download_cloudflared(&bin_dir().join(if WIN { "cloudflared.exe" } else { "cloudflared" }))
}

fn download_cloudflared(bin: &Path) -> Result<PathBuf, String> {
    let asset = cloudflared_asset(crate::platform(), crate::arch());
    let (_, sum, inner) = CLOUDFLARED.iter().find(|(a, _, _)| *a == asset).copied().ok_or("no cloudflared for this system")?;
    log(&format!("downloading cloudflared {CLOUDFLARED_VERSION} ({asset}) for the tunnel…"));
    let res = crate::http::download(&format!("https://github.com/cloudflare/cloudflared/releases/download/{CLOUDFLARED_VERSION}/{asset}"))?;
    if !res.ok() {
        return Err(format!("couldn't download cloudflared: {}", res.status));
    }
    if sha256_hex(&res.body) != sum {
        return Err("the cloudflared download didn't match its pinned checksum".into());
    }
    let dir = bin.parent().ok_or("no folder for cloudflared")?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    // everything happens in a folder of its own; only a checked binary is moved into place
    let tmp = dir.join(format!(".cloudflared-{}", crate::random_bytes(4).iter().map(|b| format!("{b:02x}")).collect::<String>()));
    std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    let result = (|| {
        let mut f = tmp.join("cloudflared");
        if asset.ends_with(".tgz") {
            std::fs::write(tmp.join("download.tgz"), &res.body).map_err(|e| e.to_string())?;
            let out = tmp.join("out");
            std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
            let ok = std::process::Command::new("tar")
                .arg("-xzf")
                .arg(tmp.join("download.tgz"))
                .arg("-C")
                .arg(&out)
                .stdout(Stdio::null())
                .stderr(Stdio::piped())
                .status()
                .is_ok_and(|s| s.success());
            if !ok {
                return Err("couldn't unpack cloudflared".to_string());
            }
            f = out.join("cloudflared");
            if !f.exists() || Some(sha256_hex(&std::fs::read(&f).unwrap_or_default()).as_str()) != inner {
                return Err("the unpacked cloudflared didn't match its pinned checksum".into());
            }
        } else {
            std::fs::write(&f, &res.body).map_err(|e| e.to_string())?;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
        }
        std::fs::rename(&f, bin).map_err(|e| e.to_string())
    })();
    let _ = std::fs::remove_dir_all(&tmp);
    result.map(|_| bin.to_path_buf())
}

/// cloudflared outlives us unless told otherwise.
static CHILDREN: Mutex<Vec<u32>> = Mutex::new(Vec::new());

/// Stops what the link started (cloudflared); this process is about to exit.
pub fn stop_children() {
    for pid in std::mem::take(&mut *CHILDREN.lock().unwrap_or_else(|e| e.into_inner())) {
        #[cfg(unix)]
        // SAFETY: a plain signal to a child this process started
        unsafe {
            libc::kill(pid as i32, libc::SIGTERM);
        }
        #[cfg(windows)]
        {
            let mut c = std::process::Command::new("taskkill");
            c.args(["/PID", &pid.to_string(), "/F"]).stdout(Stdio::null()).stderr(Stdio::null());
            ops::hide_window_std(&mut c);
            let _ = c.status();
        }
    }
}

/// The address in what cloudflared prints once its tunnel is up.
pub fn tunnel_address(text: &str) -> Option<String> {
    static URL: OnceLock<Regex> = OnceLock::new();
    let m = URL.get_or_init(|| Regex::new(r"https://[a-z0-9-]+\.trycloudflare\.com").unwrap()).find(text)?;
    Some(format!("wss://{}/link", &m.as_str()["https://".len()..]))
}

/// Keeps a quick tunnel to the listener running; calls back with each new public address.
fn tunnel(port: u16, on_url: impl Fn(Option<String>) + Send + Sync + 'static) {
    let on_url = Arc::new(on_url);
    tokio::spawn(async move {
        let mut attempt: u32 = 0;
        loop {
            let bin = match cloudflared().await {
                Ok(b) => b,
                Err(e) => {
                    error(&format!("tunnel: {e}"));
                    tokio::time::sleep(Duration::from_millis(300_000.min(10_000u64 << attempt.min(10)))).await;
                    attempt += 1;
                    continue;
                }
            };
            let mut c = tokio::process::Command::new(&bin);
            c.args(["tunnel", "--no-autoupdate", "--url", &format!("http://127.0.0.1:{port}")]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped());
            ops::hide_window(&mut c);
            let started = tokio::time::Instant::now();
            match c.spawn() {
                Ok(mut child) => {
                    let pid = child.id();
                    // on Windows it would outlive this process: in the job, it ends when the link does
                    #[cfg(windows)]
                    if let (Some(job), Some(h)) = (crate::winjob::for_children(), child.raw_handle()) {
                        if !job.add(h) {
                            error("tunnel: couldn't tie cloudflared to the link, so it may outlive it");
                        }
                    }
                    if let Some(pid) = pid {
                        CHILDREN.lock().unwrap_or_else(|e| e.into_inner()).push(pid);
                    }
                    if let Some(mut stderr) = child.stderr.take() {
                        let on_url = on_url.clone();
                        let reset = Arc::new(std::sync::atomic::AtomicBool::new(false));
                        let r = reset.clone();
                        let reader = tokio::spawn(async move {
                            let mut carry = String::new();
                            let mut pending: Vec<u8> = Vec::new();
                            let mut buf = vec![0u8; 8192];
                            while let Ok(n) = stderr.read(&mut buf).await {
                                if n == 0 {
                                    break;
                                }
                                pending.extend_from_slice(&buf[..n]);
                                let cut = match std::str::from_utf8(&pending) {
                                    Ok(_) => pending.len(),
                                    Err(e) if e.error_len().is_none() => e.valid_up_to(),
                                    Err(_) => pending.len(),
                                };
                                carry.push_str(&String::from_utf8_lossy(&pending[..cut]));
                                pending.drain(..cut);
                                if let Some(url) = tunnel_address(&carry) {
                                    r.store(true, std::sync::atomic::Ordering::Relaxed);
                                    on_url(Some(url));
                                    carry.clear();
                                } else if carry.len() > 65536 {
                                    let keep = carry.len() - 4096;
                                    let at = (keep..carry.len()).find(|i| carry.is_char_boundary(*i)).unwrap_or(carry.len());
                                    carry.drain(..at);
                                }
                            }
                        });
                        let _ = child.wait().await;
                        let _ = tokio::time::timeout(Duration::from_secs(1), reader).await;
                        if reset.load(std::sync::atomic::Ordering::Relaxed) {
                            attempt = 0;
                        }
                    } else {
                        let _ = child.wait().await;
                    }
                    if let Some(pid) = pid {
                        CHILDREN.lock().unwrap_or_else(|e| e.into_inner()).retain(|p| *p != pid);
                    }
                }
                Err(e) => error(&format!("tunnel: {e}")),
            }
            on_url(None);
            // quick tunnels are rate limited; back off if it keeps dying young
            let delay = if started.elapsed() > Duration::from_secs(60) {
                Duration::from_secs(2)
            } else {
                let d = Duration::from_millis(300_000.min(5000u64 << attempt.min(10)));
                attempt += 1;
                d
            };
            log(&format!("tunnel stopped; restarting in {}s", (delay.as_millis() + 500) / 1000));
            tokio::time::sleep(delay).await;
        }
    });
}

// ---------- relays ----------

/// A session through a relay, as a wire.
struct RelayOut {
    sid: u32,
    tx: mpsc::UnboundedSender<Message>,
    sessions: Arc<Mutex<HashMap<u32, mpsc::UnboundedSender<WireIn>>>>,
}

impl WireOut for RelayOut {
    fn send(&self, data: Vec<u8>) {
        let _ = self.tx.send(Message::Binary(inyon_link::frame(self.sid, &data).into()));
    }

    fn close(&self, _code: u16, _reason: &str) {
        self.sessions.lock().unwrap_or_else(|e| e.into_inner()).remove(&self.sid);
        let _ = self.tx.send(Message::Text(json!({ "t": "close", "sid": self.sid }).to_string().into()));
    }
}

fn host_of(url: &str) -> String {
    url::Url::parse(url)
        .ok()
        .map(|u| match (u.host_str(), u.port()) {
            (Some(h), Some(p)) => format!("{h}:{p}"),
            (Some(h), None) => h.to_string(),
            _ => String::new(),
        })
        .unwrap_or_default()
}

/// Keeps one socket to a relay; each phone that connects through it becomes a session.
fn relay(id: Arc<Identity>, url: String, on_state: impl Fn(bool) + Send + Sync + 'static) {
    tokio::spawn(async move {
        let host = host_of(&url);
        let mut attempt: u32 = 0;
        loop {
            let code = match crate::ws::connect(&inyon_link::relay_ws(&url, &inyon_link::machine_path(&id.id)), &[]).await {
                Err((code, _)) => code,
                Ok(socket) => {
                    let (mut sink, mut source) = socket.split();
                    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
                    let writer = tokio::spawn(async move {
                        while let Some(m) = rx.recv().await {
                            if sink.send(m).await.is_err() {
                                break;
                            }
                        }
                    });
                    let sessions: Arc<Mutex<HashMap<u32, mpsc::UnboundedSender<WireIn>>>> = Arc::new(Mutex::new(HashMap::new()));
                    let mut code = 1006;
                    while let Some(next) = source.next().await {
                        match next {
                            Ok(Message::Binary(b)) => {
                                if let Some((sid, data)) = inyon_link::unframe(&b) {
                                    if let Some(s) = sessions.lock().unwrap_or_else(|e| e.into_inner()).get(&sid) {
                                        let _ = s.send(WireIn::Data(data.to_vec()));
                                    }
                                }
                            }
                            Ok(Message::Text(t)) => {
                                let Ok(m) = serde_json::from_str::<Value>(t.as_str()) else { continue };
                                let sid = m.get("sid").and_then(Value::as_u64).map(|s| s as u32);
                                match m.get("t").and_then(Value::as_str) {
                                    Some("challenge") => {
                                        let nonce = m.get("nonce").and_then(Value::as_str).unwrap_or("");
                                        let sig = B64.encode(id.sign(&inyon_link::auth_message(nonce)));
                                        let _ = tx.send(Message::Text(json!({ "t": "auth", "id": id.id, "sig": sig }).to_string().into()));
                                    }
                                    Some("ready") => {
                                        attempt = 0;
                                        log(&format!("relay {host}: connected"));
                                        on_state(true);
                                    }
                                    Some("open") => {
                                        let Some(sid) = sid else { continue };
                                        let (in_tx, in_rx) = mpsc::unbounded_channel();
                                        sessions.lock().unwrap_or_else(|e| e.into_inner()).insert(sid, in_tx);
                                        let out = Arc::new(RelayOut { sid, tx: tx.clone(), sessions: sessions.clone() });
                                        tokio::spawn(session(id.clone(), in_rx, out, format!("relay {host}")));
                                    }
                                    Some("close") => {
                                        let Some(sid) = sid else { continue };
                                        if let Some(s) = sessions.lock().unwrap_or_else(|e| e.into_inner()).remove(&sid) {
                                            let _ = s.send(WireIn::Closed(1000, "phone left".into()));
                                        }
                                    }
                                    _ => {}
                                }
                            }
                            Ok(Message::Close(f)) => {
                                code = f.map(|f| u16::from(f.code)).unwrap_or(1005);
                                break;
                            }
                            Ok(_) => {}
                            Err(_) => break,
                        }
                    }
                    for (_, s) in sessions.lock().unwrap_or_else(|e| e.into_inner()).drain() {
                        let _ = s.send(WireIn::Closed(1001, "relay disconnected".into()));
                    }
                    writer.abort();
                    code
                }
            };
            on_state(false);
            let delay = Duration::from_millis(60_000.min(1000u64 << attempt.min(10)));
            attempt += 1;
            log(&format!("relay {host}: disconnected ({code}); retrying in {}s", (delay.as_millis() + 500) / 1000));
            tokio::time::sleep(delay).await;
        }
    });
}

// ---------- publishing addresses (pkarr) ----------

/// Publishes a record to every pkarr relay; the seq it used as soon as one of them took it (the
/// rest carry on).
pub async fn publish(identity: &Identity, record: &Record, last_seq: Option<u64>) -> Result<u64, String> {
    let seq = inyon_link::pkarr::next_seq(last_seq.unwrap_or(0), crate::now_ms());
    let body = inyon_link::encode_published(identity, record, seq).map_err(|e| e.to_string())?;
    let (tx, mut rx) = mpsc::unbounded_channel::<Result<(), String>>();
    for r in inyon_link::PKARR_RELAYS {
        let (tx, body, url) = (tx.clone(), body.clone(), format!("{r}/{}", identity.id));
        tokio::spawn(async move {
            let res = crate::http::fetch("PUT", url, Vec::new(), Some(body), Duration::from_secs(40)).await;
            let _ = tx.send(match res {
                Ok(r2) if r2.ok() => Ok(()),
                Ok(r2) => Err(format!("{r}: {}", r2.status)),
                Err(e) => Err(format!("{r}: {e}")),
            });
        });
    }
    drop(tx);
    let mut why = Vec::new();
    while let Some(r) = rx.recv().await {
        match r {
            Ok(()) => return Ok(seq),
            Err(e) => why.push(e),
        }
    }
    Err(format!("Couldn't publish the address: {}", why.join("; ")))
}

/// For typing in: publishes the machine's id and addresses under the short code's identity.
pub async fn publish_short_code(short: &ShortCode, machine: &str, name: &str, urls: &[String], relays: &[String]) -> Result<(), String> {
    let s = short.clone();
    let identity = tokio::task::spawn_blocking(move || inyon_link::short_code_identity(&s)).await.map_err(|e| e.to_string())?;
    let record = Record { urls: urls.to_vec(), relays: relays.to_vec(), machine: Some(machine.into()), name: Some(name.into()) };
    publish(&identity, &record, None).await.map(|_| ())
}

// ---------- the service ----------

struct Live {
    tunnel_url: Option<String>,
    last_published: String,
    last_seq: Option<u64>,
    /// private network address → its listener (with --lan, the one on 0.0.0.0 answers there already)
    vpn: Vec<(String, Option<tokio::task::JoinHandle<()>>)>,
}

fn update(id: &Arc<Identity>, config: &LinkConfig, live: &Arc<Mutex<Live>>) {
    let (urls, key, last_seq) = {
        let l = live.lock().unwrap_or_else(|e| e.into_inner());
        let mut urls: Vec<String> = Vec::new();
        let candidates =
            l.tunnel_url.iter().cloned().chain(config.urls.iter().cloned()).chain(l.vpn.iter().map(|(ip, _)| format!("ws://{ip}:{}/link", config.port))).chain(if config.lan {
                lan_urls(config.port)
            } else {
                Vec::new()
            });
        for u in candidates {
            if !urls.contains(&u) {
                urls.push(u);
            }
        }
        (urls.clone(), json!({ "urls": urls, "relays": config.relays }).to_string(), l.last_seq)
    };
    let state = State { urls: urls.clone(), relays: config.relays.clone(), updated_at: crate::now_ms(), pid: std::process::id(), version: Some(VERSION.into()), last_seq };
    {
        let _files = node_files();
        save_or_say("state.json", &state);
    }
    {
        let mut l = live.lock().unwrap_or_else(|e| e.into_inner());
        if key == l.last_published || (urls.is_empty() && config.relays.is_empty()) {
            return;
        }
        l.last_published = key;
    }
    let (id, relays, live) = (id.clone(), config.relays.clone(), live.clone());
    tokio::spawn(async move {
        let record = Record { urls: urls.clone(), relays: relays.clone(), machine: None, name: None };
        match publish(&id, &record, last_seq).await {
            Ok(seq) => {
                live.lock().unwrap_or_else(|e| e.into_inner()).last_seq = Some(seq);
                {
                    let _files = node_files();
                    let mut s = current_state().unwrap_or(state);
                    s.last_seq = Some(seq);
                    save_or_say("state.json", &s);
                }
                let all: Vec<String> = urls.iter().chain(relays.iter()).cloned().collect();
                log(&format!("published: {}", if all.is_empty() { "nothing".into() } else { all.join(" ") }));
            }
            Err(e) => {
                live.lock().unwrap_or_else(|e| e.into_inner()).last_published.clear();
                error(&format!("publish: {e}"));
            }
        }
    });
}

/// Starts the link: the listener, the tunnel, relays, private networks, notifications. Runs on
/// the current tokio runtime for as long as it does. Fails when the port is taken.
pub fn start_link(config: LinkConfig) -> Result<Identity, String> {
    let id = Arc::new(identity());
    listen(id.clone(), if config.lan { "0.0.0.0" } else { "127.0.0.1" }, config.port).map_err(|e| format!("Can't listen on port {}: {e}", config.port))?;
    let live = Arc::new(Mutex::new(Live { tunnel_url: None, last_published: String::new(), last_seq: current_state().and_then(|s| s.last_seq), vpn: Vec::new() }));
    let config = Arc::new(config);

    if config.tunnel {
        let (id, config2, live) = (id.clone(), config.clone(), live.clone());
        tunnel(config.port, move |url| {
            live.lock().unwrap_or_else(|e| e.into_inner()).tunnel_url = url.clone();
            if let Some(u) = url {
                log(&format!("tunnel: {u}"));
            }
            update(&id, &config2, &live);
        });
    }
    for r in &config.relays {
        let (id2, config2, live) = (id.clone(), config.clone(), live.clone());
        relay(id.clone(), r.clone(), move |_| update(&id2, &config2, &live));
    }
    // notifications for paired browsers while their page is closed
    crate::push::start_push(crate::push::PushOptions::default());

    // networks come and go (NetBird often connects after this starts), so look again now and then
    if config.vpn {
        let (id, config, live) = (id.clone(), config.clone(), live.clone());
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(120));
            loop {
                tick.tick().await;
                let nets = detect_networks().await;
                let mut changed = false;
                {
                    let mut l = live.lock().unwrap_or_else(|e| e.into_inner());
                    let before = l.vpn.len();
                    l.vpn.retain(|(ip, server)| {
                        let keep = nets.iter().any(|n| &n.ip == ip);
                        if !keep {
                            if let Some(s) = server {
                                s.abort();
                            }
                        }
                        keep
                    });
                    changed |= l.vpn.len() != before;
                    for n in &nets {
                        if l.vpn.iter().any(|(ip, _)| *ip == n.ip) {
                            continue;
                        }
                        let label = n.kind.label();
                        if config.lan {
                            l.vpn.push((n.ip.clone(), None));
                        } else {
                            match listen(id.clone(), &n.ip, config.port) {
                                Ok(server) => l.vpn.push((n.ip.clone(), Some(server))),
                                Err(e) => {
                                    error(&format!("{label}: can't listen on {}:{}: {e}", n.ip, config.port));
                                    continue;
                                }
                            }
                        }
                        log(&format!("{label}: answering on {}", n.ip));
                        changed = true;
                    }
                }
                if changed {
                    update(&id, &config, &live);
                }
            }
        });
    }
    update(&id, &config, &live);
    // pkarr records age out of the DHT after a few hours
    {
        let (id, config, live) = (id.clone(), config.clone(), live.clone());
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(30 * 60));
            tick.tick().await;
            loop {
                tick.tick().await;
                live.lock().unwrap_or_else(|e| e.into_inner()).last_published.clear();
                update(&id, &config, &live);
            }
        });
    }
    log(&format!("inyon {VERSION} link service for {} on port {}{}", id.id, config.port, if config.lan { " (LAN too)" } else { "" }));
    Ok((*id).clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::testing;

    struct Collect(Mutex<Vec<Vec<u8>>>);

    impl WireOut for Collect {
        fn send(&self, data: Vec<u8>) {
            self.0.lock().unwrap().push(data);
        }
        fn close(&self, _code: u16, _reason: &str) {}
    }

    #[test]
    fn frames_from_many_senders_reach_the_phone_in_the_order_they_were_sealed() {
        let machine = inyon_link::KeyPair::generate().unwrap();
        let phone = inyon_link::KeyPair::generate().unwrap();
        let (connecting, msg1) = inyon_link::connect(&phone, &machine.public, b"{}").unwrap();
        let (channel, msg2) = inyon_link::accept(&machine, &msg1).unwrap().welcome(b"{\"ok\":true}").unwrap();
        let (mut theirs, _) = connecting.finish(&msg2).unwrap();
        let out = Arc::new(Collect(Mutex::new(Vec::new())));
        let send = sealing_sender(Arc::new(Mutex::new(channel)), out.clone(), Arc::new(std::sync::atomic::AtomicBool::new(true)));
        // a terminal's output, command results and pongs, all at once; some bigger than one Noise message
        let senders: Vec<_> = (0..8u64)
            .map(|t| {
                let send = send.clone();
                std::thread::spawn(move || {
                    for i in 0..150u64 {
                        let body = if i % 15 == 0 { "x".repeat(130_000) } else { format!("{t}-{i}") };
                        send(json!({ "t": t, "i": i, "b": body }));
                    }
                })
            })
            .collect();
        for s in senders {
            s.join().unwrap();
        }
        let mut next = [0u64; 8];
        for f in out.0.lock().unwrap().iter() {
            match theirs.open(f) {
                Ok(Some(whole)) => {
                    let m: Value = serde_json::from_slice(&whole).unwrap();
                    let t = m["t"].as_u64().unwrap() as usize;
                    assert_eq!(m["i"].as_u64(), Some(next[t]), "messages from one sender stay in order");
                    next[t] += 1;
                }
                Ok(None) => {}
                Err(e) => panic!("the phone would close the connection: {e}"),
            }
        }
        assert_eq!(next, [150; 8]);
    }

    #[test]
    fn container_and_vm_bridges_are_left_out_of_the_addresses_whatever_their_case() {
        for name in ["docker0", "br-4f2a", "veth12", "vEthernet (WSL)", "virbr0", "VMnet8", "cni0", "lxdbr0", "cali9"] {
            assert!(is_virtual(name), "{name}");
        }
        for name in ["eth0", "en0", "wlan0", "tailscale0", "wt0", "Wi-Fi"] {
            assert!(!is_virtual(name), "{name}");
        }
        // the machine's real interfaces, read without failing
        let _ = lan_urls(4780);
    }

    #[test]
    fn every_platform_downloads_a_pinned_cloudflared_with_a_checksum() {
        let cases = [
            ("linux", "x64", "cloudflared-linux-amd64"),
            ("linux", "arm64", "cloudflared-linux-arm64"),
            ("linux", "arm", "cloudflared-linux-arm"),
            ("darwin", "x64", "cloudflared-darwin-amd64.tgz"),
            ("darwin", "arm64", "cloudflared-darwin-arm64.tgz"),
            ("win32", "x64", "cloudflared-windows-amd64.exe"),
            ("win32", "arm64", "cloudflared-windows-amd64.exe"),
        ];
        let hex64 = |s: &str| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase());
        for (platform, cpu, asset) in cases {
            assert_eq!(cloudflared_asset(platform, cpu), asset);
            let (_, sum, inner) = CLOUDFLARED.iter().find(|(a, _, _)| *a == asset).unwrap();
            assert!(hex64(sum));
            assert_eq!(asset.ends_with(".tgz"), inner.is_some_and(hex64));
        }
        assert!(Regex::new(r"^\d{4}\.\d+\.\d+$").unwrap().is_match(CLOUDFLARED_VERSION));
    }

    #[test]
    fn the_tunnel_address_is_read_off_cloudflareds_banner() {
        let banner = "2026-10-18T10:00:00Z INF |  https://quiet-river-1234.trycloudflare.com                                  |";
        assert_eq!(tunnel_address(banner).as_deref(), Some("wss://quiet-river-1234.trycloudflare.com/link"));
        assert_eq!(tunnel_address("INF Requesting new quick Tunnel on trycloudflare.com..."), None);
    }

    #[test]
    fn phone_names_lose_androids_build_string() {
        assert_eq!(phone_name(Some(&json!("A142 Build/BP2A.250605.031.A3"))), "A142");
        assert_eq!(phone_name(Some(&json!("  "))), "Phone");
        assert_eq!(phone_name(None), "Phone");
        assert_eq!(phone_name(Some(&json!("x".repeat(80)))).len(), 64);
    }

    #[test]
    fn files_are_written_the_way_the_bun_engine_wrote_them() {
        let _h = testing::home("link-files");
        let mut c = load_config();
        assert_eq!(c, LinkConfig::default());
        c.port = 4790;
        c.extra.insert("later".into(), json!(1));
        save_config(&c);
        let text = std::fs::read_to_string(node_dir().join("link.json")).unwrap();
        let vpn = !WIN;
        assert_eq!(text, format!("{{\n  \"relays\": [],\n  \"tunnel\": true,\n  \"lan\": false,\n  \"vpn\": {vpn},\n  \"urls\": [],\n  \"port\": 4790,\n  \"later\": 1\n}}"));
        // what a file leaves out comes from the defaults
        std::fs::write(node_dir().join("link.json"), "{\"lan\":true}").unwrap();
        assert_eq!(load_config(), LinkConfig { lan: true, ..LinkConfig::default() });
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            save_config(&load_config());
            assert_eq!(std::fs::metadata(node_dir().join("link.json")).unwrap().permissions().mode() & 0o777, 0o600);
        }
        // the identity stays the same from one start to the next
        let a = identity();
        assert_eq!(identity().id, a.id);
        let saved: Value = serde_json::from_str(&std::fs::read_to_string(node_dir().join("identity.json")).unwrap()).unwrap();
        assert_eq!(saved.as_object().unwrap().keys().collect::<Vec<_>>(), ["seed", "id"]);
        assert_eq!(saved["id"], json!(a.id));
    }

    #[test]
    fn wrong_codes_tried_at_once_still_cancel_the_code_after_five() {
        let _h = testing::home("link-check-race");
        // the phone tries every address at once, so guesses arrive together
        for _ in 0..10 {
            let p = new_pairing().unwrap();
            let wrong = json!({ "name": "Guesser", "pair": format!("{}:000000", p.short.id) });
            let start = Arc::new(std::sync::Barrier::new(12));
            let tries: Vec<_> = (0..12u8)
                .map(|i| {
                    let (wrong, start) = (wrong.clone(), start.clone());
                    std::thread::spawn(move || {
                        start.wait();
                        check(&[i; 32], &wrong).unwrap_err().message().to_string()
                    })
                })
                .collect();
            let said: Vec<String> = tries.into_iter().map(|t| t.join().unwrap()).collect();
            let saved: Value = serde_json::from_str(&std::fs::read_to_string(node_dir().join("pairing.json")).unwrap()).unwrap();
            assert_eq!(saved["failures"], json!(5), "{said:?}");
            assert!(saved.get("short").is_none());
            assert_eq!(said.iter().filter(|m| m.starts_with("That code doesn't match.")).count(), 4, "{said:?}");
            assert_eq!(said.iter().filter(|m| m.starts_with("Too many wrong codes")).count(), 1, "{said:?}");
        }
    }

    #[test]
    fn a_phone_forgotten_while_it_connects_stays_forgotten() {
        let _h = testing::home("link-forget-race");
        let key = "09".repeat(32);
        for _ in 0..40 {
            write_node_json("phones.json", &json!({ key.clone(): { "name": "Pixel 9", "pairedAt": 1 } })).unwrap();
            let start = Arc::new(std::sync::Barrier::new(2));
            let seen = {
                let start = start.clone();
                std::thread::spawn(move || {
                    start.wait();
                    for _ in 0..20 {
                        let _ = check(&[9u8; 32], &json!({}));
                    }
                })
            };
            start.wait();
            forget_phone(&key);
            seen.join().unwrap();
            assert!(!list_phones().contains_key(&key), "the phone came back after it was forgotten");
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_pid_that_belongs_to_someone_else_is_not_a_running_link() {
        assert!(alive(std::process::id()));
        // pid 1 is root's; as anyone else, kill(1, 0) says EPERM
        // SAFETY: geteuid only reads this process's user
        if unsafe { libc::geteuid() } != 0 {
            assert!(!alive(1));
        }
    }

    #[test]
    fn a_pairing_that_cannot_be_saved_is_refused_and_keeps_its_code() {
        let _h = testing::home("link-unsaved");
        let p = new_pairing().unwrap();
        // something in the way of phones.json (a folder where the file goes), as a full disk would be
        std::fs::create_dir_all(node_dir().join("phones.json")).unwrap();
        let e = check(&[3u8; 32], &json!({ "name": "Pixel 9", "pair": p.secret })).unwrap_err();
        assert_eq!(e.code(), "REFUSED", "{e}");
        assert!(e.message().contains("couldn't save the pairing"), "{e}");
        assert!(node_dir().join("pairing.json").exists(), "the code is still good for another try");
        std::fs::remove_dir(node_dir().join("phones.json")).unwrap();
        assert_eq!(check(&[3u8; 32], &json!({ "name": "Pixel 9", "pair": p.secret })).unwrap()["ok"], json!(true));
    }

    #[test]
    fn a_wrong_code_counts_and_the_fifth_cancels_it() {
        let _h = testing::home("link-check");
        let p = new_pairing().unwrap();
        let phone = [7u8; 32];
        let wrong = json!({ "name": "Guesser", "pair": format!("{}:000000", p.short.id) });
        for i in 1..=4 {
            let e = check(&phone, &wrong).unwrap_err();
            assert!(e.message().starts_with("That code doesn't match."), "{i}: {e}");
        }
        let e = check(&phone, &wrong).unwrap_err();
        assert!(e.message().starts_with("Too many wrong codes"), "{e}");
        let saved: Value = serde_json::from_str(&std::fs::read_to_string(node_dir().join("pairing.json")).unwrap()).unwrap();
        assert_eq!(saved.as_object().unwrap().keys().collect::<Vec<_>>(), ["secret", "expires", "failures"]);
        // the long secret from the QR code still pairs
        let w = check(&phone, &json!({ "name": "Pixel 9 Build/AP4A", "pair": p.secret })).unwrap();
        assert_eq!(w["ok"], json!(true));
        assert_eq!(list_phones().get(&"07".repeat(32)).unwrap().name, "Pixel 9");
        assert!(!node_dir().join("pairing.json").exists());
        // and comes back without a code
        assert!(check(&phone, &json!({})).is_ok());
        assert!(matches!(check(&[8u8; 32], &json!({})), Err(LinkError::NotPaired(_))));
    }
}
