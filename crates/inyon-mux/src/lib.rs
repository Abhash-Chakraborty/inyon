//! Inyon's own session keeper (from 0.26, in steps): it holds terminals the way a tmux server
//! does and answers the tmux commands the hub sends, so a machine needs no tmux (or psmux) for
//! Inyon to run agents on it. tmux stays the default wherever it's installed.
//!
//! The hub talks to every machine in one language: `tmux <subcommand> …` lines run through a shell.
//! The keeper speaks the same one. This crate starts with what needs no terminal: reading such a
//! command line ([`args`]), a target like `%3` or `main:1.0` ([`target`]), a format string like
//! `#{pane_id} #{pane_title}` ([`format`]) and a key name like `C-c` ([`keys`]).

pub mod args;
#[cfg(unix)]
pub mod client;
pub mod format;
pub mod keeper;
pub mod keys;
pub mod pane;
pub mod screen;
// the process and its socket: Unix first; Windows gets a named pipe with its own terminals
#[cfg(unix)]
pub mod serve;
pub mod target;
