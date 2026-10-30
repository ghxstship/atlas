#!/usr/bin/env bash
# Gate 20 (Section 18): API breaking-change check against the last released OpenAPI document.
#
#   infra/ci/oasdiff.sh [--base-ref <git ref>] [--revision <file>] [--format text|markdown|githubactions]
#
# Compares packages/api/openapi/v1.json at the current commit (or --revision) with the same file at
# the latest `v*` tag (or --base-ref), using oasdiff at the pinned version below, and exits 1 when
# oasdiff reports a breaking change at level ERR. Before any `v*` tag exists there is no released
# baseline: the script says so and passes. The frozen-contract test
# (packages/api/test/corrections.test.ts) guards v1 on every push either way.
#
# oasdiff runs from its Docker image, pinned by version and digest. Set OASDIFF_BIN to a local
# oasdiff binary of the same version to run without Docker. The documents are mounted read-only,
# and external $refs are refused, so a document can never make oasdiff fetch anything.
#
# A one-off exception (ADR 0014) is a line in an err-ignore file next to the ADR that accepts it,
# docs/adr/<number>-oasdiff-err-ignore.txt. Every such file is passed to oasdiff as --err-ignore; a line
# names the operation and the change exactly as oasdiff reports it, and lines starting with # are comments.

set -euo pipefail

OASDIFF_VERSION="v1.33.0"
OASDIFF_IMAGE="tufin/oasdiff:${OASDIFF_VERSION}@sha256:6263a96dd2ef0726c54e21fea9b8e1607eac4841add0079324b424c1f52b819c"
DOCUMENT="packages/api/openapi/v1.json"

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
BASE_REF=""
REVISION="$REPO/$DOCUMENT"
FORMAT="text"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --base-ref) BASE_REF="$2"; shift 2 ;;
    --revision) REVISION="$2"; shift 2 ;;
    --format) FORMAT="$2"; shift 2 ;;
    *) echo "oasdiff: unknown argument $1" >&2; exit 2 ;;
  esac
done

case "$FORMAT" in
  text | markdown | githubactions | singleline) ;;
  *) echo "oasdiff: --format must be text, markdown, githubactions or singleline" >&2; exit 2 ;;
esac
[[ -f "$REVISION" ]] || { echo "oasdiff: revision document $REVISION not found" >&2; exit 2; }

if [[ -z "$BASE_REF" ]]; then
  # Highest version first; pre-release tags (v4.1.0-rc.1) are not released baselines.
  BASE_REF="$(git -C "$REPO" tag --list 'v*' --sort=-v:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -1 || true)"
  if [[ -z "$BASE_REF" ]]; then
    echo "Gate 20: no released baseline yet (no v* tag), so there is nothing to compare. Passing."
    echo "Gate 20: the frozen-contract test (packages/api/test/corrections.test.ts) guards v1 until the first tag."
    exit 0
  fi
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
if ! git -C "$REPO" cat-file -e "${BASE_REF}:${DOCUMENT}" 2>/dev/null; then
  echo "oasdiff: ${BASE_REF} has no ${DOCUMENT}; a released baseline must contain the document." >&2
  exit 1
fi
git -C "$REPO" show "${BASE_REF}:${DOCUMENT}" >"$WORK/base.json"
cp "$REVISION" "$WORK/revision.json"
IGNORES=()
for file in "$REPO"/docs/adr/*-oasdiff-err-ignore.txt; do
  [[ -f "$file" ]] && IGNORES+=("$file")
done

echo "Gate 20: comparing ${DOCUMENT} at ${BASE_REF} (base) with $( [[ "$REVISION" == "$REPO/$DOCUMENT" ]] && git -C "$REPO" rev-parse --short HEAD || echo "$REVISION") (revision), oasdiff ${OASDIFF_VERSION}"

ARGS=(breaking base.json revision.json --fail-on ERR --format "$FORMAT" --allow-external-refs=false)
if [[ ${#IGNORES[@]} -gt 0 ]]; then
  grep -hv -e '^#' -e '^[[:space:]]*$' "${IGNORES[@]}" >"$WORK/err-ignore.txt" || true
  echo "Gate 20: $(wc -l <"$WORK/err-ignore.txt" | tr -d ' ') recorded exceptions from ${#IGNORES[@]} ADR err-ignore files."
  ARGS+=(--err-ignore err-ignore.txt)
fi
# --color applies only to the text formats.
if [[ "$FORMAT" == "text" || "$FORMAT" == "singleline" ]]; then ARGS+=(--color never); fi
set +e
if [[ -n "${OASDIFF_BIN:-}" ]]; then
  ACTUAL="$("$OASDIFF_BIN" --version 2>/dev/null | awk '{print $NF}')"
  [[ "$ACTUAL" == "$OASDIFF_VERSION" ]] || { echo "oasdiff: OASDIFF_BIN is ${ACTUAL:-unknown}, expected ${OASDIFF_VERSION}" >&2; exit 2; }
  (cd "$WORK" && "$OASDIFF_BIN" "${ARGS[@]}")
  STATUS=$?
else
  command -v docker >/dev/null 2>&1 || { echo "oasdiff: Docker or OASDIFF_BIN is required" >&2; exit 2; }
  docker run --rm --network none -v "$WORK:/specs:ro" -w /specs "$OASDIFF_IMAGE" "${ARGS[@]}"
  STATUS=$?
fi
set -e

if [[ "$STATUS" == "0" ]]; then
  echo "Gate 20: no breaking changes since ${BASE_REF}."
else
  echo "Gate 20: breaking changes since ${BASE_REF} (listed above). /v1 changes only additively (ADR 0003, ADR 0014);" >&2
  echo "Gate 20: a breaking change needs a new major version path, or a superseding ADR and an ignore entry." >&2
fi
exit "$STATUS"
