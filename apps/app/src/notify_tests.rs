use std::cell::RefCell;
use std::rc::Rc;

use inyon_protocol::{HostState, NotifyKind, ServerMsg};
use serde_json::{json, Value};

use super::*;

#[derive(Default)]
struct Tray {
    posted: RefCell<Vec<Notice>>,
    cleared: RefCell<Vec<String>>,
}

impl Shade for Tray {
    fn post(&self, n: &Notice) -> bool {
        self.posted.borrow_mut().push(n.clone());
        true
    }
    fn clear(&self, tag: &str) {
        self.cleared.borrow_mut().push(tag.to_owned());
    }
}

fn host(id: &str, status: &str, agent: Value) -> HostState {
    let pane = json!({ "id": "%3", "index": 0, "active": true, "command": "claude", "cwd": "/", "title": "", "width": 80, "height": 40, "dead": false, "agent": agent });
    serde_json::from_value(json!({ "config": { "id": id, "name": id, "kind": "link" }, "status": status, "integration": "installed", "tmux": "ok", "agents": ["claude"],
        "sessions": [{ "id": "$1", "name": "s", "attached": 0, "windows": [{ "id": "@1", "index": 1, "name": "", "active": true, "activity": 0, "panes": [pane] }] }], "updatedAt": 0 }))
    .unwrap()
}

fn asking(options: Value) -> Value {
    json!({ "kind": "claude", "pid": 1, "state": "waiting", "options": options })
}

fn notify(kind: NotifyKind) -> ServerMsg {
    ServerMsg::Notify { host: "lap top".into(), pane: "%3".into(), kind, title: "Claude".into(), body: "Run the tests?".into(), agent: None }
}

const ALL: Wants = Wants { done: true, pages: true };

fn setup() -> (Rc<Tray>, Rc<Notifier>) {
    let tray = Rc::new(Tray::default());
    (tray.clone(), Notifier::new(tray))
}

#[test]
fn tags_and_paths_match_the_web_app() {
    assert_eq!(tag_of("box", Some("%3")), "box:%3");
    assert_eq!(tag_of("box", None), "machine:box");
    assert_eq!(href_of("lap top", Some("%12")), "/m/lap%20top/p/12");
    assert_eq!(href_of("hub:h1/box", None), "/machines/hub%3Ah1%2Fbox");
}

#[test]
fn settings_turn_finished_and_page_notifications_off_and_default_on() {
    assert_eq!(Wants::from_settings(None), ALL);
    assert_eq!(Wants::from_settings(Some("not json")), ALL);
    assert_eq!(Wants::from_settings(Some(r#"{"notifyDone":false,"theme":"dark"}"#)), Wants { done: false, pages: true });
    assert_eq!(Wants::from_settings(Some(r#"{"notifyPages":false}"#)), Wants { done: true, pages: false });
}

#[test]
fn nothing_is_posted_while_the_app_is_on_screen() {
    let (tray, n) = setup();
    assert!(n.heard(&notify(NotifyKind::Done), true, ALL).is_none());
    assert!(n.heard(&notify(NotifyKind::Waiting), true, ALL).is_none());
    assert!(tray.posted.borrow().is_empty());
}

#[test]
fn a_finished_turn_is_posted_at_once_unless_turned_off() {
    let (tray, n) = setup();
    assert!(n.heard(&notify(NotifyKind::Done), false, Wants { done: false, pages: true }).is_none());
    assert!(tray.posted.borrow().is_empty());
    assert!(n.heard(&notify(NotifyKind::Done), false, ALL).is_none());
    let p = tray.posted.borrow()[0].clone();
    assert_eq!((p.kind.as_str(), p.tag.as_str(), p.href.as_str()), ("done", "lap top:%3", "/m/lap%20top/p/3"));
    assert_eq!((p.host.as_deref(), p.pane.as_deref()), (Some("lap top"), Some("%3")));
}

#[test]
fn a_machine_going_offline_is_tagged_by_the_machine_and_opens_it() {
    let (tray, n) = setup();
    n.heard(&notify(NotifyKind::Offline), false, ALL);
    let p = tray.posted.borrow()[0].clone();
    assert_eq!((p.kind.as_str(), p.tag.as_str(), p.href.as_str()), ("offline", "machine:lap top", "/machines/lap%20top"));
    assert_eq!((p.host, p.pane), (None, None));
}

#[test]
fn a_question_waits_for_its_answers_and_offers_up_to_three() {
    let (tray, n) = setup();
    let later = n.heard(&notify(NotifyKind::Waiting), false, ALL).expect("a question waits");
    assert!(tray.posted.borrow().is_empty());
    let hosts = vec![host("lap top", "online", asking(json!([{ "n": 1, "label": "Yes" }, { "n": 2, "label": "No" }])))];
    n.ask(later, &hosts);
    let p = tray.posted.borrow()[0].clone();
    assert_eq!(p.kind, "waiting");
    assert_eq!(p.options, vec![Choice { n: 1, label: "Yes".into() }, Choice { n: 2, label: "No".into() }]);
    // four answers don't fit on a notification
    let later = n.heard(&notify(NotifyKind::Waiting), false, ALL).unwrap();
    let four = json!([{ "n": 1, "label": "a" }, { "n": 2, "label": "b" }, { "n": 3, "label": "c" }, { "n": 4, "label": "d" }]);
    n.ask(later, &[host("lap top", "online", asking(four))]);
    assert!(tray.posted.borrow()[1].options.is_empty());
}

#[test]
fn a_question_answered_before_its_answers_arrive_gets_no_notification() {
    let (tray, n) = setup();
    let later = n.heard(&notify(NotifyKind::Waiting), false, ALL).unwrap();
    // the agent finished before the overview came: the finished notice replaces the question
    n.heard(&notify(NotifyKind::Done), false, ALL);
    n.ask(later, &[host("lap top", "online", asking(json!([{ "n": 1, "label": "Yes" }])))]);
    let kinds: Vec<_> = tray.posted.borrow().iter().map(|p| p.kind.clone()).collect();
    assert_eq!(kinds, ["done"]);
}

#[test]
fn a_question_answered_on_the_computer_takes_its_notification_away() {
    let (tray, n) = setup();
    let later = n.heard(&notify(NotifyKind::Waiting), false, ALL).unwrap();
    n.ask(later, &[host("lap top", "online", asking(json!([{ "n": 1, "label": "Yes" }])))]);
    // still asking, or the machine went quiet: it stays
    n.overview(&[host("lap top", "online", asking(json!([])))]);
    n.overview(&[host("lap top", "connecting", json!({ "kind": "claude", "pid": 1, "state": "working" }))]);
    assert!(tray.cleared.borrow().is_empty());
    n.overview(&[host("lap top", "online", json!({ "kind": "claude", "pid": 1, "state": "working" }))]);
    assert_eq!(*tray.cleared.borrow(), vec!["lap top:%3"]);
    // and only once
    n.overview(&[host("lap top", "online", json!({ "kind": "claude", "pid": 1, "state": "idle" }))]);
    assert_eq!(tray.cleared.borrow().len(), 1);
}

#[test]
fn a_page_moving_on_is_posted_unless_turned_off() {
    let (tray, n) = setup();
    let page = ServerMsg::PageNotify { host: "box".into(), slug: "plan".into(), title: "Plan".into(), body: "8 of 12 done".into() };
    n.heard(&page, false, Wants { done: true, pages: false });
    assert!(tray.posted.borrow().is_empty());
    n.heard(&page, false, ALL);
    let p = tray.posted.borrow()[0].clone();
    assert_eq!((p.kind.as_str(), p.tag.as_str(), p.href.as_str()), ("page", "page:box/plan", "/pages/box/plan"));
}

#[test]
fn a_notice_reaches_kotlin_as_the_json_notifications_post_reads() {
    let n = Notice { title: "t".into(), body: "b".into(), href: "/".into(), tag: "x".into(), kind: "done".into(), host: None, pane: None, options: vec![] };
    assert_eq!(serde_json::to_string(&n).unwrap(), r#"{"title":"t","body":"b","href":"/","tag":"x","kind":"done"}"#);
}
