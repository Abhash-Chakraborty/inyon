//! Made-up states of the window, for the tests, the SVG renderer and the window's own demo mode
//! (`INYON_WINDOW_DEMO`, see win.rs), which shows each of them on a real screen and changes nothing
//! of this computer's Inyon.

use serde_json::Value;

use super::model::{Card, Checks, Ended, Extra, Pairing, Setup, Update, CODE_MS, UNDO_MS};
use crate::service::Role;
use crate::ui::dashboard::{Job, PairedPhone, Status};

/// A link that runs, with one phone paired.
pub fn status() -> Status {
    Status {
        v: 1,
        cli: "0.20.1".into(),
        engine: Some("0.20.1".into()),
        role: "node".into(),
        hub: None,
        machine: Some("k7m2p9x4".into()),
        jobs: vec![Job { role: "link".into(), service: true, running: true, version: Some("0.20.1".into()) }],
        addresses: vec!["wss://quiet-otter.trycloudflare.com/link".into()],
        relays: vec![],
        phones: vec![PairedPhone { key: "abc".into(), name: "Nothing A142".into(), paired: "2026-10-14".into(), last_seen: Some("2026-10-22 22:27".into()) }],
        nodes: None,
        agents: vec![],
        pairing_open: false,
        log: vec!["link.log: 2026-10-22 22:31 tunnel up".into()],
        note: None,
        reach: None,
        background: None,
    }
}

pub fn extra() -> Extra {
    Extra {
        hostname: "abhash-laptop".into(),
        reach: (false, false, true),
        agents: vec!["claude".into(), "codex".into()],
        update: Update::Current,
        checks: Checks::Done { total: 9, failing: vec![] },
        hub_url: None,
        forgetting: None,
        setup: Setup::Idle,
        phone_page: 0,
        check_details: Vec::new(),
    }
}

/// The engine's answer with a code; `waiting`: while the tunnel starts, for the LAN only.
pub fn code(waiting: bool) -> Value {
    let mut v = serde_json::json!({ "qr": "https://x/#pair?m=a", "link": "inyon://pair?m=a", "short": { "id": "ZS5C3EPG", "code": "801356" }, "urls": ["wss://a.trycloudflare.com/link"], "relays": [] });
    if waiting {
        v["waiting"] = "tunnel".into();
        v["urls"] = serde_json::json!(["ws://192.168.1.20:4780/link"]);
    }
    v
}

/// The names of every state, in the order the plan lists them.
pub const NAMES: [&str; 14] = ["idle", "asking", "starting", "slow", "lan-code", "code", "expiring", "used", "expired", "error", "not-set-up", "stopped", "hub", "busy"];

/// One state by name, as the window would hold it at `now`.
pub fn state(name: &str, now: f64) -> Option<(Role, Status, Pairing, Extra)> {
    let s = status();
    let x = extra();
    // every phone listed was there when the code was asked for, so none counts as new
    let asked = |card: Card, answer: Option<Value>, at: f64| Pairing { card, answer, asked_at: at, known: vec!["abc".into(), "k0".into(), "k1".into()], seen_open: false };
    let minute_ago = now - 60_000.0;
    Some(match name {
        "idle" => (Role::Link, s, Pairing::default(), x),
        "asking" => (Role::Link, s, asked(Card::Asking, None, now), x),
        "starting" => (Role::Link, s, asked(Card::Starting, None, now), x),
        "slow" => (Role::Link, s, asked(Card::Slow, None, minute_ago), x),
        "lan-code" => (Role::Link, s, asked(Card::Code { lan: true }, Some(code(true)), minute_ago), x),
        "code" => (Role::Link, s, asked(Card::Code { lan: false }, Some(code(false)), minute_ago), x),
        "expiring" => (Role::Link, s, asked(Card::Code { lan: false }, Some(code(false)), now - CODE_MS + 42_000.0), x),
        "used" => (Role::Link, s, asked(Card::Idle(Some(Ended::Used("Pixel 8".into()))), None, minute_ago), x),
        "expired" => (Role::Link, s, asked(Card::Idle(Some(Ended::Expired)), None, now - CODE_MS), x),
        "error" => (Role::Link, s, asked(Card::Failed("Couldn't start the link: the port 4780 is taken by another program, so phones can't connect to it.".into()), None, now), x),
        "not-set-up" => {
            let mut none = s;
            none.role = "none".into();
            none.jobs[0] = Job { role: "link".into(), service: false, running: false, version: None };
            none.phones.clear();
            none.addresses.clear();
            (Role::Link, none, Pairing::default(), Extra { checks: Checks::NotRun, update: Update::Looking, agents: vec![], ..x })
        }
        "stopped" => {
            let mut stopped = s;
            stopped.jobs[0].running = false;
            (Role::Link, stopped, Pairing::default(), x)
        }
        "hub" => {
            let mut hub = s;
            hub.role = "hub".into();
            hub.jobs = vec![Job { role: "hub".into(), service: true, running: true, version: None }];
            hub.nodes = Some(vec!["abhash-arm".into(), "laptop".into()]);
            (Role::Hub, hub, Pairing::default(), Extra { hub_url: Some("http://127.0.0.1:4777".into()), ..x })
        }
        "busy" => {
            let mut many = s;
            many.phones.extend(["Pixel 8", "갤럭시 탭 S9 울트라 플러스 이름이 아주 김"].iter().enumerate().map(|(i, n)| PairedPhone {
                key: format!("k{i}"),
                name: n.to_string(),
                paired: "x".into(),
                last_seen: None,
            }));
            let busy = Extra {
                update: Update::Available("0.20.2".into()),
                checks: Checks::Done { total: 9, failing: vec!["firewall".into()] },
                forgetting: Some(("abc".into(), now + UNDO_MS - 1_000.0)),
                ..x
            };
            (Role::Link, many, asked(Card::Code { lan: false }, Some(code(false)), minute_ago), busy)
        }
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_named_state_exists_and_nothing_else_does() {
        for n in NAMES {
            assert!(state(n, 1_000_000_000.0).is_some(), "{n}");
        }
        assert!(state("nope", 0.0).is_none());
    }

    #[test]
    fn a_state_stays_put_as_the_window_watches_it() {
        // the window's timer watches an open code; a demo state must not end itself there
        let now = 1_000_000_000.0;
        for n in NAMES.into_iter().filter(|n| *n != "expiring") {
            let (_, s, mut p, _) = state(n, now).unwrap();
            assert!(!p.watch(&s, now + 1_000.0), "{n} changed: {:?}", p.card);
        }
    }
}
