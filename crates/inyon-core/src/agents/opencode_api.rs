//! The parsing in agents/opencode-api.ts: model ids, and the catalog and agents a session's own
//! server lists. The client that makes the requests (`OpenCodeClient`, `opencodeRequest`) is the
//! HTTP side and stays with the caller.

use std::collections::HashSet;

use inyon_protocol::{AgentCatalog, AgentModel, CatalogSource, ModeOption};
use serde::Serialize;
use serde_json::Value;

use super::opencode_models::{note_provider_names, variant_names};
use crate::js::json::{value_string, Js};
use crate::js::text::capitalize;

/// What a prompt runs with, as the TUI's footer shows it: "provider/model", the variant, the agent.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct OpenCodeSelection {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub variant: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
}

/// A model as the API takes it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct OpenCodeModel {
    #[serde(rename = "providerID")]
    pub provider_id: String,
    #[serde(rename = "modelID")]
    pub model_id: String,
}

/// "provider/model" (the model part may hold more slashes) → its two halves.
pub fn open_code_model(id: &str) -> Result<OpenCodeModel, String> {
    match id.find('/') {
        Some(slash) if slash >= 1 && slash != id.len() - 1 => Ok(OpenCodeModel { provider_id: id[..slash].to_owned(), model_id: id[slash + 1..].to_owned() }),
        _ => Err("Choose an OpenCode provider/model".into()),
    }
}

/// Never return raw provider objects: they include provider.key/options/headers.
pub fn open_code_catalog_from_providers(payload: &Value, now: u64) -> AgentCatalog {
    let p = Some(payload);
    let connected: HashSet<String> = p.at("connected").arr().map(|a| a.iter().map(value_string).collect()).unwrap_or_default();
    let all = p.at("all").arr().map(Vec::as_slice).unwrap_or_default();
    note_provider_names(all.iter().filter_map(|x| Some((x.get("id")?.as_str()?, x.get("name")?.as_str()?))));
    let mut models = vec![];
    for provider in all {
        let provider = Some(provider);
        let Some(pid) = provider.at("id").str().filter(|id| connected.contains(*id)) else { continue };
        for (key, model) in provider.at("models").obj().into_iter().flatten() {
            let model = Some(model);
            if !model.truthy() || model.at("status").str() == Some("deprecated") {
                continue;
            }
            let id = model.at("id").str().unwrap_or(key);
            let pname = provider.at("name").present().map_or_else(|| pid.to_owned(), value_string);
            let mname = model.at("name").present().map_or_else(|| id.to_owned(), value_string);
            models.push(AgentModel {
                id: format!("{pid}/{id}"),
                label: format!("{pname} · {mname}"),
                note: None,
                context: model.at("limit").at("context").num().map(inyon_protocol::Num),
                efforts: Some(variant_names(model.at("variants"))),
                default_effort: None,
                variants: None,
            });
        }
    }
    AgentCatalog { models, source: CatalogSource::Cli, updated_at: now, error: None, modes: None }
}

/// The agents a session can switch to: the primary ones, custom ones included; never the hidden
/// internal ones.
pub fn open_code_agents_from(payload: &Value) -> Vec<ModeOption> {
    payload
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .filter(|a| {
            let a = Some(*a);
            a.at("name").str().is_some() && !a.at("hidden").truthy() && a.at("mode").str() != Some("subagent")
        })
        .map(|a| {
            let name = a["name"].as_str().unwrap_or("");
            ModeOption { id: name.to_owned(), label: capitalize(name) }
        })
        .collect()
}
