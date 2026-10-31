//! A session's screen (PanePage.tsx and SessionHeader.tsx): the header with the agent, the title,
//! where the pane is and its state, then the chat. Opening it follows the chat's `/ws2` stream from
//! where this app left it; leaving stops following it. The terminal view isn't in this app yet, so
//! Terminal opens the web app's.

use dioxus::prelude::*;
use inyon_chat_core::format::model_name;
use inyon_chat_core::overview::{all_panes, pane_href, pane_title, terminal_name, PaneView};
use inyon_chat_core::store::{ReplyFontSetting, Settings, ToolDetail};
use inyon_protocol::{chat_key, AgentDef, AgentKind, ClientMsg2, ReplyFont, SkinTokens};

use super::chat::ChatView;
use super::icons::{AgentMark, Glyph, Icon};
use super::outbox;
use super::rows::Ctx;
use crate::model::Shown;
use crate::state::{self, Chats, Hub};
use crate::{dom, format, platform};

/// "Opus 4.8 · high · Plan": the model, effort and mode, as far as they're known.
pub fn controls_line(model: Option<&str>, effort: Option<&str>, mode: Option<&str>, def: Option<&AgentDef>) -> String {
    let mode = mode.filter(|m| !m.is_empty()).map(|m| def.and_then(|d| d.modes.iter().find(|o| o.id == m)).map_or(m.to_string(), |o| o.label.clone()));
    [Some(model_name(model)), effort.map(str::to_string), mode].into_iter().flatten().filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" · ")
}

/// The reply font's class: the setting, or the agent's own when it's on Auto.
pub fn font_class(setting: ReplyFontSetting, def: Option<&AgentDef>) -> &'static str {
    let font = match setting {
        ReplyFontSetting::Serif => ReplyFont::Serif,
        ReplyFontSetting::Sans => ReplyFont::Sans,
        ReplyFontSetting::Mono => ReplyFont::Mono,
        ReplyFontSetting::Auto => def.map_or(ReplyFont::Sans, |d| d.reply_font),
    };
    match font {
        ReplyFont::Serif => "reply-serif",
        ReplyFont::Mono => "reply-mono",
        ReplyFont::Sans => "",
    }
}

fn skin_vars(t: &SkinTokens) -> String {
    let pairs = [
        ("bg", &t.bg),
        ("panel", &t.panel),
        ("raised", &t.raised),
        ("hover", &t.hover),
        ("line", &t.line),
        ("line-strong", &t.line_strong),
        ("fg", &t.fg),
        ("fg-2", &t.fg2),
        ("fg-3", &t.fg3),
        ("accent", &t.accent),
        ("accent-fg", &t.accent_fg),
        ("accent-soft", &t.accent_soft),
        ("accent-text", &t.accent_text),
        ("bubble", &t.bubble),
        ("code", &t.code),
    ];
    pairs.iter().map(|(k, v)| format!("--{k}:{v};")).collect()
}

/// The agent's skin for everything inside the session (lib/skin.tsx), light and dark, so it follows
/// the theme as it changes.
pub fn skin_css(kind: AgentKind) -> String {
    let s = &kind.def().skin;
    let k = kind.as_str();
    format!(".skin-{k}{{{}background:var(--bg);color:var(--fg)}}[data-theme='dark'] .skin-{k}{{{}}}", skin_vars(&s.light), skin_vars(&s.dark))
}

fn settings() -> Settings {
    platform::load("inyon.settings.v2").map(|s| Settings::load(&s)).unwrap_or_default()
}

#[component]
pub fn Session(host: String, pane: String, terminal: bool) -> Element {
    let hub = use_context::<Signal<Hub>>();
    let mut chats = use_context::<Signal<Chats>>();
    let out = outbox();
    let key = chat_key(&host, &pane);
    let settings = use_hook(settings);

    // follow the chat while it's on screen, from where this app left it
    {
        let (key, out) = (key.clone(), out.clone());
        use_hook(move || {
            let mut c = chats.write();
            let e = c.entry(&key);
            e.followed = true;
            if hub.peek().connected {
                out.send(state::wire2(&ClientMsg2::Sub { stream: key.clone(), at: e.chat.position() }));
            }
        });
    }
    {
        let (key, out) = (key.clone(), out.clone());
        use_drop(move || {
            if let Some(e) = chats.write().map.get_mut(&key) {
                e.followed = false;
            }
            out.send(state::wire2(&ClientMsg2::Unsub { stream: key.clone() }));
        });
    }
    // this app has no terminal yet: ?view=terminal goes to the web app's
    let terminal_href = pane_href(&host, &pane, Some(PaneView::Terminal));
    if terminal {
        dom::go(&terminal_href);
    }

    let h = hub.read();
    let c = chats.read();
    let info = c.get(&key).and_then(|e| e.chat.info.clone());
    let screen = c.get(&key).and_then(|e| e.chat.screen.clone());
    let refs = all_panes(&h.hosts);
    let r = refs.iter().find(|r| r.host.config.id == host && r.pane.id == pane);
    let agent_info = r.and_then(|r| r.pane.agent.as_ref());
    let agent: Option<AgentKind> = agent_info.map(|a| a.kind).or(info.as_ref().and_then(|i| i.agent));
    let def = agent.map(|k| k.def());
    let agent_name = agent_info.and_then(|a| a.custom.clone()).or(def.map(|d| d.name.clone())).unwrap_or_else(|| "the agent".into());
    let title = r
        .and_then(|r| r.pane.label.clone().filter(|l| !l.is_empty()).or_else(|| (r.pane.companion == Some(true)).then(|| "Companion".into())))
        .or_else(|| info.as_ref().and_then(|i| i.title.clone()).filter(|t| !t.is_empty()))
        .or_else(|| r.map(|r| if r.pane.agent.is_some() { pane_title(r) } else { terminal_name(r).map_or_else(|| pane_title(r), str::to_string) }))
        .unwrap_or_else(|| "Session".into());
    let cwd = info.as_ref().and_then(|i| i.cwd.clone()).or(r.map(|r| r.pane.cwd.clone()));
    let subtitle = [
        Some(def.map_or("Terminal".to_string(), |d| d.name.clone())),
        r.map(|r| r.host.config.name.clone()),
        r.map(|r| format!("{}:{}", r.session.name, r.window.index)),
        cwd.map(|p| format::short_path(&p, 28)).filter(|p| !p.is_empty()),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join(" · ");
    let shown = r.and_then(|r| r.pane.agent.as_ref().map(|a| Shown::of(a, r.host)));
    let controls = controls_line(
        screen.as_ref().and_then(|s| s.model.as_deref()).or(info.as_ref().and_then(|i| i.model.as_deref())),
        screen.as_ref().and_then(|s| s.effort.as_deref()),
        screen.as_ref().and_then(|s| s.mode.as_deref()).or(info.as_ref().and_then(|i| i.mode.as_deref())),
        def,
    );
    let gone = h.loaded && r.is_none() && info.is_none();
    let skin = agent.filter(|_| settings.agent_skins);
    let ctx = Ctx {
        key: key.clone(),
        host: host.clone(),
        pane: pane.clone(),
        agent,
        agent_name: agent_name.clone(),
        font: font_class(settings.reply_font, def),
        all_tools: settings.tool_detail != ToolDetail::Compact,
    };
    let connected = h.connected && r.is_none_or(|r| r.host.status == inyon_protocol::HostStatus::Online);
    dom::set_title(&format!("{title} · Inyon"));
    drop(c);
    drop(h);

    rsx! {
        if let Some(kind) = skin {
            style { {skin_css(kind)} }
        }
        div { class: match skin { Some(k) => format!("session skin-{}", k.as_str()), None => "session".into() },
            header { class: "session-head",
                div { class: "session-head-row",
                    a { class: "back-link press", href: "/next/", "aria-label": "Back",
                        Glyph { icon: Icon::ChevronLeft, size: 20 }
                    }
                    if let Some(kind) = agent {
                        span { class: "session-logo", AgentMark { kind, size: 26 } }
                    }
                    div { class: "session-titles",
                        h1 { class: "session-title",
                            if let Some(s) = shown {
                                span { class: "dot dot-{s.class()} phone-dot" }
                            }
                            span { class: "truncate", "{title}" }
                        }
                        p { class: "session-sub mono truncate", "{subtitle}" }
                    }
                    if let Some(s) = shown {
                        span { class: "pill session-pill",
                            span { class: "dot dot-{s.class()}" }
                            "{s.label()}"
                        }
                    }
                    nav { class: "segmented session-views", "aria-label": "View",
                        span { class: "segment segment-on", "aria-current": "page",
                            Glyph { icon: Icon::MessageSquare, size: 14 }
                            span { class: "segment-word", "Chat" }
                        }
                        // the terminal opens in the web app until this one has it
                        a { class: "segment", href: "{terminal_href}", title: "Terminal (opens in the current app)",
                            Glyph { icon: Icon::SquareTerminal, size: 14 }
                            span { class: "segment-word", "Terminal" }
                        }
                    }
                }
            }
            if gone {
                div { class: "chat-column",
                    div { class: "empty chat-empty",
                        div { class: "empty-title", "This pane is gone" }
                        div { class: "empty-text", "Its tmux pane closed, or its machine no longer lists it." }
                        a { class: "button button-md button-primary press empty-action", href: "/next/", "Back to the Overview" }
                    }
                }
            } else {
                ChatView { ctx, connected, controls }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_controls_read_as_one_line() {
        let claude = AgentKind::Claude.def();
        assert_eq!(controls_line(Some("claude-opus-4-6"), Some("high"), None, Some(claude)), "Opus 4.6 · high");
        assert_eq!(controls_line(None, None, None, None), "");
        let mode = claude.modes.first().expect("Claude Code has modes");
        assert_eq!(controls_line(None, None, Some(&mode.id), Some(claude)), mode.label);
        assert_eq!(controls_line(None, None, Some("custom"), None), "custom");
    }

    #[test]
    fn replies_keep_their_agents_font() {
        let claude = AgentKind::Claude.def();
        assert_eq!(font_class(ReplyFontSetting::Auto, Some(claude)), "reply-serif");
        assert_eq!(font_class(ReplyFontSetting::Mono, Some(claude)), "reply-mono");
        assert_eq!(font_class(ReplyFontSetting::Auto, None), "");
    }

    #[test]
    fn a_skin_covers_both_themes() {
        let css = skin_css(AgentKind::Claude);
        let s = &AgentKind::Claude.def().skin;
        assert!(css.starts_with(".skin-claude{"), "{css}");
        assert!(css.contains(&format!("--accent:{};", s.light.accent)));
        assert!(css.contains(&format!("[data-theme='dark'] .skin-claude{{--bg:{};", s.dark.bg)));
    }
}
