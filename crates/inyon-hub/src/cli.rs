//! `inyon-engine hub` as apps/node/hub.ts answers it, run by the inyon command when
//! INYON_HUB_IMPL=rust. Its settings (PORT, BIND, TLS_CERT and TLS_KEY, INYON_ALLOW_HTTP…) can go
//! in ~/.inyon/hub.env, one NAME=value a line, so the background service picks them up too.
//!
//!   hub                 run it here
//!   hub code            show the setup code a new hub asks for
//!   hub reset-password  choose a new password when the old one is forgotten

use std::io::{BufRead, Write};
use std::path::PathBuf;

use inyon_engine::output::{emit, fail};
use serde_json::{Map, Value};

fn data_dir() -> PathBuf {
    std::env::var("INYON_DATA_DIR").ok().filter(|d| !d.is_empty()).map(PathBuf::from).unwrap_or_else(|| inyon_engine::paths::home().join(".inyon"))
}

pub fn hub_env_file() -> PathBuf {
    data_dir().join("hub.env")
}

/// Puts what hub.env holds into this process's environment where nothing is set yet (`??=`), and
/// each TETHER_* variable under its INYON_* name. Called before any other thread starts.
pub fn load_env() {
    for (k, v) in inyon_engine::paths::read_env_file(&hub_env_file()) {
        if std::env::var_os(&k).is_none() {
            std::env::set_var(k, v);
        }
    }
    let old: Vec<(String, String)> = std::env::vars().filter_map(|(k, v)| k.strip_prefix("TETHER_").map(|r| (format!("INYON_{r}"), v))).collect();
    for (k, v) in old {
        if std::env::var_os(&k).is_none() {
            std::env::set_var(k, v);
        }
    }
}

/// `inyon-engine hub [code|reset-password]`
pub fn run(args: &[String]) -> i32 {
    load_env();
    match args.first().map(String::as_str) {
        Some("code") => show_setup_code(),
        Some("reset-password") => reset_password(args.get(1).cloned()),
        Some(_) => {
            eprintln!("usage: inyon-engine hub [code|reset-password]");
            2
        }
        None => {
            // for `inyon update`: it waits for this to name the new version
            let _ = std::fs::create_dir_all(inyon_engine::paths::node_dir());
            let running = serde_json::json!({ "pid": std::process::id(), "version": inyon_protocol::VERSION });
            let _ = std::fs::write(inyon_engine::paths::running_file(inyon_engine::paths::Role::Hub), running.to_string());
            crate::start::serve()
        }
    }
}

/// The hub's own address on this machine, for asking it questions.
fn local_url() -> String {
    let get = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
    let tls = get("TLS_CERT").is_some() && get("TLS_KEY").is_some();
    let bind = get("BIND").unwrap_or_else(|| "127.0.0.1".into());
    let host = if ["0.0.0.0", "::", "127.0.0.1"].contains(&bind.as_str()) { "127.0.0.1".to_owned() } else { bind };
    format!("{}://{host}:{}", if tls { "https" } else { "http" }, get("PORT").unwrap_or_else(|| "4777".into()))
}

/// What `inyon hub code` says: the code while the hub still waits for its first password, and
/// otherwise what to do instead.
pub fn setup_code_message(code: Option<&str>, session: Option<&Value>, url: &str) -> String {
    let setup = |s: &Value| crate::http::truthy(s.get("setup"));
    match (code, session) {
        (_, Some(s)) if !setup(s) => "This hub has a password already, so there is no setup code. Forgotten it? Run `inyon hub reset-password`.".into(),
        (Some(c), Some(_)) => format!("Setup code: {c}\nOpen {url} in a browser and enter it to choose a password."),
        (Some(c), None) => {
            format!("Setup code: {c}\nThe hub isn't answering right now; start it (`inyon hub` or `inyon hub start`), then open it in a browser and enter the code.")
        }
        (None, _) => "No setup code here: the hub has not started yet. Run `inyon hub` or `inyon hub start`; it makes a code as it starts.".into(),
    }
}

fn show_setup_code() -> i32 {
    let url = local_url();
    let code = std::fs::read_to_string(data_dir().join("setup-code")).ok().map(|c| c.trim().to_owned()).filter(|c| !c.is_empty());
    let session = inyon_engine::http::request("GET", &format!("{url}/api/session"), &[], None, std::time::Duration::from_secs(5))
        .ok()
        .and_then(|r| serde_json::from_slice::<Value>(&r.body).ok());
    let message = setup_code_message(code.as_deref(), session.as_ref(), &url);
    let has_password = session.as_ref().map(|s| !crate::http::truthy(s.get("setup")));
    let mut out = Map::new();
    if has_password != Some(true) {
        if let Some(c) = &code {
            out.insert("code".into(), Value::String(c.clone()));
        }
    }
    out.insert("url".into(), Value::String(url.clone()));
    out.insert("running".into(), Value::Bool(session.is_some()));
    if let Some(h) = has_password {
        out.insert("hasPassword".into(), Value::Bool(h));
    }
    out.insert("message".into(), Value::String(message.clone()));
    emit(Value::Object(out), Some(&message));
    0
}

/// A new password for a forgotten one, written straight to the hub's records; a running hub has
/// to restart to pick it up. It comes as an argument, in INYON_NEW_PASSWORD, or from a prompt.
fn reset_password(given: Option<String>) -> i32 {
    let env = inyon_backends::env::HubEnv::current();
    let dir = env.data_dir();
    if let Err(e) = std::fs::create_dir_all(&dir).and_then(|_| inyon_backends::fs_store::FsStore::new(&dir)) {
        fail(&format!("Can't open {}: {e}", dir.display()), 1);
    }
    let store = inyon_backends::fs_store::FsStore::new(&dir).expect("the hub's records");
    inyon_core::platform::store::use_store(std::rc::Rc::new(store));
    let pw = given.or_else(|| std::env::var("INYON_NEW_PASSWORD").ok()).unwrap_or_else(|| {
        print!("New Inyon password: ");
        let _ = std::io::stdout().flush();
        let mut line = String::new();
        let _ = std::io::stdin().lock().read_line(&mut line);
        line.trim_end_matches(['\r', '\n']).to_owned()
    });
    if let Some(problem) = crate::password::password_problem(&pw) {
        fail(problem, 1);
    }
    crate::password::init();
    if let Err(e) = crate::password::set_password(&pw) {
        fail(&e, 1);
    }
    let message = "Password updated; everyone was signed out. Restart the hub to use it (`inyon hub restart`).";
    emit(serde_json::json!({ "message": message }), Some(message));
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_setup_code_message_says_what_to_do() {
        let url = "http://127.0.0.1:4777";
        assert!(setup_code_message(Some("abcd1234"), Some(&serde_json::json!({ "setup": false })), url).starts_with("This hub has a password already"));
        assert_eq!(
            setup_code_message(Some("abcd1234"), Some(&serde_json::json!({ "setup": true })), url),
            format!("Setup code: abcd1234\nOpen {url} in a browser and enter it to choose a password.")
        );
        assert!(setup_code_message(Some("abcd1234"), None, url).contains("The hub isn't answering right now"));
        assert!(setup_code_message(None, None, url).starts_with("No setup code here"));
    }
}
