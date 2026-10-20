#!/bin/sh
# CI: installs Maestro at MAESTRO_VERSION and runs apps/compass/.maestro against the installed release
# build, with the variables apps/compass/scripts/maestro-ci-env.sh printed (SUPABASE_URL,
# SUPABASE_ANON_KEY, KIOSK_DEVICE_KEY, KIOSK_PIN_1 to KIOSK_PIN_4) already in the environment.
#
#   apps/compass/scripts/maestro-ci.sh                              Android, or iOS with the network
#                                                                   helper running: every flow
#   apps/compass/scripts/maestro-ci.sh --exclude-tags airplane-mode iOS without the helper: Maestro
#                                                                   sets airplane mode only on Android
#
# On iOS the airplane-mode flows go offline by cutting the server: start
# apps/compass/scripts/maestro-network.ts serve first (SUPABASE_URL and SUPABASE_PROJECT_ID set), as the
# nightly job and apps/compass/scripts/maestro-ios.sh do.
#
# Extra arguments go to `maestro test`. The JUnit report and each flow's screenshots and logs land in
# MAESTRO_OUTPUT (default node_modules/.cache/maestro) for the job's artifact. One script line, so the
# Android emulator runner, which runs each line of its script on its own, can call it.
set -eu

: "${MAESTRO_VERSION:?Set MAESTRO_VERSION to the pinned Maestro CLI version.}"
OUT="${MAESTRO_OUTPUT:-node_modules/.cache/maestro}"
mkdir -p "$OUT"

if [ "$("$HOME/.maestro/bin/maestro" --version 2>/dev/null || true)" != "$MAESTRO_VERSION" ]; then
  # The installer reads MAESTRO_VERSION and installs that release.
  curl -fsSL "https://get.maestro.mobile.dev" | bash
fi

"$HOME/.maestro/bin/maestro" test \
  -e XOS_DEMO_PASSWORD="${XOS_DEMO_PASSWORD:-xos-demo-2026}" \
  -e SUPABASE_URL="$SUPABASE_URL" \
  -e SUPABASE_ANON_KEY="$SUPABASE_ANON_KEY" \
  -e KIOSK_DEVICE_KEY="$KIOSK_DEVICE_KEY" \
  -e KIOSK_PIN_1="$KIOSK_PIN_1" -e KIOSK_PIN_2="$KIOSK_PIN_2" \
  -e KIOSK_PIN_3="$KIOSK_PIN_3" -e KIOSK_PIN_4="$KIOSK_PIN_4" \
  --format junit --output "$OUT/report.xml" --test-output-dir "$OUT/flows" \
  "$@" apps/compass/.maestro
