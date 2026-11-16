//! The next time a repeating message goes: wall-clock times kept across daylight saving changes
//! both ways and in both hemispheres, month and year ends, every few hours from the first time,
//! and the rules an app may send.

use std::rc::Rc;

use inyon_protocol::{Repeat, RepeatEvery};
use serde_json::json;

use super::*;

/// unix ms of an RFC 3339 time
fn at(s: &str) -> u64 {
    s.parse::<jiff::Timestamp>().unwrap().as_millisecond() as u64
}

fn rule(every: RepeatEvery, tz: &str, minute: u32) -> Repeat {
    Repeat { every, hours: None, minute: Some(minute), day: None, tz: tz.into(), offset: 0 }
}

const NINE: u32 = 9 * 60;

#[test]
fn a_daily_time_stays_on_the_wall_clock_when_the_clocks_go_forward() {
    let r = rule(RepeatEvery::Day, "Europe/Berlin", NINE);
    // Berlin goes from +01:00 to +02:00 at 2:00 on 29 March 2026
    assert_eq!(next_run(&r, 0, at("2026-03-28T10:00:00+01:00")), Some(at("2026-03-29T09:00:00+02:00")));
    assert_eq!(next_run(&r, 0, at("2026-03-29T09:00:00+02:00")), Some(at("2026-03-30T09:00:00+02:00")), "strictly after");
    let ny = rule(RepeatEvery::Day, "America/New_York", NINE);
    assert_eq!(next_run(&ny, 0, at("2026-03-07T10:00:00-05:00")), Some(at("2026-03-08T09:00:00-04:00")));
    // Sydney goes forward on 4 October 2026
    let syd = rule(RepeatEvery::Day, "Australia/Sydney", NINE);
    assert_eq!(next_run(&syd, 0, at("2026-10-03T10:00:00+10:00")), Some(at("2026-10-04T09:00:00+11:00")));
}

#[test]
fn a_time_the_clocks_skip_goes_as_far_past_the_change_and_a_time_they_repeat_goes_once() {
    let r = rule(RepeatEvery::Day, "Europe/Berlin", 2 * 60 + 30);
    // 2:30 doesn't happen on 29 March: 3:30 summer time, an hour after 2:30 winter time would be
    assert_eq!(next_run(&r, 0, at("2026-03-28T12:00:00+01:00")), Some(at("2026-03-29T03:30:00+02:00")));
    // 2:30 happens twice on 25 October: the first one, then the next day's
    let first = next_run(&r, 0, at("2026-10-24T12:00:00+02:00")).unwrap();
    assert_eq!(first, at("2026-10-25T02:30:00+02:00"));
    assert_eq!(next_run(&r, 0, first), Some(at("2026-10-26T02:30:00+01:00")), "not again an hour later");
    let ny = rule(RepeatEvery::Day, "America/New_York", NINE);
    assert_eq!(next_run(&ny, 0, at("2026-10-31T10:00:00-04:00")), Some(at("2026-11-01T09:00:00-05:00")));
}

#[test]
fn month_and_year_ends_and_leap_days() {
    let late = rule(RepeatEvery::Day, "Asia/Kolkata", 23 * 60 + 30);
    assert_eq!(next_run(&late, 0, at("2026-01-31T23:45:00+05:30")), Some(at("2026-02-01T23:30:00+05:30")));
    assert_eq!(next_run(&late, 0, at("2026-04-30T23:31:00+05:30")), Some(at("2026-05-01T23:30:00+05:30")));
    let early = rule(RepeatEvery::Day, "UTC", 15);
    let leap = next_run(&early, 0, at("2028-02-28T12:00:00Z")).unwrap();
    assert_eq!(leap, at("2028-02-29T00:15:00Z"));
    assert_eq!(next_run(&early, 0, leap), Some(at("2028-03-01T00:15:00Z")));
    assert_eq!(next_run(&early, 0, at("2027-02-28T12:00:00Z")), Some(at("2027-03-01T00:15:00Z")));
    // Thursday 31 December 2026, then Friday 1 January
    let friday = Repeat { day: Some(5), ..rule(RepeatEvery::Week, "UTC", NINE) };
    assert_eq!(next_run(&friday, 0, at("2026-12-31T10:00:00Z")), Some(at("2027-01-01T09:00:00Z")));
    // a time of day past midnight UTC lands on the zone's own date
    let tokyo = rule(RepeatEvery::Day, "Asia/Tokyo", 8 * 60);
    assert_eq!(next_run(&tokyo, 0, at("2026-12-31T22:30:00Z")), Some(at("2027-01-01T08:00:00+09:00")));
    assert_eq!(next_run(&tokyo, 0, at("2026-12-31T23:30:00Z")), Some(at("2027-01-02T08:00:00+09:00")));
}

#[test]
fn weekdays_skip_the_weekend_and_a_weekly_one_waits_a_week() {
    let r = rule(RepeatEvery::Weekdays, "Europe/London", NINE);
    // Friday 20 November 2026 after nine: Monday
    assert_eq!(next_run(&r, 0, at("2026-11-20T10:00:00Z")), Some(at("2026-11-23T09:00:00Z")));
    assert_eq!(next_run(&r, 0, at("2026-11-21T08:00:00Z")), Some(at("2026-11-23T09:00:00Z")), "from Saturday");
    assert_eq!(next_run(&r, 0, at("2026-11-23T08:59:00Z")), Some(at("2026-11-23T09:00:00Z")), "the same morning");
    let monday = Repeat { day: Some(1), ..rule(RepeatEvery::Week, "Europe/London", NINE) };
    assert_eq!(next_run(&monday, 0, at("2026-11-23T09:00:00Z")), Some(at("2026-11-30T09:00:00Z")));
    // across the change in March: still 9:00 by the clock
    assert_eq!(next_run(&monday, 0, at("2027-03-24T09:00:00Z")), Some(at("2027-03-29T09:00:00+01:00")));
    let sunday = Repeat { day: Some(0), ..rule(RepeatEvery::Week, "Europe/London", NINE) };
    assert_eq!(next_run(&sunday, 0, at("2026-11-23T09:00:00Z")), Some(at("2026-11-29T09:00:00Z")));
}

#[test]
fn every_few_hours_counts_on_from_the_first_time_and_skips_the_ones_missed() {
    let r = Repeat { every: RepeatEvery::Hours, hours: Some(3), minute: None, day: None, tz: "Europe/Berlin".into(), offset: 60 };
    let first = at("2026-03-29T00:00:00+01:00");
    assert_eq!(next_run(&r, first, first - 1), Some(first), "not yet due: the first time itself");
    // three hours of real time across the change, not three on the clock
    assert_eq!(next_run(&r, first, first), Some(first + 3 * HOUR_MS));
    // the hub was off for ten hours: the next one on the same beat, once
    assert_eq!(next_run(&r, first, first + 10 * HOUR_MS), Some(first + 12 * HOUR_MS));
    assert_eq!(next_run(&Repeat { hours: None, ..r.clone() }, first, first), None);
}

#[test]
fn a_zone_the_hub_doesnt_know_keeps_the_offset_it_was_set_with() {
    let r = Repeat { offset: 330, ..rule(RepeatEvery::Day, "Mars/Olympus_Mons", NINE) };
    assert_eq!(zone_offset("Mars/Olympus_Mons", 0), None);
    assert_eq!(next_run(&r, 0, at("2026-06-01T00:00:00Z")), Some(at("2026-06-01T03:30:00Z")));
    // the phone's core: the browser's offsets
    set_offsets(Some(Rc::new(|tz: &str, _| (tz == "Mars/Olympus_Mons").then_some(-7 * 3600))));
    assert_eq!(next_run(&r, 0, at("2026-06-01T00:00:00Z")), Some(at("2026-06-01T16:00:00Z")));
    set_offsets(None);
}

#[test]
fn a_rule_from_an_app_is_checked_and_keeps_only_what_its_kind_uses() {
    let r = read_repeat(&json!({ "every": "week", "minute": 540, "day": 1, "hours": 5, "tz": "Europe/Berlin", "offset": 60 })).unwrap();
    assert_eq!((r.every, r.minute, r.day, r.hours), (RepeatEvery::Week, Some(540), Some(1), None));
    let r = read_repeat(&json!({ "every": "hours", "hours": 4, "minute": 540, "tz": "UTC", "offset": 0 })).unwrap();
    assert_eq!((r.hours, r.minute), (Some(4), None));
    let refused = |v: serde_json::Value| read_repeat(&v).unwrap_err().message;
    assert_eq!(refused(json!({ "every": "month", "tz": "UTC", "offset": 0 })), "repeat.every must be hours, day, weekdays or week");
    assert_eq!(refused(json!({ "every": "hours", "hours": 25, "tz": "UTC", "offset": 0 })), "Pick every 1 to 24 hours");
    assert_eq!(refused(json!({ "every": "hours", "hours": 1.5, "tz": "UTC", "offset": 0 })), "Pick every 1 to 24 hours");
    assert_eq!(refused(json!({ "every": "day", "minute": 1440, "tz": "UTC", "offset": 0 })), "repeat.minute must be a time of day, 0 to 1439");
    assert_eq!(refused(json!({ "every": "week", "minute": 0, "day": 7, "tz": "UTC", "offset": 0 })), "repeat.day must be a day of the week, 0 (Sunday) to 6");
    assert_eq!(refused(json!({ "every": "day", "minute": 0, "tz": "../etc/passwd x", "offset": 0 })), "repeat.tz must be a time zone's name");
    assert_eq!(refused(json!({ "every": "day", "minute": 0, "tz": "UTC", "offset": 900 })), "repeat.offset must be the minutes east of UTC");
    assert_eq!(refused(json!("daily")), "repeat must be an object");
}
