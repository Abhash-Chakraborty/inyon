//! Where every control of the Inyon window goes, as a pure function of the DPI and the work
//! area. The state is not an input, so nothing the window shows can make it grow, shrink or move:
//! a refresh only changes what's drawn inside these rectangles. The numbers are the plan's
//! (private plan site, "The Inyon window"), in logical pixels at 96 dpi.

/// A rectangle in device pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

impl Rect {
    pub const fn new(x: i32, y: i32, w: i32, h: i32) -> Rect {
        Rect { x, y, w, h }
    }

    pub fn right(&self) -> i32 {
        self.x + self.w
    }

    pub fn bottom(&self) -> i32 {
        self.y + self.h
    }

    pub fn overlaps(&self, o: &Rect) -> bool {
        self.x < o.right() && o.x < self.right() && self.y < o.bottom() && o.y < self.bottom()
    }

    pub fn inside(&self, o: &Rect) -> bool {
        self.x >= o.x && self.y >= o.y && self.right() <= o.right() && self.bottom() <= o.bottom()
    }
}

/// Every part of the window that has a place of its own.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Id {
    Mark,
    Title,
    Subtitle,
    /// running, starting, stopped or not set up
    Pill,
    /// the compact layout's tabs: Pair, Phones, This computer
    Tab(u8),
    PairCard,
    PairTitle,
    /// the code square, reserved in every state
    Qr,
    /// what to do, and the typed-in code at its foot
    Side,
    Note,
    Primary,
    Secondary,
    LinkCard,
    ReachLabel,
    Lan,
    Vpn,
    Tunnel,
    Change,
    LinkDetail,
    PhonesCard,
    PhonesTitle,
    ShowAll,
    PhoneName(u8),
    PhoneSeen(u8),
    Forget(u8),
    CompCard,
    /// the four rows of "This computer": service, update, checks, agents
    CompText(u8),
    /// Start or Stop
    SvcA,
    /// Restart or Set up
    SvcB,
    UpdateBtn,
    CheckBtn,
    Log,
    OpenLog,
    Quit,
}

impl Id {
    /// The cards hold other controls; everything else must keep clear of its neighbours.
    pub fn is_card(self) -> bool {
        matches!(self, Id::PairCard | Id::LinkCard | Id::PhonesCard | Id::CompCard)
    }

    /// The child windows: everything a click goes to.
    pub fn is_button(self) -> bool {
        matches!(
            self,
            Id::Tab(_) | Id::Primary | Id::Secondary | Id::Change | Id::ShowAll | Id::Forget(_) | Id::SvcA | Id::SvcB | Id::UpdateBtn | Id::CheckBtn | Id::OpenLog | Id::Quit
        )
    }

    /// The card a control sits in, if any.
    pub fn card(self) -> Option<Id> {
        Some(match self {
            Id::PairTitle | Id::Qr | Id::Side | Id::Note | Id::Primary | Id::Secondary => Id::PairCard,
            Id::ReachLabel | Id::Lan | Id::Vpn | Id::Tunnel | Id::Change | Id::LinkDetail => Id::LinkCard,
            Id::PhonesTitle | Id::ShowAll | Id::PhoneName(_) | Id::PhoneSeen(_) | Id::Forget(_) => Id::PhonesCard,
            Id::CompText(_) | Id::SvcA | Id::SvcB | Id::UpdateBtn | Id::CheckBtn => Id::CompCard,
            _ => return None,
        })
    }
}

/// Wide shows everything at once; compact (a work area too small for wide) shows one card at a
/// time behind three tabs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Wide,
    Compact,
}

/// The client area in logical pixels.
pub const WIDE: (i32, i32) = (760, 420);
pub const COMPACT: (i32, i32) = (400, 420);
/// Phones listed in the window; more are behind Show all.
pub const PHONE_ROWS: usize = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Item {
    pub id: Id,
    pub rect: Rect,
    /// in the compact layout, the tab it's on (None: on every tab)
    pub tab: Option<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Layout {
    pub mode: Mode,
    pub dpi: u32,
    /// the client area in device pixels
    pub client: (i32, i32),
    pub items: Vec<Item>,
}

impl Layout {
    pub fn get(&self, id: Id) -> Rect {
        self.items.iter().find(|i| i.id == id).map(|i| i.rect).unwrap_or_default()
    }

    /// Whether `id` is on screen with tab `tab` chosen (always, in the wide layout).
    pub fn shown(&self, id: Id, tab: u8) -> bool {
        self.items.iter().any(|i| i.id == id && (self.mode == Mode::Wide || i.tab.is_none_or(|t| t == tab)))
    }

    /// The window around the client area, with `frame` (the title bar and borders, in device
    /// pixels, from AdjustWindowRectExForDpi) added.
    pub fn outer(&self, frame: (i32, i32)) -> (i32, i32) {
        (self.client.0 + frame.0, self.client.1 + frame.1)
    }
}

/// A logical length at `dpi`, rounded.
pub fn px(v: i32, dpi: u32) -> i32 {
    (v * dpi as i32 + 48).div_euclid(96)
}

/// The title bar and borders a captioned window without a resizing border gets, as Windows 11
/// adds them at `dpi`: 7 px each side and a 23 px caption plus 7 px top and bottom at 96 dpi.
/// The window asks Windows itself; this is for the tests and a fallback.
pub fn frame_estimate(dpi: u32) -> (i32, i32) {
    (px(14, dpi), px(37, dpi))
}

/// Which layout fits `work` (the monitor's work area, without the taskbar) at `dpi`.
pub fn mode_for(dpi: u32, work: Rect, frame: (i32, i32)) -> Mode {
    if px(WIDE.0, dpi) + frame.0 <= work.w && px(WIDE.1, dpi) + frame.1 <= work.h {
        Mode::Wide
    } else {
        Mode::Compact
    }
}

/// Where the window goes: centred in the work area, and never above or left of it when it's too
/// big to fit.
pub fn place(work: Rect, outer: (i32, i32)) -> Rect {
    let x = work.x + ((work.w - outer.0) / 2).max(0);
    let y = work.y + ((work.h - outer.1) / 2).max(0);
    Rect::new(x, y, outer.0, outer.1)
}

/// Every control's rectangle at `dpi` for a window in `work`.
pub fn layout(dpi: u32, work: Rect, frame: (i32, i32)) -> Layout {
    let mode = mode_for(dpi, work, frame);
    let size = if mode == Mode::Wide { WIDE } else { COMPACT };
    let mut items: Vec<Item> = Vec::new();
    // logical rectangles first; scaled by their edges below, so neighbours that don't overlap at
    // 96 dpi can't overlap after rounding
    let mut put = |id: Id, x: i32, y: i32, w: i32, h: i32, tab: Option<u8>| items.push(Item { id, rect: Rect::new(x, y, w, h), tab });
    let w = size.0;
    put(Id::Mark, 20, 14, 32, 32, None);
    put(Id::Title, 62, 12, w - 62 - 160, 20, None);
    put(Id::Subtitle, 62, 32, w - 62 - 160, 16, None);
    put(Id::Pill, w - 20 - 140, 16, 140, 28, None);
    let compact = mode == Mode::Compact;
    let tab = |t: u8| compact.then_some(t);
    if compact {
        for t in 0..3u8 {
            put(Id::Tab(t), 20 + t as i32 * 120, 60, 120, 30, None);
        }
    }
    // the pairing card: the code square, the text beside it, the note and both buttons have the
    // same boxes in every state
    let (x, y, cw, ch) = if compact { (20, 100, 360, 268) } else { (20, 60, 352, 308) };
    let (ix, iw) = (x + 16, cw - 32);
    let q = 148.min(ch - 150);
    let qy = y + 44;
    let sx = ix + q + 16;
    let by = y + ch - 16 - 32;
    let half = (iw - 8) / 2;
    put(Id::PairCard, x, y, cw, ch, tab(0));
    put(Id::PairTitle, ix, y + 14, iw, 20, tab(0));
    put(Id::Qr, ix, qy, q, q, tab(0));
    put(Id::Side, sx, qy, x + cw - 16 - sx, q, tab(0));
    put(Id::Note, ix, qy + q + 10, iw, 40, tab(0));
    put(Id::Primary, ix, by, half, 32, tab(0));
    put(Id::Secondary, ix + half + 8, by, iw - half - 8, 32, tab(0));
    // the link: how phones get in, and where it answers
    let (x, y, cw) = if compact { (20, 100, 360) } else { (388, 60, 352) };
    let (ix, right) = (x + 16, x + cw - 16);
    put(Id::LinkCard, x, y, cw, 72, tab(1));
    put(Id::ReachLabel, ix, y + 12, 52, 24, tab(1));
    put(Id::Lan, ix + 56, y + 12, 52, 24, tab(1));
    put(Id::Vpn, ix + 114, y + 12, 52, 24, tab(1));
    put(Id::Tunnel, ix + 172, y + 12, 68, 24, tab(1));
    put(Id::Change, right - 60, y + 12, 60, 24, tab(1));
    put(Id::LinkDetail, ix, y + 42, cw - 32, 20, tab(1));
    // phones
    let (x, y) = if compact { (20, 182) } else { (388, 142) };
    put(Id::PhonesCard, x, y, cw, 104, tab(1));
    put(Id::PhonesTitle, ix, y + 10, cw - 32 - 68, 24, tab(1));
    put(Id::ShowAll, right - 60, y + 10, 60, 24, tab(1));
    for i in 0..PHONE_ROWS as u8 {
        let ry = y + 40 + i as i32 * 30;
        put(Id::PhoneName(i), ix, ry, cw - 32 - 168, 24, tab(1));
        put(Id::PhoneSeen(i), right - 160, ry, 92, 24, tab(1));
        put(Id::Forget(i), right - 60, ry, 60, 24, tab(1));
    }
    // this computer: service, update, checks, agents
    let (x, y) = if compact { (20, 100) } else { (388, 256) };
    put(Id::CompCard, x, y, cw, 112, tab(2));
    for i in 0..4u8 {
        let ry = y + 4 + i as i32 * 26;
        let text_w = cw
            - 32
            - match i {
                0 => 132,
                3 => 0,
                _ => 68,
            };
        put(Id::CompText(i), ix, ry, text_w, 26, tab(2));
    }
    put(Id::SvcA, right - 124, y + 6, 58, 22, tab(2));
    put(Id::SvcB, right - 58, y + 6, 58, 22, tab(2));
    put(Id::UpdateBtn, right - 58, y + 32, 58, 22, tab(2));
    put(Id::CheckBtn, right - 58, y + 58, 58, 22, tab(2));
    // the footer, on every tab: the newest log line and the two ways out
    if compact {
        put(Id::Log, 20, 380, 180, 24, None);
        put(Id::OpenLog, 208, 380, 86, 24, None);
        put(Id::Quit, 302, 380, 78, 24, None);
    } else {
        put(Id::Log, 20, 380, 532, 24, None);
        put(Id::OpenLog, 560, 380, 90, 24, None);
        put(Id::Quit, 658, 380, 82, 24, None);
    }
    let scale = |r: Rect| {
        let (x, y) = (px(r.x, dpi), px(r.y, dpi));
        Rect::new(x, y, px(r.right(), dpi) - x, px(r.bottom(), dpi) - y)
    };
    for i in &mut items {
        i.rect = scale(i.rect);
    }
    Layout { mode, dpi, client: (px(size.0, dpi), px(size.1, dpi)), items }
}

/// `text` in at most `lines` lines no wider than `width`, broken between words; what doesn't fit
/// ends the last line with an ellipsis, so text never spills out of its box. `measure` gives a
/// string's width (GetTextExtentPoint32 in the window, a fixed width per character in tests).
pub fn fit_lines(text: &str, width: i32, lines: usize, measure: &dyn Fn(&str) -> i32) -> Vec<String> {
    if lines == 0 {
        return Vec::new();
    }
    let ellipsize = |s: &str| -> String {
        let mut cut: String = s.trim_end_matches('…').to_string();
        while !cut.is_empty() && measure(&format!("{cut}…")) > width {
            cut.pop();
        }
        format!("{}…", cut.trim_end())
    };
    let mut out: Vec<String> = Vec::new();
    let mut line = String::new();
    let words: Vec<&str> = text.split_whitespace().collect();
    let mut i = 0;
    while i < words.len() {
        let word = words[i];
        let next = if line.is_empty() { word.to_string() } else { format!("{line} {word}") };
        if measure(&next) <= width {
            line = next;
            i += 1;
            continue;
        }
        if line.is_empty() {
            // one word wider than the box: cut it
            line = ellipsize(word);
            i += 1;
        }
        if out.len() + 1 == lines {
            // the last line: what's left is cut
            let rest = std::iter::once(line.as_str()).chain(words[i..].iter().copied()).collect::<Vec<_>>().join(" ");
            out.push(if measure(&rest) <= width { rest } else { ellipsize(&rest) });
            return out;
        }
        out.push(std::mem::take(&mut line));
    }
    if !line.is_empty() {
        out.push(line);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 100%, 125%, 150%, 175% and 200%
    const SCALES: [u32; 5] = [96, 120, 144, 168, 192];

    /// A screen big enough for the wide window at any of the scales.
    fn big() -> Rect {
        Rect::new(0, 0, 3840, 2160 - 96)
    }

    #[test]
    fn the_window_has_one_size_per_scale() {
        for dpi in SCALES {
            let l = layout(dpi, big(), frame_estimate(dpi));
            assert_eq!(l.mode, Mode::Wide);
            assert_eq!(l.client, (px(760, dpi), px(420, dpi)));
            // asked again (as a refresh, a pairing or a DPI change back would), it's the same
            assert_eq!(layout(dpi, big(), frame_estimate(dpi)), l);
        }
        assert_eq!(layout(144, big(), frame_estimate(144)).client, (1140, 630));
    }

    #[test]
    fn no_two_controls_overlap_and_each_sits_in_its_card() {
        for dpi in SCALES {
            for work in [big(), Rect::new(0, 0, 720, 1200)] {
                let l = layout(dpi, work, frame_estimate(dpi));
                let controls: Vec<&Item> = l.items.iter().filter(|i| !i.id.is_card()).collect();
                for (n, a) in controls.iter().enumerate() {
                    for b in &controls[n + 1..] {
                        let together = l.mode == Mode::Wide || a.tab.is_none() || b.tab.is_none() || a.tab == b.tab;
                        assert!(!(together && a.rect.overlaps(&b.rect)), "{:?} {:?} overlaps {:?} {:?} at {dpi} dpi ({:?})", a.id, a.rect, b.id, b.rect, l.mode);
                    }
                    if let Some(card) = a.id.card() {
                        assert!(a.rect.inside(&l.get(card)), "{:?} is outside {card:?} at {dpi} dpi", a.id);
                    }
                }
                // the cards of one tab keep clear of each other too
                let cards: Vec<&Item> = l.items.iter().filter(|i| i.id.is_card()).collect();
                for (n, a) in cards.iter().enumerate() {
                    for b in &cards[n + 1..] {
                        let together = l.mode == Mode::Wide || a.tab == b.tab;
                        assert!(!(together && a.rect.overlaps(&b.rect)), "{:?} overlaps {:?} at {dpi} dpi", a.id, b.id);
                    }
                }
            }
        }
    }

    #[test]
    fn everything_is_inside_the_client_area_at_every_scale() {
        for dpi in SCALES {
            for work in [big(), Rect::new(0, 0, 720, 1200)] {
                let l = layout(dpi, work, frame_estimate(dpi));
                let client = Rect::new(0, 0, l.client.0, l.client.1);
                for i in &l.items {
                    assert!(i.rect.inside(&client) && i.rect.w > 0 && i.rect.h > 0, "{:?} {:?} at {dpi} dpi", i.id, i.rect);
                }
            }
        }
    }

    #[test]
    fn the_window_fits_a_1366_by_768_screen_at_150() {
        // Windows 11's taskbar is 48 px at 96 dpi, 72 at 150%
        let work = Rect::new(0, 0, 1366, 768 - 72);
        let frame = frame_estimate(144);
        let l = layout(144, work, frame);
        assert_eq!(l.mode, Mode::Wide, "the full window, not the compact one");
        let at = place(work, l.outer(frame));
        assert!(at.inside(&work), "{at:?} in {work:?}");
    }

    #[test]
    fn the_wide_window_fits_a_1080p_screen_at_every_scale_and_768p_at_125() {
        for dpi in SCALES {
            // the taskbar is 48 px at 100%
            let work = Rect::new(0, 0, 1920, 1080 - px(48, dpi));
            let frame = frame_estimate(dpi);
            let l = layout(dpi, work, frame);
            assert_eq!(l.mode, Mode::Wide, "{dpi} dpi");
            assert!(place(work, l.outer(frame)).inside(&work), "{dpi} dpi");
        }
        let work = Rect::new(0, 0, 1366, 768 - px(48, 120));
        let l = layout(120, work, frame_estimate(120));
        assert_eq!(l.mode, Mode::Wide);
        assert!(place(work, l.outer(frame_estimate(120))).inside(&work));
    }

    #[test]
    fn a_narrow_work_area_gets_the_compact_layout_and_it_fits() {
        // a 1080 x 1920 portrait screen at 150%: 720 logical pixels wide
        let work = Rect::new(0, 0, 1080, 1920 - 72);
        let frame = frame_estimate(144);
        let l = layout(144, work, frame);
        assert_eq!(l.mode, Mode::Compact);
        assert!(place(work, l.outer(frame)).inside(&work));
        // one card per tab, the footer on all of them
        assert!(l.shown(Id::Qr, 0) && !l.shown(Id::Qr, 1));
        assert!(l.shown(Id::Forget(0), 1) && !l.shown(Id::Forget(0), 2));
        assert!(l.shown(Id::UpdateBtn, 2) && l.shown(Id::Quit, 0) && l.shown(Id::Quit, 2));
    }

    #[test]
    fn the_window_opens_in_the_work_area_not_on_the_whole_screen() {
        // the taskbar on the left, 60 px wide: the window centres in what's left of it
        let work = Rect::new(60, 0, 1860, 1080);
        let at = place(work, (1140, 680));
        assert_eq!((at.x, at.y), (60 + 360, 200));
        // too big: kept at the work area's top left, not pushed off it
        assert_eq!(place(Rect::new(0, 40, 800, 500), (1000, 700)), Rect::new(0, 40, 1000, 700));
    }

    #[test]
    fn text_is_wrapped_then_cut_inside_its_box() {
        let m = |s: &str| s.chars().count() as i32 * 7;
        assert_eq!(fit_lines("Works once, until 22:41.", 200, 2, &m), vec!["Works once, until 22:41."]);
        let note = "The tunnel is still starting, so for now this code works on the same network or VPN. It's shown again once the tunnel is up.";
        let lines = fit_lines(note, 140, 2, &m);
        assert_eq!(lines.len(), 2);
        assert!(lines.iter().all(|l| m(l) <= 140), "{lines:?}");
        assert!(lines[1].ends_with('…'), "{lines:?}");
        // a word longer than the box is cut too
        let lines = fit_lines("wss://a-very-long-tunnel-name.trycloudflare.com/link", 70, 1, &m);
        assert!(m(&lines[0]) <= 70 && lines[0].ends_with('…'), "{lines:?}");
        assert!(fit_lines("anything", 70, 0, &m).is_empty());
    }
}
