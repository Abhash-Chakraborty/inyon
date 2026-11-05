//! The question each session was last seen asking, with its answers, kept through a dropped
//! connection (lib/lastAsk.ts). Opening the app from an alert shows the conversation before the
//! machine is back, and until then the question would be gone; kept from the overview, forgotten
//! once the machine is back and the session isn't asking any more.

use std::cell::RefCell;
use std::collections::HashMap;

use inyon_protocol::{AgentState, HostState, HostStatus, PromptOption, ScreenPrompt};

/// The questions, by host and pane.
#[derive(Debug, Default)]
pub struct Asks(HashMap<(String, String), ScreenPrompt>);

impl Asks {
    /// Notes what every session in the overview is asking now. A machine that's online lists all its
    /// panes, so a question kept for a pane it no longer lists goes: tmux may give a new pane the
    /// same id, and the old question mustn't show in its chat.
    pub fn note(&mut self, hosts: &[HostState]) {
        for h in hosts {
            if h.status == HostStatus::Online {
                let listed: std::collections::HashSet<&str> = h.sessions.iter().flat_map(|s| &s.windows).flat_map(|w| &w.panes).map(|p| p.id.as_str()).collect();
                self.0.retain(|(host, pane), _| *host != h.config.id || listed.contains(pane.as_str()));
            }
            for p in h.sessions.iter().flat_map(|s| &s.windows).flat_map(|w| &w.panes) {
                let k = (h.config.id.clone(), p.id.clone());
                let asking = p.agent.as_ref().filter(|a| a.state == AgentState::Waiting).and_then(|a| Some((a, a.options.as_deref().filter(|o| !o.is_empty())?)));
                if let Some((a, options)) = asking {
                    let body = vec![a.waiting_for.clone().filter(|w| !w.is_empty()).unwrap_or_else(|| "Waiting for your answer".into())];
                    let options =
                        options.iter().map(|o| PromptOption { n: o.n.into(), label: o.label.clone(), detail: None, selected: false, checked: None, current: None }).collect();
                    let prompt = ScreenPrompt {
                        body,
                        whole_lines: None,
                        options,
                        tabs: None,
                        footer: None,
                        multi: false,
                        free_text_option: None,
                        navigate: None,
                        input: None,
                        links: None,
                        api: None,
                        confirm: None,
                    };
                    self.0.insert(k, prompt);
                } else if h.status == HostStatus::Online {
                    self.0.remove(&k);
                }
            }
        }
    }

    /// The question this session was last seen asking, if it may still be waiting.
    pub fn get(&self, host: &str, pane: &str) -> Option<&ScreenPrompt> {
        self.0.get(&(host.to_string(), pane.to_string()))
    }
}

thread_local! {
    static ASKS: RefCell<Asks> = RefCell::new(Asks::default());
}

/// Notes the overview as it arrives.
pub fn note(hosts: &[HostState]) {
    ASKS.with(|a| a.borrow_mut().note(hosts));
}

/// The question a session was last seen asking.
pub fn last(host: &str, pane: &str) -> Option<ScreenPrompt> {
    ASKS.with(|a| a.borrow().get(host, pane).cloned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn hosts(status: &str, agent: serde_json::Value) -> Vec<HostState> {
        let pane = json!({ "id": "%3", "index": 0, "active": true, "command": "codex", "cwd": "/w", "title": "t", "width": 80, "height": 24, "dead": false, "agent": agent });
        let host = json!({
            "config": { "id": "box", "name": "box", "kind": "node" }, "status": status, "integration": "installed", "tmux": "ok", "agents": [], "updatedAt": 0,
            "sessions": [{ "id": "$1", "name": "s", "attached": 0, "windows": [{ "id": "@1", "index": 1, "name": "w", "active": true, "activity": 0, "panes": [pane] }] }],
        });
        vec![serde_json::from_value(host).expect("a host")]
    }

    fn waiting() -> serde_json::Value {
        json!({ "kind": "codex", "state": "waiting", "pid": 1, "startedAt": 0, "waitingFor": "Run bun test?", "options": [{ "n": 1, "label": "Yes" }, { "n": 2, "label": "No" }] })
    }

    #[test]
    fn a_question_stays_while_its_machine_is_away_and_goes_once_it_is_back_and_answered() {
        let mut a = Asks::default();
        a.note(&hosts("online", waiting()));
        let p = a.get("box", "%3").expect("the question");
        assert_eq!(p.body, ["Run bun test?"]);
        assert_eq!(p.options.iter().map(|o| (o.n, o.label.as_str())).collect::<Vec<_>>(), [(1, "Yes"), (2, "No")]);

        // the machine drops: the overview no longer says it's waiting, but the question stays
        let idle = json!({ "kind": "codex", "state": "idle", "pid": 1, "startedAt": 0 });
        a.note(&hosts("error", idle.clone()));
        assert!(a.get("box", "%3").is_some());
        // back, and not asking any more
        a.note(&hosts("online", idle));
        assert!(a.get("box", "%3").is_none());
    }

    #[test]
    fn a_question_goes_with_its_pane_once_the_machine_is_back() {
        let mut a = Asks::default();
        a.note(&hosts("online", waiting()));
        // the machine drops, and its pane is gone when it comes back
        a.note(&hosts("error", waiting()));
        let mut back = hosts("online", waiting());
        back[0].sessions[0].windows[0].panes.clear();
        a.note(&back);
        assert!(a.get("box", "%3").is_none());
        // a machine that's away lists nothing for sure: its questions stay
        a.note(&hosts("online", waiting()));
        let mut away = hosts("error", waiting());
        away[0].sessions.clear();
        a.note(&away);
        assert!(a.get("box", "%3").is_some());
    }

    #[test]
    fn a_question_without_answers_to_offer_is_not_kept() {
        let mut a = Asks::default();
        a.note(&hosts("online", json!({ "kind": "claude", "state": "waiting", "pid": 1, "startedAt": 0, "waitingFor": "Edit the file?" })));
        assert!(a.get("box", "%3").is_none());
    }
}
