//! How a command answers: text for a person, or one JSON line (`{"v":1,"ok":true,…}`) with
//! `--json`, which the inyon command (and older ones, which ran the Bun engine) reads. With
//! `--json` anything meant for a person goes to stderr, so stdout stays one line of JSON. Run in
//! the background on Windows, where there's no console, the log lines go to a file. (output.ts)

use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde_json::{json, Map, Value};

static JSON_OUT: AtomicBool = AtomicBool::new(false);
static LOG_TO: Mutex<Option<PathBuf>> = Mutex::new(None);

/// Whether answers are JSON (the command was given --json).
pub fn json() -> bool {
    JSON_OUT.load(Ordering::Relaxed)
}

pub fn set_json(on: bool) {
    JSON_OUT.store(on, Ordering::Relaxed);
}

/// The arguments without the --json flag, wherever it was given; notes whether it was.
pub fn take_json(args: &[String]) -> Vec<String> {
    if args.iter().any(|a| a == "--json") {
        set_json(true);
    }
    args.iter().filter(|a| *a != "--json").cloned().collect()
}

/// Sends log lines to `file` from now on, each stamped with the time (no console to print to).
pub fn log_to(file: PathBuf) {
    *LOG_TO.lock().unwrap_or_else(|e| e.into_inner()) = Some(file);
}

fn to_file(line: &str) -> bool {
    let guard = LOG_TO.lock().unwrap_or_else(|e| e.into_inner());
    let Some(file) = guard.as_ref() else { return false };
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(file) {
        let _ = writeln!(f, "{} {line}", crate::iso_now());
    }
    true
}

/// `console.log`: a line on stdout, or in the log file.
pub fn log(line: &str) {
    if !to_file(line) {
        let mut out = std::io::stdout().lock();
        let _ = writeln!(out, "{line}");
        let _ = out.flush();
    }
}

/// `console.error`: a line on stderr, or in the log file.
pub fn error(line: &str) {
    if !to_file(line) {
        let _ = writeln!(std::io::stderr().lock(), "{line}");
    }
}

/// A line for a person: stdout, or stderr under --json.
pub fn say(line: &str) {
    if json() {
        error(line)
    } else {
        log(line)
    }
}

/// `{"v":1,"ok":true,…value}`.
pub fn answer(value: &Value) -> String {
    let mut m = Map::new();
    m.insert("v".into(), json!(1));
    m.insert("ok".into(), json!(true));
    if let Value::Object(fields) = value {
        for (k, v) in fields {
            m.insert(k.clone(), v.clone());
        }
    }
    Value::Object(m).to_string()
}

/// A command's answer: `value` as JSON under --json, else `message` (when there is one).
pub fn emit(value: Value, message: Option<&str>) {
    if json() {
        log(&answer(&value));
    } else if let Some(m) = message {
        log(m);
    }
}

/// `{"v":1,"ok":false,"error":…}`.
pub fn failure(message: &str) -> String {
    json!({ "v": 1, "ok": false, "error": message }).to_string()
}

/// Ends the command with an error: JSON on stdout and exit 1 under --json, else the message on
/// stderr and exit `code`.
pub fn fail(message: &str, code: i32) -> ! {
    if json() {
        log(&failure(message));
        std::process::exit(1);
    }
    error(message);
    std::process::exit(code);
}

/// What `pair --json` answers.
pub struct PairOutput {
    /// the link for the app (inyon://pair?…)
    pub link: String,
    /// what the QR code carries: the web app's address with the pairing after #
    pub qr: String,
    /// the typed-in form, when the relays took it
    pub short: Option<(String, String)>,
    pub urls: Vec<String>,
    pub relays: Vec<String>,
    /// whether the link runs on its own (a service), so this process ends once the code is shown
    pub service: bool,
}

/// What `pair --json` prints. The short code is left out when it couldn't be published.
pub fn pair_result(o: &PairOutput, typed: bool) -> Value {
    let mut v = json!({ "link": o.link, "qr": o.qr, "urls": o.urls, "relays": o.relays, "service": o.service });
    if let (true, Some((id, code))) = (typed, &o.short) {
        v["short"] = json!({ "id": id, "code": code });
    }
    v
}

/// The pairing code as the terminal shows it, drawn from `pair --json`'s answer.
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_pairing_answer_carries_the_short_code_only_once_published() {
        let base = PairOutput {
            link: "inyon://pair?m=a".into(),
            qr: "https://web/#pair?m=a".into(),
            short: Some(("K7Q4MX2T".into(), "493812".into())),
            urls: vec!["wss://x/link".into()],
            relays: vec![],
            service: true,
        };
        assert_eq!(
            answer(&pair_result(&base, true)),
            r#"{"v":1,"ok":true,"link":"inyon://pair?m=a","qr":"https://web/#pair?m=a","urls":["wss://x/link"],"relays":[],"service":true,"short":{"id":"K7Q4MX2T","code":"493812"}}"#
        );
        assert!(pair_result(&base, false).get("short").is_none());
    }

    #[test]
    fn answers_and_failures_are_one_line_with_v_first() {
        assert_eq!(answer(&json!({ "phones": [] })), r#"{"v":1,"ok":true,"phones":[]}"#);
        assert_eq!(failure(r#"No paired phone matches "x""#), r#"{"v":1,"ok":false,"error":"No paired phone matches \"x\""}"#);
    }

    #[test]
    fn the_flag_is_taken_out_wherever_it_is() {
        assert_eq!(take_json(&["forget".into(), "--json".into(), "a".into()]), vec!["forget".to_string(), "a".to_string()]);
        assert!(json());
        set_json(false);
    }
}
