#!/usr/bin/env bash
# CI: pulls the Supabase CLI's service images from GHCR before `supabase start` or `supabase db start`.
#
#   infra/ci/supabase-images.sh start   what `supabase start -x studio,imgproxy,logflare,vector,postgres-meta,supavisor` runs
#   infra/ci/supabase-images.sh db      what `supabase db start` and `supabase test db` run
#
# Why: the CLI pulls from public.ecr.aws first. Anonymous ECR Public pulls from GitHub's shared runner
# addresses hit "toomanyrequests: Rate exceeded" and "Data limit exceeded" when a dozen jobs start at
# once. The CLI (2.120.0) then retries each image twice and falls back to ghcr.io/supabase and Docker
# Hub, so the stack usually starts, but every job loses its retries and a bad hour can exhaust all
# three registries. GHCR is GitHub's own registry, close to the runners and not data-capped for public
# images, so this script pulls from it directly, in parallel, with retries, and falls back to ECR.
#
# The CLI checks every registry candidate for a local copy before it pulls anything
# (apps/cli/src/command-internal/docker-image-resolve.ts at v2.120.0), so an image already present as
# ghcr.io/supabase/<name>:<tag> starts without a pull. SUPABASE_INTERNAL_IMAGE_REGISTRY stays unset
# on purpose: setting it would also switch off the CLI's own fallback for any image missed here.
#
# Versions come from the CLI itself (`supabase services`), so a CLI upgrade moves them with it. Kong,
# Mailpit and pg_prove are not listed by that command; their tags below match the CLI's service
# Dockerfile at the pinned version (apps/cli/src/shared/services/Dockerfile). A stale or failed pull
# only costs time: the step warns, and the CLI pulls the image itself. Bash 3.2 compatible, for the
# macOS runners' /bin/bash.

set -euo pipefail

PROFILE="${1:-start}"
PINNED_CLI="2.120.0"
KONG_TAG="2.8.1"
MAILPIT_TAG="v1.31.3"
PG_PROVE_TAG="3.36"
REGISTRIES=("ghcr.io/supabase" "public.ecr.aws/supabase")
DELAYS=(5 15 30)

case "$PROFILE" in
  start) WANTED=(postgres gotrue postgrest realtime storage-api edge-runtime kong mailpit) ;;
  db) WANTED=(postgres gotrue realtime storage-api pg_prove) ;;
  *)
    echo "Profile must be start or db, got $PROFILE." >&2
    exit 2
    ;;
esac

warn() {
  if [[ -n "${GITHUB_ACTIONS:-}" ]]; then echo "::warning title=Supabase images::$*"; else echo "warning: $*" >&2; fi
}

cli_version="$(supabase --version 2>/dev/null | head -n 1 || true)"
if [[ "$cli_version" != "$PINNED_CLI" ]]; then
  warn "Supabase CLI is ${cli_version:-missing}; the Kong, Mailpit and pg_prove tags here match $PINNED_CLI. Check them against the CLI's service Dockerfile."
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
printf 'kong=%s\nmailpit=%s\npg_prove=%s\n' "$KONG_TAG" "$MAILPIT_TAG" "$PG_PROVE_TAG" >"$WORK/tags"
# name=tag for every service `supabase services` lists, keyed by the image's last path segment.
if ! supabase services -o json 2>/dev/null | python3 -c '
import json, sys
for service in json.load(sys.stdin):
    print(service["name"].rsplit("/", 1)[-1] + "=" + service["local"])
' >>"$WORK/tags"; then
  warn "supabase services gave no versions; only Kong, Mailpit and pg_prove are pulled ahead."
fi

tag_for() { sed -n "s/^$1=//p" "$WORK/tags" | tail -n 1; }

pull_one() {
  local image="$1" registry attempt
  for registry in "${REGISTRIES[@]}"; do
    for attempt in 0 1 2 3; do
      if docker pull --quiet "$registry/$image" >/dev/null 2>"$WORK/$image.err"; then
        echo "$registry/$image" >"$WORK/$image.ok"
        return 0
      fi
      if [[ $attempt -lt 3 ]]; then sleep "${DELAYS[$attempt]}"; fi
    done
  done
  return 1
}

IMAGES=()
for name in "${WANTED[@]}"; do
  tag="$(tag_for "$name")"
  if [[ -z "$tag" ]]; then
    warn "No version for $name; the CLI pulls it itself."
    continue
  fi
  IMAGES+=("$name:$tag")
  pull_one "$name:$tag" &
done
wait || true

failed=0
for image in "${IMAGES[@]}"; do
  if [[ -f "$WORK/$image.ok" ]]; then
    echo "local: $(cat "$WORK/$image.ok")"
  else
    failed=1
    warn "Could not pull $image from GHCR or ECR ($(tail -n 1 "$WORK/$image.err" 2>/dev/null || true)); the CLI tries again, Docker Hub included."
  fi
done
if [[ $failed -eq 0 ]]; then echo "All ${#IMAGES[@]} images for supabase $PROFILE are local."; fi
exit 0
