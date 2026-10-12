/**
 * The Unix "Add a machine" one-liner. It checks install.sh against its sha256 before running it,
 * and install.sh checks tether-node.ts the same way, so a plain-http download can't be swapped on
 * the way. The token travels in the environment, not in arguments other users can see in the
 * process list. Written for any POSIX shell, and pastes into bash, zsh and fish alike.
 * `hub` must already be checked (pairOrigin) and `token` is base64url, so both are safe unquoted.
 */
export function unixPairCommand(hub: string, token: string, installShSha256: string, scriptSha256: string) {
  const run =
    'f=$(mktemp) && curl -fsSL "$1/node/install.sh" -o "$f" && ' +
    'if [ "$( (sha256sum "$f" 2>/dev/null || shasum -a 256 "$f") | cut -c1-64)" = "$2" ]; then sh "$f" "$1"; ' +
    'else echo "install.sh did not match its checksum; get a new command from the hub" >&2; false; fi; s=$?; rm -f "$f"; exit $s'
  return `TETHER_TOKEN=${token} TETHER_NODE_SHA256=${scriptSha256} sh -c '${run}' inyon ${hub} ${installShSha256}`
}
