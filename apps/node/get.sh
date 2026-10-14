#!/bin/sh
# Gets inyon for this computer and sets it up for the Inyon phone app:
#   curl -fsSL https://inyon.abhashchakraborty.tech/get.sh | sh
# It downloads the inyon command for this system into ~/.inyon/bin from the website's copy of the
# newest release, checks it against the release's checksums (and their signature, when minisign
# is installed), and runs its setup, which fetches the engine behind it, starts it in the
# background at login, and shows a code to scan with the app. With --hub it sets up an Inyon
# hub instead (the server the app signs in to):
#   curl -fsSL …/get.sh | sh -s -- --hub
set -e
BASE="${INYON_DOWNLOAD:-${TETHER_DOWNLOAD:-https://inyon.abhashchakraborty.tech/download}}"
# the minisign key a release's SHA256SUMS is signed with (the inyon command carries the same one)
KEY=RWRTvQv/ifQnD3jarY1oarS0AKdhogH+mdgn/o0NzT/Ro8L43nFqqfp6
SITE=https://inyon.abhashchakraborty.tech
GITHUB=https://github.com/Abhash-Chakraborty/inyon/releases
# a mock release for tests signs with a key of its own; it only counts with downloads pointed
# somewhere other than the website or GitHub
case "$BASE" in
  "$SITE" | "$SITE"/* | http://inyon.abhashchakraborty.tech | http://inyon.abhashchakraborty.tech/* | "$GITHUB"/*) ;;
  *) if [ -n "${INYON_DOWNLOAD:-}${TETHER_DOWNLOAD:-}" ] && [ -n "${INYON_SIGNING_KEY:-}" ]; then KEY="$INYON_SIGNING_KEY"; fi ;;
esac
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
     [ -n "${INYON_DOWNLOAD:-}${TETHER_DOWNLOAD:-}" ] && ps1="$BASE/get.ps1" || ps1="$SITE/get.ps1"
     echo "  irm $ps1 | iex" >&2
     exit 1 ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) echo "There's no inyon build for $(uname -m) yet." >&2; exit 1 ;;
esac
# Alpine and other musl systems run the engine built against musl; the command is static and the same
libc=""
if [ -f /etc/alpine-release ] || ldd --version 2>&1 | grep -qi musl; then libc=-musl; fi

name="inyon-$os-$arch"
engine="inyon-engine-$os-$arch$libc"
dir="$HOME/.inyon/bin"
mkdir -p "$dir"
tmp="$dir/inyon.download"
list="$dir/SHA256SUMS.download"
curl -fsSL "$BASE/SHA256SUMS" -o "$list" || { echo "Couldn't get $BASE/SHA256SUMS. Check the connection and run the command again." >&2; exit 1; }
# the list is signed; without minisign it's trusted as it comes, as before 0.14
if command -v minisign >/dev/null 2>&1; then
  if curl -fsSL "$BASE/SHA256SUMS.minisig" -o "$list.minisig" && minisign -V -q -m "$list" -x "$list.minisig" -P "$KEY" >/dev/null 2>&1; then
    rm -f "$list.minisig"
  else
    rm -f "$list" "$list.minisig"
    echo "The release's checksum list isn't signed by Inyon's release key, so nothing was installed." >&2
    exit 1
  fi
else
  echo "(minisign isn't installed, so the checksums weren't signature-checked)"
fi
sums="$(cat "$list")"
rm -f "$list"
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
  # the website keeps only the gzipped copies of a large release; the plain ones stay on GitHub
  # under the release's tag, which the list gives away in its APK's name (inyon-<version>.apk).
  # Either way the file is checked against the same list below
  plain="$BASE/$name"
  case "$BASE" in
    "$SITE"/download | "$SITE"/download/)
      version="$(printf '%s\n' "$sums" | awk '{ f = $2; sub(/^\*/, "", f) } f ~ /^inyon-[0-9]+\.[0-9]+\.[0-9]+\.apk$/ { sub(/^inyon-/, "", f); sub(/\.apk$/, "", f); print f; exit }')"
      if [ -n "$version" ]; then plain="$GITHUB/download/v$version/$name"; fi ;;
  esac
  echo "Downloading $name…"
  curl -fL --progress-bar "$plain" -o "$tmp"
fi
[ -n "$want" ] && [ "$want" = "$(sum_of "$tmp")" ] || mismatch
chmod +x "$tmp"
mv -f "$tmp" "$dir/inyon"
# Apple Silicon only runs signed programs; a local signature is enough
[ "$os" = darwin ] && command -v codesign >/dev/null 2>&1 && codesign --force --sign - "$dir/inyon" >/dev/null 2>&1 || true

# new terminals find inyon by name: one line marked "added by Inyon" in the startup file of your
# shell, written once (inyon uninstall takes it out again). INYON_NO_MODIFY_PATH=1 leaves it out
on_path=""
case ":$PATH:" in *":$dir:"* | *":$dir/:"*) on_path=yes ;; esac
if [ -z "${INYON_NO_MODIFY_PATH:-}" ] && [ -z "$on_path" ]; then
  mark="# added by Inyon"
  case "${SHELL##*/}" in
    zsh) files="${ZDOTDIR:-$HOME}/.zshrc"; line="export PATH=\"\$HOME/.inyon/bin:\$PATH\" $mark" ;;
    # a Mac's Terminal starts bash as a login shell, which reads .bash_profile instead
    bash) files="$HOME/.bashrc"; [ "$os" = darwin ] && files="$files $HOME/.bash_profile"; line="export PATH=\"\$HOME/.inyon/bin:\$PATH\" $mark" ;;
    fish) files="$HOME/.config/fish/conf.d/inyon.fish"; line="contains \$HOME/.inyon/bin \$PATH; or set -gx PATH \$HOME/.inyon/bin \$PATH $mark" ;;
    *) files="$HOME/.profile"; line="export PATH=\"\$HOME/.inyon/bin:\$PATH\" $mark" ;;
  esac
  changed=""
  for f in $files; do
    grep -qF "$mark" "$f" 2>/dev/null && continue
    mkdir -p "${f%/*}"
    # on a line of its own, even when the file doesn't end with one
    if [ -s "$f" ] && { ! command -v tail >/dev/null 2>&1 || [ -n "$(tail -c 1 "$f")" ]; }; then echo >> "$f"; fi
    printf '%s\n' "$line" >> "$f" || continue
    case "$f" in "$HOME"/*) f="~/${f#"$HOME"/}" ;; esac
    changed="${changed:+$changed and }$f"
  done
  if [ -n "$changed" ]; then
    echo "Added inyon to your PATH in $changed, so new terminals find it by name."
    echo "In this one, first run: export PATH=\"\$HOME/.inyon/bin:\$PATH\""
  fi
fi

# the musl engine is linked against libstdc++ and libgcc, which Alpine doesn't ship by default
if [ -n "$libc" ] && [ ! -e /usr/lib/libstdc++.so.6 ]; then
  if [ "$(id -u)" = 0 ] && command -v apk >/dev/null 2>&1 && apk add -q libstdc++ libgcc >/dev/null 2>&1; then :
  else echo "The engine needs libstdc++ and libgcc on Alpine: apk add libstdc++ libgcc" >&2
  fi
fi

# from 0.13 a release is two files: this one is the inyon command, and its setup gets the engine
# ($engine) that runs behind it. Before that, this one file was the whole program
if [ -n "$(sum_for "$engine")" ]; then
  if [ "$ROLE" = hub ]; then exec "$dir/inyon" setup --role hub; fi
  exec "$dir/inyon" setup
fi
if [ "$ROLE" = hub ]; then exec "$dir/inyon" hub install; fi
exec "$dir/inyon" setup
