#!/usr/bin/env bash
# The weekly backup's restore path, second half, as a drill: restore an unpacked production archive
# (archive-fetch.sh) into a fresh local stack, in the order backup-and-restore.md gives for a new project.
#
#   infra/drills/archive-restore.sh --dir <unpacked archive> --target supabase_db_xos4-<name>
#
# The target is the database container of a local stack started with no migrations (`supabase start` on a copy of
# supabase/ whose migrations folder is empty), so it holds Supabase's own schemas and nothing of XOS's. The script
# refuses a remote Docker daemon, a container that is not a local XOS stack, and a database that already holds an
# application schema. As postgres, with ON_ERROR_STOP, it runs roles.sql, schema.sql, data.sql, platform.sql and
# cron.sql, then records the versions in migrations.txt as `supabase migration repair` would. It checks that the
# latest recorded migration is the archive's, that every application table restored, that PUBLIC cannot run
# app.store_search_embedding, and prints the restore time against the 4 hour RTO.
# For production itself, the same files go to a new hosted project by hand (backup-and-restore.md, Restoring
# production); this script never connects to anything but a local container.

source "$(dirname "$0")/lib.sh"

DIR=""
TARGET=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) DIR="${2:-}"; shift 2 ;;
    --target) TARGET="${2:-}"; shift 2 ;;
    *) die "Unknown argument $1" ;;
  esac
done

FILES="roles.sql schema.sql data.sql platform.sql cron.sql"
for file in $FILES migrations.txt; do
  [[ -s "$DIR/$file" ]] || die "${DIR}/${file} is missing: pass --dir, the folder archive-fetch.sh printed."
done
require_local_docker
[[ "$TARGET" =~ ^supabase_db_xos4-[a-z0-9-]+$ ]] || die "Target ${TARGET} is not a local XOS stack (supabase_db_xos4-*)."
[[ "$(docker inspect -f '{{.State.Running}}' "$TARGET" 2>/dev/null)" == "true" ]] || die "Container ${TARGET} is not running."

as_postgres() {
  docker exec -i -e PGPASSWORD=postgres "$TARGET" \
    psql -U postgres -h localhost -d postgres -v ON_ERROR_STOP=1 -X -q "$@"
}

HELD="$(as_postgres -tA -c "select count(*) from pg_catalog.pg_namespace where nspname in ('app', 'private', 'xpms')")"
[[ "$HELD" == 0 ]] || die "${TARGET} already holds XOS's schemas: start a stack with no migrations."

STARTED="$(now_epoch)"
for file in $FILES; do
  echo "restoring ${file}"
  as_postgres -f - <"$DIR/$file" >/dev/null
done

# No dump holds the migration history; the CLI's repair writes these rows.
{
  echo "create schema if not exists supabase_migrations;"
  echo "create table if not exists supabase_migrations.schema_migrations (version text not null primary key, statements text[], name text);"
  echo "insert into supabase_migrations.schema_migrations (version) values"
  grep -E '^[0-9]+$' "$DIR/migrations.txt" | sed -e "s/.*/('&')/" | paste -sd, -
  echo "on conflict (version) do nothing;"
} | as_postgres -f - >/dev/null
RESTORED="$(now_epoch)"

FAILURES=0
fail() {
  echo "FAIL: $*"
  FAILURES=$((FAILURES + 1))
}

WANT="$(grep -E '^[0-9]+$' "$DIR/migrations.txt" | sort | tail -1)"
HAVE="$(as_postgres -tA -c "select max(version) from supabase_migrations.schema_migrations")"
if [[ "$HAVE" == "$WANT" ]]; then echo "ok: latest migration ${HAVE}"; else fail "latest migration ${HAVE}, the archive's ${WANT}"; fi

# Every application table the schema created has its data statement; an empty table set means the schema failed.
TABLES="$(as_postgres -tA -c "select count(*) from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace where c.relkind in ('r', 'p') and n.nspname in ('app', 'private', 'xpms')")"
ROWS="$(table_counts "$TARGET" | awk '$1 !~ /^supabase_migrations\./ {sum += $2} END {print sum + 0}')"
if [[ "$TABLES" -gt 0 ]]; then echo "ok: ${TABLES} application tables, ${ROWS} rows"; else fail "no application table restored"; fi

OPEN="$(as_postgres -tA -c "select coalesce(bool_or(has_function_privilege('public', p.oid, 'execute')), false) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and p.proname = 'store_search_embedding'")"
if [[ "$OPEN" == f ]]; then echo "ok: PUBLIC cannot run app.store_search_embedding"; else fail "PUBLIC can run app.store_search_embedding"; fi

echo "restore took $((RESTORED - STARTED)) s against the 4 hour RTO (14400 s)"
echo "Vault, sessions and one-time tokens are not in an archive (backup-and-restore.md, What the production login reads)."
[[ "$FAILURES" -eq 0 ]] || exit 1
