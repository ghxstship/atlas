-- pgTAP: the report.run worker (A35, RRR-79). A run reads its source rows as the person it runs for
-- (their row level security, never the service role's reach), only the worker drives a run through
-- Queued, Running and Succeeded or Failed, a finished run names its own result file, and only the
-- person a run is for reads that file in the private report-results bucket.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(31);

create temporary table k (key text primary key, id uuid);
grant select, insert on k to public;

create function pg_temp.new_record(p_project text, p_title text) returns uuid
language plpgsql as $$
declare v uuid;
begin
  insert into app.records (project_id, record_kind, record_subtype, title, xyz, xyz_basis)
  values (pg_temp.id(p_project), 'Task', 'Execute', p_title, 'Y', 'Declared') returning id into v;
  return v;
end $$;

create function pg_temp.as_worker() returns void
language plpgsql as $$
begin
  perform pg_temp.as_platform();
  perform set_config('role', 'service_role', true);
end $$;

create function pg_temp.new_run(p_member text, p_format app.export_format default 'CSV') returns uuid
language plpgsql as $$
declare v uuid;
begin
  perform pg_temp.as_platform();
  insert into app.report_runs (report_definition_id, run_for_membership_id, export_format)
  values ((select id from k where key = 'rep'), pg_temp.id(p_member), p_format) returning id into v;
  return v;
end $$;

-- World: records in prj_a (dave is a member), prj_a2 (no members) and org_b's prj_b; a records report
-- by carol filtered to titles containing "truss".
select pg_temp.as_platform();
select pg_temp.new_record('prj_a', 'Install the truss');
select pg_temp.new_record('prj_a', 'Inspect the truss');
select pg_temp.new_record('prj_a', 'Verify the rigging plan');
select pg_temp.new_record('prj_a2', 'Install the gala truss');
select pg_temp.new_record('prj_b', 'Install the pier truss');
select pg_temp.as_user('carol');
insert into app.report_definitions (membership_id, name, source_code) values (pg_temp.id('carol@org_a'), 'Truss Work', 'records');
insert into k (key, id) select 'rep', id from app.report_definitions where name = 'Truss Work';
insert into app.report_fields (report_definition_id, field, aggregate, position)
values ((select id from k where key = 'rep'), 'title', 'None', 1);
insert into app.report_filters (report_definition_id, field, operator, value_text)
values ((select id from k where key = 'rep'), 'title', 'contains', 'truss');

insert into k (key, id) values ('dave_run', pg_temp.new_run('dave@org_a')), ('carol_run', pg_temp.new_run('carol@org_a'));

-- Storage ------------------------------------------------------------------------------------------------------
select is((select public from storage.buckets where id = 'report-results'), false, 'the report-results bucket is private');
select is((select allowed_mime_types from storage.buckets where id = 'report-results'), array['text/csv'], 'it takes CSV only');
select is(private.report_result_run(private.report_result_path(pg_temp.id('org_a'), (select id from k where key = 'dave_run'))),
  (select id from k where key = 'dave_run'), 'a result file name names its run');
select is(private.report_result_run('elsewhere/file.csv'), null::uuid, 'any other name names no run');

-- Only the worker drives runs ------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select throws_ok($$select app.start_report_run((select id from k where key = 'carol_run'))$$, '42501', null,
  'a person cannot start a run');
select throws_ok($$select * from app.report_run_rows((select id from k where key = 'carol_run'), array['title'], 10)$$, '42501', null,
  'a person cannot read rows through the worker API');
select throws_ok($$select app.finish_report_run((select id from k where key = 'carol_run'), 'Succeeded', 'x', 0, 0)$$, '42501', null,
  'a person cannot finish a run');
select pg_temp.as_anon();
select throws_ok($$select app.start_report_run((select id from k where key = 'carol_run'))$$, '42501', null, 'anon cannot start a run');

select pg_temp.as_worker();
select throws_ok($$select * from app.report_run_rows((select id from k where key = 'dave_run'), array['title'], 10)$$, 'XR001', null,
  'rows are read only for a running run');
select lives_ok($$select app.start_report_run((select id from k where key = 'dave_run'))$$, 'the worker starts a queued run');
select is((select run_status from app.report_runs where id = (select id from k where key = 'dave_run')), 'Running'::app.run_status,
  'the run is Running');
select throws_ok($$select app.start_report_run((select id from k where key = 'dave_run'))$$, 'XR001', null,
  'a running run cannot start again');

-- Rows as the person ---------------------------------------------------------------------------------------------
select pg_temp.as_worker();
create temporary table dave_rows as
  select r from app.report_run_rows((select id from k where key = 'dave_run'), array['title', 'project_id'], 1000) r;
grant select on dave_rows to public;
select is(current_user::text, 'service_role', 'the worker''s role is restored after the read');
select is((select count(*)::integer from dave_rows), 2, 'a member''s run reads only the truss records of projects they belong to');
select is((select count(*)::integer from dave_rows where (r ->> 'project_id')::uuid <> pg_temp.id('prj_a')), 0,
  'it never reads a project the member is not on');
select is((select count(*)::integer from dave_rows where r ->> 'title' not ilike '%truss%'), 0, 'the report''s filter applies');
select pg_temp.as_user('dave');
select is((select count(*)::integer from dave_rows),
  (select count(*)::integer from app.records where title ilike '%truss%' and org_id = pg_temp.id('org_a')),
  'the run sees exactly what the member sees signed in');

select pg_temp.as_worker();
select app.start_report_run((select id from k where key = 'carol_run'));
select is((select count(*)::integer from app.report_run_rows((select id from k where key = 'carol_run'), array['title', 'project_id'], 1000)), 3,
  'a manager''s run reads every truss record of the org and none of another tenant''s');
select is((select count(*)::integer from app.report_run_rows((select id from k where key = 'carol_run'), array['title'], 1)), 1,
  'the row limit holds');
select throws_ok($$select * from app.report_run_rows((select id from k where key = 'carol_run'), array['secret_column'], 10)$$, 'XR001', null,
  'a column the source does not have is refused');

-- Finishing -------------------------------------------------------------------------------------------------------
select throws_ok($$select app.finish_report_run((select id from k where key = 'dave_run'), 'Succeeded', 'other/file.csv', 2, 0)$$, 'XR001', null,
  'a finished run names its own result file');
select throws_ok(format($$select app.finish_report_run(%L, 'Succeeded', %L, null, 0)$$, (select id from k where key = 'dave_run'),
  private.report_result_path(pg_temp.id('org_a'), (select id from k where key = 'dave_run'))), 'XR001', null,
  'a finished run records its counts');
select lives_ok(format($$select app.finish_report_run(%L, 'Succeeded', %L, 2, 0)$$, (select id from k where key = 'dave_run'),
  private.report_result_path(pg_temp.id('org_a'), (select id from k where key = 'dave_run'))), 'the worker records a finished run');
select ok((select run_status = 'Succeeded' and finished_at is not null and row_count = 2 and unpriced_count = 0
           from app.report_runs where id = (select id from k where key = 'dave_run')), 'the run is Succeeded with its counts');
select throws_ok($$select app.finish_report_run((select id from k where key = 'dave_run'), 'Failed', null, null, null, 'late')$$, 'XR001', null,
  'a finished run cannot finish again');
select throws_ok($$select app.finish_report_run((select id from k where key = 'carol_run'), 'Failed')$$, 'XR001', null,
  'a failed attempt records why');
select app.finish_report_run((select id from k where key = 'carol_run'), 'Queued', null, null, null, 'Storage was unavailable.');
select ok((select run_status = 'Queued' and finished_at is null and last_error = 'Storage was unavailable.'
           from app.report_runs where id = (select id from k where key = 'carol_run')), 'an attempt with retries left goes back to Queued');
select app.start_report_run((select id from k where key = 'carol_run'));
select app.finish_report_run((select id from k where key = 'carol_run'), 'Failed', null, null, null, 'Storage was unavailable.');
select ok((select run_status = 'Failed' and finished_at is not null from app.report_runs where id = (select id from k where key = 'carol_run')),
  'the last attempt marks the run Failed');

-- Only the run's person reads its file ---------------------------------------------------------------------------
select pg_temp.as_platform();
insert into storage.objects (bucket_id, name)
values ('report-results', private.report_result_path(pg_temp.id('org_a'), (select id from k where key = 'dave_run')));
select pg_temp.as_user('dave');
select is((select count(*)::integer from storage.objects where bucket_id = 'report-results'), 1, 'the person a run is for reads its file');
select pg_temp.as_user('carol');
select is((select count(*)::integer from storage.objects where bucket_id = 'report-results'), 0, 'the report''s owner does not read another person''s run');
select pg_temp.as_user('dave');
select throws_ok(format($$insert into storage.objects (bucket_id, name) values ('report-results', %L)$$,
  pg_temp.id('org_a')::text || '/' || (select id from k where key = 'carol_run')::text || '.csv'), '42501', null,
  'nobody writes result files through the API');

select * from finish();
rollback;
