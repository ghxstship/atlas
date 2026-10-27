#!/bin/sh
# Writes the TLS material from the Fly secrets to files only this container reads, starts stunnel, then hands
# over to the clamav image's own init, which runs freshclam and clamd.
set -eu
for name in XOS_CLAMD_TLS_CA XOS_CLAMD_TLS_CERT XOS_CLAMD_TLS_KEY; do
  eval "value=\${$name:-}"
  if [ -z "$value" ]; then
    echo "xos-clamd: $name is not set; refusing to start without mutual TLS" >&2
    exit 1
  fi
done
umask 077
mkdir -p /tmp/xos-tls
printf '%s\n' "$XOS_CLAMD_TLS_CA" > /tmp/xos-tls/ca.pem
printf '%s\n' "$XOS_CLAMD_TLS_CERT" > /tmp/xos-tls/server.pem
printf '%s\n' "$XOS_CLAMD_TLS_KEY" > /tmp/xos-tls/server.key
stunnel /etc/stunnel/xos-clamd.conf
exec /init "$@"
