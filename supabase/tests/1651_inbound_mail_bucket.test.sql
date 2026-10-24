-- pgTAP: migration 1651, the raw inbound mail bucket (ADR 0033, decision 60; RRR-139). Resend keeps a received message
-- for 30 days, so the inbound-email function keeps its raw file in inbound-mail, a private bucket of message/rfc822 up
-- to 50 MiB that no signed-in person reads or writes. The object name the row records is what an org purge finds.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(7);

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

-- The function stores the raw message and files the mail.
select pg_temp.as_platform();
insert into storage.objects (bucket_id, name, metadata)
values ('inbound-mail', 'resend/4ef9a417-02e9-4d39-ad75-9611e0fcc33c.eml', '{"mimetype": "message/rfc822", "size": 2048}');
select pg_temp.as_user('bob');
insert into k (key, val) values ('local', app.create_project_inbox(pg_temp.id('prj_a')));
select pg_temp.as_platform();
insert into k (key, id) values ('message', app.receive_inbound_email((select val from k where key = 'local'),
  'rigging@bayside-audio.test', 'Rigging plot v4', '<plot-v4@bayside-audio.test>', true, 'Updated plot attached.',
  'resend/4ef9a417-02e9-4d39-ad75-9611e0fcc33c.eml'));

select is((select raw_object_path from app.inbound_messages where id = (select id from k where key = 'message')),
  'resend/4ef9a417-02e9-4d39-ad75-9611e0fcc33c.eml', 'the row records the raw message''s object name');

select ok(
  ('inbound-mail', 'resend/4ef9a417-02e9-4d39-ad75-9611e0fcc33c.eml') in
    (select o.bucket_id, o.name from private.org_storage_objects(pg_temp.id('org_a')) o),
  'an org purge finds the raw message through that name');

-- People who file the mail still see no raw file, and nobody signed in can write one.
select pg_temp.as_user('bob');
select is((select count(*)::integer from storage.objects where bucket_id = 'inbound-mail'), 0,
  'a coordinator who files the mail cannot list or read the raw message');

create function pg_temp.store_raw() returns text
language plpgsql as $$
begin
  insert into storage.objects (bucket_id, name, owner_id, metadata)
  values ('inbound-mail', 'resend/forged.eml', pg_temp.id('bob_user')::text, '{"mimetype": "message/rfc822", "size": 10}');
  return 'stored';
exception when others then
  return sqlstate;
end $$;
select is(pg_temp.store_raw(), '42501', 'nor store a raw message of their own');

select pg_temp.as_anon();
select is((select count(*)::integer from storage.objects where bucket_id = 'inbound-mail'), 0, 'anon sees none either');

select * from finish();
rollback;
