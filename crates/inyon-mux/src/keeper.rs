//! The keeper itself: the sessions, windows and panes it holds, and the tmux commands that act on
//! them. One [`Keeper::run`] per command line, answering as tmux would: what it prints, what it
//! complains about, and its exit code. Nothing here knows how the command arrived; the process
//! and its socket are a thin layer over this.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::mpsc::Receiver;

use crate::args::{self, Call};
use crate::format;
use crate::keys;
use crate::pane::{Pane, Start};
use crate::screen::Capture;
use crate::target::{Part, Session as Named, Target};

/// What a command answers: its output, its complaint, and 0 or 1.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Reply {
    pub out: String,
    pub err: String,
    pub code: i32,
}

impl Reply {
    fn ok(out: impl Into<String>) -> Reply {
        Reply { out: out.into(), ..Reply::default() }
    }
}

type Done = Result<String, String>;

struct Entry {
    id: u32,
    pane: Pane,
}

struct Window {
    id: u32,
    /// set by `-n` or rename-window; otherwise the window is called after what runs in it
    name: Option<String>,
    panes: Vec<Entry>,
    active: usize,
}

struct Session {
    id: u32,
    name: String,
    windows: Vec<Window>,
    active: usize,
}

/// Where a pane is: indexes into the keeper's sessions, that session's windows, that window's panes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct At(usize, usize, usize);

/// A terminal attached to a pane (`inyon attach`): a person's own, as a tmux client is.
struct Client {
    id: u32,
    pane: u32,
    /// when a key last came from it, in seconds since 1970
    activity: u64,
}

/// What a terminal gets when it attaches: the pane it shows, the bytes that draw the pane's
/// screen as it is, and then everything the program writes, until the program ends.
pub struct Attached {
    pub client: u32,
    pub pane: u32,
    pub first: Vec<u8>,
    pub output: Receiver<Vec<u8>>,
}

#[derive(Default)]
pub struct Keeper {
    sessions: Vec<Session>,
    clients: Vec<Client>,
    next_client: u32,
    buffers: BTreeMap<String, Vec<u8>>,
    next_session: u32,
    next_window: u32,
    next_pane: u32,
}

/// The size a session gets when none is asked for, as tmux's own default.
const DEFAULT_SIZE: (u16, u16) = (80, 24);

fn number<T: std::str::FromStr>(c: &Call, flag: char) -> Result<Option<T>, String> {
    c.value(flag).map(|v| v.parse().map_err(|_| format!("{}: -{flag} {v} isn't a number", c.name))).transpose()
}

/// What to start: one word goes through the user's shell, as tmux does it (a shell that then
/// becomes the program, so the pane is named after the program); several are the program and its
/// arguments; none is the shell itself.
fn start_of(c: &Call, cols: u16, rows: u16) -> Start {
    let argv = match c.words.as_slice() {
        [] => vec![],
        [line] => vec![crate::pane::shell(), "-c".to_string(), line.clone()],
        many => many.to_vec(),
    };
    Start { argv, cwd: c.value('c').map(PathBuf::from), env: vec![], cols, rows }
}

impl Keeper {
    pub fn new() -> Keeper {
        Keeper::default()
    }

    /// No session is left: the process holding the keeper may end.
    pub fn is_empty(&self) -> bool {
        self.sessions.is_empty()
    }

    #[cfg(test)]
    fn is_empty_after_sweep(&mut self) -> bool {
        self.reap();
        self.is_empty()
    }

    /// Closes what ended on its own since the last command: a window whose program is gone, and a
    /// session left with no window.
    pub fn sweep(&mut self) {
        self.reap();
    }

    /// Runs one command line (the words after `tmux`); `stdin` is what was piped to it.
    pub fn run(&mut self, argv: &[String], stdin: &[u8]) -> Reply {
        let done = args::parse(argv).and_then(|c| self.call(&c, stdin));
        match done {
            Ok(out) => Reply::ok(out),
            Err(err) => Reply { out: String::new(), err: format!("{err}\n"), code: 1 },
        }
    }

    fn call(&mut self, c: &Call, stdin: &[u8]) -> Done {
        self.reap();
        match c.name {
            "new-session" => self.new_session(c),
            "new-window" => self.new_window(c),
            "list-sessions" => {
                Ok(self.sessions.iter().enumerate().map(|(i, _)| self.line(c.value('F').unwrap_or("#{session_name}: #{session_windows} windows"), self.first_of(i))).collect())
            }
            "list-panes" => self.list_panes(c),
            // a line for each terminal a person has attached (`inyon attach`)
            "list-clients" => {
                let fmt = c.value('F').unwrap_or("#{session_name}: #{pane_id}");
                let only = c.value('t').map(|t| self.session_at(Some(t))).transpose()?;
                let lines: Vec<String> =
                    self.clients.iter().filter_map(|cl| self.find_pane(cl.pane).filter(|at| only.is_none_or(|s| s == at.0)).map(|at| self.client_line(fmt, cl, at))).collect();
                Ok(lines.concat())
            }
            "has-session" => self.session_at(c.value('t')).map(|_| String::new()),
            "display-message" => {
                let at = self.pane_at(c.value('t'))?;
                let fmt = c.words.join(" ");
                Ok(if c.has('p') { self.line(&fmt, at) } else { String::new() })
            }
            "send-keys" => self.send_keys(c),
            "load-buffer" => self.load_buffer(c, stdin),
            "paste-buffer" => self.paste_buffer(c),
            "delete-buffer" => self.buffers.remove(c.value('b').unwrap_or(BUFFER)).map(|_| String::new()).ok_or_else(|| format!("no buffer {}", c.value('b').unwrap_or(BUFFER))),
            "capture-pane" => self.capture(c),
            "kill-session" => {
                let i = self.session_at(c.value('t'))?;
                self.sessions.remove(i);
                Ok(String::new())
            }
            "kill-window" => {
                let At(s, w, _) = self.pane_at(c.value('t'))?;
                self.sessions[s].windows.remove(w);
                self.tidy();
                Ok(String::new())
            }
            "kill-pane" => {
                let At(s, w, p) = self.pane_at(c.value('t'))?;
                self.sessions[s].windows[w].panes.remove(p);
                self.tidy();
                Ok(String::new())
            }
            "kill-server" => {
                self.sessions.clear();
                Ok(String::new())
            }
            "resize-window" => {
                let At(s, w, _) = self.pane_at(c.value('t'))?;
                let win = &self.sessions[s].windows[w];
                let (cols, rows) = win.panes.first().map_or(DEFAULT_SIZE, |e| e.pane.screen().size());
                let (cols, rows) = (number(c, 'x')?.unwrap_or(cols), number(c, 'y')?.unwrap_or(rows));
                for e in &win.panes {
                    e.pane.resize(cols, rows).map_err(|e| e.to_string())?;
                }
                Ok(String::new())
            }
            "rename-session" => {
                let i = self.session_at(c.value('t'))?;
                let name = c.words.first().filter(|n| !n.is_empty()).ok_or("rename-session: a name is needed")?.clone();
                if self.sessions.iter().enumerate().any(|(j, s)| j != i && s.name == name) {
                    return Err(format!("duplicate session: {name}"));
                }
                self.sessions[i].name = name;
                Ok(String::new())
            }
            "rename-window" => {
                let At(s, w, _) = self.pane_at(c.value('t'))?;
                self.sessions[s].windows[w].name = Some(c.words.first().ok_or("rename-window: a name is needed")?.clone());
                Ok(String::new())
            }
            "respawn-pane" => self.respawn(c),
            "select-window" | "select-pane" => {
                let At(s, w, p) = self.pane_at(c.value('t'))?;
                self.sessions[s].active = w;
                self.sessions[s].windows[w].active = p;
                Ok(String::new())
            }
            // options and key bindings shape a tmux someone sits in front of; the keeper has none
            "set-option" | "set-window-option" | "bind-key" => Ok(String::new()),
            "list-windows" => {
                let s = self.session_at(c.value('t'))?;
                let fmt = c.value('F').unwrap_or("#{window_index}: #{window_name}");
                Ok((0..self.sessions[s].windows.len()).map(|w| self.line(fmt, At(s, w, self.sessions[s].windows[w].active))).collect())
            }
            // a stream, not an answer: the keeper's socket takes it before it gets here (`attach`)
            "attach-session" => Err("attach-session needs a terminal: run inyon attach".into()),
            other => Err(format!("unknown command: {other}")),
        }
    }

    // ---------- starting ----------

    fn new_session(&mut self, c: &Call) -> Done {
        let name = c.value('s').map_or_else(|| self.next_session.to_string(), str::to_string);
        if name.is_empty() || name.contains([':', '.']) {
            return Err(format!("bad session name: {name}"));
        }
        if self.sessions.iter().any(|s| s.name == name) {
            return Err(format!("duplicate session: {name}"));
        }
        let (cols, rows) = (number(c, 'x')?.unwrap_or(DEFAULT_SIZE.0), number(c, 'y')?.unwrap_or(DEFAULT_SIZE.1));
        let window = self.window(c, cols, rows)?;
        self.sessions.push(Session { id: self.next_session, name, windows: vec![window], active: 0 });
        self.next_session += 1;
        let at = At(self.sessions.len() - 1, 0, 0);
        Ok(if c.has('P') { self.line(c.value('F').unwrap_or("#{session_name}:"), at) } else { String::new() })
    }

    fn new_window(&mut self, c: &Call) -> Done {
        let s = self.session_at(c.value('t'))?;
        let (cols, rows) = self.sessions[s].windows.first().and_then(|w| w.panes.first()).map_or(DEFAULT_SIZE, |e| e.pane.screen().size());
        let window = self.window(c, cols, rows)?;
        self.sessions[s].windows.push(window);
        let w = self.sessions[s].windows.len() - 1;
        if !c.has('d') {
            self.sessions[s].active = w;
        }
        Ok(if c.has('P') { self.line(c.value('F').unwrap_or("#{session_name}:#{window_index}"), At(s, w, 0)) } else { String::new() })
    }

    /// A window with one pane running what the command asks for.
    fn window(&mut self, c: &Call, cols: u16, rows: u16) -> Result<Window, String> {
        let mut start = start_of(c, cols, rows);
        start.env.push(pane_env(self.next_pane));
        let pane = Pane::start(&start).map_err(|e| format!("{}: {e}", c.name))?;
        let window = Window { id: self.next_window, name: c.value('n').map(str::to_string), panes: vec![Entry { id: self.next_pane, pane }], active: 0 };
        self.next_window += 1;
        self.next_pane += 1;
        Ok(window)
    }

    fn respawn(&mut self, c: &Call) -> Done {
        let At(s, w, p) = self.pane_at(c.value('t'))?;
        let entry = &mut self.sessions[s].windows[w].panes[p];
        if !c.has('k') && !entry.pane.dead() {
            return Err(format!("pane %{} still active", entry.id));
        }
        let (cols, rows) = entry.pane.screen().size();
        let mut start = start_of(c, cols, rows);
        // without -c it starts where the old program was
        if start.cwd.is_none() {
            start.cwd = entry.pane.foreground().1;
        }
        start.env.push(pane_env(entry.id));
        entry.pane = Pane::start(&start).map_err(|e| format!("respawn-pane: {e}"))?;
        Ok(String::new())
    }

    // ---------- typing ----------

    fn send_keys(&mut self, c: &Call) -> Done {
        let at = self.pane_at(c.value('t'))?;
        let pane = &self.entry(at).pane;
        let bytes = if c.has('H') {
            keys::hex_bytes(&c.words)?
        } else if c.has('l') {
            c.words.concat().into_bytes()
        } else {
            // a program that asked for the keypad's application mode gets its arrows that way
            let app = pane.screen().application_cursor();
            c.words.iter().flat_map(|w| arrow(w, app).unwrap_or_else(|| keys::key_bytes(w))).collect()
        };
        pane.write(&bytes).map_err(|e| format!("send-keys: {e}"))?;
        Ok(String::new())
    }

    fn load_buffer(&mut self, c: &Call, stdin: &[u8]) -> Done {
        let data = match c.words.first().map(String::as_str) {
            Some("-") => stdin.to_vec(),
            Some(path) => std::fs::read(path).map_err(|e| format!("{path}: {e}"))?,
            None => return Err("load-buffer: a file or - is needed".into()),
        };
        self.buffers.insert(c.value('b').unwrap_or(BUFFER).to_string(), data);
        Ok(String::new())
    }

    fn paste_buffer(&mut self, c: &Call) -> Done {
        let name = c.value('b').unwrap_or(BUFFER);
        let at = self.pane_at(c.value('t'))?;
        let data = self.buffers.get(name).ok_or_else(|| format!("no buffer {name}"))?;
        let pane = &self.entry(at).pane;
        // a newline in the buffer is Enter in a terminal, unless -r says to leave it
        let mut bytes: Vec<u8> = if c.has('r') { data.clone() } else { data.iter().map(|&b| if b == b'\n' { b'\r' } else { b }).collect() };
        // -p: between brackets when the program takes pastes that way, so it reads as one paste
        if c.has('p') && pane.screen().bracketed_paste() {
            bytes = [b"\x1b[200~".as_slice(), &bytes, b"\x1b[201~"].concat();
        }
        pane.write(&bytes).map_err(|e| format!("paste-buffer: {e}"))?;
        if c.has('d') {
            self.buffers.remove(name);
        }
        Ok(String::new())
    }

    // ---------- reading ----------

    fn capture(&mut self, c: &Call) -> Done {
        let at = self.pane_at(c.value('t'))?;
        // -S -200 starts 200 rows above the screen; -S - at the very top of what's kept
        let history = match c.value('S') {
            None => 0,
            Some("-") => usize::MAX,
            Some(v) => v.parse::<i64>().map_err(|_| format!("capture-pane: -S {v} isn't a number"))?.min(0).unsigned_abs() as usize,
        };
        let text = self.entry(at).pane.screen().capture(Capture { history, escapes: c.has('e'), join: c.has('J') });
        if c.has('p') {
            return Ok(text);
        }
        self.buffers.insert(c.value('b').unwrap_or(BUFFER).to_string(), text.into_bytes());
        Ok(String::new())
    }

    fn list_panes(&mut self, c: &Call) -> Done {
        let fmt = c.value('F').unwrap_or("#{pane_index}: [#{pane_width}x#{pane_height}] #{pane_id}");
        let mut at = Vec::new();
        if c.has('a') {
            for (s, session) in self.sessions.iter().enumerate() {
                for (w, window) in session.windows.iter().enumerate() {
                    at.extend((0..window.panes.len()).map(|p| At(s, w, p)));
                }
            }
        } else if c.has('s') {
            let s = self.session_at(c.value('t'))?;
            for (w, window) in self.sessions[s].windows.iter().enumerate() {
                at.extend((0..window.panes.len()).map(|p| At(s, w, p)));
            }
        } else {
            let At(s, w, _) = self.pane_at(c.value('t'))?;
            at.extend((0..self.sessions[s].windows[w].panes.len()).map(|p| At(s, w, p)));
        }
        Ok(at.into_iter().map(|a| self.line(fmt, a)).collect())
    }

    /// `fmt` filled in for one pane, as a line.
    fn line(&self, fmt: &str, at: At) -> String {
        let mut s = format::expand(fmt, &|name| self.value(name, at));
        s.push('\n');
        s
    }

    fn value(&self, name: &str, At(s, w, p): At) -> Option<String> {
        let session = self.sessions.get(s)?;
        let window = session.windows.get(w)?;
        let entry = window.panes.get(p)?;
        let yes = |b: bool| if b { "1" } else { "0" }.to_string();
        let size = || entry.pane.screen().size();
        Some(match name {
            "session_id" => format!("${}", session.id),
            "session_name" => session.name.clone(),
            "session_attached" => self.clients.iter().filter(|cl| self.find_pane(cl.pane).is_some_and(|at| at.0 == s)).count().to_string(),
            "session_windows" => session.windows.len().to_string(),
            "window_id" => format!("@{}", window.id),
            "window_index" => w.to_string(),
            "window_name" => window.name.clone().unwrap_or_else(|| entry.pane.foreground().0),
            "window_active" => yes(session.active == w),
            "window_activity" => window.panes.iter().map(|e| e.pane.activity()).max().unwrap_or(0).to_string(),
            "window_width" | "pane_width" => size().0.to_string(),
            "window_height" | "pane_height" => size().1.to_string(),
            "window_panes" => window.panes.len().to_string(),
            "pane_id" => format!("%{}", entry.id),
            "pane_index" => p.to_string(),
            "pane_active" => yes(window.active == p),
            "pane_pid" => entry.pane.pid().map(|n| n.to_string()).unwrap_or_default(),
            "pane_dead" => yes(entry.pane.dead()),
            "cursor_x" => entry.pane.screen().cursor().0.to_string(),
            "cursor_y" => entry.pane.screen().cursor().1.to_string(),
            "cursor_flag" => yes(entry.pane.screen().cursor().2),
            "alternate_on" => yes(entry.pane.screen().alternate()),
            "pane_current_command" => entry.pane.foreground().0,
            "pane_current_path" => entry.pane.foreground().1.map(|d| d.to_string_lossy().into_owned()).unwrap_or_default(),
            // until the program names its terminal, the title is the machine's name, as in tmux
            "pane_title" => Some(entry.pane.screen().title().to_string()).filter(|t| !t.is_empty()).unwrap_or_else(hostname),
            _ => return None,
        })
    }

    // ---------- a person's terminal ----------

    /// Attaches a terminal of `cols`×`rows` to the pane `target` names: the window takes the
    /// terminal's size, as with tmux, and the terminal gets the screen and what follows.
    pub fn attach(&mut self, target: Option<&str>, cols: u16, rows: u16) -> Result<Attached, String> {
        self.reap();
        let at = self.pane_at(target)?;
        let entry = self.entry(at);
        let pane = entry.id;
        if cols > 0 && rows > 0 {
            let _ = entry.pane.resize(cols, rows);
        }
        let (first, output) = entry.pane.watch();
        let client = self.next_client;
        self.next_client += 1;
        self.clients.push(Client { id: client, pane, activity: now_secs() });
        Ok(Attached { client, pane, first, output })
    }

    /// Keys from an attached terminal. False once its pane is gone.
    pub fn client_input(&mut self, client: u32, bytes: &[u8]) -> bool {
        let Some(cl) = self.clients.iter_mut().find(|c| c.id == client) else { return false };
        cl.activity = now_secs();
        let pane = cl.pane;
        self.find_pane(pane).is_some_and(|at| self.entry(at).pane.write(bytes).is_ok())
    }

    /// An attached terminal changed size: its pane's window follows.
    pub fn client_resize(&mut self, client: u32, cols: u16, rows: u16) {
        let Some(at) = self.clients.iter().find(|c| c.id == client).and_then(|c| self.find_pane(c.pane)) else { return };
        for e in &self.sessions[at.0].windows[at.1].panes {
            let _ = e.pane.resize(cols, rows);
        }
    }

    /// The terminal let go, or its connection ended.
    pub fn detach(&mut self, client: u32) {
        self.clients.retain(|c| c.id != client);
    }

    fn find_pane(&self, id: u32) -> Option<At> {
        self.sessions
            .iter()
            .enumerate()
            .find_map(|(s, session)| session.windows.iter().enumerate().find_map(|(w, window)| window.panes.iter().position(|e| e.id == id).map(|p| At(s, w, p))))
    }

    /// `fmt` for one attached terminal: its own values, then its pane's.
    fn client_line(&self, fmt: &str, cl: &Client, at: At) -> String {
        let mut s = format::expand(fmt, &|name| match name {
            "client_control_mode" => Some("0".into()),
            "client_activity" => Some(cl.activity.to_string()),
            "client_name" | "client_tty" => Some(format!("inyon-attach-{}", cl.id)),
            other => self.value(other, at),
        });
        s.push('\n');
        s
    }

    // ---------- finding ----------

    fn entry(&self, At(s, w, p): At) -> &Entry {
        &self.sessions[s].windows[w].panes[p]
    }

    /// A session's active pane.
    fn first_of(&self, s: usize) -> At {
        let w = self.sessions[s].active.min(self.sessions[s].windows.len().saturating_sub(1));
        At(s, w, self.sessions[s].windows[w].active.min(self.sessions[s].windows[w].panes.len().saturating_sub(1)))
    }

    /// The session `-t` names; with no `-t`, the one made last.
    fn session_at(&self, target: Option<&str>) -> Result<usize, String> {
        let Some(t) = target else { return self.sessions.len().checked_sub(1).ok_or_else(|| "no sessions".to_string()) };
        let missing = || format!("can't find session: {t}");
        match Target::parse(t).map_err(|_| missing())? {
            Target::Pane(_) | Target::Window(_) => self.pane_at(target).map(|At(s, _, _)| s),
            Target::In { session, .. } => self.sessions.iter().position(|s| matches(s, &session)).ok_or_else(missing),
        }
    }

    /// The pane `-t` names: by id, or the active one of the window or session it names.
    fn pane_at(&self, target: Option<&str>) -> Result<At, String> {
        let Some(t) = target else {
            let s = self.session_at(None)?;
            return Ok(self.first_of(s));
        };
        let all = || self.sessions.iter().enumerate().flat_map(|(s, session)| session.windows.iter().enumerate().map(move |(w, window)| (s, w, window)));
        match Target::parse(t)? {
            Target::Pane(id) => all().find_map(|(s, w, window)| window.panes.iter().position(|e| e.id == id).map(|p| At(s, w, p))).ok_or_else(|| format!("can't find pane: {t}")),
            Target::Window(id) => all().find(|(_, _, window)| window.id == id).map(|(s, w, window)| At(s, w, window.active)).ok_or_else(|| format!("can't find window: {t}")),
            Target::In { session, window, pane } => {
                let s = self.sessions.iter().position(|x| matches(x, &session)).ok_or_else(|| format!("can't find session: {t}"))?;
                let windows = &self.sessions[s].windows;
                let w = match window {
                    None => self.first_of(s).1,
                    Some(Part::Id(id)) => windows.iter().position(|x| x.id == id).ok_or_else(|| format!("can't find window: {t}"))?,
                    Some(Part::Index(i)) => Some(i as usize).filter(|&i| i < windows.len()).ok_or_else(|| format!("can't find window: {t}"))?,
                };
                let panes = &windows[w].panes;
                let p = match pane {
                    None => windows[w].active.min(panes.len().saturating_sub(1)),
                    Some(Part::Id(id)) => panes.iter().position(|e| e.id == id).ok_or_else(|| format!("can't find pane: {t}"))?,
                    Some(Part::Index(i)) => Some(i as usize).filter(|&i| i < panes.len()).ok_or_else(|| format!("can't find pane: {t}"))?,
                };
                Ok(At(s, w, p))
            }
        }
    }

    // ---------- keeping house ----------

    /// A window whose program ended closes, as tmux's do, and a session with no window left ends.
    fn reap(&mut self) {
        for s in &mut self.sessions {
            for w in &mut s.windows {
                w.panes.retain(|e| !e.pane.dead());
            }
        }
        self.tidy();
    }

    /// Drops what was emptied and keeps each "active" pointing at something that's there.
    fn tidy(&mut self) {
        for s in &mut self.sessions {
            s.windows.retain(|w| !w.panes.is_empty());
            s.active = s.active.min(s.windows.len().saturating_sub(1));
            for w in &mut s.windows {
                w.active = w.active.min(w.panes.len().saturating_sub(1));
            }
        }
        self.sessions.retain(|s| !s.windows.is_empty());
        // a terminal whose pane is gone has nothing left to show
        let live: Vec<u32> = self.sessions.iter().flat_map(|s| s.windows.iter().flat_map(|w| w.panes.iter().map(|e| e.id))).collect();
        self.clients.retain(|c| live.contains(&c.pane));
    }
}

fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

/// What a program in a pane is told about where it runs: its pane's id as `TMUX_PANE`, the name
/// Inyon's agent hooks look their pane up by. `TMUX` itself stays unset, so a program doesn't
/// take this for a tmux it can send tmux's own escape sequences or commands to.
fn pane_env(id: u32) -> (String, String) {
    ("TMUX_PANE".to_string(), format!("%{id}"))
}

/// This machine's name.
fn hostname() -> String {
    #[cfg(unix)]
    {
        let mut buf = [0u8; 256];
        // SAFETY: the buffer is ours and its length is passed; the name is cut to fit it
        if unsafe { libc::gethostname(buf.as_mut_ptr().cast(), buf.len()) } == 0 {
            let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
            return String::from_utf8_lossy(&buf[..end]).into_owned();
        }
    }
    std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")).unwrap_or_default()
}

/// The buffer a command uses when it names none.
const BUFFER: &str = "buffer0";

fn matches(s: &Session, named: &Named) -> bool {
    match named {
        Named::Id(id) => s.id == *id,
        Named::Name(n) => s.name == *n,
    }
}

/// An arrow key in the keypad's application mode (`ESC O A` rather than `ESC [ A`).
fn arrow(word: &str, application: bool) -> Option<Vec<u8>> {
    let c = match word {
        "Up" => b'A',
        "Down" => b'B',
        "Right" => b'C',
        "Left" => b'D',
        _ => return None,
    };
    application.then(|| vec![0x1b, b'O', c])
}

#[cfg(all(test, unix))]
mod tests {
    use std::time::{Duration, Instant};

    use super::*;

    fn run(k: &mut Keeper, line: &[&str]) -> Reply {
        k.run(&line.iter().map(|s| s.to_string()).collect::<Vec<_>>(), b"")
    }

    fn out(k: &mut Keeper, line: &[&str]) -> String {
        let r = run(k, line);
        assert_eq!((r.code, r.err.as_str()), (0, ""), "{line:?}");
        r.out
    }

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

    /// A session called `name` running `cat` after a line that says it's ready.
    fn session(k: &mut Keeper, name: &str) -> String {
        let id = out(k, &["new-session", "-d", "-s", name, "-x", "100", "-y", "30", "-P", "-F", "#{pane_id}", "echo ready; exec cat"]);
        let id = id.trim().to_string();
        assert!(until(|| out(k, &["capture-pane", "-p", "-t", &id]).starts_with("ready")));
        id
    }

    #[test]
    fn a_session_starts_is_listed_typed_into_read_and_ended() {
        let mut k = Keeper::new();
        let pane = session(&mut k, "work");
        assert_eq!(pane, "%0");
        assert_eq!(out(&mut k, &["list-sessions", "-F", "#{session_id} #{session_name} #{session_attached}"]), "$0 work 0\n");
        assert_eq!(out(&mut k, &["has-session", "-t", "work"]), "");
        assert_eq!(
            out(
                &mut k,
                &["list-panes", "-a", "-F", "#{session_name}|#{window_id}|#{window_index}|#{pane_id}|#{pane_index}|#{pane_active}|#{pane_dead}|#{pane_width}x#{pane_height}"]
            ),
            "work|@0|0|%0|0|1|0|100x30\n"
        );
        // text, then Enter as its own key, the way the hub sends a message
        assert_eq!(out(&mut k, &["send-keys", "-t", "%0", "-l", "--", "-it's --here"]), "");
        assert_eq!(out(&mut k, &["send-keys", "-t", "%0", "Enter"]), "");
        // the terminal echoes the line and cat prints it again
        assert!(until(|| out(&mut k, &["capture-pane", "-p", "-t", "%0"]).matches("-it's --here").count() == 2));
        assert_eq!(out(&mut k, &["kill-session", "-t", "work"]), "");
        assert_eq!(out(&mut k, &["list-sessions"]), "");
        assert!(k.is_empty());
    }

    #[test]
    fn a_paste_goes_in_whole_and_its_buffer_goes_when_asked() {
        let mut k = Keeper::new();
        let pane = session(&mut k, "paste");
        let text = "first line\nsecond: ünïcödé 🪁\n";
        let r = k.run(&["load-buffer".into(), "-b".into(), "inyon-1".into(), "-".into()], text.as_bytes());
        assert_eq!(r.code, 0, "{r:?}");
        assert_eq!(out(&mut k, &["paste-buffer", "-d", "-b", "inyon-1", "-t", &pane]), "");
        assert!(until(|| out(&mut k, &["capture-pane", "-p", "-t", &pane]).matches("second: ünïcödé 🪁").count() == 2));
        // -d took the buffer with it
        assert_eq!(run(&mut k, &["paste-buffer", "-b", "inyon-1", "-t", &pane]).err, "no buffer inyon-1\n");
        assert_eq!(run(&mut k, &["delete-buffer", "-b", "inyon-1"]).code, 1);
    }

    #[test]
    fn a_pane_is_found_by_id_by_name_and_by_place() {
        let mut k = Keeper::new();
        session(&mut k, "one");
        session(&mut k, "two");
        assert_eq!(out(&mut k, &["new-window", "-d", "-t", "two", "-n", "logs", "-P", "-F", "#{window_id} #{pane_id}", "exec cat"]), "@2 %2\n");
        let which = |k: &mut Keeper, t: &str| out(k, &["display-message", "-p", "-t", t, "#{session_name} #{window_index} #{pane_id} #{window_name}"]);
        assert_eq!(which(&mut k, "%1"), "two 0 %1 cat\n");
        assert_eq!(which(&mut k, "two"), "two 0 %1 cat\n");
        assert_eq!(which(&mut k, "two:1"), "two 1 %2 logs\n");
        assert_eq!(which(&mut k, "$1:.%1"), "two 0 %1 cat\n");
        assert_eq!(which(&mut k, "@2"), "two 1 %2 logs\n");
        assert_eq!(out(&mut k, &["list-panes", "-s", "-t", "two", "-F", "#{pane_id}"]), "%1\n%2\n");
        assert_eq!(out(&mut k, &["list-panes", "-t", "two:1", "-F", "#{pane_id}"]), "%2\n");
        // select-window moves what a bare session name means
        out(&mut k, &["select-window", "-t", "two:1"]);
        assert_eq!(which(&mut k, "two"), "two 1 %2 logs\n");
        for (line, err) in [
            (vec!["has-session", "-t", "three"], "can't find session: three\n"),
            (vec!["send-keys", "-t", "%9", "Enter"], "can't find pane: %9\n"),
            (vec!["capture-pane", "-p", "-t", "two:7"], "can't find window: two:7\n"),
            (vec!["new-session", "-d", "-s", "one"], "duplicate session: one\n"),
            (vec!["split-window", "-t", "one"], "unknown command: split-window\n"),
        ] {
            let r = run(&mut k, &line);
            assert_eq!((r.code, r.err.as_str(), r.out.as_str()), (1, err, ""), "{line:?}");
        }
    }

    #[test]
    fn renames_resizes_and_a_program_started_again() {
        let mut k = Keeper::new();
        let pane = session(&mut k, "old");
        out(&mut k, &["rename-session", "-t", "old", "new"]);
        out(&mut k, &["rename-window", "-t", &pane, "agent"]);
        out(&mut k, &["resize-window", "-t", &pane, "-x", "120", "-y", "40"]);
        assert_eq!(out(&mut k, &["display-message", "-p", "-t", &pane, "#{session_name} #{window_name} #{window_width}x#{window_height}"]), "new agent 120x40\n");
        // still running: respawn refuses without -k, and with it starts the new program in the same pane
        assert_eq!(run(&mut k, &["respawn-pane", "-t", &pane, "echo again; exec cat"]).err, "pane %0 still active\n");
        out(&mut k, &["respawn-pane", "-k", "-t", &pane, "echo again; exec cat"]);
        assert!(until(|| out(&mut k, &["capture-pane", "-p", "-t", &pane]).starts_with("again")));
        assert_eq!(out(&mut k, &["list-panes", "-a", "-F", "#{pane_id} #{pane_width}"]), "%0 120\n");
        // what shapes a tmux someone sits at is accepted and changes nothing
        for line in [vec!["set-option", "-g", "mouse", "on"], vec!["bind-key", "-n", "WheelUpPane", "send-keys", "-M"], vec!["list-clients", "-F", "#{session_id}"]] {
            assert_eq!(run(&mut k, &line), Reply::default(), "{line:?}");
        }
    }

    #[test]
    fn a_program_is_told_its_pane_the_way_the_agent_hooks_look_for_it() {
        let mut k = Keeper::new();
        session(&mut k, "first");
        out(&mut k, &["new-session", "-d", "-s", "second", "echo \"pane=$TMUX_PANE tmux=[$TMUX]\"; exec cat"]);
        assert!(until(|| out(&mut k, &["capture-pane", "-p", "-t", "second"]).starts_with("pane=%1 tmux=[]")));
        // a program started again in the pane is told the same
        out(&mut k, &["respawn-pane", "-k", "-t", "second", "echo \"again=$TMUX_PANE\"; exec cat"]);
        assert!(until(|| out(&mut k, &["capture-pane", "-p", "-t", "second"]).starts_with("again=%1")));
    }

    #[test]
    fn a_pane_is_titled_after_the_machine_until_its_program_says_otherwise() {
        let mut k = Keeper::new();
        let pane = session(&mut k, "titled");
        let title = |k: &mut Keeper| out(k, &["display-message", "-p", "-t", &pane, "#{pane_title}"]);
        assert_eq!(title(&mut k).trim(), hostname());
        assert!(!hostname().is_empty());
        out(&mut k, &["respawn-pane", "-k", "-t", &pane, "printf '\\033]2;Fix the test\\007'; exec cat"]);
        assert!(until(|| title(&mut k) == "Fix the test\n"), "{:?}", title(&mut k));
    }

    #[test]
    fn the_terminal_view_gets_the_size_the_cursor_and_the_screen_in_one_go() {
        let mut k = Keeper::new();
        let pane = session(&mut k, "view");
        // what the mirror asks before each drawing, by tmux's short name for it
        assert_eq!(out(&mut k, &["display", "-p", "-t", &pane, "#{pane_width} #{pane_height} #{cursor_x} #{cursor_y} #{cursor_flag} #{alternate_on}"]), "100 30 0 1 1 0\n");
        // and how it lets go of a size it set: both are taken, and change nothing
        assert_eq!(run(&mut k, &["resize-window", "-t", &pane, "-A"]), Reply::default());
        assert_eq!(run(&mut k, &["set-option", "-w", "-t", &pane, "-u", "window-size"]), Reply::default());
        assert_eq!(out(&mut k, &["display", "-p", "-t", &pane, "#{pane_width}x#{pane_height}"]), "100x30\n");
    }

    #[test]
    fn a_terminal_attaches_sees_the_screen_types_resizes_and_lets_go() {
        let mut k = Keeper::new();
        let pane = session(&mut k, "mine");
        assert_eq!(out(&mut k, &["list-clients", "-F", "#{session_id}"]), "");
        let a = k.attach(Some("mine"), 90, 25).unwrap();
        assert_eq!((a.client, a.pane), (0, 0));
        // the window took the terminal's size, and the first picture holds what was there
        assert_eq!(out(&mut k, &["display", "-p", "-t", &pane, "#{pane_width}x#{pane_height} #{session_attached}"]), "90x25 1\n");
        let mut seen = crate::screen::Screen::new(90, 25);
        seen.feed(&a.first);
        assert!(seen.capture(crate::screen::Capture::default()).starts_with("ready\n"));
        // the hub's question about who's attached, as it asks it
        let line = out(&mut k, &["list-clients", "-F", "#{session_id} #{client_control_mode} #{client_activity} #{pane_id}"]);
        let f: Vec<&str> = line.trim().split(' ').collect();
        assert_eq!((f[0], f[1], f[3]), ("$0", "0", "%0"));
        assert!(f[2].parse::<u64>().unwrap() > 1_700_000_000);
        // what it types reaches the program, and what the program writes reaches it
        assert!(k.client_input(a.client, b"typed here\r"));
        assert!(until(|| {
            while let Ok(b) = a.output.try_recv() {
                seen.feed(&b);
            }
            seen.capture(crate::screen::Capture::default()).matches("typed here").count() == 2
        }));
        k.client_resize(a.client, 70, 20);
        assert_eq!(out(&mut k, &["display", "-p", "-t", &pane, "#{pane_width}x#{pane_height}"]), "70x20\n");
        k.detach(a.client);
        assert_eq!(out(&mut k, &["list-clients"]), "");
        assert!(!k.client_input(a.client, b"x"));
        // letting go ends nothing
        assert_eq!(out(&mut k, &["display", "-p", "-t", &pane, "#{pane_dead} #{session_attached}"]), "0 0\n");
        assert_eq!(k.attach(Some("nope"), 80, 24).err().as_deref(), Some("can't find session: nope"));
    }

    #[test]
    fn a_terminal_whose_program_ends_is_let_go_of() {
        let mut k = Keeper::new();
        out(&mut k, &["new-session", "-d", "-s", "brief", "read x"]);
        let a = k.attach(Some("brief"), 80, 24).unwrap();
        assert!(k.client_input(a.client, b"\r"));
        // the stream ends with the program
        let end = Instant::now() + Duration::from_secs(10);
        while a.output.recv_timeout(Duration::from_millis(200)).is_ok() || (Instant::now() < end && !k.is_empty_after_sweep()) {}
        assert_eq!(out(&mut k, &["list-clients"]), "");
        assert!(!k.client_input(a.client, b"x"));
    }

    #[test]
    fn a_program_that_ends_takes_its_window_and_then_its_session_with_it() {
        let mut k = Keeper::new();
        out(&mut k, &["new-session", "-d", "-s", "short", "exit 0"]);
        assert!(until(|| out(&mut k, &["list-sessions", "-F", "#{session_name}"]).is_empty()));
        assert_eq!(run(&mut k, &["has-session", "-t", "short"]).code, 1);
    }

    #[test]
    fn history_is_read_from_as_far_up_as_asked() {
        let mut k = Keeper::new();
        out(&mut k, &["new-session", "-d", "-s", "long", "-x", "40", "-y", "5", "for i in 1 2 3 4 5 6 7 8 9; do echo row $i; done; exec cat"]);
        assert!(until(|| out(&mut k, &["capture-pane", "-p", "-t", "long"]).contains("row 9")));
        let screen = out(&mut k, &["capture-pane", "-p", "-t", "long"]);
        assert!(!screen.contains("row 1\n") && screen.lines().count() == 5, "{screen:?}");
        let more = out(&mut k, &["capture-pane", "-p", "-J", "-S", "-3", "-t", "long"]);
        assert_eq!(more.lines().count(), 8, "{more:?}");
        assert!(out(&mut k, &["capture-pane", "-p", "-S", "-", "-t", "long"]).starts_with("row 1\n"));
    }
}
