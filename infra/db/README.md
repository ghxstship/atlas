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
| `app.time_entries`            | 2231      | `created_at`              | 20               | Converted (A130); retention deletes rows      |

## The conversion (migration 1510)

`private.partition_existing_table` converts a plain table in one transaction and keeps everything it had: columns, constraints, comments, indexes, triggers, policies, grants, dependent views and rows; incoming foreign keys become composite, with a filled `<fk>_<partition column>` column. It was A26's proposal 1; A94 placed it as migration 1510 with three additions, so a converted table refuses exactly what it refused before:

- **One row per id.** The widened primary key `(id, <partition column>)` would let a second row reuse an id, for example two concurrent replays of one client id through `app.record_scan`. The `t00_unique_id` trigger (`private.guard_partitioned_id`) takes a transaction lock on the id and refuses a taken one with 23505, as the old key did.
- **References to no row.** A composite key is not checked while one of its columns is null, and the fill trigger finds no partition key for a missing row, so the fill trigger refuses it with 23503.
- **Foreign key actions.** An incoming key with `ON DELETE`, `ON UPDATE` or deferral is refused rather than recreated without them.

pgTAP 1510 proves each on a probe table; 1511 proves `access_scans` keeps its policies, triggers, grants, indexes, replay behavior and append-only ledger, and that its 7-year retention now detaches whole months. Production held no tenant rows when it ran (demo data removed 2026-10-20).

Until 2230 one difference remained on converted tables: a refusal message that names the table named the month partition, for example `access_scans_p202610 is an append-only ledger.` The codes never changed, and since 2230 the messages name the table again (below).

## Trigger identity on partitions (migration 2230)

On a partitioned table each row trigger runs on the partition, so `TG_TABLE_NAME`, `TG_TABLE_SCHEMA` and `TG_RELID` name the month partition (`private.time_entries_p202610`), not the table. A26's proposal 3 waited on this, because two of `time_entries`' triggers depend on that identity:

- `private.audit_row_change` (`t85_audit_trail`) writes the action as `<table>.<op>` and the subject as `<schema>.<table>`, and looks up the audit column exclusions by table. Unresolved, audit rows would read `time_entries_p202610.update` on `private.time_entries_p202610`, and the Restricted columns `private.column_classifications` records for `app.time_entries` would enter the diffs.
- `private.guard_engaged_worker` refuses with `<table>_worker_immutable` and tells shifts from time by table name.

A130 placed the fix as 2230: `private.trigger_table(TG_RELID)` resolves a partition to its parent through `pg_class.relispartition` and `pg_inherits` (to the root), and any other table to itself; `private.trigger_table_name` gives its name. `audit_row_change`, `guard_engaged_worker`, `refuse_ledger_change`, `refuse_org_change`, `refuse_cross_org_reference`, `derive_org_id` and `assert_same_project` name tables through it. The refusal helpers resolve only on the refusal path, so a row that passes pays nothing. pgTAP 2230 converts a probe table and checks that its audit rows and refusals are identical before and after, checks `time_entries`' audit action names, excluded Restricted columns and refusal codes against what the plain table gave, and fails when one of the seven functions stops calling the resolver. A package that redefines one of them must start from 2230 and keep the resolution.

## `time_entries` (migration 2231)

A26's proposal 3, placed by A130 through `private.partition_existing_table` as 1511 placed `access_scans`. It partitions on `created_at`, which the database stamps on insert and never changes; `clock_in` changes through approved corrections and would move rows between partitions. `time_entry_audit`, `time_entry_corrections` and `clock_punches` gained `time_entry_created_at`, filled by the database, and their foreign keys became `(time_entry_id, time_entry_created_at)`; callers still send only `time_entry_id`. The procedure carries neither a view's column comments nor publication membership, so 2231 restates `api_external.time_entries`' description from 1000 and puts the table back in every publication that held it (the PowerSync publication lists it). Retention is unchanged (soft-deleted entries are deleted row by row after 7 years), so the nightly job makes months ahead and never detaches one; whole-month expiry would be a retention decision for A21 and the owner. pgTAP 2231 proves the policies, triggers, grants, indexes, composite keys and the API view, and the crew, punch and payroll suites (0340, 0365, 0940, 0941, 1321, 1328, 1398, 1399 and the others that touch `time_entries`) pass unchanged.

One behavior is new: the partition is chosen from the `created_at` the insert carries before `private.stamp_audit_columns` restamps it, so an insert that names a `created_at` outside the current month is refused (23514: no partition for the row, or its partition constraint) instead of being restamped silently. No code path sends `created_at`; the same holds for `access_scans` since 1511.

## Verification of 2231

`verify-proposals.sh` replays 2231 on a restored drill copy taken at migration 2230, never on a shared or hosted database, and compares the pgTAP suites that touch `time_entries` (with 2230's identity suite, 1321, 1328, 1398 and 1399) before and after:

```sh
supabase db reset --version 2230          # in the agent's own stack workdir
infra/drills/backup-drill.sh --source supabase_db_xos4-<stack> --out /tmp/xos-drills
infra/drills/restore-drill.sh --dump /tmp/xos-drills/xos-<stamp>.dump --keep
infra/db/verify-proposals.sh <kept container name>
docker rm -f <kept container name>
```

Equal suite results are necessary, not sufficient: on 2026-10-16 A26's run passed 11 suites before and after, and the trigger identity problem above was found later (A94). On 2026-10-28 A130's run passed 16 suites (447 assertions) before and after, 2230's identity suite included, then `supabase db reset` and the full `supabase test db` passed with 2231 placed, and `database.types.ts` (three new columns) and the data dictionary were regenerated.
