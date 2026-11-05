//! The conversation (ChatView.tsx): a virtualized list of chat-core's rows with only the ones near
//! the screen in the page, the message box or the agent's question under it, and ChatView's scroll
//! rules (follow new output at the bottom, keep the row being read in place otherwise, fetch older
//! messages before the reader reaches the top), and what it says when there's no conversation to
//! show: nothing running, an agent read only in its terminal, a machine that's away.

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use dioxus::prelude::*;
use futures_channel::mpsc::{unbounded, UnboundedReceiver, UnboundedSender};
use futures_util::StreamExt;
use inyon_chat_core::overview::{pane_href, PaneView};
use inyon_chat_core::pending::PendingStatus;
use inyon_protocol::{AgentKind, ClientMsg2, HostStatus};

use super::composer::Composer;
use super::icons::{AgentMark, Glyph, Icon};
use super::prompt::PromptCard;
use super::rows::{Ctx, RowView};
use super::toast::{self, ToastTone};
use super::{now, outbox};
use crate::list::{Scroll, Window};
use crate::route::BASE;
use crate::socket::Outbox;
use crate::state::{self, Chats, Hub};
use crate::{api, dom, format, platform};

const SCROLLER: &str = "chat-scroll";
const LIST: &str = "chat-list";
/// Away longer than this, coming back jumps to the latest message.
const AWAY_MS: f64 = 5.0 * 60_000.0;
/// How long a machine that isn't answering counts as reconnecting rather than offline.
pub const RECONNECT_GRACE_MS: u32 = 15_000;

thread_local! {
    static LISTENING: Cell<bool> = const { Cell::new(false) };
    /// the chats on screen, told how long the app was out of sight each time it comes back
    static BACKS: RefCell<Vec<UnboundedSender<f64>>> = const { RefCell::new(Vec::new()) };
}

/// Hears the app coming back into view: how long it was out of sight, each time. A channel
/// rather than a signal, so the chat's task wakes for it at once.
fn listen() -> UnboundedReceiver<f64> {
    if !LISTENING.with(|l| l.replace(true)) {
        dom::on_wake(|| {
            let gone = dom::away_ms();
            // a chat that has closed drops its end
            BACKS.with(|b| b.borrow_mut().retain(|tx| tx.unbounded_send(gone).is_ok()));
        });
    }
    let (tx, rx) = unbounded();
    BACKS.with(|b| b.borrow_mut().push(tx));
    rx
}

/// Whether coming back after `away` ms shows the latest message rather than where you were.
pub fn back_jumps(away: f64) -> bool {
    away > AWAY_MS
}

/// What the line over the message box says about the connection, if anything.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinkLine {
    /// this page lost the hub
    Hub,
    /// the machine dropped a moment ago and is most likely coming back by itself
    Machine(String),
    /// the machine has been away a while
    Offline(String),
}

/// `hub`: this page's link to the hub is up. `machine`: the machine's name and whether it's
/// online, when the hub lists it. `fresh`: the chat opened, came back into view or lost the
/// machine in the last few seconds.
pub fn link_line(hub: bool, machine: Option<(&str, bool)>, fresh: bool) -> Option<LinkLine> {
    match machine {
        _ if !hub => Some(LinkLine::Hub),
        Some((name, false)) if fresh => Some(LinkLine::Machine(name.to_string())),
        Some((name, false)) => Some(LinkLine::Offline(name.to_string())),
        _ => None,
    }
}

/// The agents a pane at its shell offers to start: the ones on the machine (Claude Code when it
/// lists none), each once.
pub fn startable(installed: &[AgentKind]) -> Vec<AgentKind> {
    let mut out: Vec<AgentKind> = Vec::new();
    for k in if installed.is_empty() { &[AgentKind::Claude][..] } else { installed } {
        if !out.contains(k) {
            out.push(*k);
        }
    }
    out
}

/// The messages to send again by themselves: each that failed only because the connection dropped
/// (`retryable`) and was on its way before the connection last came back (`back_at`), so a send
/// that spans a reconnect goes again even when its failure lands after it.
pub fn resend_due(pending: &[inyon_chat_core::pending::PendingMessage], back_at: u64) -> Vec<(String, String)> {
    pending.iter().filter(|p| p.status == PendingStatus::Failed && p.retryable && !p.remote && p.at < back_at).map(|p| (p.id.clone(), p.text.clone())).collect()
}

/// How long a start keeps its button busy at most, waiting for the pane to say an agent runs.
const START_WAIT_MS: u64 = 15_000;

/// What each pane is starting (an agent's id, or "resume") and since when, so a second tap, or the
/// card drawn again, can't type the command twice while the first one comes up.
static STARTING: GlobalSignal<std::collections::HashMap<String, (String, u64)>> = Signal::global(std::collections::HashMap::new);

/// Whether the hub says an agent runs in this pane.
fn pane_runs(hub: &Hub, host: &str, pane: &str) -> bool {
    hub.hosts.iter().filter(|m| m.config.id == host).flat_map(|m| &m.sessions).flat_map(|s| &s.windows).flat_map(|w| &w.panes).any(|p| p.id == pane && p.agent.is_some())
}

/// What a pane is still starting at `now`, if anything: a start counts until its pane runs, it
/// fails, or [`START_WAIT_MS`] pass.
pub fn starting(entry: Option<&(String, u64)>, now: u64) -> Option<&str> {
    entry.filter(|(_, at)| now.saturating_sub(*at) < START_WAIT_MS).map(|(what, _)| what.as_str())
}

/// Asks the hub for the messages before the first one this chat has.
fn load_more(chats: Signal<Chats>, key: &str, out: &Outbox) {
    let before = {
        let c = chats.peek();
        let Some(e) = c.get(key) else { return };
        if e.loading_more || !e.chat.has_more {
            return;
        }
        e.chat.items.first().map(|i| i.seq())
    };
    let Some(before) = before else { return };
    let mut c = chats;
    c.write().entry(key).loading_more = true;
    out.send(state::wire2(&ClientMsg2::More { stream: key.to_string(), before }));
}

/// `controls`: the model, effort and mode as one line, for the message box. `connected`:
/// messages can go to the agent; `offline`: the chat says it's reconnecting (not while the first
/// connection is still opening).
#[component]
pub fn ChatView(ctx: Ctx, connected: bool, offline: bool, controls: String) -> Element {
    let chats = use_context::<Signal<Chats>>();
    let out = outbox();
    let key = ctx.key.clone();
    let scroll = use_hook(|| Rc::new(RefCell::new(Scroll::default())));
    let drawn = use_hook(|| Rc::new(Cell::new(Window { start: 0, end: 0, before: 0, after: 0 })));
    let hub = use_context::<Signal<Hub>>();
    let mut layout = use_signal(|| 0u64);
    let mut away = use_signal(|| false);
    // the chat opened, came back into view or lost its machine a moment ago: a machine that isn't
    // answering is most likely on its way back, so the chat says it's reconnecting before it calls
    // it offline
    let mut fresh = use_signal(|| true);
    let grace = use_hook(|| Rc::new(Cell::new(0u64)));
    let restart = {
        let grace = grace.clone();
        move || {
            let g = grace.get() + 1;
            grace.set(g);
            fresh.set(true);
            let grace = grace.clone();
            spawn(async move {
                platform::sleep(RECONNECT_GRACE_MS).await;
                if grace.get() == g {
                    fresh.set(false);
                }
            });
        }
    };
    let backs = use_hook(|| Rc::new(RefCell::new(Some(listen()))));

    // after each change: scroll to the bottom while following, else keep the row being read where
    // it was; and draw the rows that brings into view. The rows a change brings may reach the page
    // only after this runs, and until they do the page is as tall as before, so a bottom set now
    // falls short: the list's own resize sets the place again once they're there.
    let settle = {
        let (scroll, drawn, key) = (scroll.clone(), drawn.clone(), key.clone());
        move || {
            let c = chats.peek();
            let Some(e) = c.get(&key) else { return };
            scroll.borrow_mut().settle(&e.list);
            place(&scroll.borrow());
            if scroll.borrow().window(&e.list) != drawn.get() {
                layout += 1;
            }
        }
    };
    {
        let mut settle = settle.clone();
        use_effect(move || {
            let _ = chats.read();
            settle();
        });
    }
    // open, or back from somewhere else: this session's notification is read; back after a while
    // (the phone in a pocket, another tab), the latest shows rather than where you left off
    {
        let (settle, scroll, restart) = (settle.clone(), scroll.clone(), restart.clone());
        let (host, pane) = (ctx.host.clone(), ctx.pane.clone());
        use_future(move || {
            let (host, pane, scroll, backs) = (host.clone(), pane.clone(), scroll.clone(), backs.clone());
            let (mut settle, mut restart) = (settle.clone(), restart.clone());
            async move {
                let Some(mut rx) = backs.borrow_mut().take() else { return };
                super::notices::clear_notice(&host, &pane);
                restart();
                while let Some(gone) = rx.next().await {
                    super::notices::clear_notice(&host, &pane);
                    restart();
                    if back_jumps(gone) {
                        scroll.borrow_mut().follow();
                        away.set(false);
                        settle();
                    }
                }
            }
        });
    }
    // a send that never landed says so after ten minutes; the web app checks every five seconds
    {
        let key = key.clone();
        use_future(move || {
            let key = key.clone();
            async move {
                loop {
                    platform::sleep(5000).await;
                    let waiting = chats.peek().get(&key).is_some_and(|e| e.chat.pending.iter().any(|p| p.status == PendingStatus::Sent && !p.remote));
                    if waiting {
                        let mut c = chats;
                        c.write().tick(&key, now());
                    }
                }
            }
        });
    }

    let (hub_up, machine) = {
        let h = hub.read();
        let m = h.hosts.iter().find(|m| m.config.id == ctx.host);
        let pane = m.and_then(|m| m.sessions.iter().flat_map(|s| &s.windows).flat_map(|w| &w.panes).find(|p| p.id == ctx.pane));
        let machine = m.map(|m| Machine {
            name: m.config.name.clone(),
            online: m.status == HostStatus::Online,
            agents: m.agents.clone(),
            running: pane.is_some_and(|p| p.agent.is_some()),
            failure: pane.and_then(|p| p.agent.as_ref()?.failure.as_ref()).map(|f| format::failure_text(f, platform::clock())),
        });
        (h.connected, machine)
    };
    let online = machine.as_ref().is_none_or(|m| m.online);
    {
        let mut restart = restart.clone();
        use_effect(use_reactive!(|online| {
            if !online {
                restart();
            }
        }));
    }
    // messages that failed only because the connection dropped go out by themselves once it's
    // back, once: a failure that only looks like a dropped connection would otherwise resend on
    // every reconnect
    {
        let (key, host, pane) = (key.clone(), ctx.host.clone(), ctx.pane.clone());
        // when the connection last came back, and whether it was up at the last look
        let (mut back_at, mut was_up) = (use_signal(|| 0u64), use_signal(|| false));
        // a new failure that may have spanned a reconnect looks again
        let failed = chats.read().get(&key).map(|e| e.chat.pending.iter().filter(|p| p.status == PendingStatus::Failed && p.retryable).count()).unwrap_or(0);
        use_effect(use_reactive!(|connected, failed| {
            let _ = failed;
            if !connected {
                was_up.set(false);
                return;
            }
            if !*was_up.peek() {
                was_up.set(true);
                back_at.set(now());
            }
            let waiting = chats.peek().get(&key).map(|e| resend_due(&e.chat.pending, *back_at.peek())).unwrap_or_default();
            for (id, text) in waiting {
                super::composer::retry(chats, host.clone(), pane.clone(), id, text);
            }
        }));
    }

    let on_scroll = {
        let (scroll, drawn, key, out) = (scroll.clone(), drawn.clone(), key.clone(), out.clone());
        move |_| {
            let Some((top, height, view)) = dom::scroll_metrics(SCROLLER) else { return };
            let offset = dom::offset_top(LIST).unwrap_or(0.0);
            let (r, redraw) = {
                let c = chats.peek();
                let Some(e) = c.get(&key) else { return };
                let r = scroll.borrow_mut().scrolled(&e.list, top - offset, view, height - top - view, platform::clock().now);
                (r, scroll.borrow().window(&e.list) != drawn.get())
            };
            if r.away != *away.peek() {
                away.set(r.away);
            }
            if r.more {
                load_more(chats, &key, &out);
            }
            if redraw {
                layout += 1;
            }
        }
    };
    let input = {
        let scroll = scroll.clone();
        move |up: bool| scroll.borrow_mut().input(platform::clock().now, up)
    };

    let terminal_href = format!("{BASE}{}", pane_href(&ctx.host, &ctx.pane, (super::session::home_view(ctx.agent) != PaneView::Terminal).then_some(PaneView::Terminal)));
    // an agent Inyon doesn't read as chat has no conversation for the hub to load
    let chat_capable = ctx.agent.is_none_or(|k| k.def().chat);
    let c = chats.read();
    let _ = layout();
    let Some(e) = c.get(&key).filter(|_| chat_capable) else {
        return rsx! {
            div { class: "chat",
                div { class: "chat-scroll",
                    div { class: "chat-column",
                        if !chat_capable {
                            TerminalFirst { ctx: ctx.clone(), machine: machine.clone(), terminal_href }
                        } else {
                            Loading { done: None }
                        }
                    }
                }
            }
        };
    };
    let chat = &e.chat;
    let prompt = chat.screen.as_ref().and_then(|s| s.prompt.clone());
    let working = chat.screen.as_ref().is_some_and(|s| s.working);
    // Claude Code's panel for a background shell, open over its input box in the terminal
    let panel = chat.screen.as_ref().and_then(|s| s.dialog.clone()).filter(|_| ctx.agent == Some(inyon_protocol::AgentKind::Claude));
    let running = chat.info.as_ref().is_none_or(|i| i.running);
    let catching_up = chat.catching_up;
    let session_id = chat.info.as_ref().and_then(|i| i.session_id.clone());
    // a question asked before the connection dropped (opened from its alert, say) keeps its
    // buttons, held until the machine is back and its own screen takes over
    let shown_prompt = prompt.clone().or_else(|| if connected { None } else { crate::asks::last(&ctx.host, &ctx.pane) });
    let background = chat.screen.as_ref().is_some_and(|s| s.background.as_ref().is_some_and(|b| b.as_ref().is_some_and(|t| !t.is_empty())));
    // why the last turn stopped, when it ended on an error (a rate limit, signed out)
    let failure = machine.as_ref().and_then(|m| m.failure.clone()).filter(|_| !working && prompt.is_none() && !background);
    // the hub counts as gone only once the app says it's reconnecting, not while the first
    // connection after a load is still opening
    let link = link_line(hub_up || !offline, machine.as_ref().map(|m| (m.name.as_str(), m.online)), fresh());
    let installed = machine.as_ref().map(|m| m.agents.clone()).unwrap_or_default();
    let rows = chat.rows();
    let w = scroll.borrow().window(&e.list);
    drawn.set(w);
    let first_loaded = chat.loaded;
    let has_more = chat.has_more;
    let loading_more = e.loading_more;
    let draft = chat.draft.as_ref().map(|d| (d.text.clone(), d.at, d.source == inyon_protocol::DraftSource::Terminal));
    let shown: Vec<_> = rows[w.start.min(rows.len())..w.end.min(rows.len())].to_vec();

    let (wheel_in, touch_in, touch_move, press_in, key_in) = (input.clone(), input.clone(), input.clone(), input.clone(), input.clone());
    let jump = {
        let mut settle = settle.clone();
        let scroll = scroll.clone();
        move |_| {
            // straight there in one tap: a glide is slow over a long chat and new output cuts it short
            scroll.borrow_mut().follow();
            away.set(false);
            settle();
        }
    };
    let sent = {
        let mut settle = settle.clone();
        let scroll = scroll.clone();
        move |_| {
            scroll.borrow_mut().follow();
            settle();
        }
    };
    let on_resize = {
        let mut settle = settle.clone();
        let scroll = scroll.clone();
        move |_| {
            if let Some((_, _, view)) = dom::scroll_metrics(SCROLLER) {
                scroll.borrow_mut().view = view;
            }
            settle();
        }
    };
    // the list grew or shrank (rows drawn, measured or replaced): back to the bottom while
    // following, or to the row being read
    let on_list_resize = {
        let scroll = scroll.clone();
        move |_| place(&scroll.borrow())
    };
    let more_key = key.clone();
    let more_out = out.clone();
    rsx! {
        div { class: "chat",
            div {
                id: SCROLLER,
                class: "chat-scroll",
                tabindex: "-1",
                onscroll: on_scroll,
                onresize: on_resize,
                onwheel: move |ev: WheelEvent| wheel_in(ev.delta().strip_units().y < 0.0),
                ontouchstart: move |_| touch_in(false),
                // the scrollbar, dragged
                onpointerdown: move |_| press_in(false),
                ontouchmove: move |_| touch_move(false),
                onkeydown: move |ev: KeyboardEvent| key_in(matches!(ev.key(), Key::PageUp | Key::ArrowUp | Key::Home)),
                div { class: "chat-column",
                    if !first_loaded {
                        Loading { done: catching_up }
                    } else if rows.is_empty() && !running {
                        if let Some(text) = failure.clone() {
                            div { class: "line-row chat-failure fade-in", role: "status",
                                span { class: "line-mark", span { class: "dot dot-danger" } }
                                "{text}"
                            }
                        }
                        NotRunning { host: ctx.host.clone(), pane: ctx.pane.clone(), agent: ctx.agent, installed: installed.clone(), session_id: session_id.clone(), terminal_href: terminal_href.clone(), compact: false, online: connected }
                    } else {
                        if has_more {
                            div { class: "chat-earlier",
                                if loading_more {
                                    div { class: "chat-loading", role: "status", "aria-label": "Loading earlier messages",
                                        span { class: "skeleton-line" }
                                        span { class: "skeleton-line skeleton-short" }
                                    }
                                } else {
                                    button {
                                        class: "button button-sm button-ghost press",
                                        r#type: "button",
                                        onclick: move |_| load_more(chats, &more_key, &more_out),
                                        Glyph { icon: Icon::History, size: 16 }
                                        "Earlier messages"
                                    }
                                }
                            }
                        }
                        if rows.is_empty() {
                            div { class: "empty chat-empty",
                                div { class: "empty-title", "New conversation" }
                                div { class: "empty-text", "Messages you send here are typed into the terminal, exactly as if you typed them there." }
                            }
                        }
                        div { id: LIST, class: "chat-list", onresize: on_list_resize,
                            div { style: "height:{w.before}px" }
                            for row in shown {
                                Measured { key: "{row.key()}", id: row.key().into_owned(), chat: key.clone(),
                                    RowView { row: row.clone(), ctx: ctx.clone(), working }
                                }
                            }
                            div { style: "height:{w.after}px" }
                        }
                        if let Some(text) = failure {
                            div { class: "line-row chat-failure fade-in", role: "status",
                                span { class: "line-mark", span { class: "dot dot-danger" } }
                                "{text}"
                            }
                        }
                        if !running {
                            NotRunning { host: ctx.host.clone(), pane: ctx.pane.clone(), agent: ctx.agent, installed, session_id, terminal_href, compact: true, online: connected }
                        }
                    }
                }
            }
            div { class: "chat-foot",
                button {
                    class: if away() { "jump press jump-on" } else { "jump press" },
                    r#type: "button",
                    "aria-label": "Jump to latest",
                    "aria-hidden": "{!away()}",
                    tabindex: if away() { "0" } else { "-1" },
                    onclick: jump,
                    Glyph { icon: Icon::ArrowDown, size: 16 }
                }
                if running {
                    div { class: "chat-foot-column",
                        match link {
                            Some(LinkLine::Hub) => rsx! {
                                div { class: "chat-status fade-in", role: "status", "Reconnecting…"
                                    if !dom::coarse() {
                                        HelpLink { id: None }
                                    }
                                }
                            },
                            Some(LinkLine::Machine(name)) => rsx! {
                                div { class: "chat-status fade-in", role: "status", "Reconnecting to {name}…"
                                    HelpLink { id: Some(ctx.host.clone()) }
                                }
                            },
                            Some(LinkLine::Offline(name)) => rsx! {
                                div { class: "chat-status fade-in",
                                    "{name} is offline. This is the conversation as last seen; you can send again once it reconnects."
                                    HelpLink { id: Some(ctx.host.clone()) }
                                }
                            },
                            None => rsx! {
                                if let Some(title) = panel.filter(|_| shown_prompt.is_none()) {
                                    div { class: "chat-status fade-in", role: "status", {crate::format::panel_text(&title)} }
                                }
                            },
                        }
                        if let Some(p) = shown_prompt {
                            PromptCard { prompt: p, host: ctx.host.clone(), pane: ctx.pane.clone(), disabled: !connected, agent: ctx.agent }
                            div { class: "prompt-why",
                                "{ctx.agent_name} is asking you something. Answer it here, and the model, effort and mode controls come back."
                            }
                        } else {
                            Composer {
                                host: ctx.host.clone(),
                                pane: ctx.pane.clone(),
                                agent: ctx.agent_name.clone(),
                                working,
                                disabled: !connected,
                                offline,
                                draft,
                                controls,
                                on_sent: sent,
                            }
                        }
                    }
                }
            }
        }
    }
}

/// A row in the list, its drawn height noted for the list's spacers.
#[component]
fn Measured(id: String, chat: String, children: Element) -> Element {
    let chats = use_context::<Signal<Chats>>();
    rsx! {
        div {
            class: "vrow",
            onresize: move |r: Event<ResizeData>| {
                let Ok(size) = r.get_border_box_size() else { return };
                let h = size.height;
                if chats.peek().get(&chat).is_some_and(|e| e.list.differs(&id, h)) {
                    let mut c = chats;
                    c.write().entry(&chat).list.measured(&id, h);
                }
            },
            {children}
        }
    }
}

/// Puts the list where the scroll model has it: the bottom while following, else its row.
fn place(s: &Scroll) {
    if s.stick {
        dom::set_scroll_top(SCROLLER, 1e9);
    } else {
        dom::set_scroll_top(SCROLLER, dom::offset_top(LIST).unwrap_or(0.0) + s.top);
    }
}

/// What the overview says about the chat's machine and pane.
#[derive(Debug, Clone, PartialEq)]
struct Machine {
    name: String,
    online: bool,
    /// the agents installed there
    agents: Vec<AgentKind>,
    /// an agent runs in the pane
    running: bool,
    /// why the pane's last turn stopped, as a line
    failure: Option<String>,
}

/// "Loading the conversation", with how far the hub is through reading it when it says.
#[component]
fn Loading(done: Option<f64>) -> Element {
    let label = match done {
        Some(d) => format!("Loading the conversation · {}%", (d * 100.0).round()),
        None => "Loading the conversation".into(),
    };
    rsx! {
        div { class: "chat-loading chat-loading-first fade-in", role: "status",
            span { class: "skeleton-line" }
            span { class: "skeleton-line skeleton-short" }
            span { class: "skeleton-line" }
            span { class: "chat-loading-label", "{label}" }
        }
    }
}

/// "Can't connect?" after a line about the connection.
#[component]
fn HelpLink(id: Option<String>) -> Element {
    rsx! {
        button { class: "help-link", r#type: "button", onclick: move |_| super::connect::open_connect_help(id.clone()), "Can't connect?" }
    }
}

/// An agent Inyon reads only in its terminal: what runs there, or the pane at its shell.
#[component]
fn TerminalFirst(ctx: Ctx, machine: Option<Machine>, terminal_href: String) -> Element {
    // its chat info says nothing; the pane says whether it runs
    if machine.as_ref().is_some_and(|m| !m.running) {
        let online = machine.as_ref().is_some_and(|m| m.online);
        let installed = machine.map(|m| m.agents).unwrap_or_default();
        return rsx! {
            NotRunning { host: ctx.host, pane: ctx.pane, agent: ctx.agent, installed, session_id: None, terminal_href, compact: false, online }
        };
    }
    let name = ctx.agent_name;
    rsx! {
        div { class: "empty chat-empty",
            if let Some(kind) = ctx.agent {
                div { class: "empty-icon", AgentMark { kind, size: 28 } }
            }
            div { class: "empty-title", "{name} runs in the terminal" }
            div { class: "empty-text", "Inyon doesn't read {name}'s conversation files yet, so use the terminal view. Status and notifications still work." }
            a { class: "button button-md button-primary press empty-action", href: "{terminal_href}",
                Glyph { icon: Icon::SquareTerminal, size: 16 }
                "Open terminal"
            }
        }
    }
}

/// "No agent is running in this pane", with its way back: resume the conversation, start an
/// agent, or the terminal. `compact`: a card under the conversation that ended. `online`: the
/// machine can be reached; until it can, nothing starts.
#[component]
fn NotRunning(
    host: String,
    pane: String,
    agent: Option<AgentKind>,
    installed: Vec<AgentKind>,
    session_id: Option<String>,
    terminal_href: String,
    compact: bool,
    online: bool,
) -> Element {
    let hub = use_context::<Signal<Hub>>();
    let key = inyon_protocol::chat_key(&host, &pane);
    // a start in flight holds every button, here and wherever this pane's card shows, until the
    // pane says an agent runs, the start fails, or the wait runs out
    let busy = starting(STARTING.read().get(&key), now()).map(str::to_string);
    let start = {
        let key = key.clone();
        move |kind: AgentKind, resume: Option<String>| {
            let (host, pane, key) = (host.clone(), pane.clone(), key.clone());
            if starting(STARTING.peek().get(&key), now()).is_some() {
                return;
            }
            let what = if resume.is_some() { "resume".to_string() } else { kind.as_str().to_string() };
            let began = now();
            STARTING.write().insert(key.clone(), (what, began));
            // spawned at the root, so the wait goes on after this card goes
            dioxus::core::spawn_forever(async move {
                if let Err(e) = api::start(&host, &pane, kind, resume.as_deref()).await {
                    STARTING.write().remove(&key);
                    toast::toast("Could not start", Some(e.message), ToastTone::Error);
                    return;
                }
                while now().saturating_sub(began) < START_WAIT_MS && !pane_runs(&hub.peek(), &host, &pane) {
                    platform::sleep(250).await;
                }
                STARTING.write().remove(&key);
            });
        }
    };
    let resume = session_id.zip(agent);
    let kinds = startable(&installed);
    let held = busy.is_some() || !online;
    let is_busy = move |what: &str| busy.as_deref() == Some(what);
    rsx! {
        div { class: if compact { "not-running not-running-card" } else { "not-running" },
            p { class: "not-running-title", "No agent is running in this pane" }
            p { class: "not-running-text", "The session ended or the pane is at a shell prompt." }
            div { class: "not-running-actions",
                if let Some((id, kind)) = resume {
                    button {
                        class: "button button-md button-primary press",
                        r#type: "button",
                        disabled: held,
                        onclick: {
                            let start = start.clone();
                            move |_| start(kind, Some(id.clone()))
                        },
                        if is_busy("resume") {
                            super::kit::Busy { on: true }
                        } else {
                            Glyph { icon: Icon::History, size: 16 }
                        }
                        "Resume conversation"
                    }
                }
                for kind in kinds {
                    button {
                        key: "{kind.as_str()}",
                        class: "button button-md button-quiet press",
                        r#type: "button",
                        disabled: held,
                        onclick: {
                            let start = start.clone();
                            move |_| start(kind, None)
                        },
                        if is_busy(kind.as_str()) {
                            super::kit::Busy { on: true }
                        } else {
                            AgentMark { kind, size: 16, decorative: true }
                        }
                        "Start {kind.def().name}"
                    }
                }
                a { class: "button button-md button-ghost press", href: "{terminal_href}",
                    Glyph { icon: Icon::SquareTerminal, size: 16 }
                    "Terminal"
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coming_back_after_five_minutes_jumps_to_the_latest() {
        assert!(!back_jumps(0.0));
        assert!(!back_jumps(AWAY_MS));
        assert!(back_jumps(AWAY_MS + 1.0));
    }

    #[test]
    fn a_machine_that_just_dropped_is_reconnecting_then_offline() {
        assert_eq!(link_line(true, Some(("studio", true)), true), None);
        assert_eq!(link_line(true, None, false), None);
        assert_eq!(link_line(false, Some(("studio", true)), false), Some(LinkLine::Hub));
        assert_eq!(link_line(false, Some(("studio", false)), true), Some(LinkLine::Hub));
        assert_eq!(link_line(true, Some(("studio", false)), true), Some(LinkLine::Machine("studio".into())));
        assert_eq!(link_line(true, Some(("studio", false)), false), Some(LinkLine::Offline("studio".into())));
    }

    #[test]
    fn a_send_that_spans_a_reconnect_goes_again_by_itself() {
        use inyon_chat_core::pending::PendingMessage;
        let failed = |id: &str, at: u64, retryable: bool| PendingMessage { retryable, ..PendingMessage::new(id, id, PendingStatus::Failed, at) };
        let pending = [failed("before", 100, true), failed("after", 300, true), failed("tapped", 100, false), PendingMessage::new("sent", "sent", PendingStatus::Sent, 100)];
        // the connection came back at 200: the send from before it goes again, even if it failed later
        assert_eq!(resend_due(&pending, 200), [("before".to_string(), "before".to_string())]);
        // back again at 400: both
        assert_eq!(resend_due(&pending, 400).len(), 2);
    }

    #[test]
    fn a_start_holds_its_buttons_until_it_fails_or_the_wait_runs_out() {
        let e = ("claude".to_string(), 1_000);
        assert_eq!(starting(Some(&e), 1_500), Some("claude"));
        assert_eq!(starting(Some(&e), 1_000 + START_WAIT_MS - 1), Some("claude"));
        assert_eq!(starting(Some(&e), 1_000 + START_WAIT_MS), None);
        assert_eq!(starting(None, 0), None);
    }

    #[test]
    fn a_shell_offers_each_installed_agent_once_and_claude_code_when_none_is_listed() {
        assert_eq!(startable(&[]), [AgentKind::Claude]);
        assert_eq!(startable(&[AgentKind::Codex, AgentKind::Claude, AgentKind::Codex]), [AgentKind::Codex, AgentKind::Claude]);
    }
}
