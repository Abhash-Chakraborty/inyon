#!/bin/sh
# Gets inyon for this computer and sets it up for the Inyon phone app:
#   curl -fsSL https://inyon.abhashchakraborty.tech/get.sh | sh
# It downloads the right build into ~/.inyon/bin, checks it against the release's checksums, starts
# it in the background at login, and shows a code to scan with the app. With --hub it sets up an
# Inyon hub instead (the server the app signs in to):
#   curl -fsSL …/get.sh | sh -s -- --hub
set -e
BASE="${INYON_DOWNLOAD:-${TETHER_DOWNLOAD:-https://github.com/Abhash-Chakraborty/inyon/releases/latest/download}}"
ROLE=setup
for a in "$@"; do
  case "$a" in
    --hub) ROLE=hub ;;
    *) echo "unknown option $a (the only one is --hub)" >&2; exit 2 ;;
  esac
done

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) echo "This is for macOS and Linux. On Windows, run this in PowerShell instead:" >&2
     # the short address unless downloads come from somewhere else
     [ -n "${INYON_DOWNLOAD:-}${TETHER_DOWNLOAD:-}" ] && ps1="$BASE/get.ps1" || ps1=https://inyon.abhashchakraborty.tech/get.ps1
     echo "  irm $ps1 | iex" >&2
     exit 1 ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) echo "There's no inyon build for $(uname -m) yet." >&2; exit 1 ;;
esac

name="inyon-$os-$arch"
dir="$HOME/.inyon/bin"
mkdir -p "$dir"
tmp="$dir/inyon.download"
sums="$(curl -fsSL "$BASE/SHA256SUMS")" || sums=""
sum_for() { printf '%s\n' "$sums" | awk -v f="$1" '$2 == f || $2 == "*" f { print $1 }'; }
sum_of() { (sha256sum "$1" 2>/dev/null || shasum -a 256 "$1") | cut -d' ' -f1; }
mismatch() {
  rm -f "$tmp" "$tmp.gz"
  echo "The download didn't match the release's checksum. Run the command again." >&2
  exit 1
}
want="$(sum_for "$name")"
want_gz="$(sum_for "$name.gz")"
# the gzipped copy is under half the size; releases before 0.11 have none
if [ -n "$want_gz" ] && command -v gzip >/dev/null 2>&1; then
  echo "Downloading $name.gz…"
  curl -fL --progress-bar "$BASE/$name.gz" -o "$tmp.gz"
  [ "$(sum_of "$tmp.gz")" = "$want_gz" ] || mismatch
  gzip -dc "$tmp.gz" > "$tmp"
  rm -f "$tmp.gz"
else
  echo "Downloading $name…"
  curl -fL --progress-bar "$BASE/$name" -o "$tmp"
fi
[ -n "$want" ] && [ "$want" = "$(sum_of "$tmp")" ] || mismatch
chmod +x "$tmp"
mv -f "$tmp" "$dir/inyon"
# Apple Silicon only runs signed programs; a local signature is enough
[ "$os" = darwin ] && command -v codesign >/dev/null 2>&1 && codesign --force --sign - "$dir/inyon" >/dev/null 2>&1 || true

if [ "$ROLE" = hub ]; then exec "$dir/inyon" hub install; fi
exec "$dir/inyon" setup
