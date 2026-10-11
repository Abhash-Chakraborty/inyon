#!/bin/sh
# Gets tether-node for this computer and sets it up for the Tether phone app:
#   curl -fsSL https://github.com/Abhash-Chakraborty/tether-releases/releases/latest/download/get.sh | sh
# It downloads the right build into ~/.tether-node/bin, checks it against the release's
# checksums, starts it in the background at login, and shows a code to scan with the app.
set -e
BASE="${TETHER_DOWNLOAD:-https://github.com/Abhash-Chakraborty/tether-releases/releases/latest/download}"

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) echo "This is for macOS and Linux. On Windows, run this in PowerShell instead:" >&2
     echo "  irm $BASE/get.ps1 | iex" >&2
     exit 1 ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) echo "There's no tether-node build for $(uname -m) yet." >&2; exit 1 ;;
esac

name="tether-node-$os-$arch"
dir="$HOME/.tether-node/bin"
mkdir -p "$dir"
tmp="$dir/tether-node.download"
echo "Downloading $name…"
curl -fL --progress-bar "$BASE/$name" -o "$tmp"
want="$(curl -fsSL "$BASE/SHA256SUMS" | awk -v f="$name" '$2 == f || $2 == "*" f { print $1 }')"
have="$( (sha256sum "$tmp" 2>/dev/null || shasum -a 256 "$tmp") | cut -d' ' -f1)"
if [ -z "$want" ] || [ "$want" != "$have" ]; then
  rm -f "$tmp"
  echo "The download didn't match the release's checksum. Run the command again." >&2
  exit 1
fi
chmod +x "$tmp"
mv -f "$tmp" "$dir/tether-node"
# Apple Silicon only runs signed programs; a local signature is enough
[ "$os" = darwin ] && command -v codesign >/dev/null 2>&1 && codesign --force --sign - "$dir/tether-node" >/dev/null 2>&1 || true

exec "$dir/tether-node" setup
