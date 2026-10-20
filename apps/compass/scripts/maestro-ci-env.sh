#!/bin/sh
# Prepares a Maestro run of apps/compass/.maestro against the local stack `supabase start` built, and
# prints the variables the flows read, one KEY=value per line (append them to $GITHUB_ENV in CI):
#
#   apps/compass/scripts/maestro-ci-env.sh >> "$GITHUB_ENV"
#
#   SUPABASE_URL, SUPABASE_ANON_KEY   the flows' helper scripts call the API from the host
#   KIOSK_DEVICE_KEY                  a kiosk registered for the demo org (supervisor-kiosk)
#   KIOSK_PIN_1 .. KIOSK_PIN_4        the Demo Field Tech's kiosk PIN, one digit each
#
# The kiosk is registered and the PIN set as the Demo Admin (org.time_attendance.write), through the
# same functions Atlas calls (app.register_kiosk_device, app.set_kiosk_pin), in one transaction. Ids
# are the fixed demo ids of supabase/seeds/0000_demo_tenant_conventions.sql. Local stack only: the
# device key is fixture data of a stack that lives for one CI job.
set -eu

DEMO_ORG="01920000-0000-7000-8000-000000000001"
DEMO_ADMIN="01920000-0000-7000-8000-000000000102"
FIELD_TECH_MEMBERSHIP="01920000-0000-7000-8000-00000000a106"
PIN="${KIOSK_PIN:-2468}"

status="$(supabase status -o env 2>/dev/null)"
api_url="$(printf '%s\n' "$status" | sed -n 's/^API_URL="\(.*\)"$/\1/p')"
anon_key="$(printf '%s\n' "$status" | sed -n 's/^ANON_KEY="\(.*\)"$/\1/p')"
if [ -z "$api_url" ] || [ -z "$anon_key" ]; then
  echo "No local stack: run supabase start first." >&2
  exit 1
fi
project_id="$(sed -n 's/^project_id = "\(.*\)"$/\1/p' supabase/config.toml)"
db="supabase_db_${project_id}"

device_key="$(
  docker exec -i "$db" psql -U postgres -d postgres -X -qAt -v ON_ERROR_STOP=1 <<SQL | grep '^xkio_'
begin;
select set_config('request.jwt.claims', '{"sub": "$DEMO_ADMIN", "role": "authenticated"}', true);
set local role authenticated;
select app.set_kiosk_pin('$FIELD_TECH_MEMBERSHIP', '$PIN');
select device_key from app.register_kiosk_device('$DEMO_ORG', 'Maestro CI kiosk');
commit;
SQL
)"
if [ -z "$device_key" ]; then
  echo "Registering the kiosk returned no device key." >&2
  exit 1
fi

echo "SUPABASE_URL=$api_url"
echo "SUPABASE_ANON_KEY=$anon_key"
echo "KIOSK_DEVICE_KEY=$device_key"
i=1
for digit in $(printf '%s' "$PIN" | cut -c1-4 | sed 's/./& /g'); do
  echo "KIOSK_PIN_$i=$digit"
  i=$((i + 1))
done
