//! When a repeating message sent later goes next (from 0.27): every few hours from its first time,
//! or at a time of day (every day, on weekdays, or once a week) in the time zone of the device that
//! set it. A time of day is a wall-clock time, so 9:00 stays 9:00 when the clocks change: a time
//! the change skips (2:30 on the night they go forward) goes at the same distance past it (3:30),
//! and a time that happens twice (2:30 on the night they go back) goes the first time.
//!
//! Offsets come from the system's time zones on a hub (the zoneinfo files, Android's tzdata, a
//! copy built in on Windows). The phone's wasm core plugs in the browser's instead
//! ([`set_offsets`]). Where the zone isn't known, the offset the device had when it set the rule
//! is used all year.

use std::cell::RefCell;
use std::rc::Rc;

use inyon_protocol::{Repeat, RepeatEvery, REPEAT_HOURS_MAX};
use serde_json::{Map, Value};

use crate::hosts::http_error::{http, HubResult};

const MIN_MS: i64 = 60_000;
const HOUR_MS: u64 = 3_600_000;
const DAY_MS: i64 = 86_400_000;
/// The furthest any zone is from UTC, in minutes (Kiribati is 14 hours ahead).
const OFFSET_MAX: i32 = 14 * 60;

/// Seconds east of UTC in a zone at a time (unix ms), or None for a zone it doesn't know.
pub type Offsets = Rc<dyn Fn(&str, i64) -> Option<i32>>;

thread_local! {
    static OFFSETS: RefCell<Option<Offsets>> = const { RefCell::new(None) };
}

/// Where the offsets come from (the phone's wasm core, tests); None goes back to the system's.
pub fn set_offsets(f: Option<Offsets>) {
    OFFSETS.with(|o| *o.borrow_mut() = f);
}

/// Seconds east of UTC in `tz` at `ms`, or None when the zone isn't known here.
pub fn zone_offset(tz: &str, ms: i64) -> Option<i32> {
    if let Some(f) = OFFSETS.with(|o| o.borrow().clone()) {
        return f(tz, ms);
    }
    system_offset(tz, ms)
}

#[cfg(not(target_arch = "wasm32"))]
fn system_offset(tz: &str, ms: i64) -> Option<i32> {
    let zone = jiff::tz::TimeZone::get(tz).ok()?;
    let t = jiff::Timestamp::from_millisecond(ms).ok()?;
    Some(zone.to_offset(t).seconds())
}

#[cfg(target_arch = "wasm32")]
fn system_offset(_tz: &str, _ms: i64) -> Option<i32> {
    None
}

/// Milliseconds east of UTC for the rule at `ms`: its zone's, else the offset it was set with.
fn offset_ms(r: &Repeat, ms: i64) -> i64 {
    zone_offset(&r.tz, ms).map_or(i64::from(r.offset) * MIN_MS, |s| i64::from(s) * 1000)
}

/// 0 is Sunday, for a day counted from 1 January 1970 (a Thursday).
fn weekday(day: i64) -> u32 {
    (day + 4).rem_euclid(7) as u32
}

/// The instant a local time happens (`local` is the wall clock read as if it were UTC). Of a time
/// that happens twice, the first; a time the clocks skip is read with the offset from before the
/// change, which puts it as far past the change as it was meant to be.
fn local_to_utc(local: i64, off: &dyn Fn(i64) -> i64) -> i64 {
    let (before, after) = (off(local - DAY_MS), off(local + DAY_MS));
    [before, after].into_iter().map(|o| local - o).filter(|u| local - off(*u) == *u).min().unwrap_or(local - before)
}

/// Whether the rule goes on this day of the week.
fn on_day(r: &Repeat, wd: u32) -> bool {
    match r.every {
        RepeatEvery::Hours | RepeatEvery::Day => true,
        RepeatEvery::Weekdays => (1..=5).contains(&wd),
        RepeatEvery::Week => r.day == Some(wd),
    }
}

/// The first time the rule goes after `after` (unix ms). `anchor` is a time it went or was due:
/// "every few hours" counts on from it. None for a rule that can't go (missing its time of day).
pub fn next_run(r: &Repeat, anchor: u64, after: u64) -> Option<u64> {
    if r.every == RepeatEvery::Hours {
        let step = u64::from(r.hours.filter(|h| (1..=REPEAT_HOURS_MAX).contains(h))?) * HOUR_MS;
        if anchor > after {
            return Some(anchor);
        }
        return Some(anchor + ((after - anchor) / step + 1) * step);
    }
    let minute = i64::from(r.minute.filter(|m| *m < 24 * 60)?);
    let off = |u: i64| offset_ms(r, u);
    let after = after as i64;
    let today = (after + off(after)).div_euclid(DAY_MS);
    // a week and a day covers every rule, whatever day it is now
    (today..=today + 8).filter(|d| on_day(r, weekday(*d))).map(|d| local_to_utc(d * DAY_MS + minute * MIN_MS, &off)).find(|u| *u > after).map(|u| u as u64)
}

/// A rule as an app sends it (`{ every, hours | minute, day, tz, offset }`), checked, with only the
/// fields its kind uses.
pub fn read_repeat(v: &Value) -> HubResult<Repeat> {
    let b: &Map<String, Value> = v.as_object().ok_or_else(|| http(400, "repeat must be an object"))?;
    let every: RepeatEvery = b.get("every").and_then(|e| serde_json::from_value(e.clone()).ok()).ok_or_else(|| http(400, "repeat.every must be hours, day, weekdays or week"))?;
    let int = |k: &str| b.get(k).and_then(Value::as_f64).filter(|n| n.fract() == 0.0);
    let tz = b.get("tz").and_then(Value::as_str).unwrap_or_default();
    if tz.is_empty() || tz.len() > 64 || !tz.chars().all(|c| c.is_ascii_alphanumeric() || "_+-/".contains(c)) {
        return Err(http(400, "repeat.tz must be a time zone's name"));
    }
    let offset = int("offset").filter(|o| o.abs() <= f64::from(OFFSET_MAX)).ok_or_else(|| http(400, "repeat.offset must be the minutes east of UTC"))? as i32;
    let mut r = Repeat { every, hours: None, minute: None, day: None, tz: tz.to_owned(), offset };
    if every == RepeatEvery::Hours {
        r.hours =
            Some(int("hours").filter(|h| (1.0..=f64::from(REPEAT_HOURS_MAX)).contains(h)).ok_or_else(|| http(400, format!("Pick every 1 to {REPEAT_HOURS_MAX} hours")))? as u32);
        return Ok(r);
    }
    r.minute = Some(int("minute").filter(|m| (0.0..1440.0).contains(m)).ok_or_else(|| http(400, "repeat.minute must be a time of day, 0 to 1439"))? as u32);
    if every == RepeatEvery::Week {
        r.day = Some(int("day").filter(|d| (0.0..=6.0).contains(d)).ok_or_else(|| http(400, "repeat.day must be a day of the week, 0 (Sunday) to 6"))? as u32);
    }
    Ok(r)
}

#[cfg(test)]
#[path = "repeat_tests.rs"]
mod tests;
