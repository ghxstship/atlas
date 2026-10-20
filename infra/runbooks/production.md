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

The Vercel project `atlas` exists. **OWNER** creates `gateway` and `docs` (no cost on the current plan) and chooses the production domains; buying a domain is a stop point.

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

Set any secret new in this release with `supabase secrets set --project-ref <production-ref> NAME=...` from the owner's secret store. Confirm the worker schedules (`webhook-dispatch`, `notification-dispatch`, `upload-scan`, `report-run`, each every minute) still exist: `select jobname, schedule from cron.job order by 1;`.

### 3. Apps

1. Vercel builds `atlas`, `gateway` and `docs` for the tagged commit as preview deployments against staging. Let Atlas and Gateway run there for 30 minutes with the synthetic checks green.
2. Promote to production. With Rolling Releases, the stages are 5, 25 and 100 percent, and the release gate (`progressive-delivery.md`) decides each step. Without them, promote and watch the gate's numbers for 30 minutes.
3. `docs` promotes directly; it is static.

### 4. Packages

Pushing the tag starts `publish-packages.yml` (`infra/ci/README.md`, section 5). It waits for the owner's approval in the `npm` and `pypi` environments. **OWNER** confirms the `@xos` npm scope and the `xos-sdk` PyPI name belong to the owner's accounts before the first publish; publishing under a new organization name is a stop point.

### 5. Compass

See Compass releases below. Compass ships on its own cadence; a web release never waits for store review.

### 6. Close

1. Smoke test as a real user: sign in to Atlas, open a project, open Gateway as an external party, call `GET /api/v1/openapi.json` and `xos auth status`.
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
| `ATLAS_SITE_URL`              | `https://<atlas domain>`                                          |
| `GATEWAY_SITE_URL`            | `https://<gateway domain>`                                        |
| `NEXT_PUBLIC_SENTRY_DSN`      | DSN of the Sentry project `xos-atlas` (public)                    |
| `XOS_TRACES_SAMPLE_RATE`      | `0.05` (`1` on Preview)                                           |
| `XOS_LOG_LEVEL`               | `info` (`debug` on Preview)                                       |
| `COMPASS_APPLE_TEAM_IDS`      | The Apple team id, once the developer account exists              |
| `COMPASS_ANDROID_CERT_SHA256` | The Play app signing certificate fingerprint, once the app exists |

### Gateway (Vercel project `gateway`)

| Variable                      | Production value                                                |
| ----------------------------- | --------------------------------------------------------------- |
| `SUPABASE_URL`                | As Atlas                                                        |
| `SUPABASE_ANON_KEY`           | As Atlas                                                        |
| `GATEWAY_SITE_URL`            | `https://<gateway domain>`                                      |
| `GATEWAY_PLATFORM_HOSTS`      | The platform Gateway hosts; every other host is a custom domain |
| `NEXT_PUBLIC_SENTRY_DSN`      | DSN of the Sentry project `xos-gateway` (public)                |
| `XOS_TRACES_SAMPLE_RATE`      | `0.05`                                                          |
| `XOS_LOG_LEVEL`               | `info`                                                          |
| `COMPASS_APPLE_TEAM_IDS`      | As Atlas                                                        |
| `COMPASS_ANDROID_CERT_SHA256` | As Atlas                                                        |

### Docs (Vercel project `docs`)

None. The site is built from the repository and the OpenAPI document.

### Edge Functions (production Supabase project secrets)

| Secret                                                    | Notes                                                                                               |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `XOS_API_JWT_SIGNING_KEY`                                 | The project's JWT secret, for `api-token`                                                           |
| `XOS_APP_URL`, `XOS_GATEWAY_URL`, `XOS_POSTAL_ADDRESS`    | Links and the postal address in email (CAN-SPAM)                                                    |
| `XOS_EMAIL_TRANSPORT`, `XOS_EMAIL_FROM`, `RESEND_API_KEY` | `resend`; the verified sending address; the Resend key                                              |
| `XOS_EMAIL_ALLOWLIST`, `XOS_EMAIL_DELIVER_TO_ANY`         | `XOS_EMAIL_DELIVER_TO_ANY=true` only in production, after **OWNER** approves real-recipient email   |
| `XOS_INBOUND_SECRET`, `XOS_INBOUND_DOMAIN`                | Reply by email                                                                                      |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`              | Live Stripe keys, once the owner opens billing                                                      |
| `XOS_CLAMAV_HOST`, `XOS_CLAMAV_PORT`                      | The private address and port of clamd ("Upload scanning (ClamAV)" below); the port defaults to 3310 |
| `SENTRY_DSN`, `XOS_ENVIRONMENT`, `XOS_LOG_LEVEL`          | The Edge Functions' Sentry DSN; `production`; `info`                                                |

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided to functions by Supabase. The worker schedules read the service role key from Vault (`xos_worker_key`).

### Compass (EAS environment `production`)

| Variable                        | Value                                           |
| ------------------------------- | ----------------------------------------------- |
| `EXPO_PUBLIC_SUPABASE_URL`      | The production Supabase API URL                 |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | The production anon key (public)                |
| `EXPO_PUBLIC_ATLAS_URL`         | `https://<atlas domain>`                        |
| `EXPO_PUBLIC_GATEWAY_URL`       | `https://<gateway domain>`                      |
| `XOS_UNIVERSAL_LINK_HOSTS`      | `atlas:<atlas domain>,gateway:<gateway domain>` |

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
4. Run `pnpm verify`. The translation check runs inside it.
5. Commit the catalogs, help articles, guides, `packages/i18n/translation/memory/es-US.json` and `docs/i18n/`, with a `Part of RRR-118` trailer.

Later runs: `pnpm --filter @xos/i18n translate` re-translates only strings whose en-US changed since the last run; the translation memory answers everything else, so an unchanged run calls nothing.

### 6. CI with Workload Identity Federation (optional)

The manual workflow `translate.yml` (`infra/ci/README.md`, section 7) runs the same commands in GitHub Actions and uploads the result as a patch. It needs no key:

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

### Prerequisites (OWNER)

1. An Apple Developer Program membership and an App Store Connect app record for `pro.ghxstship.compass`, with the App Group `group.pro.ghxstship.compass` and the Live Activity capability.
2. A Google Play Console developer account and an app for `pro.ghxstship.compass`, with Play App Signing on.
3. An Expo account for EAS Build and Submit, with `EXPO_TOKEN` stored as a secret if builds run in CI. EAS's free tier covers a few builds a month; more is a paid plan and a stop point.
4. App Store Connect API key and a Google Play service account for submission, stored in EAS (never in the repository).

### Build profiles

Add `apps/compass/eas.json` once the accounts exist:

```json
{
  "cli": { "version": ">= 25.0.0", "appVersionSource": "remote" },
  "build": {
    "production": {
      "environment": "production",
      "autoIncrement": true,
      "ios": { "resourceClass": "default" },
      "android": { "buildType": "app-bundle" }
    }
  },
  "submit": {
    "production": {
      "ios": { "ascAppId": "<App Store Connect app id>" },
      "android": { "track": "internal", "releaseStatus": "draft" }
    }
  }
}
```

### TestFlight (iOS)

1. From the tagged commit: `cd apps/compass && eas build --platform ios --profile production`.
2. `eas submit --platform ios --profile production --latest` uploads the build to App Store Connect.
3. In App Store Connect, TestFlight: answer export compliance, add the build to the internal testing group (up to 100 team members; no review needed).
4. Testers install through the TestFlight app. Run the Maestro field flows on a tester device, including airplane mode and queue drain.
5. External TestFlight groups need Beta App Review. Adding one is fine; it is not a public release.

### Play internal testing (Android)

1. `eas build --platform android --profile production` (an `.aab`).
2. `eas submit --platform android --profile production --latest` uploads to the internal testing track as a draft.
3. In Play Console, Testing, Internal testing: add the tester list, review the release and roll it out to internal testers (up to 100; no review).
4. Testers join through the opt-in link and install from Play.

### OWNER stop: public store submission

Submitting to the public App Store (App Review for release) or promoting to the Play production track (or closed and open tracks that reach the public) is a Section 19.8 stop condition. The release owner prepares the listing, screenshots, privacy labels (App Privacy and the Play Data safety form, from `legal/`), age rating and review notes with a demo account, then stops and asks the owner. Only the owner presses Submit for Review or promotes to production.
