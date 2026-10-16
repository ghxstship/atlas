#!/usr/bin/env bash
# CI: weekly logical backup of a hosted project to separate storage (Section 9), encrypted to the
# owner's public key so only the encrypted archive ever leaves the runner (the repository is public).
#   XOS_BACKUP_DB_URL=<secret> infra/ci/backup-weekly.sh <environment name> <output dir>
# Needs the Supabase CLI and gpg. Never prints the connection string.
set -euo pipefail

ENVIRONMENT="${1:?environment name, for example staging}"
OUT="${2:?output directory}"
KEY="infra/backup/backup-public-key.asc"
[[ -n "${XOS_BACKUP_DB_URL:-}" ]] || { echo "XOS_BACKUP_DB_URL is not set." >&2; exit 1; }
[[ -f "$KEY" ]] || { echo "${KEY} is missing; the owner provides the public backup key first." >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

supabase db dump --db-url "$XOS_BACKUP_DB_URL" --role-only -f "$WORK/roles.sql"
supabase db dump --db-url "$XOS_BACKUP_DB_URL" -f "$WORK/schema.sql"
supabase db dump --db-url "$XOS_BACKUP_DB_URL" --data-only --use-copy -f "$WORK/data.sql"

for file in roles.sql schema.sql data.sql; do
  [[ -s "$WORK/$file" ]] || { echo "${file} is empty." >&2; exit 1; }
done

export GNUPGHOME="$WORK/gnupg"
mkdir -m 700 "$GNUPGHOME"
gpg --batch --quiet --import "$KEY"
RECIPIENT="$(gpg --batch --with-colons --list-keys | awk -F: '/^fpr:/ {print $10; exit}')"

mkdir -p "$OUT"
ARCHIVE="$OUT/xos-${ENVIRONMENT}-${STAMP}.tar.gz.gpg"
tar -C "$WORK" -czf - roles.sql schema.sql data.sql |
  gpg --batch --yes --trust-model always --encrypt --recipient "$RECIPIENT" --output "$ARCHIVE"

{
  echo "### Weekly backup: ${ENVIRONMENT}"
  echo "- archive: $(basename "$ARCHIVE")"
  echo "- bytes: $(wc -c <"$ARCHIVE" | tr -d ' ')"
  echo "- sha256: $(sha256sum "$ARCHIVE" | cut -d' ' -f1)"
  echo "- encrypted to key: ${RECIPIENT}"
} >>"${GITHUB_STEP_SUMMARY:-/dev/stdout}"
