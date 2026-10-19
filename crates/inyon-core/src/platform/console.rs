//! `console.log` and `console.error`: where the core's few lines of logging go. Native builds
//! write them to stderr until the platform says otherwise; wasm has nowhere to write by itself.

use std::cell::RefCell;
use std::rc::Rc;

/// Whether a line is `console.error` (true) or `console.log`.
pub type Sink = Rc<dyn Fn(bool, &str)>;

thread_local! {
    static SINK: RefCell<Option<Sink>> = const { RefCell::new(None) };
}

/// Sends this thread's log lines to `sink` (`None`: the default).
pub fn set_sink(sink: Option<Sink>) {
    SINK.with(|s| *s.borrow_mut() = sink);
}

fn write(error: bool, line: &str) {
    if let Some(f) = SINK.with(|s| s.borrow().clone()) {
        return f(error, line);
    }
    #[cfg(not(target_arch = "wasm32"))]
    eprintln!("{line}");
}

/// `console.log(line)`
pub fn log(line: &str) {
    write(false, line);
}

/// `console.error(line)`
pub fn error(line: &str) {
    write(true, line);
}
