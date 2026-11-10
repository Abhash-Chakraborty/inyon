//! The session's side panel and its phone sheet (session/Panels.tsx, Workspace.tsx and
//! MobileSheets.tsx ActivitySheet): Changes (this chat's edits, or git's working tree with Commit
//! all and Push, and comments on diff lines), Files with a file viewer, Activity (queued messages,
//! subagents, background tasks, monitors, artifacts), Blueprints and Usage. From 1180 px
//! up it sits beside the chat; below that the header's Activity button opens the same bodies in a
//! sheet.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::future::Future;
use std::rc::Rc;

use dioxus::prelude::*;
use inyon_chat_core::format as f;
use inyon_protocol::{AgentKind, AgentStatus, BackgroundTask, ChatInfo, ChatItem, SubagentInfo, SubagentStatus, TaskStatus, TaskType};

use super::icons::{Glyph, Icon};
use super::kit::{Segmented, Sheet, WaitRows, Waiting};
use super::menu::{self, Action, Item};
use super::rows::{Ctx, RowView};
use super::toast::{self, Ask, ToastTone};
use crate::api::{self, ApiError};
use crate::changes::{self, Edit, FileChange, Hunk, Line, Note, Row};
use crate::layout;
use crate::state::Chats;
use crate::{dom, platform};

/// From this width the panel sits beside the chat (PanePage.tsx useWide).
pub const WIDE_FROM: f64 = 1180.0;
static WIDE: GlobalSignal<bool> = Signal::global(|| dom::viewport().0 >= WIDE_FROM);

thread_local! {
    static LISTENING: Cell<bool> = const { Cell::new(false) };
}

/// Whether the screen is wide enough for the panel, following the window's size.
pub fn use_wide() -> bool {
    use_hook(|| {
        if !LISTENING.with(|l| l.replace(true)) {
            dom::on_resize(|| {
                let wide = dom::viewport().0 >= WIDE_FROM;
                if *WIDE.peek() != wide {
                    *WIDE.write() = wide;
                }
            });
        }
    });
    WIDE()
}

pub fn wide() -> bool {
    WIDE()
}

/// The panel's tabs, in order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Tab {
    Changes,
    Files,
    Activity,
    Pages,
    Usage,
}

impl Tab {
    fn id(self) -> &'static str {
        match self {
            Tab::Changes => "changes",
            Tab::Files => "files",
            Tab::Activity => "activity",
            Tab::Pages => "pages",
            Tab::Usage => "usage",
        }
    }
}

/// The session the panel shows, as its screen knows it.
#[derive(Clone, PartialEq)]
pub struct Of {
    pub host: String,
    pub pane: String,
    /// the chat's rows' context, for a subagent's transcript
    pub ctx: Ctx,
    pub here: super::pages::Here,
    pub side: super::pages::Side,
    pub agent: Option<AgentKind>,
    /// the live numbers the Usage tab reads
    pub status: Option<AgentStatus>,
    /// the agent's compact command, when it has one
    pub compact: Option<String>,
}

impl Of {
    fn key(&self) -> String {
        inyon_protocol::chat_key(&self.host, &self.pane)
    }
}

// ---------- shared state ----------

/// Comments on diff lines, per session, until they go into the message box (lib/review.ts). Not
/// saved anywhere.
static REVIEW: GlobalSignal<HashMap<String, Vec<Note>>> = Signal::global(HashMap::new);
/// The diff line being commented on: the session, the file and the line.
static COMMENTING: GlobalSignal<Option<(String, String, Line)>> = Signal::global(|| None);
/// The background task or subagent whose sheet is open.
static TASK: GlobalSignal<Option<BackgroundTask>> = Signal::global(|| None);
static SUB: GlobalSignal<Option<SubagentInfo>> = Signal::global(|| None);
/// A file or folder to show in the Files tab, from its right-click menu (true: a folder).
static FILES_GO: GlobalSignal<Option<(u64, bool, String)>> = Signal::global(|| None);
/// A file to show the diff of in the working tree, from its right-click menu.
static TREE_PICK: GlobalSignal<Option<String>> = Signal::global(|| None);
static OP_N: GlobalSignal<u64> = Signal::global(|| 0);
/// Bumped when a right-click menu's Mention puts a path in the box, so the phone's sheet over the
/// box gets out of the way.
static MENTIONED: GlobalSignal<u64> = Signal::global(|| 0);

/// What the panel's right-click menus do.
#[derive(Debug, Clone, PartialEq)]
pub enum PanelOp {
    /// `@path` into the session's message box
    Mention {
        host: String,
        pane: String,
        path: String,
    },
    /// a folder (true) or a file in the Files tab
    Open(bool, String),
    ShowDiff(String),
}

pub fn run(op: PanelOp) {
    match op {
        PanelOp::Mention { host, pane, path } => {
            if mention(&host, &pane, &path) {
                *MENTIONED.write() += 1;
            }
        }
        PanelOp::Open(dir, path) => {
            let n = *OP_N.peek() + 1;
            *OP_N.write() = n;
            *FILES_GO.write() = Some((n, dir, path));
        }
        PanelOp::ShowDiff(path) => *TREE_PICK.write() = Some(path),
    }
}

/// Puts `@path` in the session's message box; says so when that chat isn't open.
fn mention(host: &str, pane: &str, path: &str) -> bool {
    let ok = super::composer::compose(host, pane, &format!("@{path}"));
    if !ok {
        toast::toast("Open the chat to mention it", None, ToastTone::Info);
    }
    ok
}

/// Loads with `load` now, whenever `key` changes, and when the returned counter is bumped,
/// keeping what it had on screen while the next answer comes (Workspace.tsx useLoad).
struct Load<T> {
    data: Option<T>,
    error: Option<String>,
    busy: bool,
    /// `data` is for the key before: shown while the next answer comes, but not to act on
    stale: bool,
}

fn use_load<K, T, F, Fut>(key: K, load: F) -> (Signal<Load<T>>, Signal<u32>)
where
    K: PartialEq + Clone + 'static,
    T: 'static,
    F: Fn(K) -> Fut + 'static,
    Fut: Future<Output = Result<T, ApiError>> + 'static,
{
    let mut state = use_signal(|| Load { data: None, error: None, busy: true, stale: false });
    let rev = use_signal(|| 0u32);
    let load = use_hook(|| Rc::new(load));
    let gen = use_hook(|| Rc::new(Cell::new(0u32)));
    let last = use_hook(|| Rc::new(RefCell::new(None::<K>)));
    use_effect(use_reactive!(|key| {
        let _ = rev();
        let n = gen.get() + 1;
        gen.set(n);
        let moved = last.borrow().as_ref().is_some_and(|k| *k != key);
        *last.borrow_mut() = Some(key.clone());
        let mut s = state.write();
        s.busy = true;
        s.stale |= moved;
        drop(s);
        let fut = load(key.clone());
        let gen = gen.clone();
        spawn(async move {
            let r = fut.await;
            if gen.get() != n {
                return;
            }
            let mut s = state.write();
            s.busy = false;
            s.stale = false;
            match r {
                Ok(d) => {
                    s.data = Some(d);
                    s.error = None;
                }
                Err(e) => {
                    s.data = None;
                    s.error = Some(e.message);
                }
            }
        });
    }));
    (state, rev)
}

#[component]
fn Empty(icon: Icon, title: String, #[props(default)] action: Option<Element>, children: Element) -> Element {
    rsx! {
        div { class: "pp-empty fade-in",
            div { class: "empty-icon", Glyph { icon, size: 20 } }
            div { class: "empty-title", "{title}" }
            div { class: "empty-text", {children} }
            if let Some(a) = action {
                div { class: "pp-empty-action", {a} }
            }
        }
    }
}

// ---------- the panel ----------

/// The tabs as the panel lists them: Blueprints only for a session that has some, or while it's
/// the tab on screen.
fn tabs(changes: usize, running: usize, pages: usize, on: Tab) -> Vec<(Tab, &'static str, Option<usize>)> {
    let mut v = vec![(Tab::Changes, "Changes", (changes > 0).then_some(changes)), (Tab::Files, "Files", None), (Tab::Activity, "Activity", (running > 0).then_some(running))];
    if pages > 0 || on == Tab::Pages {
        v.push((Tab::Pages, "Blueprints", (pages > 0).then_some(pages)));
    }
    v.push((Tab::Usage, "Usage", None));
    v
}

const PANEL_ID: &str = "side-panel";
const HANDLE_ID: &str = "side-panel-resize";

/// The panel's left edge, which drags it wider or narrower (session/PanelResize.tsx): the arrow
/// keys move it a step, and a double click, Home or Enter puts the usual width back. `live` holds
/// the width under the pointer while it's dragged; letting go keeps it in the settings.
#[component]
fn ResizeHandle(live: Signal<Option<f64>>) -> Element {
    let mut live = live;
    let stored = super::notices::PREFS.read().panel_width;
    // the panel's right edge and its row's width, from when the drag began
    let mut drag = use_signal(|| None::<(f64, f64)>);
    let row = || dom::parent_width(PANEL_ID).unwrap_or_else(|| dom::viewport().0);
    let measured = || dom::rect(PANEL_ID).map(|(left, _, right, _)| (right - left).round());
    let usual = if stored > 0.0 { stored } else { layout::usual_width(dom::viewport().0) };
    let now = live().unwrap_or(usual);
    let mut end = move |keep: bool| {
        if drag.peek().is_none() {
            return;
        }
        drag.set(None);
        dom::root_class("resizing", false);
        let w = *live.peek();
        live.set(None);
        if let (true, Some(w)) = (keep, w) {
            super::notices::set_prefs(|s| s.panel_width = w);
        }
    };
    // a panel taken away mid-drag (the window made narrow, the session left) lets go of the page
    use_drop(|| dom::root_class("resizing", false));
    rsx! {
        div {
            id: HANDLE_ID,
            class: "pp-resize",
            role: "separator",
            "aria-orientation": "vertical",
            "aria-label": "Resize the side panel",
            "aria-valuemin": "{layout::PANEL_MIN}",
            "aria-valuemax": "{layout::clamp_panel(f64::INFINITY, row())}",
            "aria-valuenow": "{now}",
            tabindex: "0",
            title: "Drag to resize. Double-click for the usual width.",
            "data-dragging": live().is_some().then_some("true"),
            onpointerdown: move |e: PointerEvent| {
                if e.trigger_button() != Some(dioxus::html::input_data::MouseButton::Primary) {
                    return;
                }
                let Some((_, _, right, _)) = dom::rect(PANEL_ID) else { return };
                e.prevent_default();
                dom::capture_pointer(HANDLE_ID, e.pointer_id());
                drag.set(Some((right, row())));
                dom::root_class("resizing", true);
                live.set(Some(measured().unwrap_or(usual)));
            },
            onpointermove: move |e: PointerEvent| {
                if let Some((right, row)) = drag() {
                    let w = layout::clamp_panel(right - e.client_coordinates().x, row);
                    if *live.peek() != Some(w) {
                        live.set(Some(w));
                    }
                }
            },
            onpointerup: move |_| end(true),
            onpointercancel: move |_| end(false),
            ondoubleclick: move |_| super::notices::set_prefs(|s| s.panel_width = 0.0),
            onkeydown: move |e: KeyboardEvent| {
                // from the width asked for last, which a second press may come before the page shows
                let kept = super::notices::PREFS.peek().panel_width;
                let from = if kept > 0.0 { kept } else { measured().unwrap_or(usual) };
                if let Some(w) = layout::handle_key(&e.key().to_string(), from, row()) {
                    e.prevent_default();
                    super::notices::set_prefs(|s| s.panel_width = w);
                }
            },
            // a hairline that shows where to grab: on hover, with the keyboard, and while dragging
            span { class: "pp-resize-line" }
            // over everything while dragging, so a page in a frame can't take the pointer
            if live().is_some() {
                div { class: "pp-resize-shield" }
            }
        }
    }
}

/// The panel beside the chat. `closing` fades it out while the screen keeps it a moment.
#[component]
pub fn SidePanel(of: Of, tab: Signal<Tab>, closing: bool) -> Element {
    let chats = use_context::<Signal<Chats>>();
    let hub = use_context::<Signal<crate::state::Hub>>();
    let key = of.key();
    let c = chats.read();
    let items: Vec<ChatItem> = c.get(&key).map(|e| e.chat.items.clone()).unwrap_or_default();
    let info = c.get(&key).and_then(|e| e.chat.info.clone());
    drop(c);
    let changes = changes::changes(&items);
    let pages = super::pages::session_page_count(&of.here, &hub.read());
    let running = changes::running(info.as_ref());
    let on = tab();
    let list = tabs(changes.len(), running, pages, on);
    let at = list.iter().position(|t| t.0 == on).unwrap_or(0);
    let ids: Vec<Tab> = list.iter().map(|t| t.0).collect();
    let mut tab_w = tab;
    let route = use_context::<Signal<crate::route::Route>>();
    // the tab row scrolls sideways like every other (kit.rs Segmented): the picked tab comes into
    // view and a hidden end fades
    // (again when a tab comes or goes, such as Blueprints once the session has pages)
    let at_id = format!("pp-tab-{}", on.id());
    let n_tabs = list.len();
    use_effect(use_reactive!(|at_id, n_tabs| {
        let _ = n_tabs;
        dom::strip_show("pp-tabs", &at_id)
    }));
    // the width it was dragged to, or while it's being dragged, the width under the pointer
    let live = use_signal(|| None::<f64>);
    let [width, min_width, max_width] = layout::panel_box(live().unwrap_or(super::notices::PREFS.read().panel_width));
    rsx! {
        aside { id: PANEL_ID, class: if closing { "pp fade-out" } else { "pp pp-in" }, width, min_width, max_width, "aria-label": "Side panel",
            ResizeHandle { live }
            div {
                id: "pp-tabs",
                class: "pp-tabs",
                role: "tablist",
                "aria-label": "Side panel",
                onscroll: move |_| dom::strip_edges("pp-tabs"),
                onresize: move |_| dom::strip_edges("pp-tabs"),
                onkeydown: move |e: KeyboardEvent| {
                    if let Some(n) = super::kit::arrow_step(&e.key(), at, ids.len()) {
                        e.prevent_default();
                        tab_w.set(ids[n]);
                        dom::focus(&format!("pp-tab-{}", ids[n].id()));
                    }
                },
                for (t , label , badge) in list {
                    button {
                        key: "{t.id()}",
                        id: "pp-tab-{t.id()}",
                        class: if t == on { "pp-tab pp-tab-on" } else { "pp-tab" },
                        r#type: "button",
                        role: "tab",
                        "aria-selected": "{t == on}",
                        tabindex: if t == on { "0" } else { "-1" },
                        onclick: move |_| tab_w.set(t),
                        "{label}"
                        if let Some(n) = badge {
                            span { class: "pp-badge tabular", "{n}" }
                        }
                    }
                }
            }
            // each tab's body fades in as it takes over
            div { class: "pp-col",
            div { key: "{on.id()}", class: "pp-body fade-in",
                match on {
                    Tab::Changes => rsx! { ChangesTab { host: of.host.clone(), pane: of.pane.clone(), changes, on_composed: None } },
                    Tab::Files => rsx! { FilesTab { key: "{key}", host: of.host.clone(), pane: of.pane.clone(), on_composed: None } },
                    Tab::Activity => rsx! { ActivityTab { host: of.host.clone(), pane: of.pane.clone(), info: info.clone() } },
                    Tab::Pages => rsx! { super::pages::SidePages { here: of.here.clone(), side: of.side } },
                    Tab::Usage => {
                        let compact = of.compact.clone().map(|c| {
                            let (host, pane, agent) = (of.host.clone(), of.pane.clone(), of.agent);
                            EventHandler::new(move |_| {
                                super::session_menu::run(
                                    super::session_menu::SessionAct { host: host.clone(), pane: pane.clone(), agent, op: super::session_menu::SessionOp::Send(c.clone(), "Could not compact") },
                                    route,
                                )
                            })
                        });
                        rsx! {
                            div { class: "pp-pad",
                                super::usage::UsagePanel { status: of.status.clone(), info: info.clone(), agent: of.agent, on_compact: compact }
                            }
                        }
                    }
                }
            }
            }
        }
    }
}

/// The phone's Activity sheet: Running, Changes, Files and Blueprints, the panel's own
/// bodies.
#[component]
pub fn ActivitySheet(of: Of, open: bool, on_close: EventHandler<()>) -> Element {
    let chats = use_context::<Signal<Chats>>();
    let hub = use_context::<Signal<crate::state::Hub>>();
    let mut tab = use_signal(|| Tab::Activity);
    let key = of.key();
    let c = chats.read();
    let items: Vec<ChatItem> = c.get(&key).map(|e| e.chat.items.clone()).unwrap_or_default();
    let info = c.get(&key).and_then(|e| e.chat.info.clone());
    drop(c);
    let pages = super::pages::session_page_count(&of.here, &hub.read());
    let mut options = vec![("activity".to_string(), "Running".to_string()), ("changes".into(), "Changes".into()), ("files".into(), "Files".into())];
    if pages > 0 || tab() == Tab::Pages {
        options.push(("pages".into(), "Blueprints".into()));
    }
    let on = tab();
    let composed = EventHandler::new(move |_| on_close.call(()));
    let seen = use_hook(|| Rc::new(Cell::new(*MENTIONED.peek())));
    use_effect(move || {
        let n = MENTIONED();
        if seen.replace(n) != n {
            on_close.call(());
        }
    });
    rsx! {
        Sheet { open, on_close, wide: true, title: "Activity",
            div { class: "pp-sheet-tabs",
                Segmented {
                    value: on.id().to_string(),
                    options,
                    full: true,
                    label: "Activity",
                    on_change: move |v: String| {
                        tab.set(match v.as_str() {
                            "changes" => Tab::Changes,
                            "files" => Tab::Files,
                            "pages" => Tab::Pages,
                            _ => Tab::Activity,
                        })
                    },
                }
            }
            div { class: "pp-sheet-wrap",
                    div { key: "{on.id()}", class: "pp-sheet-body fade-in",
                match on {
                    Tab::Changes => rsx! { ChangesTab { host: of.host.clone(), pane: of.pane.clone(), changes: changes::changes(&items), on_composed: composed } },
                    Tab::Files => rsx! { FilesTab { host: of.host.clone(), pane: of.pane.clone(), on_composed: composed } },
                    Tab::Pages => rsx! { div { class: "pp-pad", super::pages::PhonePages { here: of.here.clone() } } },
                    _ => rsx! { ActivityTab { host: of.host.clone(), pane: of.pane.clone(), info: info.clone() } },
                }
                    }
            }
        }
    }
}

/// The sheets the panel opens over the session: a comment on a diff line, a task's output and a
/// subagent's conversation. Mounted once by the session's screen.
#[component]
pub fn PanelSheets(of: Of) -> Element {
    // a task or subagent picked in one session isn't opened again in the next
    let key = of.key();
    use_effect(use_reactive!(|key| {
        let _ = key;
        *TASK.write() = None;
        *SUB.write() = None;
    }));
    rsx! {
        CommentSheet {}
        TaskOutputSheet { host: of.host.clone(), pane: of.pane.clone() }
        SubagentSheet { host: of.host.clone(), pane: of.pane.clone(), ctx: of.ctx.clone() }
    }
}

// ---------- changes ----------

const CHANGES_KEY: &str = "inyon.changes";

#[component]
fn ChangesTab(host: String, pane: String, changes: Vec<FileChange>, on_composed: Option<EventHandler<()>>) -> Element {
    let mut tree = use_signal(|| platform::load(CHANGES_KEY).as_deref() == Some("tree"));
    let mut pick = move |t: bool| {
        tree.set(t);
        platform::save(CHANGES_KEY, if t { "tree" } else { "chat" });
    };
    // what the chat has done lately, an edit once more when its result comes: the tree looks again
    let poke = changes.iter().flat_map(|c| &c.edits).map(|e| 1 + usize::from(e.done)).sum::<usize>();
    rsx! {
        div { class: "pp-col",
            div { class: "pp-seg",
                Segmented {
                    value: if tree() { "tree" } else { "chat" },
                    options: vec![("chat".into(), "This chat".into()), ("tree".into(), "Working tree".into())],
                    full: true,
                    label: "Changes",
                    on_change: move |v: String| pick(v == "tree"),
                }
            }
            div { class: "pp-col",
                div { key: "{tree()}", class: "pp-col fade-in",
                    if tree() {
                        WorkingTree { host: host.clone(), pane: pane.clone(), poke }
                    } else {
                        ChatChanges { host: host.clone(), pane: pane.clone(), changes, on_tree: move |_| pick(true) }
                    }
                }
            }
            ReviewBar { host, pane, on_composed }
        }
    }
}

fn dir_of(p: &str) -> &str {
    &p[..p.rfind('/').map_or(0, |i| i + 1)]
}

fn name_of(p: &str) -> &str {
    p.rsplit('/').next().unwrap_or(p)
}

#[component]
fn ChatChanges(host: String, pane: String, changes: Vec<FileChange>, on_tree: EventHandler<()>) -> Element {
    let mut sel = use_signal(|| None::<String>);
    if changes.is_empty() {
        // edits made with shell commands aren't edit tools: git sees them
        return rsx! {
            Empty {
                icon: Icon::FileDiff,
                title: "No changes yet",
                action: rsx! {
                    button { class: "button button-sm button-ghost press", r#type: "button", onclick: move |_| on_tree.call(()), "Show working tree" }
                },
                "Files the agent edits in this conversation show up here with their diffs. Edits it makes through commands show under Working tree."
            }
        };
    }
    let cur = sel().and_then(|s| changes.iter().find(|c| c.path == s).cloned()).unwrap_or_else(|| changes[0].clone());
    let now = platform::clock().now;
    let review = inyon_protocol::chat_key(&host, &pane);
    rsx! {
        div { class: "pp-col",
            div { class: "pp-files",
                for c in changes.iter().cloned() {
                    button {
                        key: "{c.path}",
                        class: if c.path == cur.path { "pp-file pp-file-on" } else { "pp-file" },
                        r#type: "button",
                        title: "{c.path}",
                        onclick: { let p = c.path.clone(); move |_| sel.set(Some(p.clone())) },
                        span { class: if c.created { "pp-status mono fg-ok" } else { "pp-status mono" }, if c.created { "A" } else { "M" } }
                        span { class: "pp-file-name truncate",
                            span { class: "fg-3", {f::short_path(Some(dir_of(&c.path)), 30)} }
                            "{name_of(&c.path)}"
                        }
                        span { class: "pp-counts mono tabular",
                            span { class: "fg-ok", "+{c.add}" }
                            " "
                            span { class: "fg-danger", "−{c.del}" }
                        }
                    }
                }
            }
            div { class: "pp-scroll",
                for (n , e) in cur.edits.iter().rev().cloned().enumerate() {
                    div { key: "{cur.path}-{n}", class: "pp-edit",
                        div { class: "pp-edit-head",
                            span { class: "pp-edit-word", {changes::edit_word(&e)} }
                            span { {format!("{} ago", f::since(e.ts.clone(), now))} }
                        }
                        EditDiff { e, file: cur.path.clone(), review: review.clone() }
                    }
                }
            }
        }
    }
}

#[component]
fn EditDiff(e: Edit, file: String, review: String) -> Element {
    let hunks = changes::hunks(e.meta.as_ref(), &e.input);
    if e.name == "ApplyPatch" && hunks.is_empty() {
        let patch = e.input.get("patch").and_then(|v| v.as_str()).unwrap_or("").to_string();
        return rsx! { pre { class: "pp-raw mono", "{patch}" } };
    }
    if hunks.is_empty() {
        return rsx! { div { class: "pp-note", "No diff recorded" } };
    }
    rsx! { DiffView { hunks, file, review: Some(review) } }
}

/// A diff with its line numbers; with `review` (the session), each number takes a comment.
#[component]
pub fn DiffView(hunks: Vec<Hunk>, file: String, #[props(default)] review: Option<String>, #[props(default = 400)] max: usize) -> Element {
    let (rows, hidden) = changes::rows(&hunks, max);
    let marked: Vec<(u32, bool)> =
        review.as_ref().map_or(vec![], |k| REVIEW.read().get(k).map_or(vec![], |l| l.iter().filter(|n| n.file == file).map(|n| (n.line, n.removed)).collect()));
    rsx! {
        div { class: "diff mono",
            table {
                tbody {
                    for (i , r) in rows.into_iter().enumerate() {
                        match r {
                            Row::Gap => rsx! {
                                tr { key: "{i}", td { class: "diff-gap", colspan: "3", "⋯" } }
                            },
                            Row::Line(l) => {
                                let on = marked.contains(&(l.no, l.removed));
                                let sign = if l.add { "+" } else if l.removed { "−" } else { " " };
                                let text = if l.text.is_empty() { " ".to_string() } else { l.text.clone() };
                                rsx! {
                                    tr { key: "{i}", class: if l.add { "diff-add" } else if l.removed { "diff-del" } else { "" },
                                        td { class: "diff-no pp-no",
                                            if let Some(k) = review.clone() {
                                                button {
                                                    class: if on { "diff-no-button diff-no-on" } else { "diff-no-button" },
                                                    r#type: "button",
                                                    title: "Comment on this line",
                                                    "aria-label": if l.removed { format!("Comment on removed line {}", l.no) } else { format!("Comment on line {}", l.no) },
                                                    onclick: { let (k, file, l) = (k.clone(), file.clone(), l.clone()); move |_| *COMMENTING.write() = Some((k.clone(), file.clone(), l.clone())) },
                                                    "{l.no}"
                                                }
                                            } else {
                                                span { "{l.no}" }
                                            }
                                        }
                                        td { class: if l.add { "diff-sign fg-ok" } else if l.removed { "diff-sign fg-danger" } else { "diff-sign fg-3" }, "{sign}" }
                                        td { class: "diff-text", "{text}" }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            if hidden > 0 {
                div { class: "diff-more", "{hidden} more lines" }
            }
        }
    }
}

/// Comments on diff lines wait here until they go into the message box together.
#[component]
fn ReviewBar(host: String, pane: String, on_composed: Option<EventHandler<()>>) -> Element {
    let key = inyon_protocol::chat_key(&host, &pane);
    let notes = REVIEW.read().get(&key).cloned().unwrap_or_default();
    let mut open = use_signal(|| false);
    if notes.is_empty() {
        return rsx! {};
    }
    let n = notes.len();
    let send = {
        let (key, notes) = (key.clone(), notes.clone());
        move |_| {
            if !super::composer::compose(&host, &pane, &changes::review_message(&notes)) {
                toast::toast("Open the chat to add them", None, ToastTone::Info);
                return;
            }
            REVIEW.write().remove(&key);
            open.set(false);
            if let Some(h) = on_composed {
                h.call(());
            }
        }
    };
    let clear = {
        let key = key.clone();
        move |_| {
            REVIEW.write().remove(&key);
        }
    };
    rsx! {
        div { class: "pp-review",
            if open() {
                ul { class: "pp-review-list",
                    for note in notes {
                        li { key: "{note.file}:{note.line}:{note.removed}", class: "pp-review-note",
                            span { class: "pp-review-text",
                                span { class: "mono fg-3", "{name_of(&note.file)}:{note.line}" }
                                " {note.text}"
                            }
                            button {
                                class: "icon-button press",
                                r#type: "button",
                                "aria-label": "Delete comment",
                                title: "Delete comment",
                                onclick: { let (key, note) = (key.clone(), note.clone()); move |_| remove_note(&key, &note) },
                                Glyph { icon: Icon::X, size: 14 }
                            }
                        }
                    }
                }
            }
            div { class: "pp-review-bar",
                button { class: "pp-review-count press", r#type: "button", "aria-expanded": "{open()}", onclick: move |_| open.toggle(),
                    Glyph { icon: Icon::MessageSquare, size: 16, class: "fg-3" }
                    if n == 1 { "1 comment" } else { "{n} comments" }
                }
                button { class: "button button-xs button-ghost press", r#type: "button", onclick: clear, "Clear" }
                button { class: "button button-xs button-primary press", r#type: "button", onclick: send, "Add to message" }
            }
        }
    }
}

fn remove_note(key: &str, n: &Note) {
    let mut all = REVIEW.write();
    if let Some(list) = all.get_mut(key) {
        list.retain(|x| !x.on(&n.file, n.line, n.removed));
        if list.is_empty() {
            all.remove(key);
        }
    }
}

/// Writes a comment on one diff line.
#[component]
fn CommentSheet() -> Element {
    let at = COMMENTING();
    let mut text = use_signal(String::new);
    let old = at.as_ref().and_then(|(k, file, l)| REVIEW.peek().get(k).and_then(|list| list.iter().find(|n| n.on(file, l.no, l.removed)).cloned()));
    // a new line to comment on starts from its own comment
    {
        let at = at.clone();
        use_effect(use_reactive!(|at| {
            let old = at.as_ref().and_then(|(k, file, l)| REVIEW.peek().get(k).and_then(|list| list.iter().find(|n| n.on(file, l.no, l.removed)).map(|n| n.text.clone())));
            text.set(old.unwrap_or_default());
        }));
    }
    let close = move || *COMMENTING.write() = None;
    let save = {
        let at = at.clone();
        move || {
            let Some((k, file, l)) = at.clone() else { return };
            let n = Note { file, line: l.no, removed: l.removed, code: l.text.clone(), text: text.peek().clone() };
            if text.peek().trim().is_empty() {
                remove_note(&k, &n);
            } else {
                changes::add_note(REVIEW.write().entry(k).or_default(), n);
            }
            *COMMENTING.write() = None;
        }
    };
    let deleting = old.is_some() && text().trim().is_empty();
    let title = at.as_ref().map(|(_, file, l)| format!("{}, line {}", name_of(file), l.no)).unwrap_or_default();
    let code = at.as_ref().map(|(_, _, l)| format!("{}{}", if l.removed { "− " } else { "" }, if l.text.is_empty() { " " } else { &l.text })).unwrap_or_default();
    let save_key = save.clone();
    let save_btn = save.clone();
    rsx! {
        Sheet {
            open: at.is_some(),
            on_close: move |_| close(),
            title,
            icon: rsx! { Glyph { icon: Icon::MessageSquare, size: 16, class: "fg-3" } },
            footer: rsx! {
                div { class: "sheet-actions",
                    button { class: "button button-md button-ghost press", r#type: "button", onclick: move |_| *COMMENTING.write() = None, "Cancel" }
                    button { class: "button button-md button-primary press", r#type: "button", onclick: move |_| save_btn(), if deleting { "Delete comment" } else { "Save comment" } }
                }
            },
            pre { class: "pp-comment-code mono", "{code}" }
            textarea {
                id: "pp-comment",
                class: "field pp-comment-box",
                rows: "4",
                placeholder: "What should change here?",
                "aria-label": "Comment",
                value: "{text}",
                autofocus: true,
                oninput: move |e| text.set(e.value()),
                onkeydown: move |e: KeyboardEvent| {
                    if e.key() == Key::Enter && (e.modifiers().meta() || e.modifiers().ctrl()) {
                        e.prevent_default();
                        save_key();
                    }
                },
            }
            p { class: "pp-hint", "Comments wait under the diff until you add them all to your message." }
        }
    }
}

// ---------- working tree ----------

fn status_tone(s: &str) -> (&'static str, &'static str) {
    match s {
        "A" => ("A", "fg-ok"),
        "?" => ("U", "fg-ok"),
        "D" => ("D", "fg-danger"),
        "R" => ("R", ""),
        _ => ("M", ""),
    }
}

/// What git sees in the session's folder: every change since the last commit, whoever made it.
#[component]
fn WorkingTree(host: String, pane: String, poke: usize) -> Element {
    let (git, mut rev) = use_load((host.clone(), pane.clone()), |(h, p): (String, String)| async move { api::git(&h, &p).await });
    let mut sel = use_signal(|| None::<String>);
    let mut msg = use_signal(String::new);
    let mut busy = use_signal(|| None::<&'static str>);
    // the agent did something: look again, a moment later
    let first = use_hook(|| Rc::new(Cell::new(true)));
    use_effect(use_reactive!(|poke| {
        let _ = poke;
        if first.replace(false) {
            return;
        }
        spawn(async move {
            platform::sleep(1500).await;
            rev += 1;
        });
    }));
    // a file picked from its right-click menu
    use_effect(move || {
        if let Some(p) = TREE_PICK() {
            sel.set(Some(p));
            *TREE_PICK.write() = None;
        }
    });
    let g = git.read();
    if g.data.is_none() && g.busy && g.error.is_none() {
        return rsx! { WaitRows { label: "Reading git status", class: "pp-wait" } };
    }
    if let Some(e) = &g.error {
        return rsx! { Empty { icon: Icon::FolderGit2, title: "Couldn't read git", "{e}" } };
    }
    let Some(s) = g.data.clone().filter(|s| s.repo) else {
        return rsx! { Empty { icon: Icon::FolderGit2, title: "Not a git repository", "The session's folder isn't in a git repository, so there's no working tree to show." } };
    };
    let reading = g.busy;
    drop(g);
    let cur = sel().and_then(|p| s.files.iter().find(|f| f.path == p).cloned()).or_else(|| s.files.first().cloned());
    let ahead = s.ahead.unwrap_or(0.0);
    let behind = s.behind.unwrap_or(0.0);
    // something to push, and somewhere to push it
    let can_push = s.remote == Some(true) && (s.upstream.is_none() || ahead > 0.0);
    let run = {
        let (host, pane) = (host.clone(), pane.clone());
        move |what: &'static str| {
            let (host, pane) = (host.clone(), pane.clone());
            busy.set(Some(what));
            spawn(async move {
                let r = if what == "commit" {
                    let message = msg.peek().clone();
                    api::git_commit(&host, &pane, &message).await.map(|c| {
                        // a message typed while it committed stays
                        if *msg.peek() == message {
                            msg.set(String::new());
                        }
                        format!("Committed {}", c.commit)
                    })
                } else {
                    api::git_push(&host, &pane).await.map(|_| "Pushed".to_string())
                };
                match r {
                    Ok(t) => toast::toast(t, None, ToastTone::Success),
                    Err(e) => toast::toast(if what == "commit" { "Could not commit" } else { "Could not push" }, Some(e.message), ToastTone::Error),
                }
                rev += 1;
                busy.set(None);
            });
        }
    };
    let mut push = run.clone();
    let mut commit = run.clone();
    let push_title = s.upstream.as_ref().map_or_else(|| "Push to origin".to_string(), |u| format!("Push to {u}"));
    let root = s.root.clone();
    let files_len = s.files.len();
    rsx! {
        div { class: "pp-col",
            div { class: "pp-branch",
                Glyph { icon: Icon::GitBranch, size: 14, class: "fg-3" }
                span { class: "pp-branch-name truncate", {s.branch.clone().unwrap_or_default()} }
                if ahead > 0.0 {
                    span { class: "pp-ahead tabular fg-3", title: "{ahead} commits not pushed", Glyph { icon: Icon::ArrowUp, size: 12 } "{ahead}" }
                }
                if behind > 0.0 {
                    span { class: "pp-ahead tabular fg-3", title: "{behind} commits to pull", Glyph { icon: Icon::ArrowDown, size: 12 } "{behind}" }
                }
                span { class: "pp-grow" }
                if can_push {
                    button { class: "button button-xs button-ghost press", r#type: "button", title: "{push_title}", disabled: busy().is_some(), onclick: move |_| push("push"),
                        if busy() == Some("push") { "Pushing…" } else { "Push" }
                    }
                }
                button { class: "icon-button press", r#type: "button", "aria-label": "Refresh", title: "Refresh", onclick: move |_| rev += 1,
                    Glyph { icon: Icon::RefreshCw, size: 14, class: if reading { "spin" } else { "" } }
                }
            }
            if s.files.is_empty() {
                Empty { icon: Icon::FileDiff, title: "No changes", "Nothing has changed since the last commit." }
            } else {
                div { class: "pp-files",
                    for gf in s.files.iter().cloned() {
                        {
                            let (label, tone) = status_tone(&gf.status);
                            let full = root.as_ref().map_or(gf.path.clone(), |r| format!("{r}/{}", gf.path));
                            let mut items = vec![Item::new("Show diff", Icon::FileDiff, Action::Panel(PanelOp::ShowDiff(gf.path.clone())))];
                            if gf.status != "D" {
                                items.push(Item::new("Mention in message", Icon::AtSign, Action::Panel(PanelOp::Mention { host: host.clone(), pane: pane.clone(), path: gf.path.clone() })));
                            }
                            items.push(Item::copy("Copy path", &full));
                            let title = gf.from.as_ref().map_or(gf.path.clone(), |from| format!("{from} → {}", gf.path));
                            rsx! {
                                button {
                                    key: "{gf.path}",
                                    class: if cur.as_ref().is_some_and(|c| c.path == gf.path) { "pp-file pp-file-on" } else { "pp-file" },
                                    r#type: "button",
                                    title: "{title}",
                                    oncontextmenu: menu::open(items),
                                    onclick: { let p = gf.path.clone(); move |_| sel.set(Some(p.clone())) },
                                    span { class: "pp-status mono {tone}", "{label}" }
                                    span { class: "pp-file-name truncate",
                                        span { class: "fg-3", "{dir_of(&gf.path)}" }
                                        "{name_of(&gf.path)}"
                                    }
                                    if gf.status != "?" {
                                        span { class: "pp-counts mono tabular",
                                            span { class: "fg-ok", "+{gf.add}" }
                                            " "
                                            span { class: "fg-danger", "−{gf.del}" }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                if let Some(c) = cur {
                    // read again with the status: Refresh, the agent's edits, a file coming or going
                    TreeDiff { key: "{c.path}:{poke}:{files_len}:{rev}", host: host.clone(), pane: pane.clone(), path: c.path.clone() }
                }
                form {
                    class: "pp-commit",
                    onsubmit: move |e: FormEvent| {
                        e.prevent_default();
                        if !msg.peek().trim().is_empty() && busy.peek().is_none() {
                            commit("commit");
                        }
                    },
                    input { class: "field pp-input", value: "{msg}", placeholder: "Commit message", "aria-label": "Commit message", oninput: move |e| msg.set(e.value()) }
                    button { class: "button button-sm button-primary press", r#type: "submit", title: "Commit every change shown here", disabled: msg().trim().is_empty() || busy().is_some(),
                        if busy() == Some("commit") { "Committing…" } else { "Commit all" }
                    }
                }
            }
        }
    }
}

#[component]
fn TreeDiff(host: String, pane: String, path: String) -> Element {
    let (d, _) = use_load((host.clone(), pane.clone(), path.clone()), |(h, p, f): (String, String, String)| async move { api::git_diff(&h, &p, &f).await });
    let review = inyon_protocol::chat_key(&host, &pane);
    let d = d.read();
    rsx! {
        div { class: "pp-scroll",
            if d.data.is_none() && d.busy {
                Waiting { label: "Reading the diff", lines: 4 }
            } else if let Some(e) = &d.error {
                div { class: "pp-note", "{e}" }
            } else if let Some(diff) = &d.data {
                if diff.binary {
                    div { class: "pp-note", "A binary file; no diff to show." }
                } else if diff.hunks.is_empty() {
                    div { class: "pp-note", "No line changes (only its mode or an empty file)." }
                } else {
                    DiffView { hunks: diff.hunks.iter().map(Hunk::from).collect::<Vec<_>>(), file: path.clone(), review: Some(review) }
                }
            }
        }
    }
}

// ---------- files ----------

fn join(dir: &str, name: &str) -> String {
    if dir.is_empty() {
        name.to_string()
    } else {
        format!("{dir}/{name}")
    }
}

/// The session's folder, read only: browse it, read a file, mention one in your message.
#[component]
fn FilesTab(host: String, pane: String, on_composed: Option<EventHandler<()>>) -> Element {
    let mut path = use_signal(String::new);
    let mut open = use_signal(|| None::<String>);
    let (dir, mut rev) = use_load((host.clone(), pane.clone(), path()), |(h, p, d): (String, String, String)| async move { api::dir(&h, &p, &d).await });
    // a file or folder picked from its right-click menu
    let seen = use_hook(|| Rc::new(Cell::new(FILES_GO.peek().as_ref().map_or(0, |g| g.0))));
    use_effect(move || {
        if let Some((n, is_dir, p)) = FILES_GO() {
            if n > seen.get() {
                seen.set(n);
                if is_dir {
                    path.set(p);
                } else {
                    open.set(Some(p));
                }
            }
        }
    });
    if let Some(f) = open() {
        return rsx! { FileViewer { host, pane, path: f, on_back: move |_| open.set(None), on_composed } };
    }
    let here = path();
    let crumbs: Vec<String> = if here.is_empty() { vec![] } else { here.split('/').map(str::to_string).collect() };
    let d = dir.read();
    let cwd = d.data.as_ref().map(|x| x.cwd.clone()).unwrap_or_default();
    let top = cwd.rsplit('/').next().filter(|s| !s.is_empty()).unwrap_or("Folder").to_string();
    rsx! {
        div { class: "pp-col",
            div { class: "pp-crumbs",
                button { class: "pp-crumb pp-crumb-top press", r#type: "button", title: "{cwd}", onclick: move |_| path.set(String::new()), "{top}" }
                for (i , c) in crumbs.iter().enumerate() {
                    span { key: "{i}", class: "pp-crumb-step",
                        Glyph { icon: Icon::ChevronRight, size: 12, class: "fg-3" }
                        button { class: "pp-crumb press", r#type: "button", onclick: { let to = crumbs[..=i].join("/"); move |_| path.set(to.clone()) }, "{c}" }
                    }
                }
                span { class: "pp-grow" }
                button { class: "icon-button press", r#type: "button", "aria-label": "Refresh", title: "Refresh", onclick: move |_| rev += 1,
                    Glyph { icon: Icon::RefreshCw, size: 14, class: if d.busy { "spin" } else { "" } }
                }
            }
            div { class: "pp-scroll pp-list",
                if let Some(e) = &d.error {
                    Empty { icon: Icon::Folder, title: "Couldn't open this folder", "{e}" }
                } else if (d.data.is_none() || d.stale) && d.busy {
                    // the folder before stays out of reach while this one is read
                    WaitRows { label: "Reading the folder", class: "pp-wait" }
                } else if d.data.as_ref().is_none_or(|x| x.entries.is_empty()) {
                    Empty { icon: Icon::Folder, title: "Empty folder" }
                } else if let Some(listing) = &d.data {
                    for e in listing.entries.iter().cloned() {
                        {
                            let rel = join(&here, &e.name);
                            let items = vec![
                                Item::new("Open", if e.dir { Icon::Folder } else { Icon::File }, Action::Panel(PanelOp::Open(e.dir, rel.clone()))),
                                Item::new("Mention in message", Icon::AtSign, Action::Panel(PanelOp::Mention { host: host.clone(), pane: pane.clone(), path: if e.dir { format!("{rel}/") } else { rel.clone() } })),
                                Item::copy("Copy path", &format!("{cwd}/{rel}")),
                            ];
                            rsx! {
                                button {
                                    key: "{e.name}",
                                    class: "pp-entry press",
                                    r#type: "button",
                                    oncontextmenu: menu::open(items),
                                    onclick: { let (rel, is_dir) = (rel.clone(), e.dir); move |_| if is_dir { path.set(rel.clone()) } else { open.set(Some(rel.clone())) } },
                                    Glyph { icon: if e.dir { Icon::Folder } else { Icon::File }, size: 16, class: "fg-3" }
                                    span { class: if e.name.starts_with('.') { "pp-entry-name truncate fg-3" } else { "pp-entry-name truncate" }, "{e.name}" }
                                    if !e.dir {
                                        span { class: "pp-size tabular fg-3", {f::bytes(e.size)} }
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

#[component]
fn FileViewer(host: String, pane: String, path: String, on_back: EventHandler<()>, on_composed: Option<EventHandler<()>>) -> Element {
    let (file, _) = use_load((host.clone(), pane.clone(), path.clone()), |(h, p, f): (String, String, String)| async move { api::file(&h, &p, &f).await });
    let mut raw = use_signal(|| false);
    let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    let md = ext == "md";
    let v = file.read();
    let is_text = matches!(v.data, Some(api::FileView::Text { .. }));
    let mention = {
        let (host, pane, path) = (host.clone(), pane.clone(), path.clone());
        move |_| {
            if mention(&host, &pane, &path) {
                if let Some(h) = on_composed {
                    h.call(());
                }
            }
        }
    };
    rsx! {
        div { class: "pp-col",
            div { class: "pp-viewer-head",
                button { class: "icon-button press", r#type: "button", "aria-label": "Back to the folder", title: "Back to the folder", onclick: move |_| on_back.call(()),
                    Glyph { icon: Icon::ArrowLeft, size: 16 }
                }
                span { class: "pp-viewer-path truncate", title: "{path}", "{path}" }
                if md && is_text {
                    button { class: "button button-xs button-ghost press", r#type: "button", onclick: move |_| raw.toggle(), if raw() { "Rendered" } else { "Source" } }
                }
                button { class: "button button-xs button-ghost press", r#type: "button", title: "Add @path to your message", onclick: mention,
                    Glyph { icon: Icon::AtSign, size: 14 }
                    "Mention"
                }
            }
            div { class: "pp-scroll pp-viewer",
                if let Some(e) = &v.error {
                    div { class: "pp-note", "{e}" }
                } else {
                    match &v.data {
                        None => rsx! { Waiting { label: "Reading the file", lines: 6 } },
                        Some(api::FileView::Image { mime, data, .. }) => rsx! {
                            div { class: "pp-image", img { src: "data:{mime};base64,{data}", alt: "{path}" } }
                        },
                        Some(api::FileView::Binary { size, .. }) => rsx! {
                            Empty { icon: Icon::File, title: "Not a text file", {format!("{} of binary data.", f::bytes(*size))} }
                        },
                        Some(api::FileView::Large { size, .. }) => rsx! {
                            Empty { icon: Icon::File, title: "Too large to show", {format!("{}.", f::bytes(*size))} }
                        },
                        Some(api::FileView::Text { text, truncated, size, .. }) if md && !raw() => rsx! {
                            div { class: "pp-md", super::md::Markdown { text: text.clone() } }
                            if *truncated {
                                div { class: "pp-truncated", {format!("Showing the first 512 KB of {}.", f::bytes(*size))} }
                            }
                        },
                        Some(api::FileView::Text { text, truncated, size, .. }) => rsx! {
                            pre { class: "pp-code mono", code { "{text}" } }
                            if *truncated {
                                div { class: "pp-truncated", {format!("Showing the first 512 KB of {}.", f::bytes(*size))} }
                            }
                        },
                    }
                }
            }
        }
    }
}

// ---------- activity ----------

#[component]
fn StopButton(host: String, task: BackgroundTask) -> Element {
    let mut busy = use_signal(|| false);
    rsx! {
        button {
            class: "pp-stop press",
            r#type: "button",
            disabled: busy(),
            onclick: move |e: MouseEvent| {
                e.stop_propagation();
                busy.set(true);
                let (host, task) = (host.clone(), task.clone());
                spawn(async move {
                    match api::stop_task(&host, &task.id, task.output_file.as_deref()).await {
                        Ok(r) => toast::toast(if r.stopped { "Task stopped" } else { "Already finished" }, None, if r.stopped { ToastTone::Success } else { ToastTone::Info }),
                        Err(e) => toast::toast("Could not stop", Some(e.message), ToastTone::Error),
                    }
                    busy.set(false);
                });
            },
            if busy() { "Stopping…" } else { "Stop" }
        }
    }
}

#[component]
fn ActRow(
    icon: Icon,
    title: String,
    sub: String,
    #[props(default)] live: bool,
    #[props(default)] on_open: Option<EventHandler<()>>,
    #[props(default)] right: Option<Element>,
) -> Element {
    rsx! {
        div { class: "pp-act",
            span { class: if live { "pp-act-icon pp-act-live" } else { "pp-act-icon" }, Glyph { icon, size: 16 } }
            button { class: "pp-act-text", r#type: "button", disabled: on_open.is_none(), onclick: move |_| if let Some(h) = on_open { h.call(()) },
                span { class: "pp-act-title truncate", "{title}" }
                span { class: "pp-act-sub truncate",
                    if live {
                        span { class: "pp-live-dot" }
                    }
                    "{sub}"
                }
            }
            if let Some(r) = right {
                {r}
            }
        }
    }
}

fn task_icon(t: &BackgroundTask) -> Icon {
    match t.r#type {
        TaskType::Monitor => Icon::Timer,
        TaskType::Workflow => Icon::Workflow,
        _ => Icon::SquareTerminal,
    }
}

fn status_word(s: TaskStatus) -> &'static str {
    match s {
        TaskStatus::Running => "Running",
        TaskStatus::Completed => "Completed",
        TaskStatus::Failed => "Failed",
        TaskStatus::Stopped => "Stopped",
    }
}

/// The line under a task: running for how long, or how and when it ended.
pub fn task_line(t: &BackgroundTask, now: f64) -> String {
    match (t.status, t.r#type) {
        (TaskStatus::Running, TaskType::Monitor) => t.started_at.as_ref().map_or("Watching".into(), |s| format!("Watching · {}", f::since(s.clone(), now))),
        (TaskStatus::Running, _) => format!("Running · {}", t.started_at.as_ref().map(|s| f::since(s.clone(), now)).unwrap_or_default()),
        // a monitor that ended says when it ended, as a task does
        (s, TaskType::Monitor) => format!("{}{}", status_word(s).to_lowercase(), t.ended_at.as_ref().map(|x| format!(" · {} ago", f::since(x.clone(), now))).unwrap_or_default()),
        (s, _) => format!("{}{}", status_word(s), t.ended_at.as_ref().map(|x| format!(" · {} ago", f::since(x.clone(), now))).unwrap_or_default()),
    }
}

/// The line under a subagent: its kind, how it's doing, and whether it runs in the background.
pub fn sub_line(a: &SubagentInfo, now: f64) -> String {
    let state = match a.status {
        SubagentStatus::Running => format!("running {}", a.started_at.as_ref().map(|s| f::since(s.clone(), now)).unwrap_or_default()),
        SubagentStatus::Error => "failed".into(),
        // the record says when it started, not when it finished
        SubagentStatus::Done => "done".into(),
    };
    format!("{} · {state}{}", a.r#type.as_deref().unwrap_or("agent"), if a.background == Some(true) { " · background" } else { "" })
}

#[component]
fn ActivityTab(host: String, pane: String, info: Option<ChatInfo>) -> Element {
    let Some(info) = info else {
        return rsx! { WaitRows { label: "Reading the session", class: "pp-wait" } };
    };
    let now = platform::clock().now;
    let tasks: Vec<BackgroundTask> = info.tasks.iter().rev().cloned().collect();
    let shells: Vec<BackgroundTask> = tasks.iter().filter(|t| t.r#type != TaskType::Monitor).cloned().collect();
    let monitors: Vec<BackgroundTask> = tasks.iter().filter(|t| t.r#type == TaskType::Monitor).cloned().collect();
    let subs: Vec<SubagentInfo> = info.subagents.iter().rev().cloned().collect();
    let arts: Vec<inyon_protocol::ArtifactInfo> = info.artifacts.iter().rev().cloned().collect();
    if tasks.is_empty() && subs.is_empty() && arts.is_empty() && info.queue.is_empty() {
        return rsx! { Empty { icon: Icon::Layers, title: "Nothing running", "Background shells, monitors, subagents and artifacts from this session appear here." } };
    }
    let task_row = |t: BackgroundTask, monitor: bool| {
        let host = host.clone();
        let running = t.status == TaskStatus::Running;
        let open = t.clone();
        rsx! {
            ActRow {
                key: "{t.id}",
                icon: if monitor { Icon::Timer } else { task_icon(&t) },
                title: t.description.clone(),
                sub: task_line(&t, now),
                live: running,
                on_open: move |_| *TASK.write() = Some(open.clone()),
                right: running.then(|| rsx! { StopButton { host: host.clone(), task: t.clone() } }),
            }
        }
    };
    rsx! {
        div { class: "pp-pad pp-groups",
            if !info.queue.is_empty() {
                section { class: "pp-group",
                    h3 { class: "pp-group-title", "Queued messages" }
                    for (i , q) in info.queue.iter().enumerate() {
                        div { key: "{i}", class: "pp-queued truncate", "{q}" }
                    }
                }
            }
            if !subs.is_empty() {
                section { class: "pp-group",
                    h3 { class: "pp-group-title", "Subagents" }
                    for a in subs {
                        ActRow {
                            key: "{a.tool_use_id}",
                            icon: Icon::Bot,
                            title: a.description.clone(),
                            sub: sub_line(&a, now),
                            live: a.status == SubagentStatus::Running,
                            on_open: { let a = a.clone(); move |_| *SUB.write() = Some(a.clone()) },
                        }
                    }
                }
            }
            if !shells.is_empty() {
                section { class: "pp-group",
                    h3 { class: "pp-group-title", "Background tasks" }
                    for t in shells {
                        {task_row(t, false)}
                    }
                }
            }
            if !monitors.is_empty() {
                section { class: "pp-group",
                    h3 { class: "pp-group-title", "Monitors" }
                    for t in monitors {
                        {task_row(t, true)}
                    }
                }
            }
            if !arts.is_empty() {
                section { class: "pp-group",
                    h3 { class: "pp-group-title", "Artifacts" }
                    for a in arts {
                        {
                            let title = a.title.clone().unwrap_or_else(|| "Artifact".into());
                            let updated = a.updated_at.as_ref().map(|u| format!("updated {} ago", f::since(u.clone(), now))).unwrap_or_default();
                            let (url, url2, url3) = (a.url.clone(), a.url.clone(), a.url.clone());
                            let (host, pane) = (host.clone(), pane.clone());
                            let name = a.title.clone().unwrap_or_else(|| a.url.clone());
                            rsx! {
                                ActRow {
                                    key: "{a.url}",
                                    icon: Icon::LayoutPanelLeft,
                                    title,
                                    sub: updated,
                                    on_open: move |_| dom::open_tab(&url),
                                    right: rsx! {
                                        div { class: "pp-act-buttons",
                                            button {
                                                class: "icon-button icon-button-md press",
                                                r#type: "button",
                                                title: "Copy link",
                                                "aria-label": "Copy link",
                                                onclick: move |_| {
                                                    let u = url2.clone();
                                                    spawn(async move {
                                                        if dom::copy(&u).await {
                                                            toast::toast("Link copied", None, ToastTone::Success);
                                                        }
                                                    });
                                                },
                                                Glyph { icon: Icon::Copy, size: 14 }
                                            }
                                            button {
                                                class: "icon-button icon-button-md icon-button-danger press",
                                                r#type: "button",
                                                title: "Ask the agent to delete it",
                                                "aria-label": "Ask the agent to delete it",
                                                onclick: move |_| {
                                                    let (host, pane, u, name) = (host.clone(), pane.clone(), url3.clone(), name.clone());
                                                    spawn(async move {
                                                        let ask = Ask { title: "Delete this artifact?".into(), body: Some(format!("The agent is asked to delete “{name}”.")), yes: "Ask to delete".into(), danger: true, ..Ask::default() };
                                                        if toast::confirm(ask).await {
                                                            if let Err(e) = api::send(&host, &pane, &format!("Delete the artifact {u}"), &dom::random_id()).await {
                                                                toast::toast("Could not send", Some(e.message), ToastTone::Error);
                                                            }
                                                        }
                                                    });
                                                },
                                                Glyph { icon: Icon::Trash2, size: 14 }
                                            }
                                        }
                                    },
                                }
                            }
                        }
                    }
                    p { class: "pp-hint", "Artifacts open on claude.ai in your browser, where you're signed in." }
                }
            }
        }
    }
}

/// Whether a scrolled box shows its end, give or take a line.
pub fn at_bottom(top: f64, height: f64, client: f64) -> bool {
    height - top - client < 24.0
}

/// How often a running task's output is read while its sheet is open (the sheet says so).
const TASK_REFRESH_MS: u32 = 3000;

#[component]
fn TaskOutputSheet(host: String, pane: String) -> Element {
    let chats = use_context::<Signal<Chats>>();
    // the task as the session reports it now, so one that ends while it's open says so
    let task = TASK().map(|t| {
        let c = chats.read();
        let now = c.get(&inyon_protocol::chat_key(&host, &pane)).and_then(|e| e.chat.info.as_ref()).and_then(|i| i.tasks.iter().find(|x| x.id == t.id).cloned());
        now.unwrap_or(t)
    });
    let mut out = use_signal(|| None::<String>);
    let gen = use_hook(|| Rc::new(Cell::new(0u32)));
    let shown = use_hook(|| Rc::new(RefCell::new(None::<String>)));
    let id = task.as_ref().map(|t| (t.id.clone(), t.output_file.clone(), t.status));
    {
        let host = host.clone();
        use_effect(use_reactive!(|id| {
            let n = gen.get() + 1;
            gen.set(n);
            // the same task read once more (it ended) keeps its output on screen meanwhile
            let same = id.as_ref().is_some_and(|i| shown.borrow().as_deref() == Some(i.0.as_str()));
            *shown.borrow_mut() = id.as_ref().map(|i| i.0.clone());
            if !same {
                out.set(None);
            }
            let Some((id, path, status)) = id.clone() else { return };
            let (host, gen) = (host.clone(), gen.clone());
            spawn(async move {
                loop {
                    let r = api::task_output(&host, &id, path.as_deref()).await;
                    if gen.get() != n {
                        return;
                    }
                    let text = match r {
                        Ok(o) => o.output,
                        Err(e) => format!("Could not read output: {}", e.message),
                    };
                    // followed to its end while you're at the end; read further up, it stays put
                    let first = out.peek().is_none();
                    let at_end = dom::scroll_metrics("pp-task-output").is_none_or(|(top, height, client)| at_bottom(top, height, client));
                    if out.peek().as_deref() != Some(text.as_str()) {
                        out.set(Some(text));
                        if first || at_end {
                            platform::sleep(30).await;
                            dom::set_scroll_top("pp-task-output", 1e9);
                        }
                    }
                    if status != TaskStatus::Running {
                        return;
                    }
                    // only while it's on screen; a hidden app doesn't need it every few seconds
                    loop {
                        platform::sleep(TASK_REFRESH_MS).await;
                        if gen.get() != n {
                            return;
                        }
                        if dom::visible() {
                            break;
                        }
                    }
                }
            });
        }));
    }
    let title = task.as_ref().map(|t| t.description.clone()).unwrap_or_default();
    let foot = task
        .as_ref()
        .map(|t| {
            if t.status == TaskStatus::Running {
                format!("Live · refreshes every {} seconds", TASK_REFRESH_MS / 1000)
            } else {
                t.summary.clone().unwrap_or_else(|| status_word(t.status).to_lowercase())
            }
        })
        .unwrap_or_default();
    let command = task.as_ref().and_then(|t| t.command.clone());
    rsx! {
        Sheet { open: task.is_some(), on_close: move |_| *TASK.write() = None, wide: true, title, icon: rsx! { Glyph { icon: Icon::SquareTerminal, size: 16, class: "fg-3" } },
            if let Some(c) = command {
                pre { class: "pp-command mono",
                    span { class: "fg-3", "$ " }
                    "{c}"
                }
            }
            pre { id: "pp-task-output", class: "pp-output mono", {out().unwrap_or_else(|| "Loading…".into())} }
            div { class: "pp-hint", "{foot}" }
        }
    }
}

/// The subagent's own transcript: the one its tool call names, else the one with its description
/// when only one has it, never a guess between two.
fn subagent_file<'a>(list: &'a [api::SubagentFile], tool: &str, desc: &str) -> Option<&'a api::SubagentFile> {
    if let Some(hit) = list.iter().find(|x| x.tool_use_id.as_deref() == Some(tool)) {
        return Some(hit);
    }
    let mut same = list.iter().filter(|x| x.tool_use_id.is_none() && x.description.as_deref() == Some(desc));
    let one = same.next()?;
    same.next().is_none().then_some(one)
}

#[component]
fn SubagentSheet(host: String, pane: String, ctx: Ctx) -> Element {
    let chats = use_context::<Signal<Chats>>();
    let key = inyon_protocol::chat_key(&host, &pane);
    let info = chats.read().get(&key).and_then(|e| e.chat.info.clone());
    // the subagent as the session reports it now, so one that finishes while it's open says so
    let sub = SUB().map(|s| info.as_ref().and_then(|i| i.subagents.iter().find(|x| x.tool_use_id == s.tool_use_id).cloned()).unwrap_or(s));
    let mut items = use_signal(|| None::<Vec<ChatItem>>);
    let mut err = use_signal(String::new);
    let gen = use_hook(|| Rc::new(Cell::new(0u32)));
    let shown = use_hook(|| Rc::new(RefCell::new(None::<String>)));
    let transcript = info.as_ref().and_then(|i| i.transcript_path.clone());
    let id = sub.as_ref().map(|s| (s.tool_use_id.clone(), s.description.clone(), s.status));
    {
        let host = host.clone();
        use_effect(use_reactive!(|id, transcript| {
            let n = gen.get() + 1;
            gen.set(n);
            // the same subagent read once more (it finished) keeps its conversation meanwhile
            let same = id.as_ref().is_some_and(|i| shown.borrow().as_deref() == Some(i.0.as_str()));
            *shown.borrow_mut() = id.as_ref().map(|i| i.0.clone());
            if !same {
                items.set(None);
                err.set(String::new());
            }
            let Some((tool, desc, status)) = id.clone() else { return };
            // tried again when the session's record turns up
            let Some(transcript) = transcript.clone() else {
                err.set("This session's conversation isn't available yet, so neither is the subagent's.".into());
                return;
            };
            let (host, gen) = (host.clone(), gen.clone());
            spawn(async move {
                loop {
                    let r = async {
                        let list = api::subagents(&host, &transcript).await.map_err(|e| e.message)?;
                        let Some(hit) = subagent_file(&list, &tool, &desc) else { return Err("This subagent did not save a transcript".to_string()) };
                        api::transcript(&host, &hit.path).await.map_err(|e| e.message)
                    }
                    .await;
                    if gen.get() != n {
                        return;
                    }
                    match r {
                        Ok(v) => {
                            err.set(String::new());
                            items.set(Some(v));
                        }
                        Err(e) => err.set(e),
                    }
                    if status != SubagentStatus::Running {
                        return;
                    }
                    loop {
                        platform::sleep(5000).await;
                        if gen.get() != n {
                            return;
                        }
                        if dom::visible() {
                            break;
                        }
                    }
                }
            });
        }));
    }
    let title = sub.as_ref().map(|s| s.description.clone()).unwrap_or_default();
    let running = sub.as_ref().is_some_and(|s| s.status == SubagentStatus::Running);
    let line = sub.as_ref().map(|s| {
        let state = match s.status {
            SubagentStatus::Running => "running · live",
            SubagentStatus::Done => "done",
            SubagentStatus::Error => "error",
        };
        format!("{} · {state}", s.r#type.clone().unwrap_or_else(|| "Subagent".into()))
    });
    let rows = items().map(|v| inyon_chat_core::chat::build_rows(&v));
    rsx! {
        Sheet { open: sub.is_some(), on_close: move |_| *SUB.write() = None, wide: true, title, icon: rsx! { Glyph { icon: Icon::Bot, size: 16, class: "fg-3" } },
            if let Some(l) = line {
                div { class: "pp-hint pp-sub-line", "{l}" }
            }
            if !err().is_empty() {
                div { class: "pp-error", "{err}" }
            } else if let Some(rows) = rows {
                div { class: "pp-transcript",
                    for (i , r) in rows.into_iter().enumerate() {
                        RowView { key: "{i}", row: inyon_chat_core::chat_list::ListRow::Row(r), ctx: ctx.clone(), working: running }
                    }
                }
            } else {
                Waiting { label: "Loading the subagent's conversation", lines: 4 }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_blueprints_tab_shows_only_with_pages_or_while_open() {
        let ids = |v: Vec<(Tab, &'static str, Option<usize>)>| v.into_iter().map(|t| t.1).collect::<Vec<_>>();
        assert_eq!(ids(tabs(0, 0, 0, Tab::Changes)), ["Changes", "Files", "Activity", "Usage"]);
        assert_eq!(ids(tabs(0, 0, 2, Tab::Changes)), ["Changes", "Files", "Activity", "Blueprints", "Usage"]);
        assert_eq!(ids(tabs(0, 0, 0, Tab::Pages)), ["Changes", "Files", "Activity", "Blueprints", "Usage"]);
        let t = tabs(3, 1, 0, Tab::Changes);
        assert_eq!((t[0].2, t[1].2, t[2].2), (Some(3), None, Some(1)));
    }

    #[test]
    fn task_and_subagent_lines_say_how_long_and_when_they_ended() {
        use inyon_chat_core::format::Moment;
        let now = "2026-11-05T10:01:30Z".ms();
        let iso = |s: &str| s.to_string();
        let t: BackgroundTask =
            serde_json::from_value(json!({ "id": "a", "type": "shell", "description": "build", "status": "running", "startedAt": iso("2026-11-05T10:00:00Z") })).unwrap();
        assert_eq!(task_line(&t, now), "Running · 1m 30s");
        let t: BackgroundTask =
            serde_json::from_value(json!({ "id": "a", "type": "shell", "description": "build", "status": "completed", "endedAt": iso("2026-11-05T10:01:25Z") })).unwrap();
        assert_eq!(task_line(&t, now), "Completed · 5s ago");
        let m: BackgroundTask = serde_json::from_value(json!({ "id": "m", "type": "monitor", "description": "ci", "status": "running" })).unwrap();
        assert_eq!(task_line(&m, now), "Watching");
        let m: BackgroundTask = serde_json::from_value(
            json!({ "id": "m", "type": "monitor", "description": "ci", "status": "completed", "startedAt": iso("2026-11-05T09:00:00Z"), "endedAt": iso("2026-11-05T10:01:25Z") }),
        )
        .unwrap();
        assert_eq!(task_line(&m, now), "completed · 5s ago");
        let a: SubagentInfo = serde_json::from_value(
            json!({ "toolUseId": "s", "type": "Explore", "description": "look", "status": "done", "background": true, "startedAt": iso("2026-11-05T10:01:25Z") }),
        )
        .unwrap();
        assert_eq!(sub_line(&a, now), "Explore · done · background");
    }
}
