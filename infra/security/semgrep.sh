#!/bin/sh
# Semgrep (Section 18 gate 11): the OSS engine in a pinned image, with the registry rulesets for
# TypeScript, React, Next.js, Node.js and SQL injection plus the local rules in
# infra/security/semgrep-rules.yml. Paths to skip are in .semgrepignore at the repository root.
# Exits 1 on any finding. False positives are suppressed in place with a `nosemgrep: <rule id>`
# comment that says why.
#
#   sh infra/security/semgrep.sh             # text report
#   sh infra/security/semgrep.sh --sarif     # SARIF for code scanning, written to semgrep.sarif
set -eu

IMAGE="semgrep/semgrep:1.140.0"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

FORMAT="--text"
OUTPUT=""
if [ "${1:-}" = "--sarif" ]; then
  FORMAT="--sarif"
  OUTPUT="--output=/src/semgrep.sarif"
fi

# The local rules first: each must report the `ruleid:` lines of its fixture and none of the `ok:` lines.
docker run --rm \
  -v "$ROOT:/src" \
  -w /src \
  "$IMAGE" \
  semgrep --test --metrics=off \
  --config infra/security/semgrep-rules.yml \
  infra/security/semgrep-rules.ts

# --no-git-ignore: the scan reads .semgrepignore, which lists the ignored folders, so it works the
# same in a git worktree, whose .git file points outside the mounted folder.
docker run --rm \
  -v "$ROOT:/src" \
  -w /src \
  "$IMAGE" \
  semgrep scan \
  --config p/typescript \
  --config p/react \
  --config p/nextjs \
  --config p/nodejs \
  --config p/sql-injection \
  --config infra/security/semgrep-rules.yml \
  --metrics=off \
  --no-git-ignore \
  --error \
  $FORMAT $OUTPUT
