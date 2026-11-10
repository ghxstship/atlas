#!/usr/bin/env bash
# CI: the journeys' environment, from the CI stack `supabase start` just started. The same for the e2e job in ci.yml
# (Chromium) and the engines job in nightly.yml (Firefox and WebKit), so the nightly journeys never run on an older copy
# of what the per-push journeys read. The nightly had lost the anon key, the JWT secret, the API host, the inbound domain
# and the fake Stripe, so every journey that needs them failed there and nowhere else (run 42489339979).
#
#   infra/ci/e2e-env.sh
#
# Writes apps/atlas/.env.local and apps/gateway/.env.local for the production servers, and appends the E2E_* variables
# to $GITHUB_ENV. Needs XOS_FILE_HANDOVER_SECRET in the environment (the step before makes a fresh one per run).
#
# - XOS_API_HOST: e2e/api-host.spec.ts reaches the API host by sending Host: api.localhost (RRR-119).
# - XOS_INBOUND_DOMAIN: the project inbox journey (a84) reads the full address Project Settings shows.
# - STRIPE_*: e2e/billing-checkout.spec.ts pays on its local fake of Stripe (e2e/fake-stripe.ts), never Stripe.
# - The local stack's keys (Supabase CLI 3, ADR 0168): the publishable key for the apps and A79's step-up
#   (a79-support.ts), the secret key for the import and report journeys' workers, and the stack's development JWT
#   secret, which the automation journey signs the worker's API calls with (a91-automations; production refuses it).

set -euo pipefail

: "${XOS_FILE_HANDOVER_SECRET:?Set XOS_FILE_HANDOVER_SECRET first.}"
: "${GITHUB_ENV:?Run in GitHub Actions, or set GITHUB_ENV to a file.}"

STATUS="$(supabase status -o env)"
stack() { printf '%s\n' "$STATUS" | sed -n "s/^$1=\"\(.*\)\"$/\1/p"; }
ANON="$(stack PUBLISHABLE_KEY)"
SERVICE="$(stack SECRET_KEY)"
JWT="$(stack JWT_SECRET)"
if [[ -z "$ANON" || -z "$SERVICE" || -z "$JWT" ]]; then
  echo "supabase status gave no publishable key, secret key or JWT secret; is the stack running?" >&2
  exit 1
fi

printf 'SUPABASE_URL=http://127.0.0.1:55421\nSUPABASE_ANON_KEY=%s\nATLAS_SITE_URL=http://127.0.0.1:3006\nGATEWAY_SITE_URL=http://127.0.0.1:3127\nSUPABASE_INBUCKET_URL=http://127.0.0.1:55424\nXOS_API_HOST=api.localhost\nXOS_INBOUND_DOMAIN=inbound.xos.localhost\nSTRIPE_SECRET_KEY=sk_test_abcdefghij\nSTRIPE_API_URL=http://127.0.0.1:12111\nXOS_FILE_HANDOVER_SECRET=%s\n' \
  "$ANON" "$XOS_FILE_HANDOVER_SECRET" >apps/atlas/.env.local
printf 'SUPABASE_URL=http://127.0.0.1:55421\nSUPABASE_ANON_KEY=%s\nGATEWAY_SITE_URL=http://127.0.0.1:3127\nGATEWAY_PLATFORM_HOSTS=127.0.0.1,localhost\n' \
  "$ANON" >apps/gateway/.env.local

{
  echo "E2E_ATLAS_URL=http://127.0.0.1:3006"
  echo "E2E_API_HOST=api.localhost"
  echo "E2E_GATEWAY_URL=http://127.0.0.1:3127"
  echo "E2E_SUPABASE_URL=http://127.0.0.1:55421"
  echo "E2E_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55422/postgres"
  echo "E2E_INBUCKET_URL=http://127.0.0.1:55424"
  echo "E2E_SUPABASE_ANON_KEY=$ANON"
  echo "E2E_SUPABASE_SERVICE_KEY=$SERVICE"
  echo "E2E_SUPABASE_JWT_SECRET=$JWT"
} >>"$GITHUB_ENV"
