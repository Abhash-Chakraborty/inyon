//! Port of the parsing in tmux/tmux.ts: the pane list, the probe's output, captured screens, and
//! the commands that type into a pane. Running them (and the probe script itself) stays in TS: the
//! functions here take what a command printed and return what it means, or build the command.

use std::collections::{HashMap, HashSet, VecDeque};

use indexmap::IndexMap;
use inyon_protocol::{agents, detect_agent, AgentKind, IntegrationState, MachineKind, PaneInfo, SessionInfo, WindowInfo, AGENT_KINDS};
use serde_json::Value;

use super::machine_kind::machine_kind;
use crate::hosts::host::shq;
use crate::js::json::{self, Js};
use crate::js::num::parse_int;
use crate::js::{to_number, JsStr};
use crate::re;

/// Sessions Inyon creates for terminal views; hidden from listings.
pub const VIEW_PREFIX: &str = "inyon-view-";
/// Sessions running an agent's sign-in; hidden too.
pub const LOGIN_PREFIX: &str = "inyon-login-";
/// Every prefix of a session that isn't yours, those from before the rename to Inyon included
pub const HIDDEN_PREFIXES: [&str; 4] = [VIEW_PREFIX, LOGIN_PREFIX, "tether-view-", "tether-login-"];

pub fn hidden_session(name: &str) -> bool {
    HIDDEN_PREFIXES.iter().any(|p| name.starts_with(p))
}

const SEP: char = '\u{1f}';

/// The `-F` format the probe lists panes with, fields joined by U+001F.
pub fn pane_format() -> String {
    [
        "#{session_id}",
        "#{session_name}",
        "#{session_attached}",
        "#{window_id}",
        "#{window_index}",
        "#{window_name}",
        "#{window_active}",
        "#{window_activity}",
        "#{pane_id}",
        "#{pane_index}",
        "#{pane_active}",
        "#{pane_pid}",
        "#{pane_current_command}",
        "#{pane_current_path}",
        "#{pane_title}",
        "#{pane_width}",
        "#{pane_height}",
        "#{pane_dead}",
    ]
    .join("\u{1f}")
}

/// One line of the pane format's output split into its fields. Older tmux (3.4, as on Ubuntu
/// 24.04) writes the separator escaped, as the four characters \037, and a backslash as \; those
/// lines are unescaped first. 3.6 writes them as they are.
pub fn tmux_fields(line: &str) -> Vec<String> {
    let line = if !line.contains(SEP) && line.contains("\\037") {
        re!(r"\\(\\|[0-7]{3})", "g")
            .replace_all(line, |c: &regex::Captures| {
                let e = &c[1];
                if e == "\\" {
                    "\\".to_owned()
                } else {
                    char::from_u32(parse_int(e, 8) as u32).map(String::from).unwrap_or_default()
                }
            })
            .into_owned()
    } else {
        line.to_owned()
    };
    line.split(SEP).map(str::to_owned).collect()
}

#[derive(Debug, Clone, PartialEq)]
struct Proc {
    pid: f64,
    ppid: f64,
    etimes: f64,
    comm: String,
    args: String,
}

/// A line of ~/.inyon/panes/*.json: the hook's last word on a pane.
#[derive(Debug, Clone, PartialEq)]
pub struct HookPaneState {
    pub pane: String,
    pub ts: f64,
    /// session_id, transcript_path, cwd, hook_event_name and whatever else the hook sent
    pub data: Value,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AgentProc {
    pub kind: AgentKind,
    pub pid: f64,
    pub started_at: f64,
    pub cwd: Option<String>,
    pub resume: Option<String>,
    pub args: String,
    /// the pane's own process; equal to pid when the agent was started as the pane command
    pub pane_pid: f64,
}

/// The last status line payload Claude wrote for a pane, with the account it was written under
/// and the one signed in now.
#[derive(Debug, Clone, PartialEq)]
pub struct StatusPane {
    pub ts: f64,
    pub data: Value,
    pub account: Option<String>,
    pub account_now: Option<String>,
}

/// Antigravity CLI's last status line payload for a pane.
#[derive(Debug, Clone, PartialEq)]
pub struct AgyStatusPane {
    pub ts: f64,
    pub data: Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TmuxProbe {
    Ok,
    NoServer,
    Missing,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ProbeResult {
    pub hostname: String,
    pub home: String,
    pub os: String,
    /// unix seconds
    pub now: f64,
    pub latency_ms: f64,
    pub tmux: TmuxProbe,
    /// never Unknown
    pub integration: IntegrationState,
    pub sessions: Vec<SessionInfo>,
    /// pane id → agent process found inside it
    pub agent_procs: IndexMap<String, AgentProc>,
    pub hook_panes: IndexMap<String, HookPaneState>,
    /// pane id → last status line payload (Claude)
    pub status_panes: IndexMap<String, StatusPane>,
    /// Claude account this machine is signed in to now (oauthAccount.accountUuid)
    pub account: Option<String>,
    /// pane id → unix seconds of the last compaction (Claude)
    pub compact_panes: IndexMap<String, f64>,
    pub installed: Vec<AgentKind>,
    /// agents with a saved sign-in on the machine
    pub signed_in: Vec<AgentKind>,
    /// Antigravity CLI: process id → the conversation it has open (from the presence lock it holds)
    pub agy_conversations: IndexMap<i64, String>,
    /// Antigravity CLI: pane id → last status line payload
    pub agy_status: IndexMap<String, AgyStatusPane>,
    /// Antigravity conversation id → its title
    pub agy_titles: IndexMap<String, String>,
    /// whether Inyon's status line is in Antigravity CLI's settings (None when agy isn't installed)
    pub agy_integration: Option<bool>,
    pub machine_kind: Option<MachineKind>,
}

/// `<pid> <folder>` lines → folder per process. Linux adds " (deleted)" once the folder is
/// removed (a worktree cleaned up while the agent runs); the agent's transcripts still name the
/// folder as it was, so drop the mark or the agent can't be matched to its chat.
pub fn proc_cwds(lines: &[String]) -> HashMap<i64, String> {
    let mut cwds = HashMap::new();
    for line in lines {
        let i = line.find(' ');
        let rest = match i {
            Some(i) => &line[i + 1..],
            None => line.as_str(),
        };
        let dir = re!(r" \(deleted\)$").replacen(rest, 1, "");
        if let Some(i) = i.filter(|&i| i > 0) {
            if !dir.is_empty() {
                cwds.insert(to_number(&line[..i]) as i64, dir.into_owned());
            }
        }
    }
    cwds
}

fn num(s: &str) -> f64 {
    to_number(s)
}

/// What `probe()` makes of the probe script's output. `stderr` and `code` only go into the error
/// when the script didn't run to its end.
pub fn parse_probe(stdout: &str, stderr: &str, code: i32, latency_ms: f64) -> Result<ProbeResult, String> {
    if !stdout.contains("@@END") {
        let text = if !stderr.is_empty() {
            stderr.to_owned()
        } else if !stdout.is_empty() {
            stdout.to_owned()
        } else {
            format!("exit {code}")
        };
        let lines: Vec<&str> = text.jtrim().split('\n').collect();
        return Err(lines[lines.len().saturating_sub(2)..].join(" "));
    }
    let mut sections: IndexMap<String, Vec<String>> = IndexMap::new();
    let mut cur = String::new();
    let mut res = ProbeResult {
        hostname: String::new(),
        home: String::new(),
        os: String::new(),
        now: crate::clock::now_ms() as f64 / 1000.0,
        latency_ms,
        tmux: TmuxProbe::Ok,
        integration: IntegrationState::Missing,
        sessions: vec![],
        agent_procs: IndexMap::new(),
        hook_panes: IndexMap::new(),
        status_panes: IndexMap::new(),
        account: None,
        compact_panes: IndexMap::new(),
        installed: vec![],
        signed_in: vec![],
        agy_conversations: IndexMap::new(),
        agy_status: IndexMap::new(),
        agy_titles: IndexMap::new(),
        agy_integration: None,
        machine_kind: None,
    };
    for line in stdout.split('\n') {
        if let Some(v) = line.strip_prefix("@@HOST ") {
            res.hostname = v.jtrim().to_owned();
        } else if let Some(v) = line.strip_prefix("@@HOME ") {
            res.home = v.jtrim().to_owned();
        } else if let Some(v) = line.strip_prefix("@@OS ") {
            // busybox-w32 (inyon on Windows) says Windows_NT
            let os = v.jtrim();
            res.os = if os == "Windows_NT" { "Windows".into() } else { os.to_owned() };
        } else if let Some(v) = line.strip_prefix("@@NOW ") {
            res.now = num(v);
        } else if let Some(v) = line.strip_prefix("@@KIND ") {
            res.machine_kind = machine_kind(v);
        } else if let Some(v) = line.strip_prefix("@@AUTH") {
            let words: Vec<&str> = re!(r"\s+").split(v.jtrim()).collect();
            res.signed_in = AGENT_KINDS.iter().copied().filter(|k| words.contains(&k.as_str())).collect();
        } else if let Some(v) = line.strip_prefix("@@ACCOUNT ") {
            let v = v.jtrim();
            res.account = if v == "-" { None } else { Some(v.to_owned()) };
        } else if let Some(v) = line.strip_prefix("@@AGYINT ") {
            res.agy_integration = Some(v.jtrim() == "installed");
        } else if line == "@@NOSERVER" {
            res.tmux = TmuxProbe::NoServer;
        } else if line == "@@NOTMUX" {
            res.tmux = TmuxProbe::Missing;
        } else if re!(r"^@@[A-Z]+$").is_match(line) {
            cur = line[2..].to_owned();
            sections.insert(cur.clone(), vec![]);
        } else if !cur.is_empty() {
            sections.get_mut(&cur).expect("section").push(line.to_owned());
        }
    }
    let empty = vec![];
    let section = |name: &str| sections.get(name).unwrap_or(&empty);

    // processes
    let mut procs: HashMap<i64, Proc> = HashMap::new();
    let mut children: HashMap<i64, Vec<i64>> = HashMap::new();
    for line in section("PS") {
        let Some(m) = re!(r"^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$").captures(line) else { continue };
        // macOS gives the executable's full path
        let comm = m[4].rsplit('/').next().unwrap_or("").to_owned();
        let p = Proc { pid: num(&m[1]), ppid: num(&m[2]), etimes: num(&m[3]), comm, args: m[5].to_owned() };
        children.entry(p.ppid as i64).or_default().push(p.pid as i64);
        procs.insert(p.pid as i64, p);
    }
    let cwds = proc_cwds(section("CWD"));
    let find_agent = |root: i64| -> Option<(&Proc, AgentKind)> {
        let mut queue = VecDeque::from([(root, 0)]);
        while let Some((pid, depth)) = queue.pop_front() {
            let p = procs.get(&pid);
            if let Some(p) = p {
                if let Some(kind) = detect_agent(&p.comm, &p.args) {
                    return Some((p, kind));
                }
            }
            if depth < 4 {
                for c in children.get(&pid).into_iter().flatten() {
                    queue.push_back((*c, depth + 1));
                }
            }
        }
        None
    };

    let bins: HashSet<&str> = section("BINS").iter().map(|l| l.jtrim()).filter(|l| !l.is_empty()).collect();
    res.installed = AGENT_KINDS.iter().copied().filter(|k| agents()[k].comm.iter().any(|c| bins.contains(c.as_str()))).collect();
    for line in section("STATUS") {
        let Some(m) = re!(r"^(\d+(?:\.\d+)?) (\d+) (\S+) (\S+) (.*)$").captures(line) else { continue };
        let acct = |v: &str| if v == "-" { None } else { Some(v.to_owned()) };
        if let Some(data) = json::parse(&m[5]) {
            res.status_panes.insert(format!("%{}", &m[1]), StatusPane { ts: num(&m[2]), account: acct(&m[3]), account_now: acct(&m[4]), data });
        }
    }
    for line in section("AGY") {
        if let Some(m) = re!(r"^\d+ (\d+) .*\/presence\/([0-9a-f-]{36})\.lock$").captures(line) {
            res.agy_conversations.insert(num(&m[1]) as i64, m[2].to_owned());
        }
    }
    for line in section("AGYTITLE") {
        if let Some(m) = re!(r"^([0-9a-f-]{36}) (.+)$").captures(line) {
            res.agy_titles.insert(m[1].to_owned(), m[2].jtrim().to_owned());
        }
    }
    for line in section("AGYSTATUS") {
        let Some(m) = re!(r"^(\d+(?:\.\d+)?) (\d+) (.*)$").captures(line) else { continue };
        if let Some(data) = json::parse(&m[3]) {
            res.agy_status.insert(format!("%{}", &m[1]), AgyStatusPane { ts: num(&m[2]), data });
        }
    }
    for line in section("COMPACT") {
        if let Some(m) = re!(r"^(\d+(?:\.\d+)?) (\d+)").captures(line) {
            res.compact_panes.insert(format!("%{}", &m[1]), num(&m[2]));
        }
    }

    let hook = section("HOOK").first().map(|h| h.jtrim());
    res.integration = match hook {
        Some("installed") => IntegrationState::Installed,
        Some("removed") => IntegrationState::Removed,
        Some("outdated") => IntegrationState::Outdated,
        _ => IntegrationState::Missing,
    };
    for line in section("PANES") {
        if line.is_blank() {
            continue;
        }
        let Some(v) = json::parse(line) else { continue };
        let pane = Some(&v).at("pane");
        if pane.truthy() {
            let pane = pane.to_js_string();
            let state = HookPaneState { pane: pane.clone(), ts: Some(&v).at("ts").num().unwrap_or(f64::NAN), data: Some(&v).at("data").cloned().unwrap_or(Value::Null) };
            res.hook_panes.insert(pane, state);
        }
    }

    // tmux tree
    let mut sessions: IndexMap<String, SessionInfo> = IndexMap::new();
    for line in section("TMUX") {
        let f = tmux_fields(line);
        if f.len() < 18 {
            continue;
        }
        let [sid, sname, sattached, wid, widx, wname, wactive, wact, pid, pidx, pactive, ppid, pcmd, pcwd, ptitle, pw, ph, pdead] = std::array::from_fn(|i| f[i].as_str());
        if hidden_session(sname) {
            continue;
        }
        let s = sessions.entry(sid.to_owned()).or_insert_with(|| SessionInfo { id: sid.into(), name: sname.into(), attached: num(sattached) as u32, windows: vec![] });
        // windows are keyed by session and window id, and each session holds its own
        let w = match s.windows.iter().position(|w| w.id == wid) {
            Some(i) => &mut s.windows[i],
            None => {
                s.windows.push(WindowInfo { id: wid.into(), index: num(widx) as u32, name: wname.into(), active: wactive == "1", activity: num(wact) as u64, panes: vec![] });
                s.windows.last_mut().expect("window")
            }
        };
        w.panes.push(PaneInfo {
            id: pid.into(),
            index: num(pidx) as u32,
            active: pactive == "1",
            command: pcmd.into(),
            cwd: pcwd.into(),
            title: ptitle.into(),
            label: None,
            width: num(pw) as u32,
            height: num(ph) as u32,
            dead: pdead == "1",
            agent: None,
        });
        if let Some((cp, kind)) = find_agent(num(ppid) as i64) {
            let resume = re!(r"(?:--resume|-r|resume)[ =]([0-9a-f]{8}-[0-9a-f-]{27})").captures(&cp.args).map(|c| c[1].to_owned());
            let cwd = cwds.get(&(cp.pid as i64)).cloned().unwrap_or_else(|| pcwd.to_owned());
            res.agent_procs
                .insert(pid.to_owned(), AgentProc { kind, pid: cp.pid, started_at: res.now - cp.etimes, cwd: Some(cwd), resume, args: cp.args.clone(), pane_pid: num(ppid) });
        }
    }
    // the "attached" count shouldn't include Inyon's own control-mode clients
    let mut people: HashMap<&str, u32> = HashMap::new();
    for line in section("CLIENTS") {
        let mut parts = line.jtrim().split(' ');
        let (sid, control) = (parts.next().unwrap_or(""), parts.next());
        if !sid.is_empty() && control == Some("0") {
            *people.entry(sid).or_default() += 1;
        }
    }
    if sections.contains_key("CLIENTS") {
        for s in sessions.values_mut() {
            s.attached = people.get(s.id.as_str()).copied().unwrap_or(0);
        }
    }
    res.sessions = sessions.into_values().collect();
    Ok(res)
}

/// The command `capturePanes` runs: each pane's visible screen, with styling, in one round trip.
pub fn capture_command(pane_ids: &[String]) -> Option<String> {
    if pane_ids.is_empty() {
        return None;
    }
    Some(pane_ids.iter().map(|p| format!("echo {}; tmux capture-pane -p -e -t {} 2>/dev/null", shq(&format!("@@CAP {p}")), shq(p))).collect::<Vec<_>>().join("; "))
}

/// What `capturePanes` makes of that command's output: pane id → its rows.
pub fn parse_captures(stdout: &str) -> IndexMap<String, Vec<String>> {
    let mut out: IndexMap<String, Vec<String>> = IndexMap::new();
    let mut cur: Option<String> = None;
    for line in stdout.split('\n') {
        if let Some(p) = line.strip_prefix("@@CAP ") {
            out.insert(p.to_owned(), vec![]);
            cur = Some(p.to_owned());
        } else if let Some(c) = &cur {
            out.get_mut(c).expect("pane").push(line.to_owned());
        }
    }
    out
}

/// Pastes what comes in on stdin into a pane as one bracketed paste. The text goes through a
/// file, since psmux's load-buffer only reads a path, not "-". psmux also runs a server per
/// session and buffers live in one server, so on Windows the buffer is loaded into the pane's own
/// session (the -t before the command, which psmux takes for any command); otherwise paste-buffer
/// can't find it.
pub fn paste_command(buffer: &str, pane: &str) -> String {
    let b = shq(buffer);
    let t = r#"${s:+-t "$s"}"#;
    let p = shq(pane);
    // the trap deletes the file (it holds what was pasted) even when the connection drops half way
    format!(
        r#"umask 077; f=$(mktemp) && trap 'rm -f "$f"' EXIT HUP INT TERM && {{ s=; [ "$OS" = Windows_NT ] && s={p}; cat > "$f" && tmux {t} load-buffer -b {b} "$f" && tmux paste-buffer -d -p -b {b} -t {p}; r=$?; rm -f "$f"; [ $r = 0 ] || tmux {t} delete-buffer -b {b} 2>/dev/null; [ $r = 0 ]; }}"#
    )
}

/// How `typeText` gets text into a pane.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TypeText {
    /// one bracketed paste: run `command` with `input` on stdin, then Enter after 150 ms if `submit`
    Paste { command: String, input: String, submit: bool },
    /// send-keys, the Enter (if any) included
    Keys(String),
    /// nothing to type
    Nothing,
}

/// Types text into a pane exactly as a person would; newlines become Ctrl+J (newline without
/// submitting). With `submit`, Enter follows after a short pause, all in one round trip. Long or
/// multi-line text is one paste through `buffer` (`inyon-<uuid>` in the hub).
pub fn type_text(pane: &str, text: &str, submit: bool, buffer: &str) -> TypeText {
    let normal = re!(r"\r\n?", "g").replace_all(text, "\n").into_owned();
    if text.len16() > 800 || re!(r"[\r\n]").is_match(text) {
        // Deliver one bracketed paste instead of a burst of individual key events. The CLI can
        // preserve long/multiline text atomically and display its own collapsed paste preview.
        return TypeText::Paste { command: paste_command(buffer, pane), input: normal, submit };
    }
    let mut parts: Vec<String> = vec![];
    for (i, line) in normal.split('\n').enumerate() {
        if i > 0 {
            parts.push(format!("tmux send-keys -t {} C-j", shq(pane)));
        }
        let mut o = 0;
        while o < line.len16() {
            parts.push(format!("tmux send-keys -t {} -l -- {}", shq(pane), shq(line.slice16(o as isize, Some(o as isize + 800)))));
            o += 800;
        }
    }
    if submit {
        parts.push("sleep 0.12".into());
        parts.push(format!("tmux send-keys -t {} Enter", shq(pane)));
    }
    if parts.is_empty() {
        TypeText::Nothing
    } else {
        TypeText::Keys(parts.join(" && "))
    }
}

/// letters, the named keys, function keys, and Ctrl/Alt chords (OpenCode's bindings can be
/// remapped to those)
pub fn key_allowed(key: &str) -> bool {
    re!(r"^([A-Za-z0-9]|Enter|Escape|Tab|BTab|Up|Down|Left|Right|S-Left|S-Right|Space|BSpace|Home|End|PageUp|PageDown|F[1-9]|F1[0-2]|(C-|M-|C-M-)[A-Za-z0-9])$").is_match(key)
}

/// The command `sendKeys` runs, or the error it throws for a key that isn't allowed.
pub fn send_keys_command(pane: &str, keys: &[&str]) -> Result<String, String> {
    if let Some(k) = keys.iter().find(|k| !key_allowed(k)) {
        return Err(format!("key not allowed: {k}"));
    }
    Ok(keys.iter().map(|k| format!("tmux send-keys -t {} {k}", shq(pane))).collect::<Vec<_>>().join(" && "))
}

/// The folder under ~/.claude/projects where Claude keeps a working folder's transcripts.
pub fn claude_slug(cwd: &str) -> String {
    // per UTF-16 unit, as the TS regex replaces each one
    cwd.chars().flat_map(|c| std::iter::repeat_n(if c.is_ascii_alphanumeric() { c } else { '-' }, if c.is_ascii_alphanumeric() { 1 } else { c.len_utf16() })).collect()
}

/// A Claude process as `guessTranscript` sees it.
#[derive(Debug, Clone, PartialEq)]
pub struct TranscriptProc<'a> {
    pub cwd: Option<&'a str>,
    pub started_at: f64,
    pub resume: Option<&'a str>,
}

/// The folder `guessTranscript` looks in and the command that lists its newest transcripts, or
/// None for a process without a folder.
pub fn guess_transcript_command(home: &str, proc: &TranscriptProc) -> Option<(String, String)> {
    let dir = format!("{home}/.claude/projects/{}", claude_slug(proc.cwd?));
    let cmd = format!(r#"cd {} 2>/dev/null && for f in $(ls -t *.jsonl 2>/dev/null | head -5); do echo "$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f") $f"; done"#, shq(&dir));
    Some((dir, cmd))
}

/// Best guess at a Claude process's transcript without hooks, from what that command printed:
/// the session it was resumed with, or the newest transcript in its project folder written since
/// the process started. A brand-new session has no transcript until its first message, so older
/// files are never picked.
pub fn guess_transcript(stdout: &str, dir: &str, proc: &TranscriptProc) -> Option<String> {
    let files: Vec<(f64, &str)> = stdout
        .jtrim()
        .split('\n')
        .filter(|l| !l.is_empty())
        .map(|l| match l.find(' ') {
            Some(i) => (to_number(&l[..i]), &l[i + 1..]),
            // `l.slice(0, -1)` and the whole line, as indexOf's -1 makes them
            None => (to_number(l.to16(-1)), l),
        })
        .collect();
    if let Some(resume) = proc.resume {
        let hit = files.iter().any(|f| f.1 == format!("{resume}.jsonl"));
        if hit || files.is_empty() {
            return Some(format!("{dir}/{resume}.jsonl"));
        }
    }
    match files.iter().find(|f| f.0 >= proc.started_at - 2.0) {
        Some(f) => Some(format!("{dir}/{}", f.1)),
        None => proc.resume.map(|r| format!("{dir}/{r}.jsonl")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// tmux 3.4 escapes the field separator; its lines read the same as newer ones (locale.test.ts)
    #[test]
    fn tmux_3_4_escapes_the_field_separator_its_lines_read_the_same_as_newer_ones() {
        // as tmux 3.4 printed a session "a\b" holding window "tëst"
        assert_eq!(tmux_fields("a\\\\b\\037tëst\\037%0"), vec!["a\\b", "tëst", "%0"]);
        // newer tmux: the separator as it is, and a backslash left alone
        assert_eq!(tmux_fields("a\\b\u{1f}tëst\u{1f}%0"), vec!["a\\b", "tëst", "%0"]);
    }

    /// an agent whose folder was deleted is still matched to its chat (deleted-cwd.test.ts)
    #[test]
    fn an_agent_whose_folder_was_deleted_is_still_matched_to_its_chat() {
        use crate::agents::codex::{pick_codex_rollout, CodexProc, CodexRollout};
        // what readlink /proc/<pid>/cwd prints once the worktree the agent runs in is removed
        let cwds = proc_cwds(&["4242 /home/u/wt/review (deleted)".into(), "4243 /home/u/my (deleted) notes".into()]);
        assert_eq!(cwds.get(&4242).map(String::as_str), Some("/home/u/wt/review"));
        // only the mark Linux adds at the end comes off
        assert_eq!(cwds.get(&4243).map(String::as_str), Some("/home/u/my (deleted) notes"));

        let proc = CodexProc { pid: 4242, cwd: cwds.get(&4242).cloned(), started_at: 1000.0, ..Default::default() };
        let rows = vec![CodexRollout { path: "/s/rollout-a.jsonl".into(), id: Some("a".into()), cwd: Some("/home/u/wt/review".into()), created: 1010.0, mtime: 2000.0 }];
        assert_eq!(pick_codex_rollout(&rows, &proc, std::slice::from_ref(&proc), &HashMap::new()), Some("/s/rollout-a.jsonl".into()));
    }

    #[test]
    fn the_probe_output_reads_into_sessions_and_agents() {
        let sep = "\u{1f}";
        let pane = |sid: &str, sname: &str, pid: &str, ppid: &str| {
            [
                "$".to_owned() + sid,
                sname.into(),
                "2".into(),
                "@1".into(),
                "0".into(),
                "main".into(),
                "1".into(),
                "1700000000".into(),
                pid.into(),
                "0".into(),
                "1".into(),
                ppid.into(),
                "zsh".into(),
                "/home/u/p".into(),
                "t".into(),
                "120".into(),
                "40".into(),
                "0".into(),
            ]
            .join(sep)
        };
        let out = [
            "@@HOST box ".to_owned(),
            "@@HOME /home/u".into(),
            "@@OS Linux".into(),
            "@@NOW 2000".into(),
            "@@KIND Linux|1|vm|kvm|0|0|KVM|".into(),
            "@@BINS".into(),
            "claude".into(),
            "@@TMUX".into(),
            pane("1", "work", "%1", "100"),
            pane("2", "inyon-view-x", "%2", "200"),
            "@@CLIENTS".into(),
            "$1 0".into(),
            "$1 1".into(),
            "@@PS".into(),
            "  100     1   50 zsh -zsh".into(),
            "  101   100   40 /usr/bin/claude claude --resume 7409eef9-d507-4808-a592-0bfabe896e3a".into(),
            "@@CWD".into(),
            "101 /home/u/p/sub".into(),
            "@@HOOK".into(),
            "installed".into(),
            "@@AUTH claude codex".into(),
            "@@ACCOUNT -".into(),
            "@@PANES".into(),
            r#"{"pane":"%1","ts":5,"data":{"session_id":"s"}}"#.into(),
            "@@COMPACT".into(),
            "1 1990".into(),
            "@@STATUS".into(),
            r#"1 1995 A - {"session_id":"s"}"#.into(),
            "@@END".into(),
        ]
        .join("\n");
        let r = parse_probe(&out, "", 0, 12.0).unwrap();
        assert_eq!((r.hostname.as_str(), r.os.as_str(), r.now), ("box", "Linux", 2000.0));
        assert_eq!(r.machine_kind, Some(MachineKind::Server));
        assert_eq!(r.installed, vec![AgentKind::Claude]);
        assert_eq!(r.signed_in, vec![AgentKind::Claude, AgentKind::Codex]);
        assert_eq!(r.integration, IntegrationState::Installed);
        assert_eq!(r.sessions.len(), 1);
        assert_eq!(r.sessions[0].attached, 1);
        let a = &r.agent_procs["%1"];
        assert_eq!((a.kind, a.pid, a.started_at, a.cwd.as_deref()), (AgentKind::Claude, 101.0, 1960.0, Some("/home/u/p/sub")));
        assert_eq!(a.resume.as_deref(), Some("7409eef9-d507-4808-a592-0bfabe896e3a"));
        assert_eq!(r.hook_panes["%1"].data["session_id"], "s");
        assert_eq!(r.compact_panes["%1"], 1990.0);
        assert_eq!((r.status_panes["%1"].account.as_deref(), r.status_panes["%1"].account_now.as_deref()), (Some("A"), None));
        assert_eq!(parse_probe("oops\nfirst\nsecond", "", 1, 0.0), Err("first second".into()));
    }

    #[test]
    fn captures_split_by_pane_and_commands_are_quoted() {
        assert_eq!(capture_command(&[]), None);
        assert_eq!(capture_command(&["%1".into()]).unwrap(), "echo '@@CAP %1'; tmux capture-pane -p -e -t '%1' 2>/dev/null");
        let c = parse_captures("junk\n@@CAP %1\na\nb\n@@CAP %2\n");
        assert_eq!(c["%1"], vec!["a", "b"]);
        assert_eq!(c["%2"], vec![""]);
        assert_eq!(type_text("%1", "hi", true, "b"), TypeText::Keys("tmux send-keys -t '%1' -l -- 'hi' && sleep 0.12 && tmux send-keys -t '%1' Enter".into()));
        assert_eq!(type_text("%1", "", false, "b"), TypeText::Nothing);
        assert!(matches!(type_text("%1", "a\r\nb", false, "b"), TypeText::Paste { input, .. } if input == "a\nb"));
        assert_eq!(send_keys_command("%1", &["Enter", "rm"]), Err("key not allowed: rm".into()));
        assert_eq!(claude_slug("/home/u/my.app"), "-home-u-my-app");
    }

    #[test]
    fn a_transcript_is_guessed_from_the_resume_id_or_the_newest_file() {
        let p = TranscriptProc { cwd: Some("/p"), started_at: 100.0, resume: None };
        let (dir, _) = guess_transcript_command("/h", &p).unwrap();
        assert_eq!(dir, "/h/.claude/projects/-p");
        assert_eq!(guess_transcript("200 new.jsonl\n50 old.jsonl\n", &dir, &p), Some("/h/.claude/projects/-p/new.jsonl".into()));
        assert_eq!(guess_transcript("50 old.jsonl\n", &dir, &p), None);
        let r = TranscriptProc { resume: Some("r"), ..p };
        assert_eq!(guess_transcript("", &dir, &r), Some("/h/.claude/projects/-p/r.jsonl".into()));
    }
}
