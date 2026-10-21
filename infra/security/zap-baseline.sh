#!/bin/sh
# OWASP ZAP baseline against a deployed site (Section 9 testing: DAST against staging).
#
#   sh infra/security/zap-baseline.sh https://atlas-staging.ghxstship.tech out/
#
# Spiders the site for a few minutes and runs ZAP's passive rules (no attacks), with the rules in
# infra/security/zap/baseline-rules.tsv. Writes an HTML and a JSON report to the output folder, then
# fails on any alert of a FAIL rule and on any High alert that is not ignored (infra/security/src/zap.ts).
#
# Staging sits behind Vercel deployment protection. When VERCEL_AUTOMATION_BYPASS_SECRET is set, ZAP sends
# it as the x-vercel-protection-bypass header, and only to the target's own host. The value is passed to
# the container through the environment, never on a command line.
set -eu

IMAGE="ghcr.io/zaproxy/zaproxy:2.17.0"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TARGET="${1:?Pass the URL to scan, for example https://atlas-staging.ghxstship.tech}"
OUT="${2:-zap}"
MINUTES="${ZAP_SPIDER_MINUTES:-3}"

case "$TARGET" in
  https://*) ;;
  *) echo "Scan https sites only: $TARGET" >&2; exit 2 ;;
esac
HOST="$(echo "$TARGET" | sed -E 's#^https://([^/:]+).*#\1#')"
NAME="$(echo "$HOST" | sed -E 's/[^a-z0-9.-]//g')"

mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
cp "$ROOT/infra/security/zap/baseline-rules.tsv" "$OUT/baseline-rules.tsv"
# The image runs as the zap user, which must be able to write the reports.
chmod 0777 "$OUT"

set -- --rm -v "$OUT:/zap/wrk:rw"
if [ -n "${VERCEL_AUTOMATION_BYPASS_SECRET:-}" ]; then
  export ZAP_AUTH_HEADER=x-vercel-protection-bypass
  export ZAP_AUTH_HEADER_VALUE="$VERCEL_AUTOMATION_BYPASS_SECRET"
  export ZAP_AUTH_HEADER_SITE="$HOST"
  set -- "$@" -e ZAP_AUTH_HEADER -e ZAP_AUTH_HEADER_VALUE -e ZAP_AUTH_HEADER_SITE
fi

# -I: warnings alone do not fail (the verdict below decides). Exit 1 means a FAIL rule matched, 2 only
# warnings; 3 and above mean ZAP itself failed, which fails the job.
STATUS=0
docker run "$@" "$IMAGE" zap-baseline.py \
  -t "$TARGET" \
  -c baseline-rules.tsv \
  -m "$MINUTES" \
  -J "zap-${NAME}.json" \
  -r "zap-${NAME}.html" \
  -I || STATUS=$?
# The reports may quote request headers; the bypass value is removed before anything uploads them.
node --experimental-strip-types --no-warnings "$ROOT/infra/security/src/cli.ts" redact "$OUT"
if [ "$STATUS" -ge 3 ]; then
  echo "ZAP did not complete (exit $STATUS)." >&2
  exit "$STATUS"
fi

node --experimental-strip-types --no-warnings "$ROOT/infra/security/src/cli.ts" zap \
  "$OUT/zap-${NAME}.json" "$TARGET"
