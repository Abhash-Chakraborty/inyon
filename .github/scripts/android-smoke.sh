#!/usr/bin/env bash
# Installs an APK on the running emulator, starts it, and checks logcat: no crash, nothing R8
# stripped that the app reaches for, both native plugins loaded and the web app started.
#
# Writes its verdict to $OUT/verdict ("pass" or "fail: ..."). No verdict means the emulator
# itself misbehaved, and the workflow may retry.
set -u
apk=$1
out=${OUT:-${RUNNER_TEMP:-/tmp}/smoke}
mkdir -p "$out"
rm -f "$out/verdict"
log="$out/logcat.txt"

verdict() {
  echo "$1" > "$out/verdict"
  echo "verdict: $1"
}

adb wait-for-device
if ! result=$(adb install -r "$apk" 2>&1); then
  echo "$result"
  # a rejected APK is our fault; anything else (device offline, timeouts) is the emulator's
  if grep -qE 'INSTALL_FAILED|INSTALL_PARSE_FAILED|Failure \[' <<< "$result"; then verdict "fail: the APK did not install"; fi
  exit 1
fi

adb logcat -c
adb shell am start -W -n tech.abhashchakraborty.inyon/.MainActivity || exit 1
sleep 25
pid=$(adb shell pidof tech.abhashchakraborty.inyon | tr -d '\r')
adb logcat -d -v threadtime > "$log"
adb exec-out screencap -p > "$out/screen.png" || true

# threadtime lines: date time pid tid level tag: message
mine=$(awk -v p="${pid:-none}" '$3 == p' "$log")
problems=()
if grep -qE 'FATAL EXCEPTION|ANR in tech\.abhashchakraborty\.inyon' "$log" && grep -qE 'Process: tech\.abhashchakraborty\.inyon|ANR in tech\.abhashchakraborty\.inyon' "$log"; then
  problems+=("the app crashed")
fi
[ -n "$pid" ] || problems+=("the app is not running")
if grep -qE 'ClassNotFoundException|NoClassDefFoundError|NoSuchMethodError|NoSuchMethodException|NoSuchFieldError|AbstractMethodError' <<< "$mine"; then
  problems+=("missing classes or methods (R8)")
fi
grep -qE 'InyonDevice *: ready' <<< "$mine" || problems+=("InyonDevice did not load")
grep -qE 'InyonSsh *: ready' <<< "$mine" || problems+=("InyonSsh did not load")
grep -qE 'InyonDevice *: web app started' <<< "$mine" || problems+=("the web app did not start")

# A hub on a private network is plain http, which Android lets an app call only when its manifest
# says so: ask the running app to fetch from a server on the runner (10.0.2.2 from the emulator).
if [ -n "$pid" ]; then
  # the server answers with CORS headers, as the hub does; without them the app's cross-origin
  # fetch fails the same way whether or not the request went out
  bun -e 'Bun.serve({ port: 4777, hostname: "0.0.0.0", fetch: () => new Response("ok", { headers: { "access-control-allow-origin": "*" } }) })' > /dev/null 2>&1 &
  www_pid=$!
  sleep 2
  curl -s -o /dev/null -w "the test server answers on the runner: %{http_code}\n" http://127.0.0.1:4777/ok
  here=$(cd "$(dirname "$0")" && pwd)
  adb forward tcp:9333 localabstract:webview_devtools_remote_$pid > /dev/null 2>&1
  wsurl=$(curl -s http://127.0.0.1:9333/json | grep -o '"webSocketDebuggerUrl": *"[^"]*"' | head -1 | sed 's/.*"\(ws[^"]*\)"/\1/')
  if [ -n "$wsurl" ]; then
    http=$(bun "$here/webview-eval.ts" "$wsurl" 'fetch("http://10.0.2.2:4777/ok", { cache: "no-store" }).then((r) => "http " + r.status).catch((e) => "http failed: " + e.message)' 2>&1)
    echo "plain http from the app: $http"
    [[ "$http" == *"http 200"* ]] || problems+=("the app cannot call a plain-http hub: $http")
  else
    echo "no DevTools socket, so plain http from the app was not checked"
  fi
  kill "$www_pid" 2> /dev/null || true
fi
echo "---- app log (pid ${pid:-none}) ----"
grep -E 'AndroidRuntime|Inyon|Capacitor|chromium|System.err|Exception|Error' <<< "$mine" | tail -80 || true
grep -A30 'FATAL EXCEPTION' "$log" | head -60 || true

if [ ${#problems[@]} -eq 0 ]; then
  verdict "pass"
else
  verdict "fail: $(IFS=';'; echo "${problems[*]}")"
  exit 1
fi
