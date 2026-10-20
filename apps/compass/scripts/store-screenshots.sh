#!/bin/sh
# Compass store screenshots (RRR-113). Captures the App Store (iPhone 6.9-inch and 6.5-inch) and Google
# Play phone screenshots in English and Spanish from the iOS simulator, against a LOCAL Supabase stack
# reset to the demo seed, and writes them under apps/compass/store/. Nothing here signs in to Apple,
# Google or Expo.
#
# Before running:
#   1. A local stack for this checkout (`supabase start` with the full seed). The script RESETS it.
#   2. A Release simulator build of Compass against that stack, for example
#      legal/qa/visual-review/scripts/compass-prebuild.sh and compass-build.sh with your port block; set
#      APP to the built Compass.app.
#   3. Two simulators of your own, never one another person or agent is using:
#        xcrun simctl create "Compass store 6.9" com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro-Max <runtime>
#        xcrun simctl create "Compass store 6.5" com.apple.CoreSimulator.SimDeviceType.iPhone-11-Pro-Max <runtime>
#      and pass their UDIDs as UDID_69 and UDID_65. Delete them afterwards.
#   4. Maestro, a JDK 17 (JAVA_HOME) and Pillow for python3.
#
#   APP=... UDID_69=... UDID_65=... SUPABASE_PORT=55421 [LANGUAGES="en-US es-US"] apps/compass/scripts/store-screenshots.sh
#
# Maestro's iOS driver listens on a port of the host, which every simulator shares, and it defaults to
# 7001 for every session. Two sessions on one port send each other's taps to the wrong simulator, so
# this script gives each of its simulators a driver port of its own (Maestro's hidden --port option):
# MAESTRO_PORT (default 7268) for the 6.9-inch simulator and the next port for the 6.5-inch one.
set -u
here="$(cd "$(dirname "$0")" && pwd)"
compass="$(cd "$here/.." && pwd)"
root="$(cd "$compass/../.." && pwd)"
: "${APP:?set APP to the Release Compass.app built against the local stack}"
: "${UDID_69:?set UDID_69 to an iPhone 6.9-inch simulator of your own}"
: "${UDID_65:?set UDID_65 to an iPhone 6.5-inch simulator of your own}"
port="${SUPABASE_PORT:-55421}"
driver_port="${MAESTRO_PORT:-7268}"
work="${WORK_DIR:-$(mktemp -d)}"

cd "$root" || exit 1
project="$(sed -n 's/^project_id = "\(.*\)"$/\1/p' supabase/config.toml)"
echo "Resetting the local stack $project to the demo seed"
supabase db reset > "$work/db-reset.log" 2>&1 || { echo "supabase db reset failed: $work/db-reset.log" >&2; exit 1; }
# Moves the show and an open shift to today, relative to now; run before each capture.
stage() { docker exec -i "supabase_db_$project" psql -U postgres -v ON_ERROR_STOP=1 -q < "$here/store-screenshots.sql"; }

password="$(sed -n "s/.*extensions\.crypt('\([^']*\)'.*/\1/p" supabase/seeds/0010_demo_identity.sql | head -1)"
anon="$(supabase status -o env 2>/dev/null | sed -n 's/^ANON_KEY="\(.*\)"$/\1/p')"
export PATH="${JAVA_HOME:+$JAVA_HOME/bin:}$HOME/.maestro/bin:$PATH"
export MAESTRO_CLI_NO_ANALYTICS=1

prepare() { # udid language locale
  xcrun simctl boot "$1" 2> /dev/null
  # A driver left running by an earlier session on either simulator keeps its port; remove both.
  for u in "$UDID_69" "$UDID_65"; do
    xcrun simctl uninstall "$u" dev.mobile.maestro-driver-iosUITests.xctrunner 2> /dev/null
  done
  xcrun simctl spawn "$1" defaults write -g AppleLanguages -array "$2"
  xcrun simctl spawn "$1" defaults write -g AppleLocale -string "$3"
  # Keep the keyboard from autocorrecting the text the flow types.
  xcrun simctl spawn "$1" defaults write com.apple.Preferences KeyboardAutocorrection -bool NO
  xcrun simctl install "$1" "$APP" || exit 1
  for p in location camera microphone notifications; do
    xcrun simctl privacy "$1" grant "$p" pro.ghxstship.compass 2> /dev/null
  done
  xcrun simctl ui "$1" appearance light
  xcrun simctl status_bar "$1" override --time "9:41" --dataNetwork wifi --wifiMode active --wifiBars 3 \
    --cellularMode active --cellularBars 4 --operatorName "" --batteryState charged --batteryLevel 100
}

status=0
for run in "en-US en_US en-US en-US" "es-US es_US es-MX es-US"; do
  set -- $run
  language="$1" locale="$2" apple="$3" play="$4"
  title="Loose cable cover at Bar 2"
  [ "$language" = "es-US" ] && title="Tapa de cable suelta en la Barra 2"
  case " ${LANGUAGES:-en-US es-US} " in
    *" $language "*) ;;
    *) continue ;;
  esac
  for device in "$UDID_69 APP_IPHONE_67 $driver_port" "$UDID_65 APP_IPHONE_65 $((driver_port + 1))"; do
    set -- $device
    udid="$1" display="$2" maestro_port="$3"
    out="$work/$language-$display"
    mkdir -p "$out"
    prepare "$udid" "$language" "$locale"
    stage || exit 1
    (cd "$out" && maestro --port "$maestro_port" --device "$udid" test -e XOS_DEMO_PASSWORD="$password" \
      -e SUPABASE_URL="http://127.0.0.1:$port" -e SUPABASE_ANON_KEY="$anon" -e INCIDENT_TITLE="$title" \
      "$compass/.maestro/store/screenshots.yaml" > "$out/maestro.log" 2>&1)
    code=$?
    echo "maestro $language $display: exit $code ($out/maestro.log)"
    [ "$code" -eq 0 ] || { status=1; continue; }
    python3 "$here/store-screenshots.py" "$out" "$display" "$apple" "$play" "$compass/store" || status=1
  done
done
echo "Raw captures and logs: $work"
exit "$status"
