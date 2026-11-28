#!/bin/sh
# The whole Compass Maestro suite (.maestro/config.yaml) on an iOS simulator, kiosk and offline flows
# included (A66). Grants the permissions the flows need, starts the network helper that stands in for
# airplane mode (scripts/maestro-network.ts), and runs every flow in order. supervisor-kiosk registers
# its own kiosk and PIN (.maestro/scripts/kiosk-device.js) unless KIOSK_DEVICE_KEY is set.
#
# Needs a freshly reset local stack with the demo seed, a Compass build against it installed on the
# simulator, and in the environment: SUPABASE_URL, SUPABASE_ANON_KEY, XOS_SUPABASE_STACK (the stack's
# project_id), XOS_DEMO_PASSWORD (from supabase/seeds/0010_demo_identity.sql) and UDID. Extra arguments
# go to maestro test (for example a single flow file instead of the folder). Maestro drives every iOS
# simulator through host port 7001; when another run may be going on this Mac, set MAESTRO_DRIVER_PORT
# to a free port so the two never send each other's taps.
set -eu
cd "$(dirname "$0")/.."
: "${SUPABASE_URL:?}" "${SUPABASE_ANON_KEY:?}" "${XOS_SUPABASE_STACK:?}" "${XOS_DEMO_PASSWORD:?}" "${UDID:?}"
APP=pro.ghxstship.compass
for service in location-always camera microphone photos; do
  xcrun simctl privacy "$UDID" grant "$service" "$APP"
done
node --experimental-strip-types --no-warnings scripts/maestro-network.ts serve &
helper=$!
# Stopping the helper starts the gateway again, so an interrupted run never leaves the stack down.
trap 'kill "$helper" 2>/dev/null || true' EXIT
trap 'exit 130' INT TERM
sleep 1
# field-gate-in-out-override scans the Demo Field Lead's CREW badge (seed 0217); the database issues its number.
if [ -z "${BADGE:-}" ]; then
  BADGE="$(docker exec -i "supabase_db_$XOS_SUPABASE_STACK" psql -U postgres -d postgres -X -qAt -c \
    "select credential_number from app.credentials where holder_person_id = '01920000-0000-7000-8000-000000000104' and credential_category_id = '01920000-0000-7000-8000-000000217041' and deleted_at is null")"
fi
# field-door-guest-pass reads the pass of Avery Brooks, the Approved guest of seed 0229 whom no seed checks in.
if [ -z "${PASS:-}" ]; then
  PASS="$(docker exec -i "supabase_db_$XOS_SUPABASE_STACK" psql -U postgres -d postgres -X -qAt -c \
    "select pass_code from app.guest_list_entries where id = '01920000-0000-7000-8000-000002290101' and entry_state = 'Approved' and deleted_at is null")"
fi
if [ "$#" -eq 0 ]; then set -- .maestro; fi
maestro --device "$UDID" ${MAESTRO_DRIVER_PORT:+--port "$MAESTRO_DRIVER_PORT"} test \
  -e XOS_DEMO_PASSWORD="$XOS_DEMO_PASSWORD" \
  -e SUPABASE_URL="$SUPABASE_URL" \
  -e SUPABASE_ANON_KEY="$SUPABASE_ANON_KEY" \
  -e BADGE="$BADGE" \
  -e PASS="$PASS" \
  ${KIOSK_DEVICE_KEY:+-e KIOSK_DEVICE_KEY="$KIOSK_DEVICE_KEY"} \
  ${KIOSK_DEVICE_KEY:+-e KIOSK_PIN_1="$KIOSK_PIN_1" -e KIOSK_PIN_2="$KIOSK_PIN_2"} \
  ${KIOSK_DEVICE_KEY:+-e KIOSK_PIN_3="$KIOSK_PIN_3" -e KIOSK_PIN_4="$KIOSK_PIN_4"} \
  "$@"
