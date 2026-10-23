//! Test only: draws the window's layout in each state as an SVG (boxes and their text), so the
//! layout can be looked at without Windows. `INYON_WINDOW_SVG=<dir> cargo test -p inyon-cli
//! window::svg` writes them; without it the test only checks they draw.

use super::demo;
use super::layout::{layout, Id, Layout, Mode, Rect};
use super::model::{view, View};

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// One state of the window as an SVG: cards, boxes, buttons and the text in each.
pub fn draw(l: &Layout, v: &View, tab: u8, title: &str) -> String {
    let (w, h) = l.client;
    let k = l.dpi as f32 / 96.0;
    let mut out = format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{w}\" height=\"{}\" viewBox=\"0 -{} {w} {}\" font-family=\"Segoe UI, sans-serif\">\n<rect y=\"-{}\" width=\"{w}\" height=\"{}\" fill=\"#cfd3d8\"/>\n<text x=\"8\" y=\"-10\" font-size=\"{}\" fill=\"#1d1c1a\">{}</text>\n<rect width=\"{w}\" height=\"{h}\" fill=\"#e9e8e4\"/>\n",
        h + (32.0 * k) as i32,
        (32.0 * k) as i32,
        h + (32.0 * k) as i32,
        (32.0 * k) as i32,
        h + (32.0 * k) as i32,
        12.0 * k,
        esc(title)
    );
    for item in l.items.iter().filter(|i| i.id.is_card() && l.shown(i.id, tab)) {
        let r = item.rect;
        out.push_str(&format!("<rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" rx=\"{}\" fill=\"#f4f3f0\" stroke=\"#d6d5cf\"/>\n", r.x, r.y, r.w, r.h, 12.0 * k));
    }
    for item in l.items.iter().filter(|i| !i.id.is_card() && l.shown(i.id, tab)) {
        let r: Rect = item.rect;
        let button = v.button(item.id);
        if item.id.is_button() && button.is_none() {
            // a button's place with nothing in it this state: kept, drawn dashed
            out.push_str(&format!("<rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" rx=\"4\" fill=\"none\" stroke=\"#bdbcb5\" stroke-dasharray=\"3 3\"/>\n", r.x, r.y, r.w, r.h));
            continue;
        }
        let (fill, stroke, ink) = match (item.id, button) {
            (Id::Primary, Some(b)) => (if b.enabled { "#1d1c1a" } else { "#8a8984" }, "none", "#f4f3f0"),
            (Id::Tab(t), Some(_)) if t == tab => ("#f4f3f0", "#bdbcb5", "#1d1c1a"),
            (_, Some(_)) => ("#ecebe7", "#d6d5cf", "#1d1c1a"),
            _ => ("none", "#c9c7c0", "#4a4844"),
        };
        out.push_str(&format!("<rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" rx=\"4\" fill=\"{fill}\" stroke=\"{stroke}\"/>\n", r.x, r.y, r.w, r.h));
        let text = v.text(item.id);
        if text.is_empty() {
            continue;
        }
        // wrapped and cut as the window does, with a rough width per character for Segoe UI
        let line_h = (16.0 * k) as i32;
        let many = matches!(item.id, Id::Side | Id::Note);
        let rows = if many { (r.h / line_h).max(1) as usize } else { 1 };
        let measure = |t: &str| (t.chars().count() as f32 * 6.2 * k) as i32;
        let lines = super::layout::fit_lines(&text, r.w - (8.0 * k) as i32, rows, &measure);
        for (i, line) in lines.iter().enumerate() {
            let y = if many { r.y + line_h * (i as i32 + 1) - (4.0 * k) as i32 } else { r.y + r.h / 2 + (4.0 * k) as i32 };
            out.push_str(&format!("<text x=\"{}\" y=\"{y}\" font-size=\"{}\" fill=\"{ink}\">{}</text>\n", r.x + (4.0 * k) as i32, 11.0 * k, esc(line)));
        }
    }
    out.push_str("</svg>\n");
    out
}

#[test]
fn every_state_draws_in_the_same_boxes() {
    let out = std::env::var_os("INYON_WINDOW_SVG").map(std::path::PathBuf::from);
    if let Some(dir) = &out {
        std::fs::create_dir_all(dir).unwrap();
    }
    let big = Rect::new(0, 0, 3840, 2064);
    let narrow = Rect::new(0, 0, 1080, 1848);
    let mut sizes = Vec::new();
    let now = 1_000_000_000.0;
    for name in demo::NAMES {
        let (role, s, p, x) = demo::state(name, now).unwrap();
        let v = view(role, &s, &p, &x, now, "2026-10-22");
        for (dpi, work, tabs) in [(96, big, vec![0u8]), (144, big, vec![0]), (144, narrow, vec![0, 1, 2])] {
            let l: Layout = layout(dpi, work, super::layout::frame_estimate(dpi));
            sizes.push((dpi, l.mode, l.client));
            for tab in tabs {
                // a button the state offers always has a place to go
                for id in
                    [Id::Primary, Id::Secondary, Id::Change, Id::ShowAll, Id::Forget(0), Id::Forget(1), Id::SvcA, Id::SvcB, Id::UpdateBtn, Id::CheckBtn, Id::OpenLog, Id::Quit]
                {
                    if v.button(id).is_some() {
                        assert!(l.items.iter().any(|i| i.id == id), "{name}: {id:?} has no place");
                    }
                }
                let svg =
                    draw(&l, &v, tab, &format!("{name} · {}% · {:?}{}", dpi * 100 / 96, l.mode, if l.mode == Mode::Compact { format!(" · tab {tab}") } else { String::new() }));
                assert!(svg.starts_with("<svg") && svg.contains("</svg>"));
                if let Some(dir) = &out {
                    let file = match l.mode {
                        Mode::Wide => format!("{name}-{}.svg", dpi * 100 / 96),
                        Mode::Compact => format!("{name}-compact-tab{tab}.svg"),
                    };
                    std::fs::write(dir.join(file), svg).unwrap();
                }
            }
        }
    }
    // the size depends on the scale and the work area alone, never on the state
    sizes.sort_by_key(|(d, m, c)| (*d, *m == Mode::Wide, *c));
    sizes.dedup();
    assert_eq!(sizes.len(), 3, "{sizes:?}");
}
