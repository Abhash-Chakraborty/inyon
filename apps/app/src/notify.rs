//! Notifications while the app is off screen (the Android build, from 1.0). The core's own thread
//! posts them as it hears each notice, so they arrive even while Android has frozen the window:
//! what apps/web/src/lib/store.ts's `notify` and `pageNotify` do for the Capacitor app.
//!
//! One notification per session (or machine, or page): the next replaces it. A question waits a
//! moment for the overview that carries its answers; one answered meanwhile gets none, and one
//! answered somewhere else takes its notification away.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use inyon_chat_core::js::encode_uri_component;
use inyon_protocol::{AgentState, HostState, HostStatus, NotifyKind, ServerMsg};
use serde::Serialize;

/// How long a question's notice waits for the overview with its answers (the web app's ANSWERS_WAIT_MS).
pub const ANSWERS_WAIT_MS: u64 = 400;

/// An answer a question's notification offers as a button.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Choice {
    pub n: u32,
    pub label: String,
}

/// One notification, as the Kotlin side posts it (Notifications.post).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Notice {
    pub title: String,
    pub body: String,
    pub href: String,
    pub tag: String,
    /// waiting, done, offline, online or page: the channel and the buttons
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pane: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<Choice>,
}

/// Where notifications go: Android's shade, or a test's list.
pub trait Shade {
    fn post(&self, n: &Notice) -> bool;
    fn clear(&self, tag: &str);
}

/// What the person chose in Settings (`notifyDone`, `notifyPages`); both on unless turned off.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Wants {
    pub done: bool,
    pub pages: bool,
}

impl Wants {
    /// From the app's saved settings (`inyon.settings.v2`).
    pub fn from_settings(saved: Option<&str>) -> Wants {
        let v: serde_json::Value = saved.and_then(|s| serde_json::from_str(s).ok()).unwrap_or_default();
        let on = |k: &str| v.get(k).and_then(serde_json::Value::as_bool).unwrap_or(true);
        Wants { done: on("notifyDone"), pages: on("notifyPages") }
    }
}

/// A session's (or a machine's) tag: its next notification replaces this one.
pub fn tag_of(host: &str, pane: Option<&str>) -> String {
    match pane {
        Some(p) => format!("{host}:{p}"),
        None => format!("machine:{host}"),
    }
}

/// The in-app path a tap opens, as the web app writes it.
pub fn href_of(host: &str, pane: Option<&str>) -> String {
    match pane {
        Some(p) => format!("/m/{}/p/{}", encode_uri_component(host), p.trim_start_matches('%')),
        None => format!("/machines/{}", encode_uri_component(host)),
    }
}

fn kind_name(k: NotifyKind) -> &'static str {
    match k {
        NotifyKind::Waiting => "waiting",
        NotifyKind::Done => "done",
        NotifyKind::Offline => "offline",
        NotifyKind::Online => "online",
    }
}

/// The answers a waiting session offers, when there are one to three of them (Android shows three
/// buttons at most); none otherwise.
pub fn choices_for(hosts: &[HostState], host: &str, pane: &str) -> Vec<Choice> {
    let agent = hosts
        .iter()
        .find(|h| h.config.id == host)
        .and_then(|h| h.sessions.iter().flat_map(|s| &s.windows).flat_map(|w| &w.panes).find(|p| p.id == pane))
        .and_then(|p| p.agent.as_ref());
    match agent {
        Some(a) if a.state == AgentState::Waiting => match a.options.as_deref() {
            Some(o) if (1..=3).contains(&o.len()) => o.iter().map(|o| Choice { n: o.n, label: o.label.clone() }).collect(),
            _ => vec![],
        },
        _ => vec![],
    }
}

/// What the notifier remembers between notices.
pub struct Notifier {
    shade: Rc<dyn Shade>,
    /// sessions with a "needs you" notification up, by tag
    asking: RefCell<HashMap<String, (String, String)>>,
}

/// What to do once the overview with a question's answers has had time to arrive.
pub struct Later {
    pub tag: String,
    pub notice: Notice,
}

impl Notifier {
    pub fn new(shade: Rc<dyn Shade>) -> Rc<Notifier> {
        Rc::new(Notifier { shade, asking: RefCell::default() })
    }

    /// A notice from the core. Posted at once, unless it's a question: that one comes back as
    /// [`Later`], for [`Notifier::ask`] once its answers are known.
    pub fn heard(&self, msg: &ServerMsg, visible: bool, wants: Wants) -> Option<Later> {
        match msg {
            ServerMsg::Notify { host, pane, kind, title, body, .. } => {
                let machine = matches!(kind, NotifyKind::Offline | NotifyKind::Online);
                if *kind == NotifyKind::Done && !wants.done {
                    return None;
                }
                // on screen, the app shows it itself
                if visible {
                    return None;
                }
                let pane = (!machine).then_some(pane.as_str());
                let tag = tag_of(host, pane);
                let notice = Notice {
                    title: title.clone(),
                    body: body.clone(),
                    href: href_of(host, pane),
                    tag: tag.clone(),
                    kind: kind_name(*kind).into(),
                    host: pane.map(|_| host.clone()),
                    pane: pane.map(str::to_owned),
                    options: vec![],
                };
                if *kind != NotifyKind::Waiting {
                    self.asking.borrow_mut().remove(&tag);
                    self.shade.post(&notice);
                    return None;
                }
                self.asking.borrow_mut().insert(tag.clone(), (host.clone(), pane.unwrap_or_default().to_owned()));
                Some(Later { tag, notice })
            }
            ServerMsg::PageNotify { host, slug, title, body } => {
                if !wants.pages || visible {
                    return None;
                }
                let tag = format!("page:{host}/{slug}");
                let href = format!("/pages/{}/{slug}", encode_uri_component(host));
                self.shade.post(&Notice { title: title.clone(), body: body.clone(), href, tag, kind: "page".into(), host: None, pane: None, options: vec![] });
                None
            }
            _ => None,
        }
    }

    /// Posts a question's notification with the answers the overview now shows, unless it was
    /// answered meanwhile.
    pub fn ask(&self, later: Later, hosts: &[HostState]) {
        let Some((host, pane)) = self.asking.borrow().get(&later.tag).cloned() else { return };
        let mut notice = later.notice;
        notice.options = choices_for(hosts, &host, &pane);
        self.shade.post(&notice);
    }

    /// A question answered somewhere else (on the computer, say) takes its notification with it,
    /// so what's left in the shade still needs you.
    pub fn overview(&self, hosts: &[HostState]) {
        let answered: Vec<String> = self
            .asking
            .borrow()
            .iter()
            .filter(|(_, (host, pane))| {
                // a machine that went quiet says nothing about the question
                let Some(h) = hosts.iter().find(|h| &h.config.id == host).filter(|h| h.status == HostStatus::Online) else { return false };
                let p = h.sessions.iter().flat_map(|s| &s.windows).flat_map(|w| &w.panes).find(|p| &p.id == pane);
                p.and_then(|p| p.agent.as_ref()).is_none_or(|a| a.state != AgentState::Waiting)
            })
            .map(|(tag, _)| tag.clone())
            .collect();
        for tag in answered {
            self.asking.borrow_mut().remove(&tag);
            self.shade.clear(&tag);
        }
    }
}

/// Starts posting notifications from the core's thread into `shade` (made there).
pub fn start(phone: &inyon_phone::native::PhoneHandle, shade: impl FnOnce() -> Rc<dyn Shade> + Send + 'static) {
    use inyon_core::hosts::registry::{registry, RegistryEvent};
    use inyon_core::platform::rt::set_timeout;
    phone.spawn(move || async move {
        let n = Notifier::new(shade());
        let heard = n.clone();
        inyon_api::clients::on_notice(move |msg| {
            let wants = Wants::from_settings(crate::platform::load("inyon.settings.v2").as_deref());
            if let Some(later) = heard.heard(msg, crate::phone::is_visible(), wants) {
                let n = heard.clone();
                set_timeout(ANSWERS_WAIT_MS, move || n.ask(later, &registry().overview()));
            }
        });
        let _ = registry().on(move |e| {
            if matches!(e, RegistryEvent::Overview) {
                n.overview(&registry().overview());
            }
        });
    });
}

#[cfg(test)]
#[path = "notify_tests.rs"]
mod tests;
