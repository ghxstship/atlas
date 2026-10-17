-- pgTAP: Import pipeline (Section 4.6.2, A36) on A18's import schema. Uploads stay in the uploader's
-- folder, jobs name only their creator's uploads, detection and validation queue themselves, the dry run
-- counts creates, updates, merges and refusals, and commit opens the batch only once every fuzzy match is
-- decided. The worker steps run as the platform (service role) through A18's worker RPCs.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(29);

-- World ---------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
select pg_temp.claims('alice');
insert into world select 'existing_cp', app.create_counterparty(pg_temp.id('org_a'), 'Harbor Sound Rentals', null);
select pg_temp.as_platform();
insert into world select 'alice_upload', gen_random_uuid();
insert into world select 'carol_upload', gen_random_uuid();

-- Target fields -------------------------------------------------------------------------------------------
select is((select required from app.import_target_fields where target_code = 'counterparties' and field_name = 'counterparty_type'), false,
  'a client counterparty imports without a counterparty type');
select is((select required from app.import_target_fields where target_code = 'vendor_products' and field_name = 'vendor_name'), true,
  'a vendor product names its vendor');

-- Uploads -------------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
select lives_ok(format($$insert into storage.objects (bucket_id, name, owner_id) values ('imports', '%s/%s.csv', '%s')$$,
  pg_temp.id('alice'), pg_temp.id('alice_upload'), pg_temp.id('alice_user')), 'Alice uploads into her own folder');
select throws_ok(format($$insert into storage.objects (bucket_id, name, owner_id) values ('imports', '%s/%s.csv', '%s')$$,
  pg_temp.id('carol'), pg_temp.id('carol_upload'), pg_temp.id('alice_user')), '42501', null, 'but never into someone else''s');
select pg_temp.as_user('carol');
select is((select count(*)::int from storage.objects where bucket_id = 'imports'), 0, 'nobody else reads her spreadsheet');
select pg_temp.as_platform();
select is(private.import_object_owner('../etc/passwd'), null::uuid, 'a malformed object name has no owner');

-- Jobs ----------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select throws_ok(format($$insert into app.import_jobs (org_id, target_code, source, original_filename, storage_object_path)
  values ('%s', 'counterparties', 'CSV', 'customers.csv', '%s/%s.csv')$$,
  pg_temp.id('org_a'), pg_temp.id('alice'), pg_temp.id('alice_upload')), 'XR001',
  'import_upload_owner: An import reads a spreadsheet you uploaded yourself.', 'a job names only its creator''s own upload');
select pg_temp.as_user('alice');
with x as (insert into app.import_jobs (org_id, target_code, source, original_filename, storage_object_path)
  values (pg_temp.id('org_a'), 'counterparties', 'CSV', 'customers.csv', pg_temp.id('alice') || '/' || pg_temp.id('alice_upload') || '.csv')
  returning id) insert into world select 'job', id from x;
select pg_temp.as_platform();
select is((select count(*)::int from app.job_queue where subject_id = pg_temp.id('job') and job_kind = 'import.detect'), 1,
  'creating the job queues detection');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.import_jobs where id = pg_temp.id('job')), 0, 'another org cannot see the import');
select pg_temp.as_user('frank');
select is((select count(*)::int from app.import_jobs where id = pg_temp.id('job')), 0, 'nor can a Field member without the target capability');

-- Detection (worker) ---------------------------------------------------------------------------------------
select pg_temp.as_platform();
update app.import_jobs set import_status = 'Mapped' where id = pg_temp.id('job');
insert into app.import_job_columns (import_job_id, sheet_name, column_index, header, suggested_field_name) values
  (pg_temp.id('job'), 'customers.csv', 0, 'Company', 'name'),
  (pg_temp.id('job'), 'customers.csv', 1, 'Notes', null);
select pg_temp.as_user('alice');
update app.import_job_columns set field_name = 'name' where import_job_id = pg_temp.id('job') and column_index = 0;
select throws_ok($$update app.import_job_columns set field_name = 'tax_id' where import_job_id = (select id from world where key = 'job') and column_index = 1$$,
  'XR001', null, 'a column maps only to a field of the target');
update app.import_jobs set mapping_confirmed_at = now() where id = pg_temp.id('job');
select pg_temp.as_platform();
select is((select count(*)::int from app.job_queue where subject_id = pg_temp.id('job') and job_kind = 'import.validate'), 1,
  'confirming the mapping queues validation');

-- Validation (worker) --------------------------------------------------------------------------------------
select pg_temp.as_platform();
insert into world select 'row_new', app.record_import_row(pg_temp.id('job'), 'customers.csv', 2, 'Valid', null, 'Bayfront Catering', null);
insert into world select 'row_fuzzy', app.record_import_row(pg_temp.id('job'), 'customers.csv', 3, 'Valid', null, 'Harbor Sound Rental', null);
insert into world select 'row_bad', app.record_import_row(pg_temp.id('job'), 'customers.csv', 4, 'Invalid', 'name: required', null, null);
insert into world select 'row_key', app.record_import_row(pg_temp.id('job'), 'customers.csv', 5, 'Valid', null, null, null);
insert into app.import_row_matches (import_row_result_id, target_id) values (pg_temp.id('row_key'), pg_temp.id('existing_cp'));
update app.import_jobs set import_status = 'Validated' where id = pg_temp.id('job');
select is((select count(*)::int from app.merge_reviews where import_row_result_id = pg_temp.id('row_fuzzy')), 1,
  'the near-duplicate name goes to merge review');

select pg_temp.as_user('alice');
select is((select creates || ' ' || updates || ' ' || merges || ' ' || refusals || ' ' || pending_reviews from app.import_dry_run(pg_temp.id('job'))),
  '2 1 0 1 1', 'the dry run counts two creates, one strong key update, one refusal and one pending review');
select pg_temp.as_user('xavier');
select is((select creates + updates + refusals from app.import_dry_run(pg_temp.id('job'))), 0, 'another org''s dry run sees no rows');
select pg_temp.as_anon();
select throws_ok($$select * from app.import_dry_run(gen_random_uuid())$$, '42501', null, 'anon cannot dry run');

-- Commit ------------------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
select throws_ok($$select app.request_import_commit((select id from world where key = 'job'))$$, 'XR001',
  'import_merge_reviews_pending: Decide every fuzzy match before committing.', 'commit waits for every fuzzy match');
update app.merge_reviews set decision = 'Merged' where import_row_result_id = pg_temp.id('row_fuzzy');
select is((select decided_by from app.merge_reviews where import_row_result_id = pg_temp.id('row_fuzzy')), pg_temp.id('alice'),
  'the person who merged is recorded');
select is((select creates || ' ' || merges || ' ' || pending_reviews from app.import_dry_run(pg_temp.id('job'))), '1 1 0',
  'the dry run now counts the merge');
select pg_temp.as_user('xavier');
select throws_ok($$select app.request_import_commit((select id from world where key = 'job'))$$, '42501', null, 'another org cannot commit it');
select pg_temp.as_user('alice');
select lives_ok($$insert into world select 'batch', app.request_import_commit((select id from world where key = 'job'))$$, 'Alice commits');
select pg_temp.as_platform();
select is((select import_status::text from app.import_jobs where id = pg_temp.id('job')), 'Committing', 'the import is committing');
select is((select count(*)::int from app.job_queue where subject_id = pg_temp.id('batch') and job_kind = 'import.commit'), 1,
  'and the worker is queued for the batch');
select pg_temp.as_user('alice');
select throws_ok($$select app.request_import_commit((select id from world where key = 'job'))$$, 'XR001',
  'import_not_validated: Only a validated import is committed.', 'a batch is opened once');

-- Writing and undo (worker, then person) -----------------------------------------------------------------------
select pg_temp.as_platform();
select pg_temp.claims('alice');
insert into world select 'new_cp', app.create_counterparty(pg_temp.id('org_a'), 'Bayfront Catering', null);
select pg_temp.as_platform();
select app.commit_import_write(pg_temp.id('row_new'), pg_temp.id('batch'), pg_temp.id('new_cp'), 'Created');
select app.finish_import_batch(pg_temp.id('batch'));
select is((select import_status::text from app.import_jobs where id = pg_temp.id('job')), 'Committed', 'the batch commits');
select pg_temp.as_user('alice');
select is((select reverted from app.undo_import_batch(pg_temp.id('batch'), 'Wrong file.')), 1, 'the whole batch is undone');
select is((select count(*)::int from app.counterparties where id = pg_temp.id('new_cp') and deleted_at is null), 0, 'and the created row went to Trash');

-- Job cancelling stays the person''s only status change -------------------------------------------------------
with x as (insert into app.import_jobs (org_id, target_code, source, original_filename, storage_object_path)
  values (pg_temp.id('org_a'), 'venues', 'CSV', 'venues.csv', pg_temp.id('alice') || '/' || gen_random_uuid() || '.csv')
  returning id) insert into world select 'job2', id from x;
select throws_ok($$update app.import_jobs set import_status = 'Validated' where id = (select id from world where key = 'job2')$$,
  'XR001', null, 'a person cannot mark an import validated');
select lives_ok($$update app.import_jobs set import_status = 'Canceled' where id = (select id from world where key = 'job2')$$,
  'but may cancel one');

select * from finish();
rollback;
