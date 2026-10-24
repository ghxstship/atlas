#!/bin/sh
# Push taps on the iOS simulator (A101): starts the push tap helper and runs the Maestro journey
# .maestro/journeys/push-tap-opens-record.yaml, which signs in as the Demo Field Lead, has the helper push a
# notification about the record NWS-14 with Compass closed and then open, taps each banner and checks that the
# record opens. Needs a freshly seeded local stack, a Compass build against it on the booted simulator, and
# XOS_DEMO_PASSWORD (from supabase/seeds/0010_demo_identity.sql) and UDID in the environment.
set -eu
cd "$(dirname "$0")/.."
node --experimental-strip-types --no-warnings scripts/push-tap.ts serve &
helper=$!
trap 'kill "$helper"' EXIT
sleep 1
maestro --device "$UDID" test -e XOS_DEMO_PASSWORD="$XOS_DEMO_PASSWORD" \
  .maestro/journeys/push-tap-opens-record.yaml
