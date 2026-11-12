//! What one pane's terminal shows: its screen, its scrollback and its title, kept up to date from
//! the bytes the program writes, and read back the way `tmux capture-pane -p` prints it.

use std::num::NonZeroU16;

use vt100::{Cell, Color};

/// Rows kept above the screen, as many as tmux's own default history.
pub const SCROLLBACK: usize = 2000;

/// The title a program sets with `ESC ] 2 ; … BEL`.
#[derive(Default)]
struct Title(String);

impl vt100::Callbacks for Title {
    fn set_window_title(&mut self, _: &mut vt100::Screen, title: &[u8]) {
        self.0 = String::from_utf8_lossy(title).into_owned();
    }
}

pub struct Screen {
    parser: vt100::Parser<Title>,
}

fn dim(n: u16) -> NonZeroU16 {
    NonZeroU16::new(n.max(1)).unwrap_or(NonZeroU16::MIN)
}

/// How `capture` prints.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Capture {
    /// rows of scrollback above the screen to print first (`-S -200` is 200)
    pub history: usize,
    /// with colours and styles as escape sequences (`-e`)
    pub escapes: bool,
    /// a line the terminal wrapped is printed as the one line it was (`-J`)
    pub join: bool,
}

impl Screen {
    pub fn new(cols: u16, rows: u16) -> Screen {
        Screen { parser: vt100::Parser::new_with_callbacks(dim(rows), dim(cols), SCROLLBACK, Title::default()) }
    }

    /// Takes what the program wrote.
    pub fn feed(&mut self, bytes: &[u8]) {
        self.parser.process(bytes);
    }

    pub fn resize(&mut self, cols: u16, rows: u16) {
        self.parser.screen_mut().set_size(dim(rows), dim(cols));
    }

    /// Columns and rows.
    pub fn size(&self) -> (u16, u16) {
        let (rows, cols) = self.parser.screen().size();
        (cols.get(), rows.get())
    }

    pub fn title(&self) -> &str {
        &self.parser.callbacks().0
    }

    /// The program asked for the keypad's application mode for the arrow keys (vim, less).
    pub fn application_cursor(&self) -> bool {
        self.parser.screen().application_cursor()
    }

    /// Where the cursor is (column, row, from 0), and whether it shows.
    pub fn cursor(&self) -> (u16, u16, bool) {
        let (row, col) = self.parser.screen().cursor_position();
        (col, row, !self.parser.screen().hide_cursor())
    }

    /// The program is on the alternate screen (a full-screen program such as vim or an agent's TUI).
    pub fn alternate(&self) -> bool {
        self.parser.screen().alternate_screen()
    }

    /// The program takes a paste between brackets, so a pasted newline doesn't run a line.
    pub fn bracketed_paste(&self) -> bool {
        self.parser.screen().bracketed_paste()
    }

    /// The screen as lines, top to bottom, each ending in a newline, as `capture-pane -p` prints
    /// it: trailing blanks dropped, scrollback first when asked for.
    pub fn capture(&mut self, how: Capture) -> String {
        let (cols, rows) = self.size();
        let mut lines: Vec<(String, bool)> = Vec::new();
        // scrollback is read by sliding the view up: at offset k its first row is the kth row above the screen
        let history = how.history.min(self.parser.screen().scrollback_len());
        for k in (1..=history).rev() {
            self.parser.screen_mut().set_scrollback(k);
            lines.push(self.row(0, cols, how.escapes));
        }
        self.parser.screen_mut().set_scrollback(0);
        for r in 0..rows {
            lines.push(self.row(r, cols, how.escapes));
        }
        let mut out = String::new();
        for (text, wrapped) in lines {
            out.push_str(&text);
            if !(how.join && wrapped) {
                out.push('\n');
            }
        }
        out
    }

    /// One row on view: its text (styled when `escapes`), and whether it runs on into the next.
    fn row(&self, row: u16, cols: u16, escapes: bool) -> (String, bool) {
        let screen = self.parser.screen();
        let wrapped = screen.row_wrapped(row);
        // the row ends at its last cell that shows something: blanks after it don't print, as in
        // tmux, unless they carry a background
        let shows = |x: &Cell| x.is_wide_continuation() || (x.has_contents() && x.contents() != " ") || x.bgcolor() != Color::Default || x.inverse();
        let last = (0..cols).rev().find(|&c| screen.cell(row, c).is_some_and(shows));
        let Some(last) = last else { return (String::new(), wrapped) };
        let mut out = String::new();
        let mut style = Style::default();
        for c in 0..=last {
            let Some(cell) = screen.cell(row, c) else { break };
            if cell.is_wide_continuation() {
                continue;
            }
            if escapes {
                let now = Style::of(cell);
                if now != style {
                    out.push_str(&now.sgr());
                    style = now;
                }
            }
            if cell.has_contents() {
                out.push_str(cell.contents());
            } else {
                out.push(' ');
            }
        }
        if escapes && style != Style::default() {
            out.push_str("\x1b[0m");
        }
        (out, wrapped)
    }
}

/// The look of a cell, to say again only when it changes along a row.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
struct Style {
    fg: Color,
    bg: Color,
    bold: bool,
    dim: bool,
    italic: bool,
    underline: bool,
    inverse: bool,
}

impl Style {
    fn of(c: &Cell) -> Style {
        Style { fg: c.fgcolor(), bg: c.bgcolor(), bold: c.bold(), dim: c.dim(), italic: c.italic(), underline: c.underline(), inverse: c.inverse() }
    }

    /// One sequence that sets this look from nothing: a reset, then what's on.
    fn sgr(&self) -> String {
        let mut p = vec!["0".to_string()];
        for (on, code) in [(self.bold, "1"), (self.dim, "2"), (self.italic, "3"), (self.underline, "4"), (self.inverse, "7")] {
            if on {
                p.push(code.to_string());
            }
        }
        color(&mut p, self.fg, 30, 90, "38");
        color(&mut p, self.bg, 40, 100, "48");
        format!("\x1b[{}m", p.join(";"))
    }
}

fn color(p: &mut Vec<String>, c: Color, base: u16, bright: u16, extended: &str) {
    match c {
        Color::Default => {}
        Color::Idx(n) if n < 8 => p.push((base + u16::from(n)).to_string()),
        Color::Idx(n) if n < 16 => p.push((bright + u16::from(n) - 8).to_string()),
        Color::Idx(n) => p.push(format!("{extended};5;{n}")),
        Color::Rgb(r, g, b) => p.push(format!("{extended};2;{r};{g};{b}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plain(s: &mut Screen) -> String {
        s.capture(Capture::default())
    }

    #[test]
    fn what_a_program_prints_is_on_the_screen_one_line_each() {
        let mut s = Screen::new(20, 4);
        s.feed(b"hello\r\nworld  \r\n");
        // every row prints, and blanks at a line's end don't
        assert_eq!(plain(&mut s), "hello\nworld\n\n\n");
        assert_eq!(s.size(), (20, 4));
    }

    #[test]
    fn a_program_that_redraws_leaves_only_what_it_drew_last() {
        let mut s = Screen::new(20, 3);
        s.feed(b"Thinking...");
        // back to the line's start, clear it, write again: as a spinner does
        s.feed(b"\r\x1b[2Kdone\r\n");
        // then up a line and over its end
        s.feed(b"\x1b[1;5H!");
        assert_eq!(plain(&mut s), "done!\n\n\n");
    }

    #[test]
    fn rows_that_scroll_off_are_kept_and_asked_for_by_count() {
        let mut s = Screen::new(10, 3);
        for i in 1..=8 {
            s.feed(format!("line {i}\r\n").as_bytes());
        }
        // the cursor sits on the blank row under the last line
        assert_eq!(plain(&mut s), "line 7\nline 8\n\n");
        assert_eq!(s.capture(Capture { history: 2, ..Capture::default() }), "line 5\nline 6\nline 7\nline 8\n\n");
        // asking for more than there is gives all of it, oldest first
        let all = s.capture(Capture { history: 200, ..Capture::default() });
        assert_eq!(all, "line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\n\n");
        // and reading history leaves the view where it was
        assert_eq!(plain(&mut s), "line 7\nline 8\n\n");
    }

    #[test]
    fn a_wrapped_line_is_two_rows_or_one_line_when_joined() {
        let mut s = Screen::new(10, 3);
        s.feed(b"abcdefghijKLM\r\nnext");
        assert_eq!(plain(&mut s), "abcdefghij\nKLM\nnext\n");
        assert_eq!(s.capture(Capture { join: true, ..Capture::default() }), "abcdefghijKLM\nnext\n");
    }

    #[test]
    fn colours_and_styles_come_back_as_escapes_only_when_asked() {
        let mut s = Screen::new(30, 2);
        s.feed(b"\x1b[1;31mError\x1b[0m: \x1b[38;5;208mwarm\x1b[0m \x1b[48;2;1;2;3mrgb\x1b[0m");
        assert_eq!(plain(&mut s), "Error: warm rgb\n\n");
        let e = s.capture(Capture { escapes: true, ..Capture::default() });
        assert_eq!(e, "\x1b[0;1;31mError\x1b[0m: \x1b[0;38;5;208mwarm\x1b[0m \x1b[0;48;2;1;2;3mrgb\x1b[0m\n\n");
    }

    #[test]
    fn wide_characters_take_two_columns_and_print_once() {
        let mut s = Screen::new(10, 2);
        s.feed("세션 🪁 ok".as_bytes());
        assert_eq!(plain(&mut s), "세션 🪁 ok\n\n");
    }

    #[test]
    fn the_title_a_program_sets_and_the_modes_it_asks_for() {
        let mut s = Screen::new(20, 2);
        assert_eq!(s.title(), "");
        s.feed("\x1b]2;✳ Fix the test\x07".as_bytes());
        assert_eq!(s.title(), "✳ Fix the test");
        assert!(!s.bracketed_paste() && !s.application_cursor());
        s.feed(b"\x1b[?2004h\x1b[?1h");
        assert!(s.bracketed_paste() && s.application_cursor());
    }

    #[test]
    fn the_cursor_and_the_alternate_screen_are_told() {
        let mut s = Screen::new(20, 4);
        s.feed(b"ab\r\ncde");
        assert_eq!((s.cursor(), s.alternate()), ((3, 1, true), false));
        // a full-screen program: the other screen, the cursor hidden and put somewhere
        s.feed(b"\x1b[?1049h\x1b[?25l\x1b[3;10H");
        assert_eq!((s.cursor(), s.alternate()), ((9, 2, false), true));
        s.feed(b"\x1b[?1049l\x1b[?25h");
        assert!(!s.alternate() && s.cursor().2);
    }

    #[test]
    fn a_resize_keeps_what_fits() {
        let mut s = Screen::new(20, 4);
        s.feed(b"one\r\ntwo\r\n");
        s.resize(10, 2);
        assert_eq!(s.size(), (10, 2));
        assert!(plain(&mut s).lines().count() == 2);
    }
}
