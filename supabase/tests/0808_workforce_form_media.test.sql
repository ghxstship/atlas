-- pgTAP: who writes and reads form photos and signatures in field-media (A29, 0808).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(8);

create temporary table k (key text primary key, value text);
grant select, insert on k to public;
insert into k values ('frank_path', pg_temp.id('org_a')::text || '/forms/' || pg_temp.id('frank')::text || '/hoist.jpg');

select pg_temp.claims('frank');
select ok(private.form_media_allowed((select value from k where key = 'frank_path'), true), 'a member uploads to their own form folder');
select ok(private.form_media_allowed((select value from k where key = 'frank_path'), false), 'and reads it back');
select ok(not private.form_media_allowed(pg_temp.id('org_a')::text || '/forms/' || pg_temp.id('dave')::text || '/x.jpg', true),
  'nobody uploads into someone else''s folder');
select ok(not private.form_media_allowed(pg_temp.id('org_a')::text || '/incidents/' || pg_temp.id('frank')::text || '/x.jpg', true),
  'only the forms folder is covered here');
select pg_temp.claims('gina');
select ok(not private.form_media_allowed((select value from k where key = 'frank_path'), false), 'another member does not read it');
select pg_temp.claims('carol');
select ok(private.form_media_allowed((select value from k where key = 'frank_path'), false), 'a form publisher reads it');
select pg_temp.claims('xavier');
select ok(not private.form_media_allowed((select value from k where key = 'frank_path'), false), 'no cross-tenant reads');
select pg_temp.as_platform();
select is((select count(*)::integer from pg_policies where tablename = 'objects' and policyname like 'field_media_form_%'), 2,
  'insert and read policies cover the forms folder');

select * from finish();
rollback;
