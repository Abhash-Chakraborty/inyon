//! Shared links to a blueprint, for someone who isn't in the app: `/share/<token>/` opens one
//! blueprint's files, read-only, under the same sandbox as `/v/` (pages_core's `decide_at`), until
//! it runs out (1 to 30 days), is revoked, or the page's links are revoked or it is removed (the
//! page's epoch moves on, which ends every share made before).
//!
//! A share is for **people on your network** (the link uses the hub's own address, and works only
//! on the names the hub answers to) or for **anyone with the link** (the link uses the public share
//! address, `INYON_SHARE_ORIGIN` or Settings, and a proxy you point at the hub). On that address the
//! hub answers `/share/` and nothing else: the app, the API, the WebSockets and sign-in are a 404
//! there, whatever the proxy forwards (see `server::dispatch`). A network share is refused there too.
//!
//! The token is 128 random bits, shown once. The hub keeps only its SHA-256, with the share's page,
//! mode, times and how often it was opened, in `shares.json` in its data folder (the store writes
//! it private and whole).

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use axum::http::{HeaderName, HeaderValue, Method, StatusCode};
use inyon_core::features::pages_core::{error_page_for, view_headers, ViewHeaderInput, SHARE_PREFIX};
use inyon_core::hosts::http_error::{http, HubResult};
use inyon_core::platform::store::kv;
use serde_json::{json, Value};

use crate::http::{ok, ok_json, Body, Req, Resp};
use crate::server::{guarded, h, Routes};

/// The store key, a file in the hub's data folder: `{v: 1, address?, links: [...]}`.
pub const SHARES_KEY: &str = "shares";
/// The env var that sets the public share address for a hub set up by file; it wins over Settings.
pub const ENV: &str = "INYON_SHARE_ORIGIN";
/// The longest a shared link may last, in days.
pub const MAX_DAYS: u64 = 30;
const DAY_MS: u64 = 24 * 60 * 60 * 1000;
/// The most live shared links the hub keeps.
pub const MAX_LINKS: usize = 500;
/// Opens are counted in memory and saved at most this often (and with every other change).
const OPENS_SAVE_MS: u64 = 30_000;
/// A token: 16 random bytes as base64url, no padding.
const TOKEN_LEN: usize = 22;
/// Where the hub answers its own check of the public address (`check`). A token never starts with
/// a dot, so this can't be a shared link.
pub const CHECK_PREFIX: &str = "/share/.inyon-check/";
/// How long a check's probe is answered.
const PROBE_MS: u64 = 30_000;

pub const NO_ADDRESS: &str = "Set an address for shared links in Settings › Blueprints first.";
pub const BAD_DAYS: &str = "A shared link lasts from 1 to 30 days.";
pub const TOO_MANY: &str = "This hub has 500 live shared links. Revoke some first.";
pub const UNKNOWN_SHARE: &str = "That shared link is gone already.";
pub const NOT_SAVED: &str = "The hub couldn't write to its data folder, so this change lasts only until it restarts. Check the hub's disk, then try again.";
pub const FROM_ENV: &str = "This hub's address for shared links is set by INYON_SHARE_ORIGIN. Change it there.";
pub const BAD_ADDRESS: &str = "Give the address as https://share.example.com: a scheme and a host, with no path.";
pub const SAME_ADDRESS: &str = "That's the address you're using Inyon at. Shared links need an address of their own, or the app would stop opening there.";

/// One shared link, as the hub keeps it.
#[derive(Debug, Clone, PartialEq)]
pub struct Share {
    /// a short random id to name it by in lists and to revoke it
    pub id: String,
    /// SHA-256 (hex) of the token
    hash: String,
    pub host: String,
    pub slug: String,
    /// anyone with the link, on the public share address; else people on your network
    pub public: bool,
    pub created: u64,
    pub expires: u64,
    /// the page's epoch when the link was made
    pub epoch: u64,
    pub opens: u64,
}

impl Share {
    fn to_store(&self) -> Value {
        json!({ "id": self.id, "hash": self.hash, "host": self.host, "slug": self.slug, "public": self.public, "created": self.created, "expires": self.expires, "epoch": self.epoch, "opens": self.opens })
    }

    fn from_store(v: &Value) -> Option<Share> {
        let s = |k: &str| v.get(k).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned);
        let n = |k: &str| v.get(k).and_then(Value::as_u64);
        let hash = s("hash").filter(|h| h.len() == 64 && h.bytes().all(|b| b.is_ascii_hexdigit()))?;
        Some(Share {
            id: s("id")?,
            hash,
            host: s("host")?,
            slug: s("slug")?,
            public: v.get("public").and_then(Value::as_bool)?,
            created: n("created")?,
            expires: n("expires")?,
            epoch: n("epoch")?,
            opens: n("opens").unwrap_or(0),
        })
    }

    /// The share as the API lists it: never its hash.
    pub fn to_json(&self) -> Value {
        json!({ "id": self.id, "host": self.host, "slug": self.slug, "public": self.public, "created": self.created, "expires": self.expires, "opens": self.opens })
    }

    fn live(&self, now: u64, epoch_of: &dyn Fn(&str, &str) -> u64) -> bool {
        now < self.expires && self.epoch == epoch_of(&self.host, &self.slug)
    }
}

/// The shared links and the public share address, on the core thread.
pub struct Shares {
    links: RefCell<Vec<Share>>,
    /// the address saved from Settings
    saved_address: RefCell<Option<String>>,
    /// INYON_SHARE_ORIGIN, already checked; it wins over Settings
    env_address: Option<String>,
    saved_at: Cell<u64>,
    unsaved_opens: Cell<bool>,
    /// the check in progress: the nonce in its path, the answer only this hub knows, and until when
    probe: RefCell<Option<(String, String, u64)>>,
}

impl Shares {
    /// The shares in the store, with `env` (INYON_SHARE_ORIGIN as set) over the saved address. An
    /// env address that isn't one is logged and ignored, so the hub never guesses a host to wall off.
    pub fn load(env: Option<&str>) -> Shares {
        let raw = kv::get_value(SHARES_KEY).unwrap_or(Value::Null);
        let links = raw.get("links").and_then(Value::as_array).into_iter().flatten().filter_map(Share::from_store).collect();
        let saved_address = raw.get("address").and_then(Value::as_str).and_then(|a| normalize_address(a).ok().flatten());
        let env_address = match env.map(normalize_address) {
            Some(Ok(a)) => a,
            Some(Err(_)) => {
                inyon_core::platform::console::error(&format!("{ENV} isn't an address like https://share.example.com, so shared links stay on your network."));
                None
            }
            None => None,
        };
        Shares {
            links: RefCell::new(links),
            saved_address: RefCell::new(saved_address),
            env_address,
            saved_at: Cell::new(0),
            unsaved_opens: Cell::new(false),
            probe: RefCell::new(None),
        }
    }

    /// The public share address (an origin such as `https://share.example.com`), if there is one.
    pub fn address(&self) -> Option<String> {
        self.env_address.clone().or_else(|| self.saved_address.borrow().clone())
    }

    pub fn address_from_env(&self) -> bool {
        self.env_address.is_some()
    }

    /// The host name requests for the public share address carry, lowercase.
    pub fn share_name(&self) -> Option<String> {
        self.address().as_deref().and_then(name_of_origin)
    }

    fn save(&self, now: u64) -> Result<(), String> {
        let mut v = json!({ "v": 1, "links": self.links.borrow().iter().map(Share::to_store).collect::<Vec<_>>() });
        if let Some(a) = self.saved_address.borrow().as_ref() {
            v["address"] = json!(a);
        }
        let r = kv::set_value(SHARES_KEY, &v);
        if r.is_ok() {
            self.saved_at.set(now);
            self.unsaved_opens.set(false);
        } else if let Err(e) = &r {
            inyon_core::platform::console::error(&format!("couldn't save the shared links: {e}"));
        }
        r
    }

    /// Drops the links that ran out or whose page's links were revoked; true when any went.
    fn prune(&self, now: u64, epoch_of: &dyn Fn(&str, &str) -> u64) -> bool {
        let mut links = self.links.borrow_mut();
        let before = links.len();
        links.retain(|s| s.live(now, epoch_of));
        links.len() != before
    }

    /// The live links, oldest first; the dead ones are dropped from the file.
    pub fn live(&self, now: u64, epoch_of: &dyn Fn(&str, &str) -> u64) -> Vec<Share> {
        if self.prune(now, epoch_of) {
            let _ = self.save(now);
        }
        self.links.borrow().clone()
    }

    /// A new link to one page: its token (shown once) and the share. A link for anyone needs the
    /// public address; one that can't be saved is refused, since a restart would lose it.
    pub fn create(&self, host: &str, slug: &str, public: bool, days: u64, now: u64, epoch_of: &dyn Fn(&str, &str) -> u64) -> HubResult<(String, Share)> {
        if !(1..=MAX_DAYS).contains(&days) {
            return Err(http(400, BAD_DAYS));
        }
        if public && self.address().is_none() {
            return Err(http(409, NO_ADDRESS));
        }
        self.prune(now, epoch_of);
        if self.links.borrow().len() >= MAX_LINKS {
            return Err(http(409, TOO_MANY));
        }
        let token = crate::http::random_base64url(16);
        let share = Share {
            id: crate::http::random_hex(6),
            hash: crate::http::sha256(&token),
            host: host.to_owned(),
            slug: slug.to_owned(),
            public,
            created: now,
            expires: now + days * DAY_MS,
            epoch: epoch_of(host, slug),
            opens: 0,
        };
        self.links.borrow_mut().push(share.clone());
        if self.save(now).is_err() {
            self.links.borrow_mut().retain(|s| s.id != share.id);
            return Err(http(500, NOT_SAVED));
        }
        Ok((token, share))
    }

    /// The live share a token opens. Only a token of the right shape is hashed and looked up.
    pub fn find(&self, token: &str, now: u64, epoch_of: &dyn Fn(&str, &str) -> u64) -> Option<Share> {
        if token.len() != TOKEN_LEN || !token.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
            return None;
        }
        let hash = crate::http::sha256(token);
        self.links.borrow().iter().find(|s| crate::http::same(&s.hash, &hash)).filter(|s| s.live(now, epoch_of)).cloned()
    }

    /// Counts an open of the share's page. Saved with the next change, or now if the last save is
    /// older than OPENS_SAVE_MS.
    pub fn opened(&self, id: &str, now: u64) {
        if let Some(s) = self.links.borrow_mut().iter_mut().find(|s| s.id == id) {
            s.opens += 1;
        } else {
            return;
        }
        self.unsaved_opens.set(true);
        if now.saturating_sub(self.saved_at.get()) >= OPENS_SAVE_MS {
            let _ = self.save(now);
        }
    }

    /// Removes the links `which` picks; how many went. They stop at once; a failed save says so,
    /// since a restart would bring them back.
    pub fn revoke_where(&self, now: u64, which: impl Fn(&Share) -> bool) -> HubResult<usize> {
        let gone = {
            let mut links = self.links.borrow_mut();
            let before = links.len();
            links.retain(|s| !which(s));
            before - links.len()
        };
        if gone > 0 && self.save(now).is_err() {
            return Err(http(500, NOT_SAVED));
        }
        Ok(gone)
    }

    /// Sets (or with None clears) the address saved from Settings.
    pub fn set_address(&self, address: Option<String>, now: u64) -> HubResult<()> {
        if self.address_from_env() {
            return Err(http(409, FROM_ENV));
        }
        let old = self.saved_address.replace(address);
        if self.save(now).is_err() {
            *self.saved_address.borrow_mut() = old;
            return Err(http(500, NOT_SAVED));
        }
        Ok(())
    }

    /// A new probe for `check`: the nonce to put in the path, and the answer this hub gives it. The
    /// answer isn't in the request, so only this hub can give it: a proxy that echoes the path, or
    /// another server on that name, can't.
    pub fn start_probe(&self, now: u64) -> (String, String) {
        let (nonce, answer) = (crate::http::random_hex(16), crate::http::random_hex(16));
        *self.probe.borrow_mut() = Some((nonce.clone(), answer.clone(), now + PROBE_MS));
        (nonce, answer)
    }

    /// The answer to a probe's nonce while it's live; None for anything else.
    pub fn probe_answer(&self, nonce: &str, now: u64) -> Option<String> {
        let p = self.probe.borrow();
        let (n, answer, until) = p.as_ref()?;
        (now < *until && crate::http::same(n, nonce)).then(|| answer.clone())
    }

    /// Saves opens counted since the last save (the hub stopping).
    pub fn flush(&self, now: u64) {
        if self.unsaved_opens.get() {
            let _ = self.save(now);
        }
    }
}

/// `https://share.example.com`, `share.example.com` (taken as https) or `http://10.0.0.5:8080` as
/// an origin, lowercase; None for "". A path other than `/`, a query, a fragment or a user is refused.
pub fn normalize_address(input: &str) -> Result<Option<String>, &'static str> {
    let t = input.trim();
    if t.is_empty() {
        return Ok(None);
    }
    let with_scheme = if t.contains("://") { t.to_owned() } else { format!("https://{t}") };
    let u = url::Url::parse(&with_scheme).map_err(|_| BAD_ADDRESS)?;
    if !matches!(u.scheme(), "http" | "https") || u.host_str().is_none_or(str::is_empty) || !u.username().is_empty() || u.password().is_some() {
        return Err(BAD_ADDRESS);
    }
    if u.path() != "/" || u.query().is_some() || u.fragment().is_some() || with_scheme.trim_end_matches('/').contains('#') {
        return Err(BAD_ADDRESS);
    }
    Ok(Some(u.origin().ascii_serialization()))
}

/// The host name in an origin, lowercase, without a trailing dot.
fn name_of_origin(origin: &str) -> Option<String> {
    let u = url::Url::parse(origin).ok()?;
    Some(u.host_str()?.trim_end_matches('.').to_ascii_lowercase())
}

/// The host name in a Host header, lowercase, without its port or a trailing dot.
fn name_of_host(host: &str) -> Option<String> {
    crate::hostnames::hostname_of(host.trim()).map(|n| n.trim_end_matches('.').to_ascii_lowercase())
}

/// The names a request was sent to: its Host and every X-Forwarded-Host a proxy added.
fn request_names(req: &Req) -> Vec<String> {
    let mut names: Vec<String> = req.header("host").into_iter().collect();
    if let Some(f) = req.header("x-forwarded-host") {
        names.extend(f.split(',').map(|h| h.trim().to_owned()));
    }
    names.iter().filter_map(|h| name_of_host(h)).collect()
}

thread_local! {
    static SHARES: RefCell<Option<Rc<Shares>>> = const { RefCell::new(None) };
}

/// The shares for this thread's hub, with INYON_SHARE_ORIGIN as set.
pub fn init(env: Option<&str>) {
    install(Shares::load(env));
}

pub fn install(s: Shares) {
    SHARES.with(|x| *x.borrow_mut() = Some(Rc::new(s)));
}

/// The shares, once init has run on this thread (a hub that never set them up shares nothing).
pub fn current() -> Option<Rc<Shares>> {
    SHARES.with(|x| x.borrow().clone())
}

/// Whether a request came in on the public share address: its Host, or any name a proxy says it
/// was sent to, is that address's host name (any port). Such a request reaches `/share/` only.
pub fn on_share_host(req: &Req) -> bool {
    let Some(name) = current().and_then(|s| s.share_name()) else { return false };
    request_names(req).contains(&name)
}

/// The answer on the public share address to anything but `/share/`: a 404 with no hint of the hub
/// behind it, under the same sandboxing headers as a shared page's errors.
pub fn not_here(head: bool) -> Resp {
    let headers = view_headers(&ViewHeaderInput { no_store: true, content_type: Some("text/html;charset=utf-8"), shared: true, ..Default::default() });
    let mut res = Resp::new(if head { Body::empty() } else { Body::from(error_page_for(404, true)) });
    *res.status_mut() = StatusCode::NOT_FOUND;
    for (k, v) in &headers {
        if let Ok(v) = HeaderValue::from_str(v) {
            res.headers_mut().append(HeaderName::from_static(k), v);
        }
    }
    res
}

// ---------- the API ----------

fn now() -> u64 {
    (crate::pages::pages().now)()
}

fn shares() -> HubResult<Rc<Shares>> {
    current().ok_or_else(|| http(503, "This hub doesn't share blueprints."))
}

fn epoch_of() -> impl Fn(&str, &str) -> u64 {
    let p = crate::pages::pages();
    move |h: &str, s: &str| p.epochs.of(h, s)
}

/// The link a share opens: a path on the hub's own address for your network (the app puts the
/// address it reached the hub at in front), the full address for anyone.
fn link_of(s: &Shares, share: &Share, token: &str) -> String {
    let path = format!("{SHARE_PREFIX}{token}/");
    match (share.public, s.address()) {
        (true, Some(a)) => format!("{a}{path}"),
        _ => path,
    }
}

fn listing(s: &Shares, links: Vec<Share>) -> Value {
    json!({ "address": s.address(), "fromEnv": s.address_from_env(), "upstream": upstream(), "links": links.iter().map(Share::to_json).collect::<Vec<_>>() })
}

/// Where a proxy on this machine reaches the hub, for the setup's examples: its port on loopback
/// when it listens on every address, else the address it listens on.
fn upstream() -> String {
    let c = crate::server::ctx();
    let host = match c.bind.as_str() {
        "" | "0.0.0.0" | "::" | "[::]" => "127.0.0.1".to_owned(),
        b if b.contains(':') && !b.starts_with('[') => format!("[{b}]"),
        b => b.to_owned(),
    };
    format!("{host}:{}", c.port)
}

/// The answer on the public address to a probe from `check`: 200 with the answer while it's live,
/// else the same 404 as any other path there.
pub fn probe_reply(nonce: &str, head: bool) -> Resp {
    let answer = current().and_then(|s| s.probe_answer(nonce.trim_end_matches('/'), now()));
    let Some(answer) = answer else { return not_here(head) };
    let headers = view_headers(&ViewHeaderInput { no_store: true, content_type: Some("text/plain;charset=utf-8"), shared: true, ..Default::default() });
    let mut res = Resp::new(if head { Body::empty() } else { Body::from(answer) });
    for (k, v) in &headers {
        if let Ok(v) = HeaderValue::from_str(v) {
            res.headers_mut().append(HeaderName::from_static(k), v);
        }
    }
    res
}

/// What went wrong reaching the public address, from the HTTP client's message.
pub fn fault_of(message: &str) -> &'static str {
    let m = message.to_ascii_lowercase();
    if ["certificate", "tls", "handshake", "unknownissuer", "notvalidforname"].iter().any(|k| m.contains(k)) {
        "tls"
    } else if ["dns", "resolve", "lookup", "no such host", "name or service", "nodename"].iter().any(|k| m.contains(k)) {
        "dns"
    } else if m.contains("refused") {
        "refused"
    } else if ["timeout", "timed out", "couldn't connect"].iter().any(|k| m.contains(k)) {
        "timeout"
    } else {
        "other"
    }
}

/// POST /api/share-address/check: whether links for anyone open at the public address. Looks the
/// name up, then asks `/share/.inyon-check/<nonce>` there and expects the answer only this hub
/// knows, which proves the name, the certificate and the proxy all lead here; then asks `/` and
/// `/api/session`, which the proxy shouldn't forward. Only the saved address is checked, and only
/// by the signed-in app.
pub async fn check(_req: Req) -> HubResult<Resp> {
    let s = shares()?;
    let address = s.address().ok_or_else(|| http(409, NO_ADDRESS))?;
    let u = url::Url::parse(&address).map_err(|_| http(400, BAD_ADDRESS))?;
    let name = u.host_str().unwrap_or_default().trim_start_matches('[').trim_end_matches(']').to_owned();
    let port = u.port_or_known_default().unwrap_or(443);
    let timeout = std::time::Duration::from_secs(10);

    let dns = match tokio::time::timeout(timeout, tokio::net::lookup_host((name.as_str(), port))).await {
        Ok(Ok(addrs)) => {
            let mut ips: Vec<String> = addrs.map(|a| a.ip().to_string()).collect();
            ips.sort();
            ips.dedup();
            json!({ "ok": !ips.is_empty(), "addresses": ips })
        }
        Ok(Err(e)) => json!({ "ok": false, "addresses": [], "error": e.to_string() }),
        Err(_) => json!({ "ok": false, "addresses": [], "error": "the lookup timed out" }),
    };
    if dns["ok"] != json!(true) {
        return Ok(ok_json(&json!({ "address": address, "dns": dns, "reach": { "ok": false, "fault": "dns" }, "wall": { "ok": false, "open": [] } })));
    }

    let (nonce, answer) = s.start_probe(now());
    let reach = match inyon_engine::http::fetch("GET", format!("{address}{CHECK_PREFIX}{nonce}"), vec![], None, timeout).await {
        Ok(r) if r.status == 200 && String::from_utf8_lossy(&r.body).trim() == answer => json!({ "ok": true }),
        Ok(r) => json!({ "ok": false, "fault": "not-hub", "status": r.status }),
        Err(e) => json!({ "ok": false, "fault": fault_of(&e), "error": e }),
    };
    *s.probe.borrow_mut() = None;

    // what else answers there: nothing but /share/ should
    let mut open = Vec::new();
    if reach["ok"] == json!(true) {
        for path in ["/", "/api/session"] {
            if let Ok(r) = inyon_engine::http::fetch("GET", format!("{address}{path}"), vec![], None, timeout).await {
                if (200..400).contains(&r.status) {
                    open.push(json!({ "path": path, "status": r.status }));
                }
            }
        }
    }
    let wall = json!({ "ok": reach["ok"] == json!(true) && open.is_empty(), "open": open });
    Ok(ok_json(&json!({ "address": address, "dns": dns, "reach": reach, "wall": wall })))
}

/// GET /api/pages/:host/:slug/shares: the page's live links and the public address.
pub async fn page_shares(req: Req) -> HubResult<Resp> {
    let s = shares()?;
    let p = crate::pages::pages();
    let host = req.param("host");
    let r = p.page(&host, &req.param("slug")).await?;
    let links = s.live(now(), &epoch_of()).into_iter().filter(|x| x.host == host && x.slug == r.slug).collect();
    Ok(ok_json(&listing(&s, links)))
}

/// POST /api/pages/:host/:slug/shares `{public, days}`: a new link, shown this once.
pub async fn share_page(mut req: Req) -> HubResult<Resp> {
    let s = shares()?;
    let b = req.json_body(4 * 1024).await?;
    let public = match b.get("public") {
        None => false,
        Some(Value::Bool(v)) => *v,
        Some(_) => return Err(http(400, "public must be true or false")),
    };
    let days = match b.get("days") {
        None => 7,
        Some(v) => v.as_u64().ok_or_else(|| http(400, BAD_DAYS))?,
    };
    let p = crate::pages::pages();
    let host = req.param("host");
    let r = p.page(&host, &req.param("slug")).await?;
    let (token, share) = s.create(&host, &r.slug, public, days, now(), &epoch_of())?;
    let mut v = share.to_json();
    v["url"] = json!(link_of(&s, &share, &token));
    Ok(ok_json(&v))
}

/// DELETE /api/pages/:host/:slug/shares/:id and DELETE /api/shares/:id: ends one link.
pub async fn unshare(req: Req) -> HubResult<Resp> {
    let s = shares()?;
    let id = req.param("id");
    let (host, slug) = (req.param("host"), req.param("slug"));
    let gone = s.revoke_where(now(), |x| x.id == id && (host.is_empty() || (x.host == host && x.slug == slug)))?;
    if gone == 0 {
        return Err(http(404, UNKNOWN_SHARE));
    }
    Ok(ok())
}

/// GET /api/shares: every live link, with the public address and whether INYON_SHARE_ORIGIN set it.
pub async fn all(_req: Req) -> HubResult<Resp> {
    let s = shares()?;
    let links = s.live(now(), &epoch_of());
    Ok(ok_json(&listing(&s, links)))
}

/// DELETE /api/shares: ends every link; how many went.
pub async fn revoke_all(_req: Req) -> HubResult<Resp> {
    let s = shares()?;
    let n = s.revoke_where(now(), |_| true)?;
    Ok(ok_json(&json!({ "revoked": n })))
}

/// PUT /api/share-address `{address}`: the public share address from Settings ("" clears it). The
/// address the request came in on is refused: the app would stop opening there.
pub async fn set_address(mut req: Req) -> HubResult<Resp> {
    let s = shares()?;
    let b = req.json_body(4 * 1024).await?;
    let given = match b.get("address") {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(a)) => a.clone(),
        Some(_) => return Err(http(400, BAD_ADDRESS)),
    };
    let address = normalize_address(&given).map_err(|m| http(400, m))?;
    if let Some(name) = address.as_deref().and_then(name_of_origin) {
        if request_names(&req).contains(&name) {
            return Err(http(400, SAME_ADDRESS));
        }
    }
    s.set_address(address, now())?;
    let links = s.live(now(), &epoch_of());
    Ok(ok_json(&listing(&s, links)))
}

/// The API routes, behind sign-in. The inyon command and companions can't use them.
pub fn add(r: &mut Routes) {
    guarded(r, "/api/shares", vec![(Method::GET, h(all)), (Method::DELETE, h(revoke_all))]);
    guarded(r, "/api/shares/:id", vec![(Method::DELETE, h(unshare))]);
    guarded(r, "/api/share-address", vec![(Method::PUT, h(set_address))]);
    guarded(r, "/api/share-address/check", vec![(Method::POST, h(check))]);
    guarded(r, "/api/pages/:host/:slug/shares", vec![(Method::GET, h(page_shares)), (Method::POST, h(share_page))]);
    guarded(r, "/api/pages/:host/:slug/shares/:id", vec![(Method::DELETE, h(unshare))]);
}

/// A line in the log when INYON_SHARE_ORIGIN names a host INYON_ALLOWED_HOSTS or
/// INYON_ALLOWED_ORIGINS lists too: there the hub answers shared links only.
pub fn warn_overlap(allowed_hosts: Option<&str>, allowed_origins: Option<&str>) {
    let Some(name) = current().and_then(|s| s.share_name()) else { return };
    let listed = allowed_hosts.unwrap_or("").split(',').filter_map(name_of_host).any(|h| h == name)
        || allowed_origins.unwrap_or("").split(',').filter_map(|o| name_of_origin(o.trim())).any(|h| h == name);
    if listed {
        inyon_core::platform::console::log(&format!(
            "{name} is the address for shared links, so the hub answers only /share/ there, though INYON_ALLOWED_HOSTS or INYON_ALLOWED_ORIGINS lists it too."
        ));
    }
}

#[cfg(test)]
#[path = "shares_tests.rs"]
mod tests;
