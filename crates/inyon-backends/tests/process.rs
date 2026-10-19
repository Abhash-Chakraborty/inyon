//! The process backend against real processes: output, input, exit codes, timeouts that take the
//! whole pipeline, streams, terminals, and the ssh command line.
//! These run /bin/sh, so they only run where there is one.

#![cfg(unix)]

use std::cell::RefCell;
use std::rc::Rc;
use std::time::{Duration, Instant};

use inyon_backends::process::ProcessBackend;
use inyon_backends::runtime::run_core;
use inyon_core::hosts::host::{ExecOptions, HostBackend};
use inyon_protocol::HostConfig;
use serde_json::json;

fn local() -> HostConfig {
    serde_json::from_value(json!({ "id": "local", "name": "local", "kind": "local" })).unwrap()
}

#[test]
fn a_command_gives_its_output_its_errors_and_its_exit_code() {
    run_core(|| async {
        let b = ProcessBackend::new("/tmp", vec![]);
        let r = b.exec(&local(), "echo out; echo err >&2; exit 3", ExecOptions::default()).await.unwrap();
        assert_eq!((r.code, r.stdout.as_str(), r.stderr.as_str()), (3, "out\n", "err\n"));
        let r = b.exec(&local(), "tr a-z A-Z", ExecOptions::input("shout")).await.unwrap();
        assert_eq!(r.stdout, "SHOUT");
        // nothing on stdin unless given: a command reading it ends at once
        let r = b.exec(&local(), "cat; echo done", ExecOptions::default()).await.unwrap();
        assert_eq!(r.stdout, "done\n");
    });
}

#[test]
fn a_timeout_ends_the_whole_pipeline_and_says_so() {
    run_core(|| async {
        let b = ProcessBackend::new("/tmp", vec![]);
        let t0 = Instant::now();
        // the sleep holds the pipe open: killing only the shell would leave the call waiting on it
        let r = b.exec(&local(), "echo started; sleep 30 | cat", ExecOptions::timeout(300)).await.unwrap();
        assert!(t0.elapsed() < Duration::from_secs(5), "{:?}", t0.elapsed());
        assert_eq!(r.code, 124);
        assert_eq!(r.stdout, "started\n");
        assert!(r.stderr.ends_with("timed out"), "{}", r.stderr);
    });
}

#[test]
fn old_tether_variables_reach_commands_under_their_inyon_names() {
    run_core(|| async {
        let b = ProcessBackend::new("/tmp", vec![("INYON_PORT_TEST".into(), "4999".into())]);
        let r = b.exec(&local(), "echo \"$INYON_PORT_TEST\"", ExecOptions::default()).await.unwrap();
        assert_eq!(r.stdout, "4999\n");
    });
}

#[test]
fn a_stream_hands_on_each_line_skips_empty_ones_and_ends_when_killed() {
    run_core(|| async {
        let b = ProcessBackend::new("/tmp", vec![]);
        let lines = Rc::new(RefCell::new(Vec::<String>::new()));
        let l = lines.clone();
        let h = b.stream(&local(), "printf 'one\\n\\ntwo\\nthr'; sleep 0.2; printf 'ee\\n'; sleep 30", Box::new(move |s| l.borrow_mut().push(s)), false);
        for _ in 0..100 {
            if lines.borrow().len() == 3 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(*lines.borrow(), ["one", "two", "three"]);
        assert!(!h.exited.is_settled());
        h.kill();
        let code = tokio::time::timeout(Duration::from_secs(5), h.exited.wait()).await.expect("the stream ended");
        assert_eq!(code, 128 + 15);
    });
}

#[test]
fn a_stream_that_keeps_stdin_open_stays_up_until_killed() {
    run_core(|| async {
        let b = ProcessBackend::new("/tmp", vec![]);
        let h = b.stream(&local(), "cat >/dev/null; echo eof", Box::new(|_| {}), true);
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(!h.exited.is_settled());
        h.kill();
        tokio::time::timeout(Duration::from_secs(5), h.exited.wait()).await.expect("the stream ended");
        // and without it, cat sees the end of its input at once
        let h = b.stream(&local(), "cat >/dev/null", Box::new(|_| {}), false);
        assert_eq!(tokio::time::timeout(Duration::from_secs(5), h.exited.wait()).await.unwrap(), 0);
    });
}

#[test]
fn a_terminal_runs_its_command_takes_typing_and_reports_its_exit() {
    run_core(|| async {
        let b = ProcessBackend::new("/tmp", vec![]);
        let out = Rc::new(RefCell::new(String::new()));
        let o = out.clone();
        let t = b.pty(&local(), "printf 'ready '; read x; echo \"got $x [$TERM]\"", 80, 24, Box::new(move |d| o.borrow_mut().push_str(&String::from_utf8_lossy(&d)))).unwrap();
        for _ in 0..100 {
            if out.borrow().contains("ready") {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        t.write("yo\r");
        let code = tokio::time::timeout(Duration::from_secs(5), t.exited.wait()).await.expect("the terminal's command ended");
        assert_eq!(code, 0);
        for _ in 0..50 {
            if out.borrow().contains("got yo") {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(out.borrow().contains("got yo [xterm-256color]"), "{}", out.borrow());
    });
}

#[test]
fn a_remote_machine_goes_through_ssh_with_one_shared_connection() {
    let b = ProcessBackend::new("/data/cm", vec![]);
    let c: HostConfig = serde_json::from_value(json!({ "id": "s", "name": "s", "kind": "ssh", "target": "me@box", "port": 2222, "identityFile": "/k/id" })).unwrap();
    assert_eq!(
        b.argv(&c, "echo 'hi'", false),
        [
            "ssh",
            "-o",
            "BatchMode=yes",
            "-o",
            "ControlMaster=auto",
            "-o",
            "ControlPath=/data/cm/%C",
            "-o",
            "ControlPersist=600",
            "-o",
            "ServerAliveInterval=15",
            "-o",
            "ServerAliveCountMax=3",
            "-o",
            "ConnectTimeout=10",
            "-o",
            "StrictHostKeyChecking=accept-new",
            "-p",
            "2222",
            "-i",
            "/k/id",
            "-T",
            "me@box",
            r"sh -c 'echo '\''hi'\'''",
        ]
    );
    assert_eq!(b.argv(&c, "tmux attach", true)[21], "-tt");
    assert_eq!(b.argv(&local(), "true", false), ["/bin/sh", "-c", "true"]);
}
