#!/usr/bin/env bash
# The status page's incident list, one file on the single-commit ref refs/status/incidents.
#   infra/ci/status-incidents.sh fetch <dir>     writes <dir>/incidents.json ([] when the ref does not exist yet)
#   infra/ci/status-incidents.sh publish <dir>   checks <dir>/incidents.json and replaces the ref with it
# The incident commander runs both from their own checkout (infra/runbooks/incident-response.md), and the
# status page job runs fetch. It is a ref and not a file on main so that posting an incident needs no pull
# request, no CI run and no production deployment: the main ruleset applies only to the default branch.
# Like refs/status/history it is not a branch, because Vercel deploys every branch push.
# publish refuses to overwrite a list that changed since this checkout fetched it, so two people updating
# at once cannot erase each other's entry: fetch again, redo the edit, publish again.
set -euo pipefail

COMMAND="${1:?fetch or publish}"
DIR="${2:?directory}"
REF="refs/status/incidents"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
mkdir -p "$DIR"

case "$COMMAND" in
  fetch)
    status=0
    git ls-remote --exit-code origin "$REF" >/dev/null || status=$?
    case "$status" in
      0)
        git fetch --quiet --depth 1 origin "+${REF}:${REF}"
        git show "${REF}:incidents.json" >"$DIR/incidents.json"
        git rev-parse "$REF" >"$DIR/.incidents-base"
        ;;
      2)
        echo "No ${REF} yet; the list starts empty."
        printf '[]\n' >"$DIR/incidents.json"
        : >"$DIR/.incidents-base"
        ;;
      *) echo "Could not read origin." >&2; exit "$status" ;;
    esac
    ;;
  publish)
    [[ -f "$DIR/incidents.json" ]] || { echo "${DIR}/incidents.json is missing." >&2; exit 1; }
    [[ -f "$DIR/.incidents-base" ]] || { echo "Run fetch first, then edit ${DIR}/incidents.json." >&2; exit 1; }
    node --experimental-strip-types --no-warnings "$ROOT/infra/status/src/cli.ts" --check-incidents "$DIR/incidents.json"
    BASE="$(cat "$DIR/.incidents-base")"
    BLOB="$(git hash-object -w "$DIR/incidents.json")"
    TREE="$(printf '100644 blob %s\tincidents.json\n' "$BLOB" | git mktree)"
    COMMIT="$(git -c user.name=xos-status -c user.email=xos-status@users.noreply.github.com \
      commit-tree "$TREE" -m "incidents: $(date -u +%Y-%m-%dT%H:%MZ)")"
    if ! git push --quiet --force-with-lease="${REF}:${BASE}" origin "${COMMIT}:${REF}"; then
      echo "The list changed since your fetch. Run fetch again, redo your edit, then publish." >&2
      exit 1
    fi
    echo "$COMMIT" >"$DIR/.incidents-base"
    echo "Published. Run: gh workflow run synthetics.yml --repo ghxstship/atlas --ref main"
    ;;
  *) echo "The first argument is fetch or publish." >&2; exit 2 ;;
esac
