#!/bin/sh
# A59 visual review: builds Compass (Release, JavaScript bundle embedded) for the iOS simulator against
# this worktree's Supabase stack and production servers, then installs it on the simulator.
#   UDID      simulator (default: the iPhone 17 Pro the review used)
#   A59_PORT_BLOCK  Supabase port block (default 583, the xos4-a59 stack)
set -u
root="$(cd "$(dirname "$0")/../../../.." && pwd)"
logs="$root/legal/qa/visual-review/shots/logs"
udid="${UDID:-2CC2A887-BE36-46B7-92E5-36F9C4060B40}"
block="${A59_PORT_BLOCK:-583}"
mkdir -p "$logs"
anon="$(sed -n 's/^SUPABASE_ANON_KEY=//p' "$root/apps/atlas/.env.local")"
export EXPO_PUBLIC_SUPABASE_URL="http://127.0.0.1:${block}21"
export EXPO_PUBLIC_SUPABASE_ANON_KEY="$anon"
export EXPO_PUBLIC_ATLAS_URL="http://127.0.0.1:3059"
export EXPO_PUBLIC_GATEWAY_URL="http://127.0.0.1:3159"
export RCT_NO_LAUNCH_PACKAGER=1
export LANG=en_US.UTF-8
export PATH="$HOME/.local/bin:$PATH"
cd "$root/apps/compass/ios" || exit 1
xcodebuild -workspace Compass.xcworkspace -scheme Compass -configuration Release \
  -sdk iphonesimulator -destination "id=$udid" -derivedDataPath build \
  ARCHS=arm64 ONLY_ACTIVE_ARCH=YES COMPILER_INDEX_STORE_ENABLE=NO build > "$logs/compass-xcodebuild.log" 2>&1
status=$?
echo "xcodebuild=$status"
[ "$status" -eq 0 ] || exit "$status"
app="$(find build/Build/Products/Release-iphonesimulator -maxdepth 1 -name 'Compass.app' | head -1)"
xcrun simctl boot "$udid" 2>/dev/null
xcrun simctl install "$udid" "$app"
echo "install=$?"
for p in location-always camera microphone photos; do
  xcrun simctl privacy "$udid" grant "$p" pro.ghxstship.compass 2>/dev/null
done
echo "app=$app"
