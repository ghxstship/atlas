#!/usr/bin/env bash
# CI: waits until every container of the running Supabase stack that has a health check reports healthy.
#
#   supabase start --ignore-health-check -x ...
#   infra/ci/supabase-wait-healthy.sh [seconds]     default 600
#
# Why: on the Intel macOS runner the stack runs in a 2 CPU Colima VM, where the migrations and the seed take about seven
# minutes and Realtime and Storage come up slower than the CLI's own wait for health (about two minutes from "Starting
# containers"). The CLI then stopped the stack while Realtime was already answering /api/ping (runs 42489339979,
# 42380088833, 42240294431, 41662045788). `--ignore-health-check` keeps the stack, and this script gives the slow VM its
# time: a container's health turns back to healthy at its next passing check. It fails, with each unhealthy container's
# last log lines, if any is still not healthy when the time is up. Bash 3.2 compatible, for the macOS runners' /bin/bash.

set -euo pipefail

LIMIT="${1:-600}"
DEADLINE=$(($(date +%s) + LIMIT))

pending() {
  local name health
  docker ps --filter "name=^supabase_" --format '{{.Names}}' | while read -r name; do
    health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$name")"
    if [[ "$health" != "healthy" && "$health" != "none" ]]; then echo "$name $health"; fi
  done
}

if [[ -z "$(docker ps --filter "name=^supabase_" --format '{{.Names}}')" ]]; then
  echo "No Supabase containers are running." >&2
  exit 1
fi

while true; do
  waiting="$(pending)"
  if [[ -z "$waiting" ]]; then
    echo "Every Supabase container with a health check is healthy."
    exit 0
  fi
  if (($(date +%s) >= DEADLINE)); then
    echo "Still not healthy after ${LIMIT} s:" >&2
    echo "$waiting" >&2
    echo "$waiting" | while read -r name _; do
      echo "--- $name" >&2
      docker logs --tail 40 "$name" >&2 2>&1 || true
    done
    exit 1
  fi
  echo "Waiting for: $(echo "$waiting" | tr '\n' ' ')"
  sleep 10
done
