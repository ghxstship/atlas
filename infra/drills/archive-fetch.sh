#!/usr/bin/env bash
# The weekly backup's restore path, first half: fetch an archive from the private bucket, check it and decrypt it.
#
#   BACKUP_S3_...=<the restore key's values> infra/drills/archive-fetch.sh --environment production --out <dir> \
#     [--key <object key>] [--sha256 <the run summary's sha256>]
#
# Reads the bucket with the owner's read-only restore key, never the key CI writes with, from the same five settings
# CI uses (infra/ci/backup-store.sh). Downloads the newest archive under <environment>/, or the one --key names;
# checks its SHA-256 against the one recorded at upload and, with --sha256, against the run summary's; decrypts it
# with the owner's private key from the local keyring (gpg asks for its passphrase); and unpacks it into
# <out>/<archive name>/, readable by the current user only. Prints that folder. It connects to no database: restore the
# files with archive-restore.sh (a local drill), or as backup-and-restore.md, Restoring production, describes.
# The unpacked files are production personal data. Delete the folder once the drill or the restore is done.
set -euo pipefail

STORE="$(cd "$(dirname "$0")/../ci" && pwd)/backup-store.sh"
ENVIRONMENT=""
OUT=""
KEY=""
EXPECTED=""

die() {
  echo "archive-fetch: $*" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --environment) ENVIRONMENT="${2:-}"; shift 2 ;;
    --out) OUT="${2:-}"; shift 2 ;;
    --key) KEY="${2:-}"; shift 2 ;;
    --sha256) EXPECTED="$(tr '[:upper:]' '[:lower:]' <<<"${2:-}")"; shift 2 ;;
    *) die "Unknown argument $1" ;;
  esac
done
[[ "$ENVIRONMENT" =~ ^[a-z][a-z0-9-]*$ ]] || die "Pass --environment production (or staging)."
[[ -n "$OUT" ]] || die "Pass --out <dir>, a folder on an encrypted disk."
[[ -z "$EXPECTED" || "$EXPECTED" =~ ^[0-9a-f]{64}$ ]] || die "--sha256 takes the 64 hex digits from the run summary."
command -v gpg >/dev/null || die "gpg is not installed (brew install gnupg)."
"$STORE" check || exit 1

if [[ -z "$KEY" ]]; then
  KEY="$("$STORE" list "$ENVIRONMENT" | tail -1)"
  [[ -n "$KEY" ]] || die "The bucket holds no archive under ${ENVIRONMENT}/."
fi
[[ "$KEY" == "${ENVIRONMENT}/"*.tar.gz.gpg ]] || die "${KEY} is not a ${ENVIRONMENT} archive."
NAME="$(basename "$KEY" .tar.gz.gpg)"

umask 077
mkdir -p "$OUT"
DEST="$OUT/$NAME"
[[ ! -e "$DEST" ]] || die "${DEST} exists already: remove it or choose another --out."
ENCRYPTED="$OUT/$NAME.tar.gz.gpg"
SHA256="$("$STORE" get "$KEY" "$ENCRYPTED")"
echo "ok: ${KEY} matches the SHA-256 recorded at upload"
if [[ -n "$EXPECTED" ]]; then
  [[ "$SHA256" == "$EXPECTED" ]] || { rm -f "$ENCRYPTED"; die "${KEY} does not match the SHA-256 you passed."; }
  echo "ok: it matches the run summary's"
fi

# Decrypted straight into tar, so no unencrypted archive is written.
mkdir "$DEST"
trap '[[ -f "$DEST/.complete" ]] || rm -rf "$DEST"' EXIT
gpg --decrypt --quiet "$ENCRYPTED" | tar -xzf - -C "$DEST"

REQUIRED="roles.sql schema.sql data.sql"
[[ "$ENVIRONMENT" == production ]] && REQUIRED="$REQUIRED platform.sql cron.sql migrations.txt"
for file in $REQUIRED; do
  [[ -s "$DEST/$file" ]] || die "The archive has no ${file}."
done
touch "$DEST/.complete"
rm -f "$ENCRYPTED"
echo "ok: decrypted and unpacked ${REQUIRED}"
echo "The files are personal data: delete ${DEST} once the restore or the drill is done."
echo "dir=${DEST}"
