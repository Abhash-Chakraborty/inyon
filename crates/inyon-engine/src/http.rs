//! The few plain HTTP requests: pkarr relays, Web Push services, downloads of busybox and
//! cloudflared, and the hub's "were we removed?" answer. Blocking requests (ureq, rustls with
//! ring), run off the async threads.

use std::time::Duration;

pub struct Response {
    pub status: u16,
    pub body: Vec<u8>,
}

impl Response {
    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }
}

/// NODE_TLS_REJECT_UNAUTHORIZED=0 turns certificate checks off, as it did for the Bun engine (a
/// hub on a self-signed certificate, for testing).
pub fn insecure_tls() -> bool {
    std::env::var("NODE_TLS_REJECT_UNAUTHORIZED").is_ok_and(|v| v == "0")
}

/// What may come back: more than cloudflared (about 40 MB), less than would fill memory.
const MAX_BODY: u64 = 256 * 1024 * 1024;

fn agent(timeout: Duration, insecure: bool) -> ureq::Agent {
    let mut c = ureq::Agent::config_builder().http_status_as_error(false).timeout_global(Some(timeout)).user_agent(format!("inyon/{}", crate::VERSION));
    if insecure {
        c = c.tls_config(ureq::tls::TlsConfig::builder().disable_verification(true).build());
    }
    c.build().new_agent()
}

/// A request and its whole answer. `headers` go with it; `body` makes it a request with one.
pub fn request(method: &str, url: &str, headers: &[(&str, &str)], body: Option<&[u8]>, timeout: Duration) -> Result<Response, String> {
    let a = agent(timeout, insecure_tls());
    let mut res = match (method, body) {
        ("GET", _) => {
            let mut r = a.get(url);
            for (k, v) in headers {
                r = r.header(*k, *v);
            }
            r.call()
        }
        (m, b) => {
            let b = b.unwrap_or(&[]);
            let mut r = match m {
                "PUT" => a.put(url),
                _ => a.post(url),
            };
            for (k, v) in headers {
                r = r.header(*k, *v);
            }
            r.send(b)
        }
    }
    .map_err(|e| e.to_string())?;
    let status = res.status().as_u16();
    let body = res.body_mut().with_config().limit(MAX_BODY).read_to_vec().unwrap_or_default();
    Ok(Response { status, body })
}

/// `request` on a blocking thread, for async code.
pub async fn fetch(method: &'static str, url: String, headers: Vec<(String, String)>, body: Option<Vec<u8>>, timeout: Duration) -> Result<Response, String> {
    tokio::task::spawn_blocking(move || {
        let h: Vec<(&str, &str)> = headers.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
        request(method, &url, &h, body.as_deref(), timeout)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Downloads a file whole (a program to check before it's used).
pub fn download(url: &str) -> Result<Response, String> {
    request("GET", url, &[], None, Duration::from_secs(600))
}
