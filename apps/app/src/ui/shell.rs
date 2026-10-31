//! The frame around the pages: a sidebar from tablet width up, a tab bar on phones
//! (components/AppShell.tsx). This app has the Overview and the session screen so far; the other
//! items open the web app's pages, so nothing here is a dead end.

use dioxus::prelude::*;

use super::icons::{Glyph, Icon, Logo};
use super::menu::MenuLayer;
use super::overview::Overview;
use super::session::Session;
use crate::model::{self, AgentPane};
use crate::route::Route;
use crate::state::Hub;

/// The Overview page's key, beside the sessions' `host:pane` ones.
const OVERVIEW_KEY: &str = "overview";

#[component]
pub fn Shell() -> Element {
    let here = use_context::<Signal<Route>>();
    let route = here();
    rsx! {
        div { class: "shell",
            Sidebar { overview: route == Route::Overview }
            main { class: "main",
                match route {
                    Route::Overview => rsx! {
                        div { key: "{OVERVIEW_KEY}", class: "page", Overview {} }
                        TabBar {}
                    },
                    // a session has the screen to itself on a phone, as in the web app
                    Route::Session { host, pane, terminal } => rsx! {
                        div { key: "{host}:{pane}", class: "page", Session { host, pane, terminal } }
                    },
                }
            }
            MenuLayer {}
        }
    }
}

#[component]
fn Sidebar(overview: bool) -> Element {
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
                    span { class: "sidebar-offline", "aria-label": "Reconnecting", Glyph { icon: Icon::WifiOff, size: 16 } }
                }
            }
            nav { class: "sidebar-nav",
                a { class: if overview { "nav-item nav-active" } else { "nav-item" }, href: "/next/", "aria-current": overview.then_some("page"),
                    Glyph { icon: Icon::LayoutGrid, size: 16 }
                    "Overview"
                }
            }
            div { class: "sidebar-foot",
                a { class: "nav-item", href: "/machines",
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
fn TabBar() -> Element {
    let hub = use_context::<Signal<Hub>>();
    let waiting = model::agent_panes(&hub.read().hosts).iter().filter(|r| r.agent().state == inyon_protocol::AgentState::Waiting).count();
    rsx! {
        nav { class: "tabbar",
            a { class: "tab tab-active", href: "/next/", "aria-current": "page",
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
            a { class: "tab", href: "/machines",
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
