//! The Lucide icons the screens use (the web app's set, lucide-react), drawn inline so nothing
//! else loads. 24-unit boxes with a 2px round stroke, sized by the caller.

use dioxus::prelude::*;

#[derive(Clone, Copy, PartialEq)]
pub enum Icon {
    ChevronRight,
    WifiOff,
    LayoutGrid,
    Monitor,
    PanelsTopLeft,
    Settings,
    Gauge,
    Check,
    Spinner,
}

#[component]
pub fn Glyph(icon: Icon, size: u32, #[props(default)] class: String) -> Element {
    rsx! {
        svg {
            class: "icon {class}",
            width: "{size}",
            height: "{size}",
            view_box: "0 0 24 24",
            fill: "none",
            stroke: "currentColor",
            "stroke-width": "2",
            "stroke-linecap": "round",
            "stroke-linejoin": "round",
            "aria-hidden": "true",
            match icon {
                Icon::ChevronRight => rsx! { path { d: "m9 18 6-6-6-6" } },
                Icon::WifiOff => rsx! {
                    path { d: "M12 20h.01" }
                    path { d: "M8.5 16.429a5 5 0 0 1 7 0" }
                    path { d: "M5 12.859a10 10 0 0 1 5.17-2.69" }
                    path { d: "M19 12.859a10 10 0 0 0-2.007-1.523" }
                    path { d: "M2 8.82a15 15 0 0 1 4.177-2.643" }
                    path { d: "M22 8.82a15 15 0 0 0-11.288-3.764" }
                    path { d: "m2 2 20 20" }
                },
                Icon::LayoutGrid => rsx! {
                    rect { width: "7", height: "7", x: "3", y: "3", rx: "1" }
                    rect { width: "7", height: "7", x: "14", y: "3", rx: "1" }
                    rect { width: "7", height: "7", x: "14", y: "14", rx: "1" }
                    rect { width: "7", height: "7", x: "3", y: "14", rx: "1" }
                },
                Icon::Monitor => rsx! {
                    rect { width: "20", height: "14", x: "2", y: "3", rx: "2" }
                    line { x1: "8", x2: "16", y1: "21", y2: "21" }
                    line { x1: "12", x2: "12", y1: "17", y2: "21" }
                },
                Icon::PanelsTopLeft => rsx! {
                    rect { width: "18", height: "18", x: "3", y: "3", rx: "2" }
                    path { d: "M3 9h18" }
                    path { d: "M9 21V9" }
                },
                Icon::Settings => rsx! {
                    path { d: "M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915" }
                    circle { cx: "12", cy: "12", r: "3" }
                },
                Icon::Gauge => rsx! {
                    path { d: "m12 14 4-4" }
                    path { d: "M3.34 19a10 10 0 1 1 17.32 0" }
                },
                Icon::Check => rsx! { path { d: "M20 6 9 17l-5-5" } },
                Icon::Spinner => rsx! { path { d: "M21 12a9 9 0 1 1-6.219-8.56" } },
            }
        }
    }
}

/// A machine's icon, drawn like the kite mark (components/ui/MachineIcon.tsx).
#[component]
pub fn MachineGlyph(kind: inyon_protocol::MachineKind, size: u32, #[props(default)] class: String) -> Element {
    use inyon_protocol::MachineKind;
    let label = match kind {
        MachineKind::Server => "Server",
        MachineKind::Laptop => "Laptop",
        MachineKind::Desktop => "Desktop",
    };
    rsx! {
        svg {
            class: "icon {class}",
            width: "{size}",
            height: "{size}",
            view_box: "0 0 24 24",
            fill: "none",
            stroke: "currentColor",
            "stroke-width": "1.75",
            "stroke-linecap": "round",
            "stroke-linejoin": "round",
            role: "img",
            "aria-label": label,
            match kind {
                MachineKind::Server => rsx! {
                    rect { x: "3.5", y: "4", width: "17", height: "7", rx: "2.5" }
                    rect { x: "3.5", y: "13", width: "17", height: "7", rx: "2.5" }
                    circle { cx: "7.5", cy: "7.5", r: "1.25", fill: "currentColor", stroke: "none" }
                    circle { cx: "7.5", cy: "16.5", r: "1.25", fill: "currentColor", stroke: "none" }
                    path { d: "M12 7.5h4.5M12 16.5h4.5" }
                },
                MachineKind::Laptop => rsx! {
                    rect { x: "5", y: "4.5", width: "14", height: "10.5", rx: "2.5" }
                    path { d: "M2.75 19h18.5" }
                    circle { cx: "12", cy: "9.75", r: "1.25", fill: "currentColor", stroke: "none" }
                },
                MachineKind::Desktop => rsx! {
                    rect { x: "3", y: "3.5", width: "18", height: "12.5", rx: "2.5" }
                    path { d: "M12 16v4M8.5 20h7" }
                    circle { cx: "12", cy: "9.75", r: "1.25", fill: "currentColor", stroke: "none" }
                },
            }
        }
    }
}

const SQUIRCLE: &str = "M25 0H39C60 0 64 4 64 25V39C64 60 60 64 39 64H25C4 64 0 60 0 39V25C0 4 4 0 25 0Z";

/// Inyon's mark, a Korean shield kite on its line (apps/web/public/icon.svg). While the hub is out
/// of reach the line draws itself over and over.
#[component]
pub fn Logo(#[props(default)] class: String, #[props(default)] connecting: bool) -> Element {
    let state = if connecting { "mark-connecting" } else { "" };
    rsx! {
        svg { class: "logo {state} {class}", view_box: "0 0 64 64", "aria-hidden": "true",
            path { d: SQUIRCLE, fill: "var(--logo-tile)" }
            path { d: SQUIRCLE, transform: "translate(.5 .5) scale(.984)", fill: "none", stroke: "#fff", "stroke-opacity": ".08" }
            g { fill: "#F1F0EC",
                path {
                    transform: "rotate(-12 41 23)",
                    "fill-rule": "evenodd",
                    d: "M33.5 9H48.5A3.5 3.5 0 0 1 52 12.5V33.5A3.5 3.5 0 0 1 48.5 37H33.5A3.5 3.5 0 0 1 30 33.5V12.5A3.5 3.5 0 0 1 33.5 9ZM41 18.4A4.6 4.6 0 1 0 41 27.6A4.6 4.6 0 1 0 41 18.4Z",
                }
                path { class: "mark-line", d: "M38.5 36.5C35 48 25 42 17.5 49.5", fill: "none", stroke: "#F1F0EC", "stroke-width": "3.8", "stroke-linecap": "round" }
                circle { cx: "15.5", cy: "51", r: "4" }
            }
        }
    }
}

/// An agent's mark, the web app's files (`/agents/<kind>.svg`, served by the hub next to it).
#[component]
pub fn AgentMark(kind: inyon_protocol::AgentKind, size: u32, #[props(default)] class: String) -> Element {
    let name = kind.def().name.clone();
    rsx! {
        img {
            class: "agent-mark {class}",
            src: "/agents/{kind.as_str()}.svg",
            alt: "{name}",
            width: "{size}",
            height: "{size}",
            draggable: "false",
        }
    }
}
