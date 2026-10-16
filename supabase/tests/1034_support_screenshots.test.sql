-- pgTAP: support screenshots (A33 for A31's support flow). The bucket is private; only the uploader
-- uploads and reads under their own folder, other members and other orgs read nothing, anon reads
-- nothing, nobody updates or deletes through the API, and diagnostics name only the requester's own
-- screenshot.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(12);

create function pg_temp.shot(p_person text, p_file text) returns text
language sql stable as $$ select pg_temp.id(p_person)::text || '/' || p_file $$;

select is((select public from storage.buckets where id = 'support-screenshots'), false, 'the bucket is private');

select pg_temp.as_user('dave');
select lives_ok(format($$insert into storage.objects (bucket_id, name) values ('support-screenshots', %L)$$, pg_temp.shot('dave', 'screen-1.png')),
  'a member uploads under their own folder');
select throws_ok(format($$insert into storage.objects (bucket_id, name) values ('support-screenshots', %L)$$, pg_temp.shot('erin', 'screen-1.png')),
  '42501', null, 'not under someone else''s');
select throws_ok(format($$insert into storage.objects (bucket_id, name) values ('support-screenshots', %L)$$, pg_temp.id('dave')::text || '/nested/screen.png'),
  '42501', null, 'and only directly in their folder');
select is((select count(*)::int from storage.objects where bucket_id = 'support-screenshots'), 1, 'the uploader reads their screenshot');
select pg_temp.as_user('bob');
select is((select count(*)::int from storage.objects where bucket_id = 'support-screenshots'), 0, 'an Admin of the same org does not');
select pg_temp.as_user('xavier');
select is((select count(*)::int from storage.objects where bucket_id = 'support-screenshots'), 0, 'another org does not');
select pg_temp.as_anon();
select is((select count(*)::int from storage.objects where bucket_id = 'support-screenshots'), 0, 'anon does not');
select pg_temp.as_platform();
select is((select count(*)::int from storage.objects where bucket_id = 'support-screenshots'), 1, 'the platform reads it through the service role');

select pg_temp.as_user('dave');
update storage.objects set metadata = '{"rewritten": true}'::jsonb where bucket_id = 'support-screenshots';
select pg_temp.as_platform();
select is((select count(*)::int from storage.objects where bucket_id = 'support-screenshots' and metadata ? 'rewritten'), 0,
  'nobody rewrites a screenshot through the API');
select pg_temp.as_user('dave');
select lives_ok(format($$select app.open_support_ticket((select id from world where key = 'org_a'), 'Organization', 'Problem', 'Board will not load', 'The board spins.', 'Severity 3',
  jsonb_build_object('consent', 'true', 'route', '/northwind-live/work', 'screenshot_path', %L))$$, pg_temp.shot('dave', 'screen-1.png')),
  'a request attaches the requester''s own screenshot');
select throws_ok(format($$select app.open_support_ticket((select id from world where key = 'org_a'), 'Organization', 'Problem', 'Borrowed', 'Someone else''s screen.', 'Severity 3',
  jsonb_build_object('consent', 'true', 'screenshot_path', %L))$$, pg_temp.shot('erin', 'screen-9.png')),
  'XR001', 'support_screenshot_owner: A screenshot is attached only from the requester''s own uploads.', 'never someone else''s');
select pg_temp.as_platform();

select * from finish();
rollback;
