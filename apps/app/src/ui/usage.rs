//! The session's Usage panel (session/Usage.tsx UsagePanel): the context window, plan limits,
//! cost, time, lines changed, Remote Control and the session's details with copy buttons.

use dioxus::prelude::*;
use inyon_chat_core::format as f;
use inyon_protocol::{AgentKind, AgentStatus, ChatInfo, MappedBy, StaleContext, StaleLimits};

use super::icons::{Glyph, Icon};
use super::md::CopyButton;
use crate::{model, platform};

/// Agents whose cost isn't theirs to report.
pub fn shows_cost(agent: Option<AgentKind>) -> bool {
    !matches!(agent, Some(AgentKind::Codex | AgentKind::Gemini | AgentKind::Antigravity | AgentKind::Copilot))
}

/// The context window, from whichever is newer: the agent's live status, or the transcript (which
/// knows about a compaction the moment it lands).
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Context {
    pub size: Option<f64>,
    pub used: Option<f64>,
    pub pct: Option<f64>,
    pub compacted: bool,
}

pub fn context_of(status: Option<&AgentStatus>, info: Option<&ChatInfo>) -> Context {
    let size = status.and_then(|s| s.context_size).map(|n| n.0).filter(|n| *n > 0.0);
    let stats = info.map(|i| &i.stats);
    let transcript_newer = stats.and_then(|s| s.context_at).is_some_and(|at| status.is_none_or(|s| at as f64 > s.updated_at as f64 + 2000.0));
    let live = status.is_some_and(|s| s.context_used.is_some()) && !transcript_newer;
    let used = if live {
        status.and_then(|s| s.context_used).map(|n| n.0)
    } else {
        stats.and_then(|s| s.context_tokens).map(|n| n.0).or(if transcript_newer { None } else { status.and_then(|s| s.context_used).map(|n| n.0) })
    };
    let pct = match (live, status.and_then(|s| s.context_pct)) {
        (true, Some(p)) => Some(p.0),
        _ => match (used, size) {
            (Some(u), Some(s)) if u > 0.0 => Some((u / s * 100.0).min(100.0)),
            _ => None,
        },
    };
    let compacted = match stats {
        Some(s) if s.compacted_at.is_some() && s.compacted_at == s.context_at => true,
        _ => status.and_then(|s| s.stale.as_ref()).and_then(|s| s.context) == Some(StaleContext::Compacted),
    };
    Context { size, used, pct, compacted }
}

/// "12k / 200k", or the count alone when the window's size isn't known.
fn context_line(c: &Context) -> String {
    match c.size {
        Some(s) => format!("{} / {}", f::tokens(c.used), f::tokens(Some(s))),
        None => f::tokens(c.used),
    }
}

/// What the "Matched by" row says about how the pane was tied to its conversation.
fn matched_by(m: Option<MappedBy>) -> Option<&'static str> {
    m.map(|m| match m {
        MappedBy::Hook => "Integration hook (exact)",
        MappedBy::Process => "Open conversation (exact)",
        MappedBy::Resume => "Resume flag",
        MappedBy::Cwd => "Folder (best guess)",
    })
}

/// The details rows: label and value, only those known.
pub fn details(status: Option<&AgentStatus>, info: Option<&ChatInfo>) -> Vec<(&'static str, String)> {
    let s = |f: fn(&AgentStatus) -> Option<String>| status.and_then(f);
    let i = |f: fn(&ChatInfo) -> Option<String>| info.and_then(f);
    [
        ("Model", s(|s| s.model.clone()).or(i(|i| i.model.clone()))),
        ("Effort", s(|s| s.effort.clone())),
        ("Fast mode", s(|s| s.fast.map(|on| if on { "On".into() } else { "Off".into() }))),
        ("Output style", s(|s| s.output_style.clone())),
        ("Version", s(|s| s.version.clone()).or(i(|i| i.version.clone()))),
        ("Branch", i(|i| i.git_branch.clone())),
        ("Folder", i(|i| i.cwd.clone())),
        ("Session", i(|i| i.session_id.clone())),
        ("Shared link", i(|i| i.share.clone())),
        ("Matched by", info.and_then(|i| matched_by(i.mapped_by)).map(str::to_string)),
    ]
    .into_iter()
    .filter_map(|(k, v)| v.filter(|v| !v.is_empty()).map(|v| (k, v)))
    .collect()
}

#[component]
fn Meter(pct: f64, #[props(default)] class: String) -> Element {
    let v = pct.clamp(0.0, 100.0);
    rsx! {
        span { class: "meter {class}",
            span { class: "meter-fill meter-{model::meter_tone(v)}", style: "transform: scaleX({v / 100.0})" }
        }
    }
}

#[component]
fn RateRow(label: String, window: Option<inyon_protocol::RateWindow>) -> Element {
    let clock = platform::clock();
    let Some(w) = f::live_window(window.as_ref(), clock.now) else { return rsx! {} };
    let tone = if w.pct >= 85.0 {
        "fg-danger"
    } else if w.pct >= 60.0 {
        "fg-warn"
    } else {
        ""
    };
    rsx! {
        div { class: "usage-rate",
            div { class: "usage-rate-head",
                span { class: "usage-rate-label", "{label}" }
                span { class: "tabular usage-rate-pct {tone}", "{w.pct.round()}%" }
            }
            Meter { pct: w.pct }
            if w.reset {
                div { class: "usage-note", "Reset · the new window shows after the next reply" }
            } else if w.resets_at.is_some() {
                div { class: "usage-note", {format!("{} · {}", f::resets_in(w.resets_at, clock.now), f::reset_clock(w.resets_at, clock.now, clock.tz_minutes))} }
            }
        }
    }
}

#[component]
fn Stat(icon: Option<Icon>, label: String, value: Element, #[props(default)] sub: Option<Element>) -> Element {
    rsx! {
        div { class: "usage-stat",
            div { class: "usage-stat-label",
                if let Some(i) = icon {
                    Glyph { icon: i, size: 14 }
                } else {
                    span { class: "mono", "±" }
                }
                "{label}"
            }
            div { class: "tabular usage-stat-value", {value} }
            if let Some(s) = sub {
                div { class: "usage-stat-sub truncate", {s} }
            }
        }
    }
}

fn lines(added: Option<f64>, removed: Option<f64>) -> Element {
    if added.is_none() && removed.is_none() {
        return rsx! { "—" };
    }
    rsx! {
        span { class: "fg-ok", "+{added.unwrap_or(0.0)}" }
        " "
        span { class: "fg-danger", "−{removed.unwrap_or(0.0)}" }
    }
}

/// Context window, plan limits, cost, time and session details. `on_compact` adds Compact now
/// for an agent that can.
#[component]
pub fn UsagePanel(status: Option<AgentStatus>, info: Option<ChatInfo>, agent: Option<AgentKind>, #[props(default)] on_compact: Option<EventHandler<()>>) -> Element {
    // the countdowns move on
    let mut tick = use_signal(|| 0u32);
    use_future(move || async move {
        loop {
            platform::sleep(30_000).await;
            *tick.write() += 1;
        }
    });
    let _ = tick();
    let (st, inf) = (status.as_ref(), info.as_ref());
    let ctx = context_of(st, inf);
    let stats = inf.map(|i| &i.stats);
    let pick = |a: Option<inyon_protocol::Num>, b: Option<inyon_protocol::Num>| a.or(b).map(|n| n.0);
    let cost = pick(st.and_then(|s| s.cost_usd), stats.and_then(|s| s.cost_usd));
    let dur = pick(st.and_then(|s| s.duration_ms), stats.and_then(|s| s.duration_ms)).filter(|d| *d > 0.0);
    let added = pick(st.and_then(|s| s.lines_added), stats.and_then(|s| s.lines_added));
    let removed = pick(st.and_then(|s| s.lines_removed), stats.and_then(|s| s.lines_removed));
    let has_limits = st.is_some_and(|s| s.five_hour.is_some() || s.seven_day.is_some());
    let account_changed = st.and_then(|s| s.stale.as_ref()).and_then(|s| s.limits) == Some(StaleLimits::Account);
    let now = platform::clock().now;
    let started = stats.and_then(|s| s.started_at.clone());
    let running = dur.map(f::duration).or(started.map(|s| f::since(s, now))).unwrap_or_else(|| "—".into());
    let compactions = stats.map_or(0, |s| s.compactions);
    let turns = stats.map_or(0, |s| s.turns);
    let rc = inf.and_then(|i| i.rc.as_ref()).map(|r| r.url.clone());
    let rc_word = if agent == Some(AgentKind::Antigravity) { "Open in Antigravity" } else { "Open on claude.ai" };
    let api_time = st.and_then(|s| s.api_duration_ms).map(|n| n.0).filter(|n| *n > 0.0);
    let rows = details(st, inf);
    let credits = st.and_then(|s| s.credits.clone());
    let plan = st.and_then(|s| s.plan.clone());
    let pct_line = match ctx.pct {
        Some(p) => format!("{}% used", p.round()),
        None if ctx.compacted => "Compacted · size shows after the next reply".into(),
        None => "No usage reported yet".into(),
    };
    rsx! {
        div { class: "usage",
            section { class: "usage-card",
                div { class: "usage-card-head",
                    Glyph { icon: Icon::Gauge, size: 16, class: "fg-3" }
                    span { class: "usage-card-title", "Context window" }
                    span { class: "tabular usage-card-side", {context_line(&ctx)} }
                }
                Meter { pct: ctx.pct.unwrap_or(0.0), class: "usage-meter" }
                div { class: "usage-card-foot",
                    span { class: "tabular", "{pct_line}" }
                    if compactions > 0 {
                        span { class: "usage-compactions",
                            "· "
                            Glyph { icon: Icon::Layers, size: 12 }
                            " compacted {compactions}×"
                        }
                    }
                    if let Some(c) = on_compact {
                        button { class: "usage-compact press", r#type: "button", onclick: move |_| c.call(()), "Compact now" }
                    }
                }
            }
            if account_changed && !has_limits {
                section { class: "usage-card usage-card-text",
                    div { class: "usage-card-title", "Plan limits" }
                    "Signed in to a different account since the last report. Its limits show after the next reply."
                }
            }
            if has_limits || credits.is_some() {
                section { class: "usage-card usage-limits",
                    div { class: "usage-limits-head",
                        "Plan limits"
                        if let Some(p) = plan {
                            span { class: "usage-plan", "{p}" }
                        }
                        if let Some(c) = credits {
                            span { class: "usage-credits",
                                {format!("Credits: {}", if c.unlimited == Some(true) { "unlimited".to_string() } else { c.balance.clone().unwrap_or_else(|| "—".into()) })}
                            }
                        }
                    }
                    RateRow { label: "5-hour window", window: st.and_then(|s| s.five_hour.clone()) }
                    RateRow { label: "Weekly", window: st.and_then(|s| s.seven_day.clone()) }
                }
            }
            div { class: "usage-stats",
                if shows_cost(agent) {
                    Stat {
                        icon: Icon::Coins,
                        label: "Session cost",
                        value: rsx! { {cost.map_or_else(|| "—".to_string(), |c| f::money(Some(c)))} },
                        sub: api_time.map(|t| rsx! { {format!("API time {}", f::duration(t))} }),
                    }
                }
                Stat {
                    icon: Icon::Clock3,
                    label: "Running for",
                    value: rsx! { "{running}" },
                    sub: (turns > 0).then(|| rsx! { "{turns} turns" }),
                }
                Stat {
                    label: "Lines changed",
                    value: lines(added, removed),
                    sub: (agent == Some(AgentKind::Codex)).then(|| rsx! { "Recorded patches" }),
                }
                Stat {
                    icon: Icon::RadioTower,
                    label: "Remote Control",
                    value: rsx! { if rc.is_some() { "On" } else { "Off" } },
                    sub: rc.map(|u| rsx! { a { class: "underline", href: "{u}", target: "_blank", rel: "noreferrer", "{rc_word}" } }),
                }
            }
            if !rows.is_empty() {
                section { class: "usage-card usage-details",
                    for (k , v) in rows {
                        div { key: "{k}", class: "usage-detail",
                            span { class: "usage-detail-key", "{k}" }
                            span { class: "usage-detail-value mono truncate", "{v}" }
                            if matches!(k, "Session" | "Folder" | "Shared link") {
                                CopyButton { text: v.clone(), label: format!("Copy {}", k.to_lowercase()) }
                            }
                        }
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn status(v: serde_json::Value) -> AgentStatus {
        serde_json::from_value(v).unwrap()
    }

    fn info(stats: serde_json::Value) -> ChatInfo {
        serde_json::from_value(
            json!({ "hostId": "h", "paneId": "%1", "running": false, "queue": [], "tasks": [], "subagents": [], "artifacts": [], "stats": stats, "cwd": "/p", "mappedBy": "hook" }),
        )
        .unwrap()
    }

    #[test]
    fn the_context_window_comes_from_the_newer_report() {
        let live = status(json!({ "contextUsed": 50000, "contextSize": 200000, "contextPct": 25, "updatedAt": 1000 }));
        let c = context_of(Some(&live), None);
        assert_eq!((c.used, c.pct, c.size), (Some(50000.0), Some(25.0), Some(200000.0)));
        assert_eq!(context_line(&c), "50k / 200k");
        // a compaction in the transcript after the live report wins
        let i = info(json!({ "contextTokens": 12000, "contextAt": 9000, "compactedAt": 9000, "turns": 1, "compactions": 1 }));
        let c = context_of(Some(&live), Some(&i));
        assert_eq!((c.used, c.pct, c.compacted), (Some(12000.0), Some(6.0), true));
        assert_eq!(context_of(None, None), Context::default());
    }

    #[test]
    fn the_details_list_only_whats_known() {
        let i = info(json!({ "turns": 0, "compactions": 0 }));
        let rows = details(Some(&status(json!({ "model": "Opus", "fast": false, "updatedAt": 1 }))), Some(&i));
        assert_eq!(rows, [("Model", "Opus".to_string()), ("Fast mode", "Off".into()), ("Folder", "/p".into()), ("Matched by", "Integration hook (exact)".into())]);
        assert!(!shows_cost(Some(AgentKind::Codex)) && shows_cost(Some(AgentKind::Claude)) && shows_cost(None));
    }
}
