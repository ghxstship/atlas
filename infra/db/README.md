# Partition proposals

Section 5.1 partitions eight tables by month, and a nightly pg_cron job creates future partitions and detaches expired ones. A18's machinery (0500) provides the registry, partition creation, expiry with legal holds, and the nightly job. Six tables were created partitioned from the start:

| Table                         | Migration | Partition column          | Registered order |
| ----------------------------- | --------- | ------------------------- | ---------------- |
| `app.audit_events`            | 0501      | `created_at`              | 90               |
| `app.activity_events`         | 0501      | `created_at`              | 80               |
| `app.webhook_deliveries`      | 0510      | `created_at`              | 70               |
| `app.usage_events`            | 0510      | `created_at`              | 60               |
| `app.notifications`           | 0520      | `created_at`              | 50               |
| `app.notification_deliveries` | 0520      | `notification_created_at` | 40               |

The remaining two, `app.time_entries` and `app.access_scans` (A03), are plain tables that already hold rows. The proposals here convert them. A26 has no migration range, so the orchestrator places them.

| File                                        | Suggested range                | What it does                                                                                                                                         |
| ------------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `proposals/01_partition_existing_table.sql` | A18 range or orchestrator 09xx | `private.partition_existing_table`: a one-transaction conversion keeping every dependent object                                                      |
| `proposals/02_partition_access_scans.sql`   | A03 late slot, after 01        | Converts `access_scans` on `created_at`, order 30; its 7-year retention becomes whole-partition expiry                                               |
| `proposals/03_partition_time_entries.sql`   | A03 late slot, after 01        | Converts `time_entries` on `created_at`, order 20; three referencing tables gain `time_entry_created_at` (composite foreign keys, filled by trigger) |

## Verification

`verify-proposals.sh` applies the three files to a restored drill copy, never to a shared or hosted database. It compares the pgTAP suites that touch both tables before and after. On 2026-10-16, against a copy of the shared stack at migration 1001:

- 11 suites gave the same results before and after: 0340, 0352, 0365, 0460, 0470, 0592, 0940, 0941, 0943, 0981 and 1000, with 361 passing assertions;
- both tables are partitioned with 5 partitions each and registered;
- `private.run_partition_maintenance()` ran with no errors in `private.retention_runs`;
- `api_external.time_entries` came back with its grants;
- the three foreign keys became composite.

```sh
infra/drills/backup-drill.sh --out /tmp/xos-drills
infra/drills/restore-drill.sh --dump /tmp/xos-drills/xos-<stamp>.dump --keep
infra/db/verify-proposals.sh <kept container name>
docker rm -f <kept container name>
```

After placing the files, the orchestrator runs `supabase db reset` and the full `supabase test db` on a stack at main's head, then regenerates `database.types.ts` (three new columns).
