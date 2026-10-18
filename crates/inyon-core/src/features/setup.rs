//! The part of features/setup.ts the readers' commands need.

/// Puts the usual install folders on PATH, for commands run over a non-login shell.
pub const PATHS: &str = r#"export PATH="$HOME/.local/bin:$HOME/bin:$HOME/.npm-global/bin:$HOME/.bun/bin:$HOME/.opencode/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; for d in "$HOME"/.nvm/versions/node/*/bin; do [ -d "$d" ] && PATH="$PATH:$d"; done"#;
