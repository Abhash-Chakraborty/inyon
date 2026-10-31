//! The organize routes, and how a change reaches the apps: in the v1 overview (an older app just
//! sees one field more) and on the `/ws2` organize stream, as snapshot and deltas.

use std::cell::RefCell;
use std::rc::Rc;

use inyon_chat_core::v2::{decode, Organize2};
use inyon_core::features::organize;
use inyon_core::hosts::host::Host;
use inyon_core::hosts::registry::{registry, HostRuntime};
use inyon_core::platform::store::kv;
use inyon_protocol::{HostState, ServerMsg, ServerMsg2, StreamPos};
use serde_json::{json, Value};

use crate::clients::{add as add_client, client_message, close_client, listen, new_client, new_client2, wire};
use crate::http::test_req;
use crate::routes::{dispatch, Routes};
use crate::streams::{client_message2, Wire};

fn machine() -> HostState {
    serde_json::from_value(json!({
        "config": { "id": "h", "name": "h", "kind": "ssh" }, "status": "online", "integration": "unknown", "tmux": "ok", "agents": [], "updatedAt": 0,
        "sessions": [{ "id": "$1", "name": "work", "attached": 0, "windows": [{ "id": "@1", "index": 0, "name": "w", "active": true, "activity": 0, "panes": [
            { "id": "%7", "index": 0, "active": true, "command": "claude", "cwd": "/w/inyon", "title": "claude", "width": 100, "height": 30, "dead": false,
              "agent": { "kind": "claude", "pid": 1, "state": "idle", "sessionId": "conv-7" } },
            { "id": "%8", "index": 1, "active": false, "command": "zsh", "cwd": "/w", "title": "zsh", "width": 100, "height": 30, "dead": false }
        ] }] }],
    }))
    .unwrap()
}

fn setup() -> Routes {
    organize::reset();
    kv::del(organize::KEY);
    let state = machine();
    let rt = Rc::new(RefCell::new(HostRuntime::new(Host::new(state.config.clone()), state)));
    rt.borrow_mut().hold_polls();
    registry().insert_runtime("h", rt);
    listen();
    let mut routes = Routes::default();
    crate::core_routes::add(&mut routes);
    routes
}

async fn ask(routes: &Routes, method: &str, path: &str, body: Value) -> (u16, Value) {
    let res = dispatch(routes, test_req(method, path, &[("content-type", "application/json")], &body.to_string())).await.expect("a route");
    let status = res.status().as_u16();
    let bytes = res.into_body().bytes().await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

#[test]
fn the_routes_change_what_every_device_reads() {
    crate::test_util::block(async {
        let r = setup();
        let (status, v) = ask(&r, "PATCH", "/api/hosts/h/panes/7/organize", json!({ "pinned": true, "tags": ["Review"], "note": "the menu" })).await;
        assert_eq!(status, 200, "{v}");
        let sid = v["session"]["id"].as_str().unwrap().to_owned();
        assert_eq!((v["session"]["pinned"].clone(), v["session"]["tags"].clone(), v["session"]["conv"].clone()), (json!(0), json!(["review"]), json!("conv-7")));

        let (_, all) = ask(&r, "GET", "/api/organize", json!(null)).await;
        assert_eq!(all["v"], json!(1));
        assert_eq!(all["sessions"][0]["live"], json!(true));
        // the overview a client reads over HTTP carries it too
        let (_, o) = ask(&r, "GET", "/api/overview", json!(null)).await;
        assert_eq!(o["organize"]["sessions"][0]["id"], json!(sid));

        let (status, v) = ask(&r, "PATCH", "/api/hosts/h/panes/7/organize", json!({ "note": "n".repeat(501) })).await;
        assert_eq!((status, v["error"].as_str()), (400, Some("A note can be at most 500 characters")));
        let (status, _) = ask(&r, "PATCH", "/api/hosts/h/panes/99/organize", json!({ "parked": true })).await;
        assert_eq!(status, 404);

        let (status, p) = ask(&r, "POST", "/api/organize/projects", json!({ "name": "Inyon", "color": "sage", "roots": [{ "host": "h", "path": "/w/inyon" }] })).await;
        assert_eq!(status, 200, "{p}");
        let pid = p["id"].as_str().unwrap().to_owned();
        let (status, p) = ask(&r, "PATCH", &format!("/api/organize/projects/{pid}"), json!({ "color": "teal" })).await;
        assert_eq!((status, p["color"].as_str()), (200, Some("teal")));
        let (_, g) = ask(&r, "POST", "/api/organize/groups", json!({ "name": "Work" })).await;
        let (_, w) = ask(&r, "POST", "/api/organize/spaces", json!({ "name": "Focus", "projects": [pid] })).await;
        let (status, _) = ask(&r, "PUT", "/api/organize/order", json!({ "projects": [pid], "groups": [g["id"]], "spaces": [w["id"]] })).await;
        assert_eq!(status, 200);

        let (status, v) = ask(&r, "PATCH", &format!("/api/organize/sessions/{sid}"), json!({ "pinned": false, "tags": null, "note": null })).await;
        assert_eq!((status, v["session"].clone()), (200, Value::Null), "nothing left on it: forgotten");
        let (status, _) = ask(&r, "DELETE", &format!("/api/organize/sessions/{sid}"), json!(null)).await;
        assert_eq!(status, 404);
        for path in
            [format!("/api/organize/spaces/{}", w["id"].as_str().unwrap()), format!("/api/organize/groups/{}", g["id"].as_str().unwrap()), format!("/api/organize/projects/{pid}")]
        {
            assert_eq!(ask(&r, "DELETE", &path, json!(null)).await.0, 200, "{path}");
        }
        let (_, all) = ask(&r, "GET", "/api/organize", json!(null)).await;
        assert_eq!(all, json!({ "v": 1, "sessions": [], "projects": [], "groups": [], "spaces": [] }));
    });
}

#[test]
fn a_change_reaches_v1_apps_in_the_overview_and_a_quiet_one_when_it_comes_back() {
    crate::test_util::block(async {
        let r = setup();
        let got = Rc::new(RefCell::new(Vec::<ServerMsg>::new()));
        let g = got.clone();
        let c = new_client(move |m| g.borrow_mut().push(m.clone()));
        add_client(&c);
        client_message(&c, r#"{"t":"sub.overview"}"#);
        let last_organize = |got: &Rc<RefCell<Vec<ServerMsg>>>| match got.borrow().last() {
            Some(ServerMsg::Overview { organize, .. }) => organize.clone().map(|o| *o),
            other => panic!("not an overview: {other:?}"),
        };
        assert_eq!(last_organize(&got).unwrap().sessions.len(), 0);
        ask(&r, "PATCH", "/api/hosts/h/panes/7/organize", json!({ "parked": true })).await;
        let org = last_organize(&got).unwrap();
        assert_eq!((org.sessions.len(), org.sessions[0].parked), (1, Some(true)));
        assert!(wire(got.borrow().last().unwrap()).starts_with(r#"{"t":"overview","hosts":["#), "hosts first, as an old app reads it");

        client_message(&c, r#"{"t":"quiet","on":true}"#);
        let n = got.borrow().len();
        ask(&r, "PATCH", "/api/hosts/h/panes/8/organize", json!({ "pinned": true })).await;
        assert_eq!(got.borrow().len(), n, "in the background: nothing");
        client_message(&c, r#"{"t":"quiet","on":false}"#);
        assert_eq!(last_organize(&got).unwrap().sessions.len(), 2, "back: all of it");
        close_client(&c);
    });
}

/// A `/ws2` app's frames for the organize stream, decoded.
fn frames(got: &Rc<RefCell<Vec<Wire>>>) -> Vec<ServerMsg2> {
    got.borrow_mut()
        .drain(..)
        .filter_map(|w| match w {
            Wire::Text(t) => decode(Some(&t), None).ok(),
            Wire::Binary(b) => decode(None, Some(&b)).ok(),
        })
        .filter(|f| f.stream() == Some("organize"))
        .collect()
}

#[test]
fn the_organize_stream_sends_a_snapshot_then_only_what_changed() {
    crate::test_util::block(async {
        let r = setup();
        ask(&r, "PATCH", "/api/hosts/h/panes/7/organize", json!({ "pinned": true })).await;
        let got = Rc::new(RefCell::new(Vec::<Wire>::new()));
        let g = got.clone();
        let c = new_client2(move |w| g.borrow_mut().push(w));
        add_client(&c);
        client_message2(&c, &json!({ "t": "sub", "stream": "organize" }).to_string());
        let mut view = Organize2::default();
        let f = frames(&got);
        assert!(matches!(f[..], [ServerMsg2::Snapshot(_)]), "{f:?}");
        let (org, _) = view.apply(&f[0]);
        assert_eq!(org.unwrap().sessions[0].pinned, Some(0));

        ask(&r, "PATCH", "/api/hosts/h/panes/8/organize", json!({ "tags": ["shell"] })).await;
        let f = frames(&got);
        let ServerMsg2::Delta(d) = &f[0] else { panic!("{f:?}") };
        assert_eq!((d.append.as_ref().and_then(|a| a.sessions.as_ref()).map(Vec::len), d.replace.is_none()), (Some(1), true), "{d:?}");
        let (org, resync) = view.apply(&f[0]);
        assert_eq!((org.unwrap().sessions.len(), resync), (2, None));
        let at: StreamPos = view.cursor.at().unwrap();
        close_client(&c);

        // away for a while: back with where it was, one delta with what changed
        ask(&r, "PATCH", "/api/hosts/h/panes/7/organize", json!({ "pinned": false })).await;
        let got = Rc::new(RefCell::new(Vec::<Wire>::new()));
        let g = got.clone();
        let c = new_client2(move |w| g.borrow_mut().push(w));
        add_client(&c);
        client_message2(&c, &json!({ "t": "sub", "stream": "organize", "at": at }).to_string());
        let f = frames(&got);
        let ServerMsg2::Delta(d) = &f[0] else { panic!("{f:?}") };
        assert_eq!((d.from, d.remove.as_ref().and_then(|k| k.sessions.clone()).map(|s| s.len())), (at.seq, Some(1)), "{d:?}");
        let (org, _) = view.apply(&f[0]);
        assert_eq!(org.unwrap().sessions.len(), 1);
        close_client(&c);
    });
}
