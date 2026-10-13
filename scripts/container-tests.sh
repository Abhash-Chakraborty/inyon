#!/bin/sh
# Installs inyon in fresh Linux containers from a mock of this release, and upgrades a real 0.12.0
# install to it. Needs docker; nothing is installed on this machine.
#
#   scripts/container-tests.sh                 builds the command (cargo, static musl) and the
#                                              engine (bun) for this machine's processor first
#   INYON_DIST=<dir> scripts/container-tests.sh  takes inyon-linux-<arch>[.gz] and
#                                              inyon-engine-linux-<arch>[.gz] from <dir> (CI)
#   INYON_TEST_SYSTEMS="alpine upgrade" …       runs only those (ubuntu debian alpine fedora upgrade)
#
# The release is served from a container on a network with no way out, so a test that reached
# GitHub would fail. The one download from GitHub is the 0.12.0 program for the upgrade test,
# kept in ~/.cache/inyon-tests.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) echo "no inyon build for $(uname -m)" >&2; exit 1 ;;
esac
cli="inyon-linux-$arch"
engine="inyon-engine-linux-$arch"
version=${INYON_TEST_VERSION:-0.13.2}
old=0.12.0
work=$(mktemp -d "${TMPDIR:-/tmp}/inyon-containers.XXXXXX")
cache=${INYON_TEST_CACHE:-$HOME/.cache/inyon-tests}
id=$$
net="inyon-test-$id"
failed=""

say() { printf '\n== %s\n' "$*"; }
cleanup() {
  docker rm -f "release-$id" >/dev/null 2>&1 || true
  docker network rm "$net" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

# ---------- the release ----------
dist="$work/dist"
mkdir -p "$dist"
if [ -n "${INYON_DIST:-}" ]; then
  for f in "$cli" "$engine"; do
    if [ -f "$INYON_DIST/$f" ]; then cp "$INYON_DIST/$f" "$dist/"
    elif [ -f "$INYON_DIST/$f.gz" ]; then gzip -dc "$INYON_DIST/$f.gz" > "$dist/$f"
    else echo "$INYON_DIST has no $f" >&2; exit 1
    fi
  done
else
  say "building the command and the engine for linux-$arch"
  target="$(uname -m)-unknown-linux-musl"
  rustup target add "$target" >/dev/null
  # the TLS library has C in it; without a musl cross compiler the host one does, for the same processor
  cc_var="CC_$(printf '%s' "$target" | tr '-' '_')"
  if command -v musl-gcc >/dev/null 2>&1; then cc=musl-gcc; else cc=cc; fi
  (cd "$root/apps/cli" && env "$cc_var=$cc" cargo build --release --target "$target" --quiet)
  cp "$root/apps/cli/target/$target/release/inyon" "$dist/$cli"
  [ -f "$root/apps/web/dist/index.html" ] || (cd "$root" && bun run build >/dev/null)
  bun "$root/apps/node/build.ts" "$work/engine" "linux-$arch" >/dev/null
  cp "$work/engine/$engine" "$dist/$engine"
fi
chmod +x "$dist/$cli" "$dist/$engine"
cp "$root/apps/node/get.sh" "$dist/"
(cd "$dist" && gzip -9 -k "$cli" "$engine" && sha256sum "$cli" "$cli.gz" "$engine" "$engine.gz" > SHA256SUMS)
say "the mock release $version"
cat "$dist/SHA256SUMS"

docker network create --internal "$net" >/dev/null
docker run -d --rm --name "release-$id" --network "$net" --network-alias release \
  -v "$dist:/dist:ro" -v "$root/scripts/mock-release.py:/srv/mock-release.py:ro" \
  python:3.12-alpine python3 -I /srv/mock-release.py --dir /dist --version "$version" --port 8000 >/dev/null
base="http://release:8000/releases/latest/download"

# ---------- the images: each base with curl, which get.sh needs ----------
image() {
  name="inyon-test-$1"
  case "$1" in
    ubuntu) from=ubuntu:24.04; add='RUN apt-get update -q && apt-get install -y -q --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*' ;;
    debian) from=debian:bookworm-slim; add='RUN apt-get update -q && apt-get install -y -q --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*' ;;
    alpine) from=alpine:3.20; add='RUN apk add --no-cache curl' ;;
    fedora) from=fedora:40; add='RUN dnf install -y -q curl && dnf clean all' ;;
  esac
  mkdir -p "$work/ctx"
  printf 'FROM %s\n%s\n' "$from" "$add" | docker build -q -t "$name" -f - "$work/ctx" >/dev/null
  echo "$name"
}

# ---------- a fresh install on each system (each container reaches the mock release and nothing else) ----------
fresh='set -e
curl -fsSL http://release:8000/get.sh | sh
echo "--- after setup"
ls -l ~/.inyon/bin
test -x ~/.inyon/bin/inyon-engine
~/.inyon/bin/inyon version
~/.inyon/bin/inyon status --plain
~/.inyon/bin/inyon status --plain | grep -q "^link: running" || { echo "the link is not running"; cat ~/.inyon/node/link.log 2>/dev/null; exit 1; }
~/.inyon/bin/inyon-engine version'
# The engine is built against glibc and Bun has no musl build in the release, so on Alpine only
# the command runs: it installs, fetches the engine and answers, but the link can't start yet
fresh_alpine='set -e
curl -fsSL http://release:8000/get.sh | sh || echo "(setup ended early: the engine needs a musl build to run on Alpine)"
echo "--- after setup"
ls -l ~/.inyon/bin
test -x ~/.inyon/bin/inyon-engine
~/.inyon/bin/inyon version
~/.inyon/bin/inyon status --plain
~/.inyon/bin/inyon doctor || true'
systems=${INYON_TEST_SYSTEMS:-ubuntu debian alpine fedora upgrade}
has() { case " $systems " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }
for sys in ubuntu debian alpine fedora; do
  has "$sys" || continue
  say "fresh install on $sys"
  img=$(image "$sys")
  script=$fresh
  [ "$sys" = alpine ] && script=$fresh_alpine
  if timeout 300 docker run --rm --network "$net" -e "INYON_DOWNLOAD=$base" "$img" sh -c "$script"; then
    echo "== $sys: ok"
  else
    echo "== $sys: FAILED"
    failed="$failed $sys"
  fi
done

# ---------- an upgrade from a real 0.12.0 install ----------
if has upgrade; then
say "upgrade from $old on ubuntu"
mkdir -p "$cache"
if [ ! -f "$cache/inyon-$old-linux-$arch" ]; then
  echo "downloading inyon $old (once; kept in $cache)"
  curl -fsSL "https://github.com/Abhash-Chakraborty/inyon/releases/download/v$old/SHA256SUMS" -o "$cache/SHA256SUMS-$old"
  curl -fL --progress-bar "https://github.com/Abhash-Chakraborty/inyon/releases/download/v$old/$cli.gz" -o "$cache/old.gz"
  want=$(awk -v f="$cli.gz" '$2 == f { print $1 }' "$cache/SHA256SUMS-$old")
  [ "$(sha256sum "$cache/old.gz" | cut -d' ' -f1)" = "$want" ] || { echo "the $old download didn't match its checksum" >&2; exit 1; }
  gzip -dc "$cache/old.gz" > "$cache/inyon-$old-linux-$arch"
  rm -f "$cache/old.gz"
fi
mkdir -p "$work/old"
cp "$cache/inyon-$old-linux-$arch" "$work/old/inyon"
chmod +x "$work/old/inyon"
upgrade='set -e
mkdir -p ~/.inyon/bin ~/.inyon/node
cp /old/inyon ~/.inyon/bin/inyon
# what a paired machine has: its identity and one phone
printf "%s" "{\"seed\":\"3f1a9c2e4b7d6058a1c3e5f7092b4d6e8f1a3c5e7092b4d6e8f1a3c5e7092b4d\",\"id\":\"k7m2p9x4w1q8z3v6\"}" > ~/.inyon/node/identity.json
printf "%s" "{\"a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2\":{\"name\":\"Pixel 9\",\"pairedAt\":1759300000000,\"lastSeen\":1760300000000}}" > ~/.inyon/node/phones.json
before=$(sha256sum ~/.inyon/node/phones.json)
~/.inyon/bin/inyon version
echo "--- the old program updates itself"
~/.inyon/bin/inyon update
echo "--- after the update"
ls -l ~/.inyon/bin
test "$before" = "$(sha256sum ~/.inyon/node/phones.json)" || { echo "phones.json changed"; exit 1; }
~/.inyon/bin/inyon version | grep -q "^inyon '"$version"'" || { echo "~/.inyon/bin/inyon is not the new command"; ~/.inyon/bin/inyon version; exit 1; }
~/.inyon/bin/inyon-engine version
~/.inyon/bin/inyon phones | grep "Pixel 9"
~/.inyon/bin/inyon status --plain | grep -q "machine k7m2p9x4w1q8z3v6"
# the old program keeps its copy aside (inyon.old-<time>) while nothing restarted on the new
# one; the next start removes it. No download may be left behind
test -z "$(ls ~/.inyon/bin | grep download)" || { echo "a download was left in bin"; exit 1; }'
if timeout 300 docker run --rm --network "$net" -e "INYON_DOWNLOAD=$base" -v "$work/old:/old:ro" "$(image ubuntu)" sh -c "$upgrade"; then
  echo "== upgrade: ok"
else
  echo "== upgrade: FAILED"
  failed="$failed upgrade"
fi
fi

if [ -n "$failed" ]; then
  say "failed:$failed"
  exit 1
fi
say "all container tests passed"
