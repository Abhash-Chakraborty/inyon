//! Quick access (from 1.1): one box for commands, sessions, saved prompts and files. This is the
//! part without a screen: the tabs, what a leading `>` or `@` switches to, and the fuzzy match that
//! ranks the rows.

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Tab {
    Commands,
    Sessions,
    Prompts,
    Files,
}

impl Tab {
    pub const ALL: [Tab; 4] = [Tab::Commands, Tab::Sessions, Tab::Prompts, Tab::Files];

    pub fn label(self) -> &'static str {
        match self {
            Tab::Commands => "Commands",
            Tab::Sessions => "Sessions",
            Tab::Prompts => "Saved prompts",
            Tab::Files => "Files",
        }
    }

    pub fn id(self) -> &'static str {
        match self {
            Tab::Commands => "commands",
            Tab::Sessions => "sessions",
            Tab::Prompts => "prompts",
            Tab::Files => "files",
        }
    }

    /// What the box says while it's empty.
    pub fn placeholder(self) -> &'static str {
        match self {
            Tab::Commands => "Run a command…",
            Tab::Sessions => "Find a session on any machine…",
            Tab::Prompts => "Find a saved prompt…",
            Tab::Files => "Find a file in your sessions' folders…",
        }
    }

    /// The key that opens it, as the footer and the Commands list show it.
    pub fn shortcut(self, mac: bool) -> &'static str {
        match (self, mac) {
            (Tab::Commands, false) => "Ctrl Shift P",
            (Tab::Commands, true) => "⌘ ⇧ P",
            (Tab::Sessions, false) => "Ctrl P",
            (Tab::Sessions, true) => "⌘ P",
            (Tab::Files, false) => "Ctrl O",
            (Tab::Files, true) => "⌘ O",
            (Tab::Prompts, _) => "",
        }
    }

    /// Ctrl 1 to 4 picks a tab.
    pub fn nth(n: usize) -> Option<Tab> {
        Tab::ALL.get(n.checked_sub(1)?).copied()
    }

    pub fn next(self, back: bool) -> Tab {
        let i = Tab::ALL.iter().position(|t| *t == self).unwrap_or(0);
        let n = Tab::ALL.len();
        Tab::ALL[if back { (i + n - 1) % n } else { (i + 1) % n }]
    }
}

/// The tab a query goes to and the words to match: `>` goes to Commands and `@` to Files, as in
/// an editor's palette; anything else stays where it is.
pub fn route(query: &str, tab: Tab) -> (Tab, &str) {
    let q = query.trim_start();
    if let Some(rest) = q.strip_prefix('>') {
        (Tab::Commands, rest.trim_start())
    } else if let Some(rest) = q.strip_prefix('@') {
        (Tab::Files, rest.trim_start())
    } else {
        (tab, q)
    }
}

/// How well one word matches `text`, letters in order but not side by side, ignoring case; None
/// when it doesn't. Letters that follow each other, that start a word, and an early start all
/// count for more.
fn word_score(word: &[char], text: &[char]) -> Option<i32> {
    if word.is_empty() {
        return Some(0);
    }
    let low = |c: &char| c.to_lowercase().next().unwrap_or(*c);
    let t: Vec<char> = text.iter().map(low).collect();
    let w: Vec<char> = word.iter().map(low).collect();
    let start = |i: usize| i == 0 || !text[i - 1].is_alphanumeric() || (text[i - 1].is_lowercase() && text[i].is_uppercase());
    let bonus = |i: usize| 1 + if start(i) { 8 } else { 0 };
    // the best placement of the letters so far with the last one at i: (score, where it began);
    // a letter right after the one before scores 10 more, so a run beats the same letters spread
    let mut best: Vec<Option<(i32, usize)>> = (0..t.len()).map(|i| (t[i] == w[0]).then(|| (bonus(i), i))).collect();
    for &c in &w[1..] {
        let mut next = vec![None; t.len()];
        let mut before: Option<(i32, usize)> = None;
        for i in 0..t.len() {
            if i >= 2 && best[i - 2].is_some_and(|b| before.is_none_or(|x| b.0 > x.0)) {
                before = best[i - 2];
            }
            if t[i] != c {
                continue;
            }
            let apart = before.map(|(s, f)| (s + bonus(i), f));
            let after = (i >= 1).then(|| best[i - 1]).flatten().map(|(s, f)| (s + bonus(i) + 10, f));
            next[i] = match (apart, after) {
                (Some(a), Some(b)) => Some(if b.0 >= a.0 { b } else { a }),
                (a, b) => a.or(b),
            };
        }
        best = next;
    }
    // an early start and a short spread rank higher
    best.iter().enumerate().filter_map(|(last, b)| b.map(|(s, first)| s * 4 - first.min(40) as i32 - (last - first + 1 - w.len()).min(40) as i32)).max()
}

pub fn score(query: &str, text: &str) -> Option<i32> {
    let text: Vec<char> = text.chars().collect();
    let mut total = 0;
    for w in query.split_whitespace() {
        let w: Vec<char> = w.chars().collect();
        total += word_score(&w, &text)?;
    }
    Some(total)
}

/// The rows that match, best first; rows that score the same keep their order.
pub fn rank<T>(rows: Vec<T>, query: &str, text: impl Fn(&T) -> String, limit: usize) -> Vec<T> {
    if query.trim().is_empty() {
        return rows.into_iter().take(limit).collect();
    }
    let mut scored: Vec<(i32, usize, T)> = rows.into_iter().enumerate().filter_map(|(i, r)| score(query, &text(&r)).map(|s| (s, i, r))).collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
    scored.into_iter().take(limit).map(|(_, _, r)| r).collect()
}

/// A file's name and the folder it's in, for a row: `src/ui/menu.rs` → (`menu.rs`, `src/ui`).
pub fn split_path(path: &str) -> (&str, &str) {
    match path.rfind('/') {
        Some(i) => (&path[i + 1..], &path[..i]),
        None => (path, ""),
    }
}

/// A file's full path on its machine.
pub fn full_path(cwd: &str, rel: &str) -> String {
    if rel.starts_with('/') || cwd.is_empty() {
        rel.to_string()
    } else {
        format!("{}/{rel}", cwd.trim_end_matches('/'))
    }
}

/// The search key, Ctrl K (⌘ K on a Mac), as the sidebar and menus write it.
pub fn search_key(mac: bool) -> &'static str {
    if mac {
        "⌘ K"
    } else {
        "Ctrl K"
    }
}

/// The new-session key, Alt N (⌥ N on a Mac).
pub fn new_key(mac: bool) -> &'static str {
    if mac {
        "⌥ N"
    } else {
        "Alt N"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_leading_mark_switches_the_tab() {
        assert_eq!(route("> pin", Tab::Sessions), (Tab::Commands, "pin"));
        assert_eq!(route("@menu.rs", Tab::Sessions), (Tab::Files, "menu.rs"));
        assert_eq!(route("  checkout", Tab::Prompts), (Tab::Prompts, "checkout"));
        assert_eq!(Tab::nth(1), Some(Tab::Commands));
        assert_eq!(Tab::nth(4), Some(Tab::Files));
        assert_eq!(Tab::nth(0), None);
        assert_eq!(Tab::nth(5), None);
        assert_eq!(Tab::Files.next(false), Tab::Commands);
        assert_eq!(Tab::Commands.next(true), Tab::Files);
    }

    #[test]
    fn letters_in_order_match_and_word_starts_rank_first() {
        assert!(score("fct", "Fix flaky checkout test").is_some());
        assert!(score("fkt", "Fix flaky checkout test").is_some(), "in order, not side by side");
        assert!(score("xyz", "Fix flaky checkout test").is_none());
        assert!(score("CHECK", "Fix flaky checkout test").is_some(), "case doesn't matter");
        // every word has to match
        assert!(score("flaky box", "Fix flaky checkout test · studio").is_none());
        assert!(score("flaky studio", "Fix flaky checkout test · studio").is_some());
        // a run of letters beats the same letters spread out, and a word start beats the middle
        assert!(score("menu", "src/ui/menu.rs") > score("menu", "src/ui/me_n_u.rs"));
        assert!(score("pin", "Pin") > score("pin", "Unpin"));
        assert!(score("mr", "menu.rs") > score("mr", "summary"));
        // the best placement, not the first: "test" as a run beats its letters picked up early
        let rank_of = |q: &str| rank(vec!["src/checkout/cart.ts storefront", "src/checkout/checkout.test.ts storefront"], q, |r| r.to_string(), 2);
        assert_eq!(rank_of("chktest")[0], "src/checkout/checkout.test.ts storefront");
        assert_eq!(score("", "anything"), Some(0));
    }

    #[test]
    fn ranking_keeps_the_best_and_the_order_of_equals() {
        let rows = vec!["Unpin", "Pin", "Park", "Pinned sessions"];
        assert_eq!(rank(rows.clone(), "pin", |r| r.to_string(), 10)[0], "Pin");
        assert_eq!(rank(rows.clone(), "", |r| r.to_string(), 2), ["Unpin", "Pin"]);
        assert_eq!(rank(rows, "zz", |r| r.to_string(), 10), Vec::<&str>::new());
    }

    #[test]
    fn paths_split_into_name_and_folder() {
        assert_eq!(split_path("src/ui/menu.rs"), ("menu.rs", "src/ui"));
        assert_eq!(split_path("README.md"), ("README.md", ""));
        assert_eq!(full_path("/home/a/app/", "src/x.rs"), "/home/a/app/src/x.rs");
        assert_eq!(full_path("/home/a/app", "/etc/hosts"), "/etc/hosts");
    }
}
