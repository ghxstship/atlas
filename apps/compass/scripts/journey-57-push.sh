#!/bin/sh
# Journey 57, the push half, on the iOS simulator (ADR 0030): starts the push helper and runs the Maestro
# flow .maestro/journeys/push-approve-timesheet.yaml, which signs in as the Demo Producer, turns on
# notifications, has the helper submit a timesheet and push its approval request, approves it from the
# banner's Approve action and has the helper confirm the timesheet is Approved.
#
# Needs a freshly seeded local stack, Atlas serving its API at EXPO_PUBLIC_ATLAS_URL for the build, a
# Compass build against the same stack on the booted simulator, and SUPABASE_URL, SUPABASE_ANON_KEY,
# XOS_DEMO_PASSWORD (from supabase/seeds/0010_demo_identity.sql) and UDID in the environment.
set -eu
cd "$(dirname "$0")/.."
node --experimental-strip-types --no-warnings scripts/journey-57-push.ts serve &
helper=$!
trap 'kill "$helper"' EXIT
sleep 1
maestro --device "$UDID" test -e XOS_DEMO_PASSWORD="$XOS_DEMO_PASSWORD" \
  .maestro/journeys/push-approve-timesheet.yaml
