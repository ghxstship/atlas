#!/bin/sh
# CycloneDX SBOM (Section 9 supply chain; legal/open-source-licenses.md section 3).
#
# Scans the installed node_modules of this checkout with syft in a pinned image and writes the SBOM, then
# checks it and renders the third-party notices list from it (infra/security/src/sbom.ts). Install
# production dependencies only first, so the SBOM lists what ships and not the build and test tooling:
#
#   pnpm install --frozen-lockfile --prod
#   sh infra/security/sbom.sh 4.0.0 out/        # writes out/xos-4.0.0.cdx.json and
#                                                # out/xos-4.0.0-third-party-notices.md
#
# syft reads only lockfiles in a directory by default; the installed-package cataloger is added so it
# reads each installed package.json, which carries the license the package declares. The lockfile itself
# is left out of the scan, because it lists development dependencies too.
set -eu

IMAGE="anchore/syft:v1.54.1@sha256:3eb5379ba7b409c3f4069b686110527af0c47df993fa5c10d13e7cf34f49b1aa"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
VERSION="${1:?Pass the release version, for example 4.0.0 or the commit SHA}"
OUT="${2:-sbom}"

mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
[ -d "$ROOT/node_modules/.pnpm" ] || { echo "No node_modules: run pnpm install --frozen-lockfile --prod first." >&2; exit 1; }

# The scanner reads the checkout and writes only to the output folder.
docker run --rm \
  -v "$ROOT:/src:ro" \
  -v "$OUT:/out" \
  "$IMAGE" \
  scan dir:/src \
  --source-name xos \
  --source-version "$VERSION" \
  --select-catalogers +javascript-package-cataloger \
  --exclude ./.git \
  --exclude ./pnpm-lock.yaml \
  --exclude './**/.next/**' \
  --exclude './**/.turbo/**' \
  --exclude './**/coverage/**' \
  --exclude './supabase/functions/_vendor/**' \
  --output "cyclonedx-json=/out/xos-${VERSION}.cdx.json" \
  --quiet

node --experimental-strip-types --no-warnings "$ROOT/infra/security/src/cli.ts" sbom \
  "$OUT/xos-${VERSION}.cdx.json" "$OUT/xos-${VERSION}-third-party-notices.md" "$VERSION"
