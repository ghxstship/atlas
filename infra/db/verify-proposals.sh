#!/usr/bin/env bash
# Verifies the partition proposals on a restored drill copy, never on a shared or hosted database.
#
#   infra/drills/restore-drill.sh --dump <file> --keep      # prints the container name
#   infra/db/verify-proposals.sh <xos4-drill-restore-...>
#
# Runs the pgTAP suites that touch time_entries, applies the remaining proposal in one transaction
# (private.partition_existing_table is migration 1510; access_scans was converted by 1511), checks the
# result is partitioned and registered, and runs the same suites again. Passes only when every suite
# gives the same result before and after. The copy must be at migration 1511 or later.

source "$(dirname "$0")/../drills/lib.sh"

TARGET="${1:-}"
[[ "$TARGET" == ${DRILL_PREFIX}* ]] || die "Pass the name of a restore drill container (${DRILL_PREFIX}*)."
require_local_docker
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
SUITES="${XOS_PROPOSAL_SUITES:-0340_crew 0352_assets_credentials 0365_clock_punches 0460_crew_lifecycle 0470_credentials_incidents_field 0592_kiosk_punch_record_punch 0940_external_crew_time 0941_record_punch 0943_rls_benchmark_fixes 0981_people_crew_late 1000_external_crew_time}"

copy_tests "$TARGET" "$REPO"

run_suites() {
  for suite in $SUITES; do
    [[ -f "$REPO/supabase/tests/${suite}.test.sql" ]] || die "Missing suite ${suite}."
    local out
    out="$(run_test "$TARGET" "${suite}.test.sql")"
    echo "${suite} ok=$(echo "$out" | grep -c '^ok' || true) not_ok=$(echo "$out" | grep -c '^not ok' || true) errors=$(echo "$out" | grep -c 'ERROR' || true)"
  done
}

BEFORE="$(run_suites)"
echo "$BEFORE" | sed 's/^/before: /'

{
  echo "begin;"
  echo "set local role postgres;"
  cat "$REPO"/infra/db/proposals/03_partition_time_entries.sql
  echo "commit;"
} | psql_in "$TARGET" >/dev/null

STRUCTURE="$(psql_in "$TARGET" -tA <<'SQL'
select format('%s kind=%s partitions=%s registered=%s', c.oid::regclass, c.relkind,
  (select count(*) from pg_inherits i where i.inhparent = c.oid),
  exists (select 1 from private.partitioned_tables p where p.table_name = c.oid::regclass::text))
from pg_class c where c.oid in ('app.time_entries'::regclass, 'app.access_scans'::regclass) order by 1;
SQL
)"
echo "$STRUCTURE" | sed 's/^/after: /'
echo "$STRUCTURE" | grep -q "app.time_entries kind=p .* registered=t" || die "time_entries is not partitioned and registered."
echo "$STRUCTURE" | grep -q "app.access_scans kind=p .* registered=t" || die "access_scans is not partitioned and registered."

AFTER="$(run_suites)"
echo "$AFTER" | sed 's/^/after: /'
if [[ "$BEFORE" != "$AFTER" ]]; then
  diff <(echo "$BEFORE") <(echo "$AFTER") || true
  die "Suite results changed after the proposals."
fi
echo "Proposals verified: same suite results before and after on ${TARGET}."
