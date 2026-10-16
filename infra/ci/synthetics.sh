#!/usr/bin/env bash
# CI: one synthetic run and a status page rebuild.
#   infra/ci/synthetics.sh <history file> <site dir>
# Exits with the synthetic run's status (1 when a required check fails) after the page is built, so a
# failing run still publishes the outage.
set -uo pipefail

HISTORY="${1:?history file}"
SITE="${2:?site directory}"

node --experimental-strip-types --no-warnings infra/synthetics/src/cli.ts --history "$HISTORY"
STATUS=$?
node --experimental-strip-types --no-warnings infra/status/src/cli.ts --history "$HISTORY" --out "$SITE" || exit 2
exit "$STATUS"
