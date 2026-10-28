-- 2231_partition_time_entries.sql
-- A130 (RRR-175), trace row S5.1-07, Section 5.1: app.time_entries partitioned by month on created_at, with 3 months
-- made ahead and maintenance order 20 (after access_scans, 30). This is A26's proposal 3 (infra/db/proposals),
-- placed through private.partition_existing_table (1510) as 1511 placed access_scans, now that the shared trigger
-- functions resolve a partition to its parent (2230): audit rows still read time_entries.insert and app.time_entries,
-- the worker guard still refuses with time_entries_worker_immutable, and refusals still name time_entries.
--
-- Why created_at, not clock_in: clock_in changes through approved corrections (0340), and a partition key that
-- changes moves rows between partitions and breaks the composite foreign keys below. created_at is stamped by the
-- database on insert (private.stamp_audit_columns) and never changes.
--
-- What the procedure keeps: every trigger (the web clock rules of 1321 and the kiosk punch path of 1328 included),
-- the three policies, the grants, the twelve indexes (the primary key widened to (id, created_at), with the id guard
-- keeping id unique) and api_external.time_entries, recreated with its options, comment and grants. The procedure
-- does not carry a view's column comments, so the view's description from 1000 is restated below. The payroll reads
-- of 1398 and 1399 read the parent and need nothing.
--
-- Publications: dropping the old table takes it out of any publication, and the procedure does not put the new one
-- back. The PowerSync publication (infra/powersync, applied by the owner with publish_via_partition_root) lists
-- app.time_entries, so every publication that held the table before the call holds it again after.
--
-- What changes for other tables (expand and contract, Section 5.1): app.time_entry_audit, app.time_entry_corrections
-- and app.clock_punches each gain time_entry_created_at, backfilled now and filled by a trigger on every insert, and
-- their foreign key becomes (time_entry_id, time_entry_created_at). Callers keep inserting only time_entry_id; no
-- application code changes. The column is not null on time_entry_audit and time_entry_corrections, so it gets the
-- default '-infinity' below, which never lands: the fill trigger replaces it on every insert, and were the trigger
-- bypassed the composite key would refuse it. The default is what lets callers, and the generated Insert types, leave
-- the column out as they did before.
--
-- Retention is unchanged: soft-deleted entries are deleted after 7 years (0930), row by row. Partitions bound the size
-- of the indexes the clock-in overlap guard and the payroll export scan, which is the reason Section 5.1 lists the
-- table. Switching time entries to whole-partition expiry is a retention decision for A21 and the owner (payroll
-- records are kept 7 years per jurisdiction, Section 14.3).

create temporary table a130_time_entry_publications as
  select p.pubname::text as pubname
  from pg_catalog.pg_publication p
  join pg_catalog.pg_publication_rel r on r.prpubid = p.oid
  where r.prrelid = 'app.time_entries'::regclass;

call private.partition_existing_table('app.time_entries', 'created_at', 3::smallint, 20);

do $$
declare
  v_pub text;
begin
  for v_pub in select t.pubname from a130_time_entry_publications t loop
    execute format('alter publication %I add table app.time_entries', v_pub);
  end loop;
end;
$$;

drop table a130_time_entry_publications;

alter table app.time_entry_audit alter column time_entry_created_at set default '-infinity';
alter table app.time_entry_corrections alter column time_entry_created_at set default '-infinity';

-- Restated from 1000: the procedure recreated the view, and its column comments with it.
call private.describe('api_external.time_entries', 'Time worked under the caller''s engagements while the operational area is open. Recorded through app.record_punch.', array[
  'id', 'Time entry.', 'engagement_id', 'Engagement.', 'project_id', 'Project.', 'shift_id', 'Shift worked.', 'clock_in', 'Clock in.',
  'clock_out', 'Clock out; NULL while open.', 'break_minutes', 'Break minutes.', 'source', 'Where the time was captured.']);
