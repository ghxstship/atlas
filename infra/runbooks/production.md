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

| Host                                                             | Serves                                                                 | Vercel project     | State on 2026-10-23                                                                      |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------- |
| `atlas.ghxstship.tech`                                           | Atlas                                                                  | `atlas`            | Serving, with a certificate                                                              |
| `gateway.ghxstship.tech`                                         | Gateway on the platform brand                                          | `gateway`          | Serving, with a certificate. `gateway-umber-omega.vercel.app` is a platform host too     |
| `api.ghxstship.tech`                                             | The public API, served by Atlas at `/v1`                               | `atlas`            | The orchestrator attaches it                                                             |
| `docs.ghxstship.tech`                                            | The docs site                                                          | `docs`             | The orchestrator creates the project                                                     |
| `console.ghxstship.tech`                                         | The operator console (ADR 0046)                                        | `console`          | Project and domain created (ADR 0033, decision 79); the variables below are still to set |
| `mail.ghxstship.tech`                                            | The sending domain for email through Resend                            | None               | DNS records to add                                                                       |
| `inbound.ghxstship.tech`                                         | The receiving domain for project inboxes and reply by email (ADR 0040) | None               | MX records for Resend's inbound mail to add (ADR 0033, decision 60)                      |
| `status.ghxstship.tech`                                          | The status page on GitHub Pages (ADR 0025 item 7)                      | None               | A CNAME to GitHub Pages to add (ADR 0033, decision 72)                                   |
| `atlas-staging.ghxstship.tech`, `gateway-staging.ghxstship.tech` | Atlas and Gateway on the persistent staging branch                     | `atlas`, `gateway` | Kept (ADR 0033, decision 63)                                                             |

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

### console.ghxstship.tech (project `console`, ADR 0046)

The operator console for the platform team. The owner created the project and attached the domain (ADR 0033, decision 79). Still to set, by the owner: `SUPABASE_ANON_KEY` for Production and Preview, `CONSOLE_SITE_URL` for Preview, and the Auth redirect URLs below.

| Setting                                                    | Value                                                                                                                                                                                                                |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Team and name                                              | `ghxstship`, `console`                                                                                                                                                                                               |
| Git repository and production branch                       | `ghxstship/atlas`, `main`                                                                                                                                                                                            |
| Framework preset                                           | Next.js                                                                                                                                                                                                              |
| Root Directory                                             | `apps/console`                                                                                                                                                                                                       |
| Include files outside the Root Directory in the Build Step | On (the default)                                                                                                                                                                                                     |
| Install Command                                            | `pnpm install --frozen-lockfile`                                                                                                                                                                                     |
| Build Command                                              | `pnpm turbo run build --filter=@xos/console`                                                                                                                                                                         |
| Environment variables (Production)                         | `SUPABASE_URL`, `SUPABASE_ANON_KEY` (the publishable key), `CONSOLE_SITE_URL=https://console.ghxstship.tech`, `CONSOLE_PASSWORD_SIGN_IN=false`. Never the service role key                                           |
| Environment variables (Preview)                            | `SUPABASE_URL` and `SUPABASE_ANON_KEY` of the persistent staging branch, as for `atlas` and `gateway`, and `CONSOLE_SITE_URL=https://console-git-staging-ghxstship.vercel.app` (`promote-to-production.md`, step 14) |
| Domains                                                    | `console.ghxstship.tech` on Production; its CNAME at the DNS host as Vercel shows it                                                                                                                                 |

- Supabase Auth: add `https://console.ghxstship.tech/auth/callback**` to the production redirect allow-list (ADR 0036;
  `promote-to-production.md`, step 5), and `https://console-git-staging-ghxstship.vercel.app/auth/callback**` to the
  staging branch's (Staging branch plan, step 4).
- Name the first Administrator once in the Supabase SQL editor, after the person has signed up for an XOS account:
  `select private.grant_platform_operator('<platform email>', 'Administrator', '<reason>');`. Administrators add
  the rest of the platform team in the console, under Platform Team.
- Verify: `https://console.ghxstship.tech/tenants` sends a signed-out visitor to sign in; an Atlas account that is not
  on the platform team is signed out with "This console is for the XOS platform team".

### Email from mail.ghxstship.tech (Resend, decision 6)

1. In Resend, Domains, add `mail.ghxstship.tech`. Resend then lists the records to add. Copy each name, type and
   value from that page; never retype the DKIM key.
2. Add them at the DNS host of `ghxstship.tech`:

   | Purpose     | Type | Name and value                                                                                                                                                                                                                 |
   | ----------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
   | SPF         | TXT  | As Resend lists it, on its return-path subdomain under `mail.ghxstship.tech`                                                                                                                                                   |
   | Return path | MX   | As Resend lists it, on the same subdomain, so bounces come back to Resend                                                                                                                                                      |
   | DKIM        | TXT  | As Resend lists it, on a `_domainkey` name under `mail.ghxstship.tech`                                                                                                                                                         |
   | DMARC       | TXT  | `_dmarc.mail.ghxstship.tech`: `v=DMARC1; p=none; rua=mailto:<the DMARC report mailbox>`, monitoring only, with aggregate reports to a mailbox the owner reads (ADR 0033, decision 46). Step 5 below moves it to `p=quarantine` |

   A policy at `_dmarc.ghxstship.tech` instead covers every subdomain unless its `sp=` says otherwise.

3. Verify the domain in Resend. Then set Supabase SMTP (`promote-to-production.md`, step 6) and the function
   secrets `RESEND_API_KEY` and `XOS_EMAIL_FROM`.
4. **Email to real recipients, at cutover (ADR 0033, decision 41).** Wait until Resend shows `mail.ghxstship.tech`
   verified with SPF, DKIM and DMARC passing, and the function secret `XOS_POSTAL_ADDRESS` holds the postal address
   published on the Contact page (OWNER_INPUTS item 2), which every email footer carries under CAN-SPAM. Then set
   `XOS_EMAIL_DELIVER_TO_ANY=true` on production only. Until then product email reaches only `XOS_EMAIL_ALLOWLIST`,
   and the staging branch keeps the allowlist for good. Check: send an invitation to an address outside the
   allowlist and find it delivered in Resend's log.
5. **DMARC to quarantine.** Read the aggregate reports weekly. After two to four weeks in which they show only
   Resend sending for `mail.ghxstship.tech` and every message passing SPF or DKIM in alignment, change the record to
   `v=DMARC1; p=quarantine; rua=mailto:<the DMARC report mailbox>`. Keep the reports coming; a sender that appears
   later goes back to `p=none` until it is fixed or removed.

Reply by email and project inboxes (`XOS_INBOUND_DOMAIN`, ADR 0040) receive on `inbound.ghxstship.tech`, a
subdomain used only for receiving, through Resend's inbound mail (ADR 0033, decision 60). Resend is already on the
Subprocessor List, and its row names inbound mail.

Resend meets ADR 0040's requirements (checked 2026-10-23 against Resend's documentation; RRR-139). Two things are
wired differently: the webhook carries metadata only, and it is signed instead of sent with a bearer secret.
`inbound-email` takes both:

- **Parsing:** Resend parses each message. Its `email.received` webhook carries only metadata (sender, recipients,
  subject, Message-ID, attachment names), so `inbound-email` reads the text, the HTML and the rest from Resend's
  Receiving API (`GET /emails/receiving/{id}`). That API refuses sending-only keys, so it needs a full-access key of
  its own.
- **DKIM:** the received email's `authentication.dkim` is computed by Resend's own mail server, so a sender cannot forge
  it. Only `pass` counts as verified; `gray` (unsigned, or signed by a domain other than the From domain), `fail` and
  the rest do not, and such mail is never filed.
- **Raw message:** Resend keeps a received message for 30 days, behind a signed download URL. `inbound-email` copies it
  into the private `inbound-mail` bucket (migration 1651) as `<org id>/resend/<email id>.eml`, which `raw_object_path`
  records, once the database has taken the message. The org prefix lets an org purge find the file even after
  retention has deleted its row. `inbound-email` asks the database for the org first (`app.inbound_email_org`), so mail
  to an address with no inbox costs no call to Resend and leaves nothing. Resend publishes no size limit; a message
  over 50 MiB, the bucket's limit, is filed without its raw copy and records `resend:<email id>` instead.
- **Authentication:** Resend signs each webhook the Svix way (HMAC-SHA256 over the id, timestamp and raw body, with the
  endpoint's `whsec_` signing secret) instead of sending a bearer secret. `inbound-email` refuses a bad signature and
  any timestamp more than five minutes off. `XOS_INBOUND_SECRET` is only for a provider that posts parsed messages.
- **Retries:** a failed delivery is retried immediately, then after 5 seconds, 5 minutes, 30 minutes, 2, 5, 10 and 10
  hours; then Resend disables the endpoint and emails the team. Messages can be replayed from the dashboard. Redelivered
  mail is filed once (Message-ID per org), and its raw copy is overwritten with the same file.
- **Attachments:** listed in the event and downloadable from Resend's Attachments API; XOS does not copy them onto the
  filed document yet (ADR 0040).

**OWNER**, in order:

1. In Resend, Domains, add `inbound.ghxstship.tech` with receiving enabled and sending turned off. Receiving was in
   early access when this was written; if the account does not offer it, ask Resend support before going further,
   since any other provider is a new subprocessor and needs 30 days' notice. Resend then lists the domain's records.
2. At the DNS host of `ghxstship.tech`, add exactly the records Resend lists for `inbound.ghxstship.tech`: its DKIM
   TXT record, which verifies the domain, and the receiving MX record. Copy the MX host and priority from Resend's page
   (its documentation names hosts such as `inbound-smtp.<region>.amazonaws.com`); the name has no other MX record, so
   Resend's is the lowest priority, as Resend requires. The sending records (SPF, return path) are not needed on a
   receive-only domain.

   | Name                               | Type | Value                                             |
   | ---------------------------------- | ---- | ------------------------------------------------- |
   | `inbound.ghxstship.tech`           | MX   | `<priority> <Resend's receiving host>`, as listed |
   | Resend's DKIM name under `inbound` | TXT  | As Resend lists it                                |

   Click "I've added the record" in Resend and wait until receiving shows Verified.

3. In Resend, Webhooks, add the endpoint `https://<project ref>.supabase.co/functions/v1/inbound-email` with the
   event `email.received` only. Copy its signing secret.
4. In Resend, API Keys, create a key with full access named for its use, for example `inbound-email receiving`. Keep
   `RESEND_API_KEY` sending-only.
5. Set the function secrets from your secret store: `RESEND_INBOUND_WEBHOOK_SECRET` (the signing secret),
   `RESEND_RECEIVING_API_KEY` (the full-access key) and `XOS_INBOUND_DOMAIN=inbound.ghxstship.tech`. Set
   `XOS_INBOUND_DOMAIN=inbound.ghxstship.tech` on the `atlas` Vercel project too, so Project Settings shows each
   project's full inbox address, and redeploy Atlas. Migration 1651 and the `inbound-email` function ship with the
   release (Deploy order).
6. Check: create a project inbox in Atlas (Project Settings, Project inbox) and forward one message to it from an
   address that signs with DKIM, such as Gmail. In Resend, the webhook's message shows a 200 answer with an
   `inbound_message_id`; in Supabase, Storage, `inbound-mail` holds `<org id>/resend/<email id>.eml`; in Atlas, the message is on
   the project's Documents tab, ready to file.

To rotate, create the new key or roll the signing secret in Resend, set the secret, then delete the old key. Until step
5, project inbox addresses show only their local part, and no mail arrives.

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

| Name                             | Type    | For                            | Value from                                              |
| -------------------------------- | ------- | ------------------------------ | ------------------------------------------------------- |
| `api`                            | CNAME   | Vercel project `atlas`         | Vercel, when the domain is added                        |
| `docs`                           | CNAME   | Vercel project `docs`          | Vercel, when the domain is added                        |
| Resend's records under `mail`    | TXT, MX | SPF, return path, DKIM         | Resend, Domains, `mail.ghxstship.tech`                  |
| `_dmarc.mail`                    | TXT     | DMARC                          | The owner's policy (above)                              |
| Resend's records under `inbound` | MX, TXT | Receiving, DKIM                | Resend, Domains, `inbound.ghxstship.tech` (decision 60) |
| `status`                         | CNAME   | The status page (GitHub Pages) | `infra/ci/README.md`, Repository settings; decision 72  |

`atlas` and `gateway` resolve already, and `console`, `atlas-staging` and `gateway-staging` exist (decisions 63 and 79). Passkeys on the web need nothing at the apex `ghxstship.tech`.

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

- Run against staging first, then production, from the tagged commit. The Supabase GitHub integration is not
  connected (ADR 0033, decision 48), so this step is the only way a migration reaches production; a push to
  `main` never migrates it. `supabase db push` asks for the database password, which the owner types
  (decision 75).
- Never load `supabase/seeds` into production; they are the demo tenant.
- Then run `infra/drills/key-tables.sql` read-only in the production SQL editor and keep the output with the release.
- Database advisors: Dashboard, Advisors. Zero errors (gate 11).

### 2. Edge Functions

```sh
supabase functions deploy --project-ref <production-ref>
supabase secrets list --project-ref <production-ref>   # names only; values never print
```

Set any secret new in this release with `supabase secrets set --project-ref <production-ref> NAME=...` from the owner's secret store. Confirm the worker schedules (`webhook-dispatch`, `notification-dispatch`, `upload-scan`, `report-run`, `import-run`, `integration-worker`, `subprocessor-notices`, `automation-run`, `search-embed`, each every minute; `infra/runbooks/integrations.md`; and `xos_fx_rates_ecb`, which a migration creates, section Exchange rates) still exist: `select jobname, schedule from cron.job order by 1;`.

How the functions are bundled (A85, RRR-130):

- Each function has its own bundle entry and its own import map. `supabase/functions/_vendor/<function>.js` holds the platform code that function uses, `_vendor/core.js` the logger, request observer and database seam every function shares, and `_vendor/chunks/` the code several functions share or load on demand. `supabase/functions/<function>/deno.json` lists only the npm packages that function imports, pinned from `supabase/functions/deno.json`. `supabase functions deploy` picks up each function's `deno.json` itself; pass no `--import-map`.
- All of these files are generated: `pnpm --filter @xos/platform bundle:edge`. The `@xos/platform` tests fail when a generated file is stale, missing or extra, when a function loads an npm package at boot that it did not load before, or when its boot code passes its budget (`packages/platform/test/edge-bundle.test.ts`). A new npm package must be pinned in `supabase/functions/deno.json` before the build will use it.
- A new function (for example A79's `org-lifecycle`): add `packages/platform/edge/entries/<function>.ts` exporting exactly what its `index.ts` uses, imported module by module (never through a package's index, which pulls every module in). In `index.ts`, import those from `../_vendor/<function>.js` and the logger or database seam from `../_vendor/core.js` (or through `_shared/runtime.ts`). Load a heavy package with a dynamic `import()` where a request may not need it. Run `bundle:edge`, then add the function's boot and lazy packages and its boot budget to `packages/platform/test/edge-bundle.test.ts`. The test fails for a function directory with no entry; a function that uses nothing but the shared core goes in that test's `CORE_ONLY` list instead.
- Deploy with the CLI's default Docker bundling. Never pass `--use-api`: server-side bundling allows 5 MB per function and `report-run` is about 9 MB compressed (69 MB as an eszip, mostly exceljs and pdfkit, which load only for .xlsx and PDF runs). Local bundling allows 20 MB.
- Cold starts: `kiosk-punch`, `api-token`, `email-unsubscribe` and `webhook-dispatch` load no npm package; `stripe-webhook` loads Stripe only once a request carries a signature; `scim`, `integration-worker`, `integration-inbound`, `import-run` and `upload-scan` load only supabase-js (`import-run` loads exceljs when it reads a workbook); React Email and Resend load only when `notification-dispatch` or `report-run` sends. The hosted limits are 2 s of CPU and 256 MB a request. A function that answers HTTP 546 hit one of them: check whether its boot code grew (`bundle:edge`, then the budget test) before raising anything.

Kiosk re-keying: a kiosk whose device key was retired or revoked in Atlas answers every punch with `kiosk_device_unregistered`, and Compass shows "This device is no longer registered as a kiosk". Register a new kiosk in Atlas, then on the device, signed in as a supervisor, choose **Forget this kiosk** and enter the new key (Compass help, Kiosk).

### 3. Apps

1. Vercel builds `atlas`, `gateway`, `docs` and `console` for the tagged commit as preview deployments against staging. Let Atlas and Gateway run there for 30 minutes with the synthetic checks green.
2. Promote `atlas` through its Rolling Release: 5, 25 and 100 percent, each stage approved by hand when the release gate (`progressive-delivery.md`) says promote. The plan includes Rolling Releases for one project, and `atlas` has it (ADR 0033, decision 50).
3. Promote `gateway` directly, then watch the gate's numbers for 30 minutes and use Instant Rollback if it says roll back.
4. `docs` and `console` promote directly.

### 4. Packages

Pushing the tag starts `publish-packages.yml` (`infra/ci/README.md`, section 5). It waits for the owner's approval in the `npm` and `pypi` environments. **OWNER** confirms the `@xos` npm scope and the `xos-sdk` PyPI name belong to the owner's accounts before the first publish; publishing under a new organization name is a stop point.

### 5. Compass

See Compass releases below. Compass ships on its own cadence; a web release never waits for store review.

### 6. Close

1. Smoke test as a real user: sign in to Atlas, open a project, open Gateway as an external party, call `GET https://api.ghxstship.tech/v1/openapi.json` and `xos auth status`.
2. Post the release notes and record the evidence in `docs/release-checklist.md`.

## Rollback

| What                   | How                                                                                                                                                                                             | Time            |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| A feature              | Kill switch: `pnpm --filter @xos/infra rollout:gate flag-kill <flag> on` prints the SQL; run it with the service role (`progressive-delivery.md`)                                               | 1 request       |
| Atlas, Gateway or docs | Atlas: abort the Rolling Release, which returns all traffic to the previous production deployment. Gateway, docs and the console: Vercel Instant Rollback to the previous production deployment | Seconds         |
| Edge Functions         | Check out the previous tag and redeploy the functions: `git switch --detach vPREV`, then `supabase functions deploy --project-ref <production-ref>`, then return to `main`                      | Minutes         |
| A migration            | Never run a down migration. Ship a forward fix as a new migration. The previous app build keeps working on the new schema (expand and contract)                                                 | One deploy      |
| Lost or corrupted data | Restore to a new project and switch traffic (`backup-and-restore.md`, Restoring production). Declare a SEV1 first                                                                               | Under 4 h (RTO) |
| A published package    | Never unpublish. Publish the next patch; `npm deprecate @xos/sdk@X.Y.Z "<reason>"` and yank on PyPI                                                                                             | Minutes         |
| A Compass build        | Expire the build in TestFlight, or halt the Play rollout; testers keep the previous build                                                                                                       | Minutes         |

## Environment variables

Values live in Vercel, the Supabase project, EAS and GitHub. They are never committed and never printed in logs or tickets. "Public" means the value is safe to ship to browsers by design.

### Atlas (Vercel project `atlas`)

| Variable                      | Production value                                                                       |
| ----------------------------- | -------------------------------------------------------------------------------------- |
| `SUPABASE_URL`                | The production Supabase API URL                                                        |
| `SUPABASE_ANON_KEY`           | The production anon key (public; RLS guards every row)                                 |
| `ATLAS_SITE_URL`              | `https://atlas.ghxstship.tech` (set 2026-10-20)                                        |
| `GATEWAY_SITE_URL`            | `https://gateway.ghxstship.tech` (set 2026-10-20)                                      |
| `XOS_API_HOST`                | `api.ghxstship.tech`, Production only, once `api.` is attached                         |
| `DOCS_SITE_URL`               | `https://docs.ghxstship.tech`, once `docs.` serves                                     |
| `NEXT_PUBLIC_SENTRY_DSN`      | DSN of the Sentry project `xos-atlas` (public)                                         |
| `XOS_TRACES_SAMPLE_RATE`      | `0.05` (`1` on Preview)                                                                |
| `XOS_LOG_LEVEL`               | `info` (`debug` on Preview)                                                            |
| `COMPASS_APPLE_TEAM_IDS`      | The Apple team id, once the developer account exists                                   |
| `COMPASS_ANDROID_CERT_SHA256` | The Play app signing certificate fingerprint, once the app exists                      |
| `XOS_INBOUND_DOMAIN`          | `inbound.ghxstship.tech`, once Resend receives there (ADR 0040; ADR 0033, decision 60) |
| `VAPID_PUBLIC_KEY`            | The Web Push public key ("Web push" below; public, ADR 0052)                           |
| `STRIPE_SECRET_KEY`           | The live key once billing opens (ADR 0033, decision 59); the sandbox key on staging    |

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
| `VAPID_PUBLIC_KEY`            | As Atlas                                                                                                      |

### Docs (Vercel project `docs`)

None. The site is built from the repository and the OpenAPI document. Project settings: Domains, "docs.ghxstship.tech".

### Edge Functions (production Supabase project secrets)

| Secret                                                    | Notes                                                                                                                                                     |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `XOS_API_JWT_SIGNING_KEY`                                 | The project's JWT secret, for `api-token`, `integration-worker` and `automation-run` (ADR 0047)                                                           |
| `XOS_APP_URL`, `XOS_GATEWAY_URL`, `XOS_POSTAL_ADDRESS`    | `https://atlas.ghxstship.tech`, `https://gateway.ghxstship.tech`; the postal address in email (CAN-SPAM)                                                  |
| `XOS_EMAIL_TRANSPORT`, `XOS_EMAIL_FROM`, `RESEND_API_KEY` | `resend`; an address on the verified domain, such as `XOS <notifications@mail.ghxstship.tech>`; the Resend key                                            |
| `XOS_EMAIL_ALLOWLIST`, `XOS_EMAIL_DELIVER_TO_ANY`         | `XOS_EMAIL_DELIVER_TO_ANY=true` only in production, at cutover, once the domain passes its checks and `XOS_POSTAL_ADDRESS` is set (ADR 0033, decision 41) |
| `RESEND_INBOUND_WEBHOOK_SECRET`                           | The signing secret of Resend's `inbound-email` webhook (Email, above)                                                                                     |
| `RESEND_RECEIVING_API_KEY`                                | A full-access Resend key for the Receiving API; `RESEND_API_KEY` stays sending-only                                                                       |
| `XOS_INBOUND_DOMAIN`                                      | `inbound.ghxstship.tech`, for reply by email and project inboxes. `XOS_INBOUND_SECRET` is not needed with Resend                                          |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`              | Live Stripe keys, once billing opens after Atlas Checkout ships (ADR 0033, decision 59); test keys until then                                             |
| `XOS_CLAMAV_HOST`, `XOS_CLAMAV_PORT`                      | The private address and port of clamd ("Upload scanning (ClamAV)" below); the port defaults to 3310                                                       |
| `XOS_SLACK_SIGNING_SECRET`                                | Slack events and slash commands (`integration-inbound`), `infra/runbooks/integrations.md`                                                                 |
| `XOS_XERO_WEBHOOK_KEY`                                    | Xero change notices (`integration-inbound`), once the Xero app exists                                                                                     |
| `XOS_QUICKBOOKS_VERIFIER_TOKEN`                           | QuickBooks Online change notices (`integration-inbound`), once the app exists                                                                             |
| `SENTRY_DSN`, `XOS_ENVIRONMENT`, `XOS_LOG_LEVEL`          | The Edge Functions' Sentry DSN; `production`; `info`                                                                                                      |
| `XOS_PUSH_TRANSPORT`, `EXPO_ACCESS_TOKEN`                 | `expo` to send push ("Push and SMS" below); the access token only if enhanced push security is on                                                         |
| `XOS_WEB_PUSH_TRANSPORT`, `VAPID_SUBJECT`                 | `vapid` to send browser push ("Web push" below); a `mailto:` or `https:` contact for the push services                                                    |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`                   | `<87 base64url characters>`, the same public key as the apps; `<43 base64url characters>`                                                                 |
| `XOS_SMS_TRANSPORT`, `TWILIO_ACCOUNT_SID`                 | `twilio` to send SMS; the account SID, `AC<32 hex characters>`                                                                                            |
| `TWILIO_AUTH_TOKEN`, `TWILIO_MESSAGING_SERVICE_SID`       | `<32 hex characters>`; the 10DLC Messaging Service, `MG<32 hex characters>`                                                                               |
| `XOS_SMS_HELP_CONTACT`                                    | The mailbox or page HELP replies name (OWNER_INPUTS item 6)                                                                                               |
| `XOS_SMS_ALLOWLIST`, `XOS_SMS_DELIVER_TO_ANY`             | `XOS_SMS_DELIVER_TO_ANY=true` only in production, once Twilio approves the 10DLC campaign (ADR 0033, decision 65)                                         |
| `XOS_SMS_WEBHOOK_URL`                                     | Only when Twilio calls `sms-webhook` through another host; defaults to the function's own URL                                                             |

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided to functions by Supabase. The worker schedules read the service role key from Vault (`xos_worker_key`).

### Compass (EAS environment `production`; `preview` holds the staging values)

Set in the EAS dashboard (project, Environment variables, `production`). Every value is public by design.

| Variable                           | Value                                                                                                                                                               |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EXPO_PUBLIC_SUPABASE_URL`         | The production Supabase API URL                                                                                                                                     |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY`    | The production anon key (public), the new one after the key rotation                                                                                                |
| `EXPO_PUBLIC_ATLAS_URL`            | `https://atlas.ghxstship.tech`                                                                                                                                      |
| `EXPO_PUBLIC_GATEWAY_URL`          | `https://gateway.ghxstship.tech`                                                                                                                                    |
| `EXPO_PUBLIC_DOCS_URL`             | `https://docs.ghxstship.tech`, for the help center row in Settings                                                                                                  |
| `XOS_UNIVERSAL_LINK_HOSTS`         | Leave unset: the build claims `atlas.ghxstship.tech` and `gateway.ghxstship.tech`. An empty value turns universal links off for that build                          |
| `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` | The Google Web client ID (public), "Sign in with Google (OWNER)" below                                                                                              |
| `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID` | Leave unset until Sign in with Apple ships (ADR 0033, decision 58): without it iOS shows no Google button. Then the Google iOS client ID (public), the same section |
| `XOS_APPLE_TEAM_ID`                | The Apple team id (signs the widget extension in local device builds)                                                                                               |
| `GOOGLE_SERVICES_JSON`             | Secret file variable: the Firebase `google-services.json` for `pro.ghxstship.compass` (Android push)                                                                |

A preview or production build on EAS stops in `apps/compass/app.config.ts` when a server URL is missing, not https or local, or when the app icon `apps/compass/assets/icon.png` is missing.

### GitHub Actions (repository secrets and variables)

| Name                                            | Kind     | Used by                                                             |
| ----------------------------------------------- | -------- | ------------------------------------------------------------------- |
| `NPM_TOKEN`                                     | Secret   | `publish-packages.yml`, only until npm trusted publishing is set up |
| PyPI trusted publisher (no secret)              | pypi.org | `publish-packages.yml`                                              |
| `EXPO_TOKEN`                                    | Secret   | A Compass build workflow, if builds move to CI                      |
| `STAGING_DB_URL`                                | Secret   | `backup-weekly.yml`                                                 |
| `PRODUCTION_BACKUP_DB_URL`                      | Secret   | `backup-weekly.yml`, in the `production-backup` environment         |
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

## Stripe catalogue and billing (OWNER, test mode first)

XOS launches on the 14-day trial and the Access plan, and billing opens once Checkout is in place (ADR 0033, decision 59). Billing and Plan in Atlas opens Stripe Checkout for an org on a trial or Access and the Stripe customer portal for an org that pays; the `stripe-webhook` function keeps the subscription in step. Prices come from `packages/schemas/plans.yaml` by lookup key (pricing v4, ADR 0035); no price id is stored anywhere. Every key stays on the owner's machine or in the hosting providers' encrypted settings, never in a file.

### 1. Stripe sandbox

1. In the Stripe Dashboard, switch to test mode.
2. Turn on Stripe Tax with the company's origin address (Settings, Tax). Checkout computes tax and collects VAT and GST ids, and Stripe refuses to open a Checkout session until Tax is set up.
3. Copy the test mode secret key (`sk_test_...`). A restricted key (`rk_test_...`) works for the setup script if it can write products, prices, coupons, promotion codes and customer portal configurations; Atlas needs Checkout Sessions, Prices (read), Customer portal and Subscriptions.

### 2. Catalogue and customer portal

The setup script creates the products, prices, founding-customer coupon, `FOUNDING30` promotion code and the customer portal configuration Atlas opens:

1. From the repository root, see what would be created:
   `STRIPE_SECRET_KEY=sk_test_... pnpm --filter @xos/platform stripe:setup --dry-run`
2. Create them:
   `STRIPE_SECRET_KEY=sk_test_... pnpm --filter @xos/platform stripe:setup`
3. Run it again whenever you like. It creates only what is missing, brings products and the portal configuration up to date, and prints `unchanged` for the rest.

How it behaves:

- It refuses live mode keys. Creating the live catalogue is a separate owner step, made when billing opens.
- It never prints or stores the key.
- It exits 2 and writes nothing when Stripe already holds a price, coupon or promotion code that differs from `plans.yaml`. Stripe prices cannot be edited. To change a price, give it a new versioned lookup key in `plans.yaml` (for example `_v5`), regenerate the plan seed, and run the script again.
- The portal configuration (named "XOS plans", marked `xos_portal: xos_billing_portal_v1`) lets customers update the payment method and billing details, download invoices, cancel at the end of the paid period, and switch between the Core, Pro and Team prices, prorated. Atlas finds it by that mark; until the script has run, Atlas opens the account's default portal, which Stripe test mode offers only after the portal settings are saved in the Dashboard.

### 3. Webhook and secrets (staging first)

1. In the Dashboard (Developers, Webhooks), add an endpoint at `https://<project-ref>.supabase.co/functions/v1/stripe-webhook` that sends `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `customer.subscription.paused`, `customer.subscription.resumed`, `checkout.session.completed`, `checkout.session.async_payment_succeeded` and `checkout.session.expired`. Those events carry the plan, extra seats, Aurora pack payments and the state of each Checkout session.
2. Set the Edge Function secrets `STRIPE_WEBHOOK_SECRET` (the endpoint's signing secret, `whsec_...`) and `STRIPE_SECRET_KEY` (the same key; the function reads its mode, so test events never touch live billing).
3. Set `STRIPE_SECRET_KEY` on the `atlas` Vercel project for the staging environment, then redeploy. Without it Billing and Plan says billing is not open yet.
4. Check on staging: sign up, create an org (it starts the Pro trial), open Settings, Billing and plan, choose Core, pass the second factor, and pay with Stripe's test card `4242 4242 4242 4242`. Back in Atlas the page says the org is on Core; "Open the billing portal" opens the portal on the org's customer. In the Dashboard, the webhook endpoint shows every event delivered with HTTP 200.
5. If a payment went through and Billing and Plan keeps saying Stripe is confirming it, the subscription's event has not been applied yet. Find the failed `customer.subscription.*` delivery on the endpoint and resend it. Meanwhile Atlas offers that org no second Checkout, for up to three days after the payment (Stripe's retry window); after that a new checkout can open, so resolve it before then.

### 4. Opening billing in production

Billing opens with the live catalogue and live keys, a separate owner step: create the live catalogue (the script refuses live keys by design), add the live webhook endpoint, set the live `STRIPE_WEBHOOK_SECRET` and `STRIPE_SECRET_KEY` on the production Edge Functions and the live `STRIPE_SECRET_KEY` on the `atlas` Production environment, then redeploy.

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

### Web push (browsers, ADR 0052)

Atlas and Gateway subscribe browsers to Web Push (migration 1533). Browser pushes ride the Push deliveries, so A80's quiet hours and preferences apply. Until these steps are done, browser pushes are recorded, not sent, and the Browser Notifications setting says they are not set up yet.

1. Generate one P-256 key pair for VAPID on the owner's machine, for example `npx web-push generate-vapid-keys` in an empty directory. The public key is 87 base64url characters and the private key 43.
2. Set `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT` as Edge Function secrets, then `XOS_WEB_PUSH_TRANSPORT=vapid`, on staging first.
3. Set the same `VAPID_PUBLIC_KEY` on the Atlas and Gateway Vercel projects and redeploy them.
4. Check: on staging, turn on Personal settings, Notifications, Browser Notifications, then trigger an approval. `select push_service, message_status, count(*) from app.push_tickets group by 1, 2;` shows `Web Push` rows Delivered. A browser that unsubscribed answers 404 or 410 and is revoked automatically.
5. Never rotate the keys casually: a new key pair invalidates every browser subscription, and people must turn browser notifications on again.

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
5. **Secrets.** Set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_MESSAGING_SERVICE_SID` and `XOS_SMS_HELP_CONTACT`, then `XOS_SMS_TRANSPORT=twilio`. On staging also set `XOS_SMS_ALLOWLIST` to test numbers in E.164 (`+1<10 digits>`); production sets `XOS_SMS_DELIVER_TO_ANY=true` once the campaign is approved, and not before (ADR 0033, decision 65): until then texts reach only `XOS_SMS_ALLOWLIST`.
6. **Check.** Text HELP to the number: the reply names `XOS_SMS_HELP_CONTACT`. Text STOP: `app.suppression_list` gets a `STOP` row for every org that texts the number. Text START: it is lifted.

Texts go only to verified numbers with recorded consent in the org, and never in quiet hours: the member's own, or 21:00 to 08:00 in their time zone when they set none (ADR 0033 decision 35). The zone falls back from the member's own to the project's, then the org's, never UTC. Texts held overnight go out at the end of quiet hours as one summary per member and org. Only the kinds flagged `bypasses_quiet_hours` in `packages/schemas/notification-kinds.yaml` go at once: safety alerts and changes to a shift starting within 12 hours. Decision 62 adds a new shift assigned to start within 12 hours, security changes and emergency-access alerts, and holds billing alerts until morning; those changes land in migrations 1620 to 1629.

### Chat translation (off by default)

The seam is built (Section 4.9) but no screen calls it yet, and the platform runs no provider until `XOS_MESSAGE_TRANSLATION=google`. The owner chose Google Cloud Translation for chat text, off by default for each org, and listed it on the Subprocessor List before its first publication (ADR 0033, decision 52). To turn it on: check that the published Subprocessor List names it, enable the API in the ADR 0037 project, grant the runtime's service account `roles/cloudtranslate.user` through Workload Identity Federation (`GOOGLE_WORKLOAD_IDENTITY_AUDIENCE`, `GOOGLE_TRANSLATE_SERVICE_ACCOUNT`, no key), and set `XOS_MESSAGE_TRANSLATION=google`. Each org then turns on Settings, Communication, "Translate chat messages".

### Semantic search (off until an Admin turns it on)

`search-embed` (A87, migration 1440) embeds the published documents, SOPs and handbook articles of orgs that turned on Settings, AI features, "Semantic search", with Supabase's built-in gte-small model in the Edge Runtime, so no text goes to a new subprocessor. Deploy it with the other functions and schedule it every minute like `report-run`, with the `xos_worker_key` bearer; each call embeds at most eight texts and retires the vectors of anything unpublished or of an org that turned the switch off. Atlas embeds a person's query by calling the same function with their own session, which refuses unless their org has semantic search on. `XOS_SEARCH_EMBEDDINGS=off` (an Edge Function secret, and an Atlas environment variable) stops it everywhere; never set `local-hash` outside local development.

## Sign in with Google (OWNER)

Atlas, Gateway and Compass offer "Continue with Google" once Google is turned on in the Supabase project (ADR 0036). The code is in place; the owner creates three Google OAuth clients and enters them in Supabase and EAS. Compass on iOS waits for Sign in with Apple: App Review guideline 4.8 asks for it beside any third-party sign-in, so iOS builds leave out the Google button until it ships (ADR 0033, decision 58). Atlas and Gateway need nothing in Vercel: they show the button when Supabase reports Google enabled. Until then no Google button appears in production.

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
2. Copy the client ID. Its reversed form (`com.googleusercontent.apps.<the part before .apps>`) is the URL scheme; `apps/compass/app.config.ts` adds it to the build from `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID`, so nothing is entered by hand. The client can be created now; its ID goes into EAS only when Sign in with Apple ships (step 6).

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
   - `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID`: **not yet.** Leave it unset in both environments until Sign in with Apple ships in the same build (ADR 0033, decision 58); then add the iOS client ID.
2. Build Compass again (`eas build --platform all --profile production`, "Compass releases" below). The values are read at build time, and the Google SDK is a native module, so an over-the-air update is not enough.

Without `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` Compass shows no Google button; without the iOS client ID it shows none on iOS, which is how iOS ships until Sign in with Apple.

### 7. Verify

1. Atlas: sign in with Google using a Google account that has no XOS account. You land on "Create your organization"; the new person has the Google account's name.
2. Gateway: sign in with Google using another new Google account. You are asked to accept the Worker Terms, then land on Home.
3. Sign in with Google using the email of an existing XOS account. You land in that account (same organizations), not a new one.
4. Compass on Android: Continue with Google, pick the account, and Compass loads your work. On iOS the button is absent until Sign in with Apple ships; then repeat this on iOS.
5. Cancel on Google's account picker: the sign-in page says you left before it finished.

Rollback: turn "Enable Sign in with Google" off. The buttons disappear within five minutes (Atlas and Gateway cache the provider list); accounts keep their google identity and can still sign in by email.

## Feedback triage and sandboxes (OWNER)

- **Platform staff.** People who triage product feedback at `/support/feedback` in Atlas are `private.is_platform_staff()` (ADR 0052). Once A90's operator console lands, name them in its roster. Until then, add a row with the service role: `insert into private.platform_staff (person_id, reason) select p.id, 'Triages feedback' from app.people p join auth.users u on u.id = p.user_id where u.email = '<their email>';`. Revoke with `update private.platform_staff set revoked_at = now() where person_id = '<person id>';`.
- **Sandboxes.** `xos_purge_expired_sandboxes` (pg_cron, hourly at :37) purges sandboxes 14 days after they open. `select org_id, expires_at, purge_error from app.sandbox_orgs where purge_error is not null;` lists any it could not purge, with the reason. Storage objects of purged sandboxes wait in `private.sandbox_leftover_objects` for the Storage API sweep.

## Monitoring and alerting

| Signal        | Where                                                                                                                                                            | Alert                                                                                                                                                         |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Errors        | Sentry projects `xos-atlas` and `xos-gateway`, plus the Edge Functions' DSN; scrubbed of personal data (`infra/observability`)                                   | Create one alert rule per project: a new issue, or more than 10 events in 5 minutes, emails on-call                                                           |
| Logs          | Vercel runtime logs; Supabase logs (API, Postgres, Auth, Edge Functions). One JSON line per event, with `request_id`                                             | Search by `x-request-id` from a user report. Log drains go to Better Stack (ADR 0033, decision 45): **OWNER** creates the account and a source for each drain |
| Uptime        | `synthetics.yml` every 5 minutes from `us-east`: sign-in, Gateway, API, Realtime, sync, notifications; Better Stack every minute from five regions (decision 45) | A failed required check posts to `XOS_ALERT_WEBHOOK_URL` and turns the status page red                                                                        |
| Status page   | `https://status.ghxstship.tech` (decision 72): GitHub Pages from `gh-pages`, history on `status-data`, incidents in `infra/status/incidents.json`                | Public; updated every synthetics run                                                                                                                          |
| Deploy health | The release gate's error rate and p95 per rollout stage                                                                                                          | Rolls back on its thresholds (`progressive-delivery.md`)                                                                                                      |
| Database      | Supabase reports (CPU, connections, disk), advisors, and the weekly restore drill                                                                                | Supabase usage emails at 80 percent of plan quotas                                                                                                            |
| Backups       | Daily backups listed in Dashboard, Backups; `backup-weekly.yml` run status                                                                                       | A failed scheduled run emails whoever last changed the workflow's schedule or re-enabled it, not the admins (`backup-and-restore.md`, step 4)                 |

One-minute checks from five regions (Section 5.1) run on Better Stack (ADR 0033, decision 45; `infra/ci/README.md`, Frequency and regions). **OWNER** creates the account. Its monitors cover the components `infra/synthetics` checks, sign in only as the synthetic account and alert on-call; `synthetics.yml` keeps feeding the status page. Vercel and Supabase each drain their logs to a Better Stack source, which is on the Subprocessor List.

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

#### Over-the-air updates (EAS Update)

Each build profile takes updates from the channel of its name (`development`, `preview`, `production`, `tenant-<slug>`; ADR 0049 item 5). The runtime version is the native fingerprint, so an update only reaches binaries built from the same native code: JavaScript and assets only. Anything that changes native code (a new module, a config plugin, `app.json` native fields) needs a new store build. Stage every production update:

```sh
cd apps/compass
npx eas update --channel production --rollout-percentage 10 --message "<what changed>"
npx eas update:edit --rollout-percentage 50    # then 100, watching Sentry between steps
```

Local and Maestro builds never fetch updates; set `XOS_UPDATES=1` to try one on a local build.

### Compass tenant builds (Enterprise)

An org on a plan with `branded_compass_build` gets its own app (Section 12 Mobile, ADR 0049 item 6): its name, bundle identifier, icon, splash and store listing. The engineering side is one command; the accounts are the tenant's.

1. **Generate the tenant's profiles** (from `apps/compass`, values from the org's brand in Atlas):

   ```sh
   pnpm tenant:profile --slug <slug> --org <org slug> --name "<app name>" --bundle-id <reverse.domain.app> \
     --accent "<the org's accent, #RRGGBB>" --hosts atlas:<atlas host>,gateway:<gateway host>
   pnpm tenant:check
   ```

   It writes `tenants/<slug>.json`, `tenants/<slug>/store.config.json` and the `tenant-<slug>` build and submit profiles in `eas.json`.

2. **OWNER (with the tenant):** put the tenant's 1024 x 1024 icon (PNG, no transparency) at `tenants/<slug>/icon.png` and its splash at `tenants/<slug>/splash.png`; create the tenant's EAS project (`npx eas project:init` with the tenant's slug) and put its id in `tenants/<slug>.json` `easProjectId`; register `<bundle id>`, `<bundle id>.clock-activity` and the App Group `group.<bundle id>` in the tenant's Apple Developer account; fill `submit.tenant-<slug>` in `eas.json` and the listing; set the same EAS environment variables as production (step 3 above). A tenant build stops while its EAS project, icon, splash or listing is missing.
3. **Build and submit** (TestFlight and the Play internal track only, as for the platform app):

   ```sh
   node --experimental-strip-types scripts/store-preflight.ts ios tenant-<slug>
   npx eas build --profile tenant-<slug> --platform all --auto-submit
   ```

### Wallet passes (OWNER)

Compass adds a person's own badge and accepted shifts to Apple Wallet and Google Wallet through the `wallet-pass` Edge Function (ADR 0049 item 9). Until these secrets are set the function answers 503 and Compass explains that passes are not set up yet:

```sh
npx supabase secrets set --project-ref <project-ref> \
  APPLE_PASS_TYPE_ID=pass.<reverse domain> APPLE_TEAM_ID=<10 characters> \
  APPLE_PASS_CERT_PEM="$(cat pass.pem)" APPLE_PASS_KEY_PEM="$(cat pass-key.pem)" APPLE_WWDR_CERT_PEM="$(cat wwdr.pem)"
npx supabase secrets set --project-ref <project-ref> \
  GOOGLE_WALLET_ISSUER_ID=<issuer id> GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL=<name>@<project>.iam.gserviceaccount.com \
  GOOGLE_WALLET_PRIVATE_KEY_PEM="$(cat wallet-key.pem)"
npx supabase functions deploy wallet-pass --project-ref <project-ref>
```

- **Apple:** in Certificates, Identifiers and Profiles, register a Pass Type ID and create its certificate; export it from Keychain Access as a .p12 and convert it: `openssl pkcs12 -in pass.p12 -clcerts -nokeys -out pass.pem` and `openssl pkcs12 -in pass.p12 -nocerts -nodes | openssl pkcs8 -topk8 -nocrypt -out pass-key.pem`. Download Apple's WWDR intermediate (G4) and convert it to PEM. Delete the local files afterwards.
- **Google:** in the Google Pay and Wallet Console, create the issuer; in Google Cloud, create a service account with a JSON key, add its email as a user of the issuer, and take the key's `private_key` as the PEM.

### OWNER stop: public store submission

Submitting to the public App Store (App Review for release) or promoting to the Play production track (or closed and open tracks that reach the public) is a Section 19.8 stop condition. The listing, screenshots, privacy labels (App Privacy and the Play Data safety form), age rating and review notes are ready in `apps/compass/store/`; the release owner sets up the review accounts (`apps/compass/store/review-notes.md`), checks the open questions in `apps/compass/store/README.md` and `docs/release-checklist.md` (Compass store release), then stops and asks the owner. Only the owner presses Submit for Review or promotes to production. `store.config.json` keeps `automaticRelease` false, so even an approved version waits for the owner to release it.
