//! What the native tests share: tokio as the core's runtime, and a stand-in for the SSH plugin.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::future::LocalBoxFuture;
use inyon_core::platform::rt::{install, Deferred, Runtime};
use serde_json::{json, Value};

use crate::ssh::{OnEvent, PluginError, PluginResult, SshPlugin};

pub struct TokioRuntime;

impl Runtime for TokioRuntime {
    fn spawn(&self, fut: LocalBoxFuture<'static, ()>) {
        tokio::task::spawn_local(fut);
    }
    fn sleep(&self, ms: u64) -> LocalBoxFuture<'static, ()> {
        Box::pin(tokio::time::sleep(Duration::from_millis(ms)))
    }
    fn now_ms(&self) -> u64 {
        SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
    }
}

/// Runs `test` on a fresh core thread, with tokio's clock paused (sleeps pass at once).
pub fn on_core<F: std::future::Future<Output = ()>>(test: impl FnOnce() -> F) {
    let rt = tokio::runtime::Builder::new_current_thread().enable_time().start_paused(true).build().unwrap();
    tokio::task::LocalSet::new().block_on(&rt, async move {
        install(Rc::new(TokioRuntime));
        test().await;
    });
}

pub const FINGERPRINT: &str = "SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";

/// The native plugin, played back: calls are recorded, secrets kept in memory, and every server
/// refuses commands unless a test says otherwise.
#[derive(Default)]
pub struct FakeSsh {
    pub calls: RefCell<Vec<(String, Value)>>,
    pub secrets: RefCell<HashMap<String, String>>,
    listeners: RefCell<Vec<OnEvent>>,
    /// methods that fail, and how
    pub fail: RefCell<HashMap<&'static str, PluginError>>,
    pub exec_answer: RefCell<Option<Value>>,
    /// while set, connecting waits for it: the plugin still dialing
    pub dialing: RefCell<Option<Deferred<()>>>,
}

impl FakeSsh {
    pub fn new() -> Rc<Self> {
        Rc::new(Self::default())
    }

    /// What the plugin was asked to do with `method`, in order.
    pub fn calls_of(&self, method: &str) -> Vec<Value> {
        self.calls.borrow().iter().filter(|(m, _)| m == method).map(|(_, a)| a.clone()).collect()
    }

    /// The plugin sending an event, as the native side does.
    pub fn emit(&self, event: &str, e: Value) {
        let listeners = self.listeners.borrow().clone();
        for l in listeners {
            l(event, &e);
        }
    }
}

impl SshPlugin for FakeSsh {
    fn call(&self, method: &'static str, args: Value) -> PluginResult {
        self.calls.borrow_mut().push((method.to_owned(), args.clone()));
        let failed = self.fail.borrow().get(method).cloned();
        let got = match failed {
            Some(e) => Err(e),
            None => Ok(match method {
                "probe" => json!({ "fingerprint": FINGERPRINT, "keyType": "ssh-ed25519" }),
                "exec" => self.exec_answer.borrow().clone().unwrap_or_else(|| json!({ "code": 1, "stdout": "", "stderr": "not in this test" })),
                "setSecret" => {
                    self.secrets.borrow_mut().insert(args["key"].as_str().unwrap_or_default().to_owned(), args["value"].as_str().unwrap_or_default().to_owned());
                    Value::Null
                }
                "getSecret" => json!({ "value": self.secrets.borrow().get(args["key"].as_str().unwrap_or_default()) }),
                "deleteSecret" => {
                    self.secrets.borrow_mut().remove(args["key"].as_str().unwrap_or_default());
                    Value::Null
                }
                _ => Value::Null,
            }),
        };
        let dialing = if method == "connect" { self.dialing.borrow().clone() } else { None };
        Box::pin(async move {
            if let Some(d) = dialing {
                d.wait().await;
            }
            got
        })
    }

    fn listen(&self, on: OnEvent) {
        self.listeners.borrow_mut().push(on);
    }
}
