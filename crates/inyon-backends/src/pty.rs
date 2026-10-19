//! Terminals: a command in a pseudo-terminal (the phone's terminal view), the `pty` half of
//! hosts/process-backend.ts. The terminal's reads and the wait for its child block, so each runs on
//! a thread of its own and hands what it gets to the core's thread through a channel.

use std::cell::RefCell;
use std::io::{Read, Write};
use std::rc::Rc;
use std::sync::{Arc, Mutex};

use inyon_core::hosts::host::{OnData, PtyHandle};
use inyon_core::hosts::http_error::{HubError, HubResult};
use inyon_core::platform::rt::Deferred;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use tokio::sync::{mpsc, oneshot};

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }
}

/// Starts `argv` in a pseudo-terminal of `cols`×`rows`, with TERM=xterm-256color and a UTF-8 LANG
/// unless one is set. `on_data` gets its output on the core's thread.
pub fn open(argv: &[String], env: &[(String, String)], cols: u16, rows: u16, mut on_data: OnData) -> HubResult<PtyHandle> {
    let err = |e: &dyn std::fmt::Display| HubError::plain(e.to_string());
    let pair = native_pty_system().openpty(size(cols, rows)).map_err(|e| err(&e))?;
    let mut cmd = CommandBuilder::new(&argv[0]);
    cmd.args(&argv[1..]);
    if let Ok(cwd) = std::env::current_dir() {
        cmd.cwd(cwd);
    }
    for (k, v) in env {
        cmd.env(k, v);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("LANG", std::env::var("LANG").ok().filter(|l| !l.is_empty()).unwrap_or_else(|| "C.UTF-8".into()));
    let mut child = pair.slave.spawn_command(cmd).map_err(|e| err(&e))?;
    drop(pair.slave);
    let master: Box<dyn MasterPty + Send> = pair.master;
    let mut reader = master.try_clone_reader().map_err(|e| err(&e))?;
    let writer: Arc<Mutex<Box<dyn Write + Send>>> = Arc::new(Mutex::new(master.take_writer().map_err(|e| err(&e))?));
    let killer: Arc<Mutex<Box<dyn ChildKiller + Send + Sync>>> = Arc::new(Mutex::new(child.clone_killer()));

    // output, read on a thread of its own and drawn on the core's
    let (data_tx, mut data_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut buf = [0u8; 16 * 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if data_tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });
    tokio::task::spawn_local(async move {
        while let Some(d) = data_rx.recv().await {
            on_data(d);
        }
    });

    let exited = Deferred::new();
    let (code_tx, code_rx) = oneshot::channel::<i32>();
    std::thread::spawn(move || {
        let code = child.wait().map(|s| s.exit_code() as i32).unwrap_or(1);
        let _ = code_tx.send(code);
    });
    let done = exited.clone();
    tokio::task::spawn_local(async move {
        done.resolve(code_rx.await.unwrap_or(1));
    });

    let master = Rc::new(RefCell::new(Some(master)));
    let (rm, km) = (master.clone(), master);
    Ok(PtyHandle::new(
        move |d: &str| {
            if let Ok(mut w) = writer.lock() {
                let _ = w.write_all(d.as_bytes());
                let _ = w.flush();
            }
        },
        move |c, r| {
            if let Some(m) = rm.borrow().as_ref() {
                let _ = m.resize(size(c, r));
            }
        },
        move || {
            if let Ok(mut k) = killer.lock() {
                let _ = k.kill();
            }
            // closes the terminal
            km.borrow_mut().take();
        },
        exited,
    ))
}
