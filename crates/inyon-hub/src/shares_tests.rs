//! Shared links: what a share opens and for how long, how it ends (expiry, Revoke, Revoke links,
//! removing the page), and the public share address, where nothing but `/share/` answers.

use std::cell::Cell;
use std::path::{Path, PathBuf};
use std::rc::Rc;

use inyon_core::platform::store::kv;
use serde_json::{json, Value};

use super::*;
use crate::pages::{install as install_pages, pages_file, Pages};
use crate::server::{dispatch, install_ctx, test_req, CtxInit};

const HOST: &str = "hub.test:4777";
const SHARE: &str = "share.example.com";
const DAY: u64 = 24 * 60 * 60 * 1000;

/// A temp folder, gone at the end of the test.
struct Tmp(PathBuf);

impl Tmp {
    fn new(name: &str) -> Tmp {
        let p = std::env::temp_dir().join(format!("inyon-hub-shares-{name}-{}-{}", std::process::id(), crate::http::random_hex(4)));
        std::fs::create_dir_all(&p).unwrap();
        Tmp(p)
    }
}

impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// A blueprint folder with a page, a stylesheet, a dotfile, a dot folder and a symlink out of it,
/// and a secret beside it.
fn site(t: &Tmp) -> String {
    let dir = t.0.join("plan");
    std::fs::create_dir_all(dir.join(".git")).unwrap();
    std::fs::create_dir_all(dir.join("research")).unwrap();
    std::fs::write(dir.join("index.html"), "<!doctype html><title>Plan</title>").unwrap();
    std::fs::write(dir.join("style.css"), "body{}").unwrap();
    std::fs::write(dir.join("research/notes.md"), "# Notes").unwrap();
    std::fs::write(dir.join(".env"), "TOKEN=secret").unwrap();
    std::fs::write(dir.join(".git/config"), "[core]").unwrap();
    std::fs::write(t.0.join("secret.txt"), "outside").unwrap();
    std::os::unix::fs::symlink(t.0.join("secret.txt"), dir.join("out.txt")).unwrap();
    dir.to_string_lossy().into_owned()
}

/// A hub with one page ("plan") under `home`, the clock in `now`, and shares from the store (with
/// INYON_SHARE_ORIGIN as `env`).
fn hub(home: &Path, folder: &str, now: Rc<Cell<u64>>, env: Option<&str>) {
    std::fs::create_dir_all(pages_file(home).parent().unwrap()).unwrap();
    std::fs::write(pages_file(home), json!({ "v": 1, "pages": [{ "slug": "plan", "name": "Plan", "path": folder, "project": folder, "by": "cli", "added": 1 }] }).to_string())
        .unwrap();
    kv::set_value("hub", &json!({ "secret": "shares-test-secret" })).unwrap();
    crate::password::init();
    crate::auth::init();
    crate::phones::init();
    install_pages(Pages::new(home.to_owned(), Rc::new(move || now.get())));
    init(env);
    let mut routes = crate::server::hub_routes();
    crate::pages::add(&mut routes);
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

fn cookie() -> String {
    crate::auth::issue_cookie(false).split(';').next().unwrap().to_owned()
}

struct Answer {
    status: u16,
    headers: axum::http::HeaderMap,
    body: String,
}

impl Answer {
    fn json(&self) -> Value {
        serde_json::from_str(&self.body).unwrap_or(Value::Null)
    }
    fn header(&self, k: &str) -> Option<&str> {
        self.headers.get(k).and_then(|v| v.to_str().ok())
    }
}

/// One request through the hub's dispatch. A file's body is streamed outside dispatch, so a 200
/// for a file comes back with an empty body here; its status and headers are what count.
async fn ask(method: &str, path: &str, headers: &[(&str, &str)], body: Option<Value>) -> Answer {
    let r = dispatch(test_req(method, path, headers, &body.map(|b| b.to_string()).unwrap_or_default())).await;
    let status = r.status().as_u16();
    let headers = r.headers().clone();
    let b = r.into_body().bytes().await.unwrap_or_default();
    Answer { status, headers, body: String::from_utf8_lossy(&b).into_owned() }
}

/// An API call from the signed-in app on the hub's own address.
async fn api(method: &str, path: &str, body: Option<Value>) -> Answer {
    let c = cookie();
    ask(method, path, &[("host", HOST), ("cookie", &c)], body).await
}

async fn share(public: bool, days: u64) -> Value {
    let a = api("POST", "/api/pages/local/plan/shares", Some(json!({ "public": public, "days": days }))).await;
    assert_eq!(a.status, 200, "{}", a.body);
    a.json()
}

/// The path part of a share's link (`/share/<token>/`).
fn path_of(link: &Value) -> String {
    let url = link["url"].as_str().unwrap();
    url.find("/share/").map(|i| url[i..].to_owned()).unwrap()
}

async fn on_hub(path: &str) -> u16 {
    ask("GET", path, &[("host", HOST)], None).await.status
}

async fn on_share_address(path: &str) -> u16 {
    ask("GET", path, &[("host", SHARE)], None).await.status
}

#[test]
fn a_network_link_opens_its_blueprint_on_the_hub_until_it_runs_out() {
    let t = Tmp::new("expiry");
    let folder = site(&t);
    let now = Rc::new(Cell::new(1_000_000));
    let clock = now.clone();
    crate::test_util::block(async move {
        hub(&t.0.join("home"), &folder, clock, None);
        let link = share(false, 1).await;
        let url = link["url"].as_str().unwrap();
        assert!(url.starts_with("/share/") && url.ends_with('/'), "a network link is a path on the hub's own address: {url}");
        assert_eq!((link["public"].clone(), link["expires"].as_u64().unwrap() - link["created"].as_u64().unwrap()), (json!(false), DAY));
        let token = &url["/share/".len()..url.len() - 1];
        assert_eq!(token.len(), 22, "128 random bits as base64url");

        let a = ask("GET", url, &[("host", HOST), ("cookie", "inyon_session=x.y")], None).await;
        assert_eq!(a.status, 200);
        assert_eq!(a.header("x-robots-tag"), Some("noindex, nofollow"));
        assert_eq!(a.header("referrer-policy"), Some("no-referrer"));
        assert_eq!(a.header("set-cookie"), None, "a shared page never sets a cookie");
        let csp = a.header("content-security-policy").unwrap();
        assert!(csp.starts_with("sandbox allow-scripts") && csp.contains(&format!("script-src http://{HOST}/share/{token}/ ")), "{csp}");
        assert_eq!(on_hub(&format!("{url}style.css")).await, 200);
        // no slash after the token: sent to the page's top
        let a = ask("GET", &url[..url.len() - 1], &[("host", HOST)], None).await;
        assert_eq!((a.status, a.header("location")), (301, Some(url)));

        // a day later it's an expired link, worded for whoever was sent it
        now.set(1_000_000 + DAY);
        let a = ask("GET", url, &[("host", HOST)], None).await;
        assert_eq!(a.status, 403);
        assert!(a.body.contains("Ask whoever sent it for a new one"), "{}", a.body);
        // and it has left the lists
        assert_eq!(api("GET", "/api/shares", None).await.json()["links"], json!([]));
    });
}

#[test]
fn a_shared_link_reads_files_only_never_dotfiles_symlinks_out_or_a_path_that_climbs() {
    let t = Tmp::new("paths");
    let folder = site(&t);
    let clock = Rc::new(Cell::new(1_000_000));
    crate::test_util::block(async move {
        hub(&t.0.join("home"), &folder, clock, None);
        let url = share(false, 7).await["url"].as_str().unwrap().to_owned();
        for (rest, want) in [
            ("", 200),
            ("research/notes.md", 200),
            (".env", 404),
            (".git/config", 404),
            ("%2eenv", 404),
            ("out.txt", 404),
            ("missing.html", 404),
            ("research/", 404),
            // a climb out of the token is another token, which opens nothing
            ("../secret.txt", 403),
            ("%2e%2e/secret.txt", 403),
            ("..%2f..%2fsecret.txt", 404),
        ] {
            assert_eq!(on_hub(&format!("{url}{rest}")).await, want, "{rest}");
        }
        // read only
        for method in ["POST", "PUT", "DELETE"] {
            assert_eq!(ask(method, &url, &[("host", HOST)], None).await.status, 405, "{method}");
        }
        // a token that isn't one, and the app's /v/ links aren't share tokens
        assert_eq!(on_hub("/share/not-a-token/").await, 403);
        let v = api("POST", "/api/pages/local/plan/open", None).await.json()["url"].as_str().unwrap().to_owned();
        assert_eq!(on_hub(&v.replace("/v/", "/share/")).await, 403);
        // a name the hub doesn't answer to
        assert_eq!(ask("GET", &url, &[("host", "evil.example")], None).await.status, 421);
    });
}

#[test]
fn revoke_ends_one_link_revoke_all_ends_every_one_and_revoke_links_ends_the_pages_shares_too() {
    let t = Tmp::new("revoke");
    let folder = site(&t);
    let clock = Rc::new(Cell::new(1_000_000));
    crate::test_util::block(async move {
        hub(&t.0.join("home"), &folder, clock, None);
        let (a, b) = (share(false, 7).await, share(false, 30).await);
        let listed = api("GET", "/api/pages/local/plan/shares", None).await.json();
        assert_eq!(listed["links"].as_array().unwrap().len(), 2);
        assert!(listed["links"][0].get("hash").is_none() && listed["links"][0].get("url").is_none(), "a list never carries the link again");

        assert_eq!(api("DELETE", &format!("/api/pages/local/plan/shares/{}", a["id"].as_str().unwrap()), None).await.status, 200);
        assert_eq!(on_hub(&path_of(&a)).await, 403);
        assert_eq!(on_hub(&path_of(&b)).await, 200);
        assert_eq!(api("DELETE", &format!("/api/shares/{}", a["id"].as_str().unwrap()), None).await.status, 404);

        // Revoke links on the page ends its shared links as well as the app's
        assert_eq!(api("POST", "/api/pages/local/plan/revoke", None).await.status, 200);
        assert_eq!(on_hub(&path_of(&b)).await, 403);
        assert_eq!(api("GET", "/api/shares", None).await.json()["links"], json!([]));

        // a link made after the revoke works, until Revoke all
        let (c, d) = (share(false, 7).await, share(false, 7).await);
        assert_eq!(on_hub(&path_of(&c)).await, 200);
        let r = api("DELETE", "/api/shares", None).await;
        assert_eq!((r.status, r.json()["revoked"].clone()), (200, json!(2)));
        assert_eq!((on_hub(&path_of(&c)).await, on_hub(&path_of(&d)).await), (403, 403));

        // removing the page ends them too
        let e = share(false, 7).await;
        assert_eq!(api("DELETE", "/api/pages/local/plan", None).await.status, 200);
        assert_eq!(on_hub(&path_of(&e)).await, 403);
    });
}

#[test]
fn links_are_kept_hashed_and_survive_a_restart_with_their_opens_counted_at_the_top_only() {
    let t = Tmp::new("store");
    let folder = site(&t);
    let clock = Rc::new(Cell::new(1_000_000));
    crate::test_util::block(async move {
        hub(&t.0.join("home"), &folder, clock, None);
        let link = share(false, 7).await;
        let url = path_of(&link);
        let token = url.trim_start_matches("/share/").trim_end_matches('/').to_owned();
        let stored = kv::get_value(SHARES_KEY).unwrap();
        assert!(!stored.to_string().contains(&token), "the token itself is never stored");
        assert_eq!(stored["links"][0]["hash"], json!(crate::http::sha256(&token)));

        assert_eq!(on_hub(&url).await, 200);
        on_hub(&format!("{url}style.css")).await;
        ask("HEAD", &url, &[("host", HOST)], None).await;
        on_hub(&format!("{url}research/notes.md")).await;
        assert_eq!(on_hub(&url).await, 200);
        // opens are saved with the next change, or as the hub stops
        current().unwrap().flush(2_000_000);
        init(None);
        assert_eq!(on_hub(&url).await, 200, "a restart keeps the link");
        current().unwrap().flush(3_000_000);
        init(None);
        let listed = api("GET", "/api/shares", None).await.json();
        assert_eq!(listed["links"][0]["opens"], json!(3), "{listed}");
    });
}

#[test]
fn a_link_for_anyone_needs_the_share_address_and_uses_it() {
    let t = Tmp::new("public");
    let folder = site(&t);
    let clock = Rc::new(Cell::new(1_000_000));
    crate::test_util::block(async move {
        hub(&t.0.join("home"), &folder, clock, None);
        let a = api("POST", "/api/pages/local/plan/shares", Some(json!({ "public": true, "days": 7 }))).await;
        assert_eq!((a.status, a.json()["error"].clone()), (409, json!(NO_ADDRESS)));
        for days in [0, 31] {
            assert_eq!(api("POST", "/api/pages/local/plan/shares", Some(json!({ "days": days }))).await.status, 400, "{days}");
        }
        assert_eq!(api("POST", "/api/pages/local/nope/shares", Some(json!({}))).await.status, 404);

        let set = api("PUT", "/api/share-address", Some(json!({ "address": "Share.Example.com/" }))).await;
        assert_eq!((set.status, set.json()["address"].clone()), (200, json!("https://share.example.com")));
        let link = share(true, 7).await;
        assert!(link["url"].as_str().unwrap().starts_with("https://share.example.com/share/"), "{link}");

        // clearing the address keeps the links, which then open only on the hub's address
        assert_eq!(api("PUT", "/api/share-address", Some(json!({ "address": "" }))).await.json()["address"], Value::Null);
        assert_eq!(on_share_address(&path_of(&link)).await, 421);
        assert_eq!(on_hub(&path_of(&link)).await, 200);
    });
}

#[test]
fn the_share_address_answers_share_links_and_nothing_else() {
    let t = Tmp::new("isolation");
    let folder = site(&t);
    let clock = Rc::new(Cell::new(1_000_000));
    crate::test_util::block(async move {
        hub(&t.0.join("home"), &folder, clock, Some("https://share.example.com"));
        let public = share(true, 7).await;
        let network = share(false, 7).await;
        let url = path_of(&public);
        let token = url.trim_start_matches("/share/").trim_end_matches('/');

        let a = ask("GET", &url, &[("host", SHARE)], None).await;
        assert_eq!(a.status, 200);
        let csp = a.header("content-security-policy").unwrap();
        assert!(csp.contains(&format!("script-src https://share.example.com/share/{token}/ ")), "the CSP names the share address: {csp}");
        assert_eq!(a.header("x-robots-tag"), Some("noindex, nofollow"));
        assert_eq!(on_share_address(&format!("{url}style.css")).await, 200);
        assert_eq!(on_share_address(&format!("{url}.env")).await, 404);
        // a link for your network doesn't open there, though it does on the hub
        assert_eq!(on_share_address(&path_of(&network)).await, 403);
        assert_eq!(on_hub(&path_of(&network)).await, 200);
        assert_eq!(on_hub(&url).await, 200, "a link for anyone opens on the hub's own address too");

        // everything else is a 404, signed in or not, whatever name a proxy passes on
        let c = cookie();
        let v = api("POST", "/api/pages/local/plan/open", None).await.json()["url"].as_str().unwrap().to_owned();
        for (method, path) in [
            ("GET", "/"),
            ("GET", "/index.html"),
            ("GET", "/next/"),
            ("GET", "/api/pages"),
            ("GET", "/api/session"),
            ("POST", "/api/login"),
            ("GET", "/api/shares"),
            ("PUT", "/api/share-address"),
            ("GET", "/ws"),
            ("GET", "/ws2"),
            ("GET", "/node"),
            ("OPTIONS", "/api/pages"),
            ("GET", v.as_str()),
            ("GET", "/share/../api/pages"),
            ("GET", "/share/%2e%2e/api/session"),
            ("GET", "/sharex/"),
        ] {
            for headers in [
                vec![("host", SHARE)],
                vec![("host", "share.example.com:443"), ("cookie", c.as_str())],
                vec![("host", "SHARE.example.com.")],
                vec![("host", "127.0.0.1:4777"), ("x-forwarded-host", SHARE)],
            ] {
                let a = ask(method, path, &headers, None).await;
                assert_eq!(a.status, 404, "{method} {path} {headers:?}");
                assert!(!a.body.contains("Inyon") && a.header("set-cookie").is_none(), "{method} {path}");
            }
        }
        // the hub's own address is untouched
        assert_eq!(api("GET", "/api/pages", None).await.status, 200);
        // and Settings can't change an address set by the env var
        let a = api("PUT", "/api/share-address", Some(json!({ "address": "https://other.example.com" }))).await;
        assert_eq!((a.status, a.json()["error"].clone()), (409, json!(FROM_ENV)));
        assert_eq!(api("GET", "/api/shares", None).await.json()["fromEnv"], json!(true));
    });
}

#[test]
fn settings_refuse_the_address_the_app_is_open_at_and_anything_but_an_origin() {
    let t = Tmp::new("address");
    let folder = site(&t);
    let clock = Rc::new(Cell::new(1_000_000));
    crate::test_util::block(async move {
        hub(&t.0.join("home"), &folder, clock, None);
        let a = api("PUT", "/api/share-address", Some(json!({ "address": "http://hub.test:9000" }))).await;
        assert_eq!((a.status, a.json()["error"].clone()), (400, json!(SAME_ADDRESS)));
        for bad in ["https://share.example.com/plans", "ftp://share.example.com", "https://me:pw@share.example.com", "https://share.example.com/?a=1", "https://"] {
            assert_eq!(api("PUT", "/api/share-address", Some(json!({ "address": bad }))).await.status, 400, "{bad}");
        }
        assert_eq!(api("GET", "/api/shares", None).await.json()["address"], Value::Null);
    });
}

#[test]
fn an_address_is_kept_as_its_origin() {
    for (given, want) in [
        ("share.example.com", Some("https://share.example.com")),
        (" https://Share.Example.com/ ", Some("https://share.example.com")),
        ("http://10.0.0.5:8080", Some("http://10.0.0.5:8080")),
        ("https://share.example.com:443", Some("https://share.example.com")),
        ("", None),
    ] {
        assert_eq!(normalize_address(given), Ok(want.map(str::to_owned)), "{given}");
    }
    for bad in ["https://share.example.com/x", "https://share.example.com#a", "javascript:alert(1)", "mailto:a@b.c"] {
        assert!(normalize_address(bad).is_err(), "{bad}");
    }
}

#[test]
fn a_bad_env_address_walls_nothing_off() {
    crate::test_util::block(async {
        let s = Shares::load(Some("https://share.example.com/plans"));
        assert_eq!((s.address(), s.address_from_env()), (None, false));
    });
}

#[test]
fn the_api_needs_a_sign_in_and_the_inyon_command_cant_share() {
    let t = Tmp::new("auth");
    let folder = site(&t);
    let clock = Rc::new(Cell::new(1_000_000));
    crate::test_util::block(async move {
        hub(&t.0.join("home"), &folder, clock, None);
        for (method, path) in [("GET", "/api/shares"), ("POST", "/api/pages/local/plan/shares"), ("PUT", "/api/share-address"), ("DELETE", "/api/shares")] {
            assert_eq!(ask(method, path, &[("host", HOST)], Some(json!({}))).await.status, 401, "{method} {path}");
            let local = ask(method, path, &[("host", HOST), ("authorization", "Bearer local")], Some(json!({}))).await;
            assert_ne!(local.status, 200, "{method} {path}");
        }
    });
}

#[test]
fn the_setups_probe_is_answered_on_the_share_address_with_an_answer_only_this_hub_knows() {
    let t = Tmp::new("probe");
    let folder = site(&t);
    let clock = Rc::new(Cell::new(1_000_000));
    let c = clock.clone();
    crate::test_util::block(async move {
        hub(&t.0.join("home"), &folder, c, Some("https://share.example.com"));
        let s = current().unwrap();
        let (nonce, answer) = s.start_probe(clock.get());
        assert_ne!(nonce, answer, "the answer isn't in the request");
        let a = ask("GET", &format!("{CHECK_PREFIX}{nonce}"), &[("host", SHARE)], None).await;
        assert_eq!((a.status, a.body.as_str()), (200, answer.as_str()));
        assert_eq!(a.header("x-robots-tag"), Some("noindex, nofollow"));
        // another nonce, or the probe on the hub's own address, gets nothing
        assert_eq!(on_share_address(&format!("{CHECK_PREFIX}{}", crate::http::random_hex(16))).await, 404);
        let on_hub = ask("GET", &format!("{CHECK_PREFIX}{nonce}"), &[("host", HOST)], None).await;
        assert_ne!(on_hub.body, answer);
        assert_ne!(on_hub.status, 200);
        // two checks at once each keep their own; one that ends leaves the other
        let (other, other_answer) = s.start_probe(clock.get());
        assert_eq!(ask("GET", &format!("{CHECK_PREFIX}{nonce}"), &[("host", SHARE)], None).await.body, answer);
        s.end_probe(&nonce);
        assert_eq!(on_share_address(&format!("{CHECK_PREFIX}{nonce}")).await, 404);
        assert_eq!(ask("GET", &format!("{CHECK_PREFIX}{other}"), &[("host", SHARE)], None).await.body, other_answer);
        // and it lasts 30 s
        clock.set(clock.get() + 30_001);
        assert_eq!(on_share_address(&format!("{CHECK_PREFIX}{other}")).await, 404);
    });
}

#[test]
fn cleanup_can_ask_whether_a_page_has_a_live_link() {
    let t = Tmp::new("shares-page");
    let folder = site(&t);
    let clock = Rc::new(Cell::new(1_000_000));
    let c = clock.clone();
    crate::test_util::block(async move {
        hub(&t.0.join("home"), &folder, c, Some("https://share.example.com"));
        let s = current().unwrap();
        assert!(!s.shares_page("local", "plan", clock.get()));
        let link = share(true, 1).await;
        let (host, slug) = (link["host"].as_str().unwrap().to_owned(), link["slug"].as_str().unwrap().to_owned());
        assert!(s.shares_page(&host, &slug, clock.get()));
        assert!(!s.shares_page(&host, "another", clock.get()));
        assert!(!s.shares_page(&host, &slug, clock.get() + 24 * 3_600_000 + 1), "not once it runs out");
    });
}

#[test]
fn the_check_needs_an_address_and_says_when_its_name_doesnt_resolve() {
    let t = Tmp::new("check");
    let folder = site(&t);
    let clock = Rc::new(Cell::new(1_000_000));
    let home = t.0.join("home");
    crate::test_util::block(async move {
        hub(&home, &folder, clock.clone(), None);
        let none = api("POST", "/api/share-address/check", None).await;
        assert_eq!(none.status, 409, "{}", none.body);
        // .invalid never resolves (RFC 6761)
        hub(&home, &folder, clock, Some("https://share.nothing.invalid"));
        let a = api("POST", "/api/share-address/check", None).await;
        assert_eq!(a.status, 200, "{}", a.body);
        let r = a.json();
        assert_eq!(r["address"], json!("https://share.nothing.invalid"));
        assert_eq!(r["dns"]["ok"], json!(false));
        assert_eq!(r["reach"], json!({ "ok": false, "fault": "dns" }));
        assert_eq!(r["wall"]["ok"], json!(false));
        // the CLI's local token can't run it
        let cli = ask("POST", "/api/share-address/check", &[("host", HOST), ("authorization", "Bearer local")], None).await;
        assert!(cli.status >= 400, "{}", cli.status);
    });
}

#[test]
fn the_listing_says_where_a_proxy_reaches_the_hub() {
    let t = Tmp::new("upstream");
    let folder = site(&t);
    crate::test_util::block(async move {
        hub(&t.0.join("home"), &folder, Rc::new(Cell::new(1_000_000)), None);
        assert_eq!(api("GET", "/api/shares", None).await.json()["upstream"], json!("127.0.0.1:0"));
    });
}

#[test]
fn a_failed_check_says_what_failed() {
    assert_eq!(fault_of("io: invalid peer certificate: NotValidForName"), "tls");
    assert_eq!(fault_of("Connection refused (os error 111)"), "refused");
    assert_eq!(fault_of("couldn't connect within 10 s"), "timeout");
    assert_eq!(fault_of("dns failed: failed to lookup address information"), "dns");
    assert_eq!(fault_of("something else"), "other");
}
