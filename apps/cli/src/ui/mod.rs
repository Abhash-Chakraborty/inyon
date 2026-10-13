//! What the terminal shows: the palette as the terminal's own colours, the mark, and the small
//! motif that plays while the engine answers. Silver and ink only, no accent colour; the
//! terminal's default foreground stands in for ink on paper or paper on graphite.

pub mod dashboard;
pub mod setup;

use ratatui::style::{Color, Modifier, Style};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// The Inyon mark in text: a kite on a slack line, ending in a node.
pub const MARK: [&str; 2] = ["◆", " ╰─●"];

/// The kite's line drawing itself: three frames, shown while the engine answers.
pub const MOTIF: [&str; 3] = ["◆        ●", "◆ ╰──    ●", "◆ ╰──────●"];

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
    vec![format!("  {}", MARK[0]), format!("  {}   inyon {VERSION}", MARK[1])]
}

/// A line cut to `width` cells, with an ellipsis when it had to be.
pub fn fit(s: &str, width: usize) -> String {
    let n = s.chars().count();
    if n <= width {
        return s.to_string();
    }
    if width == 0 {
        return String::new();
    }
    let mut out: String = s.chars().take(width - 1).collect();
    out.push('…');
    out
}

/// `text` as lines no wider than `width`, broken between words.
pub fn wrap(text: &str, width: usize) -> Vec<String> {
    if width == 0 {
        return vec![String::new()];
    }
    let mut lines = Vec::new();
    let mut line = String::new();
    for word in text.split_whitespace() {
        let next = if line.is_empty() { word.chars().count() } else { line.chars().count() + 1 + word.chars().count() };
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

/// Asks for a secret on the terminal without echoing it.
pub fn ask_hidden(prompt: &str) -> Result<String, String> {
    use std::io::{BufRead, Write};
    let mut err = std::io::stderr();
    let _ = write!(err, "{prompt}");
    let _ = err.flush();
    let raw = crossterm::terminal::enable_raw_mode().is_ok();
    let mut text = String::new();
    if raw {
        use crossterm::event::{read, Event, KeyCode, KeyModifiers};
        loop {
            match read().map_err(|e| e.to_string())? {
                Event::Key(k) if k.code == KeyCode::Enter => break,
                Event::Key(k) if k.code == KeyCode::Char('c') && k.modifiers.contains(KeyModifiers::CONTROL) => {
                    let _ = crossterm::terminal::disable_raw_mode();
                    return Err("Stopped.".into());
                }
                Event::Key(k) if k.code == KeyCode::Backspace => {
                    text.pop();
                }
                Event::Key(k) => {
                    if let KeyCode::Char(c) = k.code {
                        text.push(c);
                    }
                }
                _ => {}
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
    }

    #[test]
    fn fit_cuts_with_an_ellipsis() {
        assert_eq!(fit("hello", 10), "hello");
        assert_eq!(fit("hello world", 6), "hello…");
        assert_eq!(fit("x", 0), "");
    }

    #[test]
    fn wrap_breaks_between_words() {
        assert_eq!(wrap("the hub signs you in from a browser", 12), vec!["the hub", "signs you in", "from a", "browser"]);
        assert_eq!(wrap("short", 40), vec!["short"]);
        assert_eq!(wrap("averyveryverylongword", 8), vec!["averyve…"]);
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
