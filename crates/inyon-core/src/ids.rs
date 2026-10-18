//! `crypto.randomUUID()` for the rare record without an id of its own. The core can't reach the
//! system's randomness from wasm, and these ids only have to be unique within a conversation, so a
//! small generator seeded from the clock does.

use std::cell::Cell;

thread_local! {
    static STATE: Cell<u64> = const { Cell::new(0) };
}

fn next() -> u64 {
    STATE.with(|s| {
        let mut x = s.get();
        if x == 0 {
            x = crate::clock::now_ms() ^ 0x9e37_79b9_7f4a_7c15;
        }
        // xorshift64*
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        s.set(x);
        x.wrapping_mul(0x2545_f491_4f6c_dd1d)
    })
}

/// A version 4 UUID: "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".
pub fn random_uuid() -> String {
    let a = next();
    let b = next();
    let hi = (a & 0xffff_ffff_ffff_0fff) | 0x4000;
    let lo = (b & 0x3fff_ffff_ffff_ffff) | 0x8000_0000_0000_0000;
    format!("{:08x}-{:04x}-{:04x}-{:04x}-{:012x}", hi >> 32, (hi >> 16) & 0xffff, hi & 0xffff, lo >> 48, lo & 0xffff_ffff_ffff)
}
