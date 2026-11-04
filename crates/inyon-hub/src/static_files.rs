//! The apps, built and carried inside the program, each served the way index.ts served the web
//! app: the file asked for, or index.html for any other path (the app routes itself), with the page
//! headers on both. The app (apps/app, Dioxus) has the hub's root; the React app it took over from
//! (apps/web) stays at /classic for two releases, and /next, where the new app ran beside it, leads
//! to the same screen at the root.

use crate::http::Body;
use axum::http::{header, HeaderValue, Response};
use rust_embed::RustEmbed;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use crate::http::{append_header, set_header, text, Resp};

/// The classic app, built with `bun run build:hub` (base path /classic, no phone core) before the
/// program; a build without it says so at /classic. The phone core's wasm stays out: only the phone app and the browser copy run it, from their own
/// files, and a hub's page can't compile wasm under PAGE_CSP anyway.
#[derive(RustEmbed)]
#[folder = "../../apps/web/dist"]
#[exclude = "assets/inyon_phone_bg-*.wasm"]
#[allow_missing = true]
struct Web;

/// No framing by other sites; images only from the hub itself, so agent output can't make the
/// browser fetch an outside URL (a prompt-injected agent could put data in one). Scripts only from
/// the app's own files: the page's `script-src 'self'` alone would also take a script an agent
/// wrote under /v/. A path needs a host in CSP; `*:*` is any host on any port, and the page's own
/// policy still holds it to this hub, so together they leave the app's files on this hub.
pub const PAGE_CSP: &str = "frame-ancestors 'none'; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; script-src *:*/assets/ *:*/theme.js *:*/sw.js";

/// The app, built by apps/app/build.sh (dx and the wasm target). It is optional: a hub built
/// without it sends its pages to the classic app, and `cargo build` never needs dx.
#[derive(RustEmbed)]
#[folder = "../../apps/app/dist"]
#[allow_missing = true]
struct App;

/// PAGE_CSP for the app, which is wasm: a page may compile that only with 'wasm-unsafe-eval'.
pub const APP_CSP: &str =
    "frame-ancestors 'none'; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; script-src *:*/assets/ *:*/theme.js *:*/sw.js 'wasm-unsafe-eval'";

/// The policy sent beside APP_CSP. `*:*/assets/` alone would take a script from any site's
/// /assets/; a browser holds a page to every policy it is sent, so with this one only this hub's
/// own files under those paths run. The classic app's page carries the same rule in a meta tag
/// (apps/web/index.html), and its pages get this header too.
pub const APP_ORIGIN_CSP: &str = "script-src 'self' 'wasm-unsafe-eval'";

/// Where the classic app is served.
pub const CLASSIC: &str = "/classic";

/// PAGE_CSP for the classic app, whose files are all under /classic. It never compiles wasm (its
/// hub copy has no phone core), so its own-origin policy is CLASSIC_ORIGIN_CSP, without
/// 'wasm-unsafe-eval'.
pub const CLASSIC_CSP: &str =
    "frame-ancestors 'none'; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; script-src *:*/classic/assets/ *:*/classic/theme.js *:*/classic/sw.js";

/// The classic app's own-origin policy (see APP_ORIGIN_CSP).
pub const CLASSIC_ORIGIN_CSP: &str = "script-src 'self'";

/// What /classic says on a hub built without the classic app, or with one built for `/`.
pub const CLASSIC_MISSING: &str = "The classic app isn't in this build of the hub. Run `bun run build:hub` in apps/web before building the hub.";

pub fn page_headers(r: &mut Resp) {
    set_header(r, "content-security-policy", PAGE_CSP);
    set_header(r, "x-content-type-options", "nosniff");
    set_header(r, "referrer-policy", "same-origin");
}

/// The content types Bun gives these files.
fn content_type(name: &str) -> &'static str {
    let ext = name.rsplit_once('.').map_or("", |(_, e)| e).to_ascii_lowercase();
    match ext.as_str() {
        "js" | "mjs" => "text/javascript;charset=utf-8",
        "css" => "text/css;charset=utf-8",
        "html" | "htm" => "text/html;charset=utf-8",
        "json" | "map" => "application/json;charset=utf-8",
        "webmanifest" => "application/manifest+json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "txt" => "text/plain;charset=utf-8",
        "md" => "text/markdown",
        "xml" => "application/xml",
        "wasm" => "application/wasm",
        "mp3" => "audio/mpeg",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}

/// `path.normalize(decoded).replace(/^(\.\.[/\\])+/, '')` for a path that starts with `/`: dot
/// segments resolved, and nothing above the root.
pub fn normalize(path: &str) -> String {
    let decoded = crate::http::decode_uri_component(path).unwrap_or_else(|| path.to_owned());
    let mut parts: Vec<&str> = vec![];
    for seg in decoded.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            s => parts.push(s),
        }
    }
    let trailing = decoded.ends_with('/') && !parts.is_empty();
    format!("/{}{}", parts.join("/"), if trailing { "/" } else { "" })
}

/// Whether the browser takes gzip (RFC 9110): its own entry decides, else `*` does; `q=0` (the
/// name and the parameter in any case) refuses.
pub fn takes_gzip(accept: Option<&str>) -> bool {
    let mut star = None;
    for coding in accept.unwrap_or("").split(',') {
        let mut parts = coding.split(';').map(str::trim);
        let name = parts.next().unwrap_or("").to_ascii_lowercase();
        let q = parts.find_map(|p| p.split_once('=').filter(|(k, _)| k.trim().eq_ignore_ascii_case("q")).map(|(_, v)| v.trim().parse::<f32>().unwrap_or(1.0)));
        let ok = q.unwrap_or(1.0) > 0.0;
        match name.as_str() {
            "gzip" => return ok,
            "*" => star = Some(ok),
            _ => {}
        }
    }
    star.unwrap_or(false)
}

/// Text and wasm shrink to a third or less; pictures and fonts are compressed already.
fn compressible(name: &str) -> bool {
    let t = content_type(name);
    t.starts_with("text/") || (t.starts_with("application/") && !t.ends_with("octet-stream") && !t.ends_with("pdf")) || t == "image/svg+xml"
}

/// Files this small cost more in a gzip header than they save.
const GZIP_FROM: usize = 1024;

/// Gzip copies of the carried files, made on first request. The files are fixed in the program,
/// so the map holds at most one copy of each and never grows past them.
fn gzipped(key: String, data: &[u8]) -> Arc<[u8]> {
    static CACHE: OnceLock<Mutex<HashMap<String, Arc<[u8]>>>> = OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);
    if let Some(z) = cache.lock().unwrap_or_else(|e| e.into_inner()).get(&key) {
        return z.clone();
    }
    let mut e = flate2::write::GzEncoder::new(Vec::with_capacity(data.len() / 3), flate2::Compression::best());
    let z: Arc<[u8]> = match std::io::Write::write_all(&mut e, data).and_then(|()| e.finish()) {
        Ok(z) => z.into(),
        Err(_) => return data.into(),
    };
    cache.lock().unwrap_or_else(|e| e.into_inner()).insert(key, z.clone());
    z
}

fn file(app: &str, name: &str, data: Vec<u8>, cache: &'static str, gzip: bool) -> Resp {
    let squeeze = compressible(name) && data.len() >= GZIP_FROM;
    let mut r = if squeeze && gzip {
        let mut r = Response::new(Body::from(gzipped(format!("{app}{name}"), &data).to_vec()));
        r.headers_mut().insert(header::CONTENT_ENCODING, HeaderValue::from_static("gzip"));
        r
    } else {
        Response::new(Body::from(data))
    };
    if squeeze {
        r.headers_mut().insert(header::VARY, HeaderValue::from_static("accept-encoding"));
    }
    r.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type(name)));
    r.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
    page_headers(&mut r);
    r
}

/// An app's two policies: the paths its scripts may come from, and this hub as their only origin.
fn with_csp(mut r: Resp, paths: &str, origin: &str) -> Resp {
    set_header(&mut r, "content-security-policy", paths);
    append_header(&mut r, "content-security-policy", origin);
    r
}

/// The classic app's page, when it was built into this program for /classic. A copy built for `/`
/// would ask for its files there, where the app's are.
fn classic_page(get: impl Fn(&str) -> Option<Vec<u8>>) -> Option<Vec<u8>> {
    get("index.html").filter(|p| String::from_utf8_lossy(p).contains("/classic/assets/"))
}

/// Whether the classic app was built into this program.
pub fn built() -> bool {
    classic_page(|name| Web::get(name).map(|f| f.data.into_owned())).is_some()
}

/// Whether the app was built into this program.
pub fn app_built() -> bool {
    App::get("index.html").is_some()
}

/// One app's answer for `rel` (a normalized path inside it): the file, else its page, which
/// routes itself. A hashed file the build doesn't have (an old page asking after an update) is a
/// 404, never the page passed off as a script. None when the app wasn't built.
fn from_app(app: &str, rel: &str, gzip: bool, get: impl Fn(&str) -> Option<Vec<u8>>) -> Option<Resp> {
    if rel.len() > 1 {
        if let Some(data) = get(&rel[1..]) {
            let immutable = rel.starts_with("/assets/");
            return Some(file(app, rel, data, if immutable { "public, max-age=31536000, immutable" } else { "no-cache" }, gzip));
        }
        if rel.starts_with("/assets/") {
            return Some(text(404, "Not found"));
        }
    }
    get("index.html").map(|data| file(app, "index.html", data, "no-cache", gzip))
}

/// A temporary redirect (an older hub may come back) to `to` on this hub.
fn moved(to: &str) -> Resp {
    let mut r = text(302, "");
    set_header(&mut r, "location", to);
    page_headers(&mut r);
    r
}

/// `path` (as the request has it, still percent-encoded) and `query` under `base`. The rest of the
/// path never starts with a second slash or a backslash, which a browser reads as another site.
fn under(base: &str, path: &str, query: &str) -> String {
    let rest = path.trim_start_matches(['/', '\\']);
    let q = if query.is_empty() { String::new() } else { format!("?{query}") };
    format!("{base}/{rest}{q}")
}

/// What the hub serves at a path no route took: the classic app under /classic, the same path
/// without /next for an address from when the app ran there, and the app for the rest (the
/// classic app instead when this hub was built without it). `gzip` when the browser takes it.
pub fn serve(path: &str, query: &str, gzip: bool) -> Resp {
    serve_from(path, query, gzip, |name| App::get(name).map(|f| f.data.into_owned()), |name| Web::get(name).map(|f| f.data.into_owned()))
}

fn serve_from(path: &str, query: &str, gzip: bool, app: impl Fn(&str) -> Option<Vec<u8>>, classic: impl Fn(&str) -> Option<Vec<u8>>) -> Resp {
    let inside = |base: &str| path.strip_prefix(base).filter(|r| r.is_empty() || r.starts_with('/'));
    if let Some(rest) = inside(CLASSIC) {
        let rel = normalize(if rest.is_empty() { "/" } else { rest });
        return match classic_page(&classic).and_then(|_| from_app("classic:", &rel, gzip, &classic)) {
            Some(r) => with_csp(r, CLASSIC_CSP, CLASSIC_ORIGIN_CSP),
            None => {
                let mut r = text(503, CLASSIC_MISSING);
                page_headers(&mut r);
                r
            }
        };
    }
    if let Some(rest) = inside("/next") {
        return moved(&under("", rest, query));
    }
    match from_app("app:", &normalize(path), gzip, &app) {
        Some(r) => with_csp(r, APP_CSP, APP_ORIGIN_CSP),
        None => moved(&under(CLASSIC, path, query)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_stay_inside_the_app() {
        assert_eq!(normalize("/"), "/");
        assert_eq!(normalize("/assets/a.js"), "/assets/a.js");
        assert_eq!(normalize("/../../etc/passwd"), "/etc/passwd");
        assert_eq!(normalize("/a/%2e%2e/b"), "/b");
        assert_eq!(normalize("/m/x/p/1"), "/m/x/p/1");
    }

    #[test]
    fn the_app_runs_only_its_own_scripts_never_a_pages_under_v() {
        let mut r = Resp::new(Body::empty());
        page_headers(&mut r);
        let csp = r.headers()["content-security-policy"].to_str().unwrap().to_owned();
        let scripts = csp.split("; ").find_map(|d| d.strip_prefix("script-src ")).unwrap();
        assert_eq!(scripts.split(' ').collect::<Vec<_>>(), ["*:*/assets/", "*:*/theme.js", "*:*/sw.js"]);
        assert!(!scripts.contains("'self'") && !scripts.contains("/v/"));
        // the files the app loads are all under those
        let index = include_str!("../../../apps/web/index.html");
        assert!(index.contains(r#"<script src="/theme.js">"#) && index.contains("script-src 'self'"));
        assert!(include_str!("../../../apps/web/src/main.tsx").contains("publicFile('sw.js')"));
    }

    #[test]
    fn the_phone_cores_wasm_is_left_out_and_the_rest_is_in() {
        let Ok(dir) = std::fs::read_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/../../apps/web/dist/assets")) else { return };
        for e in dir.flatten() {
            let name = format!("assets/{}", e.file_name().to_string_lossy());
            let phone = name.starts_with("assets/inyon_phone_bg-") && name.ends_with(".wasm");
            assert_eq!(Web::get(&name).is_some(), !phone, "{name}");
        }
    }

    async fn body(r: Resp) -> String {
        String::from_utf8_lossy(&r.into_body().bytes().await.unwrap()).into_owned()
    }

    fn built_app(name: &str) -> Option<Vec<u8>> {
        match name {
            "index.html" => Some(b"<div id=main></div><script type=module src=/assets/app-1.js></script>".to_vec()),
            "assets/app-1.js" => Some(b"export{}".to_vec()),
            "assets/app_bg-1.wasm" => Some(vec![0, 97, 115, 109]),
            "sw.js" => Some(b"self.addEventListener('push', () => {})".to_vec()),
            _ => None,
        }
    }

    fn built_classic(name: &str) -> Option<Vec<u8>> {
        match name {
            "index.html" => Some(b"<div id=root></div><script type=module src=/classic/assets/index-1.js></script>".to_vec()),
            "assets/index-1.js" => Some(b"export{}".to_vec()),
            "version.json" => Some(b"{}".to_vec()),
            _ => None,
        }
    }

    fn none(_: &str) -> Option<Vec<u8>> {
        None
    }

    /// Every policy a response carries, in order.
    fn csps(r: &Resp) -> Vec<&str> {
        r.headers().get_all("content-security-policy").iter().map(|v| v.to_str().unwrap()).collect()
    }

    /// Whether a page at `page` (an origin) runs the script at `url` under these policies, as a
    /// browser decides it: each policy must allow it (for the kinds of source these policies use).
    fn runs(policies: &[&str], page: &str, url: &str) -> bool {
        let at = url.match_indices('/').nth(2).map_or(url.len(), |(i, _)| i);
        let (origin, path) = url.split_at(at);
        policies.iter().all(|p| {
            let Some(sources) = p.split("; ").find_map(|d| d.strip_prefix("script-src ")) else { return true };
            sources.split(' ').any(|s| match s {
                "'self'" => origin == page,
                s => s.strip_prefix("*:*").is_some_and(|want| if want.ends_with('/') { path.starts_with(want) } else { path == want }),
            })
        })
    }

    #[test]
    fn each_app_runs_scripts_from_this_hub_only() {
        let hub = "https://hub.test:4777";
        let app = [APP_CSP, APP_ORIGIN_CSP];
        for ok in ["/assets/app-1.js", "/theme.js", "/sw.js"] {
            assert!(runs(&app, hub, &format!("{hub}{ok}")), "{ok}");
        }
        // another site's file under the same path, a page an agent wrote, the classic app's files
        for refused in [
            "https://evil.example/assets/x.js",
            "http://hub.test:4778/assets/x.js",
            "https://evil.example/theme.js",
            "https://hub.test:4777/v/tok/x.js",
            "https://hub.test:4777/classic/assets/index-1.js",
        ] {
            assert!(!runs(&app, hub, refused), "{refused}");
        }
        // the path list alone would have let another site's file in
        assert!(runs(&[APP_CSP], hub, "https://evil.example/assets/x.js"));
        let classic = [CLASSIC_CSP, CLASSIC_ORIGIN_CSP];
        assert!(runs(&classic, hub, "https://hub.test:4777/classic/assets/index-1.js"));
        for refused in ["https://evil.example/classic/assets/x.js", "https://hub.test:4777/assets/app-1.js", "https://hub.test:4777/v/tok/x.js"] {
            assert!(!runs(&classic, hub, refused), "{refused}");
        }
        // the classic page's own meta tag says the same
        assert!(include_str!("../../../apps/web/index.html").contains("script-src 'self'"));
        // only the app compiles wasm
        assert!(APP_ORIGIN_CSP.contains("'wasm-unsafe-eval'") && !CLASSIC_ORIGIN_CSP.contains("wasm") && !CLASSIC_CSP.contains("wasm"));
    }

    fn get(path: &str) -> Resp {
        let (path, query) = path.split_once('?').unwrap_or((path, ""));
        serve_from(path, query, false, built_app, built_classic)
    }

    #[test]
    fn the_app_has_the_root_and_routes_itself() {
        crate::test_util::block(async {
            // its page for every path of its own, /nextcloud included
            for path in ["/", "/m/box/p/1", "/machines", "/settings", "/nextcloud", "/classicx", "/../etc/passwd"] {
                let r = get(path);
                assert_eq!(r.status().as_u16(), 200, "{path}");
                assert_eq!(r.headers()["content-type"], "text/html;charset=utf-8");
                assert_eq!(r.headers()["cache-control"], "no-cache");
                assert_eq!(csps(&r), [APP_CSP, APP_ORIGIN_CSP]);
                assert!(body(r).await.contains("/assets/app-1.js"), "{path}");
            }
        });
    }

    #[test]
    fn the_app_serves_its_files_and_refuses_ones_it_does_not_have() {
        let r = get("/assets/app-1.js");
        assert_eq!(r.status().as_u16(), 200);
        assert_eq!(r.headers()["content-type"], "text/javascript;charset=utf-8");
        assert_eq!(r.headers()["cache-control"], "public, max-age=31536000, immutable");
        assert_eq!(get("/assets/app_bg-1.wasm").headers()["content-type"], "application/wasm");
        // the service worker is checked for updates on every visit
        assert_eq!(get("/sw.js").headers()["cache-control"], "no-cache");
        // an old build's file is a 404, never the page passed off as a script
        assert_eq!(get("/assets/app-0.js").status().as_u16(), 404);
        // the classic app's files are only under /classic
        assert_eq!(get("/assets/index-1.js").status().as_u16(), 404);
        assert_eq!(get("/version.json").headers()["content-type"], "text/html;charset=utf-8");
    }

    #[test]
    fn the_classic_app_keeps_its_screens_under_classic() {
        crate::test_util::block(async {
            for path in ["/classic", "/classic/", "/classic/m/box/p/1", "/classic/../classic/settings"] {
                let r = get(path);
                assert_eq!(r.status().as_u16(), 200, "{path}");
                assert_eq!(csps(&r), [CLASSIC_CSP, CLASSIC_ORIGIN_CSP], "{path}");
                assert!(body(r).await.contains("/classic/assets/index-1.js"), "{path}");
            }
            let r = get("/classic/assets/index-1.js");
            assert_eq!(r.headers()["cache-control"], "public, max-age=31536000, immutable");
            assert_eq!(csps(&r), [CLASSIC_CSP, CLASSIC_ORIGIN_CSP]);
            assert_eq!(get("/classic/version.json").headers()["content-type"], "application/json;charset=utf-8");
            assert_eq!(get("/classic/assets/app-1.js").status().as_u16(), 404);
            // nothing above it: the path stays inside the classic app's files
            assert!(body(get("/classic/../../etc/passwd")).await.contains("/classic/assets/"));
        });
    }

    #[test]
    fn an_address_under_next_leads_to_the_same_screen_at_the_root() {
        for (from, to) in [
            ("/next", "/"),
            ("/next/", "/"),
            ("/next/m/box%20one/p/1?view=terminal", "/m/box%20one/p/1?view=terminal"),
            ("/next/machines?add=1", "/machines?add=1"),
            // never to another site
            ("/next//evil.example/x", "/evil.example/x"),
            ("/next/\\evil.example", "/evil.example"),
        ] {
            let r = get(from);
            assert_eq!(r.status().as_u16(), 302, "{from}");
            assert_eq!(r.headers()["location"], to, "{from}");
        }
    }

    #[test]
    fn a_hub_built_without_the_app_sends_its_pages_to_the_classic_app() {
        for (from, to) in [("/", "/classic/"), ("/m/box/p/1", "/classic/m/box/p/1"), ("/machines?add=1", "/classic/machines?add=1")] {
            let r = serve_from(from.split('?').next().unwrap(), from.split_once('?').map_or("", |q| q.1), false, none, built_classic);
            assert_eq!(r.status().as_u16(), 302, "{from}");
            assert_eq!(r.headers()["location"], to, "{from}");
        }
    }

    #[test]
    fn a_hub_built_without_the_classic_app_says_so_there() {
        crate::test_util::block(async {
            // not built, or built for `/`, whose files would be asked for where the app's are
            let for_root = |name: &str| (name == "index.html").then(|| b"<script type=module src=/assets/index-1.js></script>".to_vec());
            for r in [serve_from("/classic/", "", false, built_app, none), serve_from("/classic/machines", "", false, built_app, for_root)] {
                assert_eq!(r.status().as_u16(), 503);
                assert_eq!(r.headers()["content-security-policy"], PAGE_CSP);
                assert_eq!(body(r).await, CLASSIC_MISSING);
            }
        });
    }

    #[test]
    fn the_app_may_compile_wasm_and_each_app_runs_only_its_own_scripts() {
        let scripts = |csp: &'static str| csp.split("; ").find_map(|d| d.strip_prefix("script-src ")).unwrap().split(' ').collect::<Vec<_>>();
        assert_eq!(scripts(APP_CSP), ["*:*/assets/", "*:*/theme.js", "*:*/sw.js", "'wasm-unsafe-eval'"]);
        assert_eq!(scripts(CLASSIC_CSP), ["*:*/classic/assets/", "*:*/classic/theme.js", "*:*/classic/sw.js"]);
        // the rest of each policy is the page headers'
        for csp in [APP_CSP, CLASSIC_CSP] {
            assert_eq!(csp.split("; script-src").next(), PAGE_CSP.split("; script-src").next());
        }
        // the app's page loads nothing from elsewhere, and its theme script and worker are copied next to it
        let index = include_str!("../../../apps/app/index.html");
        assert!(index.contains(r#"<script src="/theme.js">"#));
        assert!(!include_str!("../../../apps/app/Dioxus.toml").contains("base_path"));
        let build = include_str!("../../../apps/app/build.sh");
        assert!(build.contains("cp -r ../web/public/. dist/") && build.contains("bun sw.ts dist"));
        assert!(include_str!("../../../apps/web/package.json").contains("--base /classic/"));
    }

    #[test]
    fn each_app_is_carried_when_it_was_built() {
        let here = |p: &str| std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..").join(p);
        let built_app = here("apps/app/dist/index.html").exists();
        assert_eq!(app_built(), built_app);
        if built_app {
            let index = String::from_utf8(App::get("index.html").unwrap().data.into_owned()).unwrap();
            assert!(index.contains(r#"src="/assets/"#) && !index.contains("/next/"), "built for the root");
            assert!(App::get("sw.js").is_some() && App::get("theme.js").is_some());
        }
        if let Ok(index) = std::fs::read_to_string(here("apps/web/dist/index.html")) {
            assert_eq!(built(), index.contains("/classic/assets/"), "built with bun run build:hub");
        }
    }

    #[test]
    fn the_hub_gives_the_root_to_the_app_and_keeps_the_classic_app() {
        use crate::server::{dispatch, install_ctx, test_req, CtxInit};
        let (app, classic) = (app_built(), built());
        crate::test_util::block(async move {
            let ctx = CtxInit {
                data_dir: std::env::temp_dir().join(format!("inyon-apps-{}", std::process::id())),
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
            };
            install_ctx(ctx, crate::server::hub_routes());
            let get = |path: &'static str, host: &'static str| dispatch(test_req("GET", path, &[("host", host)], ""));
            for path in ["/", "/machines", "/nextcloud"] {
                let r = get(path, "hub.test:4777").await;
                assert_eq!(r.status().as_u16(), if app { 200 } else { 302 }, "{path}");
                if app {
                    assert_eq!(csps(&r), [APP_CSP, APP_ORIGIN_CSP], "{path}");
                }
            }
            let r = get("/classic/machines", "hub.test:4777").await;
            assert_eq!(r.status().as_u16(), if classic { 200 } else { 503 });
            assert_eq!(csps(&r), if classic { vec![CLASSIC_CSP, CLASSIC_ORIGIN_CSP] } else { vec![PAGE_CSP] });
            let r = get("/next/machines?add=1", "hub.test:4777").await;
            assert_eq!((r.status().as_u16(), r.headers()["location"].to_str().unwrap()), (302, "/machines?add=1"));
            // a name the hub doesn't answer to is refused before either app
            assert_eq!(get("/", "evil.example").await.status().as_u16(), 421);
            assert_eq!(get("/classic/", "evil.example").await.status().as_u16(), 421);
        });
    }

    #[test]
    fn gzip_is_taken_unless_refused() {
        assert!(takes_gzip(Some("gzip, deflate, br, zstd")));
        assert!(takes_gzip(Some("br;q=1.0, GZIP;q=0.5")));
        assert!(takes_gzip(Some("*")));
        assert!(!takes_gzip(Some("gzip;q=0, br")));
        assert!(!takes_gzip(Some("gzip;Q=0")));
        assert!(!takes_gzip(Some("gzip ; q = 0.000")));
        // its own entry wins over the wildcard, either way round
        assert!(!takes_gzip(Some("gzip;q=0, *;q=1")));
        assert!(!takes_gzip(Some("*;q=1, gzip;q=0")));
        assert!(takes_gzip(Some("*;q=0, gzip")));
        assert!(!takes_gzip(Some("*;q=0")));
        assert!(!takes_gzip(Some("identity")));
        assert!(!takes_gzip(None));
    }

    fn big_app(name: &str) -> Option<Vec<u8>> {
        match name {
            "assets/app_bg-1.wasm" => Some([0u8, 97, 115, 109].repeat(4096)),
            "assets/app-1.js" => Some(b"export const a = 1;\n".repeat(200)),
            "assets/geist.woff2" => Some(vec![7; 4096]),
            "assets/tiny.js" => Some(b"export{}".to_vec()),
            _ => built_app(name),
        }
    }

    #[test]
    fn the_new_apps_wasm_and_scripts_go_out_gzipped_to_a_browser_that_takes_it() {
        crate::test_util::block(async {
            for name in ["/assets/app_bg-1.wasm", "/assets/app-1.js"] {
                let plain = big_app(&name[1..]).unwrap();
                let r = serve_from(name, "", true, big_app, none);
                assert_eq!(r.headers()["content-encoding"], "gzip", "{name}");
                assert_eq!(r.headers()["vary"], "accept-encoding");
                assert_eq!(csps(&r), [APP_CSP, APP_ORIGIN_CSP]);
                let z = r.into_body().bytes().await.unwrap();
                assert!(z.len() < plain.len() / 3, "{name}: {} of {}", z.len(), plain.len());
                let mut out = vec![];
                std::io::Read::read_to_end(&mut flate2::read::GzDecoder::new(&z[..]), &mut out).unwrap();
                assert_eq!(out, plain, "{name}");
                // a browser that doesn't take gzip gets the file as it is, and caches know it varies
                let r = serve_from(name, "", false, big_app, none);
                assert!(r.headers().get("content-encoding").is_none());
                assert_eq!(r.headers()["vary"], "accept-encoding");
                assert_eq!(r.into_body().bytes().await.unwrap(), plain);
            }
        });
    }

    #[test]
    fn fonts_and_tiny_files_go_out_as_they_are() {
        for name in ["/assets/geist.woff2", "/assets/tiny.js"] {
            let r = serve_from(name, "", true, big_app, none);
            assert!(r.headers().get("content-encoding").is_none(), "{name}");
        }
        assert!(compressible("index.html") && compressible("a.wasm") && compressible("a.svg") && compressible("m.webmanifest"));
        assert!(!compressible("a.woff2") && !compressible("a.png") && !compressible("a.pdf") && !compressible("a.bin"));
    }

    #[test]
    fn types_are_buns() {
        assert_eq!(content_type("/assets/index-x.js"), "text/javascript;charset=utf-8");
        assert_eq!(content_type("/manifest.webmanifest"), "application/manifest+json");
        assert_eq!(content_type("index.html"), "text/html;charset=utf-8");
    }
}
