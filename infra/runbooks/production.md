# Production runbook

How a release reaches production, how to undo it, what each app needs to run, how production is watched, and how Compass reaches testers. It applies to Wave 7 (Section 19.2) and every release after it. The release checklist (`docs/release-checklist.md`) tracks whether each step has happened.

Related runbooks: `progressive-delivery.md` (rollout stages and flags), `backup-and-restore.md`, `incident-response.md`, `hosted-security-settings.md`. Self-hosters follow the docs site's Self-hosting guide; this runbook is for the GHXSTSHIP production deployment.

**Owner stop points** (Section 19.8) are marked **OWNER**. Stop there and ask; do not proceed on judgment.

## Environments

| Environment | Database                                                                      | Apps (Vercel team `ghxstship`)                                       | Edge Functions             |
| ----------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------- | -------------------------- |
| Local       | A Supabase CLI stack per checkout                                             | `next dev` / `next start`                                            | `supabase functions serve` |
| Staging     | Supabase project `xos-atlas-staging`                                          | Preview deployments of `atlas`, `gateway` and `docs` against staging | Staging project            |
| Production  | **OWNER** creates the production Supabase project (region, plan, PITR add-on) | Production deployments of `atlas`, `gateway` and `docs`              | Production project         |

Decision 1 of ADR 0033 replaces the production row: `xos-atlas-staging` itself becomes production once its demo data is removed, and staging moves to a Supabase branch. The steps, with their checks and rollbacks, are in `promote-to-production.md`.

The Vercel projects `atlas` and `gateway` exist. The orchestrator creates `docs` with the settings in Domains below. The production domain is `ghxstship.tech` (ADR 0033, decision 5).

## Domains

Owner decision 5 (ADR 0033, amended 2026-10-20): `ghxstship.tech`, one subdomain per app.

| Host                     | Serves                                      | Vercel project | State on 2026-10-20                                                                  |
| ------------------------ | ------------------------------------------- | -------------- | ------------------------------------------------------------------------------------ |
| `atlas.ghxstship.tech`   | Atlas                                       | `atlas`        | Serving, with a certificate                                                          |
| `gateway.ghxstship.tech` | Gateway on the platform brand               | `gateway`      | Serving, with a certificate. `gateway-umber-omega.vercel.app` is a platform host too |
| `api.ghxstship.tech`     | The public API, served by Atlas at `/v1`    | `atlas`        | The orchestrator attaches it                                                         |
| `docs.ghxstship.tech`    | The docs site                               | `docs`         | The orchestrator creates the project                                                 |
| `mail.ghxstship.tech`    | The sending domain for email through Resend | None           | DNS records to add                                                                   |

Each org's custom Gateway domain is added to the `gateway` project when the org verifies it in Atlas.

### api.ghxstship.tech (project `atlas`)

1. Settings, Domains: add `api.ghxstship.tech` to Production. Do not redirect it to `atlas.ghxstship.tech`; it
   serves the same deployment.
2. DNS: the record Vercel shows for the subdomain (a CNAME), unless the zone already uses Vercel's nameservers.
3. Settings, Environment Variables, Production: `XOS_API_HOST=api.ghxstship.tech`. Leave it out of Preview.
   Redeploy production, because Vercel applies variables to new deployments only.
4. Supabase Auth needs nothing: no one signs in on the API host.
5. Verify:
   - `curl -s https://api.ghxstship.tech/` answers the JSON pointer, with `base_url`
     `https://api.ghxstship.tech/v1` and the OpenAPI document's URL.
   - `https://api.ghxstship.tech/v1/canon/departments` answers 401 without a key and 200 with
     `Authorization: Bearer xos_live_...`.
   - `curl -si https://api.ghxstship.tech/auth/sign-in` answers 404 as `application/problem+json`, with no
     `Set-Cookie`.
   - `https://atlas.ghxstship.tech/api/v1/openapi.json` still answers.

On the API host Atlas serves only the API (`apps/atlas/lib/api-host.ts`): `/v1/...` is the API at `/api/v1/...`,
`/` describes it, and every other path is a 404. API keys, sessions, rate limits and the IP allow-list apply per
caller, the same on both hosts. The API sends no CORS headers on either host.

### docs.ghxstship.tech (project `docs`)

| Setting                                                    | Value                                                                                                                     |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Team and name                                              | `ghxstship`, `docs`                                                                                                       |
| Git repository and production branch                       | `ghxstship/atlas`, `main`                                                                                                 |
| Framework preset                                           | Next.js                                                                                                                   |
| Root Directory                                             | `apps/docs`                                                                                                               |
| Include files outside the Root Directory in the Build Step | On (the default). The build reads `packages/api/openapi/v1.json`, `apps/atlas/help` and the workspace packages            |
| Install Command                                            | `pnpm install --frozen-lockfile`                                                                                          |
| Build Command                                              | `pnpm turbo run build --filter=@xos/docs` (it builds `@xos/tokens`, `@xos/ui` and the other workspace dependencies first) |
| Output Directory                                           | The default, `.next`                                                                                                      |
| Node.js version                                            | 22.x (`.nvmrc` is 22.14.0)                                                                                                |
| Environment variables                                      | None. The site reads no variable at build or run time and holds no secret                                                 |
| Domains                                                    | `docs.ghxstship.tech` on Production                                                                                       |
| Skip deployments with no changes to the Root Directory     | Optional. On, a commit that changes nothing the docs build depends on skips the build                                     |

- The build prerenders about 3,900 pages (1.5 minutes on a laptop). Two pages render on request: the help center
  index, which reads its search query, and the 404 page. `next.config.ts` lists the help articles in
  `outputFileTracingIncludes`, so that function carries them.
- Nothing assumes localhost. `allowedDevOrigins` applies to `next dev` only.
- Once it serves, set `DOCS_SITE_URL=https://docs.ghxstship.tech` in `atlas` and `gateway` (Production) and
  `EXPO_PUBLIC_DOCS_URL` in EAS, then redeploy. Until then the apps show no docs links.

### Email from mail.ghxstship.tech (Resend, decision 6)

1. In Resend, Domains, add `mail.ghxstship.tech`. Resend then lists the records to add. Copy each name, type and
   value from that page; never retype the DKIM key.
2. Add them at the DNS host of `ghxstship.tech`:

   | Purpose     | Type | Name and value                                                                                                                                                                                                                                                   |
   | ----------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | SPF         | TXT  | As Resend lists it, on its return-path subdomain under `mail.ghxstship.tech`                                                                                                                                                                                     |
   | Return path | MX   | As Resend lists it, on the same subdomain, so bounces come back to Resend                                                                                                                                                                                        |
   | DKIM        | TXT  | As Resend lists it, on a `_domainkey` name under `mail.ghxstship.tech`                                                                                                                                                                                           |
   | DMARC       | TXT  | `_dmarc.mail.ghxstship.tech`. The policy is the owner's; use Resend's suggestion if its page shows one. Otherwise start with `v=DMARC1; p=none; rua=mailto:` and a mailbox the owner reads, and move to `p=quarantine` once the reports show only Resend sending |

   A policy at `_dmarc.ghxstship.tech` instead covers every subdomain unless its `sp=` says otherwise.

3. Verify the domain in Resend. Then set Supabase SMTP (`promote-to-production.md`, step 6) and the function
   secrets `RESEND_API_KEY` and `XOS_EMAIL_FROM`.

Reply by email and project inboxes (`XOS_INBOUND_DOMAIN`, ADR 0040) need their own receiving domain, with MX
records pointing at the inbound mail provider that posts each parsed message to the `inbound-email` Edge
Function. That domain is not chosen yet. **OWNER**, once it is:

1. Pick a subdomain used only for receiving, written here as `<inbound domain>` (for example
   `inbound.<your domain>`), and choose an inbound provider that parses mail, checks DKIM and can post JSON to
   a URL with a bearer secret.
2. At the DNS host, add the provider's MX records for `<inbound domain>`, exactly as the provider lists them:

   | Name               | Type | Value                                                |
   | ------------------ | ---- | ---------------------------------------------------- |
   | `<inbound domain>` | MX   | `<priority> <provider's inbound mail host>`, per row |

3. Point the provider's webhook at `https://<project ref>.supabase.co/functions/v1/inbound-email` with the
   header `Authorization: Bearer <XOS_INBOUND_SECRET>`, and have it store the raw message where it can be read
   later, sending that path as `rawObjectPath`.
4. Set the function secrets `XOS_INBOUND_SECRET` (a new random value the provider also holds) and
   `XOS_INBOUND_DOMAIN=<inbound domain>`, and set `XOS_INBOUND_DOMAIN=<inbound domain>` on the `atlas` Vercel
   project too, so Project Settings shows each project's full inbox address. Redeploy Atlas.
5. Check: create a project inbox in Atlas (Project Settings, Project inbox), forward one message to it, and
   find it on the project's Documents tab.

Until then project inbox addresses show only their local part, and no mail arrives.

### Universal links to Compass

- Compass builds claim `atlas.ghxstship.tech` and `gateway.ghxstship.tech` (`apps/compass/app.config.ts`, ADR
  0030).
- Atlas and Gateway serve `/.well-known/apple-app-site-association` and `/.well-known/assetlinks.json` once
  these are set in `atlas` and `gateway` (Production), followed by a redeploy:
  - `COMPASS_APPLE_TEAM_IDS`: the 10-character Apple Developer team id;
  - `COMPASS_ANDROID_CERT_SHA256`: the SHA-256 fingerprint of the Play app signing certificate (Play Console,
    App integrity), plus the EAS upload key's fingerprint for builds installed outside Play, comma-separated.
- Unset, both files answer 404 and QR codes carry `compass://` links.
- Verify: `curl -si https://atlas.ghxstship.tech/.well-known/apple-app-site-association` answers 200 as
  `application/json` with no redirect, and lists `<team id>.pro.ghxstship.compass`; the same for Gateway and for
  `assetlinks.json`. Apple's CDN copy is at `https://app-site-association.cdn-apple.com/a/v1/atlas.ghxstship.tech`.
- iOS needs the Associated Domains capability on the App ID `pro.ghxstship.compass`. EAS Build turns it on when it
  manages the credentials; with your own credentials, turn it on in the Apple Developer portal.

### DNS records still needed

| Name                          | Type    | For                            | Value from                                |
| ----------------------------- | ------- | ------------------------------ | ----------------------------------------- |
| `api`                         | CNAME   | Vercel project `atlas`         | Vercel, when the domain is added          |
| `docs`                        | CNAME   | Vercel project `docs`          | Vercel, when the domain is added          |
| Resend's records under `mail` | TXT, MX | SPF, return path, DKIM         | Resend, Domains, `mail.ghxstship.tech`    |
| `_dmarc.mail`                 | TXT     | DMARC                          | The owner's policy (above)                |
| `status` (optional)           | CNAME   | The status page (GitHub Pages) | `infra/ci/README.md`, Repository settings |

`atlas` and `gateway` resolve already. Passkeys on the web need nothing at the apex `ghxstship.tech`.

## Deploy order

Every release is a tag `vX.Y.Z` on `main`. Each step starts only when the one before it is green. Migrations go first because database changes follow expand and contract: no migration in a release breaks the build before it, so the old apps keep working while the new schema lands.

### 0. Preflight (release owner)

1. CI is green on the tagged commit: `checks`, `database`, `secrets`, `route-js-budget`, `visual`, `ai-evals`, `e2e`, `e2e-pseudo-locales`, `verapdf`, and `api-breaking-changes` (gate 20, `infra/ci/oasdiff.sh`) once the orchestrator adds it.
2. The release drill passed on the tagged commit: `infra/drills/release-drill.sh`. Attach the report to the release.
3. No High or Critical finding is open (`legal/security/findings`, `legal/accessibility/findings`, `legal/qa/findings`).
4. The status page shows the last 30 days inside the error budget (`incident-response.md`, After the incident).
5. Announce the window in the on-call channel and name the release owner and the incident commander for it.

### 1. Migrations

```sh
supabase link --project-ref <production-ref>
supabase migration list           # what production has, against the repository
supabase db push --dry-run        # the migrations that will run
supabase db push
```

- Run against staging first, then production, from the tagged commit.
- Never load `supabase/seeds` into production; they are the demo tenant.
- Then run `infra/drills/key-tables.sql` read-only in the production SQL editor and keep the output with the release.
- Database advisors: Dashboard, Advisors. Zero errors (gate 11).

### 2. Edge Functions

```sh
supabase functions deploy --project-ref <production-ref>
supabase secrets list --project-ref <production-ref>   # names only; values never print
```

Set any secret new in this release with `supabase secrets set --project-ref <production-ref> NAME=...` from the owner's secret store. Confirm the worker schedules (`webhook-dispatch`, `notification-dispatch`, `upload-scan`, `report-run`, `import-run`, `integration-worker`, `subprocessor-notices`, each every minute; `infra/runbooks/integrations.md`; and `xos_fx_rates_ecb`, which a migration creates, section Exchange rates) still exist: `select jobname, schedule from cron.job order by 1;`.

How the functions are bundled (A85, RRR-130):

- Each function has its own bundle entry and its own import map. `supabase/functions/_vendor/<function>.js` holds the platform code that function uses, `_vendor/core.js` the logger, request observer and database seam every function shares, and `_vendor/chunks/` the code several functions share or load on demand. `supabase/functions/<function>/deno.json` lists only the npm packages that function imports, pinned from `supabase/functions/deno.json`. `supabase functions deploy` picks up each function's `deno.json` itself; pass no `--import-map`.
- All of these files are generated: `pnpm --filter @xos/platform bundle:edge`. The `@xos/platform` tests fail when a generated file is stale, missing or extra, when a function loads an npm package at boot that it did not load before, or when its boot code passes its budget (`packages/platform/test/edge-bundle.test.ts`). A new npm package must be pinned in `supabase/functions/deno.json` before the build will use it.
- A new function (for example A79's `org-lifecycle`): add `packages/platform/edge/entries/<function>.ts` exporting exactly what its `index.ts` uses, imported module by module (never through a package's index, which pulls every module in). In `index.ts`, import those from `../_vendor/<function>.js` and the logger or database seam from `../_vendor/core.js` (or through `_shared/runtime.ts`). Load a heavy package with a dynamic `import()` where a request may not need it. Run `bundle:edge`, then add the function's boot and lazy packages and its boot budget to `packages/platform/test/edge-bundle.test.ts`. The test fails for a function directory with no entry; a function that uses nothing but the shared core goes in that test's `CORE_ONLY` list instead.
- Deploy with the CLI's default Docker bundling. Never pass `--use-api`: server-side bundling allows 5 MB per function and `report-run` is about 9 MB compressed (69 MB as an eszip, mostly exceljs and pdfkit, which load only for .xlsx and PDF runs). Local bundling allows 20 MB.
- Cold starts: `kiosk-punch`, `api-token`, `email-unsubscribe` and `webhook-dispatch` load no npm package; `stripe-webhook` loads only Stripe; `scim`, `integration-worker`, `integration-inbound`, `import-run` and `upload-scan` load only supabase-js (`import-run` loads exceljs when it reads a workbook); React Email and Resend load only when `notification-dispatch` or `report-run` sends. The hosted limits are 2 s of CPU and 256 MB a request. A function that answers HTTP 546 hit one of them: check whether its boot code grew (`bundle:edge`, then the budget test) before raising anything.

Kiosk re-keying: a kiosk whose device key was retired or revoked in Atlas answers every punch with `kiosk_device_unregistered`, and Compass shows "This device is no longer registered as a kiosk". Register a new kiosk in Atlas, then on the device, signed in as a supervisor, choose **Forget this kiosk** and enter the new key (Compass help, Kiosk).

### 3. Apps

1. Vercel builds `atlas`, `gateway` and `docs` for the tagged commit as preview deployments against staging. Let Atlas and Gateway run there for 30 minutes with the synthetic checks green.
2. Promote to production. With Rolling Releases, the stages are 5, 25 and 100 percent, and the release gate (`progressive-delivery.md`) decides each step. Without them, promote and watch the gate's numbers for 30 minutes.
3. `docs` promotes directly; it is static.

### 4. Packages

Pushing the tag starts `publish-packages.yml` (`infra/ci/README.md`, section 5). It waits for the owner's approval in the `npm` and `pypi` environments. **OWNER** confirms the `@xos` npm scope and the `xos-sdk` PyPI name belong to the owner's accounts before the first publish; publishing under a new organization name is a stop point.

### 5. Compass

See Compass releases below. Compass ships on its own cadence; a web release never waits for store review.

### 6. Close

1. Smoke test as a real user: sign in to Atlas, open a project, open Gateway as an external party, call `GET https://api.ghxstship.tech/v1/openapi.json` and `xos auth status`.
2. Post the release notes and record the evidence in `docs/release-checklist.md`.

## Rollback

| What                   | How                                                                                                                                                                        | Time            |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| A feature              | Kill switch: `pnpm --filter @xos/infra rollout:gate flag-kill <flag> on` prints the SQL; run it with the service role (`progressive-delivery.md`)                          | 1 request       |
| Atlas, Gateway or docs | Rolling Releases: abort, which returns all traffic to the previous production deployment. Otherwise Vercel Instant Rollback to the previous production deployment          | Seconds         |
| Edge Functions         | Check out the previous tag and redeploy the functions: `git switch --detach vPREV`, then `supabase functions deploy --project-ref <production-ref>`, then return to `main` | Minutes         |
| A migration            | Never run a down migration. Ship a forward fix as a new migration. The previous app build keeps working on the new schema (expand and contract)                            | One deploy      |
| Lost or corrupted data | Restore to a new project and switch traffic (`backup-and-restore.md`, Restoring production). Declare a SEV1 first                                                          | Under 4 h (RTO) |
| A published package    | Never unpublish. Publish the next patch; `npm deprecate @xos/sdk@X.Y.Z "<reason>"` and yank on PyPI                                                                        | Minutes         |
| A Compass build        | Expire the build in TestFlight, or halt the Play rollout; testers keep the previous build                                                                                  | Minutes         |

## Environment variables

Values live in Vercel, the Supabase project, EAS and GitHub. They are never committed and never printed in logs or tickets. "Public" means the value is safe to ship to browsers by design.

### Atlas (Vercel project `atlas`)

| Variable                      | Production value                                                  |
| ----------------------------- | ----------------------------------------------------------------- |
| `SUPABASE_URL`                | The production Supabase API URL                                   |
| `SUPABASE_ANON_KEY`           | The production anon key (public; RLS guards every row)            |
| `ATLAS_SITE_URL`              | `https://atlas.ghxstship.tech` (set 2026-10-20)                   |
| `GATEWAY_SITE_URL`            | `https://gateway.ghxstship.tech` (set 2026-10-20)                 |
| `XOS_API_HOST`                | `api.ghxstship.tech`, Production only, once `api.` is attached    |
| `DOCS_SITE_URL`               | `https://docs.ghxstship.tech`, once `docs.` serves                |
| `NEXT_PUBLIC_SENTRY_DSN`      | DSN of the Sentry project `xos-atlas` (public)                    |
| `XOS_TRACES_SAMPLE_RATE`      | `0.05` (`1` on Preview)                                           |
| `XOS_LOG_LEVEL`               | `info` (`debug` on Preview)                                       |
| `COMPASS_APPLE_TEAM_IDS`      | The Apple team id, once the developer account exists              |
| `COMPASS_ANDROID_CERT_SHA256` | The Play app signing certificate fingerprint, once the app exists |
| `XOS_INBOUND_DOMAIN`          | `<inbound domain>`, once the receiving domain exists (ADR 0040)   |

### Gateway (Vercel project `gateway`)

| Variable                      | Production value                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `SUPABASE_URL`                | As Atlas                                                                                                      |
| `SUPABASE_ANON_KEY`           | As Atlas                                                                                                      |
| `GATEWAY_SITE_URL`            | `https://gateway.ghxstship.tech` (set 2026-10-20)                                                             |
| `GATEWAY_PLATFORM_HOSTS`      | `gateway.ghxstship.tech,gateway-umber-omega.vercel.app` (set 2026-10-20); every other host is a custom domain |
| `DOCS_SITE_URL`               | `https://docs.ghxstship.tech`, once `docs.` serves                                                            |
| `NEXT_PUBLIC_SENTRY_DSN`      | DSN of the Sentry project `xos-gateway` (public)                                                              |
| `XOS_TRACES_SAMPLE_RATE`      | `0.05`                                                                                                        |
| `XOS_LOG_LEVEL`               | `info`                                                                                                        |
| `COMPASS_APPLE_TEAM_IDS`      | As Atlas                                                                                                      |
| `COMPASS_ANDROID_CERT_SHA256` | As Atlas                                                                                                      |

### Docs (Vercel project `docs`)

None. The site is built from the repository and the OpenAPI document. Project settings: Domains, "docs.ghxstship.tech".

### Edge Functions (production Supabase project secrets)

| Secret                                                    | Notes                                                                                                          |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `XOS_API_JWT_SIGNING_KEY`                                 | The project's JWT secret, for `api-token`                                                                      |
| `XOS_APP_URL`, `XOS_GATEWAY_URL`, `XOS_POSTAL_ADDRESS`    | `https://atlas.ghxstship.tech`, `https://gateway.ghxstship.tech`; the postal address in email (CAN-SPAM)       |
| `XOS_EMAIL_TRANSPORT`, `XOS_EMAIL_FROM`, `RESEND_API_KEY` | `resend`; an address on the verified domain, such as `XOS <notifications@mail.ghxstship.tech>`; the Resend key |
| `XOS_EMAIL_ALLOWLIST`, `XOS_EMAIL_DELIVER_TO_ANY`         | `XOS_EMAIL_DELIVER_TO_ANY=true` only in production, after **OWNER** approves real-recipient email              |
| `XOS_INBOUND_SECRET`, `XOS_INBOUND_DOMAIN`                | Reply by email                                                                                                 |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`              | Live Stripe keys, once the owner opens billing                                                                 |
| `XOS_CLAMAV_HOST`, `XOS_CLAMAV_PORT`                      | The private address and port of clamd ("Upload scanning (ClamAV)" below); the port defaults to 3310            |
| `XOS_SLACK_SIGNING_SECRET`                                | Slack events and slash commands (`integration-inbound`), `infra/runbooks/integrations.md`                      |
| `XOS_XERO_WEBHOOK_KEY`                                    | Xero change notices (`integration-inbound`), once the Xero app exists                                          |
| `XOS_QUICKBOOKS_VERIFIER_TOKEN`                           | QuickBooks Online change notices (`integration-inbound`), once the app exists                                  |
| `SENTRY_DSN`, `XOS_ENVIRONMENT`, `XOS_LOG_LEVEL`          | The Edge Functions' Sentry DSN; `production`; `info`                                                           |
| `XOS_PUSH_TRANSPORT`, `EXPO_ACCESS_TOKEN`                 | `expo` to send push ("Push and SMS" below); the access token only if enhanced push security is on              |
| `XOS_SMS_TRANSPORT`, `TWILIO_ACCOUNT_SID`                 | `twilio` to send SMS; the account SID, `AC<32 hex characters>`                                                 |
| `TWILIO_AUTH_TOKEN`, `TWILIO_MESSAGING_SERVICE_SID`       | `<32 hex characters>`; the 10DLC Messaging Service, `MG<32 hex characters>`                                    |
| `XOS_SMS_HELP_CONTACT`                                    | The mailbox or page HELP replies name (OWNER_INPUTS item 6)                                                    |
| `XOS_SMS_ALLOWLIST`, `XOS_SMS_DELIVER_TO_ANY`             | `XOS_SMS_DELIVER_TO_ANY=true` only in production, after **OWNER** approves real-recipient SMS                  |
| `XOS_SMS_WEBHOOK_URL`                                     | Only when Twilio calls `sms-webhook` through another host; defaults to the function's own URL                  |

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided to functions by Supabase. The worker schedules read the service role key from Vault (`xos_worker_key`).

### Compass (EAS environment `production`; `preview` holds the staging values)

Set in the EAS dashboard (project, Environment variables, `production`). Every value is public by design.

| Variable                           | Value                                                                                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `EXPO_PUBLIC_SUPABASE_URL`         | The production Supabase API URL                                                                                                            |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY`    | The production anon key (public), the new one after the key rotation                                                                       |
| `EXPO_PUBLIC_ATLAS_URL`            | `https://atlas.ghxstship.tech`                                                                                                             |
| `EXPO_PUBLIC_GATEWAY_URL`          | `https://gateway.ghxstship.tech`                                                                                                           |
| `EXPO_PUBLIC_DOCS_URL`             | `https://docs.ghxstship.tech`, for the help center row in Settings                                                                         |
| `XOS_UNIVERSAL_LINK_HOSTS`         | Leave unset: the build claims `atlas.ghxstship.tech` and `gateway.ghxstship.tech`. An empty value turns universal links off for that build |
| `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` | The Google Web client ID (public), "Sign in with Google (OWNER)" below                                                                     |
| `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID` | The Google iOS client ID (public), the same section                                                                                        |
| `XOS_APPLE_TEAM_ID`                | The Apple team id (signs the widget extension in local device builds)                                                                      |
| `GOOGLE_SERVICES_JSON`             | Secret file variable: the Firebase `google-services.json` for `pro.ghxstship.compass` (Android push)                                       |

A preview or production build on EAS stops in `apps/compass/app.config.ts` when a server URL is missing, not https or local, or when the app icon `apps/compass/assets/icon.png` is missing.

### GitHub Actions (repository secrets and variables)

| Name                                            | Kind     | Used by                                                             |
| ----------------------------------------------- | -------- | ------------------------------------------------------------------- |
| `NPM_TOKEN`                                     | Secret   | `publish-packages.yml`, only until npm trusted publishing is set up |
| PyPI trusted publisher (no secret)              | pypi.org | `publish-packages.yml`                                              |
| `EXPO_TOKEN`                                    | Secret   | A Compass build workflow, if builds move to CI                      |
| `STAGING_DB_URL`                                | Secret   | `backup-weekly.yml`                                                 |
| `XOS_SYNTHETIC_EMAIL`, `XOS_SYNTHETIC_PASSWORD` | Secret   | `synthetics.yml`                                                    |
| `XOS_ALERT_WEBHOOK_URL`                         | Secret   | `synthetics.yml`, alerts to on-call                                 |
| `ANTHROPIC_API_KEY`                             | Secret   | `ai-evals` (gate 21)                                                |
| `XOS_STAGING_*` URLs and the staging anon key   | Variable | `synthetics.yml`                                                    |
| `GOOGLE_CLOUD_PROJECT`                          | Variable | `translate.yml`, machine translation (ADR 0037); not a secret       |
| `GOOGLE_TRANSLATE_GLOSSARY_BUCKET`              | Variable | `translate.yml`, the glossary upload; not a secret                  |
| `GOOGLE_WORKLOAD_IDENTITY_PROVIDER`             | Variable | `translate.yml`, Workload Identity Federation; no key               |
| `GOOGLE_TRANSLATE_SERVICE_ACCOUNT`              | Variable | `translate.yml`, the account CI impersonates; no key                |

## Upload scanning (ClamAV)

Uploads are scanned by self-hosted ClamAV (owner decision 10, ADR 0034). Until clamd answers, every upload
stays quarantined: attachments cannot be downloaded, imports wait, and private uploads reach only their
uploader. Files never leave XOS infrastructure, so ClamAV is not a subprocessor.

**Run clamd**

- Image: `clamav/clamav:1.5.4` (pinned in ADR 0001). It is published for linux/amd64 only, so use an amd64
  host.
- Size: at least 2 vCPU and 4 GiB of memory. clamd holds the signature database in memory (about 1.5 GiB)
  and briefly needs twice that while it reloads after an update. Keep the signature volume on disk.
- Use the same settings as `infra/scanning/docker-compose.yaml`:
  - `CLAMD_CONF_StreamMaxLength=60M`, above the largest bucket limit of 50 MiB;
  - `CLAMD_CONF_MaxScanSize=150M` and `CLAMD_CONF_MaxFileSize=60M`;
  - a persistent volume at `/var/lib/clamav`;
  - the `clamdcheck.sh` health check.
- The image runs `freshclam` itself and updates signatures several times a day. Allow outbound HTTPS from
  the host to `database.clamav.net`. The first start downloads the database and takes a few minutes, and
  the health check stays red until it finishes.
- clamd has no authentication. Never expose port 3310 to the internet. The Edge Functions must reach it
  over a private network or an authenticated tunnel, for example WireGuard, Tailscale or a TLS tunnel
  that terminates on the clamd host. Allow only the tunnel's address on 3310.
- Run two instances behind a TCP load balancer if one host is a single point of failure you cannot
  accept. Scans are stateless.

**Connect the functions**

```sh
supabase secrets set --project-ref <production-ref> XOS_CLAMAV_HOST=<private address> XOS_CLAMAV_PORT=3310
```

Then call `upload-scan` once with the service key. A 200 with `"scanner": "clamav"` means it is connected.
A 503 `scanner-not-configured` means the secret is missing. The `retrying` outcome, with "clamd is
unreachable", means the network path is wrong. Leave `XOS_ENVIRONMENT=production` set: with it, the function
never falls back to the development pass-through, even if `SUPABASE_URL` looked local.

**Check it end to end on staging**

Upload the EICAR test file (eicar.org) as an attachment. After the next worker run it shows "Blocked",
the file is gone from storage, and clamd logs `Eicar-Test-Signature FOUND`. Upload an ordinary PDF: it
becomes downloadable after the next run.

**Alerts**

- `upload-scan` answering 503, or `retrying` and `failed` outcomes in its logs: clamd is missing or
  unreachable. Files are safe, because they stay quarantined, but nothing can be downloaded.
- Rows in `private.object_scans` or `attachment.scan` jobs in Scanning for more than 15 minutes.
- The clamd health check failing, or `freshclam` failing to update for more than 24 hours.

**Upgrade**

Renovate proposes new `clamav/clamav` tags. Update ADR 0001 and `infra/scanning/docker-compose.yaml`
together. Roll hosts one at a time; while one restarts, scans retry with backoff.

## Legal change notices (OWNER)

Section 14.4 needs 30 days' notice before a material change to a legal document or a new subprocessor. Both
start with one call in the SQL editor of the production project, after the new text is published at `/legal`
(A82, migrations 1382 and 1383). Each refuses a date less than 30 days ahead and records the notice time from
the database, which is the evidence of the notice.

```sql
-- A material change: Atlas asks whoever accepts terms for each org (Org), or Gateway asks each person
-- who accepted an earlier version (Personal), until they accept the new version.
select app.announce_legal_change('terms-of-service', '2.0.0', 'Org', '<what changes, in plain words>', date '<effective date>');
-- Withdraw a notice sent by mistake:
select app.withdraw_legal_change('terms-of-service', '2.0.0');

-- A Subprocessor List change: emails every confirmed subscriber and every Owner and Admin who has not
-- opted out; the subprocessor-notices worker sends them.
select app.queue_subprocessor_notice('<list version>', '<what changes, in plain words>', date '<effective date>');
```

A subprocessor notice emails real recipients, which `legal/policies/change-management.md` section 5 makes a
stop condition: the owner approves each one before it is queued.

## Stripe catalogue (OWNER, test mode)

The products, prices, founding-customer coupon and `FOUNDING30` promotion code come from `packages/schemas/plans.yaml` (pricing v4, ADR 0035). The owner creates them in the Stripe sandbox with the setup script. It runs on the owner's machine with the owner's key, which never goes in a file:

1. In the Stripe Dashboard, switch to test mode and copy the secret key (`sk_test_...`). A restricted key (`rk_test_...`) works too if it can write products, prices, coupons and promotion codes.
2. From the repository root, see what would be created:
   `STRIPE_SECRET_KEY=sk_test_... pnpm --filter @xos/platform stripe:setup --dry-run`
3. Create the catalogue:
   `STRIPE_SECRET_KEY=sk_test_... pnpm --filter @xos/platform stripe:setup`
4. Run it again whenever you like. It creates only what is missing and prints `unchanged` for the rest.

How it behaves:

- It refuses live mode keys. Creating the live catalogue is a separate owner decision, made when billing opens.
- It exits 2 and writes nothing when Stripe already holds a price, coupon or promotion code that differs from `plans.yaml`. Stripe prices cannot be edited. To change a price, give it a new versioned lookup key in `plans.yaml` (for example `_v5`), regenerate the plan seed, and run the script again.
- The webhook endpoint (`STRIPE_WEBHOOK_SECRET`) must send `customer.subscription.*`, `checkout.session.completed` and `checkout.session.async_payment_succeeded` to the `stripe-webhook` function. Those events carry extra seats and Aurora pack payments.

## Machine translation (OWNER, Google Cloud Translation)

Google Cloud Translation reviews es-US and produces every other translation (ADR 0037). The owner sets it up once and runs it. Authentication is Application Default Credentials: a gcloud login on the owner's machine, and Workload Identity Federation in GitHub Actions. No service account key, API key or other secret is created or stored anywhere.

These are the names the pipeline reads. **Every value in this section is an example**; use your own.

| Name                                | What it is                                                                   | Example value (not real)                                                              |
| ----------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `GOOGLE_CLOUD_PROJECT`              | The Google Cloud project id that is billed for translation                   | `xos-translate-123456`                                                                |
| `GOOGLE_TRANSLATE_GLOSSARY_BUCKET`  | The Cloud Storage bucket Google reads the glossary from                      | `xos-translate-123456-glossaries`                                                     |
| `GOOGLE_WORKLOAD_IDENTITY_PROVIDER` | CI only: the full resource name of the Workload Identity Federation provider | `projects/123456789012/locations/global/workloadIdentityPools/github/providers/atlas` |
| `GOOGLE_TRANSLATE_SERVICE_ACCOUNT`  | CI only: the service account GitHub Actions impersonates                     | `xos-translate@xos-translate-123456.iam.gserviceaccount.com`                          |

Locally they are shell variables. In GitHub they are repository variables (Settings, Secrets and variables, Actions, Variables), not secrets.

### 1. Project, billing and API

1. Create or choose a project at https://console.cloud.google.com/projectcreate, or `gcloud projects create xos-translate-123456 --name="XOS Translate"` (example id). Note the project id and the project number (Dashboard, Project info).
2. Link a billing account (Billing, Link a billing account). Translation is pay as you go; the first full es-US review is estimated at USD 9.76 (ADR 0037, section 10).
3. Enable the APIs:
   `gcloud services enable translate.googleapis.com storage.googleapis.com --project=xos-translate-123456`
4. Create the glossary bucket in the glossary's region:
   `gcloud storage buckets create gs://xos-translate-123456-glossaries --project=xos-translate-123456 --location=us-central1 --uniform-bucket-level-access`

### 2. Roles

A project Owner already has every role below. Otherwise grant them to the person who runs the pipeline (`--member="user:<your Google account>"`):

| Role                                                         | Needed for                                                                                |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `roles/cloudtranslate.user` (Cloud Translation API User)     | `translate`, `translate:review` (translateText with the glossary)                         |
| `roles/cloudtranslate.editor` (Cloud Translation API Editor) | `translate:glossary` (creating and deleting glossaries); Google has no glossary-only role |
| `roles/storage.objectAdmin` on the glossary bucket           | `translate:glossary` (copying `glossary.csv` there for Google to read)                    |
| `roles/serviceusage.serviceUsageConsumer`                    | Billing calls to the project (`x-goog-user-project`)                                      |

For example:
`gcloud projects add-iam-policy-binding xos-translate-123456 --member="user:owner@example.com" --role=roles/cloudtranslate.editor`

### 3. Log in on your machine

1. Install the gcloud CLI (https://cloud.google.com/sdk/docs/install).
2. `gcloud auth application-default login`, then sign in in the browser. This stores Application Default Credentials for your user; nothing goes in the repository.
3. `gcloud auth application-default set-quota-project xos-translate-123456` (example id).

### 4. First run: glossary, translate and review

From the repository root:

```bash
export GOOGLE_CLOUD_PROJECT=xos-translate-123456                      # example
export GOOGLE_TRANSLATE_GLOSSARY_BUCKET=xos-translate-123456-glossaries  # example
pnpm --filter @xos/i18n translate:all --dry-run   # counts and prices it; no network, no files
pnpm --filter @xos/i18n translate:all             # glossary upload, translate, then the es-US review
```

`translate:all` uploads `packages/i18n/translation/glossary.csv` as `xos-glossary-<hash>` (a no-op when that version exists), fills missing and stale strings in every target locale, then translates every en-US string and file fresh and applies Google's version to es-US except where a string is locked, keeps a glossary term Google dropped, or Google's version fails the checks. The steps also run on their own: `translate:glossary`, `translate`, `translate:review` (add `--no-apply` to only write the report).

### 5. Review and commit the output

1. Read `docs/i18n/review/es-US/README.md`: counts per catalog, then one file per catalog or surface with every changed string (en-US, the previous es-US, Google's version and the decision).
2. To keep a previous wording, put it back in the catalog or file and lock it: `pnpm --filter @xos/i18n translate:lock email.common.greeting help/gates.md`. A locked string is never overwritten.
3. Update the tests listed under "Test expectations to update" (or lock those keys), and grep `apps/*/e2e` for any other Spanish text you changed by hand.
4. Run `pnpm verify`. The translation check runs inside it. The commands have already regenerated the generated catalogs and Atlas's help modules.
5. Commit the catalogs, help articles, guides, `packages/i18n/translation/memory/es-US.json` and `docs/i18n/`, with a `Part of RRR-118` trailer.

Later runs: `pnpm --filter @xos/i18n translate` re-translates only strings whose en-US changed since the last run; the translation memory answers everything else, so an unchanged run calls nothing.

### 5a. Beta locales: fr-FR, de-DE, it-IT, pt-BR and ja-JP (ADR 0053)

The five Beta locales ship in the language picker marked Beta. They are targets of the same pipeline, so the first `translate` (inside `translate:all`) writes their catalogs; until then every key reads en-US.

1. Price it first: `pnpm --filter @xos/i18n translate --dry-run` prints each locale's strings, characters and estimated cost. A full fill of one locale, catalogs and canon labels, is estimated at USD 9.58 (dry run on 2026-10-21), so about USD 48 for all five.
2. Run `pnpm --filter @xos/i18n translate` (or one locale: `--locale fr-FR`). Beta locales cover the app catalogs and the canon labels (`surfaces: ["catalogs", "canon"]` in `translation/config.json`); help articles and guides stay in en-US for them.
3. Commit `packages/i18n/messages/<locale>/`, `packages/i18n/canon/<locale>/`, `packages/i18n/translation/memory/<locale>.json`, the regenerated `packages/i18n/src/beta/<locale>.generated.ts` and `docs/i18n/translate-<locale>.md`, with a `Part of RRR-142` trailer.
   3a. Canon labels reach the database through a migration: run `pnpm --filter @xos/i18n canon:sql` and paste what it prints into a new migration in your range (`packages/i18n/test/canon.test.ts` fails until you do). es-US canon labels other than phases, record kinds, classes, states, subtypes and worker classifications arrive the same way on the first `translate`.
4. Optional: fill the Beta columns of `packages/i18n/translation/glossary.csv` (`fr`, `de`, `it`, `pt`, `ja`) with the terms a person chose, then run `translate:glossary`. Until then those columns hold only the product names.

A Beta locale becomes general when a native reviewer signs it off in `packages/i18n/REVIEW.md` (the steps are there).

### 6. CI with Workload Identity Federation (optional)

The manual workflow `translate.yml` (`infra/ci/README.md`, section 9) runs the same commands in GitHub Actions and uploads the result as a patch. It needs no key:

1. Create the service account and give it the translation roles (`roles/cloudtranslate.editor` too if CI should upload the glossary, and `roles/storage.objectAdmin` on the bucket):
   `gcloud iam service-accounts create xos-translate --project=xos-translate-123456 --display-name="XOS translation (GitHub Actions)"`
   `gcloud projects add-iam-policy-binding xos-translate-123456 --member="serviceAccount:xos-translate@xos-translate-123456.iam.gserviceaccount.com" --role=roles/cloudtranslate.user`
   `gcloud projects add-iam-policy-binding xos-translate-123456 --member="serviceAccount:xos-translate@xos-translate-123456.iam.gserviceaccount.com" --role=roles/serviceusage.serviceUsageConsumer`
2. Create the pool and the GitHub provider, limited to this repository:
   `gcloud iam workload-identity-pools create github --project=xos-translate-123456 --location=global --display-name="GitHub Actions"`
   `gcloud iam workload-identity-pools providers create-oidc atlas --project=xos-translate-123456 --location=global --workload-identity-pool=github --issuer-uri="https://token.actions.githubusercontent.com" --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" --attribute-condition="assertion.repository=='ghxstship/atlas'"`
3. Let workflows of this repository impersonate the service account (123456789012 is the example project number):
   `gcloud iam service-accounts add-iam-policy-binding xos-translate@xos-translate-123456.iam.gserviceaccount.com --project=xos-translate-123456 --role=roles/iam.workloadIdentityUser --member="principalSet://iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/github/attribute.repository/ghxstship/atlas"`
4. Add the four repository variables from the table above. `GOOGLE_WORKLOAD_IDENTITY_PROVIDER` is `projects/<project number>/locations/global/workloadIdentityPools/github/providers/atlas`.

### Troubleshooting

- `403 PERMISSION_DENIED`: the API is not enabled, a role is missing, or the quota project is not set (step 3.3).
- `404` or `NOT_FOUND` naming `glossaries/xos-glossary-...`: run `pnpm --filter @xos/i18n translate:glossary` (it runs first in `translate:all`).
- `400` about the language code `es-US`: switch to NMT as ADR 0037, section 2 describes (`general/nmt` and the code `es`).
- `400` about contextual translation: set `google.contextualGlossary` to `false` in `packages/i18n/translation/config.json` and run again.
- Many strings failed with "Google's markup did not survive": the model is dropping the masking spans. Switch to NMT as above; failed strings are retried and nothing broken was written.
- Strings listed as failed in `docs/i18n/translate-<locale>.md` kept their value (or the en-US text where they had none) and are retried on the next run.

## Exchange rates (OWNER, ECB daily reference rates)

The Edge Function `fx-rates-ecb` writes the European Central Bank's daily reference rates into every org's
exchange rates (ADR 0053, migration 1542). pg_cron job `xos_fx_rates_ecb` runs it on ECB business days at 15:30 and
21:30 UTC (`30 15,21 * * 1-5`), after the 16:00 CET publication. The rates file is public: no key is needed to read
it.

1. Deploy the function with the others: `supabase functions deploy fx-rates-ecb --project-ref <ref>`. It keeps the
   default `verify_jwt = true` and checks the service key, as the other workers do.
2. Add the functions URL to Vault once, beside `xos_worker_key` (example value, use your own project ref):
   `select vault.create_secret('https://<project ref>.supabase.co/functions/v1', 'xos_functions_url');`
3. Check the first run (the next weekday after 15:30 UTC, or call `select private.request_fx_feed();`):
   `select * from app.fx_feed_status('ECB');` shows `last_rate_date` and no failures since. Until step 2, every
   scheduled run records a failure saying the feed is not configured, and Finance, Cost centers says so.
4. A failing feed: `select ran_at, error from private.fx_feed_runs where outcome = 'Failed' order by ran_at desc
limit 5;`. Conversions keep using the newest rate recorded, show its date, and say when it is stale.

## Push and SMS (OWNER)

`notification-dispatch` (every minute) sends email, push and SMS deliveries and reads push receipts; `sms-webhook` takes Twilio's inbound messages and status callbacks (finding A65-012, migrations 1361 to 1363). Until the steps below are done both channels record instead of sending: deliveries are marked Sent with a `recorded-` provider id and nothing leaves the platform. Every secret is set with `supabase secrets set --project-ref <ref> NAME=...` from the owner's secret store; values never go into the repository, a ticket or a chat.

### Push (Expo push service, ADR 0030)

1. In the Expo project of Compass, upload the push credentials EAS asks for: an APNs key for iOS (`eas credentials`, iOS, Push Notifications) and the FCM V1 service account for Android. Release builds need the `aps-environment` entitlement set to production.
2. Optional: turn on enhanced push security in the Expo project settings, create an access token for push, and set `EXPO_ACCESS_TOKEN`. Without enhanced security no token is needed.
3. Set `XOS_PUSH_TRANSPORT=expo` on staging first. Register a device in a Compass staging build, submit a timesheet, and approve it from the push (journey 57).
4. Check: `select message_status, count(*) from app.push_tickets group by 1;` shows Sent turning into Delivered after about 15 minutes. Bounced rows with `DeviceNotRegistered` mean uninstalled apps; their devices are revoked automatically.

### SMS (Twilio with 10DLC, Section 14.5)

1. **Twilio account.** Create the account, upgrade it from trial, and note the Account SID (`AC<32 hex characters>`) and the Auth Token (`<32 hex characters>`).
2. **10DLC brand.** In Twilio Console, Messaging, Regulatory Compliance, register the brand with the legal name, EIN, address and website of GHXSTSHIP Industries LLC (OWNER_INPUTS items 1 and 2). Brand vetting takes from minutes to a few days and has a one-time fee.
3. **10DLC campaign.** Register one campaign under the brand:
   - use case: Account Notifications (mixed if marketing is ever added; it is not today);
   - description: "Work notifications from the organizations a person belongs to: shift changes, approvals, safety alerts.";
   - sample messages: copy two rendered texts, for example "Northwind Live: Your shift Load in now starts Tuesday at 9:00 AM. https://atlas.example/northwind-live/inbox Reply STOP to opt out.";
   - opt-in: "With a verified phone number, a person ticks the consent statement in Personal settings, Notifications (it names the number, message frequency, rates, STOP and HELP); each consent is recorded per organization (app.sms_consent_events, migration 1366)." Attach a screenshot of that page;
   - opt-out STOP, help HELP, with the replies in `packages/i18n/messages/en-US/email.json` under `sms`.
     Campaign review takes days to weeks and has a monthly fee per campaign.
4. **Messaging Service.** Create a Messaging Service, add the 10DLC number(s) to its sender pool, attach the campaign, and note its SID (`MG<32 hex characters>`). Under Integration, set "A message comes in" to `https://<project-ref>.supabase.co/functions/v1/sms-webhook` (HTTP POST). Keep Twilio's default opt-out handling on; `sms-webhook` records STOP, START and HELP either way, and Twilio does not deliver a second reply.
5. **Secrets.** Set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_MESSAGING_SERVICE_SID` and `XOS_SMS_HELP_CONTACT`, then `XOS_SMS_TRANSPORT=twilio`. On staging also set `XOS_SMS_ALLOWLIST` to test numbers in E.164 (`+1<10 digits>`); production sets `XOS_SMS_DELIVER_TO_ANY=true` once the campaign is approved.
6. **Check.** Text HELP to the number: the reply names `XOS_SMS_HELP_CONTACT`. Text STOP: `app.suppression_list` gets a `STOP` row for every org that texts the number. Text START: it is lifted.

Texts go only to verified numbers with recorded consent in the org, and never in quiet hours: the member's own, or 21:00 to 08:00 in their time zone when they set none (ADR 0033 decision 35). The zone falls back from the member's own to the project's, then the org's, never UTC. Texts held overnight go out at the end of quiet hours as one summary per member and org. Only the kinds flagged `bypasses_quiet_hours` in `packages/schemas/notification-kinds.yaml` go at once: safety alerts and changes to a shift starting within 12 hours.

### Chat translation (off by default)

The seam is built (Section 4.9) but no screen calls it yet, and the platform runs no provider until `XOS_MESSAGE_TRANSLATION=google`. When the owner approves Google Cloud Translation as a subprocessor for chat text: enable the API in the ADR 0037 project, grant the runtime's service account `roles/cloudtranslate.user` through Workload Identity Federation (`GOOGLE_WORKLOAD_IDENTITY_AUDIENCE`, `GOOGLE_TRANSLATE_SERVICE_ACCOUNT`, no key), and add Google to the subprocessor list. Each org then turns on Settings, Communication, "Translate chat messages".

## Sign in with Google (OWNER)

Atlas, Gateway and Compass offer "Continue with Google" once Google is turned on in the Supabase project (ADR 0036). The code is in place; the owner creates three Google OAuth clients and enters them in Supabase and EAS. Atlas and Gateway need nothing in Vercel: they show the button when Supabase reports Google enabled. Until then no Google button appears in production.

**Every value in the table below is an example of the format; none is real.** Values are kept in the owner's secret store and entered only in the dashboards named; they are never committed, pasted in tickets or logged. Only the Web client secret is a secret; client IDs are public.

| Value                     | Where it comes from                                       | Example of the format (not real)                                                                    |
| ------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Web client ID             | Google Cloud, Clients, the Web application client         | `<12 digits>-<32 letters and digits>.apps.googleusercontent.com`                                    |
| Web client secret         | Google Cloud, the same client (shown once; can be reset)  | `GOCSPX-` followed by 28 letters, digits, `-` or `_`                                                |
| iOS client ID             | Google Cloud, Clients, the iOS client                     | `<12 digits>-<32 letters and digits>.apps.googleusercontent.com`                                    |
| Android client ID         | Google Cloud, Clients, the Android client (one per SHA-1) | `<12 digits>-<32 letters and digits>.apps.googleusercontent.com`                                    |
| Android SHA-1 fingerprint | EAS credentials, and Play Console App integrity           | 20 colon-separated hex pairs, such as `AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD` |
| Supabase callback URL     | Supabase, Authentication, Sign In / Providers, Google     | `https://fquuqnzlpobaawucczgq.supabase.co/auth/v1/callback` (the real one)                          |

### 1. OAuth consent screen (Google Auth Platform, Branding and Audience)

1. In the Google Cloud project that will own sign-in (it can be the machine translation project), open Google Auth Platform at https://console.cloud.google.com/auth/overview and start the setup.
2. App name `XOS`, the support email, and the developer contact email.
3. Audience: **External**. Publish the app (Audience, Publish app) so it is "In production"; while it is "Testing", only listed test users can sign in.
4. Branding: the home page and the privacy policy and terms links on the Atlas domain (`https://<atlas domain>/legal/privacy-policy`, `https://<atlas domain>/legal/terms-of-service`), and the logo if you want Google to show it (a logo needs Google's brand verification).
5. Authorized domains: the production domain (`<domain>`) and `supabase.co`, which hosts the redirect URI.
6. Data Access (scopes): `openid`, `.../auth/userinfo.email` and `.../auth/userinfo.profile`. They are non-sensitive, so no further verification is needed.

### 2. The Web client (Atlas, Gateway, and the ID token audience for Compass)

1. Google Auth Platform, Clients, Create client, application type **Web application**, name `XOS Supabase Auth`.
2. Authorized redirect URI: `https://fquuqnzlpobaawucczgq.supabase.co/auth/v1/callback`. When staging moves to a Supabase branch (`promote-to-production.md`, step 14), add that branch's own `https://<branch ref>.supabase.co/auth/v1/callback`.
3. No JavaScript origins are needed: the browser never talks to Google from Atlas or Gateway pages.
4. Create, then copy the client ID and the client secret into the owner's secret store.

For local development, create a separate Web client with the redirect URI `http://127.0.0.1:55421/auth/v1/callback` (the local stack's callback) and use it only on your machine; never put the production client on a laptop.

### 3. The iOS client (Compass)

1. Create client, application type **iOS**, name `Compass iOS`, bundle ID `pro.ghxstship.compass`. The App Store ID and Team ID are optional.
2. Copy the client ID. Its reversed form (`com.googleusercontent.apps.<the part before .apps>`) is the URL scheme; `apps/compass/app.config.ts` adds it to the build from `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID`, so nothing is entered by hand.

### 4. The Android clients (Compass)

1. Get the SHA-1 of every key that signs a Compass build: `eas credentials --platform android` (the upload key EAS holds), and Play Console, Test and release, App integrity, App signing (the key Google Play signs store installs with). A development build signed with another keystore needs its SHA-1 too.
2. For each SHA-1, Create client, application type **Android**, name `Compass Android (<which key>)`, package name `pro.ghxstship.compass`, and the SHA-1.
3. Copy each client ID. Android does not read it in the app; Google matches the app by package and certificate, and Supabase must accept it (step 5).

### 5. Supabase (Authentication, Sign In / Providers, Google) (OWNER CONFIRMS)

| Setting                    | Value                                                                                                    |
| -------------------------- | -------------------------------------------------------------------------------------------------------- |
| Enable Sign in with Google | On                                                                                                       |
| Client IDs                 | The Web client ID first, then the iOS client ID, then each Android client ID, comma-separated, no spaces |
| Client Secret (for OAuth)  | The Web client secret                                                                                    |
| Skip nonce checks          | On. Google's iOS SDK puts a nonce in the ID token that Compass cannot read (ADR 0036, decision 9)        |
| Allow users without email  | Off                                                                                                      |

The callback URL this page shows is the one entered in step 2. The redirect URLs back to Atlas and Gateway are the ones in `promote-to-production.md`, step 5; Google needs nothing more. Manual linking stays off (step 8 there).

### 6. Compass (EAS) and a new build

1. In EAS (expo.dev, the project, Environment variables), add to the `production` and `preview` environments, visibility Plain text (they are public):
   - `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID`: the Web client ID.
   - `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID`: the iOS client ID.
2. Build Compass again (`eas build --platform all --profile production`, "Compass releases" below). The values are read at build time, and the Google SDK is a native module, so an over-the-air update is not enough.

Without `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` Compass shows no Google button; without the iOS client ID it shows none on iOS.

### 7. Verify

1. Atlas: sign in with Google using a Google account that has no XOS account. You land on "Create your organization"; the new person has the Google account's name.
2. Gateway: sign in with Google using another new Google account. You are asked to accept the Worker Terms, then land on Home.
3. Sign in with Google using the email of an existing XOS account. You land in that account (same organizations), not a new one.
4. Compass on iOS and Android: Continue with Google, pick the account, and Compass loads your work.
5. Cancel on Google's account picker: the sign-in page says you left before it finished.

Rollback: turn "Enable Sign in with Google" off. The buttons disappear within five minutes (Atlas and Gateway cache the provider list); accounts keep their google identity and can still sign in by email.

## Monitoring and alerting

| Signal        | Where                                                                                                                          | Alert                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| Errors        | Sentry projects `xos-atlas` and `xos-gateway`, plus the Edge Functions' DSN; scrubbed of personal data (`infra/observability`) | Create one alert rule per project: a new issue, or more than 10 events in 5 minutes, emails on-call |
| Logs          | Vercel runtime logs; Supabase logs (API, Postgres, Auth, Edge Functions). One JSON line per event, with `request_id`           | Search by `x-request-id` from a user report. Log drains are a paid add-on: **OWNER** decision       |
| Uptime        | `synthetics.yml` every 5 minutes from `us-east`: sign-in, Gateway, API, Realtime, sync, notifications                          | A failed required check posts to `XOS_ALERT_WEBHOOK_URL` and turns the status page red              |
| Status page   | GitHub Pages from `gh-pages`, history on `status-data`, incidents in `infra/status/incidents.json`                             | Public; updated every synthetics run                                                                |
| Deploy health | The release gate's error rate and p95 per rollout stage                                                                        | Rolls back on its thresholds (`progressive-delivery.md`)                                            |
| Database      | Supabase reports (CPU, connections, disk), advisors, and the weekly restore drill                                              | Supabase usage emails at 80 percent of plan quotas                                                  |
| Backups       | Daily backups listed in Dashboard, Backups; `backup-weekly.yml` run status                                                     | A failed weekly backup run emails the repository admins                                             |

One-minute checks from five regions (Section 5.1) need a paid monitoring service: **OWNER** decision (`infra/ci/README.md`, Frequency and regions).

## On-call checklist

**At the start of a shift**

- [ ] The status page is green, and the last synthetics run is under 10 minutes old.
- [ ] No unresolved Sentry issue is marked for escalation; new issues since the last shift are triaged.
- [ ] Supabase and Vercel status pages show no open provider incident.
- [ ] You can reach the Supabase dashboard, Vercel, Sentry and the on-call channel, and you know who the incident commander backup is.

**Daily**

- [ ] Yesterday's errors in Sentry: each new issue has an owner or is resolved.
- [ ] The webhook, notification, upload-scan and report workers ran: `app.job_queue`, `app.webhook_deliveries` and `app.notification_deliveries` are not growing, no object waits in `private.object_scans` for more than a few minutes (`select bucket_id, count(*) from private.object_scans where scan_status = 'Scanning' group by 1;`), `upload-scan` answers 200 and not 503, and `cron.job_run_details` shows no failed database jobs.
- [ ] Database CPU, connections and disk are below 70 percent of the plan.

**Weekly**

- [ ] `backup-weekly.yml` succeeded and its artifact exists.
- [ ] Run `infra/drills/release-drill.sh` on a fresh local stack; record the result in `backup-and-restore.md`.
- [ ] Review Supabase advisors and `pnpm --filter @xos/config licenses:check`; dependency updates from Renovate are merged or triaged.
- [ ] Error budget: the 30-day uptime on the status page is above 99.9 percent.

**When paged**

Follow `incident-response.md`: confirm impact, set the severity, contain first, post on the status page within 30 minutes for SEV1 and SEV2, and page the Privacy Officer if personal data may be involved.

## Compass releases

Compass's version is in `apps/compass/app.json` (`4.0.0`); the bundle identifier and Android package are `pro.ghxstship.compass`.

### Compass store release

Everything that does not need an account is in the repository (A68, RRR-113): `apps/compass/eas.json` (build profiles development, preview and production; submit profiles for TestFlight and the Play internal track), the privacy manifest and purpose strings, the store listings and screenshots, and the privacy, data safety, age rating and App Review answers under `apps/compass/store/` (start with its `README.md`). Every value that waits on an account is an `OWNER_` token; `git grep OWNER_ apps/compass` lists them. Run every command below from `apps/compass`, where `npx eas` is the repository's eas-cli (24.12.0).

#### One-time setup (OWNER)

The accounts (ADR 0033, decisions 11 and 12): an Apple Developer Program organization membership (needs the D-U-N-S number), a Google Play Console organization account, and an Expo account that belongs to the `ghxstship` organization (`app.json` `owner`; project id `7a96bb1f-c266-4df1-a072-b03bbc3d567e`). EAS's free tier covers a few builds a month; a paid plan is a stop point.

1. **Sign in to EAS and check the project.**

   ```sh
   cd apps/compass
   npx eas login
   npx eas whoami
   npx eas project:info            # ghxstship/xos-compass, id 7a96bb1f-c266-4df1-a072-b03bbc3d567e
   ```

2. **The app icon.** Put the brand icon at `apps/compass/assets/icon.png`: 1024 x 1024 PNG, no transparency. There is no Compass icon in the repository yet, and release builds stop without it.

3. **EAS environment variables**, once per environment (`production` below; repeat with `preview` and the staging values). Values are typed here, never committed:

   ```sh
   npx eas env:set production --name EXPO_PUBLIC_SUPABASE_URL --value https://<project-ref>.supabase.co --visibility plaintext
   npx eas env:set production --name EXPO_PUBLIC_SUPABASE_ANON_KEY --value <anon key> --visibility plaintext
   npx eas env:set production --name EXPO_PUBLIC_ATLAS_URL --value https://app.<domain> --visibility plaintext
   npx eas env:set production --name EXPO_PUBLIC_GATEWAY_URL --value https://gateway.<domain> --visibility plaintext
   npx eas env:set production --name XOS_UNIVERSAL_LINK_HOSTS --value atlas:app.<domain>,gateway:gateway.<domain> --visibility plaintext
   npx eas env:set production --name XOS_APPLE_TEAM_ID --value <team id> --visibility plaintext
   npx eas env:set production --name GOOGLE_SERVICES_JSON --type file --value ./google-services.json --visibility secret
   npx eas env:list production
   ```

   Delete the local `google-services.json` afterwards; EAS keeps it. Set `COMPASS_APPLE_TEAM_IDS` and `COMPASS_ANDROID_CERT_SHA256` on the Atlas and Gateway Vercel projects too (Environment variables), so universal links verify.

4. **App Store Connect.** In Certificates, Identifiers and Profiles, register the bundle ids `pro.ghxstship.compass` and `pro.ghxstship.compass.clock-activity` (the widget and Live Activity) with the App Group `group.pro.ghxstship.compass`, or let step 6 create them. In App Store Connect, My Apps, create the app: name "XOS Compass" (`store.config.json` `apple.info.en-US.title`; pick another if Apple says it is taken, and change it there), primary language English (U.S.), bundle id `pro.ghxstship.compass`, SKU `xos-compass`. Create an App Store Connect API key with the App Manager role (Users and Access, Integrations).

5. **Fill the iOS values and commit them** (`eas.json` has `requireCommit`; none of these is a secret): in `apps/compass/eas.json`, `submit.production.ios.ascAppId` becomes the app's numeric Apple ID (App Information, General) and `appleTeamId` the team id. In TestFlight, create an internal group (for example "Compass internal") with automatic distribution on and add the testers.

6. **iOS credentials, interactively once.** Signs in to Apple through EAS and stores everything on EAS:

   ```sh
   npx eas credentials --platform ios
   ```

   Choose the production profile, then: let EAS create the distribution certificate and the provisioning profiles for `pro.ghxstship.compass` and `pro.ghxstship.compass.clock-activity` (the first build turns on App Groups and Push Notifications for both from the entitlements); add the App Store Connect API key from step 4 for submissions; set up a push notification key (Expo sends push through APNs with it).

7. **Google Play Console.** Create the app: name "XOS Compass", default language English (United States), App, Free. Keep Play App Signing on. Fill App content from `apps/compass/store/google-play/data-safety.md` and `apps/compass/store/age-rating.md`, App access from `apps/compass/store/review-notes.md`, and the store listing from `apps/compass/store/google-play/listing.json` with the screenshots in `apps/compass/store/google-play/<locale>/phone/`. Add the internal testers' list.

8. **Google service account for submissions.** In Google Cloud, create a service account and a JSON key; in Play Console, Users and permissions, invite its email with release permissions for this app. Then either upload the key to EAS (preferred) and delete `serviceAccountKeyPath` from `submit.production.android` in `eas.json`:

   ```sh
   npx eas credentials --platform android      # production, Google Service Account, upload the key for submissions
   ```

   or keep the key file outside the repository and put its path in `serviceAccountKeyPath`. Commit `eas.json`.

9. **Firebase for Android push.** Create a Firebase project with an Android app `pro.ghxstship.compass` (its `google-services.json` is step 3's file variable), and upload an FCM V1 service account key: `npx eas credentials --platform android`, production, Push Notifications.

10. **The first Android upload is manual** (the Google Play API cannot create an app's first release):

    ```sh
    npx eas build --platform android --profile production
    ```

    Download the `.aab` from the build page, then in Play Console, Test and release, Testing, Internal testing, create a release, upload it and roll it out. Check its permissions against `apps/compass/store/permissions.md` (App bundle explorer, Permissions). Note the app signing certificate's SHA-256 (Test and release, App integrity) for `COMPASS_ANDROID_CERT_SHA256`.

11. **Check that nothing is missing:**

    ```sh
    pnpm --filter @xos/compass store:preflight ios
    pnpm --filter @xos/compass store:preflight android
    pnpm --filter @xos/compass store:preflight metadata
    ```

#### Each release: one command per store

From the tagged commit:

```sh
pnpm --filter @xos/compass release:ios        # build on EAS, next build number, submit to TestFlight
pnpm --filter @xos/compass release:android    # build the .aab on EAS, submit to the Play internal track
```

Each runs the preflight, then `eas build --platform <ios|android> --profile production --auto-submit`. The first iOS build may ask to confirm credentials; later builds run unattended.

- **TestFlight:** when App Store Connect finishes processing (minutes), the internal group with automatic distribution gets the build; no review is needed for internal testers. App Store Connect asks the export compliance question for each build until counsel confirms the answers in `apps/compass/store/ios/privacy-manifest.md` and `ios.config.usesNonExemptEncryption` is set in `app.json`. External TestFlight groups need Beta App Review; adding one is not a public release.
- **Play internal testing:** the release reaches internal testers once Play processes it, without review. If Play answers that only draft releases are allowed (the app has not finished its first setup), submit the same build as a draft and roll it out in Play Console:

  ```sh
  npx eas submit --platform android --profile internal-draft --latest
  ```

- **App Store listing:** after the listing, review contact and domain values are filled in `apps/compass/store/store.config.json`, push the text, screenshots, categories, age rating and review notes in one step (it creates the version's draft; it never submits it):

  ```sh
  pnpm --filter @xos/compass store:metadata
  ```

  Then type the demo password into App Store Connect, App Review Information, and enter the App Privacy answers from `apps/compass/store/ios/app-privacy.md` (App Privacy is not part of `eas metadata:push`).

- **Smoke test:** testers install from TestFlight and from the Play opt-in link. Run the Maestro field flows on a tester device, including airplane mode and queue drain, and send one approval push (journey 57) to each platform.

Retaking the store screenshots after a UI change: `apps/compass/scripts/store-screenshots.sh` (local stack and simulator only; its header lists what it needs).

### OWNER stop: public store submission

Submitting to the public App Store (App Review for release) or promoting to the Play production track (or closed and open tracks that reach the public) is a Section 19.8 stop condition. The listing, screenshots, privacy labels (App Privacy and the Play Data safety form), age rating and review notes are ready in `apps/compass/store/`; the release owner sets up the review accounts (`apps/compass/store/review-notes.md`), checks the open questions in `apps/compass/store/README.md` and `docs/release-checklist.md` (Compass store release), then stops and asks the owner. Only the owner presses Submit for Review or promotes to production. `store.config.json` keeps `automaticRelease` false, so even an approved version waits for the owner to release it.
