-- pgTAP: migration 1402 (A83, RRR-128, finding A65-025, Section 4.6.2 steps 1 to 3). A Google Sheets link needs the
-- imports.google_sheets flag and a Connected Google Drive connection and is fetched before it is scanned and read;
-- every detected sheet is recorded with a proposed target; another sheet of a read workbook is imported as the
-- person, under their own capability and upload rules; only the import service sets the sheet and the failure reason.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(33);

select pg_temp.as_platform();
insert into world select 'upload_1', gen_random_uuid();
insert into world select 'upload_2', gen_random_uuid();
create function pg_temp.path(p_person text, p_upload text, p_ext text) returns text
language sql stable as $$ select pg_temp.id(p_person) || '/' || pg_temp.id(p_upload) || '.' || p_ext $$;
create function pg_temp.sheets_import(p_url text) returns uuid
language sql as $$
  insert into app.import_jobs (org_id, target_code, source, original_filename, storage_object_path, source_url)
  values (pg_temp.id('org_a'), 'venues', 'Google Sheets', 'Tour Venues', pg_temp.path('bob', 'upload_2', 'xlsx'), p_url)
  returning id
$$;

-- Google Sheets links -------------------------------------------------------------------------------------------------
select pg_temp.as_user('bob');
select throws_ok($$select pg_temp.sheets_import('https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit')$$,
  'XR001', 'import_google_drive_required: Connect Google Drive in Settings, Integrations, before importing a Google Sheets link.',
  'a link needs a Connected Google Drive connection');
with c as (insert into app.integration_connections (org_id, provider_code, display_name)
  values (pg_temp.id('org_a'), 'google_drive', 'Northwind Drive') returning id) insert into world select 'drive', id from c;
select app.store_integration_credential(pg_temp.id('drive'), '{"access_token":"ya29-test-token"}', 'OAuth Token');
select app.transition_integration_connection(pg_temp.id('drive'), 'Pending', 'Connected', 'Drive connected.');
select throws_ok($$select pg_temp.sheets_import('https://example.test/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789')$$,
  '23514', null, 'only a docs.google.com spreadsheet link is accepted');
select throws_ok($$insert into app.import_jobs (org_id, target_code, source, original_filename, storage_object_path)
  values ((select id from world where key = 'org_a'), 'venues', 'Google Sheets', 'No Link', pg_temp.path('bob', 'upload_2', 'xlsx'))$$,
  '23514', null, 'a Google Sheets import names its link');
select throws_ok($$insert into app.import_jobs (org_id, target_code, source, original_filename, storage_object_path, source_url)
  values ((select id from world where key = 'org_a'), 'venues', 'CSV', 'Venues.csv', pg_temp.path('bob', 'upload_2', 'csv'),
          'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789')$$,
  '23514', null, 'an uploaded file carries no link');
insert into world select 'gs', pg_temp.sheets_import('https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit#gid=0');
select pg_temp.as_platform();
select is((select count(*)::int from app.job_queue where subject_id = pg_temp.id('gs') and job_kind = 'import.fetch'), 1,
  'a link not yet saved is queued for fetching');
select is((select count(*)::int from app.job_queue where subject_id = pg_temp.id('gs') and job_kind = 'import.detect'), 0,
  'and is not detected before it is saved and scanned');
select pg_temp.as_user('bob');
select throws_ok($$update app.import_jobs set source_url = 'https://docs.google.com/spreadsheets/d/9ZyXwVuTsRqPoNmLkJiHgFeDcBa9876543210' where id = (select id from world where key = 'gs')$$,
  'XR001', 'import_job_immutable: An import keeps its file and target; start a new import instead.', 'the link never changes');
select throws_ok($$update app.import_jobs set failure_code = 'google_sheet_not_shared' where id = (select id from world where key = 'gs')$$,
  'XR001', 'import_status_service_only: Import progress is set by the import service; a person may only cancel an uncommitted import.',
  'only the import service sets the failure reason');
select pg_temp.as_platform();
select lives_ok($$update app.import_jobs set failure_code = 'google_sheet_not_shared', import_status = 'Failed' where id = (select id from world where key = 'gs')$$,
  'the import service fails a link it cannot read, with the reason');
select pg_temp.as_platform();
insert into app.feature_flag_overrides (org_id, flag_key, enabled, reason)
values (pg_temp.id('org_a'), 'imports.google_sheets', false, 'Test: links turned off.');
select pg_temp.as_user('bob');
select throws_ok($$select pg_temp.sheets_import('https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789')$$,
  'XR001', 'import_google_sheets_off: Importing from a Google Sheets link is turned off for this organization.',
  'the imports.google_sheets flag turns links off');

-- Detected sheets -------------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
insert into private.object_scans (bucket_id, object_name, scan_status, scanned_at, owner_id)
values ('imports', pg_temp.path('bob', 'upload_1', 'xlsx'), 'Clean', now(), pg_temp.id('bob_user')::text);
select pg_temp.as_user('bob');
with j as (insert into app.import_jobs (org_id, target_code, source, original_filename, storage_object_path, sheet_name, failure_code)
  values (pg_temp.id('org_a'), 'venues', 'XLSX', 'Northwind Playbook.xlsx', pg_temp.path('bob', 'upload_1', 'xlsx'), null, 'invented')
  returning id) insert into world select 'wb', id from j;
select is((select failure_code from app.import_jobs where id = pg_temp.id('wb')), null, 'a failure reason sent on insert is discarded');

select pg_temp.as_platform();
with s as (insert into app.import_job_sheets (import_job_id, sheet_name, sheet_index, header_row, first_data_row, last_row, column_count, data_row_count, proposed_target_code)
  values (pg_temp.id('wb'), 'Locations', 0, 1, 2, 9, 6, 8, 'venues') returning id) insert into world select 'sheet_0', id from s;
with s as (insert into app.import_job_sheets (import_job_id, sheet_name, sheet_index, header_row, first_data_row, last_row, column_count, data_row_count, proposed_target_code, proposed_from_playbook)
  values (pg_temp.id('wb'), 'Vendor Directory', 1, 2, 3, 40, 14, 38, 'counterparties', true) returning id) insert into world select 'sheet_1', id from s;
with s as (insert into app.import_job_sheets (import_job_id, sheet_name, sheet_index, last_row)
  values (pg_temp.id('wb'), 'Notes', 2, 0) returning id) insert into world select 'sheet_2', id from s;
with s as (insert into app.import_job_sheets (import_job_id, sheet_name, sheet_index, header_row, first_data_row, last_row, column_count, data_row_count, proposed_target_code)
  values (pg_temp.id('wb'), 'Asset Inventory', 3, 1, 2, 6, 5, 5, 'asset_units') returning id) insert into world select 'sheet_3', id from s;

select pg_temp.as_user('bob');
select throws_ok($$select app.import_detected_sheet((select id from world where key = 'sheet_1'), 'counterparties')$$,
  'XR001', 'import_sheet_not_detected: Sheets can be imported once the workbook has been read.', 'sheets wait until the workbook is read');
select pg_temp.as_platform();
update app.import_jobs set import_status = 'Mapped', sheet_name = 'Locations' where id = pg_temp.id('wb');
select throws_ok($$update app.import_jobs set sheet_name = 'Other' where id = (select id from world where key = 'wb')$$,
  'XR001', 'import_job_immutable: An import keeps its file and target; start a new import instead.', 'an import keeps its sheet once chosen');

select pg_temp.as_user('bob');
select is((select count(*)::int from app.import_job_sheets where import_job_id = pg_temp.id('wb')), 4, 'the uploader reads every detected sheet');
select is((select proposed_target_code from app.import_job_sheets where id = pg_temp.id('sheet_1')), 'counterparties', 'with the target proposed for each');
insert into world select 'wb2', app.import_detected_sheet(pg_temp.id('sheet_1'), 'counterparties');
select ok((select sheet_name = 'Vendor Directory' and target_code = 'counterparties' and import_status = 'Uploaded'
                  and storage_object_path = pg_temp.path('bob', 'upload_1', 'xlsx') and import_job_sheet_id = pg_temp.id('sheet_1')
           from app.import_jobs where id = pg_temp.id('wb2')), 'importing a detected sheet starts its own import of the same file');
select pg_temp.as_platform();
select is((select count(*)::int from app.job_queue where subject_id = pg_temp.id('wb2') and job_kind = 'import.detect'), 1,
  'the file already scanned Clean, so its detection is queued at once');
select pg_temp.as_user('bob');
select throws_ok($$select app.import_detected_sheet((select id from world where key = 'sheet_1'), 'counterparties')$$,
  'XR001', 'import_sheet_taken: An import of this sheet is already open.', 'one open import per sheet');
select throws_ok($$select app.import_detected_sheet((select id from world where key = 'sheet_0'), 'venues')$$,
  'XR001', 'import_sheet_taken: An import of this sheet is already open.', 'the sheet the import itself reads is taken');
select throws_ok($$select app.import_detected_sheet((select id from world where key = 'sheet_2'), 'venues')$$,
  'XR001', 'import_sheet_empty: The sheet has no rows to import.', 'an empty sheet is not imported');
select throws_ok($$select app.import_detected_sheet((select id from world where key = 'sheet_1'), 'no_such_target')$$,
  'XR001', 'import_target_not_allowed: You cannot import into that target in this organization.', 'only a target the person may import into');

select pg_temp.as_user('carol');
select throws_ok($$select app.import_detected_sheet((select id from world where key = 'sheet_3'), 'asset_units')$$,
  'XR001', 'import_upload_owner: An import reads a spreadsheet you uploaded yourself.', 'a colleague cannot import someone else''s upload');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.import_job_sheets), 0, 'another org reads no detected sheets');
select throws_ok($$select app.import_detected_sheet((select id from world where key = 'sheet_1'), 'venues')$$,
  '42501', null, 'nor imports them');
select pg_temp.as_anon();
select throws_ok('select 1 from app.import_job_sheets', '42501', null, 'anon cannot read detected sheets');

-- Suggestion sources ------------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
insert into app.import_job_columns (import_job_id, sheet_name, column_index, header, suggested_field_name, suggestion_source)
values (pg_temp.id('wb'), 'Locations', 0, 'VENUE', 'name', 'Playbook');
select is((select suggestion_source::text from app.import_job_columns where import_job_id = pg_temp.id('wb')), 'Playbook',
  'a column records where its suggestion came from');

-- Aurora's mapping step -----------------------------------------------------------------------------------------------------
-- imports.ai_mapping is on by default, but the org's own AI switch decides: with mapping off, no column name is sent.
select pg_temp.as_user('bob');
select is((select enabled from app.org_feature_flags(pg_temp.id('org_a')) where flag_key = 'imports.ai_mapping'), true,
  'imports.ai_mapping is on by default');
select is((select count(*)::int from app.ai_enabled_features(pg_temp.id('org_a')) f where f = 'mapping'), 0,
  'an org whose Admin has not turned mapping on has no mapping feature, so the wizard offers no Aurora step');
select throws_ok($$select app.ai_begin_request((select id from world where key = 'org_a'), 'mapping', 'claude-sonnet-5-5')$$,
  'XR001', 'aurora_feature_off: An Admin has not turned on mapping in Settings, AI Features.',
  'and Aurora refuses a mapping request before any column name reaches a model');
select lives_ok($$insert into app.ai_settings (org_id, mapping_enabled) values ((select id from world where key = 'org_a'), true)$$,
  'an Admin turns mapping on in Settings, AI Features');
select results_eq($$select f::text from app.ai_enabled_features((select id from world where key = 'org_a')) f$$,
  array['mapping'], 'then the step is offered');
select lives_ok($$update app.ai_settings set mapping_enabled = false where org_id = (select id from world where key = 'org_a')$$,
  'an Admin turns mapping off again');
select is((select count(*)::int from app.ai_enabled_features(pg_temp.id('org_a')) f where f = 'mapping'), 0,
  'and the step goes away while the flag stays on');

select * from finish();
rollback;
