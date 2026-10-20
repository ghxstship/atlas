-- table-counts.sql
-- RRR-109. Row count of every table outside the Postgres system schemas, one "schema.table rows" line each, sorted.
-- Read-only. infra/production/compare-no-seed.sh runs it on the cleaned database and on a database built from
-- migrations with no seeds, then diffs the two; the promotion runbook runs it before and after the removal.

select format('%I.%I %s', n.nspname, c.relname,
  (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', n.nspname, c.relname), false, true, '')))[1]::text)
from pg_catalog.pg_class c
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where c.relkind in ('r', 'p')
  and not c.relispartition
  and n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast')
  and n.nspname not like 'pg_temp%'
  and n.nspname not like 'pg_toast_temp%'
order by n.nspname, c.relname;
