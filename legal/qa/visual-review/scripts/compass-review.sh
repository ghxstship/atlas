#!/bin/sh
# A59 visual review: runs the Compass review flows (maestro/*-review.yaml) on the iOS simulator against
# the Release build from compass-build.sh. Screenshots land in shots/compass/<flow>/.
#   compass-review.sh [field|crew]
set -u
root="$(cd "$(dirname "$0")/../../../.." && pwd)"
udid="${UDID:-2CC2A887-BE36-46B7-92E5-36F9C4060B40}"
export JAVA_HOME="${JAVA_HOME:-$HOME/.jdks/jdk-17.0.20.1+1/Contents/Home}"
export PATH="$JAVA_HOME/bin:$HOME/.maestro/bin:$PATH"
export MAESTRO_CLI_NO_ANALYTICS=1
password="$(sed -n "s/.*extensions\.crypt('\([^']*\)'.*/\1/p" "$root/supabase/seeds/0010_demo_identity.sql" | head -1)"
for flow in ${1:-field crew}; do
  out="$root/legal/qa/visual-review/shots/compass/$flow"
  mkdir -p "$out"
  cd "$out" || exit 1
  maestro --device "$udid" test -e XOS_DEMO_PASSWORD="$password" \
    "$root/legal/qa/visual-review/scripts/maestro/$flow-review.yaml" > "$out/maestro.log" 2>&1
  echo "$flow exit=$? shots=$(ls "$out"/*.png 2>/dev/null | wc -l | tr -d ' ')"
done
