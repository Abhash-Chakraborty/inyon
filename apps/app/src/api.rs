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
    /// what the hub runs, once signed in
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub commit: Option<String>,
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

/// Changes what the hub keeps about a session (pins, parking, snoozes, tags, notes; from 0.24):
/// `PATCH …/organize` with only the fields that change, `null` clearing one.
#[derive(Deserialize)]
struct Organized {
    session: Option<inyon_protocol::SessionMark>,
}

/// `PATCH …/organize`: the session's mark after the change, or None when nothing is kept about it.
pub async fn organize_pane(host: &str, pane: &str, patch: &serde_json::Value) -> Result<Option<inyon_protocol::SessionMark>, ApiError> {
    parse::<Organized>(&request("PATCH", &format!("{}/organize", pane_path(host, pane)), Some(patch.to_string())).await?).map(|o| o.session)
}

#[derive(Serialize)]
struct Name<'a> {
    name: &'a str,
}

/// Puts the pinned sessions in this order (their mark ids): `PUT /api/organize/order`.
pub async fn pin_order(ids: &[String]) -> Result<(), ApiError> {
    request("PUT", "/api/organize/order", Some(serde_json::json!({ "pins": ids }).to_string())).await.map(drop)
}

/// The files in a session's folder (git's list, or a shallow walk), as the hub caches them.
#[derive(Debug, Clone, PartialEq, serde::Deserialize)]
pub struct FileList {
    pub cwd: String,
    pub files: Vec<String>,
}

pub async fn files(host: &str, pane: &str) -> Result<FileList, ApiError> {
    parse(&request("GET", &format!("{}/files", pane_path(host, pane)), None).await?)
}

/// Saves a prompt to send again: `POST /api/organize/prompts`.
pub async fn add_prompt(name: &str, text: &str) -> Result<inyon_protocol::SavedPrompt, ApiError> {
    parse(&request("POST", "/api/organize/prompts", Some(serde_json::json!({ "name": name, "text": text }).to_string())).await?)
}

/// Changes a saved prompt's fields (`starred`, `name`, `text`).
pub async fn update_prompt(id: &str, patch: &serde_json::Value) -> Result<(), ApiError> {
    request("PATCH", &format!("/api/organize/prompts/{}", inyon_chat_core::js::encode_uri_component(id)), Some(patch.to_string())).await.map(drop)
}

pub async fn remove_prompt(id: &str) -> Result<(), ApiError> {
    request("DELETE", &format!("/api/organize/prompts/{}", inyon_chat_core::js::encode_uri_component(id)), None).await.map(drop)
}

/// Gives a session the name it shows in Inyon (a plain terminal: its tmux window's name); an empty
/// name goes back to the automatic one.
pub async fn rename(host: &str, pane: &str, name: &str) -> Result<(), ApiError> {
    request("PUT", &format!("{}/name", pane_path(host, pane)), Some(serde_json::to_string(&Name { name }).unwrap())).await.map(drop)
}

/// `/api/hosts/<machine>/sessions/<tmux's id without $>/name`, as api.ts's `renameTmuxSession`.
pub fn tmux_session_path(host: &str, session: &str) -> String {
    format!("{}/sessions/{}/name", host_path(host), inyon_chat_core::js::encode_uri_component(session.strip_prefix('$').unwrap_or(session)))
}

#[derive(Deserialize)]
struct Named {
    name: String,
}

/// Renames the tmux session itself (`session` is tmux's id, `$52`): the name tmux took, with its
/// dots and colons made underscores (from 0.22).
pub async fn rename_tmux_session(host: &str, session: &str, name: &str) -> Result<String, ApiError> {
    parse::<Named>(&request("PUT", &tmux_session_path(host, session), Some(serde_json::to_string(&Name { name }).unwrap())).await?).map(|n| n.name)
}

/// The agent's past conversations in a pane's folder, newest first, with the open one marked.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Conversations {
    pub agent: inyon_protocol::AgentKind,
    pub cwd: String,
    pub conversations: Vec<inyon_protocol::PastConversation>,
}

/// `GET …/conversations?agent=`: `agent` says whose when none is running.
pub fn conversations_path(host: &str, pane: &str, agent: Option<inyon_protocol::AgentKind>) -> String {
    let query = agent.map_or(String::new(), |k| format!("?agent={}", k.as_str()));
    format!("{}/conversations{query}", pane_path(host, pane))
}

pub async fn conversations(host: &str, pane: &str, agent: Option<inyon_protocol::AgentKind>) -> Result<Conversations, ApiError> {
    parse(&request("GET", &conversations_path(host, pane, agent), None).await?)
}

#[derive(Serialize)]
struct Switch<'a> {
    agent: inyon_protocol::AgentKind,
    id: &'a str,
}

/// The agent exits (the pane stays) and starts again on conversation `id`.
pub async fn switch_conversation(host: &str, pane: &str, agent: inyon_protocol::AgentKind, id: &str) -> Result<(), ApiError> {
    request("POST", &format!("{}/switch", pane_path(host, pane)), json(&Switch { agent, id })).await.map(drop)
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

/// Has every machine read its sessions again (pull to refresh, the Overview's Refresh).
pub async fn refresh() -> Result<(), ApiError> {
    request("POST", "/api/refresh", None).await.map(drop)
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

/// Uploads (Settings › Uploads and clipboard): how long they're kept and how big they may be.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadSettings {
    #[serde(default)]
    pub retention_days: f64,
    #[serde(default, rename = "maxMB")]
    pub max_mb: f64,
    #[serde(default, rename = "maxTotalMB")]
    pub max_total_mb: Option<f64>,
    #[serde(flatten)]
    pub rest: serde_json::Map<String, serde_json::Value>,
}

/// The hub's settings (`GET`/`PUT /api/settings`). Saving sends all of them back, so fields this
/// app doesn't read are kept as they came.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HubSettings {
    #[serde(default)]
    pub uploads: UploadSettings,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_resume: Option<bool>,
    /// joined machines may hold messages for agents with `inyon send`
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub machines_send: Option<bool>,
    /// missing until the first is saved
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_agents: Option<Vec<CustomAgent>>,
    /// days a blueprint whose session ended stays unchanged before the hub cleans it up; 0 never,
    /// unset 14 (from 0.25)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pages_cleanup_days: Option<f64>,
    #[serde(flatten)]
    pub rest: serde_json::Map<String, serde_json::Value>,
}

pub async fn settings() -> Result<HubSettings, ApiError> {
    parse(&with_retries(|| request("GET", "/api/settings", None)).await?)
}

pub async fn save_settings(s: &HubSettings) -> Result<HubSettings, ApiError> {
    parse(&request("PUT", "/api/settings", json(s)).await?)
}

// ---------- Settings (pages/Settings.tsx) ----------

#[derive(Serialize)]
struct NewPassword<'a> {
    current: &'a str,
    next: &'a str,
}

/// A new password signs out every other browser and phone; this one stays signed in.
pub async fn change_password(current: &str, next: &str) -> Result<(), ApiError> {
    request("POST", "/api/password", json(&NewPassword { current, next })).await.map(drop)
}

/// Ends this browser's sign-in at the hub; a 401 means it already had.
pub async fn logout() -> Result<(), ApiError> {
    match request("POST", "/api/logout", None).await {
        Err(e) if e.status != 401 => Err(e),
        _ => Ok(()),
    }
}

/// What the hub runs and whether a newer release is out (`GET /api/hub/update`).
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HubUpdate {
    #[serde(default)]
    pub current: String,
    pub latest: Option<String>,
    pub behind: Option<u32>,
    #[serde(default)]
    pub can_update: bool,
    pub reason: Option<String>,
    #[serde(default)]
    pub running: bool,
    pub error: Option<String>,
    pub log: Option<String>,
    #[serde(default)]
    pub restart_needed: bool,
}

pub async fn hub_update(refresh: bool) -> Result<HubUpdate, ApiError> {
    parse(&request("GET", if refresh { "/api/hub/update?refresh=1" } else { "/api/hub/update" }, None).await?)
}

pub async fn start_hub_update() -> Result<(), ApiError> {
    request("POST", "/api/hub/update", None).await.map(drop)
}

/// The hub's organize record, as far as Settings reads it: its version and the sleep rules.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct OrganizeSleep {
    #[serde(default)]
    pub v: u32,
    #[serde(default)]
    pub sleep: Vec<inyon_protocol::SleepRule>,
}

pub async fn organize() -> Result<OrganizeSleep, ApiError> {
    parse(&request("GET", "/api/organize", None).await?)
}

#[derive(Serialize)]
struct Sleep<'a> {
    scope: &'a str,
    minutes: Option<u32>,
}

/// Agents idle this long go to sleep; `None` turns it off. The answer is every rule now.
pub async fn set_sleep(minutes: Option<u32>) -> Result<Vec<inyon_protocol::SleepRule>, ApiError> {
    parse(&request("PUT", "/api/organize/sleep", json(&Sleep { scope: "all", minutes })).await?)
}

/// A phone paired with this hub.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairedPhone {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub paired_at: f64,
    pub last_seen: Option<f64>,
}

pub async fn phones() -> Result<Vec<PairedPhone>, ApiError> {
    parse(&request("GET", "/api/phones", None).await?)
}

pub async fn forget_phone(id: &str) -> Result<(), ApiError> {
    request("DELETE", &format!("/api/phones/{}", inyon_chat_core::js::encode_uri_component(id)), None).await.map(drop)
}

pub async fn companions() -> Result<Vec<inyon_protocol::PairedCompanion>, ApiError> {
    parse(&request("GET", "/api/companions", None).await?)
}

pub async fn forget_companion(id: &str) -> Result<(), ApiError> {
    request("DELETE", &format!("/api/companions/{}", inyon_chat_core::js::encode_uri_component(id)), None).await.map(drop)
}

/// A one-time code a companion app types; it needs a recent sign-in (403 otherwise).
pub async fn companion_pair() -> Result<inyon_protocol::CompanionPairCode, ApiError> {
    parse(&request("POST", "/api/companions/pair", Some("{}".into())).await?)
}

/// The companion agent: the one it runs (none when off), on which machine and pane.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct CompanionStatus {
    pub agent: Option<inyon_protocol::AgentKind>,
    #[serde(default)]
    pub host: String,
    pub pane: Option<String>,
}

pub async fn companion() -> Result<CompanionStatus, ApiError> {
    parse(&request("GET", "/api/companion", None).await?)
}

#[derive(Serialize)]
struct AgentBody {
    agent: inyon_protocol::AgentKind,
}

pub async fn start_companion(agent: inyon_protocol::AgentKind) -> Result<CompanionStatus, ApiError> {
    parse(&request("POST", "/api/companion", json(&AgentBody { agent })).await?)
}

pub async fn stop_companion() -> Result<(), ApiError> {
    request("DELETE", "/api/companion", None).await.map(drop)
}

/// Ends a session: its agent exits and its tmux pane closes.
pub async fn end(host: &str, pane: &str) -> Result<(), ApiError> {
    request("POST", &format!("{}/end", pane_path(host, pane)), None).await.map(drop)
}

#[derive(Serialize)]
struct StartBody<'a> {
    agent: inyon_protocol::AgentKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    resume: Option<&'a str>,
}

/// Starts an agent in a pane at its shell prompt, picking up the conversation `resume` names.
pub async fn start(host: &str, pane: &str, agent: inyon_protocol::AgentKind, resume: Option<&str>) -> Result<(), ApiError> {
    request("POST", &format!("{}/start", pane_path(host, pane)), json(&StartBody { agent, resume })).await.map(drop)
}

/// The agent exits to its shell; the pane stays.
pub async fn exit(host: &str, pane: &str) -> Result<(), ApiError> {
    request("POST", &format!("{}/exit", pane_path(host, pane)), None).await.map(drop)
}

/// Codex forgets the last message and its reply.
pub async fn rewind(host: &str, pane: &str) -> Result<(), ApiError> {
    request("POST", &format!("{}/rewind", pane_path(host, pane)), Some("{}".into())).await.map(drop)
}

#[derive(Serialize)]
struct On {
    on: bool,
}

/// Claude Code's Remote Control on or off.
pub async fn remote_control(host: &str, pane: &str, on: bool) -> Result<(), ApiError> {
    request("POST", &format!("{}/rc", pane_path(host, pane)), Some(serde_json::to_string(&On { on }).unwrap())).await.map(drop)
}

pub async fn ultracode(host: &str, pane: &str, on: bool) -> Result<(), ApiError> {
    request("POST", &format!("{}/ultracode", pane_path(host, pane)), Some(serde_json::to_string(&On { on }).unwrap())).await.map(drop)
}

#[derive(Serialize)]
struct Setting<'a> {
    text: &'a str,
    setting: bool,
}

/// A model, effort or goal change from the composer's controls: typed into the agent like a
/// message, never shown as one.
pub async fn setting(host: &str, pane: &str, text: &str) -> Result<(), ApiError> {
    let body = serde_json::to_string(&Setting { text, setting: true }).unwrap();
    request("POST", &format!("{}/send", pane_path(host, pane)), Some(body)).await.map(drop)
}

#[derive(Serialize)]
struct Mode<'a> {
    mode: &'a str,
}

pub async fn mode(host: &str, pane: &str, mode: &str) -> Result<(), ApiError> {
    request("POST", &format!("{}/mode", pane_path(host, pane)), Some(serde_json::to_string(&Mode { mode }).unwrap())).await.map(drop)
}

/// Forgets a model, effort or mode picked while the agent couldn't take it.
pub async fn drop_chosen(host: &str, pane: &str) -> Result<(), ApiError> {
    request("DELETE", &format!("{}/chosen", pane_path(host, pane)), None).await.map(drop)
}

/// The models (and OpenCode's agents) the machine's CLI offers now.
pub async fn models(host: &str, pane: &str) -> Result<inyon_protocol::AgentCatalog, ApiError> {
    parse(&request("GET", &format!("{}/models", pane_path(host, pane)), None).await?)
}

#[derive(Deserialize)]
struct Forked {
    pane: String,
}

/// A copy of the conversation carrying on in a new window: its pane.
pub async fn fork(host: &str, pane: &str) -> Result<String, ApiError> {
    parse::<Forked>(&request("POST", &format!("{}/fork", pane_path(host, pane)), None).await?).map(|f| f.pane)
}

// ---------- Web Push (lib/push.ts) ----------

pub async fn push(b: &crate::push::PushBody) -> Result<(), ApiError> {
    request("POST", "/api/push", Some(serde_json::to_string(b).unwrap())).await.map(drop)
}

#[derive(Deserialize)]
struct Sent {
    #[serde(default)]
    sent: u32,
}

/// A test notice through the push service to `endpoint`: how many senders delivered it.
pub async fn push_test(endpoint: &str) -> Result<u32, ApiError> {
    let body = serde_json::json!({ "endpoint": endpoint }).to_string();
    parse::<Sent>(&request("POST", "/api/push/test", Some(body)).await?).map(|s| s.sent)
}

// ---------- temp files (pages/Temp.tsx) ----------

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct TempRoot {
    pub id: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub size: f64,
    #[serde(default)]
    pub exists: bool,
}

/// One thing in a temp folder that can go as a whole: a session's folder, an upload day, a file.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct TempItem {
    pub root: String,
    pub path: String,
    pub name: String,
    /// "dir" or "file"
    pub kind: String,
    #[serde(default)]
    pub size: f64,
    #[serde(default)]
    pub files: u32,
    /// ms, the newest change inside
    #[serde(default)]
    pub modified: f64,
    /// changed in the last 30 minutes: an agent may still be using it
    #[serde(default)]
    pub recent: bool,
    /// up to four images inside, newest first
    #[serde(default)]
    pub images: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct TempListing {
    #[serde(default)]
    pub roots: Option<Vec<TempRoot>>,
    #[serde(default)]
    pub items: Option<Vec<TempItem>>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct TempFile {
    pub path: String,
    pub rel: String,
    #[serde(default)]
    pub size: f64,
    #[serde(default)]
    pub modified: f64,
    /// "image", "text" or "other"
    #[serde(default)]
    pub kind: String,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct TempFiles {
    #[serde(default)]
    pub files: Option<Vec<TempFile>>,
    #[serde(default)]
    pub truncated: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct TempPreview {
    #[serde(default)]
    pub mime: String,
    #[serde(default)]
    pub size: f64,
    pub text: Option<String>,
    pub base64: Option<String>,
    #[serde(default)]
    pub truncated: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct TempRemoved {
    #[serde(default)]
    pub removed: Option<Vec<String>>,
    #[serde(default)]
    pub freed: Option<f64>,
    #[serde(default)]
    pub failed: Option<Vec<(String, String)>>,
}

/// `?path=…&max=…`, encoded as URLSearchParams would.
fn temp_query(path: &str, max: Option<u64>) -> String {
    let enc = inyon_chat_core::js::encode_uri_component;
    match max {
        Some(m) => format!("?path={}&max={m}", enc(path)),
        None => format!("?path={}", enc(path)),
    }
}

pub async fn temp_list(id: &str) -> Result<TempListing, ApiError> {
    parse(&request("GET", &format!("{}/temp", host_path(id)), None).await?)
}

pub async fn temp_files(id: &str, path: &str) -> Result<TempFiles, ApiError> {
    parse(&request("GET", &format!("{}/temp/files{}", host_path(id), temp_query(path, None)), None).await?)
}

pub async fn temp_preview(id: &str, path: &str, max: Option<u64>) -> Result<TempPreview, ApiError> {
    parse(&request("GET", &format!("{}/temp/preview{}", host_path(id), temp_query(path, max)), None).await?)
}

#[derive(Serialize)]
struct Paths<'a> {
    paths: &'a [String],
}

pub async fn temp_delete(id: &str, paths: &[String]) -> Result<TempRemoved, ApiError> {
    parse(&request("POST", &format!("{}/temp/delete", host_path(id)), json(&Paths { paths })).await?)
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

/// A blueprint the hub cleaned up: off the list, its folder kept.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct CleanedPage {
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub slug: String,
    #[serde(default)]
    pub name: String,
}

/// What the hub's clean-up took off: the last automatic one's note (`GET /api/pages-cleaned`), or
/// the one just asked for (`POST /api/pages-cleanup`).
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct Cleaned {
    #[serde(default)]
    pub days: Option<f64>,
    #[serde(default)]
    pub pages: Vec<CleanedPage>,
}

/// "Clean up old blueprints": takes them off now (from 0.25).
pub async fn cleanup_pages() -> Result<Cleaned, ApiError> {
    parse(&request("POST", "/api/pages-cleanup", None).await?)
}

/// What the hub's last clean-up took off, until it's dismissed.
pub async fn cleaned_pages() -> Result<Cleaned, ApiError> {
    parse(&request("GET", "/api/pages-cleaned", None).await?)
}

pub async fn dismiss_cleaned() -> Result<(), ApiError> {
    request("DELETE", "/api/pages-cleaned", None).await.map(drop)
}

/// Takes a page off the list; its folder stays.
pub async fn remove_page(host: &str, slug: &str) -> Result<(), ApiError> {
    request("DELETE", &page_path(host, Some(slug)), None).await.map(drop)
}

// ---------- shared links to a blueprint (hubs from 0.25.4) ----------

use crate::shares::{MadeLink, ShareCheck, ShareList};

#[derive(Serialize)]
struct ShareBody {
    public: bool,
    days: u32,
}

#[derive(Serialize)]
struct AddressBody<'a> {
    address: &'a str,
}

/// The page's live shared links, and the hub's public address for them.
pub async fn page_shares(host: &str, slug: &str) -> Result<ShareList, ApiError> {
    parse(&request("GET", &format!("{}/shares", page_path(host, Some(slug))), None).await?)
}

/// A new shared link; its `url` is shown this once.
pub async fn share_page(host: &str, slug: &str, public: bool, days: u32) -> Result<MadeLink, ApiError> {
    parse(&request("POST", &format!("{}/shares", page_path(host, Some(slug))), json(&ShareBody { public, days })).await?)
}

pub async fn unshare_page(host: &str, slug: &str, id: &str) -> Result<(), ApiError> {
    request("DELETE", &format!("{}/shares/{}", page_path(host, Some(slug)), inyon_chat_core::js::encode_uri_component(id)), None).await.map(drop)
}

/// Every live shared link on this hub.
pub async fn shares() -> Result<ShareList, ApiError> {
    parse(&request("GET", "/api/shares", None).await?)
}

pub async fn revoke_share(id: &str) -> Result<(), ApiError> {
    request("DELETE", &format!("/api/shares/{}", inyon_chat_core::js::encode_uri_component(id)), None).await.map(drop)
}

pub async fn revoke_all_shares() -> Result<(), ApiError> {
    request("DELETE", "/api/shares", None).await.map(drop)
}

/// The public address for shared links ("" clears it).
pub async fn set_share_address(address: &str) -> Result<ShareList, ApiError> {
    parse(&request("PUT", "/api/share-address", json(&AddressBody { address })).await?)
}

/// Asks the hub to check its public address: the name, a request reaching it, nothing else let through.
pub async fn check_share_address() -> Result<ShareCheck, ApiError> {
    parse(&request("POST", "/api/share-address/check", None).await?)
}

/// Every page, as `GET /api/pages` lists them: the list when the pages stream doesn't come.
pub async fn pages() -> Result<Vec<inyon_protocol::PageEntry>, ApiError> {
    parse::<inyon_protocol::PageList>(&request("GET", "/api/pages", None).await?).map(|l| l.pages)
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

// ---------- the session side panel (session/Workspace.tsx, Panels.tsx) ----------

fn path_query(path: &str) -> String {
    format!("?path={}", inyon_chat_core::js::encode_uri_component(path))
}

/// One entry of a folder in the session's folder.
#[derive(Debug, Clone, PartialEq, serde::Deserialize)]
pub struct DirEntry {
    pub name: String,
    pub dir: bool,
    #[serde(default)]
    pub size: f64,
}

#[derive(Debug, Clone, PartialEq, serde::Deserialize)]
pub struct Dir {
    pub cwd: String,
    pub entries: Vec<DirEntry>,
}

/// A folder under the session's folder (`path` relative to it, empty for the folder itself).
pub async fn dir(host: &str, pane: &str, path: &str) -> Result<Dir, ApiError> {
    parse(&request("GET", &format!("{}/dir{}", pane_path(host, pane), path_query(path)), None).await?)
}

/// A file as the Files tab shows it.
#[derive(Debug, Clone, PartialEq, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum FileView {
    Text {
        text: String,
        size: f64,
        truncated: bool,
    },
    Image {
        #[serde(rename = "type")]
        mime: String,
        data: String,
    },
    Binary {
        size: f64,
    },
    Large {
        size: f64,
    },
}

pub async fn file(host: &str, pane: &str, path: &str) -> Result<FileView, ApiError> {
    parse(&request("GET", &format!("{}/file{}", pane_path(host, pane), path_query(path)), None).await?)
}

/// A changed file in git's working tree: `M`, `A`, `D`, `R` or `?` (not tracked).
#[derive(Debug, Clone, PartialEq, serde::Deserialize)]
pub struct GitFile {
    pub path: String,
    #[serde(default)]
    pub from: Option<String>,
    pub status: String,
    #[serde(default)]
    pub add: f64,
    #[serde(default)]
    pub del: f64,
}

#[derive(Debug, Clone, PartialEq, serde::Deserialize)]
pub struct GitState {
    pub repo: bool,
    #[serde(default)]
    pub root: Option<String>,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub remote: Option<bool>,
    #[serde(default)]
    pub upstream: Option<String>,
    #[serde(default)]
    pub ahead: Option<f64>,
    #[serde(default)]
    pub behind: Option<f64>,
    #[serde(default)]
    pub files: Vec<GitFile>,
}

/// The session folder's git working tree against the last commit.
pub async fn git(host: &str, pane: &str) -> Result<GitState, ApiError> {
    parse(&request("GET", &format!("{}/git", pane_path(host, pane)), None).await?)
}

#[derive(Debug, Clone, PartialEq, serde::Deserialize)]
pub struct GitDiff {
    #[serde(default)]
    pub binary: bool,
    #[serde(default)]
    pub hunks: Vec<inyon_protocol::PatchHunk>,
}

pub async fn git_diff(host: &str, pane: &str, path: &str) -> Result<GitDiff, ApiError> {
    parse(&request("GET", &format!("{}/git/diff{}", pane_path(host, pane), path_query(path)), None).await?)
}

#[derive(Debug, Clone, PartialEq, serde::Deserialize)]
pub struct Commit {
    pub commit: String,
}

#[derive(Serialize)]
struct CommitBody<'a> {
    message: &'a str,
}

/// Commits every change in the working tree.
pub async fn git_commit(host: &str, pane: &str, message: &str) -> Result<Commit, ApiError> {
    let body = serde_json::to_string(&CommitBody { message }).unwrap_or_default();
    parse(&request("POST", &format!("{}/git/commit", pane_path(host, pane)), Some(body)).await?)
}

pub async fn git_push(host: &str, pane: &str) -> Result<(), ApiError> {
    request("POST", &format!("{}/git/push", pane_path(host, pane)), None).await.map(drop)
}

#[derive(Debug, Clone, PartialEq, serde::Deserialize)]
pub struct Stopped {
    pub stopped: bool,
}

#[derive(Serialize)]
struct TaskRef<'a> {
    id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<&'a str>,
}

/// Stops a background task or monitor of a machine's agent.
pub async fn stop_task(host: &str, id: &str, path: Option<&str>) -> Result<Stopped, ApiError> {
    let body = serde_json::to_string(&TaskRef { id, path }).unwrap_or_default();
    parse(&request("POST", &format!("{}/tasks/stop", host_path(host)), Some(body)).await?)
}

#[derive(Debug, Clone, PartialEq, serde::Deserialize)]
pub struct TaskOutput {
    pub output: String,
}

pub async fn task_output(host: &str, id: &str, path: Option<&str>) -> Result<TaskOutput, ApiError> {
    let enc = inyon_chat_core::js::encode_uri_component;
    parse(&request("GET", &format!("{}/task-output?path={}&id={}", host_path(host), enc(path.unwrap_or("")), enc(id)), None).await?)
}

/// A subagent's own transcript file, found from the session's.
#[derive(Debug, Clone, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentFile {
    #[serde(default)]
    pub tool_use_id: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    pub path: String,
}

pub async fn subagents(host: &str, transcript: &str) -> Result<Vec<SubagentFile>, ApiError> {
    parse(&request("GET", &format!("{}/subagents?transcript={}", host_path(host), inyon_chat_core::js::encode_uri_component(transcript)), None).await?)
}

pub async fn transcript(host: &str, path: &str) -> Result<Vec<inyon_protocol::ChatItem>, ApiError> {
    parse(&request("GET", &format!("{}/transcript{}", host_path(host), path_query(path)), None).await?)
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
    fn session_routes_match_the_web_app() {
        assert_eq!(tmux_session_path("hub:h1/box", "$52"), "/api/hosts/hub%3Ah1%2Fbox/sessions/52/name");
        assert_eq!(conversations_path("local", "%11", Some(inyon_protocol::AgentKind::Claude)), "/api/hosts/local/panes/11/conversations?agent=claude");
        assert_eq!(conversations_path("local", "%11", None), "/api/hosts/local/panes/11/conversations");
        let b = Switch { agent: inyon_protocol::AgentKind::Codex, id: "019a" };
        assert_eq!(serde_json::to_string(&b).unwrap(), r#"{"agent":"codex","id":"019a"}"#);
        let list: Conversations =
            serde_json::from_str(r#"{"agent":"claude","cwd":"/home/sam/code","conversations":[{"id":"a1","title":"Fix the test","at":1700000000000,"current":true}]}"#).unwrap();
        assert_eq!(list.conversations[0].current, Some(true));
    }

    #[test]
    fn page_routes_match_the_web_app() {
        assert_eq!(page_path("hub:h1/box one", Some("my-plan")), "/api/pages/hub%3Ah1%2Fbox%20one/my-plan");
        assert_eq!(page_path("local", None), "/api/pages/local");
        let b = PageBody { path: "/p/plan".into(), name: None, slug: Some("plan".into()) };
        assert_eq!(serde_json::to_string(&b).unwrap(), r#"{"path":"/p/plan","slug":"plan"}"#);
    }

    #[test]
    fn settings_routes_and_bodies_match_the_web_app() {
        assert_eq!(temp_query("/tmp/a b", None), "?path=%2Ftmp%2Fa%20b");
        assert_eq!(temp_query("/x", Some(1_500_000)), "?path=%2Fx&max=1500000");
        assert_eq!(serde_json::to_string(&NewPassword { current: "a", next: "b" }).unwrap(), r#"{"current":"a","next":"b"}"#);
        assert_eq!(serde_json::to_string(&Sleep { scope: "all", minutes: None }).unwrap(), r#"{"scope":"all","minutes":null}"#);
        // saving sends back what this app doesn't read
        let raw = r#"{"uploads":{"retentionDays":7,"maxMB":100,"maxTotalMB":1024,"longPasteLines":40},"autoResume":true,"newer":{"x":1}}"#;
        let mut s: HubSettings = serde_json::from_str(raw).unwrap();
        s.uploads.max_mb = 500.0;
        let back: serde_json::Value = serde_json::to_value(&s).unwrap();
        assert_eq!(back["uploads"]["longPasteLines"], 40);
        assert_eq!(back["uploads"]["maxMB"], 500.0);
        assert_eq!(back["uploads"]["maxTotalMB"], 1024.0);
        assert_eq!(back["newer"]["x"], 1);
        assert_eq!(back["autoResume"], true);
        assert!(back.get("customAgents").is_none());
    }

    #[test]
    fn share_routes_and_bodies_match_the_web_app() {
        assert_eq!(format!("{}/shares", page_path("hub:h1/box", Some("plan"))), "/api/pages/hub%3Ah1%2Fbox/plan/shares");
        assert_eq!(serde_json::to_string(&ShareBody { public: true, days: 7 }).unwrap(), r#"{"public":true,"days":7}"#);
        assert_eq!(serde_json::to_string(&AddressBody { address: "" }).unwrap(), r#"{"address":""}"#);
        let l: inyon_protocol::PageList = serde_json::from_str(r#"{"pages":[]}"#).unwrap();
        assert!(l.pages.is_empty());
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
        assert_eq!(s, Session { authed: false, setup: true, setup_code: true, version: Some("0.23.1".into()), commit: None });
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
