#!/bin/sh
# Installs tether-node as a background service for the current user.
# Usage: curl -fsSL <hub>/node/install.sh | sh -s -- <hub-url> <token>
set -e
HUB="$1"; TOKEN="$2"
[ -n "$HUB" ] && [ -n "$TOKEN" ] || { echo "usage: install.sh <hub-url> <token>" >&2; exit 2; }
DIR="$HOME/.tether-node"
mkdir -p "$DIR"

if ! command -v bun >/dev/null 2>&1 && [ ! -x "$HOME/.bun/bin/bun" ]; then
  echo "Installing Bun (https://bun.sh)…"
  curl -fsSL https://bun.sh/install | bash >/dev/null
fi
BUN="$(command -v bun || echo "$HOME/.bun/bin/bun")"

curl -fsSL "$HUB/node/tether-node.ts" -o "$DIR/tether-node.ts"
umask 077
printf 'TETHER_HUB=%s\nTETHER_TOKEN=%s\n' "$HUB" "$TOKEN" > "$DIR/env"

if command -v tmux >/dev/null 2>&1; then :; else echo "Note: tmux is not installed. Install it so Tether can list and drive sessions."; fi

case "$(uname -s)" in
  Linux)
    if command -v systemctl >/dev/null 2>&1 && systemctl --user status >/dev/null 2>&1; then
      mkdir -p "$HOME/.config/systemd/user"
      cat > "$HOME/.config/systemd/user/tether-node.service" <<UNIT
[Unit]
Description=Tether node (outbound connection to your Tether hub)
After=network-online.target

[Service]
EnvironmentFile=$DIR/env
ExecStart=$BUN $DIR/tether-node.ts
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
UNIT
      systemctl --user daemon-reload
      systemctl --user enable --now tether-node
      loginctl enable-linger "$USER" 2>/dev/null || true
      echo "tether-node is running (systemctl --user status tether-node)."
      exit 0
    fi ;;
  Darwin)
    PLIST="$HOME/Library/LaunchAgents/dev.tether.node.plist"
    mkdir -p "$HOME/Library/LaunchAgents"
    cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.tether.node</string>
  <key>ProgramArguments</key><array><string>$BUN</string><string>$DIR/tether-node.ts</string></array>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>$DIR/node.log</string>
</dict></plist>
PL
    launchctl unload "$PLIST" 2>/dev/null || true
    launchctl load "$PLIST"
    echo "tether-node is running (launchctl list | grep tether)."
    exit 0 ;;
esac

# reads the hub and token from $DIR/env, so the token isn't visible in ps
nohup "$BUN" "$DIR/tether-node.ts" >> "$DIR/node.log" 2>&1 &
echo "tether-node started in the background (log: $DIR/node.log)."
