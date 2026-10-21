#!/bin/sh
# Check that Compass recovers from an offline database it cannot read (A66, RRR-111; follows A68-001,
# RRR-113). iOS builds before A68-001 wrote plain SQLite; a build with SQLCipher could not read that file
# and sat on a blank screen. On an iOS simulator this script signs in, puts an old-format database where
# the app keeps its own, relaunches, and runs .maestro/journeys/old-database.yaml:
#
#   apps/compass/scripts/old-database-check.sh plain        a plain SQLite file, as a pre-A68 build left
#                                                           it, with nothing unsent: Compass opens with
#                                                           no notice
#   apps/compass/scripts/old-database-check.sh unreadable   a file no key opens (an encrypted file whose
#                                                           key the keychain lost): Compass opens, says
#                                                           once that unsent offline work could not be
#                                                           recovered, and not again after dismissal
#
# Carrying unsent writes over from a plain file is covered by test/local-database.test.ts. Needs a
# Compass build on the simulator, a seeded local stack, sqlite3, and in the environment UDID,
# SUPABASE_URL, SUPABASE_ANON_KEY and XOS_DEMO_PASSWORD (MAESTRO_DRIVER_PORT optional).
set -eu
cd "$(dirname "$0")/.."
: "${UDID:?}" "${SUPABASE_URL:?}" "${SUPABASE_ANON_KEY:?}" "${XOS_DEMO_PASSWORD:?}"
MODE="${1:-}"
case "$MODE" in plain | unreadable) ;; *)
  echo "Usage: $0 plain|unreadable" >&2
  exit 2
  ;;
esac
APP=pro.ghxstship.compass

run() {
  maestro --device "$UDID" ${MAESTRO_DRIVER_PORT:+--port "$MAESTRO_DRIVER_PORT"} test \
    -e XOS_DEMO_PASSWORD="$XOS_DEMO_PASSWORD" -e SUPABASE_URL="$SUPABASE_URL" \
    -e SUPABASE_ANON_KEY="$SUPABASE_ANON_KEY" -e MODE="$MODE" "$@"
}

# Signed in first, so the relaunch lands on Today, where the notice shows.
run .maestro/flows/field-sign-in.yaml
xcrun simctl terminate "$UDID" "$APP" 2>/dev/null || true

# op-sqlite keeps the database in the app's Library folder; the newest file is the one in use.
lib="$(xcrun simctl get_app_container "$UDID" "$APP" data)/Library"
current="$(ls -t "$lib"/compass*.sqlite | head -1)"
rm -f "$current" "$current-wal" "$current-shm"
if [ "$MODE" = plain ]; then
  sqlite3 "$current" \
    "create table xos_local_rows (table_name text not null, id text not null, data text not null, primary key (table_name, id));
     insert into xos_local_rows values ('projects', 'old-project', '{\"id\":\"old-project\"}');"
else
  head -c 65536 /dev/urandom >"$current"
fi
echo "Replaced $(basename "$current") with a $MODE old-format database."

run .maestro/journeys/old-database.yaml
