//! Pins, parking, snoozes, tags and notes as this app shows them (from 1.1): the session list in
//! its sections, the rows picked for a bulk action, and the short words a row needs. The hub keeps
//! the marks (`organize` on `/ws2`) and chat-core's organize.rs says where each pane goes; this adds
//! what the sidebar and the Overview work out for themselves.

use inyon_chat_core::js::local_time;
use inyon_chat_core::organize::{mark_for, snoozed, sort_panes};
use inyon_protocol::{HostState, Organize, SessionMark};

use crate::format::{self, Clock};
use crate::model::{self, Filter, PaneRef};

/// A session as a bulk action names it: its machine and its tmux pane.
pub type Key = (String, String);

pub fn key_of(r: &PaneRef) -> Key {
    (r.host.config.id.clone(), r.pane.id.clone())
}

/// A section of the session list.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Kind {
    Pinned,
    Sessions,
    Parked,
    Snoozed,
}

impl Kind {
    pub fn label(self) -> &'static str {
        match self {
            Kind::Pinned => "Pinned",
            Kind::Sessions => "Sessions",
            Kind::Parked => "Parked",
            Kind::Snoozed => "Snoozed",
        }
    }

    /// The key a folded section is remembered by.
    pub fn id(self) -> &'static str {
        match self {
            Kind::Pinned => "pinned",
            Kind::Sessions => "sessions",
            Kind::Parked => "parked",
            Kind::Snoozed => "snoozed",
        }
    }

    /// Parked and snoozed sessions are out of the way, so their sections start folded.
    pub fn folded_at_first(self) -> bool {
        matches!(self, Kind::Parked | Kind::Snoozed)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Section<'a> {
    pub kind: Kind,
    pub rows: Vec<PaneRef<'a>>,
}

/// The agent sessions in their sections, the empty ones left out. Within a section they keep the
/// Overview's order (machines as added, sessions as tmux started them), except that pinned ones
/// follow their pins and snoozed ones wake soonest first.
pub fn sections<'a>(hosts: &'a [HostState], org: &Organize, now: u64) -> Vec<Section<'a>> {
    let panes: Vec<PaneRef<'a>> = model::group_panes(hosts, Filter::All).into_iter().flat_map(|g| g.panes).collect();
    let s = sort_panes(panes, org, now);
    [(Kind::Pinned, s.pinned), (Kind::Sessions, s.sessions), (Kind::Parked, s.parked), (Kind::Snoozed, s.snoozed)]
        .into_iter()
        .filter(|(_, rows)| !rows.is_empty())
        .map(|(kind, rows)| Section { kind, rows })
        .collect()
}

/// The rows in the order the list shows them, folded sections left out: what Shift-click picks a
/// range from.
pub fn visible(sections: &[Section], folded: impl Fn(Kind) -> bool) -> Vec<Key> {
    sections.iter().filter(|s| !folded(s.kind)).flat_map(|s| s.rows.iter().map(key_of)).collect()
}

/// How many sessions in a section need you, are working, or neither: the dots a heading shows.
pub fn dots(rows: &[PaneRef]) -> (usize, usize) {
    let waiting = rows.iter().filter(|r| model::AgentPane::agent(*r).state == inyon_protocol::AgentState::Waiting).count();
    let working = rows.iter().filter(|r| model::busy(model::AgentPane::agent(*r))).count();
    (waiting, working)
}

/// The rows picked for a bulk action, and the one a Shift-click counts from.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Selection {
    pub keys: Vec<Key>,
    pub anchor: Option<Key>,
}

impl Selection {
    pub fn has(&self, k: &Key) -> bool {
        self.keys.contains(k)
    }

    pub fn len(&self) -> usize {
        self.keys.len()
    }

    pub fn is_empty(&self) -> bool {
        self.keys.is_empty()
    }

    /// Cmd- or Ctrl-click: in or out of the selection, and the next range starts here.
    pub fn toggle(&mut self, k: Key) {
        if let Some(i) = self.keys.iter().position(|x| *x == k) {
            self.keys.remove(i);
        } else {
            self.keys.push(k.clone());
        }
        self.anchor = Some(k);
    }

    /// Shift-click: every row from the anchor to this one, in the list's order, joins the
    /// selection. Without an anchor still on screen it starts one here.
    pub fn extend(&mut self, k: Key, order: &[Key]) {
        let from = self.anchor.as_ref().and_then(|a| order.iter().position(|x| x == a));
        let to = order.iter().position(|x| *x == k);
        match (from, to) {
            (Some(a), Some(b)) => {
                let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
                for x in &order[lo..=hi] {
                    if !self.keys.contains(x) {
                        self.keys.push(x.clone());
                    }
                }
            }
            _ => self.toggle(k),
        }
    }

    pub fn clear(&mut self) {
        self.keys.clear();
        self.anchor = None;
    }

    /// Drops rows that are no longer listed (ended, or on a machine that went away).
    pub fn keep_only(&mut self, listed: &[Key]) -> bool {
        let before = self.keys.len();
        self.keys.retain(|k| listed.contains(k));
        if self.anchor.as_ref().is_some_and(|a| !listed.contains(a)) {
            self.anchor = None;
        }
        before != self.keys.len()
    }
}

/// What every selected session has in common, so a bulk item can say Unpin rather than Pin.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Common {
    pub pinned: bool,
    pub parked: bool,
    pub snoozed: bool,
}

pub fn common(keys: &[Key], org: &Organize, now: u64) -> Common {
    let marks: Vec<Option<&SessionMark>> = keys.iter().map(|(h, p)| mark_for(org, h, p)).collect();
    let all = |f: &dyn Fn(&SessionMark) -> bool| !marks.is_empty() && marks.iter().all(|m| m.is_some_and(f));
    Common { pinned: all(&|m| m.pinned.is_some()), parked: all(&|m| m.parked == Some(true)), snoozed: all(&|m| snoozed(m, now)) }
}

/// A row's time, as short as it goes: "now", "5m", "3h", "2d", then the date.
pub fn short_ago(ms: f64, clock: Clock) -> String {
    let s = ((clock.now - ms) / 1000.0).max(0.0);
    if s < 60.0 {
        "now".into()
    } else if s < 3600.0 {
        format!("{}m", (s / 60.0) as u64)
    } else if s < 86_400.0 {
        format!("{}h", (s / 3600.0) as u64)
    } else if s < 7.0 * 86_400.0 {
        format!("{}d", (s / 86_400.0) as u64)
    } else {
        format::time_ago(ms, clock)
    }
}

/// When a snoozed session comes back: "14:00" today, "Tue 9:00" within the week, else the date.
pub fn wakes_at(at: u64, clock: Clock) -> String {
    let t = local_time(at as f64, clock.tz_minutes);
    let today = local_time(clock.now, clock.tz_minutes);
    let days = (at as f64 - clock.now) / 86_400_000.0;
    if t.day == today.day && days < 1.0 {
        format!("{}:{:02}", t.hour, t.minute)
    } else if days < 7.0 {
        format!("{} {}:{:02}", ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][t.weekday as usize], t.hour, t.minute)
    } else {
        t.month_day()
    }
}

/// The first line of a note, for a tooltip or a card.
pub fn note_line(note: &str) -> &str {
    note.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Tuesday 3 Nov 2026, 12:00 UTC
    const NOW: f64 = 1_793_707_200_000.0;
    const CLOCK: Clock = Clock { now: NOW, tz_minutes: 0 };

    fn hosts() -> Vec<HostState> {
        let pane = |id: &str, state: &str| {
            json!({ "id": id, "index": 0, "active": true, "command": "claude", "cwd": "/w", "title": id, "width": 80, "height": 40, "dead": false,
                "agent": { "kind": "claude", "pid": 1, "state": state } })
        };
        let session = |id: &str, p: serde_json::Value| json!({ "id": id, "name": id, "attached": 0, "windows": [{ "id": "@1", "index": 1, "name": "", "active": true, "activity": 1, "panes": [p] }] });
        vec![serde_json::from_value(json!({ "config": { "id": "box", "name": "box", "kind": "local" }, "status": "online", "integration": "installed", "tmux": "ok",
            "agents": ["claude"], "updatedAt": 0,
            "sessions": [session("$1", pane("%1", "idle")), session("$2", pane("%2", "working")), session("$3", pane("%3", "waiting")),
                session("$4", pane("%4", "idle")), session("$5", pane("%5", "idle"))] }))
        .unwrap()]
    }

    fn org() -> Organize {
        serde_json::from_value(json!({ "v": 2, "sessions": [
            { "id": "s-1", "host": "box", "pane": "%4", "live": true, "pinned": 0 },
            { "id": "s-2", "host": "box", "pane": "%2", "live": true, "pinned": 1, "tags": ["ui"] },
            { "id": "s-3", "host": "box", "pane": "%5", "live": true, "parked": true },
            { "id": "s-4", "host": "box", "pane": "%1", "live": true, "snoozedUntil": NOW as u64 + 3_600_000 },
        ] }))
        .unwrap()
    }

    fn k(p: &str) -> Key {
        ("box".into(), p.into())
    }

    #[test]
    fn sessions_fall_into_sections_and_empty_ones_are_left_out() {
        let h = hosts();
        let s = sections(&h, &org(), NOW as u64);
        let shape: Vec<(Kind, Vec<&str>)> = s.iter().map(|x| (x.kind, x.rows.iter().map(|r| r.pane.id.as_str()).collect())).collect();
        assert_eq!(shape, [(Kind::Pinned, vec!["%4", "%2"]), (Kind::Sessions, vec!["%3"]), (Kind::Parked, vec!["%5"]), (Kind::Snoozed, vec!["%1"])]);
        assert_eq!(dots(&s[0].rows), (0, 1));
        assert_eq!(dots(&s[1].rows), (1, 0));
        // nothing organised: one section
        assert_eq!(sections(&h, &Organize::default(), NOW as u64).len(), 1);
        // a folded section's rows aren't in a range
        assert_eq!(visible(&s, |k| k.folded_at_first()), [k("%4"), k("%2"), k("%3")]);
    }

    #[test]
    fn a_selection_toggles_and_extends_over_a_range() {
        let order = [k("%1"), k("%2"), k("%3"), k("%4")];
        let mut s = Selection::default();
        s.toggle(k("%2"));
        s.extend(k("%4"), &order);
        assert_eq!(s.keys, [k("%2"), k("%3"), k("%4")]);
        // backwards from the anchor, without picking a row twice
        s.extend(k("%1"), &order);
        assert_eq!(s.keys, [k("%2"), k("%3"), k("%4"), k("%1")]);
        s.toggle(k("%3"));
        assert_eq!(s.len(), 3);
        assert_eq!(s.anchor, Some(k("%3")));
        // an anchor that left the list: a Shift-click starts over from the row
        assert!(s.keep_only(&[k("%1"), k("%2")]));
        assert_eq!(s.anchor, None);
        s.extend(k("%4"), &order);
        assert_eq!(s.keys, [k("%2"), k("%1"), k("%4")]);
        s.clear();
        assert!(s.is_empty());
    }

    #[test]
    fn bulk_items_flip_only_when_every_session_agrees() {
        let o = org();
        let now = NOW as u64;
        assert_eq!(common(&[k("%4"), k("%2")], &o, now), Common { pinned: true, parked: false, snoozed: false });
        assert!(!common(&[k("%4"), k("%3")], &o, now).pinned);
        assert!(common(&[k("%5")], &o, now).parked);
        assert!(common(&[k("%1")], &o, now).snoozed);
        assert!(!common(&[k("%1")], &o, now + 3_600_000).snoozed, "the snooze is over");
        assert_eq!(common(&[], &o, now), Common::default());
    }

    #[test]
    fn times_are_short_and_wake_times_local() {
        assert_eq!(short_ago(NOW - 10_000.0, CLOCK), "now");
        assert_eq!(short_ago(NOW - 5.0 * 60_000.0, CLOCK), "5m");
        assert_eq!(short_ago(NOW - 3.0 * 3_600_000.0, CLOCK), "3h");
        assert_eq!(short_ago(NOW - 2.0 * 86_400_000.0, CLOCK), "2d");
        let h = 3_600_000u64;
        assert_eq!(wakes_at(NOW as u64 + 2 * h, CLOCK), "14:00");
        assert_eq!(wakes_at(NOW as u64 + 21 * h, CLOCK), "Wed 9:00");
        let kolkata = Clock { now: NOW, tz_minutes: 330 };
        assert_eq!(wakes_at(NOW as u64 + 2 * h, kolkata), "19:30");
        assert_eq!(wakes_at(NOW as u64 + 6 * 24 * h - 3 * h, CLOCK), "Mon 9:00", "next week");
        assert_eq!(wakes_at(NOW as u64 + 8 * 24 * h, CLOCK), "Nov 11");
        assert_eq!(note_line("\n  ask about the cache \nmore"), "ask about the cache");
    }
}
