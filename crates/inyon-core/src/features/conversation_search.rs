//! Searching saved conversations for some words, on every machine (from 0.28): "the session where
//! we fixed auth", without knowing which folder it ran in.
//!
//! Each machine searches its own transcripts through `host.exec`, the same way the per-folder list
//! (conversations.rs) reads them: ripgrep when the machine has it, else `grep -F -i -l`, both under
//! a time limit and over the agents' own folders only (Claude Code's ~/.claude/projects, Codex's
//! sessions, Copilot's session-state), plus a query on OpenCode's database. The words are plain
//! text everywhere: one single-quoted shell argument, given to grep and ripgrep as a fixed string
//! after `-e`, to awk through the environment, and to SQLite as a quoted literal. Only the newest
//! matching files are read further, and only their first lines, last titles and one stretch
//! around the first match.

use futures_util::future::{join, join_all, select, Either};
use indexmap::IndexMap;
use inyon_protocol::{AgentKind, ConversationHit, ConversationSearch, ConversationSearchMachine, HostStatus};
use serde_json::Value;

use super::conversations::{claude_prompt, field, json_string_at, one_line, yaml_scalar};
use crate::agents::opencode_db::{json_rows, ocdb_query_command, ocdb_query_rows};
use crate::claude::actions::is_session_id_str;
use crate::hosts::host::{shq, ExecOptions, Host};
use crate::hosts::http_error::{http, HubResult};
use crate::hosts::names::session_name;
use crate::hosts::registry::registry;
use crate::platform::rt::sleep;
use crate::re;

/// Fewer characters than this would match nearly every transcript.
pub const MIN_QUERY: usize = 3;
/// Longer queries are cut to this many characters.
pub const MAX_QUERY: usize = 200;
/// The most conversations one machine answers with.
pub const PER_MACHINE: usize = 25;
/// The most matching files listed before the newest are picked.
const FILES_MAX: usize = 2000;
/// How long grep or ripgrep may look, in seconds, where the machine has `timeout`.
const GREP_SECONDS: u64 = 12;
/// How long one machine's commands may take.
const EXEC_MS: u64 = 25_000;
/// How long the hub waits for a machine before it says it took too long.
pub const MACHINE_MS: u64 = 30_000;
/// Bytes kept either side of the first match in a transcript line.
const WINDOW: usize = 200;
/// Characters of the snippet before and after the match.
const BEFORE: usize = 60;
const AFTER: usize = 140;

const UUID: &str = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/// The words as they are searched for: control characters (a newline, a NUL) become spaces,
/// runs of spaces one space, and the ends are trimmed. Too short is refused.
pub fn clean_query(q: &str) -> HubResult<String> {
    let plain: String = q.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    let words = re!(r"\s+").replace_all(plain.trim(), " ");
    let words: String = words.chars().take(MAX_QUERY).collect();
    let words = words.trim().to_owned();
    if words.chars().count() < MIN_QUERY {
        return Err(http(400, format!("Type at least {MIN_QUERY} characters to search conversations")));
    }
    Ok(words)
}

/// Which program lists the matching files: whatever the machine has, or one of them (tests).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Finder {
    Auto,
    Ripgrep,
    Grep,
}

/// Prints the stretch around the first match in a line, WINDOW bytes either side: in a user's or
/// the agent's message when one of the first matching lines has it there (every Claude line also
/// names its folder, which a folder's name would match first), else in the first matching line.
/// The words come in as ENVIRON["Q"]: `-v` would read backslashes in them as escapes. No single
/// quote in here: it goes in '…'.
const AWK: &str = r#"BEGIN { q = tolower(ENVIRON["Q"]); n = length(q) }
{ l = tolower($0); i = index(l, q); if (!i) next
  j = index($0, "\"message\":"); if (!j) j = index($0, "\"content\":"); if (!j) j = index($0, "\"text\":")
  m = 0
  if (j) { k = index(substr(l, j), q); if (k) { i = j + k - 1; m = 1 } }
  b = i > @W@ ? @W@ : i - 1
  s = substr($0, i - b, b + n + @W@)
  if (f == "") f = s
  if (m && $0 ~ /"(type|role)":"(user|assistant)"|"type":"(user|assistant)[.]message"|"type":"(user|agent)_message"/ && $0 !~ /"tool_result"|"function_call_output"|"tool_use_id"/) { print s; d = 1; exit } }
END { if (!d && f != "") print f }"#;

const RG: &str = r#"printf '\036@@TOOL\trg\n'
l=$($T rg --no-config --no-messages --hidden --no-ignore --path-separator / -F -i -l -g '*.jsonl' -e "$q" -- "$@" 2>/dev/null | head -n @FILES@)"#;

const GREP: &str = r#"printf '\036@@TOOL\tgrep\n'
l=$($T grep -r -F -i -l -s -e "$q" -- "$@" 2>/dev/null | grep '\.jsonl$' | head -n @FILES@)"#;

/// Lists the newest transcripts that hold the words, at most PER_MACHINE, each as
/// `\x1e<agent>\t<mtime>\t<path>` and then its sections: `@@S` the stretch around the match,
/// `@@C` the folder, `@@T` Claude's titles, `@@U` the first prompt (and Copilot's workspace).
/// Codex's thread names follow as `@@INDEX`; `@@MORE` says more files matched.
const SCRIPT: &str = r#"q=@QUERY@
c="$HOME/.claude/projects"; r="${CODEX_HOME:-$HOME/.codex}"; x="$r/sessions"; p="$HOME/.copilot/session-state"
set --
for d in "$c" "$x" "$p"; do [ -d "$d" ] && set -- "$@" "$d"; done
[ $# -gt 0 ] || exit 0
T=; command -v timeout >/dev/null 2>&1 && T="timeout @SECONDS@"
@FIND@
[ -n "$l" ] || exit 0
if stat -c %Y / >/dev/null 2>&1; then S=-c F='%Y %n'; else S=-f F='%m %N'; fi
printf '%s\n' "$l" | tr '\n' '\000' | xargs -0 stat "$S" "$F" 2>/dev/null | sort -rn | {
n=0; k=
while IFS= read -r e; do
  t=${e%% *}; f=${e#* }
  case $f in
  "$c"/*/*/*) continue ;;
  "$c"/*) a=claude ;;
  "$x"/*)
    a=codex; h=$(head -c 4000 "$f" 2>/dev/null | head -n 1)
    case $h in *'"source":"cli"'* | *'"source":"vscode"'*) ;; *'"source":'*) continue ;; esac ;;
  "$p"/*/events.jsonl) a=copilot ;;
  *) continue ;;
  esac
  [ $n -ge @LIMIT@ ] && { printf '\036@@MORE\n'; break; }
  n=$((n+1))
  printf '\036%s\t%s\t%s\n' "$a" "$t" "$f"
  echo '@@S'; grep -F -i -m 40 -e "$q" -- "$f" 2>/dev/null | Q="$q" awk '@AWK@'
  case $a in
  claude)
    echo '@@C'; head -c 65536 "$f" 2>/dev/null | grep -m 1 -o '"cwd":"[^"]*"'
    echo '@@T'; tail -c 262144 "$f" 2>/dev/null | grep -E '"type":"(custom-title|ai-title)"' | tail -n 2 | cut -c1-600
    echo '@@U'; head -c 131072 "$f" 2>/dev/null | grep -F '"type":"user"' | head -n 6 | cut -c1-2400 ;;
  codex)
    k=1
    echo '@@C'; printf '%s\n' "$h" | grep -m 1 -o '"cwd":"[^"]*"'
    echo '@@U'; head -c 262144 "$f" 2>/dev/null | grep -F '"role":"user"' | grep -v -E '"text":"[[:space:]]*<(environment_context|user_instructions|user_shell_command|codex_internal_context)' | head -n 1 | cut -c1-2400 ;;
  copilot)
    d=${f%/events.jsonl}
    echo '@@U'
    if [ -f "$d/workspace.yaml" ]; then grep -E '^(cwd|name):' "$d/workspace.yaml" | cut -c1-1200; else head -c 4000 "$f" 2>/dev/null | head -n 1; fi
    grep -qs '^name:' "$d/workspace.yaml" || head -c 131072 "$f" 2>/dev/null | grep -F '"type":"user.message"' | head -n 1 | cut -c1-2400 ;;
  esac
done
if [ -n "$k" ]; then printf '\036@@INDEX\n'; tail -n 2000 "$r/session_index.jsonl" 2>/dev/null | cut -c1-600; fi
}"#;

/// The command that searches one machine's transcript files for `q` (already cleaned).
pub fn search_script(q: &str, finder: Finder) -> String {
    let find = match finder {
        Finder::Ripgrep => RG.to_owned(),
        Finder::Grep => GREP.to_owned(),
        Finder::Auto => format!("if command -v rg >/dev/null 2>&1; then\n{RG}\nelse\n{GREP}\nfi"),
    };
    SCRIPT
        .replace("@FIND@", &find)
        .replace("@AWK@", &AWK.replace("@W@", &WINDOW.to_string()))
        .replace("@FILES@", &FILES_MAX.to_string())
        .replace("@SECONDS@", &GREP_SECONDS.to_string())
        .replace("@LIMIT@", &PER_MACHINE.to_string())
        // last, so nothing in the words is read as a placeholder
        .replace("@QUERY@", &shq(q))
}

/// A string as SQLite reads it literally.
fn sql_text(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// OpenCode keeps its conversations in SQLite: top-level, unarchived sessions whose title or any
/// part holds the words, newest first, with a stretch of the first such part. SQLite's lower()
/// only folds ASCII, so the words are folded the same way.
pub fn opencode_search_sql(q: &str, limit: usize) -> String {
    let w = sql_text(&q.to_ascii_lowercase());
    json_rows(
        &["id", "title", "directory", "t", "snip"],
        &format!(
            "select s.id as id, s.title as title, s.directory as directory, s.time_updated as t, \
             (select substr(p.data, max(1, instr(lower(p.data), {w}) - {WINDOW}), {} + length({w})) from part p where p.session_id = s.id and instr(lower(p.data), {w}) > 0 limit 1) as snip \
             from session s where s.parent_id is null and s.time_archived is null \
             and (instr(lower(s.title), {w}) > 0 or exists (select 1 from part p where p.session_id = s.id and instr(lower(p.data), {w}) > 0)) \
             order by s.time_updated desc limit {limit}",
            2 * WINDOW
        ),
    )
}

/// Where `needle` first appears in `hay`, ignoring ASCII case (as `grep -i` does in the C locale).
fn find_ci(hay: &str, needle: &str) -> Option<usize> {
    let (h, n) = (hay.as_bytes(), needle.as_bytes());
    if n.is_empty() || n.len() > h.len() {
        return None;
    }
    (0..=h.len() - n.len()).find(|&i| hay.is_char_boundary(i) && h[i..i + n.len()].eq_ignore_ascii_case(n))
}

/// Whether the quote at `i` is escaped (an odd run of backslashes before it).
fn escaped(b: &[u8], i: usize) -> bool {
    b[..i].iter().rev().take_while(|c| **c == b'\\').count() % 2 == 1
}

/// Plain text around the first place `q` appears in `raw`, a stretch of one line of JSON: the
/// string value the match is in, unescaped, on one line, with … where it goes on.
pub fn snippet_of(raw: &str, q: &str) -> String {
    // a cut through a character on the machine
    let raw = raw.trim_matches('\u{fffd}');
    let b = raw.as_bytes();
    let (text, mut open_start, mut open_end) = match find_ci(raw, q) {
        Some(m) => {
            let start = (0..m).rev().find(|&i| b[i] == b'"' && !escaped(b, i));
            let from = start.map_or(0, |s| s + 1);
            let closed = (m + q.len()..b.len()).any(|i| b[i] == b'"' && !escaped(b, i));
            (json_string_at(raw, from), start.is_none(), !closed)
        }
        None => (raw.to_owned(), true, true),
    };
    let text = re!(r"\s+").replace_all(&text, " ").trim().to_owned();
    let chars: Vec<char> = text.chars().collect();
    // where the match is, in characters
    let at = find_ci(&text, q).map(|m| text[..m].chars().count());
    let (from, to) = match at {
        Some(a) => {
            let len = q.chars().count();
            let mut from = a.saturating_sub(BEFORE);
            // start on a word
            if from > 0 {
                if let Some(sp) = chars[from..a].iter().position(|c| *c == ' ') {
                    from += sp + 1;
                }
            }
            (from, (a + len + AFTER).min(chars.len()))
        }
        None => (0, chars.len().min(BEFORE + AFTER)),
    };
    open_start |= from > 0;
    open_end |= to < chars.len();
    let body: String = chars[from..to].iter().collect();
    let body = body.trim();
    format!("{}{body}{}", if open_start { "…" } else { "" }, if open_end { "…" } else { "" })
}

/// One file's lines, by section.
#[derive(Default)]
struct Sections<'a> {
    snippet: Option<&'a str>,
    cwd: Option<&'a str>,
    titles: Vec<&'a str>,
    users: Vec<&'a str>,
}

fn sections(lines: std::str::Split<'_, char>) -> Sections<'_> {
    let mut s = Sections::default();
    let mut at = "";
    for l in lines {
        match l {
            "@@S" | "@@C" | "@@T" | "@@U" => at = l,
            "" => {}
            _ => match at {
                "@@S" if s.snippet.is_none() => s.snippet = Some(l),
                "@@C" if s.cwd.is_none() => s.cwd = Some(l),
                "@@T" => s.titles.push(l),
                "@@U" => s.users.push(l),
                _ => {}
            },
        }
    }
    s
}

fn ms_of(t: &str) -> u64 {
    t.trim().parse::<u64>().map_or(0, |s| s * 1000)
}

/// What one machine's search printed: (conversations, whether more matched).
pub fn parse_search(stdout: &str, q: &str) -> (Vec<ConversationHit>, bool) {
    let blocks: Vec<&str> = stdout.split('\u{1e}').skip(1).collect();
    let mut names: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    if let Some(index) = blocks.iter().find(|b| b.starts_with("@@INDEX")) {
        for l in index.split('\n') {
            let Some(e) = crate::js::json::parse(l) else { continue };
            if let (Some(id), Some(name)) = (e.get("id").and_then(Value::as_str), e.get("thread_name").and_then(Value::as_str)) {
                if !id.is_empty() && !name.is_empty() {
                    names.insert(id.to_owned(), name.to_owned());
                }
            }
        }
    }
    let more = blocks.iter().any(|b| b.starts_with("@@MORE"));
    let codex_file = crate::js::re::dynamic(&format!("-({UUID})(_{UUID})?\\.jsonl$"), "");
    let mut hits: IndexMap<(AgentKind, String), ConversationHit> = IndexMap::new();
    for block in &blocks {
        if block.starts_with("@@") {
            continue;
        }
        let mut lines = block.split('\n');
        let mut head = lines.next().unwrap_or("").splitn(3, '\t');
        let (Some(agent), Some(t), Some(path)) = (head.next(), head.next(), head.next()) else { continue };
        let s = sections(lines);
        let name = path.rsplit(['/', '\\']).next().unwrap_or("");
        let cwd_of = |l: &str| field(l, "cwd").filter(|c| !c.is_empty());
        let (kind, id, cwd, title) = match agent {
            "claude" => {
                let id = name.strip_suffix(".jsonl").unwrap_or("").to_owned();
                let custom = s.titles.iter().rev().find(|l| l.starts_with(r#"{"type":"custom-title""#)).and_then(|l| field(l, "customTitle"));
                let ai = s.titles.iter().rev().find(|l| l.starts_with(r#"{"type":"ai-title""#)).and_then(|l| field(l, "aiTitle"));
                let prompt = s.users.iter().find_map(|l| claude_prompt(l));
                let title = [custom, ai].into_iter().flatten().map(|t| one_line(&t)).find(|t| !t.is_empty()).or(prompt);
                let cwd = s.cwd.and_then(cwd_of).or_else(|| s.users.iter().find_map(|l| cwd_of(l)));
                (AgentKind::Claude, id, cwd, title)
            }
            "codex" => {
                let Some(m) = codex_file.captures(name) else { continue };
                let id = m[1].to_owned();
                let prompt = s.users.first().and_then(|l| field(l, "text")).map(|t| one_line(&t)).filter(|t| !t.is_empty());
                let named = names.get(&id).map(|n| one_line(n)).filter(|t| !t.is_empty());
                // a segment starts partway through: the thread's first file has the prompt it began with
                if named.is_none() {
                    let segment = m.get(2).is_some();
                    if let (Some(was), Some(p), false) = (hits.get_mut(&(AgentKind::Codex, id.clone())), &prompt, segment) {
                        was.title = p.clone();
                        continue;
                    }
                }
                (AgentKind::Codex, id, s.cwd.and_then(cwd_of), named.or(prompt))
            }
            "copilot" => {
                let dir = path.strip_suffix("/events.jsonl").unwrap_or(path);
                let id = dir.rsplit(['/', '\\']).next().unwrap_or("").to_owned();
                let (mut cwd, mut name, mut prompt) = (None, None, None);
                for l in &s.users {
                    if let Some(rest) = l.strip_prefix("cwd:") {
                        cwd = Some(yaml_scalar(rest));
                    } else if let Some(rest) = l.strip_prefix("name:") {
                        name = Some(yaml_scalar(rest));
                    } else if l.contains(r#""type":"session.start""#) {
                        cwd = field(l, "cwd");
                    } else if l.contains(r#""type":"user.message""#) && prompt.is_none() {
                        prompt = field(l, "content");
                    }
                }
                let title = [name, prompt].into_iter().flatten().map(|t| one_line(&t)).find(|t| !t.is_empty());
                (AgentKind::Copilot, id, cwd.filter(|c| !c.is_empty()), title)
            }
            _ => continue,
        };
        // nothing was said: it can't be resumed
        let Some(title) = title else { continue };
        if id.is_empty() || !is_session_id_str(Some(&id), Some(kind)) {
            continue;
        }
        let at = ms_of(t);
        let snippet = s.snippet.map(|r| snippet_of(r, q)).unwrap_or_default();
        // a Codex thread rewound into a second file: the newest file (listed first) speaks for it
        hits.entry((kind, id.clone())).or_insert(ConversationHit { agent: kind, id, cwd, title, at, snippet });
    }
    (hits.into_values().collect(), more)
}

/// OpenCode's matching sessions, from the rows `opencode_search_sql` returned.
pub fn parse_opencode(rows: &[Value], q: &str) -> Vec<ConversationHit> {
    let s = |r: &Value, k: &str| r.get(k).and_then(Value::as_str).map(str::to_owned).filter(|v| !v.is_empty());
    rows.iter()
        .filter_map(|r| {
            let id = s(r, "id")?;
            if !is_session_id_str(Some(&id), Some(AgentKind::Opencode)) {
                return None;
            }
            let title = one_line(&s(r, "title").unwrap_or_default());
            let title = if title.is_empty() { "Untitled".to_owned() } else { title };
            let t = r.get("t").and_then(Value::as_f64).unwrap_or(0.0);
            let snippet = match s(r, "snip") {
                Some(raw) => snippet_of(&raw, q),
                None => title.clone(),
            };
            Some(ConversationHit { agent: AgentKind::Opencode, id, cwd: s(r, "directory"), title, at: if t.is_finite() && t > 0.0 { t as u64 } else { 0 }, snippet })
        })
        .collect()
}

/// Searches one machine: its transcript files and OpenCode's database, side by side. A machine
/// without OpenCode answers that part with nothing; one failing there doesn't lose the rest.
pub async fn search_machine(host: &Host, q: &str) -> HubResult<(Vec<ConversationHit>, bool)> {
    let files = host.exec(&search_script(q, Finder::Auto), ExecOptions::timeout(EXEC_MS));
    let oc = host.exec(&ocdb_query_command(&opencode_search_sql(q, PER_MACHINE)), ExecOptions::timeout(EXEC_MS));
    let (files, oc) = join(files, oc).await;
    let (mut hits, mut more) = parse_search(&files?.stdout, q);
    if let Ok(oc) = oc {
        hits.extend(parse_opencode(&ocdb_query_rows(&oc.stdout), q));
    }
    hits.sort_by_key(|h| std::cmp::Reverse(h.at));
    if hits.len() > PER_MACHINE {
        hits.truncate(PER_MACHINE);
        more = true;
    }
    // a name given in Inyon wins, as in the per-folder list
    let id = host.id();
    for h in &mut hits {
        if let Some(name) = session_name(&id, Some(&h.id), Some(h.agent)) {
            h.title = name;
        }
    }
    Ok((hits, more))
}

/// Every machine's answer in one list: machines with matches first, the newest match leading,
/// then those with none, then those that failed, then those not searched.
pub fn merge(mut machines: Vec<ConversationSearchMachine>) -> Vec<ConversationSearchMachine> {
    for m in &mut machines {
        m.hits.sort_by_key(|h| std::cmp::Reverse(h.at));
        if m.hits.len() > PER_MACHINE {
            m.hits.truncate(PER_MACHINE);
            m.more = Some(true);
        }
    }
    let rank = |m: &ConversationSearchMachine| {
        if m.skipped.is_some() {
            3
        } else if m.error.is_some() {
            2
        } else if m.hits.is_empty() {
            1
        } else {
            0
        }
    };
    machines.sort_by(|a, b| {
        rank(a).cmp(&rank(b)).then_with(|| b.hits.first().map(|h| h.at).cmp(&a.hits.first().map(|h| h.at))).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    machines
}

/// Searches every online machine at once, each for at most MACHINE_MS.
pub async fn search_conversations(query: &str) -> HubResult<ConversationSearch> {
    search_conversations_within(query, MACHINE_MS).await
}

pub async fn search_conversations_within(query: &str, wait_ms: u64) -> HubResult<ConversationSearch> {
    let q = clean_query(query)?;
    let states = registry().overview();
    let all = states.into_iter().map(|s| {
        let q = q.clone();
        async move {
            let mut m = ConversationSearchMachine { host: s.config.id.clone(), name: s.config.name.clone(), hits: vec![], more: None, error: None, skipped: None };
            if s.status != HostStatus::Online {
                m.skipped = Some("Offline".into());
                return m;
            }
            let host = match registry().host(&m.host) {
                Ok(h) => h,
                Err(e) => {
                    m.error = Some(e.message);
                    return m;
                }
            };
            match select(Box::pin(async move { search_machine(&host, &q).await }), sleep(wait_ms)).await {
                Either::Left((Ok((hits, more)), _)) => {
                    m.hits = hits;
                    m.more = more.then_some(true);
                }
                Either::Left((Err(e), _)) => m.error = Some(e.message),
                Either::Right(_) => m.error = Some("Took too long to answer".into()),
            }
            m
        }
    });
    let machines = merge(join_all(all).await);
    Ok(ConversationSearch { query: q, machines })
}

#[cfg(test)]
#[path = "conversation_search_tests.rs"]
mod tests;
