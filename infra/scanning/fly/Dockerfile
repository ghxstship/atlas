# clamd for production uploads (owner decision 10, ADR 0034; hosting approved by the owner on 2026-10-24), with
# stunnel in front of it. clamd has no authentication and hosted Supabase Edge Functions cannot join a private
# network, so the only port open to the internet is stunnel's, which accepts only clients holding a certificate
# signed by the XOS scanning CA (make-certs.sh). clamd itself listens on loopback (CLAMD_CONF_TCPAddr in fly.toml).
# The image is the one ADR 0001 pins; stunnel comes from that image's Alpine release.
FROM clamav/clamav:1.5.4

RUN apk add --no-cache stunnel
COPY stunnel.conf /etc/stunnel/xos-clamd.conf
COPY entrypoint.sh /usr/local/bin/xos-entrypoint.sh
RUN chmod 0755 /usr/local/bin/xos-entrypoint.sh

ENTRYPOINT ["/usr/local/bin/xos-entrypoint.sh"]
