-- pgTAP: migration 1512, report rows readable on a read replica (A94, RRR-139, finding A65-032, Section 5.1).
-- app.report_run_rows is stable, so PostgREST serves it as GET, the only way a read replica runs an RPC. A replica is
-- a hot standby that runs only read-only transactions; here the worker reads a running run's rows inside a read-only
-- transaction and gets what it gets on the primary, as the person the run is for. Grants and comment are unchanged.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(7);

create temporary table k (key text primary key, id uuid);
grant select, insert on k to public;

create function pg_temp.as_worker() returns void
language plpgsql as $$
begin
  perform pg_temp.as_platform();
  perform set_config('role', 'service_role', true);
end $$;

select is((select provolatile::text from pg_proc where oid = 'app.report_run_rows(uuid,text[],integer)'::regprocedure), 's',
  'report_run_rows is stable, so PostgREST serves it as GET');
select ok(has_function_privilege('service_role', 'app.report_run_rows(uuid,text[],integer)', 'execute')
          and not has_function_privilege('authenticated', 'app.report_run_rows(uuid,text[],integer)', 'execute')
          and not has_function_privilege('anon', 'app.report_run_rows(uuid,text[],integer)', 'execute'),
  'only the worker may call it, as before');
select isnt(obj_description('app.report_run_rows(uuid,text[],integer)'::regprocedure, 'pg_proc'), null, 'its comment is kept');

-- A records report by carol, run for dave (a member of prj_a), started by the worker on the primary.
select pg_temp.as_platform();
insert into app.records (project_id, record_kind, record_subtype, title, xyz, xyz_basis) values
  (pg_temp.id('prj_a'), 'Task', 'Execute', 'Install the truss', 'Y', 'Declared'),
  (pg_temp.id('prj_a'), 'Task', 'Execute', 'Inspect the truss', 'Y', 'Declared'),
  (pg_temp.id('prj_b'), 'Task', 'Execute', 'Install the pier truss', 'Y', 'Declared');
select pg_temp.as_user('carol');
insert into app.report_definitions (membership_id, name, source_code) values (pg_temp.id('carol@org_a'), 'Truss Work', 'records');
insert into k (key, id) select 'rep', id from app.report_definitions where name = 'Truss Work';
insert into app.report_fields (report_definition_id, field, aggregate, position)
values ((select id from k where key = 'rep'), 'title', 'None', 1);
insert into app.report_filters (report_definition_id, field, operator, value_text)
values ((select id from k where key = 'rep'), 'title', 'contains', 'truss');
select pg_temp.as_platform();
insert into app.report_runs (report_definition_id, run_for_membership_id, export_format)
values ((select id from k where key = 'rep'), pg_temp.id('dave@org_a'), 'CSV');
insert into k (key, id) select 'run', id from app.report_runs where report_definition_id = (select id from k where key = 'rep');
select pg_temp.as_worker();
select app.start_report_run((select id from k where key = 'run'));
create temporary table primary_rows as
  select r from app.report_run_rows((select id from k where key = 'run'), array['title', 'project_id'], 1000) r;
grant select on primary_rows to public;

-- From here on the transaction is read-only, as every transaction on a replica is.
set local transaction_read_only = on;
select is(current_setting('transaction_read_only'), 'on', 'the transaction is read-only, like a replica');
select pg_temp.as_worker();
select is(
  (select array_agg(r order by r ->> 'title') from app.report_run_rows((select id from k where key = 'run'), array['title', 'project_id'], 1000) r),
  (select array_agg(r order by r ->> 'title') from primary_rows),
  'the read-only read returns exactly the rows the primary read returned');
select is((select count(*)::integer from primary_rows), 2, 'which are the member''s truss records, as the person the run is for');
select is(current_user::text, 'service_role', 'and the worker''s role is restored after it');

select * from finish();
rollback;
