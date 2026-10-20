-- pgTAP: migration 1297, finding A69-006 (RRR-114). The worker reads a sync run's source file with the service role,
-- so a run may name only a spreadsheet in the imports bucket that the enqueuing person uploaded (or, for the platform,
-- that a member of the run's org uploaded). Another org's files, other buckets and other people's uploads are refused.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(9);

select pg_temp.as_user('bob');
with c as (insert into app.integration_connections (org_id, provider_code, display_name)
  values (pg_temp.id('org_a'), 'ticketing_csv', 'Box Office Exports') returning id) insert into world select 'csv', id from c;
select app.transition_integration_connection(pg_temp.id('csv'), 'Pending', 'Connected', 'Ready for exports.');

create function pg_temp.enqueue(p_key text, p_source text) returns uuid
language sql as $$
  select app.enqueue_integration_sync(pg_temp.id('csv'), 'Attendance Import', 'Inbound', p_key, pg_temp.id('prj_a'),
    3::smallint, null, null, p_source)
$$;

select throws_ok($$select pg_temp.enqueue('k1', 'onboarding-uploads/' || pg_temp.id('org_b') || '/w9.pdf')$$,
  'XR001', 'integration_source_location: A sync run imports a spreadsheet uploaded to the imports bucket.',
  'another bucket (another org''s onboarding uploads) is refused');
select throws_ok($$select pg_temp.enqueue('k2', 'attachments/' || pg_temp.id('org_a') || '/x.csv')$$,
  'XR001', null, 'the attachments bucket is refused, even in the caller''s own org');
select throws_ok($$select pg_temp.enqueue('k3', 'imports/box-office.csv')$$,
  'XR001', null, 'a name the imports bucket never issues is refused');
select throws_ok($$select pg_temp.enqueue('k4', 'imports/' || pg_temp.id('xavier') || '/0193f2c4-0000-7000-8000-000000000004.csv')$$,
  'XR001', 'integration_source_owner: A sync run imports a spreadsheet you uploaded yourself.',
  'another person''s upload (another org''s Owner) is refused');
select throws_ok($$select pg_temp.enqueue('k5', 'imports/' || pg_temp.id('carol') || '/0193f2c4-0000-7000-8000-000000000005.csv')$$,
  'XR001', 'integration_source_owner: A sync run imports a spreadsheet you uploaded yourself.',
  'a colleague''s upload in the same org is refused too');
select throws_ok($$select pg_temp.enqueue('k6', 'imports/' || pg_temp.id('bob') || '/../' || pg_temp.id('xavier') || '/0193f2c4-0000-7000-8000-000000000006.csv')$$,
  'XR001', null, 'a path that climbs out of the uploader''s folder is refused');
select lives_ok($$select pg_temp.enqueue('k7', 'imports/' || pg_temp.id('bob') || '/0193f2c4-0000-7000-8000-000000000007.csv')$$,
  'the enqueuing person''s own upload is accepted');

-- The platform (no person) may name an upload of any member of the run's org, never of an outsider.
select app.cancel_integration_sync((select id from app.integration_sync_runs where idempotency_key = 'k7'), 'Test: frees the scope.');
select pg_temp.as_platform();
select throws_ok($$insert into app.integration_sync_runs (integration_connection_id, project_id, sync_scope, direction, idempotency_key, source_uri)
  values ((select id from world where key = 'csv'), (select id from world where key = 'prj_a'), 'Attendance Import', 'Inbound', 'k8',
    'imports/' || (select id from world where key = 'xavier') || '/0193f2c4-0000-7000-8000-000000000008.csv')$$,
  'XR001', 'integration_source_owner: A sync run imports a spreadsheet a member of its org uploaded.',
  'the platform cannot import an outsider''s upload');
select lives_ok($$insert into app.integration_sync_runs (integration_connection_id, project_id, sync_scope, direction, idempotency_key, source_uri)
  values ((select id from world where key = 'csv'), (select id from world where key = 'prj_a'), 'Attendance Import', 'Inbound', 'k9',
    'imports/' || (select id from world where key = 'carol') || '/0193f2c4-0000-7000-8000-000000000009.csv')$$,
  'the platform imports an upload of a member of the run''s org');

select * from finish();
rollback;
