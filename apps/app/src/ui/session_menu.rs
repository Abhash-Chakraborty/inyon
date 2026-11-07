//! The session header's ⋯ menu (components/session/SessionHeader.tsx and useSession.ts's actions):
//! Remote Control, compacting, rewinding, past conversations, forking, renaming, clearing, exiting
//! to the shell and ending; and the small menus of the header's Ultracode and Remote Control
//! buttons. While the agent asks something, only what can't reach its question stays.

use dioxus::prelude::*;
use inyon_protocol::AgentKind;

use super::icons::Icon;
use super::menu::{Action, Item};
use super::organize::{OrgOp, OrgSheet};
use super::toast::{self, confirm, Ask, ToastTone};
use crate::route::Route;
use crate::{api, dom};

/// One thing the menu does to its session.
#[derive(Debug, Clone, PartialEq)]
pub enum SessionOp {
    RemoteControl(bool),
    /// the Remote Control session on claude.ai (or in Antigravity)
    OpenRemote(String),
    Ultracode(bool),
    /// a slash command typed into the agent (compact, OpenCode's redo); what to say if it fails
    Send(String, &'static str),
    /// asks, then types the agent's clear command: a fresh conversation, the old one kept
    Clear(String),
    /// the Past conversations sheet
    Conversations,
    /// switches to one of them (its id, and its title for the toast)
    Switch(String, String),
    Rewind,
    /// OpenCode's public link, or taking it down
    Share(bool),
    Fork,
    Exit,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SessionAct {
    pub host: String,
    pub pane: String,
    pub agent: Option<AgentKind>,
    pub op: SessionOp,
}

/// What the session has on now, for the items that turn things off.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Now {
    pub session_id: Option<String>,
    /// Remote Control's address while it's on
    pub remote: Option<String>,
    pub ultracode: bool,
    pub shared: bool,
    /// a question or approval is on screen, so typing would answer it
    pub asking: bool,
    /// the pane's tmux session: its id (`$52`) and name
    pub tmux: Option<(String, String)>,
}

/// What stays in the menu while the agent asks something: nothing that types into its terminal.
fn kept_while_asking(label: &str) -> bool {
    matches!(label, "Past conversations…" | "Rename…" | "Copy session ID" | "End session…")
}

/// The menu for a session running `agent` (none: a plain shell).
pub fn items(host: &str, pane: &str, agent: Option<AgentKind>, now: &Now) -> Vec<Item> {
    let act = |op: SessionOp| Action::Session(SessionAct { host: host.into(), pane: pane.into(), agent, op });
    let mut v = Vec::new();
    if let Some(kind) = agent {
        let def = kind.def();
        // while it's on, the header's Remote Control button has the menu (and Ultracode's, its own)
        if def.set.rc.is_some() && now.remote.is_none() {
            v.push(Item::new("Turn on Remote Control", Icon::RadioTower, act(SessionOp::RemoteControl(true))));
        }
        if let Some(c) = &def.set.compact {
            v.push(Item::new("Compact context", Icon::Shrink, act(SessionOp::Send(c.clone(), "Could not compact"))));
        }
        if matches!(kind, AgentKind::Claude | AgentKind::Antigravity | AgentKind::Codex | AgentKind::Opencode) {
            v.push(Item::new(if kind == AgentKind::Opencode { "Undo last message…" } else { "Rewind…" }, Icon::RotateCcw, act(SessionOp::Rewind)));
        }
        if kind == AgentKind::Opencode {
            v.push(Item::new("Redo last undo", Icon::RotateCw, act(SessionOp::Send("/redo".into(), "Could not redo"))));
            v.push(Item::new(if now.shared { "Stop sharing" } else { "Share link…" }, Icon::Link2, act(SessionOp::Share(!now.shared))));
        }
        if switchable(kind) {
            v.push(Item::new("Past conversations…", Icon::History, act(SessionOp::Conversations)));
        }
        if matches!(kind, AgentKind::Claude | AgentKind::Codex | AgentKind::Opencode) && now.session_id.is_some() {
            v.push(Item::new("Fork conversation", Icon::GitFork, act(SessionOp::Fork)));
        }
    }
    v.push(Item::new("Rename…", Icon::Pencil, Action::Org(OrgOp::Sheet(OrgSheet::Rename((host.into(), pane.into()))))));
    if let Some((id, name)) = &now.tmux {
        v.push(Item::new("Rename tmux session…", Icon::Pencil, Action::Org(OrgOp::Sheet(OrgSheet::TmuxSession { host: host.into(), id: id.clone(), name: name.clone() }))));
    }
    if let Some(id) = &now.session_id {
        v.push(Item::copy("Copy session ID", id));
    }
    if let Some(kind) = agent {
        let def = kind.def();
        if let Some(c) = &def.set.clear {
            v.push(Item::new("Clear conversation", Icon::Trash2, act(SessionOp::Clear(c.clone()))).danger());
        }
        v.push(Item::new("Exit to shell", Icon::LogOut, act(SessionOp::Exit)));
    }
    v.push(Item::new("End session…", Icon::CircleX, Action::EndSession { host: host.into(), pane: pane.into() }).danger().separated());
    if now.asking {
        v.retain(|i| kept_while_asking(&i.label));
    }
    v
}

/// Whether Inyon lists this agent's past conversations itself (and "/resume" opens them).
pub fn switchable(kind: AgentKind) -> bool {
    kind.def().conversations.as_ref().is_some_and(|c| !c.is_empty())
}

/// The header's Ultracode button, while it's on.
pub fn ultracode_menu(host: &str, pane: &str, kind: AgentKind) -> Vec<Item> {
    let act = SessionAct { host: host.into(), pane: pane.into(), agent: Some(kind), op: SessionOp::Ultracode(false) };
    vec![Item::header("Ultracode is on"), Item::new("Turn off", Icon::Power, Action::Session(act)).danger()]
}

/// The header's Remote Control button, while it's on: open it where it runs, or turn it off.
pub fn remote_menu(host: &str, pane: &str, kind: AgentKind, url: &str) -> Vec<Item> {
    let act = |op: SessionOp| Action::Session(SessionAct { host: host.into(), pane: pane.into(), agent: Some(kind), op });
    let open = if kind == AgentKind::Antigravity { "Open in Antigravity" } else { "Open on claude.ai" };
    vec![
        Item::header("Remote Control is on"),
        Item::new(open, Icon::ExternalLink, act(SessionOp::OpenRemote(url.into()))),
        Item::new("Turn off", Icon::Power, act(SessionOp::RemoteControl(false))).danger(),
    ]
}

fn failed(title: &str, e: api::ApiError) {
    toast::toast(title, Some(e.message), ToastTone::Error);
}

async fn send(host: &str, pane: &str, text: &str, fail: &str) -> bool {
    match api::send(host, pane, text, &dom::random_id()).await {
        Ok(()) => true,
        Err(e) => {
            failed(fail, e);
            false
        }
    }
}

pub fn run(act: SessionAct, mut here: Signal<Route>) {
    spawn(async move {
        let SessionAct { host, pane, agent, op } = act;
        let name = agent.map_or_else(|| "the agent".to_string(), |k| k.def().name.clone());
        match op {
            SessionOp::RemoteControl(on) => match api::remote_control(&host, &pane, on).await {
                Ok(()) => toast::toast(if on { "Remote Control on" } else { "Remote Control off" }, None, ToastTone::Success),
                Err(e) => failed(if on { "Could not turn on Remote Control" } else { "Could not turn off Remote Control" }, e),
            },
            SessionOp::OpenRemote(url) => dom::open_tab(&url),
            SessionOp::Ultracode(on) => match api::ultracode(&host, &pane, on).await {
                Ok(()) => {
                    toast::toast(if on { "Ultracode on" } else { "Ultracode off" }, on.then(|| "A dynamic workflow for every task, in this session.".into()), ToastTone::Success)
                }
                Err(e) => failed(if on { "Could not turn on Ultracode" } else { "Could not turn off Ultracode" }, e),
            },
            SessionOp::Send(text, fail) => {
                send(&host, &pane, &text, fail).await;
            }
            SessionOp::Clear(text) => {
                let ask = Ask {
                    title: "Start a fresh conversation?".into(),
                    body: Some("The current one is saved and can be resumed later.".into()),
                    yes: "Clear".into(),
                    ..Ask::default()
                };
                if confirm(ask).await {
                    send(&host, &pane, &text, "Could not clear").await;
                }
            }
            SessionOp::Conversations => {
                if let Some(kind) = agent {
                    super::conversations::open(&host, &pane, kind);
                }
            }
            SessionOp::Switch(id, title) => {
                if let Some(kind) = agent {
                    super::conversations::switch(host, pane, kind, id, title).await;
                }
            }
            SessionOp::Rewind => match agent {
                Some(AgentKind::Claude | AgentKind::Antigravity) => {
                    send(&host, &pane, "/rewind", "Could not send").await;
                }
                Some(AgentKind::Opencode) => {
                    let ask = Ask {
                        title: "Undo your last message?".into(),
                        body: Some("OpenCode takes it back with its file changes. Redo puts it back.".into()),
                        yes: "Undo".into(),
                        danger: true,
                        ..Ask::default()
                    };
                    if confirm(ask).await {
                        send(&host, &pane, "/undo", "Could not undo").await;
                    }
                }
                Some(AgentKind::Codex) => {
                    let ask = Ask {
                        title: "Rewind your last message?".into(),
                        body: Some("Codex forgets it and its reply. To go further back, use the rewind button under any message.".into()),
                        yes: "Rewind".into(),
                        danger: true,
                        ..Ask::default()
                    };
                    if confirm(ask).await {
                        match api::rewind(&host, &pane).await {
                            Ok(()) => toast::toast("Conversation rewound", None, ToastTone::Success),
                            Err(e) => failed("Could not rewind", e),
                        }
                    }
                }
                _ => {}
            },
            SessionOp::Share(on) => {
                let ask = Ask {
                    title: "Share this conversation?".into(),
                    body: Some("OpenCode puts it at a public link that anyone who has it can open. Stop sharing takes it down.".into()),
                    yes: "Share".into(),
                    ..Ask::default()
                };
                if on && !confirm(ask).await {
                    return;
                }
                if send(&host, &pane, if on { "/share" } else { "/unshare" }, if on { "Could not share" } else { "Could not stop sharing" }).await {
                    toast::toast(if on { "Shared" } else { "No longer shared" }, on.then(|| "The link shows under Usage in a moment.".into()), ToastTone::Success);
                }
            }
            SessionOp::Fork => match api::fork(&host, &pane).await {
                Ok(new) => {
                    toast::toast("Forked into a new window", Some("Both conversations carry on separately from here.".into()), ToastTone::Success);
                    crate::route::go(&mut here, Route::Session { host, pane: new, view: None });
                }
                Err(e) => failed("Could not fork", e),
            },
            SessionOp::Exit => {
                let ask = Ask {
                    title: format!("Exit {name} to the shell?"),
                    body: Some("The conversation is saved, and the pane stays open at its shell. To close the pane too, use End session.".into()),
                    yes: "Exit".into(),
                    ..Ask::default()
                };
                if !confirm(ask).await {
                    return;
                }
                match api::exit(&host, &pane).await {
                    Ok(()) => toast::toast(format!("{name} exited"), None, ToastTone::Success),
                    Err(e) => failed(&format!("Could not exit {name}"), e),
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn labels(agent: Option<AgentKind>, now: &Now) -> Vec<String> {
        items("box", "%1", agent, now).into_iter().map(|i| i.label).collect()
    }

    fn tmux() -> Option<(String, String)> {
        Some(("$7".into(), "storefront".into()))
    }

    #[test]
    fn claude_code_gets_the_web_apps_menu() {
        let now = Now { session_id: Some("abc".into()), tmux: tmux(), ..Now::default() };
        assert_eq!(
            labels(Some(AgentKind::Claude), &now),
            [
                "Turn on Remote Control",
                "Compact context",
                "Rewind…",
                "Past conversations…",
                "Fork conversation",
                "Rename…",
                "Rename tmux session…",
                "Copy session ID",
                "Clear conversation",
                "Exit to shell",
                "End session…"
            ]
        );
        // Remote Control on: the header's button has it, as Ultracode's has its own
        let on = Now { remote: Some("https://claude.ai/code/x".into()), ultracode: true, ..now };
        let l = labels(Some(AgentKind::Claude), &on);
        assert_eq!(l[0], "Compact context");
        assert!(!l.iter().any(|x| x.contains("Ultracode") || x.contains("Remote Control")), "{l:?}");
    }

    #[test]
    fn the_menu_keeps_only_what_cant_reach_a_question() {
        let now = Now { session_id: Some("abc".into()), tmux: tmux(), asking: true, ..Now::default() };
        assert_eq!(labels(Some(AgentKind::Claude), &now), ["Past conversations…", "Rename…", "Copy session ID", "End session…"]);
    }

    #[test]
    fn the_header_buttons_turn_their_switch_off() {
        let u = ultracode_menu("box", "%1", AgentKind::Claude);
        assert!(u[0].header && u[0].label == "Ultracode is on");
        assert_eq!(u[1].action, Action::Session(SessionAct { host: "box".into(), pane: "%1".into(), agent: Some(AgentKind::Claude), op: SessionOp::Ultracode(false) }));
        let r: Vec<String> = remote_menu("box", "%1", AgentKind::Claude, "https://claude.ai/code/x").into_iter().map(|i| i.label).collect();
        assert_eq!(r, ["Remote Control is on", "Open on claude.ai", "Turn off"]);
        assert_eq!(remote_menu("box", "%1", AgentKind::Antigravity, "u")[1].label, "Open in Antigravity");
    }

    #[test]
    fn rename_opens_the_sheet_for_the_pane_and_for_its_tmux_session() {
        let v = items("box", "%1", None, &Now { tmux: tmux(), ..Now::default() });
        assert_eq!(v[0].action, Action::Org(OrgOp::Sheet(OrgSheet::Rename(("box".into(), "%1".into())))));
        assert_eq!(v[1].action, Action::Org(OrgOp::Sheet(OrgSheet::TmuxSession { host: "box".into(), id: "$7".into(), name: "storefront".into() })));
    }

    #[test]
    fn clearing_asks_first() {
        let v = items("box", "%1", Some(AgentKind::Claude), &Now::default());
        let clear = v.iter().find(|i| i.label == "Clear conversation").unwrap();
        assert!(matches!(&clear.action, Action::Session(SessionAct { op: SessionOp::Clear(c), .. }) if c == "/clear"));
    }

    #[test]
    fn opencode_undoes_redoes_and_shares() {
        let l = labels(Some(AgentKind::Opencode), &Now { shared: true, ..Now::default() });
        assert!(l.iter().any(|x| x == "Undo last message…") && l.iter().any(|x| x == "Redo last undo") && l.iter().any(|x| x == "Stop sharing"));
        // no conversation to fork without a session id
        assert!(!l.iter().any(|x| x == "Fork conversation"));
    }

    #[test]
    fn a_shell_can_be_renamed_or_ended() {
        assert_eq!(labels(None, &Now::default()), ["Rename…", "End session…"]);
        let end = items("box", "%1", None, &Now::default()).pop().unwrap();
        assert!(end.danger);
    }
}
