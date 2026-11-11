#!/bin/sh
# Compass component gallery snapshots (A141, S11.4-01). Runs .maestro/flows/gallery-dark.yaml and
# gallery-light.yaml on an iOS simulator and compares every page with .maestro/gallery/baselines through
# scripts/gallery-compare.ts, which documents the tolerance. Needs no Supabase stack and signs in nowhere.
#
#   APP=.../Compass.app UDID=<simulator> apps/compass/scripts/gallery-snapshots.sh            compare
#   APP=.../Compass.app UDID=<simulator> apps/compass/scripts/gallery-snapshots.sh --update   re-record
#
#   APP           a Compass build made with EXPO_PUBLIC_XOS_GALLERY=1 (Release for the simulator, as in
#                 .maestro/gallery/README.md); any other build has no gallery.
#   UDID          a simulator of your own, of the device type and runtime in baselines/manifest.json,
#                 never one another person or agent is using.
#   OUT           where the captures, the Maestro logs and any .diff.png land (default: a new temp folder).
#   MAESTRO_PORT  Maestro's iOS driver port on the host (default 7341); every simulator shares the host's
#                 ports, so two runs on one port send each other's taps.
#   GALLERY_SCALE pixels per point of the simulator (default 3, every current iPhone but the SE and 16e).
#
# Rendering is pinned before the run: English, the default text size (Dynamic Type "large"), and a fixed
# status bar, which the gallery also hides. The app holds its own clock and draws no animation (see
# packages/ui-native/src/gallery).
set -u
here="$(cd "$(dirname "$0")" && pwd)"
compass="$(cd "$here/.." && pwd)"
: "${APP:?set APP to a Compass build made with EXPO_PUBLIC_XOS_GALLERY=1}"
: "${UDID:?set UDID to a simulator of your own}"
out="${OUT:-$(mktemp -d)}"
port="${MAESTRO_PORT:-7341}"
scale="${GALLERY_SCALE:-3}"
mkdir -p "$out"
export PATH="${JAVA_HOME:+$JAVA_HOME/bin:}$HOME/.maestro/bin:$PATH"
export MAESTRO_CLI_NO_ANALYTICS=1

# The simulator's device type and runtime, as the baselines' manifest names them.
device="$(xcrun simctl list devices -j | python3 -c "
import json, re, sys
for runtime, devices in json.load(sys.stdin)['devices'].items():
    for d in devices:
        if d['udid'] == '$UDID':
            version = re.sub(r'^.*SimRuntime\.([A-Za-z]+)-(.*)$', r'\1 \2', runtime).replace('-', '.')
            kind = d['deviceTypeIdentifier'].rsplit('.', 1)[-1].replace('-', ' ')
            print(json.dumps({'device': kind, 'runtime': version, 'scale': $scale}))
")"
[ -n "$device" ] || { echo "No simulator $UDID" >&2; exit 1; }
printf '%s\n' "$device" > "$out/capture.json"
echo "Simulator: $device"

xcrun simctl boot "$UDID" 2> /dev/null
xcrun simctl bootstatus "$UDID" -b > /dev/null
# A driver left by an earlier session keeps its port.
xcrun simctl uninstall "$UDID" dev.mobile.maestro-driver-iosUITests.xctrunner 2> /dev/null
xcrun simctl spawn "$UDID" defaults write -g AppleLanguages -array en-US
xcrun simctl spawn "$UDID" defaults write -g AppleLocale -string en_US
xcrun simctl ui "$UDID" content_size large
xcrun simctl ui "$UDID" appearance dark
xcrun simctl status_bar "$UDID" override --time "9:41" --dataNetwork wifi --wifiMode active --wifiBars 3 \
  --cellularMode active --cellularBars 4 --operatorName "" --batteryState charged --batteryLevel 100
xcrun simctl install "$UDID" "$APP" || exit 1
for p in location camera microphone notifications; do
  xcrun simctl privacy "$UDID" grant "$p" pro.ghxstship.compass 2> /dev/null
done

status=0
for theme in dark light; do
  (cd "$out" && maestro --port "$port" --device "$UDID" test \
    "$compass/.maestro/flows/gallery-$theme.yaml" > "$out/maestro-$theme.log" 2>&1)
  code=$?
  echo "maestro gallery-$theme: exit $code ($out/maestro-$theme.log)"
  [ "$code" -eq 0 ] || status=1
done
[ "$status" -eq 0 ] || { echo "Captures in $out" >&2; exit "$status"; }

node --experimental-strip-types --no-warnings "$here/gallery-compare.ts" "$out" "$@"
status=$?
echo "Captures in $out"
exit "$status"
