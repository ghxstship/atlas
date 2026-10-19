#!/usr/bin/env bash
# Release restore drill (Section 20.3: "backups and a verified restore drill"; Wave 7).
#
#   infra/drills/release-drill.sh [--source supabase_db_xos4-<id>] [--out <dir>] [--pgtap "<files>"]
#
# One command, end to end, against a local stack only:
#   1. backup-drill.sh takes a pg_dump of the source stack with a manifest of every table's row
#      count and the key-table checksums (key-tables.sql);
#   2. restore-drill.sh restores it into a fresh throwaway container of the same image and verifies
#      the archive checksum, a clean pg_restore, the latest migration, every row count, every key-table
#      checksum and the pgTAP smoke suites, against the 4 hour RTO.
# Writes the whole log as the drill report, <out>/release-drill-<stamp>.txt, headed by the commit and
# the source, for the release checklist. Exits non-zero when any check fails.
#
# The source defaults to this checkout's own stack: supabase_db_<project_id> from supabase/config.toml.
# A point-in-time recovery is verified differently (it restores into a new hosted project); see
# infra/runbooks/backup-and-restore.md.

source "$(dirname "$0")/lib.sh"

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
PROJECT_ID="$(sed -n 's/^project_id = "\(.*\)"$/\1/p' "$REPO/supabase/config.toml" | head -1)"
SOURCE="supabase_db_${PROJECT_ID}"
OUT="${TMPDIR:-/tmp}/xos-drills"
PGTAP="0001_foundation.test.sql 0100_xpms_canon.test.sql 0109_xpms_playbook_roundtrip.test.sql 9900_security_catalog.test.sql"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --source) SOURCE="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --pgtap) PGTAP="$2"; shift 2 ;;
    *) die "Unknown argument $1" ;;
  esac
done

require_tools
require_local_docker
require_source_container "$SOURCE"
mkdir -p "$OUT"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
REPORT="$OUT/release-drill-$STAMP.txt"
COMMIT="$(cd "$REPO" && git rev-parse --short HEAD 2>/dev/null || echo unknown)"

set +e
{
  echo "XOS release restore drill"
  echo "date=$(date -u +%Y-%m-%dT%H:%M:%SZ) commit=${COMMIT} source=${SOURCE}"
  echo
  echo "== Backup"
  BACKUP_LOG="$("$REPO/infra/drills/backup-drill.sh" --source "$SOURCE" --out "$OUT")"
  BACKUP_STATUS=$?
  echo "$BACKUP_LOG"
  if [[ "$BACKUP_STATUS" != "0" ]]; then
    echo "Release drill FAILED: the backup did not complete."
    exit 1
  fi
  DUMP="$(echo "$BACKUP_LOG" | sed -n 's/^dump=//p' | tail -1)"
  echo
  echo "== Restore and verify"
  "$REPO/infra/drills/restore-drill.sh" --dump "$DUMP" --pgtap "$PGTAP"
  RESTORE_STATUS=$?
  echo
  if [[ "$RESTORE_STATUS" == "0" ]]; then
    echo "Release drill passed."
  else
    echo "Release drill FAILED."
  fi
  exit "$RESTORE_STATUS"
} 2>&1 | tee "$REPORT"
STATUS="${PIPESTATUS[0]}"
set -e

echo "report=$REPORT"
exit "$STATUS"
