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

### Compass (EAS environment `production`; `preview` holds the staging values)

| Variable                        | Value                                                                                         | Visibility |
| ------------------------------- | --------------------------------------------------------------------------------------------- | ---------- |
| `EXPO_PUBLIC_SUPABASE_URL`      | The production Supabase API URL                                                               | Plain text |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | The production anon key (public)                                                              | Plain text |
| `EXPO_PUBLIC_ATLAS_URL`         | `https://<atlas domain>`                                                                      | Plain text |
| `EXPO_PUBLIC_GATEWAY_URL`       | `https://<gateway domain>`                                                                    | Plain text |
| `XOS_UNIVERSAL_LINK_HOSTS`      | `atlas:<atlas domain>,gateway:<gateway domain>`                                               | Plain text |
| `XOS_APPLE_TEAM_ID`             | The Apple team id (signs the widget extension in local device builds)                         | Plain text |
| `GOOGLE_SERVICES_JSON`          | File variable: the Firebase `google-services.json` for `pro.ghxstship.compass` (Android push) | Secret     |

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
