#!/bin/sh
# Core-screen visual regression in the pinned Playwright image (Section 18, gate 9).
#
#   packages/testing/ci/visual-in-container.sh <atlas|gateway> [playwright test arguments]
#
# Runs apps/<app>/e2e/visual in mcr.microsoft.com/playwright at the pinned version, on linux/amd64
# with HOME=/root, the image the Storybook baselines and the CI visual jobs use, so a baseline made on
# a laptop matches CI. The app (next dev, for the ar-XB pseudo-locale) and the Supabase stack run
# beside the container, which shares the host network; E2E_BASE_URL names the app. The repository is
# mounted at its own path, so its installed node_modules resolve inside the container. On Docker
# Desktop, set VISUAL_FORWARD_PORTS to the app's port (forward-ports.mjs explains why).
#
# Pass VISUAL_UPDATE_SNAPSHOTS=missing, changed or all to write baselines.
set -eu

app=${1:?usage: visual-in-container.sh <atlas|gateway> [playwright arguments]}
shift
root=$(cd "$(dirname "$0")/../../.." && pwd)
image=mcr.microsoft.com/playwright:v1.64.0-noble

exec docker run --rm --platform linux/amd64 --network host --ipc=host \
  -e HOME=/root \
  -e CI \
  -e E2E_BASE_URL \
  -e E2E_SUPABASE_URL \
  -e E2E_SUPABASE_ANON_KEY \
  -e VISUAL_UPDATE_SNAPSHOTS \
  -e VISUAL_WORKERS \
  -e VISUAL_FORWARD_PORTS \
  -v "$root:$root" \
  -w "$root/apps/$app" \
  "$image" \
  node "$root/packages/testing/ci/forward-ports.mjs" \
  node node_modules/@playwright/test/cli.js test -c e2e/visual/playwright.visual.config.ts "$@"
