//! What the Inyon window says, worked out from the status, the pairing and what the window's
//! own threads found out. No Win32 here: the window draws a [`View`], and so does the test
//! renderer that turns each state into an SVG.

use serde_json::Value;

use super::layout::{Id, PHONE_ROWS};
use super::{code_card, short_code, CodeCard};
use crate::service::Role;
use crate::ui::dashboard::{PairedPhone, Status};

/// How long a code works, from the engine.
pub const CODE_MS: f64 = inyon_engine::link::PAIR_MINUTES as f64 * 60_000.0;
/// How long a forgotten phone can still be had back.
pub const UNDO_MS: f64 = 5_000.0;

/// Why the code card went back to idle.
#[derive(Debug, Clone, PartialEq)]
pub enum Ended {
    /// a phone paired with it
    Used(String),
    Expired,
}

/// The pairing card's state.
#[derive(Debug, Clone, PartialEq)]
pub enum Card {
    /// no code open; what happened to the last one, if anything
    Idle(Option<Ended>),
    /// asked, no answer yet
    Asking,
    /// the tunnel is starting
    Starting,
    /// still starting after half a minute
    Slow,
    /// a code; `lan`: it works on the same network or VPN until the tunnel is up
    Code {
        lan: bool,
    },
    Failed(String),
}

/// The pairing as the window follows it.
#[derive(Debug, Clone, PartialEq)]
pub struct Pairing {
    pub card: Card,
    /// the engine's newest answer that carries a code
    pub answer: Option<Value>,
    /// when the code was asked for; it stops working CODE_MS after
    pub asked_at: f64,
    /// the phones paired when it was asked for: a new one means it was used
    pub known: Vec<String>,
    /// pairing.json was seen open since the code showed
    pub seen_open: bool,
}

impl Default for Pairing {
    fn default() -> Self {
        Pairing { card: Card::Idle(None), answer: None, asked_at: 0.0, known: Vec::new(), seen_open: false }
    }
}

impl Pairing {
    /// Whether a code is being made (the button can't start a second one).
    pub fn busy(&self) -> bool {
        matches!(self.card, Card::Asking | Card::Starting | Card::Slow)
    }

    /// A new code was asked for. False when one is already being made.
    pub fn ask(&mut self, phones: &[PairedPhone], now: f64) -> bool {
        if self.busy() {
            return false;
        }
        *self = Pairing { card: Card::Asking, answer: None, asked_at: now, known: phones.iter().map(|p| p.key.clone()).collect(), seen_open: false };
        true
    }

    /// One of the engine's answers arrived.
    pub fn answer(&mut self, v: Value) {
        // a code that has ended stays ended: a late answer from its engine doesn't bring it back
        if matches!(self.card, Card::Idle(_)) {
            return;
        }
        self.card = match code_card(&v) {
            CodeCard::Failed(e) => Card::Failed(e),
            CodeCard::Starting(t) if t == inyon_engine::output::TUNNEL_SLOW => Card::Slow,
            CodeCard::Starting(_) => Card::Starting,
            CodeCard::Code { .. } => Card::Code { lan: v.get("waiting").is_some() },
        };
        if v.get("qr").is_some() {
            self.answer = Some(v);
        }
    }

    /// Follows a fresh status: a new phone means the code was used, and a code past its ten
    /// minutes, or one the engine closed, has expired. Either way the card goes back to idle,
    /// saying which. Returns whether it changed.
    pub fn watch(&mut self, s: &Status, now: f64) -> bool {
        let open = matches!(self.card, Card::Asking | Card::Starting | Card::Slow | Card::Code { .. });
        if !open {
            return false;
        }
        if let Some(p) = s.phones.iter().find(|p| !self.known.contains(&p.key)) {
            self.end(Ended::Used(p.name.clone()));
            return true;
        }
        if matches!(self.card, Card::Code { .. }) {
            if s.pairing_open {
                self.seen_open = true;
            }
            if now >= self.asked_at + CODE_MS || (self.seen_open && !s.pairing_open) {
                self.end(Ended::Expired);
                return true;
            }
        }
        false
    }

    fn end(&mut self, why: Ended) {
        self.card = Card::Idle(Some(why));
        self.answer = None;
        self.seen_open = false;
    }
}

/// What the update check found.
#[derive(Debug, Clone, PartialEq)]
pub enum Update {
    Looking,
    Current,
    Available(String),
    Updating(String),
    Done(String),
    Failed,
}

/// The last doctor run.
#[derive(Debug, Clone, PartialEq)]
pub enum Checks {
    NotRun,
    Running,
    /// how many passed, of how many, and the names of those that need a look
    Done {
        total: usize,
        failing: Vec<String>,
    },
}

impl Checks {
    /// From `doctor`'s answer: {"checks": [{"ok", "check", "detail"}]}.
    pub fn from_doctor(v: &Value) -> Checks {
        let list = v.get("checks").and_then(Value::as_array).cloned().unwrap_or_default();
        let failing =
            list.iter().filter(|c| c.get("ok").and_then(Value::as_bool) == Some(false)).filter_map(|c| c.get("check").and_then(Value::as_str).map(String::from)).collect();
        Checks::Done { total: list.len(), failing }
    }
}

/// Setup run from the window, with no terminal: the first one, or a change of how phones reach
/// this computer.
#[derive(Debug, Clone, PartialEq)]
pub enum Setup {
    Idle,
    Running,
    Failed(String),
}

/// `doctor`'s checks that need a look, each as "Name: what it said", for Details.
pub fn check_details(v: &Value) -> Vec<String> {
    let list = v.get("checks").and_then(Value::as_array).cloned().unwrap_or_default();
    list.iter()
        .filter(|c| c.get("ok").and_then(Value::as_bool) == Some(false))
        .map(|c| {
            let name = capitalise(c.get("check").and_then(Value::as_str).unwrap_or("A check"));
            match c.get("detail").and_then(Value::as_str).filter(|d| !d.is_empty()) {
                Some(d) => format!("{name}: {d}"),
                None => name,
            }
        })
        .collect()
}

/// How setup run from the window went, from its exit and what it printed: None when it went
/// well, else the line that says why (its last "!" line, or its last line).
pub fn setup_result(ok: bool, printed: &str) -> Option<String> {
    let lines: Vec<&str> = printed.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    if ok {
        // a background service that couldn't be set up says so with "!" and still exits 0
        return lines.iter().find(|l| l.starts_with("! Couldn't set up a background service")).map(|l| l.trim_start_matches("! ").to_string());
    }
    let why = lines.iter().rev().find(|l| l.starts_with('!')).or(lines.last()).map(|l| l.trim_start_matches("! ").to_string());
    Some(why.unwrap_or_else(|| "Setup stopped without saying why. The log has more.".into()))
}

/// `--network` for setup from the reach menu's ticks; None when nothing would be left on.
pub fn network_flag(lan: bool, vpn: bool, tunnel: bool) -> Option<String> {
    let on: Vec<&str> = [(tunnel, "tunnel"), (lan, "lan"), (vpn, "vpn")].into_iter().filter(|(on, _)| *on).map(|(_, n)| n).collect();
    (!on.is_empty()).then(|| on.join(","))
}

/// What the window's own threads found, next to the status.
#[derive(Debug, Clone, PartialEq)]
pub struct Extra {
    pub hostname: String,
    /// LAN, VPN, tunnel: how phones may reach the link, from link.json
    pub reach: (bool, bool, bool),
    /// the agents on PATH
    pub agents: Vec<String>,
    pub update: Update,
    pub checks: Checks,
    /// the hub's address, on a computer that runs one
    pub hub_url: Option<String>,
    /// a phone being forgotten: its key and when the Undo runs out
    pub forgetting: Option<(String, f64)>,
    /// setup the window runs (no terminal opens for it)
    pub setup: Setup,
    /// which rows of phones show: More pages through them
    pub phone_page: usize,
    /// the checks that need a look, each with what the check said, for Details
    pub check_details: Vec<String>,
}

/// LAN, VPN and tunnel as the link takes them from link.json, with the same defaults (on Windows
/// the VPN is off until setup turns it on, since both need a firewall rule).
pub fn reach(cfg: &crate::state::LinkConfig, windows: bool) -> (bool, bool, bool) {
    (cfg.lan.unwrap_or(false), cfg.vpn.unwrap_or(!windows), cfg.tunnel.unwrap_or(true))
}

/// What a click does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    MakeCode,
    OpenSetup,
    OpenHub,
    CopyLink,
    CopyAddress,
    ShowLog,
    ShowAll,
    Forget(u8),
    Undo,
    Start,
    Stop,
    Restart,
    Update,
    Check,
    Details,
    OpenLog,
    Quit,
    Tab(u8),
    /// pick how phones reach this computer (a menu of LAN, VPN and the tunnel)
    Reach,
}

/// A button: its label, what it does, and whether it can be pressed now.
#[derive(Debug, Clone, PartialEq)]
pub struct Button {
    pub label: String,
    pub action: Action,
    pub enabled: bool,
}

fn button(label: &str, action: Action) -> Option<Button> {
    Some(Button { label: label.to_string(), action, enabled: true })
}

/// What fills the code square.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Glyph {
    /// a phone outline: nothing open
    Idle,
    /// three dots: being made
    Wait,
    /// the QR code
    Qr,
    /// a tick: used
    Done,
    /// a ring with a bar: it failed
    Error,
    /// a server: this computer runs the hub
    Hub,
}

/// The state dot in the header pill and the chips.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dot {
    /// filled ink
    On,
    /// an empty ring
    Off,
    /// the one colour: a state that needs you
    Attention,
}

#[derive(Debug, Clone, PartialEq)]
pub struct View {
    pub subtitle: String,
    pub pill: (String, Dot),
    pub card_title: String,
    pub glyph: Glyph,
    /// the QR code's text, when the glyph is the code
    pub qr: Option<String>,
    pub side: String,
    pub side_strong: bool,
    /// the typed-in ID and code
    pub code: Option<(String, String)>,
    pub note: String,
    pub reach_label: String,
    /// LAN, VPN, tunnel; None on a computer that isn't the phone link
    pub reach: Option<(bool, bool, bool)>,
    pub link_detail: String,
    pub phones_title: String,
    /// name and last seen, in the window's rows
    pub phones: Vec<(String, String)>,
    /// the four rows of This computer, and whether each needs you
    pub comp: [(String, bool); 4],
    pub log: String,
    buttons: Vec<(Id, Button)>,
}

impl View {
    /// The button in `id`'s place now, if one shows there.
    pub fn button(&self, id: Id) -> Option<&Button> {
        self.buttons.iter().find(|(i, _)| *i == id).map(|(_, b)| b)
    }

    /// The text drawn in `id`'s box, for the test renderer.
    pub fn text(&self, id: Id) -> String {
        if let Some(b) = self.button(id) {
            return b.label.clone();
        }
        match id {
            Id::Title => "Inyon".into(),
            Id::Subtitle => self.subtitle.clone(),
            Id::Pill => self.pill.0.clone(),
            Id::PairTitle => self.card_title.clone(),
            Id::Side => match &self.code {
                Some((a, b)) => format!("{} · ID {a} · Code {b}", self.side),
                None => self.side.clone(),
            },
            Id::Note => self.note.clone(),
            Id::Qr => format!("{:?}", self.glyph),
            Id::ReachLabel => self.reach_label.clone(),
            Id::Lan | Id::Vpn | Id::Tunnel => match self.reach {
                Some((l, v, t)) => {
                    let (name, on) = match id {
                        Id::Lan => ("LAN", l),
                        Id::Vpn => ("VPN", v),
                        _ => ("Tunnel", t),
                    };
                    format!("{name} {}", if on { "on" } else { "off" })
                }
                None => String::new(),
            },
            Id::LinkDetail => self.link_detail.clone(),
            Id::PhonesTitle => self.phones_title.clone(),
            Id::PhoneName(i) => self.phones.get(i as usize).map(|p| p.0.clone()).unwrap_or_default(),
            Id::PhoneSeen(i) => self.phones.get(i as usize).map(|p| p.1.clone()).unwrap_or_default(),
            Id::CompText(i) => self.comp[i as usize].0.clone(),
            Id::Log => self.log.clone(),
            _ => String::new(),
        }
    }
}

/// "22:27" today, "14 Oct" before: state.json's times are "2026-10-14 22:27".
pub fn seen_short(full: &str, today: &str) -> String {
    match full.split_once(' ') {
        Some((date, time)) if date == today => time.to_string(),
        Some((date, _)) => {
            let mut parts = date.split('-');
            let (_, m, d) = (parts.next(), parts.next().and_then(|m| m.parse::<usize>().ok()), parts.next().and_then(|d| d.parse::<u32>().ok()));
            const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
            match (m, d) {
                (Some(m @ 1..=12), Some(d)) => format!("{d} {}", MONTHS[m - 1]),
                _ => date.to_string(),
            }
        }
        None => full.to_string(),
    }
}

/// The window, worked out. `role` is the job the window was opened for; `now` and `today`
/// ("2026-10-22") come from the clock.
pub fn view(role: Role, s: &Status, p: &Pairing, x: &Extra, now: f64, today: &str) -> View {
    let mut buttons: Vec<(Id, Button)> = Vec::new();
    let job = s.jobs.iter().find(|j| j.role == role.name());
    let (service, running) = job.map(|j| (j.service, j.running)).unwrap_or((false, false));
    let set_up = s.role != "none";
    let answering = s.answering();
    let hub = role == Role::Hub;

    let subtitle = format!(
        "{} · {} · {}",
        crate::ui::VERSION,
        x.hostname,
        match role {
            Role::Link => "paired with your phone",
            Role::Node => "on your hub",
            Role::Hub => "your hub",
        }
    );
    let pill = if running && role == Role::Link && answering.is_empty() {
        ("Starting".to_string(), Dot::Off)
    } else if running {
        ("Running".to_string(), Dot::On)
    } else if service {
        ("Stopped".to_string(), Dot::Attention)
    } else {
        ("Not set up".to_string(), Dot::Off)
    };

    // the pairing card
    let code_note =
        |lan: bool| if lan { "For now this works on the same network or VPN. It changes once the tunnel is up.".to_string() } else { expiry_note(p.asked_at + CODE_MS, now) };
    let (card_title, glyph, side, side_strong, note, primary, secondary): (String, Glyph, String, bool, String, Option<Button>, Option<Button>) = if hub {
        let url = x.hub_url.clone().unwrap_or_else(|| "http://127.0.0.1:4777".into());
        let machines = s.nodes.as_ref().map(|n| n.len()).unwrap_or(0);
        (
            "Phones sign in to the hub".into(),
            Glyph::Hub,
            "This computer runs your hub. Phones pair in the hub's Settings.".into(),
            false,
            format!("{url} · {machines} machine{}", if machines == 1 { "" } else { "s" }),
            button("Open the hub", Action::OpenHub),
            button("Copy address", Action::CopyAddress),
        )
    } else if !set_up && matches!(p.card, Card::Idle(_)) {
        match &x.setup {
            Setup::Running => (
                "Pair a phone".into(),
                Glyph::Wait,
                "Setting Inyon up…".into(),
                false,
                "It gets what it needs and starts the link, with no window of its own. This takes a minute.".into(),
                Some(Button { label: "Setting up…".into(), action: Action::OpenSetup, enabled: false }),
                None,
            ),
            Setup::Failed(e) => (
                "Pair a phone".into(),
                Glyph::Error,
                "Setup didn't finish.".into(),
                true,
                e.clone(),
                button("Try again", Action::OpenSetup),
                button("Show the log", Action::ShowLog),
            ),
            Setup::Idle => (
                "Pair a phone".into(),
                Glyph::Idle,
                "Set Inyon up first.".into(),
                true,
                "Setup reaches phones through a tunnel (you can add the LAN or a VPN after), then a code shows here.".into(),
                button("Set up", Action::OpenSetup),
                None,
            ),
        }
    } else {
        let make = |label: &str| button(label, Action::MakeCode);
        let busy = Some(Button { label: "Making a code…".into(), action: Action::MakeCode, enabled: false });
        match &p.card {
            Card::Idle(None) => (
                "Pair a phone".into(),
                Glyph::Idle,
                "Scan a code with the Inyon app to add this computer.".into(),
                false,
                "A code works once, for 10 minutes.".into(),
                make("Make a code"),
                None,
            ),
            Card::Idle(Some(Ended::Used(name))) => (
                "Pair a phone".into(),
                Glyph::Done,
                format!("Paired with {name}."),
                true,
                "That code is used up. Make another one for the next phone.".into(),
                make("Make a new code"),
                None,
            ),
            Card::Idle(Some(Ended::Expired)) => (
                "Pair a phone".into(),
                Glyph::Idle,
                "That code expired.".into(),
                true,
                "Codes last 10 minutes. Make a new one when your phone is ready.".into(),
                make("Make a new code"),
                None,
            ),
            Card::Asking => ("Pair a phone".into(), Glyph::Wait, "Making a code…".into(), false, "Asking the link for a pairing code.".into(), busy, None),
            Card::Starting => (
                "Pair a phone".into(),
                Glyph::Wait,
                "Starting the tunnel…".into(),
                false,
                "So your phone can reach this computer from any network. This takes a few seconds.".into(),
                busy,
                None,
            ),
            Card::Slow => (
                "Pair a phone".into(),
                Glyph::Wait,
                "The tunnel is still starting.".into(),
                false,
                "The code shows here once it's up. The log says what the tunnel is doing.".into(),
                busy,
                button("Show the log", Action::ShowLog),
            ),
            Card::Code { lan } => (
                "Pair a phone".into(),
                Glyph::Qr,
                "Scan with the Inyon app or the phone's camera.".into(),
                false,
                code_note(*lan),
                make("Make a new code"),
                button("Copy link", Action::CopyLink),
            ),
            Card::Failed(e) => (
                "Pair a phone".into(),
                Glyph::Error,
                "Couldn't make a code.".into(),
                true,
                e.clone(),
                button("Try again", Action::MakeCode),
                button("Show the log", Action::ShowLog),
            ),
        }
    };
    let qr = (glyph == Glyph::Qr).then(|| p.answer.as_ref().and_then(|v| v.get("qr")).and_then(Value::as_str).map(String::from)).flatten();
    let code = if glyph == Glyph::Qr { p.answer.as_ref().and_then(short_code) } else { None };
    if let Some(b) = primary {
        buttons.push((Id::Primary, b));
    }
    if let Some(b) = secondary {
        buttons.push((Id::Secondary, b));
    }

    // the link card
    let (reach_label, reach, link_detail) = match role {
        Role::Link => {
            let detail = if x.setup == Setup::Running {
                "Applying the new settings…".to_string()
            } else if let Setup::Failed(e) = &x.setup {
                format!("Couldn't change it: {e}")
            } else if !answering.is_empty() {
                format!("Answers on {}", answering.iter().map(|a| crate::http::host_of(a)).collect::<Vec<_>>().join(", "))
            } else if running {
                "No address yet: the tunnel is starting".to_string()
            } else if service {
                "Stopped: phones can't reach this computer".to_string()
            } else {
                "Not set up yet".to_string()
            };
            buttons.push((Id::Change, Button { label: "Change".into(), action: Action::Reach, enabled: set_up && x.setup != Setup::Running }));
            // before setup nothing reaches it, whatever link.json's defaults would say
            ("Reach".to_string(), Some(if set_up { x.reach } else { (false, false, false) }), detail)
        }
        Role::Node => {
            let hub_host = s.hub.as_deref().map(crate::http::host_of).unwrap_or_default();
            ("Hub".to_string(), None, if running { format!("Connected to {hub_host}") } else { format!("Not connected to {hub_host}") })
        }
        Role::Hub => {
            let machines = s.nodes.as_ref().map(|n| n.join(", ")).unwrap_or_default();
            ("Hub".to_string(), None, if machines.is_empty() { "No machines have joined yet".to_string() } else { format!("Machines: {machines}") })
        }
    };

    // phones
    let shown: Vec<&PairedPhone> = s.phones.iter().filter(|ph| x.forgetting.as_ref().is_none_or(|(k, until)| *k != ph.key || now >= *until)).collect();
    let phones_title = if s.phones.is_empty() { "Phones".to_string() } else { format!("Phones · {}", shown.len()) };
    let mut phones: Vec<(String, String)> = Vec::new();
    if let Some((key, until)) = x.forgetting.as_ref().filter(|(_, until)| now < *until) {
        let name = s.phones.iter().find(|ph| ph.key == *key).map(|ph| ph.name.clone()).unwrap_or_else(|| "The phone".into());
        phones.push((name, format!("forgotten in {}s", ((until - now) / 1000.0).ceil() as i64)));
        buttons.push((Id::Forget(0), button("Undo", Action::Undo).unwrap()));
    }
    // More pages through them, a screenful at a time
    let pages = s.phones.len().div_ceil(PHONE_ROWS).max(1);
    let page = if x.forgetting.is_some() { 0 } else { x.phone_page % pages };
    for ph in shown.into_iter().skip(page * PHONE_ROWS) {
        if phones.len() >= PHONE_ROWS {
            break;
        }
        let seen = ph.last_seen.as_deref().map(|t| format!("seen {}", seen_short(t, today))).unwrap_or_else(|| "never seen".into());
        let i = phones.len() as u8;
        phones.push((ph.name.clone(), seen));
        // one phone at a time: Forget waits while another is being forgotten
        if x.forgetting.as_ref().is_none_or(|(_, until)| now >= *until) {
            let index = s.phones.iter().position(|q| q.key == ph.key).unwrap_or(0) as u8;
            buttons.push((Id::Forget(i), button("Forget", Action::Forget(index)).unwrap()));
        }
    }
    if phones.is_empty() && !hub {
        phones.push(("No phones yet. Make a code to pair one.".into(), String::new()));
    }
    if s.phones.len() > PHONE_ROWS {
        buttons.push((Id::ShowAll, button(if page + 1 < pages { "More" } else { "Back" }, Action::ShowAll).unwrap()));
    }

    // this computer
    // Set up is the phone link's setup: the hub connection and the hub are set up from their
    // own commands (a hub's Add a machine, `inyon hub`), so their windows only start and stop
    let svc = if role == Role::Link && (!set_up || (!service && !running)) {
        buttons.push((Id::SvcB, Button { label: "Set up".into(), action: Action::OpenSetup, enabled: x.setup != Setup::Running }));
        // short enough for its box beside the button
        (if set_up { "Doesn't run at sign-in" } else { "Not set up" }.to_string(), false)
    } else if running {
        buttons.push((Id::SvcA, button("Stop", Action::Stop).unwrap()));
        buttons.push((Id::SvcB, button("Restart", Action::Restart).unwrap()));
        (if service { "Runs at sign-in · running" } else { "Started by hand · running" }.to_string(), false)
    } else if set_up {
        buttons.push((Id::SvcA, button("Start", Action::Start).unwrap()));
        (if service { "Runs at sign-in · stopped" } else { "Doesn't run at sign-in" }.to_string(), true)
    } else {
        ("Not set up".to_string(), false)
    };
    let upd = match &x.update {
        Update::Looking => "Looking for updates…".to_string(),
        Update::Current => format!("Up to date · {}", crate::ui::VERSION),
        Update::Available(v) => {
            buttons.push((Id::UpdateBtn, button("Update", Action::Update).unwrap()));
            format!("{v} is out")
        }
        Update::Updating(v) => format!("Updating to {v}…"),
        Update::Done(v) => format!("Updated to {v}"),
        Update::Failed => "Couldn't look for updates".to_string(),
    };
    let checks = match &x.checks {
        Checks::NotRun => {
            buttons.push((Id::CheckBtn, button("Check", Action::Check).unwrap()));
            ("Checks haven't run".to_string(), false)
        }
        Checks::Running => ("Checking…".to_string(), false),
        Checks::Done { total, failing } if failing.is_empty() => {
            buttons.push((Id::CheckBtn, button("Check", Action::Check).unwrap()));
            (format!("Checks: all {total} pass"), false)
        }
        Checks::Done { failing, .. } => {
            buttons.push((Id::CheckBtn, button("Details", Action::Details).unwrap()));
            let more = if failing.len() > 1 { format!(" and {} more", failing.len() - 1) } else { String::new() };
            (format!("{} needs a look{more}", capitalise(&failing[0])), true)
        }
    };
    let agents = if x.agents.is_empty() { "No agents found on PATH".to_string() } else { format!("Agents: {}", x.agents.join(", ")) };
    buttons.push((Id::OpenLog, button("Open the log", Action::OpenLog).unwrap()));
    buttons.push((Id::Quit, button("Quit Inyon", Action::Quit).unwrap()));
    for t in 0..3u8 {
        buttons.push((Id::Tab(t), button(["Pair", "Phones", "This computer"][t as usize], Action::Tab(t)).unwrap()));
    }
    View {
        subtitle,
        pill,
        card_title,
        glyph,
        qr,
        side,
        side_strong,
        code,
        note,
        reach_label,
        reach,
        link_detail,
        phones_title,
        phones,
        comp: [svc, (upd, false), checks, (agents, false)],
        log: s.log.last().cloned().unwrap_or_else(|| "The log is empty so far.".into()),
        buttons,
    }
}

/// When a shown code stops working: the clock time while there's time, then a countdown in its
/// last minute, so a code about to go is read as one.
pub fn expiry_note(ends: f64, now: f64) -> String {
    let left = ((ends - now) / 1000.0).ceil() as i64;
    if left <= 60 {
        return format!("Works once, gone in {}s.", left.max(0));
    }
    let until = crate::state::format_time(ends);
    format!("Works once, until {}.", until.rsplit(' ').next().unwrap_or(&until))
}

fn capitalise(s: &str) -> String {
    let mut c = s.chars();
    c.next().map(|f| f.to_uppercase().chain(c).collect()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::super::demo::{code, extra, status};
    use super::*;
    use crate::ui::dashboard::Job;

    const T0: f64 = 1_000_000.0;

    #[test]
    fn a_code_goes_from_asking_to_the_tunnel_to_the_code() {
        let s = status();
        let mut p = Pairing::default();
        assert!(p.ask(&s.phones, T0));
        assert!(!p.ask(&s.phones, T0), "a second press while it's being made does nothing");
        p.answer(serde_json::json!({ "waiting": "tunnel", "service": true }));
        assert_eq!(p.card, Card::Starting);
        p.answer(serde_json::json!({ "waiting": "tunnel", "qr": "https://x/#pair", "urls": [], "relays": [] }));
        assert_eq!(p.card, Card::Slow);
        p.answer(code(true));
        assert_eq!(p.card, Card::Code { lan: true });
        p.answer(code(false));
        assert_eq!(p.card, Card::Code { lan: false });
        let v = view(Role::Link, &s, &p, &extra(), T0, "2026-10-22");
        assert_eq!(v.glyph, Glyph::Qr);
        assert_eq!(v.qr.as_deref(), Some("https://x/#pair?m=a"));
        assert_eq!(v.code, Some(("ZS5C-3EPG".into(), "801 356".into())));
        assert!(v.note.starts_with("Works once, until "), "{}", v.note);
        assert_eq!(v.button(Id::Primary).unwrap().label, "Make a new code");
        assert_eq!(v.button(Id::Secondary).unwrap().action, Action::CopyLink);
    }

    #[test]
    fn a_used_code_clears_to_idle_with_make_a_new_code() {
        let mut s = status();
        let mut p = Pairing::default();
        p.ask(&s.phones, T0);
        p.answer(code(false));
        s.pairing_open = true;
        assert!(!p.watch(&s, T0 + 1000.0));
        s.phones.push(PairedPhone { key: "new".into(), name: "Pixel 8".into(), paired: "x".into(), last_seen: None });
        s.pairing_open = false;
        assert!(p.watch(&s, T0 + 2000.0));
        assert_eq!(p.card, Card::Idle(Some(Ended::Used("Pixel 8".into()))));
        assert_eq!(p.answer, None, "the used code isn't drawn any more");
        let v = view(Role::Link, &s, &p, &extra(), T0, "2026-10-22");
        assert_eq!((v.glyph, v.side.as_str()), (Glyph::Done, "Paired with Pixel 8."));
        assert_eq!(v.button(Id::Primary).unwrap().label, "Make a new code");
        assert_eq!(v.button(Id::Secondary), None);
        // the engine's last answer for that code, arriving late, doesn't bring it back
        p.answer(code(false));
        assert!(matches!(p.card, Card::Idle(_)));
    }

    #[test]
    fn an_expired_code_clears_to_idle_after_ten_minutes_or_when_the_engine_closes_it() {
        let s = status();
        let mut p = Pairing::default();
        p.ask(&s.phones, T0);
        p.answer(code(false));
        assert!(!p.watch(&s, T0 + CODE_MS - 1.0));
        assert!(p.watch(&s, T0 + CODE_MS));
        assert_eq!(p.card, Card::Idle(Some(Ended::Expired)));
        let v = view(Role::Link, &s, &p, &extra(), T0, "2026-10-22");
        assert_eq!(v.side, "That code expired.");
        assert_eq!(v.button(Id::Primary).unwrap().label, "Make a new code");
        // closed early (too many wrong codes): pairing.json was open, then it's gone
        let mut s = status();
        let mut p = Pairing::default();
        p.ask(&s.phones, T0);
        p.answer(code(false));
        s.pairing_open = true;
        p.watch(&s, T0 + 1.0);
        s.pairing_open = false;
        assert!(p.watch(&s, T0 + 2.0));
        assert_eq!(p.card, Card::Idle(Some(Ended::Expired)));
    }

    #[test]
    fn a_failure_says_so_and_offers_the_log() {
        let s = status();
        let mut p = Pairing::default();
        p.ask(&s.phones, T0);
        p.answer(serde_json::json!({ "error": "The engine gave no code." }));
        let v = view(Role::Link, &s, &p, &extra(), T0, "2026-10-22");
        assert_eq!((v.glyph, v.note.as_str()), (Glyph::Error, "The engine gave no code."));
        assert_eq!(v.button(Id::Primary).unwrap().label, "Try again");
        assert_eq!(v.button(Id::Secondary).unwrap().action, Action::ShowLog);
    }

    #[test]
    fn the_link_says_where_it_answers_and_the_service_what_it_can_do() {
        let mut s = status();
        let v = view(Role::Link, &s, &Pairing::default(), &extra(), T0, "2026-10-22");
        assert_eq!(v.pill, ("Running".into(), Dot::On));
        assert_eq!(v.link_detail, "Answers on quiet-otter.trycloudflare.com");
        assert_eq!(v.reach, Some((false, false, true)));
        assert_eq!(v.comp[0].0, "Runs at sign-in · running");
        assert_eq!((v.button(Id::SvcA).unwrap().action, v.button(Id::SvcB).unwrap().action), (Action::Stop, Action::Restart));
        assert_eq!(v.phones, vec![("Nothing A142".into(), "seen 22:27".into())]);
        s.jobs[0].running = false;
        let v = view(Role::Link, &s, &Pairing::default(), &extra(), T0, "2026-10-22");
        assert_eq!(v.pill, ("Stopped".into(), Dot::Attention));
        assert_eq!(v.link_detail, "Stopped: phones can't reach this computer");
        assert_eq!(v.button(Id::SvcA).unwrap().action, Action::Start);
        assert!(v.comp[0].1);
        // running, no address yet
        let mut s = status();
        s.addresses.clear();
        assert_eq!(view(Role::Link, &s, &Pairing::default(), &extra(), T0, "2026-10-22").pill.0, "Starting");
    }

    #[test]
    fn a_hub_connection_window_never_offers_the_phone_links_setup() {
        let mut s = status();
        s.role = "joined".into();
        s.jobs = vec![Job { role: "node".into(), service: false, running: false, version: None }];
        let v = view(Role::Node, &s, &Pairing::default(), &extra(), T0, "2026-10-22");
        assert!(v.buttons.iter().all(|(_, b)| b.action != Action::OpenSetup), "{:?}", v.buttons);
        assert_eq!(v.button(Id::SvcA).unwrap().action, Action::Start);
        assert_eq!(v.comp[0].0, "Doesn't run at sign-in");
        // nothing set up at all: said, with nothing to press
        s.role = "none".into();
        let v = view(Role::Node, &s, &Pairing::default(), &extra(), T0, "2026-10-22");
        assert!(v.button(Id::SvcA).is_none() && v.button(Id::SvcB).is_none());
        assert_eq!(v.comp[0].0, "Not set up");
        // the link's window still sets itself up
        let v = view(Role::Link, &s, &Pairing::default(), &extra(), T0, "2026-10-22");
        assert_eq!(v.button(Id::SvcB).unwrap().action, Action::OpenSetup);
    }

    #[test]
    fn update_and_checks_say_what_to_do_next() {
        let s = status();
        let mut x = extra();
        x.update = Update::Available("0.20.1".into());
        x.checks =
            Checks::from_doctor(&serde_json::json!({ "checks": [{ "ok": true, "check": "agents" }, { "ok": false, "check": "firewall" }, { "ok": false, "check": "hub port" }] }));
        let v = view(Role::Link, &s, &Pairing::default(), &x, T0, "2026-10-22");
        assert_eq!(v.comp[1].0, "0.20.1 is out");
        assert_eq!(v.button(Id::UpdateBtn).unwrap().action, Action::Update);
        assert_eq!(v.comp[2], ("Firewall needs a look and 1 more".into(), true));
        assert_eq!(v.button(Id::CheckBtn).unwrap().action, Action::Details);
        assert_eq!(v.comp[3].0, "Agents: claude, codex");
    }

    #[test]
    fn forget_waits_five_seconds_with_undo_in_its_place() {
        let mut s = status();
        s.phones.push(PairedPhone { key: "p8".into(), name: "Pixel 8".into(), paired: "x".into(), last_seen: None });
        s.phones.push(PairedPhone { key: "tab".into(), name: "Galaxy Tab".into(), paired: "x".into(), last_seen: None });
        let v = view(Role::Link, &s, &Pairing::default(), &extra(), T0, "2026-10-22");
        assert_eq!(v.phones_title, "Phones · 3");
        assert_eq!(v.phones.len(), 2);
        assert_eq!(v.button(Id::ShowAll).unwrap().action, Action::ShowAll);
        assert_eq!(v.button(Id::Forget(1)).unwrap().action, Action::Forget(1));
        let mut x = extra();
        x.forgetting = Some(("abc".into(), T0 + UNDO_MS));
        let v = view(Role::Link, &s, &Pairing::default(), &x, T0 + 1000.0, "2026-10-22");
        assert_eq!(v.phones[0], ("Nothing A142".into(), "forgotten in 4s".into()));
        assert_eq!(v.button(Id::Forget(0)).unwrap().action, Action::Undo);
        assert_eq!(v.phones[1].0, "Pixel 8");
        assert_eq!(v.button(Id::Forget(1)), None, "one phone at a time");
        assert_eq!(v.phones_title, "Phones · 2");
    }

    #[test]
    fn details_setup_and_the_reach_menu_come_back_as_words() {
        let doctor = serde_json::json!({ "checks": [{ "ok": true, "check": "agents" }, { "ok": false, "check": "firewall", "detail": "no rule lets the link in" }, { "ok": false, "check": "tmux" }] });
        assert_eq!(check_details(&doctor), ["Firewall: no rule lets the link in", "Tmux"]);
        assert_eq!(setup_result(true, "✓ psmux is installed\n✓ Runs as the Inyon app."), None);
        assert_eq!(setup_result(false, "✓ psmux\n! Couldn't reach Cloudflare\nsomething else"), Some("Couldn't reach Cloudflare".into()));
        assert_eq!(setup_result(false, "plain failure"), Some("plain failure".into()));
        assert!(setup_result(false, "").is_some());
        assert_eq!(
            setup_result(true, "! Couldn't set up a background service (Task Scheduler refused). Keep this window open instead."),
            Some("Couldn't set up a background service (Task Scheduler refused). Keep this window open instead.".into())
        );
        assert_eq!(network_flag(true, false, true).as_deref(), Some("tunnel,lan"));
        assert_eq!(network_flag(false, false, false), None, "the last way in stays on");
    }

    #[test]
    fn more_pages_through_the_phones_in_the_window() {
        let mut s = status();
        for (k, n) in [("p8", "Pixel 8"), ("tab", "Galaxy Tab"), ("ip", "iPhone")] {
            s.phones.push(PairedPhone { key: k.into(), name: n.into(), paired: "x".into(), last_seen: None });
        }
        let mut x = extra();
        let names = |x: &Extra| view(Role::Link, &s, &Pairing::default(), x, T0, "2026-10-22").phones.into_iter().map(|p| p.0).collect::<Vec<_>>();
        assert_eq!(names(&x), ["Nothing A142", "Pixel 8"]);
        assert_eq!(view(Role::Link, &s, &Pairing::default(), &x, T0, "2026-10-22").button(Id::ShowAll).unwrap().label, "More");
        x.phone_page = 1;
        assert_eq!(names(&x), ["Galaxy Tab", "iPhone"]);
        let v = view(Role::Link, &s, &Pairing::default(), &x, T0, "2026-10-22");
        assert_eq!(v.button(Id::ShowAll).unwrap().label, "Back");
        // Forget on the second page forgets that phone
        assert_eq!(v.button(Id::Forget(0)).unwrap().action, Action::Forget(2));
        x.phone_page = 2;
        assert_eq!(names(&x), ["Nothing A142", "Pixel 8"], "round to the first again");
    }

    #[test]
    fn setup_runs_in_the_window_and_says_how_it_went() {
        let mut s = status();
        s.role = "none".into();
        s.jobs.clear();
        let mut x = extra();
        let v = view(Role::Link, &s, &Pairing::default(), &x, T0, "2026-10-22");
        assert_eq!((v.button(Id::Primary).unwrap().label.as_str(), v.button(Id::Primary).unwrap().action), ("Set up", Action::OpenSetup));
        x.setup = Setup::Running;
        let v = view(Role::Link, &s, &Pairing::default(), &x, T0, "2026-10-22");
        assert_eq!(v.side, "Setting Inyon up…");
        assert!(!v.button(Id::Primary).unwrap().enabled, "one setup at a time");
        assert!(!v.button(Id::SvcB).unwrap().enabled);
        x.setup = Setup::Failed("winget isn't here".into());
        let v = view(Role::Link, &s, &Pairing::default(), &x, T0, "2026-10-22");
        assert_eq!((v.glyph, v.note.as_str(), v.button(Id::Primary).unwrap().label.as_str()), (Glyph::Error, "winget isn't here", "Try again"));
        // set up: Change opens the reach menu, not a terminal
        let v = view(Role::Link, &status(), &Pairing::default(), &extra(), T0, "2026-10-22");
        assert_eq!(v.button(Id::Change).unwrap().action, Action::Reach);
    }

    #[test]
    fn a_code_in_its_last_minute_counts_down() {
        let ends = T0 + CODE_MS;
        assert!(expiry_note(ends, T0).starts_with("Works once, until "), "{}", expiry_note(ends, T0));
        assert_eq!(expiry_note(ends, ends - 60_000.0), "Works once, gone in 60s.");
        assert_eq!(expiry_note(ends, ends - 41_500.0), "Works once, gone in 42s.");
        assert_eq!(expiry_note(ends, ends + 3_000.0), "Works once, gone in 0s.");
        // the card shows it as the clock runs
        let s = status();
        let mut p = Pairing::default();
        p.ask(&s.phones, T0);
        p.answer(code(false));
        assert_eq!(view(Role::Link, &s, &p, &extra(), ends - 9_000.0, "2026-10-22").note, "Works once, gone in 9s.");
    }

    #[test]
    fn last_seen_is_short() {
        assert_eq!(seen_short("2026-10-22 22:27", "2026-10-22"), "22:27");
        assert_eq!(seen_short("2026-10-14 09:01", "2026-10-22"), "14 Oct");
        assert_eq!(seen_short("22:27", "2026-10-22"), "22:27");
    }

    #[test]
    fn before_setup_the_card_points_to_it_and_a_hub_points_to_its_settings() {
        let mut s = status();
        s.role = "none".into();
        s.jobs[0] = Job { role: "link".into(), service: false, running: false, version: None };
        let v = view(Role::Link, &s, &Pairing::default(), &extra(), T0, "2026-10-22");
        assert_eq!((v.side.as_str(), v.button(Id::Primary).unwrap().action), ("Set Inyon up first.", Action::OpenSetup));
        assert_eq!(v.pill.0, "Not set up");
        assert_eq!(v.reach, Some((false, false, false)), "nothing reaches it before setup");
        assert_eq!(v.comp[0].0, "Not set up");
        let mut s = status();
        s.role = "hub".into();
        s.jobs = vec![Job { role: "hub".into(), service: true, running: true, version: None }];
        s.nodes = Some(vec!["abhash-arm".into(), "laptop".into()]);
        let mut x = extra();
        x.hub_url = Some("http://127.0.0.1:4777".into());
        let v = view(Role::Hub, &s, &Pairing::default(), &x, T0, "2026-10-22");
        assert_eq!((v.glyph, v.note.as_str()), (Glyph::Hub, "http://127.0.0.1:4777 · 2 machines"));
        assert_eq!(v.button(Id::Primary).unwrap().action, Action::OpenHub);
        assert_eq!(v.reach, None);
    }

    #[test]
    fn reach_follows_link_json_with_the_windows_defaults() {
        let cfg = crate::state::LinkConfig::default();
        assert_eq!(reach(&cfg, true), (false, false, true));
        assert_eq!(reach(&cfg, false), (false, true, true));
        let cfg = crate::state::LinkConfig { lan: Some(true), tunnel: Some(false), ..Default::default() };
        assert_eq!(reach(&cfg, true), (true, false, false));
    }
}
