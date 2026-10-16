#!/bin/sh
# A22 security attack runner (RRR-41).
#
# Each *.attack.psql file in this directory reproduces one open finding in legal/security/findings
# as a pgTAP test. The files use the .psql extension so `supabase test db` (which runs every .sql
# file under supabase/tests) skips them and main stays green while the finding is open. This script
# copies them, with the shared .psql fixtures, to supabase/.temp as .sql files and runs them with `supabase test db` against the
# local stack.
#
# A failing assertion means the finding is still open. When the owner's fix lands, the attack passes;
# the finding is then closed and its file is renamed to a numbered regression test (9900 to 9949).
#
# Usage: supabase/tests/security/run-attacks.sh [A22-NNN ...]
# Exit status: 0 when every selected attack passes (every finding fixed), 1 otherwise.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
tests=$(dirname "$here")
root=$(dirname "$(dirname "$tests")")
out="$root/supabase/.temp/security-attacks"

rm -rf "$out"
mkdir -p "$out"

selected=0
for file in "$here"/*.attack.psql; do
  name=$(basename "$file" .attack.psql)
  if [ "$#" -gt 0 ]; then
    match=0
    for want in "$@"; do
      case "$name" in "$want"*) match=1 ;; esac
    done
    [ "$match" -eq 1 ] || continue
  fi
  # The copy sits beside the shared fixtures, so the relative includes drop their "../".
  sed 's#^\\ir \.\./#\\ir #' "$file" > "$out/$name.sql"
  selected=$((selected + 1))
done

if [ "$selected" -eq 0 ]; then
  echo "No attack files matched." >&2
  exit 1
fi

# supabase test db mounts only the directory it runs, so the shared fixtures travel with the copies.
cp "$tests"/*.psql "$out"/

cd "$root"
supabase test db "$out"
