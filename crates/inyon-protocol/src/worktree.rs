//! Names for sessions in a git worktree of their own (New session › In a new worktree): the
//! branch New session suggests, git's rules for a branch name, and the worktree folder's name.
//! The hub (inyon-core's features/worktrees) and the Rust app share them; the React app's
//! `lib/worktree.ts` follows the same rules.

/// The first few words of `text` as a branch-friendly slug: lowercase ASCII letters and digits
/// joined by dashes, at most four words and 32 characters. Anything else separates words.
pub fn slug(text: &str) -> String {
    let lower = text.to_ascii_lowercase();
    let mut out = String::new();
    for w in lower.split(|c: char| !c.is_ascii_alphanumeric()).filter(|w| !w.is_empty()).take(4) {
        let next = if out.is_empty() { w.to_owned() } else { format!("{out}-{w}") };
        if next.len() > 32 {
            if out.is_empty() {
                out = w[..32].to_owned();
            }
            break;
        }
        out = next;
    }
    out
}

/// The branch New session suggests: `inyon/<first words of the message>`, or `inyon/<agent>-<MMDD-HHMM>`
/// when there's no message. `stamp` is that MMDD-HHMM.
pub fn default_branch(prompt: Option<&str>, agent: &str, stamp: &str) -> String {
    let words = slug(prompt.unwrap_or(""));
    if words.is_empty() {
        let a = slug(agent);
        format!("inyon/{}-{stamp}", if a.is_empty() { "session" } else { &a })
    } else {
        format!("inyon/{words}")
    }
}

/// Whether git takes `name` as a branch, by the rules of `git check-ref-format --branch`, with
/// the reason in a sentence when it doesn't.
pub fn check_branch(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("Type a branch name".into());
    }
    if name.len() > 200 {
        return Err("That branch name is too long".into());
    }
    if name == "@" || name == "HEAD" {
        return Err(format!("“{name}” can't be a branch name"));
    }
    if name.starts_with('-') {
        return Err("A branch name can't start with -".into());
    }
    if name.starts_with('/') || name.ends_with('/') || name.contains("//") {
        return Err("A branch name can't start or end with /, or have two in a row".into());
    }
    if name.ends_with('.') {
        return Err("A branch name can't end with a dot".into());
    }
    if name.contains("..") {
        return Err("A branch name can't have two dots in a row".into());
    }
    if name.contains("@{") {
        return Err("A branch name can't contain @{".into());
    }
    if let Some(c) = name.chars().find(|c| c.is_ascii_control() || " ~^:?*[\\".contains(*c)) {
        return Err(match c {
            ' ' => "A branch name can't contain spaces".into(),
            c if c.is_ascii_control() => "A branch name can't contain control characters".into(),
            c => format!("A branch name can't contain {c}"),
        });
    }
    for part in name.split('/') {
        if part.starts_with('.') {
            return Err("No part of a branch name can start with a dot".into());
        }
        if part.ends_with(".lock") {
            return Err("No part of a branch name can end with .lock".into());
        }
    }
    Ok(())
}

/// The worktree folder's name after the repo's: the branch without `inyon/`, with anything but
/// letters, digits, dots, dashes and underscores as a dash.
pub fn folder_slug(branch: &str) -> String {
    let b = branch.strip_prefix("inyon/").unwrap_or(branch);
    let mut out = String::new();
    for c in b.chars() {
        let c = if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' { c } else { '-' };
        if !(c == '-' && out.ends_with('-')) {
            out.push(c);
        }
    }
    let s: String = out.trim_matches(|c| c == '-' || c == '.').chars().take(48).collect();
    let s = s.trim_end_matches(['-', '.']).to_owned();
    if s.is_empty() {
        "worktree".into()
    } else {
        s
    }
}

/// Where the hub puts the worktree, relative to the repo's top folder `root`:
/// `../.inyon-worktrees/<repo>-<name>`.
pub fn worktree_folder(root: &str, branch: &str) -> String {
    let repo = root.split(['/', '\\']).rfind(|p| !p.is_empty()).unwrap_or("repo");
    format!("../.inyon-worktrees/{repo}-{}", folder_slug(branch))
}
