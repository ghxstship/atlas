#!/usr/bin/env bash
# CI: backup and restore drill against the stack `supabase db start` just built from the migrations.
# Run from the repository root after the pgTAP step. Fails the job when the restore does not verify:
# row counts of every table, key-table checksums and the pgTAP smoke suites (release-drill.sh).

set -euo pipefail

OUT="${RUNNER_TEMP:-/tmp}/xos-drills"
infra/drills/release-drill.sh --source supabase_db_xos4 --out "$OUT"
