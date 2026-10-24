# Backup and restore

Section 9 sets the targets:

- point-in-time recovery for at least 7 days;
- weekly logical backups to separate storage;
- a 1 hour RPO and a 4 hour RTO, verified by a restore drill script.

Section 14.3 adds that EU-region tenants keep their backups in the EU, and Section 14.7 that deleted data ages out of backups on schedule.

## What protects the data

| Layer                  | Where                                                  | Recovery point           | Status                                                                                    |
| ---------------------- | ------------------------------------------------------ | ------------------------ | ----------------------------------------------------------------------------------------- |
| Point-in-time recovery | Supabase PITR add-on on the production project         | Seconds, for 7 days      | Paid add-on, so it is a blocked item: the owner must approve the spend                    |
| Daily physical backups | Supabase, included in the Pro plan                     | 24 hours, kept 7 days    | On by default for Pro projects; confirm in Dashboard, Database, Backups                   |
| Weekly logical backup  | GitHub Actions `backup-weekly` job, encrypted artifact | 7 days                   | `.github/workflows/backup-weekly.yml`; needs the owner's public key and each job's secret |
| Restore drill          | `infra/drills/restore-drill.sh` on a local copy        | Proves a backup restores | Runs locally and in CI                                                                    |

Daily backups alone give a 24 hour RPO. The 1 hour RPO holds only once PITR is on, and that is the reason the PITR spend is raised as a decision rather than assumed.

## Weekly logical backup (staging and production)

`.github/workflows/backup-weekly.yml` runs every Monday at 06:23 UTC, and on demand from the Actions tab. It has one job per project, both through `infra/ci/backup-weekly.sh`:

| Job          | Logs in as                                                                  | Secret                                                                      | Dumps with                                                                                                                                 |
| ------------ | --------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `staging`    | `postgres`                                                                  | `STAGING_DB_URL`, a repository secret                                       | `supabase db dump` (CLI 2.120.0): `roles.sql`, `schema.sql`, `data.sql`                                                                    |
| `production` | `xos_backup`, the read-only login of migration 1650 (ADR 0033, decision 47) | `PRODUCTION_BACKUP_DB_URL`, a secret of the `production-backup` environment | `--reader`: pg_dumpall, pg_dump and psql from the Postgres image the pinned CLI uses; adds `platform.sql`, `cron.sql` and `migrations.txt` |

1. Each job dumps roles, schema and data into separate files. The connection string is a GitHub Actions secret, so the job never prints it. Both secrets are Session pooler strings (port 5432): GitHub's hosted runners have no IPv6, and a project's direct host is IPv6 unless it has the IPv4 add-on.
2. The files are encrypted with `gpg --encrypt --recipient` to the owner's public backup key, which is committed at `infra/backup/backup-public-key.asc` once the owner provides it. The private key never touches CI.
3. The encrypted archive is uploaded as a workflow artifact kept 35 days, `xos-staging-backup` or `xos-production-backup`. The repository is public, so only the encrypted file is ever uploaded. The SHA-256 of the encrypted file is written to the job summary.
4. Both jobs fail until the key is committed and their secret is set, so a missing backup is never silent. GitHub emails a failed scheduled run to one person only: whoever last changed the workflow's `cron` line, or last re-enabled the workflow, and only while their notification settings send Actions email. It does not email the repository admins. So the owner pushes any change to the schedule, or re-enables the workflow after someone else's change, and checks the run status each week (`production.md`, Monitoring and alerting).
5. Database network restrictions on production stay off for now, because GitHub runners connect from changing addresses (ADR 0033, decision 47; `promote-to-production.md`, step 11).
6. EU-region projects would run the same job with their own secret, their archives going to EU storage through a bucket the owner chooses. EU data residency is deferred until the first EU Enterprise contract (ADR 0033, decision 53), so that storage decision waits for it.

### What the production login reads

`supabase db dump` always switches to the `postgres` role, which `xos_backup` cannot, so the `production` job runs the clients itself. They come from the `supabase/postgres` image the pinned CLI names (`supabase services`), the same pg_dump `supabase db dump` would run. The archive holds:

- `roles.sql` and `schema.sql`, written with the CLI's own flags, schema exclusions and filters, two of them corrected. `roles.sql` leaves out grants on server parameters to Supabase's reserved roles (`GRANT SET ON PARAMETER log_min_messages TO supabase_realtime_admin`): every new project has them, and `postgres` may not repeat them. `schema.sql` keeps the grants and revokes on an application function that takes a platform type, which the CLI drops with any line naming a platform schema: `app.store_search_embedding` takes an `extensions.vector`, and lost its REVOKE from PUBLIC;
- `data.sql`: every table of `app`, `private` and `xpms` and the storage buckets and object list, from one snapshot, then the accounts (`auth.users`, `identities`, `mfa_factors`, `sso_providers`, `sso_domains`, `saml_providers`) as one INSERT per row, read just after in their own transaction;
- `platform.sql`: the triggers, policies and grants XOS keeps on Supabase's own tables: the triggers on `auth.users` (a person for each new account, the age confirmation) and on `storage.objects` (the upload scan queue), every storage policy, and the login's grants on `storage`. The schema dump leaves the `auth` and `storage` schemas out, and these with them; without them a restored project has no storage access for anyone, no person on sign-up and no scanning;
- `cron.sql`: the pg_cron worker schedules as `cron.schedule` calls;
- `migrations.txt`: the applied migration versions, one a line. No dump holds the migration history, the CLI's included, so the restore records it again from this list.

The users' one-time tokens (confirmation, recovery, email and phone change, reauthentication) are written empty, which Supabase Auth reads as no link pending: a link sent before the backup fails after a restore, and the person asks again.

Migration 1650 explains each grant. The login has no write grant, no Vault, no USAGE on `auth` or `cron`, and reaches the accounts, schedules and migration versions only through `private.backup_account_rows`, `private.backup_cron_schedules` and `private.backup_migration_versions`; `private.backup_platform_objects` reads only catalogs, with the login's own rights. Its sessions start read-only. It holds what every role holds through PUBLIC, which includes pg_net's `net.http_delete` (a pg_net default, not an XOS grant); a session must first turn read-only off to queue a request.

Not in a production archive, and kept by Supabase's daily backups and PITR instead: sessions and refresh tokens (everyone signs in again after a logical restore), one-time tokens, the auth audit log, passkeys (`auth.webauthn_credentials`), Supabase Auth's own recovery codes, the OAuth server's clients and consents, SCIM and custom OAuth providers. postgres reads those last tables without the grant option, so no login of its own can.

Vault is in no archive either, since the login has no grant on it, and losing it costs more than sign-ins:

- The keys migrations created in the project (`xos_medical_notes_key`, `xos_tax_form_key`, `xos_org_tax_identifier_key`, `xos_passport_number_key`) exist only in its Vault (ADR 0033, decision 49). A project restored from an archive gets new keys, and the values encrypted with the old ones (medical treatment notes, tax form identifiers, legal entity tax identifiers, passport numbers) cannot be read again. People enter them again.
- `xos_inbound_reply_secret` is new as well, so reply addresses in mail sent before the restore no longer verify, and those replies are ignored.
- Secrets that orgs entered (integration credentials, inbound integration secrets, warehouse credentials, webhook signing secrets) are referenced by Vault id, so their rows point at nothing: the org connects each integration again and creates its webhook endpoints again, each with a new signing secret.
- `xos_worker_key` and `xos_functions_url`, which the operator set, are set again from the operator's records.

So a weekly archive is the last resort, for when Supabase's own backups are gone. Whenever a daily backup or PITR can restore, use it: both keep Vault.

### Set up the production backup login (OWNER)

Do this once migrations 1650 to 1659 are on production, and again to rotate the password.

1. Generate a long random password in your password manager.
2. Connect to production as `postgres` with psql and run `\password xos_backup`. psql asks for the password twice and sends only its SCRAM hash, so the password never appears in a statement or a log. Do not use `alter role ... password` in the SQL editor: statements can be logged.
3. Build the connection string from Dashboard, Connect, **Session pooler** (port 5432), with the user changed from `postgres.<project ref>` to `xos_backup.<project ref>`. GitHub's hosted runners have no IPv6, and the direct host `db.<project ref>.supabase.co` is IPv6 unless the project has the IPv4 add-on. Check it from a terminal: `psql "<connection string>" -c 'select current_user'` prints `xos_backup`. If the pooler refuses the login, use the direct connection string with the IPv4 add-on instead.
4. In GitHub, Settings, Environments, create `production-backup`. Under Deployment branches and tags, allow `main` only. Add the secret `PRODUCTION_BACKUP_DB_URL` there, not as a repository secret, so no other branch or workflow can read it.
5. Commit the public backup key as `infra/backup/backup-public-key.asc` if it is not there yet.
6. Run Weekly backup from the Actions tab. Check that the `production` job's summary lists `roles.sql schema.sql data.sql platform.sql cron.sql migrations.txt`, and download the artifact once to confirm it decrypts with your private key.

To rotate, repeat steps 1 to 4 and delete the old password from your password manager. To revoke the login at once, run `alter role xos_backup nologin;` as `postgres`.

## Restore drill (local, every week and before each release)

One command runs the whole drill against this checkout's own stack (`supabase_db_<project_id>` from `supabase/config.toml`) and writes a report for the release checklist:

```sh
infra/drills/release-drill.sh --out /tmp/xos-drills
# report=/tmp/xos-drills/release-drill-<stamp>.txt
```

It runs the two steps below, then adds the security catalog suite (`9900_security_catalog`) to the pgTAP smoke set. The steps can also run separately:

```sh
# 1. Back up a local stack (read-only on the source).
infra/drills/backup-drill.sh --source supabase_db_xos4-shared --out /tmp/xos-drills

# 2. Restore into a throwaway container and verify.
infra/drills/restore-drill.sh --dump /tmp/xos-drills/xos-<stamp>.dump
```

The scripts refuse anything that is not local:

- the Docker daemon must be a local socket;
- the source must be a `supabase_db_xos4-*` container;
- the target is a container the script creates, named `xos4-drill-*`, and removes on exit.

The restore drill proves:

1. the archive checksum matches the manifest;
2. pg_restore reports no errors (it creates the service roles the fresh image lacks, without login or password);
3. the latest migration matches;
4. every table in `xpms`, `app`, `private`, `api_public`, `api_external` and `supabase_migrations` has exactly the source row count;
5. the 25 key tables in `infra/drills/key-tables.sql` (identity and tenancy, projects and records, engagements, time, purchase orders and invoices, audit and domain events, plans and capabilities, the canon, storage and the migration history) have the source row count and content checksum. The checksum is the MD5 of every row's MD5 in sorted order, so one changed value in one row fails it;
6. the foundation, canon and Playbook round-trip pgTAP suites pass on the copy. The round trip hashes every canon sheet, so one changed cell fails it.

It prints the measured restore time against the 4 hour RTO.

| Date       | Stack                       | Size, tables, migration | Restore | Verified | Result                                                                          |
| ---------- | --------------------------- | ----------------------- | ------- | -------- | ------------------------------------------------------------------------------- |
| 2026-10-16 | `xos4-shared`               | 94 MB, 519, 1001        | 26 s    | 31 s     | Passed                                                                          |
| 2026-10-19 | `xos4-a55` (fresh, release) | 14 MB, 657, 1191        | 21 s    | 26 s     | Passed: 657 row counts, 25 key-table checksums, 4 pgTAP suites (156 assertions) |

A tampered manifest (one key-table checksum changed) fails the drill with the differing table named, so the comparison is live, not a formality.

Pass `--keep` to leave the copy running (its name is printed) for investigation or for `infra/db/verify-proposals.sh`. Remove it afterwards with `docker rm -f <name>`.

## Verifying a point-in-time recovery

Once PITR is on, drill it each quarter and before the first production release. A PITR restore always lands in a new hosted project, so the local scripts cannot run it; the same checks run by hand:

1. Note the recovery target time `T`, then restore to a new project: Dashboard, Database, Backups, Point in time.
2. In the SQL editor of the restored project, run `infra/drills/key-tables.sql`. It is read-only.
3. Check the recovery point. The latest migration equals production's, and the newest `app.audit_events.created_at` in the restored project is at or just before `T`. For the append-only `app.audit_events`, the restored count plus production's `select count(*) from app.audit_events where created_at > 'T'` equals production's count now. Keep both outputs as the evidence.
4. Run the pgTAP suites against the restored project: `supabase test db --db-url "<restored project's direct connection string>"`. The suites roll back their own writes.
5. Record the target time, the restore duration and the newest audit event in the release checklist, then pause the restored project. Deleting it needs the owner (Section 19.8).

## Restoring production (incident)

Follow the incident runbook first (`incident-response.md`): declare a SEV1, name an incident commander and freeze deploys.

1. **Choose the recovery point.** For accidental writes, pick the last good moment from `app.audit_events` (who changed what, when). For corruption or loss, pick the latest PITR point.
2. **Restore to a new project, never over the live one.**
   - PITR: Supabase Dashboard, Database, Backups, Point in time, restore to a new project. Daily backup: Restore to new project.
   - From a weekly archive: decrypt it offline with the owner's private key. Then, against the new project's Session pooler string as `postgres`, run `psql -v ON_ERROR_STOP=1 -f` on `roles.sql`, `schema.sql` and `data.sql`, in that order, and for a production archive on `platform.sql` and then `cron.sql`, which schedules the workers again. `ON_ERROR_STOP` makes a failed statement stop the restore rather than scroll past.
   - Then record the migration history, which no dump holds. From a checkout of `main` (migrations are only ever added), run `supabase migration repair --db-url "<new project>" --status applied $(cat migrations.txt)` for a production archive. A staging archive, the CLI's dump, has neither `migrations.txt` nor `platform.sql`: pass the versions of the release staging ran, and expect to recreate the storage policies and auth triggers by hand. It also has the two lines the production script corrects (What the production login reads): delete any `GRANT ... ON PARAMETER` line from its `roles.sql` before running it, and run `revoke all on function app.store_search_embedding from public;` after `schema.sql`. Staging is usually quicker to rebuild from its migrations. Without this step the migration check below fails, and the next `supabase db push` would try every migration again.
   - Then create Vault's secrets again (What the production login reads): as `postgres`, `select vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), '<name>', '<description>');` for each of the four keys and `xos_inbound_reply_secret`, with the descriptions their migrations give (0363, 0730, 1200, 1340 and 0550), and `xos_worker_key` and `xos_functions_url` as `production.md` sets them. Tell the orgs that hold integrations or webhook endpoints to connect or create them again.
   - Users sign in again; passkeys and OAuth clients come back only from a Supabase backup (What the production login reads). The archive lists stored files but holds none: the files stay in the old project's Storage until they are copied across.
3. **Verify the new project** with the same checks the drill runs. Point a local checkout's `supabase/config.toml` at it read-only and run:
   - the migration version check;
   - the row counts against the last manifest;
   - `supabase test db` filtered to the foundation and canon suites.
4. **Switch traffic.** Update `SUPABASE_URL`, the anon key and the service key in the Vercel projects `atlas` and `gateway` and in the Edge Function secrets, then redeploy.
5. **Repair the gap.** Rows written between the recovery point and the switch exist only in the old project. Export them by `created_at` and `updated_at` from the old project and replay them through the API, or record them as lost in the postmortem.
6. **Keep the old project paused, not deleted,** until the postmortem closes. Deleting a cloud resource needs the owner (Section 19.8).

Vault secrets (`vault.secrets`) are encrypted with the project's own key, which a daily backup or PITR restore brings along. A restore from a weekly archive has no Vault: step 2 creates the secrets again, and What the production login reads lists what that loses.

## Settings for the orchestrator to apply

| Where                                          | Setting                                                                                                                    |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Supabase, xos-atlas-staging, Database, Backups | Confirm daily backups are listed (included in Pro)                                                                         |
| Supabase, production project, Add-ons          | Point in Time Recovery, 7 days: only after the owner approves the cost                                                     |
| GitHub, repository secrets                     | `STAGING_DB_URL` (the staging Session pooler string as `postgres`, read by the backup job only)                            |
| GitHub, environment `production-backup`        | `PRODUCTION_BACKUP_DB_URL`, the read-only backup login's session pooler string (Set up the production backup login, OWNER) |
| Repository                                     | Commit the owner's public key as `infra/backup/backup-public-key.asc`                                                      |
