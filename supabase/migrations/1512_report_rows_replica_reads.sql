-- 1512_report_rows_replica_reads.sql
-- A94 (RRR-139), finding A65-032, Section 5.1: read replicas serve reports. The report-run worker reads a run's source
-- rows from a read replica when XOS_READ_REPLICA_URL is set (packages/data/src/read-replica.ts). A replica is a hot
-- standby: it runs only read-only transactions, and PostgREST runs an RPC read-only when it is called with GET, which
-- it allows for functions that are not volatile.
--
-- app.report_run_rows (1050) only reads: it checks the run, builds the query and switches to the person the run is for
-- with set_config, which a read-only transaction allows. It was declared volatile, so it is declared stable here. Its
-- body, grants and comment are unchanged; on the primary it answers exactly as before (pgTAP 1050 and 1512).

alter function app.report_run_rows(uuid, text[], integer) stable;
