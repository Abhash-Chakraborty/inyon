//! Port of agents/opencode-keys.ts: the keys Inyon presses in OpenCode's terminal, as OpenCode
//! 1.19 binds them unless the config says otherwise (`keybinds` in opencode.json, user or
//! project). The command that reads those files is built here; the caller runs and caches it.

use indexmap::IndexMap;
use serde::Serialize;
use serde_json::Value;

use crate::hosts::host::shq;
use crate::js::json;
use crate::re;

/// The default bindings, in OpenCode's order.
pub const DEFAULT_KEYS: &[(&str, &str)] = &[
    ("leader", "ctrl+x"),
    ("agent_cycle", "tab"),
    ("agent_cycle_reverse", "shift+tab"),
    ("variant_cycle", "ctrl+t"),
    ("model_list", "<leader>m"),
    ("session_interrupt", "escape"),
];

pub const DEFAULT_LEADER: &str = "ctrl+x";

fn default_key(name: &str) -> &'static str {
    DEFAULT_KEYS.iter().find(|(k, _)| *k == name).map_or("", |(_, v)| v)
}

/// The keys to press for each action.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct OpenCodeKeys {
    pub agent_cycle: Vec<String>,
    pub agent_cycle_reverse: Vec<String>,
    pub variant_cycle: Vec<String>,
    pub model_list: Vec<String>,
    pub session_interrupt: Vec<String>,
}

fn named(key: &str) -> Option<&'static str> {
    Some(match key {
        "tab" => "Tab",
        "escape" | "esc" => "Escape",
        "return" | "enter" => "Enter",
        "space" => "Space",
        "backspace" => "BSpace",
        "up" => "Up",
        "down" => "Down",
        "left" => "Left",
        "right" => "Right",
        "home" => "Home",
        "end" => "End",
        "pageup" => "PageUp",
        "pagedown" => "PageDown",
        _ => return None,
    })
}

/// One binding as OpenCode writes it ("ctrl+t", "shift+tab", `<leader>m`, "f2"; alternatives
/// separated by commas) as the keys `tmux send-keys` takes, or None when none of its alternatives
/// can be sent that way (super, shift with most keys).
pub fn tmux_keys(binding: &str, leader: Option<&str>) -> Option<Vec<String>> {
    let leader = leader.unwrap_or(DEFAULT_LEADER);
    for alt in binding.split(',').map(|s| crate::js::text::lower(crate::js::JsStr::jtrim(s))).filter(|s| !s.is_empty()) {
        if alt == "none" {
            continue;
        }
        if let Some(rest) = alt.strip_prefix("<leader>") {
            if let (Some(first), Some(rest)) = (tmux_keys(leader, None), tmux_keys(rest, Some(leader))) {
                return Some([first, rest].concat());
            }
            continue;
        }
        let mut parts: Vec<&str> = alt.split('+').collect();
        let key = parts.pop().unwrap_or("");
        let has = |m: &str| parts.contains(&m);
        if has("super") || has("cmd") || has("meta") {
            continue;
        }
        let mut name = if let Some(n) = named(key) {
            n.to_owned()
        } else if re!(r"^f([1-9]|1[0-2])$").is_match(key) {
            key.to_uppercase()
        } else if re!(r"^[a-z0-9]$").is_match(key) {
            key.to_owned()
        } else {
            continue;
        };
        if has("shift") {
            if name == "Tab" {
                name = "BTab".into();
            } else if re!(r"^[a-z]$").is_match(&name) {
                name = name.to_uppercase();
            } else {
                continue;
            }
        }
        let ctrl = has("ctrl") || has("control");
        let alt_ = has("alt") || has("option");
        if (ctrl || alt_) && !re!(r"^[a-zA-Z0-9]$").is_match(&name) {
            continue;
        }
        return Some(vec![format!("{}{}{name}", if ctrl { "C-" } else { "" }, if alt_ { "M-" } else { "" })]);
    }
    None
}

/// `keybinds` from the files OpenCode reads (user, then the project's), later ones winning.
pub fn merge_keybinds(files: &[&str]) -> IndexMap<String, String> {
    let mut out = IndexMap::new();
    for text in files {
        let Some(Value::Object(config)) = parse_jsonc(text) else { continue };
        let Some(Value::Object(binds)) = config.get("keybinds") else { continue };
        for (k, v) in binds {
            if let Value::String(v) = v {
                out.insert(k.clone(), v.clone());
            }
        }
    }
    out
}

/// JSON with comments and trailing commas, as opencode.jsonc allows; None when it doesn't parse.
pub fn parse_jsonc(text: &str) -> Option<Value> {
    let c: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < c.len() {
        let ch = c[i];
        if ch == '"' {
            let mut j = i + 1;
            while j < c.len() && c[j] != '"' {
                j += if c[j] == '\\' { 2 } else { 1 };
            }
            out.extend(&c[i..(j + 1).min(c.len())]);
            i = j + 1;
        } else if ch == '/' && c.get(i + 1) == Some(&'/') {
            while i < c.len() && c[i] != '\n' {
                i += 1;
            }
        } else if ch == '/' && c.get(i + 1) == Some(&'*') {
            let end = (i + 2..c.len().saturating_sub(1)).find(|&k| c[k] == '*' && c[k + 1] == '/');
            i = end.map_or(c.len(), |e| e + 2);
        } else {
            out.push(ch);
            i += 1;
        }
    }
    json::parse(&re!(r",(\s*[}\]])", "g").replace_all(&out, "$1"))
}

/// The keys to press for each action, from the bindings (defaults filled in).
pub fn keys_from(binds: &IndexMap<String, String>) -> OpenCodeKeys {
    let leader = binds.get("leader").map_or(DEFAULT_LEADER, String::as_str);
    let keys = |name: &str| tmux_keys(binds.get(name).map_or(default_key(name), String::as_str), Some(leader)).or_else(|| tmux_keys(default_key(name), None)).unwrap_or_default();
    OpenCodeKeys {
        agent_cycle: keys("agent_cycle"),
        agent_cycle_reverse: keys("agent_cycle_reverse"),
        variant_cycle: keys("variant_cycle"),
        model_list: keys("model_list"),
        session_interrupt: keys("session_interrupt"),
    }
}

/// The command printing the user's and the project's config files, each after "@@FILE".
pub fn opencode_keys_command(cwd: Option<&str>) -> String {
    let mut files = vec![r#""${XDG_CONFIG_HOME:-$HOME/.config}/opencode/opencode.json""#.to_owned(), r#""${XDG_CONFIG_HOME:-$HOME/.config}/opencode/opencode.jsonc""#.to_owned()];
    if let Some(cwd) = cwd.filter(|c| !c.is_empty()) {
        let q = shq(cwd);
        files.extend([format!("{q}/opencode.json"), format!("{q}/opencode.jsonc"), format!("{q}/.opencode/opencode.json"), format!("{q}/.opencode/opencode.jsonc")]);
    }
    format!(r#"for f in {}; do [ -f "$f" ] && {{ echo "@@FILE"; cat "$f"; echo; }}; done; true"#, files.join(" "))
}

/// The keys from what that command printed.
pub fn opencode_keys(stdout: &str) -> OpenCodeKeys {
    let files: Vec<&str> = stdout.split("@@FILE\n").skip(1).collect();
    keys_from(&merge_keybinds(&files))
}

#[cfg(test)]
#[path = "opencode_keys_tests.rs"]
mod tests;
