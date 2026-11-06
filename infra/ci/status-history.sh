#!/usr/bin/env bash
# CI: the synthetic checks' history, one file on the single-commit branch status-data, which the
# workflow force-pushes so the repository does not grow with every run.
#   infra/ci/status-history.sh fetch <dir>     writes <dir>/history.json when the branch exists
#   infra/ci/status-history.sh publish <dir>   replaces the branch with <dir>
# Run from a checkout whose origin the job's token can read and, to publish, write. A branch that does
# not exist yet is a first run. Any other failure stops the step: treating it as a first run would reset
# every failure streak, and then nothing would alert.
set -euo pipefail

COMMAND="${1:?fetch or publish}"
DIR="${2:?directory}"
BRANCH="status-data"
mkdir -p "$DIR"

case "$COMMAND" in
  fetch)
    status=0
    git ls-remote --exit-code --heads origin "$BRANCH" >/dev/null || status=$?
    case "$status" in
      0)
        git fetch --quiet --depth 1 origin "+refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}"
        git show "origin/${BRANCH}:history.json" >"$DIR/history.json"
        ;;
      2) echo "No ${BRANCH} branch yet; this run starts the history." ;;
      *) echo "Could not read origin." >&2; exit "$status" ;;
    esac
    ;;
  publish)
    [[ -f "$DIR/history.json" ]] || { echo "${DIR}/history.json is missing." >&2; exit 1; }
    # An orphan commit made inside the checkout, whose credential a new repository would not have.
    BLOB="$(git hash-object -w "$DIR/history.json")"
    TREE="$(printf '100644 blob %s\thistory.json\n' "$BLOB" | git mktree)"
    COMMIT="$(git -c user.name=xos-synthetics -c user.email=xos-synthetics@users.noreply.github.com \
      commit-tree "$TREE" -m "status: $(date -u +%Y-%m-%dT%H:%MZ)")"
    git push --quiet --force origin "${COMMIT}:refs/heads/${BRANCH}"
    ;;
  *) echo "The first argument is fetch or publish." >&2; exit 2 ;;
esac
