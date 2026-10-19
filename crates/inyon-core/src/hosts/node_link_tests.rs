//! hosts/node-link.test.ts

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use serde_json::{json, Value};

use super::*;
use crate::hosts::host::{ExecOptions, HostBackend};
use crate::hosts::node_backend::NodeBackend;
use crate::platform::rt::Deferred;
use crate::test_support::rt::{run, wait};

#[derive(Default)]
struct FakeSocket {
    sent: RefCell<Vec<Value>>,
    closed: Cell<bool>,
    on_close: RefCell<Option<Box<dyn Fn()>>>,
}

impl NodeSocket for FakeSocket {
    fn send(&self, data: &str) {
        self.sent.borrow_mut().push(serde_json::from_str(data).unwrap());
    }
    fn close(&self, _code: u16, _reason: &str) {
        self.closed.set(true);
        if let Some(f) = self.on_close.borrow().as_ref() {
            f();
        }
    }
}

fn config(id: &str) -> inyon_protocol::HostConfig {
    serde_json::from_value(json!({ "id": id, "name": id, "kind": "node" })).unwrap()
}

/// Whether the promise settles within 50 ms.
async fn settled(p: &Deferred<i32>) -> bool {
    wait(50).await;
    p.is_settled()
}

#[test]
fn a_newer_connection_fails_the_old_ones_streams_and_terminals_even_when_the_old_close_comes_later() {
    run(|| async {
        let c = config("replace-late");
        let old = Rc::new(FakeSocket::default());
        let old_s: Socket = old.clone();
        attach(&c.id, old_s.clone());
        let stream = NodeBackend.stream(&c, "tail", Box::new(|_| {}), false);
        let pty = NodeBackend.pty(&c, "sh", 80, 24, Box::new(|_| {})).unwrap();
        let next = Rc::new(FakeSocket::default());
        let next_s: Socket = next.clone();
        attach(&c.id, next_s.clone());
        assert!(old.closed.get());
        assert!(settled(&stream.exited).await);
        assert!(settled(&pty.exited).await);

        // what the old operations still try to say stays off the new socket
        pty.write("ls\n");
        stream.kill();
        assert!(next.sent.borrow().is_empty());

        // the old socket's own close callback arrives afterwards and leaves the new one alone
        let fresh = NodeBackend.stream(&c, "tail", Box::new(|_| {}), false);
        detach(&c.id, &old_s);
        assert!(is_up(&c.id));
        assert!(!settled(&fresh.exited).await);
        fresh.kill();
        detach(&c.id, &next_s);
    });
}

#[test]
fn the_same_holds_when_the_old_socket_reports_its_close_straight_away() {
    run(|| async {
        let c = config("replace-sync");
        let old = Rc::new(FakeSocket::default());
        let old_s: Socket = old.clone();
        let (id, me) = (c.id.clone(), old_s.clone());
        *old.on_close.borrow_mut() = Some(Box::new(move || detach(&id, &me)));
        attach(&c.id, old_s.clone());
        let stream = NodeBackend.stream(&c, "tail", Box::new(|_| {}), false);
        let next: Socket = Rc::new(FakeSocket::default());
        attach(&c.id, next.clone());
        assert!(settled(&stream.exited).await);
        assert!(is_up(&c.id));
        detach(&c.id, &next);
        // the socket holds a closure that holds the socket: let it go
        old.on_close.borrow_mut().take();
    });
}

#[test]
fn acting_on_a_machine_that_isnt_connected_answers_503_with_a_sentence_the_app_can_show() {
    run(|| async {
        let e = NodeBackend.exec(&config("not-connected"), "true", ExecOptions::default()).await.unwrap_err();
        assert_eq!(e.status, Some(503));
        assert_eq!(e.message, "This machine is not connected. Is inyon running on it?");
    });
}

#[test]
fn frames_carry_the_operation_then_its_id_and_replies_come_back_by_id() {
    run(|| async {
        let c = config("frames");
        let ws = Rc::new(FakeSocket::default());
        attach(&c.id, ws.clone());
        let run = NodeBackend.exec(&c, "echo hi", ExecOptions::input("x"));
        let sent = ws.sent.borrow()[0].clone();
        assert_eq!(crate::js::stringify(&sent), r#"{"op":"exec","cmd":"echo hi","input":"eA==","id":"1"}"#);
        message(&c.id, r#"{"id":"1","type":"exit","code":0,"stdout":"hi\n","stderr":""}"#);
        let r = run.await.unwrap();
        assert_eq!((r.code, r.stdout.as_str()), (0, "hi\n"));
        receive(&c.id, &json!({ "type": "hello", "version": "0.20.0", "os": "linux x64" }));
        assert_eq!(info(&c.id).unwrap().version.as_deref(), Some("0.20.0"));
    });
}

#[test]
fn an_exec_that_gets_no_answer_times_out_and_kills_the_command() {
    run(|| async {
        let c = config("slow");
        let ws = Rc::new(FakeSocket::default());
        attach(&c.id, ws.clone());
        let r = NodeBackend.exec(&c, "sleep 9", ExecOptions::timeout(1000)).await.unwrap();
        assert_eq!((r.code, r.stderr.as_str()), (124, "timed out"));
        assert_eq!(ws.sent.borrow()[1], json!({ "op": "kill", "id": "1" }));
    });
}
