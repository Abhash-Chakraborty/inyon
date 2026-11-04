//! Files attached to a message before it goes (Composer.tsx's attachments): what a paste turns
//! into, how each chip reads, and what the message says about them once they've uploaded. Kept per
//! session outside the composer, as React's `ATTACH` map is, so leaving the screen (or an upload
//! finishing while you're elsewhere) doesn't drop a file you meant to send.

use std::collections::HashMap;

use dioxus::prelude::*;

/// A paste longer than this many lines goes as a text file instead of into the box.
pub const LONG_PASTE_LINES: usize = 40;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Uploading,
    Done,
    Error,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Attachment {
    pub id: String,
    pub name: String,
    pub size: f64,
    pub mime: String,
    /// an image's thumbnail (an object URL), while it's on screen
    pub preview: Option<String>,
    /// the share of the file the machine has, 0 to 1
    pub progress: f64,
    pub status: Status,
    /// the connection dropped mid-upload: it carries on by itself once it's back
    pub waiting: bool,
    /// where the machine saved it
    pub path: Option<String>,
    pub error: Option<String>,
    /// a long paste that became this file: how many lines it had
    pub pasted_lines: Option<usize>,
}

impl Attachment {
    pub fn new(id: String, name: String, size: f64, mime: String, preview: Option<String>, pasted_lines: Option<usize>) -> Attachment {
        Attachment { id, name, size, mime, preview, progress: 0.0, status: Status::Uploading, waiting: false, path: None, error: None, pasted_lines }
    }

    /// The chip's first line.
    pub fn title(&self) -> &str {
        if self.pasted_lines.is_some() {
            "Pasted text"
        } else {
            &self.name
        }
    }

    /// The chip's second line: how far it got, why it failed, or its size.
    pub fn detail(&self) -> String {
        match self.status {
            Status::Uploading if self.waiting => "Reconnecting…".into(),
            Status::Uploading => format!("{}%", (self.progress * 100.0).round()),
            Status::Error => self.error.clone().unwrap_or_default(),
            Status::Done => match self.pasted_lines {
                Some(n) => format!("{n} lines"),
                None => inyon_chat_core::format::bytes(self.size),
            },
        }
    }

    /// The red ring's title on a failed one.
    pub fn retry_title(&self) -> String {
        format!("{} · tap to try again", self.error.as_deref().unwrap_or("Couldn't upload"))
    }
}

/// The lines in a paste when it's long enough to go as a file, else None.
pub fn long_paste(text: &str) -> Option<usize> {
    let lines = text.split('\n').count();
    (lines > LONG_PASTE_LINES).then_some(lines)
}

/// `pasted-HHMMSS.txt`, from the time of day in UTC, as React names it.
pub fn pasted_name(now_ms: u64) -> String {
    let s = (now_ms / 1000) % 86_400;
    format!("pasted-{:02}{:02}{:02}.txt", s / 3600, s % 3600 / 60, s % 60)
}

/// The name a pasted or dropped file goes under: a screenshot comes as `image.png` or with no name
/// at all, so it gets one that won't clash with the last.
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub fn file_name(name: &str, mime: &str, now_ms: u64, index: usize) -> String {
    if !name.is_empty() && name != "image.png" {
        return name.to_string();
    }
    let ext = mime.split('/').nth(1).filter(|e| !e.is_empty()).unwrap_or("bin");
    format!("pasted-{now_ms}-{index}.{ext}")
}

/// Text pasted with nothing focused, added to what the box already has.
pub fn append_text(box_text: &str, pasted: &str) -> String {
    if box_text.is_empty() {
        pasted.to_string()
    } else if box_text.ends_with(char::is_whitespace) {
        format!("{box_text}{pasted}")
    } else {
        format!("{box_text} {pasted}")
    }
}

/// The message with the uploaded files' paths after it, as the agent reads them.
pub fn with_files(text: &str, paths: &[String]) -> String {
    let text = text.trim();
    if paths.is_empty() {
        return text.to_string();
    }
    let gap = if text.is_empty() { "" } else { "\n\n" };
    format!("{text}{gap}Attached files:\n{}", paths.join("\n"))
}

/// What the attachments allow: (any still uploading, any failed, the paths of those that are in).
pub fn summary(list: &[Attachment]) -> (bool, bool, Vec<String>) {
    let uploading = list.iter().any(|a| a.status == Status::Uploading);
    let failed = list.iter().any(|a| a.status == Status::Error);
    let ready = list.iter().filter(|a| a.status == Status::Done).filter_map(|a| a.path.clone()).collect();
    (uploading, failed, ready)
}

/// The note by the send button.
pub fn note(uploading: bool, failed: bool) -> Option<&'static str> {
    if uploading {
        Some("Uploading…")
    } else if failed {
        Some("Upload failed")
    } else {
        None
    }
}

/// Every session's attachments, by chat key.
pub static ATTACH: GlobalSignal<HashMap<String, Vec<Attachment>>> = Signal::global(HashMap::new);

/// One session's attachments.
pub fn of(key: &str) -> Vec<Attachment> {
    ATTACH.read().get(key).cloned().unwrap_or_default()
}

pub fn add(key: &str, a: Attachment) {
    ATTACH.write().entry(key.to_string()).or_default().push(a);
}

/// Changes one attachment, if it's still there.
pub fn update(key: &str, id: &str, f: impl FnOnce(&mut Attachment)) {
    let mut all = ATTACH.write();
    if let Some(a) = all.get_mut(key).and_then(|l| l.iter_mut().find(|a| a.id == id)) {
        f(a);
    }
}

/// Takes attachments off a session's list; what they were, so their previews can be freed.
pub fn remove(key: &str, keep: impl Fn(&Attachment) -> bool) -> Vec<Attachment> {
    let mut all = ATTACH.write();
    let Some(list) = all.get_mut(key) else { return vec![] };
    let (kept, gone): (Vec<_>, Vec<_>) = std::mem::take(list).into_iter().partition(|a| keep(a));
    *list = kept;
    gone
}

#[cfg(test)]
mod tests {
    use super::*;

    fn att(status: Status, path: Option<&str>) -> Attachment {
        let mut a = Attachment::new("a".into(), "spec.pdf".into(), 2048.0, "application/pdf".into(), None, None);
        a.status = status;
        a.path = path.map(str::to_string);
        a
    }

    #[test]
    fn only_a_paste_over_forty_lines_becomes_a_file() {
        let forty = vec!["x"; 40].join("\n");
        assert_eq!(long_paste(&forty), None);
        let more = vec!["x"; 41].join("\n");
        assert_eq!(long_paste(&more), Some(41));
        assert_eq!(long_paste(""), None);
    }

    #[test]
    fn pasted_files_get_names() {
        // 14:03:09 UTC
        assert_eq!(pasted_name((14 * 3600 + 3 * 60 + 9) * 1000 + 86_400_000 * 3), "pasted-140309.txt");
        assert_eq!(file_name("notes.md", "text/markdown", 5, 0), "notes.md");
        assert_eq!(file_name("image.png", "image/png", 5, 1), "pasted-5-1.png");
        assert_eq!(file_name("", "image/webp", 5, 0), "pasted-5-0.webp");
        assert_eq!(file_name("", "", 5, 0), "pasted-5-0.bin");
    }

    #[test]
    fn text_pasted_from_the_page_goes_after_the_draft() {
        assert_eq!(append_text("", "hello"), "hello");
        assert_eq!(append_text("look at", "this"), "look at this");
        assert_eq!(append_text("look at\n", "this"), "look at\nthis");
    }

    #[test]
    fn the_message_lists_what_uploaded() {
        assert_eq!(with_files(" fix it ", &[]), "fix it");
        assert_eq!(with_files("use the spec", &["/up/a.pdf".into(), "/up/b.png".into()]), "use the spec\n\nAttached files:\n/up/a.pdf\n/up/b.png");
        assert_eq!(with_files("", &["/up/a.pdf".into()]), "Attached files:\n/up/a.pdf");
    }

    #[test]
    fn a_failed_or_unfinished_file_holds_the_message() {
        let (up, failed, ready) = summary(&[att(Status::Done, Some("/up/a")), att(Status::Uploading, None)]);
        assert!(up && !failed);
        assert_eq!(ready, vec!["/up/a".to_string()]);
        let (up, failed, _) = summary(&[att(Status::Error, None)]);
        assert!(!up && failed);
        assert_eq!(note(true, true), Some("Uploading…"));
        assert_eq!(note(false, true), Some("Upload failed"));
        assert_eq!(note(false, false), None);
    }

    #[test]
    fn chips_read_like_the_web_app() {
        let mut a = att(Status::Uploading, None);
        a.progress = 0.426;
        assert_eq!(a.detail(), "43%");
        a.waiting = true;
        assert_eq!(a.detail(), "Reconnecting…");
        a.status = Status::Done;
        assert_eq!(a.detail(), "2 KB");
        a.pasted_lines = Some(120);
        assert_eq!((a.title(), a.detail().as_str()), ("Pasted text", "120 lines"));
        a.status = Status::Error;
        a.error = Some("The connection dropped".into());
        assert_eq!(a.detail(), "The connection dropped");
        assert_eq!(a.retry_title(), "The connection dropped · tap to try again");
    }
}
