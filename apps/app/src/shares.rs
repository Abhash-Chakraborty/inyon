//! Shared links to a blueprint (lib/shares.ts): a link for someone outside the app, on the hub's own
//! address for people on your network, or on a public address of its own for anyone with the link.
//! The words the Share sheet and Settings › Blueprints show, and the setup of that public address:
//! the name, its DNS record, a proxy's config and what a check of it found. The hub's side is in
//! crates/inyon-hub/src/shares.rs.

use serde::Deserialize;

/// A shared link to a blueprint, as the hub lists it (never the link itself, which it keeps only
/// hashed).
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct ShareLink {
    pub id: String,
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub slug: String,
    /// anyone with the link, on the public share address; else people on your network
    #[serde(default)]
    pub public: bool,
    #[serde(default)]
    pub created: f64,
    #[serde(default)]
    pub expires: f64,
    #[serde(default)]
    pub opens: u64,
}

/// The hub's shared links and its public address for them, also when parts are missing.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareList {
    /// the public address for shared links, such as https://share.example.com
    #[serde(default)]
    pub address: Option<String>,
    /// set by INYON_SHARE_ORIGIN on the hub, so Settings can't change it
    #[serde(default)]
    pub from_env: bool,
    /// where a proxy on the hub's machine reaches it, such as 127.0.0.1:4777 (from 0.25.5)
    #[serde(default)]
    pub upstream: Option<String>,
    #[serde(default)]
    pub links: Vec<ShareLink>,
}

/// A new shared link: `url` is shown this once (a path on the hub for your network, a full address
/// for anyone).
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct MadeLink {
    #[serde(flatten)]
    pub link: ShareLink,
    pub url: String,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct DnsCheck {
    #[serde(default)]
    pub ok: bool,
    #[serde(default)]
    pub addresses: Vec<String>,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct ReachCheck {
    #[serde(default)]
    pub ok: bool,
    /// dns, tls, refused, timeout, not-hub or other
    #[serde(default)]
    pub fault: Option<String>,
    #[serde(default)]
    pub status: Option<u16>,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct OpenPath {
    pub path: String,
    #[serde(default)]
    pub status: u16,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct WallCheck {
    #[serde(default)]
    pub ok: bool,
    /// the paths that answered
    #[serde(default)]
    pub open: Vec<OpenPath>,
    /// those that didn't answer at all
    #[serde(default)]
    pub unsure: Vec<String>,
}

/// What the hub found checking its public address for shared links (from 0.25.5): the name looked
/// up, a request there reaching this hub, and nothing but /share/ answering there.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct ShareCheck {
    #[serde(default)]
    pub address: String,
    #[serde(default)]
    pub dns: DnsCheck,
    #[serde(default)]
    pub reach: ReachCheck,
    #[serde(default)]
    pub wall: WallCheck,
}

impl ShareCheck {
    /// Links reach this hub and nothing else answers there.
    pub fn passed(&self) -> bool {
        self.reach.ok && self.wall.ok
    }
}

/// A hub from before shared links answers their routes with a bare "Not found".
pub fn share_error(message: &str) -> String {
    if message == "Not found" {
        "This hub can't share blueprints yet. Update it first.".into()
    } else {
        message.into()
    }
}

/// How long a shared link may last, as the Share sheet offers it.
pub const SHARE_DAYS: [(&str, &str); 3] = [("1", "1 day"), ("7", "7 days"), ("30", "30 days")];

/// The link to hand out: a link for your network is a path on the page's hub, put after the address
/// this app reached it at (`origin`).
pub fn share_url(origin: &str, url: &str) -> String {
    if url.starts_with('/') {
        format!("{origin}{url}")
    } else {
        url.to_string()
    }
}

/// "in 6 days", "in 5 h", "in 12 min", or "now" once it ran out.
pub fn expires_in(expires: f64, now: f64) -> String {
    let m = ((expires - now) / 60_000.0).floor();
    if m < 1.0 {
        return "now".into();
    }
    if m < 60.0 {
        return format!("in {m} min");
    }
    let h = (m / 60.0).floor();
    if h < 48.0 {
        return format!("in {h} h");
    }
    format!("in {} days", (h / 24.0).round())
}

/// Who a link is for, in a few words.
pub fn audience(public: bool) -> &'static str {
    if public {
        "Anyone with the link"
    } else {
        "Your network"
    }
}

/// A link's line under its audience: when it ends, how often it was opened and when it was made
/// (`tz` minutes east of UTC).
pub fn share_meta(s: &ShareLink, now: f64, tz: i32) -> String {
    let made = inyon_chat_core::js::local_time(s.created, tz).month_day();
    let opens = if s.opens == 1 { "1 open".to_string() } else { format!("{} opens", s.opens) };
    format!("ends {} · {opens} · made {made}", expires_in(s.expires, now))
}

// ---------- setting up the public address ----------

/// The host name someone typed, as an address: `share.example.com` → `https://share.example.com`.
pub fn address_of(input: &str) -> String {
    let t = input.trim().trim_end_matches('/');
    if t.is_empty() {
        return String::new();
    }
    if has_scheme(t) {
        t.to_string()
    } else {
        format!("https://{t}")
    }
}

/// `^[a-z]+://`, any case.
fn has_scheme(s: &str) -> bool {
    match s.find("://") {
        Some(i) => i > 0 && s[..i].bytes().all(|b| b.is_ascii_alphabetic()),
        None => false,
    }
}

/// An address cut into its scheme (lowercase), host and port, as a browser's URL reads them; None
/// when it isn't one.
fn parse(address: &str) -> Option<(String, String, Option<String>)> {
    let (scheme, rest) = address.split_once("://")?;
    if scheme.is_empty() || !scheme.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'-' || b == b'.') {
        return None;
    }
    let end = rest.find(['/', '?', '#', '\\']).unwrap_or(rest.len());
    let auth = &rest[..end];
    let auth = auth.rsplit_once('@').map_or(auth, |(_, h)| h);
    let (host, port) = if let Some(v6) = auth.strip_prefix('[') {
        let (inner, after) = v6.split_once(']')?;
        (format!("[{inner}]"), after.strip_prefix(':').map(str::to_string))
    } else {
        match auth.rsplit_once(':') {
            Some((h, p)) => (h.to_string(), Some(p.to_string())),
            None => (auth.to_string(), None),
        }
    };
    if host.is_empty() || host.chars().any(|c| c.is_whitespace() || matches!(c, '<' | '>' | '^' | '|' | '%')) {
        return None;
    }
    if port.as_deref().is_some_and(|p| !p.bytes().all(|b| b.is_ascii_digit())) {
        return None;
    }
    let scheme = scheme.to_ascii_lowercase();
    // the usual port for the scheme is no port at all
    let port = port.filter(|p| !p.is_empty() && !matches!((scheme.as_str(), p.as_str()), ("https", "443") | ("http", "80")));
    Some((scheme, host, port))
}

/// The host name in an address, lowercase, without a port or a trailing root dot.
pub fn name_of(address: &str) -> String {
    parse(&address_of(address)).map(|(_, h, _)| h.to_lowercase().trim_end_matches('.').to_string()).unwrap_or_default()
}

/// The second-level names a country uses under its code (example.co.uk is a main domain).
const SECOND_LEVEL: [&str; 10] = ["co", "com", "net", "org", "gov", "ac", "edu", "ne", "or", "go"];

/// The main domain a name sits under: share.example.co.uk → example.co.uk.
pub fn main_domain_of(name: &str) -> String {
    let parts: Vec<&str> = name.split('.').filter(|p| !p.is_empty()).collect();
    if parts.len() < 2 {
        return name.to_string();
    }
    let n = parts.len();
    let take = if n >= 3 && parts[n - 1].len() == 2 && SECOND_LEVEL.contains(&parts[n - 2]) { 3 } else { 2 };
    parts[n - take..].join(".")
}

/// What the setup sheet starts with for a saved address: the bare name for https on the usual port,
/// else all of it.
pub fn field_of(address: &str) -> String {
    match parse(address) {
        Some((scheme, _, None)) if scheme == "https" => name_of(address),
        _ => address.to_string(),
    }
}

/// A name a certificate can be made out to: dot-separated labels of letters, digits and inner
/// hyphens.
pub fn valid_name(name: &str) -> bool {
    let label = |l: &str| {
        let b = l.as_bytes();
        let ok = |c: &u8| c.is_ascii_lowercase() || c.is_ascii_digit();
        (1..=63).contains(&b.len()) && ok(&b[0]) && ok(&b[b.len() - 1]) && b.iter().all(|c| ok(c) || *c == b'-')
    };
    let labels: Vec<&str> = name.split('.').collect();
    labels.len() >= 2 && labels.iter().all(|l| label(l))
}

fn is_ipv4(name: &str) -> bool {
    let parts: Vec<&str> = name.split('.').collect();
    parts.len() == 4 && parts.iter().all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
}

/// Why a name isn't a good one for shared links, or "" when it is: a subdomain kept for this.
/// `app_name` is the name this app was opened at.
pub fn name_advice(name: &str, app_name: &str) -> String {
    if name.is_empty() {
        return String::new();
    }
    if is_ipv4(name) || name.contains(':') {
        return "Use a name, not an IP address: links need a certificate made out to a name.".into();
    }
    if !name.contains('.') {
        return "Use a full name, such as share.example.com.".into();
    }
    if !valid_name(name) {
        return "Use letters, digits and hyphens between the dots, such as share.example.com.".into();
    }
    if name == app_name.to_lowercase() {
        return "That's the address you open Inyon at. Shared links need a name of their own.".into();
    }
    if main_domain_of(name) == name {
        return format!("That's a main domain. Use a subdomain you keep for this, such as share.{name}, so nothing else on {name} changes.");
    }
    String::new()
}

/// The DNS record to add for a name: its label under the main domain, an A record to the proxy's IP.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DnsRecord {
    pub kind: &'static str,
    pub name: String,
    pub zone: String,
}

pub fn dns_record(name: &str) -> DnsRecord {
    let main = main_domain_of(name);
    let label = if name == main { "@".to_string() } else { name[..name.len().saturating_sub(main.len() + 1)].to_string() };
    DnsRecord { kind: "A", name: label, zone: main }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Proxy {
    Caddy,
    Traefik,
    Nginx,
}

impl Proxy {
    pub const ALL: [Proxy; 3] = [Proxy::Caddy, Proxy::Traefik, Proxy::Nginx];

    pub fn key(self) -> &'static str {
        match self {
            Proxy::Caddy => "caddy",
            Proxy::Traefik => "traefik",
            Proxy::Nginx => "nginx",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Proxy::Caddy => "Caddy",
            Proxy::Traefik => "Traefik",
            Proxy::Nginx => "nginx",
        }
    }

    pub fn of(key: &str) -> Proxy {
        Proxy::ALL.into_iter().find(|p| p.key() == key).unwrap_or(Proxy::Caddy)
    }
}

/// Where a proxy on the hub's machine reaches it, when the hub doesn't say.
pub const UPSTREAM: &str = "127.0.0.1:4777";

/// A proxy's config that forwards only /share/ on `name` to the hub at `upstream`, keeping the Host
/// header.
pub fn proxy_config(kind: Proxy, name: &str, upstream: &str) -> String {
    match kind {
        Proxy::Caddy => format!("{name} {{\n\thandle /share/* {{\n\t\treverse_proxy {upstream}\n\t}}\n\thandle {{\n\t\trespond 404\n\t}}\n}}\n"),
        Proxy::Traefik => [
            "http:".to_string(),
            "  routers:".into(),
            "    inyon-share:".into(),
            format!("      rule: \"Host(`{name}`) && PathPrefix(`/share/`)\""),
            "      entryPoints: [websecure]".into(),
            "      middlewares: [inyon-share-rate]".into(),
            "      service: inyon-share".into(),
            "      tls:".into(),
            "        certResolver: letsencrypt".into(),
            "  middlewares:".into(),
            "    inyon-share-rate:".into(),
            "      rateLimit:".into(),
            "        average: 20".into(),
            "        burst: 40".into(),
            "  services:".into(),
            "    inyon-share:".into(),
            "      loadBalancer:".into(),
            "        passHostHeader: true".into(),
            "        servers:".into(),
            format!("          - url: \"http://{upstream}\""),
            String::new(),
        ]
        .join("\n"),
        Proxy::Nginx => [
            "server {".to_string(),
            "    listen 443 ssl;".into(),
            format!("    server_name {name};"),
            format!("    ssl_certificate     /etc/letsencrypt/live/{name}/fullchain.pem;"),
            format!("    ssl_certificate_key /etc/letsencrypt/live/{name}/privkey.pem;"),
            String::new(),
            "    location /share/ {".into(),
            format!("        proxy_pass http://{upstream};"),
            "        proxy_set_header Host $host;".into(),
            "        proxy_set_header X-Forwarded-Proto $scheme;".into(),
            "    }".into(),
            String::new(),
            "    location / {".into(),
            "        return 404;".into(),
            "    }".into(),
            "}".into(),
            String::new(),
        ]
        .join("\n"),
    }
}

/// A line of a check's result: done, or what to fix.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckLine {
    pub ok: bool,
    pub title: String,
    pub body: Option<String>,
}

fn line(ok: bool, title: impl Into<String>, body: Option<&str>) -> CheckLine {
    CheckLine { ok, title: title.into(), body: body.map(str::to_string) }
}

/// A check's result as lines for the setup: the name, reaching this hub, and nothing else answering,
/// stopping at the first thing that failed.
pub fn check_lines(c: &ShareCheck) -> Vec<CheckLine> {
    let name = name_of(&c.address);
    let dns = if c.dns.ok {
        line(true, format!("{name} points at {}", c.dns.addresses.join(", ")), None)
    } else {
        line(false, format!("{name} doesn't point anywhere yet"), Some("Add the DNS record. A new record can take a few minutes to show up."))
    };
    if !c.dns.ok {
        return vec![dns];
    }
    let r = &c.reach;
    let reach = if r.ok {
        line(true, "Links reach this hub", Some("The name, its certificate and the proxy all lead here."))
    } else {
        match r.fault.as_deref() {
            Some("tls") => line(
                false,
                format!("The certificate for {name} isn't valid"),
                Some("Your proxy gets one once the name points at it. Behind Cloudflare, set the record to DNS only, or use Full (strict) SSL."),
            ),
            Some("refused" | "timeout") => line(false, format!("Nothing answers at {name}"), Some("Check the proxy is running and that ports 80 and 443 are open on its machine.")),
            Some("not-hub") => {
                let status = r.status.map(|s| s.to_string()).unwrap_or_default();
                line(
                    false,
                    format!("{name} answered {status}, but not from this hub").replacen("  ", " ", 1),
                    Some("Forward /share/ to the hub and keep the Host header, as in the example above."),
                )
            }
            _ => line(false, format!("Couldn't reach {name}"), r.error.as_deref()),
        }
    };
    if !r.ok {
        return vec![dns, reach];
    }
    let w = &c.wall;
    let wall = if w.ok {
        line(true, "Nothing else answers there", Some("Only /share/ links get through: / and /api/session are a 404."))
    } else if w.open.is_empty() && !w.unsure.is_empty() {
        let s = if w.unsure.len() == 1 { "s" } else { "" };
        line(false, format!("Couldn't tell whether {} stay{s} closed", w.unsure.join(" and ")), Some("They didn't answer in time. Run Check again."))
    } else {
        let paths: Vec<&str> = w.open.iter().map(|o| o.path.as_str()).collect();
        let s = if w.open.len() == 1 { "s" } else { "" };
        line(
            false,
            format!("{} answer{s} there too", paths.join(" and ")),
            Some("Forward only /share/ to the hub. The hub still refuses the rest on that name, but keep both walls."),
        )
    };
    vec![dns, reach, wall]
}

/// The status under "Address for shared links" in Settings.
pub fn address_status(list: &ShareList, check: Option<&ShareCheck>) -> &'static str {
    match (list.address.as_deref(), check) {
        (None, _) => "Off. Links stay on your network until you set one up.",
        (Some(_), None) => "Links for anyone open here.",
        (Some(_), Some(c)) if c.passed() => "Checked: links reach this hub.",
        _ => "The last check found something to fix.",
    }
}

/// The host part of an address, for "Opens at share.example.com" (with its port, as a URL's host).
pub fn host_of(address: &str) -> String {
    match parse(address) {
        Some((_, h, Some(p))) => format!("{h}:{p}"),
        Some((_, h, None)) => h,
        None => address.to_string(),
    }
}

/// The confirm before Revoke all: the one link, or all of them.
pub fn revoke_all_title(n: usize) -> String {
    if n == 1 {
        "Revoke the shared link?".into()
    } else {
        format!("Revoke all {n} shared links?")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // 5 Nov 2026, 12:00 UTC
    const NOW: f64 = 1_793_880_000_000.0;
    const MIN: f64 = 60_000.0;

    fn check(dns: bool, reach: ReachCheck, wall: WallCheck) -> ShareCheck {
        ShareCheck {
            address: "https://share.example.com".into(),
            dns: DnsCheck { ok: dns, addresses: if dns { vec!["203.0.113.4".into()] } else { vec![] }, error: None },
            reach,
            wall,
        }
    }

    fn reached() -> ReachCheck {
        ReachCheck { ok: true, ..ReachCheck::default() }
    }

    fn fault(f: &str) -> ReachCheck {
        ReachCheck { fault: Some(f.into()), ..ReachCheck::default() }
    }

    fn closed() -> WallCheck {
        WallCheck { ok: true, ..WallCheck::default() }
    }

    #[test]
    fn when_a_link_ends() {
        assert_eq!(expires_in(NOW + 12.0 * MIN, NOW), "in 12 min");
        assert_eq!(expires_in(NOW + 5.0 * 60.0 * MIN, NOW), "in 5 h");
        assert_eq!(expires_in(NOW + 47.0 * 60.0 * MIN, NOW), "in 47 h");
        assert_eq!(expires_in(NOW + 7.0 * 24.0 * 60.0 * MIN, NOW), "in 7 days");
        assert_eq!(expires_in(NOW + 7.0 * 24.0 * 60.0 * MIN - 5.0 * MIN, NOW), "in 7 days");
        assert_eq!(expires_in(NOW - MIN, NOW), "now");
    }

    #[test]
    fn who_it_is_for_and_its_line_end_opens_and_when_it_was_made() {
        let s = ShareLink {
            id: "a1".into(),
            host: "local".into(),
            slug: "plan".into(),
            public: false,
            created: NOW - 24.0 * 60.0 * MIN,
            expires: NOW + 6.0 * 24.0 * 60.0 * MIN,
            opens: 1,
        };
        assert_eq!(audience(s.public), "Your network");
        assert_eq!(audience(true), "Anyone with the link");
        assert_eq!(share_meta(&s, NOW, 0), "ends in 6 days · 1 open · made Nov 4");
        assert!(share_meta(&ShareLink { opens: 3, ..s }, NOW, 0).contains("3 opens"));
    }

    #[test]
    fn a_network_link_goes_after_the_address_the_app_reached_the_hub_at() {
        assert_eq!(share_url("https://hub.test:4777", "/share/abc/"), "https://hub.test:4777/share/abc/");
        // a link for anyone is kept as the hub gave it
        assert_eq!(share_url("https://hub.test:4777", "https://share.example.com/share/abc/"), "https://share.example.com/share/abc/");
    }

    #[test]
    fn an_old_hub_says_so() {
        assert_eq!(share_error("Not found"), "This hub can't share blueprints yet. Update it first.");
        assert_eq!(share_error("The disk is full"), "The disk is full");
    }

    #[test]
    fn a_typed_name_becomes_an_address_and_back() {
        assert_eq!(address_of(" share.example.com/ "), "https://share.example.com");
        assert_eq!(address_of("http://10.0.0.5:8080"), "http://10.0.0.5:8080");
        assert_eq!(address_of(""), "");
        assert_eq!(name_of("https://Share.Example.com:8443"), "share.example.com");
        assert_eq!(name_of("share.example.com"), "share.example.com");
        assert_eq!(name_of("share.example.com."), "share.example.com");
        assert_eq!(name_of("hub.example:4777"), "hub.example");
        assert_eq!(name_of("not a name"), "");
    }

    #[test]
    fn the_sheet_starts_with_the_saved_address_keeping_a_scheme_or_port_the_bare_name_would_lose() {
        assert_eq!(field_of("https://share.example.com"), "share.example.com");
        assert_eq!(field_of("http://share.example.com"), "http://share.example.com");
        assert_eq!(field_of("https://share.example.com:8443"), "https://share.example.com:8443");
        assert_eq!(address_of(&field_of("http://share.example.com")), "http://share.example.com");
    }

    #[test]
    fn only_a_name_a_certificate_can_be_made_out_to_is_saved() {
        assert!(valid_name("share.example.com"));
        assert!(valid_name("xn--bcher-kva.example"));
        for bad in ["share..example.com", "share{.example.com", "-share.example.com", "share-.example.com", "share", "a_b.example.com"] {
            assert!(!valid_name(bad), "{bad}");
        }
        assert!(name_advice("share..example.com", "hub.example.com").contains("letters, digits and hyphens"));
        assert!(name_advice("share{.example.com", "hub.example.com").contains("letters, digits and hyphens"));
        // what the field reads such a name as
        assert_eq!(name_of("share{.example.com"), "share{.example.com");
    }

    #[test]
    fn a_subdomain_is_recommended_over_a_main_domain_an_ip_or_the_apps_own_address() {
        assert_eq!(main_domain_of("share.example.com"), "example.com");
        assert_eq!(main_domain_of("share.example.co.uk"), "example.co.uk");
        assert_eq!(name_advice("share.example.com", "hub.example.com"), "");
        let main = name_advice("example.com", "hub.example.com");
        assert!(main.contains("main domain") && main.contains("share.example.com"), "{main}");
        assert!(name_advice("example.co.uk", "hub.example.com").contains("main domain"));
        assert!(name_advice("hub.example.com", "Hub.example.com").contains("address you open Inyon at"));
        assert!(name_advice("203.0.113.4", "hub.example.com").contains("not an IP"));
        assert!(name_advice("share", "hub.example.com").contains("full name"));
        assert_eq!(name_advice("", "hub.example.com"), "");
    }

    #[test]
    fn the_dns_record_is_the_label_under_the_main_domain() {
        assert_eq!(dns_record("share.example.com"), DnsRecord { kind: "A", name: "share".into(), zone: "example.com".into() });
        assert_eq!(dns_record("plans.team.example.co.uk"), DnsRecord { kind: "A", name: "plans.team".into(), zone: "example.co.uk".into() });
        assert_eq!(dns_record("example.com").name, "@");
    }

    #[test]
    fn every_proxy_example_forwards_only_share_to_the_hub_and_nginx_keeps_the_host_header() {
        for k in Proxy::ALL {
            let c = proxy_config(k, "share.example.com", "127.0.0.1:4777");
            assert!(c.contains("share.example.com") && c.contains("127.0.0.1:4777") && c.contains("/share/"), "{}", k.key());
            assert_eq!(Proxy::of(k.key()), k);
        }
        assert_eq!(
            proxy_config(Proxy::Caddy, "share.example.com", UPSTREAM),
            "share.example.com {\n\thandle /share/* {\n\t\treverse_proxy 127.0.0.1:4777\n\t}\n\thandle {\n\t\trespond 404\n\t}\n}\n"
        );
        assert!(proxy_config(Proxy::Traefik, "share.example.com", UPSTREAM).contains("Host(`share.example.com`) && PathPrefix(`/share/`)"));
        assert!(proxy_config(Proxy::Traefik, "share.example.com", UPSTREAM).ends_with("- url: \"http://127.0.0.1:4777\"\n"));
        assert!(proxy_config(Proxy::Nginx, "share.example.com", UPSTREAM).contains("proxy_set_header Host $host;"));
        assert!(proxy_config(Proxy::Nginx, "share.example.com", UPSTREAM).contains("return 404;"));
    }

    #[test]
    fn a_check_reads_as_lines_stopping_at_the_first_thing_that_failed() {
        let base = check(true, reached(), closed());
        assert_eq!(check_lines(&base).iter().map(|l| l.ok).collect::<Vec<_>>(), [true, true, true]);
        assert_eq!(check_lines(&base)[0].title, "share.example.com points at 203.0.113.4");
        assert!(base.passed());
        let no_dns = check_lines(&check(false, fault("dns"), WallCheck::default()));
        assert_eq!(no_dns.len(), 1);
        assert!(no_dns[0].title.contains("doesn't point anywhere"));
        assert!(check_lines(&check(true, fault("tls"), closed()))[1].body.as_deref().unwrap().contains("DNS only"));
        let not_hub = ReachCheck { status: Some(421), ..fault("not-hub") };
        assert_eq!(check_lines(&check(true, not_hub, closed()))[1].title, "share.example.com answered 421, but not from this hub");
        assert!(check_lines(&check(true, fault("refused"), closed()))[1].title.starts_with("Nothing answers"));
        let other = ReachCheck { error: Some("boom".into()), ..fault("other") };
        assert_eq!(check_lines(&check(true, other, closed()))[1], CheckLine { ok: false, title: "Couldn't reach share.example.com".into(), body: Some("boom".into()) });
        let open = check_lines(&check(true, reached(), WallCheck { ok: false, open: vec![OpenPath { path: "/".into(), status: 200 }], unsure: vec![] }));
        assert_eq!((open[2].ok, open[2].title.as_str()), (false, "/ answers there too"));
        // a path that didn't answer at all proves nothing
        let unsure = check_lines(&check(true, reached(), WallCheck { ok: false, open: vec![], unsure: vec!["/api/session".into()] }));
        assert_eq!((unsure[2].ok, unsure[2].title.as_str()), (false, "Couldn't tell whether /api/session stays closed"));
        let two = check_lines(&check(true, reached(), WallCheck { ok: false, open: vec![], unsure: vec!["/".into(), "/api/session".into()] }));
        assert_eq!(two[2].title, "Couldn't tell whether / and /api/session stay closed");
    }

    #[test]
    fn the_hubs_answers_read_with_or_without_the_newer_fields() {
        let l: ShareList = serde_json::from_str(r#"{"address":null,"fromEnv":false,"links":[]}"#).unwrap();
        assert_eq!(l, ShareList::default());
        let l: ShareList = serde_json::from_str(r#"{"address":"https://s.example.com","fromEnv":true,"upstream":"127.0.0.1:4777","links":[{"id":"a","host":"local","slug":"p","public":true,"created":1,"expires":2,"opens":0}]}"#).unwrap();
        assert!(l.from_env && l.links[0].public && l.upstream.as_deref() == Some("127.0.0.1:4777"));
        let m: MadeLink = serde_json::from_str(r#"{"id":"a","host":"local","slug":"p","public":false,"created":1,"expires":2,"opens":0,"url":"/share/t/"}"#).unwrap();
        assert_eq!((m.link.id.as_str(), m.url.as_str()), ("a", "/share/t/"));
        let c: ShareCheck = serde_json::from_str(r#"{"address":"https://s.example.com","dns":{"ok":true,"addresses":["1.2.3.4"]},"reach":{"ok":false,"fault":"not-hub","status":421},"wall":{"ok":false,"open":[],"unsure":[]}}"#).unwrap();
        assert_eq!(c.reach.status, Some(421));
    }

    #[test]
    fn settings_says_where_the_address_stands() {
        let off = ShareList::default();
        assert_eq!(address_status(&off, None), "Off. Links stay on your network until you set one up.");
        let on = ShareList { address: Some("https://share.example.com".into()), ..ShareList::default() };
        assert_eq!(address_status(&on, None), "Links for anyone open here.");
        assert_eq!(address_status(&on, Some(&check(true, reached(), closed()))), "Checked: links reach this hub.");
        assert_eq!(address_status(&on, Some(&check(true, fault("tls"), closed()))), "The last check found something to fix.");
        assert_eq!(host_of("https://share.example.com"), "share.example.com");
        assert_eq!(host_of("https://share.example.com:8443"), "share.example.com:8443");
        assert_eq!(revoke_all_title(1), "Revoke the shared link?");
        assert_eq!(revoke_all_title(3), "Revoke all 3 shared links?");
    }
}
