//! Pins, parking, snoozes, tags and notes in this app (from 1.1; the hub keeps them from 0.24, see
//! inyon-protocol's organize.rs): what the session menu and the bulk menu offer, the changes they
//! send, the Tags, Note and Rename sheets, and the bar that acts on several selected sessions.
//! Menus carry an [`OrgOp`] as data, so a menu still works after its row scrolled away.

use dioxus::prelude::*;
use inyon_chat_core::organize::{mark_for, shown_title, snooze_until, snoozed, tags_in_use, SnoozeFor};
use inyon_protocol::{normalize_tag, Organize, SessionMark, MAX_TAGS, NOTE_LEN, TAG_LEN, TITLE_LEN};
use serde_json::{json, Value};

use super::icons::{Glyph, Icon};
use super::kit::{Busy, Field, Sheet};
use super::menu::{self, Action, Item, Menu};
use super::toast::{self, Toast, ToastTone};
use crate::format::Clock;
use crate::model::{self, AgentPane, PaneRef};
use crate::organize::{common, key_of, wakes_at, Key, Kind, Selection};
use crate::route::Route;
use crate::state::Hub;
use crate::{api, dom, platform};

/// What the hub keeps, as its organize stream last said, and whether it has said anything yet (a
/// hub without the stream never does, and its menus offer none of this).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Org {
    pub org: Organize,
    pub loaded: bool,
}

pub static ORG: GlobalSignal<Org> = Signal::global(Org::default);
/// The sessions picked for a bulk action, in the sidebar and on the Overview alike.
pub static SELECTION: GlobalSignal<Selection> = Signal::global(Selection::default);

pub fn set(org: Organize) {
    *ORG.write() = Org { org, loaded: true };
}

/// How sessions were organised as this browser last saw it: they take their places at once, and
/// the actions wait for the hub's own copy.
pub fn kept(org: Organize) {
    *ORG.write() = Org { org, loaded: false };
}

/// A change to one session or several, or a sheet that asks for one.
#[derive(Debug, Clone, PartialEq)]
pub enum OrgOp {
    Pin(Vec<Key>, bool),
    Park(Vec<Key>, bool),
    /// None ends the snooze
    Snooze(Vec<Key>, Option<SnoozeFor>),
    /// a tag, added or taken off
    Tag(Vec<Key>, String, bool),
    CloseWhenDone(Key, bool),
    /// puts back what each session had before (Undo)
    Restore(Undo),
    Sheet(OrgSheet),
    /// starts picking sessions from this one (the long-press menu on a phone)
    Select(Key),
    SelectAll(Vec<Key>),
    ClearSelection,
}

#[derive(Debug, Clone, PartialEq)]
pub enum OrgSheet {
    /// a new tag for these sessions
    Tags(Vec<Key>),
    Note(Key),
    Rename(Key),
}

/// What Undo puts back after a change.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Undo {
    /// each session's fields as they were
    pub fields: Vec<(Key, Value)>,
    /// the pinned sessions' order (mark ids) to put back once they're pinned again
    pub pins: Vec<String>,
    /// a tag to add (true) or take off again on these sessions, from their tags as they are when
    /// Undo runs, so a tag another device added in between stays
    pub tag: Option<(Vec<Key>, String, bool)>,
}

impl Undo {
    pub fn is_empty(&self) -> bool {
        self.fields.is_empty() && self.tag.as_ref().is_none_or(|(k, _, _)| k.is_empty())
    }

    /// The same Undo without the sessions whose change the hub refused.
    pub fn without(&self, failed: &[Key]) -> Undo {
        Undo {
            fields: self.fields.iter().filter(|(k, _)| !failed.contains(k)).cloned().collect(),
            pins: self.pins.clone(),
            tag: self.tag.as_ref().map(|(keys, t, add)| (keys.iter().filter(|k| !failed.contains(k)).cloned().collect(), t.clone(), *add)),
        }
    }

    /// The sessions its tag can't go back on, since each has eight tags already.
    pub fn full(&self, org: &Organize) -> Vec<Key> {
        match &self.tag {
            Some((keys, t, true)) => keys.iter().filter(|k| no_room(std::slice::from_ref(*k), org, t)).cloned().collect(),
            _ => vec![],
        }
    }

    /// What to send for it now, against what the hub keeps now.
    pub fn changes(&self, org: &Organize) -> Vec<(Key, Value)> {
        let mut list = self.fields.clone();
        if let Some((keys, t, add)) = &self.tag {
            let op = OrgOp::Tag(vec![], t.clone(), *add);
            list.extend(keys.iter().filter_map(|k| patch_for(&op, mark_for(org, &k.0, &k.1), 0, &|_| 0).map(|(c, _)| (k.clone(), c))));
        }
        list
    }
}

/// The pinned sessions' mark ids, in their order.
pub fn pin_order(org: &Organize) -> Vec<String> {
    let mut v: Vec<(u32, &str)> = org.sessions.iter().filter_map(|m| m.pinned.map(|p| (p, m.id.as_str()))).collect();
    v.sort();
    v.into_iter().map(|(_, id)| id.to_string()).collect()
}

/// True when `tag` can't go on any of these sessions: each has eight tags, none of them this one.
pub fn no_room(keys: &[Key], org: &Organize, tag: &str) -> bool {
    !keys.is_empty() && keys.iter().all(|k| mark_for(org, &k.0, &k.1).and_then(|m| m.tags.as_ref()).is_some_and(|t| t.len() >= MAX_TAGS && !t.iter().any(|x| x == tag)))
}

/// What `op` sends to each session that needs it, and what undoes it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Plan {
    pub changes: Vec<(Key, Value)>,
    pub undo: Undo,
    /// a tag couldn't go on a session because it has eight already
    pub over_limit: bool,
}

pub fn plan(op: &OrgOp, org: &Organize, now: u64, wake: &dyn Fn(SnoozeFor) -> u64) -> Plan {
    let keys = keys_of(op);
    let mut p = Plan::default();
    let mut changed = vec![];
    for k in &keys {
        if let Some((change, back)) = patch_for(op, mark_for(org, &k.0, &k.1), now, wake) {
            p.changes.push((k.clone(), change));
            p.undo.fields.push((k.clone(), back));
            changed.push(k.clone());
        }
    }
    match op {
        OrgOp::Tag(_, t, add) => {
            // a tag's Undo takes off or puts back that one tag, not the whole list
            p.undo.fields.clear();
            p.undo.tag = Some((changed, t.clone(), !add));
            p.over_limit = *add && keys.iter().any(|k| mark_for(org, &k.0, &k.1).and_then(|m| m.tags.as_ref()).is_some_and(|tags| tags.len() >= MAX_TAGS && !tags.contains(t)));
        }
        OrgOp::Pin(_, false) if !p.changes.is_empty() => p.undo.pins = pin_order(org),
        _ => {}
    }
    p
}

/// When a snooze for `p` ends, by this device's clock, with the offset in effect then (a
/// daylight-saving change before tomorrow morning still wakes it at 9:00).
pub fn wake_at(p: SnoozeFor, now: u64, tz_now: i32, tz_at: impl Fn(u64) -> i32) -> u64 {
    let t = snooze_until(p, now, tz_now);
    match p {
        SnoozeFor::Hour | SnoozeFor::ThreeHours => t,
        _ => t.saturating_add_signed(-i64::from(tz_at(t) - tz_now) * 60_000),
    }
}

fn wake(p: SnoozeFor, clock: Clock) -> u64 {
    wake_at(p, clock.now as u64, clock.tz_minutes, platform::tz_at)
}

/// The change one session needs for `op`, and the change that undoes it; None when it has it
/// already. `wake` says when a snooze ends.
pub fn patch_for(op: &OrgOp, m: Option<&SessionMark>, now: u64, wake: &dyn Fn(SnoozeFor) -> u64) -> Option<(Value, Value)> {
    let tags = || m.and_then(|m| m.tags.clone()).unwrap_or_default();
    match op {
        OrgOp::Pin(_, on) => {
            let was = m.is_some_and(|m| m.pinned.is_some());
            (was != *on).then(|| (json!({ "pinned": on }), json!({ "pinned": was })))
        }
        OrgOp::Park(_, on) => {
            let was = m.is_some_and(|m| m.parked == Some(true));
            (was != *on).then(|| (json!({ "parked": on }), json!({ "parked": was })))
        }
        OrgOp::Snooze(_, until) => {
            // a snooze that's over can't be put back; none is
            let was = m.and_then(|m| m.snoozed_until).filter(|t| *t > now);
            match until {
                Some(p) => Some((json!({ "snoozedUntil": wake(*p) }), json!({ "snoozedUntil": was }))),
                None => was.map(|t| (json!({ "snoozedUntil": null }), json!({ "snoozedUntil": t }))),
            }
        }
        OrgOp::Tag(_, tag, add) => {
            let before = tags();
            let has = before.contains(tag);
            if has == *add || (*add && before.len() >= MAX_TAGS) {
                return None;
            }
            let after: Vec<String> = if *add { before.iter().cloned().chain([tag.clone()]).collect() } else { before.iter().filter(|t| *t != tag).cloned().collect() };
            Some((json!({ "tags": after }), json!({ "tags": before })))
        }
        OrgOp::CloseWhenDone(_, on) => {
            let was = m.is_some_and(|m| m.close_when_done == Some(true));
            (was != *on).then(|| (json!({ "closeWhenDone": on }), json!({ "closeWhenDone": was })))
        }
        _ => None,
    }
}

fn keys_of(op: &OrgOp) -> Vec<Key> {
    match op {
        OrgOp::Pin(k, _) | OrgOp::Park(k, _) | OrgOp::Snooze(k, _) | OrgOp::Tag(k, _, _) => k.clone(),
        OrgOp::CloseWhenDone(k, _) => vec![k.clone()],
        _ => vec![],
    }
}

/// What the toast after a change says, and whether it offers Undo. `name` is the one session's
/// name when there's one.
pub fn told(op: &OrgOp, n: usize, name: &str, clock: Clock) -> Option<String> {
    let many = |verb: &str| (n > 1).then(|| format!("{verb} {n} sessions"));
    match op {
        OrgOp::Park(_, true) if n == 1 => Some(format!("Parked “{name}”")),
        OrgOp::Park(_, true) => many("Parked"),
        OrgOp::Park(_, false) => many("Unparked"),
        OrgOp::Pin(_, on) => many(if *on { "Pinned" } else { "Unpinned" }),
        OrgOp::Snooze(_, Some(p)) => {
            let at = wakes_at_here(wake(*p, clock), clock);
            Some(if n == 1 { format!("Snoozed until {at}") } else { format!("Snoozed {n} sessions until {at}") })
        }
        OrgOp::Snooze(_, None) => many("Woke"),
        OrgOp::Tag(_, t, true) => many(&format!("Tagged #{t} on")),
        OrgOp::Tag(_, t, false) => many(&format!("Took #{t} off")),
        OrgOp::CloseWhenDone(_, true) => Some(format!("“{name}” closes when its agent is done")),
        _ => None,
    }
}

/// A session's name, for a toast.
fn name_of(hosts: &[inyon_protocol::HostState], org: &Organize, k: &Key) -> String {
    model::all_panes(hosts).into_iter().find(|r| r.host.config.id == k.0 && r.pane.id == k.1).map_or_else(|| "the session".into(), |r| shown_title(&r, org))
}

/// A wake time as this device shows it, by the offset in effect at that time.
pub fn wakes_at_here(at: u64, clock: Clock) -> String {
    wakes_at(at, clock, platform::tz_at(at))
}

/// One organize change at a time: each is planned from the marks the one before left, so two
/// quick tag changes to a session don't each send a tag list without the other's tag.
static SENDING: std::sync::LazyLock<futures_util::lock::Mutex<()>> = std::sync::LazyLock::new(|| futures_util::lock::Mutex::new(()));

/// Sends each session its change; the sessions the hub refused, and the last reason.
async fn send_all(list: Vec<(Key, Value)>) -> (Vec<Key>, Option<String>) {
    let mut failed = vec![];
    let mut why = None;
    for (k, body) in list {
        match api::organize_pane(&k.0, &k.1, &body).await {
            // planned from at once, though the stream brings it a moment later
            Ok(mark) => crate::organize::take_mark(&mut ORG.write().org, &k, mark),
            Err(e) => {
                failed.push(k);
                why = Some(e.message);
            }
        }
    }
    (failed, why)
}

fn undo_toast(title: String, body: Option<String>, tone: ToastTone, undo: Undo) {
    toast::show(Toast { id: 0, title, body, tone, href: None, agent: None, action: Some(("Undo".into(), Action::Org(OrgOp::Restore(undo)))) });
}

pub fn run(op: OrgOp, hub: Signal<Hub>) {
    match op {
        OrgOp::Sheet(s) => open_sheet(s),
        OrgOp::Select(k) => {
            let mut s = SELECTION.write();
            s.clear();
            s.toggle(k);
        }
        OrgOp::SelectAll(keys) => {
            let mut s = SELECTION.write();
            for k in keys {
                if !s.has(&k) {
                    s.keys.push(k);
                }
            }
        }
        OrgOp::ClearSelection => SELECTION.write().clear(),
        // not tied to the screen that asked: the toast whose Undo this is goes away at once
        OrgOp::Restore(undo) => {
            dioxus::core::spawn_forever(async move {
                let _turn = SENDING.lock().await;
                let org = ORG.peek().org.clone();
                let full = undo.full(&org);
                if let (false, Some((_, t, _))) = (full.is_empty(), &undo.tag) {
                    let why = if full.len() == 1 { format!("That session has {MAX_TAGS} tags already.") } else { format!("{} sessions have {MAX_TAGS} tags already.", full.len()) };
                    toast::toast(format!("Could not put “{t}” back"), Some(why), ToastTone::Error);
                }
                let list = undo.changes(&org);
                let n = list.len();
                let (failed, why) = send_all(list).await;
                // the pins go back where they were once they're all pinned again
                if failed.is_empty() && !undo.pins.is_empty() {
                    if let Err(e) = api::pin_order(&undo.pins).await {
                        toast::toast("Could not put the pins back in order", Some(e.message), ToastTone::Error);
                    }
                }
                if let Some(why) = why {
                    toast::toast(if n == 1 { "Could not undo" } else { "Could not undo every change" }, Some(why), ToastTone::Error);
                }
            });
        }
        op => {
            let many = keys_of(&op).len() > 1;
            // the time of the click: a snooze is for an hour from now, or tomorrow from today
            let clock = platform::clock();
            dioxus::core::spawn_forever(async move {
                // planned once the change before it is in, from the marks it left
                let _turn = SENDING.lock().await;
                let org = ORG.peek().org.clone();
                let Plan { changes, undo, over_limit } = plan(&op, &org, clock.now as u64, &|p| wake(p, clock));
                if over_limit {
                    toast::toast(format!("A session can have at most {MAX_TAGS} tags"), None, ToastTone::Error);
                }
                if changes.is_empty() {
                    return;
                }
                // the one that changed, when only one of the selected did
                let name = changes.first().map(|(k, _)| name_of(&hub.peek().hosts, &org, k)).unwrap_or_default();
                let said = told(&op, changes.len(), &name, clock);
                let n = changes.len();
                let (failed, why) = send_all(changes).await;
                let f = failed.len();
                if f == 0 {
                    if let Some(title) = said {
                        undo_toast(title, None, ToastTone::Info, undo);
                    }
                } else if f == n {
                    toast::toast("Could not change it", why, ToastTone::Error);
                } else {
                    // the ones that did change can still go back
                    let kept = undo.without(&failed);
                    if kept.is_empty() {
                        toast::toast(format!("Could not change {f} of {n}"), why, ToastTone::Error);
                    } else {
                        undo_toast(format!("Could not change {f} of {n}"), why, ToastTone::Error, kept);
                    }
                }
            });
            // a bulk action is done with its selection
            if many {
                SELECTION.write().clear();
            }
        }
    }
}

// ---------- the menus ----------

fn snooze_items(keys: &[Key], clock: Clock) -> Vec<Item> {
    [(SnoozeFor::Hour, "1 hour"), (SnoozeFor::ThreeHours, "3 hours"), (SnoozeFor::Tomorrow, "Tomorrow morning"), (SnoozeFor::NextWeek, "Next week")]
        .into_iter()
        .map(|(p, label)| Item::new(label, Icon::Clock3, Action::Org(OrgOp::Snooze(keys.to_vec(), Some(p)))).hint(wakes_at_here(wake(p, clock), clock)))
        .collect()
}

/// The tags to offer: this session's own first, then the rest in use, most used first.
fn tag_items(keys: &[Key], org: &Organize, mine: &[String], toggle: bool) -> Vec<Item> {
    let mut all: Vec<String> = mine.to_vec();
    for t in tags_in_use(org) {
        if !all.contains(&t) {
            all.push(t);
        }
    }
    let mut v: Vec<Item> = all
        .into_iter()
        .take(12)
        .map(|t| {
            let on = mine.contains(&t);
            let item = Item::new(format!("#{t}"), Icon::Tag, Action::Org(OrgOp::Tag(keys.to_vec(), t.clone(), !(toggle && on))));
            if toggle {
                item.toggled(on)
            } else {
                item
            }
        })
        .collect();
    let new = Item::new("New tag…", Icon::Plus, Action::Org(OrgOp::Sheet(OrgSheet::Tags(keys.to_vec()))));
    v.push(if v.is_empty() { new } else { new.separated() });
    v
}

/// What can be done to one agent session from its row, its card or its ⋯ button, in Ghostex's
/// order: open it, organise it, copy from it, then the rest.
pub fn session_items(r: &PaneRef, org: &Org, clock: Clock, tabs: bool) -> Vec<Item> {
    let (host, pane) = (r.host.config.id.as_str(), r.pane.id.as_str());
    let k = key_of(r);
    let chat = Route::Session { host: host.into(), pane: pane.into(), view: None };
    let mut v = vec![
        Item::new("Open", Icon::ArrowRight, Action::Go(chat.clone())),
        Item::new(
            "Open terminal",
            Icon::SquareTerminal,
            Action::Go(Route::Session { host: host.into(), pane: pane.into(), view: Some(inyon_chat_core::overview::PaneView::Terminal) }),
        ),
    ];
    if tabs {
        v.push(Item::new("Open in new tab", Icon::ExternalLink, Action::NewTab(chat.href())));
    }
    v.push(Item::new("Rename…", Icon::Pencil, Action::Org(OrgOp::Sheet(OrgSheet::Rename(k.clone())))).separated());
    let a = r.agent();
    let mut copy = vec![];
    if let Some(id) = a.session_id.as_deref() {
        copy.push(Item::copy("Conversation ID", id));
    }
    if !r.pane.cwd.is_empty() {
        copy.push(Item::copy("Folder path", &r.pane.cwd));
    }
    copy.push(Item::copy("tmux target", &model::tmux_target(r)));
    if org.loaded {
        let m = mark_for(&org.org, host, pane);
        let pinned = m.is_some_and(|m| m.pinned.is_some());
        let parked = m.is_some_and(|m| m.parked == Some(true));
        let asleep = m.is_some_and(|m| snoozed(m, clock.now as u64));
        let mine = m.and_then(|m| m.tags.clone()).unwrap_or_default();
        let keys = vec![k.clone()];
        v.push(if pinned {
            Item::new("Unpin", Icon::PinOff, Action::Org(OrgOp::Pin(keys.clone(), false)))
        } else {
            Item::new("Pin", Icon::Pin, Action::Org(OrgOp::Pin(keys.clone(), true)))
        });
        v.push(if asleep {
            Item::new("Unsnooze", Icon::AlarmClockOff, Action::Org(OrgOp::Snooze(keys.clone(), None)))
        } else {
            Item::sub("Snooze", Icon::AlarmClock, snooze_items(&keys, clock))
        });
        v.push(if parked {
            Item::new("Unpark", Icon::ArchiveRestore, Action::Org(OrgOp::Park(keys.clone(), false)))
        } else {
            Item::new("Park", Icon::Archive, Action::Org(OrgOp::Park(keys.clone(), true)))
        });
        v.push(Item::sub("Tag as", Icon::Tag, tag_items(&keys, &org.org, &mine, true)));
        v.push(Item::sub("Copy", Icon::Copy, copy).separated());
        let noted = m.and_then(|m| m.note.as_deref()).is_some_and(|n| !n.is_empty());
        let closes = m.is_some_and(|m| m.close_when_done == Some(true));
        v.push(Item::sub(
            "More",
            Icon::Ellipsis,
            vec![
                Item::new(if noted { "Edit note…" } else { "Note…" }, Icon::StickyNote, Action::Org(OrgOp::Sheet(OrgSheet::Note(k.clone())))),
                Item::new("Close when done", Icon::CircleCheck, Action::Org(OrgOp::CloseWhenDone(k.clone(), !closes))).toggled(closes),
            ],
        ));
        v.push(Item::new("Select", Icon::ListChecks, Action::Org(OrgOp::Select(k))).separated());
    } else {
        v.push(Item::sub("Copy", Icon::Copy, copy).separated());
    }
    v.push(Item::new("End session…", Icon::CircleX, Action::EndSession { host: host.into(), pane: pane.into() }).danger().separated());
    v
}

/// What can be done to every selected session at once. A selection can span machines.
pub fn bulk_items(keys: &[Key], org: &Organize, clock: Clock) -> Vec<Item> {
    let c = common(keys, org, clock.now as u64);
    let k = keys.to_vec();
    vec![
        Item::header(format!("{} sessions selected", keys.len())),
        if c.pinned {
            Item::new("Unpin selected", Icon::PinOff, Action::Org(OrgOp::Pin(k.clone(), false)))
        } else {
            Item::new("Pin selected", Icon::Pin, Action::Org(OrgOp::Pin(k.clone(), true)))
        },
        if c.parked {
            Item::new("Unpark selected", Icon::ArchiveRestore, Action::Org(OrgOp::Park(k.clone(), false)))
        } else {
            Item::new("Park selected", Icon::Archive, Action::Org(OrgOp::Park(k.clone(), true)))
        },
        if c.snoozed {
            Item::new("Unsnooze selected", Icon::AlarmClockOff, Action::Org(OrgOp::Snooze(k.clone(), None)))
        } else {
            Item::sub("Snooze selected", Icon::AlarmClock, snooze_items(&k, clock))
        },
        Item::sub("Tag selected as", Icon::Tag, tag_items(&k, org, &[], false)),
        Item::new("Clear selection", Icon::X, Action::Org(OrgOp::ClearSelection)).separated(),
    ]
}

/// A section heading's menu: everything in it at once.
pub fn section_items(kind: Kind, keys: &[Key]) -> Vec<Item> {
    let k = keys.to_vec();
    let mut v = vec![Item::new("Select all here", Icon::ListChecks, Action::Org(OrgOp::SelectAll(k.clone())))];
    match kind {
        Kind::Pinned => v.push(Item::new("Unpin all", Icon::PinOff, Action::Org(OrgOp::Pin(k, false)))),
        Kind::Parked => v.push(Item::new("Unpark all", Icon::ArchiveRestore, Action::Org(OrgOp::Park(k, false)))),
        Kind::Snoozed => v.push(Item::new("Unsnooze all", Icon::AlarmClockOff, Action::Org(OrgOp::Snooze(k, None)))),
        Kind::Sessions => {}
    }
    v
}

/// The menu a row's right click or long press opens: the bulk menu on a selected row while several
/// are selected, else the row's own.
pub fn row_items(r: &PaneRef, org: &Org, sel: &Selection, clock: Clock, tabs: bool) -> Vec<Item> {
    if org.loaded && sel.len() > 1 && sel.has(&key_of(r)) {
        bulk_items(&sel.keys, &org.org, clock)
    } else {
        session_items(r, org, clock, tabs)
    }
}

/// What a click on a row does with the modifier keys held: Cmd/Ctrl picks it, Shift picks a range,
/// and on a touch screen a tap while picking adds or removes it. True when the click was taken.
pub fn pick_click(e: &MouseEvent, k: Key, order: &[Key]) -> bool {
    let m = e.modifiers();
    let picking = !SELECTION.peek().is_empty();
    if m.meta() || m.ctrl() {
        SELECTION.write().toggle(k);
    } else if m.shift() {
        SELECTION.write().extend(k, order);
    } else if picking && dom::coarse() {
        SELECTION.write().toggle(k);
    } else {
        if picking {
            SELECTION.write().clear();
        }
        return false;
    }
    e.prevent_default();
    e.stop_propagation();
    true
}

// ---------- the sheets ----------

static SHEET: GlobalSignal<Option<OrgSheet>> = Signal::global(|| None);
static SHEET_OPEN: GlobalSignal<bool> = Signal::global(|| false);

/// Forgets the last hub's marks and the sessions picked, for a new sign-in: the screens wait for
/// this hub's own organize stream.
pub fn reset() {
    *ORG.write() = Org::default();
    SELECTION.write().clear();
    *SHEET_OPEN.write() = false;
}

/// Opens a tag, note or rename sheet over whatever screen is showing. Other screens use it too
/// (the session header's Rename… is `Action::Org(OrgOp::Sheet(OrgSheet::Rename((host, pane))))`),
/// since `OrgSheets` is mounted once in the shell.
pub fn open_sheet(s: OrgSheet) {
    *SHEET.write() = Some(s);
    *SHEET_OPEN.write() = true;
}

/// The sheets the organize menus open, mounted once in the shell.
#[component]
pub fn OrgSheets() -> Element {
    let open = SHEET_OPEN();
    let close = move |_| *SHEET_OPEN.write() = false;
    match SHEET() {
        Some(OrgSheet::Tags(keys)) => rsx! { TagSheet { open, on_close: close, keys } },
        Some(OrgSheet::Note(k)) => rsx! { NoteSheet { open, on_close: close, k } },
        Some(OrgSheet::Rename(k)) => rsx! { RenameSheet { open, on_close: close, k } },
        None => rsx! {},
    }
}

/// A new tag for one session or several, with the tags already in use one tap away.
#[component]
fn TagSheet(open: bool, on_close: EventHandler<()>, keys: Vec<Key>) -> Element {
    let mut text = use_signal(String::new);
    let mut error = use_signal(|| None::<String>);
    let hub = use_context::<Signal<Hub>>();
    use_effect(use_reactive!(|open| {
        if open {
            text.set(String::new());
            error.set(None);
        }
    }));
    let org = ORG.read().org.clone();
    let mine: Vec<String> = if keys.len() == 1 { mark_for(&org, &keys[0].0, &keys[0].1).and_then(|m| m.tags.clone()).unwrap_or_default() } else { vec![] };
    let offered: Vec<String> = tags_in_use(&org).into_iter().filter(|t| !mine.contains(t)).take(10).collect();
    let title = if keys.len() == 1 { "New tag".to_string() } else { format!("Tag {} sessions", keys.len()) };
    let add = {
        let keys = keys.clone();
        move |raw: String| {
            let Some(tag) = normalize_tag(&raw) else {
                error.set(Some(format!("A tag is one line of at most {TAG_LEN} characters.")));
                return;
            };
            // the sheet stays open, with what was typed, when the tag can't go on anywhere
            if no_room(&keys, &ORG.peek().org, &tag) {
                error.set(Some(format!("{} {MAX_TAGS} tags already.", if keys.len() == 1 { "This session has" } else { "These sessions have" })));
                return;
            }
            on_close.call(());
            run(OrgOp::Tag(keys.clone(), tag, true), hub);
        }
    };
    let mut add_form = add.clone();
    let mut add_button = add.clone();
    rsx! {
        Sheet {
            open,
            on_close: move |_| on_close.call(()),
            title,
            footer: rsx! {
                div { class: "sheet-actions",
                    button { class: "button button-md button-ghost press", r#type: "button", onclick: move |_| on_close.call(()), "Cancel" }
                    button { class: "button button-md button-primary press", r#type: "button", disabled: text().trim().trim_start_matches('#').is_empty(), onclick: move |_| add_button(text()), "Add tag" }
                }
            },
            form {
                class: "stack",
                onsubmit: move |e| {
                    e.prevent_default();
                    if !text().trim().is_empty() {
                        add_form(text());
                    }
                },
                Field { label: "Tag", hint: error().unwrap_or_else(|| "Tags are kept on the hub, so every device filters by the same ones.".into()),
                    input {
                        class: "field",
                        value: "{text}",
                        placeholder: "review",
                        maxlength: "{TAG_LEN + 1}",
                        autocapitalize: "off",
                        "data-autofocus": "true",
                        oninput: move |e| {
                            text.set(e.value());
                            error.set(None);
                        },
                    }
                }
                if !mine.is_empty() {
                    div { class: "tag-row", "aria-label": "Its tags",
                        for t in mine.iter().cloned() {
                            {
                                let keys = keys.clone();
                                rsx! {
                                    button {
                                        key: "{t}",
                                        class: "chip tag-chip press",
                                        r#type: "button",
                                        title: "Take #{t} off",
                                        onclick: move |_| run(OrgOp::Tag(keys.clone(), t.clone(), false), hub),
                                        "#{t}"
                                        Glyph { icon: Icon::X, size: 12 }
                                    }
                                }
                            }
                        }
                    }
                }
                if !offered.is_empty() {
                    div { class: "tag-row", "aria-label": "Tags in use",
                        for t in offered {
                            {
                                let mut add = add.clone();
                                rsx! {
                                    button { key: "{t}", class: "chip tag-chip tag-offer press", r#type: "button", onclick: move |_| add(t.clone()), "#{t}" }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

/// A note kept with a session.
#[component]
fn NoteSheet(open: bool, on_close: EventHandler<()>, k: Key) -> Element {
    let mut text = use_signal(String::new);
    let mut busy = use_signal(|| false);
    let had = mark_for(&ORG.peek().org, &k.0, &k.1).and_then(|m| m.note.clone()).unwrap_or_default();
    {
        let had = had.clone();
        use_effect(use_reactive!(|open| {
            if open {
                text.set(had.clone());
            }
        }));
    }
    let save = {
        let k = k.clone();
        move |note: Option<String>| {
            let k = k.clone();
            busy.set(true);
            spawn(async move {
                // its turn with the other changes, so its answer can't put back older tags
                let _turn = SENDING.lock().await;
                match api::organize_pane(&k.0, &k.1, &json!({ "note": note })).await {
                    Ok(mark) => {
                        crate::organize::take_mark(&mut ORG.write().org, &k, mark);
                        on_close.call(());
                    }
                    Err(e) => toast::toast("Could not save the note", Some(e.message), ToastTone::Error),
                }
                busy.set(false);
            });
        }
    };
    let mut save_button = save.clone();
    let mut remove = save;
    let len = text().encode_utf16().count();
    let over = len > NOTE_LEN;
    rsx! {
        Sheet {
            open,
            on_close: move |_| on_close.call(()),
            title: if had.is_empty() { "Note" } else { "Edit note" },
            footer: rsx! {
                div { class: "sheet-actions",
                    if !had.is_empty() {
                        button { class: "button button-md button-ghost press sheet-action-start", r#type: "button", disabled: busy(), onclick: move |_| remove(None), "Remove note" }
                    }
                    // a save on its way closes this sheet when it lands, so it can't be left for another
                    button { class: "button button-md button-ghost press", r#type: "button", disabled: busy(), onclick: move |_| on_close.call(()), "Cancel" }
                    button {
                        class: "button button-md button-primary press",
                        r#type: "button",
                        disabled: busy() || over || (had.is_empty() && text().trim().is_empty()),
                        onclick: move |_| save_button(Some(text()).filter(|t| !t.trim().is_empty())),
                        Busy { on: busy() }
                        "Save"
                    }
                }
            },
            Field { label: "Note", hint: if over { format!("{len} of {NOTE_LEN} characters: too long") } else { format!("{len} of {NOTE_LEN}") },
                textarea {
                    class: "field field-area",
                    rows: "5",
                    value: "{text}",
                    placeholder: "What to remember about this session",
                    "data-autofocus": "true",
                    oninput: move |e| text.set(e.value()),
                }
            }
        }
    }
}

/// The name a session shows in Inyon, in place of the agent's own title.
#[component]
fn RenameSheet(open: bool, on_close: EventHandler<()>, k: Key) -> Element {
    let mut text = use_signal(String::new);
    let mut busy = use_signal(|| false);
    let hub = use_context::<Signal<Hub>>();
    let (shown, labelled) = {
        let h = hub.peek();
        let org = ORG.peek();
        model::all_panes(&h.hosts)
            .into_iter()
            .find(|r| r.host.config.id == k.0 && r.pane.id == k.1)
            .map_or((String::new(), false), |r| (shown_title(&r, &org.org), r.pane.label.as_deref().is_some_and(|l| !l.is_empty())))
    };
    {
        let shown = shown.clone();
        use_effect(use_reactive!(|open| {
            if open {
                text.set(shown.clone());
            }
        }));
    }
    let save = {
        let k = k.clone();
        move |name: String| {
            let k = k.clone();
            busy.set(true);
            spawn(async move {
                match api::rename(&k.0, &k.1, name.trim()).await {
                    Ok(()) => on_close.call(()),
                    Err(e) => toast::toast("Could not rename it", Some(e.message), ToastTone::Error),
                }
                busy.set(false);
            });
        }
    };
    let mut save_form = save.clone();
    let mut save_button = save.clone();
    let mut reset = save;
    let ready = !text().trim().is_empty() && text().encode_utf16().count() <= TITLE_LEN;
    rsx! {
        Sheet {
            open,
            on_close: move |_| on_close.call(()),
            title: "Rename",
            footer: rsx! {
                div { class: "sheet-actions",
                    if labelled {
                        button { class: "button button-md button-ghost press sheet-action-start", r#type: "button", disabled: busy(), onclick: move |_| reset(String::new()), "Use the agent's title" }
                    }
                    button { class: "button button-md button-ghost press", r#type: "button", onclick: move |_| on_close.call(()), "Cancel" }
                    button { class: "button button-md button-primary press", r#type: "button", disabled: busy() || !ready, onclick: move |_| save_button(text()),
                        Busy { on: busy() }
                        "Save"
                    }
                }
            },
            form {
                class: "stack",
                onsubmit: move |e| {
                    e.prevent_default();
                    if ready && !busy() {
                        save_form(text());
                    }
                },
                Field { label: "Name",
                    input { class: "field", value: "{text}", maxlength: "{TITLE_LEN}", "data-autofocus": "true", oninput: move |e| text.set(e.value()) }
                }
            }
        }
    }
}

// ---------- acting on a selection ----------

/// While sessions are selected: how many, the actions every one of them can take, and a way out.
/// It sits over the bottom of the screen, above the tab bar on a phone.
#[component]
pub fn SelectionBar() -> Element {
    let sel = SELECTION.read().clone();
    let hub = use_context::<Signal<Hub>>();
    let mut menu = use_context::<Signal<Option<Menu>>>();
    // sessions that ended or went away drop out of the selection
    {
        let listed: Vec<Key> = model::agent_panes(&hub.read().hosts).iter().map(key_of).collect();
        if !sel.is_empty() && sel.keys.iter().any(|k| !listed.contains(k)) {
            spawn(async move {
                SELECTION.write().keep_only(&listed);
            });
        }
    }
    let org = ORG.read().clone();
    if sel.is_empty() || !org.loaded {
        return rsx! {};
    }
    let clock = platform::clock();
    let c = common(&sel.keys, &org.org, clock.now as u64);
    let keys = sel.keys.clone();
    let n = keys.len();
    let (k1, k2, k3, k4, k5) = (keys.clone(), keys.clone(), keys.clone(), keys.clone(), keys.clone());
    let org2 = org.org.clone();
    rsx! {
        div { class: "select-bar", role: "toolbar", "aria-label": "Selected sessions",
            span { class: "select-count mono tabular", if n == 1 { "1 selected" } else { "{n} selected" } }
            button { class: "select-action press", r#type: "button", "aria-label": if c.pinned { "Unpin" } else { "Pin" }, title: if c.pinned { "Unpin" } else { "Pin" }, onclick: move |_| run(OrgOp::Pin(k1.clone(), !c.pinned), hub),
                Glyph { icon: if c.pinned { Icon::PinOff } else { Icon::Pin }, size: 16 }
                span { if c.pinned { "Unpin" } else { "Pin" } }
            }
            button { class: "select-action press", r#type: "button", "aria-label": if c.parked { "Unpark" } else { "Park" }, title: if c.parked { "Unpark" } else { "Park" }, onclick: move |_| run(OrgOp::Park(k2.clone(), !c.parked), hub),
                Glyph { icon: if c.parked { Icon::ArchiveRestore } else { Icon::Archive }, size: 16 }
                span { if c.parked { "Unpark" } else { "Park" } }
            }
            button {
                id: "select-snooze",
                class: "select-action press",
                r#type: "button",
                "aria-label": if c.snoozed { "Unsnooze" } else { "Snooze" },
                title: if c.snoozed { "Unsnooze" } else { "Snooze" },
                onclick: move |_| {
                    if c.snoozed {
                        run(OrgOp::Snooze(k3.clone(), None), hub);
                    } else {
                        menu::drop_down(&mut menu, "select-snooze", snooze_items(&k3, platform::clock()));
                    }
                },
                Glyph { icon: if c.snoozed { Icon::AlarmClockOff } else { Icon::AlarmClock }, size: 16 }
                span { if c.snoozed { "Unsnooze" } else { "Snooze" } }
            }
            button { id: "select-tag", class: "select-action press", r#type: "button", "aria-label": "Tag", title: "Tag", onclick: move |_| menu::drop_down(&mut menu, "select-tag", tag_items(&k4, &org2, &[], false)),
                Glyph { icon: Icon::Tag, size: 16 }
                span { "Tag" }
            }
            button {
                id: "select-more",
                class: "icon-button press",
                r#type: "button",
                "aria-label": "More for the selected sessions",
                title: "More",
                onclick: move |_| menu::drop_down(&mut menu, "select-more", bulk_items(&k5, &ORG.peek().org, platform::clock())),
                Glyph { icon: Icon::Ellipsis, size: 16 }
            }
            button { class: "icon-button press select-done", r#type: "button", "aria-label": "Clear selection", title: "Clear selection (Esc)", onclick: move |_| SELECTION.write().clear(),
                Glyph { icon: Icon::X, size: 16 }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Tuesday 3 Nov 2026, 12:00 UTC
    const NOW: u64 = 1_793_707_200_000;
    const CLOCK: Clock = Clock { now: NOW as f64, tz_minutes: 0 };

    fn mark(v: Value) -> SessionMark {
        let mut base = json!({ "id": "s-1", "host": "box", "pane": "%1", "live": true });
        for (k, x) in v.as_object().unwrap() {
            base[k] = x.clone();
        }
        serde_json::from_value(base).unwrap()
    }

    fn k(p: &str) -> Key {
        ("box".into(), p.into())
    }

    #[test]
    fn each_change_comes_with_the_change_that_undoes_it() {
        let pinned = mark(json!({ "pinned": 0, "tags": ["ui"] }));
        let p = |op: OrgOp, m: Option<&SessionMark>| patch_for(&op, m, NOW, &|f| snooze_until(f, NOW, 0));
        assert_eq!(p(OrgOp::Pin(vec![k("%1")], true), None), Some((json!({ "pinned": true }), json!({ "pinned": false }))));
        assert_eq!(p(OrgOp::Pin(vec![k("%1")], true), Some(&pinned)), None, "already pinned");
        assert_eq!(p(OrgOp::Park(vec![k("%1")], true), Some(&pinned)), Some((json!({ "parked": true }), json!({ "parked": false }))));
        assert_eq!(p(OrgOp::Tag(vec![k("%1")], "review".into(), true), Some(&pinned)), Some((json!({ "tags": ["ui", "review"] }), json!({ "tags": ["ui"] }))));
        assert_eq!(p(OrgOp::Tag(vec![k("%1")], "ui".into(), false), Some(&pinned)), Some((json!({ "tags": [] }), json!({ "tags": ["ui"] }))));
        assert_eq!(p(OrgOp::Tag(vec![k("%1")], "ui".into(), true), Some(&pinned)), None);
        let full = mark(json!({ "tags": ["a", "b", "c", "d", "e", "f", "g", "h"] }));
        assert_eq!(p(OrgOp::Tag(vec![k("%1")], "i".into(), true), Some(&full)), None, "eight tags at most");
        // a snooze: the time by this device's clock; undo puts back an earlier snooze still running
        let (change, back) = p(OrgOp::Snooze(vec![k("%1")], Some(SnoozeFor::Hour)), None).unwrap();
        assert_eq!((change, back), (json!({ "snoozedUntil": NOW + 3_600_000 }), json!({ "snoozedUntil": null })));
        let asleep = mark(json!({ "snoozedUntil": NOW + 60_000 }));
        assert_eq!(p(OrgOp::Snooze(vec![k("%1")], None), Some(&asleep)), Some((json!({ "snoozedUntil": null }), json!({ "snoozedUntil": NOW + 60_000 }))));
        assert_eq!(patch_for(&OrgOp::Snooze(vec![k("%1")], None), Some(&asleep), NOW + 60_000, &|_| 0), None, "its time is up already");
        assert_eq!(p(OrgOp::CloseWhenDone(k("%1"), true), None), Some((json!({ "closeWhenDone": true }), json!({ "closeWhenDone": false }))));
    }

    #[test]
    fn the_hubs_answer_is_planned_from_before_the_stream_brings_it() {
        let wake = |_: SnoozeFor| 0;
        let mut org = Organize { sessions: vec![mark(json!({ "tags": ["ui"] }))], ..Default::default() };
        let first = plan(&OrgOp::Tag(vec![k("%1")], "review".into(), true), &org, NOW, &wake);
        // the hub answers with the mark as it keeps it now; the stream hasn't caught up
        crate::organize::take_mark(&mut org, &k("%1"), Some(mark(json!({ "tags": ["ui", "review"] }))));
        let second = plan(&OrgOp::Tag(vec![k("%1")], "later".into(), true), &org, NOW, &wake);
        assert_eq!(second.changes, vec![(k("%1"), json!({ "tags": ["ui", "review", "later"] }))], "the first tag isn't lost");
        // and the first one's Undo finds its tag to take off
        assert_eq!(first.undo.changes(&org), vec![(k("%1"), json!({ "tags": ["ui"] }))]);
        // nothing kept any more: the mark goes
        crate::organize::take_mark(&mut org, &k("%1"), None);
        assert!(org.sessions.is_empty());
        crate::organize::take_mark(&mut org, &k("%1"), Some(mark(json!({ "id": "s-2" }))));
        assert_eq!(org.sessions.len(), 1, "a new mark is added");
    }

    #[test]
    fn undo_names_the_sessions_with_no_room_for_their_tag() {
        let full = mark(json!({ "tags": ["a", "b", "c", "d", "e", "f", "g", "h"] }));
        let room = mark(json!({ "id": "s-2", "pane": "%2", "tags": ["a"] }));
        let org = Organize { sessions: vec![full, room], ..Default::default() };
        let undo = Undo { tag: Some((vec![k("%1"), k("%2")], "x".into(), true)), ..Default::default() };
        assert_eq!(undo.full(&org), vec![k("%1")]);
        assert_eq!(undo.changes(&org), vec![(k("%2"), json!({ "tags": ["a", "x"] }))]);
        let off = Undo { tag: Some((vec![k("%1")], "x".into(), false)), ..Default::default() };
        assert!(off.full(&org).is_empty(), "taking a tag off always fits");
    }

    #[test]
    fn a_new_sign_in_forgets_the_last_hubs_marks_and_selection() {
        use std::sync::atomic::{AtomicBool, Ordering};
        static CLEARED: AtomicBool = AtomicBool::new(false);
        fn app() -> Element {
            *ORG.write() = Org { org: Organize::default(), loaded: true };
            SELECTION.write().toggle(k("%1"));
            reset();
            CLEARED.store(*ORG.peek() == Org::default() && SELECTION.peek().is_empty(), Ordering::SeqCst);
            rsx! {}
        }
        VirtualDom::new(app).rebuild_in_place();
        assert!(CLEARED.load(Ordering::SeqCst));
    }

    #[test]
    fn a_plan_undoes_only_its_own_change() {
        let org: Organize = serde_json::from_value(json!({ "v": 2, "sessions": [
            { "id": "s-a", "host": "box", "pane": "%1", "live": true, "pinned": 0, "tags": ["ui"] },
            { "id": "s-b", "host": "box", "pane": "%2", "live": true, "pinned": 1, "tags": ["a", "b", "c", "d", "e", "f", "g", "review"] },
            { "id": "s-c", "host": "box", "pane": "%3", "live": true, "tags": ["a", "b", "c", "d", "e", "f", "g", "h"] },
        ] }))
        .unwrap();
        let wake = |p| snooze_until(p, NOW, 0);
        // a tag's Undo takes that tag off again rather than sending the old list back
        let p = plan(&OrgOp::Tag(vec![k("%1"), k("%4")], "review".into(), true), &org, NOW, &wake);
        assert_eq!(p.changes, vec![(k("%1"), json!({ "tags": ["ui", "review"] })), (k("%4"), json!({ "tags": ["review"] }))]);
        assert_eq!(p.undo.tag, Some((vec![k("%1"), k("%4")], "review".into(), false)), "every session that changed");
        assert!(p.undo.fields.is_empty());
        assert!(!p.over_limit);
        // another device has added a tag since: Undo keeps it
        let later: Organize =
            serde_json::from_value(json!({ "v": 2, "sessions": [{ "id": "s-a", "host": "box", "pane": "%1", "live": true, "tags": ["ui", "review", "mine"] }] })).unwrap();
        assert_eq!(p.undo.changes(&later), vec![(k("%1"), json!({ "tags": ["ui", "mine"] }))]);
        // a full session that has the tag already isn't over the limit; one without it is
        assert!(!plan(&OrgOp::Tag(vec![k("%1"), k("%2")], "review".into(), true), &org, NOW, &wake).over_limit);
        assert!(plan(&OrgOp::Tag(vec![k("%1"), k("%3")], "review".into(), true), &org, NOW, &wake).over_limit);
        // the tag sheet stays open only when the tag can go on none of them
        assert!(no_room(&[k("%3")], &org, "review"));
        assert!(!no_room(&[k("%3"), k("%1")], &org, "review"));
        assert!(!no_room(&[k("%2")], &org, "review"), "it has that one already");
        // unpinning keeps the order, so Undo can put the pins back where they were
        let p = plan(&OrgOp::Pin(vec![k("%1"), k("%2")], false), &org, NOW, &wake);
        assert_eq!(p.undo.pins, ["s-a", "s-b"]);
        assert_eq!(p.undo.fields.len(), 2);
        assert!(plan(&OrgOp::Pin(vec![k("%3")], true), &org, NOW, &wake).undo.pins.is_empty());
        // after a partial failure, Undo covers only what did change
        let kept = p.undo.without(&[k("%2")]);
        assert_eq!(kept.fields, vec![(k("%1"), json!({ "pinned": true }))]);
        assert!(!kept.is_empty());
        assert!(p.undo.without(&[k("%1"), k("%2")]).is_empty());
    }

    #[test]
    fn a_morning_snooze_wakes_at_nine_across_a_clock_change() {
        // Saturday 28 Mar 2026, 12:00 UTC in Berlin (UTC+1); the clocks go to UTC+2 that night
        let now = 1_774_699_200_000;
        let berlin = |t: u64| if t >= 1_774_746_000_000 { 120 } else { 60 };
        let at = wake_at(SnoozeFor::Tomorrow, now, 60, berlin);
        // 9:00 on Sunday in summer time is 7:00 UTC
        assert_eq!(at, 1_774_767_600_000);
        assert_eq!(wakes_at(at, Clock { now: now as f64, tz_minutes: 60 }, berlin(at)), "Sun 9:00");
        // at 23:30 that night it's still Saturday here, though the wake's offset is a day on
        let late = 1_774_737_000_000;
        assert_eq!(wakes_at(at, Clock { now: late as f64, tz_minutes: berlin(late) }, berlin(at)), "Sun 9:00");
        // without a change it's plain 9:00, and an hour's snooze is an hour
        assert_eq!(wake_at(SnoozeFor::Tomorrow, now, 60, |_| 60), 1_774_771_200_000);
        assert_eq!(wake_at(SnoozeFor::Hour, now, 60, berlin), now + 3_600_000);
    }

    #[test]
    fn toasts_name_what_changed() {
        let one = vec![k("%1")];
        assert_eq!(told(&OrgOp::Park(one.clone(), true), 1, "Fix login", CLOCK).as_deref(), Some("Parked “Fix login”"));
        assert_eq!(told(&OrgOp::Park(one.clone(), true), 3, "", CLOCK).as_deref(), Some("Parked 3 sessions"));
        assert_eq!(told(&OrgOp::Pin(one.clone(), true), 1, "x", CLOCK), None, "a pin shows for itself");
        assert_eq!(told(&OrgOp::Pin(one.clone(), false), 2, "", CLOCK).as_deref(), Some("Unpinned 2 sessions"));
        assert_eq!(told(&OrgOp::Snooze(one.clone(), Some(SnoozeFor::Hour)), 1, "x", CLOCK).as_deref(), Some("Snoozed until 13:00"));
        assert_eq!(told(&OrgOp::Snooze(one.clone(), Some(SnoozeFor::Tomorrow)), 2, "x", CLOCK).as_deref(), Some("Snoozed 2 sessions until Wed 9:00"));
        assert_eq!(told(&OrgOp::Tag(one, "review".into(), true), 4, "", CLOCK).as_deref(), Some("Tagged #review on 4 sessions"));
    }

    fn labels(v: &[Item]) -> Vec<&str> {
        v.iter().map(|i| i.label.as_str()).collect()
    }

    fn hosts() -> Vec<inyon_protocol::HostState> {
        let pane = |id: &str| {
            json!({ "id": id, "index": 0, "active": true, "command": "claude", "cwd": "/w/app", "title": "✳ Fix login", "width": 80, "height": 40, "dead": false,
                "agent": { "kind": "claude", "pid": 1, "state": "idle", "sessionId": "abc-1" } })
        };
        vec![serde_json::from_value(json!({ "config": { "id": "box", "name": "box", "kind": "local" }, "status": "online", "integration": "installed", "tmux": "ok",
            "agents": ["claude"], "updatedAt": 0,
            "sessions": [{ "id": "$1", "name": "app", "attached": 0, "windows": [{ "id": "@1", "index": 1, "name": "", "active": true, "activity": 1, "panes": [pane("%1"), pane("%2")] }] }] }))
        .unwrap()]
    }

    #[test]
    fn a_sessions_menu_organises_it_and_flips_with_its_state() {
        let h = hosts();
        let panes = model::all_panes(&h);
        let org = Org { org: serde_json::from_value(json!({ "v": 2, "sessions": [{ "id": "s-1", "host": "box", "pane": "%2", "live": true, "pinned": 0, "parked": true, "tags": ["ui"], "note": "x", "closeWhenDone": true }] })).unwrap(), loaded: true };
        let m = session_items(&panes[0], &org, CLOCK, true);
        assert_eq!(labels(&m), ["Open", "Open terminal", "Open in new tab", "Rename…", "Pin", "Snooze", "Park", "Tag as", "Copy", "More", "Select", "End session…"]);
        assert_eq!(m[11].action, Action::EndSession { host: "box".into(), pane: "%1".into() });
        let snooze = m[5].sub.as_ref().unwrap();
        assert_eq!(labels(snooze), ["1 hour", "3 hours", "Tomorrow morning", "Next week"]);
        assert_eq!(snooze[2].hint.as_deref(), Some("Wed 9:00"));
        let tags = m[7].sub.as_ref().unwrap();
        assert_eq!(labels(tags), ["#ui", "New tag…"]);
        assert_eq!(tags[0].checked, Some(false));
        assert_eq!(labels(m[8].sub.as_ref().unwrap()), ["Conversation ID", "Folder path", "tmux target"]);
        assert_eq!(labels(m[9].sub.as_ref().unwrap()), ["Note…", "Close when done"]);
        // the other one is pinned, parked, tagged, noted and closing
        let m = session_items(&panes[1], &org, CLOCK, false);
        assert_eq!(labels(&m), ["Open", "Open terminal", "Rename…", "Unpin", "Snooze", "Unpark", "Tag as", "Copy", "More", "Select", "End session…"]);
        assert_eq!(m[6].sub.as_ref().unwrap()[0].checked, Some(true));
        assert_eq!(m[6].sub.as_ref().unwrap()[0].action, Action::Org(OrgOp::Tag(vec![k("%2")], "ui".into(), false)), "a tick takes it off");
        let more = m[8].sub.as_ref().unwrap();
        assert_eq!((more[0].label.as_str(), more[1].checked), ("Edit note…", Some(true)));
        // a hub that keeps none of this: no items for it
        assert_eq!(labels(&session_items(&panes[0], &Org::default(), CLOCK, false)), ["Open", "Open terminal", "Rename…", "Copy", "End session…"]);
    }

    #[test]
    fn the_bulk_menu_acts_on_every_selected_session() {
        let org: Organize = serde_json::from_value(json!({ "v": 2, "sessions": [
            { "id": "s-1", "host": "box", "pane": "%1", "live": true, "pinned": 0, "tags": ["ui"] },
            { "id": "s-2", "host": "box", "pane": "%2", "live": true, "pinned": 1 }] }))
        .unwrap();
        let both = vec![k("%1"), k("%2")];
        let m = bulk_items(&both, &org, CLOCK);
        assert_eq!(labels(&m), ["2 sessions selected", "Unpin selected", "Park selected", "Snooze selected", "Tag selected as", "Clear selection"]);
        assert!(m[0].header);
        assert_eq!(m[2].action, Action::Org(OrgOp::Park(both.clone(), true)));
        // tags in use are offered to add, none ticked
        let tags = m[4].sub.as_ref().unwrap();
        assert_eq!((tags[0].label.as_str(), tags[0].checked), ("#ui", None));
        assert_eq!(tags[0].action, Action::Org(OrgOp::Tag(both.clone(), "ui".into(), true)));
        // a right click on a selected row gives this menu; on another row, that row's own
        let h = hosts();
        let panes = model::all_panes(&h);
        let o = Org { org, loaded: true };
        let sel = Selection { keys: both, anchor: None };
        assert!(row_items(&panes[0], &o, &sel, CLOCK, false)[0].header);
        let one = Selection { keys: vec![k("%1")], anchor: None };
        assert_eq!(row_items(&panes[0], &o, &one, CLOCK, false)[0].label, "Open");
        assert_eq!(labels(&section_items(Kind::Parked, &[k("%1")])), ["Select all here", "Unpark all"]);
    }
}
