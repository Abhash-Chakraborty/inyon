#!/usr/bin/env bash
# Runs the spike APK on the emulator and writes what it saw to $OUT: summary.md, logcat, screenshots.
# Fails only when the app crashes or never gets its terminal up.
set -u
apk=$1
own=${2:-}
out=${OUT:-/tmp/s1-out}
here=$(cd "$(dirname "$0")" && pwd)
pkg=tech.abhashchakraborty.inyon.spike
act=$pkg/dev.dioxus.main.MainActivity
mkdir -p "$out"
sum="$out/summary.md"
: > "$sum"
note() { echo "$*" | tee -a "$sum"; }
shot() { adb exec-out screencap -p > "$out/$1.png" 2>/dev/null || true; }
spike_log() { adb logcat -d -s InyonSpike:I; }
wait_log() { # pattern seconds
  for _ in $(seq 1 "$2"); do spike_log | grep -q "$1" && return 0; sleep 1; done
  return 1
}

adb wait-for-device
adb install -r "$apk" || { note "install failed"; exit 1; }
adb shell pm grant $pkg android.permission.POST_NOTIFICATIONS || true
note "## Emulator (API 34, x86_64, pixel_6, swiftshader)"
note ""
note "APK: $(stat -c %s "$apk") bytes (x86_64; the arm64 size is in the apk job)"
note ""

# cold starts: force-stop, then start and wait for the terminal to report in
note "| run | am start TotalTime | Rust main | first render | terminal ready |"
note "|---|---|---|---|---|"
for run in 1 2 3 4; do
  adb shell am force-stop $pkg
  sleep 2
  adb logcat -c
  total=$(adb shell am start -W -n $act | tr -d '\r' | awk -F': ' '/TotalTime/ {print $2}')
  if wait_log "terminal ready" 90; then
    l=$(spike_log)
    m=$(grep -o 'main started [0-9]* ms' <<< "$l" | grep -o '[0-9]*' | head -1)
    f=$(grep -o 'first render [0-9]* ms' <<< "$l" | grep -o '[0-9]*' | head -1)
    t=$(grep -o 'terminal ready [0-9]* ms' <<< "$l" | grep -o '[0-9]*' | head -1)
    note "| $run | ${total} ms | ${m} ms | ${f} ms | ${t} ms |"
  else
    note "| $run | ${total} ms | never got ready | | |"
  fi
done
note ""
note "Run 1 is the first start after install; the times after it are from process start (read in Rust from /proc)."
note ""

pid=$(adb shell pidof $pkg | tr -d '\r')
adb logcat -d -v threadtime > "$out/logcat-start.txt"
if [ -z "$pid" ] || grep -q "FATAL EXCEPTION" "$out/logcat-start.txt"; then
  note "**The app crashed or is not running.**"
  echo fail > "$out/verdict"
  exit 1
fi
spike_log | grep "terminal ready" | tail -1 | sed 's/^.*terminal ready/terminal ready/' | tee -a "$sum"
note ""
sleep 2
shot 01-chat

# DevTools for clicks and reading the page
adb forward tcp:9333 localabstract:webview_devtools_remote_$pid > /dev/null
cdp() { bun "$here/cdp.ts" 9333 "$@"; }
for _ in $(seq 1 20); do curl -s http://127.0.0.1:9333/json > /dev/null && break; sleep 1; done
note "page metrics: \`$(cdp eval 'JSON.stringify(window.__spike)')\`"
note ""

cdp eval "document.querySelector('[aria-label=Terminal]').click()" > /dev/null
sleep 2
shot 02-terminal
cdp eval "document.querySelector('[aria-label=Chat]').click()" > /dev/null
cdp eval "document.querySelector('[aria-label=\"Open sidebar\"]').click()" > /dev/null
sleep 1.5
shot 03-sidebar
cdp eval "document.querySelector('.scrim').click()" > /dev/null
sleep 1

# soft keyboard: a real touch on the composer should bring it up
adb logcat -c
cdp tap 'textarea' | tee -a "$sum"
sleep 3
kb=$(adb shell dumpsys input_method | tr -d '\r' | grep -oE 'mInputShown=(true|false)' | head -1)
note "keyboard after a tap on the composer: ${kb:-unknown}"
adb shell input text 'hello%sfrom%sthe%skeyboard'
sleep 2
shot 04-keyboard
typed=$(spike_log | grep -o 'composer: .*' | tail -1)
note "Rust saw: \`${typed:-nothing}\`"
cdp eval "document.querySelector('[aria-label=Send]').click()" > /dev/null
sleep 1
sent=$(spike_log | grep -o 'sent: .*' | tail -1)
note "after Send: \`${sent:-nothing}\`"
adb shell input keyevent KEYCODE_BACK
sleep 1

# typing into the terminal (xterm's own hidden textarea)
cdp eval "document.querySelector('[aria-label=Terminal]').click()" > /dev/null
sleep 1
cdp tap '#term' > /dev/null
sleep 2
adb shell input text 'ls%s-la'
adb shell input keyevent KEYCODE_ENTER
sleep 2
shot 05-terminal-typing
note "terminal input seen by Rust: \`$(spike_log | grep -o 'terminal input: .*' | head -3 | tr '\n' ' ')\`"
adb shell input keyevent KEYCODE_BACK

# the keep-alive service, started from Rust over JNI
fgs=$(adb shell dumpsys activity services $pkg | tr -d '\r')
echo "$fgs" > "$out/services.txt"
if grep -q "isForeground=true" <<< "$fgs"; then note "keep-alive service: running in the foreground"; else note "keep-alive service: NOT in the foreground"; fi
note "$(adb logcat -d -s InyonSpike:I | grep -E 'keep-alive' | sed 's/^.*InyonSpike: //' | sort -u | tr '\n' ';')"
adb shell cmd statusbar expand-notifications
sleep 2
shot 06-notification
adb shell cmd statusbar collapse

mem=$(adb shell dumpsys meminfo $pkg | tr -d '\r' | grep -E 'TOTAL PSS|TOTAL:' | head -1)
note "memory: $mem"
adb logcat -d -v threadtime > "$out/logcat.txt"
if grep -q "FATAL EXCEPTION" "$out/logcat.txt"; then note "**crashed during the run**"; echo fail > "$out/verdict"; exit 1; fi

# the APK from the app's own Gradle project, installed over the dx one as an upgrade (same id and
# key, higher versionCode)
if [ -f "$own" ]; then
  note ""
  note "### Own Gradle project APK"
  if adb install -r "$own" > /dev/null; then
    note "installed over the dx build: $(adb shell dumpsys package $pkg | tr -d '\r' | grep -m1 -o 'versionCode=[0-9]*')"
    adb shell am force-stop $pkg
    adb logcat -c
    total=$(adb shell am start -W -n $act | tr -d '\r' | awk -F': ' '/TotalTime/ {print $2}')
    if wait_log "terminal ready" 90; then
      note "started: am start ${total} ms, $(spike_log | grep -o 'terminal ready [0-9]* ms' | head -1)"
      sleep 2
      shot 07-own-gradle
      if adb shell dumpsys activity services $pkg | grep -q "isForeground=true"; then note "keep-alive: in the foreground"; else note "keep-alive: not running"; fi
    else
      note "**never got ready**"
    fi
    adb logcat -d -v threadtime > "$out/logcat-own.txt"
    grep -q "FATAL EXCEPTION" "$out/logcat-own.txt" && note "**crashed**"
  else
    note "install failed"
  fi
fi
echo pass > "$out/verdict"
exit 0
