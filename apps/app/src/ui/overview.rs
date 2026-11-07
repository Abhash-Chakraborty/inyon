//! The Overview (apps/web/src/pages/Home.tsx and components/Overview.tsx): every agent session as a
//! card, grouped by machine when there is more than one, the machines, the plan limits and recent
//! activity. Past six sessions a search box narrows the cards; Show brings the next one that needs
//! you into view; Refresh (with a mouse) and pull to refresh (on a touch screen) have every machine
//! read again.

use std::cell::Cell;
use std::collections::{BTreeMap, BTreeSet};

use dioxus::prelude::*;
use inyon_chat_core::store::{ActivityEvent, Haptic};
use inyon_protocol::{AgentState, HostState, HostStatus, IntegrationState};

use super::icons::{AgentMark, Glyph, Icon, Logo, MachineGlyph};
use super::kit::{Busy, FilterInput};
use super::menu::{self, Menu};
use super::notices::{self, ACTIVITY};
use super::organize::{pick_click, row_items, wakes_at_here, ORG, SELECTION};
use super::toast::{self, ToastTone};
use crate::format::{self, Clock};
use crate::home;
use crate::model::{self, AgentPane, Filter, Shown};
use crate::organize::{key_of, note_line, Key};
use crate::route::Route;
use crate::socket::Outbox;
use crate::state::Hub;
use crate::{api, dom, platform};
use inyon_chat_core::organize::{mark_for, place_of, shown_title, sort_panes, Place};

/// Folded machine groups, in the web app's key (`inyon.folded`, entries `home:<machine>`), so a
/// group folded in one app is folded in the other.
const FOLDED: &str = "inyon.folded";
/// The parked and snoozed start folded: this is kept with the folded groups, set when it's open.
const ASIDE_OPEN: &str = "~set-aside-open";

/// The phone app, which says computer and has no phone card (it is the phone).
const PHONE: bool = cfg!(feature = "phone");

fn load_folded() -> BTreeSet<String> {
    platform::load(FOLDED).and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok()).unwrap_or_default().into_iter().collect()
}

thread_local! {
    /// Which waiting card Show brings up next; each press moves on.
    static SHOWN: Cell<usize> = const { Cell::new(0) };
}

/// Brings the next session that needs you into view, in the order they're shown.
fn show_next() -> bool {
    match dom::show_waiting(SHOWN.with(Cell::get)) {
        Some(i) => {
            SHOWN.with(|s| s.set(i + 1));
            true
        }
        None => false,
    }
}

/// Pull to refresh and Refresh (lib/refresh.ts): try the hub again if the link dropped, and have
/// every machine read again. Takes at least 600 ms, long enough to see it happen however fast the
/// hub answers.
async fn refresh_all(connected: bool, outbox: Outbox) {
    if !connected {
        outbox.wake();
    }
    let ask = async {
        if let Err(e) = api::refresh().await {
            toast::toast("Could not refresh", Some(e.message), ToastTone::Error);
        }
    };
    futures_util::future::join(ask, platform::sleep(600)).await;
}

/// A grid's id, for its animations.
fn grid_id(name: &str) -> String {
    format!("cards-{}", name.replace(|c: char| !c.is_ascii_alphanumeric() && c != '-', "_"))
}

#[component]
pub fn Overview() -> Element {
    let hub = use_context::<Signal<Hub>>();
    let mut folded = use_signal(load_folded);
    let mut filter = use_signal(|| Filter::All);
    let mut query = use_signal(String::new);
    let mut reloading = use_signal(|| false);
    let mut adding = use_signal(|| false);
    // a card being turned on stays, with its spinner, until the machine answers (with the state it
    // had when tapped, so its words don't change under the spinner)
    let mut turning = use_signal(BTreeMap::<String, IntegrationState>::new);
    let mut show_after_open = use_signal(|| false);
    let outbox = super::outbox();
    // pull to refresh: where the finger started, how far the mark came, whether letting go refreshes
    let mut pulling = use_signal(|| None::<f64>);
    let mut pull = use_signal(|| 0.0f64);
    let mut armed = use_signal(|| false);
    let mut refreshing = use_signal(|| false);
    let mut top = use_signal(|| 0.0f64);
    let end_pull = {
        let outbox = outbox.clone();
        use_callback(move |_: ()| {
            if pulling.peek().is_none() {
                return;
            }
            pulling.set(None);
            if !*armed.peek() {
                pull.set(0.0);
                return;
            }
            refreshing.set(true);
            pull.set(home::PULL_TRIGGER);
            let (up, outbox) = (hub.peek().connected, outbox.clone());
            spawn(async move {
                refresh_all(up, outbox).await;
                refreshing.set(false);
                pull.set(0.0);
            });
        })
    };
    // Show finds a session that needs you even in the folded parked and snoozed: it opens them
    // first, then brings the card into view once it's on screen
    use_effect(move || {
        if !show_after_open() || (!folded.read().contains(&format!("home:{ASIDE_OPEN}")) && query.read().is_empty()) {
            return;
        }
        show_after_open.set(false);
        spawn(async {
            platform::sleep(30).await;
            show_next();
        });
    });

    let h = hub.read();
    let clock = platform::clock();
    let org = ORG.read().clone();
    let now_ms = clock.now as u64;
    let panes = model::agent_panes(&h.hosts);
    let waiting = panes.iter().filter(|r| r.agent().state == AgentState::Waiting).count();
    // the switch goes with the sessions it would sort; with few of them it's back to all
    let filtering = panes.len() >= model::FILTER_FROM;
    let shown_filter = if filtering { filter() } else { Filter::All };
    let searching = home::searchable(panes.len());
    let q = if searching { query() } else { String::new() };
    let mut all_groups = model::group_panes(&h.hosts, shown_filter);
    // a search looks through every machine, tags and notes included
    for g in all_groups.iter_mut() {
        g.panes.retain(|r| home::matches(r, mark_for(&org.org, &r.host.config.id, &r.pane.id), &shown_title(r, &org.org), &q));
    }
    let grouped = h.hosts.len() > 1;
    // pinned sessions come first across machines, parked and snoozed ones wait folded at the end
    let sorted = sort_panes(all_groups.iter().flat_map(|g| g.panes.iter().copied()).collect(), &org.org, now_ms);
    let groups: Vec<model::HostGroup> = all_groups
        .into_iter()
        .map(|mut g| {
            g.panes.retain(|r| place_of(mark_for(&org.org, &r.host.config.id, &r.pane.id), now_ms) == Place::Sessions);
            g
        })
        .filter(|g| !g.panes.is_empty())
        .collect();
    let pinned: Vec<Key> = sorted.pinned.iter().map(key_of).collect();
    let set_aside: Vec<Key> = sorted.snoozed.iter().chain(sorted.parked.iter()).map(key_of).collect();
    let aside_waiting = sorted.snoozed.iter().chain(sorted.parked.iter()).any(|r| r.agent().state == AgentState::Waiting);
    // folded until opened, as in the web app: the set stores the opened one; a search opens it
    let aside_open = !q.is_empty() || folded.read().contains(&format!("home:{ASIDE_OPEN}"));
    let group_open = |id: &str| !q.is_empty() || !folded.read().contains(&format!("home:{id}"));
    // the order a Shift-click picks a range in: as the cards are laid out
    let order: Vec<Key> = pinned
        .iter()
        .cloned()
        .chain(groups.iter().filter(|g| !grouped || group_open(&g.host.config.id)).flat_map(|g| g.panes.iter().map(key_of)))
        .chain(if aside_open { set_aside.clone() } else { vec![] })
        .collect();
    let mut toggle = move |id: String| {
        let key = format!("home:{id}");
        let mut f = folded.write();
        if !f.remove(&key) {
            f.insert(key);
        }
        let list: Vec<&String> = f.iter().collect();
        platform::save(FOLDED, &serde_json::to_string(&list).unwrap_or_default());
    };
    let show = move |_| {
        if show_next() || aside_open || !aside_waiting {
            return;
        }
        show_after_open.set(true);
        toggle(ASIDE_OPEN.into());
    };
    let reload = {
        let outbox = outbox.clone();
        move |_| {
            reloading.set(true);
            let (up, outbox) = (hub.peek().connected, outbox.clone());
            spawn(async move {
                refresh_all(up, outbox).await;
                reloading.set(false);
            });
        }
    };
    let integration: Vec<(String, String, IntegrationState, bool)> = h
        .hosts
        .iter()
        .filter_map(|x| {
            let busy = turning.read().get(&x.config.id).copied();
            (busy.is_some() || home::needs_integration(x)).then(|| (x.config.id.clone(), x.config.name.clone(), busy.unwrap_or(x.integration), busy.is_some()))
        })
        .collect();
    let mut enable = move |id: String, state: IntegrationState| {
        turning.write().insert(id.clone(), state);
        spawn(async move {
            match api::integration(&id, true).await {
                Ok(()) => {
                    toast::toast(home::integration_toast(state, true), Some("Restart running Claude sessions to get live limits and exact matching.".into()), ToastTone::Success)
                }
                Err(e) => toast::toast(home::integration_toast(state, false), Some(e.message), ToastTone::Error),
            }
            turning.write().remove(&id);
        });
    };
    let nothing = groups.is_empty() && pinned.is_empty() && set_aside.is_empty();
    let (empty_title, empty_line) = home::empty_text(!panes.is_empty(), &q, PHONE);
    let dragging = pulling().is_some() && !refreshing();
    let pull_style = format!("opacity:{};transform:translate(-50%, {}px)", home::pull_opacity(pull()), pull() - 40.0);
    let pull_line = format!("--pull:{}", (pull() / home::PULL_TRIGGER).min(1.0));

    rsx! {
        div { class: "pull-wrap",
            div {
                class: if dragging { "pull-mark pull-dragging" } else { "pull-mark" },
                style: "{pull_style}",
                "aria-hidden": (!refreshing()).then_some("true"),
                role: refreshing().then_some("status"),
                "aria-label": refreshing().then_some("Refreshing"),
                span { class: if refreshing() { "pull-logo mark-reeling" } else { "pull-logo mark-pull" }, style: (!refreshing()).then_some(pull_line),
                    Logo { class: "logo-20" }
                }
            }
            div {
                class: "scroll",
                onscroll: move |e| top.set(e.scroll_top()),
                ontouchstart: move |e| {
                    let t = e.touches();
                    let start = (*top.peek() <= 0.0 && !*refreshing.peek() && t.len() == 1).then(|| t[0].client_coordinates().y);
                    pulling.set(start);
                    armed.set(false);
                },
                ontouchmove: move |e| {
                    let Some(start) = *pulling.peek() else { return };
                    let Some(t) = e.touches().into_iter().next() else { return };
                    let dy = t.client_coordinates().y - start;
                    if dy <= 0.0 || *top.peek() > 0.0 {
                        if *pull.peek() != 0.0 {
                            pull.set(0.0);
                        }
                        return;
                    }
                    let p = home::pull_distance(dy);
                    pull.set(p);
                    let now = p >= home::PULL_TRIGGER;
                    // one tick when letting go would refresh
                    if now && !*armed.peek() {
                        notices::haptic(Haptic::Select);
                    }
                    if now != *armed.peek() {
                        armed.set(now);
                    }
                },
                ontouchend: move |_| end_pull.call(()),
                ontouchcancel: move |_| end_pull.call(()),
                header { class: "topbar",
                    div { class: "topbar-row",
                        span { class: "phone-only", Logo { connecting: h.offline(), target: true } }
                        span { class: "topbar-counts mono wide-only", {model::counts_line(&h.hosts, panes.len())} }
                        if h.offline() {
                            span { class: "reconnecting",
                                Glyph { icon: Icon::WifiOff, size: 14 }
                                "Reconnecting"
                                button { class: "help-link", r#type: "button", onclick: move |_| super::connect::open_connect_help(None), "Can't connect?" }
                            }
                        }
                        // with a mouse there is no pull to refresh: the mark's line reels here instead
                        button {
                            class: if h.offline() { "topbar-refresh icon-button icon-button-lg press" } else { "topbar-refresh topbar-refresh-push icon-button icon-button-lg press" },
                            r#type: "button",
                            "aria-label": "Refresh",
                            title: "Refresh",
                            onclick: reload,
                            span { class: if reloading() { "refresh-logo mark-reeling" } else { "refresh-logo" }, Logo { class: "logo-18" } }
                        }
                        button {
                            class: "topbar-quick icon-button icon-button-lg press phone-only",
                            r#type: "button",
                            "aria-label": "Search",
                            onclick: move |_| super::quick::open_fresh(crate::quick::Tab::Sessions),
                            Glyph { icon: Icon::Search, size: 18 }
                        }
                    }
                }
                div { class: "content",
                    div { class: "content-main",
                        if !h.loaded {
                            div { class: "skeletons", "aria-label": "Loading",
                                for i in 0..4 {
                                    div { key: "{i}", class: "skeleton" }
                                }
                            }
                        } else if h.hosts.is_empty() {
                            div { class: "empty",
                                div { class: "empty-icon", Logo { class: "mark-drawn logo-28" } }
                                p { class: "empty-title", if PHONE { "Connect your computer" } else { "No machines yet" } }
                                p { class: "empty-text",
                                    if PHONE {
                                        "See the coding agents on your laptop or server and talk to them from here. Run one command on it, then scan the code it shows."
                                    } else {
                                        "Pair a machine or add one over SSH to see the coding agents running in tmux on it."
                                    }
                                }
                                button { class: "button button-primary button-md press empty-action", r#type: "button", onclick: move |_| adding.set(true),
                                    Glyph { icon: Icon::Plus, size: 14 }
                                    if PHONE { "Add a computer" } else { "Add a machine" }
                                }
                            }
                        } else {
                            div {
                                h1 { class: "title", "Overview" }
                                p { class: "lede",
                                    span { class: "truncate", {model::status_line(&panes)} }
                                    if waiting > 0 {
                                        button { class: "show-next", r#type: "button", onclick: show, "Show" }
                                    }
                                }
                            }
                            super::companion::CompanionBar {}
                            if !PHONE {
                                PhoneCard {}
                            }
                            for (id, name, state, busy) in integration {
                                div { key: "{id}", class: "line-card",
                                    Glyph { icon: Icon::Plug, size: 16, class: "fg-3" }
                                    p { class: "line-card-text",
                                        span { class: "line-card-lead", "{name}:" }
                                        " {home::integration_line(state)}"
                                    }
                                    button {
                                        class: "button button-sm button-primary press",
                                        r#type: "button",
                                        disabled: busy,
                                        onclick: { let id = id.clone(); move |_| enable(id.clone(), state) },
                                        Busy { on: busy }
                                        {home::integration_button(state, busy)}
                                    }
                                }
                            }
                            section {
                                div { class: "section-label",
                                    h2 { "Agent sessions" }
                                    if filtering {
                                        div { class: "segmented", role: "radiogroup", "aria-label": "Show",
                                            for f in Filter::ALL {
                                                button {
                                                    key: "{f.label()}",
                                                    class: if f == shown_filter { "segment segment-on" } else { "segment" },
                                                    r#type: "button",
                                                    role: "radio",
                                                    "aria-checked": "{f == shown_filter}",
                                                    onclick: move |_| filter.set(f),
                                                    "{f.label()}"
                                                }
                                            }
                                        }
                                    }
                                }
                                if searching {
                                    FilterInput { value: query(), on_change: move |v| query.set(v), placeholder: format!("Search {} sessions", panes.len()), class: "overview-search" }
                                }
                                if !pinned.is_empty() {
                                    div { class: "pinned",
                                        h3 { class: "subsection", Glyph { icon: Icon::Pin, size: 14 } "Pinned" }
                                        div { id: "cards-pinned", class: "cards", onmounted: move |_| dom::animate_grid("cards-pinned"),
                                            for k in pinned.iter().cloned() {
                                                Card { key: "{k.0}{k.1}", k, show_host: grouped, order: order.clone() }
                                            }
                                        }
                                    }
                                }
                                if nothing {
                                    div { class: "empty",
                                        p { class: "empty-title", "{empty_title}" }
                                        p { class: "empty-text", "{empty_line}" }
                                    }
                                } else if grouped {
                                    div { class: "groups",
                                        for g in groups.iter() {
                                            {
                                                let id = g.host.config.id.clone();
                                                let open = group_open(&id);
                                                let online = g.host.status == HostStatus::Online;
                                                let grid = grid_id(&format!("host-{id}"));
                                                let mount = grid.clone();
                                                rsx! {
                                                    div { key: "{id}",
                                                        button {
                                                            class: "group-head",
                                                            r#type: "button",
                                                            "aria-expanded": "{open}",
                                                            onclick: { let id = id.clone(); move |_| toggle(id.clone()) },
                                                            Glyph { icon: Icon::ChevronRight, size: 16, class: if open { "chevron chevron-open" } else { "chevron" } }
                                                            MachineGlyph { kind: model::machine_kind(g.host), size: 16, class: if online { "fg-2" } else { "fg-3" } }
                                                            span { class: if online { "group-name" } else { "group-name fg-2" }, "{g.host.config.name}" }
                                                            if !online {
                                                                span { class: "group-state", if g.host.status == HostStatus::Error { "Offline" } else { "Connecting" } }
                                                            }
                                                            span { class: "group-count mono tabular", "{g.panes.len()}" }
                                                        }
                                                        div { class: "expand", "data-open": "{open}",
                                                            div { "inert": (!open).then_some(""),
                                                                div { id: "{grid}", class: "cards cards-grouped", onmounted: move |_| dom::animate_grid(&mount),
                                                                    for k in g.panes.iter().map(key_of) {
                                                                        Card { key: "{k.0}{k.1}", k, show_host: false, order: order.clone() }
                                                                    }
                                                                }
                                                            }
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }
                                } else {
                                    div { id: "cards-all", class: "cards", onmounted: move |_| dom::animate_grid("cards-all"),
                                        for g in groups.iter() {
                                            for k in g.panes.iter().map(key_of) {
                                                Card { key: "{k.0}{k.1}", k, show_host: true, order: order.clone() }
                                            }
                                        }
                                    }
                                }
                                if !set_aside.is_empty() {
                                    div { class: "set-aside",
                                        button {
                                            class: "group-head",
                                            r#type: "button",
                                            "aria-expanded": "{aside_open}",
                                            onclick: move |_| toggle(ASIDE_OPEN.into()),
                                            Glyph { icon: Icon::ChevronRight, size: 16, class: if aside_open { "chevron chevron-open" } else { "chevron" } }
                                            Glyph { icon: Icon::Archive, size: 16, class: "fg-2" }
                                            span { class: "group-name", "Parked and snoozed" }
                                            span { class: "group-count mono tabular", "{set_aside.len()}" }
                                        }
                                        div { class: "expand", "data-open": "{aside_open}",
                                            div { "inert": (!aside_open).then_some(""),
                                                div { id: "cards-aside", class: "cards cards-grouped", onmounted: move |_| dom::animate_grid("cards-aside"),
                                                    for k in set_aside.iter().cloned() {
                                                        Card { key: "{k.0}{k.1}", k, show_host: grouped, order: order.clone() }
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                            section {
                                div { class: "section-label",
                                    h2 { if PHONE { "Computers" } else { "Machines" } }
                                    a { class: "section-link", href: Route::Machines { add: false }.href(), "Manage →" }
                                }
                                {machines(&h.hosts, clock)}
                            }
                        }
                    }
                    aside { class: "content-side",
                        {limits(&h.hosts, clock)}
                        ActivityFeed {}
                    }
                }
            }
            super::add::MachineSheet { open: adding(), on_close: move |_| adding.set(false), edit: None }
        }
    }
}

const PHONE_CARD_KEY: &str = "inyon.phoneCard.dismissed";

/// Until a phone is paired (or this is put off): the hub's one-line invitation to open it on a
/// phone. Later puts it away for good in this browser.
#[component]
fn PhoneCard() -> Element {
    let mut show = use_signal(|| false);
    let mut open = use_signal(|| false);
    use_hook(move || {
        if platform::load(PHONE_CARD_KEY).is_some() {
            return;
        }
        spawn(async move {
            if let Ok(phones) = api::phones().await {
                show.set(phones.is_empty());
            }
        });
    });
    let mut dismiss = move || {
        platform::save(PHONE_CARD_KEY, "1");
        show.set(false);
    };
    if !show() {
        return rsx! {};
    }
    rsx! {
        div { class: "line-card",
            Glyph { icon: Icon::Smartphone, size: 16, class: "fg-3" }
            p { class: "line-card-text",
                span { class: "line-card-lead", "Open this hub on your phone." }
                " The Inyon app scans a code and reaches every machine here itself."
            }
            button { class: "button button-sm button-ghost press", r#type: "button", onclick: move |_| dismiss(), "Later" }
            button { class: "button button-sm button-primary press", r#type: "button", onclick: move |_| open.set(true), "Show the code" }
        }
        super::phone::PhoneSheet {
            open: open(),
            on_close: move |_| {
                open.set(false);
                // paired while the code was up: the card has done its job
                spawn(async move {
                    if api::phones().await.is_ok_and(|p| !p.is_empty()) {
                        dismiss();
                    }
                });
            },
        }
    }
}

/// The latest events, newest first. While the pointer or focus is on it the list holds still, and
/// what arrived meanwhile waits behind a "new" button, so a click lands on the row it aimed at.
#[component]
fn ActivityFeed() -> Element {
    let hub = use_context::<Signal<Hub>>();
    let live = ACTIVITY.read().clone();
    let mut held = use_signal(|| None::<Vec<ActivityEvent>>);
    if live.is_empty() {
        return rsx! {};
    }
    let fresh = held.read().as_ref().map_or(0, |h| home::fresh(h, &live));
    let list = held.read().clone().unwrap_or_else(|| live.clone());
    let h = hub.read();
    let clock = platform::clock();
    let hold = {
        let live = live.clone();
        move || {
            if held.peek().is_none() {
                held.set(Some(live.clone()));
            }
        }
    };
    let (mut hold_pointer, mut hold_focus) = (hold.clone(), hold);
    let catch_up = live.clone();
    rsx! {
        section {
            id: "activity",
            class: "panel activity",
            onpointerenter: move |_| hold_pointer(),
            // let go once neither the pointer nor the focus is on it
            onpointerleave: move |_| {
                if !dom::focus_inside("activity") {
                    held.set(None);
                }
            },
            onfocusin: move |_| hold_focus(),
            onfocusout: move |_| {
                spawn(async move {
                    platform::sleep(0).await;
                    if !dom::holds("activity") {
                        held.set(None);
                    }
                });
            },
            h2 { class: "limits-title",
                "Recent activity"
                if fresh > 0 {
                    button { class: "activity-new mono fade-in", r#type: "button", onclick: move |_| held.set(Some(catch_up.clone())), "{fresh} new" }
                }
            }
            div { class: "activity-rows",
                for (i, e) in list.iter().enumerate().take(home::FEED_ROWS) {
                    a { key: "{e.id}-{i}", class: "activity-row", href: model::pane_href(&e.host, &e.pane),
                        if let Some(kind) = e.agent {
                            AgentMark { kind, size: 18, decorative: true }
                        } else {
                            span { class: "activity-tile", Glyph { icon: Icon::SquareTerminal, size: 12 } }
                        }
                        div { class: "activity-text",
                            div { class: "truncate activity-line",
                                span { class: "activity-title", "{e.title}" }
                                span { class: "fg-2", " · {home::activity_label(i, &list, &h.hosts)}" }
                            }
                            div { class: "activity-time mono", {format::time_ago(e.at as f64, clock)} }
                        }
                    }
                }
            }
        }
    }
}

/// An agent session as a card. The whole card opens the session; ⋯ (shown on hover with a mouse,
/// always on a touch screen), a right click and a long press offer what can be done without
/// opening it. One that asks something shows its answers in place and keeps its size, so nothing
/// around it moves. Cmd/Ctrl- or Shift-click picks it for a bulk action.
#[component]
fn Card(k: Key, show_host: bool, order: Vec<Key>) -> Element {
    let hub = use_context::<Signal<Hub>>();
    let mut menu_at = use_context::<Signal<Option<Menu>>>();
    // pressed, then sent, then the agent took it: two short pulses, once
    let mut answered = use_signal(|| false);
    let h = hub.read();
    let org = ORG.read().clone();
    let sel = SELECTION.read().clone();
    let clock = platform::clock();
    let panes = model::all_panes(&h.hosts);
    let r = panes.iter().find(|r| r.host.config.id == k.0 && r.pane.id == k.1 && r.pane.agent.is_some());
    let items = r.map(|r| row_items(r, &org, &sel, clock, cfg!(target_arch = "wasm32"))).unwrap_or_default();
    let press = menu::long_press(items.clone());
    let waiting = r.is_some_and(|r| r.agent().state == AgentState::Waiting);
    use_effect(use_reactive!(|waiting| {
        if !waiting && *answered.peek() {
            answered.set(false);
            notices::haptic(Haptic::Success);
        }
    }));
    let Some(r) = r else { return rsx! {} };
    // a question from the copy kept in the browser may be long answered, and a tap on it would
    // answer whatever asks now: answers wait for the hub's own overview
    let live = h.confirmed();
    let (p1, p2, p3, p4) = (press.clone(), press.clone(), press.clone(), press);
    let a = r.agent();
    let shown = Shown::of(a, r.host);
    let title = shown_title(r, &org.org);
    let href = model::pane_href(&r.host.config.id, &r.pane.id);
    let st = a.status.as_ref();
    let cost = st.and_then(|s| s.cost_usd).map(|c| format::money(*c));
    let ctx = st.and_then(|s| s.context_pct).map(|p| *p);
    let ctx_title = format!("{} of {} tokens", format::tokens(st.and_then(|s| s.context_used).map(|n| *n)), format::tokens(st.and_then(|s| s.context_size).map(|n| *n)));
    let options: Vec<(u32, String)> = a.options.iter().flatten().map(|o| (o.n, o.label.clone())).collect();
    let m = mark_for(&org.org, &k.0, &k.1);
    let pinned = m.is_some_and(|m| m.pinned.is_some());
    let until = m.and_then(|m| m.snoozed_until).filter(|t| *t > clock.now as u64);
    let tags = m.and_then(|m| m.tags.clone()).unwrap_or_default();
    let note = m.and_then(|m| m.note.as_deref()).map(note_line).filter(|n| !n.is_empty()).map(str::to_owned);
    let picked = sel.has(&k);
    let class = match (waiting, picked) {
        (true, true) => "card card-waiting card-picked",
        (true, false) => "card card-waiting",
        (false, true) => "card card-picked",
        (false, false) => "card",
    };
    let more_id = format!("card-more-{}-{}", k.0, k.1.trim_start_matches('%')).replace(|c: char| !c.is_ascii_alphanumeric() && c != '-', "_");
    let more_at = more_id.clone();
    let more_items = items.clone();
    let kc = k.clone();
    rsx! {
        div { class, "data-key": "{k.0} {k.1}", "data-waiting": waiting.then_some("true"), oncontextmenu: menu::open(items),
            a {
                class: "card-link",
                href: "{href}",
                // a screen reader hears which cards a bulk action will change
                "aria-label": if picked { format!("{title}, selected") } else { title.clone() },
                onpointerdown: move |e| p1.down(&e),
                onpointermove: move |e| p2.moved(&e),
                onpointerup: move |_| p3.up(),
                onclick: move |e| {
                    if !p4.click(&e) {
                        pick_click(&e, kc.clone(), &order);
                    }
                },
            }
            div { class: "card-top",
                AgentMark { kind: a.kind, size: 26 }
                if picked {
                    span { class: "card-check", Glyph { icon: Icon::Check, size: 14 } }
                }
                span { class: "card-agent", {model::agent_name(a)} }
                if pinned {
                    span { class: "card-mark", title: "Pinned", Glyph { icon: Icon::Pin, size: 14 } }
                }
                if let Some(t) = until {
                    span { class: "card-mark mono", title: "Snoozed", Glyph { icon: Icon::AlarmClock, size: 14 } {wakes_at_here(t, clock)} }
                }
                if let Some(n) = &note {
                    span { class: "card-mark", title: "{n}", Glyph { icon: Icon::StickyNote, size: 14 } }
                }
                span { class: "pill", title: a.background.clone(),
                    span { class: "dot dot-{shown.class()}" }
                    "{shown.label()}"
                }
                button {
                    id: "{more_id}",
                    class: "card-more icon-button press",
                    r#type: "button",
                    "aria-label": "Actions for {title}",
                    title: "More",
                    onclick: move |_| menu::drop_down(&mut menu_at, &more_at, more_items.clone()),
                    Glyph { icon: Icon::Ellipsis, size: 16 }
                }
            }
            div { class: "card-head",
                div { class: "card-title", "{title}" }
                div { class: "card-meta mono",
                    {model::card_meta(r, show_host)}
                    for t in tags.iter() {
                        span { key: "{t}", class: "card-tag", " · #{t}" }
                    }
                }
            }
            div { class: "card-line", {model::card_line(r, clock)} }
            div { class: "card-foot mono",
                if waiting && live && r.host.status == HostStatus::Online {
                    Answers { host: r.host.config.id.clone(), pane: r.pane.id.clone(), href: href.clone(), options, on_sent: move |_| answered.set(true) }
                } else {
                    span { class: "truncate", {model::model_line(a)} }
                    if let Some(cost) = cost {
                        span { class: "tabular shrink-0", "{cost}" }
                    }
                    if let Some(pct) = ctx {
                        span { class: "card-ctx", title: "{ctx_title}",
                            span { class: "tabular", "{pct.round()}%" }
                            {meter(pct, "meter-sm")}
                        }
                    }
                }
            }
        }
    }
}

/// A waiting session's answers, in the row where the card shows its model and cost: Sending…
/// while the request runs, then Sent until the agent moves on; a toast when the machine didn't
/// take it, and the choices stay for another try.
#[component]
fn Answers(host: String, pane: String, href: String, options: Vec<(u32, String)>, on_sent: EventHandler<()>) -> Element {
    let mut busy = use_signal(|| None::<u32>);
    let mut sent = use_signal(|| false);
    if sent() {
        return rsx! {
            span { class: "answered fade-in", Glyph { icon: Icon::Check, size: 16 } "Sent" }
        };
    }
    if options.is_empty() {
        return rsx! {
            span { class: "answers",
                a { class: "answer answer-first press", href: "{href}", "data-answer": "", "Answer" }
            }
        };
    }
    rsx! {
        span { class: "answers",
            for (i, (n, label)) in options.iter().cloned().enumerate() {
                {
                    let host = host.clone();
                    let pane = pane.clone();
                    let kind = if i == 0 { "answer answer-first press" } else if label.to_lowercase().starts_with("no") { "answer answer-no press" } else { "answer press" };
                    rsx! {
                        button {
                            key: "{n}",
                            class: kind,
                            r#type: "button",
                            title: "{label}",
                            "data-answer": (i == 0).then_some(""),
                            disabled: busy().is_some(),
                            onclick: move |_| {
                                let (host, pane) = (host.clone(), pane.clone());
                                spawn(async move {
                                    busy.set(Some(n));
                                    match api::answer(&host, &pane, &api::Answer { option: n, text: None, question: None }).await {
                                        Ok(()) => {
                                            busy.set(None);
                                            on_sent.call(());
                                            sent.set(true);
                                            // still asking after a moment: the choices again
                                            platform::sleep(4000).await;
                                            sent.set(false);
                                        }
                                        Err(e) => {
                                            busy.set(None);
                                            toast::toast("Could not answer", Some(e.message), ToastTone::Error);
                                        }
                                    }
                                });
                            },
                            if busy() == Some(n) { "Sending…" } else { "{label}" }
                        }
                    }
                }
            }
        }
    }
}

fn meter(pct: f64, class: &str) -> Element {
    let v = pct.clamp(0.0, 100.0);
    rsx! {
        span { class: "meter {class}",
            span { class: "meter-fill meter-{model::meter_tone(v)}", style: "transform: scaleX({v / 100.0})" }
        }
    }
}

pub(super) fn host_dot(status: HostStatus) -> Element {
    let s = match status {
        HostStatus::Online => "online",
        HostStatus::Connecting => "connecting",
        HostStatus::Error => "error",
    };
    rsx! { span { class: "host-dot host-dot-{s}" } }
}

/// The agents installed on a machine: in colour when one runs there now, grey when only installed.
pub(super) fn badges(h: &HostState, size: u32) -> Element {
    let list = model::agent_badges(h);
    if list.is_empty() {
        return rsx! { span { class: "fg-3", "—" } };
    }
    rsx! {
        span { class: "badges",
            for (kind, n) in list {
                span {
                    key: "{kind.as_str()}",
                    class: if n > 0 { "badge" } else { "badge badge-idle" },
                    title: if n > 0 { format!("{}: {n} running", kind.def().name) } else { format!("{}: installed, not running", kind.def().name) },
                    AgentMark { kind, size }
                    if n > 1 {
                        span { class: "mono tabular fg-3 badge-n", "{n}" }
                    }
                }
            }
        }
    }
}

/// The machines: a list in a narrow column, a table once there's room for one (about 600px). Each
/// row has the machine's menu on a right click, and the list on a long press too.
fn machines(hosts: &[HostState], clock: Clock) -> Element {
    rsx! {
        div { class: "machines",
            div { class: "panel machine-list",
                for h in hosts.iter() {
                    MachineListRow { key: "{h.config.id}", h: h.clone(), line: model::machine_line(h, clock) }
                }
            }
            div { class: "panel machine-table",
                table {
                    thead {
                        tr {
                            th { "Machine" }
                            th { title: "In colour: running now. Grey: installed.", "Agents" }
                            th { "tmux" }
                            th { class: "num", title: "How long the machine took to report its sessions at the last check", "Response" }
                        }
                    }
                    tbody {
                        for h in hosts.iter() {
                            MachineTableRow { key: "{h.config.id}", h: h.clone(), address: model::machine_address(h, hosts) }
                        }
                    }
                }
            }
        }
    }
}

#[component]
fn MachineListRow(h: HostState, line: String) -> Element {
    let items = menu::machine_menu(&h, cfg!(target_arch = "wasm32"));
    let press = menu::long_press(items.clone());
    let (p1, p2, p3, p4) = (press.clone(), press.clone(), press.clone(), press);
    rsx! {
        a {
            class: if h.status == HostStatus::Online { "machine-row" } else { "machine-row dim" },
            href: "{model::machine_href(&h.config.id)}",
            oncontextmenu: menu::open(items),
            onpointerdown: move |e| p1.down(&e),
            onpointermove: move |e| p2.moved(&e),
            onpointerup: move |_| p3.up(),
            onclick: move |e| {
                p4.click(&e);
            },
            {host_dot(h.status)}
            div { class: "machine-text",
                div { class: "machine-name-row",
                    span { class: "machine-name", "{h.config.name}" }
                    {badges(&h, 15)}
                }
                div { class: "machine-line mono", "{line}" }
            }
            Glyph { icon: Icon::ChevronRight, size: 16, class: "fg-3" }
        }
    }
}

#[component]
fn MachineTableRow(h: HostState, address: String) -> Element {
    let items = menu::machine_menu(&h, cfg!(target_arch = "wasm32"));
    rsx! {
        tr { class: if h.status == HostStatus::Online { "" } else { "dim" }, oncontextmenu: menu::open(items),
            td {
                a { class: "machine-cell", href: "{model::machine_href(&h.config.id)}",
                    {host_dot(h.status)}
                    div { class: "machine-text",
                        div { class: "machine-name", "{h.config.name}" }
                        div { class: "machine-line mono", "{address}" }
                    }
                }
            }
            td { {badges(&h, 18)} }
            td { class: "fg-2", {model::tmux_cell(&h)} }
            td { class: "num mono tabular fg-2",
                {h.latency_ms.map_or("—".to_string(), format::response_time)}
            }
        }
    }
}

/// Plan limits per machine and agent.
fn limits(hosts: &[HostState], clock: Clock) -> Element {
    let rows = model::limit_rows(hosts);
    if rows.is_empty() {
        return rsx! {};
    }
    rsx! {
        section { class: "panel limits",
            h2 { class: "limits-title", Glyph { icon: Icon::Gauge, size: 16, class: "fg-3" } "Plan limits" }
            div { class: "limits-rows",
                for row in rows {
                    div { key: "{row.host_id}{row.kind.as_str()}",
                        div { class: "limits-head",
                            AgentMark { kind: row.kind, size: 16 }
                            span { class: "limits-host", "{row.host}" }
                            if let Some(n) = row.resets {
                                span { class: "limits-banked mono", title: "Limit resets this account has banked. Inyon never uses them.",
                                    if n == 1 { "1 reset banked" } else { "{n} resets banked" }
                                }
                            }
                        }
                        for (label, w) in [("5-hour", format::live_window(row.five_hour.as_ref(), clock)), ("Weekly", format::live_window(row.seven_day.as_ref(), clock))] {
                            if let Some(w) = w {
                                div { key: "{label}", class: "limit",
                                    div { class: "limit-line",
                                        span { class: "fg-2", "{label}" }
                                        span { class: "limit-reset mono", if w.reset { "reset" } else { {format::resets_in(w.resets_at, clock)} } }
                                        span { class: "limit-pct mono tabular", "{w.pct.round()}%" }
                                    }
                                    {meter(w.pct, "")}
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
