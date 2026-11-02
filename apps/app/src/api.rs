//! The hub's HTTP API, the same endpoints, bodies and cookie the web app uses (apps/web/src/lib/api.ts).

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq)]
pub struct ApiError {
    pub status: u16,
    pub message: String,
}

impl ApiError {
    fn new(status: u16, message: impl Into<String>) -> Self {
        ApiError { status, message: message.into() }
    }
}

/// `GET /api/session`: signed in or not, and whether this hub still needs its first password.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    #[serde(default)]
    pub authed: bool,
    #[serde(default)]
    pub setup: bool,
    /// the first password also needs the code the hub printed when it started
    #[serde(default)]
    pub setup_code: bool,
}

#[derive(Serialize)]
struct Login<'a> {
    password: &'a str,
}

#[derive(Serialize)]
struct Setup<'a> {
    password: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<&'a str>,
}

/// `POST …/answer`: the option picked, a typed answer for a free-text option, and the question it
/// answers ([`inyon_protocol::prompt_key`]), so an answer that arrives late isn't taken for the next
/// question.
#[derive(Serialize)]
pub struct Answer<'a> {
    pub option: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub question: Option<&'a str>,
}

/// `POST …/send`: a message typed into the agent's terminal. The same `requestId` on every try, so
/// the hub submits it once however many times it arrives.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Send<'a> {
    pub text: &'a str,
    pub request_id: &'a str,
}

#[derive(Serialize)]
struct Keys<'a> {
    keys: &'a [&'a str],
}

#[derive(Serialize)]
struct Text<'a> {
    text: &'a str,
}

/// The hub's error text (`{ "error": "…" }`), or the status when it gave none.
pub fn error_of(status: u16, body: &str) -> ApiError {
    #[derive(Deserialize)]
    struct E {
        error: Option<String>,
    }
    let msg = serde_json::from_str::<E>(body).ok().and_then(|e| e.error).unwrap_or_else(|| format!("Request failed ({status})"));
    ApiError::new(status, msg)
}

/// What the first-password form checks before it asks the hub.
pub fn check_new_password(password: &str, confirm: &str) -> Result<(), String> {
    if password.chars().count() < 8 {
        return Err("Use at least 8 characters.".into());
    }
    if password != confirm {
        return Err("The two passwords don't match.".into());
    }
    Ok(())
}

pub async fn session() -> Result<Session, ApiError> {
    let body = request("GET", "/api/session", None).await?;
    serde_json::from_str(&body).map_err(|e| ApiError::new(0, e.to_string()))
}

pub async fn login(password: &str) -> Result<(), ApiError> {
    request("POST", "/api/login", Some(serde_json::to_string(&Login { password }).unwrap())).await.map(drop)
}

pub async fn create_password(password: &str, code: Option<&str>) -> Result<(), ApiError> {
    request("POST", "/api/setup", Some(serde_json::to_string(&Setup { password, code }).unwrap())).await.map(drop)
}

/// `/api/hosts/<machine>/panes/<pane without %>`, as api.ts's `panePath`.
pub fn pane_path(host: &str, pane: &str) -> String {
    format!("/api/hosts/{}/panes/{}", inyon_chat_core::js::encode_uri_component(host), inyon_chat_core::overview::pane_slug(pane))
}

/// Picks one of the answers a waiting agent offers.
pub async fn answer(host: &str, pane: &str, a: &Answer<'_>) -> Result<(), ApiError> {
    request("POST", &format!("{}/answer", pane_path(host, pane)), Some(serde_json::to_string(a).unwrap())).await.map(drop)
}

/// Sends a message, trying again while the connection hiccups.
pub async fn send(host: &str, pane: &str, text: &str, request_id: &str) -> Result<(), ApiError> {
    let body = serde_json::to_string(&Send { text, request_id }).unwrap();
    let path = format!("{}/send", pane_path(host, pane));
    with_retries(|| request("POST", &path, Some(body.clone()))).await.map(drop)
}

/// Stops the agent's turn (Esc in its terminal).
pub async fn interrupt(host: &str, pane: &str) -> Result<(), ApiError> {
    request("POST", &format!("{}/interrupt", pane_path(host, pane)), None).await.map(drop)
}

/// Presses keys in the agent's terminal (a question's Cancel is Escape).
pub async fn keys(host: &str, pane: &str, keys: &[&str]) -> Result<(), ApiError> {
    request("POST", &format!("{}/keys", pane_path(host, pane)), Some(serde_json::to_string(&Keys { keys }).unwrap())).await.map(drop)
}

/// Types the answer a dialog's input asks for (a sign-in code).
pub async fn input(host: &str, pane: &str, text: &str) -> Result<(), ApiError> {
    request("POST", &format!("{}/input", pane_path(host, pane)), Some(serde_json::to_string(&Text { text }).unwrap())).await.map(drop)
}

/// Holds a message until the agent is free; the hub types it in then.
pub async fn hold(host: &str, pane: &str, text: &str) -> Result<(), ApiError> {
    request("POST", &format!("{}/held", pane_path(host, pane)), Some(serde_json::to_string(&Text { text }).unwrap())).await.map(drop)
}

/// A dropped connection or a busy server, as opposed to a refusal that a retry won't change.
pub fn is_transient(e: &ApiError) -> bool {
    e.status == 0 || e.status == 408 || e.status == 429 || e.status >= 500
}

/// Runs `f` again when the connection hiccups: up to three more tries, waiting longer each time.
async fn with_retries<F, Fut>(mut f: F) -> Result<String, ApiError>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<String, ApiError>>,
{
    for wait in [700, 2000, 5000] {
        match f().await {
            Err(e) if is_transient(&e) => crate::platform::sleep(wait).await,
            other => return other,
        }
    }
    f().await
}

// ---------- machines (pages/Machines.tsx and its sheets) ----------

/// `/api/hosts/<machine>`.
pub fn host_path(id: &str) -> String {
    format!("/api/hosts/{}", inyon_chat_core::js::encode_uri_component(id))
}

fn parse<T: serde::de::DeserializeOwned>(body: &str) -> Result<T, ApiError> {
    serde_json::from_str(body).map_err(|e| ApiError::new(0, e.to_string()))
}

fn json(v: &impl Serialize) -> Option<String> {
    Some(serde_json::to_string(v).expect("request bodies serialise"))
}

/// A machine reached over the hub's own SSH, as the Add and Edit sheets send it. A paired machine
/// or this hub sends only its name.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostBody {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub identity_file: Option<String>,
}

pub async fn add_host(b: &HostBody) -> Result<(), ApiError> {
    request("POST", "/api/hosts", json(b)).await.map(drop)
}

pub async fn update_host(id: &str, b: &HostBody) -> Result<(), ApiError> {
    request("PATCH", &host_path(id), json(b)).await.map(drop)
}

/// What removing a machine says: `untold` names a computer that still trusts this phone.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct Removed {
    #[serde(default)]
    pub untold: Option<String>,
}

pub async fn remove_host(id: &str) -> Result<Removed, ApiError> {
    let body = request("DELETE", &host_path(id), None).await?;
    Ok(serde_json::from_str(&body).unwrap_or_default())
}

/// A pairing command for a machine that connects out to the hub: one for macOS and Linux, one for
/// Windows when the hub has both.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Pairing {
    pub id: String,
    pub command: String,
    #[serde(default)]
    pub commands: Option<PairCommands>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct PairCommands {
    pub unix: String,
    pub windows: String,
}

#[derive(Serialize)]
struct PairBody<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<&'a str>,
    origin: &'a str,
}

/// A new machine to pair; `origin` is the address the machine reaches this hub at.
pub async fn pair(name: &str, origin: &str) -> Result<Pairing, ApiError> {
    parse(&request("POST", "/api/hosts/pair", json(&PairBody { name: Some(name), origin })).await?)
}

/// A fresh pairing command for a machine that never ran its first one; the old one stops working.
pub async fn repair(id: &str, origin: &str) -> Result<Pairing, ApiError> {
    parse(&request("POST", &format!("{}/pair", host_path(id)), json(&PairBody { name: None, origin })).await?)
}

#[derive(Serialize)]
struct Enable {
    enable: bool,
}

pub async fn integration(id: &str, enable: bool) -> Result<(), ApiError> {
    request("POST", &format!("{}/integration", host_path(id)), json(&Enable { enable })).await.map(drop)
}

/// Updates a machine's inyon; the overview reports how it goes.
pub async fn node_update(id: &str) -> Result<(), ApiError> {
    request("POST", &format!("{}/node/update", host_path(id)), None).await.map(drop)
}

/// A new session: an agent (or `shell`), where and how it starts. `sign_in` starts a terminal-first
/// agent's own sign-in instead.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Launch {
    pub agent: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub custom: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub sign_in: bool,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Started {
    pub pane: String,
}

pub async fn launch(id: &str, b: &Launch) -> Result<Started, ApiError> {
    parse(&request("POST", &format!("{}/launch", host_path(id)), json(b)).await?)
}

/// One of your own agents (Settings › Agents): any command, read as the agent it works like.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CustomAgent {
    pub id: String,
    pub name: String,
    pub command: String,
    pub like: inyon_protocol::AgentKind,
}

/// The hub's settings, as far as the screens here read them.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HubSettings {
    #[serde(default)]
    pub custom_agents: Option<Vec<CustomAgent>>,
}

pub async fn settings() -> Result<HubSettings, ApiError> {
    parse(&request("GET", "/api/settings", None).await?)
}

/// A check in a machine's Setup tab, with its fix when one is safe to run from here.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct SetupCheck {
    pub id: String,
    pub label: String,
    pub ok: bool,
    #[serde(default)]
    pub detail: Option<String>,
    #[serde(default)]
    pub fix: Option<SetupFix>,
    #[serde(default)]
    pub manual: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct SetupFix {
    pub label: String,
    pub action: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupAgent {
    pub kind: inyon_protocol::AgentKind,
    pub installed: bool,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub signed_in: bool,
    #[serde(default)]
    pub latest: Option<String>,
    #[serde(default)]
    pub outdated: bool,
    #[serde(default)]
    pub providers: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupReport {
    pub os: String,
    #[serde(default)]
    pub pkg: Option<String>,
    #[serde(default)]
    pub sudo: bool,
    pub checks: Vec<SetupCheck>,
    pub agents: Vec<SetupAgent>,
    #[serde(default)]
    pub keep_session: bool,
}

/// What a setup step came back with: a terminal to watch it in, or how it went.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct SetupResult {
    #[serde(default)]
    pub ok: bool,
    #[serde(default)]
    pub output: Option<String>,
    #[serde(default)]
    pub pane: Option<String>,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub manual: Option<String>,
    #[serde(default)]
    pub hint: Option<String>,
}

pub async fn setup(id: &str) -> Result<SetupReport, ApiError> {
    parse(&request("GET", &format!("{}/setup?catalog={}", host_path(id), inyon_protocol::compat::CATALOG), None).await?)
}

#[derive(Serialize)]
struct Action<'a> {
    action: &'a str,
}

pub async fn run_setup(id: &str, action: &str) -> Result<SetupResult, ApiError> {
    parse(&request("POST", &format!("{}/setup", host_path(id)), json(&Action { action })).await?)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct KeepSession {
    keep_session: bool,
}

pub async fn keep_session(id: &str, keep: bool) -> Result<(), ApiError> {
    request("POST", &format!("{}/setup", host_path(id)), json(&KeepSession { keep_session: keep })).await.map(drop)
}

pub async fn providers(id: &str, pane: Option<&str>) -> Result<inyon_protocol::ProvidersReport, ApiError> {
    let q = pane.map(|p| format!("?pane={}", inyon_chat_core::js::encode_uri_component(inyon_chat_core::overview::pane_slug(p)))).unwrap_or_default();
    parse(&request("GET", &format!("{}/providers{q}", host_path(id)), None).await?)
}

pub async fn connect_provider(id: &str, provider: &str) -> Result<Started, ApiError> {
    parse(&request("POST", &format!("{}/providers/{}", host_path(id), inyon_chat_core::js::encode_uri_component(provider)), None).await?)
}

pub async fn disconnect_provider(id: &str, provider: &str) -> Result<(), ApiError> {
    request("DELETE", &format!("{}/providers/{}", host_path(id), inyon_chat_core::js::encode_uri_component(provider)), None).await.map(drop)
}

/// An agent's sign-in as the hub reads it off the screen: its links, a code to type on the page, a
/// box it asks for, a menu, and how it ended.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct SignInScreen {
    #[serde(default)]
    pub lines: Vec<String>,
    #[serde(default)]
    pub links: Vec<String>,
    #[serde(default)]
    pub code: Option<String>,
    #[serde(default)]
    pub input: Option<SignInInput>,
    #[serde(default)]
    pub exit: Option<i32>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub menu: Option<SignInMenu>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct SignInInput {
    pub label: String,
    #[serde(default)]
    pub secret: bool,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct SignInMenu {
    #[serde(default)]
    pub question: Option<String>,
    pub options: Vec<SignInOption>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct SignInOption {
    pub n: u32,
    pub label: String,
    #[serde(default)]
    pub detail: Option<String>,
    #[serde(default)]
    pub selected: bool,
}

#[derive(Serialize)]
struct Agent<'a> {
    agent: &'a str,
}

/// What the sign-in sheet types or presses: a code, keys, or a menu's option.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct SignInSend {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub keys: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub option: Option<u32>,
}

fn signin_path(id: &str, pane: &str) -> String {
    format!("{}/signin/{}", host_path(id), inyon_chat_core::overview::pane_slug(pane))
}

pub async fn sign_in(id: &str, agent: inyon_protocol::AgentKind) -> Result<Started, ApiError> {
    parse(&request("POST", &format!("{}/signin", host_path(id)), json(&Agent { agent: agent.as_str() })).await?)
}

pub async fn sign_in_screen(id: &str, pane: &str) -> Result<SignInScreen, ApiError> {
    parse(&request("GET", &signin_path(id, pane), None).await?)
}

pub async fn sign_in_send(id: &str, pane: &str, b: &SignInSend) -> Result<(), ApiError> {
    request("POST", &signin_path(id, pane), json(b)).await.map(drop)
}

pub async fn sign_in_stop(id: &str, pane: &str) -> Result<(), ApiError> {
    request("DELETE", &signin_path(id, pane), None).await.map(drop)
}

/// What the app has sent to a machine: how much, where, and how many are past the hub's keep time.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct UploadUsage {
    pub dir: String,
    pub files: u64,
    pub bytes: f64,
    #[serde(default)]
    pub days: Option<f64>,
    #[serde(default)]
    pub expired: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Clean {
    older_than_days: f64,
}

pub async fn upload_usage(id: &str) -> Result<UploadUsage, ApiError> {
    parse(&request("GET", &format!("{}/uploads", host_path(id)), None).await?)
}

pub async fn clean_uploads(id: &str, days: f64) -> Result<UploadUsage, ApiError> {
    parse(&request("POST", &format!("{}/uploads/clean", host_path(id)), json(&Clean { older_than_days: days })).await?)
}

/// An agent's config file on a machine (the Config tab).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct ConfigFile {
    pub agent: inyon_protocol::AgentKind,
    pub label: String,
    pub path: String,
    pub format: String,
    pub exists: bool,
    #[serde(default)]
    pub size: f64,
    #[serde(default)]
    pub mtime: Option<f64>,
}

#[derive(Deserialize)]
struct Content {
    content: String,
}

#[derive(Serialize)]
struct WriteConfig<'a> {
    path: &'a str,
    content: &'a str,
}

pub async fn configs(id: &str) -> Result<Vec<ConfigFile>, ApiError> {
    parse(&request("GET", &format!("{}/configs", host_path(id)), None).await?)
}

pub async fn read_config(id: &str, path: &str) -> Result<String, ApiError> {
    let c: Content = parse(&request("GET", &format!("{}/config?path={}", host_path(id), inyon_chat_core::js::encode_uri_component(path)), None).await?)?;
    Ok(c.content)
}

pub async fn write_config(id: &str, path: &str, content: &str) -> Result<(), ApiError> {
    request("PUT", &format!("{}/config", host_path(id)), json(&WriteConfig { path, content })).await.map(drop)
}

/// A one-time code a phone scans to pair with this hub; it needs a recent sign-in (403 otherwise).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhoneCode {
    pub id: String,
    pub code: String,
    pub link: String,
    pub expires_at: f64,
}

#[derive(Serialize)]
struct Origin<'a> {
    origin: &'a str,
}

pub async fn phone_pair(origin: &str) -> Result<PhoneCode, ApiError> {
    parse(&request("POST", "/api/phones/pair", json(&Origin { origin })).await?)
}

// ---------- pages (pages/Pages.tsx and components/pages) ----------

/// `/api/pages/<machine>` and `/api/pages/<machine>/<slug>`, as api.ts's `pg`.
pub fn page_path(host: &str, slug: Option<&str>) -> String {
    let enc = inyon_chat_core::js::encode_uri_component;
    match slug {
        Some(s) => format!("/api/pages/{}/{}", enc(host), enc(s)),
        None => format!("/api/pages/{}", enc(host)),
    }
}

/// A link to the page, good for 12 hours; `url` is a path on this hub.
pub async fn open_page(host: &str, slug: &str) -> Result<inyon_protocol::PageOpen, ApiError> {
    parse(&request("POST", &format!("{}/open", page_path(host, Some(slug))), None).await?)
}

/// Every link to the page stops working.
pub async fn revoke_page(host: &str, slug: &str) -> Result<(), ApiError> {
    request("POST", &format!("{}/revoke", page_path(host, Some(slug))), None).await.map(drop)
}

/// A folder with an index.html to list as a page; the slug only to put a removed page back as it was.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct PageBody {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slug: Option<String>,
}

pub async fn add_page(host: &str, b: &PageBody) -> Result<inyon_protocol::PageEntry, ApiError> {
    parse(&request("POST", &page_path(host, None), json(b)).await?)
}

/// Takes a page off the list; its folder stays.
pub async fn remove_page(host: &str, slug: &str) -> Result<(), ApiError> {
    request("DELETE", &page_path(host, Some(slug)), None).await.map(drop)
}

/// Whether a file of a page's site is there: a HEAD request without the app's cookie, as the page's
/// own frame would ask.
#[cfg(target_arch = "wasm32")]
pub async fn page_file_exists(url: &str) -> bool {
    use wasm_bindgen::JsCast;
    use wasm_bindgen_futures::JsFuture;
    let init = web_sys::RequestInit::new();
    init.set_method("HEAD");
    init.set_credentials(web_sys::RequestCredentials::Omit);
    init.set_referrer_policy(web_sys::ReferrerPolicy::NoReferrer);
    let Ok(req) = web_sys::Request::new_with_str_and_init(url, &init) else { return false };
    let Some(win) = web_sys::window() else { return false };
    match JsFuture::from(win.fetch_with_request(&req)).await {
        Ok(v) => v.dyn_into::<web_sys::Response>().is_ok_and(|r| r.ok()),
        Err(_) => false,
    }
}

#[cfg(not(target_arch = "wasm32"))]
pub async fn page_file_exists(_url: &str) -> bool {
    false
}

#[cfg(target_arch = "wasm32")]
async fn request(method: &str, path: &str, body: Option<String>) -> Result<String, ApiError> {
    use wasm_bindgen::JsCast;
    use wasm_bindgen_futures::JsFuture;

    let unreachable = || ApiError::new(0, "Couldn't reach the hub. Check your connection.");
    let init = web_sys::RequestInit::new();
    init.set_method(method);
    init.set_credentials(web_sys::RequestCredentials::SameOrigin);
    if let Some(b) = &body {
        init.set_body(&wasm_bindgen::JsValue::from_str(b));
    }
    let req = web_sys::Request::new_with_str_and_init(path, &init).map_err(|_| unreachable())?;
    if body.is_some() {
        let _ = req.headers().set("content-type", "application/json");
    }
    let win = web_sys::window().ok_or_else(unreachable)?;
    let res: web_sys::Response = JsFuture::from(win.fetch_with_request(&req)).await.map_err(|_| unreachable())?.dyn_into().map_err(|_| unreachable())?;
    let text = match res.text() {
        Ok(p) => JsFuture::from(p).await.ok().and_then(|v| v.as_string()).unwrap_or_default(),
        Err(_) => String::new(),
    };
    if !res.ok() {
        return Err(error_of(res.status(), &text));
    }
    Ok(text)
}

#[cfg(not(target_arch = "wasm32"))]
async fn request(method: &str, path: &str, body: Option<String>) -> Result<String, ApiError> {
    crate::platform::request(method, path, body).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_routes_match_the_web_app() {
        assert_eq!(page_path("hub:h1/box one", Some("my-plan")), "/api/pages/hub%3Ah1%2Fbox%20one/my-plan");
        assert_eq!(page_path("local", None), "/api/pages/local");
        let b = PageBody { path: "/p/plan".into(), name: None, slug: Some("plan".into()) };
        assert_eq!(serde_json::to_string(&b).unwrap(), r#"{"path":"/p/plan","slug":"plan"}"#);
    }

    #[test]
    fn the_hubs_own_words_win() {
        assert_eq!(error_of(401, r#"{"error":"Wrong password"}"#).message, "Wrong password");
        assert_eq!(error_of(502, "<html>bad gateway</html>").message, "Request failed (502)");
        assert_eq!(error_of(500, "{}").status, 500);
    }

    #[test]
    fn a_session_reads_with_or_without_the_setup_fields() {
        let s: Session = serde_json::from_str(r#"{"authed":false,"setup":true,"setupCode":true,"version":"0.23.1"}"#).unwrap();
        assert_eq!(s, Session { authed: false, setup: true, setup_code: true });
        let s: Session = serde_json::from_str(r#"{"authed":true}"#).unwrap();
        assert!(s.authed && !s.setup);
    }

    #[test]
    fn bodies_match_the_web_app() {
        assert_eq!(serde_json::to_string(&Login { password: "pw" }).unwrap(), r#"{"password":"pw"}"#);
        assert_eq!(serde_json::to_string(&Setup { password: "pw", code: None }).unwrap(), r#"{"password":"pw"}"#);
        assert_eq!(serde_json::to_string(&Setup { password: "pw", code: Some("ab12") }).unwrap(), r#"{"password":"pw","code":"ab12"}"#);
        assert_eq!(serde_json::to_string(&Answer { option: 2, text: None, question: None }).unwrap(), r#"{"option":2}"#);
        assert_eq!(serde_json::to_string(&Send { text: "  keep\n    this", request_id: "r1" }).unwrap(), r#"{"text":"  keep\n    this","requestId":"r1"}"#);
        assert_eq!(serde_json::to_string(&Keys { keys: &["Escape"] }).unwrap(), r#"{"keys":["Escape"]}"#);
        assert_eq!(pane_path("hub:h1/laptop", "%12"), "/api/hosts/hub%3Ah1%2Flaptop/panes/12");
    }

    #[test]
    fn only_a_dropped_connection_or_a_busy_hub_is_tried_again() {
        assert!(is_transient(&ApiError::new(0, "")));
        assert!(is_transient(&ApiError::new(503, "")));
        assert!(is_transient(&ApiError::new(429, "")));
        assert!(!is_transient(&ApiError::new(409, "That question is no longer on screen")));
        assert!(!is_transient(&ApiError::new(400, "")));
    }

    #[test]
    fn a_new_password_is_checked_first() {
        assert_eq!(check_new_password("short", "short"), Err("Use at least 8 characters.".into()));
        assert_eq!(check_new_password("long enough", "long enougj"), Err("The two passwords don't match.".into()));
        assert_eq!(check_new_password("long enough", "long enough"), Ok(()));
    }
}
