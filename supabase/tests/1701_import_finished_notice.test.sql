-- pgTAP: migration 1701, import finished notices (A104, RRR-149; a follow-up of A83). The import worker calls
-- app.notify_import_finished when it finishes validating an import and when it finishes committing a batch: each call
-- creates exactly one import.finished notification, for the person who started the import and then for the person who
-- committed it, with the counts read from the import's rows (as numbers) and the absolute review link the worker built,
-- the arguments the import_finished email template reads. Only the service role calls it, and only for a validated
-- import or a committed batch.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(18);

create function pg_temp.notices(p_person text) returns integer
language plpgsql as $$
declare
  v_count integer;
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
  select count(*)::int into v_count from app.notifications n
  where n.recipient_person_id = pg_temp.id(p_person) and n.kind = 'import.finished';
  return v_count;
end $$;

create function pg_temp.notice_args(p_person text, p_stage text) returns jsonb
language sql as $$
  select n.message_args from app.notifications n
  where n.recipient_person_id = pg_temp.id(p_person) and n.kind = 'import.finished' and n.message_args ->> 'stage' = p_stage
$$;

-- World: Alice uploads a customer list, the worker validates it (two rows ready, one invalid, one blank) --------------------
select pg_temp.as_platform();
insert into world select 'upload', gen_random_uuid();
select pg_temp.as_user('alice');
insert into storage.objects (bucket_id, name, owner_id)
values ('imports', pg_temp.id('alice') || '/' || pg_temp.id('upload') || '.csv', pg_temp.id('alice_user'));
select pg_temp.as_platform();
do $$ begin perform app.record_object_scan((select s.id from private.object_scans s where s.bucket_id = 'imports'
  and s.object_name = pg_temp.id('alice') || '/' || pg_temp.id('upload') || '.csv'), true); end $$;
select pg_temp.as_user('alice');
with x as (insert into app.import_jobs (org_id, target_code, source, original_filename, storage_object_path)
  values (pg_temp.id('org_a'), 'counterparties', 'CSV', 'customers.csv', pg_temp.id('alice') || '/' || pg_temp.id('upload') || '.csv')
  returning id) insert into world select 'job', id from x;
select pg_temp.as_platform();
update app.import_jobs set import_status = 'Mapped', mapping_confirmed_at = now(), sheet_name = 'customers.csv'
where id = pg_temp.id('job');
insert into world select 'row_new', app.record_import_row(pg_temp.id('job'), 'customers.csv', 2, 'Valid', null, null, null);
insert into world select 'row_late', app.record_import_row(pg_temp.id('job'), 'customers.csv', 3, 'Valid', null, null, null);
insert into world select 'row_bad', app.record_import_row(pg_temp.id('job'), 'customers.csv', 4, 'Invalid', 'name: required', null, null);
insert into world select 'row_blank', app.record_import_row(pg_temp.id('job'), 'customers.csv', 5, 'Skipped', null, null, null);
insert into world values ('link', gen_random_uuid());

-- Who may call it ---------------------------------------------------------------------------------------------------------
select ok(has_function_privilege('service_role', 'app.notify_import_finished(uuid, uuid, text)', 'execute')
  and not has_function_privilege('authenticated', 'app.notify_import_finished(uuid, uuid, text)', 'execute')
  and not has_function_privilege('anon', 'app.notify_import_finished(uuid, uuid, text)', 'execute'),
  'only the import worker (service role) announces an import');
select throws_ok(format($$select app.notify_import_finished('%s', null, 'https://atlas.example/northwind-live/import')$$,
  pg_temp.id('job')), 'XR001', 'import_not_finished: Only a validated import or a committed batch is announced.',
  'an import still being validated is not announced');

-- Validated ---------------------------------------------------------------------------------------------------------------
update app.import_jobs set import_status = 'Validated' where id = pg_temp.id('job');
select throws_ok(format($$select app.notify_import_finished('%s', null, '/northwind-live/import')$$, pg_temp.id('job')),
  'XR001', 'import_review_url_invalid: The review link is an absolute http or https address.',
  'the review link is absolute');
select throws_ok($$select app.notify_import_finished(gen_random_uuid(), null, 'https://atlas.example/northwind-live/import')$$,
  'XR001', 'import_not_found: No import has that id.', 'an unknown import is refused');
select isnt(app.notify_import_finished(pg_temp.id('job'), null,
  'https://atlas.example/northwind-live/import?import=' || pg_temp.id('job')), null, 'the validated import is announced');
select is(pg_temp.notices('alice'), 1, 'which creates one notice for Alice, who started it');
select is((select jsonb_build_object('title', a ->> 'title', 'importName', a ->> 'importName', 'written', a -> 'written',
  'refused', a -> 'refused', 'skipped', a -> 'skipped') from pg_temp.notice_args('alice', 'validated') a),
  jsonb_build_object('title', 'customers.csv', 'importName', 'customers.csv', 'written', 2, 'refused', 1, 'skipped', 1),
  'named after the file, with two rows ready to write, one to fix and one skipped, as numbers');
select is(pg_temp.notice_args('alice', 'validated') ->> 'url', 'https://atlas.example/northwind-live/import?import=' || pg_temp.id('job'),
  'and the review link the worker built');
select is((select n.subject_table || ' ' || n.subject_id from app.notifications n
  where n.recipient_person_id = pg_temp.id('alice') and n.kind = 'import.finished'), 'app.import_jobs ' || pg_temp.id('job'),
  'the notice is about the import');
select is((select count(*)::int from app.notification_deliveries d join app.notifications n on n.id = d.notification_id
  where n.recipient_person_id = pg_temp.id('alice') and n.kind = 'import.finished' and d.channel = 'Email'), 1,
  'and goes out by email, with the import_finished template');

-- Committed ---------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('bob');
select lives_ok($$insert into world select 'batch', app.request_import_commit((select id from world where key = 'job'))$$,
  'Bob commits the import');
select pg_temp.as_platform();
select throws_ok(format($$select app.notify_import_finished('%s', '%s', 'https://atlas.example/northwind-live/import')$$,
  pg_temp.id('job'), pg_temp.id('batch')), 'XR001', 'import_not_finished: Only a validated import or a committed batch is announced.',
  'a batch still being written is not announced');
select throws_ok(format($$select app.notify_import_finished('%s', null, 'https://atlas.example/northwind-live/import')$$,
  pg_temp.id('job')), 'XR001', 'import_not_finished: Only a validated import or a committed batch is announced.',
  'nor is the import as validated once it is committing');
select pg_temp.claims('bob');
insert into world select 'new_cp', app.create_counterparty(pg_temp.id('org_a'), 'Bayfront Catering', null);
select pg_temp.as_platform();
select app.commit_import_write(pg_temp.id('row_new'), pg_temp.id('batch'), pg_temp.id('new_cp'), 'Created');
update app.import_row_results set row_state = 'Refused', reason = 'duplicate key value' where id = pg_temp.id('row_late');
select app.finish_import_batch(pg_temp.id('batch'));
select isnt(app.notify_import_finished(pg_temp.id('job'), pg_temp.id('batch'),
  'https://atlas.example/northwind-live/import?import=' || pg_temp.id('job')), null, 'the committed batch is announced');
select is(pg_temp.notices('bob'), 1, 'which creates one notice for Bob, who committed it');
select is((select jsonb_build_object('written', a -> 'written', 'refused', a -> 'refused', 'skipped', a -> 'skipped')
  from pg_temp.notice_args('bob', 'committed') a),
  jsonb_build_object('written', 1, 'refused', 2, 'skipped', 1),
  'one row written, two not written (refused while writing, or invalid) and one skipped');
select is(pg_temp.notices('alice'), 1, 'Alice keeps her one notice');

-- An import nobody started (the service role made it) has nobody to tell.
insert into app.import_jobs (org_id, target_code, source, original_filename, storage_object_path, import_status)
values (pg_temp.id('org_a'), 'counterparties', 'CSV', 'service.csv', 'service/service.csv', 'Validated')
returning id as service_job \gset
select is(app.notify_import_finished(:'service_job', null, 'https://atlas.example/northwind-live/import'), null::uuid,
  'an import nobody started tells nobody');

select * from finish();
rollback;
