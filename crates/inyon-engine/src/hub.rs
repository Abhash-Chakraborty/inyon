//! The part of hub.ts a machine needs without the hub: which hub addresses may take its token
//! over plain http. The hub itself (`inyon hub`) still runs from the Bun engine.

use url::Url;

/// A private IPv4 address: a whole dotted quad (10.0.0.1.example.com is a name, not one) in a
/// private range.
fn private_ipv4(h: &str) -> bool {
    let parts: Vec<&str> = h.split('.').collect();
    if parts.len() != 4 || !parts.iter().all(|p| (1..=3).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_digit()) && p.parse::<u16>().is_ok_and(|n| n <= 255)) {
        return false;
    }
    let a: u16 = parts[0].parse().unwrap_or(0);
    let b: u16 = parts[1].parse().unwrap_or(0);
    if a == 10 || a == 127 {
        return true;
    }
    if a == 192 && b == 168 {
        return true;
    }
    if a == 172 && (16..=31).contains(&b) {
        return true;
    }
    // the CGNAT range Tailscale and NetBird use
    a == 100 && (64..=127).contains(&b)
}

/// Whether a hub's address is on your own network, where plain http:// is accepted for the token.
pub fn private_host(url: &Url) -> bool {
    let h = url.host_str().unwrap_or("").to_lowercase();
    // IPv6 literals: loopback, unique-local (fc00::/7, Tailscale uses fd7a:115c:a1e0::/48), link-local
    if let Some(inner) = h.strip_prefix('[') {
        let hex = |c: char| c.is_ascii_hexdigit();
        if inner.starts_with("::1") {
            return true;
        }
        let b: Vec<char> = inner.chars().collect();
        // f[cd][0-9a-f]{0,2}:
        if b.len() >= 3 && b[0] == 'f' && (b[1] == 'c' || b[1] == 'd') {
            let rest: String = b[2..].iter().take_while(|c| hex(**c)).collect();
            if rest.len() <= 2 && b.get(2 + rest.len()) == Some(&':') {
                return true;
            }
        }
        // fe[89ab][0-9a-f]?:
        if b.len() >= 4 && b[0] == 'f' && b[1] == 'e' && matches!(b[2], '8' | '9' | 'a' | 'b') {
            return b[3] == ':' || (hex(b[3]) && b.get(4) == Some(&':'));
        }
        return false;
    }
    if h == "localhost" || h == "::1" || private_ipv4(&h) {
        return true;
    }
    if [".ts.net", ".netbird.cloud", ".netbird.selfhosted", ".local", ".lan", ".internal"].iter().any(|s| h.ends_with(s)) {
        return true;
    }
    // single-label names on your private network
    !h.contains('.')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn is_private(hub: &str) -> bool {
        private_host(&Url::parse(hub).unwrap())
    }

    #[test]
    fn plain_http_is_for_private_addresses() {
        for h in [
            "localhost",
            "127.0.0.1",
            "10.0.0.1",
            "192.168.1.20",
            "172.16.0.1",
            "172.31.255.255",
            "100.64.0.1",
            "100.127.255.255",
            "[::1]",
            "[fd7a:115c:a1e0::1]",
            "[fe80::1]",
            "hub.ts.net",
            "hub.local",
            "hub.lan",
            "hub.internal",
            "hub",
        ] {
            assert!(is_private(&format!("http://{h}:4777")), "{h}");
        }
    }

    #[test]
    fn a_public_address_or_a_lookalike_name_is_not() {
        for h in ["example.com", "8.8.8.8", "172.32.0.1", "100.128.0.1", "10.0.0.1.attacker.com", "192.168.1.20.example.net", "127.0.0.1.nip.io", "[2001:db8::1]"] {
            assert!(!is_private(&format!("http://{h}:4777")), "{h}");
        }
    }
}
