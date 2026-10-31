//! Right-click menus (ui/ContextMenu.tsx): a right click, or a long press on a phone, on a message,
//! a code block or a reply opens a short list of what can be done with it. One menu at a time, drawn
//! over everything by [`MenuLayer`]; ↑/↓ move, Enter picks, Esc closes.

use dioxus::prelude::*;

use super::icons::{Glyph, Icon};
use crate::dom;

/// What an item does. Kept as data rather than a callback, so the menu still works after the row
/// that opened it has scrolled out of the list.
#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    Copy(String),
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
}

#[derive(Debug, Clone, PartialEq)]
pub struct Item {
    pub label: String,
    pub icon: Icon,
    pub action: Action,
    pub danger: bool,
}

impl Item {
    pub fn copy(label: &str, text: &str) -> Item {
        Item { label: label.into(), icon: Icon::Copy, action: Action::Copy(text.into()), danger: false }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Menu {
    x: f64,
    y: f64,
    items: Vec<Item>,
}

/// An `oncontextmenu` handler that opens a menu with `items` where the pointer is.
pub fn open(items: Vec<Item>) -> impl FnMut(Event<MouseData>) + 'static {
    let mut menu = use_context::<Signal<Option<Menu>>>();
    move |e: Event<MouseData>| {
        if items.is_empty() {
            return;
        }
        e.prevent_default();
        e.stop_propagation();
        let p = e.client_coordinates();
        menu.set(Some(Menu { x: p.x, y: p.y, items: items.clone() }));
    }
}

/// Where a menu of `n` items opens so it stays on a `w`×`h` screen: at the pointer, moved left or
/// up when it would run off the edge.
pub fn place(x: f64, y: f64, n: usize, w: f64, h: f64) -> (f64, f64) {
    const WIDTH: f64 = 220.0;
    let height = 12.0 + 40.0 * n as f64;
    let left = if x + WIDTH + 8.0 > w { (x - WIDTH).max(8.0) } else { x };
    let top = if y + height + 8.0 > h { (y - height).max(8.0) } else { y };
    (left, top)
}

const FIRST: &str = "menu-item-0";

#[component]
pub fn MenuLayer() -> Element {
    let mut menu = use_context::<Signal<Option<Menu>>>();
    let chats = use_context::<Signal<crate::state::Chats>>();
    // the first item takes focus as the menu opens, so the keys work at once
    use_effect(move || {
        if menu.read().is_some() {
            dom::focus(FIRST);
        }
    });
    let Some(m) = menu() else { return rsx! {} };
    let (w, h) = dom::viewport();
    let (left, top) = place(m.x, m.y, m.items.len(), w, h);
    let n = m.items.len();
    rsx! {
        div {
            class: "menu-backdrop",
            onclick: move |_| menu.set(None),
            oncontextmenu: move |e| {
                e.prevent_default();
                menu.set(None);
            },
        }
        div {
            class: "menu",
            role: "menu",
            style: "left:{left}px;top:{top}px",
            onkeydown: move |e: KeyboardEvent| {
                let at = dom::active_id().and_then(|id| id.strip_prefix("menu-item-").and_then(|i| i.parse::<usize>().ok()));
                match e.key() {
                    Key::Escape => menu.set(None),
                    Key::ArrowDown => dom::focus(&format!("menu-item-{}", at.map_or(0, |i| (i + 1) % n))),
                    Key::ArrowUp => dom::focus(&format!("menu-item-{}", at.map_or(n - 1, |i| (i + n - 1) % n))),
                    _ => return,
                }
                e.prevent_default();
            },
            for (i , item) in m.items.into_iter().enumerate() {
                button {
                    key: "{i}",
                    id: "menu-item-{i}",
                    class: if item.danger { "menu-item menu-danger" } else { "menu-item" },
                    role: "menuitem",
                    r#type: "button",
                    onclick: move |_| {
                        menu.set(None);
                        run(item.action.clone(), chats);
                    },
                    Glyph { icon: item.icon, size: 16 }
                    "{item.label}"
                }
            }
        }
    }
}

fn run(action: Action, chats: Signal<crate::state::Chats>) {
    match action {
        Action::Copy(text) => {
            spawn(async move {
                dom::copy(&text).await;
            });
        }
        Action::Retry { host, pane, id, text } => super::composer::retry(chats, host, pane, id, text),
        Action::Dismiss { key, id } => super::composer::dismiss(chats, &key, &id),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_menu_stays_on_the_screen() {
        assert_eq!(place(100.0, 100.0, 2, 390.0, 844.0), (100.0, 100.0));
        // near the right edge it opens to the left of the pointer, near the bottom above it
        assert_eq!(place(300.0, 820.0, 2, 390.0, 844.0), (80.0, 728.0));
        assert_eq!(place(10.0, 10.0, 3, 200.0, 100.0), (8.0, 8.0));
    }
}
