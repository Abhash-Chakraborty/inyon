//! `inyon attach <session>`: this terminal on a session Inyon keeps itself, the way `tmux attach`
//! puts it on a tmux one. Keys go to the program, what it draws shows here, and the session's
//! window takes this terminal's size. `Ctrl-b d` lets go and leaves the session running;
//! `Ctrl-b Ctrl-b` sends a real `Ctrl-b`.

use std::io::{Read, Write};
use std::os::fd::AsRawFd;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use crate::serve::{attach, frame, put_frame, socket_path, take_frame};

/// The key before `d` that lets go: tmux's own prefix.
const PREFIX: u8 = 0x02;

/// What the keys typed so far mean: bytes for the program, and whether to let go.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Keys {
    pub send: Vec<u8>,
    pub detach: bool,
}

/// Reads keys for the prefix: `Ctrl-b d` detaches, `Ctrl-b Ctrl-b` is one `Ctrl-b`, and `Ctrl-b`
/// then anything else is passed on whole, as the program may have a use for it. `held` carries a
/// `Ctrl-b` typed at the end of one read over to the next.
pub fn read_keys(held: &mut bool, bytes: &[u8]) -> Keys {
    let mut k = Keys::default();
    for &b in bytes {
        if *held {
            *held = false;
            match b {
                b'd' | b'D' | 0x04 => {
                    k.detach = true;
                    return k;
                }
                PREFIX => k.send.push(PREFIX),
                other => k.send.extend([PREFIX, other]),
            }
        } else if b == PREFIX {
            *held = true;
        } else {
            k.send.push(b);
        }
    }
    k
}

/// This terminal's size in columns and rows, when stdout is one.
fn size() -> Option<(u16, u16)> {
    // SAFETY: winsize is plain numbers, and the call fills it or fails
    let mut w: libc::winsize = unsafe { std::mem::zeroed() };
    let ok = unsafe { libc::ioctl(libc::STDOUT_FILENO, libc::TIOCGWINSZ, &mut w) } == 0;
    (ok && w.ws_col > 0 && w.ws_row > 0).then_some((w.ws_col, w.ws_row))
}

/// The terminal as it was, put back when this goes: raw mode off, the first screen back.
struct Raw(libc::termios);

impl Raw {
    /// Every key at once and unechoed, on a screen of its own so what was there comes back.
    fn enter() -> Option<Raw> {
        // SAFETY: termios is plain data filled by tcgetattr, and stdin is a valid descriptor
        let mut t: libc::termios = unsafe { std::mem::zeroed() };
        if unsafe { libc::tcgetattr(libc::STDIN_FILENO, &mut t) } != 0 {
            return None;
        }
        let was = t;
        // SAFETY: as above; cfmakeraw only edits the struct
        unsafe {
            libc::cfmakeraw(&mut t);
            libc::tcsetattr(libc::STDIN_FILENO, libc::TCSANOW, &t);
        }
        print!("\x1b[?1049h\x1b[H\x1b[2J");
        let _ = std::io::stdout().flush();
        Some(Raw(was))
    }
}

impl Drop for Raw {
    fn drop(&mut self) {
        // whatever the program turned on in this terminal goes off: mouse, bracketed paste, a hidden
        // cursor, colours; then the screen that was there before
        print!("\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[?25h\x1b[0m\x1b[?1049l");
        let _ = std::io::stdout().flush();
        // SAFETY: the termios came from tcgetattr on this descriptor
        unsafe {
            libc::tcsetattr(libc::STDIN_FILENO, libc::TCSANOW, &self.0);
        }
    }
}

/// Runs `inyon attach [session]`; the exit code.
pub fn run(target: Option<&str>) -> i32 {
    // SAFETY: isatty only looks at the descriptor
    let terminal = unsafe { libc::isatty(libc::STDIN_FILENO) == 1 && libc::isatty(libc::STDOUT_FILENO) == 1 };
    if !terminal {
        eprintln!("inyon attach needs a terminal to show the session in.");
        return 1;
    }
    let socket = socket_path();
    let (cols, rows) = size().unwrap_or((80, 24));
    let mut stream = match attach(&socket, target, cols, rows) {
        Ok(Ok(s)) => s,
        Ok(Err(reply)) => {
            eprint!("{}", reply.err);
            return reply.code;
        }
        Err(_) => {
            eprintln!("Inyon keeps no sessions on this computer right now. (Sessions in tmux open with tmux attach.)");
            return 1;
        }
    };
    let Some(raw) = Raw::enter() else {
        eprintln!("inyon attach couldn't take over this terminal.");
        return 1;
    };
    let done = Arc::new(AtomicBool::new(false));
    // what the keeper sends is drawn as it comes
    let (mut from, over) = (stream.try_clone().ok(), done.clone());
    let draw = std::thread::spawn(move || {
        let mut why = String::from("the keeper stopped");
        while let Some(s) = from.as_mut() {
            match take_frame(s) {
                Ok((frame::OUTPUT, bytes)) => {
                    let mut out = std::io::stdout().lock();
                    let _ = out.write_all(&bytes).and_then(|()| out.flush());
                }
                Ok((frame::END, reason)) => {
                    why = String::from_utf8_lossy(&reason).into_owned();
                    break;
                }
                Ok(_) => {}
                Err(_) => break,
            }
        }
        over.store(true, Ordering::SeqCst);
        why
    });
    // keys, and this terminal's size whenever it changes; stdin is asked with a short wait so the
    // end of the session is noticed without a key
    let (mut held, mut last, mut detached) = (false, (cols, rows), false);
    let mut buf = [0u8; 4096];
    let stdin_fd = std::io::stdin().as_raw_fd();
    while !done.load(Ordering::SeqCst) {
        if let Some(now) = size().filter(|s| *s != last) {
            last = now;
            let [a, b] = now.0.to_be_bytes();
            let [c, d] = now.1.to_be_bytes();
            if put_frame(&mut stream, frame::RESIZE, &[a, b, c, d]).is_err() {
                break;
            }
        }
        let mut fds = [libc::pollfd { fd: stdin_fd, events: libc::POLLIN, revents: 0 }];
        // SAFETY: one valid pollfd, with its count
        if unsafe { libc::poll(fds.as_mut_ptr(), 1, 150) } <= 0 {
            continue;
        }
        let n = match std::io::stdin().lock().read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        let keys = read_keys(&mut held, &buf[..n]);
        if !keys.send.is_empty() && put_frame(&mut stream, frame::INPUT, &keys.send).is_err() {
            break;
        }
        if keys.detach {
            detached = true;
            let _ = put_frame(&mut stream, frame::DETACH, b"");
            break;
        }
    }
    let _ = stream.shutdown(std::net::Shutdown::Both);
    // the drawing thread ends once the line is closed; give it a moment to say why
    let mut why = String::new();
    for _ in 0..50 {
        if draw.is_finished() {
            why = draw.join().unwrap_or_default();
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    drop(raw);
    if detached {
        println!("[detached, still running: inyon attach{}]", target.map(|t| format!(" {t}")).unwrap_or_default());
    } else if why == "exited" {
        println!("[the session ended]");
    } else {
        println!("[disconnected]");
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keys(held: &mut bool, b: &[u8]) -> (Vec<u8>, bool) {
        let k = read_keys(held, b);
        (k.send, k.detach)
    }

    #[test]
    fn keys_pass_through_and_ctrl_b_d_lets_go() {
        let mut held = false;
        assert_eq!(keys(&mut held, b"ls -la\r"), (b"ls -la\r".to_vec(), false));
        // what came before the prefix is still sent; what comes after the d is not
        assert_eq!(keys(&mut held, b"ab\x02dzz"), (b"ab".to_vec(), true));
        assert!(!held);
        // Ctrl-d after the prefix lets go too, for a finger that never left Ctrl
        assert_eq!(keys(&mut held, b"\x02\x04"), (vec![], true));
    }

    #[test]
    fn the_prefix_may_come_in_one_read_and_its_key_in_the_next() {
        let mut held = false;
        assert_eq!(keys(&mut held, b"x\x02"), (b"x".to_vec(), false));
        assert!(held);
        assert_eq!(keys(&mut held, b"d"), (vec![], true));
    }

    #[test]
    fn ctrl_b_twice_is_one_for_the_program_and_before_another_key_it_passes_whole() {
        let mut held = false;
        assert_eq!(keys(&mut held, b"\x02\x02"), (vec![0x02], false));
        // an editor's own Ctrl-b something still reaches it
        assert_eq!(keys(&mut held, b"\x02n"), (vec![0x02, b'n'], false));
        assert_eq!(keys(&mut held, b"\x02\x02\x02d"), (vec![0x02], true));
    }
}
