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

echo "---- app log (pid ${pid:-none}) ----"
grep -E 'AndroidRuntime|Inyon|Capacitor|chromium|System.err|Exception|Error' <<< "$mine" | tail -80 || true
grep -A30 'FATAL EXCEPTION' "$log" | head -60 || true

if [ ${#problems[@]} -eq 0 ]; then
  verdict "pass"
else
  verdict "fail: $(IFS=';'; echo "${problems[*]}")"
  exit 1
fi
