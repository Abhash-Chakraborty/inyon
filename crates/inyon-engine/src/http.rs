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

/// How long opening a connection may take, every address of the name and the TLS handshake
/// included. ureq gives the first address half of it and each next one half of what's left, so an
/// address that never answers (GitHub's CDN hands out a dead one now and then) costs a few seconds
/// before the next is tried, not the two minutes the system would wait.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// How long a request may wait for its next byte, either way, before it's given up: a download
/// that stalls fails after this rather than at the end of its whole time.
pub const STALL_TIMEOUT: Duration = Duration::from_secs(30);

/// A request's time limits: in all, to connect, and between two reads or writes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    pub total: Duration,
    pub connect: Duration,
    pub stall: Duration,
}

impl Limits {
    /// `total` in all, with the usual connect and stall limits (never longer than `total`).
    pub fn new(total: Duration) -> Limits {
        Limits { total, connect: CONNECT_TIMEOUT.min(total), stall: STALL_TIMEOUT.min(total) }
    }
}

/// An agent for `config` that keeps to `limits`. Every request this program makes goes through
/// one (the inyon command's too), so none of them can hang on a dead address or a stalled answer.
pub fn timed_agent(config: ureq::config::ConfigBuilder<ureq::typestate::AgentScope>, limits: Limits) -> ureq::Agent {
    timed_agent_with(config, limits, ureq::unversioned::resolver::DefaultResolver::default())
}

/// `timed_agent` with a resolver of its own (the tests hand out a dead address first).
pub fn timed_agent_with(config: ureq::config::ConfigBuilder<ureq::typestate::AgentScope>, limits: Limits, resolver: impl ureq::unversioned::resolver::Resolver) -> ureq::Agent {
    let config = config.timeout_global(Some(limits.total)).timeout_resolve(Some(limits.connect)).timeout_connect(Some(limits.connect)).build();
    ureq::Agent::with_parts(config, stall::Connector::new(limits.stall), resolver)
}

/// A request that gave up because nothing came for a while says so, and a connection that
/// couldn't be opened says how long it was given.
fn describe(e: ureq::Error, limits: &Limits) -> String {
    match e {
        ureq::Error::Timeout(ureq::Timeout::Connect) => format!("couldn't connect within {} s", limits.connect.as_secs()),
        e => e.to_string(),
    }
}

/// Caps every wait for a byte at the stall limit. ureq's own timeouts count from the start of a
/// phase (the whole body, say), so a body that stops arriving halfway would otherwise hold the
/// request until its total time ran out.
mod stall {
    use std::time::Duration;

    use ureq::unversioned::transport::time::Duration as UDuration;
    use ureq::unversioned::transport::{Buffers, ConnectionDetails, DefaultConnector, NextTimeout, Transport};

    #[derive(Debug)]
    pub struct Connector {
        inner: DefaultConnector,
        stall: Duration,
    }

    impl Connector {
        pub fn new(stall: Duration) -> Connector {
            Connector { inner: DefaultConnector::new(), stall }
        }
    }

    impl ureq::unversioned::transport::Connector<()> for Connector {
        type Out = Stalling;

        fn connect(&self, details: &ConnectionDetails, chained: Option<()>) -> Result<Option<Stalling>, ureq::Error> {
            Ok(self.inner.connect(details, chained)?.map(|inner| Stalling { inner, stall: self.stall }))
        }
    }

    #[derive(Debug)]
    pub struct Stalling {
        inner: Box<dyn Transport>,
        stall: Duration,
    }

    impl Stalling {
        /// The wait ureq asked for, or the stall limit when that's sooner; and whether it was cut.
        fn cap(&self, t: NextTimeout) -> (NextTimeout, bool) {
            if *t.after > self.stall {
                (NextTimeout { after: UDuration::Exact(self.stall), reason: t.reason }, true)
            } else {
                (t, false)
            }
        }

        fn stalled(&self, e: ureq::Error, cut: bool) -> ureq::Error {
            match e {
                ureq::Error::Timeout(_) if cut => ureq::Error::Io(std::io::Error::new(std::io::ErrorKind::TimedOut, format!("nothing arrived for {} s", self.stall.as_secs()))),
                e => e,
            }
        }
    }

    impl Transport for Stalling {
        fn buffers(&mut self) -> &mut dyn Buffers {
            self.inner.buffers()
        }

        fn transmit_output(&mut self, amount: usize, timeout: NextTimeout) -> Result<(), ureq::Error> {
            let (t, cut) = self.cap(timeout);
            self.inner.transmit_output(amount, t).map_err(|e| self.stalled(e, cut))
        }

        fn await_input(&mut self, timeout: NextTimeout) -> Result<bool, ureq::Error> {
            let (t, cut) = self.cap(timeout);
            self.inner.await_input(t).map_err(|e| self.stalled(e, cut))
        }

        fn is_open(&mut self) -> bool {
            self.inner.is_open()
        }

        fn is_tls(&self) -> bool {
            self.inner.is_tls()
        }
    }
}

fn config(insecure: bool) -> ureq::config::ConfigBuilder<ureq::typestate::AgentScope> {
    let c = ureq::Agent::config_builder().http_status_as_error(false).user_agent(format!("inyon/{}", crate::VERSION));
    c.tls_config(if insecure { ureq::tls::TlsConfig::builder().disable_verification(true).build() } else { ureq::tls::TlsConfig::builder().root_certs(ureq_roots()).build() })
}

/// A request and its whole answer. `headers` go with it; `body` makes it a request with one.
pub fn request(method: &str, url: &str, headers: &[(&str, &str)], body: Option<&[u8]>, timeout: Duration) -> Result<Response, String> {
    let limits = Limits::new(timeout);
    request_with(timed_agent(config(insecure_tls()), limits), &limits, method, url, headers, body, false)
}

/// A GET to the hub on this machine over loopback (`inyon hub code`). Its certificate is made out
/// to the hub's name, not 127.0.0.1, so it isn't checked, as the Bun engine's
/// `rejectUnauthorized: false` didn't check it.
pub fn get_local(url: &str, timeout: Duration) -> Result<Response, String> {
    let limits = Limits::new(timeout);
    request_with(timed_agent(config(true), limits), &limits, "GET", url, &[], None, false)
}

/// A POST with no body to the hub on this machine, unchecked like `get_local` (`inyon hub companion-code`).
pub fn post_local(url: &str, timeout: Duration) -> Result<Response, String> {
    let limits = Limits::new(timeout);
    request_with(timed_agent(config(true), limits), &limits, "POST", url, &[], Some(&[]), false)
}

/// Sends the request and reads the answer. With `whole`, a body that breaks off is an error
/// rather than whatever arrived (a download is checked against its checksum after this).
fn request_with(a: ureq::Agent, limits: &Limits, method: &str, url: &str, headers: &[(&str, &str)], body: Option<&[u8]>, whole: bool) -> Result<Response, String> {
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
    .map_err(|e| describe(e, limits))?;
    let status = res.status().as_u16();
    let read = res.body_mut().with_config().limit(MAX_BODY).read_to_vec();
    let body = match read {
        Ok(b) => b,
        Err(e) if whole => return Err(describe(e, limits)),
        Err(_) => Vec::new(),
    };
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

/// The longest a download may take in all, however steadily it arrives.
pub const DOWNLOAD_TIME: Duration = Duration::from_secs(600);

/// Downloads a file whole (a program to check before it's used).
pub fn download(url: &str) -> Result<Response, String> {
    download_with(url, Limits::new(DOWNLOAD_TIME), ureq::unversioned::resolver::DefaultResolver::default())
}

fn download_with(url: &str, limits: Limits, resolver: impl ureq::unversioned::resolver::Resolver) -> Result<Response, String> {
    request_with(timed_agent_with(config(insecure_tls()), limits, resolver), &limits, "GET", url, &[], None, true)
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

    #[test]
    fn the_hub_on_this_machine_is_asked_whatever_name_its_certificate_has() {
        let dir = std::env::temp_dir().join(format!("inyon-local-hub-http-{}", std::process::id()));
        let (_ca, port) = test_tls::server(&dir);
        let url = format!("https://127.0.0.1:{port}/");
        let got = get_local(&url, Duration::from_secs(10));
        let _ = std::fs::remove_dir_all(&dir);
        let got = got.unwrap();
        assert_eq!((got.status, got.body.as_slice()), (200, &b"ok"[..]));
    }
}

#[cfg(test)]
mod timeout_tests {
    use std::io::{Read, Write};
    use std::net::{SocketAddr, TcpListener};
    use std::time::Instant;

    use super::*;

    /// A name that resolves to these addresses, in this order.
    #[derive(Debug)]
    struct Fixed(Vec<SocketAddr>);

    impl ureq::unversioned::resolver::Resolver for Fixed {
        fn resolve(
            &self,
            _uri: &ureq::http::Uri,
            _config: &ureq::config::Config,
            _timeout: ureq::unversioned::transport::NextTimeout,
        ) -> Result<ureq::unversioned::resolver::ResolvedSocketAddrs, ureq::Error> {
            let mut v = self.empty();
            for a in &self.0 {
                v.push(*a);
            }
            Ok(v)
        }
    }

    /// A server on 127.0.0.1 that reads one request per connection and hands it to `answer`.
    fn server(answer: impl Fn(&mut std::net::TcpStream) + Send + Sync + 'static) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let answer = std::sync::Arc::new(answer);
        std::thread::spawn(move || {
            for mut tcp in listener.incoming().flatten() {
                let answer = answer.clone();
                std::thread::spawn(move || {
                    let mut seen = Vec::new();
                    let mut buf = [0u8; 1024];
                    while !seen.windows(4).any(|w| w == b"\r\n\r\n") {
                        match tcp.read(&mut buf) {
                            Ok(0) | Err(_) => return,
                            Ok(n) => seen.extend_from_slice(&buf[..n]),
                        }
                    }
                    answer(&mut tcp);
                });
            }
        });
        port
    }

    #[test]
    fn a_download_moves_on_from_an_address_that_never_answers() {
        // 192.0.2.1 is kept for documentation: nothing answers it, so a connect there waits until
        // the system gives up (two minutes on Linux), as one of GitHub's addresses did in 0.19.0
        let port = server(|tcp| {
            let _ = tcp.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 11\r\nConnection: close\r\n\r\ncloudflared");
        });
        let addrs = vec![SocketAddr::from(([192, 0, 2, 1], port)), SocketAddr::from(([127, 0, 0, 1], port))];
        let started = Instant::now();
        let got = download_with(&format!("http://downloads.example:{port}/cloudflared"), Limits::new(DOWNLOAD_TIME), Fixed(addrs)).unwrap();
        let took = started.elapsed();
        assert_eq!((got.status, got.body.as_slice()), (200, &b"cloudflared"[..]));
        // the dead address gets about two thirds of the 10 s connect limit, then the next one is tried
        assert!(took < Duration::from_secs(12), "took {took:?}");
    }

    #[test]
    fn a_download_that_stops_arriving_fails_once_nothing_came_for_the_stall_limit() {
        let port = server(|tcp| {
            let _ = tcp.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 1000\r\nConnection: close\r\n\r\npart of it");
            let _ = tcp.flush();
            std::thread::sleep(Duration::from_secs(20));
        });
        let limits = Limits { stall: Duration::from_secs(1), ..Limits::new(DOWNLOAD_TIME) };
        let started = Instant::now();
        let got = download_with(&format!("http://127.0.0.1:{port}/cloudflared"), limits, ureq::unversioned::resolver::DefaultResolver::default());
        let took = started.elapsed();
        let err = got.err().expect("a body that broke off is an error, not a short file");
        assert!(err.contains("nothing arrived for 1 s"), "{err}");
        assert!(took < Duration::from_secs(8), "took {took:?}");
    }

    #[test]
    fn a_server_that_never_answers_is_given_up_on_after_the_stall_limit() {
        let port = server(|_| std::thread::sleep(Duration::from_secs(20)));
        let limits = Limits { stall: Duration::from_secs(1), ..Limits::new(DOWNLOAD_TIME) };
        let started = Instant::now();
        let err = download_with(&format!("http://127.0.0.1:{port}/"), limits, ureq::unversioned::resolver::DefaultResolver::default()).err().unwrap();
        assert!(err.contains("nothing arrived for 1 s"), "{err}");
        assert!(started.elapsed() < Duration::from_secs(8));
    }

    #[test]
    fn short_requests_keep_their_own_total() {
        assert_eq!(Limits::new(Duration::from_millis(700)), Limits { total: Duration::from_millis(700), connect: Duration::from_millis(700), stall: Duration::from_millis(700) });
        assert_eq!(Limits::new(DOWNLOAD_TIME), Limits { total: DOWNLOAD_TIME, connect: CONNECT_TIMEOUT, stall: STALL_TIMEOUT });
    }
}
