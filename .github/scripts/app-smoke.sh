#!/usr/bin/env bash
# The Android app from 1.0 (apps/app/android) on the running emulator: installs it, starts it and
# checks logcat (no crash, nothing R8 stripped, the phone core running), then measures what it costs
# while hidden. With a second APK (the Capacitor build) it measures that the same way first, so the
# two numbers come from the same emulator.
#
# Writes $OUT/verdict ("pass" or "fail: ...") and $OUT/summary.md. No verdict means the emulator
# itself misbehaved.
set -u
apk=$1
before=${2:-}
out=${OUT:-${RUNNER_TEMP:-/tmp}/app-smoke}
pkg=tech.abhashchakraborty.inyon
mkdir -p "$out"
rm -f "$out/verdict"
sum="$out/summary.md"
: > "$sum"
note() { echo "$*" | tee -a "$sum"; }
verdict() {
  echo "$1" > "$out/verdict"
  echo "verdict: $1"
}
hz=100
cap="" app=""
# utime + stime of a process, in clock ticks
ticks() { adb shell cat "/proc/$1/stat" 2>/dev/null | tr -d '\r' | sed 's/^.*) //' | awk '{print $12 + $13}'; }
# wakeups are what drains a phone in the background: context switches of every thread of a process
switches() { adb shell "cat /proc/$1/task/*/status" 2>/dev/null | tr -d '\r' | awk '/^(voluntary|nonvoluntary)_ctxt_switches/ {n += $2} END {print n + 0}'; }
# each thread's id, name (spaces taken out) and context switches, to see which ones wake
threads() { adb shell "for t in /proc/$1/task/*; do echo \${t##*/} \$(tr -d ' ' < \$t/comm) \$(grep -h ctxt_switches \$t/status | awk '{s+=\$2} END {print s}'); done" 2>/dev/null | tr -d '\r'; }
# the WebView's renderers (children of webview_zygote): the Capacitor app's core runs in its
# renderer, the new app's in its own process, so both count for a fair comparison
renderers() {
  local z
  z=$(adb shell ps -A -o PID,NAME | tr -d '\r' | awk '$2 == "webview_zygote" {print $1}')
  [ -n "$z" ] && adb shell ps -A -o PID,PPID | tr -d '\r' | awk -v z="$z" '$2 == z {print $1}'
}
sum() { local f=$1 n=0 p; shift; for p in "$@"; do n=$(( n + $($f "$p") )); done; echo $n; }

# Starts the launcher activity, waits, sends it home and counts its CPU over two minutes hidden,
# the app's process alone and with the WebView's renderers. Prints "<app ms> <app switches>
# <all ms> <all switches>"; nothing if the process is gone. $1 names the thread table.
hidden_cost() {
  adb shell monkey -p $pkg -c android.intent.category.LAUNCHER 1 > /dev/null 2>&1
  sleep 20
  adb shell input keyevent KEYCODE_HOME
  # Android freezes cached apps after about 10 s; the first minute settles
  sleep 60
  local pid r t0 s0 t1 s1 rt0 rs0 rt1 rs1
  pid=$(adb shell pidof $pkg | tr -d '\r')
  [ -n "$pid" ] || return 0
  r=$(renderers | tr '\n' ' ')
  threads "$pid" | sort > "$out/threads-$1-before.txt"
  t0=$(ticks "$pid") s0=$(switches "$pid")
  rt0=$(sum ticks $r) rs0=$(sum switches $r)
  sleep 120
  t1=$(ticks "$pid") s1=$(switches "$pid")
  rt1=$(sum ticks $r) rs1=$(sum switches $r)
  threads "$pid" | sort > "$out/threads-$1-after.txt"
  [ -n "$t0" ] && [ -n "$t1" ] || return 0
  echo "$(( (t1 - t0) * 1000 / hz )) $(( s1 - s0 )) $(( (t1 - t0 + rt1 - rt0) * 1000 / hz )) $(( s1 - s0 + rs1 - rs0 ))"
}

# the threads that woke most while hidden, from hidden_cost's tables (joined on the thread id)
busiest() {
  join "$out/threads-$1-before.txt" "$out/threads-$1-after.txt" 2>/dev/null |
    awk '{d = $5 - $3; if (d > 0) printf "%s %d\n", $2, d}' | sort -k2 -n -r | head -6 | awk '{printf "%s%s (%d)", (NR > 1 ? ", " : ""), $1, $2} END {print ""}'
}

adb wait-for-device
adb shell settings put global hide_error_dialogs 1

note "## Android app from 1.0 on an emulator (API 34, x86_64)"
note ""
if [ -n "$before" ]; then
  if adb install -r "$before" > /dev/null 2>&1; then
    adb shell pm grant $pkg android.permission.POST_NOTIFICATIONS > /dev/null 2>&1 || true
    cap=$(hidden_cost capacitor)
    adb uninstall $pkg > /dev/null 2>&1
  fi
fi

if ! result=$(adb install -r "$apk" 2>&1); then
  echo "$result"
  if grep -qE 'INSTALL_FAILED|INSTALL_PARSE_FAILED|Failure \[' <<< "$result"; then verdict "fail: the APK did not install"; fi
  exit 1
fi
adb shell pm grant $pkg android.permission.POST_NOTIFICATIONS > /dev/null 2>&1 || true

adb logcat -c
total=$(adb shell am start -W -n $pkg/dev.dioxus.main.MainActivity | tr -d '\r' | awk -F': ' '/TotalTime/ {print $2}')
for _ in $(seq 1 60); do adb logcat -d -s Inyon:I | grep -q "core ready" && break; sleep 1; done
sleep 10
pid=$(adb shell pidof $pkg | tr -d '\r')
log="$out/logcat.txt"
adb logcat -d -v threadtime > "$log"
adb exec-out screencap -p > "$out/screen.png" || true
adb shell uiautomator dump /sdcard/ui.xml > /dev/null 2>&1
adb shell cat /sdcard/ui.xml > "$out/ui.xml" 2>/dev/null || true

mine=$(awk -v p="${pid:-none}" '$3 == p' "$log")
problems=()
if grep -qE "FATAL EXCEPTION|ANR in $pkg" "$log" && grep -qE "Process: $pkg|ANR in $pkg" "$log"; then problems+=("the app crashed"); fi
grep -qE 'Fatal signal|SIGSEGV|SIGABRT' <<< "$mine" && problems+=("the Rust side crashed")
grep -qE 'panicked at' "$log" && problems+=("Rust panicked")
[ -n "$pid" ] || problems+=("the app is not running")
if grep -qE 'ClassNotFoundException|NoClassDefFoundError|NoSuchMethodError|NoSuchMethodException|NoSuchFieldError|AbstractMethodError|UnsatisfiedLinkError' <<< "$mine"; then
  problems+=("missing classes, methods or native functions (R8 or JNI)")
fi
grep -qE 'Inyon *: core ready' <<< "$mine" || problems+=("the phone core did not start")
grep -q 'android.webkit.WebView' "$out/ui.xml" || problems+=("no WebView on screen")
note "Cold start after install: ${total:-?} ms (am start TotalTime)"
note ""

if [ ${#problems[@]} -eq 0 ]; then
  adb shell am force-stop $pkg
  app=$(hidden_cost app)
  note "While hidden and idle with no machine: two minutes after a minute's settling, from /proc on the emulator ($hz Hz ticks)."
  note ""
  note "| build | app CPU ms | app context switches | with the WebView: CPU ms | with the WebView: switches |"
  note "|---|---|---|---|---|"
  row() { read -r a b c d <<< "$2"; note "| $1 | ${a:-?} | ${b:-?} | ${c:-?} | ${d:-?} |"; }
  [ -n "$before" ] && row "Capacitor (this branch)" "$cap"
  row "Dioxus (from 1.0)" "$app"
  note ""
  [ -n "$before" ] && note "Capacitor's busiest threads: $(busiest capacitor)"
  note "Dioxus's busiest threads: $(busiest app)"
  verdict "pass"
else
  verdict "fail: $(IFS=';'; echo "${problems[*]}")"
fi
