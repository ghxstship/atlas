#!/usr/bin/env bash
# CI: one line to the on-call channel, the same path and body the synthetic checks use
# (infra/synthetics/src/run.ts, postAlerts).
#   XOS_ALERT_WEBHOOK_URL=<secret> infra/ci/post-alert.sh "<text>"
# Without the secret the run's red mark is the only alert, so this warns and passes. A webhook that
# refuses fails the step. Never prints the webhook's address.
set -euo pipefail

TEXT="${1:?alert text}"
if [[ -z "${XOS_ALERT_WEBHOOK_URL:-}" ]]; then
  echo "::warning title=No alert channel::XOS_ALERT_WEBHOOK_URL is not set, so this alert reached no channel (infra/runbooks/security-owner-steps.md)."
  exit 0
fi
BODY="$(python3 -c 'import json, sys; print(json.dumps({"text": sys.argv[1]}))' "$TEXT")"
curl --silent --show-error --fail --max-time 10 --output /dev/null \
  --header "content-type: application/json" --data "$BODY" "$XOS_ALERT_WEBHOOK_URL"
