//! Port of config.ts: the machine list and the hub's settings, as records in the store.

use std::cell::RefCell;

use indexmap::IndexMap;
use inyon_protocol::HostConfig;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::platform::store::kv;

// ---------- hosts ----------

thread_local! {
    /// the machine the core runs on, when it can run commands there (the hub can, the phone app can't)
    static LOCAL: RefCell<Option<HostConfig>> = const { RefCell::new(None) };
}

pub fn set_local_host(host: Option<HostConfig>) {
    LOCAL.with(|l| *l.borrow_mut() = host);
}

pub fn load_hosts() -> Vec<HostConfig> {
    let mut hosts: Vec<HostConfig> =
        kv::get_value("hosts").and_then(|v| v.as_array().cloned()).map(|a| a.into_iter().filter_map(|h| serde_json::from_value(h).ok()).collect()).unwrap_or_default();
    if let Some(local) = LOCAL.with(|l| l.borrow().clone()) {
        if !hosts.iter().any(|h| h.id == "local") {
            hosts.insert(0, local);
        }
    }
    hosts
}

pub fn save_hosts(hosts: &[HostConfig]) -> Result<(), String> {
    kv::set("hosts", hosts)
}

// ---------- settings ----------

/// maxTotalMB: the most a machine's uploads folder keeps before the oldest go (0: no limit)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadSettings {
    pub retention_days: f64,
    #[serde(rename = "maxMB")]
    pub max_mb: f64,
    #[serde(rename = "maxTotalMB")]
    pub max_total_mb: f64,
    pub long_paste_lines: f64,
}

/// The settings as a JSON object, defaults filled in: the TS spreads whatever the file holds over
/// them, so keys this port doesn't know are kept too.
#[derive(Debug, Clone, PartialEq)]
pub struct HubSettings(pub Map<String, Value>);

impl HubSettings {
    pub fn uploads(&self) -> Option<UploadSettings> {
        self.0.get("uploads").and_then(|u| serde_json::from_value(u.clone()).ok())
    }

    /// machines where Inyon keeps a tmux session running
    pub fn keep_session(&self) -> IndexMap<String, bool> {
        self.0.get("keepSession").and_then(|v| serde_json::from_value(v.clone()).ok()).unwrap_or_default()
    }

    /// resume idle Claude sessions that stopped reporting live numbers (off unless turned on)
    pub fn auto_resume(&self) -> Option<bool> {
        self.0.get("autoResume").and_then(Value::as_bool)
    }
}

fn default_uploads() -> Map<String, Value> {
    let Value::Object(m) = serde_json::json!({ "retentionDays": 7, "maxMB": 100, "maxTotalMB": 1024, "longPasteLines": 40 }) else { unreachable!() };
    m
}

pub fn load_settings() -> HubSettings {
    let s = kv::get_value("settings").and_then(|v| v.as_object().cloned()).unwrap_or_default();
    let mut uploads = default_uploads();
    if let Some(Value::Object(u)) = s.get("uploads") {
        for (k, v) in u {
            uploads.insert(k.clone(), v.clone());
        }
    }
    let mut out = Map::new();
    out.insert("uploads".into(), Value::Object(default_uploads()));
    for (k, v) in s {
        out.insert(k, v);
    }
    out.insert("uploads".into(), Value::Object(uploads));
    HubSettings(out)
}

pub fn save_settings(s: &HubSettings) -> Result<(), String> {
    kv::set_value("settings", &Value::Object(s.0.clone()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_local_machine_comes_first_unless_the_list_has_one() {
        set_local_host(Some(serde_json::from_value(serde_json::json!({ "id": "local", "name": "box", "kind": "local" })).unwrap()));
        kv::set_value("hosts", &serde_json::json!([{ "id": "a", "name": "A", "kind": "ssh", "target": "a" }])).unwrap();
        let ids: Vec<String> = load_hosts().into_iter().map(|h| h.id).collect();
        assert_eq!(ids, vec!["local", "a"]);
    }

    #[test]
    fn settings_fill_in_the_defaults_and_keep_what_they_dont_know() {
        kv::set_value("settings", &serde_json::json!({ "uploads": { "maxMB": 5 }, "autoResume": true, "other": 1 })).unwrap();
        let s = load_settings();
        assert_eq!(
            crate::js::stringify(&Value::Object(s.0.clone())),
            r#"{"uploads":{"retentionDays":7,"maxMB":5,"maxTotalMB":1024,"longPasteLines":40},"autoResume":true,"other":1}"#
        );
        assert_eq!(s.auto_resume(), Some(true));
    }
}
