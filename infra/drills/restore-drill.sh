#!/usr/bin/env bash
# Restore drill (Section 9: verified by a restore drill script; targets 1 hour RPO, 4 hour RTO).
#
#   infra/drills/restore-drill.sh --dump <file.dump> [--pgtap "<files in supabase/tests>"] [--keep]
#
# Restores a backup-drill dump into a fresh, throwaway Postgres container built from the same
# Supabase image as the source, then proves the restore:
#   1. the archive checksum matches its manifest;
#   2. the latest applied migration matches;
#   3. every table in the XOS schemas has exactly the source row count;
#   4. the key tables in key-tables.sql have the source row count and content checksum;
#   5. the chosen pgTAP suites pass on the restored copy (default: the foundation and canon suites,
#      including the Playbook round trip, which hashes every canon sheet).
# Prints a report with the measured restore time against the 4 hour RTO, and removes the container
# unless --keep is given. Exits non-zero when any check fails.

source "$(dirname "$0")/lib.sh"

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
DUMP=""
KEEP="no"
PGTAP="0001_foundation.test.sql 0100_xpms_canon.test.sql 0109_xpms_playbook_roundtrip.test.sql"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dump) DUMP="$2"; shift 2 ;;
    --pgtap) PGTAP="$2"; shift 2 ;;
    --keep) KEEP="yes"; shift ;;
    *) die "Unknown argument $1" ;;
  esac
done

[[ -f "$DUMP" ]] || die "Pass --dump <file> from backup-drill.sh."
MANIFEST="${DUMP%.dump}.manifest"
[[ -f "$MANIFEST" && -f "$MANIFEST.counts" && -f "$MANIFEST.roles" ]] || die "Manifest ${MANIFEST} (with .counts and .roles) not found next to the dump."
require_tools
require_local_docker

field() { grep "^$1=" "$MANIFEST" | head -1 | cut -d= -f2-; }
IMAGE="$(field image)"
# The CLI pulls Supabase Postgres from public.ecr.aws, GitHub's registry or Docker Hub, depending on where it runs.
[[ "$IMAGE" =~ ^((public\.ecr\.aws|ghcr\.io)/)?supabase/postgres:[0-9.]+$ ]] || die "Manifest image ${IMAGE} is not a Supabase Postgres image."

FAILURES=0
fail() {
  echo "FAIL: $*"
  FAILURES=$((FAILURES + 1))
}

STARTED="$(now_epoch)"
[[ "$(shasum -a 256 "$DUMP" | cut -d' ' -f1)" == "$(field sha256)" ]] || die "Checksum mismatch: the archive changed since the backup."
echo "ok: checksum"

TARGET="${DRILL_PREFIX}restore-$(date -u +%Y%m%d%H%M%S)"
trap '[[ "$KEEP" == "yes" ]] || remove_drill_container "$TARGET"' EXIT
PASSWORD="$(openssl rand -hex 24)"
docker run -d --name "$TARGET" --label xos.drill=restore -e POSTGRES_PASSWORD="$PASSWORD" "$IMAGE" >/dev/null
unset PASSWORD

READY="no"
for _ in $(seq 1 90); do
  if docker exec "$TARGET" pg_isready -U postgres -h localhost >/dev/null 2>&1 &&
    psql_in "$TARGET" -tA -c "select 1" >/dev/null 2>&1; then
    READY="yes"
    break
  fi
  sleep 2
done
[[ "$READY" == "yes" ]] || die "The restore target did not become ready."
# The image runs its init scripts once more after the first ready signal; wait for them to settle.
sleep 5
until psql_in "$TARGET" -tA -c "select 1" >/dev/null 2>&1; do sleep 2; done

# Roles created by Supabase services rather than the image (Realtime, for one) are created without
# login and without a password, so ownership and grants in the archive restore exactly.
while read -r role; do
  [[ "$role" =~ ^[a-z_][a-z0-9_]*$ ]] || die "Unexpected role name in the manifest."
  psql_in "$TARGET" </dev/null -c "do \$\$ begin if not exists (select 1 from pg_roles where rolname = '${role}') then create role ${role} nologin; end if; end \$\$;"
done <"$MANIFEST.roles"

# The fresh image already holds Supabase's own schemas (auth, storage, extensions, vault). Restore
# replaces them from the archive so the copy matches the source exactly. Any pg_restore error fails
# the drill and is listed.
RESTORE_LOG="$(mktemp)"
set +e
docker exec -i "$TARGET" pg_restore -U supabase_admin -h localhost -d postgres --clean --if-exists \
  <"$DUMP" >"$RESTORE_LOG" 2>&1
set -e
RESTORE_ERRORS="$(grep -c '^pg_restore: error' "$RESTORE_LOG" || true)"
RESTORED_AT="$(now_epoch)"
if [[ "$RESTORE_ERRORS" == "0" ]]; then
  echo "ok: pg_restore reported no errors"
else
  fail "pg_restore reported ${RESTORE_ERRORS} errors:"
  grep -A1 '^pg_restore: error' "$RESTORE_LOG" | grep -v '^--$' | sort | uniq -c | sort -rn | head -20
fi

SOURCE_MIGRATION="$(field latest_migration)"
TARGET_MIGRATION="$(latest_migration "$TARGET")"
if [[ "$SOURCE_MIGRATION" == "$TARGET_MIGRATION" ]]; then
  echo "ok: latest migration ${TARGET_MIGRATION}"
else
  fail "latest migration ${TARGET_MIGRATION}, expected ${SOURCE_MIGRATION}"
fi

COUNTS="$(mktemp)"
table_counts "$TARGET" >"$COUNTS"
DIFF="$(diff "$MANIFEST.counts" "$COUNTS" || true)"
if [[ -z "$DIFF" ]]; then
  echo "ok: row counts match in $(wc -l <"$COUNTS" | tr -d ' ') tables"
else
  fail "row counts differ (source <, restored >):"
  echo "$DIFF" | head -40
fi

if [[ -f "$MANIFEST.checksums" ]]; then
  SUMS="$(mktemp)"
  key_table_checksums "$TARGET" >"$SUMS"
  SUM_DIFF="$(diff "$MANIFEST.checksums" "$SUMS" || true)"
  if [[ -z "$SUM_DIFF" ]]; then
    echo "ok: row counts and content checksums match in $(wc -l <"$SUMS" | tr -d ' ') key tables"
  else
    fail "key-table checksums differ (source <, restored >):"
    echo "$SUM_DIFF" | head -40
  fi
else
  echo "skip: key-table checksums (the manifest predates them)"
fi

copy_tests "$TARGET" "$REPO"
for file in $PGTAP; do
  [[ -f "$REPO/supabase/tests/$file" ]] || { fail "pgTAP file ${file} not found"; continue; }
  OUTPUT="$(run_test "$TARGET" "$file")"
  NOT_OK="$(echo "$OUTPUT" | grep -c '^not ok' || true)"
  OK="$(echo "$OUTPUT" | grep -c '^ok' || true)"
  if [[ "$NOT_OK" == "0" && "$OK" != "0" ]] && ! echo "$OUTPUT" | grep -q 'ERROR'; then
    echo "ok: ${file} (${OK} assertions)"
  else
    fail "${file}: ${OK} ok, ${NOT_OK} not ok"
    echo "$OUTPUT" | grep -E '^not ok|ERROR' | head -10
  fi
done

FINISHED="$(now_epoch)"
RTO_SECONDS=$((FINISHED - STARTED))
echo "report: restore_seconds=$((RESTORED_AT - STARTED)) verified_seconds=${RTO_SECONDS} rto_target_seconds=14400"
echo "report: backup_created_at=$(field created_at) newest_audit_event=$(field newest_audit_event)"
if ((RTO_SECONDS > 14400)); then fail "restore took longer than the 4 hour RTO"; fi

if ((FAILURES > 0)); then
  echo "Restore drill FAILED with ${FAILURES} failing checks."
  exit 1
fi
echo "Restore drill passed."
if [[ "$KEEP" == "yes" ]]; then echo "kept: ${TARGET}"; fi
