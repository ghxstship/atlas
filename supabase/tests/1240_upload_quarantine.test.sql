-- pgTAP: 1240 (A57, owner decision 10). The imports and support-screenshots buckets are scanned and
-- quarantined like the other private upload buckets, workers read a file's scan status, and an
-- Infected verdict outlives the removed file so only its uploader learns why it is gone.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(29);

-- Catalog -------------------------------------------------------------------------------------------------------------
select ok(private.scanned_upload_bucket('imports') and private.scanned_upload_bucket('support-screenshots')
  and private.scanned_upload_bucket('field-media') and not private.scanned_upload_bucket('attachments')
  and not private.scanned_upload_bucket('report-results'),
  'imports and support-screenshots are scanned buckets; attachments and generated reports are not');
select ok(not has_function_privilege('authenticated', 'app.object_scan_status(text, text)', 'execute')
  and not has_function_privilege('anon', 'app.object_scan_status(text, text)', 'execute')
  and has_function_privilege('service_role', 'app.object_scan_status(text, text)', 'execute'),
  'only the service role reads any object''s scan status');
select ok(has_function_privilege('authenticated', 'app.my_upload_scan_status(text, text)', 'execute')
  and not has_function_privilege('anon', 'app.my_upload_scan_status(text, text)', 'execute'),
  'a signed-in person asks about their own uploads; anon cannot');
select ok((select count(*) from pg_constraint where conname = 'object_scans_bucket' and conrelid = 'private.object_scans'::regclass) = 1,
  'object_scans still names its buckets in a check constraint');

-- An import spreadsheet is quarantined -------------------------------------------------------------------------------
select pg_temp.as_platform();
insert into world select 'upload_1', gen_random_uuid();
create function pg_temp.import_path(p_person text, p_upload text) returns text
language sql stable as $$ select pg_temp.id(p_person) || '/' || pg_temp.id(p_upload) || '.csv' $$;

select pg_temp.as_user('dave');
insert into storage.objects (bucket_id, name, owner_id, metadata)
values ('imports', pg_temp.import_path('dave', 'upload_1'), pg_temp.id('dave_user')::text,
        jsonb_build_object('mimetype', 'text/csv', 'size', 120));

select pg_temp.as_platform();
select is((select scan_status from private.object_scans where bucket_id = 'imports' and object_name = pg_temp.import_path('dave', 'upload_1')),
  'Scanning'::app.scan_status, 'a new import spreadsheet is queued for scanning');
select is((select owner_id from private.object_scans where bucket_id = 'imports' and object_name = pg_temp.import_path('dave', 'upload_1')),
  pg_temp.id('dave_user')::text, 'the scan remembers its uploader');
select is(app.object_scan_status('imports', pg_temp.import_path('dave', 'upload_1')), 'Scanning'::app.scan_status,
  'the import worker sees it is still being scanned');
select is(app.object_scan_status('imports', 'nobody/nothing.csv'), null::app.scan_status, 'an unknown object has no status');

select pg_temp.as_user('dave');
select is((select count(*)::integer from storage.objects where bucket_id = 'imports' and name = pg_temp.import_path('dave', 'upload_1')), 1,
  'the uploader still reads their own spreadsheet while it is scanned');
select is(app.my_upload_scan_status('imports', pg_temp.import_path('dave', 'upload_1')), 'Scanning'::app.scan_status,
  'and sees that it is being scanned');
select throws_ok(format('select app.object_scan_status(%L, %L)', 'imports', pg_temp.import_path('dave', 'upload_1')),
  '42501', null, 'but cannot call the worker''s status function');
select pg_temp.as_user('alice');
select is(app.my_upload_scan_status('imports', pg_temp.import_path('dave', 'upload_1')), null::app.scan_status,
  'another person learns nothing about Dave''s upload');

-- An infected file is removed, and only its uploader is told -----------------------------------------------------------
select pg_temp.as_platform();
select is(app.record_object_scan((select id from private.object_scans where object_name = pg_temp.import_path('dave', 'upload_1')), false, 'Eicar-Test-Signature'),
  'Infected'::app.scan_status, 'the worker records Infected');
set local storage.allow_delete_query = 'true';
delete from storage.objects where bucket_id = 'imports' and name = pg_temp.import_path('dave', 'upload_1');
select is((select scan_status from private.object_scans where object_name = pg_temp.import_path('dave', 'upload_1')),
  'Infected'::app.scan_status, 'the verdict outlives the removed file');
select pg_temp.as_user('dave');
select is(app.my_upload_scan_status('imports', pg_temp.import_path('dave', 'upload_1')), 'Infected'::app.scan_status,
  'the uploader learns the file was infected');
select pg_temp.as_user('xavier');
select is(app.my_upload_scan_status('imports', pg_temp.import_path('dave', 'upload_1')), null::app.scan_status,
  'cross-tenant: nobody else does');

-- Uploading the same name again starts a fresh scan.
select pg_temp.as_user('dave');
insert into storage.objects (bucket_id, name, owner_id, metadata)
values ('imports', pg_temp.import_path('dave', 'upload_1'), pg_temp.id('dave_user')::text,
        jsonb_build_object('mimetype', 'text/csv', 'size', 90));
select is(app.my_upload_scan_status('imports', pg_temp.import_path('dave', 'upload_1')), 'Scanning'::app.scan_status,
  'a new upload under the same name is scanned again');

-- A Clean file that is deleted leaves no row.
select pg_temp.as_platform();
select is(app.record_object_scan((select id from private.object_scans where object_name = pg_temp.import_path('dave', 'upload_1')), true),
  'Clean'::app.scan_status, 'the new upload scans Clean');
delete from storage.objects where bucket_id = 'imports' and name = pg_temp.import_path('dave', 'upload_1');
select is((select count(*)::integer from private.object_scans where object_name = pg_temp.import_path('dave', 'upload_1')), 0,
  'a deleted Clean object leaves no scan row');

-- Imports wait for their spreadsheet to scan Clean -------------------------------------------------------------------
select pg_temp.as_platform();
insert into world select 'upload_2', gen_random_uuid();
insert into world select 'upload_3', gen_random_uuid();
select pg_temp.as_user('alice');
insert into storage.objects (bucket_id, name, owner_id, metadata) values
  ('imports', pg_temp.import_path('alice', 'upload_2'), pg_temp.id('alice_user')::text, jsonb_build_object('mimetype', 'text/csv', 'size', 10)),
  ('imports', pg_temp.import_path('alice', 'upload_3'), pg_temp.id('alice_user')::text, jsonb_build_object('mimetype', 'text/csv', 'size', 10));
with x as (insert into app.import_jobs (org_id, target_code, source, original_filename, storage_object_path)
  values (pg_temp.id('org_a'), 'counterparties', 'CSV', 'clean.csv', pg_temp.import_path('alice', 'upload_2')) returning id)
  insert into world select 'job_2', id from x;
with x as (insert into app.import_jobs (org_id, target_code, source, original_filename, storage_object_path)
  values (pg_temp.id('org_a'), 'counterparties', 'CSV', 'eicar.csv', pg_temp.import_path('alice', 'upload_3')) returning id)
  insert into world select 'job_3', id from x;

select pg_temp.as_platform();
select is((select count(*)::integer from app.job_queue where subject_id = pg_temp.id('job_2') and job_kind = 'import.detect'), 0,
  'an import waits while its spreadsheet is scanned');
select is(app.record_object_scan((select id from private.object_scans where object_name = pg_temp.import_path('alice', 'upload_2')), true),
  'Clean'::app.scan_status, 'its spreadsheet scans Clean');
select is((select count(*)::integer from app.job_queue where subject_id = pg_temp.id('job_2') and job_kind = 'import.detect'), 1,
  'a Clean verdict queues detection once');
select is(app.record_object_scan((select id from private.object_scans where object_name = pg_temp.import_path('alice', 'upload_3')), false, 'Eicar-Test-Signature'),
  'Infected'::app.scan_status, 'the other spreadsheet is infected');
select ok((select import_status::text = 'Failed' from app.import_jobs where id = pg_temp.id('job_3'))
  and (select count(*) = 0 from app.job_queue where subject_id = pg_temp.id('job_3')),
  'an infected spreadsheet fails its import and is never parsed');

-- Support screenshots are quarantined too ----------------------------------------------------------------------------
select pg_temp.as_user('dave');
insert into storage.objects (bucket_id, name, owner_id, metadata)
values ('support-screenshots', pg_temp.id('dave') || '/screen.png', pg_temp.id('dave_user')::text,
        jsonb_build_object('mimetype', 'image/png', 'size', 2048));
select is(app.my_upload_scan_status('support-screenshots', pg_temp.id('dave') || '/screen.png'), 'Scanning'::app.scan_status,
  'a support screenshot is queued for scanning');
select is((select count(*)::integer from storage.objects where bucket_id = 'support-screenshots'), 1,
  'its uploader reads it while it is scanned');
select pg_temp.as_platform();
select ok(not has_function_privilege('authenticated', 'app.claim_bucket_scans(text, text, integer)', 'execute'),
  'only the service role claims one bucket''s scans');
select is((select count(*)::integer from app.claim_bucket_scans('imports', 'scanner-a57', 100)), 0,
  'claiming one bucket takes nothing from another');
select is((select count(*)::integer from app.claim_bucket_scans('support-screenshots', 'scanner-a57', 100)), 1,
  'the scan worker claims support screenshots');

select * from finish();
rollback;
