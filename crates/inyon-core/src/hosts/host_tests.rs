//! What `tmux` means after the prelude the hub puts before every command, under a plain sh: the
//! real tmux with -u, Inyon's own keeper on a machine that asked for it, or nothing at all.

use std::os::unix::fs::PermissionsExt;

use super::UTF8_TMUX;
use crate::test_support::{sh, TempDir};

/// A machine: a home folder, and a bin folder that's the whole PATH besides the system's.
struct Machine {
    home: TempDir,
    bin: TempDir,
}

impl Machine {
    fn new() -> Machine {
        let m = Machine { home: TempDir::new("inyon-prelude-home-"), bin: TempDir::new("inyon-prelude-bin-") };
        // the one program the shell itself is found by
        std::os::unix::fs::symlink("/bin/sh", m.bin.path("sh")).unwrap();
        m
    }

    fn program(&self, dir: &TempDir, rel: &str, script: &str) {
        dir.write(rel, &format!("#!/bin/sh\n{script}\n"));
        std::fs::set_permissions(dir.path(rel), std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    /// A tmux that says how it was called.
    fn with_tmux(self) -> Machine {
        self.program(&self.bin, "tmux", r#"echo "real tmux: $*""#);
        self
    }

    /// An inyon in the usual place, with a keeper (it answers `mux -V`) or from before there was one.
    fn with_inyon(self, has_keeper: bool) -> Machine {
        let script = if has_keeper { r#"[ "$1 $2" = "mux -V" ] && exit 0; echo "keeper: $*""# } else { r#"echo "unknown command: $1" >&2; exit 2"# };
        self.program(&self.home, ".inyon/bin/inyon", script);
        self
    }

    fn sessions(self, word: &str) -> Machine {
        self.home.write(".inyon/sessions", &format!("{word}\n"));
        self
    }

    /// What `tmux ls -F x` prints after the prelude (stdout and stderr). The PATH is this machine's
    /// bin folder alone, so a tmux the test machine happens to have is out of sight.
    fn tmux(&self, extra: &[(&str, &str)]) -> String {
        let path = self.bin.s();
        let home = self.home.s();
        let mut env = vec![("HOME", home.as_str()), ("PATH", path.as_str())];
        env.extend_from_slice(extra);
        let (_, out, err) = sh(&format!("{UTF8_TMUX}tmux ls -F x; [ -z \"$_inyon_keeper\" ] || echo '[keeper]'"), None, &env);
        format!("{out}{err}").trim().to_string()
    }
}

#[test]
fn with_no_word_it_is_tmux_and_nothing_else_as_before() {
    assert_eq!(Machine::new().with_tmux().with_inyon(true).tmux(&[]), "real tmux: -u ls -F x");
    // no tmux and no word: the command isn't there, and the machine says so as it always did
    assert!(Machine::new().with_inyon(true).tmux(&[]).contains("not found"));
}

#[test]
fn auto_takes_the_keeper_only_where_tmux_is_not_installed() {
    assert_eq!(Machine::new().with_tmux().with_inyon(true).sessions("auto").tmux(&[]), "real tmux: -u ls -F x");
    assert_eq!(Machine::new().with_inyon(true).sessions("auto").tmux(&[]), "keeper: mux ls -F x\n[keeper]");
    // an inyon from before the keeper: still no tmux, as before
    assert!(Machine::new().with_inyon(false).sessions("auto").tmux(&[]).contains("not found"));
}

#[test]
fn own_takes_the_keeper_even_where_tmux_is_installed() {
    assert_eq!(Machine::new().with_tmux().with_inyon(true).sessions("own").tmux(&[]), "keeper: mux ls -F x\n[keeper]");
}

#[test]
fn an_inyon_from_before_the_keeper_leaves_tmux_as_it_was() {
    assert_eq!(Machine::new().with_tmux().with_inyon(false).sessions("own").tmux(&[]), "real tmux: -u ls -F x");
    // and with no inyon there at all
    assert_eq!(Machine::new().with_tmux().sessions("own").tmux(&[]), "real tmux: -u ls -F x");
}

#[test]
fn the_engine_says_where_inyon_is_and_an_unknown_word_means_tmux() {
    let m = Machine::new().with_tmux().sessions("own");
    m.program(&m.bin, "inyon-elsewhere", r#"[ "$1 $2" = "mux -V" ] && exit 0; echo "elsewhere: $*""#);
    let exe = m.bin.path("inyon-elsewhere").to_string_lossy().into_owned();
    assert_eq!(m.tmux(&[("INYON_EXE", &exe)]), "elsewhere: mux ls -F x\n[keeper]");
    assert_eq!(Machine::new().with_tmux().with_inyon(true).sessions("maybe").tmux(&[]), "real tmux: -u ls -F x");
}
