#!/usr/bin/env bash
# Two requests at once against the session gate's own records (ADR 0169 work package 2, RRR-243).
#
#   infra/db/test/session-gate-concurrency.sh [supabase_db_<project id>]
#
# pgTAP runs on one connection, so it cannot show one request waiting on another. This script opens two connections
# to a local stack's database and holds that the second request never waits on the first:
#
#   observe   private.session_gate_observe counts every call enforce would refuse in one row for the day, control,
#             surface, organization, kind of token and reason. One member holding a write open must not make every
#             other member's call wait on that row, on its first insert of the day or afterwards. A call that finds
#             the counter busy skips the count; the log line is the complete record.
#   stamp     private.stamp_session_activity keeps one row for each session. Two requests of one session must not
#             wait on each other: not on the session's first stamp, not inside the minute in which nothing is
#             written, and not when the minute is over and one of them writes.
#
# It runs against a local Docker stack only, never a database URL. It commits one test person with one session and
# counts under a surface name of its own, and removes all of it when it exits. With no argument it uses the one
# running supabase_db_* container, which is how CI calls it after the pgTAP suites.

set -euo pipefail

die() {
  echo "session-gate-concurrency: $*" >&2
  exit 1
}

if [[ -n "${DOCKER_HOST:-}" && "${DOCKER_HOST}" != unix://* ]]; then
  die "DOCKER_HOST points at ${DOCKER_HOST}; this check only runs against a local Docker daemon."
fi

DB="${1:-}"
if [[ -z "$DB" ]]; then
  FOUND="$(docker ps --format '{{.Names}}' | grep '^supabase_db_' || true)"
  [[ -n "$FOUND" && "$(printf '%s\n' "$FOUND" | wc -l | tr -d ' ')" == "1" ]] \
    || die "Name the database container (supabase_db_<project id>); more than one local stack, or none, is running."
  DB="$FOUND"
fi
[[ "$DB" == supabase_db_* ]] || die "${DB} is not a local Supabase database container (supabase_db_*)."
docker inspect "$DB" >/dev/null 2>&1 || die "No container named ${DB} is running."

SURFACE="concurrency_check"
HOLDER="session_gate_concurrency_holder"
HOLD_SECONDS=4
FAILED=0

sql() {
  docker exec -i "$DB" psql -U postgres -d postgres -X -q -At -v ON_ERROR_STOP=1 "$@"
}

USER_ID="$(sql -c 'select gen_random_uuid()')"
SESSION_ID="$(sql -c 'select gen_random_uuid()')"
CLAIMS="select set_config('request.jwt.claims', json_build_object('sub', '${USER_ID}', 'role', 'authenticated',
  'session_id', '${SESSION_ID}', 'aal', 'aal1')::text, false);"
VERDICT="'{\"v\": 1, \"token\": \"session\", \"session\": null, \"orgs\": {},
  \"observed\": [{\"org\": null, \"control\": \"ended\", \"reason\": \"session_ended\"}]}'::jsonb"
OBSERVE="select private.session_gate_observe('${SURFACE}', ${VERDICT});"
STAMP="select private.stamp_session_activity();"

cleanup() {
  sql >/dev/null 2>&1 <<SQL || true
select pg_terminate_backend(pid) from pg_stat_activity where application_name = '${HOLDER}';
delete from private.session_gate_observations where surface = '${SURFACE}';
set session_replication_role = replica;
delete from private.session_state where session_id = '${SESSION_ID}';
delete from private.session_devices where session_id = '${SESSION_ID}';
delete from auth.sessions where id = '${SESSION_ID}';
delete from auth.users where id = '${USER_ID}';
SQL
}
trap cleanup EXIT

# One person and one live session, committed so both connections see them. Triggers are off for the two rows: the
# check needs a session row, not a profile.
sql <<SQL
set session_replication_role = replica;
insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at)
values ('${USER_ID}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
        'session-gate-concurrency-${USER_ID}@example.invalid', now(), now());
insert into auth.sessions (id, user_id, created_at, updated_at, aal)
values ('${SESSION_ID}', '${USER_ID}', now(), now(), 'aal1');
SQL

# Runs one statement on a first connection and keeps its transaction open, then runs the same statement on a second
# connection that may wait one second for a lock and no longer. Passes when the second returns without an error.
two_at_once() {
  local name="$1" statement="$2"
  sql >/dev/null <<SQL &
set application_name = '${HOLDER}';
${CLAIMS}
begin;
${statement}
select pg_sleep(${HOLD_SECONDS});
commit;
SQL
  local holder=$!
  local waited=0
  until [[ "$(sql -c "select count(*) from pg_stat_activity where application_name = '${HOLDER}' and wait_event = 'PgSleep'")" == "1" ]]; do
    sleep 0.1
    waited=$((waited + 1))
    [[ $waited -lt 100 ]] || die "${name}: the first request never reached its hold."
  done
  local output
  if output="$(sql 2>&1 <<SQL
set lock_timeout = '1s';
set statement_timeout = '3s';
${CLAIMS}
${statement}
SQL
  )"; then
    echo "ok      ${name}: the second request did not wait on the first"
  else
    echo "FAILED  ${name}: the second request waited on the first"
    echo "        ${output//$'\n'/$'\n'        }"
    FAILED=1
  fi
  wait "$holder" || die "${name}: the first request failed."
}

expect() {
  local name="$1" query="$2" want="$3" got
  got="$(sql -c "$query")"
  if [[ "$got" == "$want" ]]; then
    echo "ok      ${name}"
  else
    echo "FAILED  ${name}: expected ${want}, got ${got}"
    FAILED=1
  fi
}

COUNT="select coalesce(sum(calls), 0) from private.session_gate_observations where surface = '${SURFACE}'"

two_at_once "observe, the first row of the day" "$OBSERVE"
expect "observe: the call that found the counter busy was not counted, and the other was" "$COUNT" "1"
two_at_once "observe, a row that exists" "$OBSERVE"
expect "observe: the count is a lower bound under contention" "$COUNT" "2"
sql -c "$OBSERVE" -c "$OBSERVE" -c "$OBSERVE" >/dev/null
expect "observe: three calls one after another are all counted" "$COUNT" "5"

STATE="from private.session_state where session_id = '${SESSION_ID}'"
two_at_once "stamp, the first of a session" "$STAMP"
expect "stamp: the session has its one row" "select count(*) ${STATE}" "1"
two_at_once "stamp, inside the minute" "$STAMP"
sql -c "update private.session_state set last_activity_at = now() - interval '2 minutes' where session_id = '${SESSION_ID}'"
two_at_once "stamp, after the minute" "$STAMP"
expect "stamp: the request that held the row recorded the activity for both" \
  "select last_activity_at > now() - interval '1 minute' ${STATE}" "t"

if [[ $FAILED -ne 0 ]]; then
  die "at least one request waited on another."
fi
echo "session-gate-concurrency: no request waited on another."
