#!/bin/sh
# A59 visual review: walks the workflow journeys end to end by running the existing Playwright journey
# specs against this worktree's production servers and Supabase stack, with a trace of every action.
# extract-traces.mjs turns each trace into step screenshots. Nothing in apps/ is changed: the specs run
# as written, only the base URLs, the browser and the trace mode come from the command line.
#   node extract-traces.mjs afterwards
set -u
root="$(cd "$(dirname "$0")/../../../.." && pwd)"
out="$root/legal/qa/visual-review/shots/workflows"
mkdir -p "$out"
status_json="$(cd "$root" && supabase status -o json 2>/dev/null)"
field() { printf '%s' "$status_json" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.parse(s)['$1']??''))"; }
export E2E_SUPABASE_URL="$(field API_URL)"
export E2E_SUPABASE_SERVICE_KEY="$(field SERVICE_ROLE_KEY)"
export E2E_SUPABASE_ANON_KEY="$(field ANON_KEY)"
export E2E_DATABASE_URL="$(field DB_URL)"
export E2E_INBUCKET_URL="$(field INBUCKET_URL)"
export E2E_ENGINES=chromium
export E2E_SKIP_AURORA=1
export PLAYWRIGHT_CHROMIUM_EXECUTABLE="${PLAYWRIGHT_CHROMIUM_EXECUTABLE:-$HOME/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell}"

run() {
  app="$1"
  name="$2"
  shift 2
  if [ "$app" = atlas ]; then
    base=http://127.0.0.1:3059
  else
    base=http://127.0.0.1:3159
  fi
  echo "== $app $name: $*"
  (cd "$root/apps/$app" && E2E_BASE_URL="$base" E2E_ATLAS_URL=http://127.0.0.1:3059 \
    pnpm exec playwright test "$@" --project=chromium --trace=on --workers=1 --retries=0 \
    --output="$out/$app-$name" --reporter=line) > "$out/$app-$name.log" 2>&1
  echo "   exit=$? ($(tail -3 "$out/$app-$name.log" | tr '\n' ' ' | cut -c1-160))"
}

only="${1:-}"
want() { [ -z "$only" ] || [ "$only" = "$1" ]; }

want template && run atlas template e2e/a33-workflow.spec.ts:54
want gate && run atlas gate e2e/projects.spec.ts:124
want credential-scan && run atlas credential-scan e2e/credentials-incidents.spec.ts:48
want budget && run atlas budget e2e/finance.spec.ts:93 e2e/finance.spec.ts:202
want rfq-po && run atlas rfq-po e2e/a16-journeys.spec.ts:37
want crew-atlas && run atlas crew-atlas e2e/crew.spec.ts:103 e2e/crew.spec.ts:243
want crew-gateway && run gateway crew-gateway e2e/crew-lifecycle.spec.ts:33
want vendor-invoice && run gateway vendor-invoice e2e/vendor-lifecycle.spec.ts:77
want incident && run atlas incident e2e/credentials-incidents.spec.ts:139
want import && run atlas import e2e/a36-import.spec.ts
want report-builder && run atlas report-builder e2e/a33-workflow.spec.ts:70
want report-dashboard && run atlas report-dashboard e2e/a43-journey-29.spec.ts
want handoff && run atlas handoff e2e/a45-handoff.spec.ts
want finance-lead && run atlas finance-lead e2e/finance-lead.spec.ts:21
want tokens && run gateway tokens e2e/tokens.spec.ts
# The other Gateway role types have no seeded engagement; their journey specs create one.
want artist && run gateway artist e2e/artist.spec.ts
want client && run gateway client e2e/client.spec.ts
want sponsor && run gateway sponsor e2e/sponsor.spec.ts
want staff && run gateway staff e2e/staff.spec.ts
exit 0
