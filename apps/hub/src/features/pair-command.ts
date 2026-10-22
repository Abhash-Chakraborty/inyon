/**
 * The Unix "Add a machine" one-liner. It checks install.sh against its sha256 before running it,
 * and install.sh checks the hub's list of checksums against the one given here, then the program
 * against its line, so a plain-http download can't be swapped on the way. The token travels in the
 * environment, not in arguments other users can see in the process list. Written for any POSIX
 * shell, and pastes into bash, zsh and fish alike.
 * `hub` must already be checked (pairOrigin), `token` is base64url and `certSha256` hex, so all
 * are safe unquoted.
 */
export function unixPairCommand(hub: string, token: string, installShSha256: string, sumsSha256: string, certSha256?: string) {
  // a hub on a certificate it made itself: curl can't check it, which is fine for files whose
  // sha256 the command already has; `inyon join` trusts only the certificate with this sha256
  const cert = certSha256 ? ` INYON_HUB_CERT=${certSha256}` : ''
  const run =
    `f=$(mktemp) && curl -fsSL${certSha256 ? 'k' : ''} "$1/node/install.sh" -o "$f" && ` +
    'if [ "$( (sha256sum "$f" 2>/dev/null || shasum -a 256 "$f") | cut -c1-64)" = "$2" ]; then sh "$f" "$1"; ' +
    'else echo "install.sh did not match its checksum; get a new command from the hub" >&2; false; fi; s=$?; rm -f "$f"; exit $s'
  return `INYON_TOKEN=${token} INYON_SUMS_SHA256=${sumsSha256}${cert} sh -c '${run}' inyon ${hub} ${installShSha256}`
}
