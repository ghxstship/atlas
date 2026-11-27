#!/bin/sh
# Waits until a password sign-in of the Demo Field Lead through SUPABASE_URL, the app's own path,
# and a read of app.memberships as that person succeed, for up to the given number of seconds (default
# 300). On a timeout it prints the last status and body (tokens redacted) and the Auth, Kong and
# PostgREST logs of the stack XOS_SUPABASE_STACK.
#
#   XOS_SUPABASE_STACK=xos4 apps/compass/scripts/maestro-signin-wait.sh 300
#
# The body sits in a file and each status in a variable: the macOS runner's bash 3.2 split inline,
# nested-quoted JSON (run 43678837846: "[: too many arguments", GoTrue bad_json).
set -u

: "${SUPABASE_URL:?Set SUPABASE_URL (apps/compass/scripts/maestro-ci-env.sh).}"
: "${SUPABASE_ANON_KEY:?Set SUPABASE_ANON_KEY (apps/compass/scripts/maestro-ci-env.sh).}"
stack="${XOS_SUPABASE_STACK:-xos4}"
tmp="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
printf '{"email":"field@example.com","password":"%s"}' "${XOS_DEMO_PASSWORD:-xos-demo-2026}" > "$tmp/signin.json"
deadline=$(($(date +%s) + ${1:-300}))
while :; do
  health=$(curl -s -m 30 -o /dev/null -w '%{http_code}' -H "apikey: $SUPABASE_ANON_KEY" "$SUPABASE_URL/auth/v1/health" || true)
  token=$(curl -s -m 30 -o "$tmp/signin.out" -w '%{http_code}' -X POST -H "apikey: $SUPABASE_ANON_KEY" \
    -H 'Content-Type: application/json' --data-binary "@$tmp/signin.json" \
    "$SUPABASE_URL/auth/v1/token?grant_type=password" || true)
  # After the sign-in the app reads the person's access through PostgREST. Auth answering says nothing about
  # that: in run 45870505730 this wait passed, the app's own sign-in was accepted, and its first reads then
  # took 9 and 15 seconds each. A read as the signed-in person goes through here as well, which also loads
  # PostgREST's schema cache and the plans of the row level security functions before the first flow.
  rest=000
  if [ "$health" = 200 ] && [ "$token" = 200 ]; then
    access=$(sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p' "$tmp/signin.out")
    rest=$(curl -s -m 60 -o /dev/null -w '%{http_code}' -H "apikey: $SUPABASE_ANON_KEY" \
      -H "Authorization: Bearer $access" -H 'Accept-Profile: app' \
      "$SUPABASE_URL/rest/v1/memberships?select=id&limit=1" || true)
  fi
  if [ "$rest" = 200 ]; then
    echo "Password sign-in and a read as that person through $SUPABASE_URL succeeded."
    exit 0
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "A password sign-in and read through $SUPABASE_URL did not succeed in time (health $health, token $token, read $rest)." >&2
    echo "Last token response body:" >&2
    sed -E 's/"(access|refresh)_token":"[^"]*"/"\1_token":"<redacted>"/g' "$tmp/signin.out" >&2 || true
    echo >&2
    docker ps -a --filter "label=com.supabase.cli.project=$stack" --format '{{.Names}} {{.Status}}' >&2 || true
    docker logs --tail 60 "supabase_auth_$stack" >&2 2>&1 || true
    docker logs --tail 40 "supabase_kong_$stack" >&2 2>&1 || true
    docker logs --tail 40 "supabase_rest_$stack" >&2 2>&1 || true
    exit 1
  fi
  sleep 5
done
