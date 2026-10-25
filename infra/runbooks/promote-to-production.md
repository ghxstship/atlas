# Promote `xos-atlas-staging` to production

Owner decision 1 (ADR 0033, amended 2026-10-19): the hosted Supabase project `xos-atlas-staging` (ref
`fquuqnzlpobaawucczgq`) becomes production on Supabase Pro. It holds every migration and the demo seed, so the
demo data is removed before real users arrive, its settings move to production values, and staging moves to a
Supabase branch.

Everything below was prepared and proven on a local stack only (RRR-109, agent A64). Nothing here has run
against the hosted project. Each step that changes the hosted project is marked **OWNER CONFIRMS**: the
orchestrator runs it only after the owner confirms that exact step in writing, and records the date, who ran it
and the log file in the release notes.

Values are never pasted into tickets, logs or this file. Where a step needs a secret, it names the secret only.

## Order

| Step | What                                                       | Reversible?                                    | Confirm |
| ---- | ---------------------------------------------------------- | ---------------------------------------------- | ------- |
| 1    | Pro plan, point-in-time recovery, a fresh logical backup   | Yes                                            | OWNER   |
| 2    | Freeze: no one uses the hosted project during steps 3 to 4 | Yes                                            | Owner   |
| 3    | Dry run and rehearsal of the demo removal                  | Nothing changes                                | No      |
| 4    | The removal run                                            | Only by point-in-time recovery                 | OWNER   |
| 5    | Auth Site URL and redirect URLs                            | Yes                                            | OWNER   |
| 6    | Email: SMTP through Resend and the email templates         | Yes                                            | OWNER   |
| 7    | Password security, leaked-password protection              | Yes                                            | OWNER   |
| 8    | MFA and the rest of the auth settings                      | Yes                                            | OWNER   |
| 9    | Edge Function secrets                                      | Yes                                            | OWNER   |
| 10   | Vault secrets                                              | Yes                                            | OWNER   |
| 11   | Database network restrictions: stay off for now            | Yes                                            | OWNER   |
| 12   | Rotate the JWT secret and the anon and service keys        | No: old keys and sessions stop working at once | OWNER   |
| 13   | Vercel environment variables per app                       | Yes                                            | OWNER   |
| 14   | Staging branch, and `STAGING_DB_URL` re-pointed at it      | Yes                                            | OWNER   |
| 15   | Post-promotion checks                                      | Nothing changes                                | No      |

Step 12 comes after the removal so that the demo period's keys die with the demo data, and before step 13 so
Vercel receives the new keys once. Step 14 can run any time after step 4.

## Prerequisites

- The repository at the commit that carries migration `1270_tenant_purge.sql`, and that migration applied to the
  hosted project (`supabase db push`, as in `production.md`, "1. Migrations"). The removal script refuses to run
  without `private.begin_tenant_purge`.
- `psql` 17 on PATH, or Docker (the wrapper then uses the `postgres:17` image), and Node 22 or later.
- Either of two ways to reach the hosted project:
  - **Linked (preferred, no secrets in the shell):** the Supabase CLI logged in (`supabase login`) and the
    repository linked (`supabase link --project-ref fquuqnzlpobaawucczgq`). `remove-demo-data.sh --linked` runs
    the same SQL through `supabase db query --linked` (the Management API) and deletes storage objects through
    `supabase storage rm --linked`. It needs neither the database password nor the service role key.
    `src/plain-sql.ts` translates the psql script for one mode and refuses anything it cannot translate exactly;
    the run prints one JSON report per step and keeps it in the `--log` directory.
  - **psql:** from the owner's secret store, exported in the shell only for the commands that need them:
  - `DATABASE_URL`: the hosted project's direct connection string (Settings, Database), as the `postgres` role.
  - `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`: the hosted API URL and the current service role key, used
    only to delete demo storage objects in step 4.

## 1. Backup and point-in-time recovery (OWNER CONFIRMS)

1. Upgrade the organization to Pro, then turn on the PITR add-on (Project Settings, Add-ons, Point in Time
   Recovery). PITR is a paid add-on: the owner approved it in decision 2.
2. Take a logical backup that does not depend on Supabase:
   - with the owner's public key committed: `XOS_BACKUP_DB_URL="$DATABASE_URL" infra/ci/backup-weekly.sh pre-promotion <dir>`;
   - otherwise `supabase db dump --linked -f schema.sql` (or `--db-url "$DATABASE_URL"`), then the same with `--data-only --use-copy -f data.sql` and `--role-only -f roles.sql`, kept encrypted on the owner's machine.
3. Record the key-table fingerprints: run `infra/drills/key-tables.sql` in the SQL editor and keep the output.
4. Record the full row counts: `supabase db query --linked --agent no -o json -f infra/production/table-counts.sql`
   (one row per table), or `psql "$DATABASE_URL" -X -q -tA -f infra/production/table-counts.sql > before.txt`.

Verify: Database, Backups shows PITR enabled with an earliest restore point, and the daily backups list today.
The dump files are not empty.

Rollback: turning PITR off ends its billing. The backups are files and change nothing.

## 2. Freeze

Tell everyone using staging that it stops for the duration of steps 3 and 4. Pause the GitHub Actions workflows
that write to the hosted project (`synthetics.yml`, and `backup-weekly.yml` if it runs in the window). Vercel
preview deployments keep pointing at the project until step 13; nobody should use them during the run.

## 3. Dry run and rehearsal

```sh
infra/production/remove-demo-data.sh dry-run --linked --log <dir>     # or DATABASE_URL=... without --linked
infra/production/remove-demo-data.sh rehearse --linked --log <dir>
```

The dry run changes nothing. The rehearsal deletes inside a transaction, runs every verification and rolls
back, so it holds row locks on the demo orgs' rows for a few seconds.

Review the dry-run report with the owner:

- **Orgs to remove**: the 12 seeded orgs (`demo-productions`, `demo-staging-supply`, `demo-partner` and the nine
  external-role orgs of seed 1080) plus every org a demo person created or that has only demo members (the
  seed's vendor accounts, load-test tenants, orgs made during journeys on staging).
- **Sign-ins to remove**: every sign-in with a seed id, an `example.com` address or a `load.example.test` address.
- **What stays**: every other org and the email domains of the remaining sign-ins. Anything here that is not
  meant for production (the synthetic-check account, test accounts on other domains) is the owner's call: delete
  it in the dashboard after step 4, or keep it.
- **Rows reached in orgs that are not being removed** must be empty. If it is not, the execute run refuses.
- **Storage objects** and **Vault secrets** the run removes.

## 4. The removal run (OWNER CONFIRMS)

The owner confirms with the dry-run output in hand. Note the UTC time just before running; it is the
point-in-time recovery target if anything has to be undone.

```sh
infra/production/remove-demo-data.sh execute --linked --confirm fquuqnzlpobaawucczgq --log <dir>
# or, with psql:
DATABASE_URL=... SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
  infra/production/remove-demo-data.sh execute --confirm fquuqnzlpobaawucczgq --log <dir>
```

The linked execute runs a dry run first and stops if any row of another org is reached, deletes the listed
storage objects, runs the execute SQL, and finishes with a second dry run that must find nothing.

What it does, in order:

1. Lists the demo orgs' storage objects (names that start with a demo org or person id, or uploaded by a demo
   sign-in) and deletes them through the Storage API. SQL deletes of `storage.objects` are refused by Supabase.
2. In one transaction: derives the demo rows, refuses if the closure reaches canon or another org, marks the
   demo orgs with `private.begin_tenant_purge` (migration 1270), deletes children before parents, deletes the
   demo integration credentials from Vault, ends the mark, verifies, and commits only if every check passes.

Verify:

- The log ends with `Verification passed` and `Committed.`
- `psql "$DATABASE_URL" -X -q -tA -f infra/production/table-counts.sql > after.txt`, then compare with a
  database built from the same migrations and no seeds (`supabase db reset --no-seed` on a local stack at the
  same commit, then `table-counts.sql` into `noseed.txt`):
  `node --experimental-strip-types infra/production/src/cli.ts compare noseed.txt after.txt`.
  Only `runtime` lines may differ (cron run history, `supabase_migrations.seed_files`). A `DATA` line is a table
  that still holds rows a fresh build does not have: look at it before going on.
- A second dry run reports no orgs, no sign-ins and no rows to delete.

Rollback:

- A failed run changes nothing in the database: it is one transaction, and the wrapper stops before the SQL if
  the storage step fails.
- After a commit, the only way back is point-in-time recovery to the noted time (Database, Backups, Point in
  Time), which restores the whole project. Storage objects are files, not database rows: PITR does not bring them
  back. They are demo files; if the owner wants them kept, copy them before step 4
  (`supabase storage cp -r ss:///<bucket>/<prefix> <dir> --experimental`).

### What is deleted and what stays

Deleted: every row the closure reaches, in every schema it walks (`app`, `private`, `auth`, `xpms`, the API
schemas and migration history), plus the storage objects and Vault credentials above. In the local proof that
was 347 tables (342 in `app`, 2 in `auth`, 3 in `private`), including the append-only history of those orgs:
audit events, state transitions, domain and activity events, ledgers. No append-only history of a removed org
is kept, because its rows reference the org and the org itself goes.

Stays, unchanged: canon (`xpms`, 94 tables), the plan, capability, role, settings and invariant registries,
reference data, storage buckets, cron jobs, the migration-created Vault keys, and `supabase_migrations` history.
`supabase_migrations.seed_files` (the CLI's record that seeds were loaded) stays on purpose: with it in place,
an accidental `supabase db push --include-seed` against production skips the seed files.

### How the guards are handled

Several guards refuse hard deletes with no exception: append-only ledgers, the audit ledger (invariant 23), the
sole-Owner rule (invariant 4), posted journal lines, locked baselines and payroll lines, issued wholesale
statements, retained Canceled records and custom roles. Migration 1270 adds the tenant purge:
`private.begin_tenant_purge(org ids)` marks the current transaction as purging exactly those orgs, and each of
those guards then lets a **delete** of a marked org's row through; updates stay refused and other orgs keep
every rule. The audit trigger writes no audit row for a marked org. The mark lives in
`private.tenant_purge_scope`, keyed by transaction id, so it ends with the transaction; only the service role
and the database owner may set it, and an org under an active legal hold is refused. No trigger is disabled, no
foreign key is switched off, and `session_replication_role` is never touched. pgTAP
`1270_tenant_purge.test.sql` covers all of this. The same seam serves the Section 14.7 day-90 org deletion
when it is built.

### Local proof (2026-10-19, stack `xos4-a64`, commit with migration 1270)

Set-up on a fresh `supabase db reset` (all migrations and the 26 seed files), plus, to exercise the paths a
hosted staging project may have and the seeds do not:

- the load-test fixture in both shapes (two `load-tenant-*` orgs with 3 users each, and 3 load users joined to
  `demo-productions`);
- three storage objects: a logo under the demo org's prefix in `org-brand`, an avatar under the demo Owner's
  prefix in `profile-media`, and `org-brand/keep-me/not-demo.png`, which must stay;
- one Vault credential for a demo integration connection, stored the way `app.store_integration_credential`
  stores it.

| Check                                      | Result                                                                                                                                           |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Dry run                                    | 19 orgs (12 seeded, 5 seed vendor accounts, 2 load tenants), 30 sign-ins (21 seed ids, 9 load users), 2 storage objects, 1 Vault secret          |
| What stays / rows in other orgs            | Nothing stays; no row of another org reached                                                                                                     |
| Rehearsal                                  | Verification passed, rolled back                                                                                                                 |
| Execute without `--confirm`                | Refused before connecting                                                                                                                        |
| Execute                                    | 2 storage objects deleted through the Storage API; 2,655 rows deleted from 347 tables; 1 Vault secret deleted; verification passed; committed    |
| Seed orgs, people, sign-ins left           | 0 organizations, 0 people, 0 `auth.users`, 0 `auth.identities` (were 19, 30, 30, 30)                                                             |
| Canon and registries                       | `xpms` 94 tables, 41,749 rows before and after; `app.plans` 5, `app.capabilities` 257, `app.roles` 7, `app.role_capabilities` 986, unchanged     |
| Untouched tables                           | 375 of 725 tables identical before and after; every table lost exactly its marked rows                                                           |
| Storage                                    | `org-brand/keep-me/not-demo.png` kept; 8 buckets kept                                                                                            |
| Vault                                      | 5 secrets before, 4 after: the four migration-created keys kept                                                                                  |
| `supabase test db` on the cleaned database | 6,749 of 6,752 assertions pass in 206 files. The 3 failures need demo data, as expected (below)                                                  |
| Compare with a no-seed build (724 tables)  | Every data table matches. Differences: `cron.job_run_details` (runtime), `supabase_migrations.seed_files` (runtime), and the kept fixture object |

The three pgTAP assertions that depend on the demo seed and fail on a database without it:

- `0931_brand_lookup_org_id` test 1: the slug lookup returns the demo org's id to anon;
- `0934_organization_profile_org_id` test 1: the demo org's public profile returns its org id to anon;
- `1180_playbook_field_homes` test 10: `update app.shifts set scheduled_break_minutes = 2000` must raise a check
  violation, and with no shifts it updates nothing.

They run against seeded databases (local and CI) and are not run against production. The comparison's only
`DATA` lines were the deliberately kept fixture object and its `private.object_scans` row.

Largest deletions: `app.activity_events` 447, `app.domain_events` 447, `app.audit_events` 386,
`private.sync_scope_grants` 86, `app.asset_state_transitions` 60, `app.notification_deliveries` 60,
`app.record_state_transitions` 41, `app.notifications` 30, `app.people` 30, `auth.users` 30,
`auth.identities` 30. The full list is in the appendix.

## 5. Auth Site URL and redirect URLs (OWNER CONFIRMS)

The owner confirmed the domain on 2026-10-20 (ADR 0033, decision 5, amended): `ghxstship.tech`, with Atlas at
`atlas.` and Gateway at `gateway.`. The orchestrator set these values that day, together with the Data API
schemas below.

Authentication, URL Configuration:

| Setting       | Value                                                                                                                                                                   |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Site URL      | `https://atlas.ghxstship.tech`                                                                                                                                          |
| Redirect URLs | `https://atlas.ghxstship.tech/auth/callback**`, `https://gateway.ghxstship.tech/auth/callback**`, `https://console.ghxstship.tech/auth/callback**`, `compass://sign-in` |

The console's callback joined the list with ADR 0033, decision 79; the owner adds it (`production.md`, console.ghxstship.tech).

Keep the `**` at the end of each callback. Atlas and Gateway return to `/auth/callback` with a query string (`?next=...` for invitations and the claim step, `&provider=google` for Sign in with Google, ADR 0036), and Supabase Auth matches the whole address: an exact entry refuses it and sends the person to the Site URL instead. Checked on a local Supabase Auth (v2.197.0): `.../auth/callback**` accepts the callback with any query string and still refuses other paths and other hosts. Addresses on the Site URL's own host are always accepted.

- `**` lets a callback URL carry its query, such as the page to return to.
- When an org verifies a custom Gateway domain, add `https://<that domain>/auth/callback**`.
- Remove `localhost`, `127.0.0.1` and every Vercel preview URL: previews belong to the staging branch (step 14).

**Data API.** The hosted Data API's exposed schemas (Project Settings, Data API) must match `[api] schemas` in
`supabase/config.toml`: `app`, `xpms`, `api_public` and `api_external`. Until 2026-10-20 the hosted project
exposed only `public`, and Gateway's brand lookup failed with `PGRST106`. When a migration adds a schema to
`config.toml`, add it here in the same release.

Verify: request a password reset for a test account; the link opens
`https://atlas.ghxstship.tech/auth/callback`. `https://gateway.ghxstship.tech/` renders the platform brand, not
an error. Rollback: put back the values recorded before the change.

## 6. Email: SMTP through Resend and the templates (OWNER CONFIRMS)

1. In Resend, verify the sending subdomain `mail.ghxstship.tech` (decision 6) with the SPF, DKIM and DMARC
   records in `production.md`, "Domains".
2. Authentication, Emails, SMTP Settings: enable custom SMTP, host `smtp.resend.com`, port 465, user `resend`,
   password the Resend API key (secret), sender `no-reply@mail.ghxstship.tech`, sender name `XOS`.
3. Templates (confirm signup, invite, magic link, change email, reset password, reauthentication): the product's
   own email goes through the Edge Functions; the auth templates keep Supabase's defaults with the product name
   and links to `https://atlas.ghxstship.tech`. Check that no template still names staging or the demo tenant.
4. Set the email rate limit (Authentication, Rate Limits) to about 100 emails an hour, sent through Resend (ADR 0033,
   decision 43). Watch the Auth logs for sign-up confirmations, magic links and password resets after launch, and
   raise it before real volume reaches it. The repository's local value (`email_sent = 2` an hour in
   `supabase/config.toml`) is for tests only.
5. DMARC starts monitoring-only, `p=none`, with reports to the owner's DMARC report mailbox, and moves to
   `p=quarantine` after two to four clean weeks (ADR 0033, decision 46; `production.md`, Email from
   mail.ghxstship.tech, steps 2 and 5).

Verify: a test sign-up receives its confirmation from `mail.ghxstship.tech`, and the message passes SPF, DKIM and
DMARC.
Rollback: disable custom SMTP to fall back to Supabase's built-in sender (rate-limited, not for production).

## 7. Password security and leaked-password protection (OWNER CONFIRMS)

As in `hosted-security-settings.md` (A22-010): leaked-password protection on (Have I Been Pwned, decision 3),
minimum length 12, letters and digits, secure password change on.

Verify: setting the password `Password1234` on a test account is refused with `weak_password`.
Rollback: switch the setting off.

## 8. MFA and the rest of the auth settings (OWNER CONFIRMS)

Match `supabase/config.toml`, except the local URLs:

| Setting                                      | Value                                                                                                                                                                |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TOTP                                         | Enroll and verify on                                                                                                                                                 |
| WebAuthn and passkeys                        | Enroll and verify on; relying party id `ghxstship.tech`; origins `https://atlas.ghxstship.tech` and `https://gateway.ghxstship.tech` (`hosted-security-settings.md`) |
| Phone MFA                                    | Off                                                                                                                                                                  |
| Maximum enrolled factors                     | 10                                                                                                                                                                   |
| Custom access token hook                     | On, `pg-functions://postgres/private/custom_access_token_hook`                                                                                                       |
| JWT expiry, refresh token rotation, reuse    | 3600 seconds, on, 10 seconds                                                                                                                                         |
| Sign-ups; anonymous sign-ins; manual linking | On; off; off                                                                                                                                                         |
| Sign in with Google                          | As in `production.md`, "Sign in with Google (OWNER)", step 5, once the owner has created the Google clients                                                          |
| Double confirm email changes                 | On                                                                                                                                                                   |
| Confirm email (`enable_confirmations`)       | On: a new email sign-up confirms its address before it can sign in (ADR 0033, decision 42). It needs the custom SMTP of step 6 first                                 |

`enable_confirmations` stays off locally so tests can sign in at once. Production turns it on (ADR 0033, decision
42). Check: a new email sign-up cannot sign in until it opens the confirmation link from `mail.ghxstship.tech`.

Verify: enroll TOTP on a test account and sign in with it; the access token carries the hook's claims (Atlas
loads the org switcher). Rollback: restore the recorded values.

## 9. Edge Function secrets (OWNER CONFIRMS)

Names only; values come from the owner's secret store. `supabase secrets list --project-ref fquuqnzlpobaawucczgq`
prints names and digests, never values.

`XOS_API_JWT_SIGNING_KEY` (the project's JWT secret, so it changes again in step 12), `XOS_APP_URL`,
`XOS_GATEWAY_URL`, `XOS_POSTAL_ADDRESS`, `XOS_EMAIL_TRANSPORT`, `XOS_EMAIL_FROM`, `RESEND_API_KEY`,
`XOS_EMAIL_ALLOWLIST`, `XOS_EMAIL_DELIVER_TO_ANY` (true only at cutover, once `mail.ghxstship.tech` passes its
SPF, DKIM and DMARC checks and `XOS_POSTAL_ADDRESS` holds the postal address; ADR 0033, decision 41),
`RESEND_INBOUND_WEBHOOK_SECRET`, `RESEND_RECEIVING_API_KEY` and `XOS_INBOUND_DOMAIN` (`inbound.ghxstship.tech`,
decision 60; `production.md`, Email), `STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET` (test keys until Atlas Checkout ships and billing opens with live keys, decision 59), `XOS_CLAMAV_HOST`, `XOS_CLAMAV_PORT`, `SENTRY_DSN`, `XOS_ENVIRONMENT` (`production`),
`XOS_LOG_LEVEL` (`info`). Unset `XOS_REPORT_MAILPIT_URL`, which only a local stack uses.

Verify: the list shows each name; `XOS_ENVIRONMENT` digest differs from staging's. Rollback: set the previous
value again.

## 10. Vault secrets (OWNER CONFIRMS)

`select name from vault.secrets order by 1;` (names only). Expected after step 4:

- created by migrations: `xos_medical_notes_key`, `xos_tax_form_key`, `xos_org_tax_identifier_key`,
  `xos_passport_number_key`, `xos_inbound_reply_secret`;
- set by the operator: `xos_worker_key`, the service role key the cron worker schedules use. It must be replaced
  in step 12.

The five keys were generated in this project and never left Vault, so the demo period did not expose them. After
step 4 no row they encrypt remains (the demo encounters, tax forms and entities are gone), so regenerating them
now would cost nothing, but the owner decided to keep them (ADR 0033, decision 49). No `xos_integration_*` secret
may remain: the removal deletes the demo connections' credentials.

## 11. Database network restrictions: off for now (OWNER CONFIRMS)

Database, Network Restrictions limits direct and pooler Postgres connections to listed CIDR ranges. The apps
and Edge Functions use the HTTPS API and are not affected. What is affected: the operator's own `psql` and
`supabase db push`, and any GitHub Actions job that connects to Postgres (runner addresses change on every run).
The owner decided to leave them off for now (ADR 0033, decision 47): the weekly production backup is a CI job with
its own read-only login, and GitHub runners connect from changing addresses. Revisit when that job moves to a fixed
address. Once migration 1650 is on production, set that login up: `backup-and-restore.md`, Set up the production
backup login.

Verify: a connection from an unlisted address is refused; the API still works. Rollback: allow all again.

## 12. Rotate the JWT secret and the anon and service keys (OWNER CONFIRMS)

Approved for cutover (ADR 0033, decision 44). The owner still confirms the moment in writing, because of what it
does:

- every signed-in person in Atlas, Gateway, Compass and the console is signed out at once and signs in again;
- every token issued with the old keys stops working, including any API token from `api-token` and the worker
  schedules until step 1 below replaces `xos_worker_key`;
- it cannot be undone, only repeated.

Run it after step 4 and before step 13, at a quiet hour announced to anyone already using production.

Why: during the build the staging anon and service keys sat in Vercel preview settings, CI variables, local
`.env` files and agent sessions, and the demo sign-ins used a password published in the repository. The demo
accounts are gone after step 4; the keys must go too.

Settings, JWT Keys: generate a new legacy JWT secret. This issues a new anon key and a new service role key at
once, invalidates every existing session and stops the old keys working.

Do the following immediately after, in this order, with the new values:

1. Vault: `select vault.update_secret((select id from vault.secrets where name = 'xos_worker_key'), '<new service key>');`
   in the SQL editor, or the cron workers stop.
2. Edge Function secret `XOS_API_JWT_SIGNING_KEY` = the new JWT secret.
3. Vercel (step 13): `SUPABASE_ANON_KEY` in `atlas`, `gateway` and `console`, Production environment, then redeploy
   all three. Their Preview environments keep the old key and stop signing in until step 14 points them at the
   staging branch.
4. EAS `production`: `EXPO_PUBLIC_SUPABASE_ANON_KEY`, picked up by the next Compass build.
5. The owner's secret store: the new service key replaces the old one; delete the old one.

Verify: Atlas and console sign-in work; `api-token` issues a token the API accepts; within a minute
`cron.job_run_details` shows the worker jobs succeeding. Rollback: none; a rotation cannot be undone, only repeated.

The new publishable and secret API keys (`sb_publishable_`, `sb_secret_`) are the longer-term replacement for
the legacy keys; moving to them is a separate change, because `api-token` signs with the project JWT secret.

## 13. Vercel environment variables per app (OWNER CONFIRMS)

Production environment only; the Preview environment moves to the staging branch in step 14. The full table is
in `production.md`, "Environment variables".

| App       | Production variables                                                                                                                                                                                                                           |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `atlas`   | `SUPABASE_URL`, `SUPABASE_ANON_KEY` (new), `ATLAS_SITE_URL`, `GATEWAY_SITE_URL`, `XOS_API_HOST`, `DOCS_SITE_URL`, `NEXT_PUBLIC_SENTRY_DSN`, `XOS_TRACES_SAMPLE_RATE`, `XOS_LOG_LEVEL`, `COMPASS_APPLE_TEAM_IDS`, `COMPASS_ANDROID_CERT_SHA256` |
| `gateway` | `SUPABASE_URL`, `SUPABASE_ANON_KEY` (new), `GATEWAY_SITE_URL`, `GATEWAY_PLATFORM_HOSTS`, `DOCS_SITE_URL`, `NEXT_PUBLIC_SENTRY_DSN`, `XOS_TRACES_SAMPLE_RATE`, `XOS_LOG_LEVEL`, `COMPASS_APPLE_TEAM_IDS`, `COMPASS_ANDROID_CERT_SHA256`         |
| `console` | `SUPABASE_URL`, `SUPABASE_ANON_KEY` (new), `CONSOLE_SITE_URL` (`https://console.ghxstship.tech`), `CONSOLE_PASSWORD_SIGN_IN` (`false`)                                                                                                         |
| `docs`    | None                                                                                                                                                                                                                                           |

`SUPABASE_URL` does not change (the project keeps its ref). Set on 2026-10-20: `ATLAS_SITE_URL`
(`https://atlas.ghxstship.tech`) and `GATEWAY_SITE_URL` (`https://gateway.ghxstship.tech`) in both projects, and
`GATEWAY_PLATFORM_HOSTS` (`gateway.ghxstship.tech,gateway-umber-omega.vercel.app`) in `gateway`. Still to set:
`XOS_API_HOST=api.ghxstship.tech` in `atlas`, and `DOCS_SITE_URL=https://docs.ghxstship.tech` in both, once
`api.` and `docs.` serve.

Verify: each production deployment's runtime logs show no auth errors; synthetic checks pass against production.
Rollback: Vercel Instant Rollback to the previous deployment, with the previous variables.

## 14. Staging on a Supabase branch, and `STAGING_DB_URL` (OWNER CONFIRMS)

The plan is in "Staging branch plan" below. When the staging branch exists:

- GitHub secret `STAGING_DB_URL` = the staging branch's Session pooler connection string, port 5432 (it feeds
  `backup-weekly.yml` and the load-test instructions). GitHub's hosted runners have no IPv6, and a direct host is IPv6
  without the IPv4 add-on. It must no longer point at this project.
- GitHub variables `XOS_STAGING_*` (synthetics) = the branch's API URL and anon key; the synthetic account is
  created on the branch.
- Vercel `atlas`, `gateway` and `console`, Preview environment: `SUPABASE_URL` and `SUPABASE_ANON_KEY` of the branch,
  and for `console` also `CONSOLE_SITE_URL=https://console-git-staging-ghxstship.vercel.app`, the address Vercel gives
  the `staging` git branch of the project (the console has no staging domain).

Verify: `backup-weekly` runs green against the branch; a preview deployment signs in as `owner@example.com` on
the branch. Rollback: point the secret and variables back.

## 15. Post-promotion checks

- A dry run against production reports nothing to remove. Repeat it before launch as a guard.
- `infra/drills/key-tables.sql`: identity and tenancy tables are empty, plan and capability fingerprints match the
  values recorded in step 1.
- Supabase advisors (`infra/security/supabase-advisors.sh`) report nothing new.
- Synthetic checks green against production and staging.
- The hosted Data API's exposed schemas still match `[api] schemas` in `supabase/config.toml` (step 5).
- The account security notice triggers (migration 2050, ADR 0064) exist on staging and production. They sit on
  Supabase Auth's tables, outside the `app` and `private` schemas (the weekly backup's `platform.sql` carries them,
  as it does 0206's `xos_create_person`). This query lists
  `xos_notify_security_change` on `auth.users`, `xos_notify_factor_change` on `auth.mfa_factors` and
  `xos_notify_passkey_change` on `auth.webauthn_credentials`; a missing one means a password, second factor or
  passkey change there tells nobody:
  `select tgrelid::regclass, tgname from pg_trigger where tgname like 'xos_notify_%';`
- `https://api.ghxstship.tech/` answers the JSON pointer, `https://api.ghxstship.tech/v1/openapi.json` the
  document, and `https://api.ghxstship.tech/auth/sign-in` a 404 problem with no `Set-Cookie`.

## Staging branch plan

Branching needs Pro, which decision 1 already buys. Branches are billed per hour of compute; a persistent
`staging` branch runs all month, so the owner confirms that cost first.

1. **GitHub stays disconnected.** The owner decided not to connect the Supabase GitHub integration (ADR 0033,
   decision 48). Migrations reach staging and production only through `supabase db push` from the tagged commit,
   staging first (`production.md`, Deploy order), so a push to `main` never migrates production.
2. **Create a persistent branch** named `staging`, from the dashboard or with
   `supabase --experimental branches create --persistent`. Persistent branches are not paused or deleted with
   pull requests. A new branch starts with no data.
3. **Seed the branch only.** In `supabase/config.toml` (a change the orchestrator makes once the branch exists):

   ```toml
   [remotes.staging]
   project_id = "<staging branch ref from: supabase --experimental branches list>"

   [remotes.staging.db.seed]
   enabled = true
   sql_paths = ["./seeds/*.sql"]

   [remotes.production]
   project_id = "fquuqnzlpobaawucczgq"

   [remotes.production.db.seed]
   enabled = false
   ```

   Seeding runs when a branch is created. To seed by hand, or to reseed: `supabase db push --db-url <branch
direct connection string> --include-seed`, on the branch only. `--include-seed` is never used against
   production; Supabase's documentation says the same.

4. **Branch settings.** Under `[remotes.staging.auth]`: `site_url` is `https://atlas-staging.ghxstship.tech` and
   `additional_redirect_urls` holds `https://atlas-staging.ghxstship.tech/auth/callback**`,
   `https://gateway-staging.ghxstship.tech/auth/callback**`, the console's preview callback
   `https://console-git-staging-ghxstship.vercel.app/auth/callback**` (step 14) and the preview URLs (decisions 7, 63
   and 79). Branch secrets are separate from production:
   `supabase secrets set --project-ref <branch ref> ...` with staging values (Resend with
   `XOS_EMAIL_ALLOWLIST`, Stripe test keys, `XOS_ENVIRONMENT=staging`).
5. **Vercel previews.** The Preview environment variables of `atlas`, `gateway` and `console` point at the
   persistent `staging` branch's values (ADR 0033, decision 63). No database is made per pull request, and the
   Supabase Vercel integration is not installed.
6. **CI.** `STAGING_DB_URL` and the `XOS_STAGING_*` variables point at the staging branch (step 14). The
   `database` job keeps using a local stack; nothing in CI connects to production.
7. **Verify.** The staging branch has the demo tenant (`owner@example.com` signs in); a dry run of
   `remove-demo-data.sh` against production reports nothing; one against the branch lists the demo orgs.

Supabase documentation used:

- Branching: https://supabase.com/docs/guides/deployment/branching
- Working with branches (seeding behavior): https://supabase.com/docs/guides/deployment/branching/working-with-branches
- Branch configuration and `[remotes]`: https://supabase.com/docs/guides/deployment/branching/configuration
- GitHub integration: https://supabase.com/docs/guides/deployment/branching/github-integration
- Hosting integrations (Vercel): https://supabase.com/docs/guides/deployment/branching/integrations
- Vercel environments for persistent branches: https://supabase.com/docs/guides/troubleshooting/vercel-integration-environment-variables-not-syncing-for-persistent-git-branches-b9191e
- Seeding and `--include-seed`: https://supabase.com/docs/guides/local-development/seeding-your-database and https://supabase.com/docs/guides/local-development/cli-workflows
- Backups and PITR: https://supabase.com/docs/guides/platform/backups
- Password security: https://supabase.com/docs/guides/auth/password-security
- Custom SMTP: https://supabase.com/docs/guides/auth/auth-smtp
- Network restrictions: https://supabase.com/docs/guides/platform/network-restrictions
- API keys and JWT signing keys: https://supabase.com/docs/guides/getting-started/api-keys and https://supabase.com/docs/guides/auth/signing-keys
- Production checklist: https://supabase.com/docs/guides/deployment/going-into-prod

## Files

| File                                        | Purpose                                                                |
| ------------------------------------------- | ---------------------------------------------------------------------- |
| `infra/production/remove-demo-data.sh`      | Wrapper: target, confirmation, storage step, logs                      |
| `infra/production/remove-demo-data.sql`     | The removal: markers, closure, report, delete, verification            |
| `infra/production/table-counts.sql`         | Row count of every table, for before, after and the no-seed comparison |
| `infra/production/src/cli.ts`               | `generate` and `check` the marker block, `delete-storage`, `compare`   |
| `supabase/migrations/1270_tenant_purge.sql` | The tenant purge mark and the guards that honor it                     |
| `supabase/tests/1270_tenant_purge.test.sql` | pgTAP for the tenant purge                                             |

When a seed file changes, run `pnpm --filter @xos/infra demo-markers` to regenerate the marker block; the infra
test suite fails until it matches.

## Appendix: per-table deletions in the local proof

| Table                                          | Rows before | Rows deleted |
| ---------------------------------------------- | ----------- | ------------ |
| `app.access_grid`                              | 9           | 9            |
| `app.access_scans`                             | 4           | 4            |
| `app.accommodation_assignments`                | 3           | 3            |
| `app.accommodation_blocks`                     | 1           | 1            |
| `app.account_membership_roles`                 | 9           | 9            |
| `app.account_memberships`                      | 9           | 9            |
| `app.accounting_period_state_transitions`      | 10          | 10           |
| `app.accounting_periods`                       | 5           | 5            |
| `app.activity_events`                          | 447         | 447          |
| `app.advance_packets`                          | 2           | 2            |
| `app.advance_recipient_tokens`                 | 1           | 1            |
| `app.advance_recipients`                       | 2           | 2            |
| `app.advance_sections`                         | 4           | 4            |
| `app.advance_submissions`                      | 2           | 2            |
| `app.agreement_state_transitions`              | 2           | 2            |
| `app.agreements`                               | 1           | 1            |
| `app.ai_requests`                              | 2           | 2            |
| `app.ai_settings`                              | 1           | 1            |
| `app.ai_suggestion_fields`                     | 4           | 4            |
| `app.ai_suggestion_state_transitions`          | 1           | 1            |
| `app.ai_suggestions`                           | 1           | 1            |
| `app.ai_usage`                                 | 2           | 2            |
| `app.application_answers`                      | 1           | 1            |
| `app.application_state_transitions`            | 5           | 5            |
| `app.applications`                             | 1           | 1            |
| `app.approval_decisions`                       | 1           | 1            |
| `app.approval_instances`                       | 1           | 1            |
| `app.approval_policies`                        | 1           | 1            |
| `app.approval_policy_state_transitions`        | 2           | 2            |
| `app.approval_state_transitions`               | 1           | 1            |
| `app.approval_steps`                           | 2           | 2            |
| `app.asset_classes`                            | 6           | 6            |
| `app.asset_custody`                            | 4           | 4            |
| `app.asset_damage`                             | 2           | 2            |
| `app.asset_identifiers`                        | 6           | 6            |
| `app.asset_lot_movements`                      | 2           | 2            |
| `app.asset_lots`                               | 2           | 2            |
| `app.asset_maintenance`                        | 4           | 4            |
| `app.asset_state_transitions`                  | 60          | 60           |
| `app.asset_units`                              | 18          | 18           |
| `app.attendance_counts`                        | 3           | 3            |
| `app.audit_events`                             | 386         | 386          |
| `app.availability_blocks`                      | 2           | 2            |
| `app.availability_calendars`                   | 1           | 1            |
| `app.beo_lines`                                | 3           | 3            |
| `app.beos`                                     | 1           | 1            |
| `app.budget_lines`                             | 18          | 18           |
| `app.budgets`                                  | 2           | 2            |
| `app.call_sheets`                              | 1           | 1            |
| `app.canon_extension_proposals`                | 1           | 1            |
| `app.canon_extension_state_transitions`        | 2           | 2            |
| `app.capability_documents`                     | 3           | 3            |
| `app.capability_statements`                    | 5           | 5            |
| `app.catalog_bindings`                         | 1           | 1            |
| `app.certification_holders`                    | 2           | 2            |
| `app.certifications`                           | 2           | 2            |
| `app.change_order_lines`                       | 2           | 2            |
| `app.change_order_state_transitions`           | 4           | 4            |
| `app.change_orders`                            | 2           | 2            |
| `app.chat_messages`                            | 3           | 3            |
| `app.comment_threads`                          | 2           | 2            |
| `app.comments`                                 | 2           | 2            |
| `app.contingency_draws`                        | 1           | 1            |
| `app.conversation_members`                     | 5           | 5            |
| `app.conversations`                            | 2           | 2            |
| `app.cost_centers`                             | 3           | 3            |
| `app.counterparties`                           | 12          | 12           |
| `app.credential_categories`                    | 5           | 5            |
| `app.credentials`                              | 6           | 6            |
| `app.crisis_alerts`                            | 1           | 1            |
| `app.cues`                                     | 5           | 5            |
| `app.custom_object_field_choices`              | 3           | 3            |
| `app.custom_object_fields`                     | 2           | 2            |
| `app.custom_object_records`                    | 2           | 2            |
| `app.custom_object_types`                      | 1           | 1            |
| `app.custom_object_values`                     | 2           | 2            |
| `app.day_sheets`                               | 1           | 1            |
| `app.dispatch_assignments`                     | 2           | 2            |
| `app.dock_slots`                               | 3           | 3            |
| `app.document_versions`                        | 1           | 1            |
| `app.documents`                                | 1           | 1            |
| `app.domain_events`                            | 447         | 447          |
| `app.earning_codes`                            | 2           | 2            |
| `app.engagement_document_state_transitions`    | 2           | 2            |
| `app.engagement_documents`                     | 1           | 1            |
| `app.engagement_state_transitions`             | 11          | 11           |
| `app.engagements`                              | 5           | 5            |
| `app.entitlement_deliveries`                   | 1           | 1            |
| `app.event_rsvps`                              | 1           | 1            |
| `app.expense_state_transitions`                | 5           | 5            |
| `app.expenses`                                 | 3           | 3            |
| `app.favorites`                                | 2           | 2            |
| `app.feed_acknowledgments`                     | 1           | 1            |
| `app.feed_posts`                               | 5           | 5            |
| `app.feed_reactions`                           | 1           | 1            |
| `app.form_submission_state_transitions`        | 2           | 2            |
| `app.form_submissions`                         | 1           | 1            |
| `app.form_template_state_transitions`          | 2           | 2            |
| `app.form_template_versions`                   | 1           | 1            |
| `app.form_templates`                           | 1           | 1            |
| `app.fulfillment_lines`                        | 5           | 5            |
| `app.fulfillment_state_transitions`            | 8           | 8            |
| `app.fulfillments`                             | 4           | 4            |
| `app.fx_rates`                                 | 1           | 1            |
| `app.gate_evidence`                            | 6           | 6            |
| `app.gate_queue`                               | 2           | 2            |
| `app.geofences`                                | 2           | 2            |
| `app.goods_receipts`                           | 1           | 1            |
| `app.group_members`                            | 3           | 3            |
| `app.groups`                                   | 1           | 1            |
| `app.guest_check_ins`                          | 1           | 1            |
| `app.guest_list_entries`                       | 5           | 5            |
| `app.handbook_acknowledgments`                 | 1           | 1            |
| `app.handbook_article_versions`                | 1           | 1            |
| `app.handbook_articles`                        | 1           | 1            |
| `app.handbook_sections`                        | 1           | 1            |
| `app.help_desk_team_members`                   | 1           | 1            |
| `app.help_desk_teams`                          | 1           | 1            |
| `app.incident_parties`                         | 2           | 2            |
| `app.incident_state_transitions`               | 7           | 7            |
| `app.incidents`                                | 3           | 3            |
| `app.inspection_items`                         | 9           | 9            |
| `app.inspection_results`                       | 4           | 4            |
| `app.inspection_templates`                     | 3           | 3            |
| `app.inspections`                              | 2           | 2            |
| `app.insurance_certificates`                   | 1           | 1            |
| `app.integration_account_mappings`             | 2           | 2            |
| `app.integration_calendar_targets`             | 1           | 1            |
| `app.integration_channel_routes`               | 2           | 2            |
| `app.integration_connection_state_transitions` | 7           | 7            |
| `app.integration_connections`                  | 6           | 6            |
| `app.integration_sync_run_state_transitions`   | 6           | 6            |
| `app.integration_sync_runs`                    | 2           | 2            |
| `app.invoice_lines`                            | 1           | 1            |
| `app.invoice_state_transitions`                | 2           | 2            |
| `app.invoices`                                 | 1           | 1            |
| `app.job_queue`                                | 2           | 2            |
| `app.journal_entries`                          | 3           | 3            |
| `app.journal_lines`                            | 6           | 6            |
| `app.journal_state_transitions`                | 5           | 5            |
| `app.legal_acceptances`                        | 2           | 2            |
| `app.lost_found_claims`                        | 1           | 1            |
| `app.lost_found_items`                         | 1           | 1            |
| `app.lost_item_state_transitions`              | 2           | 2            |
| `app.marshalling_log`                          | 3           | 3            |
| `app.medical_encounters`                       | 1           | 1            |
| `app.membership_roles`                         | 23          | 23           |
| `app.memberships`                              | 22          | 22           |
| `app.notification_deliveries`                  | 60          | 60           |
| `app.notifications`                            | 30          | 30           |
| `app.occupancy_counters`                       | 1           | 1            |
| `app.occupancy_counts`                         | 1           | 1            |
| `app.offer_state_transitions`                  | 2           | 2            |
| `app.offer_versions`                           | 1           | 1            |
| `app.offers`                                   | 1           | 1            |
| `app.onboarding_items`                         | 1           | 1            |
| `app.onboarding_requirements`                  | 1           | 1            |
| `app.opportunities`                            | 2           | 2            |
| `app.opportunity_invitations`                  | 2           | 2            |
| `app.opportunity_positions`                    | 2           | 2            |
| `app.opportunity_questions`                    | 1           | 1            |
| `app.opportunity_requirements`                 | 1           | 1            |
| `app.opportunity_state_transitions`            | 4           | 4            |
| `app.org_brands`                               | 1           | 1            |
| `app.org_domains`                              | 3           | 3            |
| `app.org_state_labels`                         | 1           | 1            |
| `app.organization_case_studies`                | 2           | 2            |
| `app.organization_profile_capabilities`        | 4           | 4            |
| `app.organization_profile_members`             | 2           | 2            |
| `app.organization_profiles`                    | 2           | 2            |
| `app.organization_service_regions`             | 1           | 1            |
| `app.organization_verifications`               | 1           | 1            |
| `app.organizations`                            | 19          | 19           |
| `app.partner_agreements`                       | 1           | 1            |
| `app.partner_default_brands`                   | 1           | 1            |
| `app.party_messages`                           | 1           | 1            |
| `app.party_threads`                            | 1           | 1            |
| `app.pay_period_state_transitions`             | 1           | 1            |
| `app.pay_periods`                              | 1           | 1            |
| `app.pay_rates`                                | 1           | 1            |
| `app.payment_applications`                     | 1           | 1            |
| `app.payment_state_transitions`                | 2           | 2            |
| `app.payments`                                 | 1           | 1            |
| `app.payroll_run_state_transitions`            | 1           | 1            |
| `app.payroll_runs`                             | 1           | 1            |
| `app.people`                                   | 30          | 30           |
| `app.permit_requirements`                      | 22          | 22           |
| `app.person_certifications`                    | 1           | 1            |
| `app.person_languages`                         | 2           | 2            |
| `app.person_links`                             | 1           | 1            |
| `app.person_profiles`                          | 5           | 5            |
| `app.person_skills`                            | 3           | 3            |
| `app.personal_setting_values`                  | 3           | 3            |
| `app.po_lines`                                 | 4           | 4            |
| `app.poll_options`                             | 3           | 3            |
| `app.poll_votes`                               | 1           | 1            |
| `app.polls`                                    | 1           | 1            |
| `app.pool_members`                             | 2           | 2            |
| `app.portfolio_items`                          | 1           | 1            |
| `app.prequalifications`                        | 1           | 1            |
| `app.production_state_transitions`             | 5           | 5            |
| `app.profile_section_visibility`               | 1           | 1            |
| `app.project_member_roles`                     | 3           | 3            |
| `app.project_members`                          | 3           | 3            |
| `app.project_phase_transitions`                | 1           | 1            |
| `app.project_state_transitions`                | 5           | 5            |
| `app.projects`                                 | 4           | 4            |
| `app.punch_items`                              | 2           | 2            |
| `app.purchase_order_state_transitions`         | 4           | 4            |
| `app.purchase_orders`                          | 2           | 2            |
| `app.radio_channels`                           | 7           | 7            |
| `app.rate_card_lines`                          | 6           | 6            |
| `app.rate_cards`                               | 1           | 1            |
| `app.ratings`                                  | 2           | 2            |
| `app.receipt_lines`                            | 1           | 1            |
| `app.recognitions`                             | 1           | 1            |
| `app.reconciliation_lines`                     | 3           | 3            |
| `app.reconciliations`                          | 1           | 1            |
| `app.record_assignments`                       | 2           | 2            |
| `app.record_booking`                           | 1           | 1            |
| `app.record_build`                             | 1           | 1            |
| `app.record_checklist_items`                   | 3           | 3            |
| `app.record_contract`                          | 1           | 1            |
| `app.record_deadline`                          | 1           | 1            |
| `app.record_dependencies`                      | 5           | 5            |
| `app.record_document`                          | 1           | 1            |
| `app.record_event`                             | 1           | 1            |
| `app.record_inspection`                        | 1           | 1            |
| `app.record_meeting`                           | 1           | 1            |
| `app.record_milestone`                         | 1           | 1            |
| `app.record_permit`                            | 3           | 3            |
| `app.record_recurrences`                       | 1           | 1            |
| `app.record_rehearsal`                         | 1           | 1            |
| `app.record_replans`                           | 4           | 4            |
| `app.record_risk`                              | 1           | 1            |
| `app.record_shift`                             | 1           | 1            |
| `app.record_state_transitions`                 | 41          | 41           |
| `app.record_strike`                            | 1           | 1            |
| `app.record_task`                              | 2           | 2            |
| `app.record_timeline`                          | 1           | 1            |
| `app.records`                                  | 22          | 22           |
| `app.representation_scopes`                    | 4           | 4            |
| `app.representations`                          | 1           | 1            |
| `app.requisition_state_transitions`            | 3           | 3            |
| `app.requisitions`                             | 2           | 2            |
| `app.rfq_invitations`                          | 2           | 2            |
| `app.rfq_response_lines`                       | 4           | 4            |
| `app.rfq_responses`                            | 2           | 2            |
| `app.rfq_state_transitions`                    | 4           | 4            |
| `app.rfqs`                                     | 1           | 1            |
| `app.rider_lines`                              | 4           | 4            |
| `app.riders`                                   | 2           | 2            |
| `app.role_assignment_state_transitions`        | 1           | 1            |
| `app.role_assignments`                         | 1           | 1            |
| `app.run_of_show`                              | 1           | 1            |
| `app.saved_searches`                           | 1           | 1            |
| `app.saved_view_defaults`                      | 1           | 1            |
| `app.saved_view_filters`                       | 1           | 1            |
| `app.saved_view_shares`                        | 1           | 1            |
| `app.saved_view_sorts`                         | 1           | 1            |
| `app.saved_views`                              | 3           | 3            |
| `app.schedule_baseline_items`                  | 16          | 16           |
| `app.schedule_baselines`                       | 1           | 1            |
| `app.scope_nodes`                              | 8           | 8            |
| `app.setting_values`                           | 7           | 7            |
| `app.shift_state_transitions`                  | 20          | 20           |
| `app.shift_swaps`                              | 1           | 1            |
| `app.shifts`                                   | 8           | 8            |
| `app.shipment_lines`                           | 7           | 7            |
| `app.shipments`                                | 4           | 4            |
| `app.shortlists`                               | 1           | 1            |
| `app.site_plan_pins`                           | 3           | 3            |
| `app.site_plans`                               | 1           | 1            |
| `app.sop_acknowledgments`                      | 1           | 1            |
| `app.sops`                                     | 4           | 4            |
| `app.spaces`                                   | 3           | 3            |
| `app.spend_approvals`                          | 4           | 4            |
| `app.spend_authorities`                        | 13          | 13           |
| `app.sponsor_asset_state_transitions`          | 3           | 3            |
| `app.sponsor_assets`                           | 1           | 1            |
| `app.sponsor_entitlements`                     | 2           | 2            |
| `app.submittal_state_transitions`              | 3           | 3            |
| `app.submittals`                               | 1           | 1            |
| `app.subscription_state_transitions`           | 7           | 7            |
| `app.subscriptions`                            | 7           | 7            |
| `app.support_ticket_diagnostics`               | 1           | 1            |
| `app.support_ticket_messages`                  | 1           | 1            |
| `app.support_ticket_state_transitions`         | 3           | 3            |
| `app.support_tickets`                          | 3           | 3            |
| `app.survey_answers`                           | 2           | 2            |
| `app.survey_participations`                    | 1           | 1            |
| `app.survey_questions`                         | 3           | 3            |
| `app.survey_responses`                         | 1           | 1            |
| `app.survey_state_transitions`                 | 2           | 2            |
| `app.surveys`                                  | 1           | 1            |
| `app.swap_state_transitions`                   | 1           | 1            |
| `app.talent_pools`                             | 2           | 2            |
| `app.team_members`                             | 2           | 2            |
| `app.teams`                                    | 1           | 1            |
| `app.template_items`                           | 11          | 11           |
| `app.template_versions`                        | 2           | 2            |
| `app.templates`                                | 2           | 2            |
| `app.thread_subscriptions`                     | 2           | 2            |
| `app.time_entries`                             | 4           | 4            |
| `app.time_entry_audit`                         | 4           | 4            |
| `app.time_off_policies`                        | 1           | 1            |
| `app.time_off_requests`                        | 1           | 1            |
| `app.time_off_state_transitions`               | 1           | 1            |
| `app.timesheet_approvals`                      | 1           | 1            |
| `app.timesheet_state_transitions`              | 3           | 3            |
| `app.timesheets`                               | 1           | 1            |
| `app.tip_dismissals`                           | 1           | 1            |
| `app.tour_progress`                            | 2           | 2            |
| `app.training_assignments`                     | 1           | 1            |
| `app.training_completions`                     | 1           | 1            |
| `app.training_course_state_transitions`        | 2           | 2            |
| `app.training_courses`                         | 1           | 1            |
| `app.training_lesson_progress`                 | 1           | 1            |
| `app.training_lessons`                         | 2           | 2            |
| `app.training_quiz_keys`                       | 1           | 1            |
| `app.training_quiz_questions`                  | 1           | 1            |
| `app.travel_segments`                          | 2           | 2            |
| `app.vendor_bank_accounts`                     | 1           | 1            |
| `app.vendor_bank_detail_changes`               | 1           | 1            |
| `app.vendor_class_assignments`                 | 2           | 2            |
| `app.vendor_classes`                           | 2           | 2            |
| `app.vendor_products`                          | 1           | 1            |
| `app.vendor_scorecards`                        | 1           | 1            |
| `app.vendor_state_transitions`                 | 5           | 5            |
| `app.vendors`                                  | 2           | 2            |
| `app.venues`                                   | 7           | 7            |
| `app.verbiage_terms`                           | 3           | 3            |
| `app.weather_alerts`                           | 1           | 1            |
| `app.weather_readings`                         | 1           | 1            |
| `app.weather_thresholds`                       | 4           | 4            |
| `app.work_order_bids`                          | 1           | 1            |
| `app.work_order_state_transitions`             | 2           | 2            |
| `app.work_orders`                              | 1           | 1            |
| `app.workforce_events`                         | 1           | 1            |
| `app.workspace_members`                        | 6           | 6            |
| `app.workspaces`                               | 1           | 1            |
| `app.zones`                                    | 13          | 13           |
| `auth.identities`                              | 30          | 30           |
| `auth.users`                                   | 30          | 30           |
| `private.integration_credentials`              | 1           | 1            |
| `private.key_sequences`                        | 8           | 8            |
| `private.sync_scope_grants`                    | 86          | 86           |
