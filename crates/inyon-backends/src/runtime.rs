//! The core's event loop on tokio: one thread, a current-thread runtime and a `LocalSet`, as
//! Bun's single event loop is for the TS hub.

use std::future::Future;
use std::rc::Rc;
use std::thread::JoinHandle;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::future::LocalBoxFuture;
use inyon_core::platform::rt::{install, Runtime};
use tokio::sync::{mpsc, oneshot};

/// [`Runtime`] on tokio: tasks go to the thread's `LocalSet`, timers to tokio's, and the clock is
/// the wall clock (`Date.now()`).
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

/// Runs `main` as the core on this thread until it ends: a current-thread runtime with IO, time
/// and child processes, a `LocalSet` for the core's tasks, and [`TokioRuntime`] installed. Tasks
/// still running when `main` returns are dropped with the runtime.
pub fn run_core<F: Future>(main: impl FnOnce() -> F) -> F::Output {
    let tokio = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("a tokio runtime");
    let local = tokio::task::LocalSet::new();
    local.block_on(&tokio, async move {
        install(Rc::new(TokioRuntime));
        main().await
    })
}

type Job = Box<dyn FnOnce() -> LocalBoxFuture<'static, ()> + Send>;

/// Work for the core from other threads. Jobs start on the core's thread in the order they were
/// sent, each as a task of its own, as Bun runs request handlers.
#[derive(Clone)]
pub struct CoreHandle {
    tx: mpsc::UnboundedSender<Job>,
}

/// The core's thread has ended, so the job never ran (or never finished).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoreGone;

impl std::fmt::Display for CoreGone {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("the hub's core has stopped")
    }
}

impl std::error::Error for CoreGone {}

impl CoreHandle {
    /// Runs `job` on the core's thread and gives back what it returns. The job itself (a closure)
    /// is sent across threads; the future it makes, and everything it touches, stays on the core's.
    pub fn call<R, Fut>(&self, job: impl FnOnce() -> Fut + Send + 'static) -> impl Future<Output = Result<R, CoreGone>> + Send + 'static
    where
        R: Send + 'static,
        Fut: Future<Output = R> + 'static,
    {
        let (done, answer) = oneshot::channel();
        let sent = self
            .tx
            .send(Box::new(move || {
                Box::pin(async move {
                    let _ = done.send(job().await);
                }) as LocalBoxFuture<'static, ()>
            }))
            .is_ok();
        async move {
            if !sent {
                return Err(CoreGone);
            }
            answer.await.map_err(|_| CoreGone)
        }
    }

    /// Starts `job` on the core's thread without waiting for it.
    pub fn send<Fut: Future<Output = ()> + 'static>(&self, job: impl FnOnce() -> Fut + Send + 'static) -> Result<(), CoreGone> {
        self.tx.send(Box::new(move || Box::pin(job()) as LocalBoxFuture<'static, ()>)).map_err(|_| CoreGone)
    }
}

/// Starts the core's thread: `init` runs there first (plug in the store and the backends, start the
/// registry), then jobs from the returned handle until every handle is dropped.
pub fn core_thread(init: impl FnOnce() + Send + 'static) -> (CoreHandle, JoinHandle<()>) {
    let (tx, mut rx) = mpsc::unbounded_channel::<Job>();
    let thread = std::thread::Builder::new()
        .name("inyon-core".into())
        .spawn(move || {
            run_core(|| async move {
                init();
                while let Some(job) = rx.recv().await {
                    inyon_core::platform::rt::spawn(job());
                }
            })
        })
        .expect("the core's thread");
    (CoreHandle { tx }, thread)
}
