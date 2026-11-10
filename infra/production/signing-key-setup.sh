#!/usr/bin/env bash
# XOS's own JWT signing key for one Supabase project (ADR 0168, D5). The owner runs it once per project:
#
#   infra/production/signing-key-setup.sh <project-ref>
#
# It makes an ES256 private key (`supabase gen signing-key`) in ~/xos-signing-keys/<project-ref>.jwk.json, readable
# only by you, sets it as the Edge Function secret XOS_API_JWT_SIGNING_KEY, and puts it on the clipboard for the one
# dashboard step: Settings, JWT Keys, create a standby key by importing it, then rotate to it. The key is never printed;
# the clipboard is cleared when you press Enter. Safe to run again: it reuses the key it made.
set -euo pipefail

PROJECT="${1:?Usage: infra/production/signing-key-setup.sh <project-ref>}"
DIR="$HOME/xos-signing-keys"
FILE="$DIR/$PROJECT.jwk.json"
umask 077
mkdir -p "$DIR"

if [[ ! -s "$FILE" ]]; then
  supabase gen signing-key --algorithm ES256 > "$FILE" 2> /dev/null
fi
kid="$(python3 -c 'import json,sys; k=json.load(open(sys.argv[1])); k=k[0] if isinstance(k,list) else k; assert k["kty"]=="EC" and k["crv"]=="P-256" and k.get("d") and k.get("kid"); print(k["kid"])' "$FILE")" ||
  { echo "$FILE is not an ES256 private JWK; remove it and run again." >&2; exit 1; }

echo "1/2 Setting XOS_API_JWT_SIGNING_KEY on $PROJECT (key id $kid)"
supabase secrets set --project-ref "$PROJECT" XOS_API_JWT_SIGNING_KEY="$(cat "$FILE")" > /dev/null

python3 -c 'import json,sys; k=json.load(open(sys.argv[1])); k=k[0] if isinstance(k,list) else k; print(json.dumps(k))' "$FILE" | pbcopy
cat <<EOF
2/2 The key is on the clipboard. In the Supabase dashboard for $PROJECT:
    Settings > JWT Keys > Create standby key > Import an existing private key, paste (Cmd-V), create.
    Wait for it to show as Standby (about 5 minutes), then Rotate keys. Nobody is signed out.
    Key id to look for: $kid
EOF
read -r -p "Press Enter once it is imported, to clear the clipboard. "
pbcopy < /dev/null
echo "Done. The private key stays in $FILE; keep that file backed up and private."
