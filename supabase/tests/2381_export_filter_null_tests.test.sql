-- pgTAP: exports keep the filters a page applies by default (A102, RRR-146, review finding 3; migrations 2380 and
-- 2381). An export filter can keep the rows whose column is unset (is_null) or set (not_null): it names a column of
-- the source and no value, the column counts toward the classification, and the worker reads only those rows. So
-- the Projects export leaves out the archived projects the page hides, and shows only them when asked.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(12);

create temporary table k (key text primary key, id uuid);
grant select, insert, update on k to public;

-- World: NWX is archived, NWL is not.
select pg_temp.as_platform();
update app.projects set archived_at = now() where id = pg_temp.id('prj_a2');

-- Requesting ------------------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
insert into k values ('live', app.request_export(pg_temp.id('org_a'), 'CSV', 'Projects',
  array['app.projects.project_key', 'app.projects.name'], array['Key', 'Name'],
  '[{"operator":"is_null","column":"archived_at"}]'::jsonb));
insert into k values ('archived', app.request_export(pg_temp.id('org_a'), 'CSV', 'Archived projects',
  array['app.projects.project_key'], null,
  '[{"operator":"not_null","column":"archived_at","value":null}]'::jsonb));
insert into k values ('all', app.request_export(pg_temp.id('org_a'), 'CSV', 'All projects',
  array['app.projects.project_key'], null, null));
select results_eq($$select column_name, filter_operator::text, value_text from app.export_job_filters
  where export_job_id in (select id from k where key in ('live', 'archived')) order by filter_operator$$,
  $$values ('archived_at'::text, 'is_null'::text, null::text), ('archived_at', 'not_null', null)$$,
  'a null test is recorded with its column and no value');

select throws_ok($$select app.request_export(pg_temp.id('org_a'), 'CSV', 'Projects', array['app.projects.name'], null, '[{"operator":"is_null","column":"archived_at","value":"x"}]')$$,
  'XR001', 'export_filters: An is_null or not_null filter compares no value.', 'a null test compares no value');
select throws_ok($$select app.request_export(pg_temp.id('org_a'), 'CSV', 'Projects', array['app.projects.name'], null, '[{"operator":"is_null"}]')$$,
  'XR001', 'export_filter_column: app.projects has no column  to filter on.', 'a null test names a column');
select throws_ok($$select app.request_export(pg_temp.id('org_a'), 'CSV', 'Projects', array['app.projects.name'], null, '[{"operator":"not_null","column":"retired_at"}]')$$,
  'XR001', 'export_filter_column: app.projects has no column retired_at to filter on.', 'of the source');
select throws_ok($$select app.request_export(pg_temp.id('org_a'), 'CSV', 'Projects', array['app.projects.name'], null, '[{"operator":"eq","column":"name"}]')$$,
  'XR001', 'export_filters: Each filter has an operator (eq, in or search) and a value of 1 to 1000 characters.', 'every other filter still has a value');
select throws_ok($$select app.request_export(pg_temp.id('org_a'), 'CSV', 'Projects', array['app.projects.name'], null, '[{"operator":"lt","column":"name","value":"x"}]')$$,
  'XR001', 'export_filters: Each filter has an operator (eq, in, search, is_null or not_null).', 'and the operators are those five');

-- The table holds the same rule for anything written past the function.
select pg_temp.as_platform();
select throws_ok(format($$insert into app.export_job_filters (org_id, export_job_id, column_name, filter_operator, value_text)
  values (%L, %L, 'archived_at', 'is_null', 'x')$$, pg_temp.id('org_a'), (select id from k where key = 'live')),
  '23514', null, 'a stored null test has no value');
select throws_ok(format($$insert into app.export_job_filters (org_id, export_job_id, column_name, filter_operator, value_text)
  values (%L, %L, 'name', 'eq', null)$$, pg_temp.id('org_a'), (select id from k where key = 'live')),
  '23514', null, 'and a stored eq has one');

-- A filtered column counts toward the classification: a null test on the Restricted rate asks for step-up.
select pg_temp.as_user('alice');
select throws_ok($$select app.request_export(pg_temp.id('org_a'), 'CSV', 'Rates', array['app.rate_card_lines_masked.role_code'], null, '[{"operator":"not_null","column":"rate_minor"}]')$$,
  'XR001', 'step_up_required: Exporting Restricted columns needs step-up authentication.', 'a null test on a Restricted column discloses it, so it asks for step-up');

-- The worker reads the rows each test keeps ---------------------------------------------------------------------------
select pg_temp.as_platform();
select set_config('role', 'service_role', true);
create temporary table claimed as select * from app.claim_export_renders('worker-1', 20);
select results_eq($$select array_agg(r ->> 'project_key' order by r ->> 'project_key') from jsonb_array_elements(app.export_job_rows((select id from k where key = 'live'), 100)) r
    where r ->> 'project_key' in ('NWL', 'NWX')$$,
  $$values (array['NWL'])$$, 'is_null leaves out the archived project, as the Projects page does');
select results_eq($$select array_agg(r ->> 'project_key' order by r ->> 'project_key') from jsonb_array_elements(app.export_job_rows((select id from k where key = 'archived'), 100)) r
    where r ->> 'project_key' in ('NWL', 'NWX')$$,
  $$values (array['NWX'])$$, 'not_null keeps only the archived project');
select results_eq($$select array_agg(r ->> 'project_key' order by r ->> 'project_key') from jsonb_array_elements(app.export_job_rows((select id from k where key = 'all'), 100)) r
    where r ->> 'project_key' in ('NWL', 'NWX')$$,
  $$values (array['NWL', 'NWX'])$$, 'without one, both are exported (Projects with ?archived=1)');

select * from finish();
rollback;
