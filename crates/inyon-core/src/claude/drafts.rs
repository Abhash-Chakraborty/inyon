//! The pure part of claude/drafts.ts: the draft record, the rule for keeping one, and the keys
//! that clear and refill the terminal's input box. Storing drafts and typing the keys stay in TS.

use serde::{Deserialize, Serialize};

pub use crate::js::text::squash;
use crate::js::JsStr;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DraftSource {
    App,
    Terminal,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Draft {
    pub text: String,
    pub source: DraftSource,
    pub at: f64,
    /// what we last put into (or read from) the terminal's input box
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mirrored: Option<String>,
}

/// What `setDraft` keeps: a box emptied in the app is still a draft until the terminal's box is
/// empty too: without what it holds, a screen read in between would take the old text for typing
/// there and bring it back.
pub fn keeps_draft(d: Option<&Draft>) -> bool {
    d.is_some_and(|d| !d.text.is_empty() || d.mirrored.as_deref().is_some_and(|m| !m.is_empty()))
}

/// Rows a draft fills in the input box. The screen reader joins wrapped rows back into one line,
/// but Ctrl+U only clears the row the cursor is on, so a long dictated paragraph needs one per row.
pub fn draft_rows(draft: &str, width: Option<u32>) -> usize {
    let row = (width.filter(|w| *w != 0).unwrap_or(80) as i64 - 6).max(20) as usize;
    draft.split('\n').map(|line| line.len16().div_ceil(row).max(1)).sum::<usize>() + 2
}

/// The keys `clearInput` sends to empty Claude's input box: Ctrl+U clears a row, Backspace joins
/// the row above.
pub fn clear_input_keys(draft: &str, width: Option<u32>) -> Vec<&'static str> {
    let rows = draft_rows(draft, width);
    let mut keys = vec![];
    for _ in 0..(rows + 1).min(240) {
        keys.extend(["C-u", "BSpace"]);
    }
    keys.push("C-u");
    keys
}

/// What `mirrorToTerminal` does to put `text` into the input box (replacing `current`): None when
/// the box already holds it, else the keys that clear it first (if anything is there) and the
/// text to type (if any).
pub fn mirror_steps(text: &str, current: Option<&str>, width: Option<u32>) -> Option<(Option<Vec<&'static str>>, Option<String>)> {
    if squash(current.unwrap_or("")) == squash(text) {
        return None;
    }
    let clear = current.filter(|c| !c.is_empty()).map(|c| clear_input_keys(c, width));
    let typed = (!text.is_empty()).then(|| text.to_owned());
    Some((clear, typed))
}
