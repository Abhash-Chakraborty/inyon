//! Sharing a blueprint (components/pages/ShareSheet.tsx, SharedLinks.tsx, ShareSetup.tsx): the
//! Share… sheet the page menus open, a link to one blueprint for someone outside the app, and the
//! sharing rows of Settings › Blueprints, with the hub's public address for shared links (set up in
//! four steps, checked, turned off) and every live link with Revoke and Revoke all.

use dioxus::prelude::*;
use inyon_protocol::PageEntry;

use super::icons::{Glyph, Icon};
use super::kit::{arrow_step, Busy, Segmented, Sheet, WaitRows};
use super::pages::PAGES;
use super::toast::{self, confirm, Ask, ToastTone};
use crate::api;
use crate::route::Route;
use crate::shares::{self as sh, Proxy, ShareCheck, ShareLink, ShareList};
use crate::{dom, platform};

/// Where the Share sheet sends you to set up the public address.
fn settings_href() -> String {
    format!("{}#blueprints", Route::Settings.href())
}

fn meta(s: &ShareLink) -> String {
    let c = platform::clock();
    sh::share_meta(s, c.now, c.tz_minutes)
}

/// Who a choice in the Share sheet lets open the link.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Who {
    Network,
    Public,
}

/// "Share…": a link to one blueprint for someone outside the app. People on your network is the
/// default and uses the hub's own address; Anyone with the link needs the hub's public address for
/// shared links, set in Settings. The link is shown once, since the hub keeps only its hash; the
/// page's live links are listed under it, each with Revoke.
#[component]
pub fn ShareSheet(page: PageEntry, open: bool, on_close: EventHandler<()>) -> Element {
    let mut list = use_signal(|| None::<ShareList>);
    let mut load_error = use_signal(String::new);
    let mut who = use_signal(|| Who::Network);
    let mut days = use_signal(|| "7".to_string());
    let mut made = use_signal(|| None::<(String, bool)>);
    let mut copied = use_signal(|| false);
    let mut busy = use_signal(|| false);
    let mut error = use_signal(String::new);
    let (host, slug) = (page.host.clone(), page.slug.clone());
    let load = move |host: String, slug: String| {
        spawn(async move {
            match api::page_shares(&host, &slug).await {
                Ok(l) => {
                    list.set(Some(l));
                    load_error.set(String::new());
                }
                Err(e) => load_error.set(sh::share_error(&e.message)),
            }
        });
    };
    let id = format!("{host}/{slug}");
    {
        let (host, slug) = (host.clone(), slug.clone());
        use_effect(use_reactive!(|open, id| {
            let _ = id;
            if !open {
                return;
            }
            who.set(Who::Network);
            days.set("7".into());
            made.set(None);
            copied.set(false);
            error.set(String::new());
            list.set(None);
            load_error.set(String::new());
            load(host.clone(), slug.clone());
        }));
    }
    let address = list.read().as_ref().and_then(|l| l.address.clone());
    let create = {
        let (host, slug) = (host.clone(), slug.clone());
        move |_| {
            let (host, slug) = (host.clone(), slug.clone());
            busy.set(true);
            error.set(String::new());
            let public = who() == Who::Public;
            let d = days.peek().parse().unwrap_or(7);
            spawn(async move {
                match api::share_page(&host, &slug, public, d).await {
                    Ok(s) => {
                        let url = sh::share_url(&dom::origin(), &s.url);
                        made.set(Some((url.clone(), s.link.public)));
                        copied.set(false);
                        if dom::copy(&url).await {
                            copied.set(true);
                        }
                        load(host, slug);
                    }
                    Err(e) => error.set(sh::share_error(&e.message)),
                }
                busy.set(false);
            });
        }
    };
    let copy = move |_| {
        let Some((url, _)) = made() else { return };
        spawn(async move {
            if dom::copy(&url).await {
                copied.set(true);
                toast::toast("Copied the link", None, ToastTone::Success);
            }
        });
    };
    let off = address.is_none();
    let pick = move |w: Who| {
        if w == Who::Public && off {
            return;
        }
        who.set(w);
    };
    let mut pick_k = pick;
    let on_key = move |e: KeyboardEvent| {
        let at = if who() == Who::Network { 0 } else { 1 };
        let key = match e.key() {
            Key::ArrowDown => Key::ArrowRight,
            Key::ArrowUp => Key::ArrowLeft,
            k => k,
        };
        if let Some(next) = arrow_step(&key, at, 2) {
            e.prevent_default();
            pick_k(if next == 0 { Who::Network } else { Who::Public });
        }
    };
    let public_hint = address.as_ref().map(|a| format!("Opens at {}, through the proxy you set up.", sh::host_of(a)));
    let loaded = list.read().is_some();
    let links = list.read().as_ref().map(|l| l.links.clone()).unwrap_or_default();
    let w = who();
    rsx! {
        Sheet {
            open,
            on_close: move |_| on_close.call(()),
            title: "Share “{page.name}”",
            icon: rsx! { Glyph { icon: Icon::Share2, size: 16, class: "fg-2" } },
            footer: rsx! {
                div { class: "sheet-actions",
                    button { class: "button button-md button-ghost press", r#type: "button", onclick: move |_| on_close.call(()), "Done" }
                    button { class: "button button-md button-primary press", r#type: "button", disabled: !loaded || busy(), onclick: create,
                        Busy { on: busy() }
                        "Create link"
                    }
                }
            },
            div { class: "share",
                div {
                    div { id: "share-who", class: "share-label", "Who can open it" }
                    div { class: "share-choices", role: "radiogroup", "aria-labelledby": "share-who", onkeydown: on_key,
                        WhoRow {
                            on: w == Who::Network,
                            icon: Icon::Users,
                            title: "People on your network",
                            on_pick: move |_| { let mut p = pick; p(Who::Network) },
                            "Uses this hub's address, for devices that already reach it."
                        }
                        WhoRow { on: w == Who::Public, off, icon: Icon::Globe, title: "Anyone with the link", on_pick: move |_| { let mut p = pick; p(Who::Public) },
                            if let Some(h) = &public_hint {
                                "{h}"
                            } else {
                                "Set an address for shared links in "
                                a { class: "share-link", href: "{settings_href()}", onclick: move |_| on_close.call(()), "Settings › Blueprints" }
                                " first."
                            }
                        }
                    }
                    if w == Who::Public {
                        p { class: "share-note", "Every file in the blueprint's folder opens with the link, research notes too." }
                    }
                }
                div {
                    div { class: "share-label", "Expires after" }
                    Segmented {
                        value: days(),
                        options: sh::SHARE_DAYS.iter().map(|(v, l)| (v.to_string(), l.to_string())).collect::<Vec<_>>(),
                        label: "Expires after",
                        on_change: move |v: String| days.set(v),
                    }
                }
                if !error().is_empty() {
                    p { class: "form-error share-error", role: "alert", "{error}" }
                }
                if let Some((url, _)) = made() {
                    div { class: "share-made slide-up",
                        div { class: "share-made-row",
                            code { class: "mono share-url truncate", title: "{url}", "data-testid": "share-url", "{url}" }
                            button { class: "button button-sm button-quiet press", r#type: "button", onclick: copy,
                                Glyph { icon: if copied() { Icon::Check } else { Icon::Copy }, size: 14 }
                                if copied() { "Copied" } else { "Copy" }
                            }
                        }
                        p { class: "share-made-note", "Copy it now: the hub keeps only a fingerprint of it, so it can't show it again." }
                    }
                }
                div {
                    div { class: "share-label", "Live links" }
                    if !loaded && load_error().is_empty() {
                        WaitRows { label: "Loading shared links", count: 1, class: "share-wait" }
                    } else if !load_error().is_empty() {
                        p { class: "share-empty", "{load_error}" }
                    } else if links.is_empty() {
                        p { class: "share-empty", "None yet." }
                    } else {
                        ul { class: "share-links",
                            for s in links {
                                {
                                    let (h, sl) = (host.clone(), slug.clone());
                                    let sid = s.id.clone();
                                    rsx! {
                                        li { key: "{s.id}", class: "share-link-row",
                                            Glyph { icon: if s.public { Icon::Globe } else { Icon::Users }, size: 16, class: "fg-3 share-link-icon" }
                                            span { class: "share-link-words",
                                                span { class: "share-link-title truncate", {sh::audience(s.public)} }
                                                span { class: "share-link-meta mono truncate", {meta(&s)} }
                                            }
                                            button { class: "button button-xs button-ghost press", r#type: "button",
                                                onclick: move |_| {
                                                    let (h, sl, sid) = (h.clone(), sl.clone(), sid.clone());
                                                    spawn(async move {
                                                        match api::unshare_page(&h, &sl, &sid).await {
                                                            Ok(()) => {
                                                                if let Some(l) = list.write().as_mut() {
                                                                    l.links.retain(|x| x.id != sid);
                                                                }
                                                                toast::toast("Link revoked", Some("It stops working now.".into()), ToastTone::Success);
                                                            }
                                                            Err(e) => toast::toast("Couldn't revoke the link", Some(e.message), ToastTone::Error),
                                                        }
                                                    });
                                                },
                                                "Revoke"
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

/// A choice of who can open the link: a radio row with its icon, title and a line under it.
#[component]
fn WhoRow(on: bool, #[props(default)] off: bool, icon: Icon, title: String, on_pick: EventHandler<()>, children: Element) -> Element {
    let class = match (on, off) {
        (_, true) => "share-choice share-choice-off",
        (true, _) => "share-choice share-choice-on",
        _ => "share-choice",
    };
    rsx! {
        div {
            class: "{class}",
            role: "radio",
            "aria-checked": "{on}",
            "aria-disabled": off.then_some("true"),
            tabindex: if on { "0" } else { "-1" },
            onclick: move |_| on_pick.call(()),
            span { class: "share-choice-icon", Glyph { icon, size: 16 } }
            span { class: "share-choice-words",
                span { class: "share-choice-title", "{title}" }
                span { class: "share-choice-hint", {children} }
            }
            span { class: "share-radio", "aria-hidden": "true",
                if on {
                    span { class: "share-radio-dot" }
                }
            }
        }
    }
}

/// The lines of a check, each with a mark: done, or what to fix.
#[component]
pub fn CheckResult(check: ShareCheck) -> Element {
    rsx! {
        ul { class: "share-check", "aria-label": "Check result", "data-testid": "share-check",
            for l in sh::check_lines(&check) {
                li { key: "{l.title}", class: "share-check-line",
                    if l.ok {
                        span { class: "share-check-mark fg-2", role: "img", "aria-label": "Done", Glyph { icon: Icon::Check, size: 16 } }
                    } else {
                        span { class: "share-check-mark warn", role: "img", "aria-label": "To fix", Glyph { icon: Icon::CircleAlert, size: 16 } }
                    }
                    span { class: "share-check-words",
                        span { class: "share-check-title", "{l.title}" }
                        if let Some(b) = &l.body {
                            span { class: "share-check-body", "{b}" }
                        }
                    }
                }
            }
        }
    }
}

/// Settings › Blueprints, the sharing part: the hub's public address for shared links (off unless
/// set up, and read-only when INYON_SHARE_ORIGIN sets it) with Set up, Check and Turn off, and every
/// live shared link with Revoke and Revoke all. Rows for the Blueprints card.
#[component]
pub fn SharedLinks() -> Element {
    let mut list = use_signal(|| None::<ShareList>);
    let mut error = use_signal(String::new);
    let mut setup = use_signal(|| false);
    let mut check = use_signal(|| None::<ShareCheck>);
    let mut checking = use_signal(|| false);
    use_hook(move || {
        spawn(async move {
            match api::shares().await {
                Ok(l) => list.set(Some(l)),
                Err(e) => error.set(sh::share_error(&e.message)),
            }
        })
    });
    if !error().is_empty() {
        return rsx! {
            div { class: "set-row",
                div { class: "set-words",
                    div { class: "set-label", "Shared links" }
                    div { class: "set-hint", "{error}" }
                }
            }
        };
    }
    let Some(l) = list() else {
        return rsx! { WaitRows { label: "Loading shared links", count: 1, class: "set-wait" } };
    };
    let page_name = |s: &ShareLink| PAGES.read().find(&s.host, &s.slug).map_or_else(|| s.slug.clone(), |p| p.name.clone());
    let run_check = move |_| {
        checking.set(true);
        spawn(async move {
            match api::check_share_address().await {
                Ok(c) => check.set(Some(c)),
                Err(e) => toast::toast("Couldn't check the address", Some(e.message), ToastTone::Error),
            }
            checking.set(false);
        });
    };
    let turn_off = move |_| {
        spawn(async move {
            let ask = Ask {
                title: "Turn off the public address?".into(),
                body: Some("Links for anyone stop opening there, and new links stay on your network. Your proxy and DNS record stay as they are.".into()),
                yes: "Turn off".into(),
                danger: true,
                ..Ask::default()
            };
            if !confirm(ask).await {
                return;
            }
            match api::set_share_address("").await {
                Ok(l) => {
                    list.set(Some(l));
                    check.set(None);
                    toast::toast("Public address off", Some("New links stay on your network.".into()), ToastTone::Success);
                }
                Err(e) => toast::toast("Couldn't turn it off", Some(e.message), ToastTone::Error),
            }
        });
    };
    let n = l.links.len();
    let revoke_all = move |_| {
        spawn(async move {
            let ask = Ask {
                title: sh::revoke_all_title(n),
                body: Some("Whoever has them can no longer open those blueprints. Links in the app keep working.".into()),
                yes: "Revoke all".into(),
                danger: true,
                ..Ask::default()
            };
            if !confirm(ask).await {
                return;
            }
            match api::revoke_all_shares().await {
                Ok(()) => {
                    if let Some(l) = list.write().as_mut() {
                        l.links.clear();
                    }
                    toast::toast("Shared links revoked", None, ToastTone::Success);
                }
                Err(e) => toast::toast("Couldn't revoke them", Some(e.message), ToastTone::Error),
            }
        });
    };
    let c = check();
    let status = sh::address_status(&l, c.as_ref());
    let has = l.address.is_some();
    let setup_label = if !has {
        "Set up"
    } else if l.from_env {
        "Guide"
    } else {
        "Change"
    };
    rsx! {
        div { class: "set-row", id: "share-address",
            div { class: "set-words",
                div { class: "set-label", "Address for shared links" }
                div { class: "set-hint",
                    if let Some(a) = &l.address {
                        code { class: "mono fg-2 share-address", {sh::name_of(a)} }
                        " · "
                    }
                    "{status}"
                    if l.from_env {
                        " Set by INYON_SHARE_ORIGIN."
                    }
                }
            }
            div { class: "share-actions",
                if has {
                    button { class: "button button-sm button-quiet press", r#type: "button", disabled: checking(), onclick: run_check,
                        Busy { on: checking() }
                        "Check"
                    }
                }
                button { class: if has { "button button-sm button-ghost press" } else { "button button-sm button-quiet press" }, r#type: "button", onclick: move |_| setup.set(true), "{setup_label}" }
                if has && !l.from_env {
                    button { class: "button button-sm button-ghost press", r#type: "button", onclick: turn_off, "Turn off" }
                }
            }
            if let Some(c) = c {
                div { class: "share-full", CheckResult { check: c } }
            }
            ShareSetup {
                open: setup(),
                on_close: move |_| setup.set(false),
                list: l.clone(),
                on_saved: move |(nl, nc): (ShareList, Option<ShareCheck>)| {
                    list.set(Some(nl));
                    check.set(nc);
                },
            }
        }
        div { class: "set-row",
            div { class: "set-words",
                div { class: "set-label", "Shared links" }
                div { class: "set-hint",
                    if n > 0 { "Live links to your blueprints, on every machine." } else { "None live. Share a blueprint from its ⋯ menu." }
                }
            }
            if n > 0 {
                button { class: "button button-sm button-danger press", r#type: "button", onclick: revoke_all, "Revoke all" }
                ul { class: "share-links share-full",
                    for s in l.links.clone() {
                        {
                            let name = page_name(&s);
                            let sid = s.id.clone();
                            let gone = name.clone();
                            rsx! {
                                li { key: "{s.id}", class: "share-link-row",
                                    span { class: "share-link-icon fg-3", title: "{sh::audience(s.public)}",
                                        Glyph { icon: if s.public { Icon::Globe } else { Icon::Users }, size: 16 }
                                    }
                                    span { class: "share-link-words",
                                        span { class: "share-link-title truncate", "{name}" }
                                        span { class: "share-link-meta mono truncate", "{sh::audience(s.public)} · {meta(&s)}" }
                                    }
                                    button { class: "button button-xs button-ghost press", r#type: "button",
                                        onclick: move |_| {
                                            let (sid, gone) = (sid.clone(), gone.clone());
                                            spawn(async move {
                                                match api::revoke_share(&sid).await {
                                                    Ok(()) => {
                                                        if let Some(l) = list.write().as_mut() {
                                                            l.links.retain(|x| x.id != sid);
                                                        }
                                                        toast::toast("Link revoked", Some(format!("The link to “{gone}” stops working now.")), ToastTone::Success);
                                                    }
                                                    Err(e) => toast::toast("Couldn't revoke the link", Some(e.message), ToastTone::Error),
                                                }
                                            });
                                        },
                                        "Revoke"
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

/// A numbered step of the setup.
#[component]
fn Step(n: u32, title: String, children: Element) -> Element {
    rsx! {
        section { class: "share-step",
            span { class: "share-step-n mono", "aria-hidden": "true", "{n}" }
            div { class: "share-step-body",
                h3 { class: "share-step-title", "{title}" }
                div { class: "share-step-text", {children} }
            }
        }
    }
}

/// Text to copy, with its Copy button.
#[component]
fn CopyBlock(text: String, label: String) -> Element {
    let mut copied = use_signal(|| false);
    let t = text.clone();
    rsx! {
        div { class: "share-code",
            pre { class: "share-code-text mono", "{text}" }
            button { class: "button button-xs button-quiet press share-code-copy", r#type: "button", "aria-label": "Copy {label}",
                onclick: move |_| {
                    let t = t.clone();
                    spawn(async move {
                        if dom::copy(&t).await {
                            copied.set(true);
                            platform::sleep(1600).await;
                            copied.set(false);
                        }
                    });
                },
                Glyph { icon: if copied() { Icon::Check } else { Icon::Copy }, size: 14 }
                if copied() { "Copied" } else { "Copy" }
            }
        }
    }
}

/// Settings › Blueprints › Set up: the public address for links made for Anyone with the link, in
/// four steps. Pick a subdomain kept for this, point its DNS at the proxy, have the proxy forward only
/// /share/ to the hub, then save and check. The check asks the address for a probe only this hub can
/// answer, so a pass means links really arrive here, and that nothing else is let through.
#[component]
fn ShareSetup(open: bool, on_close: EventHandler<()>, list: ShareList, on_saved: EventHandler<(ShareList, Option<ShareCheck>)>) -> Element {
    let mut name = use_signal(String::new);
    let mut proxy = use_signal(|| Proxy::Caddy);
    let mut busy = use_signal(|| false);
    let mut error = use_signal(String::new);
    // the check, with the name it was for: typing another name hides it
    let mut checked = use_signal(|| None::<(String, ShareCheck)>);
    // keyed on opening only: saving changes the address, and that mustn't wipe the check it starts
    let saved_address = list.address.clone();
    use_effect(use_reactive!(|open| {
        if open {
            name.set(saved_address.as_deref().map(sh::field_of).unwrap_or_default());
            error.set(String::new());
            checked.set(None);
            busy.set(false);
        }
    }));
    let typed = name();
    let clean = sh::name_of(&typed);
    let valid = sh::valid_name(&clean);
    let advice = sh::name_advice(&clean, &sh::name_of(&dom::host()));
    let shown = if valid { clean.clone() } else { "share.example.com".to_string() };
    let check = checked().filter(|(n, _)| *n == typed).map(|(_, c)| c);
    let record = sh::dns_record(&shown);
    let upstream = list.upstream.clone().unwrap_or_else(|| sh::UPSTREAM.into());
    let from_env = list.from_env;
    let same = sh::address_of(&typed) == list.address.clone().unwrap_or_default();
    let save_list = list.clone();
    let save = move |_| {
        let l0 = save_list.clone();
        let typed = name.peek().clone();
        busy.set(true);
        error.set(String::new());
        checked.set(None);
        spawn(async move {
            let mut l = l0.clone();
            if !l0.from_env && sh::address_of(&typed) != l0.address.clone().unwrap_or_default() {
                match api::set_share_address(&sh::address_of(&typed)).await {
                    Ok(nl) => {
                        l = nl;
                        // saved: Settings shows the new address even if the check then fails
                        on_saved.call((l.clone(), None));
                    }
                    Err(e) => {
                        error.set(e.message);
                        busy.set(false);
                        return;
                    }
                }
            }
            match api::check_share_address().await {
                Ok(c) => {
                    checked.set(Some((typed, c.clone())));
                    on_saved.call((l, Some(c.clone())));
                    if c.passed() {
                        toast::toast("Shared links work", Some(format!("Links for anyone open at {}.", sh::name_of(&c.address))), ToastTone::Success);
                    }
                }
                Err(e) => error.set(e.message),
            }
            busy.set(false);
        });
    };
    let ip = upstream.split(':').next().unwrap_or_default().to_string();
    let p = proxy();
    rsx! {
        Sheet {
            open,
            wide: true,
            on_close: move |_| on_close.call(()),
            title: "Address for shared links",
            icon: rsx! { Glyph { icon: Icon::Globe, size: 16, class: "fg-2" } },
            footer: rsx! {
                div { class: "sheet-actions",
                    button { class: "button button-md button-ghost press", r#type: "button", onclick: move |_| on_close.call(()),
                        if check.as_ref().is_some_and(|c| c.reach.ok) { "Done" } else { "Close" }
                    }
                    button { class: "button button-md button-primary press", r#type: "button", disabled: !valid || busy(), onclick: save,
                        Busy { on: busy() }
                        if from_env || same { "Check" } else { "Save and check" }
                    }
                }
            },
            div { class: "share-setup",
                p { class: "share-lede",
                    "Links for "
                    span { class: "fg-2", "Anyone with the link" }
                    " open at an address of their own, through a proxy you run. Only "
                    code { class: "mono", "/share/" }
                    " links get through it: no app, no sign-in, nothing else from this hub. Links for your network keep working without any of this."
                }
                Step { n: 1, title: "Pick a subdomain",
                    p { "One you keep for this, such as share.yourdomain.com. Not your main domain, and not the address you open Inyon at." }
                    input {
                        class: if from_env { "field mono-field share-name fg-2" } else { "field mono-field share-name" },
                        "aria-label": "Name for shared links",
                        value: "{typed}",
                        readonly: from_env,
                        placeholder: "share.example.com",
                        spellcheck: "false",
                        autocapitalize: "off",
                        inputmode: "url",
                        "data-autofocus": "true",
                        oninput: move |e| name.set(e.value()),
                    }
                    if from_env {
                        p { class: "share-fine", "Set by INYON_SHARE_ORIGIN on the hub." }
                    }
                    if !advice.is_empty() {
                        p { class: "share-fine warn", role: "status", "{advice}" }
                    }
                }
                Step { n: 2, title: "Point it at your proxy",
                    p {
                        "Add this record where "
                        span { class: "share-fg", "{record.zone}" }
                        "'s DNS is kept, pointing at the public IP of the server your proxy runs on."
                    }
                    div { class: "share-table-wrap",
                        table { class: "share-table mono",
                            thead {
                                tr {
                                    th { "Type" }
                                    th { "Name" }
                                    th { "Points to" }
                                }
                            }
                            tbody {
                                tr {
                                    td { "{record.kind}" }
                                    td { "{record.name}" }
                                    td { class: "share-table-sans fg-2", "your proxy's public IP" }
                                }
                            }
                        }
                    }
                    p { class: "share-fine",
                        "If DNS for a subdomain of {record.zone} is kept on its own, name the record from that zone instead. Use AAAA for an IPv6 address. On Cloudflare, set it to DNS only, or use Full (strict) SSL with the proxy turned on."
                    }
                }
                Step { n: 3, title: "Forward only /share/ to the hub",
                    p { "Your proxy gets the certificate and passes /share/ links to the hub at {upstream}, keeping the Host header. Everything else on the name answers 404." }
                    Segmented {
                        value: p.key().to_string(),
                        options: Proxy::ALL.iter().map(|x| (x.key().to_string(), x.label().to_string())).collect::<Vec<_>>(),
                        label: "Proxy",
                        on_change: move |k: String| proxy.set(Proxy::of(&k)),
                    }
                    CopyBlock { text: sh::proxy_config(p, &shown, &upstream), label: "the {p.key()} example" }
                    p { class: "share-fine",
                        "From a container, use the host's address instead of {ip}. A password, an IP allowlist or a rate limit on the proxy are extra walls the hub doesn't need to know about."
                    }
                }
                Step { n: 4, title: if from_env { "Check it" } else { "Save and check" },
                    p { "The hub asks the address for something only it can answer, so a pass means links really arrive here." }
                    if !error().is_empty() {
                        p { class: "form-error share-error", role: "alert", "{error}" }
                    }
                    if let Some(c) = check {
                        CheckResult { check: c }
                    }
                }
            }
        }
    }
}
