#!/bin/sh
# Supabase database advisors (Section 18 gate 11): the security and performance lints of the
# Supabase linter (splinter), run by the CLI against a database. Prints and fails on any WARN or
# ERROR. INFO lints never fail the run and show only with ADVISOR_LEVEL=info; on a fresh local
# stack they are:
#
# - unused_index: a database with no traffic has used no index, so every index is reported.
# - rls_enabled_no_policy: tables with row level security on and no policy, which refuse every
#   authenticated and anonymous read on purpose: 84 private tables read through views or
#   SECURITY DEFINER functions, and the four xpms Production Template store tables that only the
#   Playbook import and export (service role) touch.
#
#   sh infra/security/supabase-advisors.sh              # the local stack (supabase start)
#   sh infra/security/supabase-advisors.sh "$DB_URL"    # any database, by connection string
set -eu

cd "$(dirname "$0")/../.."

if [ $# -gt 0 ]; then
  TARGET="--db-url=$1"
else
  TARGET="--local"
fi

supabase db advisors "$TARGET" --type all --level "${ADVISOR_LEVEL:-warn}" --fail-on warn
