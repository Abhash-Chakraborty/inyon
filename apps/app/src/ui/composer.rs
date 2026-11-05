//! The message box under the chat (Composer.tsx): Enter sends (Shift+Enter for a new line), a
//! message sent while the agent works waits in its queue, Esc in an empty box stops the agent and
//! Alt+Enter holds the message until it's free. What you type is the pane's draft, kept in step
//! with the terminal's input line and other devices through the hub's `draft` message.
//!
//! Files come along too: pasted (from the box or anywhere on the page), dropped on the box, or
//! picked with Attach files and Take a photo. Each uploads at once with its progress on a chip,
//! and the message lists where they were saved once it goes. A paste over 40 lines goes as a text
//! file instead of into the box.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;

use dioxus::prelude::*;
use inyon_chat_core::pending::{PendingMessage, PendingStatus};
use inyon_protocol::ClientMsg;

use super::icons::{Glyph, Icon};
use super::{now, outbox};
use crate::attach::{self, Attachment, Status};
use crate::files::{self, PageEvent};
use crate::state::{self, Chats};
use crate::{api, dom, platform, upload};

pub const BOX: &str = "composer-input";
/// the box and its chips, where files can be dropped
const ZONE: &str = "composer-zone";
const PICK_FILES: &str = "composer-files";
const PICK_PHOTO: &str = "composer-photo";
/// How long typing pauses before the draft goes to the hub.
const DRAFT_MS: u32 = 450;

/// What the one round button does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Button {
    Send,
    /// the agent is working: the message waits in its queue
    Queue,
    /// the agent is working and the box is empty
    Stop,
}

/// `held`: a file is still uploading or failed, which holds the message (and Stop gives way to it).
pub fn button(working: bool, can_send: bool, held: bool) -> Button {
    match (working, can_send) {
        (true, false) if !held => Button::Stop,
        (true, _) => Button::Queue,
        _ => Button::Send,
    }
}

/// Whether the box takes something from the page: files and screenshots, a paste over 40 lines,
/// and text pasted with nothing focused. Text pasted into the box itself is left to the browser.
pub fn takes(ev: &PageEvent) -> bool {
    match ev {
        PageEvent::Paste { files, text, in_box, free } => (*in_box || *free) && (!files.is_empty() || attach::long_paste(text).is_some() || (*free && !text.is_empty())),
        PageEvent::Drop(files) => !files.is_empty(),
        PageEvent::Key | PageEvent::Drag(_) => false,
    }
}

/// Whether a draft from the terminal (or another device) takes the box: unless it's what the box
/// last synced, or you're in the box with your own edit.
pub fn adopt(server: &str, synced: &str, text: &str, focused: bool) -> bool {
    server != synced && !(focused && text != synced)
}

/// Sends a message: it shows as on its way at once, then as sent, or as failed with a Retry.
pub fn send(chats: Signal<Chats>, host: String, pane: String, text: String) {
    let id = dom::random_id();
    let mut c = chats;
    let key = inyon_protocol::chat_key(&host, &pane);
    let p = PendingMessage::new(id.clone(), text.clone(), PendingStatus::Sending, now());
    c.write().patch(&key, now(), move |d| d.pending.push(p));
    deliver(chats, host, pane, id, text, false);
}

/// Sends a message that failed again, under the same request id (the hub submits it once).
pub fn retry(chats: Signal<Chats>, host: String, pane: String, id: String, text: String) {
    let key = inyon_protocol::chat_key(&host, &pane);
    let mut c = chats;
    let i = id.clone();
    c.write().patch(&key, now(), move |d| {
        for p in d.pending.iter_mut().filter(|p| p.id == i) {
            p.status = PendingStatus::Sending;
            p.at = now();
            p.retryable = false;
            p.error = None;
        }
    });
    deliver(chats, host, pane, id, text, true);
}

pub fn dismiss(chats: Signal<Chats>, key: &str, id: &str) {
    let mut c = chats;
    let id = id.to_string();
    c.write().patch(key, now(), move |d| d.pending.retain(|p| p.id != id));
}

fn deliver(chats: Signal<Chats>, host: String, pane: String, id: String, text: String, again: bool) {
    let key = inyon_protocol::chat_key(&host, &pane);
    spawn(async move {
        let result = api::send(&host, &pane, &text, &id).await;
        let mut c = chats;
        c.write().patch(&key, now(), move |d| {
            for p in d.pending.iter_mut().filter(|p| p.id == id) {
                match &result {
                    Ok(()) => p.status = PendingStatus::Sent,
                    Err(e) => {
                        p.status = PendingStatus::Failed;
                        p.error = Some(e.message.clone());
                        // a dropped connection sends it again once it's back; a retry that failed
                        // too waits for a tap
                        p.retryable = !again && api::is_transient(e);
                    }
                }
            }
        });
    });
}

thread_local! {
    /// each attachment's file until it has uploaded, so a failed one can be tried again
    static FILES: RefCell<HashMap<String, files::File>> = RefCell::new(HashMap::new());
    /// per pane, what's in the box, so it's still there after the terminal or another chat
    static DRAFTS: RefCell<HashMap<String, String>> = RefCell::new(HashMap::new());
    /// per pane, the draft both sides last agreed on when the box went away
    static SYNCED: RefCell<HashMap<String, String>> = RefCell::new(HashMap::new());
}

/// Adds files to a session's message and starts uploading each.
pub fn add_files(host: &str, pane: &str, list: Vec<files::File>, pasted_lines: Option<usize>) {
    let key = inyon_protocol::chat_key(host, pane);
    for file in list {
        let id = dom::random_id();
        let name = files::name(&file);
        let mime = files::mime(&file);
        let preview = if mime.starts_with("image/") { files::object_url(&file) } else { None };
        let name = if name.is_empty() { "pasted".to_string() } else { name };
        attach::add(&key, Attachment::new(id.clone(), name, files::size(&file), mime, preview, pasted_lines));
        FILES.with(|f| f.borrow_mut().insert(id.clone(), file));
        start(host, pane, &id);
    }
}

/// Uploads one attachment's file. The task outlives the screen, so a file keeps going while you
/// look at something else.
fn start(host: &str, pane: &str, id: &str) {
    let Some(file) = FILES.with(|f| f.borrow().get(id).cloned()) else { return };
    let (key, host, pane, id) = (inyon_protocol::chat_key(host, pane), host.to_string(), pane.to_string(), id.to_string());
    #[cfg(target_arch = "wasm32")]
    dioxus::core::spawn_forever(async move {
        let k = key.clone();
        let i = id.clone();
        let result = upload::upload(&id, &host, Some(&pane), &file, move |progress, waiting| {
            attach::update(&k, &i, |a| {
                a.progress = progress;
                a.waiting = waiting;
            })
        })
        .await;
        match result {
            Ok(u) => {
                FILES.with(|f| f.borrow_mut().remove(&id));
                attach::update(&key, &id, |a| {
                    a.status = Status::Done;
                    a.progress = 1.0;
                    a.waiting = false;
                    a.path = Some(u.path);
                });
            }
            Err(e) => attach::update(&key, &id, |a| {
                a.status = Status::Error;
                a.waiting = false;
                a.error = Some(e.message);
            }),
        }
    });
    #[cfg(not(target_arch = "wasm32"))]
    let _ = (file, key, host, pane, id);
}

/// Tries a failed file again; it picks up where it stopped, so the bar stays where it was.
fn retry_file(host: &str, pane: &str, id: &str) {
    let key = inyon_protocol::chat_key(host, pane);
    attach::update(&key, id, |a| {
        a.status = Status::Uploading;
        a.error = None;
    });
    start(host, pane, id);
}

/// Takes a file off the message: one still going stops, and what reached the machine is deleted.
fn remove_file(key: &str, id: &str) {
    upload::cancel(id);
    FILES.with(|f| f.borrow_mut().remove(id));
    for a in attach::remove(key, |a| a.id != id) {
        if let Some(p) = a.preview {
            files::revoke(&p);
        }
    }
}

/// `draft`: the pane's draft as the hub last sent it (its text, when, and whether the terminal
/// wrote it). `controls`: the model, effort and mode, as one line. `disabled` keeps anything
/// from going out; `offline` also greys the box out (not while the first connection opens).
#[component]
pub fn Composer(
    host: String,
    pane: String,
    agent: String,
    working: bool,
    disabled: bool,
    #[props(default)] offline: bool,
    draft: Option<(String, u64, bool)>,
    controls: String,
    on_sent: EventHandler<()>,
) -> Element {
    let chats = use_context::<Signal<Chats>>();
    let out = outbox();
    let key = inyon_protocol::chat_key(&host, &pane);
    let server = draft.as_ref().map(|d| d.0.clone());
    let mut text = use_signal(|| DRAFTS.with(|d| d.borrow().get(&key).cloned()).or(server.clone()).unwrap_or_default());
    let mut from_terminal = use_signal(|| draft.as_ref().is_some_and(|d| d.2 && !d.0.is_empty()));
    let mut focused = use_signal(|| false);
    let mut stopping = use_signal(|| false);
    let mut dragging = use_signal(|| false);
    // what the hub has as the draft, as far as this box knows. Coming back to a chat it starts
    // from what was agreed when the box went away: a draft the terminal sent meanwhile then
    // reads as new and replaces the old copy, instead of looking already seen.
    let synced = use_hook(|| Rc::new(RefCell::new(SYNCED.with(|s| s.borrow().get(&key).cloned()).or(server).unwrap_or_else(|| text.peek().clone()))));
    {
        let (synced, key) = (synced.clone(), key.clone());
        use_drop(move || {
            SYNCED.with(|s| s.borrow_mut().insert(key.clone(), synced.borrow().clone()));
        });
    }
    {
        let key = key.clone();
        use_effect(move || {
            let t = text.read().clone();
            DRAFTS.with(|d| d.borrow_mut().insert(key.clone(), t));
        });
    }
    let typed = use_hook(|| Rc::new(Cell::new(0u32)));

    // a draft from the terminal or another device
    {
        let synced = synced.clone();
        use_effect(use_reactive!(|draft| {
            let Some((server, _, terminal)) = draft else { return };
            if adopt(&server, &synced.borrow(), &text.peek(), *focused.peek()) {
                *synced.borrow_mut() = server.clone();
                text.set(server);
                from_terminal.set(terminal);
            }
        }));
    }
    // ready to type on arrival and once it can send again, except on a phone, where that would
    // pop the keyboard up
    use_effect(use_reactive!(|offline| {
        if !offline && !dom::coarse() {
            spawn(async { dom::focus(BOX) });
        }
    }));
    use_effect(move || {
        let _ = text.read();
        dom::autosize(BOX, 0.4);
    });

    let push_draft = {
        let (synced, out, host, pane) = (synced.clone(), out.clone(), host.clone(), pane.clone());
        move |value: String| {
            if *synced.borrow() != value {
                *synced.borrow_mut() = value.clone();
                out.send(state::wire(&ClientMsg::Draft { host: host.clone(), pane: pane.clone(), text: value }));
            }
        }
    };
    // your edit: shown at once, sent to the hub once typing pauses, or once the socket is up when
    // that's later (a message for a socket not yet open is dropped)
    let unsent = use_hook(|| Rc::new(RefCell::new(None::<String>)));
    let off = use_hook(|| Rc::new(Cell::new(disabled)));
    off.set(disabled);
    let set_text = {
        let (typed, push_draft, unsent, off) = (typed.clone(), push_draft.clone(), unsent.clone(), off.clone());
        move |v: String| {
            let (mut text, mut from_terminal) = (text, from_terminal);
            text.set(v.clone());
            from_terminal.set(false);
            let n = typed.get() + 1;
            typed.set(n);
            *unsent.borrow_mut() = Some(v.clone());
            let (typed, push, unsent, off) = (typed.clone(), push_draft.clone(), unsent.clone(), off.clone());
            spawn(async move {
                platform::sleep(DRAFT_MS).await;
                if typed.get() == n && !off.get() {
                    unsent.borrow_mut().take();
                    push(v);
                }
            });
        }
    };
    // leaving the app (or reloading) mid-sentence: the draft goes now, not in half a second, and
    // on the socket itself, since the page may be gone before the app's queue is read
    let _leaving = use_hook(|| {
        let (typed, synced, unsent, out, host, pane) = (typed.clone(), synced.clone(), unsent.clone(), out.clone(), host.clone(), pane.clone());
        Rc::new(dom::on_leave(move || {
            let Some(value) = unsent.borrow_mut().take() else { return };
            // the timer's push is then stale
            typed.set(typed.get() + 1);
            if *synced.borrow() != value {
                *synced.borrow_mut() = value.clone();
                out.send_now(state::wire(&ClientMsg::Draft { host: host.clone(), pane: pane.clone(), text: value }));
            }
        }))
    });
    let on_input = {
        let set_text = set_text.clone();
        move |e: FormEvent| set_text(e.value())
    };

    // the edit that waited for the socket goes out once the box can send
    {
        let (unsent, push_draft) = (unsent.clone(), push_draft.clone());
        use_effect(use_reactive!(|disabled| {
            if !disabled {
                if let Some(v) = unsent.borrow_mut().take() {
                    push_draft(v);
                }
            }
        }));
    }
    // pastes, dropped files and typing with nothing focused, from anywhere on the page. The
    // page's listener decides at once whether the app takes the event (so the browser's own
    // handling can be stopped), and this task, inside the app, does the rest.
    let live = use_hook(|| Rc::new(RefCell::new((host.clone(), pane.clone()))));
    *live.borrow_mut() = (host.clone(), pane.clone());
    let listener = use_hook(|| {
        let (tx, mut rx) = futures_channel::mpsc::unbounded::<PageEvent>();
        let (live, set_text) = (live.clone(), set_text.clone());
        spawn(async move {
            use futures_util::StreamExt;
            while let Some(ev) = rx.next().await {
                let (host, pane) = live.borrow().clone();
                match ev {
                    PageEvent::Paste { files, text: pasted, .. } if !files.is_empty() || attach::long_paste(&pasted).is_some() => {
                        if !files.is_empty() {
                            add_files(&host, &pane, files, None);
                        } else if let Some(f) = files::text_file(&pasted, &attach::pasted_name(now())) {
                            add_files(&host, &pane, vec![f], attach::long_paste(&pasted));
                        }
                    }
                    PageEvent::Paste { text: pasted, .. } => {
                        // read first: a peek still held while the box is written would panic
                        let next = attach::append_text(&text.peek(), &pasted);
                        set_text(next);
                        dom::focus(BOX);
                        dom::caret_to_end(BOX);
                    }
                    PageEvent::Drag(on) => {
                        if *dragging.peek() != on {
                            dragging.set(on);
                        }
                    }
                    PageEvent::Drop(files) => add_files(&host, &pane, files, None),
                    PageEvent::Key => {}
                }
            }
        });
        let off = off.clone();
        Rc::new(files::listen(BOX, ZONE, move |ev| {
            if let PageEvent::Drag(_) = ev {
                let _ = tx.unbounded_send(ev);
                return false;
            }
            if off.get() {
                return false;
            }
            if let PageEvent::Key = ev {
                // the key then types into the box (not on a phone, where that pops the keyboard)
                if !dom::coarse() {
                    dom::focus(BOX);
                }
                return false;
            }
            let take = takes(&ev);
            if take {
                let _ = tx.unbounded_send(ev);
            }
            take
        }))
    });
    use_drop(move || drop(listener));

    let list = attach::ATTACH.read().get(&key).cloned().unwrap_or_default();
    let (uploading, failed, ready) = attach::summary(&list);
    let can_send = (!text.read().trim().is_empty() || !ready.is_empty()) && !uploading && !failed && !disabled;
    let mode = button(working, can_send, uploading || failed);
    let do_send = {
        let (host, pane, key, synced, typed, unsent) = (host.clone(), pane.clone(), key.clone(), synced.clone(), typed.clone(), unsent.clone());
        move || {
            let list = attach::of(&key);
            let (uploading, failed, ready) = attach::summary(&list);
            // a file that didn't upload holds the message until it's retried or removed: the text
            // often refers to it ("use the attached spec")
            if disabled || uploading || failed {
                return;
            }
            let msg = attach::with_files(&text.peek(), &ready);
            if msg.is_empty() {
                return;
            }
            // the box empties here and on the hub; the terminal's line is cleared by the send
            typed.set(typed.get() + 1);
            unsent.borrow_mut().take();
            *synced.borrow_mut() = String::new();
            text.set(String::new());
            from_terminal.set(false);
            if dom::coarse() {
                dom::blur(BOX);
            }
            // the sent files' previews aren't shown any more: free them
            for a in attach::remove(&key, |a| !(a.status == Status::Done && a.path.is_some())) {
                if let Some(p) = a.preview {
                    files::revoke(&p);
                }
            }
            send(chats, host.clone(), pane.clone(), msg);
            on_sent.call(());
        }
    };
    let stop = {
        let (host, pane) = (host.clone(), pane.clone());
        move || {
            stopping.set(true);
            let (host, pane) = (host.clone(), pane.clone());
            spawn(async move {
                let _ = api::interrupt(&host, &pane).await;
                stopping.set(false);
            });
        }
    };
    let hold = {
        let (host, pane, key, synced, typed, unsent) = (host.clone(), pane.clone(), key.clone(), synced.clone(), typed.clone(), unsent.clone());
        move || {
            let msg = text.peek().trim().to_string();
            // the hub holds text only
            if msg.is_empty() || !attach::of(&key).is_empty() {
                return;
            }
            let (host, pane, synced, typed, unsent) = (host.clone(), pane.clone(), synced.clone(), typed.clone(), unsent.clone());
            spawn(async move {
                if api::hold(&host, &pane, &msg).await.is_ok() {
                    typed.set(typed.get() + 1);
                    unsent.borrow_mut().take();
                    *synced.borrow_mut() = String::new();
                    text.set(String::new());
                }
            });
        }
    };
    let on_key = {
        let (mut do_send, mut stop, hold) = (do_send.clone(), stop.clone(), hold.clone());
        move |e: KeyboardEvent| {
            if e.is_composing() {
                return;
            }
            let m = e.modifiers();
            match e.key() {
                Key::Escape if working && text.peek().is_empty() => {
                    e.prevent_default();
                    stop();
                }
                Key::Enter if m.alt() => {
                    e.prevent_default();
                    hold();
                }
                // on a touch screen Enter is a new line; the button sends
                Key::Enter if !m.shift() && !dom::coarse() => {
                    e.prevent_default();
                    do_send();
                }
                _ => {}
            }
        }
    };
    let placeholder = if working { format!("Queue a message for {agent}…") } else { format!("Message {agent}…") };
    let (label, title) = match mode {
        Button::Stop => ("Stop", "Stop (Esc in the terminal)"),
        Button::Queue => ("Queue follow-up", "Queue a follow-up"),
        Button::Send => ("Send", "Send"),
    };
    let note = attach::note(uploading, failed).unwrap_or(if !text.read().is_empty() && from_terminal() { "From the terminal" } else { "" });
    let touch = dom::coarse();
    let (mut do_send, mut stop) = (do_send, stop);
    let box_class = match (offline, dragging()) {
        (true, _) => "composer-box composer-off",
        (false, true) => "composer-box composer-drag",
        _ => "composer-box",
    };
    rsx! {
        div { id: ZONE, class: "composer fade-in",
            div {
                class: box_class,
                // measured again once the page's styles and fonts settle, or the width changes
                onresize: move |_| dom::autosize(BOX, 0.4),
                if !list.is_empty() {
                    div { class: "attach-row no-scrollbar",
                        for a in list {
                            Chip { key: "{a.id}", a: a.clone(), host: host.clone(), pane: pane.clone() }
                        }
                    }
                }
                textarea {
                    id: BOX,
                    class: "composer-text",
                    rows: "1",
                    value: "{text}",
                    disabled: offline,
                    placeholder: "{placeholder}",
                    "aria-label": "Message {agent}",
                    oninput: on_input,
                    onkeydown: on_key,
                    onfocus: move |_| focused.set(true),
                    onblur: move |_| focused.set(false),
                }
                div { class: "composer-bar",
                    ToolButton { label: "Attach files", onpress: move |_| files::pick(PICK_FILES), Glyph { icon: Icon::Paperclip, size: 17 } }
                    if touch {
                        ToolButton { label: "Take a photo", onpress: move |_| files::pick(PICK_PHOTO), Glyph { icon: Icon::Camera, size: 17 } }
                    }
                    if !controls.is_empty() {
                        span { class: "composer-controls mono truncate", title: "Model, effort and mode", "{controls}" }
                    }
                    span { class: "composer-note truncate", "{note}" }
                    button {
                        class: match mode {
                            Button::Stop => "send-button press send-stop",
                            _ if can_send => "send-button press send-ready",
                            _ => "send-button press",
                        },
                        r#type: "button",
                        "aria-label": label,
                        title,
                        disabled: if mode == Button::Stop { stopping() } else { !can_send },
                        onmousedown: move |e| e.prevent_default(),
                        onclick: move |_| if mode == Button::Stop { stop() } else { do_send() },
                        span { key: "{label}", class: "fade-in send-icon",
                            if mode == Button::Stop {
                                Glyph { icon: Icon::Square, size: 12, class: "fill" }
                            } else {
                                Glyph { icon: Icon::ArrowUp, size: 17 }
                            }
                        }
                    }
                }
            }
            input {
                id: PICK_FILES,
                r#type: "file",
                multiple: true,
                hidden: true,
                tabindex: "-1",
                onchange: {
                    let (host, pane) = (host.clone(), pane.clone());
                    move |_| add_files(&host, &pane, files::picked(PICK_FILES), None)
                },
            }
            input {
                id: PICK_PHOTO,
                r#type: "file",
                accept: "image/*",
                "capture": "environment",
                hidden: true,
                tabindex: "-1",
                onchange: {
                    let (host, pane) = (host.clone(), pane.clone());
                    move |_| add_files(&host, &pane, files::picked(PICK_PHOTO), None)
                },
            }
        }
    }
}

/// One attachment above the text: an image's thumbnail or a file's name and size, its progress
/// while it uploads, a red ring to try again when it failed, and × to take it off.
#[component]
fn Chip(a: Attachment, host: String, pane: String) -> Element {
    let key = inyon_protocol::chat_key(&host, &pane);
    let failed = a.status == Status::Error;
    let id = a.id.clone();
    let status = match a.status {
        Status::Uploading => "uploading",
        Status::Done => "done",
        Status::Error => "error",
    };
    rsx! {
        div { class: "attach fade-in", "data-status": status,
            if let Some(src) = a.preview.clone() {
                div { class: "attach-thumb",
                    img { src: "{src}", alt: "{a.name}" }
                    if failed {
                        div { class: "attach-thumb-cover", Glyph { icon: Icon::RotateCw, size: 16 } }
                    }
                    if a.status == Status::Uploading {
                        div { class: "attach-shade" }
                        div { class: "attach-bar",
                            div { class: "attach-bar-fill", style: "transform: scaleX({a.progress})" }
                        }
                    }
                }
            } else {
                div { class: "attach-file",
                    if failed {
                        Glyph { icon: Icon::RotateCw, size: 16, class: "attach-error-icon" }
                    } else {
                        Glyph { icon: Icon::FileText, size: 16, class: "attach-file-icon" }
                    }
                    div { class: "attach-text",
                        div { class: "attach-name truncate", "{a.title()}" }
                        div { class: "attach-detail truncate", "{a.detail()}" }
                    }
                }
            }
            if failed {
                button {
                    class: "attach-retry",
                    r#type: "button",
                    "aria-label": "Retry {a.name}",
                    title: "{a.retry_title()}",
                    onmousedown: move |e| e.prevent_default(),
                    onclick: {
                        let id = id.clone();
                        move |_| retry_file(&host, &pane, &id)
                    },
                }
            }
            button {
                class: "attach-remove",
                r#type: "button",
                "aria-label": "Remove {a.name}",
                onclick: move |_| remove_file(&key, &id),
                Glyph { icon: Icon::X, size: 12 }
            }
        }
    }
}

/// A small round button in the box's bar.
#[component]
fn ToolButton(label: &'static str, onpress: EventHandler<()>, children: Element) -> Element {
    rsx! {
        button {
            class: "composer-tool",
            r#type: "button",
            "aria-label": label,
            title: label,
            onmousedown: move |e| e.prevent_default(),
            onclick: move |_| onpress.call(()),
            {children}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_button_sends_queues_or_stops() {
        assert_eq!(button(false, true, false), Button::Send);
        assert_eq!(button(false, false, false), Button::Send);
        assert_eq!(button(true, true, false), Button::Queue);
        assert_eq!(button(true, false, false), Button::Stop);
        // a file still uploading (or failed) holds the message: no Stop in its place
        assert_eq!(button(true, false, true), Button::Queue);
    }

    #[test]
    fn a_draft_from_elsewhere_waits_while_you_edit() {
        // the terminal typed something new and the box is as last synced: it takes it
        assert!(adopt("fix the tests", "", "", false));
        assert!(adopt("fix the tests", "fix", "fix", true));
        // you're mid-edit with other text: yours stays
        assert!(!adopt("fix the tests", "fix", "fix the build", true));
        // the same text the box last sent back: nothing to do
        assert!(!adopt("fix", "fix", "", false));
    }
}
