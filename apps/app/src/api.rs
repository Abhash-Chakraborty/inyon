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
async fn request(_method: &str, _path: &str, _body: Option<String>) -> Result<String, ApiError> {
    // the desktop build will talk to a hub it was given; this slice is the browser's
    Err(ApiError::new(0, "Only the browser build reaches a hub so far."))
}

#[cfg(test)]
mod tests {
    use super::*;

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
