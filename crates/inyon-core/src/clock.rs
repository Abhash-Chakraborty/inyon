//! The time, for the few readers that compare against it (Codex's elapsed-time spinner, the send
//! ledger). Native builds read the system clock; wasm has none of its own, so the host that embeds
//! the core sets it (`set_now`), and tests pin it the same way.

use std::cell::Cell;

thread_local! {
    static NOW: Cell<Option<u64>> = const { Cell::new(None) };
}

/// `Date.now()`: milliseconds since the epoch.
pub fn now_ms() -> u64 {
    if let Some(t) = NOW.with(Cell::get) {
        return t;
    }
    system_ms()
}

/// Pins the clock for this thread (`None` goes back to the system clock).
pub fn set_now(ms: Option<u64>) {
    NOW.with(|n| n.set(ms));
}

#[cfg(not(target_arch = "wasm32"))]
fn system_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

#[cfg(target_arch = "wasm32")]
fn system_ms() -> u64 {
    0
}
