# Partitions

Section 5.1 partitions eight tables by month, and a nightly pg_cron job creates future partitions and detaches expired ones. A18's machinery (0500) provides the registry, partition creation, expiry with legal holds, and the nightly job.

| Table                         | Migration | Partition column          | Registered order | How                                           |
| ----------------------------- | --------- | ------------------------- | ---------------- | --------------------------------------------- |
| `app.audit_events`            | 0501      | `created_at`              | 90               | Created partitioned                           |
| `app.activity_events`         | 0501      | `created_at`              | 80               | Created partitioned                           |
| `app.webhook_deliveries`      | 0510      | `created_at`              | 70               | Created partitioned                           |
| `app.usage_events`            | 0510      | `created_at`              | 60               | Created partitioned                           |
| `app.notifications`           | 0520      | `created_at`              | 50               | Created partitioned                           |
| `app.notification_deliveries` | 0520      | `notification_created_at` | 40               | Created partitioned                           |
| `app.access_scans`            | 1511      | `created_at`              | 30               | Converted (A94); retention drops whole months |
| `app.time_entries`            | not yet   | `created_at`              | 20               | Proposal 3 waits on the precondition below    |

## The conversion (migration 1510)

`private.partition_existing_table` converts a plain table in one transaction and keeps everything it had: columns, constraints, comments, indexes, triggers, policies, grants, dependent views and rows; incoming foreign keys become composite, with a filled `<fk>_<partition column>` column. It was A26's proposal 1; A94 placed it as migration 1510 with three additions, so a converted table refuses exactly what it refused before:

- **One row per id.** The widened primary key `(id, <partition column>)` would let a second row reuse an id, for example two concurrent replays of one client id through `app.record_scan`. The `t00_unique_id` trigger (`private.guard_partitioned_id`) takes a transaction lock on the id and refuses a taken one with 23505, as the old key did.
- **References to no row.** A composite key is not checked while one of its columns is null, and the fill trigger finds no partition key for a missing row, so the fill trigger refuses it with 23503.
- **Foreign key actions.** An incoming key with `ON DELETE`, `ON UPDATE` or deferral is refused rather than recreated without them.

pgTAP 1510 proves each on a probe table; 1511 proves `access_scans` keeps its policies, triggers, grants, indexes, replay behavior and append-only ledger, and that its 7-year retention now detaches whole months. Production held no tenant rows when it ran (demo data removed 2026-10-20).

One difference remains on converted tables: a refusal message that names the table (`private.refuse_ledger_change`, `refuse_org_change`, `refuse_cross_org_reference`, `derive_org_id`) names the month partition, for example `access_scans_p202610 is an append-only ledger.` The refusal codes are unchanged.

## `time_entries`: the precondition

`proposals/03_partition_time_entries.sql` is not placed. On a partitioned table each row trigger runs on the partition, so `TG_TABLE_NAME` and `TG_RELID` name the partition, not the table. Two of `time_entries`' triggers depend on that identity:

- `private.audit_row_change` (`t85_audit_trail`) writes the action as `<table>.<op>` and the subject as `app.<table>`, and looks up the audit column exclusions by `TG_RELID`. Converted, audit rows would read `time_entries_p202610.update`, and the Restricted columns `private.column_classifications` records for `app.time_entries` would enter the audit diffs, since the lookup is by table name.
- `private.guard_engaged_worker` refuses with the code `<table>_worker_immutable`, which would become `time_entries_p202610_worker_immutable`.

So the shared trigger functions must first resolve a partition to its parent (`pg_class.relispartition` and `pg_inherits`). `audit_row_change` was redefined as recently as 1411 and other agents may redefine it, so the orchestrator makes that change in a quiet window, with a pgTAP check that `time_entries` audit rows keep their action names, then places proposal 3.

## Verification of proposal 3

`verify-proposals.sh` applies proposal 3 to a restored drill copy at migration 1511 or later, never to a shared or hosted database, and compares the pgTAP suites that touch `time_entries` before and after:

```sh
infra/drills/backup-drill.sh --out /tmp/xos-drills
infra/drills/restore-drill.sh --dump /tmp/xos-drills/xos-<stamp>.dump --keep
infra/db/verify-proposals.sh <kept container name>
docker rm -f <kept container name>
```

Equal suite results are necessary, not sufficient: on 2026-10-16 A26's run passed 11 suites before and after, and the trigger identity problem above was found later (A94). After placing it, the orchestrator runs `supabase db reset` and the full `supabase test db`, then regenerates `database.types.ts` (three new columns) and the data dictionary.
