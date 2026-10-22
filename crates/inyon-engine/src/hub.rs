//! The part of hub.ts a machine needs without the hub: which hub addresses may take its token
//! over plain http. The hub itself (`inyon hub`) still runs from the Bun engine.

use std::net::IpAddr;

use url::Url;

/// An address plain http may carry the token to: this machine, or a VPN that encrypts on its own
/// (Tailscale and NetBird's 100.64.0.0/10, Tailscale's fd7a:115c:a1e0::/48). A LAN address isn't:
/// anyone on the Wi-Fi can read the token there, or answer in the hub's place.
pub fn plain_http_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, ..] = v4.octets();
            v4.is_loopback() || (a == 100 && (64..=127).contains(&b))
        }
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => plain_http_ip(IpAddr::V4(v4)),
            None => v6.is_loopback() || v6.segments()[..3] == [0xfd7a, 0x115c, 0xa1e0],
        },
    }
}

/// What a hub address on plain http is: fine as it is (an address above, or localhost), a name
/// whose addresses have to be looked up and checked before every connection, or refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Plain {
    Ok,
    LookUp,
    Refused,
}

pub fn plain_host(url: &Url) -> Plain {
    match url.host() {
        Some(url::Host::Ipv4(ip)) => ok_if(plain_http_ip(ip.into())),
        Some(url::Host::Ipv6(ip)) => ok_if(plain_http_ip(ip.into())),
        Some(url::Host::Domain(d)) if d.eq_ignore_ascii_case("localhost") => Plain::Ok,
        Some(url::Host::Domain(_)) => Plain::LookUp,
        None => Plain::Refused,
    }
}

fn ok_if(ok: bool) -> Plain {
    if ok {
        Plain::Ok
    } else {
        Plain::Refused
    }
}

/// Why a hub address can't take the token over plain http, and what to do instead.
pub fn plain_refusal(host: &str) -> String {
    format!(
        "Refusing to send the token over plain http to {host}: anyone on that network could read it, or answer in the hub's place. Use the hub's https address, or its Tailscale or NetBird address (100.x.y.z), or set INYON_ALLOW_INSECURE=1 to send it anyway."
    )
}

/// Looks up a hub's name and checks that every address it has is one plain http may go to (a
/// MagicDNS name that points into the tailnet is). Err(None) when the name couldn't be looked up,
/// which is worth trying again; Err(Some(why)) when it points somewhere it mustn't.
pub async fn check_name(host: &str, port: u16) -> Result<Vec<std::net::SocketAddr>, Option<String>> {
    let addrs: Vec<std::net::SocketAddr> = tokio::net::lookup_host((host, port)).await.map_err(|_| None)?.collect();
    judge(host, addrs.iter().map(|a| a.ip()).collect())?;
    Ok(addrs)
}

/// check_name, for a program with no async threads (`inyon join`).
pub fn check_name_now(host: &str, port: u16) -> Result<(), Option<String>> {
    use std::net::ToSocketAddrs;
    judge(host, (host, port).to_socket_addrs().map_err(|_| None)?.map(|a| a.ip()).collect())
}

fn judge(host: &str, addrs: Vec<IpAddr>) -> Result<(), Option<String>> {
    match addrs.iter().find(|ip| !plain_http_ip(**ip)) {
        _ if addrs.is_empty() => Err(None),
        Some(bad) => Err(Some(format!("{} ({host} is {bad})", plain_refusal(host).trim_end_matches('.')))),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plain(hub: &str) -> Plain {
        plain_host(&Url::parse(hub).unwrap())
    }

    #[test]
    fn plain_http_is_for_this_machine_and_the_vpn_ranges() {
        for h in ["localhost", "127.0.0.1", "127.8.0.1", "100.64.0.1", "100.127.255.255", "[::1]", "[fd7a:115c:a1e0::1]", "[fd7a:115c:a1e0:ab12::5]", "[::ffff:100.100.1.1]"] {
            assert_eq!(plain(&format!("http://{h}:4777")), Plain::Ok, "{h}");
        }
    }

    #[test]
    fn a_lan_address_or_a_public_one_is_refused_and_a_name_is_looked_up() {
        // a LAN can be listened to, and answered by anyone on it
        for h in [
            "10.0.0.1",
            "192.168.1.20",
            "172.16.0.1",
            "8.8.8.8",
            "100.128.0.1",
            "100.63.255.255",
            "[fd00::1]",
            "[fe80::1]",
            "[fd7a:115c:a1e1::1]",
            "[2001:db8::1]",
            "[::ffff:192.168.1.2]",
        ] {
            assert_eq!(plain(&format!("http://{h}:4777")), Plain::Refused, "{h}");
        }
        // mDNS, LLMNR and the Wi-Fi's DNS answer names: what they point to is checked each time
        for h in ["hub.local", "hub.lan", "hub", "hub.tail1234.ts.net", "10.0.0.1.attacker.com"] {
            assert_eq!(plain(&format!("http://{h}:4777")), Plain::LookUp, "{h}");
        }
    }

    #[tokio::test]
    async fn a_name_passes_only_when_every_address_it_has_is_allowed() {
        // the addresses it was judged by, to connect to and nothing else
        assert!(check_name("localhost", 4777).await.unwrap().iter().all(|a| a.ip().is_loopback() && a.port() == 4777));
        // 192.168.1.2 written as a name
        let lan = check_name("192.168.1.2", 4777).await.unwrap_err().unwrap();
        assert!(lan.starts_with("Refusing to send the token over plain http to 192.168.1.2") && lan.contains("is 192.168.1.2"), "{lan}");
        assert_eq!(check_name("100.100.1.1", 4777).await, Ok(vec!["100.100.1.1:4777".parse().unwrap()]));
        assert_eq!(check_name("nothing.invalid", 4777).await, Err(None));
        assert_eq!(check_name_now("localhost", 4777), Ok(()));
        assert!(check_name_now("192.168.1.2", 4777).unwrap_err().is_some());
    }
}
