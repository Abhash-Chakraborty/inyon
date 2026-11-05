//! The sidebar's session list (from 1.1): every agent session in its section (Pinned, Sessions,
//! Parked, Snoozed), one line each with its agent, name, first tag, state and when it last did
//! something. A click opens it, Cmd/Ctrl-click and Shift-click pick several for the bulk menu, and
//! a right click (or ⋯) opens its menu. Sections fold, and remember it on this device.

use std::collections::BTreeMap;

use dioxus::prelude::*;
use inyon_chat_core::organize::{mark_for, shown_title};
use inyon_protocol::AgentState;

use super::icons::{AgentMark, Glyph, Icon};
use super::menu::{self, Menu};
use super::organize::{pick_click, row_items, section_items, wakes_at_here, ORG, SELECTION};
use crate::model::{self, AgentPane, Shown};
use crate::organize::{dots, key_of, note_line, sections, short_ago, visible, Key, Kind, Section};
use crate::platform;
use crate::state::Hub;

/// Sections folded or opened by hand, by id; the rest start as [`Kind::folded_at_first`] says.
const FOLDED: &str = "inyon.sidebar.sections";

fn load_folded() -> BTreeMap<String, bool> {
    platform::load(FOLDED).and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

fn is_folded(saved: &BTreeMap<String, bool>, k: Kind) -> bool {
    saved.get(k.id()).copied().unwrap_or(k.folded_at_first())
}

#[component]
pub fn SessionList(current: Option<(String, String)>) -> Element {
    let hub = use_context::<Signal<Hub>>();
    let mut folded = use_signal(load_folded);
    let h = hub.read();
    let org = ORG.read().clone();
    let sel = SELECTION.read().clone();
    let clock = platform::clock();
    let list = sections(&h.hosts, &org.org, clock.now as u64);
    // the list redraws when the next snooze ends, so the session comes back on time
    let wake = inyon_chat_core::organize::next_wake(&org.org, clock.now as u64);
    use_future(use_reactive!(|wake| async move {
        if let Some(at) = wake {
            platform::sleep(at.saturating_sub(platform::clock().now as u64).saturating_add(250).min(u64::from(u32::MAX)) as u32).await;
            ORG.write();
        }
    }));
    if list.is_empty() {
        return rsx! {};
    }
    let saved = folded.read().clone();
    let order = visible(&list, |k| is_folded(&saved, k));
    let many_machines = h.hosts.len() > 1;
    rsx! {
        div { class: "session-list", role: "list", "aria-label": "Sessions",
            for s in list.iter() {
                {
                    let kind = s.kind;
                    let shut = is_folded(&saved, kind);
                    rsx! {
                        div { key: "{kind.id()}", class: "side-section", role: "listitem",
                            SectionHead { kind, section: s.clone_keys(), open: !shut, dots: dots(&s.rows), on_toggle: move |_| {
                                let mut f = folded.write();
                                let now = !is_folded(&f, kind);
                                f.insert(kind.id().to_string(), now);
                                platform::save(FOLDED, &serde_json::to_string(&*f).unwrap_or_default());
                            } }
                            div { class: "expand", "data-open": "{!shut}",
                                div { "inert": shut.then_some(""),
                                    div { class: "side-rows", role: "list",
                                        for k in s.clone_keys() {
                                            SideRow {
                                                key: "{k.0}{k.1}",
                                                on: current.as_ref() == Some(&k),
                                                picked: sel.has(&k),
                                                k,
                                                kind,
                                                order: order.clone(),
                                                many_machines,
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

trait Keys {
    fn clone_keys(&self) -> Vec<Key>;
}

impl Keys for Section<'_> {
    fn clone_keys(&self) -> Vec<Key> {
        self.rows.iter().map(key_of).collect()
    }
}

/// A section's heading: fold it, see what needs you inside, or right-click for all of it at once.
#[component]
fn SectionHead(kind: Kind, section: Vec<Key>, open: bool, dots: (usize, usize), on_toggle: EventHandler<()>) -> Element {
    let items = section_items(kind, &section);
    let press = menu::long_press(items.clone());
    let (p1, p2, p3, p4) = (press.clone(), press.clone(), press.clone(), press);
    let (waiting, working) = dots;
    rsx! {
        button {
            class: "side-head",
            r#type: "button",
            "aria-expanded": "{open}",
            oncontextmenu: menu::open(items),
            onpointerdown: move |e| p1.down(&e),
            onpointermove: move |e| p2.moved(&e),
            onpointerup: move |_| p3.up(),
            onclick: move |e| {
                if !p4.click(&e) {
                    on_toggle.call(());
                }
            },
            Glyph { icon: Icon::ChevronRight, size: 14, class: if open { "chevron chevron-open" } else { "chevron" } }
            span { class: "side-head-label", "{kind.label()}" }
            span { class: "side-head-count mono tabular", "{section.len()}" }
            if waiting > 0 {
                span { class: "dot dot-waiting", title: if waiting == 1 { "1 needs you".to_string() } else { format!("{waiting} need you") } }
            }
            if working > 0 && !open {
                span { class: "dot dot-working", title: "{working} working" }
            }
        }
    }
}

/// One session's line.
#[component]
fn SideRow(k: Key, kind: Kind, on: bool, picked: bool, order: Vec<Key>, many_machines: bool) -> Element {
    let hub = use_context::<Signal<Hub>>();
    let mut menu_at = use_context::<Signal<Option<Menu>>>();
    let h = hub.read();
    let org = ORG.read().clone();
    let sel = SELECTION.read().clone();
    let clock = platform::clock();
    let panes = model::all_panes(&h.hosts);
    let Some(r) = panes.iter().find(|r| r.host.config.id == k.0 && r.pane.id == k.1 && r.pane.agent.is_some()) else { return rsx! {} };
    let a = r.agent();
    let m = mark_for(&org.org, &k.0, &k.1);
    let title = shown_title(r, &org.org);
    let shown = Shown::of(a, r.host);
    let href = model::pane_href(&k.0, &k.1);
    let tag = m.and_then(|m| m.tags.as_ref()).and_then(|t| t.first().cloned());
    let note = m.and_then(|m| m.note.as_deref()).map(note_line).filter(|n| !n.is_empty()).map(str::to_owned);
    let time = match (kind, m.and_then(|m| m.snoozed_until)) {
        (Kind::Snoozed, Some(at)) => wakes_at_here(at, clock),
        _ => short_ago(*r.window.activity * 1000.0, clock),
    };
    let mut tip = vec![title.clone()];
    if many_machines {
        tip.push(r.host.config.name.clone());
    }
    tip.push(shown.label().to_string());
    if let Some(n) = &note {
        tip.push(n.clone());
    }
    // a new tab only in a browser
    let items = row_items(r, &org, &sel, clock, cfg!(target_arch = "wasm32"));
    let press = menu::long_press(items.clone());
    let (p1, p2, p3, p4) = (press.clone(), press.clone(), press.clone(), press);
    let id = format!("side-more-{}-{}", k.0, k.1.trim_start_matches('%')).replace(|c: char| !c.is_ascii_alphanumeric() && c != '-', "_");
    let more_id = id.clone();
    let more_items = items.clone();
    let class = match (on, picked) {
        (true, true) => "side-row side-row-on side-row-picked",
        (true, false) => "side-row side-row-on",
        (false, true) => "side-row side-row-picked",
        (false, false) => "side-row",
    };
    let kc = k.clone();
    rsx! {
        div { class, role: "listitem",
            a {
                class: "side-link",
                href: "{href}",
                title: tip.join(" · "),
                "aria-current": on.then_some("page"),
                oncontextmenu: menu::open(items),
                onpointerdown: move |e| p1.down(&e),
                onpointermove: move |e| p2.moved(&e),
                onpointerup: move |_| p3.up(),
                onclick: move |e| {
                    if !p4.click(&e) {
                        pick_click(&e, kc.clone(), &order);
                    }
                },
                span { class: "side-mark",
                    AgentMark { kind: a.kind, size: 16 }
                    if picked {
                        span { class: "side-check", Glyph { icon: Icon::Check, size: 12 } }
                    }
                }
                span { class: "side-title truncate", "{title}" }
                if let Some(t) = tag {
                    span { class: "side-tag mono truncate", "#{t}" }
                }
                if note.is_some() {
                    Glyph { icon: Icon::StickyNote, size: 12, class: "side-note" }
                }
                if a.state == AgentState::Waiting || model::busy(a) {
                    span { class: "dot dot-{shown.class()}" }
                }
                span { class: "side-time mono tabular", "{time}" }
                if picked {
                    span { class: "sr-only", ", selected" }
                }
            }
            button {
                id: "{id}",
                class: "side-more icon-button press",
                r#type: "button",
                "aria-label": "More for {title}",
                title: "More",
                onclick: move |_| menu::drop_down(&mut menu_at, &more_id, more_items.clone()),
                Glyph { icon: Icon::Ellipsis, size: 14 }
            }
        }
    }
}
