-- pgTAP: the import wizard (row states, confirmed mappings, merge reviews that never auto-merge,
-- batches and undo within 7 days except rows later edits depend on) and exports with data loss
-- prevention (Section 4.6.2, Section 7.3, Section 8.6).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(41);

create temporary table k (key text primary key, id uuid);
grant select, insert, update on k to public;

-- Jobs and mappings ---------------------------------------------------------------------------------------
select pg_temp.as_user('bob');
insert into app.import_jobs (org_id, target_code, source, original_filename, storage_object_path, import_status)
values (pg_temp.id('org_a'), 'venues', 'CSV', 'venues.csv', 'org_a/imports/venues.csv', 'Committed');
insert into k select 'job', id from app.import_jobs;
select is((select import_status from app.import_jobs), 'Uploaded'::app.import_status, 'a new import always starts Uploaded');
select pg_temp.as_platform();
select throws_ok($$select app.record_import_row((select id from k where key = 'job'), 'Sheet1', 2, 'Valid')$$, 'XR001', null,
  'no row is validated before the mapping is confirmed');
update app.import_jobs set import_status = 'Mapped' where id = (select id from k where key = 'job');
insert into app.import_job_columns (import_job_id, sheet_name, column_index, header, suggested_field_name) values
  ((select id from k where key = 'job'), 'Sheet1', 0, 'Venue Name', 'name'),
  ((select id from k where key = 'job'), 'Sheet1', 1, 'Street', 'street_address');
select throws_ok($$insert into app.import_job_columns (import_job_id, sheet_name, column_index, header, field_name)
  values ((select id from k where key = 'job'), 'Sheet1', 2, 'Color', 'paint_color')$$, 'XR001', null,
  'a column maps only to a field of the target');
select pg_temp.as_user('bob');
update app.import_job_columns set field_name = suggested_field_name;
select throws_ok($$update app.import_jobs set import_status = 'Validated'$$, 'XR001', null, 'a person cannot skip validation');
select lives_ok($$update app.import_jobs set mapping_confirmed_at = now()$$, 'the person confirms every mapping');
select throws_ok($$update app.import_jobs set mapping_confirmed_at = now() + interval '1 day'$$, 'XR001', null, 'a mapping is confirmed once');
select pg_temp.as_user('xavier');
select is((select count(*)::integer from app.import_jobs), 0, 'no cross-tenant import reads');
select pg_temp.as_user('gina');
select is((select count(*)::integer from app.import_jobs), 0, 'a viewer without the target write capability sees no imports');

-- Validation, row states and fuzzy matches ---------------------------------------------------------------------
select pg_temp.as_platform();
insert into k values ('r_fuzzy', app.record_import_row((select id from k where key = 'job'), 'Sheet1', 2, 'Valid', null, 'Northwind Pier Pavillion'));
insert into k values ('r_new', app.record_import_row((select id from k where key = 'job'), 'Sheet1', 3, 'Valid', null, 'Bayfront Amphitheater'));
insert into k values ('r_dep', app.record_import_row((select id from k where key = 'job'), 'Sheet1', 4, 'Valid'));
insert into k values ('r_edit', app.record_import_row((select id from k where key = 'job'), 'Sheet1', 5, 'Valid'));
insert into k values ('r_upd', app.record_import_row((select id from k where key = 'job'), 'Sheet1', 6, 'Valid'));
select app.record_import_row((select id from k where key = 'job'), 'Sheet1', 7, 'Skipped', 'Blank row.');
select throws_ok($$select app.record_import_row((select id from k where key = 'job'), 'Sheet1', 8, 'Invalid')$$, '23514', null,
  'an Invalid row carries its reason');
insert into k values ('r_bad', app.record_import_row((select id from k where key = 'job'), 'Sheet1', 8, 'Invalid', 'Name is required.'));
insert into app.import_cell_issues (import_row_result_id, column_index, issue_code) values ((select id from k where key = 'r_bad'), 0, 'required');
select throws_ok($$select app.record_import_row((select id from k where key = 'job'), 'Sheet1', 9, 'Written')$$, 'XR001', null,
  'only a commit makes a row Written');
select is((select count(*)::integer from app.merge_reviews where import_row_result_id = (select id from k where key = 'r_fuzzy')), 1,
  'a name at least 0.85 similar to an existing venue goes to merge review');
select ok((select similarity >= 0.85 and candidate_id = pg_temp.id('venue_a') and decision = 'Pending' from app.merge_reviews),
  'the review names the candidate, its similarity and starts Pending');
select is((select count(*)::integer from app.merge_reviews where import_row_result_id = (select id from k where key = 'r_new')), 0,
  'a dissimilar name has no merge review');
select throws_ok($$insert into app.merge_reviews (import_row_result_id, candidate_table, candidate_id, similarity)
  values ((select id from k where key = 'r_new'), 'app.venues', pg_temp.id('venue_a'), 0.70)$$, '23514', null,
  'matches below 0.85 are never reviews');
update app.import_jobs set import_status = 'Validated' where id = (select id from k where key = 'job');
select throws_ok($$select app.start_import_batch((select id from k where key = 'job'))$$, 'XR001', null,
  'a batch cannot commit while a fuzzy match is undecided');
select throws_ok($$update app.merge_reviews set decision = 'Merged'$$, 'XR001', null, 'a fuzzy match never merges without a person');
select pg_temp.as_user('bob');
select lives_ok($$update app.merge_reviews set decision = 'Kept Separate'$$, 'a person decides the fuzzy match');
select is((select decided_by from app.merge_reviews), pg_temp.id('bob'), 'the decision records who decided');
select throws_ok($$update app.merge_reviews set decision = 'Merged'$$, 'XR001', null, 'a decision is final');

-- Commit --------------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
insert into k values ('batch', app.start_import_batch((select id from k where key = 'job')));
alter table app.venues disable trigger t90_stamp_audit_columns;
insert into app.venues (id, org_id, name, jurisdiction_id, time_zone, created_at, updated_at) values
  (gen_random_uuid(), pg_temp.id('org_a'), 'Northwind Pier Pavillion', 'US-FL-MIAMI-DADE', 'America/New_York', now() - interval '2 hours', now() - interval '2 hours'),
  (gen_random_uuid(), pg_temp.id('org_a'), 'Bayfront Amphitheater', 'US-FL-MIAMI-DADE', 'America/New_York', now() - interval '2 hours', now() - interval '2 hours'),
  (gen_random_uuid(), pg_temp.id('org_a'), 'Pier 9 Warehouse', 'US-FL-MIAMI-DADE', 'America/New_York', now() - interval '2 hours', now() - interval '2 hours'),
  (gen_random_uuid(), pg_temp.id('org_a'), 'Harbor Tent', 'US-FL-MIAMI-DADE', 'America/New_York', now() - interval '2 hours', now() - interval '2 hours');
update app.venues set street_address = '1 Pier Rd', updated_at = now() - interval '2 hours' where id = pg_temp.id('venue_a');
alter table app.venues enable trigger t90_stamp_audit_columns;
select app.commit_import_write((select id from k where key = 'r_fuzzy'), (select id from k where key = 'batch'), (select id from app.venues where name = 'Northwind Pier Pavillion'), 'Created');
select app.commit_import_write((select id from k where key = 'r_new'), (select id from k where key = 'batch'), (select id from app.venues where name = 'Bayfront Amphitheater'), 'Created');
select app.commit_import_write((select id from k where key = 'r_dep'), (select id from k where key = 'batch'), (select id from app.venues where name = 'Pier 9 Warehouse'), 'Created');
select app.commit_import_write((select id from k where key = 'r_edit'), (select id from k where key = 'batch'), (select id from app.venues where name = 'Harbor Tent'), 'Created');
select app.commit_import_write((select id from k where key = 'r_upd'), (select id from k where key = 'batch'), pg_temp.id('venue_a'), 'Updated', '{"street_address": null}');
select throws_ok($$select app.commit_import_write((select id from k where key = 'r_bad'), (select id from k where key = 'batch'), pg_temp.id('venue_a'), 'Created')$$,
  'XR001', null, 'an Invalid row is never written');
select throws_ok($$select app.commit_import_write((select id from k where key = 'r_new'), (select id from k where key = 'batch'), pg_temp.id('venue_b'), 'Created')$$,
  'XR001', null, 'a row is never written to another org');
select app.finish_import_batch((select id from k where key = 'batch'));
update app.import_batches set committed_at = now() - interval '1 hour' where id = (select id from k where key = 'batch');
select is((select count(*)::integer from app.import_row_results where import_batch_id = (select id from k where key = 'batch')), 5,
  'every written row carries the batch id');
select is((select count(*)::integer from app.import_row_results where row_state = 'Written' and import_batch_id is null), 0,
  'no written row lacks a batch');

-- Later edits and dependents ---------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
update app.venues set name = 'Harbor Big Top' where name = 'Harbor Tent';
insert into app.projects (org_id, project_key, name, time_zone, venue_id)
values (pg_temp.id('org_a'), 'NWP', 'Pier 9 Pop-Up', 'America/New_York', (select id from app.venues where name = 'Pier 9 Warehouse'));

-- Undo ----------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('xavier');
select throws_ok($$select app.undo_import_batch((select id from k where key = 'batch'), 'Wrong file.')$$, '42501', null,
  'another org cannot undo the batch');
select pg_temp.as_user('bob');
select throws_ok($$select app.undo_import_batch((select id from k where key = 'batch'), '')$$, 'XR001', null, 'an undo says why');
select results_eq($$select reverted, kept from app.undo_import_batch((select id from k where key = 'batch'), 'Wrong file uploaded.')$$,
  $$values (3, 2)$$, 'undo reverts what it can and keeps rows later edits depend on');
select pg_temp.as_platform();
select ok((select deleted_at is not null from app.venues where name = 'Bayfront Amphitheater'), 'a created row goes to Trash');
select is((select street_address from app.venues where id = pg_temp.id('venue_a')), null, 'an updated row gets its before image back');
select is((select undo_reason from app.import_row_results where id = (select id from k where key = 'r_edit')), 'The row was edited after the import.',
  'a row edited after the import is kept and says why');
select ok((select undo_outcome = 'Kept' and undo_reason like '%app.projects%' from app.import_row_results where id = (select id from k where key = 'r_dep')),
  'a row other records depend on is kept and names them');
select ok((select deleted_at is null from app.venues where name = 'Pier 9 Warehouse'), 'the depended-on row stays live');
select pg_temp.as_user('bob');
select throws_ok($$select app.undo_import_batch((select id from k where key = 'batch'), 'Again.')$$, 'XR001', null, 'a batch is undone once');
select pg_temp.as_platform();
insert into app.import_jobs (org_id, target_code, source, original_filename, storage_object_path)
values (pg_temp.id('org_a'), 'venues', 'XLSX', 'old.xlsx', 'org_a/imports/old.xlsx');
insert into app.import_batches (import_job_id, committed_at) select id, now() - interval '8 days' from app.import_jobs where original_filename = 'old.xlsx';
select pg_temp.as_user('bob');
select throws_ok($$select app.undo_import_batch((select b.id from app.import_batches b join app.import_jobs j on j.id = b.import_job_id where j.original_filename = 'old.xlsx'), 'Late.')$$,
  'XR001', 'import_undo_window: A batch can be undone for 7 days after it was committed.', 'undo closes 7 days after commit');

-- Exports and data loss prevention ------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select ok(app.request_export(pg_temp.id('org_a'), 'CSV', 'Venues', array['app.venues.name', 'app.venues.locality']) is not null,
  'a member exports Internal data');
select is((select classification::text || ':' || watermark::text from app.export_jobs), 'Internal:false', 'the export is classified by its columns');
select is((select count(*)::integer from app.job_queue where job_kind = 'export.render'), 0, 'the render job is hidden from members');
select pg_temp.as_user('bob');
select throws_ok($$select app.request_export(pg_temp.id('org_a'), 'XLSX', 'Bank details', array['app.vendor_bank_accounts.account_number'])$$,
  'XR001', null, 'Restricted columns need the restricted export capability');
select pg_temp.as_user('alice');
select throws_ok($$select app.request_export(pg_temp.id('org_a'), 'XLSX', 'Bank details', array['app.vendor_bank_accounts.account_number'])$$,
  'XR001', 'step_up_required: Exporting Restricted columns needs step-up authentication.', 'Restricted exports need step-up');
select set_config('request.jwt.claims', json_build_object('sub', pg_temp.id('alice_user'), 'role', 'authenticated', 'aal', 'aal2')::text, true);
insert into k values ('exp', app.request_export(pg_temp.id('org_a'), 'PDF', 'Bank details', array['app.vendor_bank_accounts.account_number']));
select is((select classification::text || ':' || watermark::text from app.export_jobs where id = (select id from k where key = 'exp')),
  'Restricted:true', 'after step-up a Restricted export is allowed and watermarked');
select throws_ok($$select app.request_export(pg_temp.id('org_a'), 'CSV', 'Clinic', array['app.medical_encounters.treatment_notes'])$$,
  'XR001', null, 'medical data is excluded from exports');
select pg_temp.as_user('xavier');
select throws_ok($$select app.request_export(pg_temp.id('org_a'), 'CSV', 'Venues', array['app.venues.name'])$$, '42501', null,
  'nobody exports another org''s data');

select * from finish();
rollback;
