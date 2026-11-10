#!/usr/bin/env bash
# CI: weekly logical backup of a hosted project to separate storage (Section 9), encrypted to the
# owner's public key and uploaded to the owner's private bucket (infra/ci/backup-store.sh). Only the
# encrypted archive leaves the runner, and never to GitHub: the repository is public.
#   XOS_BACKUP_DB_URL=<secret> BACKUP_ENCRYPTION_RECIPIENT=<fingerprint> BACKUP_S3_...=<secrets> \
#     infra/ci/backup-weekly.sh <environment name> <working dir> [--reader]
#
# Nothing is dumped until every secret is set: the connection string, the fingerprint of the key the
# archive is encrypted to, which must be a key in infra/backup/backup-public-key.asc (so a changed key
# file cannot redirect the backup to a key the owner does not hold), and the bucket's five settings.
# The archive is written to <working dir>, uploaded to <environment>/ in the bucket and then removed.
#
# Without --reader the URL logs in as postgres, and `supabase db dump` writes roles.sql, schema.sql and
# data.sql (the staging job). With --reader it logs in as xos_backup, the read-only backup login of
# migration 1650 (the production job, ADR 0033 decision 47). The CLI always switches to the postgres
# role, which that login cannot, so the script runs pg_dumpall, pg_dump and psql itself from the
# Postgres image the pinned CLI resolves (`supabase services`), the client `supabase db dump` would use:
#   - roles.sql and schema.sql with the CLI's own flags, schema exclusions and filters (2.120.0),
#     two of them corrected (see below);
#   - data.sql: every table of the application schemas and the storage buckets and object list,
#     from one snapshot, then the accounts as INSERTs (private.backup_account_rows);
#   - platform.sql: XOS's triggers, policies and grants on the auth and storage tables, which the
#     schema dump leaves out with those schemas (private.backup_platform_objects);
#   - cron.sql: the worker schedules as cron.schedule calls (private.backup_cron_schedules);
#   - migrations.txt: the applied migration versions (private.backup_migration_versions), which no
#     dump holds, for `supabase migration repair` after a restore.
# XOS_BACKUP_DOCKER_NETWORK names the Docker network the client joins (host on a runner).
# Needs the Supabase CLI, gpg, curl, openssl, and Docker for --reader. Never prints a secret's value.
set -euo pipefail

ENVIRONMENT="${1:?environment name, for example staging}"
OUT="${2:?output directory}"
MODE="${3:-cli}"
KEY="infra/backup/backup-public-key.asc"
STORE="$(dirname "$0")/backup-store.sh"
[[ "$MODE" == cli || "$MODE" == --reader ]] || { echo "The third argument is --reader or nothing." >&2; exit 2; }

# Everything a run needs, reported together, so one failed run names every missing piece. No secret value
# is printed: XOS_BACKUP_SECRET_NAME only names the GitHub secret the workflow reads the URL from.
PROBLEMS=()
[[ -n "${XOS_BACKUP_DB_URL:-}" ]] ||
  PROBLEMS+=("The connection string is empty: set the secret ${XOS_BACKUP_SECRET_NAME:-XOS_BACKUP_DB_URL}.")
[[ -f "$KEY" ]] ||
  PROBLEMS+=("${KEY} is missing: the owner commits the public backup key.")
[[ -n "${BACKUP_ENCRYPTION_RECIPIENT:-}" ]] ||
  PROBLEMS+=("The secret BACKUP_ENCRYPTION_RECIPIENT is empty: set it to the backup key's fingerprint.")
# The bucket's settings, checked by the script that uses them, which names each missing one the same way.
STORAGE="ready"
STORAGE_PROBLEMS="$("$STORE" check 2>&1)" || STORAGE="missing"
if [[ ${#PROBLEMS[@]} -gt 0 || "$STORAGE" != ready ]]; then
  for problem in "${PROBLEMS[@]}"; do
    echo "::error title=Weekly backup, ${ENVIRONMENT}::${problem}" >&2
  done
  [[ "$STORAGE" == ready ]] || grep -v '^Steps: ' <<<"$STORAGE_PROBLEMS" >&2
  echo "Steps: infra/runbooks/security-owner-steps.md, 1. Secret values for the backup." >&2
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

# The key is read before anything is dumped, so a bad key costs seconds and no data leaves the database.
export GNUPGHOME="$WORK/gnupg"
mkdir -m 700 "$GNUPGHOME"
gpg --batch --quiet --import "$KEY" ||
  { echo "::error title=Weekly backup, ${ENVIRONMENT}::${KEY} is not a key gpg can read." >&2; exit 1; }
# The archive is encrypted only to the key the secret names, and only if the committed file holds it.
RECIPIENT="$(tr -d ' ' <<<"$BACKUP_ENCRYPTION_RECIPIENT" | tr '[:lower:]' '[:upper:]')"
if ! gpg --batch --with-colons --list-keys | awk -F: '/^pub:/ {getline; print $10}' | grep -qxF "$RECIPIENT"; then
  echo "::error title=Weekly backup, ${ENVIRONMENT}::BACKUP_ENCRYPTION_RECIPIENT is not the full fingerprint of a key in ${KEY}." >&2
  exit 1
fi
# Validity is the second field: e expired, r revoked. Capabilities in the twelfth carry a capital E
# while a usable encryption subkey exists.
KEY_STATE="$(gpg --batch --with-colons --list-keys "$RECIPIENT" | awk -F: '/^pub:/ {print $2 "|" $12; exit}')"
if [[ "${KEY_STATE%%|*}" == [er] || "${KEY_STATE##*|}" != *E* ]]; then
  echo "::error title=Weekly backup, ${ENVIRONMENT}::${KEY} is expired, revoked or cannot encrypt." >&2
  exit 1
fi
KEY_EXPIRES="$(gpg --batch --with-colons --list-keys "$RECIPIENT" | awk -F: '/^pub:/ {print $7; exit}')"
if [[ -n "$KEY_EXPIRES" ]] && (( KEY_EXPIRES < $(date +%s) + 60 * 86400 )); then
  echo "::warning title=Weekly backup, ${ENVIRONMENT}::${KEY} expires within 60 days; the owner extends it and commits it again."
fi

# Schemas the platform maintains, as `supabase db dump` 2.120.0 leaves them out of a schema dump, and
# the roles it never recreates. Everything else is an application schema.
PLATFORM_SCHEMAS="information_schema|pg_*|_analytics|_realtime|_supavisor|auth|etl|extensions|pgbouncer|realtime|storage|supabase_functions|supabase_migrations|cron|dbdev|graphql|graphql_public|net|pgmq|pgsodium|pgsodium_masks|pgtle|repack|tiger|tiger_data|timescaledb_*|_timescaledb_*|topology|vault"
RESERVED_ROLES="anon|authenticated|authenticator|cli_login_.*|dashboard_user|pgbouncer|postgres|service_role|supabase_.*|pgsodium_keyholder|pgsodium_keyiduser|pgsodium_keymaker|pgtle_admin"

pinned_client() {
  local tag registry
  tag="$(supabase services -o json | python3 -c '
import json, sys
print(next(s["local"] for s in json.load(sys.stdin) if s["name"].rsplit("/", 1)[-1] == "postgres"))
')"
  for registry in ghcr.io/supabase public.ecr.aws/supabase; do
    if docker pull --quiet "$registry/postgres:$tag" >/dev/null 2>&1; then
      echo "$registry/postgres:$tag"
      return 0
    fi
  done
  echo "Could not pull supabase/postgres:${tag}." >&2
  return 1
}

# Runs one client tool of the pinned image against the database. The connection string reaches the
# container as an environment variable, never as an argument on the runner.
client() {
  docker run --rm -i --network "${XOS_BACKUP_DOCKER_NETWORK:-host}" -e XOS_BACKUP_DB_URL --entrypoint "" "$IMAGE" \
    sh -c 'tool="$1"; shift; exec "$tool" --dbname="$XOS_BACKUP_DB_URL" "$@"' sh "$@"
}

dump_with_reader() {
  IMAGE="$(pinned_client)"

  # As `supabase db dump --role-only` writes it, without switching to the postgres role, and leaving
  # out one more kind of line: a grant on a server parameter to a reserved role, such as SET on
  # log_min_messages to supabase_realtime_admin. Every new project has it, and postgres may not repeat it.
  {
    client pg_dumpall --roles-only --quote-all-identifier --no-role-passwords --no-comments |
      sed -E 's/^\\(un)?restrict .*$/-- &/' |
      sed -E "s/^CREATE ROLE \"($RESERVED_ROLES)\"/-- &/" |
      sed -E "s/^ALTER ROLE \"($RESERVED_ROLES)\"/-- &/" |
      sed -E "s/ (NOSUPERUSER|NOREPLICATION)//g" |
      sed -E "s/^-- (.* SET \"(pgaudit.*|pgrst.*|session_replication_role|statement_timeout|track_io_timing)\" .*)/\1/" |
      sed -E "s/GRANT \".*\" TO \"($RESERVED_ROLES)\"/-- &/" |
      sed -E "s/^GRANT .+ ON PARAMETER .+ TO \"($RESERVED_ROLES)\"/-- &/" |
      sed -E "/^--/d" |
      uniq
    echo "RESET ALL;"
  } >"$WORK/roles.sql"

  # As `supabase db dump` writes the schema, but for one filter. The CLI leaves out every GRANT and
  # REVOKE that names a platform schema anywhere, which also drops those on an application function
  # taking a platform type: app.store_search_embedding takes an extensions.vector, so its REVOKE from
  # PUBLIC went missing and anyone could run it on the restored project. This leaves out only the
  # grants and revokes on an object in a platform schema.
  client pg_dump --schema-only --quote-all-identifier --exclude-schema "$PLATFORM_SCHEMAS" |
    sed -E 's/^\\(un)?restrict .*$/-- &/' |
    sed -E 's/^CREATE SCHEMA "/CREATE SCHEMA IF NOT EXISTS "/' |
    sed -E 's/^CREATE TABLE "/CREATE TABLE IF NOT EXISTS "/' |
    sed -E 's/^CREATE SEQUENCE "/CREATE SEQUENCE IF NOT EXISTS "/' |
    sed -E 's/^CREATE VIEW "/CREATE OR REPLACE VIEW "/' |
    sed -E 's/^CREATE FUNCTION "/CREATE OR REPLACE FUNCTION "/' |
    sed -E 's/^CREATE TRIGGER "/CREATE OR REPLACE TRIGGER "/' |
    sed -E 's/^CREATE PUBLICATION "supabase_realtime/-- &/' |
    sed -E 's/^CREATE EVENT TRIGGER /-- &/' |
    sed -E 's/^         WHEN TAG IN /-- &/' |
    sed -E 's/^   EXECUTE FUNCTION /-- &/' |
    sed -E 's/^ALTER EVENT TRIGGER /-- &/' |
    sed -E 's/^ALTER PUBLICATION "supabase_realtime_/-- &/' |
    sed -E 's/^ALTER FOREIGN DATA WRAPPER (.+) OWNER TO /-- &/' |
    sed -E 's/^ALTER DEFAULT PRIVILEGES FOR ROLE "supabase_admin"/-- &/' |
    sed -E 's/^GRANT ALL ON FOREIGN DATA WRAPPER (.+) TO "postgres" WITH GRANT OPTION/-- &/' |
    sed -E "s/^(GRANT|REVOKE) (.+) ON (SCHEMA|TABLE|SEQUENCE|FUNCTION|PROCEDURE|TYPE|DOMAIN|FOREIGN TABLE) \"($PLATFORM_SCHEMAS)\"/-- &/" |
    sed -E 's/^(CREATE EXTENSION IF NOT EXISTS "pg_tle").+/\1;/' |
    sed -E 's/^(CREATE EXTENSION IF NOT EXISTS "pgsodium").+/\1;/' |
    sed -E 's/^(CREATE EXTENSION IF NOT EXISTS "pgmq").+/\1;/' |
    sed -E 's/^COMMENT ON EXTENSION (.+)/-- &/' |
    sed -E 's/^CREATE POLICY "cron_job_/-- &/' |
    sed -E 's/^ALTER TABLE "cron"/-- &/' |
    sed -E 's/^SET transaction_timeout = 0;/-- &/' |
    sed -E "/^--/d" >"$WORK/schema.sql"

  # Every application schema whole and the storage buckets and object list, as --table patterns, so
  # one pg_dump reads them from one snapshot. A table the login cannot read fails the dump rather than
  # leaving the backup short. The accounts follow, read just after it in their own transaction.
  local tables=() pattern
  while IFS= read -r pattern; do
    [[ -n "$pattern" ]] && tables+=(--table "$pattern")
  done < <(client psql -X -A -t -v ON_ERROR_STOP=1 -v platform="$PLATFORM_SCHEMAS" <<'SQL'
select format('%I.*', n.nspname) from pg_catalog.pg_namespace n
where n.nspname !~ ('^(' || replace(:'platform', '*', '.*') || ')$')
union all
select unnest(array['storage.buckets', 'storage.objects'])
order by 1;
SQL
  )
  [[ ${#tables[@]} -gt 0 ]] || { echo "The login reads no table." >&2; exit 1; }
  {
    printf 'SET session_replication_role = replica;\n\n'
    client pg_dump --data-only --quote-all-identifier "${tables[@]}" | sed -E 's/^\\(un)?restrict .*$/-- &/'
    client psql -X -A -t -v ON_ERROR_STOP=1 -c 'select private.backup_account_rows()'
    echo "RESET ALL;"
  } >"$WORK/data.sql"

  client psql -X -A -t -v ON_ERROR_STOP=1 -c 'select private.backup_platform_objects()' >"$WORK/platform.sql"
  client psql -X -A -t -v ON_ERROR_STOP=1 -c 'select private.backup_cron_schedules()' >"$WORK/cron.sql"
  client psql -X -A -t -v ON_ERROR_STOP=1 -c 'select private.backup_migration_versions()' >"$WORK/migrations.txt"
  FILES=(roles.sql schema.sql data.sql platform.sql cron.sql migrations.txt)
}

if [[ "$MODE" == --reader ]]; then
  dump_with_reader
else
  supabase db dump --remote="$XOS_BACKUP_DB_URL" --role-only -f "$WORK/roles.sql"
  supabase db dump --remote="$XOS_BACKUP_DB_URL" -f "$WORK/schema.sql"
  supabase db dump --remote="$XOS_BACKUP_DB_URL" --data-only --use-copy -f "$WORK/data.sql"
  FILES=(roles.sql schema.sql data.sql)
fi

for file in "${FILES[@]}"; do
  [[ -s "$WORK/$file" ]] || { echo "${file} is empty." >&2; exit 1; }
done

mkdir -p "$OUT"
ARCHIVE="$OUT/xos-${ENVIRONMENT}-${STAMP}.tar.gz.gpg"
tar -C "$WORK" -czf - "${FILES[@]}" |
  gpg --batch --yes --trust-model always --encrypt --recipient "$RECIPIENT" --output "$ARCHIVE"
BYTES="$(wc -c <"$ARCHIVE" | tr -d ' ')"
SHA256="$(openssl dgst -sha256 -r "$ARCHIVE" | cut -d' ' -f1)"

# Uploaded with its SHA-256, which the restore checks (infra/drills/archive-fetch.sh), then removed here.
OBJECT="$("$STORE" put "$ARCHIVE" "$ENVIRONMENT")"
rm -f "$ARCHIVE"

# The run summary is public with the repository: it names the object and the secrets, never their values.
{
  echo "### Weekly backup: ${ENVIRONMENT}"
  echo "- stored as: ${OBJECT}, in the bucket the secret BACKUP_S3_BUCKET names"
  echo "- files: ${FILES[*]}"
  echo "- bytes: ${BYTES}"
  echo "- sha256: ${SHA256}"
  echo "- encrypted to: the key BACKUP_ENCRYPTION_RECIPIENT names"
} >>"${GITHUB_STEP_SUMMARY:-/dev/stdout}"
