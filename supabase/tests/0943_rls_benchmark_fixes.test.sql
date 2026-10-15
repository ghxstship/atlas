-- pgTAP: the gate 17 fixes (RRR-71). Record child policies no longer enumerate every reachable record;
-- records_read and time_entries_read evaluate their sets once as arrays; the list indexes exist. Row
-- level behavior is covered by the 0310, 0340 and 0940 suites, which run unchanged against these
-- policies; timings are measured by supabase/tests/0399_rls_benchmark.psql.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;

select plan(6);

select is((select string_agg(p.tablename || '.' || p.policyname, ', ' order by 1) from pg_catalog.pg_policies p
  where p.schemaname = 'app' and coalesce(p.qual, p.with_check) like '%record_ids_with%'
    and p.tablename not in ('punch_items', 'record_watchers')), null,
  'no A03 policy enumerates every reachable record through record_ids_with');
select ok((select qual from pg_catalog.pg_policies where schemaname = 'app' and tablename = 'record_task' and policyname = 'record_task_read') like 'EXISTS%'
       or (select qual from pg_catalog.pg_policies where schemaname = 'app' and tablename = 'record_task' and policyname = 'record_task_read') like '%EXISTS ( SELECT 1%',
  'a record extension checks its one parent record');
select ok((select qual from pg_catalog.pg_policies where schemaname = 'app' and tablename = 'records' and policyname = 'records_read') like '%= ANY (ARRAY( SELECT private.project_ids_with%',
  'records_read evaluates the project set once as an array');
select ok((select qual from pg_catalog.pg_policies where schemaname = 'app' and tablename = 'time_entries' and policyname = 'time_entries_read') like '%= ANY (ARRAY( SELECT private.my_membership_ids%',
  'time_entries_read evaluates the membership set once as an array');
select has_index('app', 'records', 'records_created_at_idx', 'records are listed newest first through an index');
select has_index('app', 'time_entries', 'time_entries_project_clock_in_idx', 'a project''s time entries are listed newest first through an index');

select * from finish();
rollback;
