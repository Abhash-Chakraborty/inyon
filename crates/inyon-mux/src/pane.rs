//! One pane: a program in a pseudo-terminal, with the screen it draws kept in memory so the pane
//! can be read at any moment, the way a tmux pane can. The program's output is read on a thread of
//! its own; keys go in through `write`.

use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex, MutexGuard};

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};

use crate::screen::Screen;

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }
}

/// What to start in a pane.
#[derive(Debug, Clone, Default)]
pub struct Start {
    /// the program and its arguments; empty starts the user's shell
    pub argv: Vec<String>,
    pub cwd: Option<PathBuf>,
    /// added to (and replacing in) the keeper's own environment
    pub env: Vec<(String, String)>,
    pub cols: u16,
    pub rows: u16,
}

pub struct Pane {
    master: Box<dyn MasterPty + Send>,
    keys: Mutex<Box<dyn Write + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    screen: Arc<Mutex<Screen>>,
    dead: Arc<AtomicBool>,
    /// terminals following the pane live: each gets every byte the program writes
    watchers: Arc<Mutex<Vec<Sender<Vec<u8>>>>>,
    /// when the program last wrote something, in seconds since 1970
    active: Arc<AtomicU64>,
    pid: Option<u32>,
    command: String,
    cwd: Option<PathBuf>,
}

fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

/// The user's shell: `$SHELL`, or `sh` where there is none.
pub fn shell() -> String {
    std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/sh".into())
}

/// Where keys go. On Unix not portable-pty's own writer, which types a newline and Ctrl-D when
/// it's dropped (the engine's terminal does the same, for the same reason).
fn input(master: &dyn MasterPty) -> std::io::Result<Box<dyn Write + Send>> {
    #[cfg(unix)]
    {
        use std::os::fd::BorrowedFd;
        let fd = master.as_raw_fd().ok_or_else(|| std::io::Error::other("no terminal"))?;
        // SAFETY: the master is open for this whole call, and the copy is a descriptor of its own
        let own = unsafe { BorrowedFd::borrow_raw(fd) }.try_clone_to_owned()?;
        Ok(Box::new(std::fs::File::from(own)))
    }
    #[cfg(not(unix))]
    master.take_writer().map_err(std::io::Error::other)
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    // a reader thread that panicked mid-update leaves the screen as it was, which is still readable
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

impl Pane {
    /// Starts the program in a terminal of its own. TERM is xterm-256color, the one the screen
    /// model reads, and LANG is UTF-8 unless one is set.
    pub fn start(what: &Start) -> std::io::Result<Pane> {
        // portable-pty reports failures as anyhow errors; here they are only ever printed
        fn other(e: impl std::fmt::Display) -> std::io::Error {
            std::io::Error::other(e.to_string())
        }
        let (cols, rows) = (what.cols.max(1), what.rows.max(1));
        let pair = native_pty_system().openpty(size(cols, rows)).map_err(other)?;
        let argv = if what.argv.is_empty() { vec![shell()] } else { what.argv.clone() };
        let mut cmd = CommandBuilder::new(&argv[0]);
        cmd.args(&argv[1..]);
        let cwd = what.cwd.clone().filter(|c| c.is_dir()).or_else(|| std::env::current_dir().ok());
        if let Some(cwd) = &cwd {
            cmd.cwd(cwd);
        }
        cmd.env("TERM", "xterm-256color");
        cmd.env("LANG", std::env::var("LANG").ok().filter(|l| !l.is_empty()).unwrap_or_else(|| "C.UTF-8".into()));
        // started from inside a tmux, the keeper carries that tmux's TMUX and TMUX_PANE: a pane here
        // isn't in it
        cmd.env_remove("TMUX");
        cmd.env_remove("TMUX_PANE");
        for (k, v) in &what.env {
            cmd.env(k, v);
        }
        let mut child = pair.slave.spawn_command(cmd).map_err(other)?;
        drop(pair.slave);
        let master: Box<dyn MasterPty + Send> = pair.master;
        let mut reader = master.try_clone_reader().map_err(other)?;
        let keys = input(&*master)?;
        let screen = Arc::new(Mutex::new(Screen::new(cols, rows)));
        let dead = Arc::new(AtomicBool::new(false));
        let active = Arc::new(AtomicU64::new(now_secs()));
        let pid = child.process_id();
        let killer = child.clone_killer();

        // what the program writes goes onto the screen as it comes
        let watchers: Arc<Mutex<Vec<Sender<Vec<u8>>>>> = Arc::default();
        let (draw, gone, wrote, watching) = (screen.clone(), dead.clone(), active.clone(), watchers.clone());
        std::thread::spawn(move || {
            let mut buf = [0u8; 16 * 1024];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        // the screen stays locked while the bytes go on to the watchers, so one that
                        // joins gets each byte once: in its first picture or after it, never both
                        let mut screen = lock(&draw);
                        screen.feed(&buf[..n]);
                        lock(&watching).retain(|w| w.send(buf[..n].to_vec()).is_ok());
                        drop(screen);
                        wrote.store(now_secs(), Ordering::Relaxed);
                    }
                }
            }
            // the terminal closed: the program is gone (or closed its side); reap it
            let _ = child.wait();
            gone.store(true, Ordering::SeqCst);
            // nothing more will come: letting go of the senders tells each watcher so
            lock(&watching).clear();
        });

        Ok(Pane { master, keys: Mutex::new(keys), killer: Mutex::new(killer), screen, dead, watchers, active, pid, command: program_name(&argv[0]), cwd })
    }

    /// Types `bytes` into the pane.
    pub fn write(&self, bytes: &[u8]) -> std::io::Result<()> {
        let mut k = lock(&self.keys);
        k.write_all(bytes)?;
        k.flush()
    }

    /// Follows the pane live: the bytes that draw its screen as it is now, then everything the
    /// program writes from here on. The stream ends when the program does.
    pub fn watch(&self) -> (Vec<u8>, Receiver<Vec<u8>>) {
        let (tx, rx) = channel();
        let screen = lock(&self.screen);
        let first = screen.repaint();
        if !self.dead() {
            lock(&self.watchers).push(tx);
        }
        (first, rx)
    }

    /// The pane's screen, to read or to ask about.
    pub fn screen(&self) -> MutexGuard<'_, Screen> {
        lock(&self.screen)
    }

    pub fn resize(&self, cols: u16, rows: u16) -> std::io::Result<()> {
        let (cols, rows) = (cols.max(1), rows.max(1));
        self.master.resize(size(cols, rows)).map_err(|e| std::io::Error::other(e.to_string()))?;
        self.screen().resize(cols, rows);
        Ok(())
    }

    /// The program has ended.
    pub fn dead(&self) -> bool {
        self.dead.load(Ordering::SeqCst)
    }

    pub fn pid(&self) -> Option<u32> {
        self.pid
    }

    /// The program's name as it was started (`claude`, `bash`): tmux's `pane_current_command` on
    /// a pane whose program hasn't started another.
    pub fn command(&self) -> &str {
        &self.command
    }

    /// When the program last wrote to its terminal, in seconds since 1970.
    pub fn activity(&self) -> u64 {
        self.active.load(Ordering::Relaxed)
    }

    /// The program in front in this terminal right now and the folder it's in: the one that was
    /// started, or what it has started since (an agent started from a shell). Linux tells; elsewhere
    /// it's what the pane began with.
    pub fn foreground(&self) -> (String, Option<PathBuf>) {
        #[cfg(target_os = "linux")]
        if let Some(found) = self.pid.and_then(front_of) {
            return found;
        }
        (self.command.clone(), self.cwd.clone())
    }

    /// Ends the program.
    pub fn kill(&self) {
        let _ = lock(&self.killer).kill();
    }
}

impl Drop for Pane {
    fn drop(&mut self) {
        self.kill();
    }
}

/// The process in front in the terminal `pid` leads: its name and its folder, from /proc.
#[cfg(target_os = "linux")]
fn front_of(pid: u32) -> Option<(String, Option<PathBuf>)> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    // "pid (comm) state ppid pgrp session tty tpgid …": comm may hold spaces and brackets, so count from its end
    let rest = &stat[stat.rfind(')')? + 1..];
    let front: u32 = rest.split_whitespace().nth(5)?.parse().ok().filter(|&n: &u32| n > 0)?;
    let name = std::fs::read_to_string(format!("/proc/{front}/comm")).ok()?.trim_end().to_string();
    Some((name, std::fs::read_link(format!("/proc/{front}/cwd")).ok()))
}

fn program_name(path: &str) -> String {
    std::path::Path::new(path).file_name().map_or_else(|| path.to_string(), |n| n.to_string_lossy().into_owned())
}

#[cfg(all(test, unix))]
mod tests {
    use std::time::{Duration, Instant};

    use super::*;
    use crate::screen::Capture;

    fn sh(script: &str) -> Pane {
        Pane::start(&Start { argv: vec!["/bin/sh".into(), "-c".into(), script.into()], cols: 40, rows: 5, ..Start::default() }).expect("a pane")
    }

    /// Waits for `f` to hold, as long as a slow machine may take.
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

    fn text(p: &Pane) -> String {
        p.screen().capture(Capture::default())
    }

    #[test]
    fn what_the_program_prints_can_be_read_and_what_is_typed_reaches_it() {
        let p = sh("printf 'name? '; read n; echo \"hello $n\"; sleep 30");
        assert!(until(|| text(&p).starts_with("name?")), "{:?}", text(&p));
        assert_eq!(p.command(), "sh");
        assert!(p.pid().is_some() && !p.dead());
        p.write(b"sam\r").unwrap();
        assert!(until(|| text(&p).contains("hello sam")), "{:?}", text(&p));
        p.kill();
        assert!(until(|| p.dead()));
    }

    #[test]
    fn a_program_that_ends_leaves_its_last_screen_and_the_pane_says_it_is_dead() {
        let p = sh("echo done; exit 3");
        assert!(until(|| p.dead()));
        assert!(text(&p).starts_with("done\n"), "{:?}", text(&p));
    }

    #[test]
    fn the_program_sees_the_size_and_a_resize() {
        let p = sh("stty size; read x; stty size; sleep 30");
        assert!(until(|| text(&p).starts_with("5 40")), "{:?}", text(&p));
        p.resize(100, 30).unwrap();
        assert_eq!(p.screen().size(), (100, 30));
        p.write(b"\r").unwrap();
        assert!(until(|| text(&p).contains("30 100")), "{:?}", text(&p));
    }

    #[test]
    fn it_starts_where_it_is_told_with_what_it_is_given() {
        let dir = std::env::temp_dir();
        let p = Pane::start(&Start {
            argv: vec!["/bin/sh".into(), "-c".into(), "pwd; echo \"$INYON_TEST_VAR $TERM\"; sleep 30".into()],
            cwd: Some(dir.clone()),
            env: vec![("INYON_TEST_VAR".into(), "kept".into())],
            cols: 80,
            rows: 5,
        })
        .unwrap();
        let want = dir.canonicalize().unwrap_or(dir).to_string_lossy().into_owned();
        assert!(until(|| text(&p).contains("kept xterm-256color")), "{:?}", text(&p));
        assert!(text(&p).lines().next().is_some_and(|l| l == want || want.ends_with(l)), "{:?} vs {want}", text(&p));
    }

    #[test]
    fn it_says_when_it_last_wrote_and_what_runs_in_front() {
        let p = sh("echo up; exec sleep 30");
        assert!(until(|| text(&p).starts_with("up")));
        assert!(p.activity() > 1_700_000_000 && p.activity() <= now_secs());
        // the shell became sleep: on Linux the pane says so, elsewhere it keeps the name it began with
        let named = |want: &str| until(|| p.foreground().0 == want);
        assert!(if cfg!(target_os = "linux") { named("sleep") } else { named("sh") }, "{:?}", p.foreground());
    }

    #[test]
    fn a_watcher_gets_the_screen_as_it_is_then_every_byte_once_and_the_end() {
        let p = sh("echo before; read x; echo \"after $x\"");
        assert!(until(|| text(&p).starts_with("before")));
        let (first, rx) = p.watch();
        // a screen fed the first picture and then the stream shows what the pane's own does
        let mut seen = Screen::new(40, 5);
        seen.feed(&first);
        assert!(seen.capture(Capture::default()).starts_with("before\n"));
        p.write(b"go\r").unwrap();
        // the stream ends when the program does
        while let Ok(bytes) = rx.recv_timeout(Duration::from_secs(10)) {
            seen.feed(&bytes);
        }
        assert!(until(|| p.dead()));
        assert_eq!(seen.capture(Capture::default()), text(&p));
        assert!(text(&p).contains("after go"));
        // watching a pane that has ended gives its last screen and nothing after
        let (last, rx) = p.watch();
        assert!(!last.is_empty() && rx.recv_timeout(Duration::from_secs(2)).is_err());
    }

    #[test]
    fn a_program_that_is_not_there_is_an_error_not_a_dead_pane() {
        let r = Pane::start(&Start { argv: vec!["/no/such/program-inyon".into()], cols: 80, rows: 5, ..Start::default() });
        assert!(r.is_err() || until(|| r.as_ref().is_ok_and(Pane::dead)));
    }
}
