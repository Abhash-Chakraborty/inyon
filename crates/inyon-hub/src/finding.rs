//! Pages an agent made but never added: every few minutes, while anyone could see them, each
//! machine's own `inyon pages find` looks under the folders its agents work in for Blueprint sites
//! (a `.inyon-page.json` next to an `index.html`) and adds those not on its list yet. A page taken
//! off the list stays off: the list remembers it under `removed`. The hub keeps whose folder each
//! page was found under (`page-sessions`): the conversation and, from 0.25, the tmux session, so
//! the app can list the page under that session.

use std::collections::{BTreeMap, HashMap};

use inyon_core::features::pages_core::LOCAL_HOST;
#[cfg(test)]
use inyon_core::features::pages_remote::tmux_of;
use inyon_core::features::pages_remote::{is_session, is_tmux_id, is_tmux_name};
use inyon_core::hosts::registry::registry;
use inyon_core::platform::rt::{sleep, spawn};
use inyon_core::platform::store::kv;
use inyon_protocol::{HostState, HostStatus};
use serde_json::{Map, Value};

/// How often the agents' folders are looked through, in ms.
pub const EVERY_MS: u64 = 5 * 60_000;
/// How long a machine whose inyon can't find pages (before 0.22.4) is left before it's asked again.
pub const RETRY_MS: u64 = 30 * 60_000;
/// The most folders sent to one machine at a time.
const DIRS_MAX: usize = 32;
/// The most pages whose session the hub keeps.
const SESSIONS_MAX: usize = 500;

/// Who a page belongs to, as far as the hub knows: the agent conversation and the tmux session
/// it was made in.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Owner {
    pub session: Option<String>,
    /// the tmux session's name
    pub tmux: Option<String>,
    /// the tmux session's id ("$3")
    pub tmux_id: Option<String>,
}

impl Owner {
    fn is_empty(&self) -> bool {
        self.session.is_none() && self.tmux.is_none()
    }
}

/// The folders each kind of agent works in on a machine, from its sessions: agent panes only, with
/// an absolute folder (a Windows one too), each with the first conversation working there that
/// has an id, and its tmux session.
pub fn agent_folders(state: &HostState) -> BTreeMap<String, BTreeMap<String, Owner>> {
    let mut out: BTreeMap<String, BTreeMap<String, Owner>> = BTreeMap::new();
    for tmux in &state.sessions {
        for pane in tmux.windows.iter().flat_map(|w| &w.panes) {
            let Some(agent) = &pane.agent else { continue };
            let cwd = pane.cwd.trim();
            let absolute = cwd.starts_with('/') || cwd.as_bytes().get(1..3).is_some_and(|b| b[0] == b':' && (b[1] == b'\\' || b[1] == b'/'));
            if pane.dead || !absolute {
                continue;
            }
            let dirs = out.entry(agent.kind.as_str().to_owned()).or_default();
            if dirs.len() < DIRS_MAX || dirs.contains_key(cwd) {
                let owner = dirs.entry(cwd.to_owned()).or_default();
                if owner.session.is_none() {
                    *owner = Owner { session: agent.session_id.clone(), tmux: Some(tmux.name.clone()), tmux_id: Some(tmux.id.clone()) };
                }
            }
        }
    }
    out
}

/// Looks through the agents' folders on every connected machine, the hub's own first.
pub async fn find_all(not_before: &mut HashMap<String, u64>, now: u64) {
    let mut ids = vec![LOCAL_HOST.to_owned()];
    ids.extend(crate::pages_remote::machines());
    for id in ids {
        if not_before.get(&id).is_some_and(|t| now < *t) {
            continue;
        }
        let Some(rt) = registry().get(&id) else { continue };
        let state = rt.borrow().state.clone();
        if state.status != HostStatus::Online {
            continue;
        }
        let mut added = 0;
        for (by, dirs) in agent_folders(&state) {
            match crate::pages_remote::find(&id, &by, &dirs.keys().cloned().collect::<Vec<_>>()).await {
                Ok(found) => {
                    added += found.len();
                    for page in found {
                        let (Some(slug), Some(path)) = (page.get("slug").and_then(Value::as_str), page.get("path").and_then(Value::as_str)) else { continue };
                        if let Some(owner) = owner_for(path, &dirs) {
                            remember(&id, slug, &owner, page.get("added").and_then(Value::as_u64));
                        }
                    }
                }
                // its inyon is too old (409) or refused (400, 501): leave it for a while. A timeout
                // or a dropped connection is tried again next time
                Err(e) if matches!(e.status, Some(400 | 409 | 501)) => {
                    not_before.insert(id.clone(), now + RETRY_MS);
                    break;
                }
                Err(_) => break,
            }
        }
        if added > 0 && id != LOCAL_HOST {
            crate::pages::pages().remote.forget(&id);
        }
    }
}

/// Whose is the deepest of `dirs` that holds a found page (`find` only looks inside them).
/// Windows paths match in any case.
pub fn owner_for(page: &str, dirs: &BTreeMap<String, Owner>) -> Option<Owner> {
    let parts = |p: &str| p.split(['/', '\\']).filter(|s| !s.is_empty()).map(str::to_ascii_lowercase).collect::<Vec<_>>();
    let page = parts(page);
    dirs.iter()
        .filter_map(|(dir, owner)| {
            let dir = parts(dir);
            (!dir.is_empty() && page.starts_with(&dir)).then(|| (dir.len(), owner.clone()))
        })
        .max_by_key(|(depth, _)| *depth)
        .map(|(_, o)| o)
        .filter(|o| !o.is_empty())
}

/// Keeps whose a page is (the parts that look right), with when the page was added so a later
/// page under the same slug doesn't inherit it, moved to the end of the list; past SESSIONS_MAX
/// the first ones go.
pub fn remember(host: &str, slug: &str, owner: &Owner, added: Option<u64>) {
    let mut o = Map::new();
    if let Some(s) = owner.session.as_deref().filter(|s| is_session(s)) {
        o.insert("session".into(), Value::String(s.to_owned()));
    }
    if let Some(t) = owner.tmux.as_deref().filter(|t| is_tmux_name(t)) {
        o.insert("tmux".into(), Value::String(t.to_owned()));
        if let Some(id) = owner.tmux_id.as_deref().filter(|id| is_tmux_id(id)) {
            o.insert("tmuxId".into(), Value::String(id.to_owned()));
        }
    }
    if o.is_empty() {
        return;
    }
    if let Some(a) = added {
        o.insert("added".into(), Value::from(a));
    }
    let mut all: Map<String, Value> = kv::get("page-sessions").unwrap_or_default();
    let key = format!("{host}/{slug}");
    all.remove(&key);
    all.insert(key, Value::Object(o));
    while all.len() > SESSIONS_MAX {
        let Some(first) = all.keys().next().cloned() else { break };
        all.remove(&first);
    }
    let _ = kv::set("page-sessions", &all);
}

/// Whose the hub found a page to be, or last saw it to be. Nothing when what's kept was about an
/// earlier page under that slug (one removed, then another added as `added`). Before 0.25 the hub
/// kept only the conversation, as a string.
pub fn owner_of(host: &str, slug: &str, added: Option<u64>) -> Owner {
    let Some(v) = kv::get::<Map<String, Value>>("page-sessions").and_then(|mut all| all.remove(&format!("{host}/{slug}"))) else { return Owner::default() };
    if let (Some(kept), Some(now)) = (v.get("added").and_then(Value::as_u64), added) {
        if kept != now {
            return Owner::default();
        }
    }
    let text = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_owned);
    match &v {
        Value::String(s) => Owner { session: Some(s.clone()).filter(|s| is_session(s)), ..Owner::default() },
        _ => Owner { session: text("session").filter(|s| is_session(s)), tmux: text("tmux").filter(|t| is_tmux_name(t)), tmux_id: text("tmuxId").filter(|id| is_tmux_id(id)) },
    }
}

/// Looks every EVERY_MS while an app is connected or a browser wants page notices.
pub fn start() {
    spawn(async {
        let mut not_before = HashMap::new();
        // a minute after the hub starts, then every EVERY_MS
        let mut wait = 60_000;
        loop {
            sleep(wait).await;
            wait = EVERY_MS;
            if !crate::clients::any() && crate::push::registrations().iter().all(|r| !r.pages) {
                continue;
            }
            find_all(&mut not_before, inyon_core::clock::now_ms()).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_live_agent_panes_with_a_full_folder_count() {
        let pane = |cwd: &str, agent: Option<&str>, dead: bool| {
            json!({ "id": "%1", "index": 0, "active": true, "command": "x", "cwd": cwd, "title": "", "width": 80, "height": 24, "dead": dead,
                "agent": agent.map(|k| json!({ "kind": k, "pid": 1, "state": "idle" })) })
        };
        let state: HostState = serde_json::from_value(json!({
            "config": { "id": "laptop", "name": "laptop", "kind": "node" }, "status": "online", "integration": "unknown", "tmux": "ok", "agents": [], "updatedAt": 0,
            "sessions": [{ "id": "$1", "name": "s", "attached": 0, "windows": [{ "id": "@1", "index": 0, "name": "w", "active": true, "activity": 0, "panes": [
                pane("/home/sam/code/shop", Some("claude"), false),
                pane("/home/sam/code/shop", Some("claude"), false),
                pane("C:\\demo\\app", Some("codex"), false),
                pane("/home/sam/shell", None, false),
                pane("/home/sam/old", Some("claude"), true),
                pane("relative/dir", Some("claude"), false),
            ] }] }]
        }))
        .unwrap();
        let found = agent_folders(&state);
        assert_eq!(found.get("claude").map(|d| d.keys().cloned().collect::<Vec<_>>()), Some(vec!["/home/sam/code/shop".to_owned()]));
        assert_eq!(found.get("codex").map(|d| d.keys().cloned().collect::<Vec<_>>()), Some(vec!["C:\\demo\\app".to_owned()]));
        assert_eq!(found.len(), 2);
        // each folder with the tmux session its agent runs in
        assert_eq!(found["claude"]["/home/sam/code/shop"], Owner { session: None, tmux: Some("s".into()), tmux_id: Some("$1".into()) });
    }

    fn two_sessions() -> HostState {
        let pane = |id: &str, cwd: &str, conv: &str| {
            json!({ "id": id, "index": 0, "active": true, "command": "claude", "cwd": cwd, "title": "", "width": 80, "height": 24, "dead": false,
                "agent": { "kind": "claude", "pid": 1, "state": "idle", "sessionId": conv } })
        };
        let session = |id: &str, name: &str, panes: Vec<Value>| json!({ "id": id, "name": name, "attached": 0, "windows": [{ "id": "@1", "index": 0, "name": "w", "active": true, "activity": 0, "panes": panes }] });
        serde_json::from_value(json!({
            "config": { "id": "laptop", "name": "laptop", "kind": "node" }, "status": "online", "integration": "unknown", "tmux": "ok", "agents": [], "updatedAt": 0,
            "sessions": [
                session("$2", "cardboard", vec![pane("%3", "/home/sam/robots", "conv-a")]),
                session("$5", "notes", vec![pane("%9", "/home/sam/notes", "conv-b")]),
            ]
        }))
        .unwrap()
    }

    #[test]
    fn a_folder_belongs_to_the_conversation_and_tmux_session_working_in_it() {
        let found = agent_folders(&two_sessions());
        assert_eq!(found["claude"]["/home/sam/robots"], Owner { session: Some("conv-a".into()), tmux: Some("cardboard".into()), tmux_id: Some("$2".into()) });
        assert_eq!(found["claude"]["/home/sam/notes"].tmux.as_deref(), Some("notes"));
    }

    #[test]
    fn a_conversation_is_found_in_its_tmux_session_by_the_name_it_has_now() {
        let mut state = two_sessions();
        assert_eq!(tmux_of(&state, "conv-a"), Some(("$2".into(), "cardboard".into())));
        state.sessions[0].name = "robots".into();
        assert_eq!(tmux_of(&state, "conv-a"), Some(("$2".into(), "robots".into())));
        assert_eq!(tmux_of(&state, "gone"), None);
        // an agent that ended doesn't count
        state.sessions[1].windows[0].panes[0].dead = true;
        assert_eq!(tmux_of(&state, "conv-b"), None);
    }

    #[test]
    fn a_session_renamed_between_two_polls_in_a_row_is_followed_by_its_old_name() {
        use inyon_core::features::pages_remote::{note_renames, renamed_in, RENAME_GAP_MS};
        let mut prev = two_sessions();
        prev.status = inyon_protocol::HostStatus::Online;
        prev.updated_at = 10_000;
        let mut next = prev.clone();
        next.updated_at = 12_000;
        next.sessions[0].name = "robots".into();
        note_renames("box-r", &prev, &next);
        assert_eq!(renamed_in(&next, "box-r", "$2", "cardboard").as_deref(), Some("robots"));
        // and again: the newest name, through each rename
        let mut third = next.clone();
        third.updated_at = 14_000;
        third.sessions[0].name = "mob".into();
        note_renames("box-r", &next, &third);
        assert_eq!(renamed_in(&third, "box-r", "$2", "cardboard").as_deref(), Some("mob"));
        assert_eq!(renamed_in(&third, "box-r", "$2", "robots").as_deref(), Some("mob"));
        // not renamed, another machine, or the id is another session's by now
        assert_eq!(renamed_in(&third, "box-r", "$2", "mob"), None);
        assert_eq!(renamed_in(&third, "box-other", "$2", "cardboard"), None);
        let mut reused = third.clone();
        reused.sessions[0].name = "cardboard".into();
        assert_eq!(renamed_in(&reused, "box-r", "$2", "cardboard"), None);
        // the machine was away (or its last state an error): a new name under the same id is a new session
        let mut back = third.clone();
        back.updated_at = third.updated_at + RENAME_GAP_MS + 1;
        back.sessions[1].name = "fresh".into();
        note_renames("box-r", &third, &back);
        assert_eq!(renamed_in(&back, "box-r", "$5", "notes"), None);
        let mut offline = third.clone();
        offline.status = inyon_protocol::HostStatus::Error;
        let mut after = third.clone();
        after.sessions[1].name = "fresh".into();
        note_renames("box-r", &offline, &after);
        assert_eq!(renamed_in(&after, "box-r", "$5", "notes"), None);
        // nor do the renames seen before it: a new session under that id, renamed, isn't the old one's
        let mut restarted = back.clone();
        restarted.updated_at = back.updated_at + 2_000;
        restarted.sessions[0].name = "robots".into();
        note_renames("box-r", &back, &restarted);
        let mut renamed_new = restarted.clone();
        renamed_new.updated_at = restarted.updated_at + 2_000;
        renamed_new.sessions[0].name = "zines".into();
        note_renames("box-r", &restarted, &renamed_new);
        assert_eq!(renamed_in(&renamed_new, "box-r", "$2", "robots").as_deref(), Some("zines"));
        assert_eq!(renamed_in(&renamed_new, "box-r", "$2", "cardboard"), None);
    }

    #[test]
    fn a_session_renamed_many_times_is_followed_to_its_newest_name() {
        use inyon_core::features::pages_remote::{note_renames, renamed_in};
        let mut prev = two_sessions();
        prev.status = inyon_protocol::HostStatus::Online;
        prev.updated_at = 10_000;
        prev.sessions[0].name = "draft-0".into();
        for i in 1..=40 {
            let mut next = prev.clone();
            next.updated_at += 2_000;
            next.sessions[0].name = format!("draft-{i}");
            note_renames("box-many", &prev, &next);
            prev = next;
        }
        assert_eq!(renamed_in(&prev, "box-many", "$2", "draft-0").as_deref(), Some("draft-40"));
    }

    #[test]
    fn a_found_page_belongs_to_the_session_working_in_its_folder() {
        let conv = |c: &str| Owner { session: Some(c.into()), ..Owner::default() };
        let dirs: BTreeMap<String, Owner> =
            [("/home/sam/code/shop".to_owned(), conv("shop-chat")), ("/home/sam/code/shop/web".to_owned(), conv("web-chat")), ("/home/sam/notes".to_owned(), Owner::default())]
                .into();
        let session = |p: &str| owner_for(p, &dirs).and_then(|o| o.session);
        assert_eq!(session("/home/sam/code/shop/private/plans/checkout").as_deref(), Some("shop-chat"));
        assert_eq!(session("/home/sam/code/shop/web/plans/x").as_deref(), Some("web-chat"));
        assert_eq!(owner_for("/home/sam/notes/plan", &dirs), None);
        assert_eq!(owner_for("/home/sam/code/shopping/plan", &dirs), None);
        // Windows folders, in any case
        let win: BTreeMap<String, Owner> = [("C:\\Dev\\Shop".to_owned(), conv("w"))].into();
        assert_eq!(owner_for("c:\\dev\\shop\\private\\plans\\x", &win).and_then(|o| o.session).as_deref(), Some("w"));
    }
}
