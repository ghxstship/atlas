#!/usr/bin/env bash
# CI: backup and restore drill against the stack `supabase db start` just built from the migrations.
# Run from the repository root after the pgTAP step. Fails the job when the restore does not verify.
set -euo pipefail

OUT="${RUNNER_TEMP:-/tmp}/xos-drills"
infra/drills/backup-drill.sh --source supabase_db_xos4 --out "$OUT"
DUMP="$(ls -t "$OUT"/xos-*.dump | head -1)"
infra/drills/restore-drill.sh --dump "$DUMP"
