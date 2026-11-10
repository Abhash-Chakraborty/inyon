//! Right-click menus (ui/ContextMenu.tsx, components/menus.tsx): a right click, or a long press on
//! a touch screen, on anything listed (a machine, a session, a message, a code block, the terminal)
//! opens a short list of what can be done with it; its ⋯ button opens the same list. One menu at a
//! time, drawn over everything by [`MenuLayer`]; ↑/↓ move, Enter picks, Esc and back close it.
//! Everywhere else the app's own menu replaces the browser's: Cut, Copy and Paste in a text box,
//! Open and Copy link on a link, and the page menu on anything else ([`page_menu`]). Shift+right
//! click, and anything marked `data-native-menu`, keep the browser's own.

use dioxus::prelude::*;
use inyon_protocol::{HostKind, HostState, HostStatus};

use super::icons::{Glyph, Icon};
use crate::route::Route;
use crate::{dom, machines, platform};

/// What an item does. Kept as data rather than a callback, so the menu still works after the row
/// that opened it has scrolled out of the list.
#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    /// copies `text`; `what` names it for the toast that says so ("Session ID copied"), and a copy
    /// without one (the selection, a text box's) says nothing
    Copy {
        text: String,
        what: Option<String>,
    },
    /// Cut, Copy, Paste or Select all in the text box the menu was opened on
    Text(crate::dom::TextOp),
    /// back a page, past whatever layers are open (the page menu)
    Back,
    Reload,
    /// folds the sidebar to its rail, or opens it again
    Sidebar,
    /// send a message that failed again
    Retry {
        host: String,
        pane: String,
        id: String,
        text: String,
    },
    /// drop a message that failed
    Dismiss {
        key: String,
        id: String,
    },
    /// copy, paste or select in the terminal on screen
    Term(crate::term::MenuOp),
    /// a screen inside the app
    Go(Route),
    /// an address in a new tab
    NewTab(String),
    /// the New session sheet for a machine
    NewSession(String),
    /// the Rename (or, for SSH, Edit) sheet for a machine
    EditMachine(String),
    UpdateMachine(String),
    /// asks, then removes a machine from the hub
    RemoveMachine(String),
    /// what can be done to a page (components/pages/shared.tsx's page menu)
    /// boxed: a page's entry is far bigger than the other actions
    Page(Box<super::pages::PageOp>),
    /// a temp item or file (pages/Temp.tsx)
    Temp(super::temp::TempOp),
    /// a custom agent or a paired companion app in Settings
    Settings(super::settings::SettingsOp),
    /// asks, then ends a session: its agent exits and its pane closes (lib/end.ts)
    EndSession {
        host: String,
        pane: String,
    },
    /// the session header's ⋯: Remote Control, compact, rewind, fork, exit…
    Session(super::session_menu::SessionAct),
    /// the composer's model, effort and mode menus
    Control(super::controls::ControlAct),
    /// pins, parking, snoozes, tags and notes on one session or a selection (from 1.1)
    Org(super::organize::OrgOp),
    /// Quick access's own: a tab, a saved prompt sent, starred or removed (from 1.1)
    Quick(super::quick::QuickOp),
    /// the session side panel's: a mention, a file or folder to show, a diff to show
    Panel(super::panel::PanelOp),
    /// nothing: a heading, or an item that opens a submenu
    None,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Item {
    pub label: String,
    pub icon: Icon,
    pub action: Action,
    pub danger: bool,
    /// a hairline above it, starting a new group
    pub separated: bool,
    /// a second line under the label
    pub hint: Option<String>,
    /// its key, written on the right ("⌘K", "Alt N")
    pub keys: Option<String>,
    /// one of a few to pick from (a part of a page, a note), and whether it's the one picked
    pub checked: Option<bool>,
    /// an on/off of its own (`menuitemcheckbox`) rather than one choice of several
    pub toggle: bool,
    pub disabled: bool,
    /// opens these instead of doing something: beside the menu on a wide screen, in its place on a
    /// phone
    pub sub: Option<Vec<Item>>,
    /// a heading over the items after it, not something to pick
    pub header: bool,
}

impl Item {
    pub fn new(label: impl Into<String>, icon: Icon, action: Action) -> Item {
        Item { label: label.into(), icon, action, danger: false, separated: false, hint: None, keys: None, checked: None, toggle: false, disabled: false, sub: None, header: false }
    }

    /// An item that opens a submenu.
    pub fn sub(label: impl Into<String>, icon: Icon, items: Vec<Item>) -> Item {
        Item { sub: Some(items), ..Item::new(label, icon, Action::None) }
    }

    /// A heading in a menu ("3 sessions selected").
    pub fn header(label: impl Into<String>) -> Item {
        Item { header: true, ..Item::new(label, Icon::Ellipsis, Action::None) }
    }

    /// An item that copies `text` and says so: "Copy session ID" toasts "Session ID copied", and an
    /// item in a Copy submenu ("Folder path") names what it copies itself.
    pub fn copy(label: &str, text: &str) -> Item {
        Item::new(label, Icon::Copy, Action::Copy { text: text.into(), what: Some(copied_what(label)) })
    }

    pub fn hint(mut self, h: impl Into<String>) -> Item {
        self.hint = Some(h.into());
        self
    }

    /// A tick for an on/off of its own, such as a tag: read out as a checkbox, not a choice.
    pub fn toggled(mut self, on: bool) -> Item {
        self.checked = Some(on);
        self.toggle = true;
        self
    }

    pub fn keys(mut self, k: impl Into<String>) -> Item {
        self.keys = Some(k.into());
        self
    }

    pub fn checked(mut self, on: bool) -> Item {
        self.checked = Some(on);
        self
    }

    pub fn disabled(mut self, off: bool) -> Item {
        self.disabled = off;
        self
    }

    pub fn danger(mut self) -> Item {
        self.danger = true;
        self
    }

    pub fn separated(mut self) -> Item {
        self.separated = true;
        self
    }
}

/// What a copy item's toast calls what it copied: its label without "Copy ", from a capital.
fn copied_what(label: &str) -> String {
    let rest = label.strip_prefix("Copy ").unwrap_or(label);
    let mut c = rest.chars();
    c.next().map_or_else(String::new, |f| f.to_uppercase().chain(c).collect())
}

/// What a copy says when it's done (ContextMenu.tsx's copyItem).
pub fn copy_toast(what: &str, ok: bool) -> (String, super::toast::ToastTone) {
    if ok {
        (format!("{what} copied"), super::toast::ToastTone::Info)
    } else {
        ("Could not copy".into(), super::toast::ToastTone::Error)
    }
}

/// A key with ⌘ or ⌥ on a Mac, Ctrl or Alt elsewhere, as the web app writes it (lib/keys.ts).
pub fn key_label(mac: bool, cmd: bool, key: &str) -> String {
    match (mac, cmd) {
        (true, true) => format!("⌘{key}"),
        (true, false) => format!("⌥{key}"),
        (false, true) => format!("Ctrl {key}"),
        (false, false) => format!("Alt {key}"),
    }
}

/// Cut, Copy, Paste and Select all for the text box that was right-clicked.
pub fn text_items(b: crate::dom::TextBox, mac: bool) -> Vec<Item> {
    use crate::dom::TextOp;
    let mut v = vec![];
    if b.editable {
        v.push(Item::new("Cut", Icon::Scissors, Action::Text(TextOp::Cut)).keys(key_label(mac, true, "X")).disabled(!b.picked || b.secret));
    }
    v.push(Item::new("Copy", Icon::Copy, Action::Text(TextOp::Copy)).keys(key_label(mac, true, "C")).disabled(!b.picked || b.secret));
    if b.editable {
        v.push(Item::new("Paste", Icon::ClipboardPaste, Action::Text(TextOp::Paste)).keys(key_label(mac, true, "V")));
    }
    v.push(Item::new("Select all", Icon::TextSelect, Action::Text(TextOp::SelectAll)).keys(key_label(mac, true, "A")).separated());
    v
}

/// Open, open in a new tab (a link inside the app, where there are tabs) and copy, for a link.
pub fn link_items(href: &str, path: &str, outside: bool, tabs: bool) -> Vec<Item> {
    let inside = if outside { None } else { crate::route::internal(path) };
    let mut v = vec![match &inside {
        Some(r) => Item::new("Open link", Icon::ArrowRight, Action::Go(r.clone())),
        None => Item::new("Open link", Icon::ExternalLink, Action::NewTab(href.into())),
    }];
    if !outside && tabs {
        v.push(Item::new("Open in new tab", Icon::ExternalLink, Action::NewTab(href.into())));
    }
    v.push(Item { icon: Icon::Link2, ..Item::copy("Copy link", href) });
    v
}

/// The menu for a right click nothing on the page claimed (ContextMenu.tsx's fallbackMenu): a text
/// box's, a link's, or the page's own (Back while there's a page to go back to, Reload, then
/// `extra`: Search… and New session…), with Copy first while text is selected.
pub fn page_menu(at: &crate::dom::PageAt, picked: &str, back: bool, extra: Vec<Item>, mac: bool, tabs: bool) -> Vec<Item> {
    use crate::dom::PageAt;
    if let PageAt::TextBox(b) = at {
        return text_items(*b, mac);
    }
    let rest = match at {
        PageAt::Link { href, path, outside } => link_items(href, path, *outside, tabs),
        _ => {
            let mut v = vec![];
            if back {
                v.push(Item::new("Back", Icon::ArrowLeft, Action::Back));
            }
            v.push(Item::new("Reload", Icon::RotateCw, Action::Reload));
            v.extend(extra.into_iter().enumerate().map(|(i, it)| if i == 0 { it.separated() } else { it }));
            v
        }
    };
    with_copy(picked, rest, Some(key_label(mac, true, "C")))
}

/// `items` with Copy first while `picked` holds selected text.
fn with_copy(picked: &str, items: Vec<Item>, keys: Option<String>) -> Vec<Item> {
    if picked.trim().is_empty() {
        return items;
    }
    let copy = Item { keys, ..Item::new("Copy", Icon::Copy, Action::Copy { text: picked.into(), what: None }) };
    std::iter::once(copy).chain(items.into_iter().enumerate().map(|(i, it)| if i == 0 { it.separated() } else { it })).collect()
}

/// What can be done to a machine from wherever it's listed: its row's right-click menu and the ⋯
/// menu share it, in the web app's order. No new tabs in the phone app, which has none.
pub fn machine_menu(h: &HostState, tabs: bool) -> Vec<Item> {
    let id = h.config.id.clone();
    let page = Route::Machine { id: id.clone() };
    let paired = !(h.config.kind == HostKind::Node && h.config.paired_at.is_none());
    let mut v = vec![Item::new("Open", Icon::Server, Action::Go(page.clone()))];
    if paired && h.status == HostStatus::Online {
        v.push(Item::new("New session", Icon::Plus, Action::NewSession(id.clone())));
    }
    if tabs {
        v.push(Item::new("Open in new tab", Icon::ExternalLink, Action::NewTab(page.href())));
    }
    if paired {
        v.push(Item::new("Temp files", Icon::FolderOpen, Action::Go(Route::Temp { host: Some(id.clone()) })));
    }
    v.push(Item::new(if h.config.kind == HostKind::Ssh { "Edit…" } else { "Rename…" }, Icon::Pencil, Action::EditMachine(id.clone())).separated());
    if let Some(latest) = machines::can_update(h) {
        v.push(Item::new(format!("Update to inyon {latest}"), Icon::Download, Action::UpdateMachine(id.clone())));
    }
    if h.config.kind != HostKind::Local {
        v.push(Item::new("Remove…", Icon::Trash2, Action::RemoveMachine(id)).danger().separated());
    }
    v
}

/// A session listed on a machine's page.
pub fn pane_menu(host: &str, pane: &str, agent: bool, session_id: Option<&str>, tabs: bool) -> Vec<Item> {
    let chat = Route::Session { host: host.into(), pane: pane.into(), view: None };
    let mut v = vec![Item::new("Open", Icon::ArrowRight, Action::Go(chat.clone()))];
    if agent {
        v.push(Item::new(
            "Open terminal",
            Icon::SquareTerminal,
            Action::Go(Route::Session { host: host.into(), pane: pane.into(), view: Some(inyon_chat_core::overview::PaneView::Terminal) }),
        ));
    }
    if tabs {
        v.push(Item::new("Open in new tab", Icon::ExternalLink, Action::NewTab(chat.href())));
    }
    if let Some(id) = session_id {
        v.push(Item::copy("Copy session ID", id).separated());
    }
    v.push(Item::new("End session…", Icon::CircleX, Action::EndSession { host: host.into(), pane: pane.into() }).danger().separated());
    v
}

/// What a menu opens next to: a button, or the point that was right-clicked (a box of no size).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Anchor {
    pub left: f64,
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
    /// the menu's right edge lines up with the anchor's (a ⋯ button), else its left
    pub end: bool,
    /// how far from the anchor it opens
    pub gap: f64,
}

impl Anchor {
    pub fn point(x: f64, y: f64) -> Anchor {
        Anchor { left: x, top: y, right: x, bottom: y, end: false, gap: 2.0 }
    }

    fn of(id: &str, end: bool) -> Anchor {
        let (left, top, right, bottom) = dom::rect(id).unwrap_or((8.0, 8.0, 8.0, 8.0));
        Anchor { left, top, right, bottom, end, gap: 6.0 }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Menu {
    anchor: Anchor,
    items: Vec<Item>,
}

impl Menu {
    /// A menu of `items` opened at a point on the screen.
    pub fn at(x: f64, y: f64, items: Vec<Item>) -> Menu {
        Menu { anchor: Anchor::point(x, y), items }
    }

    /// Whether it's a message-box chip's menu, which must close when its session can't take picks.
    pub fn of_controls(&self) -> bool {
        self.items.iter().any(|i| matches!(i.action, Action::Control(_)))
    }
}

/// An `oncontextmenu` handler that opens a menu with `items` where the pointer is.
pub fn open(items: Vec<Item>) -> impl FnMut(Event<MouseData>) + 'static {
    open_with(move || items.clone())
}

/// An `oncontextmenu` handler for a menu whose items depend on the moment it opens (the
/// terminal's Copy, there only while text is selected). A right click on a text box or a link out
/// inside it gets that one's own menu instead, Shift or `data-native-menu` the browser's, and text
/// selected in it puts Copy first.
pub fn open_with(items: impl Fn() -> Vec<Item> + 'static) -> impl FnMut(Event<MouseData>) + 'static {
    let mut menu = use_context::<Signal<Option<Menu>>>();
    move |e: Event<MouseData>| {
        if e.modifiers().shift() {
            return;
        }
        let p = e.client_coordinates();
        let Some(picked) = dom::row_menu(&e.data(), p.x, p.y) else { return };
        let items = items();
        if items.is_empty() {
            return;
        }
        e.prevent_default();
        e.stop_propagation();
        menu.set(Some(Menu::at(p.x, p.y, with_copy(&picked, items, None))));
    }
}

/// A ⋯ button's menu, under the button with their right edges lined up (or over it when there's
/// more room above). `anchor` is the button's id.
pub fn drop_down(menu: &mut Signal<Option<Menu>>, anchor: &str, items: Vec<Item>) {
    if items.is_empty() {
        return;
    }
    menu.set(Some(Menu { anchor: Anchor::of(anchor, true), items }));
}

/// A chip's menu at the bottom of the screen (the composer's model, effort and mode): over the
/// chip with their left edges lined up, since that's where the room is.
pub fn drop_up(menu: &mut Signal<Option<Menu>>, anchor: &str, items: Vec<Item>) {
    if items.is_empty() {
        return;
    }
    menu.set(Some(Menu { anchor: Anchor::of(anchor, false), items }));
}

/// The tallest a menu gets before it scrolls (primitives.tsx's MenuPopup).
const MAX_HEIGHT: f64 = 420.0;

/// Where a menu sits: `top` or `bottom` (from the window's bottom edge, so it grows up from its
/// anchor), how far from the left, and how tall it may get before it scrolls.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Placed {
    pub left: f64,
    pub top: Option<f64>,
    pub bottom: Option<f64>,
    pub max_height: f64,
}

impl Placed {
    fn style(&self) -> String {
        // both edges every time: the page keeps an edge that's left out from the last placing
        let edge = match (self.top, self.bottom) {
            (Some(t), _) => format!("top:{t}px;bottom:auto"),
            (_, Some(b)) => format!("top:auto;bottom:{b}px"),
            _ => String::new(),
        };
        format!("left:{}px;{edge};max-height:{}px", self.left, self.max_height)
    }
}

/// Places a menu `wanted` px tall and `width` wide next to `a` (primitives.tsx's MenuPopup): below
/// it, or above when there's less room below than it needs and more above, shrunk to the room
/// there is when neither side has enough. `area` is the part of the window a keyboard leaves (top,
/// bottom), then the window's width and full height.
pub fn fit(a: Anchor, wanted: f64, width: f64, area: (f64, f64, f64, f64)) -> Placed {
    let (top, bottom, w, h) = (area.0 + 8.0, area.1 - 8.0, area.2, area.3);
    // a point the window shrank away from (a keyboard came up under it) counts as its edge
    let a = Anchor { top: a.top.clamp(top, bottom.max(top)), bottom: a.bottom.clamp(top, bottom.max(top)), ..a };
    let below = (bottom - a.bottom - a.gap).max(0.0);
    let above = (a.top - a.gap - top).max(0.0);
    let up = below < wanted.min(MAX_HEIGHT) && above > below;
    let width = width.min(w - 16.0);
    let left = if a.end { a.right - width } else { a.left };
    Placed {
        left: left.min(w - width - 8.0).max(8.0),
        top: (!up).then(|| (a.bottom + a.gap).min(bottom)),
        bottom: up.then(|| h - (a.top - a.gap).max(top)),
        max_height: MAX_HEIGHT.min(if up { above } else { below }),
    }
}

/// A first guess at a menu's height, for before the page has measured it (and for the native
/// build, where it can't).
fn guess(items: &[Item]) -> f64 {
    12.0 + 40.0 * rows(items) as f64
}

// ---------- a long press on a touch screen ----------

/// How long a finger rests before the menu opens, and how far it may move meanwhile.
const HOLD_MS: u32 = 500;
const SLOP: f64 = 10.0;

#[derive(Debug, Clone, PartialEq)]
struct Press {
    n: u64,
    x: f64,
    y: f64,
    /// the menu opened, so the click that follows the lift must not also open the row
    fired: bool,
    /// when the finger came up after the menu opened
    lifted: Option<f64>,
}

/// How long after the lift the click it brings still belongs to the press.
const LIFT_MS: f64 = 600.0;

impl Press {
    /// An event at `now` that this press brings after it opened the menu: the browser's own
    /// long-press context menu (while the finger is down, or as it lifts, depending on the
    /// platform) and the click the lift sends.
    fn owns(&self, now: f64) -> bool {
        self.fired && self.lifted.is_none_or(|t| now - t < LIFT_MS)
    }
}

static PRESS: GlobalSignal<Option<Press>> = Signal::global(|| None);
static PRESSES: GlobalSignal<u64> = Signal::global(|| 0);

/// The handlers that give a row its menu on a long press, for touch screens whose browser doesn't
/// send a right click for one. Put each on the row's matching event.
#[derive(Clone)]
pub struct LongPress {
    menu: Signal<Option<Menu>>,
    items: Vec<Item>,
}

pub fn long_press(items: Vec<Item>) -> LongPress {
    LongPress { menu: use_context::<Signal<Option<Menu>>>(), items }
}

impl LongPress {
    pub fn down(&self, e: &PointerEvent) {
        if e.pointer_type() != "touch" || self.items.is_empty() {
            return;
        }
        let p = e.client_coordinates();
        let n = *PRESSES.peek() + 1;
        *PRESSES.write() = n;
        *PRESS.write() = Some(Press { n, x: p.x, y: p.y, fired: false, lifted: None });
        let mut menu = self.menu;
        let items = self.items.clone();
        spawn(async move {
            platform::sleep(HOLD_MS).await;
            let at = PRESS.peek().clone();
            if let Some(p) = at.filter(|p| p.n == n && !p.fired) {
                if let Some(pr) = PRESS.write().as_mut() {
                    pr.fired = true;
                }
                buzz();
                menu.set(Some(Menu::at(p.x, p.y, items)));
            }
        });
    }

    pub fn moved(&self, e: &PointerEvent) {
        let p = e.client_coordinates();
        let far = PRESS.peek().as_ref().is_some_and(|s| !s.fired && ((p.x - s.x).abs() > SLOP || (p.y - s.y).abs() > SLOP));
        if far {
            *PRESS.write() = None;
        }
    }

    /// The finger lifted.
    pub fn up(&self) {
        lifted();
    }

    /// The browser took the touch for a scroll or another gesture: the press is forgotten.
    pub fn cancel(&self) {
        if PRESS.peek().as_ref().is_some_and(|p| !p.fired) {
            *PRESS.write() = None;
        }
    }

    /// The click after a lift: swallowed when the press opened the menu.
    pub fn click(&self, e: &MouseEvent) -> bool {
        if lift_click() {
            e.prevent_default();
            e.stop_propagation();
            return true;
        }
        false
    }
}

/// The firm buzz as a long press opens its menu (lib/haptics.ts's 'long'), when haptics are on.
fn buzz() {
    if super::notices::PREFS.peek().haptics {
        dom::vibrate(&LONG_BUZZ);
    }
}

const LONG_BUZZ: [u32; 1] = [40];

/// The finger came up: a press that didn't open the menu is forgotten, and one that did notes when,
/// so the click the lift brings is told apart from a later tap.
fn lifted() {
    let fired = PRESS.peek().as_ref().map(|p| p.fired);
    match fired {
        Some(false) => *PRESS.write() = None,
        Some(true) => {
            if let Some(p) = PRESS.write().as_mut() {
                p.lifted.get_or_insert(platform::clock().now);
            }
        }
        None => {}
    }
}

/// Whether a click is the one a long press brings when the finger lifts (it lands on whatever the
/// menu now covers); it's used up either way.
fn lift_click() -> bool {
    let owned = PRESS.peek().as_ref().is_some_and(|p| p.owns(platform::clock().now));
    if PRESS.peek().as_ref().is_some_and(|p| p.fired) {
        *PRESS.write() = None;
    }
    owned
}

/// Where a submenu of `n` rows opens beside the item at `item` (left, top, right): to its right,
/// or to its left when there's no room, and moved up to stay on the screen.
pub fn place_sub(item: (f64, f64, f64), n: usize, w: f64, h: f64) -> (f64, f64) {
    const WIDTH: f64 = 220.0;
    let (left, top, right) = item;
    let height = 12.0 + 40.0 * n as f64;
    let x = if right - 4.0 + WIDTH + 8.0 > w { (left - WIDTH + 4.0).max(8.0) } else { right - 4.0 };
    let y = if top - 6.0 + height + 8.0 > h { (h - 8.0 - height).max(8.0) } else { top - 6.0 };
    (x, y)
}

/// Where a submenu of `n` rows that takes the menu's place (a phone) starts: at the menu's top, or
/// moved up so its last rows stay on the screen. Past the screen's height it scrolls.
pub fn sub_top(top: f64, n: usize, h: f64) -> f64 {
    let height = 12.0 + 40.0 * n as f64;
    if top + height + 8.0 > h {
        (h - 8.0 - height).max(8.0)
    } else {
        top
    }
}

/// Below this width a submenu takes the menu's place instead of opening beside it.
const SIDE_BY_SIDE: f64 = 640.0;

/// How many 40px rows `items` take: a hint makes its row about half a row taller.
fn rows(items: &[Item]) -> usize {
    items.len() + items.iter().filter(|i| i.hint.is_some()).count().div_ceil(2)
}

/// Where item `i` of a menu at `top` starts, for when the page can't say (the native build).
fn row_top(items: &[Item], i: usize, top: f64) -> f64 {
    top + 6.0 + 40.0 * rows(&items[..i.min(items.len())]) as f64
}

/// The first item that can be picked, for the focus when a menu or submenu opens.
fn first_pick(items: &[Item]) -> usize {
    items.iter().position(|i| !i.header && !i.disabled).unwrap_or(0)
}

/// The next item from `at` that can be picked, going down (or up), round the end.
fn step(items: &[Item], at: Option<usize>, down: bool) -> usize {
    let n = items.len();
    let mut i = at.unwrap_or(if down { n - 1 } else { 0 });
    for _ in 0..n {
        i = if down { (i + 1) % n } else { (i + n - 1) % n };
        if !items[i].header && !items[i].disabled {
            return i;
        }
    }
    i
}

#[component]
pub fn MenuLayer() -> Element {
    let mut menu = use_context::<Signal<Option<Menu>>>();
    let chats = use_context::<Signal<crate::state::Chats>>();
    let here = use_context::<Signal<Route>>();
    let hub = use_context::<Signal<crate::state::Hub>>();
    // the submenu open now: which item of the menu holds it
    let mut open_sub = use_signal(|| None::<usize>);
    // back and Esc close it, as the newest layer
    let layer = super::back::use_layer(menu.read().is_some(), true, move || menu.set(None));
    // the menu's real height and width, once the page has drawn it, for the menu they're of
    let mut measured = use_signal(|| None::<(Anchor, usize, f64, f64)>);
    // the window, and what a keyboard leaves of it: the menu moves when they change
    let area = use_signal(dom::visible_area);
    use_hook(move || {
        dom::on_viewport(move || {
            let mut a = area;
            a.set(dom::visible_area());
        })
    });
    // the first item takes focus as the menu opens, so the keys work at once
    use_effect(move || {
        if let Some(m) = menu.read().as_ref() {
            open_sub.set(None);
            dom::focus(&format!("menu-item-{}", first_pick(&m.items)));
            if let (Some((_, full, _)), Some((l, _, r, _))) = (dom::scroll_metrics("menu-root"), dom::rect("menu-root")) {
                measured.set(Some((m.anchor, m.items.len(), full, r - l)));
            }
        }
    });
    let Some(m) = menu() else { return rsx! {} };
    let (_, _, w, h) = area();
    let narrow = w < SIDE_BY_SIDE;
    let (wanted, width) = measured().filter(|x| x.0 == m.anchor && x.1 == m.items.len()).map_or((guess(&m.items), 220.0), |x| (x.2, x.3));
    let placed = fit(m.anchor, wanted, width, area());
    let left = placed.left;
    // where its top edge is, for a submenu that opens in its place or beside one of its items
    let top = placed.top.unwrap_or_else(|| h - placed.bottom.unwrap_or(0.0) - wanted.min(placed.max_height));
    let style = placed.style();
    let grows_up = placed.bottom.is_some();
    let sub = open_sub().and_then(|i| m.items.get(i).and_then(|it| it.sub.clone().map(|s| (i, it.label.clone(), s))));
    let mut close_sub = move |back_to: usize| {
        open_sub.set(None);
        // on a narrow screen the menu comes back only once this has drawn
        spawn(async move {
            platform::sleep(10).await;
            dom::focus(&format!("menu-item-{back_to}"));
        });
    };
    let mut enter_sub = move |i: usize, items: &[Item]| {
        open_sub.set(Some(i));
        let first = first_pick(items);
        spawn(async move {
            // once it's drawn
            platform::sleep(10).await;
            dom::focus(&format!("menu-sub-{first}"));
        });
    };
    let main_items = m.items.clone();
    let main_keys = main_items.clone();
    let all_items = main_items.clone();
    rsx! {
        div {
            class: "menu-backdrop",
            // a long press opens the menu under the finger, so the lift's click and the browser's
            // own long-press context menu land here; neither closes it
            onpointerup: move |_| lifted(),
            onclick: move |_| {
                if !lift_click() {
                    menu.set(None);
                }
            },
            // a right click on something else closes this menu and opens that one's
            oncontextmenu: move |e| {
                e.prevent_default();
                let now = platform::clock().now;
                if PRESS.peek().as_ref().is_some_and(|p| p.owns(now)) {
                    return;
                }
                menu.set(None);
                let p = e.client_coordinates();
                if !dom::touch_press() {
                    spawn(async move {
                        // once the backdrop has gone
                        platform::sleep(20).await;
                        dom::context_menu_at(p.x, p.y);
                    });
                }
            },
        }
        if !(narrow && sub.is_some()) {
            div {
                id: "menu-root",
                class: if grows_up { "menu menu-up" } else { "menu" },
                role: "menu",
                style: "{style}",
                onkeydown: move |e: KeyboardEvent| {
                    let at = dom::active_id().and_then(|id| id.strip_prefix("menu-item-").and_then(|i| i.parse::<usize>().ok()));
                    match e.key() {
                        // closing the menu shouldn't also let go of the sessions picked
                        Key::Escape => {
                            e.stop_propagation();
                            menu.set(None);
                        }
                        Key::ArrowDown => dom::focus(&format!("menu-item-{}", step(&main_keys, at, true))),
                        Key::ArrowUp => dom::focus(&format!("menu-item-{}", step(&main_keys, at, false))),
                        Key::ArrowRight => match at.and_then(|i| main_keys.get(i).and_then(|it| it.sub.clone()).map(|s| (i, s))) {
                            Some((i, s)) => enter_sub(i, &s),
                            None => return,
                        },
                        _ => return,
                    }
                    e.prevent_default();
                },
                for (i , item) in main_items.into_iter().enumerate() {
                    {
                        let opens = item.sub.clone();
                        let on = open_sub() == Some(i);
                        rsx! {
                            MenuRow {
                                key: "{i}",
                                id: format!("menu-item-{i}"),
                                item: item.clone(),
                                first: i == 0,
                                expanded: on,
                                on_hover: move |_| {
                                    // on a pointer, resting on an item opens its submenu and leaves any other
                                    if narrow {
                                        return;
                                    }
                                    match &opens {
                                        Some(_) => open_sub.set(Some(i)),
                                        None if open_sub.peek().is_some() => open_sub.set(None),
                                        None => {}
                                    }
                                },
                                on_pick: {
                                    let item = item.clone();
                                    move |_| match &item.sub {
                                        Some(s) => enter_sub(i, s),
                                        None => {
                                            menu.set(None);
                                            layer.done();
                                            run(item.action.clone(), chats, here, hub);
                                        }
                                    }
                                },
                            }
                        }
                    }
                }
            }
        }
        if let Some((parent, label, items)) = sub {
            {
                let n = rows(&items);
                let (sx, sy) = if narrow {
                    // its Back row is one more
                    (left, sub_top(top, n + 1, h))
                } else {
                    let r = dom::rect(&format!("menu-item-{parent}"))
                        .map_or((left, row_top(&all_items, parent, top), left + 220.0), |(l, t, r, _)| (l, t, r));
                    place_sub(r, n, w, h)
                };
                let keys = items.clone();
                rsx! {
                    div {
                        class: "menu menu-sub",
                        role: "menu",
                        "aria-label": "{label}",
                        style: "left:{sx}px;top:{sy}px",
                        onkeydown: move |e: KeyboardEvent| {
                            let at = dom::active_id().and_then(|id| id.strip_prefix("menu-sub-").and_then(|i| i.parse::<usize>().ok()));
                            match e.key() {
                                Key::Escape | Key::ArrowLeft => close_sub(parent),
                                Key::ArrowDown => dom::focus(&format!("menu-sub-{}", step(&keys, at, true))),
                                Key::ArrowUp => dom::focus(&format!("menu-sub-{}", step(&keys, at, false))),
                                _ => return,
                            }
                            e.stop_propagation();
                            e.prevent_default();
                        },
                        if narrow {
                            button { class: "menu-item menu-back", r#type: "button", onclick: move |_| close_sub(parent),
                                Glyph { icon: Icon::ChevronLeft, size: 16 }
                                span { class: "menu-words truncate", "{label}" }
                            }
                        }
                        for (i , item) in items.into_iter().enumerate() {
                            MenuRow {
                                key: "{i}",
                                id: format!("menu-sub-{i}"),
                                item: item.clone(),
                                first: i == 0 && !narrow,
                                expanded: false,
                                on_hover: move |_| {},
                                on_pick: move |_| {
                                    menu.set(None);
                                    layer.done();
                                    run(item.action.clone(), chats, here, hub);
                                },
                            }
                        }
                    }
                }
            }
        }
    }
}

/// One row of a menu: an item, or a heading over the items after it.
#[component]
fn MenuRow(id: String, item: Item, first: bool, expanded: bool, on_hover: EventHandler<()>, on_pick: EventHandler<()>) -> Element {
    if item.header {
        return rsx! {
            div { class: if item.separated && !first { "menu-header menu-group" } else { "menu-header" }, role: "presentation", "{item.label}" }
        };
    }
    let class = match (item.danger, item.separated && !first) {
        (true, true) => "menu-item menu-danger menu-group",
        (true, false) => "menu-item menu-danger",
        (false, true) => "menu-item menu-group",
        (false, false) => "menu-item",
    };
    let opens = item.sub.is_some();
    rsx! {
        button {
            id: "{id}",
            class: if expanded { format!("{class} menu-open") } else { class.to_string() },
            role: match (item.checked, item.toggle) {
                (Some(_), true) => "menuitemcheckbox",
                (Some(_), false) => "menuitemradio",
                _ => "menuitem",
            },
            "aria-checked": item.checked.map(|on| if on { "true" } else { "false" }),
            "aria-haspopup": opens.then_some("menu"),
            "aria-expanded": opens.then_some(if expanded { "true" } else { "false" }),
            r#type: "button",
            disabled: item.disabled,
            onpointerenter: move |e: PointerEvent| {
                if e.pointer_type() == "mouse" {
                    on_hover.call(());
                }
            },
            // the click a long press brings as the finger lifts lands on whatever item the menu
            // opened under it; it isn't a pick
            onclick: move |e: MouseEvent| {
                if lift_click() {
                    e.prevent_default();
                    return;
                }
                on_pick.call(());
            },
            Glyph { icon: item.icon, size: 16 }
            if let Some(hint) = &item.hint {
                span { class: "menu-words",
                    span { class: "truncate", "{item.label}" }
                    span { class: "menu-hint truncate", "{hint}" }
                }
            } else {
                span { class: "menu-words truncate", "{item.label}" }
            }
            if let Some(k) = &item.keys {
                kbd { class: "menu-keys mono", "{k}" }
            }
            if item.checked == Some(true) {
                Glyph { icon: Icon::Check, size: 16, class: "menu-check" }
            }
            if opens {
                Glyph { icon: Icon::ChevronRight, size: 16, class: "menu-more" }
            }
        }
    }
}

pub fn run(action: Action, chats: Signal<crate::state::Chats>, mut here: Signal<Route>, hub: Signal<crate::state::Hub>) {
    match action {
        Action::Copy { text, what } => {
            spawn(async move {
                let ok = dom::copy(&text).await;
                if let Some(what) = what {
                    let (title, tone) = copy_toast(&what, ok);
                    super::toast::toast(title, None, tone);
                }
            });
        }
        Action::Text(op) => {
            spawn(async move {
                if !dom::text_op(op).await {
                    // the browser won't let a page read the clipboard: the keys still work
                    let keys = key_label(dom::mac(), true, "V");
                    super::toast::toast(format!("Press {keys} to paste"), Some("This browser doesn't let the menu read the clipboard.".into()), super::toast::ToastTone::Info);
                }
            });
        }
        Action::Back => super::back::page_back(),
        Action::Reload => dom::reload(),
        Action::Sidebar => super::shell::fold_sidebar(),
        Action::Retry { host, pane, id, text } => super::composer::retry(chats, host, pane, id, text),
        Action::Dismiss { key, id } => super::composer::dismiss(chats, &key, &id),
        Action::Term(op) => crate::term::menu(op),
        Action::Go(r) => crate::route::go(&mut here, r),
        Action::NewTab(url) => dom::open_tab(&url),
        Action::NewSession(host) => super::add::open_action(super::add::ActionSheet::NewSession(host)),
        Action::EditMachine(id) => super::add::open_action(super::add::ActionSheet::Edit(id)),
        Action::UpdateMachine(id) => {
            spawn(async move {
                if let Err(e) = crate::api::node_update(&id).await {
                    super::toast::toast("Could not update", Some(e.message), super::toast::ToastTone::Error);
                }
            });
        }
        Action::RemoveMachine(id) => {
            let Some(h) = hub.peek().hosts.iter().find(|h| h.config.id == id).cloned() else { return };
            spawn(async move {
                super::machines::remove(&h).await;
            });
        }
        Action::Page(op) => super::pages::run(*op, here, hub),
        Action::Temp(op) => super::temp::run(op),
        Action::Panel(op) => super::panel::run(op),
        Action::Settings(op) => super::settings::run(op),
        Action::Session(act) => super::session_menu::run(act, here),
        Action::Control(act) => super::controls::run(act),
        Action::EndSession { host, pane } => {
            // from the session's own screen, the Overview after
            let own = matches!(&*here.peek(), Route::Session { host: h, pane: p, .. } if *h == host && *p == pane);
            spawn(async move {
                super::session::end_session(hub, &host, &pane, own.then_some(here)).await;
            });
        }
        Action::Org(op) => super::organize::run(op, hub),
        Action::Quick(op) => super::quick::run(op, here, hub),
        Action::None => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_lift_after_a_long_press_does_not_close_its_menu() {
        let held = Press { n: 1, x: 0.0, y: 0.0, fired: true, lifted: None };
        // the browser's own long-press menu and a click while the finger is down belong to the press
        assert!(held.owns(1_000.0));
        let up = Press { lifted: Some(1_000.0), ..held.clone() };
        assert!(up.owns(1_300.0), "the context menu or click the lift brings");
        assert!(!up.owns(1_000.0 + LIFT_MS), "a later tap or right click closes the menu");
        let short = Press { fired: false, ..held };
        assert!(!short.owns(1_000.0), "a press that opened nothing owns nothing");
    }

    #[test]
    fn a_menu_opens_on_the_side_with_room_and_shrinks_when_neither_has_enough() {
        let screen = (0.0, 844.0, 390.0, 844.0);
        // a right click high up: below the point, as tall as it is
        let p = fit(Anchor::point(100.0, 100.0), 300.0, 240.0, screen);
        assert_eq!(p, Placed { left: 100.0, top: Some(102.0), bottom: None, max_height: 420.0f64.min(844.0 - 8.0 - 102.0) });
        // low down: above it, growing up from the point, kept off the right edge
        let p = fit(Anchor::point(300.0, 800.0), 300.0, 240.0, screen);
        assert_eq!((p.left, p.top, p.bottom), (142.0, None, Some(844.0 - 798.0)));
        assert_eq!(p.max_height, 420.0);
        // a ⋯ button: right edges lined up
        let button = Anchor { left: 340.0, top: 20.0, right: 372.0, bottom: 52.0, end: true, gap: 6.0 };
        assert_eq!(fit(button, 200.0, 220.0, screen).left, 152.0);
        // the keyboard is up: only the top 400px show, so a menu from a point at 300 goes up and shrinks
        let p = fit(Anchor::point(20.0, 300.0), 360.0, 240.0, (0.0, 400.0, 390.0, 844.0));
        assert_eq!((p.top, p.bottom, p.max_height), (None, Some(844.0 - 298.0), 290.0));
        // the window shrank under the point: it counts as the bottom edge, and the menu goes up
        let p = fit(Anchor::point(200.0, 548.0), 300.0, 200.0, (0.0, 420.0, 390.0, 420.0));
        assert_eq!((p.top, p.bottom, p.max_height), (None, Some(420.0 - 410.0), 402.0));
        assert_eq!(p.style(), "left:182px;top:auto;bottom:10px;max-height:402px");
        // a measured menu that fits below stays below, whatever 40px a row would have guessed
        let short = fit(Anchor::point(20.0, 600.0), 150.0, 240.0, screen);
        assert_eq!(short.top, Some(602.0));
    }

    #[test]
    fn a_submenu_opens_beside_its_item_and_stays_on_the_screen() {
        // room on the right: beside it, a little over the menu's edge
        assert_eq!(place_sub((100.0, 200.0, 320.0), 3, 1440.0, 900.0), (316.0, 194.0));
        // no room: on the left
        assert_eq!(place_sub((1200.0, 200.0, 1420.0), 3, 1440.0, 900.0), (984.0, 194.0));
        // near the bottom: moved up
        assert_eq!(place_sub((100.0, 860.0, 320.0), 4, 1440.0, 900.0), (316.0, 720.0));
    }

    #[test]
    fn a_submenu_in_the_menus_place_moves_up_to_fit() {
        // a 14-row tag list from a menu low on a phone moves up; a short one stays put
        assert_eq!(sub_top(500.0, 14, 844.0), 844.0 - 8.0 - 572.0);
        assert_eq!(sub_top(100.0, 3, 844.0), 100.0);
        // taller than the screen: from the top, and the list scrolls
        assert_eq!(sub_top(300.0, 14, 500.0), 8.0);
    }

    #[test]
    fn hinted_rows_count_as_taller_and_place_a_native_submenu_by_its_row() {
        let snooze: Vec<Item> = (0..4).map(|i| Item::copy(&format!("{i}"), "x").hint("9:00")).collect();
        // four hinted rows are about six plain ones, so the last one stays on the screen
        assert_eq!(rows(&snooze), 6);
        let (_, y) = place_sub((100.0, 760.0, 320.0), rows(&snooze), 1440.0, 900.0);
        assert!(y + 12.0 + 40.0 * 6.0 <= 892.0, "{y}");
        // without the page's measure, item 3 of a menu at 100 starts three rows down
        let menu = vec![Item::copy("A", "a"), Item::copy("B", "b"), Item::copy("C", "c"), Item::copy("D", "d")];
        assert_eq!(row_top(&menu, 3, 100.0), 226.0);
        assert_eq!(row_top(&menu, 0, 100.0), 106.0);
    }

    #[test]
    fn copy_items_say_what_they_copied() {
        let id = Item::copy("Copy session ID", "abc");
        assert_eq!(id.action, Action::Copy { text: "abc".into(), what: Some("Session ID".into()) });
        assert_eq!(copied_what("Copy message"), "Message");
        assert_eq!(copied_what("Folder path"), "Folder path", "an item in a Copy submenu names itself");
        assert_eq!(copied_what("tmux target"), "Tmux target");
        assert_eq!(copy_toast("Session ID", true).0, "Session ID copied");
        assert_eq!(copy_toast("Session ID", false), ("Could not copy".to_string(), super::super::toast::ToastTone::Error));
    }

    #[test]
    fn a_text_box_menu_cuts_copies_pastes_and_selects_all() {
        use crate::dom::{TextBox, TextOp};
        let m = text_items(TextBox { picked: true, editable: true, secret: false }, false);
        assert_eq!(labels(&m), ["Cut", "Copy", "Paste", "Select all"]);
        assert_eq!(m.iter().map(|i| i.keys.clone().unwrap()).collect::<Vec<_>>(), ["Ctrl X", "Ctrl C", "Ctrl V", "Ctrl A"]);
        assert_eq!(m[2].action, Action::Text(TextOp::Paste));
        assert!(m[3].separated && !m[0].disabled);
        // nothing selected, or a password: no Cut or Copy; read-only: nothing to cut or paste
        let none = text_items(TextBox { picked: false, editable: true, secret: false }, true);
        assert!(none[0].disabled && none[1].disabled);
        assert_eq!(none[0].keys.as_deref(), Some("⌘X"));
        assert!(text_items(TextBox { picked: true, editable: true, secret: true }, false)[1].disabled);
        assert_eq!(labels(&text_items(TextBox { picked: true, editable: false, secret: false }, false)), ["Copy", "Select all"]);
    }

    #[test]
    fn a_link_menu_opens_it_here_or_in_a_tab_and_copies_it() {
        let m = link_items("http://hub:4777/next/settings", "/next/settings", false, true);
        assert_eq!(labels(&m), ["Open link", "Open in new tab", "Copy link"]);
        assert_eq!(m[0].action, Action::Go(Route::Settings));
        assert_eq!(m[2].action, Action::Copy { text: "http://hub:4777/next/settings".into(), what: Some("Link".into()) });
        // a link out opens in a tab of its own; the phone app has no tabs
        let out = link_items("https://example.com/", "https://example.com/", true, true);
        assert_eq!(labels(&out), ["Open link", "Copy link"]);
        assert_eq!(out[0].action, Action::NewTab("https://example.com/".into()));
        assert_eq!(labels(&link_items("http://hub/next/", "/next/", false, false)), ["Open link", "Copy link"]);
    }

    #[test]
    fn the_page_menu_goes_back_reloads_then_offers_the_shells_own_with_copy_first() {
        use crate::dom::PageAt;
        let extra = || vec![Item::new("Search…", Icon::Search, Action::None), Item::new("New session…", Icon::Plus, Action::None)];
        let m = page_menu(&PageAt::Page, "", true, extra(), false, true);
        assert_eq!(labels(&m), ["Back", "Reload", "Search…", "New session…"]);
        assert_eq!((m[0].action.clone(), m[1].action.clone()), (Action::Back, Action::Reload));
        assert!(m[2].separated && !m[3].separated);
        // the first page of the tab has nowhere to go back to
        assert_eq!(labels(&page_menu(&PageAt::Page, "", false, extra(), false, true)), ["Reload", "Search…", "New session…"]);
        // selected text: Copy first, silently, with its key
        let m = page_menu(&PageAt::Page, "two words", true, extra(), true, true);
        assert_eq!(labels(&m), ["Copy", "Back", "Reload", "Search…", "New session…"]);
        assert_eq!((m[0].action.clone(), m[0].keys.as_deref()), (Action::Copy { text: "two words".into(), what: None }, Some("⌘C")));
        assert!(m[1].separated);
        let link = PageAt::Link { href: "http://hub/next/machines".into(), path: "/next/machines".into(), outside: false };
        assert_eq!(labels(&page_menu(&link, "x", true, extra(), false, true)), ["Copy", "Open link", "Open in new tab", "Copy link"]);
        // a text box gets its own menu, and the selection elsewhere doesn't matter to it
        let b = PageAt::TextBox(crate::dom::TextBox { picked: false, editable: true, secret: false });
        assert_eq!(labels(&page_menu(&b, "x", true, extra(), false, true)), ["Cut", "Copy", "Paste", "Select all"]);
    }

    #[test]
    fn selected_text_puts_copy_at_the_top_of_a_rows_menu() {
        let rows = vec![Item::copy("Copy message", "all of it")];
        let m = with_copy("part", rows.clone(), None);
        assert_eq!(labels(&m), ["Copy", "Copy message"]);
        assert!(m[1].separated && m[0].keys.is_none());
        assert_eq!(with_copy("  ", rows.clone(), None), rows);
    }

    #[test]
    fn the_keys_skip_headings_and_disabled_items() {
        let items = vec![Item::header("2 selected"), Item::copy("A", "a"), Item::copy("B", "b").disabled(true), Item::copy("C", "c")];
        assert_eq!(first_pick(&items), 1);
        assert_eq!(step(&items, Some(1), true), 3);
        assert_eq!(step(&items, Some(3), true), 1, "round the end, past the heading");
        assert_eq!(step(&items, Some(1), false), 3);
        assert_eq!(step(&items, None, true), 1);
    }

    fn host(v: serde_json::Value) -> HostState {
        let mut base = json!({ "config": { "id": "box", "name": "studio", "kind": "node", "pairedAt": 1 }, "status": "online",
            "integration": "installed", "tmux": "ok", "agents": ["claude"], "sessions": [], "updatedAt": 1 });
        if let (Some(b), Some(o)) = (base.as_object_mut(), v.as_object()) {
            for (k, x) in o {
                b.insert(k.clone(), x.clone());
            }
        }
        serde_json::from_value(base).unwrap()
    }

    fn labels(v: &[Item]) -> Vec<&str> {
        v.iter().map(|i| i.label.as_str()).collect()
    }

    #[test]
    fn a_machines_menu_offers_what_can_be_done_with_it_now() {
        let h = host(json!({ "nodeVersion": "0.22.0", "nodeUpdate": { "latest": "0.23.1", "supported": true } }));
        let m = machine_menu(&h, true);
        assert_eq!(labels(&m), ["Open", "New session", "Open in new tab", "Temp files", "Rename…", "Update to inyon 0.23.1", "Remove…"]);
        assert!(m[4].separated && m[6].separated && m[6].danger);
        assert_eq!(m[0].action, Action::Go(Route::Machine { id: "box".into() }));
        assert_eq!(m[2].action, Action::NewTab("/next/machines/box".into()));
        // offline, an SSH server, in the phone app: no new session, Edit, no tab
        let ssh = host(json!({ "config": { "id": "s", "name": "srv", "kind": "ssh", "target": "me@srv" }, "status": "error" }));
        assert_eq!(labels(&machine_menu(&ssh, false)), ["Open", "Temp files", "Edit…", "Remove…"]);
        // this hub can't be removed; a machine that never paired has no sessions or files yet
        let local = host(json!({ "config": { "id": "local", "name": "hub", "kind": "local" } }));
        assert_eq!(labels(&machine_menu(&local, true)), ["Open", "New session", "Open in new tab", "Temp files", "Rename…"]);
        let unpaired = host(json!({ "config": { "id": "n", "name": "new", "kind": "node" }, "status": "connecting" }));
        assert_eq!(labels(&machine_menu(&unpaired, true)), ["Open", "Open in new tab", "Rename…", "Remove…"]);
    }

    #[test]
    fn a_sessions_menu_opens_it_its_terminal_or_a_tab() {
        let m = pane_menu("box", "%3", true, Some("abc-123"), true);
        assert_eq!(labels(&m), ["Open", "Open terminal", "Open in new tab", "Copy session ID", "End session…"]);
        assert_eq!(m[2].action, Action::NewTab("/next/m/box/p/3".into()));
        assert!(m[4].danger && m[4].separated);
        assert_eq!(m[4].action, Action::EndSession { host: "box".into(), pane: "%3".into() });
        assert_eq!(labels(&pane_menu("box", "%4", false, None, false)), ["Open", "End session…"]);
        assert_eq!(machine_menu(&host(json!({})), true)[3].action, Action::Go(Route::Temp { host: Some("box".into()) }));
    }
}
