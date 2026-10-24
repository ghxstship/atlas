#!/bin/sh
# Puts a local Supabase stack on the visual clock (Section 18, gate 9).
#
#   packages/testing/ci/visual-clock.sh [directory holding supabase/]
#
# The core-screen baselines are a picture of the demo tenant at one instant, VISUAL_NOW. On the real
# clock the shots followed the date of the run: the seed dates some rows from the reset (today's
# shifts, the Field Tech's last two days, credentials valid for 30 days) and keeps the demo event on
# fixed dates in March 2027, so "this week", "today" and "overdue" covered different rows on
# different days. Here every clock that decides what a screen shows stands at VISUAL_NOW instead:
#
#   1. The database is reset to the platform base (0207) and Postgres restarts with its clock at
#      VISUAL_NOW (packages/testing/clock/pg-clock.sh, libfaketime).
#   2. The other migrations run, so partitions and other "now" defaults are made at that time.
#   3. Postgres restarts at VISUAL_NOW again and the seed loads, so it starts at the same moment
#      however long the migrations took.
#
# It prints E2E_CLOCK_OFFSET_MS=<ms>, the shift from the real clock, on stdout (everything else goes
# to stderr), for $GITHUB_ENV or `export`. Start next dev with that variable and
# NODE_OPTIONS="--require <repo>/packages/testing/clock/node-clock.cjs", and pass it to
# visual-in-container.sh, whose browsers follow it (apps/<app>/e2e/visual/stable.ts). The clock runs
# on from VISUAL_NOW, and `supabase stop` or `supabase db reset` put the stack back on the real clock.
#
# VISUAL_NOW is a Wednesday afternoon in New York, the demo tenant's zone: the week around it holds
# the seed's dates from the reset, the date is the same in UTC, and no daylight saving change or
# month end is near. It lies in the past on purpose: the auth server and PostgREST keep the real
# clock, so the tokens they issue look fresh to the shifted clocks (pg-clock.sh). Changing it
# changes every core-screen baseline.
#
# Only for a local stack you own; the container is supabase_db_<project_id> from config.toml.
set -eu

VISUAL_NOW=2026-10-21T18:00:00Z

root=$(cd "$(dirname "$0")/../../.." && pwd)
workdir=$(cd "${1:-$root}" && pwd)
project=$(sed -n 's/^project_id = "\(.*\)"$/\1/p' "$workdir/supabase/config.toml")
container="supabase_db_$project"
clock="$root/packages/testing/clock/pg-clock.sh"

supabase db reset --workdir "$workdir" --local --version 0207 --no-seed >&2
"$clock" at "$container" "$VISUAL_NOW" >&2
supabase migration up --workdir "$workdir" --local > /dev/null
offset=$("$clock" at "$container" "$VISUAL_NOW" | tee /dev/stderr | sed -n 's/^export E2E_CLOCK_OFFSET_MS=//p')
if [ -z "$offset" ]; then
  echo "visual-clock.sh: pg-clock.sh printed no offset" >&2
  exit 1
fi
supabase db push --workdir "$workdir" --local --include-seed --yes >&2
echo "E2E_CLOCK_OFFSET_MS=$offset"
