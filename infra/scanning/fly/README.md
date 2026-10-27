# clamd on Fly.io, behind mutual TLS

Production upload scanning (owner decision 10, ADR 0034), hosted the way the owner approved on 2026-10-24: one
always-on Fly.io machine running the pinned `clamav/clamav:1.5.4` image, with stunnel in front of clamd. clamd has no
authentication and hosted Supabase Edge Functions cannot join a private network, so the only open port is
stunnel's 3311. It accepts only a client certificate signed by the XOS scanning CA, and the `upload-scan` Edge
Function presents it. clamd listens on loopback. Files never leave XOS infrastructure, so this adds no subprocessor;
Fly.io is the host.

Until this runs and the function's secrets are set, uploads stay quarantined (fail closed).

## Owner steps

1. **Fly.io account and app.** Install `flyctl` and sign in, then from this directory:

   ```sh
   fly apps create xos-clamav
   fly volumes create clamav_signatures --app xos-clamav --region iad --size 3
   ```

   A different app name works; pass it to `make-certs.sh` and change `app` in `fly.toml`.

   stunnel's port 3311 is a raw TCP service, which Fly routes only over a dedicated IPv4 (or IPv6) address; the
   shared IPv4 carries HTTP alone. Allocate one with `fly ips allocate-v4 --app xos-clamav` (billed monthly). A
   trial organization cannot allocate addresses until a card is on file, so add one first.

2. **Certificates.** On your own machine, with the output outside the repository:

   ```sh
   infra/scanning/fly/make-certs.sh ~/xos-scanning-tls xos-clamav
   ```

   `ca.key` signs new certificates: keep it offline. The server certificate names `xos-clamav.fly.dev`.

3. **clamd's secrets**, from the same directory:

   ```sh
   fly secrets set --app xos-clamav \
     XOS_CLAMD_TLS_CA="$(cat ~/xos-scanning-tls/ca.pem)" \
     XOS_CLAMD_TLS_CERT="$(cat ~/xos-scanning-tls/server.pem)" \
     XOS_CLAMD_TLS_KEY="$(cat ~/xos-scanning-tls/server.key)"
   fly deploy --app xos-clamav
   ```

   The first start downloads the signature database (a few minutes). `fly logs --app xos-clamav` shows freshclam,
   then clamd's "Listening daemon" line. The container refuses to start without the three secrets.

4. **The Edge Function's secrets**, on staging first, then production:

   ```sh
   supabase secrets set --project-ref <project-ref> \
     XOS_CLAMAV_HOST=xos-clamav.fly.dev XOS_CLAMAV_PORT=3311 \
     XOS_CLAMAV_TLS_CA="$(cat ~/xos-scanning-tls/ca.pem)" \
     XOS_CLAMAV_TLS_CERT="$(cat ~/xos-scanning-tls/client.pem)" \
     XOS_CLAMAV_TLS_KEY="$(cat ~/xos-scanning-tls/client.key)"
   ```

   Then upload a small file in Atlas and check that it leaves Scanning. The EICAR test file
   (`infra/scanning/README.md`) should come back Infected.

## Operating it

- Size: 2 shared vCPUs and 4 GB of memory (`fly.toml`). clamd holds about 1.5 GB of signatures and briefly twice
  that while it reloads after an update.
- Signatures update several times a day inside the container and persist on the `clamav_signatures` volume.
- A certificate expires after 825 days; rerun `make-certs.sh` with the same CA (or a new one) and repeat steps 3 and 4.
- If the machine stops, scans wait and retry; nothing is marked clean without a scan.
