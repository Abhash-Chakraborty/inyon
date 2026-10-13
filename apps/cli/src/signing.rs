//! A release's SHA256SUMS comes with SHA256SUMS.minisig, a minisign signature made with Inyon's
//! release key, so a checksum list from anywhere else is refused before a file is downloaded.
//! Files a hub hands out aren't signed: they're checked against the sha256 the hub publishes.

use std::fmt;

use minisign_verify::{PublicKey, Signature};

use crate::paths::env_var;
use crate::update::RELEASES;

/// Inyon's release key (minisign key 0F27F489FF0BBD53).
pub const RELEASE_KEY: &str = "RWRTvQv/ifQnD3jarY1oarS0AKdhogH+mdgn/o0NzT/Ro8L43nFqqfp6";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    /// the key isn't a minisign public key
    Key,
    /// the .minisig file isn't a minisign signature
    Signature,
    /// another key, a changed list, or a signature of the kind minisign no longer makes
    Mismatch,
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Error::Key => "the signing key isn't a minisign key",
            Error::Signature => "the signature file isn't a minisign signature",
            Error::Mismatch => "the signature doesn't match the key and the checksum list",
        })
    }
}

/// Checks that `sig` (a .minisig file) signs `sums` with `key` (the base64 line of a .pub file).
/// Only the hashed kind of signature, which today's minisign and the release workflow make, is
/// accepted: the older kind over the plain bytes is refused along with everything else.
pub fn verify_sums(sums: &str, sig: &str, key: &str) -> Result<(), Error> {
    let key = PublicKey::from_base64(key.trim()).map_err(|_| Error::Key)?;
    let sig = Signature::decode(sig).map_err(|_| Error::Signature)?;
    key.verify(sums.as_bytes(), &sig, false).map_err(|_| Error::Mismatch)
}

/// The key out of a .pub file's text: the base64 line, whether or not the "untrusted comment"
/// line comes first.
pub fn key_line(text: &str) -> Option<String> {
    text.lines().map(str::trim).rfind(|l| !l.is_empty() && !l.starts_with("untrusted comment:")).map(String::from)
}

/// The key releases from `base` must be signed with. Tests and the container runs point
/// INYON_DOWNLOAD at a mock release and INYON_SIGNING_KEY at the key that signed it; with the real
/// releases the variable is ignored, so an environment variable alone can't point an install at
/// another key.
pub fn signing_key(base: &str) -> String {
    if base.trim_end_matches('/') != RELEASES {
        if let Some(k) = env_var("INYON_SIGNING_KEY").and_then(|t| key_line(&t)) {
            return k;
        }
    }
    RELEASE_KEY.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEST_KEY: &str = "RWQqNVK9mQOKMvLzyK5hNRZhdkrEQAMzJCRgzTyujgXyvmvHB0y3/zRm";

    // made with the minisign binary (0.12) and the key in tests/keys, so this is the format the
    // release workflow produces
    const SUMS: &str = "abc  file-a\n";
    const SUMS_SIG: &str = "untrusted comment: signature from minisign secret key\n\
        RUQqNVK9mQOKMsG6IaBxYN3yeR9DY8Kwq2+HGNkBa8PWTC7MyZVoH8WrwxnZc1dJUEhj/YiXuUfHK7DA/140uWusc6AMswmIuAk=\n\
        trusted comment: timestamp:1791906365\tfile:SUMS\thashed\n\
        oVJ5Gs0ifXOH3A3LPOydH99Oy63a+zAnotC94agLquPv6YcFYKXEl61a2M7Kiba52Dq4ulBuTrygyBnx8RdFCw==\n";

    #[test]
    fn a_signature_from_the_minisign_binary_checks_out_and_any_change_is_refused() {
        assert_eq!(verify_sums(SUMS, SUMS_SIG, TEST_KEY), Ok(()));
        assert_eq!(verify_sums("abd  file-a\n", SUMS_SIG, TEST_KEY), Err(Error::Mismatch));
        assert_eq!(verify_sums(SUMS, SUMS_SIG, RELEASE_KEY), Err(Error::Mismatch));
        assert_eq!(verify_sums(SUMS, "not a signature", TEST_KEY), Err(Error::Signature));
        assert_eq!(verify_sums(SUMS, SUMS_SIG, "not a key"), Err(Error::Key));
    }

    #[test]
    fn the_key_line_is_the_base64_with_or_without_the_comment() {
        assert_eq!(key_line(TEST_KEY).as_deref(), Some(TEST_KEY));
        assert_eq!(key_line(&format!("untrusted comment: minisign public key 328A0399BD52352A\n{TEST_KEY}\n")).as_deref(), Some(TEST_KEY));
        assert_eq!(key_line("untrusted comment: nothing after it\n"), None);
        assert_eq!(key_line(""), None);
    }
}
