# Backup and restore

Section 9 sets the targets:

- point-in-time recovery for at least 7 days;
- weekly logical backups to separate storage;
- a 1 hour RPO and a 4 hour RTO, verified by a restore drill script.

Section 14.3 adds that EU-region tenants keep their backups in the EU, and Section 14.7 that deleted data ages out of backups on schedule.

## What protects the data

| Layer                  | Where                                                  | Recovery point           | Status                                                                                       |
| ---------------------- | ------------------------------------------------------ | ------------------------ | -------------------------------------------------------------------------------------------- |
| Point-in-time recovery | Supabase PITR add-on on the production project         | Seconds, for 7 days      | Paid add-on, so it is a blocked item: the owner must approve the spend                       |
| Daily physical backups | Supabase, included in the Pro plan                     | 24 hours, kept 7 days    | On by default for Pro projects; confirm in Dashboard, Database, Backups                      |
| Weekly logical backup  | GitHub Actions `backup-weekly` job, encrypted artifact | 7 days                   | Workflow snippet in `infra/ci/README.md`; needs the owner's public key and the DB URL secret |
| Restore drill          | `infra/drills/restore-drill.sh` on a local copy        | Proves a backup restores | Runs locally and in CI                                                                       |

Daily backups alone give a 24 hour RPO. The 1 hour RPO holds only once PITR is on, and that is the reason the PITR spend is raised as a decision rather than assumed.

## Weekly logical backup (staging and production)

1. The job runs `supabase db dump` three times, writing roles, schema and data into separate files, against the project's direct connection string. That string is a GitHub Actions secret, so the job never prints it.
2. The files are encrypted with `gpg --encrypt --recipient` to the owner's public backup key, which is committed at `infra/backup/backup-public-key.asc` once the owner provides it. The private key never touches CI.
3. The encrypted archive is uploaded as a workflow artifact kept 35 days. The repository is public, so only the encrypted file is ever uploaded. The SHA-256 of the encrypted file is written to the job summary.
4. EU-region projects run the same job with their own secret. Their archives go to EU storage through the owner's chosen bucket; this needs a storage decision before the EU region launches.

## Restore drill (local, every week and before each release)

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
5. the foundation, canon and Playbook round-trip pgTAP suites pass on the copy. The round trip hashes every canon sheet, so one changed cell fails it.

It prints the measured restore time against the 4 hour RTO. On the 2026-10-16 drill of the shared stack (94 MB, 519 tables, migration 1001), the restore took 26 seconds and full verification 31 seconds.

Pass `--keep` to leave the copy running (its name is printed) for investigation or for `infra/db/verify-proposals.sh`. Remove it afterwards with `docker rm -f <name>`.

## Restoring production (incident)

Follow the incident runbook first (`incident-response.md`): declare a SEV1, name an incident commander and freeze deploys.

1. **Choose the recovery point.** For accidental writes, pick the last good moment from `app.audit_events` (who changed what, when). For corruption or loss, pick the latest PITR point.
2. **Restore to a new project, never over the live one.**
   - PITR: Supabase Dashboard, Database, Backups, Point in time, restore to a new project. Daily backup: Restore to new project.
   - From a weekly archive: decrypt it offline with the owner's private key. Then `psql -f roles.sql`, `psql -f schema.sql` and `psql -f data.sql` against the new project, in that order.
3. **Verify the new project** with the same checks the drill runs. Point a local checkout's `supabase/config.toml` at it read-only and run:
   - the migration version check;
   - the row counts against the last manifest;
   - `supabase test db` filtered to the foundation and canon suites.
4. **Switch traffic.** Update `SUPABASE_URL`, the anon key and the service key in the Vercel projects `atlas` and `gateway` and in the Edge Function secrets, then redeploy.
5. **Repair the gap.** Rows written between the recovery point and the switch exist only in the old project. Export them by `created_at` and `updated_at` from the old project and replay them through the API, or record them as lost in the postmortem.
6. **Keep the old project paused, not deleted,** until the postmortem closes. Deleting a cloud resource needs the owner (Section 19.8).

Vault secrets (`vault.secrets`) are encrypted with the project's own key. A restore into a new project must re-create them from the owner's secret store; the restore steps list them by name with `select name from vault.secrets`.

## Settings for the orchestrator to apply

| Where                                          | Setting                                                                  |
| ---------------------------------------------- | ------------------------------------------------------------------------ |
| Supabase, xos-atlas-staging, Database, Backups | Confirm daily backups are listed (included in Pro)                       |
| Supabase, production project, Add-ons          | Point in Time Recovery, 7 days: only after the owner approves the cost   |
| GitHub, repository secrets                     | `STAGING_DB_URL` (direct connection string, read by the backup job only) |
| Repository                                     | Commit the owner's public key as `infra/backup/backup-public-key.asc`    |
