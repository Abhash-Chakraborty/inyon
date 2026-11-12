//! What `inyon mux …` does: sends the command line to the keeper and prints its answer. The first
//! `new-session` starts the keeper, detached, the way the first tmux command starts a tmux server.

use std::io::Read;
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::keeper::Reply;
use crate::serve::{ask, bind, no_server, serve, socket_path};

/// The name the `inyon` command runs the keeper under (`inyon mux-server`).
pub const SERVER_COMMAND: &str = "mux-server";

/// A command that may start the keeper when none runs; every other one says there is none.
fn starts(argv: &[String]) -> bool {
    matches!(argv.first().map(String::as_str), Some("new-session" | "new"))
}

/// `load-buffer … -` reads what's piped in; nothing else touches stdin, so a command run with a
/// terminal (or an open pipe) on stdin never waits on it.
fn wants_stdin(argv: &[String]) -> bool {
    matches!(argv.first().map(String::as_str), Some("load-buffer" | "loadb")) && argv.last().is_some_and(|a| a == "-")
}

/// What `-V` prints: the keeper's name and version. Not "tmux …": a script that asks which tmux
/// this is should learn it's none.
pub fn version() -> String {
    format!("inyon-mux {}", env!("CARGO_PKG_VERSION"))
}

/// Runs one command line and prints its answer; the exit code is the command's.
pub fn run(argv: &[String]) -> i32 {
    // the one command that takes over the terminal
    if matches!(argv.first().map(String::as_str), Some("attach-session" | "attach")) {
        return crate::attach::run_args(argv);
    }
    // answered here, keeper or no keeper: how a script learns this inyon has one
    if argv.first().is_some_and(|a| a == "-V") {
        println!("{}", version());
        return 0;
    }
    let socket = socket_path();
    let mut stdin = Vec::new();
    if wants_stdin(argv) && std::io::stdin().read_to_end(&mut stdin).is_err() {
        eprintln!("load-buffer: couldn't read what was piped in");
        return 1;
    }
    let reply = match ask(&socket, argv, &stdin) {
        Ok(r) => r,
        Err(_) if starts(argv) => start_keeper(&socket).and_then(|()| ask(&socket, argv, &stdin)).unwrap_or_else(|e| Reply {
            out: String::new(),
            err: format!("couldn't start Inyon's session keeper: {e}\n"),
            code: 1,
        }),
        Err(_) => no_server(&socket),
    };
    print!("{}", reply.out);
    eprint!("{}", reply.err);
    reply.code
}

/// Starts this same program as the keeper, in a session of its own so a terminal that closes (or
/// the shell this was run from ending) takes nothing with it, and waits until it listens.
fn start_keeper(socket: &Path) -> std::io::Result<()> {
    // the keeper's own complaint would go nowhere: it runs with nothing to print to
    crate::serve::too_long(socket)?;
    let mut cmd = Command::new(std::env::current_exe()?);
    cmd.arg(SERVER_COMMAND).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    // SAFETY: setsid is async-signal-safe and touches nothing the parent holds
    unsafe {
        cmd.pre_exec(|| if libc::setsid() == -1 { Err(std::io::Error::last_os_error()) } else { Ok(()) });
    }
    cmd.spawn()?;
    let end = Instant::now() + Duration::from_secs(5);
    while Instant::now() < end {
        if UnixStream::connect(socket).is_ok() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    Err(std::io::Error::other("it didn't start listening"))
}

/// The keeper itself (`inyon mux-server`): answers until its last session ends. One already
/// running here is no error: two first commands at once both try to start it.
pub fn server() -> i32 {
    let socket = socket_path();
    match bind(&socket) {
        Ok(listener) => match serve(listener, &socket) {
            Ok(()) => 0,
            Err(e) => {
                eprintln!("inyon's session keeper stopped: {e}");
                1
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => 0,
        Err(e) => {
            eprintln!("inyon's session keeper couldn't listen on {}: {e}", socket.display());
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn w(line: &str) -> Vec<String> {
        line.split(' ').map(str::to_string).collect()
    }

    #[test]
    fn the_version_names_the_keeper_not_tmux() {
        assert!(version().starts_with("inyon-mux 0.") && !version().contains("tmux"), "{}", version());
        assert_eq!(run(&w("-V")), 0);
    }

    #[test]
    fn only_a_new_session_starts_the_keeper() {
        assert!(starts(&w("new-session -d -s work")) && starts(&w("new -s work")));
        for line in ["list-sessions", "has-session -t work", "send-keys -t %0 Enter", "kill-session -t work", "new-window -t work"] {
            assert!(!starts(&w(line)), "{line}");
        }
        assert!(!starts(&[]));
    }

    #[test]
    fn only_a_buffer_read_from_a_dash_takes_what_is_piped_in() {
        assert!(wants_stdin(&w("load-buffer -b inyon-1 -")) && wants_stdin(&w("loadb -")));
        assert!(!wants_stdin(&w("load-buffer -b inyon-1 /tmp/file")));
        // a dash elsewhere is somebody's text or flag value
        assert!(!wants_stdin(&w("send-keys -t %0 -l -- -")));
        assert!(!wants_stdin(&w("capture-pane -p -S - -t %0")));
    }
}
