-- Proposal 2 of 3 (A26 Reliability, for the orchestrator to place in A03's late slots, after proposal 1).
-- Partitions app.access_scans by month on created_at (Section 5.1).
--
-- Why created_at: the database stamps it on insert (private.stamp_audit_columns) and never changes it, the
-- table is append-only (t95_append_only), and the existing retention policy already ages rows on it. No
-- table references access_scans, so no composite keys are needed.
--
-- Retention: the ledger keeps 7 years (0930 default). With partitions, expiry drops whole months instead of
-- deleting rows; legal holds still apply through A18's held partitions.

call private.partition_existing_table('app.access_scans', 'created_at', 3::smallint, 30);

update private.retention_policies
set purge_method = 'Drop Partition'
where table_name = 'app.access_scans' and time_column = 'created_at';
