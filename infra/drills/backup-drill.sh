#!/usr/bin/env bash
# Backup drill: takes a logical backup of a local XOS stack and writes a manifest the restore drill
# verifies against.
#
#   infra/drills/backup-drill.sh [--source supabase_db_xos4-shared] [--out <dir>]
#
# Writes <out>/xos-<timestamp>.dump (pg_dump custom format), <out>/xos-<timestamp>.manifest
# (image, latest migration, newest write, row counts, key-table checksums) and its SHA-256.
# Read-only on the source.

source "$(dirname "$0")/lib.sh"

SOURCE="supabase_db_xos4-shared"
OUT="${TMPDIR:-/tmp}/xos-drills"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --source) SOURCE="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    *) die "Unknown argument $1" ;;
  esac
done

require_tools
require_local_docker
require_source_container "$SOURCE"
mkdir -p "$OUT"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DUMP="$OUT/xos-$STAMP.dump"
MANIFEST="$OUT/xos-$STAMP.manifest"
STARTED="$(now_epoch)"

# Counts first, then the dump, inside one exported snapshot would be ideal; on a quiet local stack
# taking counts immediately before the dump is exact.
table_counts "$SOURCE" >"$MANIFEST.counts"
key_table_checksums "$SOURCE" >"$MANIFEST.checksums"
# Roles the archive references; the restore creates any the fresh image lacks (no passwords are read).
psql_in "$SOURCE" -tA -c "select rolname from pg_roles where rolname !~ '^pg_' order by 1" >"$MANIFEST.roles"
docker exec "$SOURCE" pg_dump -U supabase_admin -h localhost -d postgres --format=custom --compress=6 >"$DUMP"
[[ -s "$DUMP" ]] || die "The dump is empty."

ENTRIES="$(docker exec -i "$SOURCE" pg_restore --list <"$DUMP" | grep -vc '^;')"
NEWEST_WRITE="$(psql_in "$SOURCE" -tA -c "select coalesce(max(created_at)::text, 'none') from app.audit_events" 2>/dev/null || echo none)"

{
  echo "created_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "source_container=$SOURCE"
  echo "image=$(docker inspect -f '{{.Config.Image}}' "$SOURCE")"
  echo "latest_migration=$(latest_migration "$SOURCE")"
  echo "newest_audit_event=$NEWEST_WRITE"
  echo "archive_entries=$ENTRIES"
  echo "bytes=$(wc -c <"$DUMP" | tr -d ' ')"
  echo "sha256=$(shasum -a 256 "$DUMP" | cut -d' ' -f1)"
  echo "tables=$(wc -l <"$MANIFEST.counts" | tr -d ' ')"
  echo "key_tables=$(wc -l <"$MANIFEST.checksums" | tr -d ' ')"
  echo "seconds=$(($(now_epoch) - STARTED))"
} >"$MANIFEST"

cat "$MANIFEST"
echo "dump=$DUMP"
