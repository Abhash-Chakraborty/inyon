//! The shell's two edges that move (from 0.25.6, components/session/PanelResize.tsx and
//! AppShell.tsx): how wide a session's side panel may be dragged, and what the sidebar's fold is
//! called. Both are kept in the settings the web app shares, so one app's choice holds in the other.

/// The narrowest the side panel goes, and the least it leaves the chat beside it.
pub const PANEL_MIN: f64 = 340.0;
pub const CHAT_MIN: f64 = 420.0;
/// One press of an arrow key on the handle.
pub const STEP: f64 = 24.0;
/// The sidebar and its fold are for a screen this wide; below it a phone's tab bar takes over.
pub const SIDEBAR_FROM: f64 = 768.0;

/// A width kept between the panel's least and what the row can give up (`row`: the chat and the
/// panel together).
pub fn clamp_panel(w: f64, row: f64) -> f64 {
    let most = (row - CHAT_MIN).max(PANEL_MIN);
    if w.is_nan() {
        return PANEL_MIN;
    }
    w.min(most).max(PANEL_MIN).round()
}

/// The width the panel comes with until it has been dragged: 480px on a very wide screen.
pub fn usual_width(viewport: f64) -> f64 {
    if viewport >= 1536.0 {
        480.0
    } else {
        420.0
    }
}

/// The panel's own width, least and most once it has been dragged (`width` is 0 until then, and
/// the stylesheet's width holds). The row caps it in CSS too, so a window made narrower never
/// squeezes the chat out. Three properties rather than one `style`: Dioxus keeps what an earlier
/// `style` set and a later one leaves out, so a width taken away would stay.
pub fn panel_box(width: f64) -> [Option<String>; 3] {
    if width > 0.0 {
        [Some(format!("{}px", width.round())), Some(format!("{PANEL_MIN}px")), Some(format!("calc(100% - {CHAT_MIN}px)"))]
    } else {
        [None, None, None]
    }
}

/// What a key does on the handle: the width to keep, where 0 is the usual one again. The handle is
/// the panel's left edge, so left makes it wider.
pub fn handle_key(key: &str, now: f64, row: f64) -> Option<f64> {
    match key {
        "ArrowLeft" => Some(clamp_panel(now + STEP, row)),
        "ArrowRight" => Some(clamp_panel(now - STEP, row)),
        "Home" | "Enter" => Some(0.0),
        _ => None,
    }
}

/// The fold's key, as its tooltips and the page menu show it.
pub fn fold_key(mac: bool) -> &'static str {
    if mac {
        "⌘ B"
    } else {
        "Ctrl B"
    }
}

/// The fold's name for where the sidebar is now.
pub fn fold_label(open: bool) -> &'static str {
    if open {
        "Hide sidebar"
    } else {
        "Show sidebar"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_panel_stays_between_its_least_and_what_the_chat_can_spare() {
        // a row of 1176px (a 1440px window beside the open sidebar)
        assert_eq!(clamp_panel(500.4, 1176.0), 500.0);
        assert_eq!(clamp_panel(100.0, 1176.0), PANEL_MIN);
        assert_eq!(clamp_panel(2000.0, 1176.0), 1176.0 - CHAT_MIN);
        assert_eq!(clamp_panel(f64::INFINITY, 1176.0), 756.0);
        // a row too narrow for both keeps the panel's least rather than going under it
        assert_eq!(clamp_panel(500.0, 700.0), PANEL_MIN);
        assert_eq!(clamp_panel(f64::NAN, 1176.0), PANEL_MIN);
    }

    #[test]
    fn the_panel_has_no_width_of_its_own_until_it_is_dragged() {
        assert_eq!(panel_box(0.0), [None, None, None]);
        assert_eq!(panel_box(-20.0), [None, None, None]);
        assert_eq!(panel_box(512.3).map(Option::unwrap), ["512px", "340px", "calc(100% - 420px)"]);
        assert_eq!((usual_width(1440.0), usual_width(1536.0)), (420.0, 480.0));
    }

    #[test]
    fn arrows_move_the_handle_a_step_and_home_puts_the_usual_width_back() {
        assert_eq!(handle_key("ArrowLeft", 420.0, 1176.0), Some(444.0));
        assert_eq!(handle_key("ArrowRight", 420.0, 1176.0), Some(396.0));
        // at either end a step stays inside
        assert_eq!(handle_key("ArrowRight", 350.0, 1176.0), Some(PANEL_MIN));
        assert_eq!(handle_key("ArrowLeft", 750.0, 1176.0), Some(756.0));
        assert_eq!(handle_key("Home", 600.0, 1176.0), Some(0.0));
        assert_eq!(handle_key("Enter", 600.0, 1176.0), Some(0.0));
        assert_eq!(handle_key("a", 600.0, 1176.0), None);
    }

    #[test]
    fn the_fold_is_named_for_what_it_does_next() {
        assert_eq!((fold_label(true), fold_label(false)), ("Hide sidebar", "Show sidebar"));
        assert_eq!((fold_key(true), fold_key(false)), ("⌘ B", "Ctrl B"));
    }
}
