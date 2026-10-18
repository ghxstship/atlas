#!/bin/sh
# Journey 58 end to end (ADR 0030): Atlas shows the Continue on another device QR code, Playwright decodes
# it, and Maestro opens the decoded link in Compass on the iOS simulator and asserts the same record.
#
# Needs a freshly seeded local stack, Atlas serving it (E2E_PORT, default 3006) and a Compass build
# against the same stack on the booted simulator. Pass the demo password from
# supabase/seeds/0010_demo_identity.sql as XOS_DEMO_PASSWORD.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
link_file=$(mktemp)
(cd "$here/../../atlas" && E2E_ENGINES=chromium E2E_HANDOFF_OUT="$link_file" \
  npx playwright test e2e/a45-handoff.spec.ts --project=chromium)
link=$(head -1 "$link_file")
rm -f "$link_file"
echo "Atlas QR code carries: $link"
cd "$here/.."
maestro test -e XOS_DEMO_PASSWORD="$XOS_DEMO_PASSWORD" -e HANDOFF_LINK="$link" \
  .maestro/flows/handoff-open-record.yaml
