//! `inyon join --no-autostart`, as install.ps1 runs it on Windows (and install.sh, with the
//! service): the env file it writes, and what it refuses.

use std::fs;
use std::path::PathBuf;
use std::process::Command;

struct Home(PathBuf);

impl Home {
    fn new(name: &str) -> Home {
        let dir = std::env::temp_dir().join(format!("inyon-join-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        Home(dir)
    }

    fn join(&self, hub: &str, env: &[(&str, &str)]) -> (bool, String) {
        let mut c = Command::new(env!("CARGO_BIN_EXE_inyon"));
        c.args(["join", hub, "--no-autostart"]).env("HOME", &self.0).env("USERPROFILE", &self.0).current_dir(&self.0);
        for v in [
            "INYON_HUB",
            "INYON_ALLOW_INSECURE",
            "INYON_HUB_CERT",
            "INYON_LEGACY_ENGINE",
            "INYON_SH",
            "TETHER_HUB",
            "TETHER_ALLOW_INSECURE",
            "TETHER_LEGACY_ENGINE",
            "TETHER_TOKEN",
        ] {
            c.env_remove(v);
        }
        c.env("INYON_TOKEN", "t0k3n-for-the-join-test-0123456789");
        for (k, v) in env {
            c.env(k, v);
        }
        let out = c.output().unwrap();
        (out.status.success(), format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr)))
    }

    fn saved(&self) -> Option<String> {
        let dir = self.0.join(".inyon").join("node");
        fs::read_to_string(dir.join(if cfg!(windows) { ".env" } else { "env" })).ok()
    }
}

impl Drop for Home {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn a_join_notes_its_version_and_refuses_plain_http_that_anyone_could_answer() {
    let version = env!("CARGO_PKG_VERSION");
    // a VPN address: saved, with the version that joined, so the connection holds it to this check
    let h = Home::new("vpn");
    let (ok, said) = h.join("http://100.70.1.2:4777", &[("INYON_SH", "C:\\inyon\\busybox.exe")]);
    assert!(ok, "{said}");
    let saved = h.saved().unwrap();
    assert!(saved.contains("INYON_HUB=http://100.70.1.2:4777\n"), "{saved}");
    assert!(saved.contains("INYON_TOKEN=t0k3n-for-the-join-test-0123456789\n"), "{saved}");
    assert!(saved.contains(&format!("INYON_JOINED={version}\n")), "{saved}");
    assert!(!saved.contains("INYON_ALLOW_INSECURE"), "{saved}");
    // Windows keeps the shell install.ps1 put there
    assert_eq!(saved.contains("INYON_SH=C:\\inyon\\busybox.exe"), cfg!(windows), "{saved}");

    // a LAN or public address on plain http: refused, nothing saved
    for hub in ["http://192.168.1.5:4777", "http://203.0.113.7:4777"] {
        let h = Home::new("refused");
        let (ok, said) = h.join(hub, &[]);
        assert!(!ok, "{hub}: {said}");
        assert!(said.contains("Refusing to send the token over plain http"), "{said}");
        assert_eq!(h.saved(), None, "{hub}");
    }

    // told to send it anyway: saved, and the choice noted for the connection
    let h = Home::new("insecure");
    let (ok, said) = h.join("http://192.168.1.5:4777", &[("INYON_ALLOW_INSECURE", "1")]);
    assert!(ok, "{said}");
    let saved = h.saved().unwrap();
    assert!(saved.contains(&format!("INYON_JOINED={version}\n")) && saved.contains("INYON_ALLOW_INSECURE=1\n"), "{saved}");
}
