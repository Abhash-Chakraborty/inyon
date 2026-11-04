//! Sends a file to a machine a chunk at a time (hubs from 0.24), as `apps/web/src/lib/upload.ts`
//! does: start the upload, PUT its bytes in order, then finish with the file's SHA-256, worked out
//! from the chunks as they're read. A dropped connection waits and asks the hub how much arrived,
//! then carries on from there for about ten minutes; a later retry of the same attachment ("tap to
//! try again") picks up where it stopped. Removing the attachment stops it and deletes what arrived.
//! A hub without chunked uploads gets the file in one request, the old way.

use inyon_chat_core::upload::{self as chunked, Next};

/// The file as the machine saved it.
#[derive(Debug, Clone, PartialEq, serde::Deserialize)]
pub struct Uploaded {
    pub path: String,
}

/// What an attempt at the whole file ended with, short of the saved file.
#[derive(Debug, Clone, PartialEq)]
pub enum Stop {
    /// the hub forgot the upload: start the file over
    StartOver,
    /// the hub has no chunked uploads
    OldHub,
    /// it can't go on, with the words to show; `retry` when trying later could still work
    Fail {
        message: String,
        retry: bool,
    },
    Cancelled,
}

/// The words for an answer that kept failing to come: the hub's, or a plain one.
pub fn wait_message(status: u16, body: &serde_json::Value) -> String {
    if status == 0 {
        return "The connection dropped".into();
    }
    body.get("error").and_then(|e| e.as_str()).map_or_else(|| format!("Upload failed ({status})"), str::to_owned)
}

/// Where a chunk's answer leaves the upload: carry on from a byte, try the same chunk again after
/// asking where the hub is (`Wait`), or stop.
pub fn after_chunk(status: u16, body: &serde_json::Value) -> Result<Option<u64>, Stop> {
    match chunked::next(status, body, false) {
        Next::From(n) => Ok(Some(n)),
        Next::Wait => Ok(None),
        // a 404 here means the upload went, not the route
        Next::StartOver | Next::OldHub => Err(Stop::StartOver),
        Next::Done(_) => Ok(None),
        Next::Fail(message) => Err(Stop::Fail { message, retry: false }),
    }
}

#[cfg(target_arch = "wasm32")]
pub use imp::*;

#[cfg(target_arch = "wasm32")]
mod imp {
    use std::cell::{Cell, RefCell};
    use std::collections::HashMap;
    use std::rc::Rc;

    use futures_util::future::{select, Either};
    use serde_json::{json, Value};
    use sha2::{Digest, Sha256};
    use wasm_bindgen::JsCast;
    use wasm_bindgen_futures::JsFuture;

    use inyon_chat_core::upload::{UploadStatus, RETRY_WAITS_MS};

    use super::*;
    use crate::api::ApiError;

    /// One upload under way, so removing its attachment can stop it.
    #[derive(Default)]
    struct Job {
        cancelled: Cell<bool>,
        current: RefCell<Option<web_sys::AbortController>>,
    }

    /// What a later try of the same attachment picks up: the hub's upload, and the hash of what was read.
    struct Resume {
        status: Option<UploadStatus>,
        hasher: Sha256,
        hashed: u64,
    }

    thread_local! {
        static JOBS: RefCell<HashMap<String, Rc<Job>>> = RefCell::new(HashMap::new());
        static RESUMES: RefCell<HashMap<String, Resume>> = RefCell::new(HashMap::new());
    }

    /// Stops the upload for this attachment (if one is going) and forgets where it got to.
    pub fn cancel(id: &str) {
        if let Some(job) = JOBS.with(|j| j.borrow_mut().remove(id)) {
            job.cancelled.set(true);
            if let Some(c) = job.current.borrow_mut().take() {
                c.abort();
            }
        }
    }

    enum Body {
        None,
        Json(String),
        Bytes(js_sys::Uint8Array),
    }

    /// One request: its status (0 when no answer came in `ms`, or at all) and its JSON body.
    async fn call(job: &Job, method: &str, url: &str, body: Body, ms: u32) -> (u16, Value) {
        let ctl = web_sys::AbortController::new().ok();
        let init = web_sys::RequestInit::new();
        init.set_method(method);
        init.set_credentials(web_sys::RequestCredentials::SameOrigin);
        if let Some(c) = &ctl {
            init.set_signal(Some(&c.signal()));
        }
        let kind = match &body {
            Body::None => None,
            Body::Json(s) => {
                init.set_body(&wasm_bindgen::JsValue::from_str(s));
                Some("application/json")
            }
            Body::Bytes(b) => {
                init.set_body(b);
                Some("application/octet-stream")
            }
        };
        let Ok(req) = web_sys::Request::new_with_str_and_init(url, &init) else { return (0, json!({})) };
        if let Some(k) = kind {
            let _ = req.headers().set("content-type", k);
        }
        let Some(win) = web_sys::window() else { return (0, json!({})) };
        *job.current.borrow_mut() = ctl.clone();
        let fetch = Box::pin(JsFuture::from(win.fetch_with_request(&req)));
        let timer = Box::pin(crate::platform::sleep(ms));
        let res = match select(fetch, timer).await {
            Either::Left((Ok(r), _)) => r.dyn_into::<web_sys::Response>().ok(),
            Either::Left((Err(_), _)) => None,
            Either::Right(_) => {
                if let Some(c) = &ctl {
                    c.abort();
                }
                None
            }
        };
        let Some(res) = res else { return (0, json!({})) };
        let text = match res.text() {
            Ok(p) => JsFuture::from(p).await.ok().and_then(|v| v.as_string()).unwrap_or_default(),
            Err(_) => String::new(),
        };
        (res.status(), serde_json::from_str(&text).unwrap_or_else(|_| json!({})))
    }

    /// Waits `ms`, sooner when the device comes back online.
    async fn pause(job: &Job, ms: u64) {
        let offline = !crate::dom::online();
        let mut left = ms;
        while left > 0 && !job.cancelled.get() {
            let step = left.min(500);
            crate::platform::sleep(step as u32).await;
            left -= step;
            if offline && crate::dom::online() {
                crate::platform::sleep(300).await;
                return;
            }
        }
    }

    async fn bytes_of(file: &web_sys::File, from: u64, to: u64) -> Result<Vec<u8>, Stop> {
        let fail = || Stop::Fail { message: "Couldn't read the file".into(), retry: false };
        let blob = file.slice_with_f64_and_f64(from as f64, to as f64).map_err(|_| fail())?;
        let buf = JsFuture::from(blob.array_buffer()).await.map_err(|_| fail())?;
        Ok(js_sys::Uint8Array::new(&buf).to_vec())
    }

    /// Sends `file` for the attachment `id` to the machine `host`, saved next to `pane`'s files.
    /// `progress` hears the share the machine has, and whether the connection is down.
    pub async fn upload(id: &str, host: &str, pane: Option<&str>, file: &web_sys::File, progress: impl Fn(f64, bool)) -> Result<Uploaded, ApiError> {
        let job = Rc::new(Job::default());
        JOBS.with(|j| j.borrow_mut().insert(id.to_string(), job.clone()));
        let result = chunks(&job, id, host, pane, file, &progress).await;
        let result = match result {
            Err(Stop::OldHub) => whole(&job, host, pane, file).await,
            other => other,
        };
        JOBS.with(|j| {
            let mut j = j.borrow_mut();
            if j.get(id).is_some_and(|x| Rc::ptr_eq(x, &job)) {
                j.remove(id);
            }
        });
        result.map_err(|s| match s {
            Stop::Fail { message, .. } => ApiError { status: 0, message },
            Stop::Cancelled => ApiError { status: 0, message: "Cancelled".into() },
            _ => ApiError { status: 0, message: "This upload is no longer on the hub. Send the file again.".into() },
        })
    }

    async fn chunks(job: &Job, id: &str, host: &str, pane: Option<&str>, file: &web_sys::File, progress: &impl Fn(f64, bool)) -> Result<Uploaded, Stop> {
        let size = file.size() as u64;
        let report = |received: u64, waiting: bool| progress(if size == 0 && waiting { 0.0 } else { chunked::fraction(received, size) }, waiting);
        let mut r = RESUMES.with(|m| m.borrow_mut().remove(id)).unwrap_or(Resume { status: None, hasher: Sha256::new(), hashed: 0 });
        let mut fresh = 0;
        let out = loop {
            match attempt(job, host, pane, file, size, &mut r, &report).await {
                Err(Stop::StartOver) if fresh < 2 => {
                    fresh += 1;
                    r.status = None;
                }
                other => break other,
            }
        };
        match &out {
            // what arrived stays for a later try
            Err(Stop::Fail { retry: true, .. }) => RESUMES.with(|m| {
                m.borrow_mut().insert(id.to_string(), r);
            }),
            Err(Stop::Cancelled) => {
                if let Some(s) = r.status {
                    // a cancelled upload leaves nothing on the machine
                    let path = chunked::status_path(host, &s.id);
                    wasm_bindgen_futures::spawn_local(async move {
                        let _ = call(&Job::default(), "DELETE", &path, Body::None, 15_000).await;
                    });
                }
            }
            _ => {}
        }
        out
    }

    /// Runs a request until it gets an answer that isn't "try again", waiting between tries.
    async fn persist(job: &Job, received: u64, report: &impl Fn(u64, bool), mut f: impl AsyncFnMut() -> Result<Option<Value>, (u16, Value, Stop)>) -> Result<Value, Stop> {
        let mut last = (0u16, json!({}));
        let mut waits = RETRY_WAITS_MS.iter();
        loop {
            if job.cancelled.get() {
                return Err(Stop::Cancelled);
            }
            match f().await {
                Ok(Some(v)) => return Ok(v),
                Ok(None) => {}
                Err((status, body, stop)) => {
                    if !matches!(stop, Stop::Fail { retry: true, .. }) {
                        return Err(stop);
                    }
                    last = (status, body);
                }
            }
            let Some(&wait) = waits.next() else { break };
            report(received, true);
            pause(job, wait).await;
        }
        if job.cancelled.get() {
            return Err(Stop::Cancelled);
        }
        Err(Stop::Fail { message: wait_message(last.0, &last.1), retry: true })
    }

    /// What an answer means to [`persist`]: the body, try again, or stop.
    fn read(status: u16, body: Value, finish: bool) -> Result<Option<Value>, (u16, Value, Stop)> {
        match chunked::next(status, &body, finish) {
            Next::Done(v) => Ok(Some(v)),
            Next::From(_) => Ok(Some(body)),
            Next::Wait => Err((status, body, Stop::Fail { message: String::new(), retry: true })),
            Next::StartOver => Err((status, body, Stop::StartOver)),
            Next::OldHub => Err((status, body, Stop::OldHub)),
            Next::Fail(message) => Err((status, body, Stop::Fail { message, retry: false })),
        }
    }

    async fn attempt(job: &Job, host: &str, pane: Option<&str>, file: &web_sys::File, size: u64, r: &mut Resume, report: &impl Fn(u64, bool)) -> Result<Uploaded, Stop> {
        if r.status.is_none() {
            let name = if file.name().is_empty() { "file".to_string() } else { file.name() };
            let mut start = json!({ "name": name, "size": size, "type": file.type_() });
            if let Some(p) = pane {
                start["pane"] = json!(inyon_chat_core::overview::pane_slug(p));
            }
            let start = start.to_string();
            let url = chunked::start_path(host);
            let v = persist(job, 0, report, async || {
                let (s, b) = call(job, "POST", &url, Body::Json(start.clone()), 60_000).await;
                read(s, b, false)
            })
            .await?;
            r.status = Some(serde_json::from_value(v).map_err(|e| Stop::Fail { message: e.to_string(), retry: false })?);
        }
        let s = r.status.clone().expect("started");
        let mut received = s.received;
        report(received, false);
        while received < size {
            let at = received;
            let range = chunked::next_chunk(&UploadStatus { received: at, size, ..s.clone() }).expect("bytes left");
            let bytes = bytes_of(file, range.start, range.end).await?;
            if range.end > r.hashed {
                r.hasher.update(&bytes[(r.hashed.saturating_sub(at)) as usize..]);
                r.hashed = range.end;
            }
            let url = chunked::chunk_path(host, &s.id, at);
            let status_url = chunked::status_path(host, &s.id);
            let v = persist(job, received, report, async || {
                // a megabyte takes about two minutes at 64 kbit/s
                let (st, b) = call(job, "PUT", &url, Body::Bytes(js_sys::Uint8Array::from(bytes.as_slice())), 180_000).await;
                match super::after_chunk(st, &b) {
                    Ok(Some(n)) => Ok(Some(json!({ "received": n }))),
                    Ok(None) => {
                        // the answer may be lost rather than the chunk: ask before sending it again
                        let (gs, gb) = call(job, "GET", &status_url, Body::None, 30_000).await;
                        match gb.get("received").and_then(Value::as_u64) {
                            Some(n) if (200..300).contains(&gs) && n != at => Ok(Some(json!({ "received": n }))),
                            _ => Err((st, b, Stop::Fail { message: String::new(), retry: true })),
                        }
                    }
                    Err(stop) => Err((st, b, stop)),
                }
            })
            .await?;
            received = v["received"].as_u64().unwrap_or(at);
            if let Some(st) = r.status.as_mut() {
                st.received = received;
            }
            report(received, false);
        }
        // what was sent before a retry that found it all there: read for the hash only
        let mut at = r.hashed;
        while at < size {
            let end = (at + s.chunk.max(1)).min(size);
            r.hasher.update(&bytes_of(file, at, end).await?);
            at = end;
        }
        let sha256 = format!("{:x}", std::mem::take(&mut r.hasher).finalize());
        r.hashed = 0;
        let url = chunked::finish_path(host, &s.id);
        let body = json!({ "sha256": sha256 }).to_string();
        let v = persist(job, size, report, async || {
            let (st, b) = call(job, "POST", &url, Body::Json(body.clone()), 180_000).await;
            read(st, b, true)
        })
        .await?;
        report(size, false);
        serde_json::from_value(v).map_err(|e| Stop::Fail { message: e.to_string(), retry: false })
    }

    /// A hub from before 0.24: the whole file in one request.
    async fn whole(job: &Job, host: &str, pane: Option<&str>, file: &web_sys::File) -> Result<Uploaded, Stop> {
        let fail = |m: &str| Stop::Fail { message: m.into(), retry: false };
        let form = web_sys::FormData::new().map_err(|_| fail("Couldn't read the file"))?;
        form.append_with_blob_and_filename("files", file, &file.name()).map_err(|_| fail("Couldn't read the file"))?;
        if let Some(p) = pane {
            let _ = form.append_with_str("pane", inyon_chat_core::overview::pane_slug(p));
        }
        let init = web_sys::RequestInit::new();
        init.set_method("POST");
        init.set_credentials(web_sys::RequestCredentials::SameOrigin);
        init.set_body(&form);
        let url = format!("{}/uploads", crate::api::host_path(host));
        let req = web_sys::Request::new_with_str_and_init(&url, &init).map_err(|_| fail("Network error during upload"))?;
        let win = web_sys::window().ok_or_else(|| fail("Network error during upload"))?;
        if job.cancelled.get() {
            return Err(Stop::Cancelled);
        }
        let res: web_sys::Response = JsFuture::from(win.fetch_with_request(&req))
            .await
            .ok()
            .and_then(|r| r.dyn_into().ok())
            .ok_or_else(|| Stop::Fail { message: "Network error during upload".into(), retry: true })?;
        let text = match res.text() {
            Ok(p) => JsFuture::from(p).await.ok().and_then(|v| v.as_string()).unwrap_or_default(),
            Err(_) => String::new(),
        };
        let body: Value = serde_json::from_str(&text).unwrap_or_else(|_| json!({}));
        match body.get("files").and_then(|f| f.get(0)) {
            Some(f) if res.ok() => serde_json::from_value(f.clone()).map_err(|e| fail(&e.to_string())),
            _ => Err(fail(&body.get("error").and_then(Value::as_str).map_or_else(|| format!("Upload failed ({})", res.status()), str::to_owned))),
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
mod imp {
    /// Uploads come from the browser build only so far.
    #[allow(dead_code)]
    pub fn cancel(_id: &str) {}
}

#[cfg(not(target_arch = "wasm32"))]
#[allow(unused_imports)]
pub use imp::*;

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn a_chunk_answer_says_where_to_go_on() {
        let st = json!({ "id": "ab", "size": 10, "received": 8, "chunk": 4 });
        assert_eq!(after_chunk(200, &st), Ok(Some(8)));
        // a chunk the hub didn't expect: carry on from what it has
        assert_eq!(after_chunk(409, &json!({ "received": 4, "error": "The upload carries on from byte 4" })), Ok(Some(4)));
        // no answer, or a busy hub: ask where it is, then send again
        assert_eq!(after_chunk(0, &json!({})), Ok(None));
        assert_eq!(after_chunk(503, &json!({})), Ok(None));
        // the hub forgot it: the file starts over
        assert_eq!(after_chunk(404, &json!({ "error": "Not found" })), Err(Stop::StartOver));
        assert_eq!(after_chunk(410, &json!({ "error": "gone" })), Err(Stop::StartOver));
        assert_eq!(after_chunk(413, &json!({ "error": "a is larger than 100 MB" })), Err(Stop::Fail { message: "a is larger than 100 MB".into(), retry: false }));
    }

    #[test]
    fn a_hub_that_never_answered_reads_plainly() {
        assert_eq!(wait_message(0, &json!({})), "The connection dropped");
        assert_eq!(wait_message(503, &json!({ "error": "The machine is busy" })), "The machine is busy");
        assert_eq!(wait_message(502, &json!({})), "Upload failed (502)");
    }
}
