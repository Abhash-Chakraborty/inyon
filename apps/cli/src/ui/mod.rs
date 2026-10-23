//! What the terminal shows: the palette as the terminal's own colours, the mark, and the small
//! motif that plays while the engine answers. Silver and ink only, no accent colour; the
//! terminal's default foreground stands in for ink on paper or paper on graphite.

pub mod dashboard;
pub mod setup;

use ratatui::style::{Color, Modifier, Style};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// The Inyon mark in text: a kite on a line that hangs from it, ending in a node. The corner
/// sits right under the kite, so the line meets it in any monospace font.
pub const MARK: [&str; 2] = ["◆", "╰─●"];

/// The kite's line drawing itself: three frames, shown while the engine answers.
pub const MOTIF: [&str; 3] = ["◆        ●", "◆───     ●", "◆────────●"];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Theme {
    pub color: bool,
}

impl Theme {
    /// Colour unless NO_COLOR is set (any value) or the output isn't a terminal.
    pub fn detect(is_tty: bool) -> Theme {
        Theme { color: is_tty && std::env::var_os("NO_COLOR").is_none() && std::env::var("TERM").map(|t| t != "dumb").unwrap_or(true) }
    }

    pub const fn plain() -> Theme {
        Theme { color: false }
    }

    pub const fn colored() -> Theme {
        Theme { color: true }
    }

    fn c(self, s: Style) -> Style {
        if self.color {
            s
        } else {
            Style::default()
        }
    }

    /// ink on paper, paper on graphite: the terminal's own foreground
    pub fn strong(self) -> Style {
        self.c(Style::default().add_modifier(Modifier::BOLD))
    }

    pub fn body(self) -> Style {
        Style::default()
    }

    /// silver #b4b2ab
    pub fn muted(self) -> Style {
        self.c(Style::default().fg(Color::Indexed(249)))
    }

    /// subtle #959389
    pub fn faint(self) -> Style {
        self.c(Style::default().fg(Color::Indexed(245)))
    }

    /// hairlines #45433f
    pub fn line(self) -> Style {
        self.c(Style::default().fg(Color::Indexed(240)))
    }

    /// a state that needs you: the only warm tone, used on the dot alone
    pub fn attention(self) -> Style {
        self.c(Style::default().fg(Color::Indexed(180)))
    }

    pub fn error(self) -> Style {
        self.c(Style::default().fg(Color::Indexed(174)))
    }

    /// the selected row: inverted, like a pill
    pub fn selected(self) -> Style {
        self.c(Style::default().add_modifier(Modifier::REVERSED))
    }
}

/// The one-line banner: the mark and the version, shortened on narrow terminals.
pub fn banner(width: u16) -> Vec<String> {
    if width < 40 {
        return vec![format!("◆╰─● inyon {VERSION}")];
    }
    vec![format!("  {}", MARK[0]), format!("  {}    inyon {VERSION}", MARK[1])]
}

/// How many terminal columns `s` takes: two for a CJK character or most emoji, none for a
/// combining mark.
pub fn columns(s: &str) -> usize {
    unicode_width::UnicodeWidthStr::width(s)
}

/// A line cut to `width` columns, with an ellipsis when it had to be.
pub fn fit(s: &str, width: usize) -> String {
    if columns(s) <= width {
        return s.to_string();
    }
    if width == 0 {
        return String::new();
    }
    let mut out = String::new();
    let mut used = 0;
    for c in s.chars() {
        let w = unicode_width::UnicodeWidthChar::width(c).unwrap_or(0);
        if used + w > width - 1 {
            break;
        }
        used += w;
        out.push(c);
    }
    out.push('…');
    out
}

/// `s` cut to `width` columns and filled out with spaces to exactly that, so what follows it
/// lines up.
pub fn pad(s: &str, width: usize) -> String {
    let mut out = fit(s, width);
    out.push_str(&" ".repeat(width.saturating_sub(columns(&out))));
    out
}

/// `text` as lines no wider than `width` columns, broken between words.
pub fn wrap(text: &str, width: usize) -> Vec<String> {
    if width == 0 {
        return vec![String::new()];
    }
    let mut lines = Vec::new();
    let mut line = String::new();
    for word in text.split_whitespace() {
        let next = if line.is_empty() { columns(word) } else { columns(&line) + 1 + columns(word) };
        if next > width && !line.is_empty() {
            lines.push(std::mem::take(&mut line));
        }
        if !line.is_empty() {
            line.push(' ');
        }
        line.push_str(word);
    }
    if !line.is_empty() || lines.is_empty() {
        lines.push(line);
    }
    lines.into_iter().map(|l| fit(&l, width)).collect()
}

/// One line of progress on stderr, redrawn in place.
pub fn progress_line(text: &str) {
    use std::io::Write;
    let mut out = std::io::stderr();
    let _ = write!(out, "\r\x1b[2K{text}");
    let _ = out.flush();
}

/// Asks a yes-or-no question on the terminal. An empty answer, or one that can't be read, is
/// `default`.
pub fn ask_yes_no(question: &str, default: bool) -> bool {
    use std::io::{BufRead, Write};
    let mut err = std::io::stderr();
    let _ = write!(err, "{question} [{}] ", if default { "Y/n" } else { "y/N" });
    let _ = err.flush();
    let mut line = String::new();
    if std::io::stdin().lock().read_line(&mut line).is_err() {
        return default;
    }
    match line.trim().to_ascii_lowercase().as_str() {
        "y" | "yes" => true,
        "n" | "no" => false,
        _ => default,
    }
}

/// Waits for Enter, for a window that would close as soon as the command ends.
pub fn wait_for_enter() {
    use std::io::{BufRead, Write};
    let _ = write!(std::io::stderr(), "Press Enter to close this window. ");
    let _ = std::io::stderr().flush();
    let mut line = String::new();
    let _ = std::io::stdin().lock().read_line(&mut line);
}

/// Asks for a secret on the terminal without echoing it.
pub fn ask_hidden(prompt: &str) -> Result<String, String> {
    use std::io::{BufRead, Write};
    let mut err = std::io::stderr();
    let _ = write!(err, "{prompt}");
    let _ = err.flush();
    let raw = crossterm::terminal::enable_raw_mode().is_ok();
    let mut text = String::new();
    if raw {
        loop {
            let crossterm::event::Event::Key(k) = crossterm::event::read().map_err(|e| e.to_string())? else { continue };
            match hidden_key(&mut text, k) {
                Hidden::More => {}
                Hidden::Done => break,
                Hidden::Stopped => {
                    let _ = crossterm::terminal::disable_raw_mode();
                    return Err("Stopped.".into());
                }
            }
        }
        let _ = crossterm::terminal::disable_raw_mode();
    } else {
        // no terminal (a pipe): the line as it comes
        std::io::stdin().lock().read_line(&mut text).map_err(|e| e.to_string())?;
    }
    let _ = writeln!(err);
    Ok(text.trim_end_matches(['\r', '\n']).to_string())
}

/// What a key did to a secret being typed.
#[derive(Debug, PartialEq, Eq)]
pub enum Hidden {
    More,
    Done,
    Stopped,
}

/// One key of a secret typed with no echo. Windows reports a key's release as well as its press,
/// so only presses (and a held key's repeats) count, or every letter would be typed twice.
pub fn hidden_key(text: &mut String, k: crossterm::event::KeyEvent) -> Hidden {
    use crossterm::event::{KeyCode, KeyEventKind, KeyModifiers};
    if k.kind == KeyEventKind::Release {
        return Hidden::More;
    }
    match k.code {
        KeyCode::Enter => Hidden::Done,
        KeyCode::Char('c') if k.modifiers.contains(KeyModifiers::CONTROL) => Hidden::Stopped,
        KeyCode::Backspace => {
            text.pop();
            Hidden::More
        }
        KeyCode::Char(c) => {
            text.push(c);
            Hidden::More
        }
        _ => Hidden::More,
    }
}

/// Prints `frames` one after another while `work` runs on another thread, then its result.
pub fn with_motif<T: Send + 'static>(label: &str, theme: Theme, work: impl FnOnce() -> T + Send + 'static) -> T {
    use std::io::Write;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(work());
    });
    let mut i = 0usize;
    let mut out = std::io::stderr();
    loop {
        match rx.recv_timeout(std::time::Duration::from_millis(220)) {
            Ok(v) => {
                let _ = write!(out, "\r{}\r", " ".repeat(label.chars().count() + 12));
                let _ = out.flush();
                return v;
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                let frame = MOTIF[i % MOTIF.len()];
                if theme.color {
                    let _ = write!(out, "\r\x1b[38;5;245m{frame}\x1b[0m {label}");
                } else {
                    let _ = write!(out, "\r{frame} {label}");
                }
                let _ = out.flush();
                i += 1;
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => unreachable!("the worker always sends"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_banner_shrinks_on_narrow_terminals() {
        assert_eq!(banner(30), vec![format!("◆╰─● inyon {VERSION}")]);
        assert_eq!(banner(80).len(), 2);
        assert!(banner(80)[1].contains("inyon"));
        // the line's corner is in the kite's column, so it hangs from the kite
        let kite = banner(80)[0].find('◆').unwrap();
        assert_eq!(banner(80)[1].find('╰').unwrap(), kite);
    }

    #[test]
    fn fit_cuts_with_an_ellipsis() {
        assert_eq!(fit("hello", 10), "hello");
        assert_eq!(fit("hello world", 6), "hello…");
        assert_eq!(fit("x", 0), "");
    }

    #[test]
    fn widths_are_terminal_columns_not_characters() {
        // a Korean name takes two columns a character, an emoji two, a combining accent none
        assert_eq!(columns("인연"), 4);
        assert_eq!(columns("📱"), 2);
        assert_eq!(columns("e\u{301}"), 1);
        assert_eq!(fit("인연 폰", 4), "인…");
        assert!(columns(&fit("인연 폰", 4)) <= 4);
        assert_eq!(fit("📱 Pixel", 3), "📱…");
        assert_eq!(pad("인연", 6), "인연  ");
        assert_eq!(columns(&pad("갤럭시 탭 S9 울트라", 10)), 10);
        // wrapped lines stay within the width in columns
        for l in wrap("갤럭시 탭 울트라 휴대폰 이름이 길다", 8) {
            assert!(columns(&l) <= 8, "{l}");
        }
    }

    #[test]
    fn wrap_breaks_between_words() {
        assert_eq!(wrap("the hub signs you in from a browser", 12), vec!["the hub", "signs you in", "from a", "browser"]);
        assert_eq!(wrap("short", 40), vec!["short"]);
        assert_eq!(wrap("averyveryverylongword", 8), vec!["averyve…"]);
    }

    #[test]
    fn a_secret_counts_each_key_once_when_windows_reports_the_release_too() {
        use crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyEventState, KeyModifiers};
        let key = |c: KeyCode, kind: KeyEventKind| KeyEvent { code: c, modifiers: KeyModifiers::NONE, kind, state: KeyEventState::NONE };
        let mut text = String::new();
        for c in ['a', 'b'] {
            assert_eq!(hidden_key(&mut text, key(KeyCode::Char(c), KeyEventKind::Press)), Hidden::More);
            assert_eq!(hidden_key(&mut text, key(KeyCode::Char(c), KeyEventKind::Release)), Hidden::More);
        }
        assert_eq!(text, "ab");
        hidden_key(&mut text, key(KeyCode::Backspace, KeyEventKind::Press));
        hidden_key(&mut text, key(KeyCode::Backspace, KeyEventKind::Release));
        assert_eq!(text, "a");
        assert_eq!(hidden_key(&mut text, key(KeyCode::Enter, KeyEventKind::Release)), Hidden::More);
        assert_eq!(hidden_key(&mut text, key(KeyCode::Enter, KeyEventKind::Press)), Hidden::Done);
    }

    #[test]
    fn no_color_turns_every_style_off() {
        assert_eq!(Theme::plain().muted(), Style::default());
        assert_ne!(Theme::colored().muted(), Style::default());
    }

    #[test]
    fn the_motif_draws_the_line_in_three_frames() {
        assert_eq!(MOTIF.len(), 3);
        assert!(MOTIF.iter().all(|f| f.starts_with('◆') && f.ends_with('●')));
        assert!(MOTIF[2].matches('─').count() > MOTIF[1].matches('─').count());
    }
}
