#!/usr/bin/env bash
# CI: checks A17's sync rules against the freshly migrated database and writes the publication SQL.
# Exits 1 while the rules would replicate nothing or send internal columns to external devices.
set -euo pipefail

node --experimental-strip-types --no-warnings infra/powersync/src/cli.ts \
  --container supabase_db_xos4 --out "${RUNNER_TEMP:-/tmp}/powersync-publication.sql"
