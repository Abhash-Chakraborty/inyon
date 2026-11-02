//! The frame around the pages: a sidebar from tablet width up, a tab bar on phones
//! (components/AppShell.tsx). This app has the Overview, the session screen and the Machines so
//! far; the other items open the web app's pages, so nothing here is a dead end. The layers every
//! page shares (menus, toasts, the confirm sheet, the sheets a menu opens, Can't connect?) are
//! mounted here once.

use dioxus::prelude::*;

use super::icons::{Glyph, Icon, Logo};
use super::menu::MenuLayer;
use super::overview::Overview;
use super::session::Session;
use super::{add, connect, machines, toast};
use crate::model::{self, AgentPane};
use crate::route::Route;
use crate::state::Hub;

/// The Overview page's key, beside the sessions' `host:pane` ones.
const OVERVIEW_KEY: &str = "overview";
const MACHINES_KEY: &str = "machines";

#[component]
pub fn Shell() -> Element {
    let here = use_context::<Signal<Route>>();
    let route = here();
    let section = match route {
        Route::Overview => Section::Overview,
        Route::Machines { .. } | Route::Machine { .. } => Section::Machines,
        Route::Session { .. } => Section::None,
    };
    rsx! {
        div { class: "shell",
            Sidebar { section }
            main { class: "main",
                match route {
                    Route::Overview => rsx! {
                        div { key: "{OVERVIEW_KEY}", class: "page", Overview {} }
                        TabBar { section }
                    },
                    // a session has the screen to itself on a phone, as in the web app
                    Route::Session { host, pane, view } => rsx! {
                        div { key: "{host}:{pane}", class: "page", Session { host, pane, view } }
                    },
                    Route::Machines { add } => rsx! {
                        div { key: "{MACHINES_KEY}", class: "page", machines::MachinesPage { add } }
                        TabBar { section }
                    },
                    Route::Machine { id } => rsx! {
                        div { key: "machine:{id}", class: "page", machines::MachinePage { id } }
                        TabBar { section }
                    },
                }
            }
            MenuLayer {}
            add::ActionSheets {}
            connect::ConnectHelpHost {}
            toast::ConfirmHost {}
            toast::Toasts {}
        }
    }
}

/// Which item the sidebar and the tab bar light up.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Section {
    Overview,
    Machines,
    None,
}

fn nav_class(on: bool) -> &'static str {
    if on {
        "nav-item nav-active"
    } else {
        "nav-item"
    }
}

fn tab_class(on: bool) -> &'static str {
    if on {
        "tab tab-active"
    } else {
        "tab"
    }
}

#[component]
fn Sidebar(section: Section) -> Element {
    let overview = section == Section::Overview;
    let on_machines = section == Section::Machines;
    let hub = use_context::<Signal<Hub>>();
    let h = hub.read();
    let online = h.hosts.iter().filter(|x| x.status == inyon_protocol::HostStatus::Online).count();
    let total = h.hosts.len();
    let count = if online == total { total.to_string() } else { format!("{online}/{total}") };
    rsx! {
        aside { class: "sidebar",
            div { class: "sidebar-head",
                Logo { connecting: !h.connected }
                span { class: "brand", "Inyon" }
                span { class: "chip chip-quiet", title: "The new app, in progress. Items it doesn't have yet open the current app.", "Preview" }
                if !h.connected {
                    button {
                        class: "sidebar-offline icon-button press",
                        r#type: "button",
                        "aria-label": "Reconnecting. Can't connect?",
                        title: "Reconnecting. Can't connect?",
                        onclick: move |_| connect::open_connect_help(None),
                        Glyph { icon: Icon::WifiOff, size: 16 }
                    }
                }
            }
            nav { class: "sidebar-nav",
                a { class: nav_class(overview), href: "/next/", "aria-current": overview.then_some("page"),
                    Glyph { icon: Icon::LayoutGrid, size: 16 }
                    "Overview"
                }
            }
            div { class: "sidebar-foot",
                a { class: nav_class(on_machines), href: "/next/machines", "aria-current": on_machines.then_some("page"),
                    Glyph { icon: Icon::Monitor, size: 16 }
                    "Machines"
                    if total > 0 {
                        span { class: "nav-count mono tabular", title: "{online} of {total} online", "{count}" }
                    }
                }
                a { class: "nav-item", href: "/pages",
                    Glyph { icon: Icon::PanelsTopLeft, size: 16 }
                    "Pages"
                }
                a { class: "nav-item", href: "/settings",
                    Glyph { icon: Icon::Settings, size: 16 }
                    "Settings"
                }
            }
        }
    }
}

#[component]
fn TabBar(section: Section) -> Element {
    let overview = section == Section::Overview;
    let on_machines = section == Section::Machines;
    let hub = use_context::<Signal<Hub>>();
    let waiting = model::agent_panes(&hub.read().hosts).iter().filter(|r| r.agent().state == inyon_protocol::AgentState::Waiting).count();
    rsx! {
        nav { class: "tabbar",
            a { class: tab_class(overview), href: "/next/", "aria-current": overview.then_some("page"),
                span { class: "tab-icon",
                    Glyph { icon: Icon::LayoutGrid, size: 21 }
                    if waiting > 0 {
                        span { class: "tab-badge", "aria-label": "{waiting} need you", "{waiting}" }
                    }
                }
                "Overview"
            }
            a { class: "tab", href: "/pages",
                Glyph { icon: Icon::PanelsTopLeft, size: 21 }
                "Pages"
            }
            a { class: tab_class(on_machines), href: "/next/machines", "aria-current": on_machines.then_some("page"),
                Glyph { icon: Icon::Monitor, size: 21 }
                "Machines"
            }
            a { class: "tab", href: "/settings",
                Glyph { icon: Icon::Settings, size: 21 }
                "Settings"
            }
        }
    }
}
