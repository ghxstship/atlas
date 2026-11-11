-- pgTAP: 6558, budget lines as an import wizard target (B13, RRR-237, gap G-214). The target and destination listed; the
-- destination guard; authority on the budget's project, never org-wide; the strong key on line_number; undo soft-deletes
-- created lines and keeps a line a later snapshot or shift references; no old overloads.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select no_plan();

create function pg_temp.path(p_person text) returns text
language sql as $$ select pg_temp.id(p_person) || '/' || gen_random_uuid() || '.csv' $$;
grant execute on function pg_temp.path(text) to public;

select pg_temp.as_user('carol');
with x as (insert into app.budgets (project_id, name, currency_code) values (pg_temp.id('prj_a'), 'Import Budget', 'USD') returning id) insert into world select 'bud', id from x;
with x as (insert into app.budgets (project_id, name, currency_code) values (pg_temp.id('prj_a2'), 'Winter Budget', 'USD') returning id) insert into world select 'bud_a2', id from x;
with x as (insert into app.budget_lines (budget_id, line_number, description, urid, quantity, unit_price_minor, xyz, xyz_basis)
  values (pg_temp.id('bud'), 1, 'Stage deck.', '5000.04.02', 1, 1000, 'X', 'Declared') returning id) insert into world select 'l1', id from x;

-- Target and destination --------------------------------------------------------------------------------------------------
select is((select destination from app.import_targets where code = 'budget_lines'), 'budget_id', 'budget_lines has destination budget_id');
select is((select write_capability from app.import_targets where code = 'budget_lines'), 'finance.budget.write', 'authorized by finance.budget.write');
select ok((select bool_and(required) from app.import_target_fields where target_code = 'budget_lines' and field_name in ('description', 'urid')),
  'description and urid are required');
select is((select field_name from app.import_target_fields where target_code = 'budget_lines' and strong_key), 'line_number', 'line_number is the strong key');
select ok(exists (select 1 from app.import_destinations(pg_temp.id('org_a'), 'budget_lines') d where d.destination_id = pg_temp.id('bud')), 'budgets are listed as destinations');

-- No overloads remain.
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private' and p.proname = 'import_job_allowed'), 1,
  'no old overload of private.import_job_allowed');
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and p.proname = 'import_detected_sheet'), 1,
  'no old overload of app.import_detected_sheet');

-- The destination guard ----------------------------------------------------------------------------------------------------
select throws_ok(format($$insert into app.import_jobs (org_id, target_code, source, original_filename, storage_object_path)
  values (%L, 'budget_lines', 'CSV', 'lines.csv', %L)$$, pg_temp.id('org_a'), pg_temp.path('carol')),
  'XR001', 'import_destination_required: Choose the budget the lines go into.', 'a budget line import names its budget');
select throws_ok(format($$insert into app.import_jobs (org_id, target_code, source, original_filename, storage_object_path, budget_id, project_id)
  values (%L, 'budget_lines', 'CSV', 'lines.csv', %L, %L, %L)$$, pg_temp.id('org_a'), pg_temp.path('carol'), pg_temp.id('bud'), pg_temp.id('prj_a')),
  'XR001', 'import_destination_unexpected: A budget line import names a budget, not a project or a running order.', 'and nothing else');
select throws_ok(format($$insert into app.import_jobs (org_id, target_code, source, original_filename, storage_object_path, budget_id)
  values (%L, 'venues', 'CSV', 'venues.csv', %L, %L)$$, pg_temp.id('org_a'), pg_temp.path('carol'), pg_temp.id('bud')),
  'XR001', 'import_destination_unexpected: This target imports into the whole organization; it names no budget.', 'an org-wide target names no budget');

-- Authority on the budget's project -----------------------------------------------------------------------------------------
with x as (insert into app.import_jobs (org_id, target_code, source, original_filename, storage_object_path, budget_id)
  values (pg_temp.id('org_a'), 'budget_lines', 'CSV', 'lines.csv', pg_temp.path('carol'), pg_temp.id('bud')) returning id) insert into world select 'job', id from x;
select pg_temp.as_user('frank');
select throws_ok(format($$insert into app.import_jobs (org_id, target_code, source, original_filename, storage_object_path, budget_id)
  values (%L, 'budget_lines', 'CSV', 'lines.csv', %L, %L)$$, pg_temp.id('org_a'), pg_temp.path('frank'), pg_temp.id('bud')),
  '42501', null, 'a Field member without finance.budget.write cannot import');
select is_empty(format($$select 1 from app.import_jobs where id = '%s'$$, pg_temp.id('job')), 'nor read the import');
select pg_temp.as_user('xavier');
select throws_ok(format($$insert into app.import_jobs (org_id, target_code, source, original_filename, storage_object_path, budget_id)
  values (%L, 'budget_lines', 'CSV', 'lines.csv', %L, %L)$$, pg_temp.id('org_a'), pg_temp.path('xavier'), pg_temp.id('bud')),
  '42501', null, 'cross tenant: refused');

-- Strong key, commit and undo ------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
update app.import_jobs set import_status = 'Detected' where id = pg_temp.id('job');
update app.import_jobs set import_status = 'Mapped', mapping_confirmed_at = now() where id = pg_temp.id('job');
select is(app.import_strong_key_match(pg_temp.id('job'), '{"line_number": 1}'::jsonb), pg_temp.id('l1'), 'the strong key finds the line of the destination budget');
select is(app.import_strong_key_match(pg_temp.id('job'), '{"line_number": 99}'::jsonb), null::uuid, 'and nothing for an unused number');
insert into world select 'r_new', app.record_import_row(pg_temp.id('job'), 'Sheet1', 2, 'Valid');
insert into world select 'r_kept', app.record_import_row(pg_temp.id('job'), 'Sheet1', 3, 'Valid');
insert into world select 'r_snap', app.record_import_row(pg_temp.id('job'), 'Sheet1', 4, 'Valid');
update app.import_jobs set import_status = 'Validated' where id = pg_temp.id('job');
select pg_temp.as_user('carol');
insert into world select 'batch', app.request_import_commit(pg_temp.id('job'));
select pg_temp.as_platform();
alter table app.budget_lines disable trigger t90_stamp_audit_columns;
with x as (insert into app.budget_lines (budget_id, line_number, description, urid, line_type, quantity, unit_price_minor, xyz, xyz_basis, created_at, updated_at)
  values (pg_temp.id('bud'), 2, 'Imported.', '5000.04.02', 'Cost', 1, null, 'X', 'Declared', now() - interval '2 hours', now() - interval '2 hours') returning id) insert into world select 'imp1', id from x;
with x as (insert into app.budget_lines (budget_id, line_number, description, urid, line_type, quantity, unit_price_minor, xyz, xyz_basis, created_at, updated_at)
  values (pg_temp.id('bud'), 3, 'Imported, then staffed.', '5000.51.02', 'Labor', 1, 100, 'X', 'Declared', now() - interval '2 hours', now() - interval '2 hours') returning id) insert into world select 'imp2', id from x;
with x as (insert into app.budget_lines (budget_id, line_number, description, urid, line_type, quantity, unit_price_minor, xyz, xyz_basis, created_at, updated_at)
  values (pg_temp.id('bud'), 4, 'Imported, then captured.', '5000.04.02', 'Cost', 1, 100, 'X', 'Declared', now() - interval '2 hours', now() - interval '2 hours') returning id) insert into world select 'imp3', id from x;
alter table app.budget_lines enable trigger t90_stamp_audit_columns;
select app.commit_import_write(pg_temp.id('r_new'), pg_temp.id('batch'), pg_temp.id('imp1'), 'Created');
select app.commit_import_write(pg_temp.id('r_kept'), pg_temp.id('batch'), pg_temp.id('imp2'), 'Created');
select app.commit_import_write(pg_temp.id('r_snap'), pg_temp.id('batch'), pg_temp.id('imp3'), 'Created');
select app.finish_import_batch(pg_temp.id('batch'));
update app.import_batches set committed_at = now() - interval '1 hour' where id = pg_temp.id('batch');
with x as (insert into app.budget_lines (budget_id, line_number, description, urid, quantity, unit_price_minor, xyz, xyz_basis)
  values (pg_temp.id('bud_a2'), 1, 'Elsewhere.', '5000.04.02', 1, 100, 'X', 'Declared') returning id) insert into world select 'other_line', id from x;
select throws_ok(format($$select app.commit_import_write('%s', '%s', '%s', 'Updated', '{"description": "x"}')$$, pg_temp.id('r_new'), pg_temp.id('batch'), pg_temp.id('other_line')),
  'XR001', null, 'a line of another budget is never written');

-- A later shift and a later snapshot reference two of the created lines: undo keeps them.
select pg_temp.as_user('carol');
insert into app.shifts (project_id, membership_id, role_code, starts_at, ends_at, time_zone, budget_line_id)
values (pg_temp.id('prj_a'), pg_temp.id('frank@org_a'), '5000.51.02', '2027-09-06 12:00+00', '2027-09-06 13:00+00', 'America/New_York', pg_temp.id('imp2'));
select app.snapshot_budget(pg_temp.id('bud'), 'After the import');
select is((select reverted from app.undo_import_batch(pg_temp.id('batch'), 'Wrong sheet.')), 0,
  'a snapshot captures every live line, so undo keeps them all and says why');
select pg_temp.as_platform();
select ok((select deleted_at is null from app.budget_lines where id = pg_temp.id('imp2')), 'a line a later shift references is kept');
select ok((select deleted_at is null from app.budget_lines where id = pg_temp.id('imp3')), 'a line a later snapshot references is kept');
select is((select count(*)::int from app.import_row_results where id in (pg_temp.id('r_kept'), pg_temp.id('r_snap')) and undo_reason is not null), 2, 'with the reason recorded');

-- With no later reference, undo soft-deletes the created line.
select pg_temp.as_user('carol');
with x as (insert into app.import_jobs (org_id, target_code, source, original_filename, storage_object_path, budget_id)
  values (pg_temp.id('org_a'), 'budget_lines', 'CSV', 'more.csv', pg_temp.path('carol'), pg_temp.id('bud')) returning id) insert into world select 'job2', id from x;
select pg_temp.as_platform();
update app.import_jobs set import_status = 'Detected' where id = pg_temp.id('job2');
update app.import_jobs set import_status = 'Mapped', mapping_confirmed_at = now() where id = pg_temp.id('job2');
insert into world select 'r2', app.record_import_row(pg_temp.id('job2'), 'Sheet1', 2, 'Valid');
update app.import_jobs set import_status = 'Validated' where id = pg_temp.id('job2');
select pg_temp.as_user('carol');
insert into world select 'batch2', app.request_import_commit(pg_temp.id('job2'));
select pg_temp.as_platform();
alter table app.budget_lines disable trigger t90_stamp_audit_columns;
with x as (insert into app.budget_lines (budget_id, line_number, description, urid, line_type, quantity, unit_price_minor, xyz, xyz_basis, created_at, updated_at)
  values (pg_temp.id('bud'), 5, 'Second import.', '5000.04.02', 'Cost', 1, 100, 'X', 'Declared', now() - interval '2 hours', now() - interval '2 hours') returning id) insert into world select 'imp4', id from x;
alter table app.budget_lines enable trigger t90_stamp_audit_columns;
select app.commit_import_write(pg_temp.id('r2'), pg_temp.id('batch2'), pg_temp.id('imp4'), 'Created');
select app.finish_import_batch(pg_temp.id('batch2'));
update app.import_batches set committed_at = now() - interval '1 hour' where id = pg_temp.id('batch2');
select pg_temp.as_user('carol');
select is((select reverted from app.undo_import_batch(pg_temp.id('batch2'), 'Wrong sheet.')), 1, 'undo reverts the created line');
select pg_temp.as_platform();
select ok((select deleted_at is not null from app.budget_lines where id = pg_temp.id('imp4')), 'undo soft-deletes it');

select * from finish();
rollback;
