//! A `tmux` command line as the hub writes it: the subcommand, its flags and its words. Each
//! subcommand the keeper answers lists which of its flags take a value; a flag it doesn't list is
//! an error, so a command the keeper would get wrong fails loudly instead of doing something else.

use std::collections::BTreeMap;

/// One parsed command: `send-keys -t %3 -l -- hello` is `send-keys` with `t` = `%3`, the switch
/// `l`, and the word `hello`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Call {
    pub name: &'static str,
    /// flags that came with a value (`-t %3`)
    pub values: BTreeMap<char, String>,
    /// flags that stand alone (`-d`)
    pub switches: Vec<char>,
    /// what follows the flags: keys to press, a command to run, a name
    pub words: Vec<String>,
}

impl Call {
    pub fn has(&self, flag: char) -> bool {
        self.switches.contains(&flag)
    }

    pub fn value(&self, flag: char) -> Option<&str> {
        self.values.get(&flag).map(String::as_str)
    }
}

/// A subcommand: its names, the flags that take a value and the ones that stand alone.
struct Spec {
    name: &'static str,
    alias: &'static str,
    values: &'static str,
    switches: &'static str,
}

const fn spec(name: &'static str, alias: &'static str, values: &'static str, switches: &'static str) -> Spec {
    Spec { name, alias, values, switches }
}

/// The subcommands the hub uses, with the flags it passes (and the few more tmux users reach for).
const SPECS: &[Spec] = &[
    spec("new-session", "new", "scnxyFt", "dPAD"),
    spec("new-window", "neww", "tcnF", "dPk"),
    spec("list-sessions", "ls", "F", ""),
    spec("list-windows", "lsw", "tF", "a"),
    spec("list-panes", "lsp", "tF", "as"),
    spec("list-clients", "lsc", "tF", ""),
    spec("has-session", "has", "t", ""),
    spec("display-message", "display", "tF", "p"),
    spec("send-keys", "send", "tN", "lHMRX"),
    spec("load-buffer", "loadb", "bt", "w"),
    spec("paste-buffer", "pasteb", "bts", "dpr"),
    spec("delete-buffer", "deleteb", "b", ""),
    spec("capture-pane", "capturep", "tSEb", "peJaqCNT"),
    spec("kill-session", "", "t", "aC"),
    spec("kill-pane", "killp", "t", "a"),
    spec("kill-window", "killw", "t", "a"),
    spec("resize-window", "resizew", "txy", "aADLRU"),
    spec("rename-session", "rename", "t", ""),
    spec("rename-window", "renamew", "t", ""),
    spec("respawn-pane", "respawnp", "tce", "k"),
    spec("select-pane", "selectp", "tT", "DLRUlMmdeZ"),
    spec("select-window", "selectw", "t", "lnpT"),
    spec("set-option", "set", "t", "aFgopqsuUw"),
    spec("set-window-option", "setw", "t", "aFgoqu"),
    spec("bind-key", "bind", "NT", "nr"),
    // -x and -y: the attaching terminal's size (the keeper's own, as `inyon attach` sends it)
    spec("attach-session", "attach", "tcxy", "dEr"),
    spec("kill-server", "", "", ""),
];

/// Reads the words after `tmux`. `--` ends the flags; so does the first word that isn't one, and
/// for `send-keys -l` and `-H` everything after the flags is text or bytes whatever it looks like.
pub fn parse(argv: &[String]) -> Result<Call, String> {
    let Some(first) = argv.first() else { return Err("no command".into()) };
    let Some(spec) = SPECS.iter().find(|s| s.name == first || (!s.alias.is_empty() && s.alias == first)) else {
        return Err(format!("unknown command: {first}"));
    };
    let mut call = Call { name: spec.name, ..Call::default() };
    let mut i = 1;
    while i < argv.len() {
        let a = &argv[i];
        if a == "--" {
            i += 1;
            break;
        }
        // a lone dash is a word (load-buffer reads stdin from it), and so is a negative number's
        // look-alike only where a flag expects a value, which the loop below takes care of
        if !a.starts_with('-') || a.len() == 1 {
            break;
        }
        // flags may be run together: -de, -pet %3
        let mut chars = a[1..].chars();
        while let Some(c) = chars.next() {
            if spec.switches.contains(c) {
                if !call.switches.contains(&c) {
                    call.switches.push(c);
                }
            } else if spec.values.contains(c) {
                let rest: String = chars.by_ref().collect();
                let v = if rest.is_empty() {
                    i += 1;
                    argv.get(i).cloned().ok_or_else(|| format!("{}: -{c} needs a value", spec.name))?
                } else {
                    rest
                };
                call.values.insert(c, v);
            } else {
                return Err(format!("{}: unknown flag -{c}", spec.name));
            }
        }
        i += 1;
    }
    call.words = argv[i..].to_vec();
    Ok(call)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(line: &str) -> Result<Call, String> {
        parse(&line.split(' ').map(str::to_string).collect::<Vec<_>>())
    }

    fn words(c: &Call) -> Vec<&str> {
        c.words.iter().map(String::as_str).collect()
    }

    #[test]
    fn a_new_session_as_the_hub_starts_one() {
        let c = p("new-session -d -s work -x 220 -y 50 -P -F #{pane_id} -c /home/sam/app claude --resume").unwrap();
        assert_eq!(c.name, "new-session");
        assert!(c.has('d') && c.has('P'));
        assert_eq!((c.value('s'), c.value('x'), c.value('y'), c.value('F'), c.value('c')), (Some("work"), Some("220"), Some("50"), Some("#{pane_id}"), Some("/home/sam/app")));
        // the command's own flags are its words, not ours
        assert_eq!(words(&c), ["claude", "--resume"]);
    }

    #[test]
    fn keys_text_and_bytes() {
        let c = p("send-keys -t %3 C-c Up Enter").unwrap();
        assert_eq!((c.value('t'), words(&c)), (Some("%3"), vec!["C-c", "Up", "Enter"]));
        // after -l -- everything is text, a leading dash and all
        let c = p("send-keys -t %3 -l -- -it's --not a flag").unwrap();
        assert!(c.has('l'));
        assert_eq!(words(&c), ["-it's", "--not", "a", "flag"]);
        let c = p("send-keys -t %55 -H 1b 5b 41").unwrap();
        assert!(c.has('H'));
        assert_eq!(words(&c), ["1b", "5b", "41"]);
    }

    #[test]
    fn flags_run_together_and_values_stuck_to_their_flag() {
        let c = p("capture-pane -pe -t %1").unwrap();
        assert!(c.has('p') && c.has('e'));
        assert_eq!(c.value('t'), Some("%1"));
        let c = p("capture-pane -p -J -S -200 -t %1").unwrap();
        // -200 is -S's value, not three flags
        assert_eq!((c.value('S'), c.value('t')), (Some("-200"), Some("%1")));
        let c = p("list-panes -a -F#{pane_id}").unwrap();
        assert_eq!(c.value('F'), Some("#{pane_id}"));
    }

    #[test]
    fn short_names_are_the_long_ones() {
        assert_eq!(p("ls -F #{session_id}").unwrap().name, "list-sessions");
        assert_eq!(p("has -t main").unwrap().name, "has-session");
        assert_eq!(p("neww -t main -n logs").unwrap().name, "new-window");
    }

    #[test]
    fn a_buffer_from_stdin_and_its_paste() {
        let c = p("load-buffer -b inyon-7 -").unwrap();
        assert_eq!((c.value('b'), words(&c)), (Some("inyon-7"), vec!["-"]));
        let c = p("paste-buffer -d -p -r -b inyon-7 -t %3").unwrap();
        assert!(c.has('d') && c.has('p') && c.has('r'));
        assert_eq!((c.value('b'), c.value('t')), (Some("inyon-7"), Some("%3")));
    }

    #[test]
    fn what_it_would_get_wrong_fails_loudly() {
        assert_eq!(p("split-window -h").unwrap_err(), "unknown command: split-window");
        assert_eq!(p("send-keys -Q").unwrap_err(), "send-keys: unknown flag -Q");
        assert_eq!(p("kill-session -t").unwrap_err(), "kill-session: -t needs a value");
        assert_eq!(parse(&[]).unwrap_err(), "no command");
    }

    #[test]
    fn every_subcommand_the_hub_uses_is_known() {
        for name in [
            "send-keys",
            "capture-pane",
            "paste-buffer",
            "select-pane",
            "new-session",
            "select-window",
            "resize-window",
            "load-buffer",
            "list-panes",
            "list-clients",
            "display-message",
            "respawn-pane",
            "new-window",
            "kill-session",
            "bind-key",
            "set-option",
            "rename-window",
            "rename-session",
            "list-sessions",
            "kill-pane",
            "has-session",
            "set-window-option",
            "delete-buffer",
            "attach-session",
        ] {
            assert!(parse(&[name.to_string()]).is_ok(), "{name}");
        }
    }
}
