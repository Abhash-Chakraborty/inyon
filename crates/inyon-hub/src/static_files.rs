//! The web app, built (apps/web/dist) and carried inside the program, served the way index.ts
//! serves it: the file asked for, or index.html for any other path (the app routes itself), with
//! the page headers on both.

use crate::http::Body;
use axum::http::{header, HeaderValue, Response, StatusCode};
use rust_embed::RustEmbed;

use crate::http::{set_header, text, Resp};

/// Built with `bun run build` before the program; a build without it says so on every page. The
/// phone core's wasm stays out: only the phone app and the browser copy run it, from their own
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

fn file(name: &str, data: Vec<u8>, cache: &'static str) -> Resp {
    let mut r = Response::new(Body::from(data));
    r.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type(name)));
    r.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
    page_headers(&mut r);
    r
}

/// Whether the web app was built into this program.
pub fn built() -> bool {
    Web::get("index.html").is_some()
}

pub fn serve(path: &str) -> Resp {
    let rel = normalize(path);
    if rel != "/" {
        if let Some(f) = Web::get(&rel[1..]) {
            let immutable = rel.starts_with("/assets/");
            return file(&rel, f.data.into_owned(), if immutable { "public, max-age=31536000, immutable" } else { "no-cache" });
        }
    }
    match Web::get("index.html") {
        Some(f) => file("index.html", f.data.into_owned(), "no-cache"),
        None => {
            let mut r = text(503, "Web app not built. Run `bun run build`.");
            *r.status_mut() = StatusCode::SERVICE_UNAVAILABLE;
            r
        }
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

    #[test]
    fn types_are_buns() {
        assert_eq!(content_type("/assets/index-x.js"), "text/javascript;charset=utf-8");
        assert_eq!(content_type("/manifest.webmanifest"), "application/manifest+json");
        assert_eq!(content_type("index.html"), "text/html;charset=utf-8");
    }
}
