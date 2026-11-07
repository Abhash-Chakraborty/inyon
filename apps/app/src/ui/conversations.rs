//! Past conversations (session/ConversationsSheet.tsx): the agent's earlier conversations in the
//! session's folder, and switching to one. It's what /resume does in the agent's terminal, as a list
//! the app can show: the agent saves the open conversation as it exits, then starts again on the one
//! picked, and the chat follows by itself. The header's ⋯, a bare "/resume" typed in the message box
//! and "No agent is running" open it.

use std::cell::Cell;

use dioxus::prelude::*;
use inyon_protocol::{AgentKind, PastConversation};

use super::icons::{Glyph, Icon};
use super::kit::{Sheet, Waiting};
use super::menu::{self, Action, Item};
use super::session_menu::{SessionAct, SessionOp};
use super::toast::{self, confirm, Ask, ToastTone};
use crate::{api, format, platform};

/// The session whose conversations are asked for.
#[derive(Debug, Clone, PartialEq)]
struct Want {
    host: String,
    pane: String,
    agent: AgentKind,
}

#[derive(Debug, Clone, PartialEq)]
enum Loaded {
    Loading,
    Failed(String),
    /// whose they are, as the hub answered: the pane may have changed agent meanwhile
    Ready {
        agent: AgentKind,
        cwd: String,
        list: Vec<PastConversation>,
    },
}

static WANT: GlobalSignal<Option<Want>> = Signal::global(|| None);
static OPEN: GlobalSignal<bool> = Signal::global(|| false);
/// the conversation being switched to, while the agent restarts on it
static SWITCHING: GlobalSignal<Option<String>> = Signal::global(|| None);

thread_local! {
    /// whether the session's agent is working, as the sheet last drew it: switching then asks first
    static WORKING: Cell<bool> = const { Cell::new(false) };
}

/// Opens the sheet for the agent `agent` in this pane.
pub fn open(host: &str, pane: &str, agent: AgentKind) {
    *WANT.write() = Some(Want { host: host.into(), pane: pane.into(), agent });
    *OPEN.write() = true;
}

fn close() {
    *OPEN.write() = false;
}

/// Whether a message typed bare is one of the commands that open the agent's own conversation
/// picker ("/resume"): the app's sheet does the job instead.
pub fn asks_for(text: &str, agent: Option<AgentKind>) -> bool {
    let c = text.trim().to_lowercase();
    agent.and_then(|k| k.def().conversations.as_ref()).is_some_and(|list| list.contains(&c))
}

/// The second line under a conversation: when it was last used, and whether it's the open one.
pub fn meta(c: &PastConversation, switching: bool, ago: &str) -> String {
    if switching {
        "Switching…".into()
    } else if c.current == Some(true) {
        format!("Open now · {ago}")
    } else {
        ago.into()
    }
}

/// Switches the pane's agent to conversation `id`, asking first while it works.
pub async fn switch(host: String, pane: String, agent: AgentKind, id: String, title: String) {
    if SWITCHING.peek().is_some() {
        return;
    }
    let ask = Ask { title: "Switch conversation?".into(), body: Some("The current one is saved and can be resumed later.".into()), yes: "Switch".into(), ..Ask::default() };
    if WORKING.with(Cell::get) && !confirm(ask).await {
        return;
    }
    *SWITCHING.write() = Some(id.clone());
    match api::switch_conversation(&host, &pane, agent, &id).await {
        Ok(()) => {
            close();
            toast::toast("Conversation switched", Some(title), ToastTone::Success);
        }
        Err(e) => toast::toast("Could not switch", Some(e.message), ToastTone::Error),
    }
    *SWITCHING.write() = None;
}

/// The sheet, mounted with the session's screen (`host`, `pane`), which it closes with. `working`:
/// its agent is busy now.
#[component]
pub fn ConversationsSheet(host: String, pane: String, working: bool) -> Element {
    WORKING.with(|w| w.set(working));
    // another session's list (opened there, then left) isn't this one's to show or act on
    use_drop(close);
    let mut loaded = use_signal(|| Loaded::Loading);
    // counts loads, so an answer for an earlier one is dropped
    let mut asked = use_signal(|| 0u32);
    let want = WANT().filter(|w| w.host == host && w.pane == pane);
    let open = OPEN() && want.is_some();
    let mut load = move |w: Want| {
        let n = *asked.peek() + 1;
        asked.set(n);
        loaded.set(Loaded::Loading);
        spawn(async move {
            let got = api::conversations(&w.host, &w.pane, Some(w.agent)).await;
            if *asked.peek() != n {
                return;
            }
            loaded.set(match got {
                Ok(r) => Loaded::Ready { agent: r.agent, cwd: r.cwd, list: r.conversations },
                Err(e) => Loaded::Failed(e.message),
            });
        });
    };
    {
        let want = want.clone();
        use_effect(use_reactive!(|open, want| {
            if let Some(w) = want.filter(|_| open) {
                load(w);
            }
        }));
    }
    let Some(w) = want else { return rsx! {} };
    let agent = match &*loaded.read() {
        Loaded::Ready { agent, .. } => *agent,
        _ => w.agent,
    };
    let name = agent.def().name.clone();
    let switching = SWITCHING();
    let clock = platform::clock();
    let on_key = {
        let rows = match &*loaded.read() {
            Loaded::Ready { list, .. } => list.len(),
            _ => 0,
        };
        move |e: KeyboardEvent| {
            let down = match e.key() {
                Key::ArrowDown => true,
                Key::ArrowUp => false,
                _ => return,
            };
            if rows == 0 {
                return;
            }
            e.prevent_default();
            // ↑ and ↓ move between conversations, as in the agent's own picker
            let at = crate::dom::active_id().and_then(|id| id.strip_prefix("conv-row-").and_then(|i| i.parse::<usize>().ok()));
            let next = match at {
                None => 0,
                Some(i) if down => (i + 1).min(rows - 1),
                Some(i) => i.saturating_sub(1),
            };
            crate::dom::focus(&format!("conv-row-{next}"));
        }
    };
    let body = match loaded() {
        Loaded::Loading => rsx! {
            Waiting { label: format!("Reading {name}'s conversations…"), lines: Some(4) }
        },
        Loaded::Failed(why) => rsx! {
            div { class: "empty",
                p { class: "empty-title", "Couldn't load conversations" }
                p { class: "empty-text", "{why}" }
                button { class: "button button-md button-quiet press empty-action", r#type: "button", onclick: { let w = w.clone(); move |_| load(w.clone()) }, "Try again" }
            }
        },
        Loaded::Ready { cwd, list, .. } if list.is_empty() => rsx! {
            div { class: "empty",
                span { class: "empty-icon", Glyph { icon: Icon::History, size: 20 } }
                p { class: "empty-title", "No past conversations" }
                p { class: "empty-text", "Conversations with {name} in {format::short_path(&cwd, 32)} show up here." }
            }
        },
        Loaded::Ready { cwd, list, .. } => rsx! {
            p { class: "conv-head truncate",
                if switching.is_some() {
                    span { class: "conv-status", role: "status",
                        span { class: "pulse-dot" }
                        "Saving this conversation and opening the other…"
                    }
                } else {
                    span { class: "mono", "{name} · {format::short_path(&cwd, 40)}" }
                }
            }
            div { class: "conv-list stagger", "aria-label": "Conversations", onkeydown: on_key,
                for (i, c) in list.into_iter().enumerate() {
                    ConvRow { key: "{c.id}", i, c: c.clone(), host: w.host.clone(), pane: w.pane.clone(), agent, ago: format::time_ago(c.at as f64, clock), switching: switching.clone() }
                }
            }
        },
    };
    rsx! {
        Sheet {
            open,
            on_close: move |_| close(),
            title: "Past conversations",
            icon: rsx! { Glyph { icon: Icon::History, size: 16, class: "fg-3" } },
            {body}
        }
    }
}

/// One conversation: a click switches to it (the open one stays put), and its menu offers the same
/// and its id to copy.
#[component]
fn ConvRow(i: usize, c: PastConversation, host: String, pane: String, agent: AgentKind, ago: String, switching: Option<String>) -> Element {
    let current = c.current == Some(true);
    let mine = switching.as_deref() == Some(c.id.as_str());
    let mut items = Vec::new();
    if !current && switching.is_none() {
        items.push(Item::new(
            "Switch to it",
            Icon::ArrowRight,
            Action::Session(SessionAct { host: host.clone(), pane: pane.clone(), agent: Some(agent), op: SessionOp::Switch(c.id.clone(), c.title.clone()) }),
        ));
    }
    items.push(Item::copy("Copy conversation ID", &c.id));
    let press = menu::long_press(items.clone());
    let (p1, p2, p3, p4) = (press.clone(), press.clone(), press.clone(), press);
    let line = meta(&c, mine, &ago);
    let pick = {
        let c = c.clone();
        move |e: MouseEvent| {
            if p4.click(&e) || current {
                return;
            }
            let (host, pane, id, title) = (host.clone(), pane.clone(), c.id.clone(), c.title.clone());
            // at the root, so closing the sheet mid-switch can't leave it marked as switching
            dioxus::core::spawn_forever(switch(host, pane, agent, id, title));
        }
    };
    rsx! {
        button {
            id: "conv-row-{i}",
            class: if current { "conv-row conv-row-current press" } else { "conv-row press" },
            r#type: "button",
            style: "--i:{i.min(8)}",
            "aria-current": current.then_some("true"),
            disabled: switching.is_some() && !mine,
            oncontextmenu: menu::open(items),
            onpointerdown: move |e| p1.down(&e),
            onpointermove: move |e| p2.moved(&e),
            onpointerup: move |_| p3.up(),
            onclick: pick,
            span { class: "conv-text",
                span { class: "conv-title truncate", "{c.title}" }
                span { class: "conv-meta mono", "{line}" }
            }
            if mine {
                Glyph { icon: Icon::Spinner, size: 16, class: "spin fg-3" }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resume_typed_bare_opens_the_list() {
        assert!(asks_for("/resume", Some(AgentKind::Claude)));
        assert!(asks_for(" /Resume ", Some(AgentKind::Claude)));
        // with words after it, it goes to the agent as typed
        assert!(!asks_for("/resume abc", Some(AgentKind::Claude)));
        assert!(!asks_for("/resume", None));
        // each agent's own words for it
        let k =
            inyon_protocol::AGENT_KINDS.into_iter().find(|k| k.def().conversations.as_ref().is_some_and(|c| c.iter().any(|x| x == "/sessions"))).expect("an agent with /sessions");
        assert!(asks_for("/sessions", Some(k)));
        assert!(!asks_for("/sessions", Some(AgentKind::Claude)));
    }

    #[test]
    fn a_row_says_which_is_open_and_which_is_switching() {
        let c = PastConversation { id: "a".into(), title: "Fix the test".into(), at: 0, current: Some(true) };
        assert_eq!(meta(&c, false, "3h ago"), "Open now · 3h ago");
        assert_eq!(meta(&PastConversation { current: None, ..c.clone() }, false, "3h ago"), "3h ago");
        assert_eq!(meta(&c, true, "3h ago"), "Switching…");
    }
}
