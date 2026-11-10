#!/usr/bin/env bash
# Checks an XOS API key end to end against a hosted project (ADR 0168, D5): the key is exchanged at api-token for a
# short-lived token signed with the project signing key, then the public API answers GET /v1/me with it. The owner
# runs it after creating a key in Atlas (Settings, API keys and service accounts):
#
#   infra/production/api-key-check.sh [project-ref] [api-host]
#
# Copy the key with Atlas's copy button first. The script reads it from the clipboard, clears the clipboard at once,
# and never prints the key or the token: only status codes, the token's signing key id and the org it is bound to.
# Revoke the key in Atlas afterwards.
set -euo pipefail

PROJECT="${1:-fquuqnzlpobaawucczgq}"
API_HOST="${2:-api.ghxstship.tech}"
KEY="$(pbpaste | head -n 1 | tr -d '[:space:]')"
pbcopy < /dev/null
[[ "$KEY" =~ ^xos_(live|pat)_[0-9a-f]{48}$ ]] ||
  { echo "The clipboard does not hold an XOS API key (xos_live_ and 48 hex characters). Copy it in Atlas and run again." >&2; exit 1; }

echo "1/2 Exchanging the key at api-token on $PROJECT"
EXCHANGE="$(curl -s -w '\n%{http_code}' -X POST "https://$PROJECT.supabase.co/functions/v1/api-token" \
  -H "Authorization: Bearer $KEY")"
STATUS="${EXCHANGE##*$'\n'}"
BODY="${EXCHANGE%$'\n'*}"
echo "    HTTP $STATUS"
[[ "$STATUS" == 200 ]] || { printf '    %s\n' "$(printf '%s' "$BODY" | head -c 300)"; exit 1; }
printf '%s' "$BODY" | python3 -c '
import base64, json, sys
body = json.load(sys.stdin)
head = body["access_token"].split(".")[0]
head = json.loads(base64.urlsafe_b64decode(head + "=" * (-len(head) % 4)))
print("    token: alg", head.get("alg"), "kid", head.get("kid"), "expires_in", body.get("expires_in"), "org", body.get("org_id"))
'

echo "2/2 GET https://$API_HOST/v1/me with the key"
ME="$(curl -s -w '\n%{http_code}' "https://$API_HOST/v1/me" -H "Authorization: Bearer $KEY")"
STATUS="${ME##*$'\n'}"
echo "    HTTP $STATUS"
[[ "$STATUS" == 200 ]] || { printf '    %s\n' "$(printf '%s' "${ME%$'\n'*}" | head -c 300)"; exit 1; }
unset KEY
echo "Passed. Revoke the key in Atlas (Settings, API keys and service accounts) when you are done."
