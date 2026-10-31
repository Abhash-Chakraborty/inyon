//! The Lucide icons the screens use (the web app's set, lucide-react), drawn inline so nothing
//! else loads. 24-unit boxes with a 2px round stroke, sized by the caller.

use dioxus::prelude::*;

#[derive(Debug, Clone, Copy, PartialEq)]
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
    ChevronLeft,
    MessageSquare,
    SquareTerminal,
    ArrowUp,
    ArrowDown,
    ArrowRight,
    Square,
    Copy,
    History,
    Lightbulb,
    Clock3,
    CircleAlert,
    RotateCcw,
    X,
    Image,
    File,
    Info,
    TriangleAlert,
    Layers,
    Target,
    CircleCheck,
    CircleX,
    CornerDownLeft,
    Send,
    ExternalLink,
    ClipboardList,
    MessageCircleQuestion,
    ListTodo,
    CircleDashed,
    Hourglass,
    Wrench,
    Bell,
    BookMarked,
    Bot,
    FileCode2,
    FilePen,
    FilePlus2,
    FileSearch,
    FileText,
    FolderSearch,
    Globe,
    ListChecks,
    Plug,
    ScrollText,
    Search,
    Timer,
    Workflow,
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
                Icon::ChevronLeft => rsx! { path { d: "m15 18-6-6 6-6" } },
                Icon::MessageSquare => rsx! { path { d: "M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z" } },
                Icon::SquareTerminal => rsx! {
                    path { d: "m7 11 2-2-2-2" }
                    path { d: "M11 13h4" }
                    rect { width: "18", height: "18", x: "3", y: "3", rx: "2", ry: "2" }
                },
                Icon::ArrowUp => rsx! {
                    path { d: "m5 12 7-7 7 7" }
                    path { d: "M12 19V5" }
                },
                Icon::ArrowDown => rsx! {
                    path { d: "M12 5v14" }
                    path { d: "m19 12-7 7-7-7" }
                },
                Icon::ArrowRight => rsx! {
                    path { d: "M5 12h14" }
                    path { d: "m12 5 7 7-7 7" }
                },
                Icon::Square => rsx! { rect { width: "18", height: "18", x: "3", y: "3", rx: "2" } },
                Icon::Copy => rsx! {
                    rect { width: "14", height: "14", x: "8", y: "8", rx: "2", ry: "2" }
                    path { d: "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" }
                },
                Icon::History => rsx! {
                    path { d: "M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" }
                    path { d: "M3 3v5h5" }
                    path { d: "M12 7v5l4 2" }
                },
                Icon::Lightbulb => rsx! {
                    path { d: "M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5" }
                    path { d: "M9 18h6" }
                    path { d: "M10 22h4" }
                },
                Icon::Clock3 => rsx! {
                    circle { cx: "12", cy: "12", r: "10" }
                    path { d: "M12 6v6h4" }
                },
                Icon::CircleAlert => rsx! {
                    circle { cx: "12", cy: "12", r: "10" }
                    line { x1: "12", x2: "12", y1: "8", y2: "12" }
                    line { x1: "12", x2: "12.01", y1: "16", y2: "16" }
                },
                Icon::RotateCcw => rsx! {
                    path { d: "M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" }
                    path { d: "M3 3v5h5" }
                },
                Icon::X => rsx! {
                    path { d: "M18 6 6 18" }
                    path { d: "m6 6 12 12" }
                },
                Icon::Image => rsx! {
                    rect { width: "18", height: "18", x: "3", y: "3", rx: "2", ry: "2" }
                    circle { cx: "9", cy: "9", r: "2" }
                    path { d: "m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" }
                },
                Icon::File => rsx! {
                    path { d: "M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" }
                    path { d: "M14 2v5a1 1 0 0 0 1 1h5" }
                },
                Icon::Info => rsx! {
                    circle { cx: "12", cy: "12", r: "10" }
                    path { d: "M12 16v-4" }
                    path { d: "M12 8h.01" }
                },
                Icon::TriangleAlert => rsx! {
                    path { d: "m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" }
                    path { d: "M12 9v4" }
                    path { d: "M12 17h.01" }
                },
                Icon::Layers => rsx! {
                    path { d: "M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z" }
                    path { d: "M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12" }
                    path { d: "M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17" }
                },
                Icon::Target => rsx! {
                    circle { cx: "12", cy: "12", r: "10" }
                    circle { cx: "12", cy: "12", r: "6" }
                    circle { cx: "12", cy: "12", r: "2" }
                },
                Icon::CircleCheck => rsx! {
                    circle { cx: "12", cy: "12", r: "10" }
                    path { d: "m16 9-5.5 5.5L8 12" }
                },
                Icon::CircleX => rsx! {
                    circle { cx: "12", cy: "12", r: "10" }
                    path { d: "m15 9-6 6" }
                    path { d: "m9 9 6 6" }
                },
                Icon::CornerDownLeft => rsx! {
                    path { d: "M20 4v7a4 4 0 0 1-4 4H4" }
                    path { d: "m9 10-5 5 5 5" }
                },
                Icon::Send => rsx! {
                    path { d: "M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z" }
                    path { d: "m21.854 2.147-10.94 10.939" }
                },
                Icon::ExternalLink => rsx! {
                    path { d: "M15 3h6v6" }
                    path { d: "M10 14 21 3" }
                    path { d: "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" }
                },
                Icon::ClipboardList => rsx! {
                    rect { width: "8", height: "4", x: "8", y: "2", rx: "1", ry: "1" }
                    path { d: "M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" }
                    path { d: "M12 11h4" }
                    path { d: "M12 16h4" }
                    path { d: "M8 11h.01" }
                    path { d: "M8 16h.01" }
                },
                Icon::MessageCircleQuestion => rsx! {
                    path { d: "M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719" }
                    path { d: "M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" }
                    path { d: "M12 17h.01" }
                },
                Icon::ListTodo => rsx! {
                    path { d: "M13 5h8" }
                    path { d: "M13 12h8" }
                    path { d: "M13 19h8" }
                    path { d: "m3 17 2 2 4-4" }
                    rect { x: "3", y: "4", width: "6", height: "6", rx: "1" }
                },
                Icon::CircleDashed => rsx! {
                    path { d: "M10.1 2.182a10 10 0 0 1 3.8 0" }
                    path { d: "M13.9 21.818a10 10 0 0 1-3.8 0" }
                    path { d: "M17.609 3.721a10 10 0 0 1 2.69 2.7" }
                    path { d: "M2.182 13.9a10 10 0 0 1 0-3.8" }
                    path { d: "M20.279 17.609a10 10 0 0 1-2.7 2.69" }
                    path { d: "M21.818 10.1a10 10 0 0 1 0 3.8" }
                    path { d: "M3.721 6.391a10 10 0 0 1 2.7-2.69" }
                    path { d: "M6.391 20.279a10 10 0 0 1-2.69-2.7" }
                },
                Icon::Hourglass => rsx! {
                    path { d: "M5 22h14" }
                    path { d: "M5 2h14" }
                    path { d: "M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22" }
                    path { d: "M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2" }
                },
                Icon::Wrench => rsx! { path { d: "M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.106-3.105c.32-.322.863-.22.983.218a6 6 0 0 1-8.259 7.057l-7.91 7.91a1 1 0 0 1-2.999-3l7.91-7.91a6 6 0 0 1 7.057-8.259c.438.12.54.662.219.984z" } },
                Icon::Bell => rsx! {
                    path { d: "M10.268 21a2 2 0 0 0 3.464 0" }
                    path { d: "M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326" }
                },
                Icon::BookMarked => rsx! {
                    path { d: "M10 2v7.751a.25.25 0 00.407.195l2.28-1.834a.5.5 0 01.627 0l2.28 1.834A.25.25 0 0016 9.751V2" }
                    path { d: "M4 19.5v-15A2.5 2.5 0 016.5 2H19a1 1 0 011 1v18a1 1 0 01-1 1H6.5a1 1 0 010-5H20" }
                },
                Icon::Bot => rsx! {
                    path { d: "M12 8V4H8" }
                    rect { width: "16", height: "12", x: "4", y: "8", rx: "2" }
                    path { d: "M2 14h2" }
                    path { d: "M20 14h2" }
                    path { d: "M15 13v2" }
                    path { d: "M9 13v2" }
                },
                Icon::FileCode2 => rsx! {
                    path { d: "M4 12.15V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.706.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2h-3.35" }
                    path { d: "M14 2v5a1 1 0 0 0 1 1h5" }
                    path { d: "m5 16-3 3 3 3" }
                    path { d: "m9 22 3-3-3-3" }
                },
                Icon::FilePen => rsx! {
                    path { d: "M12.659 22H18a2 2 0 0 0 2-2V8a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 14 2H6a2 2 0 0 0-2 2v9.34" }
                    path { d: "M14 2v5a1 1 0 0 0 1 1h5" }
                    path { d: "M10.378 12.622a1 1 0 0 1 3 3.003L8.36 20.637a2 2 0 0 1-.854.506l-2.867.837a.5.5 0 0 1-.62-.62l.836-2.869a2 2 0 0 1 .506-.853z" }
                },
                Icon::FilePlus2 => rsx! {
                    path { d: "M11.35 22H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.706.706l3.588 3.588A2.4 2.4 0 0 1 20 8v5.35" }
                    path { d: "M14 2v5a1 1 0 0 0 1 1h5" }
                    path { d: "M14 19h6" }
                    path { d: "M17 16v6" }
                },
                Icon::FileSearch => rsx! {
                    path { d: "M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" }
                    path { d: "M14 2v5a1 1 0 0 0 1 1h5" }
                    circle { cx: "11.5", cy: "14.5", r: "2.5" }
                    path { d: "M13.3 16.3 15 18" }
                },
                Icon::FileText => rsx! {
                    path { d: "M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" }
                    path { d: "M14 2v5a1 1 0 0 0 1 1h5" }
                    path { d: "M10 9H8" }
                    path { d: "M16 13H8" }
                    path { d: "M16 17H8" }
                },
                Icon::FolderSearch => rsx! {
                    path { d: "M10.7 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v4.1" }
                    path { d: "m21 21-1.9-1.9" }
                    circle { cx: "17", cy: "17", r: "3" }
                },
                Icon::Globe => rsx! {
                    circle { cx: "12", cy: "12", r: "10" }
                    path { d: "M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" }
                    path { d: "M2 12h20" }
                },
                Icon::ListChecks => rsx! {
                    path { d: "M13 5h8" }
                    path { d: "M13 12h8" }
                    path { d: "M13 19h8" }
                    path { d: "m3 17 2 2 4-4" }
                    path { d: "m3 7 2 2 4-4" }
                },
                Icon::Plug => rsx! {
                    path { d: "M12 22v-5" }
                    path { d: "M15 8V2" }
                    path { d: "M17 8a1 1 0 0 1 1 1v4a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1z" }
                    path { d: "M9 8V2" }
                },
                Icon::ScrollText => rsx! {
                    path { d: "M15 12h-5" }
                    path { d: "M15 8h-5" }
                    path { d: "M19 17V5a2 2 0 0 0-2-2H4" }
                    path { d: "M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3" }
                },
                Icon::Search => rsx! {
                    path { d: "m21 21-4.34-4.34" }
                    circle { cx: "11", cy: "11", r: "8" }
                },
                Icon::Timer => rsx! {
                    line { x1: "10", x2: "14", y1: "2", y2: "2" }
                    line { x1: "12", x2: "15", y1: "14", y2: "11" }
                    circle { cx: "12", cy: "14", r: "8" }
                },
                Icon::Workflow => rsx! {
                    rect { width: "8", height: "8", x: "3", y: "3", rx: "2" }
                    path { d: "M7 11v4a2 2 0 0 0 2 2h4" }
                    rect { width: "8", height: "8", x: "13", y: "13", rx: "2" }
                },
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
