//! The server half of index.ts: the route table Bun.serve had, the checks every API route goes
//! through (the hub's own names, same origin, sign-in, CORS for the phone app), the fallback for
//! everything else (the WebSocket upgrades, the web app's files), and the listener itself.
//!
//! Threading. Everything the hub keeps (its records, the registry and chat watchers of
//! inyon-core, sign-ins, phones, open connections) lives on one thread, the core's, as the TS
//! hub lived on Bun's one event loop. The listener runs on that same thread's tokio runtime. axum
//! hands each request to one handler that sends it, whole, to the core as a job of its own
//! (`CoreHandle::call`) and waits for the answer. Two things follow: no route races another on
//! shared state, since a synchronous stretch on the core thread is never interleaved, and a
//! request whose client goes away still runs to its end, since dropping the handler only drops
//! the wait for the answer, not the job. WebSockets are the same: the socket's own task only
//! moves frames, and every frame is handled on the core thread in the order it came.

use std::cell::{Cell, RefCell};
use std::collections::HashSet;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::rc::Rc;

use axum::extract::{ConnectInfo, Request, State};
use axum::http::Method;
use futures_util::future::LocalBoxFuture;
use inyon_backends::CoreHandle;
use inyon_core::hosts::http_error::HubResult;
use inyon_core::platform::console;

use crate::auth::is_authed;
use crate::http::{answer, json, set_header, text, Req, Resp};
use crate::phones::has_bearer;

pub type Handler = Rc<dyn Fn(Req) -> LocalBoxFuture<'static, Resp>>;
type KnownHost = Box<dyn Fn(Option<&str>) -> bool>;
pub type ApiHandler = Rc<dyn Fn(Req) -> LocalBoxFuture<'static, HubResult<Resp>>>;

/// An async closure as an API handler.
pub fn h<F, Fut>(f: F) -> ApiHandler
where
    F: Fn(Req) -> Fut + 'static,
    Fut: std::future::Future<Output = HubResult<Resp>> + 'static,
{
    Rc::new(move |r| Box::pin(f(r)))
}

/// An async closure as a plain handler (no checks, no error mapping).
pub fn raw<F, Fut>(f: F) -> Handler
where
    F: Fn(Req) -> Fut + 'static,
    Fut: std::future::Future<Output = Resp> + 'static,
{
    Rc::new(move |r| Box::pin(f(r)))
}

/// What one path answers: every method with one handler, or some methods each with its own.
pub enum Route {
    Any(Handler),
    Methods(Vec<(Method, Handler)>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Seg {
    Static(String),
    Param(String),
}

fn segments(pattern: &str) -> Vec<Seg> {
    pattern.split('/').skip(1).map(|s| s.strip_prefix(':').map_or_else(|| Seg::Static(s.to_owned()), |p| Seg::Param(p.to_owned()))).collect()
}

/// Bun's routes: a path matches a pattern segment for segment, a `:name` takes any one segment,
/// and where two patterns match, the one with a fixed segment earlier wins.
#[derive(Default)]
pub struct Routes(Vec<(Vec<Seg>, Route)>);

impl Routes {
    pub fn add(&mut self, pattern: &str, r: Route) {
        self.0.push((segments(pattern), r));
    }

    pub fn methods(&mut self, pattern: &str, list: Vec<(Method, Handler)>) {
        self.add(pattern, Route::Methods(list));
    }

    pub fn find(&self, path: &str) -> Option<(&Route, Vec<(String, String)>)> {
        let parts: Vec<&str> = path.split('/').skip(1).collect();
        let mut best: Option<(&Vec<Seg>, &Route)> = None;
        for (segs, route) in &self.0 {
            if segs.len() != parts.len() || !segs.iter().zip(&parts).all(|(s, p)| matches!(s, Seg::Param(_)) && !p.is_empty() || matches!(s, Seg::Static(x) if x == p)) {
                continue;
            }
            let better = match best {
                None => true,
                Some((b, _)) => {
                    let first_diff = segs.iter().zip(b.iter()).find(|(x, y)| matches!(x, Seg::Static(_)) != matches!(y, Seg::Static(_)));
                    matches!(first_diff, Some((Seg::Static(_), _)))
                }
            };
            if better {
                best = Some((segs, route));
            }
        }
        let (segs, route) = best?;
        let params = segs
            .iter()
            .zip(&parts)
            .filter_map(|(s, p)| match s {
                Seg::Param(name) => Some((name.clone(), crate::http::decode_uri_component(p).unwrap_or_else(|| (*p).to_owned()))),
                Seg::Static(_) => None,
            })
            .collect();
        Some((route, params))
    }
}

// ---------- the hub's settings and state on the core thread ----------

/// What index.ts worked out as it started, for every route.
pub struct HubCtx {
    pub data_dir: PathBuf,
    pub bind: String,
    pub port: u16,
    pub tls: bool,
    /// INYON_ALLOWED_ORIGINS
    pub allowed_origins: HashSet<String>,
    known_host: KnownHost,
    /// this machine's names on its private networks, found as the hub starts
    pub network_names: Rc<RefCell<HashSet<String>>>,
    refused_hosts: RefCell<HashSet<String>>,
    /// the first-run code, while the hub has no password
    pub setup_code: RefCell<Option<String>>,
    pub setup_attempts: Cell<(u32, u64)>,
    pub local_token: String,
    pub hub_commit: String,
    pub core: CoreHandle,
}

thread_local! {
    static CTX: RefCell<Option<Rc<HubCtx>>> = const { RefCell::new(None) };
    static ROUTES: RefCell<Option<Rc<Routes>>> = const { RefCell::new(None) };
}

impl HubCtx {
    /// Whether a Host header names this hub (see hostnames), with no cookie looked at.
    pub fn answers_to(&self, host: &str) -> bool {
        (self.known_host)(Some(host))
    }
}

/// The hub's context; only on the core thread, once the hub has started.
pub fn ctx() -> Rc<HubCtx> {
    CTX.with(|c| c.borrow().clone()).expect("the hub has started on this thread")
}

pub struct CtxInit {
    pub data_dir: PathBuf,
    pub bind: String,
    pub port: u16,
    pub tls: bool,
    pub allowed_hosts: Option<String>,
    pub allowed_origins: Option<String>,
    pub hostname: String,
    pub setup_code: Option<String>,
    pub local_token: String,
    pub hub_commit: String,
    pub core: CoreHandle,
}

pub fn install_ctx(i: CtxInit, routes: Routes) {
    let network_names = Rc::new(RefCell::new(HashSet::new()));
    let allowed_origins = i.allowed_origins.as_deref().unwrap_or("").split(',').map(|o| o.trim().trim_end_matches('/').to_owned()).filter(|o| !o.is_empty()).collect();
    let known = crate::hostnames::allowed_hosts(i.allowed_hosts.as_deref(), i.allowed_origins.as_deref(), &i.hostname, &i.bind, network_names.clone());
    let c = HubCtx {
        data_dir: i.data_dir,
        bind: i.bind,
        port: i.port,
        tls: i.tls,
        allowed_origins,
        known_host: Box::new(known),
        network_names,
        refused_hosts: RefCell::new(HashSet::new()),
        setup_code: RefCell::new(i.setup_code),
        setup_attempts: Cell::new((0, 0)),
        local_token: i.local_token,
        hub_commit: i.hub_commit,
        core: i.core,
    };
    CTX.with(|x| *x.borrow_mut() = Some(Rc::new(c)));
    ROUTES.with(|r| *r.borrow_mut() = Some(Rc::new(routes)));
}

// ---------- the checks ----------

/// A browser request made by this app's own pages. Other sites can share the hub's cookie when they
/// run on the same host (a dev server on another port, a sibling subdomain), so anything that
/// changes state, and the WebSocket, must come from the hub's own origin. Requests without an
/// Origin header don't come from a web page (curl, the node agent) and carry no ambient cookie risk.
pub fn same_origin(req: &Req) -> bool {
    let Some(origin) = req.header("origin") else { return true };
    if ctx().allowed_origins.contains(&origin) {
        return true;
    }
    let host = req.header("x-forwarded-host").or_else(|| req.header("host"));
    match (host, url::Url::parse(&origin)) {
        (Some(host), Ok(u)) => !host.is_empty() && url_host(&u) == host,
        _ => false,
    }
}

/// `new URL(origin).host`: the hostname with the port when it isn't the scheme's default.
fn url_host(u: &url::Url) -> String {
    let h = match u.host() {
        Some(url::Host::Ipv6(a)) => format!("[{a}]"),
        Some(h) => h.to_string(),
        None => String::new(),
    };
    match u.port() {
        Some(p) => format!("{h}:{p}"),
        None => h,
    }
}

pub const WRONG_HOST: &str = "This hub doesn't answer to that address. If it's yours, add it to INYON_ALLOWED_HOSTS on the hub.";

/// Sent to a name the hub answers to (see hostnames), including the one a local proxy forwards.
/// A signed-in browser passes under any name: its cookie can only have been set by the hub itself.
pub fn right_host(req: &Req) -> bool {
    if is_authed(req) {
        return true;
    }
    let c = ctx();
    let mut names: Vec<String> = req.header("host").into_iter().collect();
    if let Some(f) = req.header("x-forwarded-host") {
        names.extend(f.split(',').map(|h| h.trim().to_owned()));
    }
    let wrong = names.iter().find(|h| !(c.known_host)(Some(h))).cloned().or_else(|| names.is_empty().then(|| "(none)".to_owned()));
    let Some(wrong) = wrong else { return true };
    let mut refused = c.refused_hosts.borrow_mut();
    if !refused.contains(&wrong) && refused.len() < 50 {
        refused.insert(wrong.clone());
        let shown: String = wrong.chars().take(200).collect();
        console::log(&format!("Refused a request for host {}. If that is this hub's address, add it to INYON_ALLOWED_HOSTS.", serde_json::Value::String(shown)));
    }
    false
}

/// The phone app runs on an origin of its own and signs in with a bearer token, so its requests
/// are cross-origin and need CORS answers. That is safe where no cookie is read: a request with a
/// bearer is judged by the bearer alone (see is_authed), and these two routes never look at one.
const CORS_PATHS: [&str; 2] = ["/api/phones/claim", "/api/phones/ticket"];

fn phone_request(req: &Req) -> bool {
    has_bearer(req) || CORS_PATHS.contains(&req.path.as_str())
}

/// A call from a page with no origin of its own (a sandboxed frame, such as a page served under
/// /v/) or from another site. The browser may still attach the hub's cookie, so these are refused
/// for every method, reads included. A bearer request carries no ambient credential and passes.
fn framed_caller(req: &Req) -> bool {
    let origin = req.header("origin");
    if origin.as_deref() == Some("null") {
        return true;
    }
    req.header("sec-fetch-site").as_deref() == Some("cross-site") && !origin.is_some_and(|o| ctx().allowed_origins.contains(&o))
}

fn allow_origin(mut res: Resp, origin: &str) -> Resp {
    set_header(&mut res, "access-control-allow-origin", origin);
    set_header(&mut res, "vary", "Origin");
    set_header(&mut res, "access-control-allow-headers", "authorization, content-type");
    set_header(&mut res, "access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE");
    res
}

fn cors(req_origin: Option<&str>, phone: bool, res: Resp) -> Resp {
    match req_origin {
        Some(o) if phone => allow_origin(res, o),
        _ => res,
    }
}

/// A preflight carries no token yet; the one for a bearer request names the header it will send.
pub fn preflight(req: &Req) -> Option<Resp> {
    if req.method != Method::OPTIONS {
        return None;
    }
    let asked = req.header("access-control-request-headers").unwrap_or_default();
    let for_bearer = inyon_core::re!(r"(?i)\bauthorization\b").is_match(&asked);
    if !req.path.starts_with("/api/") || !(for_bearer || CORS_PATHS.contains(&req.path.as_str())) {
        return None;
    }
    if !right_host(req) {
        return Some(json(421, &serde_json::json!({ "error": WRONG_HOST })));
    }
    let mut res = text(204, "");
    res.headers_mut().remove("content-type");
    set_header(&mut res, "access-control-max-age", "600");
    Some(match req.header("origin") {
        Some(o) => allow_origin(res, &o),
        None => res,
    })
}

/// Who may call an API route: `open` needs no sign-in; `owner` refuses a paired phone (the hub's
/// own account is the browser's to manage).
#[derive(Clone, Copy, Default)]
pub struct Opts {
    pub open: bool,
    pub owner: bool,
}

pub const OPEN: Opts = Opts { open: true, owner: false };
pub const OWNER: Opts = Opts { open: false, owner: true };
pub const OPEN_OWNER: Opts = Opts { open: true, owner: true };

/// `api(fn, opts)`: an API handler behind the hub's checks, its errors as JSON.
pub fn api(f: ApiHandler, o: Opts) -> Handler {
    Rc::new(move |req: Req| {
        let f = f.clone();
        Box::pin(async move {
            if let Some(pre) = preflight(&req) {
                return pre;
            }
            if !right_host(&req) {
                return json(421, &serde_json::json!({ "error": WRONG_HOST }));
            }
            let origin = req.header("origin");
            let phone = phone_request(&req);
            if o.owner && has_bearer(&req) {
                return cors(origin.as_deref(), phone, json(403, &serde_json::json!({ "error": "Not from a phone. Do this in the browser." })));
            }
            if !phone && framed_caller(&req) {
                return json(403, &serde_json::json!({ "error": "Cross-site request refused" }));
            }
            // a bearer request carries no ambient credential, so CSRF doesn't apply to it
            if req.method != Method::GET && req.method != Method::HEAD && !phone && !same_origin(&req) {
                return json(403, &serde_json::json!({ "error": "Cross-site request refused" }));
            }
            if !o.open && !is_authed(&req) {
                return cors(origin.as_deref(), phone, json(401, &serde_json::json!({ "error": "Not signed in" })));
            }
            let res = answer(f(req).await);
            cors(origin.as_deref(), phone, res)
        })
    })
}

/// The shared routes, each method behind sign-in (`guarded`).
pub fn guarded(routes: &mut Routes, pattern: &str, list: Vec<(Method, ApiHandler)>) {
    routes.methods(pattern, list.into_iter().map(|(m, f)| (m, api(f, Opts::default()))).collect());
}

/// The same for handlers that make their own answers.
pub fn guarded_raw(routes: &mut Routes, pattern: &str, list: Vec<(Method, Handler)>) {
    let wrap = |f: Handler| -> ApiHandler {
        Rc::new(move |r| {
            let f = f.clone();
            Box::pin(async move { Ok(f(r).await) })
        })
    };
    routes.methods(pattern, list.into_iter().map(|(m, f)| (m, api(wrap(f), Opts::default()))).collect());
}

// ---------- requests ----------

/// Answers one request on the core thread: its route if one matches, else the fallback.
pub async fn dispatch(mut req: Req) -> Resp {
    let routes = ROUTES.with(|r| r.borrow().clone()).expect("routes");
    let handler = match routes.find(&req.path) {
        Some((Route::Any(h), params)) => Some((h.clone(), params)),
        Some((Route::Methods(list), params)) => list.iter().find(|(m, _)| *m == req.method || (req.method == Method::HEAD && *m == Method::GET)).map(|(_, h)| (h.clone(), params)),
        None => None,
    };
    if let Some((h, params)) = handler {
        req.params = params;
        return h(req).await;
    }
    fallback(req).await
}

/// Bun.serve's `fetch`: what no route took.
async fn fallback(req: Req) -> Resp {
    if req.path == "/node" {
        return crate::ws::node_upgrade(req).await;
    }
    if req.path == "/ws" {
        return crate::ws::app_upgrade(req);
    }
    // a page's own files: the token in the path is the only credential, never the cookie, and the
    // Host is checked there without one (pages::view)
    if req.path.starts_with("/v/") {
        return crate::pages::view(req).await;
    }
    // a route that only lists some methods leaves OPTIONS to land here
    if let Some(pre) = preflight(&req) {
        return pre;
    }
    if req.path.starts_with("/api/") {
        return json(404, &serde_json::json!({ "error": "Not found" }));
    }
    if !right_host(&req) {
        let mut r = text(421, format!("{WRONG_HOST}\n"));
        crate::static_files::page_headers(&mut r);
        return r;
    }
    crate::static_files::serve(&req.path)
}

// ---------- the listener ----------

#[derive(Clone)]
struct App {
    core: CoreHandle,
    https: bool,
}

/// The one axum handler: the request goes to the core thread whole, as a job of its own.
async fn handle(State(app): State<App>, ConnectInfo(Peer(peer)): ConnectInfo<Peer>, req: Request) -> Resp {
    let (mut parts, body) = req.into_parts();
    let upgrade = parts.extensions.remove::<hyper::upgrade::OnUpgrade>();
    // dot segments resolved as Bun's req.url resolves them, so both hubs route the same path
    let (path, _) = inyon_core::features::pages_core::normalize_target(parts.uri.path());
    let r = Req {
        method: parts.method,
        path,
        query: parts.uri.query().unwrap_or("").to_owned(),
        headers: parts.headers,
        peer,
        https: app.https,
        body: Some(body),
        params: vec![],
        upgrade,
    };
    match app.core.call(move || dispatch(r)).await {
        // a page's file is read here, off the core's job (pages::view only named it)
        Ok(mut res) => match res.extensions_mut().remove::<crate::pages::ViewFile>() {
            Some(f) => {
                *res.body_mut() = crate::pages::file_body(f.path, f.size);
                res
            }
            None => res,
        },
        // the job panicked (and only it ended), or the hub is stopping
        Err(e) => json(500, &serde_json::json!({ "error": e.to_string() })),
    }
}

/// The client's address, from a plain or a TLS connection.
#[derive(Clone, Copy, Debug)]
pub struct Peer(pub SocketAddr);

type PlainListener = crate::idle::IdleListener<tokio::net::TcpListener>;
type SecureListener = crate::idle::IdleListener<crate::tls::TlsListener>;

impl axum::extract::connect_info::Connected<axum::serve::IncomingStream<'_, PlainListener>> for Peer {
    fn connect_info(s: axum::serve::IncomingStream<'_, PlainListener>) -> Self {
        Peer(*s.remote_addr())
    }
}

impl axum::extract::connect_info::Connected<axum::serve::IncomingStream<'_, SecureListener>> for Peer {
    fn connect_info(s: axum::serve::IncomingStream<'_, SecureListener>) -> Self {
        Peer(*s.remote_addr())
    }
}

pub fn router(core: CoreHandle, https: bool) -> axum::Router {
    axum::Router::new().fallback(handle).with_state(App { core, https })
}

/// Starts serving on `listener` (TLS when `tls` holds a config), on this thread's runtime.
pub fn serve(listener: tokio::net::TcpListener, tls: Option<std::sync::Arc<rustls::ServerConfig>>, core: CoreHandle) {
    let app = router(core, tls.is_some()).into_make_service_with_connect_info::<Peer>();
    match tls {
        None => {
            let l = crate::idle::IdleListener::new(listener, crate::idle::IDLE);
            tokio::spawn(async move {
                if let Err(e) = axum::serve(l, app).await {
                    console::error(&format!("the hub's server stopped: {e}"));
                }
            });
        }
        Some(cfg) => {
            let l = crate::idle::IdleListener::new(crate::tls::TlsListener::new(listener, cfg), crate::idle::IDLE);
            tokio::spawn(async move {
                if let Err(e) = axum::serve(l, app).await {
                    console::error(&format!("the hub's server stopped: {e}"));
                }
            });
        }
    }
}

/// A request for the tests: method, path with query, headers.
#[cfg(test)]
pub fn test_req(method: &str, path_q: &str, headers: &[(&str, &str)], body: &str) -> Req {
    let (path, query) = path_q.split_once('?').unwrap_or((path_q, ""));
    let mut h = axum::http::HeaderMap::new();
    for (k, v) in headers {
        h.append(axum::http::HeaderName::from_bytes(k.as_bytes()).unwrap(), v.parse().unwrap());
    }
    Req {
        method: method.parse().unwrap(),
        path: path.to_owned(),
        query: query.to_owned(),
        headers: h,
        peer: "127.0.0.1:50000".parse().unwrap(),
        https: false,
        body: Some(axum::body::Body::from(body.to_owned())),
        params: vec![],
        upgrade: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn table() -> Routes {
        let mut r = Routes::default();
        let none: Handler = raw(|_| async { text(200, "") });
        r.methods("/api/hosts/pair", vec![(Method::POST, none.clone())]);
        r.methods("/api/hosts/:id", vec![(Method::PATCH, none.clone())]);
        r.methods("/api/hosts/:id/panes/:pane/send", vec![(Method::POST, none.clone())]);
        r.methods("/api/phones/claim", vec![(Method::POST, none.clone())]);
        r.methods("/api/phones/:id", vec![(Method::DELETE, none)]);
        r
    }

    #[test]
    fn a_fixed_segment_beats_a_parameter_and_parameters_are_decoded() {
        let t = table();
        let (_, p) = t.find("/api/hosts/pair").unwrap();
        assert!(p.is_empty());
        let (_, p) = t.find("/api/hosts/my%20box/panes/12/send").unwrap();
        assert_eq!(p, vec![("id".into(), "my box".into()), ("pane".into(), "12".into())]);
        let (_, p) = t.find("/api/phones/claim").unwrap();
        assert!(p.is_empty());
        assert!(t.find("/api/hosts/").is_none());
        assert!(t.find("/api/hosts/a/b").is_none());
    }
}
