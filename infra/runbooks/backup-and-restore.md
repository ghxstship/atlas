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

| Job          | Logs in as                                                                  | Secret                                                                      | Dumps with                                                                                            |
| ------------ | --------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `staging`    | `postgres`                                                                  | `STAGING_DB_URL`, a repository secret                                       | `supabase db dump` (CLI 2.120.0): `roles.sql`, `schema.sql`, `data.sql`                               |
| `production` | `xos_backup`, the read-only login of migration 1650 (ADR 0033, decision 47) | `PRODUCTION_BACKUP_DB_URL`, a secret of the `production-backup` environment | `--reader`: pg_dumpall, pg_dump and psql from the Postgres image the pinned CLI uses; adds `cron.sql` |

1. Each job dumps roles, schema and data into separate files. The connection string is a GitHub Actions secret, so the job never prints it. Both secrets are Session pooler strings (port 5432): GitHub's hosted runners have no IPv6, and a project's direct host is IPv6 unless it has the IPv4 add-on.
2. The files are encrypted with `gpg --encrypt --recipient` to the owner's public backup key, which is committed at `infra/backup/backup-public-key.asc` once the owner provides it. The private key never touches CI.
3. The encrypted archive is uploaded as a workflow artifact kept 35 days, `xos-staging-backup` or `xos-production-backup`. The repository is public, so only the encrypted file is ever uploaded. The SHA-256 of the encrypted file is written to the job summary.
4. Both jobs fail until the key is committed and their secret is set, so a missing backup is never silent. A failed scheduled run emails the repository admins.
5. Database network restrictions on production stay off for now, because GitHub runners connect from changing addresses (ADR 0033, decision 47; `promote-to-production.md`, step 11).
6. EU-region projects would run the same job with their own secret, their archives going to EU storage through a bucket the owner chooses. EU data residency is deferred until the first EU Enterprise contract (ADR 0033, decision 53), so that storage decision waits for it.

### What the production login reads

`supabase db dump` always switches to the `postgres` role, which `xos_backup` cannot, so the `production` job runs the clients itself. They come from the `supabase/postgres` image the pinned CLI names (`supabase services`), the same pg_dump `supabase db dump` would run. The archive holds:

- `roles.sql` and `schema.sql`, written with the CLI's own flags, schema exclusions and filters;
- `data.sql`: every table of `app`, `private` and `xpms` and the storage buckets and object list, from one snapshot, then the accounts (`auth.users`, `identities`, `mfa_factors`, `sso_providers`, `sso_domains`, `saml_providers`) as one INSERT per row, read just after in their own transaction;
- `cron.sql`: the pg_cron worker schedules as `cron.schedule` calls.

Migration 1650 explains each grant. The login has no write grant, no Vault, no USAGE on `auth` or `cron`, and reaches the accounts and schedules only through `private.backup_account_rows` and `private.backup_cron_schedules`. Its sessions start read-only. It holds what every role holds through PUBLIC, which includes pg_net's `net.http_delete` (a pg_net default, not an XOS grant); a session must first turn read-only off to queue a request.

Not in a production archive, and kept by Supabase's daily backups and PITR instead: sessions and refresh tokens (everyone signs in again after a logical restore), one-time tokens, the auth audit log, passkeys (`auth.webauthn_credentials`), Supabase Auth's own recovery codes, the OAuth server's clients and consents, SCIM and custom OAuth providers. postgres reads those last tables without the grant option, so no login of its own can.

### Set up the production backup login (OWNER)

Do this once migrations 1650 to 1659 are on production, and again to rotate the password.

1. Generate a long random password in your password manager.
2. Connect to production as `postgres` with psql and run `\password xos_backup`. psql asks for the password twice and sends only its SCRAM hash, so the password never appears in a statement or a log. Do not use `alter role ... password` in the SQL editor: statements can be logged.
3. Build the connection string from Dashboard, Connect, **Session pooler** (port 5432), with the user changed from `postgres.<project ref>` to `xos_backup.<project ref>`. GitHub's hosted runners have no IPv6, and the direct host `db.<project ref>.supabase.co` is IPv6 unless the project has the IPv4 add-on. Check it from a terminal: `psql "<connection string>" -c 'select current_user'` prints `xos_backup`. If the pooler refuses the login, use the direct connection string with the IPv4 add-on instead.
4. In GitHub, Settings, Environments, create `production-backup`. Under Deployment branches and tags, allow `main` only. Add the secret `PRODUCTION_BACKUP_DB_URL` there, not as a repository secret, so no other branch or workflow can read it.
5. Commit the public backup key as `infra/backup/backup-public-key.asc` if it is not there yet.
6. Run Weekly backup from the Actions tab. Check that the `production` job's summary lists `roles.sql schema.sql data.sql cron.sql`, and download the artifact once to confirm it decrypts with your private key.

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
   - From a weekly archive: decrypt it offline with the owner's private key. Then `psql -f roles.sql`, `psql -f schema.sql` and `psql -f data.sql` against the new project, in that order, and for a production archive `psql -f cron.sql` last, which schedules the workers again. Users sign in again; passkeys and OAuth clients come back only from a Supabase backup (What the production login reads).
3. **Verify the new project** with the same checks the drill runs. Point a local checkout's `supabase/config.toml` at it read-only and run:
   - the migration version check;
   - the row counts against the last manifest;
   - `supabase test db` filtered to the foundation and canon suites.
4. **Switch traffic.** Update `SUPABASE_URL`, the anon key and the service key in the Vercel projects `atlas` and `gateway` and in the Edge Function secrets, then redeploy.
5. **Repair the gap.** Rows written between the recovery point and the switch exist only in the old project. Export them by `created_at` and `updated_at` from the old project and replay them through the API, or record them as lost in the postmortem.
6. **Keep the old project paused, not deleted,** until the postmortem closes. Deleting a cloud resource needs the owner (Section 19.8).

Vault secrets (`vault.secrets`) are encrypted with the project's own key. A restore into a new project must re-create them from the owner's secret store; the restore steps list them by name with `select name from vault.secrets`.

## Settings for the orchestrator to apply

| Where                                          | Setting                                                                                                                    |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Supabase, xos-atlas-staging, Database, Backups | Confirm daily backups are listed (included in Pro)                                                                         |
| Supabase, production project, Add-ons          | Point in Time Recovery, 7 days: only after the owner approves the cost                                                     |
| GitHub, repository secrets                     | `STAGING_DB_URL` (the staging Session pooler string as `postgres`, read by the backup job only)                            |
| GitHub, environment `production-backup`        | `PRODUCTION_BACKUP_DB_URL`, the read-only backup login's session pooler string (Set up the production backup login, OWNER) |
| Repository                                     | Commit the owner's public key as `infra/backup/backup-public-key.asc`                                                      |
