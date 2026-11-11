#!/bin/sh
# Makes the XOS scanning CA, clamd's server certificate and upload-scan's client certificate, for mutual TLS
# between the upload-scan Edge Function and clamd on Fly.io. Run it on the owner's machine, never in CI, and
# keep the output out of the repository: it holds private keys.
#
#   infra/scanning/fly/make-certs.sh <output directory outside the repository> [fly app name]
set -eu
out=${1:?usage: make-certs.sh <output directory outside the repository> [fly app name]}
app=${2:-xos-clamav}
repo=$(git -C "$(dirname "$0")" rev-parse --show-toplevel 2>/dev/null || echo "")
mkdir -p "$out"
abs=$(cd "$out" && pwd -P)
if [ -n "$repo" ]; then
  case "$abs" in "$(cd "$repo" && pwd -P)"*) echo "Refusing to write private keys inside the repository: $abs" >&2; exit 1 ;; esac
fi
umask 077
cd "$abs"
openssl ecparam -name prime256v1 -genkey -noout -out ca.key
openssl req -x509 -new -key ca.key -sha256 -days 1825 -subj "/O=GHXSTSHIP Industries LLC/CN=XOS scanning CA" -out ca.pem
openssl ecparam -name prime256v1 -genkey -noout -out server.key
openssl req -new -key server.key -subj "/O=GHXSTSHIP Industries LLC/CN=$app.fly.dev" -out server.csr
printf 'subjectAltName=DNS:%s.fly.dev\nextendedKeyUsage=serverAuth\n' "$app" > server.ext
openssl x509 -req -in server.csr -CA ca.pem -CAkey ca.key -CAcreateserial -sha256 -days 825 -extfile server.ext -out server.pem
openssl ecparam -name prime256v1 -genkey -noout -out client.key
openssl req -new -key client.key -subj "/O=GHXSTSHIP Industries LLC/CN=xos-upload-scan" -out client.csr
printf 'extendedKeyUsage=clientAuth\n' > client.ext
openssl x509 -req -in client.csr -CA ca.pem -CAkey ca.key -CAcreateserial -sha256 -days 825 -extfile client.ext -out client.pem
rm -f server.csr client.csr server.ext client.ext
echo "Wrote ca.pem, server.pem, server.key, client.pem and client.key to $abs (ca.key signs new certificates; keep it offline)."
echo "Next: infra/scanning/fly/README.md, steps 3 and 4."
