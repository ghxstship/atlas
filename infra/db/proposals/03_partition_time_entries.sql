-- Proposal 3 of 3 (A26 Reliability, for the orchestrator to place in A03's late slots, after proposal 1).
-- Partitions app.time_entries by month on created_at (Section 5.1).
--
-- Why created_at, not clock_in: clock_in changes through approved corrections (0340), and a partition key
-- that changes moves rows between partitions and breaks the composite foreign keys below. created_at is
-- stamped by the database on insert and never changes.
--
-- What changes for other tables (expand and contract, Section 5.1): app.time_entry_audit,
-- app.time_entry_corrections and app.clock_punches each gain time_entry_created_at, backfilled now and
-- filled by a trigger on every insert, and their foreign key becomes (time_entry_id, time_entry_created_at).
-- Callers keep inserting only time_entry_id; no application code changes. api_external.time_entries is
-- recreated unchanged.
--
-- Retention is unchanged: soft-deleted entries are deleted after 7 years (0930). Partitions bound the size of
-- the indexes the clock-in overlap guard and the payroll export scan, which is the reason Section 5.1 lists
-- the table. Switching time entries to whole-partition expiry is a retention decision for A21 and the owner
-- (payroll records are kept 7 years per jurisdiction, Section 14.3).

call private.partition_existing_table('app.time_entries', 'created_at', 3::smallint, 20);
