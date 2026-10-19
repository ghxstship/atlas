-- pgTAP: 1241 (A57, owner decision 28). Legacy .xls imports are refused in the database with a
-- plain-language message; .csv and .xlsx imports still upload and create jobs.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(9);

select pg_temp.as_platform();
insert into world select 'csv_upload', gen_random_uuid();
insert into world select 'xlsx_upload', gen_random_uuid();
insert into world select 'xls_upload', gen_random_uuid();

select is((select allowed_mime_types from storage.buckets where id = 'imports'),
  array['text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  'the imports bucket takes CSV and .xlsx only');
select is(private.import_object_owner(pg_temp.id('alice') || '/' || pg_temp.id('xls_upload') || '.xls'), null::uuid,
  'a .xls object name has no owner, so no one may upload it');
select is(private.import_object_owner(pg_temp.id('alice') || '/' || pg_temp.id('xlsx_upload') || '.xlsx'), pg_temp.id('alice'),
  'a .xlsx object name belongs to its person');

select pg_temp.as_user('alice');
select throws_ok(format($$insert into storage.objects (bucket_id, name, owner_id) values ('imports', '%s/%s.xls', '%s')$$,
  pg_temp.id('alice'), pg_temp.id('xls_upload'), pg_temp.id('alice_user')), '42501', null,
  'a .xls spreadsheet cannot be uploaded for import');
select lives_ok(format($$insert into storage.objects (bucket_id, name, owner_id) values ('imports', '%s/%s.csv', '%s')$$,
  pg_temp.id('alice'), pg_temp.id('csv_upload'), pg_temp.id('alice_user')), 'a .csv spreadsheet uploads');
select lives_ok(format($$insert into storage.objects (bucket_id, name, owner_id) values ('imports', '%s/%s.xlsx', '%s')$$,
  pg_temp.id('alice'), pg_temp.id('xlsx_upload'), pg_temp.id('alice_user')), 'a .xlsx spreadsheet uploads');

select throws_ok(format($$insert into app.import_jobs (org_id, target_code, source, original_filename, storage_object_path)
  values ('%s', 'counterparties', 'XLS', 'customers.xls', '%s/%s.xlsx')$$,
  pg_temp.id('org_a'), pg_temp.id('alice'), pg_temp.id('xlsx_upload')), 'XR001',
  'import_xls_unsupported: Older .xls files cannot be read. Save the sheet as .xlsx or .csv and upload it again.',
  'an XLS import job is refused with a plain-language message');
select lives_ok(format($$insert into app.import_jobs (org_id, target_code, source, original_filename, storage_object_path)
  values ('%s', 'counterparties', 'CSV', 'customers.csv', '%s/%s.csv')$$,
  pg_temp.id('org_a'), pg_temp.id('alice'), pg_temp.id('csv_upload')), 'a CSV import job is created');
select lives_ok(format($$insert into app.import_jobs (org_id, target_code, source, original_filename, storage_object_path)
  values ('%s', 'counterparties', 'XLSX', 'customers.xlsx', '%s/%s.xlsx')$$,
  pg_temp.id('org_a'), pg_temp.id('alice'), pg_temp.id('xlsx_upload')), 'an .xlsx import job is created');

select * from finish();
rollback;
