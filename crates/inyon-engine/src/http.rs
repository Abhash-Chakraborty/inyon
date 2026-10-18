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

/// The certificates in the file NODE_EXTRA_CA_CERTS names, trusted besides Mozilla's roots, as
/// the Bun engine did (a hub behind a company's own certificate authority). A file that can't be
/// read is said once and left out, as Node does.
pub fn extra_roots() -> Vec<rustls::pki_types::CertificateDer<'static>> {
    static SAID: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    let Some(path) = std::env::var_os("NODE_EXTRA_CA_CERTS").filter(|p| !p.is_empty()) else {
        return Vec::new();
    };
    let path = std::path::PathBuf::from(path);
    match pem_certs(&path) {
        Ok(certs) => certs,
        Err(e) => {
            if !SAID.swap(true, std::sync::atomic::Ordering::Relaxed) {
                crate::output::log(&format!("Ignoring NODE_EXTRA_CA_CERTS: couldn't read certificates from {} ({e}).", path.display()));
            }
            Vec::new()
        }
    }
}

fn pem_certs(path: &std::path::Path) -> Result<Vec<rustls::pki_types::CertificateDer<'static>>, String> {
    use rustls::pki_types::pem::PemObject;
    let certs = rustls::pki_types::CertificateDer::pem_file_iter(path).map_err(|e| e.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
    if certs.is_empty() {
        return Err("there are none in it".into());
    }
    Ok(certs)
}

/// The roots ureq checks a server's certificate against: Mozilla's, and NODE_EXTRA_CA_CERTS.
pub fn ureq_roots() -> ureq::tls::RootCerts {
    let extra = extra_roots();
    if extra.is_empty() {
        return ureq::tls::RootCerts::WebPki;
    }
    let all: Vec<ureq::tls::Certificate<'static>> =
        webpki_root_certs::TLS_SERVER_ROOT_CERTS.iter().chain(&extra).map(|c| ureq::tls::Certificate::from_der(c.as_ref()).to_owned()).collect();
    ureq::tls::RootCerts::new_with_certs(&all)
}

/// What may come back: more than cloudflared (about 40 MB), less than would fill memory.
const MAX_BODY: u64 = 256 * 1024 * 1024;

fn agent(timeout: Duration, insecure: bool) -> ureq::Agent {
    let mut c = ureq::Agent::config_builder().http_status_as_error(false).timeout_global(Some(timeout)).user_agent(format!("inyon/{}", crate::VERSION));
    c = c.tls_config(if insecure { ureq::tls::TlsConfig::builder().disable_verification(true).build() } else { ureq::tls::TlsConfig::builder().root_certs(ureq_roots()).build() });
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

/// A server on a certificate from a certificate authority of its own, made with openssl for the
/// test (no key is kept in the repository), and whether a client trusts it.
#[cfg(all(test, target_os = "linux"))]
pub(crate) mod test_tls {
    use std::io::{Read, Write};
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, Mutex, MutexGuard};

    use rustls::pki_types::pem::PemObject;
    use rustls::pki_types::{CertificateDer, PrivateKeyDer};

    /// The tests that set NODE_EXTRA_CA_CERTS take turns.
    pub fn env_lock() -> MutexGuard<'static, ()> {
        static LOCK: Mutex<()> = Mutex::new(());
        LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The authority's certificate and the port of a server answering "ok" over TLS, as 127.0.0.1.
    pub fn server(dir: &Path) -> (PathBuf, u16) {
        std::fs::create_dir_all(dir).unwrap();
        let script = "set -e
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout ca.key -out ca.pem -days 2 -subj /CN=inyon-test-ca -addext basicConstraints=critical,CA:TRUE -addext keyUsage=critical,keyCertSign,cRLSign
openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout server.key -out server.csr -subj /CN=localhost
printf 'subjectAltName=DNS:localhost,IP:127.0.0.1\\nbasicConstraints=critical,CA:FALSE\\nkeyUsage=critical,digitalSignature\\nextendedKeyUsage=serverAuth\\n' > ext
openssl x509 -req -in server.csr -CA ca.pem -CAkey ca.key -CAcreateserial -out server.pem -days 2 -extfile ext";
        let made = std::process::Command::new("sh").arg("-c").arg(script).current_dir(dir).output().expect("sh");
        assert!(made.status.success(), "openssl: {}", String::from_utf8_lossy(&made.stderr));
        let certs: Vec<CertificateDer<'static>> = CertificateDer::pem_file_iter(dir.join("server.pem")).unwrap().map(Result::unwrap).collect();
        let key = PrivateKeyDer::from_pem_file(dir.join("server.key")).unwrap();
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let config = Arc::new(
            rustls::ServerConfig::builder_with_provider(provider).with_safe_default_protocol_versions().unwrap().with_no_client_auth().with_single_cert(certs, key).unwrap(),
        );
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for tcp in listener.incoming().flatten() {
                let config = config.clone();
                std::thread::spawn(move || {
                    let Ok(conn) = rustls::ServerConnection::new(config) else { return };
                    let mut s = rustls::StreamOwned::new(conn, tcp);
                    let mut seen = Vec::new();
                    let mut buf = [0u8; 1024];
                    while !seen.windows(4).any(|w| w == b"\r\n\r\n") {
                        match s.read(&mut buf) {
                            Ok(0) | Err(_) => return,
                            Ok(n) => seen.extend_from_slice(&buf[..n]),
                        }
                    }
                    let _ = s.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
                    let _ = s.flush();
                    s.conn.send_close_notify();
                    let _ = s.flush();
                });
            }
        });
        (dir.join("ca.pem"), port)
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    #[test]
    fn a_hub_on_a_certificate_from_node_extra_ca_certs_is_trusted() {
        let _env = test_tls::env_lock();
        let dir = std::env::temp_dir().join(format!("inyon-extra-ca-http-{}", std::process::id()));
        let (ca, port) = test_tls::server(&dir);
        let url = format!("https://127.0.0.1:{port}/");
        // SAFETY: the tests that touch NODE_EXTRA_CA_CERTS hold env_lock
        unsafe { std::env::remove_var("NODE_EXTRA_CA_CERTS") };
        let unknown = request("GET", &url, &[], None, Duration::from_secs(10));
        unsafe { std::env::set_var("NODE_EXTRA_CA_CERTS", &ca) };
        let trusted = request("GET", &url, &[], None, Duration::from_secs(10));
        // a file that isn't there leaves Mozilla's roots as they are
        unsafe { std::env::set_var("NODE_EXTRA_CA_CERTS", dir.join("missing.pem")) };
        let missing = request("GET", &url, &[], None, Duration::from_secs(10));
        unsafe { std::env::remove_var("NODE_EXTRA_CA_CERTS") };
        let _ = std::fs::remove_dir_all(&dir);
        assert!(unknown.is_err(), "an authority nobody named isn't trusted");
        let trusted = trusted.unwrap();
        assert_eq!((trusted.status, trusted.body.as_slice()), (200, &b"ok"[..]));
        assert!(missing.is_err());
    }
}
