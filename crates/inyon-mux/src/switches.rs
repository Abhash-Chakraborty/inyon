//! Takes a program's alternate-screen switches out of what an attached terminal is sent. That
//! terminal is already on its alternate screen for the whole attachment, so that what was in it
//! comes back afterwards; a program's own `ESC [ ? 1049 l` passed through would drop it onto its
//! first screen in the middle of things. The pane's reader sends a fresh picture when the program
//! switches, so nothing is lost by leaving the switch itself out.

/// The private modes that switch screens.
const SWITCHES: [&str; 3] = ["47", "1047", "1049"];

/// Filters a stream chunk by chunk: a sequence cut in two by a read is held until its end arrives.
#[derive(Default)]
pub struct Filter {
    held: Vec<u8>,
}

impl Filter {
    /// `bytes` without the screen switches; what may be the start of one waits for the next call.
    pub fn pass(&mut self, bytes: &[u8]) -> Vec<u8> {
        let mut input = std::mem::take(&mut self.held);
        input.extend_from_slice(bytes);
        let mut out = Vec::with_capacity(input.len());
        let mut i = 0;
        while i < input.len() {
            if input[i] != 0x1b {
                out.push(input[i]);
                i += 1;
                continue;
            }
            // ESC [ ? digits and semicolons, then h or l
            let rest = &input[i..];
            let starts = |p: &[u8]| rest.len() >= p.len() && &rest[..p.len()] == p;
            if rest.len() < 3 && b"\x1b[?".starts_with(rest) {
                self.held = rest.to_vec();
                break;
            }
            if !starts(b"\x1b[?") {
                out.push(0x1b);
                i += 1;
                continue;
            }
            let params = rest[3..].iter().take_while(|b| b.is_ascii_digit() || **b == b';').count();
            let Some(&last) = rest.get(3 + params) else {
                // no end yet: wait for it, unless this has gone on too long to be one of ours
                if rest.len() > 64 {
                    out.extend_from_slice(rest);
                } else {
                    self.held = rest.to_vec();
                }
                break;
            };
            let whole = &rest[..3 + params + 1];
            if last == b'h' || last == b'l' {
                let text = String::from_utf8_lossy(&rest[3..3 + params]).into_owned();
                let kept: Vec<&str> = text.split(';').filter(|p| !SWITCHES.contains(p)).collect();
                if kept.len() == text.split(';').count() {
                    out.extend_from_slice(whole);
                } else if !kept.is_empty() {
                    // the other modes set in the same breath stay
                    out.extend_from_slice(format!("\x1b[?{}{}", kept.join(";"), last as char).as_bytes());
                }
            } else {
                out.extend_from_slice(whole);
            }
            i += whole.len();
        }
        out
    }
}

/// A whole buffer without the switches (a first picture, which is never cut in two).
pub fn strip(bytes: &[u8]) -> Vec<u8> {
    let mut f = Filter::default();
    let mut out = f.pass(bytes);
    out.extend(std::mem::take(&mut f.held));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_switches_go_and_everything_else_stays() {
        assert_eq!(strip(b"a\x1b[?1049hb\x1b[?1049lc"), b"abc");
        assert_eq!(strip(b"\x1b[?47h\x1b[?1047l"), b"");
        // other private modes, colours and plain escapes are untouched
        let other = b"\x1b[?25l\x1b[?2004h\x1b[1;31mred\x1b[0m\x1b]2;title\x07\x1b[2J\x1bM";
        assert_eq!(strip(other), other);
        // a mode set together with a switch keeps its place
        assert_eq!(strip(b"\x1b[?1049;25h"), b"\x1b[?25h");
        assert_eq!(strip(b"\x1b[?25;1049;2004l"), b"\x1b[?25;2004l");
    }

    #[test]
    fn a_switch_cut_in_two_by_a_read_is_still_caught() {
        for cut in 1..8 {
            let whole = b"x\x1b[?1049hy";
            let mut f = Filter::default();
            let mut out = f.pass(&whole[..cut]);
            out.extend(f.pass(&whole[cut..]));
            assert_eq!(out, b"xy", "cut at {cut}");
        }
        // an escape at the very end waits, and comes out when it turns out to be something else
        let mut f = Filter::default();
        assert_eq!(f.pass(b"a\x1b"), b"a");
        assert_eq!(f.pass(b"[1mb"), b"\x1b[1mb");
    }

    #[test]
    fn what_never_ends_is_let_through_rather_than_held_for_ever() {
        let mut f = Filter::default();
        let long = [b"\x1b[?".as_slice(), &[b'1'; 80]].concat();
        assert_eq!(f.pass(&long), long);
        assert!(f.held.is_empty());
    }
}
