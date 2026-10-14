//! `inyon` with nothing after it: what this machine is to the app, where it answers, who's
//! paired, what's running. Read from the state files, so it's on screen before the engine
//! could have started.

use std::fs;
use std::path::Path;

use ratatui::buffer::Buffer;
use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;
use ratatui::Frame;
use serde::Serialize;

use super::{banner, fit, Theme, VERSION};
use crate::paths::{node_dir, saved_hub};
use crate::service::{self, Role, Sys};
use crate::state;
use crate::sys::which;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Job {
    pub role: String,
    pub service: bool,
    pub running: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PairedPhone {
    pub key: String,
    pub name: String,
    pub paired: String,
    pub last_seen: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Status {
    pub v: u32,
    pub cli: String,
    pub engine: Option<String>,
    /// hub, node (paired with the phone), joined (a hub's node) or none
    pub role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hub: Option<String>,
    pub machine: Option<String>,
    pub jobs: Vec<Job>,
    pub addresses: Vec<String>,
    pub relays: Vec<String>,
    pub phones: Vec<PairedPhone>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nodes: Option<Vec<String>>,
    pub agents: Vec<String>,
    pub pairing_open: bool,
    pub log: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// Reads everything the screen shows. `agents` costs a tmux call, so it's optional.
pub fn gather(sys: &Sys, with_agents: bool) -> Status {
    let link = state::link_state();
    let hub = saved_hub();
    let jobs: Vec<Job> = service::ROLES
        .iter()
        .map(|r| {
            let running = crate::update::read_running(*r);
            Job {
                role: r.name().to_string(),
                service: service::has_service(sys, *r),
                running: running.as_ref().and_then(|s| s.pid).is_some_and(|p| sys.proc.alive(p)),
                version: running.and_then(|s| s.version),
            }
        })
        .collect();
    let has = |r: Role| jobs.iter().any(|j| j.role == r.name() && (j.service || j.running));
    let role = if has(Role::Hub) {
        "hub"
    } else if hub.is_some() || has(Role::Node) {
        "joined"
    } else if has(Role::Link) || state::identity().is_some() {
        "node"
    } else {
        "none"
    };
    let engine = jobs.iter().find_map(|j| if j.running { j.version.clone() } else { None }).or_else(|| crate::engine::find().map(|_| "installed".to_string()));
    let phones = state::phones()
        .into_iter()
        .map(|(key, p)| PairedPhone { key: key.chars().take(12).collect(), name: p.name, paired: state::format_date(p.paired_at), last_seen: p.last_seen.map(state::format_time) })
        .collect();
    let nodes = (role == "hub").then(hub_nodes).flatten();
    let agents = if with_agents { running_agents() } else { Vec::new() };
    let note = (!crate::engine::find().is_some()).then(|| "The engine isn't installed yet: run `inyon setup`.".to_string());
    Status {
        v: 1,
        cli: VERSION.to_string(),
        engine,
        role: role.to_string(),
        hub,
        machine: state::identity().and_then(|i| i.id),
        jobs,
        addresses: link.as_ref().map(|s| s.urls.clone()).unwrap_or_default(),
        relays: link.as_ref().map(|s| s.relays.clone()).unwrap_or_default(),
        phones,
        nodes,
        agents,
        pairing_open: state::pairing_open(),
        log: last_log_lines(&node_dir(), 6),
        note,
    }
}

/// The hub's machines, through its loopback API (hub 0.13 and on; older hubs have none).
fn hub_nodes() -> Option<Vec<String>> {
    let token = fs::read_to_string(crate::paths::data_dir().join("local-token")).ok()?.trim().to_string();
    let env = crate::paths::read_env_file(&crate::paths::data_dir().join("hub.env"));
    let res = crate::http::get_local(&format!("{}/api/local/nodes?token={token}", crate::commands::hub_local_url(&env))).ok()?;
    if !res.ok() {
        return None;
    }
    let v: serde_json::Value = serde_json::from_slice(&res.body).ok()?;
    Some(v.get("nodes")?.as_array()?.iter().filter_map(|n| n.get("name").or(n.get("hostname")).and_then(|s| s.as_str()).map(String::from)).collect())
}

const AGENTS: [&str; 5] = ["claude", "codex", "gemini", "opencode", "aider"];

/// The coding agents in tmux panes right now (one tmux call; nothing when tmux isn't running).
pub fn running_agents() -> Vec<String> {
    if which("tmux").is_none() {
        return Vec::new();
    }
    let r = crate::sys::run(&["tmux", "list-panes", "-a", "-F", "#{session_name}:#{window_index}.#{pane_index} #{pane_current_command}"]);
    if !r.ok {
        return Vec::new();
    }
    parse_agents(&r.out)
}

pub fn parse_agents(list: &str) -> Vec<String> {
    list.lines()
        .filter_map(|l| {
            let (pane, cmd) = l.split_once(' ')?;
            let name = cmd.trim().rsplit('/').next()?.to_lowercase();
            AGENTS.iter().any(|a| name == *a).then(|| format!("{} in {pane}", cmd.trim()))
        })
        .collect()
}

/// The last `n` lines of whichever log changed most recently.
pub fn last_log_lines(dir: &Path, n: usize) -> Vec<String> {
    let mut best: Option<(std::time::SystemTime, std::path::PathBuf)> = None;
    for name in ["link.log", "node.log", "hub.log", "update.log"] {
        let p = dir.join(name);
        if let Ok(m) = fs::metadata(&p).and_then(|m| m.modified()) {
            if best.as_ref().is_none_or(|(t, _)| m > *t) {
                best = Some((m, p));
            }
        }
    }
    let Some((_, p)) = best else {
        return Vec::new();
    };
    let Ok(text) = fs::read_to_string(&p) else {
        return Vec::new();
    };
    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    lines.iter().rev().take(n).rev().map(|l| format!("{name}: {}", state::local_log_line(l))).collect()
}

fn role_line(s: &Status) -> String {
    match s.role.as_str() {
        "hub" => "Hub: the server phones sign in to".to_string(),
        "joined" => format!("Machine on the hub {}", s.hub.as_deref().map(crate::http::host_of).unwrap_or_default()),
        "node" => "Paired with the phone".to_string(),
        _ => "Not set up yet: run `inyon setup`".to_string(),
    }
}

fn dot(theme: Theme, on: bool, attention: bool) -> Span<'static> {
    if on {
        Span::styled("●", theme.strong())
    } else if attention {
        Span::styled("●", theme.attention())
    } else {
        Span::styled("○", theme.faint())
    }
}

fn job_lines(s: &Status, theme: Theme) -> Vec<Line<'static>> {
    let mut out = Vec::new();
    for j in &s.jobs {
        if !j.service && !j.running {
            continue;
        }
        let what = match j.role.as_str() {
            "link" => "phone link",
            "node" => "hub connection",
            _ => "hub",
        };
        let how = match (j.running, j.service) {
            (true, true) => "running",
            (true, false) => "running, started by hand",
            _ => "set up, not running",
        };
        let version = j.version.as_deref().map(|v| format!(" · {v}")).unwrap_or_default();
        out.push(Line::from(vec![
            dot(theme, j.running, j.service && !j.running),
            Span::raw(" "),
            Span::styled(what.to_string(), theme.body()),
            Span::styled(format!("  {how}{version}"), theme.muted()),
        ]));
    }
    if out.is_empty() {
        out.push(Line::from(vec![dot(theme, false, false), Span::styled(" nothing runs in the background", theme.muted())]));
    }
    out
}

/// The screen, for a terminal or a TestBackend.
pub fn render(f: &mut Frame, s: &Status, theme: Theme) {
    let area = f.area();
    let narrow = area.width < 72;
    let head = banner(area.width);
    let rows = Layout::default().direction(Direction::Vertical).constraints([Constraint::Length(head.len() as u16 + 1), Constraint::Min(4), Constraint::Length(1)]).split(area);
    let mut top: Vec<Line> = head.iter().map(|l| Line::from(Span::styled(l.clone(), theme.strong()))).collect();
    top.push(Line::from(Span::styled("─".repeat(area.width as usize), theme.line())));
    f.render_widget(Paragraph::new(top), rows[0]);

    let mut left: Vec<Line> = vec![Line::from(Span::styled(role_line(s), theme.body()))];
    if let Some(m) = &s.machine {
        left.push(Line::from(Span::styled(format!("machine {}", fit(m, 28)), theme.faint())));
    }
    left.push(Line::raw(""));
    left.extend(job_lines(s, theme));
    let left_w = if narrow { area.width as usize } else { (area.width as usize) * 58 / 100 };
    if !s.addresses.is_empty() || !s.relays.is_empty() {
        left.push(Line::raw(""));
        left.push(Line::from(Span::styled("Answers on", theme.muted())));
        for a in s.addresses.iter().chain(s.relays.iter()) {
            left.push(Line::from(Span::raw(format!("  {}", fit(a, left_w.saturating_sub(2))))));
        }
    }

    let mut right: Vec<Line> = Vec::new();
    right.push(Line::from(Span::styled(if s.phones.is_empty() { "No phones paired yet".to_string() } else { format!("Phones ({})", s.phones.len()) }, theme.muted())));
    for p in &s.phones {
        let seen = p.last_seen.as_deref().map(|t| format!("seen {t}")).unwrap_or_else(|| "never seen".to_string());
        right.push(Line::from(vec![Span::raw(format!("  {}", fit(&p.name, 18))), Span::styled(format!("  {seen}"), theme.faint())]));
    }
    if s.pairing_open {
        right.push(Line::from(vec![Span::styled("  ● ", theme.attention()), Span::styled("a pairing code is open", theme.muted())]));
    }
    if let Some(nodes) = &s.nodes {
        right.push(Line::raw(""));
        right.push(Line::from(Span::styled(format!("Machines on this hub ({})", nodes.len()), theme.muted())));
        for n in nodes {
            right.push(Line::from(Span::raw(format!("  {n}"))));
        }
    }
    if !s.agents.is_empty() {
        right.push(Line::raw(""));
        right.push(Line::from(Span::styled("Agents running", theme.muted())));
        for a in &s.agents {
            right.push(Line::from(Span::raw(format!("  {a}"))));
        }
    }

    // the content takes the height it needs; the log follows it, and the footer stays at the bottom
    let content_h = if narrow { left.len() + 1 + right.len() } else { left.len().max(right.len()) } as u16;
    let note_h = s.note.as_deref().map(|n| super::wrap(n, (area.width as usize).saturating_sub(2)).len() as u16 + 1).unwrap_or(0);
    let log_h = note_h + if s.log.is_empty() { 0 } else { s.log.len().min(5) as u16 + 2 };
    let body_rows = Layout::default().direction(Direction::Vertical).constraints([Constraint::Length(content_h), Constraint::Length(log_h), Constraint::Min(0)]).split(rows[1]);
    if narrow {
        let mut all = left;
        all.push(Line::raw(""));
        all.extend(right);
        f.render_widget(Paragraph::new(all), body_rows[0]);
    } else {
        let cols = Layout::default().direction(Direction::Horizontal).constraints([Constraint::Percentage(58), Constraint::Percentage(42)]).split(body_rows[0]);
        f.render_widget(Paragraph::new(left), cols[0]);
        f.render_widget(Paragraph::new(right), cols[1]);
    }
    let mut below: Vec<Line> = Vec::new();
    if let Some(note) = &s.note {
        below.push(Line::raw(""));
        for (i, l) in super::wrap(note, (area.width as usize).saturating_sub(2)).into_iter().enumerate() {
            below.push(Line::from(vec![Span::styled(if i == 0 { "! " } else { "  " }, theme.attention()), Span::raw(l)]));
        }
    }
    if !s.log.is_empty() {
        below.push(Line::raw(""));
        below.push(Line::from(Span::styled("Log", theme.muted())));
        for l in s.log.iter().rev().take(5).rev() {
            below.push(Line::from(Span::styled(fit(l, area.width as usize), theme.faint())));
        }
    }
    f.render_widget(Paragraph::new(below), body_rows[1]);
    let foot = Rect { x: area.x, y: area.y + area.height - 1, width: area.width, height: 1 };
    f.render_widget(Paragraph::new(Line::from(Span::styled(fit("q quit · r refresh · s setup · p pair", area.width as usize), theme.faint()))), foot);
}

/// The same, as text for a pipe or a file.
pub fn plain(s: &Status) -> String {
    let mut out = vec![format!("inyon {}", s.cli)];
    out.push(role_line(s));
    if let Some(m) = &s.machine {
        out.push(format!("machine {m}"));
    }
    for j in &s.jobs {
        if j.service || j.running {
            out.push(format!("{}: {}{}", j.role, if j.running { "running" } else { "set up, not running" }, j.version.as_deref().map(|v| format!(" ({v})")).unwrap_or_default()));
        }
    }
    for a in s.addresses.iter().chain(s.relays.iter()) {
        out.push(format!("answers on {a}"));
    }
    if s.phones.is_empty() {
        out.push("no phones paired yet".into());
    }
    for p in &s.phones {
        out.push(format!("phone {} ({}), paired {}, last seen {}", p.name, p.key, p.paired, p.last_seen.as_deref().unwrap_or("never")));
    }
    if let Some(nodes) = &s.nodes {
        for n in nodes {
            out.push(format!("machine on this hub: {n}"));
        }
    }
    for a in &s.agents {
        out.push(format!("agent {a}"));
    }
    if let Some(n) = &s.note {
        out.push(n.clone());
    }
    for l in &s.log {
        out.push(l.clone());
    }
    out.join("\n")
}

/// A rendered buffer as lines, trailing spaces trimmed, for the snapshot tests.
pub fn buffer_text(buf: &Buffer) -> String {
    let area = buf.area;
    let mut lines = Vec::new();
    for y in 0..area.height {
        let mut line = String::new();
        for x in 0..area.width {
            line.push_str(buf[(x, y)].symbol());
        }
        lines.push(line.trim_end().to_string());
    }
    lines.join("\n")
}

/// Shows the screen until q or Esc; r reads everything again.
pub fn run_screen(sys: &Sys, theme: Theme) -> std::io::Result<()> {
    use crossterm::event::{self, Event, KeyCode};
    let mut terminal = ratatui::init();
    let mut status = gather(sys, true);
    let result = (|| -> std::io::Result<Option<&'static str>> {
        loop {
            terminal.draw(|f| render(f, &status, theme))?;
            if event::poll(std::time::Duration::from_secs(2))? {
                if let Event::Key(k) = event::read()? {
                    match k.code {
                        KeyCode::Char('q') | KeyCode::Esc => return Ok(None),
                        KeyCode::Char('c') if k.modifiers.contains(event::KeyModifiers::CONTROL) => return Ok(None),
                        KeyCode::Char('s') => return Ok(Some("setup")),
                        KeyCode::Char('p') => return Ok(Some("pair")),
                        _ => {}
                    }
                }
            }
            status = gather(sys, true);
        }
    })();
    ratatui::restore();
    match &result {
        Ok(Some(next)) => crate::commands::run_named(next),
        // the screen ran on the terminal's second buffer, so what was there before is back;
        // what it showed stays in the scrollback as plain lines, like any command's output
        Ok(None) => println!("{}", plain(&status)),
        Err(_) => {}
    }
    result.map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agents_are_picked_out_of_the_pane_list() {
        let list = "work:0.0 zsh\nwork:1.0 claude\nops:0.0 /usr/local/bin/codex\nops:1.0 vim\n";
        assert_eq!(parse_agents(list), vec!["claude in work:1.0", "/usr/local/bin/codex in ops:0.0"]);
    }

    #[test]
    fn the_newest_log_gives_its_last_lines() {
        let dir = std::env::temp_dir().join(format!("inyon-dash-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("update.log"), "a\nb\n\nc\n").unwrap();
        assert_eq!(last_log_lines(&dir, 2), vec!["update.log: b", "update.log: c"]);
        assert!(last_log_lines(&dir.join("nope"), 2).is_empty());
        // the engine's UTC stamps are shown in local time
        fs::write(dir.join("link.log"), "2025-10-14T11:01:23.456Z tunnel: up\n").unwrap();
        assert_eq!(last_log_lines(&dir, 1), vec![format!("link.log: {}", state::local_log_line("2025-10-14T11:01:23Z tunnel: up"))]);
        assert!(!last_log_lines(&dir, 1)[0].contains('Z'));
        fs::remove_dir_all(&dir).unwrap();
    }
}
