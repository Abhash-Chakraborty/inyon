//! What the Overview's own tools work out (pages/Home.tsx and components/Overview.tsx): its search,
//! the empty list's words, the Claude integration card, Recent activity and pull to refresh. The
//! screen is ui/overview.rs.

use inyon_chat_core::groups::{matches_query, search_text};
use inyon_chat_core::store::{ActivityEvent, ActivityKind};
use inyon_protocol::{AgentKind, AgentState, HostState, HostStatus, IntegrationState, SessionMark};

use crate::model::PaneRef;

/// Past this many agent sessions the Overview gets a search box.
pub const SEARCH_FROM: usize = 6;

pub fn searchable(sessions: usize) -> bool {
    sessions > SEARCH_FROM
}

/// Whether a session matches the search: every word somewhere in its title (the agent's and the
/// one given in Inyon), agent, machine, tmux session and window, folder, tags or note.
pub fn matches(r: &PaneRef, mark: Option<&SessionMark>, title: &str, query: &str) -> bool {
    if query.is_empty() {
        return true;
    }
    let mut text = search_text(r);
    text.push(' ');
    text.push_str(title);
    for t in mark.and_then(|m| m.tags.as_ref()).into_iter().flatten() {
        text.push_str(&format!(" #{t} {t}"));
    }
    if let Some(n) = mark.and_then(|m| m.note.as_deref()) {
        text.push(' ');
        text.push_str(n);
    }
    matches_query(&text, query)
}

/// The empty list's title and line: nothing matches the filter or the search, or there are no
/// agent sessions at all. The phone app says computer, and its + is a tap.
pub fn empty_text(any: bool, query: &str, phone: bool) -> (&'static str, String) {
    if any {
        let line = if query.is_empty() { "Try another filter.".to_string() } else { format!("No session matches “{query}”.") };
        return ("Nothing here", line);
    }
    let (machine, start) = if phone { ("computer", "tap + ") } else { ("machine", "press N ") };
    ("No agent sessions", format!("Start Claude Code, Codex or another agent in tmux on any {machine}, or {start}to start one from here."))
}

/// A machine whose Claude integration is off, gone or old, while Claude Code is there.
pub fn needs_integration(h: &HostState) -> bool {
    h.status == HostStatus::Online
        && matches!(h.integration, IntegrationState::Missing | IntegrationState::Removed | IntegrationState::Outdated)
        && h.agents.contains(&AgentKind::Claude)
}

/// What the card says after the machine's name.
pub fn integration_line(s: IntegrationState) -> &'static str {
    match s {
        IntegrationState::Missing => "turn on the integration for live usage limits, context and cost, instant updates and exact session matching.",
        IntegrationState::Removed | IntegrationState::Outdated => crate::machines::integration_text(s),
        _ => "",
    }
}

/// The card's button, while it runs and before.
pub fn integration_button(s: IntegrationState, busy: bool) -> &'static str {
    match (s == IntegrationState::Outdated, busy) {
        (true, true) => "Updating",
        (true, false) => "Update",
        (false, true) => "Turning on",
        (false, false) => "Turn on",
    }
}

/// The toast's title when the machine took it, or when it didn't.
pub fn integration_toast(s: IntegrationState, ok: bool) -> &'static str {
    match (s == IntegrationState::Outdated, ok) {
        (true, true) => "Claude integration updated",
        (false, true) => "Claude integration on",
        (true, false) => "Could not update the integration",
        (false, false) => "Could not turn on the integration",
    }
}

/// How many events Recent activity shows.
pub const FEED_ROWS: usize = 8;

/// What an entry says now. Only the latest question of a session still waiting needs you; an
/// earlier one, or one the session has moved on from, was answered (from here, from an alert or at
/// the keyboard), and one whose session has ended was just asked. "Latest" is judged from the live
/// list, so a row held still under the pointer stops saying "needs you" once a newer question came.
pub fn activity_label(e: &ActivityEvent, live: &[ActivityEvent], hosts: &[HostState]) -> &'static str {
    if e.kind == ActivityKind::Done {
        return "finished";
    }
    let agent = hosts
        .iter()
        .filter(|h| h.config.id == e.host)
        .flat_map(|h| &h.sessions)
        .flat_map(|s| &s.windows)
        .flat_map(|w| &w.panes)
        .find(|p| p.id == e.pane)
        .and_then(|p| p.agent.as_ref());
    let Some(a) = agent else { return "asked" };
    let latest = live.iter().find(|x| x.host == e.host && x.pane == e.pane && x.kind == ActivityKind::Waiting);
    if a.state == AgentState::Waiting && latest == Some(e) {
        "needs you"
    } else {
        "answered"
    }
}

/// Events that came in while the list was held still: the live list is newest first, so the ones
/// above the event that topped the held list (all of them once it has dropped off the end). Two
/// events in the same millisecond still count apart.
pub fn fresh(held: &[ActivityEvent], live: &[ActivityEvent]) -> usize {
    let Some(top) = held.first() else { return live.len() };
    live.iter().position(|e| e == top).unwrap_or(live.len())
}

/// Where a session's card sits on the Overview.
#[derive(Clone, Debug, PartialEq)]
pub enum Spot {
    Pinned,
    /// Under its machine (by id)
    Machine(String),
    /// In the folded Parked and snoozed
    SetAside,
}

/// What Show opens so that a session that needs you is on screen.
#[derive(Debug, Default, PartialEq)]
pub struct Reveal {
    /// Back to All
    pub filter: bool,
    /// Empty the search
    pub search: bool,
    /// Unfold this machine
    pub machine: Option<String>,
    /// Open Parked and snoozed
    pub set_aside: bool,
}

/// What hides a card from view and has to give way: the All / Working / Idle switch, the search,
/// its folded machine (when there are machine groups) or the folded Parked and snoozed. A search
/// that stays opens every fold by itself. `folded` says whether a fold (a machine's id, or
/// `aside`) is kept closed.
pub fn reveal(spot: &Spot, passes_filter: bool, passes_search: bool, searching: bool, grouped: bool, folded: impl Fn(&str) -> bool) -> Reveal {
    let kept_search = searching && passes_search;
    Reveal {
        filter: !passes_filter,
        search: searching && !passes_search,
        machine: match spot {
            Spot::Machine(id) if grouped && !kept_search && folded(id) => Some(id.clone()),
            _ => None,
        },
        set_aside: *spot == Spot::SetAside && !kept_search && folded("aside"),
    }
}

/// How far to pull (px, after damping) before letting go refreshes.
pub const PULL_TRIGGER: f64 = 64.0;
const PULL_MAX: f64 = 96.0;

/// How far the mark comes down for a finger `dy` px below where it started.
pub fn pull_distance(dy: f64) -> f64 {
    if dy <= 0.0 {
        0.0
    } else {
        (dy * 0.5).min(PULL_MAX)
    }
}

/// The mark fades in over the first part of the pull.
pub fn pull_opacity(pull: f64) -> f64 {
    if pull <= 0.0 {
        0.0
    } else {
        (pull / (PULL_TRIGGER * 0.6)).min(1.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::all_panes;
    use serde_json::json;

    fn hosts() -> Vec<HostState> {
        let pane = |id: &str, title: &str, cwd: &str, state: &str| {
            json!({ "id": id, "index": 0, "active": true, "command": "claude", "cwd": cwd, "title": title, "width": 80, "height": 40, "dead": false,
                "agent": { "kind": "claude", "pid": 1, "state": state } })
        };
        vec![serde_json::from_value(json!({ "config": { "id": "box", "name": "studio", "kind": "local" }, "status": "online", "integration": "missing",
            "tmux": "ok", "agents": ["claude"], "updatedAt": 0, "sessions": [{ "id": "$1", "name": "storefront", "attached": 0,
            "windows": [{ "id": "@1", "index": 1, "name": "", "active": true, "activity": 0, "panes": [
                pane("%1", "✳ Fix flaky checkout test", "/home/sam/code/storefront", "idle"),
                pane("%2", "Tidy billing types", "/home/sam/code/billing", "waiting") ] }] }] }))
        .unwrap()]
    }

    #[test]
    fn the_search_finds_a_session_by_every_field() {
        let h = hosts();
        let p = all_panes(&h);
        let r = &p[0];
        let m: SessionMark =
            serde_json::from_value(json!({ "id": "s-1", "host": "box", "pane": "%1", "live": true, "tags": ["release"], "note": "waiting on the payments team" })).unwrap();
        let hit = |q: &str| matches(r, Some(&m), "Checkout race", q);
        for q in ["", "flaky", "FLAKY checkout", "claude code", "studio", "storefront:1", "code/storefront", "#release", "release", "payments", "race"] {
            assert!(hit(q), "{q}");
        }
        assert!(!hit("billing"));
        assert!(!hit("flaky billing"), "every word has to match");
        assert!(matches(&p[1], None, "Tidy billing types", "billing"));
        assert!(!matches(&p[1], None, "Tidy billing types", "#release"));
    }

    #[test]
    fn the_empty_list_says_why() {
        assert_eq!(empty_text(true, "", false), ("Nothing here", "Try another filter.".into()));
        assert_eq!(empty_text(true, "zzz", false), ("Nothing here", "No session matches “zzz”.".into()));
        assert_eq!(empty_text(false, "", false).1, "Start Claude Code, Codex or another agent in tmux on any machine, or press N to start one from here.");
        assert_eq!(empty_text(false, "", true).1, "Start Claude Code, Codex or another agent in tmux on any computer, or tap + to start one from here.");
        assert!(searchable(7) && !searchable(6));
    }

    #[test]
    fn the_integration_card_asks_only_where_claude_runs_without_it() {
        let mut h = hosts().remove(0);
        assert!(needs_integration(&h));
        h.agents = vec![AgentKind::Codex];
        assert!(!needs_integration(&h), "no Claude Code there");
        h.agents = vec![AgentKind::Claude];
        h.status = HostStatus::Error;
        assert!(!needs_integration(&h), "offline");
        h.status = HostStatus::Online;
        h.integration = IntegrationState::Installed;
        assert!(!needs_integration(&h));
        for s in [IntegrationState::Removed, IntegrationState::Outdated] {
            h.integration = s;
            assert!(needs_integration(&h));
        }
        assert!(integration_line(IntegrationState::Missing).starts_with("turn on the integration for live usage limits"));
        assert!(integration_line(IntegrationState::Outdated).starts_with("The Claude integration on this machine is an older version"));
        assert_eq!(integration_button(IntegrationState::Outdated, false), "Update");
        assert_eq!(integration_button(IntegrationState::Outdated, true), "Updating");
        assert_eq!(integration_button(IntegrationState::Removed, true), "Turning on");
        assert_eq!(integration_toast(IntegrationState::Missing, true), "Claude integration on");
        assert_eq!(integration_toast(IntegrationState::Outdated, false), "Could not update the integration");
    }

    fn event(at: u64, pane: &str, kind: ActivityKind) -> ActivityEvent {
        ActivityEvent { id: at, at, host: "box".into(), pane: pane.into(), kind, title: "t".into(), body: String::new(), agent: Some(AgentKind::Claude) }
    }

    #[test]
    fn activity_says_what_each_event_is_now() {
        let h = hosts();
        // newest first: %2 asked twice, %1 asked once and has moved on, %9 is gone, %1 finished
        let all = vec![
            event(5, "%2", ActivityKind::Waiting),
            event(4, "%2", ActivityKind::Waiting),
            event(3, "%1", ActivityKind::Waiting),
            event(2, "%9", ActivityKind::Waiting),
            event(1, "%1", ActivityKind::Done),
        ];
        let labels: Vec<_> = all.iter().map(|e| activity_label(e, &all, &h)).collect();
        assert_eq!(labels, ["needs you", "answered", "answered", "asked", "finished"]);
        // held still at the last four: the row that was latest is answered once a newer one came
        assert_eq!(activity_label(&all[1], &all[1..], &h), "needs you");
        assert_eq!(activity_label(&all[1], &all, &h), "answered");
        // held still at the first three, two arrived since
        assert_eq!(fresh(&all[2..], &all), 2);
        assert_eq!(fresh(&[], &all), 5);
        // one in the same millisecond as the top of the held list still counts
        let mut same = event(3, "%2", ActivityKind::Done);
        same.title = "another".into();
        let live: Vec<_> = std::iter::once(same).chain(all[2..].iter().cloned()).collect();
        assert_eq!(fresh(&all[2..], &live), 1);
        // the held top has dropped off the end: everything is new
        assert_eq!(fresh(&all[4..], &all[..3]), 3);
    }

    #[test]
    fn show_opens_what_hides_the_session() {
        let none = |_: &str| false;
        let all = |_: &str| true;
        let m = Spot::Machine("box".into());
        assert_eq!(reveal(&m, true, true, false, true, none), Reveal::default(), "on screen already");
        assert_eq!(reveal(&m, true, true, false, true, all), Reveal { machine: Some("box".into()), ..Default::default() });
        assert_eq!(reveal(&m, true, true, false, false, all), Reveal::default(), "one machine has no fold");
        assert_eq!(reveal(&Spot::SetAside, true, true, false, true, all), Reveal { set_aside: true, ..Default::default() });
        assert_eq!(reveal(&Spot::Pinned, false, true, false, true, all), Reveal { filter: true, ..Default::default() });
        // a search it matches keeps the folds open; one it doesn't is emptied, and the folds count
        assert_eq!(reveal(&Spot::SetAside, true, true, true, true, all), Reveal::default());
        assert_eq!(reveal(&Spot::SetAside, true, false, true, true, all), Reveal { search: true, set_aside: true, ..Default::default() });
        assert_eq!(reveal(&m, false, false, true, true, none), Reveal { filter: true, search: true, ..Default::default() });
    }

    #[test]
    fn a_pull_is_damped_and_capped() {
        assert_eq!(pull_distance(-20.0), 0.0);
        assert_eq!(pull_distance(100.0), 50.0);
        assert!(pull_distance(128.0) >= PULL_TRIGGER);
        assert_eq!(pull_distance(1000.0), 96.0);
        assert_eq!(pull_opacity(0.0), 0.0);
        assert!(pull_opacity(19.2) > 0.49 && pull_opacity(19.2) < 0.51);
        assert_eq!(pull_opacity(80.0), 1.0);
    }
}
