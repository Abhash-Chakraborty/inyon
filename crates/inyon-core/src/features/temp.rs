//! Port of features/temp.ts: agent temp files (pasted images, screenshots, scratch folders) for the
//! app's Temp files screen. The machine's own `inyon temp … --json` does the work (apps/cli's
//! temp.rs): it knows the folders, checks every path is strictly inside one of them and never
//! follows a link out. The hub only runs it and hands the answer on.

use serde_json::{json, Map, Value};

use crate::hosts::host::{shq, ExecOptions, ExecResult, Host};
use crate::hosts::http_error::{http, HubResult};
use crate::hosts::registry::registry;
use crate::re;

/// The machine's inyon: the one the connection runs from (INYON_EXE, set for paired machines),
/// else the one on PATH or in ~/.inyon/bin. Exit 127 when there's none.
pub const INYON: &str = r#"x="${INYON_EXE:-}"; s="${INYON_SCRIPT:-}"
if [ -z "$x" ]; then x="$(command -v inyon 2>/dev/null)"; s=; fi
if [ -z "$x" ] && [ -x "$HOME/.inyon/bin/inyon" ]; then x="$HOME/.inyon/bin/inyon"; fi
[ -n "$x" ] || { echo 'inyon: not found' >&2; exit 127; }
"$x" ${s:+"$s"} temp"#;

/// The biggest image the app gets whole (as the CLI's own limit).
pub const PREVIEW_MAX: u64 = 8 * 1024 * 1024;

pub fn too_old(name: &str) -> String {
    format!("Update Inyon on {name} to see its temp files")
}

pub fn missing(name: &str) -> String {
    format!("Install Inyon on {name} to see its temp files")
}

fn machine(host_id: &str) -> HubResult<(Host, String)> {
    let rt = registry().get(host_id).ok_or_else(|| http(404, "Unknown machine"))?;
    let r = rt.borrow();
    let connected = r.probe.as_ref().is_some_and(|p| !p.borrow().home.is_empty());
    if !connected {
        return Err(http(503, "Machine is not connected yet"));
    }
    Ok((r.host.clone(), r.host.config().name))
}

/// Runs `inyon temp <args> --json` on the machine and reads its answer.
async fn run(host_id: &str, args: &str, input: Option<String>, timeout_ms: u64) -> HubResult<Map<String, Value>> {
    let (host, name) = machine(host_id)?;
    let opts = ExecOptions { input: input.map(String::into_bytes), timeout_ms: Some(timeout_ms) };
    let r = host.exec(&format!("{INYON} {args}"), opts).await?;
    read_answer(&name, &r)
}

/// The command's JSON, or the error a person can act on.
pub fn read_answer(name: &str, r: &ExecResult) -> HubResult<Map<String, Value>> {
    let last = r.stdout.trim().split('\n').next_back().unwrap_or("");
    if let Ok(Value::Object(m)) = serde_json::from_str::<Value>(last) {
        return Ok(m);
    }
    let said = format!("{}\n{}", r.stderr, r.stdout);
    if r.code == 127 || said.contains("inyon: not found") {
        return Err(http(409, missing(name)));
    }
    // what an inyon from before `temp` says when asked for it (clap's words, and the engine's)
    if re!(r"(?im)unrecognized subcommand|unexpected argument|unknown command|^inyon-engine\b|^usage:").is_match(&said) {
        return Err(http(409, too_old(name)));
    }
    if r.code == 124 {
        return Err(http(504, format!("{name} took too long to answer")));
    }
    let line = said.trim().split('\n').next_back().unwrap_or("").to_owned();
    Err(http(500, if line.is_empty() { format!("Couldn't read the temp files on {name}") } else { line }))
}

/// A refusal from the command itself ("That isn't inside one of the temp folders…").
fn refused(data: Map<String, Value>) -> HubResult<Value> {
    if data.get("ok") == Some(&Value::Bool(false)) {
        if let Some(Value::String(e)) = data.get("error") {
            return Err(http(400, e.clone()));
        }
    }
    Ok(Value::Object(data))
}

/// Everything in the machine's temp folders, one item per session folder, upload day or loose file.
pub async fn temp_list(host_id: &str) -> HubResult<Value> {
    refused(run(host_id, "ls --json", None, 60_000).await?)
}

/// Every file inside one item, newest first.
pub async fn temp_files(host_id: &str, path: &str) -> HubResult<Value> {
    if path.is_empty() {
        return Err(http(400, "Which item?"));
    }
    refused(run(host_id, &format!("files --json -- {}", shq(path)), None, 60_000).await?)
}

/// One file to look at: text, or an image as base64 up to `max` bytes.
pub async fn temp_preview(host_id: &str, path: &str, max: Option<f64>) -> HubResult<Value> {
    if path.is_empty() {
        return Err(http(400, "Which file?"));
    }
    let limit = match max {
        Some(m) if m.is_finite() && m >= 1.0 => (m.floor() as u64).min(PREVIEW_MAX),
        _ => PREVIEW_MAX,
    };
    refused(run(host_id, &format!("show --json --max {limit} -- {}", shq(path)), None, 60_000).await?)
}

/// Deletes items for good. The paths go on stdin, so a long list fits where a command line
/// wouldn't (Windows stops at 32k characters). Paths the machine refused come back in `failed`.
pub async fn temp_delete(host_id: &str, paths: Option<&Value>) -> HubResult<Value> {
    let list: Option<Vec<String>> = match paths {
        Some(Value::Array(a)) if !a.is_empty() => a.iter().map(|p| p.as_str().filter(|s| !s.is_empty()).map(str::to_owned)).collect(),
        _ => None,
    };
    let list = list.ok_or_else(|| http(400, "Send the paths to delete"))?;
    let mut data = run(host_id, "rm --stdin --json", Some(json!(list).to_string()), 120_000).await?;
    // nothing deleted is still an answer: the app shows each path and why it stayed
    if matches!(data.get("failed"), Some(Value::Array(_))) {
        data.insert("ok".into(), json!(true));
        return Ok(Value::Object(data));
    }
    refused(data)
}

#[cfg(test)]
#[path = "temp_tests.rs"]
mod tests;
