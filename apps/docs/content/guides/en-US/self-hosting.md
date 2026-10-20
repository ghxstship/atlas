---
title: Self-hosting
summary: Run XOS on your own infrastructure. Covers the Supabase database, environment variables, Edge Functions, hosting Atlas and Gateway on Vercel or Node, Compass builds, backups and upgrades.
section: operate
order: 11
---

XOS is open source under AGPL-3.0. A deployment is one Supabase project and the apps that run on it. Atlas serves the workspace and the public API at `/api/v1`, Gateway serves external parties, and Compass is the field app. This guide takes you from an empty project to a verified deployment, in the order the pieces depend on each other.

## What you run

| Component         | What it is                                                                                         | Where it runs                                           |
| ----------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Supabase          | Postgres 17 with every table, policy and job, plus Auth, Storage, Realtime and Edge Functions      | A hosted Supabase project, or Supabase's Docker Compose |
| Atlas             | The Next.js workspace app and the public API                                                       | Vercel, or any host that runs Node.js 22                |
| Gateway           | The Next.js portal for crew, vendors, clients and other external parties, including custom domains | Vercel, or any host that runs Node.js 22                |
| Docs (optional)   | This site: guides, the help center and the API reference                                           | Vercel, or any host that runs Node.js 22                |
| Compass           | The Expo field app for iOS and Android                                                             | App Store and Google Play, through EAS Build or Xcode   |
| ClamAV            | Scans uploads before anyone else can download them                                                 | A small container host the Edge Functions can reach     |
| PowerSync (later) | Streams offline buckets to Compass; until it is configured, Compass downloads over the REST API    | A container next to the database                        |

## Requirements

- Node.js 22.12 or later and pnpm 10.15.1 (the version in `packageManager`; Corepack installs it).
- Docker, for the local Supabase stack and ClamAV.
- The Supabase CLI 2.x.
- A clone of the repository at a release tag.

```bash
git clone https://github.com/ghxstship/atlas.git xos
cd xos
git checkout v4.0.0
corepack enable
pnpm install --frozen-lockfile
```

## 1. The database

### Local development

`supabase/config.toml` defines the local stack. Start it, apply every migration from empty, and run the database tests:

```bash
supabase start
supabase db reset
supabase test db
```

`supabase db reset` also loads the demo tenant from `supabase/seeds`. `supabase start` prints the API URL and the anon key.

### Production

Create a Supabase project on Postgres 17 in the region your customers' data must stay in. The Pro plan includes daily backups; point-in-time recovery is an add-on (see Backups below).

```bash
supabase link --project-ref <project-ref>
supabase db push
```

For a self-hosted Compose stack, pass its connection string instead: `supabase db push --db-url "postgresql://postgres:<password>@<host>:5432/postgres"`.

The migrations hold everything a new deployment needs: the canon, the plans and capabilities, the scheduled database jobs (pg_cron) and the encryption keys in Vault. They create the keys themselves.

> Never load `supabase/seeds` into production. The seeds are the demo tenant, with a shared demo password. Create your first organization by signing up in Atlas.

Migrations are forward-only. Apply them before you deploy apps that need them.

### Auth settings

`supabase/config.toml` is for the local stack only; do not run `supabase config push` with it. Set these in the hosted project's dashboard:

| Setting                  | Value                                                                                                                                                                |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Site URL                 | The Atlas origin, for example `https://atlas.example.com`                                                                                                            |
| Redirect URLs            | `https://<origin>/auth/callback**` for the Atlas and Gateway origins and each custom Gateway domain; the `**` lets the query string through                          |
| Custom access token hook | Postgres function `private.custom_access_token_hook` (it writes the active organization claim)                                                                       |
| Password policy          | Minimum length 12, letters and digits, leaked password protection on                                                                                                 |
| MFA                      | TOTP and WebAuthn enroll and verify on; the WebAuthn relying party is your registrable domain                                                                        |
| SMTP                     | Your mail provider, so sign-in and invitation emails come from your domain                                                                                           |
| Google (optional)        | Google provider on, with your Google Web client ID and secret, then your iOS and Android client IDs after the Web one; "Skip nonce checks" on for native iOS sign-in |

The repository's `infra/runbooks/hosted-security-settings.md` lists every setting with the reason for it.

## 2. Environment variables

Atlas and Gateway validate their environment when they start and name every missing or malformed variable. Copy `apps/atlas/.env.example` and `apps/gateway/.env.example` for local development.

| Variable                      | Atlas    | Gateway  | Value                                                                                    |
| ----------------------------- | -------- | -------- | ---------------------------------------------------------------------------------------- |
| `SUPABASE_URL`                | Required | Required | The Supabase API URL                                                                     |
| `SUPABASE_ANON_KEY`           | Required | Required | The anon (publishable) key; row-level security guards every row                          |
| `ATLAS_SITE_URL`              | Required |          | The public origin of Atlas, used for sign-in links and the CSRF origin check             |
| `GATEWAY_SITE_URL`            | Optional | Required | The public origin of Gateway; Atlas uses it for advance and signing links                |
| `GATEWAY_PLATFORM_HOSTS`      |          | Optional | Hosts that serve the platform Gateway; any other host is an organization's custom domain |
| `XOS_API_HOST`                | Optional |          | A host name, such as `api.example.com`, on which Atlas serves only the API, at `/v1`     |
| `DOCS_SITE_URL`               | Optional | Optional | The public origin of this docs site, for help center links                               |
| `NEXT_PUBLIC_SENTRY_DSN`      | Optional | Optional | Error reporting; without a DSN nothing is sent to Sentry                                 |
| `XOS_TRACES_SAMPLE_RATE`      | Optional | Optional | Trace sample rate, `0.05` by default                                                     |
| `XOS_LOG_LEVEL`               | Optional | Optional | `info` in production                                                                     |
| `COMPASS_APPLE_TEAM_IDS`      | Optional | Optional | Apple team ids, so Compass opens Atlas and Gateway links as universal links              |
| `COMPASS_ANDROID_CERT_SHA256` | Optional | Optional | Compass signing certificate fingerprints, for Android App Links                          |
| `XOS_TRUSTED_PROXY_HOPS`      | Optional |          | Trusted proxies in front of the one that appends the client address; `0` by default      |

Neither app ever receives the service role key. Every Supabase call runs on the server with the signed-in person's session.

## 3. Edge Functions

Deploy every function in `supabase/functions` and set their secrets:

```bash
supabase functions deploy
supabase secrets set --env-file ./functions.env
```

For a self-hosted stack, mount `supabase/functions` into the Compose stack's functions service instead. `stripe-webhook`, `inbound-email`, `email-unsubscribe`, `kiosk-punch`, `api-token` and `integration-inbound` authenticate their callers themselves and are deployed without JWT verification, as `supabase/config.toml` declares.

| Secret                                                    | Used by                                                                                          |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `XOS_API_JWT_SIGNING_KEY`                                 | `api-token`, which exchanges API keys for short-lived tokens; set it to the project's JWT secret |
| `SUPABASE_SERVICE_ROLE_KEY`                               | The worker functions (provided automatically on hosted Supabase)                                 |
| `XOS_APP_URL`, `XOS_GATEWAY_URL`, `XOS_POSTAL_ADDRESS`    | Links and the postal address in email                                                            |
| `XOS_EMAIL_TRANSPORT`, `XOS_EMAIL_FROM`, `RESEND_API_KEY` | Outgoing email through Resend (`XOS_EMAIL_TRANSPORT=resend`); unset, email is recorded, not sent |
| `XOS_EMAIL_ALLOWLIST`, `XOS_EMAIL_DELIVER_TO_ANY`         | Who may receive email; set `XOS_EMAIL_DELIVER_TO_ANY=true` only in production                    |
| `XOS_INBOUND_SECRET`, `XOS_INBOUND_DOMAIN`                | `inbound-email`, for replies by email                                                            |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`              | `stripe-webhook`, only if you bill through Stripe                                                |
| `XOS_CLAMAV_HOST`, `XOS_CLAMAV_PORT`                      | `upload-scan`, the ClamAV daemon; the port defaults to 3310 (see Upload scanning below)          |
| `SENTRY_DSN`, `XOS_ENVIRONMENT`, `XOS_LOG_LEVEL`          | Optional error reporting and log level                                                           |

### Schedule the workers

`webhook-dispatch`, `notification-dispatch`, `upload-scan`, `report-run`, `import-run` and `integration-worker` do their work when called with the service role key. Call each one every minute. On hosted Supabase, pg_cron and pg_net can do it from the database, reading the key from Vault:

```sql
select vault.create_secret('<service role key>', 'xos_worker_key');

select cron.schedule('xos_worker_webhook_dispatch', '* * * * *', $$
  select net.http_post(
    url := 'https://<project-ref>.supabase.co/functions/v1/webhook-dispatch',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'xos_worker_key')
    )
  );
$$);
```

Repeat for the other five functions, or call them from any scheduler you already run. Until `upload-scan` runs, attachments cannot be downloaded and field and onboarding uploads reach only the person who uploaded them. Until `import-run` runs, imports are not read, and until `integration-worker` runs, integrations do not sync and warehouse deliveries wait. Provider apps and their webhook secrets are in `infra/runbooks/integrations.md`.

### Upload scanning

Every upload is scanned by ClamAV that you run yourself, the `clamav/clamav:1.5.4` image. Files stay quarantined until they scan clean, and an infected file is deleted while its uploader is told why.

1. Run clamd on a host the Edge Functions can reach privately. The image is published for linux/amd64 only. Give it at least 2 vCPU and 4 GiB of memory and a persistent volume at `/var/lib/clamav`. Use the settings in `infra/scanning/docker-compose.yaml`, which also works as is with Docker Compose.
2. clamd has no authentication, so never expose port 3310 to the internet. Reach it over a private network or a tunnel.
3. Set the function secrets `XOS_CLAMAV_HOST` and `XOS_CLAMAV_PORT`, and `XOS_ENVIRONMENT=production`.
4. Call `upload-scan` once with the service role key. A response with `"scanner": "clamav"` means it is connected.

Without `XOS_CLAMAV_HOST`, `upload-scan` answers 503 and scans nothing, so uploads stay quarantined. On a local development stack only, it marks files clean without scanning and logs a warning for each one. The image updates its own signatures, so allow outbound HTTPS to `database.clamav.net`. `infra/runbooks/production.md` has sizing, alerts and upgrades.

### Know the IP allow-list's limit

An organization's IP allow-list is enforced where Atlas and the API check a session or an API key. It is not enforced on direct calls to your Supabase endpoint (REST, Storage and Realtime) made with a valid session token, because only Atlas and the API see the caller's address. If you rely on the allow-list, restrict who can reach the Supabase endpoint at your network edge as well. Routing all data access through the API is the planned fix.

## 4. Atlas, Gateway and docs

### On Vercel

Create one Vercel project per app with these settings, then add the variables above to each project's Production and Preview environments:

| Project | Root directory | Install command                  | Build command                                |
| ------- | -------------- | -------------------------------- | -------------------------------------------- |
| Atlas   | `apps/atlas`   | `pnpm install --frozen-lockfile` | `pnpm turbo run build --filter=@xos/atlas`   |
| Gateway | `apps/gateway` | `pnpm install --frozen-lockfile` | `pnpm turbo run build --filter=@xos/gateway` |
| Docs    | `apps/docs`    | `pnpm install --frozen-lockfile` | `pnpm turbo run build --filter=@xos/docs`    |

Add each custom Gateway domain to the Gateway project; organizations verify their domain in Atlas settings.

To serve the API on its own host, add that host to the Atlas project too and set `XOS_API_HOST` to it. Atlas then answers `https://<that host>/v1/...` as the API at `/api/v1/...`, with the same credentials and limits, and serves no page or cookie there.

### On your own Node host

```bash
pnpm turbo run build --filter=@xos/atlas --filter=@xos/gateway
pnpm --filter @xos/atlas exec next start --port 3000
pnpm --filter @xos/gateway exec next start --port 3001
```

Run each app under a process manager, behind a TLS-terminating reverse proxy that passes the `Host` header through, so Gateway can recognize custom domains.

The proxy must append the client address to `X-Forwarded-For` (in nginx, `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`). Atlas reads the last entry, the one your proxy added, because the client writes the entries before it; the IP allow-list depends on that. If another trusted proxy, such as a CDN, sits in front of yours, set `XOS_TRUSTED_PROXY_HOPS=1`. Never expose the apps without a proxy: then every forwarding header is the client's own text.

## 5. Compass

Compass reads its configuration at build time:

| Variable                           | Value                                                                                                                                                      |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EXPO_PUBLIC_SUPABASE_URL`         | The Supabase API URL                                                                                                                                       |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY`    | The anon key                                                                                                                                               |
| `EXPO_PUBLIC_ATLAS_URL`            | The Atlas origin                                                                                                                                           |
| `EXPO_PUBLIC_GATEWAY_URL`          | The Gateway origin                                                                                                                                         |
| `EXPO_PUBLIC_DOCS_URL`             | Optional: the docs site origin, for the help center row in Settings                                                                                        |
| `XOS_UNIVERSAL_LINK_HOSTS`         | `atlas:<host>,gateway:<host>`, so handoff links open in Compass. Unset, a build claims the GHXSTSHIP hosts; set your own hosts, or an empty value for none |
| `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` | Optional: your Google Web client ID, for Continue with Google                                                                                              |
| `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID` | Optional: your Google iOS client ID, for Continue with Google on iOS                                                                                       |

Change the bundle identifier and Android package in `apps/compass/app.json` to your own, then build with EAS Build (add an `eas.json` with a `production` profile and run `eas build --platform all --profile production`) or locally with `expo prebuild` followed by an Xcode archive and a Gradle release build. Distribute through TestFlight and Google Play internal testing first.

## 6. Verify the deployment

```bash
curl -s "$ATLAS_SITE_URL/api/v1/openapi.json" | head -c 200
XOS_BASE_URL="$ATLAS_SITE_URL/api/v1" XOS_API_KEY="xos_live_..." xos auth status
```

Then sign up, create an organization and a project, invite a member and open the project in Compass.

## 7. Backups and restores

| Layer                  | What it gives you                                                                 |
| ---------------------- | --------------------------------------------------------------------------------- |
| Point-in-time recovery | Restore to any second in the last 7 days; needed for a 1 hour recovery point      |
| Daily backups          | Included in Supabase Pro, kept 7 days                                             |
| Weekly logical backup  | `supabase db dump` of roles, schema and data, encrypted, kept in separate storage |

A backup counts only once a restore of it has been verified. The repository's restore drill restores a dump into a throwaway local database and checks the migration version, the row count of every table, checksums of the key tables and the database test suites:

```bash
infra/drills/release-drill.sh
```

Restore an incident into a new project, never over the live one, then switch the apps' `SUPABASE_URL` and keys. `infra/runbooks/backup-and-restore.md` has the full procedure.

## 8. Upgrades

1. Read the release notes for the tag, then check out the tag and run `pnpm install --frozen-lockfile`.
2. Take a backup, or confirm point-in-time recovery is on.
3. Apply new migrations: `supabase db push`.
4. Deploy the Edge Functions: `supabase functions deploy`.
5. Deploy Atlas, Gateway and docs.
6. Build Compass when the release notes say it changed.

Database changes follow expand and contract: no migration in a release breaks the build before it. To roll back an app, redeploy its previous build; the database is never rolled back. `/v1` changes only additively, so existing API integrations keep working across upgrades.
