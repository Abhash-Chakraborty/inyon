//! Quick access (from 1.1): one box over any screen for commands, sessions on every machine,
//! saved prompts and the files in the sessions' folders. Ctrl P (⌘ P) opens it on Sessions,
//! Ctrl Shift P on Commands and Ctrl O on Files; the sidebar's and the Overview's search button
//! open it too. Enter, Ctrl Enter and Alt Enter run the row's actions, Ctrl K or a right click
//! opens all of them. On a phone it takes the screen and each row has a ⋯.

use std::collections::BTreeMap;

use dioxus::prelude::*;
use inyon_chat_core::organize::shown_title;
use inyon_protocol::{AgentKind, HostStatus, SavedPrompt, NAME_LEN, PROMPT_LEN};

use super::icons::{AgentMark, Glyph, Icon};
use super::kit::{Busy, Field, Sheet};
use super::menu::{self, Action, Item, Menu};
use super::organize::{bulk_items, row_items, session_items, OrgOp, ORG, SELECTION};
use super::toast::{self, Toast, ToastTone};
use crate::model::AgentPane;
use crate::organize::{key_of, sections};
use crate::quick::{full_path, rank, route, split_path, Tab};
use crate::route::Route;
use crate::state::{Chats, Hub};
use crate::{api, dom, model, platform};

/// The tab Quick access is open on, or None while it's shut.
pub static QUICK: GlobalSignal<Option<Tab>> = Signal::global(|| None);

/// Opens Quick access on `tab`, or moves it there when it's open.
pub fn open(tab: Tab) {
    *QUICK.write() = Some(tab);
}

/// What a row's actions do beyond what a menu item can.
#[derive(Debug, Clone, PartialEq)]
pub enum QuickOp {
    Tab(Tab),
    /// the New session sheet, or Add a machine while none is online
    NewSession,
    /// sends a saved prompt as a message to a session, and opens it
    Send {
        host: String,
        pane: String,
        title: String,
        name: String,
        text: String,
    },
    Star {
        id: String,
        on: bool,
    },
    Remove(SavedPrompt),
    /// puts a removed prompt back (Undo)
    Restore(SavedPrompt),
    /// the sheet for a new saved prompt, with its text started
    NewPrompt(String),
}

/// The most rows a tab lists; the box narrows them.
const LIMIT: usize = 60;

#[derive(Debug, Clone, PartialEq)]
enum Mark {
    Icon(Icon),
    Agent(AgentKind),
}

#[derive(Debug, Clone, PartialEq)]
struct Row {
    title: String,
    sub: String,
    mark: Mark,
    /// a key, for a command that has one
    hint: Option<String>,
    /// Enter, Ctrl Enter and Alt Enter: a name for the footer and what it does
    main: (String, Action),
    alt: Option<(String, Action)>,
    third: Option<(String, Action)>,
    /// Ctrl K, the ⋯ and a right click
    menu: Vec<Item>,
    /// what the box matches
    text: String,
}

impl Row {
    fn new(title: impl Into<String>, sub: impl Into<String>, mark: Mark, main: (&str, Action)) -> Row {
        let (title, sub) = (title.into(), sub.into());
        Row { text: format!("{title} {sub}"), title, sub, mark, hint: None, main: (main.0.into(), main.1), alt: None, third: None, menu: vec![] }
    }
}

/// A menu's items as commands, a submenu's as "Snooze: 1 hour"; headings and rows that only open
/// a submenu left out.
fn flatten(items: Vec<Item>, prefix: &str, sub: &str, v: &mut Vec<Row>) {
    for it in items {
        if it.header || it.disabled {
            continue;
        }
        let label = if prefix.is_empty() { it.label.clone() } else { format!("{prefix}: {}", it.label) };
        match it.sub {
            Some(children) => flatten(children, &label, sub, v),
            None if it.action != Action::None => v.push(Row::new(label, sub, Mark::Icon(it.icon), ("Run", it.action))),
            None => {}
        }
    }
}

fn commands(h: &Hub, here: &Route, mac: bool) -> Vec<Row> {
    let org = ORG.peek().clone();
    let sel = SELECTION.peek().clone();
    let clock = platform::clock();
    let tabs = cfg!(target_arch = "wasm32");
    let mut v = vec![];
    // this session's own menu first, while one is open
    if let Route::Session { host, pane, .. } = here {
        let panes = model::all_panes(&h.hosts);
        if let Some(r) = panes.iter().find(|r| &r.host.config.id == host && &r.pane.id == pane && r.pane.agent.is_some()) {
            let name = shown_title(r, &org.org);
            let items: Vec<Item> = session_items(r, &org, clock, tabs).into_iter().filter(|i| !matches!(i.action, Action::Go(_) | Action::NewTab(_))).collect();
            flatten(items, "", &name, &mut v);
        }
    }
    if sel.len() > 1 && org.loaded {
        flatten(bulk_items(&sel.keys, &org.org, clock), "", &format!("{} sessions selected", sel.len()), &mut v);
    }
    let go = |label: &str, icon: Icon, r: Route| Row::new(label, "", Mark::Icon(icon), ("Open", Action::Go(r)));
    v.push(go("Go to Overview", Icon::LayoutGrid, Route::Overview));
    v.push(go("Go to Machines", Icon::Monitor, Route::Machines { add: false }));
    v.push(go("Go to Pages", Icon::PanelsTopLeft, Route::Pages { page: None }));
    v.push(go("Go to Settings", Icon::Settings, Route::Settings));
    v.push(go("Go to Temp files", Icon::FolderOpen, Route::Temp { host: None }));
    let mut new = Row::new("New session…", "", Mark::Icon(Icon::Plus), ("Run", Action::Quick(QuickOp::NewSession)));
    new.hint = Some(crate::quick::new_key(mac).to_string());
    v.push(new);
    v.push(go("Add a machine…", Icon::Plus, Route::Machines { add: true }));
    for host in &h.hosts {
        let paired = !(host.config.kind == inyon_protocol::HostKind::Node && host.config.paired_at.is_none());
        if paired && host.status == HostStatus::Online {
            v.push(Row::new(format!("New session on {}", host.config.name), "", Mark::Icon(Icon::Plus), ("Run", Action::NewSession(host.config.id.clone()))));
        }
    }
    if org.loaded {
        let all: Vec<_> = model::agent_panes(&h.hosts).iter().map(key_of).collect();
        if !all.is_empty() {
            v.push(Row::new("Select every session", "", Mark::Icon(Icon::ListChecks), ("Run", Action::Org(OrgOp::SelectAll(all)))));
        }
        if !sel.is_empty() {
            v.push(Row::new("Clear selection", "", Mark::Icon(Icon::X), ("Run", Action::Org(OrgOp::ClearSelection))));
        }
        v.push(Row::new("New saved prompt…", "", Mark::Icon(Icon::Star), ("Run", Action::Quick(QuickOp::NewPrompt(String::new())))));
    }
    for t in [Tab::Sessions, Tab::Prompts, Tab::Files] {
        let mut r = Row::new(format!("Find in {}", t.label().to_lowercase()), "", Mark::Icon(Icon::Search), ("Open", Action::Quick(QuickOp::Tab(t))));
        r.hint = Some(t.shortcut(mac).to_string()).filter(|s| !s.is_empty());
        v.push(r);
    }
    v
}

fn sessions(h: &Hub) -> Vec<Row> {
    let org = ORG.peek().clone();
    let sel = SELECTION.peek().clone();
    let clock = platform::clock();
    let tabs = cfg!(target_arch = "wasm32");
    let many = h.hosts.len() > 1;
    let mut v = vec![];
    for s in sections(&h.hosts, &org.org, clock.now as u64) {
        for r in &s.rows {
            let a = r.agent();
            let (host, pane) = (r.host.config.id.clone(), r.pane.id.clone());
            let title = shown_title(r, &org.org);
            let mark = inyon_chat_core::organize::mark_for(&org.org, &host, &pane);
            let tags: Vec<String> = mark.and_then(|m| m.tags.clone()).unwrap_or_default().iter().map(|t| format!("#{t}")).collect();
            let mut sub = model::card_meta(r, many);
            if !tags.is_empty() {
                sub = format!("{sub} · {}", tags.join(" "));
            }
            let chat = Route::Session { host: host.clone(), pane: pane.clone(), view: None };
            let mut row = Row::new(title.clone(), sub, Mark::Agent(a.kind), ("Open", Action::Go(chat.clone())));
            let note = mark.and_then(|m| m.note.clone()).unwrap_or_default();
            row.text = format!("{title} {} {} {} {} {note}", model::agent_name(a), r.host.config.name, r.pane.cwd, tags.join(" "));
            row.alt = Some(("Terminal".into(), Action::Go(Route::Session { host, pane, view: Some(inyon_chat_core::overview::PaneView::Terminal) })));
            if tabs {
                row.third = Some(("New tab".into(), Action::NewTab(chat.href())));
            }
            row.hint = (s.kind != crate::organize::Kind::Sessions).then(|| s.kind.label().to_string());
            row.menu = row_items(r, &org, &sel, clock, tabs);
            v.push(row);
        }
    }
    v
}

fn prompts(h: &Hub, here: &Route, query: &str) -> Vec<Row> {
    let org = ORG.peek().clone();
    let mut list: Vec<SavedPrompt> = org.org.prompts.clone().unwrap_or_default();
    list.sort_by_key(|q| q.starred != Some(true));
    // Enter sends to the session on screen, if one is
    let target = match here {
        Route::Session { host, pane, .. } => {
            model::all_panes(&h.hosts).iter().find(|r| &r.host.config.id == host && &r.pane.id == pane).map(|r| (host.clone(), pane.clone(), shown_title(r, &org.org)))
        }
        _ => None,
    };
    let mut v: Vec<Row> = list
        .into_iter()
        .map(|q| {
            let first = q.text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("").to_string();
            let starred = q.starred == Some(true);
            let copy = ("Copy".to_string(), Action::Copy(q.text.clone()));
            let mut row = match &target {
                Some((host, pane, title)) => {
                    let send = Action::Quick(QuickOp::Send { host: host.clone(), pane: pane.clone(), title: title.clone(), name: q.name.clone(), text: q.text.clone() });
                    let mut r = Row::new(q.name.clone(), first, Mark::Icon(if starred { Icon::Star } else { Icon::MessageSquare }), ("Send", send));
                    r.alt = Some(copy.clone());
                    r
                }
                None => Row::new(q.name.clone(), first, Mark::Icon(if starred { Icon::Star } else { Icon::MessageSquare }), ("Copy", copy.1.clone())),
            };
            row.text = format!("{} {}", q.name, q.text);
            row.menu = vec![
                Item::copy("Copy text", &q.text),
                Item::new(if starred { "Unstar" } else { "Star" }, Icon::Star, Action::Quick(QuickOp::Star { id: q.id.clone(), on: !starred })),
                Item::new("Remove", Icon::Trash2, Action::Quick(QuickOp::Remove(q.clone()))).danger().separated(),
            ];
            row
        })
        .collect();
    if org.loaded {
        let label = if query.trim().is_empty() { "New saved prompt…".to_string() } else { format!("Save “{}” as a prompt…", query.trim()) };
        let mut add = Row::new(label, "", Mark::Icon(Icon::Plus), ("Run", Action::Quick(QuickOp::NewPrompt(query.trim().to_string()))));
        // always offered, whatever's typed
        add.text = String::new();
        v.push(add);
    }
    v
}

/// The files in each session folder, fetched once a palette asks: by machine and folder.
#[derive(Debug, Clone, PartialEq)]
enum Folder {
    Loading,
    Ready { pane: String, files: Vec<String> },
    Failed,
}

static FOLDERS: GlobalSignal<BTreeMap<(String, String), Folder>> = Signal::global(BTreeMap::new);

/// Asks each online machine for its sessions' folders it hasn't listed yet.
fn fetch_folders(h: &Hub) {
    for r in model::agent_panes(&h.hosts) {
        if r.host.status != HostStatus::Online || r.pane.cwd.is_empty() {
            continue;
        }
        let k = (r.host.config.id.clone(), r.pane.cwd.clone());
        if FOLDERS.peek().contains_key(&k) {
            continue;
        }
        FOLDERS.write().insert(k.clone(), Folder::Loading);
        let pane = r.pane.id.clone();
        spawn(async move {
            let got = match api::files(&k.0, &pane).await {
                Ok(l) => Folder::Ready { pane, files: l.files },
                Err(_) => Folder::Failed,
            };
            FOLDERS.write().insert(k, got);
        });
    }
}

fn files(h: &Hub) -> (Vec<Row>, usize) {
    let folders = FOLDERS.read().clone();
    let pending = folders.values().filter(|f| **f == Folder::Loading).count();
    let mut v = vec![];
    for ((host, cwd), f) in folders {
        let Folder::Ready { pane, files } = f else { continue };
        let machine = h.hosts.iter().find(|x| x.config.id == host).map_or(host.clone(), |x| x.config.name.clone());
        let folder = cwd.rsplit('/').find(|s| !s.is_empty()).unwrap_or(&cwd).to_string();
        for rel in files {
            let (name, dir) = split_path(&rel);
            let full = full_path(&cwd, &rel);
            let sub = if dir.is_empty() { format!("{folder} · {machine}") } else { format!("{folder}/{dir} · {machine}") };
            let mut row = Row::new(name, sub, Mark::Icon(Icon::File), ("Copy path", Action::Copy(full.clone())));
            row.text = format!("{rel} {folder} {machine}");
            let open = Action::Go(Route::Session { host: host.clone(), pane: pane.clone(), view: None });
            row.alt = Some(("Open its session".into(), open.clone()));
            row.menu = vec![Item::copy("Copy path", &full), Item::copy("Copy path in the folder", &rel), Item::new("Open its session", Icon::ArrowRight, open).separated()];
            v.push(row);
        }
    }
    (v, pending)
}

/// The sidebar's New session, the phone's +, Alt N and N: the New session sheet on the first
/// machine online, or Add a machine when none is, since there's nothing to start one on.
pub fn new_session(hub: Signal<Hub>, here: &mut Signal<Route>) {
    let online = hub.peek().hosts.iter().any(|h| h.status == HostStatus::Online);
    if online {
        super::add::open_action(super::add::ActionSheet::NewSession(String::new()));
    } else {
        crate::route::go(here, Route::Machines { add: true });
    }
}

/// What a right click on nothing in particular offers: the same two things as the keys.
pub fn page_items(online: bool, mac: bool) -> Vec<Item> {
    vec![
        Item::new("Search…", Icon::Search, Action::Quick(QuickOp::Tab(Tab::Sessions))).keys(crate::quick::search_key(mac)),
        Item::new(if online { "New session…" } else { "Add a machine…" }, Icon::Plus, Action::Quick(QuickOp::NewSession)).keys(crate::quick::new_key(mac)),
    ]
}

pub fn run(op: QuickOp, mut here: Signal<Route>, hub: Signal<Hub>) {
    match op {
        QuickOp::Tab(t) => open_fresh(t),
        QuickOp::NewSession => new_session(hub, &mut here),
        QuickOp::Send { host, pane, title, name, text } => {
            crate::route::go(&mut here, Route::Session { host: host.clone(), pane: pane.clone(), view: None });
            dioxus::core::spawn_forever(async move {
                match api::send(&host, &pane, &text, &dom::random_id()).await {
                    Ok(()) => toast::toast(format!("Sent “{name}” to {title}"), None, ToastTone::Success),
                    Err(e) => toast::toast(format!("Could not send “{name}”"), Some(e.message), ToastTone::Error),
                }
            });
        }
        QuickOp::Star { id, on } => {
            dioxus::core::spawn_forever(async move {
                if let Err(e) = api::update_prompt(&id, &serde_json::json!({ "starred": on })).await {
                    toast::toast("Could not change it", Some(e.message), ToastTone::Error);
                }
            });
        }
        QuickOp::Remove(q) => {
            dioxus::core::spawn_forever(async move {
                match api::remove_prompt(&q.id).await {
                    Ok(()) => toast::show(Toast {
                        id: 0,
                        title: format!("Removed “{}”", q.name),
                        body: None,
                        tone: ToastTone::Info,
                        href: None,
                        agent: None,
                        action: Some(("Undo".into(), Action::Quick(QuickOp::Restore(q)))),
                    }),
                    Err(e) => toast::toast("Could not remove it", Some(e.message), ToastTone::Error),
                }
            });
        }
        QuickOp::Restore(q) => {
            dioxus::core::spawn_forever(async move {
                let back = async {
                    let added = api::add_prompt(&q.name, &q.text).await?;
                    if q.starred == Some(true) {
                        api::update_prompt(&added.id, &serde_json::json!({ "starred": true })).await?;
                    }
                    Ok::<(), api::ApiError>(())
                };
                if let Err(e) = back.await {
                    toast::toast("Could not undo", Some(e.message), ToastTone::Error);
                }
            });
        }
        QuickOp::NewPrompt(text) => {
            *PROMPT_SHEET.write() = Some(text);
        }
    }
}

// ---------- the box ----------

/// The new-prompt sheet, open with its text started.
static PROMPT_SHEET: GlobalSignal<Option<String>> = Signal::global(|| None);
static QUERY: GlobalSignal<String> = Signal::global(String::new);
static AT: GlobalSignal<usize> = Signal::global(|| 0);

fn close() {
    if QUICK.peek().is_some() {
        *QUICK.write() = None;
        dom::pop_focus();
    }
}

/// Opens it from a key or a button: with an empty box when it was shut.
pub fn open_fresh(tab: Tab) {
    if QUICK.peek().is_none() {
        dom::push_focus();
        QUERY.write().clear();
    }
    *AT.write() = 0;
    open(tab);
}

/// Picks a tab by hand: a leading `>` or `@` goes, since it would pick another.
fn pick_tab(t: Tab) {
    let q = QUERY.peek().clone();
    let (_, rest) = route(&q, t);
    if rest.len() != q.trim_start().len() {
        *QUERY.write() = rest.to_string();
    }
    *AT.write() = 0;
    open(t);
}

const INPUT: &str = "quick-input";

/// Keeps the row with the keys' focus in sight in the list.
fn reveal(i: usize) {
    let id = format!("quick-row-{i}");
    if let (Some((top, height, _)), Some(off), Some((_, rt, _, rb))) = (dom::scroll_metrics("quick-list"), dom::offset_top(&id), dom::rect(&id)) {
        let h = rb - rt;
        if off < top {
            dom::set_scroll_top("quick-list", off);
        } else if off + h > top + height {
            dom::set_scroll_top("quick-list", off + h - height);
        }
    }
}

#[component]
pub fn QuickAccess() -> Element {
    let hub = use_context::<Signal<Hub>>();
    let here = use_context::<Signal<Route>>();
    let chats = use_context::<Signal<Chats>>();
    let mut menu_at = use_context::<Signal<Option<Menu>>>();
    use_hook(move || {
        dom::on_shortcut(move |k| match k {
            // Esc closes the box wherever the focus went (a menu that just closed can take it
            // back), unless a row's menu is open over it, which closes first
            "escape" if QUICK.peek().is_some() && menu_at.peek().is_none() => {
                close();
                true
            }
            "new" => {
                close();
                let mut here = here;
                new_session(hub, &mut here);
                true
            }
            "shift+p" => {
                open_fresh(Tab::Commands);
                true
            }
            "o" => {
                open_fresh(Tab::Files);
                true
            }
            "p" => {
                open_fresh(Tab::Sessions);
                true
            }
            // the classic app's search key; inside the box it opens the row's menu instead
            "k" if QUICK.peek().is_none() => {
                open_fresh(Tab::Sessions);
                true
            }
            _ => false,
        })
    });
    // the box takes the keys whenever it opens or changes tab
    use_effect(move || {
        if QUICK().is_some() {
            spawn(async move {
                platform::sleep(10).await;
                dom::focus(INPUT);
            });
        }
    });
    // the Files tab asks the machines for their folders as it opens
    use_effect(move || {
        if let Some(t) = QUICK() {
            if route(&QUERY(), t).0 == Tab::Files {
                fetch_folders(&hub.peek());
            }
        }
    });
    let Some(base) = QUICK() else { return rsx! { PromptSheet {} } };
    let q = QUERY();
    let (tab, words) = route(&q, base);
    let words = words.to_string();
    let h = hub.read();
    let mac = dom::mac();
    let route_now = here();
    let mut pending = 0;
    let saved = ORG.read().org.prompts.as_ref().map_or(0, Vec::len);
    // the row that saves a new prompt is always there; it isn't a match
    let mut extra = 0;
    let rows: Vec<Row> = match tab {
        Tab::Commands => rank(commands(&h, &route_now, mac), &words, |r| r.text.clone(), LIMIT),
        Tab::Sessions => rank(sessions(&h), &words, |r| r.text.clone(), LIMIT),
        Tab::Prompts => {
            let mut all = prompts(&h, &route_now, &words);
            let add = all.pop_if(|r| r.text.is_empty());
            extra = usize::from(add.is_some());
            let mut v = rank(all, &words, |r| r.text.clone(), LIMIT);
            v.extend(add);
            v
        }
        Tab::Files => {
            let (all, p) = files(&h);
            pending = p;
            rank(all, &words, |r| r.text.clone(), LIMIT)
        }
    };
    drop(h);
    let n = rows.len();
    let sel = AT().min(n.saturating_sub(1));
    let fire = move |a: Action| {
        close();
        menu::run(a, chats, here, hub);
    };
    let keys_rows = rows.clone();
    let cmd = if mac { "⌘" } else { "Ctrl" };
    let alt_key = if mac { "⌥" } else { "Alt" };
    let current = rows.get(sel).cloned();
    let empty = match tab {
        Tab::Files if pending > 0 => None,
        Tab::Files if FOLDERS.read().is_empty() => Some("No session folders to look in"),
        Tab::Prompts if saved == 0 => Some("No saved prompts yet"),
        _ if n == extra => Some("Nothing matches"),
        _ => None,
    };
    rsx! {
        div { class: "quick-backdrop", onclick: move |_| close() }
        div {
            class: "quick",
            role: "dialog",
            "aria-modal": "true",
            "aria-label": "Quick access",
            div { class: "quick-head",
                Glyph { icon: Icon::Search, size: 16, class: "quick-search" }
                input {
                    id: INPUT,
                    class: "quick-input",
                    r#type: "text",
                    role: "combobox",
                    "aria-expanded": "true",
                    "aria-controls": "quick-options",
                    "aria-activedescendant": if n > 0 { format!("quick-row-{sel}") } else { String::new() },
                    autocomplete: "off",
                    spellcheck: "false",
                    placeholder: tab.placeholder(),
                    value: "{q}",
                    oninput: move |e| {
                        *QUERY.write() = e.value();
                        *AT.write() = 0;
                    },
                    onkeydown: move |e: KeyboardEvent| {
                        let m = e.modifiers();
                        let cmd = if mac { m.meta() } else { m.ctrl() };
                        match e.key() {
                            Key::ArrowDown | Key::ArrowUp if n > 0 => {
                                let i = if e.key() == Key::ArrowDown { (sel + 1) % n } else { (sel + n - 1) % n };
                                *AT.write() = i;
                                spawn(async move {
                                    platform::sleep(0).await;
                                    reveal(i);
                                });
                            }
                            Key::Enter => {
                                let Some(r) = keys_rows.get(sel) else { return };
                                let a = if cmd { r.alt.clone().map(|x| x.1) } else if m.alt() { r.third.clone().map(|x| x.1) } else { Some(r.main.1.clone()) };
                                if let Some(a) = a {
                                    fire(a);
                                }
                            }
                            Key::Escape => close(),
                            Key::Tab => pick_tab(tab.next(m.shift())),
                            Key::Character(c) if cmd && c.len() == 1 => {
                                if let Some(t) = c.parse::<usize>().ok().and_then(Tab::nth) {
                                    pick_tab(t);
                                } else if c.eq_ignore_ascii_case("k") {
                                    let Some(r) = keys_rows.get(sel) else { return };
                                    menu::drop_down(&mut menu_at, &format!("quick-row-{sel}"), r.menu.clone());
                                } else {
                                    return;
                                }
                            }
                            _ => return,
                        }
                        e.prevent_default();
                        e.stop_propagation();
                    },
                }
                button { class: "icon-button press quick-close", r#type: "button", "aria-label": "Close", title: "Close (Esc)", onclick: move |_| close(),
                    Glyph { icon: Icon::X, size: 16 }
                }
            }
            div { class: "quick-tabs", role: "tablist", "aria-label": "What to look for",
                for t in Tab::ALL {
                    button {
                        key: "{t.id()}",
                        class: if t == tab { "quick-tab quick-tab-on press" } else { "quick-tab press" },
                        r#type: "button",
                        role: "tab",
                        "aria-selected": if t == tab { "true" } else { "false" },
                        onclick: move |_| pick_tab(t),
                        "{t.label()}"
                    }
                }
            }
            div { id: "quick-list", class: "quick-list",
                if let Some(t) = empty {
                    div { class: "quick-note", role: "status", "{t}" }
                }
                div { id: "quick-options", role: "listbox", "aria-label": "{tab.label()}",
                    for (i , r) in rows.into_iter().enumerate() {
                        {
                            let main = r.main.1.clone();
                            let items = r.menu.clone();
                            let more = r.menu.clone();
                            let more_id = format!("quick-more-{i}");
                            let more_anchor = more_id.clone();
                            rsx! {
                                div {
                                    key: "{i}-{r.title}",
                                    id: "quick-row-{i}",
                                    class: if i == sel { "quick-row quick-row-on" } else { "quick-row" },
                                    role: "option",
                                    "aria-selected": if i == sel { "true" } else { "false" },
                                    onmousemove: move |_| {
                                        if *AT.peek() != i {
                                            *AT.write() = i;
                                        }
                                    },
                                    onclick: move |_| fire(main.clone()),
                                    oncontextmenu: move |e: MouseEvent| {
                                        if items.is_empty() {
                                            return;
                                        }
                                        e.prevent_default();
                                        let p = e.client_coordinates();
                                        menu_at.set(Some(Menu::at(p.x, p.y, items.clone())));
                                    },
                                    span { class: "quick-mark",
                                        match r.mark {
                                            Mark::Icon(icon) => rsx! { Glyph { icon, size: 16 } },
                                            Mark::Agent(kind) => rsx! { AgentMark { kind, size: 16 } },
                                        }
                                    }
                                    span { class: "quick-words",
                                        span { class: "quick-title truncate", "{r.title}" }
                                        if !r.sub.is_empty() {
                                            span { class: "quick-sub truncate", "{r.sub}" }
                                        }
                                    }
                                    if let Some(hint) = &r.hint {
                                        span { class: "quick-hint mono", "{hint}" }
                                    }
                                    if !more.is_empty() {
                                        button {
                                            id: "{more_id}",
                                            class: "icon-button press quick-more",
                                            r#type: "button",
                                            "aria-label": "More for {r.title}",
                                            title: "More ({cmd} K)",
                                            onclick: move |e| {
                                                e.stop_propagation();
                                                menu::drop_down(&mut menu_at, &more_anchor, more.clone());
                                            },
                                            Glyph { icon: Icon::Ellipsis, size: 14 }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                if pending > 0 {
                    div { class: "quick-note", role: "status",
                        Busy { on: true }
                        if pending == 1 { "Still searching a folder…" } else { "Still searching {pending} folders…" }
                    }
                }
            }
            if let Some(r) = current {
                div { class: "quick-foot",
                    span { class: "quick-key", Glyph { icon: Icon::CornerDownLeft, size: 12 } " {r.main.0}" }
                    if let Some((l, _)) = &r.alt {
                        span { class: "quick-key", "{cmd} ↵ {l}" }
                    }
                    if let Some((l, _)) = &r.third {
                        span { class: "quick-key", "{alt_key} ↵ {l}" }
                    }
                    if !r.menu.is_empty() {
                        span { class: "quick-key", "{cmd} K More" }
                    }
                    span { class: "quick-key quick-key-end", "Tab Next list" }
                }
            }
        }
        PromptSheet {}
    }
}

#[component]
fn PromptSheet() -> Element {
    let open = PROMPT_SHEET.read().is_some();
    let mut name = use_signal(String::new);
    let mut text = use_signal(String::new);
    let mut busy = use_signal(|| false);
    let mut error = use_signal(|| None::<String>);
    use_effect(move || {
        if let Some(t) = PROMPT_SHEET() {
            name.set(String::new());
            text.set(t);
            error.set(None);
        }
    });
    let close_sheet = move || *PROMPT_SHEET.write() = None;
    let mut save = move || {
        let (n, t) = (name().trim().to_string(), text());
        busy.set(true);
        spawn(async move {
            match api::add_prompt(&n, &t).await {
                Ok(_) => {
                    *PROMPT_SHEET.write() = None;
                    toast::toast(format!("Saved “{n}”"), Some("It's under Saved prompts in Quick access.".into()), ToastTone::Success);
                }
                Err(e) => error.set(Some(e.message)),
            }
            busy.set(false);
        });
    };
    let n_len = name().encode_utf16().count();
    let t_len = text().encode_utf16().count();
    let ready = !name().trim().is_empty() && n_len <= NAME_LEN && !text().trim().is_empty() && t_len <= PROMPT_LEN;
    rsx! {
        Sheet {
            open,
            on_close: move |_| close_sheet(),
            title: "New saved prompt",
            footer: rsx! {
                div { class: "sheet-actions",
                    button { class: "button button-md button-ghost press", r#type: "button", disabled: busy(), onclick: move |_| close_sheet(), "Cancel" }
                    button { class: "button button-md button-primary press", r#type: "button", disabled: busy() || !ready, onclick: move |_| save(),
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
                        save();
                    }
                },
                Field { label: "Name",
                    input { class: "field", value: "{name}", maxlength: "{NAME_LEN}", "data-autofocus": "true", oninput: move |e| name.set(e.value()) }
                }
                Field { label: "Prompt", hint: (t_len > PROMPT_LEN).then(|| format!("{t_len} of {PROMPT_LEN} characters")),
                    textarea { class: "field field-area", rows: "6", value: "{text}", oninput: move |e| text.set(e.value()) }
                }
                if let Some(e) = error() {
                    p { class: "form-error", role: "alert", "{e}" }
                }
            }
        }
    }
}
