#!/usr/bin/env bash
# Shared guards for the backup and restore drills (Section 9: 1 hour RPO, 4 hour RTO, verified by
# a restore drill script). The drills run against a local Docker stack only:
#   * the Docker daemon must be local (a unix socket), never a remote host;
#   * the source is named by its local container (supabase_db_xos4-*), never by a database URL,
#     so a hosted Supabase project can never be the source or the target;
#   * the restore target is a throwaway container this script creates, names xos4-drill-*, and
#     removes when it exits.

set -euo pipefail

DRILL_PREFIX="xos4-drill-"

die() {
  echo "drill: $*" >&2
  exit 1
}

require_tools() {
  for tool in docker openssl shasum; do
    command -v "$tool" >/dev/null 2>&1 || die "$tool is required."
  done
}

require_local_docker() {
  if [[ -n "${DOCKER_HOST:-}" && "${DOCKER_HOST}" != unix://* ]]; then
    die "DOCKER_HOST points at ${DOCKER_HOST}; drills only run against a local Docker daemon."
  fi
  local endpoint
  endpoint="$(docker context inspect --format '{{.Endpoints.docker.Host}}' 2>/dev/null || true)"
  if [[ -n "$endpoint" && "$endpoint" != unix://* ]]; then
    die "The current Docker context targets ${endpoint}; switch to a local context first."
  fi
}

# The source must be a local XOS stack's database container.
require_source_container() {
  local name="$1"
  # CI starts the repository's own stack (project_id xos4) on a fresh runner; on a workstation that
  # name belongs to the orchestrator's stack, so it is accepted only in CI.
  if [[ "$name" == "supabase_db_xos4" && "${CI:-}" == "true" ]]; then
    :
  elif [[ ! "$name" =~ ^supabase_db_xos4-[a-z0-9-]+$ ]]; then
    die "Source ${name} is not a local XOS stack (supabase_db_xos4-*)."
  fi
  [[ "$(docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null)" == "true" ]] || die "Container ${name} is not running."
}

# Only containers this drill created may be removed.
remove_drill_container() {
  local name="$1"
  [[ "$name" == ${DRILL_PREFIX}* ]] || die "Refusing to remove ${name}: not a drill container."
  docker rm -f "$name" >/dev/null 2>&1 || true
}

psql_in() {
  local container="$1"
  shift
  docker exec -i "$container" psql -U supabase_admin -h localhost -d postgres -v ON_ERROR_STOP=1 -X -q "$@"
}

# Row counts of every base and partitioned table in the XOS schemas, one "schema.table count" per line.
table_counts() {
  local container="$1"
  psql_in "$container" -tA -F ' ' <<'SQL'
select format('%I.%I', n.nspname, c.relname),
       (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', n.nspname, c.relname), false, true, '')))[1]::text
from pg_catalog.pg_class c
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where c.relkind in ('r', 'p')
  and not c.relispartition
  and n.nspname in ('xpms', 'app', 'private', 'api_public', 'api_external', 'supabase_migrations')
order by 1;
SQL
}

latest_migration() {
  psql_in "$1" -tA -c "select coalesce(max(version), 'none') from supabase_migrations.schema_migrations"
}

now_epoch() {
  date +%s
}

# Copies supabase/tests into a drill container so suites that include fixtures (\ir) resolve them.
copy_tests() {
  local container="$1" repo="$2"
  [[ "$container" == ${DRILL_PREFIX}* ]] || die "Tests are copied only into drill containers."
  docker exec "$container" rm -rf /tmp/xos-tests
  docker cp "$repo/supabase/tests" "$container:/tmp/xos-tests" >/dev/null
}

# Runs one copied pgTAP file; prints its output.
run_test() {
  local container="$1" file="$2"
  docker exec -w /tmp/xos-tests "$container" psql -U supabase_admin -h localhost -d postgres -X -q -tA -f "/tmp/xos-tests/$file" 2>&1 || true
}
