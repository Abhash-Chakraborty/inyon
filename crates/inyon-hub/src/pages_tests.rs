//! features/pages.test.ts and pages-hub.test.ts: the list file, epochs, the API, and every `/v/`
//! answer checked against fixtures/pages/responses.json over a real socket, byte for byte. The
//! tokens in fixtures/pages/tokens.json were minted by the Bun hub's code; the same session secret
//! makes this hub mint and accept them too.

use std::cell::Cell;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::rc::Rc;

use axum::http::Method;
use http_body_util::BodyExt;
use inyon_core::features::pages_core::{error_page, pages_key, verify_token, VerifyContext, CANT_WRITE_LIST, NO_INDEX, PRIVATE_FOLDER, TOO_WIDE};
use inyon_core::platform::store::kv;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::*;
use crate::server::{dispatch, install_ctx, test_req, CtxInit};

const SECRET: &str = "fixture-session-secret: not a real one";
const HOST: &str = "hub.test:4777";
const PHONE_TOKEN: &str = "phone-bearer-token";

fn fixture(name: &str) -> Value {
    let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/pages").join(name);
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

fn fixtures_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/pages")
}

/// A temp folder, gone at the end of the test.
struct Tmp(PathBuf);

impl Tmp {
    fn new(name: &str) -> Tmp {
        let p = std::env::temp_dir().join(format!("inyon-hub-pages-{name}-{}-{}", std::process::id(), crate::http::random_hex(4)));
        std::fs::create_dir_all(&p).unwrap();
        Tmp(p)
    }
    fn join(&self, rel: &str) -> PathBuf {
        self.0.join(rel)
    }
}

impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn s(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for e in std::fs::read_dir(from).unwrap() {
        let e = e.unwrap();
        if e.file_type().unwrap().is_dir() {
            copy_dir(&e.path(), &to.join(e.file_name()));
        } else {
            std::fs::copy(e.path(), to.join(e.file_name())).unwrap();
        }
    }
}

fn set_mtime(p: &Path, at: std::time::SystemTime) {
    std::fs::OpenOptions::new().write(true).open(p).unwrap().set_modified(at).unwrap();
}

/// A site folder: the fixture site copied, or only an index.html.
fn site(t: &Tmp, name: &str, copy: bool) -> String {
    let dir = t.join(&format!("sites/{name}-{}", crate::http::random_hex(3)));
    if copy {
        copy_dir(&fixtures_dir().join("site"), &dir);
    } else {
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("index.html"), "<!doctype html><title>x</title>").unwrap();
    }
    s(&dir)
}

/// A FIFO at `p`, and a writer that opens it after two seconds and closes it at once: a hub that
/// opened it as a plain file waits that long (and then reads nothing), instead of hanging the test
/// for good. The writer is stopped when this is dropped, since a hub that never opens it leaves the
/// writer waiting.
struct Fifo(std::process::Child);

impl Fifo {
    fn at(p: &Path) -> Fifo {
        let _ = std::fs::remove_file(p);
        assert!(std::process::Command::new("mkfifo").arg(p).status().unwrap().success());
        Fifo(std::process::Command::new("sh").args(["-c", "sleep 2; : > \"$1\"", "sh"]).arg(p).spawn().unwrap())
    }
}

impl Drop for Fifo {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn record(slug: &str, path: &str) -> Value {
    json!({ "slug": slug, "name": slug, "path": path, "project": path, "by": "cli", "added": 1 })
}

fn write_list(file: &Path, pages: Value) {
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(file, serde_json::to_string(&json!({ "v": 1, "pages": pages })).unwrap()).unwrap();
}

fn read_list(file: &Path) -> Value {
    serde_json::from_str(&std::fs::read_to_string(file).unwrap()).unwrap()
}

/// The hub's records as a test hub has them: the fixture secret, a paired phone `ph1` (whose
/// bearer is PHONE_TOKEN), the fixture epochs, pages.json under `home`, and the routes.
fn hub(home: &Path, now: Rc<Cell<u64>>) {
    let t = fixture("tokens.json");
    kv::set_value("hub", &json!({ "secret": SECRET })).unwrap();
    crate::password::init();
    crate::auth::init();
    kv::set_value("phones", &json!([{ "id": "ph1", "name": "Pixel", "tokenHash": crate::http::sha256(PHONE_TOKEN), "pairedAt": 1, "lastSeen": 1 }])).unwrap();
    crate::phones::init();
    kv::set_value(EPOCHS_KEY, &t["epochs"]).unwrap();
    install(Pages::new(home.to_owned(), Rc::new(move || now.get())));
    let mut routes = Routes::default();
    add(&mut routes);
    install_ctx(
        CtxInit {
            data_dir: home.join("data"),
            bind: "127.0.0.1".into(),
            port: 0,
            tls: false,
            allowed_hosts: Some("hub.test".into()),
            allowed_origins: None,
            hostname: "test-box".into(),
            setup_code: None,
            local_token: "local".into(),
            hub_commit: String::new(),
            core: inyon_backends::core_here(),
        },
        routes,
    );
}

fn clock(at: u64) -> Rc<Cell<u64>> {
    Rc::new(Cell::new(at))
}

fn now_ms() -> u64 {
    inyon_core::clock::now_ms()
}

async fn body_json(r: Resp) -> Value {
    let b = r.into_body().collect().await.unwrap().to_bytes();
    serde_json::from_slice(&b).unwrap_or(Value::Null)
}

type Handler = fn(Req) -> futures_util::future::LocalBoxFuture<'static, HubResult<Resp>>;

/// A handler called as its route would call it: the result, or the error's status and message.
async fn call(f: Handler, method: &str, params: &[(&str, &str)], body: Option<Value>, headers: &[(&str, &str)]) -> Result<Value, (u16, String)> {
    let mut req = test_req(method, "/api/pages", headers, &body.map(|b| b.to_string()).unwrap_or_default());
    req.params = params.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect();
    match f(req).await {
        Ok(r) => Ok(body_json(r).await),
        Err(e) => Err((e.status.unwrap_or(500), e.message)),
    }
}

fn h_list(r: Req) -> futures_util::future::LocalBoxFuture<'static, HubResult<Resp>> {
    Box::pin(list(r))
}
fn h_open(r: Req) -> futures_util::future::LocalBoxFuture<'static, HubResult<Resp>> {
    Box::pin(open(r))
}
fn h_revoke(r: Req) -> futures_util::future::LocalBoxFuture<'static, HubResult<Resp>> {
    Box::pin(revoke(r))
}
fn h_register(r: Req) -> futures_util::future::LocalBoxFuture<'static, HubResult<Resp>> {
    Box::pin(register(r))
}
fn h_remove(r: Req) -> futures_util::future::LocalBoxFuture<'static, HubResult<Resp>> {
    Box::pin(remove(r))
}

async fn open_url(slug: &str) -> String {
    call(h_open, "POST", &[("host", "local"), ("slug", slug)], None, &[]).await.unwrap()["url"].as_str().unwrap().to_owned()
}

async fn add_page(body: Value) -> Result<Value, (u16, String)> {
    call(h_register, "POST", &[("host", "local")], Some(body), &[]).await
}

/// `/v/…` through the hub's dispatch, as the app's iframe asks for it.
async fn view_status(url: &str) -> u16 {
    dispatch(test_req("GET", url, &[("host", HOST)], "")).await.status().as_u16()
}

// ---------- the /v/ answer, against the fixture, over a socket ----------

struct Raw {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Raw {
    fn header(&self, k: &str) -> Option<&str> {
        self.headers.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str())
    }
}

/// One request written to the socket as is (a client would resolve the dot segments itself), and
/// its answer, with repeated headers joined as the Bun test joins them.
async fn raw(addr: SocketAddr, method: &str, target: &str, headers: &[(String, String)]) -> Raw {
    let mut sock = tokio::net::TcpStream::connect(addr).await.unwrap();
    let mut req = format!("{method} {target} HTTP/1.1\r\n");
    for (k, v) in headers {
        req.push_str(&format!("{k}: {v}\r\n"));
    }
    req.push_str("connection: close\r\n\r\n");
    sock.write_all(req.as_bytes()).await.unwrap();
    let mut all = vec![];
    sock.read_to_end(&mut all).await.unwrap();
    let end = all.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
    let head = String::from_utf8_lossy(&all[..end]).into_owned();
    let mut lines = head.split("\r\n");
    let status = lines.next().unwrap().split(' ').nth(1).unwrap().parse().unwrap();
    let mut out: Vec<(String, String)> = vec![];
    for line in lines {
        let (k, v) = line.split_once(':').unwrap();
        let (k, v) = (k.trim().to_lowercase(), v.trim().to_owned());
        match out.iter_mut().find(|(n, _)| *n == k) {
            Some((_, old)) => *old = format!("{old}, {v}"),
            None => out.push((k, v)),
        }
    }
    let mut body = all[end + 4..].to_vec();
    if out.iter().any(|(k, v)| k == "transfer-encoding" && v == "chunked") {
        let mut plain = vec![];
        let mut i = 0;
        loop {
            let eol = i + body[i..].windows(2).position(|w| w == b"\r\n").unwrap();
            let size = usize::from_str_radix(std::str::from_utf8(&body[i..eol]).unwrap().trim(), 16).unwrap();
            if size == 0 {
                break;
            }
            plain.extend_from_slice(&body[eol + 2..eol + 2 + size]);
            i = eol + 2 + size + 2;
        }
        body = plain;
    }
    Raw { status, headers: out, body }
}

/// responses.json's `setup` under `dir`. The site's folder.
fn lay_out(dir: &Path, setup: &Value) -> PathBuf {
    let site = dir.join("site");
    copy_dir(&fixtures_dir().join(setup["copy"].as_str().unwrap()), &site);
    std::fs::create_dir_all(dir.join("outside")).unwrap();
    for (name, text) in setup["outside"].as_object().unwrap() {
        std::fs::write(dir.join("outside").join(name), text.as_str().unwrap()).unwrap();
    }
    for (name, target) in setup["symlinks"].as_object().unwrap() {
        std::os::unix::fs::symlink(target.as_str().unwrap(), site.join(name)).unwrap();
    }
    let at = std::time::UNIX_EPOCH + std::time::Duration::from_millis(setup["mtimeMs"].as_u64().unwrap());
    fn touch(p: &Path, at: std::time::SystemTime) {
        for e in std::fs::read_dir(p).unwrap() {
            let e = e.unwrap();
            let ty = e.file_type().unwrap();
            if ty.is_symlink() {
                continue;
            }
            if ty.is_dir() {
                touch(&e.path(), at);
            } else {
                set_mtime(&e.path(), at);
            }
        }
    }
    touch(dir, at);
    site
}

/// The hub listening on a free port, as start.rs serves it.
async fn listen() -> SocketAddr {
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    crate::server::serve(l, None, crate::server::ctx().core.clone());
    addr
}

#[test]
fn every_view_request_in_responses_json_gets_exactly_its_status_headers_and_body() {
    let r = fixture("responses.json");
    let t = Tmp::new("responses");
    let site_dir = lay_out(&t.join("fixture"), &r["setup"]);
    let home = t.join("home");
    write_list(&pages_file(&home), json!([record(r["context"]["site"]["s"].as_str().unwrap(), &s(&site_dir))]));
    crate::test_util::block(async {
        hub(&home, clock(r["context"]["now"].as_u64().unwrap()));
        let addr = listen().await;
        let ignored: Vec<&str> = r["ignoredHeaders"].as_array().unwrap().iter().map(|h| h.as_str().unwrap()).collect();
        for c in r["cases"].as_array().unwrap() {
            let name = c["name"].as_str().unwrap();
            let q = &c["request"];
            let headers: Vec<(String, String)> = q["headers"].as_object().unwrap().iter().map(|(k, v)| (k.clone(), v.as_str().unwrap().to_owned())).collect();
            let res = raw(addr, q["method"].as_str().unwrap(), q["target"].as_str().unwrap(), &headers).await;
            let want = &c["response"];
            assert_eq!(u64::from(res.status), want["status"].as_u64().unwrap(), "{name}");
            let got: serde_json::Map<String, Value> = res.headers.iter().filter(|(k, _)| !ignored.contains(&k.as_str())).map(|(k, v)| (k.clone(), json!(v))).collect();
            assert_eq!(Value::Object(got), want["headers"], "{name}");
            let body: Vec<u8> = match &want["body"] {
                Value::Null => vec![],
                b if b["file"].is_string() => std::fs::read(fixtures_dir().join(b["file"].as_str().unwrap())).unwrap(),
                b => r["errorPages"][b["page"].to_string()].as_str().unwrap().as_bytes().to_vec(),
            };
            assert_eq!(String::from_utf8_lossy(&res.body), String::from_utf8_lossy(&body), "{name}");
        }

        // a Range request still gets the whole file with a 200, and nothing sets a cookie
        let css = r["cases"].as_array().unwrap().iter().find(|c| c["name"] == "stylesheet").unwrap();
        let target = css["request"]["target"].as_str().unwrap();
        let res = raw(addr, "GET", target, &[("host".into(), HOST.into()), ("range".into(), "bytes=0-3".into()), ("cookie".into(), "inyon_session=x.y".into())]).await;
        assert_eq!(res.status, 200);
        assert_eq!(res.header("content-range"), None);
        assert_eq!(res.header("set-cookie"), None);
        assert_eq!(res.body, std::fs::read(fixtures_dir().join("site/style.css")).unwrap());
        // HEAD names the size and sends nothing
        let res = raw(addr, "HEAD", target, &[("host".into(), HOST.into())]).await;
        assert_eq!(
            (res.status, res.header("content-length"), res.body.len()),
            (200, Some(std::fs::metadata(fixtures_dir().join("site/style.css")).unwrap().len().to_string().as_str()), 0)
        );
    });
}

#[test]
fn routes_match_the_path_as_it_came_so_a_dot_segment_into_api_is_no_route_as_in_bun() {
    let t = Tmp::new("dots");
    let home = t.join("home");
    crate::test_util::block(async {
        hub(&home, clock(now_ms()));
        let addr = listen().await;
        let cookie = crate::auth::issue_cookie(false).split(';').next().unwrap().to_owned();
        let h = |extra: &[(&str, &str)]| -> Vec<(String, String)> { [("host", HOST)].iter().chain(extra).map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect() };
        // Bun's router matches the raw path, and its fetch fallback answers /api with a 404
        for target in ["/api/nothing/../pages", "/api/%2e%2E/api/pages", "/api/./pages"] {
            let res = raw(addr, "GET", target, &h(&[("cookie", &cookie)])).await;
            assert_eq!((res.status, String::from_utf8_lossy(&res.body).into_owned()), (404, r#"{"error":"Not found"}"#.to_owned()), "{target}");
        }
        let res = raw(addr, "GET", "/v/x/../../api/pages", &h(&[])).await;
        assert_eq!(res.status, 404);
        let res = raw(addr, "GET", "/api/pages", &h(&[("cookie", &cookie)])).await;
        assert_eq!(res.status, 200);
    });
}

/// The disk as it is, except that the last look decide_view takes at `watch` swaps `folder` for a
/// symlink to `to` right after, as an agent renaming its own folders in a loop would.
struct SwapFs {
    watch: PathBuf,
    folder: PathBuf,
    to: PathBuf,
    swapped: Cell<bool>,
}

impl ViewFs for SwapFs {
    fn stat<'a>(&'a self, p: &'a Path) -> futures_util::future::LocalBoxFuture<'a, Option<FileStat>> {
        Box::pin(async move {
            let st = DiskFs.stat(p).await;
            if !self.swapped.get() && p == self.watch {
                self.swapped.set(true);
                let mut aside = self.folder.as_os_str().to_owned();
                aside.push("-real");
                std::fs::rename(&self.folder, PathBuf::from(aside)).unwrap();
                std::os::unix::fs::symlink(&self.to, &self.folder).unwrap();
            }
            st
        })
    }
    fn realpath<'a>(&'a self, p: &'a Path) -> futures_util::future::LocalBoxFuture<'a, Option<PathBuf>> {
        DiskFs.realpath(p)
    }
}

#[test]
fn a_folder_swapped_for_a_symlink_after_the_check_is_not_followed_out_of_the_site() {
    let tmp = Tmp::new("swap");
    let home = tmp.join("home");
    let dir = PathBuf::from(site(&tmp, "swap", true));
    let outside = tmp.join("outside");
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("index.html"), "SECRET KEY").unwrap();
    write_list(&pages_file(&home), json!([record("swap", &s(&dir))]));
    crate::test_util::block(async {
        hub(&home, clock(now_ms()));
        let real = std::fs::canonicalize(&dir).unwrap();
        let swap = Rc::new(SwapFs { watch: real.join("sub").join("index.html"), folder: dir.join("sub"), to: outside.clone(), swapped: Cell::new(false) });
        let mut p = Pages::new(home.clone(), Rc::new(now_ms));
        p.fs = swap.clone();
        install(p);
        let addr = listen().await;
        let url = open_url("swap").await;
        let res = raw(addr, "GET", &format!("{url}sub/index.html"), &[("host".into(), HOST.into())]).await;
        assert!(swap.swapped.get());
        assert_eq!(res.status, 404);
        assert!(!String::from_utf8_lossy(&res.body).contains("SECRET"));
        // with nothing swapped the same file is served
        let res = raw(addr, "GET", &format!("{url}style.css"), &[("host".into(), HOST.into())]).await;
        assert_eq!(res.status, 200);
    });
}

#[test]
fn a_file_swapped_for_a_fifo_after_the_check_is_a_404_at_once_not_an_open_that_waits_for_a_writer() {
    let tmp = Tmp::new("fifo");
    let home = tmp.join("home");
    let dir = PathBuf::from(site(&tmp, "fifo", true));
    write_list(&pages_file(&home), json!([record("fifo", &s(&dir))]));
    /// decide_view's last look at the file swaps it for a FIFO right after
    struct FifoFs(PathBuf, Cell<bool>);
    impl ViewFs for FifoFs {
        fn stat<'a>(&'a self, p: &'a Path) -> futures_util::future::LocalBoxFuture<'a, Option<FileStat>> {
            Box::pin(async move {
                let st = DiskFs.stat(p).await;
                if !self.1.get() && p == self.0 {
                    self.1.set(true);
                    std::fs::remove_file(&self.0).unwrap();
                    assert!(std::process::Command::new("mkfifo").arg(&self.0).status().unwrap().success());
                }
                st
            })
        }
        fn realpath<'a>(&'a self, p: &'a Path) -> futures_util::future::LocalBoxFuture<'a, Option<PathBuf>> {
            DiskFs.realpath(p)
        }
    }
    crate::test_util::block(async {
        hub(&home, clock(now_ms()));
        let fifo = Rc::new(FifoFs(std::fs::canonicalize(&dir).unwrap().join("style.css"), Cell::new(false)));
        let mut p = Pages::new(home.clone(), Rc::new(now_ms));
        p.fs = fifo.clone();
        install(p);
        let addr = listen().await;
        let url = open_url("fifo").await;
        let (target, headers) = (format!("{url}style.css"), [("host".to_string(), HOST.to_string())]);
        let get = || raw(addr, "GET", &target, &headers);
        let res = tokio::time::timeout(std::time::Duration::from_secs(3), get()).await.expect("the open waited for a writer");
        assert!(fifo.1.get());
        assert_eq!(res.status, 404);
        assert_eq!(String::from_utf8_lossy(&res.body), error_page(404));
        // and a FIFO there from the start is a 404 too
        assert_eq!(tokio::time::timeout(std::time::Duration::from_secs(3), get()).await.unwrap().status, 404);
    });
}

#[test]
fn a_file_replaced_after_the_check_is_sent_whole_with_the_length_of_the_file_opened() {
    let tmp = Tmp::new("replace");
    let home = tmp.join("home");
    let dir = PathBuf::from(site(&tmp, "replace", false));
    std::fs::write(dir.join("progress.json"), r#"{"a":1}"#).unwrap();
    write_list(&pages_file(&home), json!([record("replace", &s(&dir))]));
    /// progress.py's atomic replace, right after decide_view's last look at the file
    struct ReplaceFs(PathBuf, Cell<bool>);
    impl ViewFs for ReplaceFs {
        fn stat<'a>(&'a self, p: &'a Path) -> futures_util::future::LocalBoxFuture<'a, Option<FileStat>> {
            Box::pin(async move {
                let st = DiskFs.stat(p).await;
                if !self.1.get() && p == self.0 {
                    self.1.set(true);
                    let tmp = self.0.with_extension("tmp");
                    std::fs::write(&tmp, r#"{"a":1,"b":"a longer file than before"}"#).unwrap();
                    std::fs::rename(&tmp, &self.0).unwrap();
                }
                st
            })
        }
        fn realpath<'a>(&'a self, p: &'a Path) -> futures_util::future::LocalBoxFuture<'a, Option<PathBuf>> {
            DiskFs.realpath(p)
        }
    }
    crate::test_util::block(async {
        hub(&home, clock(now_ms()));
        let mut p = Pages::new(home.clone(), Rc::new(now_ms));
        p.fs = Rc::new(ReplaceFs(std::fs::canonicalize(&dir).unwrap().join("progress.json"), Cell::new(false)));
        install(p);
        let addr = listen().await;
        let url = open_url("replace").await;
        let res = raw(addr, "GET", &format!("{url}progress.json"), &[("host".into(), HOST.into())]).await;
        assert_eq!(res.status, 200);
        let body = String::from_utf8_lossy(&res.body).into_owned();
        assert_eq!(body, r#"{"a":1,"b":"a longer file than before"}"#);
        assert_eq!(res.header("content-length"), Some(body.len().to_string().as_str()));
    });
}

// ---------- tokens ----------

#[test]
fn the_hub_mints_the_tokens_in_tokens_json_phone_bound_when_a_phone_asks() {
    let t = fixture("tokens.json");
    let tmp = Tmp::new("mint");
    let home = tmp.join("home");
    let folder = site(&tmp, "mint", false);
    write_list(&pages_file(&home), json!([record("fixture", &folder)]));
    crate::test_util::block(async {
        let now = clock(0);
        hub(&home, now.clone());
        assert_eq!(crate::http::hex(&pages_key(&crate::password::session_secret())), t["key"].as_str().unwrap());
        let mut n = 0;
        for m in t["mint"].as_array().unwrap().iter().filter(|m| m["site"]["h"] == "local" && m["site"]["s"] == "fixture") {
            now.set(m["now"].as_u64().unwrap());
            let bearer = format!("Bearer {PHONE_TOKEN}");
            let headers: Vec<(&str, &str)> = if m["site"]["p"].is_string() { vec![("authorization", bearer.as_str())] } else { vec![] };
            assert_eq!(m["site"]["p"].as_str().unwrap_or("ph1"), "ph1");
            let opened = call(h_open, "POST", &[("host", "local"), ("slug", "fixture")], None, &headers).await.unwrap();
            assert_eq!(opened, json!({ "url": format!("/v/{}/", m["token"].as_str().unwrap()), "expires": m["expires"], "ttl": 43_200_000 }));
            n += 1;
        }
        assert_eq!(n, 2);
    });
}

#[test]
fn every_verify_vector_with_the_epochs_read_from_the_hub_data_folder() {
    let t = fixture("tokens.json");
    crate::test_util::block(async {
        let mut epochs = t["epochs"].clone();
        epochs["local/junk"] = json!(-1);
        epochs["local/frac"] = json!(1.5);
        kv::set_value(EPOCHS_KEY, &epochs).unwrap();
        let e = Epochs::load();
        assert_eq!((e.of("local", "junk"), e.of("local", "frac"), e.of("local", "fixture")), (0, 0, 3));
        let phones: Vec<&str> = t["phones"].as_array().unwrap().iter().map(|p| p.as_str().unwrap()).collect();
        let key = pages_key(t["secret"].as_str().unwrap());
        let epoch_of = |h: &str, s: &str| e.of(h, s);
        let phone_paired = |id: &str| phones.contains(&id);
        let ctx = VerifyContext { key: &key, now: t["now"].as_u64().unwrap(), epoch_of: &epoch_of, phone_paired: &phone_paired };
        for c in t["verify"].as_array().unwrap() {
            let got = verify_token(c["token"].as_str().unwrap(), &ctx).map_or_else(|v| v.as_str(), |_| "ok");
            assert_eq!(got, c["verdict"].as_str().unwrap(), "{}", c["name"]);
        }
    });
}

#[test]
fn revoking_moves_the_epoch_on_and_survives_a_restart_links_made_before_stop_working() {
    let tmp = Tmp::new("revoke");
    let home = tmp.join("home");
    write_list(&pages_file(&home), json!([record("plan", &site(&tmp, "plan", true))]));
    crate::test_util::block(async {
        hub(&home, clock(now_ms()));
        let before = open_url("plan").await;
        assert_eq!(view_status(&before).await, 200);
        assert_eq!(call(h_revoke, "POST", &[("host", "local"), ("slug", "plan")], None, &[]).await, Ok(json!({ "ok": true })));
        assert_eq!(kv::get_value(EPOCHS_KEY).unwrap()["local/plan"], json!(1));
        assert_eq!(Epochs::load().of("local", "plan"), 1);
        assert_eq!(view_status(&before).await, 403);
        let after = open_url("plan").await;
        assert_eq!(view_status(&after).await, 200);
        assert_eq!(call(h_revoke, "POST", &[("host", "local"), ("slug", "nope")], None, &[]).await.unwrap_err().0, 404);
        assert_eq!(call(h_open, "POST", &[("host", "laptop"), ("slug", "plan")], None, &[]).await.unwrap_err().0, 404);
    });
}

/// The hub's records in memory, with writes to one key failing once `fail` is set (a full disk).
struct FailingStore {
    inner: inyon_core::platform::store::MemoryStore,
    key: &'static str,
    fail: Cell<bool>,
}

impl inyon_core::platform::store::Store for FailingStore {
    fn get(&self, key: &str) -> Option<Value> {
        self.inner.get(key)
    }
    fn set(&self, key: &str, value: &Value) -> Result<(), String> {
        if self.fail.get() && key == self.key {
            return Err("No space left on device".into());
        }
        self.inner.set(key, value)
    }
    fn del(&self, key: &str) {
        self.inner.del(key)
    }
    fn keys(&self, prefix: &str) -> Vec<String> {
        self.inner.keys(prefix)
    }
}

#[test]
fn a_revoke_that_cannot_be_saved_says_so_and_still_ends_the_links_until_a_restart() {
    let tmp = Tmp::new("revoke-full");
    let home = tmp.join("home");
    write_list(&pages_file(&home), json!([record("plan", &site(&tmp, "plan", true))]));
    let store = Rc::new(FailingStore { inner: Default::default(), key: EPOCHS_KEY, fail: Cell::new(false) });
    inyon_core::platform::store::use_store(store.clone());
    crate::test_util::block(async {
        hub(&home, clock(now_ms()));
        let before = open_url("plan").await;
        store.fail.set(true);
        assert_eq!(call(h_revoke, "POST", &[("host", "local"), ("slug", "plan")], None, &[]).await, Err((500, NOT_SAVED.to_owned())));
        assert_eq!(view_status(&before).await, 403);
    });
}

#[test]
fn a_list_that_cannot_be_saved_is_still_served() {
    let tmp = Tmp::new("listed-full");
    let home = tmp.join("home");
    let store = Rc::new(FailingStore { inner: Default::default(), key: LISTED_KEY, fail: Cell::new(false) });
    inyon_core::platform::store::use_store(store.clone());
    crate::test_util::block(async {
        hub(&home, clock(now_ms()));
        store.fail.set(true);
        write_list(&pages_file(&home), json!([record("plan", &site(&tmp, "plan", true))]));
        assert_eq!(call(h_list, "GET", &[], None, &[]).await.unwrap()["pages"].as_array().unwrap().len(), 1);
        assert_eq!(view_status(&open_url("plan").await).await, 200);
    });
}

#[test]
fn a_new_password_ends_every_link() {
    let tmp = Tmp::new("password");
    let home = tmp.join("home");
    write_list(&pages_file(&home), json!([record("plan", &site(&tmp, "plan", true))]));
    crate::test_util::block(async {
        hub(&home, clock(now_ms()));
        let url = open_url("plan").await;
        assert_eq!(view_status(&url).await, 200);
        crate::password::set_password("a brand new password").unwrap();
        assert_eq!(view_status(&url).await, 403);
    });
}

#[test]
fn a_phones_link_is_bound_to_it_and_stops_when_the_phone_is_forgotten() {
    let tmp = Tmp::new("phone");
    let home = tmp.join("home");
    write_list(&pages_file(&home), json!([record("plan", &site(&tmp, "plan", true))]));
    crate::test_util::block(async {
        hub(&home, clock(now_ms()));
        let bearer = format!("Bearer {PHONE_TOKEN}");
        let opened = call(h_open, "POST", &[("host", "local"), ("slug", "plan")], None, &[("authorization", &bearer)]).await.unwrap();
        let url = opened["url"].as_str().unwrap().to_owned();
        let payload = url.split('/').nth(2).unwrap().split('.').nth(1).unwrap().to_owned();
        use base64::Engine;
        let claims: Value = serde_json::from_slice(&base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(payload).unwrap()).unwrap();
        assert_eq!(claims["p"], "ph1");
        assert_eq!(view_status(&url).await, 200);
        assert!(crate::phones::revoke_phone("ph1"));
        assert_eq!(view_status(&url).await, 403);
    });
}

// ---------- the list ----------

#[test]
fn the_list_has_a_progress_summary_and_is_read_again_when_the_file_changes() {
    let tmp = Tmp::new("list");
    let home = tmp.join("home");
    let a = site(&tmp, "a", true);
    let file = pages_file(&home);
    write_list(&file, json!([{ "slug": "a", "name": "Plan A", "path": a, "project": "/p", "by": "claude", "added": 5 }]));
    crate::test_util::block(async {
        hub(&home, clock(1_792_320_000_000));
        let progress = json!({ "done": 1, "total": 3, "now": "Writing the sub page", "updated": "2026-10-19T12:00+00:00" });
        let got = call(h_list, "GET", &[], None, &[]).await.unwrap();
        assert_eq!(got, json!({ "pages": [{ "host": "local", "slug": "a", "name": "Plan A", "project": "/p", "by": "claude", "added": 5, "folder": a, "progress": progress }] }));
        let b = site(&tmp, "b", false);
        write_list(&file, json!([record("a", &a), record("b", &b)]));
        set_mtime(&file, std::time::SystemTime::now() + std::time::Duration::from_secs(5));
        let got = call(h_list, "GET", &[], None, &[]).await.unwrap();
        let rows: Vec<(Value, Value)> = got["pages"].as_array().unwrap().iter().map(|p| (p["slug"].clone(), p.get("progress").cloned().unwrap_or(Value::Null))).collect();
        assert_eq!(rows, vec![(json!("a"), progress), (json!("b"), Value::Null)]);
    });
}

#[test]
fn progress_is_read_at_most_every_thirty_seconds() {
    let tmp = Tmp::new("progress");
    let home = tmp.join("home");
    let a = site(&tmp, "a", true);
    write_list(&pages_file(&home), json!([record("a", &a)]));
    crate::test_util::block(async {
        let now = clock(1_792_320_000_000);
        hub(&home, now.clone());
        let done = || async { call(h_list, "GET", &[], None, &[]).await.unwrap()["pages"][0]["progress"]["done"].clone() };
        assert_eq!(done().await, 1);
        std::fs::write(Path::new(&a).join("progress.json"), r#"{"releases":[{"tasks":[{"status":"done"},{"status":"done"}]}]}"#).unwrap();
        now.set(now.get() + 29_000);
        assert_eq!(done().await, 1);
        now.set(now.get() + 1_000);
        assert_eq!(done().await, 2);
    });
}

#[test]
fn a_fifo_as_progress_json_is_skipped_at_once_not_read_until_something_writes_to_it() {
    let tmp = Tmp::new("fifo-progress");
    let home = tmp.join("home");
    let a = site(&tmp, "a", true);
    let _writer = Fifo::at(&Path::new(&a).join("progress.json"));
    write_list(&pages_file(&home), json!([record("a", &a)]));
    crate::test_util::block(async {
        hub(&home, clock(now_ms()));
        let at = std::time::Instant::now();
        let got = call(h_list, "GET", &[], None, &[]).await.unwrap();
        assert!(at.elapsed() < std::time::Duration::from_secs(1), "took {:?}", at.elapsed());
        assert_eq!(got["pages"][0]["slug"], "a");
        assert_eq!(got["pages"][0].get("progress"), None);
    });
}

#[test]
fn a_fifo_as_the_list_file_itself_is_no_list_at_once() {
    let tmp = Tmp::new("fifo-list");
    let home = tmp.join("home");
    let file = pages_file(&home);
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    let _writer = Fifo::at(&file);
    crate::test_util::block(async {
        hub(&home, clock(now_ms()));
        let at = std::time::Instant::now();
        assert_eq!(call(h_list, "GET", &[], None, &[]).await, Ok(json!({ "pages": [] })));
        assert!(at.elapsed() < std::time::Duration::from_secs(1), "took {:?}", at.elapsed());
    });
}

#[test]
fn only_entries_that_may_be_served_come_out() {
    let tmp = Tmp::new("filter");
    let home = tmp.join("home");
    let good = site(&tmp, "good", false);
    std::fs::create_dir_all(home.join(".ssh/site")).unwrap();
    let link = tmp.join("home-link");
    std::os::unix::fs::symlink(&home, &link).unwrap();
    write_list(
        &pages_file(&home),
        json!([
            record("good", &good),
            record("good", &site(&tmp, "second", false)),
            record("Bad", &good),
            record("home", &s(&home)),
            record("ssh", &s(&home.join(".ssh/site"))),
            record("root", "/"),
            record("relative", "some/where"),
            record("via-link", &s(&link)),
            { "slug": "partial", "path": good },
            "junk"
        ]),
    );
    crate::test_util::block(async {
        hub(&home, clock(now_ms()));
        let got = call(h_list, "GET", &[], None, &[]).await.unwrap();
        let rows: Vec<(Value, Value)> = got["pages"].as_array().unwrap().iter().map(|p| (p["slug"].clone(), p["folder"].clone())).collect();
        assert_eq!(rows, vec![(json!("good"), json!(good))]);
        assert_eq!(call(h_open, "POST", &[("host", "local"), ("slug", "home")], None, &[]).await.unwrap_err().0, 404);
    });
}

#[test]
fn a_missing_file_is_an_empty_list_and_one_that_is_not_a_list_is_refused_for_writes_and_left_alone() {
    let tmp = Tmp::new("broken");
    let home = tmp.join("home");
    let file = pages_file(&home);
    let x = site(&tmp, "x", false);
    crate::test_util::block(async {
        hub(&home, clock(now_ms()));
        assert_eq!(call(h_list, "GET", &[], None, &[]).await, Ok(json!({ "pages": [] })));
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, r#"{"v":1,"pages":["#).unwrap();
        assert_eq!(call(h_list, "GET", &[], None, &[]).await, Ok(json!({ "pages": [] })));
        assert!(pages().registry.broken());
        assert_eq!(add_page(json!({ "path": x })).await, Err((500, BROKEN_FILE.into())));
        assert_eq!(call(h_remove, "DELETE", &[("host", "local"), ("slug", "x")], None, &[]).await, Err((500, BROKEN_FILE.into())));
        assert_eq!(std::fs::read_to_string(&file).unwrap(), r#"{"v":1,"pages":["#);
    });
}

// ---------- adding and removing ----------

#[test]
fn adding_takes_the_name_and_slug_from_the_marker_the_project_from_git_and_writes_the_file() {
    let tmp = Tmp::new("add");
    let home = tmp.join("home");
    let file = pages_file(&home);
    let folder = site(&tmp, "marked", true);
    let now = 1_792_320_000_000u64;
    crate::test_util::block(async {
        hub(&home, clock(now));
        let entry = add_page(json!({ "path": format!("{folder}/") })).await.unwrap();
        let progress = json!({ "done": 1, "total": 3, "now": "Writing the sub page", "updated": "2026-10-19T12:00+00:00" });
        assert_eq!(
            entry,
            json!({ "host": "local", "slug": "fixture", "name": "Fixture site", "project": folder, "by": "app", "added": now, "folder": folder, "progress": progress })
        );
        assert_eq!(read_list(&file), json!({ "v": 1, "pages": [{ "slug": "fixture", "name": "Fixture site", "path": folder, "project": folder, "by": "app", "added": now }] }));
        // written as JSON.stringify(…, null, 2) writes it, readable only by this user
        assert!(std::fs::read_to_string(&file).unwrap().starts_with("{\n  \"v\": 1,\n  \"pages\": [\n    {\n      \"slug\": \"fixture\""));
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
        assert!(!lock_of(&file).exists());

        // the project is the git top level when the folder is in a repository
        let repo = tmp.join("repo");
        std::fs::create_dir_all(repo.join("private/plans")).unwrap();
        assert!(std::process::Command::new("git").args(["init", "-q"]).arg(&repo).status().unwrap().success());
        copy_dir(&fixtures_dir().join("site"), &repo.join("private/plans/ghostex"));
        let in_repo = add_page(json!({ "path": s(&repo.join("private/plans/ghostex")), "name": "Inyon plan" })).await.unwrap();
        assert_eq!(
            (in_repo["slug"].clone(), in_repo["name"].clone(), in_repo["project"].clone()),
            (json!("fixture-2"), json!("Inyon plan"), json!(s(&std::fs::canonicalize(&repo).unwrap())))
        );
    });
}

#[test]
fn a_folder_in_a_linked_git_worktree_belongs_to_the_main_checkout_as_the_cli_and_the_skill_say() {
    let tmp = Tmp::new("worktree");
    let home = tmp.join("home");
    let repo = tmp.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    let git = |args: &[&str]| {
        let ok = std::process::Command::new("git")
            .arg("-C")
            .arg(&repo)
            .args(["-c", "user.name=t", "-c", "user.email=t@t"])
            .args(args)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap()
            .success();
        assert!(ok, "git {args:?}");
    };
    git(&["init", "-q"]);
    git(&["commit", "-q", "--allow-empty", "-m", "first"]);
    let tree = repo.join(".claude/worktrees/pages");
    git(&["worktree", "add", "-q", "--detach", &s(&tree)]);
    copy_dir(&fixtures_dir().join("site"), &tree.join("private/plans/ghostex"));
    crate::test_util::block(async {
        hub(&home, clock(1));
        let entry = add_page(json!({ "path": s(&tree.join("private/plans/ghostex")) })).await.unwrap();
        assert_eq!(entry["project"], json!(s(&std::fs::canonicalize(&repo).unwrap())));
    });
}

#[test]
fn the_project_is_found_the_same_with_any_git_old_ones_that_print_unknown_options_back_too() {
    let tmp = Tmp::new("old-git");
    let repo = tmp.join("repo");
    std::fs::create_dir_all(repo.join("sub")).unwrap();
    let repo = std::fs::canonicalize(&repo).unwrap();
    let git = |args: &[&str]| {
        let ok = std::process::Command::new("git").arg("-C").arg(&repo).args(["-c", "user.name=t", "-c", "user.email=t@t"]).args(args).output().unwrap().status.success();
        assert!(ok, "git {args:?}");
    };
    git(&["init", "-q"]);
    git(&["commit", "-q", "--allow-empty", "-m", "first"]);
    let tree = repo.join(".claude/worktrees/x");
    git(&["worktree", "add", "-q", "--detach", &s(&tree)]);
    std::fs::create_dir_all(tree.join("deep")).unwrap();
    // fixtures/old-git/git is git before 2.31 (prints --path-format=absolute back, exit 0); git-2.4 knows no --git-common-dir
    let old = fixtures_dir().join("../old-git");
    crate::test_util::block(async {
        for g in ["git".to_owned(), s(&old.join("git"))] {
            assert_eq!(project_of(&s(&repo), &g).await, s(&repo), "{g}");
            assert_eq!(project_of(&s(&repo.join("sub")), &g).await, s(&repo), "{g}");
            assert_eq!(project_of(&s(&tree), &g).await, s(&repo), "{g}");
            assert_eq!(project_of(&s(&tree.join("deep")), &g).await, s(&repo), "{g}");
        }
        let g24 = s(&old.join("git-2.4"));
        assert_eq!(project_of(&s(&repo.join("sub")), &g24).await, s(&repo));
        assert_eq!(project_of(&s(&tree.join("deep")), &g24).await, s(&tree));
    });
}

#[test]
fn a_fifo_as_the_marker_is_skipped_at_once_the_name_and_slug_come_from_the_folder() {
    let tmp = Tmp::new("fifo-marker");
    let home = tmp.join("home");
    let folder = site(&tmp, "piped", false);
    let _writer = Fifo::at(&Path::new(&folder).join(".inyon-page.json"));
    crate::test_util::block(async {
        hub(&home, clock(now_ms()));
        let at = std::time::Instant::now();
        let entry = add_page(json!({ "path": folder })).await.unwrap();
        assert!(at.elapsed() < std::time::Duration::from_secs(1), "took {:?}", at.elapsed());
        let base = Path::new(&folder).file_name().unwrap().to_string_lossy().into_owned();
        assert_eq!((entry["slug"].clone(), entry["name"].clone()), (json!(base), json!(base)));
    });
}

#[test]
fn without_a_marker_the_slug_comes_from_the_folder_whatever_the_name_and_is_unique() {
    let tmp = Tmp::new("slugs");
    let home = tmp.join("home");
    let twin = |parent: &str| {
        let dir = tmp.join(&format!("twins/{parent}/Handy"));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("index.html"), "<!doctype html><title>x</title>").unwrap();
        s(&dir)
    };
    let (h1, h2, named, x) = (twin("a"), twin("b"), site(&tmp, "Folder-Name", false), site(&tmp, "x", false));
    crate::test_util::block(async {
        hub(&home, clock(now_ms()));
        let slug = |v: Result<Value, (u16, String)>| v.unwrap()["slug"].as_str().unwrap().to_owned();
        assert_eq!(slug(add_page(json!({ "path": h1, "name": "Handy redesign" })).await), "handy");
        assert_eq!(slug(add_page(json!({ "path": h2, "name": "Handy redesign" })).await), "handy-2");
        assert_eq!(slug(add_page(json!({ "path": named })).await), Path::new(&named).file_name().unwrap().to_string_lossy().to_lowercase());
        assert_eq!(slug(add_page(json!({ "path": x, "slug": "chosen" })).await), "chosen");
    });
}

#[test]
fn the_same_folder_again_is_the_same_page_and_a_new_name_renames_it() {
    let tmp = Tmp::new("again");
    let home = tmp.join("home");
    let folder = site(&tmp, "again", false);
    crate::test_util::block(async {
        hub(&home, clock(now_ms()));
        let first = add_page(json!({ "path": folder, "name": "One" })).await.unwrap();
        assert_eq!(add_page(json!({ "path": folder })).await.unwrap(), first);
        let renamed = add_page(json!({ "path": folder, "name": "Two" })).await.unwrap();
        assert_eq!((renamed["slug"].clone(), renamed["name"].clone(), renamed["added"].clone()), (first["slug"].clone(), json!("Two"), first["added"].clone()));
        assert_eq!(read_list(&pages_file(&home))["pages"].as_array().unwrap().len(), 1);
        assert_eq!(add_page(json!({ "path": folder, "slug": "other" })).await.unwrap_err().0, 409);
    });
}

#[test]
fn adding_refuses_bad_folders_slugs_names_and_other_machines() {
    let tmp = Tmp::new("refuse");
    let home = tmp.join("home");
    std::fs::create_dir_all(home.join(".inyon/site")).unwrap();
    std::fs::write(home.join(".inyon/site/index.html"), "x").unwrap();
    let empty = tmp.join("empty");
    std::fs::create_dir_all(&empty).unwrap();
    let (s1, s2, s3) = (site(&tmp, "s", false), site(&tmp, "s", false), site(&tmp, "s", false));
    let (taken, t2, t3) = (site(&tmp, "taken", false), site(&tmp, "t2", false), site(&tmp, "t3", false));
    crate::test_util::block(async {
        hub(&home, clock(now_ms()));
        let msg = |r: Result<Value, (u16, String)>| r.unwrap_err().1;
        assert_eq!(msg(add_page(json!({ "path": s(&home) })).await), TOO_WIDE);
        assert_eq!(msg(add_page(json!({ "path": "/" })).await), TOO_WIDE);
        assert_eq!(msg(add_page(json!({ "path": s(&home.join(".inyon/site")) })).await), PRIVATE_FOLDER);
        assert_eq!(msg(add_page(json!({ "path": s(&empty) })).await), NO_INDEX);
        assert_eq!(msg(add_page(json!({ "path": "relative" })).await), "The folder must be an absolute path");
        assert_eq!(msg(add_page(json!({})).await), "The folder must be an absolute path");
        assert!(msg(add_page(json!({ "path": s1, "slug": "Not A Slug" })).await).starts_with("A slug is"));
        assert!(msg(add_page(json!({ "path": s1, "slug": null })).await).starts_with("A slug is"));
        assert_eq!(msg(add_page(json!({ "path": s2, "name": 5 })).await), "The name must be text");
        assert_eq!(call(h_register, "POST", &[("host", "laptop")], Some(json!({ "path": s3 })), &[]).await, Err((404, OTHER_MACHINE.into())));
        assert_eq!(call(h_register, "POST", &[("host", "local")], Some(json!([1])), &[]).await, Err((400, "Invalid JSON".into())));
        let to_home = tmp.join("to-home");
        std::os::unix::fs::symlink(&home, &to_home).unwrap();
        std::fs::write(home.join("index.html"), "x").unwrap();
        assert_eq!(msg(add_page(json!({ "path": s(&to_home) })).await), TOO_WIDE);
        add_page(json!({ "path": taken, "slug": "taken" })).await.unwrap();
        assert_eq!(add_page(json!({ "path": t2, "slug": "taken" })).await.unwrap_err().0, 409);
        assert!(add_page(json!({ "path": t3 })).await.is_ok());
    });
}

#[test]
fn adding_keeps_entries_it_cannot_read_and_other_fields_of_the_file_as_they_were() {
    let tmp = Tmp::new("keep");
    let home = tmp.join("home");
    let file = pages_file(&home);
    let unknown = json!({ "slug": "future", "path": "/x", "kind": "remote", "extra": [1] });
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(&file, serde_json::to_string(&json!({ "v": 1, "pages": [unknown], "note": "kept" })).unwrap()).unwrap();
    let (k1, k2) = (site(&tmp, "k", false), site(&tmp, "k", false));
    crate::test_util::block(async {
        hub(&home, clock(now_ms()));
        assert_eq!(add_page(json!({ "path": k1, "slug": "future" })).await.unwrap_err().0, 409);
        add_page(json!({ "path": k2, "slug": "k" })).await.unwrap();
        let after = read_list(&file);
        assert_eq!(after["note"], "kept");
        assert_eq!(after["pages"][0], unknown);
        let slugs: Vec<&str> = after["pages"].as_array().unwrap().iter().map(|p| p["slug"].as_str().unwrap()).collect();
        assert_eq!(slugs, ["future", "k"]);
        // and in the order the file had its fields
        assert!(std::fs::read_to_string(&file).unwrap().starts_with("{\n  \"v\": 1,\n  \"pages\": ["));
    });
}

#[test]
fn removing_drops_the_page_from_the_file_and_ends_its_links_even_if_the_slug_comes_back() {
    let tmp = Tmp::new("remove");
    let home = tmp.join("home");
    let folder = site(&tmp, "gone", true);
    write_list(&pages_file(&home), json!([record("gone", &folder), record("kept", &site(&tmp, "kept", false))]));
    crate::test_util::block(async {
        hub(&home, clock(now_ms()));
        let url = open_url("gone").await;
        assert_eq!(call(h_remove, "DELETE", &[("host", "local"), ("slug", "gone")], None, &[]).await, Ok(json!({ "ok": true })));
        let slugs: Vec<Value> = read_list(&pages_file(&home))["pages"].as_array().unwrap().iter().map(|p| p["slug"].clone()).collect();
        assert_eq!(slugs, vec![json!("kept")]);
        assert_eq!(call(h_remove, "DELETE", &[("host", "local"), ("slug", "gone")], None, &[]).await.unwrap_err().0, 404);
        add_page(json!({ "path": folder, "slug": "gone" })).await.unwrap();
        assert_eq!(view_status(&url).await, 403);
        assert_eq!(view_status(&open_url("gone").await).await, 200);
    });
}

#[test]
fn taken_off_the_file_by_another_program_ends_its_links_too_other_changes_keep_them() {
    let tmp = Tmp::new("remove-cli");
    let home = tmp.join("home");
    let file = pages_file(&home);
    let folder = site(&tmp, "cli", true);
    write_list(&file, json!([record("cli", &folder)]));
    crate::test_util::block(async {
        hub(&home, clock(now_ms()));
        let url = open_url("cli").await;
        assert_eq!(view_status(&url).await, 200);
        // another page added, this one renamed: same page, links still open
        let mut renamed = record("cli", &folder);
        renamed["name"] = json!("Renamed");
        write_list(&file, json!([renamed, record("other", &site(&tmp, "other", false))]));
        assert_eq!(view_status(&url).await, 200);
        // removed and added again under the same slug before the hub looked: a new page, old links end
        let mut again = record("cli", &folder);
        again["added"] = json!(2);
        write_list(&file, json!([again]));
        assert_eq!(view_status(&url).await, 403);
        assert_eq!(pages().epochs.of("local", "cli"), 1);
        assert_eq!(view_status(&open_url("cli").await).await, 200);
        // the file deleted: every page it listed is gone
        std::fs::remove_file(&file).unwrap();
        assert!(pages().registry.records().is_empty());
        assert_eq!(pages().epochs.of("local", "cli"), 2);
    });
}

#[test]
fn removed_and_added_again_while_the_hub_was_stopped_its_old_links_still_end() {
    let tmp = Tmp::new("remove-restart");
    let home = tmp.join("home");
    let file = pages_file(&home);
    let folder = site(&tmp, "restart", true);
    write_list(&file, json!([record("plan", &folder)]));
    crate::test_util::block(async {
        hub(&home, clock(now_ms()));
        let url = open_url("plan").await;
        // the hub stops; the CLI removes the page and adds it again
        let mut again = record("plan", &folder);
        again["added"] = json!(7);
        write_list(&file, json!([again]));
        install(Pages::new(home.clone(), Rc::new(now_ms)));
        assert_eq!(view_status(&url).await, 403);
        // and a restart with nothing changed keeps links working
        let fresh = open_url("plan").await;
        install(Pages::new(home.clone(), Rc::new(now_ms)));
        assert_eq!(view_status(&fresh).await, 200);
    });
}

// ---------- the lock ----------

#[test]
fn the_lock_waits_for_a_live_writer_and_takes_over_one_left_for_more_than_ten_seconds() {
    let tmp = Tmp::new("lock");
    let lock = tmp.join("pages.json.lock");
    std::fs::write(&lock, "1\n").unwrap();
    crate::test_util::block(async {
        assert_eq!(with_lock(&lock, 100, || Ok(1)).await.unwrap_err().message, LOCKED);
        assert!(lock.exists());
        set_mtime(&lock, std::time::SystemTime::now() - std::time::Duration::from_secs(11));
        let inside = with_lock(&lock, 100, || Ok(std::fs::read_to_string(&lock).unwrap())).await.unwrap();
        let (pid, tag) = inside.trim_end().split_once(' ').unwrap();
        assert_eq!((pid, tag.len(), inside.ends_with('\n')), (std::process::id().to_string().as_str(), 16, true));
        assert!(!lock.exists());
        // nothing is left beside it from the takeover
        assert_eq!(std::fs::read_dir(tmp.join("")).unwrap().count(), 0);
        // released when the change fails, too
        assert_eq!(with_lock::<()>(&lock, 100, || Err(http(400, "boom"))).await.unwrap_err().message, "boom");
        assert!(!lock.exists());
    });
}

#[test]
fn a_lock_its_tag_could_not_be_written_to_is_taken_away_again_not_left_for_ten_seconds() {
    let tmp = Tmp::new("lock-full");
    let lock = tmp.join("pages.json.lock");
    let full = |_: &mut std::fs::File, _: &[u8]| Err(std::io::Error::from_raw_os_error(libc::ENOSPC));
    assert_eq!(make_lock(&lock, "1 tag\n", full).unwrap_err().raw_os_error(), Some(libc::ENOSPC));
    assert!(!lock.exists());
    // the next writer gets it at once
    crate::test_util::block(async {
        assert_eq!(with_lock(&lock, 100, || Ok("in")).await.unwrap(), "in");
    });
}

#[test]
fn the_lock_is_removed_only_while_it_is_still_this_writers() {
    let tmp = Tmp::new("lock-owned");
    let lock = tmp.join("pages.json.lock");
    crate::test_util::block(async {
        // another writer took it over (it thought this one had died) and holds it now
        with_lock(&lock, 100, || {
            std::fs::write(&lock, "999 0123456789abcdef\n").unwrap();
            Ok(())
        })
        .await
        .unwrap();
        assert_eq!(std::fs::read_to_string(&lock).unwrap(), "999 0123456789abcdef\n");
    });
}

#[test]
fn a_stale_lock_judged_by_two_writers_leaves_the_fresh_one_in_its_place() {
    let tmp = Tmp::new("lock-race");
    let lock = tmp.join("pages.json.lock");
    std::fs::write(&lock, "1 stale\n").unwrap();
    set_mtime(&lock, std::time::SystemTime::now() - std::time::Duration::from_secs(11));
    let judged = std::fs::metadata(&lock).unwrap();
    // another writer saw it stale too, took it over and made its own before this one acts
    std::fs::remove_file(&lock).unwrap();
    std::fs::write(&lock, "2 fresh\n").unwrap();
    remove_judged(&lock, &judged).unwrap();
    assert_eq!(std::fs::read_to_string(&lock).unwrap(), "2 fresh\n");
    assert_eq!(std::fs::read_dir(tmp.join("")).unwrap().count(), 1);
}

#[cfg(unix)]
#[test]
fn a_stale_lock_that_cannot_be_removed_is_an_error_not_a_wait() {
    use std::os::unix::fs::PermissionsExt;
    let tmp = Tmp::new("lock-ro");
    let dir = tmp.join("ro");
    std::fs::create_dir_all(&dir).unwrap();
    let lock = dir.join("pages.json.lock");
    std::fs::write(&lock, "1\n").unwrap();
    set_mtime(&lock, std::time::SystemTime::now() - std::time::Duration::from_secs(11));
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o500)).unwrap();
    let r = crate::test_util::block(async { with_lock(&lock, 60_000, || Ok(1)).await });
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    // root ignores the folder's mode; then the takeover just works
    if unsafe { libc::geteuid() } != 0 {
        let e = r.unwrap_err();
        assert_eq!((e.status, e.message.as_str()), (Some(500), CANT_WRITE_LIST));
    }
}

#[cfg(unix)]
#[test]
fn register_and_delete_answer_the_same_500_as_the_bun_hub_when_a_stale_lock_cannot_be_removed() {
    use std::os::unix::fs::PermissionsExt;
    if unsafe { libc::geteuid() } == 0 {
        return; // root ignores the folder's mode
    }
    let tmp = Tmp::new("lock-ro-routes");
    let home = tmp.join("home");
    let file = pages_file(&home);
    let (listed, fresh) = (site(&tmp, "listed", false), site(&tmp, "new", false));
    write_list(&file, json!([record("listed", &listed)]));
    let lock = file.with_extension("json.lock");
    std::fs::write(&lock, "1\n").unwrap();
    set_mtime(&lock, std::time::SystemTime::now() - std::time::Duration::from_secs(11));
    let inyon = file.parent().unwrap().to_path_buf();
    std::fs::set_permissions(&inyon, std::fs::Permissions::from_mode(0o500)).unwrap();
    let (added, removed) = crate::test_util::block(async {
        hub(&home, clock(now_ms()));
        (add_page(json!({ "path": fresh })).await, call(h_remove, "DELETE", &[("host", "local"), ("slug", "listed")], None, &[]).await)
    });
    std::fs::set_permissions(&inyon, std::fs::Permissions::from_mode(0o700)).unwrap();
    assert_eq!(added, Err((500, CANT_WRITE_LIST.into())));
    assert_eq!(removed, Err((500, CANT_WRITE_LIST.into())));
}

#[test]
fn two_writers_at_once_both_land() {
    let tmp = Tmp::new("writers");
    let home = tmp.join("home");
    let sites = [site(&tmp, "w1", false), site(&tmp, "w2", false), site(&tmp, "w3", false)];
    crate::test_util::block(async {
        hub(&home, clock(now_ms()));
        let all = futures_util::future::join_all(sites.iter().map(|p| add_page(json!({ "path": p })))).await;
        assert!(all.iter().all(Result::is_ok));
        assert_eq!(read_list(&pages_file(&home))["pages"].as_array().unwrap().len(), 3);
    });
}

// ---------- the hub's checks ----------

#[test]
fn cookie_api_calls_from_a_framed_page_or_another_site_are_refused_reads_too_but_not_a_bearer() {
    let tmp = Tmp::new("framed");
    let home = tmp.join("home");
    write_list(&pages_file(&home), json!([record("fixture", &site(&tmp, "f", true))]));
    crate::test_util::block(async {
        hub(&home, clock(now_ms()));
        let cookie = crate::auth::issue_cookie(false).split(';').next().unwrap().to_owned();
        let ask = |method: &'static str, path: &'static str, extra: Vec<(&'static str, String)>| {
            let mut headers: Vec<(&str, String)> = vec![("host", HOST.to_owned())];
            headers.extend(extra);
            async move {
                let refs: Vec<(&str, &str)> = headers.iter().map(|(k, v)| (*k, v.as_str())).collect();
                let res = dispatch(test_req(method, path, &refs, "")).await;
                let status = res.status().as_u16();
                (status, body_json(res).await)
            }
        };
        let refused = json!({ "error": "Cross-site request refused" });
        for (m, p, extra) in [
            ("GET", "/api/pages", vec![("cookie", cookie.clone()), ("origin", "null".into())]),
            ("GET", "/api/pages", vec![("cookie", cookie.clone()), ("sec-fetch-site", "cross-site".into())]),
            ("POST", "/api/pages/local/fixture/open", vec![("cookie", cookie.clone()), ("origin", "null".into())]),
            ("POST", "/api/pages/local/fixture/revoke", vec![("cookie", cookie.clone()), ("origin", "null".into()), ("sec-fetch-site", "cross-site".into())]),
        ] {
            assert_eq!(ask(m, p, extra).await, (403, refused.clone()), "{m} {p}");
        }
        // the app's own calls, and plain tools with no browser headers, still pass
        for extra in [vec![("sec-fetch-site", "same-origin".to_owned())], vec![("sec-fetch-site", "none".into())], vec![]] {
            let mut e = extra;
            e.push(("cookie", cookie.clone()));
            assert_eq!(ask("GET", "/api/pages", e).await.0, 200);
        }
        assert_eq!(ask("GET", "/api/pages", vec![]).await.0, 401);
        // a paired phone sends a bearer from its own origin, which is cross-site
        let bearer = format!("Bearer {PHONE_TOKEN}");
        assert_eq!(ask("GET", "/api/pages", vec![("authorization", bearer.clone()), ("origin", "null".into())]).await.0, 200);
        assert_eq!(ask("GET", "/api/pages", vec![("authorization", bearer), ("origin", "http://localhost".into()), ("sec-fetch-site", "cross-site".into())]).await.0, 200);
    });
}

#[test]
fn view_refuses_a_host_the_hub_does_not_answer_to_even_with_a_signed_in_cookie() {
    let tmp = Tmp::new("host");
    let home = tmp.join("home");
    write_list(&pages_file(&home), json!([record("fixture", &site(&tmp, "f", true))]));
    crate::test_util::block(async {
        hub(&home, clock(now_ms()));
        let url = open_url("fixture").await;
        let cookie = crate::auth::issue_cookie(false).split(';').next().unwrap().to_owned();
        let res = dispatch(test_req("GET", &url, &[("host", "evil.example"), ("cookie", &cookie)], "")).await;
        assert_eq!(res.status().as_u16(), 421);
        assert!(res.headers()["content-security-policy"].to_str().unwrap().starts_with("sandbox allow-scripts allow-forms allow-popups allow-downloads;"));
        assert!(res.headers().get("set-cookie").is_none());
        let b = res.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(String::from_utf8_lossy(&b), error_page(421));
        // and a forwarded name it doesn't know, behind a local proxy
        let res = dispatch(test_req("GET", &url, &[("host", HOST), ("x-forwarded-host", "evil.example")], "")).await;
        assert_eq!(res.status().as_u16(), 421);
        assert_eq!(view_status(&url).await, 200);
        let _ = Method::GET;
    });
}
