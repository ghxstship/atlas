#!/usr/bin/env bash
# The weekly backup's private object storage (Section 9; infra/runbooks/backup-and-restore.md).
#
# No backup, encrypted or not, is ever stored on GitHub: not as a workflow artifact, a cache, a release asset or a
# commit. The repository is public, and anyone signed in to GitHub can download a public repository's artifacts.
# Archives go to an S3-compatible bucket the owner creates private, versioned and locked
# (infra/runbooks/security-owner-steps.md, step 1), named only by these secrets:
#   BACKUP_S3_ENDPOINT           https:// address of the S3 API, without the bucket
#   BACKUP_S3_REGION             the bucket's region (auto on Cloudflare R2)
#   BACKUP_S3_BUCKET             the bucket
#   BACKUP_S3_ACCESS_KEY_ID      a key limited to that bucket
#   BACKUP_S3_SECRET_ACCESS_KEY  its secret
#
#   infra/ci/backup-store.sh check                         every setting is present and well formed, or exit 1
#   infra/ci/backup-store.sh put <archive> <environment>   upload to <environment>/<archive's name>
#   infra/ci/backup-store.sh list <environment>            the object keys under <environment>/, oldest first
#   infra/ci/backup-store.sh get <key> <file>              download, then check the SHA-256 recorded at upload
#
# Requests are signed by curl (--aws-sigv4) with path-style addresses. The key pair reaches curl through a config
# file descriptor, never its command line. No value of these secrets is printed: messages name the secret only.
# An http:// endpoint is accepted only on this machine's loopback address, for tests against a local stack.
set -euo pipefail

SETTINGS=(BACKUP_S3_ENDPOINT BACKUP_S3_REGION BACKUP_S3_BUCKET BACKUP_S3_ACCESS_KEY_ID BACKUP_S3_SECRET_ACCESS_KEY)
LOOPBACK='^http://(127\.0\.0\.1|localhost)(:[0-9]+)?(/|$)'

fail() {
  echo "::error title=Backup storage::$*" >&2
  exit 1
}

# Every problem at once, so one failed run names each missing piece.
check() {
  local problems=() name
  for name in "${SETTINGS[@]}"; do
    [[ -n "${!name:-}" ]] || problems+=("The secret ${name} is empty: set it in the production-backup environment.")
  done
  if [[ -n "${BACKUP_S3_ENDPOINT:-}" && "$BACKUP_S3_ENDPOINT" != https://* && ! "$BACKUP_S3_ENDPOINT" =~ $LOOPBACK ]]; then
    problems+=("The secret BACKUP_S3_ENDPOINT is not an https:// address.")
  fi
  if [[ -n "${BACKUP_S3_BUCKET:-}" && ! "$BACKUP_S3_BUCKET" =~ ^[a-z0-9][a-z0-9.-]+[a-z0-9]$ ]]; then
    problems+=("The secret BACKUP_S3_BUCKET is not a bucket name: lowercase letters, digits, dots and hyphens.")
  fi
  command -v openssl >/dev/null || problems+=("openssl is not installed.")
  [[ "$(curl --help all 2>/dev/null)" == *--aws-sigv4* ]] || problems+=("This curl cannot sign requests (--aws-sigv4).")
  if [[ ${#problems[@]} -gt 0 ]]; then
    local problem
    for problem in "${problems[@]}"; do
      echo "::error title=Backup storage::${problem}" >&2
    done
    echo "Steps: infra/runbooks/security-owner-steps.md, 1. Secret values for the backup." >&2
    return 1
  fi
}

# A double-quoted value in a curl config file.
quoted() {
  local value="${1//\\/\\\\}"
  printf '"%s"' "${value//\"/\\\"}"
}

# request <path and query after the bucket> <response body file> [curl arguments]; prints the HTTP status. curl's own
# error messages stay silent, because they name the host, which is part of a secret; the caller reports its exit code.
request() {
  local target="$1" body="$2"
  shift 2
  local protocols="=https"
  [[ "$BACKUP_S3_ENDPOINT" =~ $LOOPBACK ]] && protocols="=http"
  curl --silent --proto "$protocols" --max-time 900 --retry 2 \
    --aws-sigv4 "aws:amz:${BACKUP_S3_REGION}:s3" \
    --config <(printf 'user = %s\n' "$(quoted "${BACKUP_S3_ACCESS_KEY_ID}:${BACKUP_S3_SECRET_ACCESS_KEY}")") \
    --output "$body" --write-out '%{http_code}' "$@" "${BACKUP_S3_ENDPOINT%/}/${BACKUP_S3_BUCKET}/${target}"
}

# The storage's own error code and message, never the request or its address.
refused() {
  local what="$1" status="$2" body="$3" code message
  code="$(sed -n 's:.*<Code>\([^<]*\)</Code>.*:\1:p' "$body" 2>/dev/null | head -1)"
  message="$(sed -n 's:.*<Message>\([^<]*\)</Message>.*:\1:p' "$body" 2>/dev/null | head -1)"
  rm -f "$body"
  fail "${what} was refused with HTTP ${status}${code:+ (${code}${message:+: ${message}})}."
}

sha256_of() {
  openssl dgst -sha256 -r "$1" | cut -d' ' -f1
}

environment_name() {
  [[ "$1" =~ ^[a-z][a-z0-9-]*$ ]] || fail "The environment is a lowercase name, for example production."
}

put() {
  local archive="${1:?archive}" environment="${2:?environment}"
  environment_name "$environment"
  [[ -s "$archive" ]] || fail "${archive} is missing or empty."
  local key sha md5 body status
  key="${environment}/$(basename "$archive")"
  [[ "$key" =~ ^[a-z0-9-]+/[A-Za-z0-9._-]+$ ]] || fail "The archive's name holds characters an object key should not."
  sha="$(sha256_of "$archive")"
  # Content-MD5 lets the storage reject a damaged upload, and is what S3 Object Lock requires on every write.
  md5="$(openssl dgst -md5 -binary "$archive" | openssl base64 -A)"
  body="$(mktemp)"
  status="$(request "$key" "$body" --upload-file "$archive" \
    --header "Content-Type: application/octet-stream" \
    --header "Content-MD5: ${md5}" \
    --header "x-amz-content-sha256: ${sha}" \
    --header "x-amz-meta-sha256: ${sha}")" ||
    { status=$?; rm -f "$body"; fail "The upload of ${key} did not complete (curl exit ${status})."; }
  [[ "$status" == 2?? ]] || refused "The upload of ${key}" "$status" "$body"
  rm -f "$body"
  echo "$key"
}

list() {
  local environment="${1:?environment}" body status
  environment_name "$environment"
  body="$(mktemp)"
  status="$(request "?list-type=2&prefix=${environment}%2F" "$body")" ||
    { status=$?; rm -f "$body"; fail "The list of ${environment}/ did not complete (curl exit ${status})."; }
  [[ "$status" == 2?? ]] || refused "The list of ${environment}/" "$status" "$body"
  # About five archives an environment at 35 days' retention, so one page of 1,000 always holds them all.
  if grep -q '<IsTruncated>true</IsTruncated>' "$body"; then
    rm -f "$body"
    fail "More than one page of ${environment}/: pass the object key."
  fi
  # An empty prefix lists nothing, which is not an error here; the caller decides.
  { grep -o '<Key>[^<]*</Key>' "$body" || true; } | sed -e 's:</*Key>::g' | sort
  rm -f "$body"
}

get() {
  local key="${1:?object key}" file="${2:?output file}" headers status want have
  [[ "$key" =~ ^[a-z0-9-]+/[A-Za-z0-9._-]+$ ]] || fail "${key} is not a backup's object key."
  headers="$(mktemp)"
  status="$(request "$key" "$file" --dump-header "$headers")" ||
    { status=$?; rm -f "$headers" "$file"; fail "The download of ${key} did not complete (curl exit ${status})."; }
  [[ "$status" == 2?? ]] || { rm -f "$headers"; refused "The download of ${key}" "$status" "$file"; }
  want="$(awk -F': *' 'tolower($1) == "x-amz-meta-sha256" {print $2}' "$headers" | tr -d '\r' | tail -1)"
  rm -f "$headers"
  have="$(sha256_of "$file")"
  [[ -n "$want" ]] || fail "${key} has no SHA-256 recorded at upload."
  [[ "$want" == "$have" ]] || { rm -f "$file"; fail "${key} does not match the SHA-256 recorded at upload."; }
  echo "$have"
}

COMMAND="${1:-}"
shift || true
case "$COMMAND" in
  check) check ;;
  put | list | get) check && "$COMMAND" "$@" ;;
  *) echo "Usage: infra/ci/backup-store.sh check | put <archive> <environment> | list <environment> | get <key> <file>" >&2; exit 2 ;;
esac
