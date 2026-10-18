//! The private networks this machine is on: Tailscale (or a Headscale server), NetBird, ZeroTier
//! and plain WireGuard. Their addresses only reach devices on the same network, which the network
//! itself lets in and encrypts, so the phone link answers on them. The Tailscale and NetBird
//! programs are asked first; anything else is recognised by its network interface. (The hub's
//! networks.ts, which the Bun engine's link used.)

use std::process::Stdio;
use std::time::Duration;

use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NetKind {
    Tailscale,
    Headscale,
    Netbird,
    Zerotier,
    Wireguard,
}

impl NetKind {
    pub fn label(self) -> &'static str {
        match self {
            NetKind::Tailscale => "Tailscale",
            NetKind::Headscale => "Headscale",
            NetKind::Netbird => "NetBird",
            NetKind::Zerotier => "ZeroTier",
            NetKind::Wireguard => "WireGuard",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Network {
    pub kind: NetKind,
    /// this machine's IPv4 address on the network
    pub ip: String,
    /// this machine's name on the network, like `laptop.tail1234.ts.net`
    pub name: Option<String>,
}

fn ipv4(s: &str) -> Option<String> {
    let s = match s.rfind('/') {
        Some(i) if s[i + 1..].bytes().all(|b| b.is_ascii_digit()) && i + 1 < s.len() => &s[..i],
        _ => s,
    };
    let parts: Vec<&str> = s.split('.').collect();
    (parts.len() == 4 && parts.iter().all(|p| (1..=3).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_digit()))).then(|| s.to_string())
}

fn trim_dot(s: Option<&str>) -> Option<String> {
    let t = s.unwrap_or("").trim_end_matches('.').to_lowercase();
    (!t.is_empty()).then_some(t)
}

/// `tailscale status --json`, when it's logged in and running.
pub fn from_tailscale(status: &Value) -> Option<Network> {
    if status.get("BackendState")?.as_str()? != "Running" {
        return None;
    }
    let ips = status.pointer("/Self/TailscaleIPs").or_else(|| status.get("TailscaleIPs")).and_then(Value::as_array)?;
    let ip = ips.iter().filter_map(Value::as_str).find_map(ipv4)?;
    let name = trim_dot(status.pointer("/Self/DNSName").and_then(Value::as_str));
    let suffix = trim_dot(status.pointer("/CurrentTailnet/MagicDNSSuffix").or_else(|| status.get("MagicDNSSuffix")).and_then(Value::as_str));
    // Tailscale's own servers hand out names under ts.net; any other suffix is a Headscale server
    let kind = if suffix.as_deref().is_some_and(|s| !s.ends_with("ts.net")) { NetKind::Headscale } else { NetKind::Tailscale };
    Some(Network { kind, ip, name })
}

/// `netbird status --json`, when it's connected.
pub fn from_netbird(status: &Value) -> Option<Network> {
    if status.pointer("/management/connected").and_then(Value::as_bool) == Some(false) {
        return None;
    }
    let ip = ipv4(status.get("netbirdIp")?.as_str()?)?;
    Some(Network { kind: NetKind::Netbird, ip, name: trim_dot(status.get("fqdn").and_then(Value::as_str)) })
}

/// The kind of network an interface belongs to, by the name each gives its own on Linux, macOS
/// and Windows.
pub fn kind_of(iface: &str) -> Option<NetKind> {
    let l = iface.to_lowercase();
    let digits = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
    if (l.starts_with("tailscale") && digits(&l["tailscale".len()..])) || iface == "Tailscale" {
        Some(NetKind::Tailscale)
    } else if (l.starts_with("wt") && l.len() > 2 && digits(&l[2..])) || l.starts_with("netbird") {
        Some(NetKind::Netbird)
    } else if l.starts_with("zt") || (l.starts_with("feth") && l[4..].starts_with(|c: char| c.is_ascii_digit())) || l.starts_with("zerotier") {
        Some(NetKind::Zerotier)
    } else if (l.starts_with("wg") && digits(&l[2..])) || l.starts_with("wg-") || l.contains("wireguard") {
        Some(NetKind::Wireguard)
    } else {
        None
    }
}

/// One address of a network interface: its name, IPv4 address and whether it's the loopback.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Iface {
    pub name: String,
    pub ip: String,
    pub internal: bool,
}

/// The IPv4 addresses of this machine's interfaces, as `os.networkInterfaces()` lists them.
pub fn interfaces() -> Vec<Iface> {
    if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|i| match i.addr {
            // on Windows if-addrs names an adapter by its friendly name ("Tailscale", "Ethernet"), as Node does
            if_addrs::IfAddr::V4(ref a) => Some(Iface { name: i.name.clone(), ip: a.ip.to_string(), internal: a.ip.is_loopback() }),
            _ => None,
        })
        .collect()
}

/// The networks the interface list shows, for whatever the programs didn't report.
pub fn from_interfaces(ifaces: &[Iface]) -> Vec<Network> {
    let mut found: Vec<Network> = Vec::new();
    let mut seen: Vec<&str> = Vec::new();
    for i in ifaces {
        // Node groups addresses by interface, and the first non-internal IPv4 of each counts
        if seen.contains(&i.name.as_str()) || i.internal {
            continue;
        }
        if let Some(kind) = kind_of(&i.name) {
            seen.push(&i.name);
            found.push(Network { kind, ip: i.ip.clone(), name: None });
        }
    }
    found
}

/// Runs a program and parses what it prints as JSON; None if it's missing, slow or fails.
async fn json_of(cmd: &[&str]) -> Option<Value> {
    let mut c = tokio::process::Command::new(cmd[0]);
    c.args(&cmd[1..]).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
    crate::ops::hide_window(&mut c);
    let out = tokio::time::timeout(Duration::from_secs(3), c.output()).await.ok()?.ok()?;
    if !out.status.success() {
        return None;
    }
    serde_json::from_slice(&out.stdout).ok()
}

/// Every private network this machine is on, one entry per address.
pub async fn detect_networks() -> Vec<Network> {
    // the macOS app keeps its command line inside the bundle
    let tailscale = async {
        for bin in ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"] {
            if let Some(s) = json_of(&[bin, "status", "--json"]).await {
                return Some(s);
            }
        }
        None
    };
    let (ts, nb) = tokio::join!(tailscale, json_of(&["netbird", "status", "--json"]));
    let mut nets = Vec::new();
    if let Some(n) = ts.as_ref().and_then(from_tailscale) {
        nets.push(n);
    }
    if let Some(n) = nb.as_ref().and_then(from_netbird) {
        nets.push(n);
    }
    for n in from_interfaces(&interfaces()) {
        if !nets.iter().any(|m: &Network| m.ip == n.ip) {
            nets.push(n);
        }
    }
    nets
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn tailscale_and_headscale_by_their_dns_suffix() {
        let ts = json!({ "BackendState": "Running", "Self": { "TailscaleIPs": ["fd7a:115c:a1e0::1", "100.101.102.103"], "DNSName": "laptop.tail1234.ts.net." }, "CurrentTailnet": { "MagicDNSSuffix": "tail1234.ts.net" } });
        assert_eq!(from_tailscale(&ts), Some(Network { kind: NetKind::Tailscale, ip: "100.101.102.103".into(), name: Some("laptop.tail1234.ts.net".into()) }));
        let hs = json!({ "BackendState": "Running", "TailscaleIPs": ["100.64.0.2"], "MagicDNSSuffix": "mesh.example.com" });
        assert_eq!(from_tailscale(&hs).unwrap().kind, NetKind::Headscale);
        assert_eq!(from_tailscale(&json!({ "BackendState": "Stopped" })), None);
    }

    #[test]
    fn netbird_when_connected() {
        assert_eq!(
            from_netbird(&json!({ "netbirdIp": "100.97.1.2/16", "fqdn": "box.netbird.cloud." })),
            Some(Network { kind: NetKind::Netbird, ip: "100.97.1.2".into(), name: Some("box.netbird.cloud".into()) })
        );
        assert_eq!(from_netbird(&json!({ "netbirdIp": "100.97.1.2/16", "management": { "connected": false } })), None);
    }

    #[test]
    fn interfaces_by_the_names_each_network_gives_them() {
        let i = |name: &str, ip: &str| Iface { name: name.into(), ip: ip.into(), internal: false };
        let found = from_interfaces(&[
            i("eth0", "192.168.1.5"),
            i("wt0", "100.97.0.9"),
            i("zt5u4y", "10.147.17.3"),
            i("wg0", "10.8.0.2"),
            i("tailscale0", "100.70.0.1"),
            i("Tailscale", "100.70.0.2"),
            i("docker0", "172.17.0.1"),
        ]);
        assert_eq!(found.iter().map(|n| n.kind).collect::<Vec<_>>(), [NetKind::Netbird, NetKind::Zerotier, NetKind::Wireguard, NetKind::Tailscale, NetKind::Tailscale]);
        assert_eq!(kind_of("NetBird Tunnel"), Some(NetKind::Netbird));
        assert_eq!(kind_of("wg-home"), Some(NetKind::Wireguard));
        assert_eq!(kind_of("WireGuard Tunnel"), Some(NetKind::Wireguard));
        assert_eq!(kind_of("feth1"), Some(NetKind::Zerotier));
        assert_eq!(kind_of("wlan0"), None);
    }
}
