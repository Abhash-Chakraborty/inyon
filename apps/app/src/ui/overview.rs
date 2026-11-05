//! The Overview (apps/web/src/pages/Home.tsx and components/Overview.tsx): every agent session as a
//! card, grouped by machine when there is more than one, the machines, and the plan limits.

use std::collections::BTreeSet;

use dioxus::prelude::*;
use inyon_protocol::{AgentState, HostState, HostStatus};

use super::icons::{AgentMark, Glyph, Icon, Logo, MachineGlyph};
use super::menu;
use super::organize::{pick_click, row_items, wakes_at_here, ORG, SELECTION};
use crate::format::{self, Clock};
use crate::model::{self, AgentPane, Filter, Shown};
use crate::organize::{key_of, note_line, Key};
use crate::state::Hub;
use crate::{api, platform};
use inyon_chat_core::organize::{mark_for, place_of, shown_title, sort_panes, Place};

/// Folded machine groups, in the web app's key (`inyon.folded`, entries `home:<machine>`), so a
/// group folded in one app is folded in the other.
const FOLDED: &str = "inyon.folded";

fn load_folded() -> BTreeSet<String> {
    platform::load(FOLDED).and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok()).unwrap_or_default().into_iter().collect()
}

#[component]
pub fn Overview() -> Element {
    let hub = use_context::<Signal<Hub>>();
    let mut folded = use_signal(load_folded);
    let mut filter = use_signal(|| Filter::All);
    let h = hub.read();
    let clock = platform::clock();
    let panes = model::agent_panes(&h.hosts);
    // the switch goes with the sessions it would sort; with few of them it's back to all
    let filtering = panes.len() >= model::FILTER_FROM;
    let shown_filter = if filtering { filter() } else { Filter::All };
    let all_groups = model::group_panes(&h.hosts, shown_filter);
    let grouped = h.hosts.len() > 1;
    // pinned sessions come first across machines, parked and snoozed ones wait folded at the end
    let org = ORG.read().clone();
    let now_ms = clock.now as u64;
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
    // folded until opened, as in the web app: the set stores the opened one
    let aside_open = folded.read().contains("home:~set-aside-open");
    // the order a Shift-click picks a range in: as the cards are laid out
    let order: Vec<Key> = pinned
        .iter()
        .cloned()
        .chain(groups.iter().filter(|g| !grouped || !folded.read().contains(&format!("home:{}", g.host.config.id))).flat_map(|g| g.panes.iter().map(key_of)))
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

    rsx! {
        div { class: "scroll",
            header { class: "topbar",
                div { class: "topbar-row",
                    span { class: "phone-only", Logo { connecting: !h.connected, target: true } }
                    span { class: "topbar-counts mono wide-only", {model::counts_line(&h.hosts, panes.len())} }
                    if !h.connected {
                        span { class: "reconnecting",
                            Glyph { icon: Icon::WifiOff, size: 14 }
                            "Reconnecting"
                            button { class: "help-link", r#type: "button", onclick: move |_| super::connect::open_connect_help(None), "Can't connect?" }
                        }
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
                            p { class: "empty-title", "No machines yet" }
                            p { class: "empty-text", "Pair a machine or add one over SSH to see the coding agents running in tmux on it." }
                            a { class: "button button-primary button-md press empty-action", href: "/next/machines?add=1", "Add a machine →" }
                        }
                    } else {
                        div {
                            h1 { class: "title", "Overview" }
                            p { class: "lede", span { class: "truncate", {model::status_line(&panes)} } }
                        }
                        super::companion::CompanionBar {}
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
                            if !pinned.is_empty() {
                                div { class: "pinned",
                                    h3 { class: "subsection", Glyph { icon: Icon::Pin, size: 14 } "Pinned" }
                                    div { class: "cards",
                                        for k in pinned.iter().cloned() {
                                            Card { key: "{k.0}{k.1}", k, show_host: grouped, order: order.clone() }
                                        }
                                    }
                                }
                            }
                            if groups.is_empty() && pinned.is_empty() && set_aside.is_empty() && !panes.is_empty() {
                                div { class: "empty",
                                    p { class: "empty-title", "Nothing here" }
                                    p { class: "empty-text", "Try another filter." }
                                }
                            } else if groups.is_empty() && pinned.is_empty() && set_aside.is_empty() {
                                div { class: "empty",
                                    p { class: "empty-title", "No agent sessions" }
                                    p { class: "empty-text", "Start Claude Code, Codex or another agent in tmux on any machine, or press N in the current app to start one from here." }
                                }
                            } else if grouped {
                                div { class: "groups",
                                    for g in groups.iter() {
                                        {
                                            let id = g.host.config.id.clone();
                                            let open = !folded.read().contains(&format!("home:{id}"));
                                            let online = g.host.status == HostStatus::Online;
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
                                                            div { class: "cards cards-grouped",
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
                                div { class: "cards",
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
                                        onclick: move |_| toggle("~set-aside-open".into()),
                                        Glyph { icon: Icon::ChevronRight, size: 16, class: if aside_open { "chevron chevron-open" } else { "chevron" } }
                                        Glyph { icon: Icon::Archive, size: 16, class: "fg-2" }
                                        span { class: "group-name", "Parked and snoozed" }
                                        span { class: "group-count mono tabular", "{set_aside.len()}" }
                                    }
                                    div { class: "expand", "data-open": "{aside_open}",
                                        div { "inert": (!aside_open).then_some(""),
                                            div { class: "cards cards-grouped",
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
                                h2 { "Machines" }
                                a { class: "section-link", href: "/next/machines", "Manage →" }
                            }
                            {machines(&h.hosts, clock)}
                        }
                    }
                }
                aside { class: "content-side",
                    {limits(&h.hosts, clock)}
                }
            }
        }
    }
}

/// An agent session as a card. The whole card opens the session; one that asks something shows its
/// answers in place and keeps its size, so nothing around it moves. Cmd/Ctrl- or Shift-click picks
/// it for a bulk action, and a right click or long press opens its menu.
#[component]
fn Card(k: Key, show_host: bool, order: Vec<Key>) -> Element {
    let hub = use_context::<Signal<Hub>>();
    let h = hub.read();
    let org = ORG.read().clone();
    let sel = SELECTION.read().clone();
    let clock = platform::clock();
    let panes = model::all_panes(&h.hosts);
    let r = panes.iter().find(|r| r.host.config.id == k.0 && r.pane.id == k.1 && r.pane.agent.is_some());
    let items = r.map(|r| row_items(r, &org, &sel, clock, cfg!(target_arch = "wasm32"))).unwrap_or_default();
    let press = menu::long_press(items.clone());
    let Some(r) = r else { return rsx! {} };
    let (p1, p2, p3, p4) = (press.clone(), press.clone(), press.clone(), press);
    let a = r.agent();
    let shown = Shown::of(a, r.host);
    let title = shown_title(r, &org.org);
    let href = model::pane_href(&r.host.config.id, &r.pane.id);
    let waiting = a.state == AgentState::Waiting;
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
    let kc = k.clone();
    rsx! {
        div { class, "data-waiting": waiting.then_some("true"), oncontextmenu: menu::open(items),
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
                if waiting && r.host.status == HostStatus::Online {
                    Answers { host: r.host.config.id.clone(), pane: r.pane.id.clone(), href: href.clone(), options }
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

/// A waiting session's answers, in the row where the card shows its model and cost.
#[component]
fn Answers(host: String, pane: String, href: String, options: Vec<(u32, String)>) -> Element {
    let mut busy = use_signal(|| None::<u32>);
    let mut sent = use_signal(|| false);
    let mut failed = use_signal(|| None::<String>);
    if sent() {
        return rsx! {
            span { class: "answered fade-in", Glyph { icon: Icon::Check, size: 16 } "Sent" }
        };
    }
    if let Some(msg) = failed() {
        return rsx! {
            span { class: "answer-error fade-in", role: "alert", "Couldn't answer: {msg}" }
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
                                            sent.set(true);
                                            // still asking after a moment: the choices again
                                            platform::sleep(4000).await;
                                            sent.set(false);
                                        }
                                        Err(e) => {
                                            failed.set(Some(e.message));
                                            platform::sleep(4000).await;
                                            failed.set(None);
                                        }
                                    }
                                    busy.set(None);
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

/// The machines: a list in a narrow column, a table once there's room for one (about 600px).
fn machines(hosts: &[HostState], clock: Clock) -> Element {
    rsx! {
        div { class: "machines",
            div { class: "panel machine-list",
                for h in hosts.iter() {
                    a {
                        key: "{h.config.id}",
                        class: if h.status == HostStatus::Online { "machine-row" } else { "machine-row dim" },
                        href: "{model::machine_href(&h.config.id)}",
                        {host_dot(h.status)}
                        div { class: "machine-text",
                            div { class: "machine-name-row",
                                span { class: "machine-name", "{h.config.name}" }
                                {badges(h, 15)}
                            }
                            div { class: "machine-line mono", {model::machine_line(h, clock)} }
                        }
                        Glyph { icon: Icon::ChevronRight, size: 16, class: "fg-3" }
                    }
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
                            tr { key: "{h.config.id}", class: if h.status == HostStatus::Online { "" } else { "dim" },
                                td {
                                    a { class: "machine-cell", href: "{model::machine_href(&h.config.id)}",
                                        {host_dot(h.status)}
                                        div { class: "machine-text",
                                            div { class: "machine-name", "{h.config.name}" }
                                            div { class: "machine-line mono", {model::machine_address(h, hosts)} }
                                        }
                                    }
                                }
                                td { {badges(h, 18)} }
                                td { class: "fg-2", {model::tmux_cell(h)} }
                                td { class: "num mono tabular fg-2",
                                    {h.latency_ms.map_or("—".to_string(), format::response_time)}
                                }
                            }
                        }
                    }
                }
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
