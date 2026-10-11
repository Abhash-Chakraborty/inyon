#!/bin/sh
# Updates a tether-node that install.sh set up, from the hub it's paired with. The hub fills in the
# checksum and version below, writes this to ~/.tether-node/update.sh and starts it detached, since
# restarting tether-node ends the command that started it. It works with any tether-node, so a
# version from before `tether-node update` can be updated too. Nothing is replaced until the
# download matches the checksum, and the old copy comes back if the new one doesn't start.
WANT='@@SHA256@@'
VERSION='@@VERSION@@'
D="$HOME/.tether-node"
F="$D/tether-node.ts"
exec >> "$D/update.log" 2>&1 < /dev/null
echo "$(date) updating tether-node to $VERSION"

say() { printf '%s\n' "$1" > "$D/update-status"; }
fail() {
  rm -f "$F.download"
  echo "failed: $1"
  say "failed: $1"
  exit 1
}

HUB="${TETHER_HUB:-}"
[ -n "$HUB" ] || HUB="$(sed -n 's/^TETHER_HUB=//p' "$D/env" 2>/dev/null | head -n 1)"
HUB="${HUB%/}"
[ -n "$HUB" ] || fail "there's no hub address in $D/env"

curl -fsSL "$HUB/node/tether-node.ts" -o "$F.download" || fail "couldn't download tether-node from $HUB"
have="$( (sha256sum "$F.download" 2>/dev/null || shasum -a 256 "$F.download") | cut -c1-64)"
[ "$have" = "$WANT" ] || fail "the download didn't match the hub's checksum, so nothing was changed"

BUN="$(command -v bun || echo "$HOME/.bun/bin/bun")"
UNIT="$HOME/.config/systemd/user/tether-node.service"
PLIST="$HOME/Library/LaunchAgents/dev.tether.node.plist"
# the tether-node that started this, for an install without a service manager (nohup)
OLD_PID="${TETHER_NODE_PID:-}"

restart() {
  if [ -f "$UNIT" ] && systemctl --user restart tether-node; then return 0; fi
  if [ -f "$PLIST" ]; then
    launchctl kickstart -k "gui/$(id -u)/dev.tether.node" 2>/dev/null || { launchctl unload "$PLIST" 2>/dev/null; launchctl load "$PLIST"; }
    return 0
  fi
  # only stop that process if it's still tether-node (a pid can be reused)
  if [ -n "$OLD_PID" ] && ps -o args= -p "$OLD_PID" 2>/dev/null | grep -q tether-node; then
    kill "$OLD_PID" 2>/dev/null
    sleep 1
  fi
  nohup "$BUN" "$F" >> "$D/node.log" 2>&1 < /dev/null &
  OLD_PID=$!
}

# The new copy writes node.json with its pid and version as it starts; it must still be running a
# few seconds later.
started() {
  i=0
  while [ "$i" -lt 45 ]; do
    if grep -q "\"version\":\"$VERSION\"" "$D/node.json" 2>/dev/null; then
      pid="$(sed -n 's/.*"pid":\([0-9]*\).*/\1/p' "$D/node.json")"
      sleep 5
      [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
      return
    fi
    sleep 1
    i=$((i + 1))
  done
  return 1
}

OLD="$F.old-$(date +%s)"
cp -p "$F" "$OLD" || fail "couldn't keep a copy of the current version"
mv -f "$F.download" "$F" || fail "couldn't put the new version in place"
rm -f "$D/node.json"
restart
if started; then
  rm -f "$OLD"
  echo "done"
  say "done $VERSION"
  exit 0
fi
mv -f "$OLD" "$F"
restart
fail "the new version didn't start, so the previous one is running again"
