//! Inyon's hub core: the readers that turn what an agent shows and writes into Inyon's wire
//! types. A port of `apps/hub/src`, file for file and with the same names, so each Rust module
//! reads next to the TypeScript it came from:
//!
//! | TypeScript | Rust |
//! |---|---|
//! | `claude/screen.ts` | [`claude::screen`] |
//! | `claude/transcript.ts`, `claude/transcript-tail.ts` | [`claude::transcript`], [`claude::transcript_tail`] |
//! | `claude/delivery.ts`, `claude/drafts.ts`, `claude/keep-default.ts` | [`claude::delivery`], [`claude::drafts`], [`claude::keep_default`] |
//! | `agents/status.ts` | [`agents::status`] |
//! | `agents/codex.ts`, `agents/codex-live.ts` | [`agents::codex`], [`agents::codex_live`] |
//! | `agents/antigravity.ts`, `agents/gemini.ts` | [`agents::antigravity`], [`agents::gemini`] |
//! | `agents/copilot.ts`, `agents/copilot-screen.ts` | [`agents::copilot`], [`agents::copilot_screen`] |
//! | `agents/opencode.ts`, `agents/opencode-screen.ts`, `agents/opencode-db.ts` | [`agents::opencode`], [`agents::opencode_screen`], [`agents::opencode_db`] |
//! | `agents/opencode-models.ts`, `agents/opencode-keys.ts`, `agents/opencode-questions.ts` | [`agents::opencode_models`], [`agents::opencode_keys`], [`agents::opencode_questions`] |
//! | `agents/opencode-controls.ts`, the parsing in `agents/opencode-api.ts` | [`agents::opencode_controls`], [`agents::opencode_api`] |
//! | `tmux/tmux.ts`, `tmux/machine-kind.ts` | [`tmux::tmux`], [`tmux::machine_kind`] |
//!
//! The core does no I/O: it takes the bytes a command printed or a file held and returns what
//! they mean. Running commands, reading files and the HTTP side stay with the caller. It builds for
//! wasm32 as well as natively, and any thread may call it: the one thing it keeps between calls,
//! the provider names OpenCode reported, is shared by all of them, as the hub's module state is.

pub mod js;

pub mod agents;
pub mod claude;
pub mod clock;
pub mod config;
pub mod features;
pub mod hosts;
pub mod ids;
pub mod platform;
pub mod sha;
pub mod terminal;
pub mod tmux;

#[cfg(test)]
pub(crate) mod test_support;

#[cfg(test)]
mod build {
    /// regex without its `perf` features runs every pattern on its slowest engine
    #[test]
    fn native_builds_get_the_fast_regex_engines() {
        let manifest = include_str!("../Cargo.toml");
        let native = manifest.split("[target.'cfg(not(target_arch = \"wasm32\"))'.dependencies]").nth(1).expect("a native-only dependency table");
        let regex = native.lines().find(|l| l.starts_with("regex ")).expect("regex in it");
        assert!(regex.contains("\"perf\""), "{regex}");
    }
}
