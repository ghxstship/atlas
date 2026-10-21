-- 1511_partition_access_scans.sql
-- A94 (RRR-139), finding A65-032, Section 5.1: app.access_scans partitioned by month on created_at, with 3 months made
-- ahead and maintenance order 30 (after A18's six, 90 to 40). A26's proposal 2 (infra/db/proposals), unchanged.
--
-- Why created_at: the database stamps it on insert (private.stamp_audit_columns) and never changes it, the table is
-- append-only (t95_append_only), and the existing retention policy already ages rows on it. No table references
-- access_scans, so no composite keys are needed.
--
-- Retention: the ledger keeps 7 years (0930). With partitions, expiry drops whole months instead of deleting rows, as
-- for audit_events; legal holds still apply through A18's held partitions. pgTAP 1511 proves the policies, triggers,
-- grants and the scan decision behave as before.

call private.partition_existing_table('app.access_scans', 'created_at', 3::smallint, 30);

update private.retention_policies
set purge_method = 'Drop Partition'
where table_name = 'app.access_scans' and time_column = 'created_at';
