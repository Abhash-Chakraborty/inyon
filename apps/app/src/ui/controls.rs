//! Model, effort, permission mode and goal in the composer, where you use them
//! (components/session/ComposerControls.tsx). Each chip opens the agent's own choices; a pick the
//! agent can't take while it works waits on the hub (chosen.rs) and its chip says so.

use std::cell::Cell;
use std::rc::Rc;

use dioxus::prelude::*;
use inyon_chat_core::format::model_name;
use inyon_protocol::{AgentCatalog, AgentKind, AgentModel, AgentStatus, ChatGoal, ChatInfo, ChosenControls, ModeOption};

use super::icons::{AgentMark, Glyph, Icon};
use super::kit::{Busy, Field, Segmented, Sheet, Toggle};
use super::menu::{self, Action, Item};
use super::session_menu::{Now, SessionAct, SessionOp};
use super::toast::{self, confirm, Ask, ToastTone};
use crate::route::Route;
use crate::{api, platform};

/// Agents whose model list the hub reads from the CLI (agy models, Codex's models cache).
const LIVE: [AgentKind; 4] = [AgentKind::Antigravity, AgentKind::Codex, AgentKind::Opencode, AgentKind::Copilot];

/// Codex, Copilot and OpenCode name their modes themselves; the others share Claude's names.
fn own_modes(agent: AgentKind) -> bool {
    matches!(agent, AgentKind::Codex | AgentKind::Copilot | AgentKind::Opencode)
}

pub fn effort_label(e: &str) -> String {
    match e {
        "default" => "Default",
        "none" => "None",
        "minimal" => "Minimal",
        "low" => "Low",
        "medium" => "Medium",
        "high" => "High",
        "xhigh" => "X-high",
        "max" => "Max",
        "ultra" => "Ultra",
        other => other,
    }
    .to_string()
}

/// A catalog label without its provider ("OpenAI · GPT-5" → "GPT-5").
/// A level as the controls sheet's row of levels names it, short enough for six side by side.
pub fn effort_short(e: &str) -> String {
    match e {
        "default" => "Default".into(),
        "none" => "None".into(),
        "minimal" => "Min".into(),
        "low" => "Low".into(),
        "medium" => "Med".into(),
        "high" => "High".into(),
        "xhigh" => "X-high".into(),
        "max" => "Max".into(),
        "ultra" => "Ultra".into(),
        e => e.into(),
    }
}

fn short(label: &str) -> &str {
    label.rsplit(" · ").next().unwrap_or(label)
}

/// The model in `models` the agent runs: its exact id when it reports one, else the label it shows
/// ("Opus 5.5" → "opus"), else the longest id or label the name holds, so "gpt-5" never stands in
/// for "gpt-5.1-codex".
pub fn current_model_id(models: &[AgentModel], status: Option<&AgentStatus>, model: Option<&str>) -> Option<String> {
    let model_id = status.and_then(|s| s.model_id.as_deref());
    if let Some(id) = model_id.filter(|id| models.iter().any(|m| m.id == *id)) {
        return Some(id.to_string());
    }
    let label = status.and_then(|s| s.model.as_deref()).or(model).unwrap_or("").to_lowercase();
    if !label.is_empty() {
        if let Some(m) = models.iter().find(|m| m.label.to_lowercase() == label || short(&m.label).to_lowercase() == label) {
            return Some(m.id.clone());
        }
    }
    let mut by_length: Vec<&AgentModel> = models.iter().collect();
    by_length.sort_by_key(|m| std::cmp::Reverse(m.id.len()));
    by_length
        .into_iter()
        .find(|m| (!label.is_empty() && (label.contains(&m.label.to_lowercase()) || label.contains(&m.id.to_lowercase()))) || model_id.unwrap_or("").contains(&m.id))
        .map(|m| m.id.clone())
}

/// What a mode reads as: the agent's own name for it, or Claude's names for the others.
pub fn mode_label(mode: Option<&str>, agent: AgentKind, modes: &[ModeOption]) -> String {
    let mode = mode.filter(|m| !m.is_empty());
    if own_modes(agent) {
        let id = mode.unwrap_or("default");
        if let Some(m) = modes.iter().find(|m| m.id == id) {
            return m.label.clone();
        }
        return match mode {
            Some(m) if agent == AgentKind::Opencode => {
                let mut c = m.chars();
                c.next().map_or_else(String::new, |f| f.to_uppercase().chain(c).collect())
            }
            Some(m) => m.to_string(),
            None => "Default".into(),
        };
    }
    claude_mode(mode).map_or_else(|| mode.unwrap_or_default().to_string(), str::to_string)
}

fn claude_mode(mode: Option<&str>) -> Option<&'static str> {
    let Some(m) = mode else { return Some("Ask each time") };
    if matches!(m, "manual" | "default" | "normal") {
        Some("Ask each time")
    } else if m.contains("accept") {
        Some("Accept edits")
    } else if m.contains("plan") {
        Some("Plan")
    } else if m.contains("bypass") {
        Some("Bypass permissions")
    } else if m.contains("auto") {
        Some("Auto")
    } else {
        None
    }
}

/// Whether the agent's `mode` is the mode with this id.
pub fn mode_matches(mode: Option<&str>, id: &str, agent: AgentKind) -> bool {
    let mode = mode.filter(|m| !m.is_empty());
    if own_modes(agent) {
        return mode.unwrap_or("default") == id;
    }
    let l = claude_mode(mode);
    matches!(
        (id, l),
        ("default", Some("Ask each time"))
            | ("acceptEdits", Some("Accept edits"))
            | ("plan", Some("Plan"))
            | ("auto", Some("Auto"))
            | ("bypassPermissions", Some("Bypass permissions"))
    )
}

/// Everything the chips show, worked out from the session as the hub reports it.
#[derive(Debug, Clone, PartialEq)]
pub struct Controls {
    pub host: String,
    pub host_name: String,
    pub pane: String,
    pub agent: AgentKind,
    pub models: Vec<AgentModel>,
    pub modes: Vec<ModeOption>,
    /// the model running, as an id in `models`
    pub model: Option<String>,
    pub model_label: String,
    /// the level running: the model's own default when the agent doesn't name one
    pub effort: Option<String>,
    pub efforts: Vec<String>,
    pub mode: Option<String>,
    pub chosen: Option<ChosenControls>,
    pub goal: Option<ChatGoal>,
    pub ultracode: bool,
    /// the hub has confirmed the pane is this session, so picks may go to it; until then (after a
    /// reload, or while the machine is away) the chips are inert
    pub ready: bool,
}

/// What the session says, for [`Controls::of`].
#[derive(Debug, Clone, Default)]
pub struct Reported<'a> {
    pub catalog: Option<&'a AgentCatalog>,
    pub status: Option<&'a AgentStatus>,
    /// the model the screen or the conversation's record names
    pub model: Option<&'a str>,
    /// the level the screen shows, for a session whose numbers haven't come yet
    pub effort: Option<&'a str>,
    pub mode: Option<&'a str>,
    pub chosen: Option<&'a ChosenControls>,
    pub goal: Option<&'a ChatGoal>,
    pub ultracode: bool,
}

impl Controls {
    pub fn of(host: &str, host_name: &str, pane: &str, agent: AgentKind, r: Reported) -> Controls {
        let def = agent.def();
        // the machine's own lists when the agent has them: OpenCode's models and agents
        let models = r.catalog.map_or_else(|| def.models.clone(), |c| c.models.clone());
        let modes = r.catalog.and_then(|c| c.modes.clone()).unwrap_or_else(|| def.modes.clone());
        // Copilot's numbers can still name the model it ran before a switch; its screen is current
        let model = match (agent, r.model) {
            (AgentKind::Copilot, Some(_)) => current_model_id(&models, None, r.model).or_else(|| current_model_id(&models, r.status, r.model)),
            _ => current_model_id(&models, r.status, r.model),
        };
        let selected = model.as_ref().and_then(|id| models.iter().find(|m| m.id == *id));
        let label = selected.map(|m| short(&m.label).to_string());
        let model_label = label.or(r.status.and_then(|s| s.model.clone())).or(r.model.map(|m| model_name(Some(m)))).unwrap_or_else(|| "Default model".into());
        // "default", or no level from a session that reports, is the model's own default level
        let reported = r.status.and_then(|s| s.effort.as_deref()).or(r.effort).filter(|e| *e != "default").map(str::to_string);
        let effort = match (reported, r.status) {
            (Some(e), _) => Some(e),
            (None, Some(_)) => selected.and_then(|m| m.default_effort.clone()),
            (None, None) => None,
        };
        let mut c = Controls {
            host: host.into(),
            host_name: host_name.into(),
            pane: pane.into(),
            agent,
            models,
            modes,
            model,
            model_label,
            effort,
            mode: r.mode.map(str::to_string),
            chosen: r.chosen.cloned(),
            goal: r.goal.cloned(),
            ultracode: r.ultracode,
            ready: true,
            efforts: Vec::new(),
        };
        // the levels of the model it's switching to, if one is waiting, so a level picked meanwhile
        // keeps that model
        c.efforts = levels(agent, c.target());
        c
    }

    /// The model a level applies to: the one waiting to go in, else the one running.
    fn target(&self) -> Option<&AgentModel> {
        self.pending(|c| c.model.as_ref()).and_then(|v| self.chosen_model(&v)).or_else(|| self.selected())
    }

    fn selected(&self) -> Option<&AgentModel> {
        self.model.as_ref().and_then(|id| self.models.iter().find(|m| m.id == *id))
    }

    fn act(&self, op: ControlOp) -> Action {
        Action::Control(ControlAct { host: self.host.clone(), pane: self.pane.clone(), op })
    }

    /// The command that picks model `id`, keeping the level for a family that names it in its id.
    pub fn model_command(&self, id: &str) -> Option<String> {
        let def = self.agent.def();
        let m = self.models.iter().find(|m| m.id == id);
        let variants = m.and_then(|m| m.variants.as_ref());
        let variant = variants.and_then(|v| self.effort.as_ref().and_then(|e| v.get(e)).or_else(|| v.values().next()));
        def.model_command(variant.map_or(id, String::as_str), self.effort.as_deref())
    }

    /// The command that sets `level`: a family's own model id for it, or the agent's effort command.
    pub fn effort_command(&self, level: &str) -> Option<String> {
        match self.target().and_then(|m| m.variants.as_ref()).and_then(|v| v.get(level)) {
            Some(variant) => Some(format!("/model {variant}")),
            None => self.agent.def().effort_command(level),
        }
    }

    /// The model a pick held for later names: its id, or the agent's own `/model` value for it.
    pub fn chosen_model(&self, value: &str) -> Option<&AgentModel> {
        let def = self.agent.def();
        self.models.iter().find(|m| {
            m.id == value
                || m.variants.as_ref().is_some_and(|v| v.values().any(|x| x == value))
                || def.model_command(&m.id, self.effort.as_deref()).as_deref() == Some(&format!("/model {value}"))
        })
    }

    fn mode_label(&self, mode: Option<&str>) -> String {
        mode_label(mode, self.agent, &self.modes)
    }

    /// What a chip and its menu show for a pick held until the agent is free: the value marked
    /// as waiting, or why it didn't take.
    fn waiting(&self, picked: Option<&str>, label: Option<String>, current: &str) -> Option<Waiting> {
        picked?;
        let label = label?;
        let drop = self.act(ControlOp::DropChosen);
        let name = &self.agent.def().name;
        Some(match self.chosen.as_ref().and_then(|c| c.error.clone()) {
            Some(error) => Waiting {
                failed: true,
                title: format!("Couldn't switch to {label}: {error}"),
                item: Item::new(format!("Couldn't switch to {label}"), Icon::CircleAlert, drop).hint(error).separated(),
            },
            None => {
                // the hub drops every waiting switch at once, so say so when there's more than one
                let waiting = self.chosen.as_ref().map_or(0, |c| [c.model.is_some(), c.effort.is_some(), c.mode.is_some()].iter().filter(|w| **w).count());
                let hint = if waiting > 1 { "Cancels every waiting switch".to_string() } else { format!("Keeps {current}") };
                Waiting { failed: false, title: format!("Switches to {label} when {name} is free"), item: Item::new("Don't switch", Icon::X, drop).hint(hint).separated() }
            }
        })
    }

    /// A pick still on its way (not one that failed).
    fn pending(&self, f: impl Fn(&ChosenControls) -> Option<&String>) -> Option<String> {
        self.chosen.as_ref().filter(|c| c.error.is_none()).and_then(|c| f(c).cloned())
    }

    pub fn model_chip(&self) -> Option<Chip> {
        let opencode = self.agent == AgentKind::Opencode;
        if self.models.is_empty() && !opencode {
            return None;
        }
        let picked = self.chosen.as_ref().and_then(|c| c.model.as_deref());
        let picked_model = picked.and_then(|p| self.chosen_model(p));
        let picked_label = picked.map(|p| picked_model.map_or(p.to_string(), |m| short(&m.label).to_string()));
        let w = self.waiting(picked, picked_label.clone(), &self.model_label);
        let on = self.pending(|c| c.model.as_ref()).map(|_| picked_model.map(|m| m.id.clone())).unwrap_or(self.model.clone());
        let mut items = vec![Item::header("Model")];
        for m in &self.models {
            let mut it = Item::new(m.label.clone(), Icon::Bot, self.act(ControlOp::Setting(self.model_command(&m.id).unwrap_or_default(), "Could not switch model")))
                .checked(on.as_deref() == Some(&m.id));
            if let Some(n) = &m.note {
                it = it.hint(n.clone());
            }
            items.push(it);
        }
        // OpenCode's list is what its connected providers offer; one more provider adds to it
        if opencode {
            let it = Item::new("Connect a provider…", Icon::Plug, self.act(ControlOp::Providers));
            items.push(if self.models.is_empty() { it } else { it.separated() });
        }
        let text = match (&w, &picked_label) {
            (Some(w), Some(l)) if !w.failed => l.clone(),
            _ => self.model_label.clone(),
        };
        Some(Chip::new("control-model", text, w.as_ref().map_or("Model".into(), |w| w.title.clone()), items, w))
    }

    pub fn effort_chip(&self) -> Option<Chip> {
        if self.efforts.is_empty() {
            return None;
        }
        let current = self.effort.as_deref().map_or("Default".into(), effort_label);
        let picked = self.chosen.as_ref().and_then(|c| c.effort.as_deref());
        let w = self.waiting(picked, picked.map(effort_label), &current);
        let pending = self.pending(|c| c.effort.as_ref());
        let on = pending.clone().or(self.effort.clone());
        let mut items = vec![Item::header("Reasoning effort")];
        // OpenCode runs a model without a variant unless one is picked
        if self.agent == AgentKind::Opencode {
            items.push(
                Item::new("Default", Icon::Gauge, self.act(ControlOp::Setting(self.effort_command("default").unwrap_or_default(), "Could not change effort")))
                    .checked(on.is_none()),
            );
        }
        for e in &self.efforts {
            items.push(
                Item::new(effort_label(e), Icon::Gauge, self.act(ControlOp::Setting(self.effort_command(e).unwrap_or_default(), "Could not change effort")))
                    .checked(on.as_deref() == Some(e)),
            );
        }
        // Claude Code keeps its ultracode switch next to the levels; so does this menu
        if self.agent.def().set.ultracode.is_some() {
            let on = self.ultracode;
            let act = Action::Session(SessionAct { host: self.host.clone(), pane: self.pane.clone(), agent: Some(self.agent), op: SessionOp::Ultracode(!on) });
            items.push(Item::new(format!("Ultracode: {}", if on { "on" } else { "off" }), Icon::Gauge, act).hint("A dynamic workflow for every task").toggled(on).separated());
        }
        let shown = pending.as_deref().map_or(current.clone(), effort_label);
        let title = w.as_ref().map_or_else(
            || format!("Reasoning effort{}{}", self.effort.as_ref().map_or(String::new(), |_| format!(": {current}")), if self.ultracode { " · Ultracode on" } else { "" }),
            |w| w.title.clone(),
        );
        let mut chip = Chip::new("control-effort", shown, title, items, w);
        chip.bars = Some(bars(on.as_deref(), &self.efforts));
        chip.ultracode = self.ultracode;
        Some(chip)
    }

    pub fn mode_chip(&self) -> Option<Chip> {
        if self.modes.is_empty() {
            return None;
        }
        let what = if self.agent == AgentKind::Opencode { "Agent" } else { "Permission mode" };
        let current = self.mode_label(self.mode.as_deref());
        let picked = self.chosen.as_ref().and_then(|c| c.mode.as_deref());
        let w = self.waiting(picked, picked.map(|m| self.mode_label(Some(m))), &current);
        let pending = self.pending(|c| c.mode.as_ref());
        let mut items = vec![Item::header(what)];
        for m in &self.modes {
            let on = pending.as_ref().map_or_else(|| mode_matches(self.mode.as_deref(), &m.id, self.agent), |p| *p == m.id);
            items.push(Item::new(m.label.clone(), Icon::Shield, self.act(ControlOp::Mode(m.id.clone()))).checked(on));
        }
        let title = w.as_ref().map_or_else(|| format!("{what}: {current}"), |w| w.title.clone());
        let mut chip = Chip::new("control-mode", self.mode_label(pending.as_deref().or(self.mode.as_deref())), title, items, w);
        chip.icon = Some(Icon::Shield);
        chip.narrow_word = false;
        Some(chip)
    }

    /// A goal that's on (set and not met yet).
    pub fn goal_on(&self) -> Option<&ChatGoal> {
        self.goal.as_ref().filter(|g| !g.met)
    }
}

struct Waiting {
    failed: bool,
    title: String,
    item: Item,
}

/// One chip: what it reads, its tooltip and its menu.
#[derive(Debug, Clone, PartialEq)]
pub struct Chip {
    pub id: &'static str,
    pub text: String,
    pub title: String,
    pub items: Vec<Item>,
    /// the pick waits for the agent (a clock), or didn't take (a warning)
    pub mark: Option<bool>,
    pub icon: Option<Icon>,
    /// the effort's bars: how many of four are lit
    pub bars: Option<usize>,
    pub ultracode: bool,
    /// the word stays on a narrow composer (the mode shows only its shield there)
    pub narrow_word: bool,
}

impl Chip {
    fn new(id: &'static str, text: String, title: String, mut items: Vec<Item>, w: Option<Waiting>) -> Chip {
        let mark = w.as_ref().map(|w| w.failed);
        if let Some(w) = w {
            items.push(w.item);
        }
        Chip { id, text, title, items, mark, icon: None, bars: None, ultracode: false, narrow_word: true }
    }
}

/// How many of the effort's four bars are lit for `level` among `levels`.
pub fn bars(level: Option<&str>, levels: &[String]) -> usize {
    let Some(i) = level.and_then(|l| levels.iter().position(|x| x == l)) else { return 0 };
    let top = levels.len().saturating_sub(1).max(1) as f64;
    ((i as f64 / top) * 3.0).round() as usize + 1
}

/// What a chip's menu does to the session.
#[derive(Debug, Clone, PartialEq)]
pub enum ControlOp {
    /// a command typed into the agent that the chat doesn't show (model, effort, goal), and
    /// what to say if it fails
    Setting(String, &'static str),
    Mode(String),
    DropChosen,
    /// OpenCode's providers sheet
    Providers,
    /// the session controls sheet: everything the chips do, the switches and the Usage panel
    Sheet,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ControlAct {
    pub host: String,
    pub pane: String,
    pub op: ControlOp,
}

// one composer at a time, so its sheets can be opened from a menu
static GOAL_OPEN: GlobalSignal<bool> = Signal::global(|| false);
static PROVIDERS_OPEN: GlobalSignal<bool> = Signal::global(|| false);
static SHEET_OPEN: GlobalSignal<bool> = Signal::global(|| false);
/// bumped when a provider is connected or disconnected, so the model list is read again
static MODELS_CHANGED: GlobalSignal<u32> = Signal::global(|| 0);

fn close_sheets() {
    *GOAL_OPEN.write() = false;
    *PROVIDERS_OPEN.write() = false;
    *SHEET_OPEN.write() = false;
}

pub fn open_goal() {
    *GOAL_OPEN.write() = true;
}

pub fn run(act: ControlAct) {
    let ControlAct { host, pane, op } = act;
    match op {
        ControlOp::Providers => *PROVIDERS_OPEN.write() = true,
        ControlOp::Sheet => *SHEET_OPEN.write() = true,
        ControlOp::Setting(text, fail) => {
            spawn(async move {
                setting(&host, &pane, &text, fail).await;
            });
        }
        ControlOp::Mode(mode) => {
            spawn(async move {
                if let Err(e) = api::mode(&host, &pane, &mode).await {
                    toast::toast("Could not switch mode", Some(e.message), ToastTone::Error);
                }
            });
        }
        ControlOp::DropChosen => {
            spawn(async move {
                if let Err(e) = api::drop_chosen(&host, &pane).await {
                    toast::toast("Could not cancel the switch", Some(e.message), ToastTone::Error);
                }
            });
        }
    }
}

async fn setting(host: &str, pane: &str, text: &str, fail: &str) -> bool {
    if text.is_empty() {
        return false;
    }
    match api::setting(host, pane, text).await {
        Ok(()) => true,
        Err(e) => {
            toast::toast(fail, Some(e.message), ToastTone::Error);
            false
        }
    }
}

/// The machine's own model list for agents that have one, read again every minute and when a
/// provider changes; none for the others, which use the catalog's.
pub fn use_catalog(host: &str, pane: &str, agent: Option<AgentKind>) -> Option<AgentCatalog> {
    let key = format!("{host}:{pane}:{}", agent.map_or("", |a| a.as_str()));
    let live = agent.is_some_and(|a| LIVE.contains(&a));
    let mut got = use_signal(|| None::<(String, AgentCatalog)>);
    let gen = use_hook(|| Rc::new(Cell::new(0u32)));
    let (h, p) = (host.to_string(), pane.to_string());
    use_effect(use_reactive!(|key, live| {
        let _ = MODELS_CHANGED();
        let n = gen.get() + 1;
        gen.set(n);
        if !live {
            return;
        }
        let (gen, h, p) = (gen.clone(), h.clone(), p.clone());
        spawn(async move {
            while gen.get() == n {
                if let Ok(c) = api::models(&h, &p).await {
                    if gen.get() == n {
                        got.set(Some((key.clone(), c)));
                    }
                }
                platform::sleep(60_000).await;
            }
        });
    }));
    let c = got.read().as_ref().filter(|(k, _)| *k == key).map(|(_, c)| c.clone());
    c
}

/// The levels a model offers: its own list, else the agent's, and none for an agent without
/// levels unless the model has variants for them.
fn levels(agent: AgentKind, m: Option<&AgentModel>) -> Vec<String> {
    let def = agent.def();
    if def.set.effort.is_some() || m.is_some_and(|m| m.variants.is_some()) {
        m.and_then(|m| m.efforts.clone()).unwrap_or_else(|| def.efforts.clone())
    } else {
        Vec::new()
    }
}

/// The chips, in the composer's bar.
#[component]
pub fn ControlChips(c: Controls) -> Element {
    let mut menu_at = use_context::<Signal<Option<menu::Menu>>>();
    // a session that can't take picks closes a chip's menu (ControlSheets closes the sheets)
    let ready = c.ready;
    use_effect(use_reactive!(|ready| {
        if !ready && menu_at.peek().as_ref().is_some_and(|m| m.of_controls()) {
            menu_at.set(None);
        }
    }));
    let chips: Vec<Chip> = [c.model_chip(), c.effort_chip(), c.mode_chip()].into_iter().flatten().collect();
    let goal = c.goal_on().cloned();
    let has_goal = c.agent.def().set.goal.is_some();
    rsx! {
        div { class: "controls no-scrollbar",
            for chip in chips {
                button {
                    key: "{chip.id}",
                    id: chip.id,
                    class: if chip.narrow_word { "control-chip press" } else { "control-chip control-icon-only press" },
                    r#type: "button",
                    title: "{chip.title}",
                    "aria-label": "{chip.title}",
                    "aria-haspopup": "menu",
                    disabled: !ready,
                    onmousedown: move |e| e.prevent_default(),
                    onclick: {
                        let (id, items) = (chip.id, chip.items.clone());
                        move |_| menu::drop_up(&mut menu_at, id, items.clone())
                    },
                    match chip.mark {
                        Some(true) => rsx! { Glyph { icon: Icon::CircleAlert, size: 14, class: "control-failed" } },
                        Some(false) => rsx! { Glyph { icon: Icon::Clock3, size: 12, class: "control-waiting" } },
                        None => rsx! {
                            if let Some(icon) = chip.icon {
                                Glyph { icon, size: 14 }
                            }
                        },
                    }
                    if let Some(lit) = chip.bars {
                        span { class: "effort-bars", "aria-hidden": "true",
                            for n in 0..4usize {
                                span { key: "{n}", class: if n < lit { "effort-bar on" } else { "effort-bar" }, style: "height: {5.0 + n as f64 * 2.5}px" }
                            }
                        }
                    }
                    span { class: "control-word truncate", "{chip.text}" }
                    if chip.ultracode {
                        Glyph { icon: Icon::Gauge, size: 14, class: "ultracode-mark" }
                    }
                    if chip.id == "control-model" {
                        Glyph { icon: Icon::ChevronDown, size: 12, class: "control-caret" }
                    }
                }
            }
            if has_goal {
                button {
                    class: if goal.is_some() { "control-chip control-goal press" } else { "control-chip control-icon-only press" },
                    r#type: "button",
                    title: goal.as_ref().map_or("Set a goal".to_string(), |g| format!("Goal: {}", g.condition)),
                    "aria-label": goal.as_ref().map_or("Set a goal".to_string(), |g| format!("Goal: {}", g.condition)),
                    disabled: !ready,
                    onmousedown: move |e| e.prevent_default(),
                    onclick: move |_| open_goal(),
                    Glyph { icon: Icon::Target, size: 14 }
                    span { class: "control-word truncate", {goal.as_ref().map_or("Goal".to_string(), |g| g.condition.clone())} }
                }
            }
        }
    }
}

/// What the session controls sheet needs besides the chips: whether the agent is asking
/// something, what's switched on, and the numbers for its Usage part.
#[derive(Debug, Clone, PartialEq)]
pub struct SheetOf {
    pub asking: bool,
    pub now: Now,
    pub status: Option<AgentStatus>,
    pub info: Option<ChatInfo>,
}

/// The sheets the chips and the header open, kept with the session rather than the message box
/// so they open from the terminal view as well.
#[component]
pub fn ControlSheets(c: Controls, of: SheetOf) -> Element {
    // a session that can't take picks closes them, and one left open doesn't follow you to the
    // next session
    let ready = c.ready;
    use_effect(use_reactive!(|ready| {
        if !ready {
            close_sheets();
        }
    }));
    use_drop(close_sheets);
    rsx! {
        ControlsSheet { c: c.clone(), of }
        GoalSheet { c: c.clone() }
        if c.agent == AgentKind::Opencode {
            super::setup::ProvidersSheet {
                host: c.host.clone(),
                host_name: c.host_name.clone(),
                open: PROVIDERS_OPEN(),
                on_close: move |_| {
                    *PROVIDERS_OPEN.write() = false;
                    *MODELS_CHANGED.write() += 1;
                },
            }
        }
    }
}

/// One of the sheet's buttons under the switches: a session action, or one that asks first.
#[derive(Clone, PartialEq)]
struct Tile {
    label: &'static str,
    icon: Icon,
    action: Action,
    danger: bool,
    /// a confirm before it goes (Clear)
    ask: Option<(&'static str, &'static str, &'static str)>,
}

/// The buttons under the switches, as the web app's controls sheet lists them for `agent`.
fn tiles(c: &Controls, now: &Now) -> Vec<Tile> {
    let def = c.agent.def();
    let kind = c.agent;
    let session = |op: SessionOp| Action::Session(SessionAct { host: c.host.clone(), pane: c.pane.clone(), agent: Some(kind), op });
    let tile = |label, icon, action| Tile { label, icon, action, danger: false, ask: None };
    let mut v = Vec::new();
    if let Some(cmd) = &def.set.compact {
        v.push(tile("Compact", Icon::Shrink, session(SessionOp::Send(cmd.clone(), "Could not compact"))));
    }
    if matches!(kind, AgentKind::Claude | AgentKind::Antigravity | AgentKind::Codex | AgentKind::Opencode) {
        v.push(tile(if kind == AgentKind::Opencode { "Undo" } else { "Rewind" }, Icon::RotateCcw, session(SessionOp::Rewind)));
    }
    if kind == AgentKind::Opencode {
        v.push(tile("Redo", Icon::RotateCw, session(SessionOp::Send("/redo".into(), "Could not redo"))));
        v.push(tile(if now.shared { "Unshare" } else { "Share" }, Icon::Link2, session(SessionOp::Share(!now.shared))));
    }
    if matches!(kind, AgentKind::Claude | AgentKind::Codex | AgentKind::Opencode) && now.session_id.is_some() {
        v.push(tile("Fork", Icon::GitFork, session(SessionOp::Fork)));
    }
    if let Some(id) = &now.session_id {
        v.push(tile("Copy ID", Icon::Copy, Action::Copy { text: id.clone(), what: Some("Session ID".into()) }));
    }
    if let Some(cmd) = &def.set.clear {
        v.push(Tile {
            ask: Some(("Start a fresh conversation?", "The current one is saved and can be resumed later.", "Clear")),
            ..tile("Clear", Icon::Trash2, session(SessionOp::Send(cmd.clone(), "Could not clear")))
        });
    }
    v.push(tile("To shell", Icon::LogOut, session(SessionOp::Exit)));
    v.push(Tile { danger: true, ..tile("End", Icon::CircleX, Action::EndSession { host: c.host.clone(), pane: c.pane.clone() }) });
    v
}

/// The session controls sheet (MobileSheets.tsx ControlsSheet): model, effort and mode as
/// buttons, the goal, Ultracode and Remote Control switches, the session's actions, and its
/// Usage. Phones open it from the header's ⋯; every size from the usage chip and Session
/// controls… in the menu. While the agent asks something, only the Usage part stays.
#[component]
fn ControlsSheet(c: Controls, of: SheetOf) -> Element {
    // it opens only while the session can take picks
    let open = SHEET_OPEN() && c.ready;
    let chats = use_context::<Signal<crate::state::Chats>>();
    let here = use_context::<Signal<Route>>();
    let hub = use_context::<Signal<crate::state::Hub>>();
    let close = move || *SHEET_OPEN.write() = false;
    let run = move |a: Action| menu::run(a, chats, here, hub);
    let def = c.agent.def();
    let kind = c.agent;
    let session = {
        let (host, pane) = (c.host.clone(), c.pane.clone());
        move |op: SessionOp| Action::Session(SessionAct { host: host.clone(), pane: pane.clone(), agent: Some(kind), op })
    };
    let (ultra, remote) = (session.clone(), session.clone());
    let goal = c.goal_on().map(|g| g.condition.clone());
    let goal_sub = match (&goal, &c.goal) {
        (Some(g), _) => g.clone(),
        (None, Some(g)) if g.met => "Last goal met".into(),
        _ => "Keep working until a condition is met".into(),
    };
    let clear_goal = def.set.clear_goal.clone();
    let efforts: Vec<(String, String)> =
        (kind == AgentKind::Opencode).then(|| "default".to_string()).into_iter().chain(c.efforts.iter().cloned()).map(|e| (e.clone(), effort_short(&e))).collect();
    let effort = c.effort.clone().unwrap_or_else(|| if kind == AgentKind::Opencode { "default".into() } else { String::new() });
    let rc_where = if kind == AgentKind::Antigravity { "Antigravity" } else { "claude.ai" };
    let tiles = tiles(&c, &of.now);
    let compact = def.set.compact.clone().map(|cmd| {
        let a = session(SessionOp::Send(cmd, "Could not compact"));
        EventHandler::new(move |_| run(a.clone()))
    });
    let models = c.models.clone();
    let modes = c.modes.clone();
    let cc = c.clone();
    let cm = c.clone();
    let ce = c.clone();
    rsx! {
        Sheet {
            open,
            on_close: move |_| close(),
            title: def.name.clone(),
            icon: rsx! { AgentMark { kind, size: 24, decorative: true } },
            div { class: "csheet",
                if of.asking {
                    div { class: "csheet-asking", role: "status",
                        "{def.name} is asking you something. Answer it in the chat, and the model, effort and mode controls come back."
                    }
                } else {
                    if !models.is_empty() || kind == AgentKind::Opencode {
                        div {
                            div { class: "csheet-label", "Model" }
                            div { class: "csheet-models",
                                for m in models {
                                    button {
                                        key: "{m.id}",
                                        class: if cm.model.as_deref() == Some(m.id.as_str()) { "csheet-model csheet-model-on press" } else { "csheet-model press" },
                                        r#type: "button",
                                        "aria-pressed": "{cm.model.as_deref() == Some(m.id.as_str())}",
                                        onclick: {
                                            let a = cm.act(ControlOp::Setting(cm.model_command(&m.id).unwrap_or_default(), "Could not switch model"));
                                            move |_| run(a.clone())
                                        },
                                        span { class: "csheet-model-name", "{m.label}" }
                                        if let Some(n) = &m.note {
                                            span { class: "csheet-model-note", "{n}" }
                                        }
                                    }
                                }
                            }
                            if kind == AgentKind::Opencode {
                                button { class: "csheet-link press", r#type: "button", onclick: move |_| { close(); *PROVIDERS_OPEN.write() = true },
                                    Glyph { icon: Icon::Plug, size: 14 }
                                    "Connect a provider…"
                                }
                            }
                        }
                    }
                    if !c.efforts.is_empty() {
                        div {
                            div { class: "csheet-label", "Reasoning effort" }
                            Segmented {
                                full: true,
                                label: "Reasoning effort",
                                value: effort,
                                options: efforts,
                                on_change: move |v: String| run(ce.act(ControlOp::Setting(ce.effort_command(&v).unwrap_or_default(), "Could not change effort"))),
                            }
                        }
                    }
                    if !modes.is_empty() {
                        div {
                            div { class: "csheet-label", if kind == AgentKind::Opencode { "Agent" } else { "Permission mode" } }
                            div { class: "csheet-modes",
                                for m in modes {
                                    button {
                                        key: "{m.id}",
                                        class: if mode_matches(cc.mode.as_deref(), &m.id, kind) { "csheet-mode csheet-mode-on press" } else { "csheet-mode press" },
                                        r#type: "button",
                                        "aria-pressed": "{mode_matches(cc.mode.as_deref(), &m.id, kind)}",
                                        onclick: {
                                            let a = cc.act(ControlOp::Mode(m.id.clone()));
                                            move |_| run(a.clone())
                                        },
                                        "{m.label}"
                                    }
                                }
                            }
                        }
                    }
                    if def.set.goal.is_some() || def.set.ultracode.is_some() || def.set.rc.is_some() {
                        div { class: "csheet-rows",
                            if def.set.goal.is_some() {
                                div { class: "csheet-row",
                                    Glyph { icon: Icon::Target, size: 16, class: "fg-3" }
                                    button { class: "csheet-row-words", r#type: "button", onclick: move |_| { close(); open_goal() },
                                        span { class: "csheet-row-title", "Goal" }
                                        span { class: "csheet-row-sub truncate", "{goal_sub}" }
                                    }
                                    Toggle {
                                        on: goal.is_some(),
                                        label: "Goal",
                                        on_change: {
                                            let a = clear_goal.map(|cmd| c.act(ControlOp::Setting(cmd, "Could not clear goal")));
                                            move |v: bool| if v { close(); open_goal() } else if let Some(a) = a.clone() { run(a) }
                                        },
                                    }
                                }
                            }
                            if def.set.ultracode.is_some() {
                                div { class: "csheet-row",
                                    Glyph { icon: Icon::Gauge, size: 16, class: if c.ultracode { "ultracode-mark" } else { "fg-3" } }
                                    div { class: "csheet-row-words",
                                        span { class: "csheet-row-title", "Ultracode" }
                                        span { class: "csheet-row-sub truncate", if c.ultracode { "On · a dynamic workflow for every task" } else { "Off" } }
                                    }
                                    Toggle { on: c.ultracode, label: "Ultracode", on_change: move |v: bool| run(ultra(SessionOp::Ultracode(v))) }
                                }
                            }
                            if def.set.rc.is_some() {
                                div { class: "csheet-row",
                                    Glyph { icon: Icon::RadioTower, size: 16, class: "fg-3" }
                                    div { class: "csheet-row-words",
                                        span { class: "csheet-row-title", "Remote Control" }
                                        span { class: "csheet-row-sub truncate",
                                            if of.now.remote.is_some() { "On · reachable from {rc_where}" } else { "Off" }
                                        }
                                    }
                                    if let Some(url) = of.now.remote.clone() {
                                        a { class: "csheet-open", href: "{url}", target: "_blank", rel: "noreferrer", "Open" }
                                    }
                                    Toggle { on: of.now.remote.is_some(), label: "Remote Control", on_change: move |v: bool| run(remote(SessionOp::RemoteControl(v))) }
                                }
                            }
                        }
                    }
                    div { class: "csheet-tiles",
                        for t in tiles {
                            button {
                                key: "{t.label}",
                                class: if t.danger { "csheet-tile csheet-tile-danger press" } else { "csheet-tile press" },
                                r#type: "button",
                                onclick: {
                                    let t = t.clone();
                                    move |_| {
                                        let t = t.clone();
                                        // Fork and End take you elsewhere, so the sheet goes first
                                        if matches!(t.action, Action::EndSession { .. } | Action::Session(SessionAct { op: SessionOp::Fork, .. })) {
                                            close();
                                        }
                                        match t.ask {
                                            Some((title, body, yes)) => {
                                                spawn(async move {
                                                    if confirm(Ask { title: title.into(), body: Some(body.into()), yes: yes.into(), ..Ask::default() }).await {
                                                        run(t.action);
                                                    }
                                                });
                                            }
                                            None => run(t.action),
                                        }
                                    }
                                },
                                Glyph { icon: t.icon, size: 16 }
                                "{t.label}"
                            }
                        }
                    }
                }
                super::usage::UsagePanel { status: of.status.clone(), info: of.info.clone(), agent: Some(kind), on_compact: compact }
            }
        }
    }
}

/// Setting, changing or turning off the goal the agent checks before it stops.
#[component]
fn GoalSheet(c: Controls) -> Element {
    let open = GOAL_OPEN();
    let mut text = use_signal(String::new);
    let mut busy = use_signal(|| false);
    let goal = c.goal.clone();
    let active = c.goal_on().is_some();
    // each opening starts from the goal as it is
    {
        let condition = goal.as_ref().map(|g| g.condition.clone()).unwrap_or_default();
        use_effect(use_reactive!(|open| {
            if open {
                text.set(condition.clone());
                busy.set(false);
            }
        }));
    }
    let def = c.agent.def();
    let clear = def.set.clear_goal.clone().filter(|_| active);
    let close = move || *GOAL_OPEN.write() = false;
    let send = {
        let (host, pane) = (c.host.clone(), c.pane.clone());
        move |command: String, fail: &'static str| {
            let (host, pane) = (host.clone(), pane.clone());
            busy.set(true);
            spawn(async move {
                if setting(&host, &pane, &command, fail).await {
                    close();
                }
                busy.set(false);
            });
        }
    };
    let mut turn_off = send.clone();
    let mut set = send;
    let goal_command = move |t: &str| def.goal_command(t).unwrap_or_default();
    rsx! {
        Sheet {
            open,
            on_close: move |_| close(),
            title: "Goal",
            icon: rsx! { Glyph { icon: Icon::Target, size: 16, class: "fg-3" } },
            footer: rsx! {
                div { class: "sheet-actions",
                    if let Some(cmd) = clear {
                        button { class: "button button-md button-danger press sheet-action-start", r#type: "button", disabled: busy() || !c.ready, onclick: move |_| turn_off(cmd.clone(), "Could not clear goal"), "Turn off" }
                    }
                    button { class: "button button-md button-ghost press", r#type: "button", disabled: busy(), onclick: move |_| close(), "Cancel" }
                    button {
                        class: "button button-md button-primary press",
                        r#type: "button",
                        disabled: busy() || !c.ready || text().trim().is_empty(),
                        onclick: move |_| set(goal_command(text().trim()), "Could not set goal"),
                        Busy { on: busy() }
                        if active { "Update goal" } else { "Set goal" }
                    }
                }
            },
            p { class: "sheet-text goal-lede", "The agent checks this condition before it stops, and keeps going until it's met." }
            if let Some(g) = goal {
                div { class: "goal-now",
                    div { class: "goal-now-title", if g.met { "Last goal was met" } else { "Active goal" } }
                    div { class: "goal-now-text", "{g.condition}" }
                    if g.met {
                        if let Some(r) = g.reason {
                            div { class: "goal-now-reason", "{r}" }
                        }
                    }
                }
            }
            Field { label: if active { "Change the goal" } else { "New goal" },
                textarea {
                    class: "field field-area",
                    rows: "3",
                    value: "{text}",
                    placeholder: "All tests pass and the PR is open",
                    "data-autofocus": "true",
                    oninput: move |e| text.set(e.value()),
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status(model: Option<&str>, id: Option<&str>, effort: Option<&str>) -> AgentStatus {
        let mut s: AgentStatus = serde_json::from_str(r#"{"updatedAt":1}"#).unwrap();
        s.model = model.map(str::to_string);
        s.model_id = id.map(str::to_string);
        s.effort = effort.map(str::to_string);
        s
    }

    fn model(id: &str, label: &str) -> AgentModel {
        serde_json::from_value(serde_json::json!({ "id": id, "label": label })).unwrap()
    }

    #[test]
    fn an_exact_model_id_wins_and_a_name_never_stands_in_for_a_longer_one() {
        let models = [model("openai/gpt-5", "OpenAI · GPT-5"), model("openai/gpt-5.1-codex", "OpenAI · GPT-5.1 Codex"), model("openrouter/openai/gpt-5", "OpenRouter · GPT-5")];
        let id = |s: AgentStatus| current_model_id(&models, Some(&s), None);
        assert_eq!(id(status(None, Some("openai/gpt-5"), None)).as_deref(), Some("openai/gpt-5"));
        assert_eq!(id(status(None, Some("openai/gpt-5.1-codex"), None)).as_deref(), Some("openai/gpt-5.1-codex"));
        assert_eq!(id(status(Some("GPT-5.1 Codex"), None, None)).as_deref(), Some("openai/gpt-5.1-codex"));
        assert_eq!(id(status(Some("OpenRouter · GPT-5"), None, None)).as_deref(), Some("openrouter/openai/gpt-5"));
        assert_eq!(current_model_id(&models, None, Some("openai/gpt-5.1-codex")).as_deref(), Some("openai/gpt-5.1-codex"));
        let claude = AgentKind::Claude.def();
        assert_eq!(current_model_id(&claude.models, Some(&status(Some("Opus 5.5"), None, None)), None).as_deref(), Some("opus"));
    }

    #[test]
    fn modes_read_as_the_agent_names_them() {
        let claude = &AgentKind::Claude.def().modes;
        assert_eq!(mode_label(None, AgentKind::Claude, claude), "Ask each time");
        assert_eq!(mode_label(Some("acceptEdits"), AgentKind::Claude, claude), "Accept edits");
        assert_eq!(mode_label(Some("plan"), AgentKind::Claude, claude), "Plan");
        assert_eq!(mode_label(Some("bypassPermissions"), AgentKind::Claude, claude), "Bypass permissions");
        assert!(mode_matches(Some("acceptEdits"), "acceptEdits", AgentKind::Claude));
        assert!(mode_matches(None, "default", AgentKind::Claude));
        assert!(!mode_matches(Some("plan"), "default", AgentKind::Claude));
        // OpenCode's own agents, custom ones too, and one it hasn't listed
        let modes = vec![ModeOption { id: "build".into(), label: "Build".into() }, ModeOption { id: "review".into(), label: "Reviewer".into() }];
        assert_eq!(mode_label(Some("review"), AgentKind::Opencode, &modes), "Reviewer");
        assert_eq!(mode_label(Some("docs"), AgentKind::Opencode, &modes), "Docs");
        assert!(mode_matches(Some("build"), "build", AgentKind::Opencode));
        assert_eq!(mode_label(None, AgentKind::Codex, &[]), "Default");
    }

    #[test]
    fn the_bars_light_up_to_the_level() {
        let levels: Vec<String> = ["low", "medium", "high", "xhigh"].map(String::from).to_vec();
        assert_eq!(bars(None, &levels), 0);
        assert_eq!(bars(Some("low"), &levels), 1);
        assert_eq!(bars(Some("xhigh"), &levels), 4);
        assert_eq!(bars(Some("medium"), &levels[..2]), 4);
        assert_eq!(bars(Some("other"), &levels), 0);
    }

    fn claude(r: Reported) -> Controls {
        Controls::of("box", "Box", "%1", AgentKind::Claude, r)
    }

    #[test]
    fn a_session_that_names_no_level_shows_the_models_default() {
        let s = status(Some("Opus 5.5"), None, None);
        let c = claude(Reported { status: Some(&s), ..Default::default() });
        let opus = c.models.iter().find(|m| m.id == "opus").unwrap();
        assert_eq!(c.effort, opus.default_effort);
        assert_eq!(c.model_label, short(&opus.label));
        let s = status(Some("Opus 5.5"), None, Some("default"));
        assert_eq!(claude(Reported { status: Some(&s), ..Default::default() }).effort, opus.default_effort);
        let s = status(Some("Opus 5.5"), None, Some("max"));
        assert_eq!(claude(Reported { status: Some(&s), ..Default::default() }).effort.as_deref(), Some("max"));
        // nothing reported at all: no level to show
        assert_eq!(claude(Reported::default()).effort, None);
        assert_eq!(claude(Reported::default()).model_label, "Default model");
    }

    #[test]
    fn the_menus_type_the_agents_own_commands() {
        let c = claude(Reported::default());
        let def = AgentKind::Claude.def();
        assert_eq!(c.model_command("opus"), def.model_command("opus", None));
        assert_eq!(c.effort_command("high"), def.effort_command("high"));
        let chip = c.model_chip().unwrap();
        assert!(chip.items[0].header);
        let first = &chip.items[1];
        assert_eq!(
            first.action,
            Action::Control(ControlAct { host: "box".into(), pane: "%1".into(), op: ControlOp::Setting(c.model_command(&c.models[0].id).unwrap(), "Could not switch model") })
        );
        // Claude Code's ultracode switch sits with the levels
        let effort = c.effort_chip().unwrap();
        let last = effort.items.last().unwrap();
        assert_eq!(last.label, "Ultracode: off");
        assert_eq!(last.action, Action::Session(SessionAct { host: "box".into(), pane: "%1".into(), agent: Some(AgentKind::Claude), op: SessionOp::Ultracode(true) }));
    }

    #[test]
    fn a_family_with_its_level_in_the_id_switches_by_model() {
        let mut m = model("fam", "Family");
        m.efforts = Some(vec!["low".into(), "high".into()]);
        m.variants = Some(serde_json::from_value(serde_json::json!({ "low": "fam-low", "high": "fam-high" })).unwrap());
        let catalog = AgentCatalog { models: vec![m], source: inyon_protocol::CatalogSource::Cli, updated_at: 0, error: None, modes: None };
        let s = status(None, Some("fam"), Some("high"));
        let c = Controls::of("box", "Box", "%1", AgentKind::Opencode, Reported { catalog: Some(&catalog), status: Some(&s), ..Default::default() });
        assert_eq!(c.efforts, vec!["low", "high"]);
        assert_eq!(c.effort_command("low").as_deref(), Some("/model fam-low"));
        assert_eq!(c.model_command("fam"), AgentKind::Opencode.def().model_command("fam-high", Some("high")));
    }

    #[test]
    fn a_pick_that_waits_says_so_and_can_be_dropped() {
        let s = status(Some("Opus 5.5"), None, Some("high"));
        let chosen = ChosenControls { model: None, effort: Some("low".into()), mode: Some("plan".into()), error: None };
        let c = claude(Reported { status: Some(&s), chosen: Some(&chosen), ..Default::default() });
        let effort = c.effort_chip().unwrap();
        assert_eq!(effort.text, "Low");
        assert_eq!(effort.mark, Some(false));
        assert_eq!(effort.title, "Switches to Low when Claude Code is free");
        let drop = effort.items.iter().find(|i| i.label == "Don't switch").unwrap();
        // the mode waits too, and the hub drops both
        assert_eq!(drop.hint.as_deref(), Some("Cancels every waiting switch"));
        assert_eq!(drop.action, Action::Control(ControlAct { host: "box".into(), pane: "%1".into(), op: ControlOp::DropChosen }));
        assert!(effort.items.iter().any(|i| i.label == "Low" && i.checked == Some(true)));
        let mode = c.mode_chip().unwrap();
        assert_eq!(mode.text, "Plan");
        assert!(mode.items.iter().any(|i| i.label == "Plan" && i.checked == Some(true)));
        // the model wasn't picked: its chip says nothing about waiting
        assert_eq!(c.model_chip().unwrap().mark, None);
    }

    #[test]
    fn a_pick_that_didnt_take_shows_why_and_keeps_the_current_value() {
        let s = status(Some("Opus 5.5"), None, Some("high"));
        let chosen = ChosenControls { model: None, effort: Some("low".into()), mode: None, error: Some("The agent didn't take it".into()) };
        let c = claude(Reported { status: Some(&s), chosen: Some(&chosen), ..Default::default() });
        let effort = c.effort_chip().unwrap();
        assert_eq!(effort.text, "High");
        assert_eq!(effort.mark, Some(true));
        assert_eq!(effort.title, "Couldn't switch to Low: The agent didn't take it");
        assert!(effort.items.iter().any(|i| i.label == "Couldn't switch to Low" && i.hint.as_deref() == Some("The agent didn't take it")));
        assert!(effort.items.iter().any(|i| i.label == "High" && i.checked == Some(true)));
    }

    #[test]
    fn a_goal_met_is_not_on() {
        let goal = ChatGoal { condition: "Tests pass".into(), met: true, reason: None, ts: String::new() };
        let c = claude(Reported { goal: Some(&goal), ..Default::default() });
        assert!(c.goal_on().is_none());
        let goal = ChatGoal { met: false, ..goal };
        assert_eq!(claude(Reported { goal: Some(&goal), ..Default::default() }).goal_on().map(|g| g.condition.as_str()), Some("Tests pass"));
    }

    fn family(id: &str, label: &str, variants: &[(&str, &str)]) -> AgentModel {
        let v: serde_json::Map<String, serde_json::Value> = variants.iter().map(|(k, x)| (k.to_string(), serde_json::json!(x))).collect();
        let efforts: Vec<&str> = variants.iter().map(|(k, _)| *k).collect();
        serde_json::from_value(serde_json::json!({ "id": id, "label": label, "efforts": efforts, "variants": v })).unwrap()
    }

    #[test]
    fn a_level_picked_while_a_model_waits_keeps_that_model() {
        let catalog = AgentCatalog {
            models: vec![family("pro", "Pro", &[("low", "pro-low"), ("high", "pro-high")]), family("flash", "Flash", &[("minimal", "flash-min"), ("medium", "flash-med")])],
            source: inyon_protocol::CatalogSource::Cli,
            updated_at: 0,
            error: None,
            modes: None,
        };
        let s = status(None, Some("pro-high"), Some("high"));
        let chosen = ChosenControls { model: Some("flash-med".into()), effort: None, mode: None, error: None };
        let c = Controls::of("box", "Box", "%1", AgentKind::Antigravity, Reported { catalog: Some(&catalog), status: Some(&s), chosen: Some(&chosen), ..Default::default() });
        // the waiting variant's own id is matched to its family
        assert_eq!(c.chosen_model("flash-med").map(|m| m.id.as_str()), Some("flash"));
        // the levels are Flash's, and a level goes in as a Flash variant
        assert_eq!(c.efforts, ["minimal", "medium"]);
        assert_eq!(c.effort_command("minimal").as_deref(), Some("/model flash-min"));
    }

    #[test]
    fn copilots_screen_names_the_model_after_a_switch() {
        let catalog = AgentCatalog {
            models: vec![model("gpt-5", "GPT-5"), model("claude-sonnet-5.5", "Claude Sonnet 5.5")],
            source: inyon_protocol::CatalogSource::Cli,
            updated_at: 0,
            error: None,
            modes: None,
        };
        // the numbers still say GPT-5; the footer already shows the new model
        let s = status(Some("GPT-5"), Some("gpt-5"), None);
        let c =
            Controls::of("box", "Box", "%1", AgentKind::Copilot, Reported { catalog: Some(&catalog), status: Some(&s), model: Some("Claude Sonnet 5.5"), ..Default::default() });
        assert_eq!(c.model.as_deref(), Some("claude-sonnet-5.5"));
    }

    #[test]
    fn dont_switch_says_it_cancels_every_waiting_switch() {
        let s = status(Some("Opus 5.5"), None, Some("high"));
        let one = ChosenControls { model: None, effort: Some("low".into()), mode: None, error: None };
        let hint = |c: &Controls| c.effort_chip().unwrap().items.into_iter().find(|i| i.label == "Don't switch").and_then(|i| i.hint);
        assert_eq!(hint(&claude(Reported { status: Some(&s), chosen: Some(&one), ..Default::default() })).as_deref(), Some("Keeps High"));
        let two = ChosenControls { mode: Some("plan".into()), ..one };
        assert_eq!(hint(&claude(Reported { status: Some(&s), chosen: Some(&two), ..Default::default() })).as_deref(), Some("Cancels every waiting switch"));
    }

    #[test]
    fn the_sheet_lists_the_web_apps_actions_for_each_agent() {
        let labels = |c: &Controls, now: &Now| tiles(c, now).into_iter().map(|t| t.label).collect::<Vec<_>>();
        let with_id = Now { session_id: Some("abc".into()), ..Now::default() };
        assert_eq!(labels(&claude(Reported::default()), &with_id), ["Compact", "Rewind", "Fork", "Copy ID", "Clear", "To shell", "End"]);
        // no conversation yet: nothing to fork or copy
        assert_eq!(labels(&claude(Reported::default()), &Now::default()), ["Compact", "Rewind", "Clear", "To shell", "End"]);
        let opencode = Controls::of("box", "Box", "%1", AgentKind::Opencode, Reported::default());
        let l = labels(&opencode, &Now { shared: true, ..Now::default() });
        assert!(l.contains(&"Undo") && l.contains(&"Redo") && l.contains(&"Unshare"));
        // Clear asks first, End is the one in red
        let t = tiles(&claude(Reported::default()), &with_id);
        assert_eq!(t.iter().find(|t| t.label == "Clear").and_then(|t| t.ask).map(|a| a.0), Some("Start a fresh conversation?"));
        assert_eq!(t.iter().filter(|t| t.danger).map(|t| t.label).collect::<Vec<_>>(), ["End"]);
    }

    #[test]
    fn levels_fit_six_across() {
        assert_eq!(["default", "minimal", "medium", "xhigh", "ultra", "odd"].map(effort_short), ["Default", "Min", "Med", "X-high", "Ultra", "odd"]);
    }
}
