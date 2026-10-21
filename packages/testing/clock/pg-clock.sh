#!/usr/bin/env bash
# Test clock for a local Supabase Postgres container (A71, RRR-116).
#
#   pg-clock.sh at <container> <instant>   restart Postgres with its wall clock at <instant>
#   pg-clock.sh off <container>            restart Postgres on the real clock
#
# <instant> is UTC, for example 2026-10-21T03:30:00Z (23:30 in New York, a day ahead in UTC). The
# clock runs on from there. `at` prints the matching E2E_CLOCK_OFFSET_MS for node-clock.cjs, so the
# Playwright runner, the Next servers and the browsers move by the same amount.
#
# How: Postgres's now() cannot be set, so the container's postgres loads libfaketime through
# LD_PRELOAD with a relative offset. The library is Ubuntu's libfaketime package, built for glibc,
# which the Nix-built Postgres in public.ecr.aws/supabase/postgres uses; it is taken once from the
# pinned Playwright image and cached under node_modules/.cache/pg-clock. It is copied into the Nix
# glibc's own library directory and preloaded by bare name, so only glibc programs find it: the
# image's musl tools (the pgsodium key script Postgres runs at start among them) skip a preload they
# cannot find, where a path would make them load a glibc library and die. Monotonic clocks stay real
# so statement timeouts and waits behave. `supabase db reset` and `supabase stop` recreate the
# container and drop the hook; run `at` again afterwards.
#
# Only for a local stack you own: the container name must be supabase_db_<project id>.
set -euo pipefail

cmd="${1:-}"
container="${2:-}"
case "$container" in
  supabase_db_*) ;;
  *)
    echo "usage: pg-clock.sh at <supabase_db_container> <UTC instant> | off <supabase_db_container>" >&2
    exit 2
    ;;
esac

root="$(cd "$(dirname "$0")/../../.." && pwd)"
cache="$root/node_modules/.cache/pg-clock"
lib="$cache/libfaketime.so.1"
image="mcr.microsoft.com/playwright:v1.64.0-noble"

wait_ready() {
  for _ in $(seq 90); do
    if docker exec "$container" pg_isready -U postgres -q; then return 0; fi
    sleep 1
  done
  echo "Postgres in $container did not come back" >&2
  return 1
}

install_hook() {
  if [ ! -f "$lib" ]; then
    mkdir -p "$cache"
    docker run --rm -v "$cache:/out" "$image" bash -c \
      "apt-get update -qq > /dev/null && apt-get install -y -qq libfaketime > /dev/null && cp /usr/lib/\$(uname -m)-linux-gnu/faketime/libfaketime.so.1 /out/"
  fi
  docker cp "$lib" "$container:/tmp/libfaketime.so.1"
  docker exec "$container" sh -c \
    'for d in /nix/store/*-glibc-*/lib; do if [ -e "$d/libc.so.6" ]; then cp /tmp/libfaketime.so.1 "$d/"; fi; done'
  if ! docker exec "$container" grep -q faketime.enable /usr/local/bin/docker-entrypoint.sh; then
    docker exec "$container" sed -i \
      's|^\texec "\$@"$|\tif [ -f /etc/faketime.enable ]; then export LD_PRELOAD=libfaketime.so.1 FAKETIME_TIMESTAMP_FILE=/etc/faketimerc FAKETIME_CACHE_DURATION=1 FAKETIME_DONT_FAKE_MONOTONIC=1; fi\n\texec "$@"|' \
      /usr/local/bin/docker-entrypoint.sh
  fi
}

case "$cmd" in
  at)
    instant="${3:?a UTC instant such as 2026-10-21T03:30:00Z}"
    install_hook
    target=$(node -e 'const t = Date.parse(process.argv[1]); if (Number.isNaN(t)) process.exit(1); console.log(Math.floor(t / 1000))' "$instant")
    offset=$((target - $(date -u +%s)))
    if [ "$offset" -lt 0 ]; then spec="$offset"; else spec="+$offset"; fi
    docker exec "$container" sh -c "printf '%s\n' '$spec' > /etc/faketimerc && chmod 644 /etc/faketimerc && touch /etc/faketime.enable"
    docker restart "$container" > /dev/null
    wait_ready
    docker exec "$container" psql -U postgres -Atc \
      "select 'database clock ' || now() || ', New York ' || (now() at time zone 'America/New_York')"
    echo "export E2E_CLOCK_OFFSET_MS=$((offset * 1000))"
    ;;
  off)
    docker exec "$container" rm -f /etc/faketime.enable
    docker restart "$container" > /dev/null
    wait_ready
    docker exec "$container" psql -U postgres -Atc "select 'database clock ' || now()"
    ;;
  *)
    echo "usage: pg-clock.sh at <supabase_db_container> <UTC instant> | off <supabase_db_container>" >&2
    exit 2
    ;;
esac
