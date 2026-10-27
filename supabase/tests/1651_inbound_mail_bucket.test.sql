-- pgTAP: migration 1651, the raw inbound mail bucket (ADR 0033, decision 60; RRR-139). Resend keeps a received message
-- for 30 days, so the inbound-email function keeps its raw file in inbound-mail, a private bucket of message/rfc822 up
-- to 50 MiB that no signed-in person reads or writes. The object is named under the org, so an org purge finds it even
-- once retention has deleted its row. app.inbound_email_org names that org before anything is downloaded, and agrees
-- with app.receive_inbound_email on every address.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(16);

select results_eq(
  $$select public, file_size_limit, allowed_mime_types from storage.buckets where id = 'inbound-mail'$$,
  $$values (false, 52428800::bigint, array['message/rfc822'])$$,
  'inbound-mail is private, holds raw messages only, and caps each at 50 MiB like an inbound attachment');

select is_empty(
  $$select policyname::text from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and (coalesce(qual, '') ~ 'inbound-mail' or coalesce(with_check, '') ~ 'inbound-mail')$$,
  'no storage policy names the bucket: only the service role reaches it');

create temporary table k (key text primary key, id uuid, val text);
grant select, insert on k to public;

-- The org of each kind of address, before anything is filed.
select pg_temp.as_user('bob');
insert into k (key, val) values ('local', app.create_project_inbox(pg_temp.id('prj_a')));
select pg_temp.as_platform();
insert into k (key, val) values ('reply', private.reply_local_part(pg_temp.id('erin'), pg_temp.id('prj_a')));

select is(app.inbound_email_org((select val from k where key = 'local')), pg_temp.id('org_a'),
  'a project inbox''s mail goes to the project''s org');
select is(app.inbound_email_org(upper((select val from k where key = 'local'))), pg_temp.id('org_a'),
  'whatever the case of the address');
select is(app.inbound_email_org((select val from k where key = 'reply')),
  (select e.org_id from app.domain_events e where e.subject_id = pg_temp.id('prj_a') order by e.occurred_at desc limit 1),
  'a signed reply goes to the org of its thread''s latest event');
select is(app.inbound_email_org(regexp_replace((select val from k where key = 'reply'), '.$', 'x')), null::uuid,
  'a reply address with a bad signature has no org, so the function calls Resend for nothing');
select is(app.inbound_email_org('nobody-0000000000'), null::uuid, 'nor does an address with no inbox');

-- The function names the raw message under that org, stores it, and files the mail there.
insert into k (key, val) values ('raw', pg_temp.id('org_a')::text || '/resend/4ef9a417-02e9-4d39-ad75-9611e0fcc33c.eml');
insert into storage.objects (bucket_id, name, metadata)
values ('inbound-mail', (select val from k where key = 'raw'), '{"mimetype": "message/rfc822", "size": 2048}');
insert into k (key, id) values ('message', app.receive_inbound_email((select val from k where key = 'local'),
  'rigging@bayside-audio.test', 'Rigging plot v4', '<plot-v4@bayside-audio.test>', true, 'Updated plot attached.',
  (select val from k where key = 'raw')));
insert into k (key, id) values ('reply_message', app.receive_inbound_email((select val from k where key = 'reply'),
  'erin@northwind.test', 'Re: Load-in', '<reply-1651@northwind.test>', true, 'On my way.', 'raw/reply-1651.eml'));

select results_eq(
  $$select m.org_id, m.raw_object_path from app.inbound_messages m where m.id = (select id from k where key = 'message')$$,
  $$select app.inbound_email_org((select val from k where key = 'local')), (select val from k where key = 'raw')$$,
  'receive_inbound_email files the mail under the org inbound_email_org named, with the raw message''s object name');
select is((select m.org_id from app.inbound_messages m where m.id = (select id from k where key = 'reply_message')),
  app.inbound_email_org((select val from k where key = 'reply')), 'and a reply too');

select ok(
  ('inbound-mail', (select val from k where key = 'raw')) in
    (select o.bucket_id, o.name from private.org_storage_objects(pg_temp.id('org_a')) o),
  'an org purge finds the raw message');

-- Retention deletes the row after two years; the object's name still ties it to the org.
delete from app.inbound_messages where id = (select id from k where key = 'message');
select ok(
  ('inbound-mail', (select val from k where key = 'raw')) in
    (select o.bucket_id, o.name from private.org_storage_objects(pg_temp.id('org_a')) o),
  'and still finds it by its org prefix once retention has deleted the row');

-- A disabled inbox takes no mail, and so has no org.
select pg_temp.as_user('bob');
select app.disable_project_inbox(pg_temp.id('prj_a'));
select pg_temp.as_platform();
select is(app.inbound_email_org((select val from k where key = 'local')), null::uuid,
  'a disabled inbox has no org, as receive_inbound_email ignores its mail');

-- Only the service role asks.
select ok(has_function_privilege('service_role', 'app.inbound_email_org(text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'app.inbound_email_org(text)', 'EXECUTE')
  and not has_function_privilege('anon', 'app.inbound_email_org(text)', 'EXECUTE'),
  'only the service role may look up an inbox''s org');

-- People who file the mail still see no raw file, and nobody signed in can write one.
select pg_temp.as_user('bob');
select is((select count(*)::integer from storage.objects where bucket_id = 'inbound-mail'), 0,
  'a coordinator who files the mail cannot list or read the raw message');

create function pg_temp.store_raw() returns text
language plpgsql as $$
begin
  insert into storage.objects (bucket_id, name, owner_id, metadata)
  values ('inbound-mail', pg_temp.id('org_a')::text || '/resend/forged.eml', pg_temp.id('bob_user')::text,
    '{"mimetype": "message/rfc822", "size": 10}');
  return 'stored';
exception when others then
  return sqlstate;
end $$;
select is(pg_temp.store_raw(), '42501', 'nor store a raw message of their own');

select pg_temp.as_anon();
select is((select count(*)::integer from storage.objects where bucket_id = 'inbound-mail'), 0, 'anon sees none either');

select * from finish();
rollback;
