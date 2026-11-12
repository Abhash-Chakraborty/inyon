//! The keeper as a process: it listens on a socket in the user's own folder, runs each command
//! line it's sent on its [`Keeper`], and ends when its last session does, as a tmux server does.
//! [`ask`] is the other end: what `inyon mux …` (and so the hub's `tmux …`) calls.
//!
//! One command per connection. The request is the words and what was piped in; the answer is the
//! exit code, the output and the complaint. Every length is four bytes, big end first.

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

/// What a command answers when no keeper runs: tmux's own words for it, which the hub knows.
pub fn no_server(socket: &Path) -> Reply {
    Reply { out: String::new(), err: format!("no server running on {}\n", socket.display()), code: 1 }
}

fn answer(stream: &mut UnixStream, keeper: &Mutex<Keeper>) -> std::io::Result<()> {
    // a client that stops mid-request mustn't hold the keeper up
    stream.set_read_timeout(Some(Duration::from_secs(30)))?;
    let count = number(stream)? as usize;
    if count > 4096 {
        return Err(std::io::Error::other("too many words"));
    }
    let argv = (0..count).map(|_| text(stream)).collect::<std::io::Result<Vec<_>>>()?;
    let stdin = take(stream)?;
    let reply = keeper.lock().unwrap_or_else(std::sync::PoisonError::into_inner).run(&argv, &stdin);
    stream.write_all(&(reply.code as u32).to_be_bytes())?;
    put(stream, reply.out.as_bytes())?;
    put(stream, reply.err.as_bytes())?;
    stream.flush()
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
            Ok((mut stream, _)) => {
                stream.set_nonblocking(false)?;
                // one at a time: commands are short, and the order they came in is the order they ran
                let _ = answer(&mut stream, &keeper);
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
