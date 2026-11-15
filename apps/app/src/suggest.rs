//! The lists that open over the message box while you type (Composer.tsx's suggestions): `/` at
//! the start for the agent's commands and skills, `$` for Codex's skills, and `@` for a file or
//! folder in the session's folder. Also which commands, typed bare, open one of the app's own
//! pickers instead of the agent's menu in its terminal.

use inyon_protocol::{AgentKind, CommandSource, SlashCommand};

/// At most this many rows in a list.
const MAX: usize = 40;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PopKind {
    /// `/command`, only at the very start of the message
    Slash,
    /// `$skill` (Codex)
    Skill,
    /// `@path`
    Mention,
}

/// The token being typed: what kind, what's typed after its sign, and where it sits in the text
/// (byte offsets, the sign included).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pop {
    pub kind: PopKind,
    pub query: String,
    pub start: usize,
    pub end: usize,
}

/// The characters a command or skill name is made of (`[\w:.-]`).
fn name_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '_' | ':' | '.' | '-')
}

/// Finds a `/command` (at the start), a Codex `$skill` or an `@path` token ending at `cursor`, a
/// byte offset into `text`.
pub fn token_at(text: &str, cursor: usize, skills: bool) -> Option<Pop> {
    let before = text.get(..cursor)?;
    if let Some(q) = before.strip_prefix('/') {
        if q.chars().all(name_char) {
            return Some(Pop { kind: PopKind::Slash, query: q.into(), start: 0, end: cursor });
        }
    }
    // the sign starts the text or follows a space
    let after_space = |at: usize| before[..at].chars().next_back().is_none_or(char::is_whitespace);
    if skills {
        if let Some(at) = before.rfind('$') {
            let q = &before[at + 1..];
            if after_space(at) && q.chars().all(name_char) {
                return Some(Pop { kind: PopKind::Skill, query: q.into(), start: at, end: cursor });
            }
        }
    }
    let at = before.rfind('@')?;
    let q = &before[at + 1..];
    (after_space(at) && !q.chars().any(char::is_whitespace)).then(|| Pop { kind: PopKind::Mention, query: q.into(), start: at, end: cursor })
}

/// How well `query` matches `target`, higher is better, None for no match: a run of the query
/// inside it scores best (more so in its last part, after the last `/`), then its letters in order.
pub fn fuzzy(query: &str, target: &str) -> Option<f64> {
    if query.is_empty() {
        return Some(0.0);
    }
    let q: Vec<char> = query.to_lowercase().chars().collect();
    let t: Vec<char> = target.to_lowercase().chars().collect();
    if let Some(at) = t.windows(q.len()).position(|w| w == q.as_slice()) {
        let last_part = t.iter().rposition(|c| *c == '/').is_none_or(|s| s < at);
        return Some(1000.0 - at as f64 - (t.len() - q.len()) as f64 * 0.1 + if last_part { 200.0 } else { 0.0 });
    }
    let (mut ti, mut score, mut streak) = (0usize, 0.0, 0.0);
    for ch in q {
        let found = ti + t.get(ti..)?.iter().position(|c| *c == ch)?;
        streak = if found == ti { streak + 1.0 } else { 0.0 };
        score += 10.0 + streak * 5.0 - (found - ti) as f64 * 0.5;
        ti = found + 1;
    }
    Some(score)
}

/// One row of a list.
#[derive(Debug, Clone, PartialEq)]
pub struct Suggestion {
    /// what's shown, and what's put in: `/name`, `$name`, or a path (a folder's ends in `/`)
    pub label: String,
    pub hint: Option<String>,
    /// where a command comes from, when it isn't the agent's own
    pub tag: Option<&'static str>,
    /// a command that runs as soon as it's picked
    pub instant: bool,
}

impl Suggestion {
    pub fn folder(&self) -> bool {
        self.label.ends_with('/')
    }
}

fn source(s: CommandSource) -> Option<&'static str> {
    match s {
        CommandSource::BuiltIn => None,
        CommandSource::Skill => Some("skill"),
        CommandSource::Project => Some("project"),
        CommandSource::User => Some("user"),
        CommandSource::Plugin => Some("plugin"),
    }
}

/// The commands (`/`) or skills (`$`) that match `query`, best first.
pub fn commands(kind: PopKind, query: &str, list: &[SlashCommand]) -> Vec<Suggestion> {
    let sign = if kind == PopKind::Skill { '$' } else { '/' };
    let mut scored: Vec<(f64, &SlashCommand)> = list.iter().filter(|c| c.name.starts_with(sign)).filter_map(|c| Some((fuzzy(query, &c.name[1..])?, c))).collect();
    scored.sort_by(|a, b| b.0.total_cmp(&a.0).then_with(|| a.1.name.cmp(&b.1.name)));
    scored
        .into_iter()
        .take(MAX)
        .map(|(_, c)| Suggestion {
            label: c.name.clone(),
            hint: (!c.description.is_empty()).then(|| c.description.clone()),
            tag: source(c.source),
            instant: c.instant == Some(true),
        })
        .collect()
}

/// The files, and the folders they're in, that match `query`, best first and shorter first.
pub fn paths(query: &str, files: &[String]) -> Vec<Suggestion> {
    let mut pool: Vec<String> = files.to_vec();
    let mut dirs = std::collections::BTreeSet::new();
    for f in files {
        let parts: Vec<&str> = f.split('/').collect();
        for i in 1..parts.len() {
            dirs.insert(format!("{}/", parts[..i].join("/")));
        }
    }
    pool.extend(dirs);
    let mut scored: Vec<(f64, String)> = pool.into_iter().filter_map(|p| Some((fuzzy(query, &p)?, p))).collect();
    scored.sort_by(|a, b| b.0.total_cmp(&a.0).then_with(|| a.1.len().cmp(&b.1.len())));
    scored.into_iter().take(MAX).map(|(_, p)| Suggestion { label: p, hint: None, tag: None, instant: false }).collect()
}

/// What the list's top line says.
pub fn heading(kind: PopKind, agent: Option<AgentKind>, have_paths: bool) -> &'static str {
    match kind {
        PopKind::Slash if agent == Some(AgentKind::Codex) => "Commands",
        PopKind::Slash => "Commands and skills",
        PopKind::Skill => "Skills",
        PopKind::Mention if have_paths => "Files in this folder",
        PopKind::Mention => "Files in …",
    }
}

/// The app's own picker for a command typed bare.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Picker {
    Model,
    Effort,
    /// OpenCode's agents
    Mode,
    /// OpenCode's providers sheet
    Providers,
    /// Past conversations (the agent's resume command)
    Conversations,
}

/// The picker that `command`, typed with nothing after it, opens instead of the agent's own menu
/// in its terminal.
pub fn picker_for(command: &str, agent: Option<AgentKind>) -> Option<Picker> {
    let c = command.trim().to_lowercase();
    let menu = match c.as_str() {
        "/model" | "/models" => Some(Picker::Model),
        "/effort" | "/variants" => Some(Picker::Effort),
        "/agents" | "/agent" => Some(Picker::Mode),
        "/connect" => Some(Picker::Providers),
        _ => None,
    };
    if let Some(m) = menu {
        let opencode_only = matches!(m, Picker::Mode | Picker::Providers);
        return (!opencode_only || agent == Some(AgentKind::Opencode)).then_some(m);
    }
    crate::ui::conversations::asks_for(&c, agent).then_some(Picker::Conversations)
}

/// The message box after picking `s` from the list open at `pop`, and where the cursor goes.
pub fn insert(text: &str, pop: &Pop, s: &Suggestion) -> (String, usize) {
    let rest = &text[pop.end..];
    match pop.kind {
        PopKind::Slash => {
            let next = format!("{} {}", s.label, rest.trim_start());
            (next, s.label.len() + 1)
        }
        PopKind::Skill | PopKind::Mention => {
            let sign = if pop.kind == PopKind::Mention { "@" } else { "" };
            // a folder keeps the list open inside it
            let space = if s.folder() && pop.kind == PopKind::Mention { "" } else { " " };
            let ins = format!("{sign}{}{space}", s.label);
            (format!("{}{ins}{rest}", &text[..pop.start]), pop.start + ins.len())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cmd(name: &str, source: CommandSource) -> SlashCommand {
        SlashCommand { name: name.into(), description: format!("about {name}"), source, instant: None }
    }

    #[test]
    fn the_token_under_the_cursor() {
        assert_eq!(token_at("/mo", 3, false), Some(Pop { kind: PopKind::Slash, query: "mo".into(), start: 0, end: 3 }));
        // a slash only counts at the start, and only up to a space
        assert_eq!(token_at("fix /mo", 7, false), None);
        assert_eq!(token_at("/model opus", 11, false), None);
        assert_eq!(token_at("/model opus", 6, false).map(|p| p.query), Some("model".into()));
        assert_eq!(token_at("look at @src/ma", 15, false), Some(Pop { kind: PopKind::Mention, query: "src/ma".into(), start: 8, end: 15 }));
        assert_eq!(token_at("@", 1, false).map(|p| p.kind), Some(PopKind::Mention));
        // an address isn't a mention
        assert_eq!(token_at("mail sam@example", 16, false), None);
        // $ only for Codex
        assert_eq!(token_at("use $rev", 8, false), None);
        assert_eq!(token_at("use $rev", 8, true), Some(Pop { kind: PopKind::Skill, query: "rev".into(), start: 4, end: 8 }));
        assert_eq!(token_at("costs 5$", 8, true), None);
        // the cursor in the middle of the text: only what's before it counts
        assert_eq!(token_at("see @a then", 6, false).map(|p| p.query), Some("a".into()));
        // a cursor that isn't on a character boundary finds nothing rather than panicking
        assert_eq!(token_at("é", 1, false), None);
    }

    #[test]
    fn a_run_of_letters_beats_scattered_ones() {
        assert!(fuzzy("mod", "model").unwrap() > fuzzy("mdl", "model").unwrap());
        assert_eq!(fuzzy("xyz", "model"), None);
        assert_eq!(fuzzy("", "anything"), Some(0.0));
        // in the file's own name rather than a folder above it
        assert!(fuzzy("cart", "src/cart.ts").unwrap() > fuzzy("cart", "cart/index.ts").unwrap());
        assert!(fuzzy("MOD", "model").is_some());
    }

    #[test]
    fn commands_match_best_first_with_where_they_come_from() {
        let list = [cmd("/compact", CommandSource::BuiltIn), cmd("/model", CommandSource::BuiltIn), cmd("/review", CommandSource::Skill), cmd("$deploy", CommandSource::Skill)];
        let s = commands(PopKind::Slash, "mo", &list);
        assert_eq!(s.first().map(|s| s.label.as_str()), Some("/model"));
        assert!(s.iter().all(|s| s.label.starts_with('/')));
        let all = commands(PopKind::Slash, "", &list);
        // nothing typed: every command, by name
        assert_eq!(all.iter().map(|s| s.label.as_str()).collect::<Vec<_>>(), ["/compact", "/model", "/review"]);
        assert_eq!(all[2].tag, Some("skill"));
        assert_eq!(all[0].tag, None);
        assert_eq!(all[0].hint.as_deref(), Some("about /compact"));
        let skills = commands(PopKind::Skill, "", &list);
        assert_eq!(skills.iter().map(|s| s.label.as_str()).collect::<Vec<_>>(), ["$deploy"]);
    }

    #[test]
    fn paths_bring_their_folders() {
        let files = ["src/cart.ts".to_string(), "src/checkout/total.ts".to_string(), "README.md".to_string()];
        let s = paths("", &files);
        for want in ["src/", "src/checkout/", "README.md"] {
            assert!(s.iter().any(|x| x.label == want), "{want} in {s:?}");
        }
        let t = paths("total", &files);
        assert_eq!(t.first().map(|s| s.label.as_str()), Some("src/checkout/total.ts"));
        assert!(paths("src/", &files).iter().any(|s| s.folder()));
    }

    #[test]
    fn picking_puts_the_name_in() {
        let slash = token_at("/mo", 3, false).unwrap();
        let model = Suggestion { label: "/model".into(), hint: None, tag: None, instant: false };
        assert_eq!(insert("/mo", &slash, &model), ("/model ".into(), 7));
        // what came after the cursor stays
        let mid = token_at("/mo opus", 3, false).unwrap();
        assert_eq!(insert("/mo opus", &mid, &model), ("/model opus".into(), 7));

        let at = token_at("look at @ca now", 11, false).unwrap();
        let file = Suggestion { label: "src/cart.ts".into(), hint: None, tag: None, instant: false };
        assert_eq!(insert("look at @ca now", &at, &file), ("look at @src/cart.ts  now".into(), 21));
        let folder = Suggestion { label: "src/".into(), hint: None, tag: None, instant: false };
        let (t, c) = insert("look at @s", &token_at("look at @s", 10, false).unwrap(), &folder);
        assert_eq!((t.as_str(), c), ("look at @src/", 13));
        // and the list stays open inside it
        assert_eq!(token_at(&t, c, false).map(|p| p.query), Some("src/".into()));

        let sk = token_at("use $re", 7, true).unwrap();
        let skill = Suggestion { label: "$review".into(), hint: None, tag: None, instant: false };
        assert_eq!(insert("use $re", &sk, &skill), ("use $review ".into(), 12));
    }

    #[test]
    fn bare_commands_open_the_apps_pickers() {
        let claude = Some(AgentKind::Claude);
        let opencode = Some(AgentKind::Opencode);
        assert_eq!(picker_for("/model", claude), Some(Picker::Model));
        assert_eq!(picker_for(" /Models ", claude), Some(Picker::Model));
        assert_eq!(picker_for("/effort", claude), Some(Picker::Effort));
        assert_eq!(picker_for("/model opus", claude), None);
        // OpenCode's agents and providers have sheets only for OpenCode
        assert_eq!(picker_for("/agents", claude), None);
        assert_eq!(picker_for("/agents", opencode), Some(Picker::Mode));
        assert_eq!(picker_for("/connect", opencode), Some(Picker::Providers));
        assert_eq!(picker_for("/connect", claude), None);
        assert_eq!(picker_for("/resume", claude), Some(Picker::Conversations));
        assert_eq!(picker_for("/resume", None), None);
        assert_eq!(picker_for("/compact", claude), None);
    }

    #[test]
    fn headings() {
        assert_eq!(heading(PopKind::Slash, Some(AgentKind::Codex), false), "Commands");
        assert_eq!(heading(PopKind::Slash, Some(AgentKind::Claude), false), "Commands and skills");
        assert_eq!(heading(PopKind::Mention, None, true), "Files in this folder");
    }
}
