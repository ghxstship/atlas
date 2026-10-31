-- pgTAP: P3 rundown and guest list import (2800 to 2802, RRR-217, Section 4.6.2). Cues and guest list entries are
-- import targets that name a running order or a project; the destination guard; project-only access through
-- membership (create, read, commit, undo) and its denials; org-wide targets as before; outside orgs holding a record
-- grant reach no org-level import config (C4); app.import_destinations (C6); app.import_detected_sheet with a
-- destination; guest fuzzy candidates within the project; exact strong keys with NULL shows and times (C9); the
-- column samples, their readers and purges (C1, C3); separation of duties for imported guests (C7); undo keeping a
-- called cue and a decided guest; the Trash sync unchanged.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(77);

create function pg_temp.path(p_person text) returns text
language sql as $$ select pg_temp.id(p_person) || '/' || gen_random_uuid() || '.csv' $$;

create function pg_temp.cue_job(p_person text, p_ros text) returns uuid
language plpgsql as $$
declare
  v_id uuid;
begin
  perform pg_temp.as_user(p_person);
  insert into app.import_jobs (org_id, target_code, source, original_filename, storage_object_path, run_of_show_id)
  values (pg_temp.id('org_a'), 'cues', 'CSV', 'rundown.csv', pg_temp.path(p_person), pg_temp.id(p_ros)) returning id into v_id;
  perform pg_temp.as_platform();
  return v_id;
end $$;

create function pg_temp.guest_job(p_person text, p_project text) returns uuid
language plpgsql as $$
declare
  v_id uuid;
begin
  perform pg_temp.as_user(p_person);
  insert into app.import_jobs (org_id, target_code, source, original_filename, storage_object_path, project_id)
  values (pg_temp.id('org_a'), 'guest_list_entries', 'CSV', 'guests.csv', pg_temp.path(p_person), pg_temp.id(p_project)) returning id into v_id;
  perform pg_temp.as_platform();
  return v_id;
end $$;

-- Detection as the worker: Detected, one column per header, samples, then Mapped.
create function pg_temp.detect(p_job uuid, p_headers text[], p_fields text[]) returns void
language plpgsql as $$
begin
  perform pg_temp.as_platform();
  update app.import_jobs set import_status = 'Detected' where id = p_job;
  insert into app.import_job_columns (import_job_id, sheet_name, column_index, header, suggested_field_name)
  select p_job, 'Sheet1', i - 1, p_headers[i], p_fields[i] from generate_subscripts(p_headers, 1) i;
  perform app.record_import_column_samples(p_job, (
    select jsonb_agg(jsonb_build_object('import_job_column_id', c.id, 'sample_index', n, 'sample_value', c.header || ' ' || n))
    from app.import_job_columns c cross join generate_series(1, 3) n where c.import_job_id = p_job));
  update app.import_jobs set import_status = 'Mapped' where id = p_job;
end $$;

create function pg_temp.samples(p_job uuid) returns integer
language plpgsql as $$
begin
  perform pg_temp.as_platform();
  return (select count(*)::integer from private.import_column_samples s
    join app.import_job_columns c on c.id = s.import_job_column_id where c.import_job_id = p_job);
end $$;

-- World: running orders, cues and guests ---------------------------------------------------------------------------
select pg_temp.as_platform();
with x as (insert into app.run_of_show (project_id, scope_node_id, name, show_date)
  values (pg_temp.id('prj_a'), pg_temp.id('show_a'), 'Opening Night', '2026-11-14') returning id) insert into world select 'ros_a', id from x;
with x as (insert into app.run_of_show (project_id, name, show_date)
  values (pg_temp.id('prj_a2'), 'Gala Night', '2026-12-31') returning id) insert into world select 'ros_a2', id from x;
with x as (insert into app.run_of_show (project_id, name, show_date, deleted_at)
  values (pg_temp.id('prj_a'), 'Canceled Matinee', '2026-11-15', now()) returning id) insert into world select 'ros_dead', id from x;
with x as (insert into app.run_of_show (project_id, name, show_date)
  values (pg_temp.id('prj_b'), 'Pier Night', '2026-11-20') returning id) insert into world select 'ros_b', id from x;
with x as (insert into app.cues (run_of_show_id, position, label)
  values (pg_temp.id('ros_a'), 1, 'House to half') returning id) insert into world select 'cue_1', id from x;
with x as (insert into app.cues (run_of_show_id, position, label, planned_at)
  values (pg_temp.id('ros_a'), 3, 'Walk-in music', '2026-11-14 19:00-05') returning id) insert into world select 'cue_timed', id from x;
with x as (insert into app.cues (run_of_show_id, position, label)
  values (pg_temp.id('ros_a2'), 1, 'Doors') returning id) insert into world select 'cue_a2', id from x;
with x as (insert into app.guest_list_entries (project_id, scope_node_id, guest_name)
  values (pg_temp.id('prj_a'), pg_temp.id('show_a'), 'Jordan Pike') returning id) insert into world select 'guest_show', id from x;
with x as (insert into app.guest_list_entries (project_id, guest_name)
  values (pg_temp.id('prj_a'), 'Riley Chen') returning id) insert into world select 'guest_whole', id from x;
with x as (insert into app.guest_list_entries (project_id, guest_name)
  values (pg_temp.id('prj_a2'), 'Jordan Pike') returning id) insert into world select 'guest_a2', id from x;
create temporary table trash_before as select table_name from private.trash_tables;
grant select on trash_before to public;

-- 1. Targets and fields ------------------------------------------------------------------------------------------
select results_eq($$select code, write_capability, destination from app.import_targets order by sort_order$$,
  $$values ('venues', 'places.venue.write', null::text), ('counterparties', 'vendors.vendor.write', null),
    ('vendor_products', 'vendors.vendor.write', null), ('asset_units', 'assets.asset.write', null),
    ('cues', 'show.run_of_show.write', 'run_of_show_id'), ('guest_list_entries', 'advancing.rider.write', 'project_id')$$,
  'cues and guest list entries follow the four org-wide targets, each naming its destination');
select set_eq($$select field_name, required, strong_key from app.import_target_fields where target_code = 'cues'$$,
  $$values ('position', false, true), ('label', true, false), ('segment', false, false), ('description', false, false),
    ('planned_at', false, false), ('duration', false, false), ('space_id', false, false)$$,
  'cue fields: the position is the strong key, the label is required');
select set_eq($$select field_name, required, strong_key from app.import_target_fields where target_code = 'guest_list_entries'$$,
  $$values ('guest_name', true, true), ('plus_ones', false, false), ('note', false, false), ('scope_node_id', false, false),
    ('counterparty_id', false, false)$$,
  'guest fields: no state, decision or check-in field is importable');

-- 2. The destination guard -----------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select throws_ok(format($$insert into app.import_jobs (org_id, target_code, source, original_filename, storage_object_path)
  values (%L, 'cues', 'CSV', 'rundown.csv', %L)$$, pg_temp.id('org_a'), pg_temp.path('dave')),
  'XR001', 'import_destination_required: Choose the running order the rows go into.', 'a cue import names its running order');
select throws_ok(format($$insert into app.import_jobs (org_id, target_code, source, original_filename, storage_object_path, project_id)
  values (%L, 'cues', 'CSV', 'rundown.csv', %L, %L)$$, pg_temp.id('org_a'), pg_temp.path('dave'), pg_temp.id('prj_a')),
  'XR001', 'import_destination_unexpected: A cue import names a running order, not a project.', 'not a project');
select throws_ok(format($$insert into app.import_jobs (org_id, target_code, source, original_filename, storage_object_path, run_of_show_id)
  values (%L, 'cues', 'CSV', 'rundown.csv', %L, %L)$$, pg_temp.id('org_a'), pg_temp.path('dave'), pg_temp.id('ros_dead')),
  'XR001', 'import_destination_unknown: The running order does not exist or was deleted.', 'nor a deleted running order');
select throws_ok(format($$insert into app.import_jobs (org_id, target_code, source, original_filename, storage_object_path)
  values (%L, 'guest_list_entries', 'CSV', 'guests.csv', %L)$$, pg_temp.id('org_a'), pg_temp.path('dave')),
  'XR001', 'import_destination_required: Choose the project the rows go into.', 'a guest list import names its project');
select throws_ok(format($$insert into app.import_jobs (org_id, target_code, source, original_filename, storage_object_path, project_id, run_of_show_id)
  values (%L, 'guest_list_entries', 'CSV', 'guests.csv', %L, %L, %L)$$, pg_temp.id('org_a'), pg_temp.path('dave'), pg_temp.id('prj_a'), pg_temp.id('ros_a')),
  'XR001', 'import_destination_unexpected: A guest list import names a project, not a running order.', 'and never a running order');
select throws_ok(format($$insert into app.import_jobs (org_id, target_code, source, original_filename, storage_object_path, project_id)
  values (%L, 'venues', 'CSV', 'venues.csv', %L, %L)$$, pg_temp.id('org_a'), pg_temp.path('dave'), pg_temp.id('prj_a')),
  'XR001', 'import_destination_unexpected: This target imports into the whole organization; it names no running order or project.',
  'an org-wide target names no destination');
select lives_ok($$insert into world select 'job_cue', pg_temp.cue_job('dave', 'ros_a')$$,
  'a member holding show.run_of_show.write through project A starts a cue import into its running order');
select pg_temp.as_user('dave');
select throws_ok($$update app.import_jobs set run_of_show_id = (select id from world where key = 'ros_dead') where id = (select id from world where key = 'job_cue')$$,
  'XR001', 'import_job_immutable: An import keeps its file and target; start a new import instead.', 'the destination never changes');

-- 3. Project-only access -------------------------------------------------------------------------------------------
select is((select run_of_show_id from app.import_jobs where id = pg_temp.id('job_cue')), pg_temp.id('ros_a'), 'he reads his cue import');
select throws_ok(format($$insert into app.import_jobs (org_id, target_code, source, original_filename, storage_object_path, run_of_show_id)
  values (%L, 'cues', 'CSV', 'rundown.csv', %L, %L)$$, pg_temp.id('org_a'), pg_temp.path('dave'), pg_temp.id('ros_a2')),
  '42501', null, 'but cannot import into a running order of project B, where he is no member');
select lives_ok($$insert into world select 'job_a2', pg_temp.cue_job('carol', 'ros_a2')$$, 'a Manager imports into project B');
select pg_temp.as_platform();
update app.import_jobs set import_status = 'Validated' where id = pg_temp.id('job_a2');
with x as (insert into app.import_batches (import_job_id, committed_at)
  values (pg_temp.id('job_a2'), now()) returning id) insert into world select 'batch_a2', id from x;
select pg_temp.as_user('dave');
select is((select count(*)::int from app.import_jobs where id = pg_temp.id('job_a2')), 0, 'the member cannot see that import');
select throws_ok($$select app.request_import_commit((select id from world where key = 'job_a2'))$$, '42501', null, 'nor commit it');
select throws_ok($$select app.undo_import_batch((select id from world where key = 'batch_a2'), 'Wrong file.')$$, '42501', null, 'nor undo its batch');
select pg_temp.as_user('gina');
select is((select count(*)::int from app.import_jobs where id = pg_temp.id('job_cue')), 0, 'a Viewer without the project capability sees no cue import');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.import_jobs where org_id = pg_temp.id('org_a')), 0, 'another org sees none');

-- 4. Org-wide targets as before --------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
select lives_ok(format($$with x as (insert into app.import_jobs (org_id, target_code, source, original_filename, storage_object_path)
  values (%L, 'counterparties', 'CSV', 'customers.csv', %L) returning id) insert into world select 'job_cp', id from x$$, pg_temp.id('org_a'), pg_temp.path('alice')),
  'an org-wide holder of vendors.vendor.write imports counterparties as before');
select is((select count(*)::int from app.import_jobs where id = pg_temp.id('job_cp')), 1, 'and reads the import');
select pg_temp.as_user('frank');
select is((select count(*)::int from app.import_jobs where id = pg_temp.id('job_cp')), 0, 'a Field member without it does not');

-- 5. Mapping preview samples (C1, C3) ------------------------------------------------------------------------------------
select pg_temp.detect(pg_temp.id('job_cue'), array['Cue', 'Scene', 'Notes'], array['position', 'label', null]);
select pg_temp.as_user('dave');
select is((select count(*)::int from app.import_column_samples(pg_temp.id('job_cue'))), 9,
  'while the import is Mapped its creator reads three aligned samples per column');
select is((select sample_value from app.import_column_samples(pg_temp.id('job_cue')) s
  join app.import_job_columns c on c.id = s.import_job_column_id where c.column_index = 1 and s.sample_index = 2), 'Scene 2',
  'each sample keeps its column and row');
select throws_ok($$select app.record_import_column_samples((select id from world where key = 'job_cue'), '[]'::jsonb)$$, '42501', null,
  'only the worker records samples');
select is((select count(*)::int from app.import_job_columns where import_job_id = pg_temp.id('job_cue')), 3,
  'the columns of a cue import are readable through it');
select pg_temp.as_user('carol');
select is((select count(*)::int from app.import_column_samples(pg_temp.id('job_cue'))), 0,
  'another person who may work on the import gets no samples');
select pg_temp.as_platform();
select throws_ok(format($$select app.record_import_column_samples(%L, jsonb_build_array(jsonb_build_object('import_job_column_id', %L, 'sample_index', 1, 'sample_value', 'x')))$$,
  pg_temp.id('job_cue'), (select id from app.import_job_columns where import_job_id = pg_temp.id('job_a2') limit 1)),
  'XR001', null, 'a sample belongs to a column of the same import');

-- 6. A cue import end to end -----------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
update app.import_job_columns set field_name = suggested_field_name where import_job_id = pg_temp.id('job_cue');
update app.import_jobs set mapping_confirmed_at = now() where id = pg_temp.id('job_cue');
select pg_temp.as_platform();
insert into world select 'r_new', app.record_import_row(pg_temp.id('job_cue'), 'Sheet1', 2, 'Valid');
insert into world select 'r_called', app.record_import_row(pg_temp.id('job_cue'), 'Sheet1', 3, 'Valid');
insert into world select 'r_match', app.record_import_row(pg_temp.id('job_cue'), 'Sheet1', 4, 'Valid');
insert into world select 'r_other', app.record_import_row(pg_temp.id('job_cue'), 'Sheet1', 5, 'Valid');
insert into app.import_row_matches (import_row_result_id, target_id) values (pg_temp.id('r_match'), pg_temp.id('cue_1'));
update app.import_jobs set import_status = 'Validated' where id = pg_temp.id('job_cue');
select is(pg_temp.samples(pg_temp.id('job_cue')), 0, 'validation deletes the samples');
select pg_temp.as_user('dave');
select is((select creates || ' ' || updates from app.import_dry_run(pg_temp.id('job_cue'))), '3 1', 'the dry run counts the strong key match as an update');
select lives_ok($$insert into world select 'batch', app.request_import_commit((select id from world where key = 'job_cue'))$$, 'the member commits');
select pg_temp.as_platform();
alter table app.cues disable trigger t90_stamp_audit_columns;
with x as (insert into app.cues (run_of_show_id, position, label, created_at, updated_at)
  values (pg_temp.id('ros_a'), 4, 'Lights up', now() - interval '2 hours', now() - interval '2 hours') returning id) insert into world select 'cue_new', id from x;
with x as (insert into app.cues (run_of_show_id, position, label, created_at, updated_at)
  values (pg_temp.id('ros_a'), 5, 'Band walk-on', now() - interval '2 hours', now() - interval '2 hours') returning id) insert into world select 'cue_called', id from x;
update app.cues set label = 'House to half, slow', updated_at = now() - interval '2 hours' where id = pg_temp.id('cue_1');
alter table app.cues enable trigger t90_stamp_audit_columns;
select app.commit_import_write(pg_temp.id('r_new'), pg_temp.id('batch'), pg_temp.id('cue_new'), 'Created');
select app.commit_import_write(pg_temp.id('r_called'), pg_temp.id('batch'), pg_temp.id('cue_called'), 'Created');
select app.commit_import_write(pg_temp.id('r_match'), pg_temp.id('batch'), pg_temp.id('cue_1'), 'Updated', '{"label": "House to half"}');
select throws_ok($$select app.commit_import_write((select id from world where key = 'r_other'), (select id from world where key = 'batch'), (select id from world where key = 'cue_a2'), 'Updated', '{"label": "Doors"}')$$,
  'XR001', 'import_target_outside_destination: The written row must be in the running order or project the import names.',
  'a cue of another running order is never written');
select app.finish_import_batch(pg_temp.id('batch'));
update app.import_batches set committed_at = now() - interval '1 hour' where id = pg_temp.id('batch');
select pg_temp.as_user('dave');
update app.cues set called_at = now() where id = pg_temp.id('cue_called');
select results_eq($$select reverted, kept from app.undo_import_batch((select id from world where key = 'batch'), 'Wrong rundown.')$$,
  $$values (2, 1)$$, 'the member undoes the batch: a cue called after the import is kept');
select pg_temp.as_platform();
select ok((select deleted_at is not null from app.cues where id = pg_temp.id('cue_new')), 'an untouched created cue goes to Trash');
select is((select label from app.cues where id = pg_temp.id('cue_1')), 'House to half', 'an updated cue gets its before image back');
select is((select undo_reason from app.import_row_results where id = pg_temp.id('r_called')), 'The row was edited after the import.',
  'the called cue says why it was kept');

-- 7. Destinations (C6) -----------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select results_eq($$select destination_id from app.import_destinations((select id from world where key = 'org_a'), 'cues')$$,
  $$select id from world where key = 'ros_a'$$, 'the member is offered only the live running orders of his projects');
select results_eq($$select destination_id, project_id, label from app.import_destinations((select id from world where key = 'org_a'), 'guest_list_entries')$$,
  $$select pg_temp.id('prj_a'), pg_temp.id('prj_a'), 'NWL · Northwind Summer Series'$$, 'and only his projects for a guest list');
select is((select count(*)::int from app.import_destinations(pg_temp.id('org_b'), 'cues')), 0, 'nothing in an org he is not a member of');
select is((select count(*)::int from app.import_destinations(pg_temp.id('org_a'), 'venues')), 0, 'nothing for an org-wide target');
select is((select count(*)::int from app.import_destinations(pg_temp.id('org_a'), 'cues', pg_temp.id('ros_a2'))), 1,
  'a preselected running order he may not import into is not added');
select pg_temp.as_user('carol');
select is((select count(*)::int from app.import_destinations(pg_temp.id('org_a'), 'cues')), 2, 'a Manager is offered both projects');
select pg_temp.as_platform();
insert into app.run_of_show (project_id, name, show_date)
select pg_temp.id('prj_a'), 'Night ' || n, date '2027-01-01' + n from generate_series(1, 200) n;
select pg_temp.as_user('dave');
select is((select count(*)::int from app.import_destinations(pg_temp.id('org_a'), 'cues')), 200, 'at most 200 destinations, newest first');
select ok(not exists (select 1 from app.import_destinations(pg_temp.id('org_a'), 'cues') where destination_id = pg_temp.id('ros_a')),
  'so the oldest falls off the list');
select ok(exists (select 1 from app.import_destinations(pg_temp.id('org_a'), 'cues', pg_temp.id('ros_a')) where destination_id = pg_temp.id('ros_a')),
  'but a preselected one always resolves');

-- 8. Importing another detected sheet with a destination ----------------------------------------------------------------------
select lives_ok($$insert into world select 'job_guest', pg_temp.guest_job('dave', 'prj_a')$$, 'the member starts a guest list import of project A');
select pg_temp.as_platform();
update app.import_jobs set import_status = 'Mapped', sheet_name = 'Guests' where id = pg_temp.id('job_guest');
with x as (insert into app.import_job_sheets (import_job_id, sheet_name, sheet_index, header_row, first_data_row, last_row, column_count, data_row_count, proposed_target_code)
  values (pg_temp.id('job_guest'), 'Run of Show', 1, 1, 2, 9, 7, 8, 'cues') returning id) insert into world select 'sheet_run', id from x;
select pg_temp.as_user('dave');
select throws_ok($$select app.import_detected_sheet((select id from world where key = 'sheet_run'), 'cues')$$,
  'XR001', 'import_destination_required: Choose the running order the rows go into.', 'a detected sheet imported as cues names its running order');
select throws_ok($$select app.import_detected_sheet((select id from world where key = 'sheet_run'), 'cues', null, (select id from world where key = 'ros_a2'))$$,
  'XR001', 'import_target_not_allowed: You cannot import into that target in this organization.', 'one he may import into');
-- An org-wide target is checked as in 1402: the member holds assets.asset.write only where assigned, and
-- places.venue.write org-wide.
select throws_ok($$select app.import_detected_sheet((select id from world where key = 'sheet_run'), 'asset_units')$$,
  'XR001', 'import_target_not_allowed: You cannot import into that target in this organization.',
  'another sheet goes into an org-wide target only with its capability org-wide');
select pg_temp.as_platform();
select is((select count(*)::int from app.import_jobs where import_job_sheet_id = pg_temp.id('sheet_run')), 0,
  'so no import of it is created');
select pg_temp.as_user('dave');
insert into world select 'job_sheet', app.import_detected_sheet(pg_temp.id('sheet_run'), 'cues', null, pg_temp.id('ros_a'));
select ok((select run_of_show_id = pg_temp.id('ros_a') and target_code = 'cues' from app.import_jobs where id = pg_temp.id('job_sheet')),
  'and the new import carries it');

-- 9. Guest matching: fuzzy within the project, exact strong keys (C9) ---------------------------------------------------------
select pg_temp.as_platform();
update app.import_jobs set mapping_confirmed_at = now() where id = pg_temp.id('job_guest');
insert into world select 'r_fuzzy', app.record_import_row(pg_temp.id('job_guest'), 'Guests', 2, 'Valid', null, 'Pike, Jordan');
select results_eq($$select candidate_id from app.merge_reviews where import_row_result_id = (select id from world where key = 'r_fuzzy')$$,
  $$select id from world where key = 'guest_show'$$, 'a near-duplicate guest goes to merge review, against guests of the project only');
select is(app.import_strong_key_match(pg_temp.id('job_guest'), jsonb_build_object('guest_name', '  JORDAN pike ', 'scope_node_id', pg_temp.id('show_a'))),
  pg_temp.id('guest_show'), 'a guest matches exactly on the trimmed name, in any case, for the same show');
select is(app.import_strong_key_match(pg_temp.id('job_guest'), jsonb_build_object('guest_name', 'Jordan Pike')), null::uuid,
  'a guest of one show does not match a whole-project row');
select is(app.import_strong_key_match(pg_temp.id('job_guest'), jsonb_build_object('guest_name', 'riley chen')), pg_temp.id('guest_whole'),
  'a NULL show matches only a NULL show');
select is(app.import_strong_key_match(pg_temp.id('job_cue'), jsonb_build_object('position', '3')), pg_temp.id('cue_timed'),
  'a numbered cue matches on its position in the import''s running order');
select is(app.import_strong_key_match(pg_temp.id('job_cue'), jsonb_build_object('label', 'Walk-in music')), null::uuid,
  'an unnumbered cue without a time does not match a timed cue');
select is(app.import_strong_key_match(pg_temp.id('job_cue'), jsonb_build_object('label', 'Walk-in music', 'planned_at', '2026-11-14T19:00:00-05:00')),
  pg_temp.id('cue_timed'), 'but matches on label and the same time');
select pg_temp.as_user('dave');
select throws_ok($$select app.import_strong_key_match((select id from world where key = 'job_cue'), '{}'::jsonb)$$, '42501', null,
  'only the worker matches strong keys');

-- 10. Separation of duties for imported guests (C7) -------------------------------------------------------------------------
select lives_ok($$insert into world select 'job_sod', pg_temp.guest_job('dave', 'prj_a')$$, 'Dave uploads a guest list');
select pg_temp.as_platform();
update app.import_jobs set import_status = 'Mapped', mapping_confirmed_at = now() where id = pg_temp.id('job_sod');
insert into world select 'r_g' || n, app.record_import_row(pg_temp.id('job_sod'), 'Guests', n + 1, 'Valid') from generate_series(1, 4) n;
update app.import_jobs set import_status = 'Validated' where id = pg_temp.id('job_sod');
select pg_temp.as_user('carol');
insert into world select 'batch_sod', app.request_import_commit(pg_temp.id('job_sod'));
select pg_temp.as_platform();
alter table app.guest_list_entries disable trigger t90_stamp_audit_columns;
do $$ declare v uuid; begin
  for n in 1..4 loop
    insert into app.guest_list_entries (project_id, guest_name, created_at, updated_at)
    values (pg_temp.id('prj_a'), 'Imported Guest ' || n, now() - interval '2 hours', now() - interval '2 hours') returning id into v;
    insert into world values ('g' || n, v);
  end loop;
end $$;
alter table app.guest_list_entries enable trigger t90_stamp_audit_columns;
select app.commit_import_write(pg_temp.id('r_g' || n), pg_temp.id('batch_sod'), pg_temp.id('g' || n), 'Created') from generate_series(1, 4) n;
select app.finish_import_batch(pg_temp.id('batch_sod'));
update app.import_batches set committed_at = now() - interval '1 hour' where id = pg_temp.id('batch_sod');
select is((select count(*)::int from app.guest_list_entries where id in (pg_temp.id('g1'), pg_temp.id('g4')) and entry_state = 'Requested'), 2,
  'imported guests are Requested');
select pg_temp.as_user('dave');
select throws_ok($$update app.guest_list_entries set entry_state = 'Approved' where id = (select id from world where key = 'g1')$$,
  'XR001', 'sod_guest_requester: The person who requested a guest cannot approve or decline the request.', 'the uploader cannot approve them');
select pg_temp.as_user('carol');
select throws_ok($$update app.guest_list_entries set entry_state = 'Declined' where id = (select id from world where key = 'g1')$$,
  'XR001', 'sod_guest_requester: The person who requested a guest cannot approve or decline the request.', 'nor can the person who committed them');
select is(app.bulk_update_guest_list_entries(jsonb_build_array(jsonb_build_object('id', pg_temp.id('g2'), 'set', jsonb_build_object('entry_state', 'Approved')))) -> 'refused' -> 0 ->> 'rule',
  'sod_guest_requester', 'not even in bulk');
select pg_temp.as_user('bob');
select lives_ok($$update app.guest_list_entries set entry_state = 'Approved' where id = (select id from world where key = 'g1')$$, 'a third reviewer approves');
select is(app.bulk_update_guest_list_entries(jsonb_build_array(
    jsonb_build_object('id', pg_temp.id('g2'), 'set', jsonb_build_object('entry_state', 'Approved')),
    jsonb_build_object('id', pg_temp.id('g3'), 'set', jsonb_build_object('entry_state', 'Declined')))) ->> 'changed',
  '2', 'and decides others in bulk');
select pg_temp.as_user('dave');
select results_eq($$select reverted, kept from app.undo_import_batch((select id from world where key = 'batch_sod'), 'Wrong list.')$$,
  $$values (1, 3)$$, 'undo keeps the guests decided after the import and reverts the untouched one');
select pg_temp.as_platform();
select ok((select deleted_at is not null from app.guest_list_entries where id = pg_temp.id('g4')), 'the untouched guest goes to Trash');

-- 11. Outside orgs (C4) -------------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
insert into app.import_mapping_profiles (org_id, target_code, name) values (pg_temp.id('org_a'), 'guest_list_entries', 'Door list');
select pg_temp.as_platform();
insert into app.record_grants (org_id, target_kind, target_id, capability_code, grantee_org_id, valid_to, reason)
values (pg_temp.id('org_a'), 'project', pg_temp.id('prj_a'), 'advancing.rider.write', pg_temp.id('org_b'), now() + interval '1 day', 'Co-promoted series.');
select pg_temp.claims('xavier');
select ok(private.can_on_project(pg_temp.id('prj_a'), 'advancing.rider.write'), 'a record grant gives the other org the project capability');
select ok(not exists (select 1 from private.import_target_orgs('guest_list_entries') o where o = pg_temp.id('org_a')),
  'but the owning org is not an org it may import into');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.import_mapping_profiles where org_id = pg_temp.id('org_a')), 0, 'so it reads none of its mapping profiles');
select throws_ok(format($$insert into app.import_jobs (org_id, target_code, source, original_filename, storage_object_path, project_id)
  values (%L, 'guest_list_entries', 'CSV', 'guests.csv', %L, %L)$$, pg_temp.id('org_a'), pg_temp.path('xavier'), pg_temp.id('prj_a')),
  '42501', null, 'and cannot start an import there');

-- 12. Sample purges (C3) ------------------------------------------------------------------------------------------------------
insert into world select 'job_cancel', pg_temp.cue_job('dave', 'ros_a');
select pg_temp.detect(pg_temp.id('job_cancel'), array['Cue', 'Scene'], array['position', 'label']);
select pg_temp.as_user('dave');
update app.import_jobs set import_status = 'Canceled' where id = pg_temp.id('job_cancel');
select is(pg_temp.samples(pg_temp.id('job_cancel')), 0, 'canceling deletes the samples');
insert into world select 'job_deleted', pg_temp.cue_job('dave', 'ros_a');
select pg_temp.detect(pg_temp.id('job_deleted'), array['Cue', 'Scene'], array['position', 'label']);
update app.import_jobs set deleted_at = now() where id = pg_temp.id('job_deleted');
select is(pg_temp.samples(pg_temp.id('job_deleted')), 0, 'soft-deleting the import deletes them');
insert into world select 'job_aged', pg_temp.cue_job('dave', 'ros_a');
select pg_temp.detect(pg_temp.id('job_aged'), array['Cue', 'Scene'], array['position', 'label']);
delete from app.import_job_columns where import_job_id = pg_temp.id('job_aged');
select is(pg_temp.samples(pg_temp.id('job_aged')), 0, 'and the retention sweep deleting the columns takes them along');

-- 13. Trash ------------------------------------------------------------------------------------------------------------------
select is(private.sync_trash_tables(), 0, 'the Trash sync adds no table');
select set_eq($$select table_name from private.trash_tables$$, $$select table_name from trash_before$$, 'and changes none');

select * from finish();
rollback;
