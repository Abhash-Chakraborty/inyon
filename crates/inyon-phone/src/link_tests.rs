use std::cell::RefCell;
use std::rc::Rc;
use std::time::Duration;

use inyon_core::hosts::host::ExecOptions;
use inyon_core::hosts::node_backend::node_backend;
use inyon_core::platform::store::{use_store, MemoryStore};
use inyon_link::{Identity, PairInfo};
use inyon_protocol::{HostConfig, HostKind};

use super::*;
use crate::testing::{net, on_core, Answer, FakeMachine, FakeNet};

const LAN: &str = "ws://10.0.0.5:4890";

type Saved = Rc<RefCell<Vec<(String, Vec<String>)>>>;

/// The phone's connector on a test network, with what it saved as each computer's addresses.
fn phone(net: &Rc<FakeNet>) -> (Links, Saved) {
    use_store(Rc::new(MemoryStore::new()));
    let me = Identity::from_seed([1; 32]);
    let saved: Saved = Rc::default();
    let s = saved.clone();
    let links = Links::new(
        net.reach(),
        Rc::new(move || {
            let noise = me.noise.clone();
            Box::pin(async move { Ok(noise) })
        }),
        "Test phone".into(),
        Rc::new(move |id: &str, urls, _| s.borrow_mut().push((id.to_owned(), urls))),
    );
    (links, saved)
}

fn laptop(m: &FakeMachine, id: &str, urls: &[&str]) -> HostConfig {
    HostConfig {
        id: id.into(),
        name: "Laptop".into(),
        kind: HostKind::Link,
        machine_id: Some(m.id.id.clone()),
        urls: Some(urls.iter().map(|u| u.to_string()).collect()),
        relays: Some(vec![]),
        ..inyon_api::core_routes::empty_config()
    }
}

fn code(m: &FakeMachine, urls: &[&str]) -> PairInfo {
    PairInfo { id: m.id.id.clone(), secret: m.secret.clone(), name: "laptop".into(), urls: urls.iter().map(|u| u.to_string()).collect(), relays: vec![] }
}

async fn until(what: &str, check: impl Fn() -> bool) {
    for _ in 0..600 {
        if check() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("never: {what}");
}

#[test]
fn pairs_from_the_code_and_runs_commands_over_the_channel() {
    on_core(|| async {
        let net = net();
        let m = FakeMachine::new(9);
        *m.urls.borrow_mut() = vec![LAN.into(), "wss://tunnel.example".into()];
        net.put(LAN, Answer::Machine(m.clone()));
        let (links, saved) = phone(&net);

        let welcome = links.pair(&code(&m, &[LAN])).await.unwrap();
        assert_eq!(welcome["hostname"], "laptop");
        assert_eq!(welcome["urls"], json!([LAN, "wss://tunnel.example"]));
        assert_eq!(m.hellos.borrow()[0], json!({ "name": "Test phone", "pair": "pair-secret" }));
        assert_eq!(m.paired.borrow().len(), 1);

        let config = laptop(&m, "laptop", &[LAN]);
        links.ensure(&config);
        until("connected", || node_link::is_up("laptop")).await;
        assert_eq!(node_link::info("laptop").map(|i| i.os), Some(Some("linux".into())));
        let r = node_backend().exec(&config, "echo hi", ExecOptions::default()).await.unwrap();
        assert_eq!((r.code, r.stdout.as_str()), (0, "ran echo hi"));
        // the laptop listed more addresses than the phone had: they're kept for next time
        assert_eq!(*saved.borrow(), [("laptop".to_owned(), vec![LAN.to_owned(), "wss://tunnel.example".to_owned()])]);
        // the only hello without a secret is the reconnect
        assert_eq!(m.hellos.borrow()[1], json!({ "name": "Test phone" }));
    });
}

#[test]
fn a_computer_that_forgot_the_phone_says_so_and_is_not_asked_again() {
    on_core(|| async {
        let net = net();
        let m = FakeMachine::new(9);
        net.put(LAN, Answer::Machine(m.clone()));
        let (links, _) = phone(&net);
        links.ensure(&laptop(&m, "laptop", &[LAN]));
        until("refused", || node_link::why("laptop").is_some()).await;
        assert!(node_link::why("laptop").unwrap().starts_with("This phone isn't paired with this computer any more."));
        let dialed = net.dialed.borrow().len();
        tokio::time::sleep(Duration::from_secs(120)).await;
        assert_eq!(net.dialed.borrow().len(), dialed);
        // removed: its error goes with it
        links.forget("laptop", None);
        assert_eq!(node_link::why("laptop"), None);
    });
}

#[test]
fn a_dead_address_and_an_impostor_give_way_to_the_published_one() {
    on_core(|| async {
        let net = net();
        let m = FakeMachine::new(9);
        net.put("ws://10.0.0.9:1", Answer::Garbage);
        net.put("wss://new-tunnel.example", Answer::Machine(m.clone()));
        net.published.borrow_mut().insert(m.id.id.clone(), inyon_link::Record { urls: vec!["wss://new-tunnel.example".into()], relays: vec![], machine: None, name: None });
        let (links, _) = phone(&net);
        m.paired.borrow_mut().push(Identity::from_seed([1; 32]).noise.public);
        let r = links.0.reach.reach(&Identity::from_seed([1; 32]).noise, &m.id.id, &["ws://10.0.0.9:1".into(), "ws://10.0.0.8:1".into()], &[], &json!({})).await.unwrap();
        assert_eq!((r.url.as_str(), r.urls.clone()), ("wss://new-tunnel.example", vec!["wss://new-tunnel.example".to_owned()]));
        // the impostor's socket was closed as a bad handshake
        assert!(net.closed.borrow().iter().any(|(u, c, _)| u == "ws://10.0.0.9:1" && *c == 4401));
    });
}

#[test]
fn when_nothing_answers_the_error_says_what_to_check_and_where_something_else_was() {
    on_core(|| async {
        let net = net();
        let m = FakeMachine::new(9);
        net.put("ws://10.0.0.9:1", Answer::Garbage);
        net.put("ws://10.0.0.7:1", Answer::Silent);
        let (links, _) = phone(&net);
        let me = Identity::from_seed([1; 32]).noise;
        let e = links.0.reach.reach(&me, &m.id.id, &["ws://10.0.0.9:1".into(), "ws://10.0.0.7:1".into()], &[], &json!({})).await.err().unwrap();
        assert_eq!(
            e.message(),
            "Couldn't find the computer online. Is `inyon link` running there? It needs to be on and connected to the internet. (something else answered at 10.0.0.9:1)"
        );
        // the silent one was given up on after its time
        assert!(net.closed.borrow().iter().any(|(u, _, _)| u == "ws://10.0.0.7:1"));
    });
}

#[test]
fn relays_come_last_and_a_page_on_https_skips_plain_addresses() {
    on_core(|| async {
        let net = net();
        let m = FakeMachine::new(9);
        m.paired.borrow_mut().push(Identity::from_seed([1; 32]).noise.public);
        let relayed = relay_ws("https://relay.example", &phone_path(&m.id.id));
        net.put(&relayed, Answer::Machine(m.clone()));
        net.put(LAN, Answer::Machine(m.clone()));
        let (links, _) = phone(&net);
        let reach = Reach { plain_ws: false, ..links.0.reach.clone() };
        let me = Identity::from_seed([1; 32]).noise;
        let r = reach.reach(&me, &m.id.id, &[LAN.into()], &["https://relay.example".into()], &json!({})).await.unwrap();
        assert_eq!(r.url, relayed);
        assert!(!net.dialed.borrow().iter().any(|u| u == LAN));
    });
}

#[test]
fn a_laptop_that_stops_answering_pings_is_dropped_and_comes_back() {
    on_core(|| async {
        let net = net();
        let m = FakeMachine::new(9);
        net.put(LAN, Answer::Machine(m.clone()));
        let (links, _) = phone(&net);
        links.pair(&code(&m, &[LAN])).await.unwrap();
        links.ensure(&laptop(&m, "laptop", &[LAN]));
        until("connected", || node_link::is_up("laptop")).await;
        // answered: still up after the check
        links.resume();
        tokio::time::sleep(Duration::from_secs(4)).await;
        assert!(node_link::is_up("laptop"));
        m.answers_pings.set(false);
        links.resume();
        until("dropped", || !node_link::is_up("laptop")).await;
        assert!(net.closed.borrow().iter().any(|(_, c, r)| *c == 4408 && r == "no answer"));
        m.answers_pings.set(true);
        until("back", || node_link::is_up("laptop")).await;
        // it vanishes: down, then back on its own
        m.vanish();
        until("gone", || !node_link::is_up("laptop")).await;
        until("back again", || node_link::is_up("laptop")).await;
    });
}

#[test]
fn removing_a_computer_tells_it_to_forget_the_phone_now_or_once_it_answers() {
    on_core(|| async {
        let net = net();
        let m = FakeMachine::new(9);
        net.put(LAN, Answer::Machine(m.clone()));
        let (links, _) = phone(&net);
        links.pair(&code(&m, &[LAN])).await.unwrap();
        let config = laptop(&m, "laptop", &[LAN]);
        links.ensure(&config);
        until("connected", || node_link::is_up("laptop")).await;
        assert!(links.forget("laptop", None));
        until("told", || m.paired.borrow().is_empty()).await;
        // asked again until it says the phone isn't paired there
        until("settled", || links.pending_unpairs().is_empty()).await;

        // one that's away when it's removed hears once it's back
        links.pair(&code(&m, &[LAN])).await.unwrap();
        net.put(LAN, Answer::Down);
        assert!(!links.forget("laptop", Some(&config)));
        assert_eq!(links.pending_unpairs()[0].machine_id, m.id.id);
        tokio::time::sleep(Duration::from_secs(10)).await;
        assert_eq!(m.paired.borrow().len(), 1);
        net.put(LAN, Answer::Machine(m.clone()));
        links.resume();
        until("told later", || m.paired.borrow().is_empty() && links.pending_unpairs().is_empty()).await;

        // paired again before it heard: that pairing stands
        net.put(LAN, Answer::Down);
        links.pair(&code(&m, &[LAN])).await.err();
        assert!(!links.forget("laptop", Some(&config)));
        net.put(LAN, Answer::Machine(m.clone()));
        links.pair(&code(&m, &[LAN])).await.unwrap();
        assert!(links.pending_unpairs().is_empty());
        tokio::time::sleep(Duration::from_secs(30)).await;
        assert_eq!(m.paired.borrow().len(), 1);
    });
}

#[test]
fn a_computer_removed_while_connecting_leaves_no_error_behind() {
    on_core(|| async {
        let net = net();
        let m = FakeMachine::new(9);
        net.put(LAN, Answer::Silent);
        let (links, _) = phone(&net);
        links.ensure(&laptop(&m, "laptop3", &[LAN]));
        links.forget("laptop3", None);
        tokio::time::sleep(Duration::from_secs(30)).await;
        assert_eq!(node_link::why("laptop3"), None);
    });
}

#[test]
fn addresses_keep_a_direct_one_that_worked_first() {
    let l = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    assert_eq!(addresses("ws://10.0.0.5:1", &l(&["wss://t"])), l(&["ws://10.0.0.5:1", "wss://t"]));
    assert_eq!(addresses("wss://old-tunnel", &l(&["wss://t"])), l(&["wss://t"]));
    assert_eq!(addresses("wss://t", &l(&["ws://a", "wss://t"])), l(&["wss://t", "ws://a"]));
    for attempt in 0..40 {
        assert!(backoff(attempt, 1000, 30_000) < 30_000);
    }
}
