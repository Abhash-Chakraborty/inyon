//! The pure part of hosts/host.ts: quoting for the shell commands the readers build.

/// `shq`: one argument for a POSIX shell, in single quotes.
pub fn shq(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}
