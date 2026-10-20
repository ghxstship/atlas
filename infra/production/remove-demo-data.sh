#!/usr/bin/env bash
# Removes the demo seed from the database being promoted to production (RRR-109, ADR 0033 decision 1).
# Runbook: infra/runbooks/promote-to-production.md. SQL: infra/production/remove-demo-data.sql.
#
# Usage:
#   remove-demo-data.sh dry-run  [--container NAME]                 counts per table; changes nothing
#   remove-demo-data.sh rehearse [--container NAME]                 deletes, verifies, rolls back
#   remove-demo-data.sh execute  [--container NAME] --confirm WORD  removes storage objects, deletes, verifies, commits
#
# Target, one of:
#   --container NAME   a local Supabase stack's database container (supabase_db_xos4 or supabase_db_xos4-*);
#                      psql runs inside it as the postgres role, the same role a hosted connection uses
#   DATABASE_URL       (environment) a hosted connection string, used only when --container is absent; it is
#                      never printed. psql comes from PATH, or from the postgres:17 image when PATH has none.
# Storage (execute only, when the dry run lists objects): SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the
# environment; objects are deleted through the Storage API because SQL deletes of storage.objects are refused.
#
# --confirm WORD must be the project ref in DATABASE_URL (for example fquuqnzlpobaawucczgq) or, for a container,
# its name. --log DIR (default: current directory) receives the full output of each run.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
sql_file="$here/remove-demo-data.sql"

die() {
  echo "remove-demo-data: $*" >&2
  exit 1
}

mode="${1:-}"
[[ "$mode" =~ ^(dry-run|rehearse|execute)$ ]] || die "first argument must be dry-run, rehearse or execute."
shift

container=""
confirm=""
log_dir="$PWD"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --container) container="${2:-}"; shift 2 ;;
    --confirm) confirm="${2:-}"; shift 2 ;;
    --log) log_dir="${2:-}"; shift 2 ;;
    *) die "unknown argument $1" ;;
  esac
done
mkdir -p "$log_dir"

# Target ---------------------------------------------------------------------------------------------------------

target=""
if [[ -n "$container" ]]; then
  [[ "$container" =~ ^supabase_db_xos4(-[a-z0-9-]+)?$ ]] || die "$container is not a local XOS stack (supabase_db_xos4 or supabase_db_xos4-*)."
  [[ "$(docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null)" == "true" ]] || die "container $container is not running."
  target="$container"
else
  [[ -n "${DATABASE_URL:-}" ]] || die "set DATABASE_URL or pass --container."
  # The project ref is the user name suffix on the pooler (postgres.<ref>) or the host label (db.<ref>.supabase.co).
  target="$(printf '%s' "$DATABASE_URL" | sed -nE 's#^[a-z]+://[^.:/@]+\.([a-z0-9]{20})[:@].*#\1#p')"
  [[ -n "$target" ]] || target="$(printf '%s' "$DATABASE_URL" | sed -nE 's#.*@db\.([a-z0-9]{20})\.supabase\.co.*#\1#p')"
  [[ -n "$target" ]] || die "could not read a Supabase project ref from DATABASE_URL."
fi

if [[ "$mode" == "execute" && "$confirm" != "$target" ]]; then
  die "execute needs --confirm $target (the target you are about to change)."
fi

# psql, with the SQL file and any output files exchanged through a scratch directory --------------------------------

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cp "$sql_file" "$work/remove-demo-data.sql"

run_psql() {
  # $1: mode, $2: optional storage list file name inside $work
  local run_mode="$1" storage="${2:-}"
  local args=(-X -v ON_ERROR_STOP=1 -v "mode=$run_mode")
  if [[ -n "$container" ]]; then
    local inside="/tmp/xos-remove-demo-data"
    docker exec "$container" rm -rf "$inside"
    docker cp "$work" "$container:$inside" >/dev/null
    # The copied directory belongs to the host user; psql writes the list straight into /tmp instead.
    [[ -n "$storage" ]] && args+=(-v "storage_list=$inside-$storage")
    local status=0
    docker exec "$container" psql -U postgres -h localhost -d postgres "${args[@]}" -f "$inside/remove-demo-data.sql" || status=$?
    if [[ $status -eq 0 && -n "$storage" ]]; then docker cp "$container:$inside-$storage" "$work/$storage" >/dev/null; fi
    docker exec "$container" rm -rf "$inside" "$inside-$storage"
    return $status
  elif command -v psql >/dev/null 2>&1; then
    [[ -n "$storage" ]] && args+=(-v "storage_list=$work/$storage")
    psql "$DATABASE_URL" "${args[@]}" -f "$work/remove-demo-data.sql"
  else
    [[ -n "$storage" ]] && args+=(-v "storage_list=/work/$storage")
    docker run --rm -i -e DATABASE_URL -v "$work:/work" postgres:17 \
      sh -c 'psql "$DATABASE_URL" "$@"' psql "${args[@]}" -f /work/remove-demo-data.sql
  fi
}

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
log="$log_dir/remove-demo-data-$mode-$stamp.log"

# Storage objects (execute) -----------------------------------------------------------------------------------------

delete_storage_objects() {
  local list="$work/storage.csv"
  : >"$list"
  run_psql dry-run storage.csv >>"$log" 2>&1 || die "listing storage objects failed; see $log"
  local count
  count="$(grep -c . "$list" || true)"
  echo "Storage objects of the demo orgs: $count" | tee -a "$log"
  [[ "$count" -eq 0 ]] && return 0
  [[ -n "${SUPABASE_URL:-}" && -n "${SUPABASE_SERVICE_ROLE_KEY:-}" ]] ||
    die "set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to delete $count storage objects through the Storage API."
  command -v node >/dev/null 2>&1 || die "node is required to delete storage objects."
  node --experimental-strip-types --no-warnings "$here/src/cli.ts" delete-storage "$list" 2>&1 | tee -a "$log"
  [[ ${PIPESTATUS[0]} -eq 0 ]] || die "deleting storage objects failed; nothing was deleted from the database. See $log"
}

# Run ---------------------------------------------------------------------------------------------------------------

echo "remove-demo-data: $mode against ${container:+container }$target; log $log"
if [[ "$mode" == "execute" ]]; then
  delete_storage_objects
fi
set +e
run_psql "$mode" 2>&1 | tee -a "$log"
status=${PIPESTATUS[0]}
set -e
if [[ $status -ne 0 ]]; then
  die "the $mode run failed (psql exit $status); nothing was committed. See $log"
fi
echo "remove-demo-data: $mode finished; log $log"
