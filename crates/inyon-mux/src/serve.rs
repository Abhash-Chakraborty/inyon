//! The keeper as a process: it listens on a socket in the user's own folder, runs each command
//! line it's sent on its [`Keeper`], and ends when its last session does, as a tmux server does.
//! [`ask`] is the other end: what `inyon mux …` (and so the hub's `tmux …`) calls.
//!
//! One command per connection. The request is the words and what was piped in; the answer is the
//! exit code, the output and the complaint. Every length is four bytes, big end first.
//!
//! `attach-session` is the one command that stays: after its answer the connection carries a
//! terminal both ways in frames (a kind byte, a length, the bytes) until either side lets go.

use std::io::{Read, Write};
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::keeper::{Keeper, Reply};

/// The most one request or answer may carry: a paste or a long scrollback, with room to spare.
const MOST: usize = 64 * 1024 * 1024;

/// Where the keeper listens: `$INYON_MUX_SOCKET`, or `mux/keeper.sock` under Inyon's folder in
/// the user's home.
pub fn socket_path() -> PathBuf {
    if let Some(p) = std::env::var_os("INYON_MUX_SOCKET").filter(|p| !p.is_empty()) {
        return PathBuf::from(p);
    }
    let home = std::env::var_os("HOME").map_or_else(|| PathBuf::from("/"), PathBuf::from);
    home.join(".inyon").join("mux").join("keeper.sock")
}

fn put(w: &mut impl Write, bytes: &[u8]) -> std::io::Result<()> {
    let n = u32::try_from(bytes.len()).map_err(|_| std::io::Error::other("too long"))?;
    w.write_all(&n.to_be_bytes())?;
    w.write_all(bytes)
}

fn number(r: &mut impl Read) -> std::io::Result<u32> {
    let mut b = [0u8; 4];
    r.read_exact(&mut b)?;
    Ok(u32::from_be_bytes(b))
}

fn take(r: &mut impl Read) -> std::io::Result<Vec<u8>> {
    let n = number(r)? as usize;
    if n > MOST {
        return Err(std::io::Error::other("too long"));
    }
    let mut v = vec![0u8; n];
    r.read_exact(&mut v)?;
    Ok(v)
}

fn text(r: &mut impl Read) -> std::io::Result<String> {
    String::from_utf8(take(r)?).map_err(|_| std::io::Error::other("not text"))
}

/// Sends one command line to the keeper at `socket` and waits for its answer.
pub fn ask(socket: &Path, argv: &[String], stdin: &[u8]) -> std::io::Result<Reply> {
    let mut s = UnixStream::connect(socket)?;
    let count = u32::try_from(argv.len()).map_err(|_| std::io::Error::other("too many words"))?;
    s.write_all(&count.to_be_bytes())?;
    for a in argv {
        put(&mut s, a.as_bytes())?;
    }
    put(&mut s, stdin)?;
    s.flush()?;
    let code = number(&mut s)? as i32;
    Ok(Reply { code, out: text(&mut s)?, err: text(&mut s)? })
}

/// Frames on an attached connection. To the terminal: what to draw, or that it's over (with why).
/// From the terminal: keys, its new size (columns then rows, two bytes each), or that it lets go.
pub mod frame {
    pub const OUTPUT: u8 = 1;
    pub const END: u8 = 2;
    pub const INPUT: u8 = 1;
    pub const RESIZE: u8 = 2;
    pub const DETACH: u8 = 3;
}

pub fn put_frame(w: &mut impl Write, kind: u8, bytes: &[u8]) -> std::io::Result<()> {
    w.write_all(&[kind])?;
    put(w, bytes)?;
    w.flush()
}

pub fn take_frame(r: &mut impl Read) -> std::io::Result<(u8, Vec<u8>)> {
    let mut kind = [0u8; 1];
    r.read_exact(&mut kind)?;
    Ok((kind[0], take(r)?))
}

/// Asks to attach a terminal of `cols`×`rows` to `target`. Ok(Ok(stream)) is the open connection,
/// frames from here on; Ok(Err(reply)) is the keeper's refusal.
pub fn attach(socket: &Path, target: Option<&str>, cols: u16, rows: u16) -> std::io::Result<Result<UnixStream, Reply>> {
    let mut argv = vec!["attach-session".to_string(), "-x".into(), cols.to_string(), "-y".into(), rows.to_string()];
    if let Some(t) = target {
        argv.extend(["-t".to_string(), t.to_string()]);
    }
    let mut s = UnixStream::connect(socket)?;
    s.write_all(&(argv.len() as u32).to_be_bytes())?;
    for a in &argv {
        put(&mut s, a.as_bytes())?;
    }
    put(&mut s, b"")?;
    s.flush()?;
    let code = number(&mut s)? as i32;
    let reply = Reply { code, out: text(&mut s)?, err: text(&mut s)? };
    Ok(if code == 0 { Ok(s) } else { Err(reply) })
}

/// What a command answers when no keeper runs: tmux's own words for it, which the hub knows.
pub fn no_server(socket: &Path) -> Reply {
    Reply { out: String::new(), err: format!("no server running on {}\n", socket.display()), code: 1 }
}

/// The keeper, even after a thread that held it panicked: its sessions are still worth answering for.
fn held(k: &Mutex<Keeper>) -> std::sync::MutexGuard<'_, Keeper> {
    k.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Carries one attached terminal: a thread sends it what the pane writes, this one takes its keys.
/// Ends when the terminal lets go, its connection drops, or the program in the pane ends.
fn carry(mut stream: UnixStream, keeper: Arc<Mutex<Keeper>>, a: crate::keeper::Attached) {
    let Ok(mut out) = stream.try_clone() else {
        held(&keeper).detach(a.client);
        return;
    };
    let (client, input, watching) = (a.client, a.input, keeper.clone());
    std::thread::spawn(move || {
        let mut ok = put_frame(&mut out, frame::OUTPUT, &a.first).is_ok();
        while ok {
            match a.output.recv() {
                Ok(bytes) => ok = put_frame(&mut out, frame::OUTPUT, &bytes).is_ok(),
                // the stream is over: the program ended, or this terminal read too slowly and was let
                // go. Say which, and hang up so the other thread stops waiting for keys
                Err(_) => {
                    let alive = held(&watching).client_typed(client);
                    let _ = put_frame(&mut out, frame::END, if alive { b"behind".as_slice() } else { b"exited" });
                    break;
                }
            }
        }
        let _ = out.shutdown(std::net::Shutdown::Both);
    });
    std::thread::spawn(move || {
        let _ = stream.set_read_timeout(None);
        loop {
            match take_frame(&mut stream) {
                // the keeper is asked only whether this terminal is still attached; the write itself
                // waits on the program alone, never with the keeper held
                Ok((frame::INPUT, bytes)) => {
                    if !held(&keeper).client_typed(client) || input.write(&bytes).is_err() {
                        break;
                    }
                }
                Ok((frame::RESIZE, b)) if b.len() == 4 => held(&keeper).client_resize(client, u16::from_be_bytes([b[0], b[1]]), u16::from_be_bytes([b[2], b[3]])),
                // it let go, hung up, or sent something else
                _ => break,
            }
        }
        held(&keeper).detach(client);
        // the sender thread's next write fails, and it ends too
        let _ = stream.shutdown(std::net::Shutdown::Both);
    });
}

fn answer(mut stream: UnixStream, keeper: &Arc<Mutex<Keeper>>) -> std::io::Result<()> {
    // a client that stops mid-request mustn't hold the keeper up
    stream.set_read_timeout(Some(Duration::from_secs(30)))?;
    let count = number(&mut stream)? as usize;
    if count > 4096 {
        return Err(std::io::Error::other("too many words"));
    }
    let argv = (0..count).map(|_| text(&mut stream)).collect::<std::io::Result<Vec<_>>>()?;
    let stdin = take(&mut stream)?;
    let send = |stream: &mut UnixStream, reply: &Reply| -> std::io::Result<()> {
        stream.write_all(&(reply.code as u32).to_be_bytes())?;
        put(stream, reply.out.as_bytes())?;
        put(stream, reply.err.as_bytes())?;
        stream.flush()
    };
    // the one command that stays on the line
    if matches!(argv.first().map(String::as_str), Some("attach-session" | "attach")) {
        let attached = crate::args::parse(&argv).and_then(|c| {
            let size = |f: char| c.value(f).and_then(|v| v.parse::<u16>().ok()).unwrap_or(0);
            keeper.lock().unwrap_or_else(std::sync::PoisonError::into_inner).attach(c.value('t'), size('x'), size('y'))
        });
        return match attached {
            Ok(a) => {
                // a terminal that hung up before its answer was never attached
                if let Err(e) = send(&mut stream, &Reply::default()) {
                    held(keeper).detach(a.client);
                    return Err(e);
                }
                carry(stream, keeper.clone(), a);
                Ok(())
            }
            Err(e) => send(&mut stream, &Reply { out: String::new(), err: format!("{e}\n"), code: 1 }),
        };
    }
    let reply = keeper.lock().unwrap_or_else(std::sync::PoisonError::into_inner).run(&argv, &stdin);
    send(&mut stream, &reply)
}

/// A socket's path has to fit in about a hundred bytes; a longer one fails with words that don't
/// say what's wrong, so this says it first. (The usual place, under the home folder, is short.)
pub fn too_long(socket: &Path) -> std::io::Result<()> {
    let n = socket.as_os_str().len();
    if n > 100 {
        return Err(std::io::Error::other(format!("the socket's path is {n} bytes, and a socket's can be 100 at most: set INYON_MUX_SOCKET to a shorter one")));
    }
    Ok(())
}

/// Binds the keeper's socket, in a folder only the user can enter. A socket left by a keeper that's
/// gone is taken over; one that answers means a keeper already runs.
pub fn bind(socket: &Path) -> std::io::Result<UnixListener> {
    too_long(socket)?;
    if let Some(dir) = socket.parent() {
        std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir)?;
    }
    if UnixStream::connect(socket).is_ok() {
        return Err(std::io::Error::new(std::io::ErrorKind::AddrInUse, "a keeper already runs here"));
    }
    let _ = std::fs::remove_file(socket);
    let listener = UnixListener::bind(socket)?;
    std::fs::set_permissions(socket, std::fs::Permissions::from_mode(0o600))?;
    Ok(listener)
}

/// Answers commands until the last session has ended (one has to have started first), then takes
/// the socket away and returns.
pub fn serve(listener: UnixListener, socket: &Path) -> std::io::Result<()> {
    let keeper = Arc::new(Mutex::new(Keeper::new()));
    listener.set_nonblocking(true)?;
    let mut had_one = false;
    loop {
        match listener.accept() {
            Ok((stream, _)) => {
                stream.set_nonblocking(false)?;
                // one at a time: commands are short, and the order they came in is the order they ran
                // (an attached terminal goes on in threads of its own)
                let _ = answer(stream, &keeper);
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(15)),
            Err(e) => return Err(e),
        }
        // a program that ended on its own closes its window; the last one closing ends the keeper
        let mut k = keeper.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        k.sweep();
        had_one |= !k.is_empty();
        if had_one && k.is_empty() {
            break;
        }
    }
    let _ = std::fs::remove_file(socket);
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::time::Instant;

    use super::*;

    fn until(mut f: impl FnMut() -> bool) -> bool {
        let end = Instant::now() + Duration::from_secs(10);
        while Instant::now() < end {
            if f() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        false
    }

    fn words(line: &[&str]) -> Vec<String> {
        line.iter().map(|s| s.to_string()).collect()
    }

    /// A keeper on a socket of its own, in a folder that goes with the test.
    fn keeper(name: &str) -> (PathBuf, std::thread::JoinHandle<std::io::Result<()>>) {
        let dir = std::env::temp_dir().join(format!("inyon-mux-test-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let socket = dir.join("keeper.sock");
        let listener = bind(&socket).expect("a socket");
        let at = socket.clone();
        (socket, std::thread::spawn(move || serve(listener, &at)))
    }

    #[test]
    fn commands_go_over_the_socket_and_the_keeper_ends_with_its_last_session() {
        let (socket, server) = keeper("round-trip");
        let ask_ok = |line: &[&str], stdin: &[u8]| {
            let r = ask(&socket, &words(line), stdin).expect("an answer");
            assert_eq!((r.code, r.err.as_str()), (0, ""), "{line:?}");
            r.out
        };
        // only the user may reach it
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!((mode(&socket), mode(socket.parent().unwrap())), (0o600, 0o700));
        // nothing yet: it stays up, waiting for its first session
        assert_eq!(ask_ok(&["list-sessions"], b""), "");
        assert_eq!(ask_ok(&["new-session", "-d", "-s", "over", "-P", "-F", "#{pane_id}", "echo up; exec cat"], b""), "%0\n");
        assert!(until(|| ask_ok(&["capture-pane", "-p", "-t", "over"], b"").starts_with("up")));
        // what's piped in arrives whole
        let text = "pasted, with a\nnewline and 🪁\n";
        ask_ok(&["load-buffer", "-b", "b1", "-"], text.as_bytes());
        ask_ok(&["paste-buffer", "-d", "-b", "b1", "-t", "over"], b"");
        assert!(until(|| ask_ok(&["capture-pane", "-p", "-t", "over"], b"").matches("newline and 🪁").count() == 2));
        // a complaint comes back as one, with its code
        let r = ask(&socket, &words(&["kill-session", "-t", "nope"]), b"").unwrap();
        assert_eq!((r.code, r.err.as_str(), r.out.as_str()), (1, "can't find session: nope\n", ""));
        ask_ok(&["kill-session", "-t", "over"], b"");
        // its last session gone, the keeper ends and takes its socket with it
        assert!(server.join().unwrap().is_ok());
        assert!(!socket.exists());
        assert!(ask(&socket, &words(&["list-sessions"]), b"").is_err());
        assert_eq!(no_server(&socket).err, format!("no server running on {}\n", socket.display()));
    }

    #[test]
    fn a_session_whose_program_ends_by_itself_ends_the_keeper_too() {
        let (socket, server) = keeper("ends");
        let r = ask(&socket, &words(&["new-session", "-d", "-s", "brief", "sleep 0.3"]), b"").unwrap();
        assert_eq!(r.code, 0, "{r:?}");
        assert!(server.join().unwrap().is_ok());
        assert!(!socket.exists());
    }

    #[test]
    fn a_path_too_long_for_a_socket_says_so() {
        let long = std::env::temp_dir().join("x".repeat(120)).join("keeper.sock");
        let e = bind(&long).unwrap_err().to_string();
        assert!(e.contains("can be 100 at most") && e.contains("INYON_MUX_SOCKET"), "{e}");
        assert!(too_long(Path::new("/home/sam/.inyon/mux/keeper.sock")).is_ok());
    }

    /// Reads frames until `seen` holds, feeding a screen with what's drawn. Err is the END reason.
    fn watch_until(stream: &mut UnixStream, screen: &mut crate::screen::Screen, mut seen: impl FnMut(&str) -> bool) -> Result<(), String> {
        stream.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        loop {
            match take_frame(stream) {
                Ok((frame::OUTPUT, b)) => {
                    screen.feed(&b);
                    if seen(&screen.capture(crate::screen::Capture::default())) {
                        return Ok(());
                    }
                }
                Ok((frame::END, why)) => return Err(String::from_utf8_lossy(&why).into_owned()),
                Ok(_) => {}
                Err(e) => return Err(format!("closed: {e}")),
            }
        }
    }

    #[test]
    fn a_terminal_attaches_over_the_socket_types_resizes_detaches_and_hears_the_end() {
        let (socket, server) = keeper("attach");
        let run = |line: &[&str]| ask(&socket, &words(line), b"").unwrap();
        assert_eq!(run(&["new-session", "-d", "-s", "work", "echo up; read x; echo \"got $x\"; read y"]).code, 0);
        assert!(until(|| run(&["capture-pane", "-p", "-t", "work"]).out.starts_with("up")));
        // a session that isn't there is refused with the usual words, and nothing stays open
        let no = attach(&socket, Some("nope"), 80, 24).unwrap().unwrap_err();
        assert_eq!((no.code, no.err.as_str()), (1, "can't find session: nope\n"));

        let mut term = attach(&socket, Some("work"), 60, 12).unwrap().unwrap();
        let mut screen = crate::screen::Screen::new(60, 12);
        // the first picture is what was already there, at the terminal's size
        watch_until(&mut term, &mut screen, |s| s.starts_with("up")).unwrap();
        assert_eq!(run(&["display", "-p", "-t", "work", "#{pane_width}x#{pane_height} #{session_attached}"]).out, "60x12 1\n");
        // keys go in, and what the program answers comes back, while plain commands still run
        put_frame(&mut term, frame::INPUT, b"hello\r").unwrap();
        watch_until(&mut term, &mut screen, |s| s.contains("got hello")).unwrap();
        put_frame(&mut term, frame::RESIZE, &[0, 100, 0, 30]).unwrap();
        assert!(until(|| run(&["display", "-p", "-t", "work", "#{pane_width}x#{pane_height}"]).out == "100x30\n"));
        // letting go ends nothing
        put_frame(&mut term, frame::DETACH, b"").unwrap();
        assert!(until(|| run(&["list-clients"]).out.is_empty()));
        assert_eq!(run(&["display", "-p", "-t", "work", "#{pane_dead} #{session_attached}"]).out, "0 0\n");

        // a terminal that just goes away is let go of too
        let gone = attach(&socket, Some("work"), 60, 12).unwrap().unwrap();
        assert!(until(|| run(&["list-clients"]).out.lines().count() == 1));
        drop(gone);
        assert!(until(|| run(&["list-clients"]).out.is_empty()));

        // and one that's attached when the program ends is told, and the keeper stops as usual
        let mut last = attach(&socket, Some("work"), 60, 12).unwrap().unwrap();
        let mut screen = crate::screen::Screen::new(60, 12);
        watch_until(&mut last, &mut screen, |s| s.contains("got hello")).unwrap();
        put_frame(&mut last, frame::INPUT, b"\r").unwrap();
        assert_eq!(watch_until(&mut last, &mut screen, |_| false), Err("exited".to_string()));
        assert!(server.join().unwrap().is_ok());
    }

    #[test]
    fn a_second_keeper_on_the_same_socket_is_refused_and_a_dead_one_is_replaced() {
        let (socket, server) = keeper("twice");
        assert_eq!(bind(&socket).unwrap_err().kind(), std::io::ErrorKind::AddrInUse);
        ask(&socket, &words(&["new-session", "-d", "-s", "x", "sleep 0.2"]), b"").unwrap();
        server.join().unwrap().unwrap();
        // a socket file with nobody behind it
        std::os::unix::net::UnixListener::bind(&socket).map(drop).unwrap();
        assert!(socket.exists());
        assert!(bind(&socket).is_ok());
    }
}
