#!/bin/sh
# Runs the k6 load scripts through the pinned official image (no host install).
#   sh load/run.sh smoke                 all three scripts at smoke scale against the local stack
#   sh load/run.sh smoke compass-show    one script
#   LOAD_MODE=full ... sh load/run.sh full <script>   full scale; see load/README.md first
# Results land in node_modules/.cache/k6/<script>-<mode>.json, outside formatting and git.
set -eu

K6_IMAGE="grafana/k6:2.3.0"
MODE="${1:-smoke}"
ONLY="${2:-}"
HERE="$(cd "$(dirname "$0")" && pwd)"
RESULTS="$HERE/../node_modules/.cache/k6"
mkdir -p "$RESULTS"

if [ "$MODE" != "smoke" ] && [ "$MODE" != "full" ]; then
  echo "Mode must be smoke or full, got $MODE." >&2
  exit 2
fi
if [ -z "${SUPABASE_ANON_KEY:-}" ]; then
  echo "Set SUPABASE_ANON_KEY to the stack's publishable key (supabase status)." >&2
  exit 2
fi

run() {
  script="$1"; shift
  echo "k6 $script ($MODE)"
  docker run --rm -i \
    --add-host=host.docker.internal:host-gateway \
    -v "$HERE:/load:ro" -v "$RESULTS:/results" \
    -e LOAD_MODE="$MODE" -e SUPABASE_ANON_KEY \
    -e SUPABASE_URL="${SUPABASE_URL:-}" -e ATLAS_URL="${ATLAS_URL:-}" \
    -e LOAD_USERS="${LOAD_USERS:-}" -e LOAD_PASSWORD="${LOAD_PASSWORD:-}" \
    -e LOAD_DURATION="${LOAD_DURATION:-}" -e LOAD_CONFIRM_STAGING="${LOAD_CONFIRM_STAGING:-}" \
    "$@" \
    "$K6_IMAGE" run --summary-export "/results/$script-$MODE.json" "/load/$script.js"
}

status=0
for script in api-platform api-tenant compass-show; do
  if [ -n "$ONLY" ] && [ "$ONLY" != "$script" ]; then continue; fi
  case "$script" in
    api-platform) run api -e LOAD_PROFILE=platform || status=1; mv -f "$RESULTS/api-$MODE.json" "$RESULTS/api-platform-$MODE.json" 2>/dev/null || true ;;
    api-tenant) run api -e LOAD_PROFILE=tenant || status=1; mv -f "$RESULTS/api-$MODE.json" "$RESULTS/api-tenant-$MODE.json" 2>/dev/null || true ;;
    compass-show) run compass-show || status=1 ;;
  esac
done
exit "$status"
