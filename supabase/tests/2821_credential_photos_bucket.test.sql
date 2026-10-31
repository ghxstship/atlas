-- pgTAP: migration 2821 (P5, G-144), the credential-photos bucket. It is private, 2 MiB, JPEG and PNG, scanned like the
-- other upload buckets, and every earlier bucket is still scanned and still gated. A holder uploads only into their own
-- folder of an org where they hold a live credential; before a Clean scan only the uploader reads a photo, then the
-- org's credential readers do too, and another org never does. A photo a live row names cannot be deleted; once it is
-- unreferenced, the holder deletes it even after their credential is revoked, and so does the org's issuer.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select * from no_plan();
-- Deleting objects here stands in for the Storage API, as 1041 does.
set local storage.allow_delete_query = 'true';

-- Bucket and scanning --------------------------------------------------------------------------------------------------
select is((select public::text || '|' || file_size_limit::text || '|' || array_to_string(allowed_mime_types, ',')
    from storage.buckets where id = 'credential-photos'),
  'false|2097152|image/jpeg,image/png', 'credential-photos is private, 2 MiB, JPEG and PNG');
select ok(private.scanned_upload_bucket('credential-photos'), 'its objects are virus-scanned');
select ok(private.scanned_upload_bucket('field-media') and private.scanned_upload_bucket('onboarding-uploads')
    and private.scanned_upload_bucket('profile-media') and private.scanned_upload_bucket('org-brand')
    and private.scanned_upload_bucket('imports') and private.scanned_upload_bucket('support-screenshots')
    and private.scanned_upload_bucket('upload-staging'),
  'every bucket scanned before 2821 is still scanned');
select ok(not exists (select 1 from storage.buckets where id = 'party-uploads') or private.scanned_upload_bucket('party-uploads'),
  'and party-uploads too, where R9 adds it');
select ok(not private.scanned_upload_bucket('attachments'), 'attachments keep their own scan state');
create function pg_temp.gate() returns text
language sql stable as $$
  select qual from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'object_scan_read_gate' $$;
select is((select permissive from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'object_scan_read_gate'),
  'RESTRICTIVE', 'the read gate is still restrictive');
select ok(pg_temp.gate() like '%field-media%' and pg_temp.gate() like '%onboarding-uploads%' and pg_temp.gate() like '%credential-photos%',
  'it gates field-media, onboarding-uploads and credential-photos');
select ok(not exists (select 1 from storage.buckets where id = 'party-uploads') or pg_temp.gate() like '%party-uploads%',
  'and party-uploads, where R9 gates it');

-- Fixture: alice issues frank a Crew badge on prj_a. Frank holds nothing in org_b.
select pg_temp.as_user('alice');
with c as (insert into app.credential_categories (project_id, code, name) values (pg_temp.id('prj_a'), 'CREW', 'Crew') returning id)
  insert into world select 'cat_a', id from c;
with c as (insert into app.credentials (credential_category_id, holder_person_id) values (pg_temp.id('cat_a'), pg_temp.id('frank')) returning id)
  insert into world select 'cred_frank', id from c;
select pg_temp.as_platform();

create temporary table names (key text primary key, name text not null);
grant select, insert on names to public;
insert into names values
  ('own', pg_temp.id('org_a') || '/' || pg_temp.id('frank') || '/' || gen_random_uuid() || '.jpg'),
  ('own2', pg_temp.id('org_a') || '/' || pg_temp.id('frank') || '/' || gen_random_uuid() || '.png'),
  ('own3', pg_temp.id('org_a') || '/' || pg_temp.id('frank') || '/' || gen_random_uuid() || '.jpg'),
  ('other', pg_temp.id('org_a') || '/' || pg_temp.id('dave') || '/' || gen_random_uuid() || '.jpg'),
  ('org_b', pg_temp.id('org_b') || '/' || pg_temp.id('frank') || '/' || gen_random_uuid() || '.jpg'),
  ('bad', pg_temp.id('org_a') || '/' || pg_temp.id('frank') || '/face.gif');
create function pg_temp.n(p_key text) returns text language sql stable as $$ select name from names where key = p_key $$;

create function pg_temp.upload(p_who text, p_key text) returns void
language plpgsql as $$
begin
  perform pg_temp.as_user(p_who);
  insert into storage.objects (bucket_id, name, owner_id, metadata)
  values ('credential-photos', pg_temp.n(p_key), pg_temp.id(p_who || '_user')::text,
          jsonb_build_object('mimetype', 'image/jpeg', 'size', 40960));
  perform pg_temp.as_platform();
end $$;

create function pg_temp.visible(p_who text, p_key text) returns integer
language plpgsql as $$
declare v integer;
begin
  perform pg_temp.as_user(p_who);
  select count(*)::int into v from storage.objects o where o.bucket_id = 'credential-photos' and o.name = pg_temp.n(p_key);
  perform pg_temp.as_platform();
  return v;
end $$;

create function pg_temp.remove(p_who text, p_key text) returns integer
language plpgsql as $$
declare v integer;
begin
  perform pg_temp.as_user(p_who);
  with d as (delete from storage.objects o where o.bucket_id = 'credential-photos' and o.name = pg_temp.n(p_key) returning 1)
    select count(*)::int into v from d;
  perform pg_temp.as_platform();
  return v;
end $$;

-- Helpers ----------------------------------------------------------------------------------------------------------------
select is((select org_id::text || '/' || person_id::text from private.credential_photo_object(pg_temp.n('own'))),
  pg_temp.id('org_a')::text || '/' || pg_temp.id('frank')::text, 'an object name gives its org and holder');
select is((select count(*)::int from private.credential_photo_object(pg_temp.n('bad'))), 0, 'a malformed name gives nothing');
select is((select count(*)::int from private.credential_photo_object('../' || pg_temp.n('own'))), 0, 'nor does a name with a prefix');

-- Uploading --------------------------------------------------------------------------------------------------------------
select lives_ok($$select pg_temp.upload('frank', 'own')$$, 'the holder uploads into their own folder');
select is((select scan_status from private.object_scans where bucket_id = 'credential-photos' and object_name = pg_temp.n('own')),
  'Scanning'::app.scan_status, 'and the photo is queued for scanning');
select throws_ok($$select pg_temp.upload('frank', 'other')$$, '42501', null, 'nobody uploads into another person''s folder');
select throws_ok($$select pg_temp.upload('alice', 'other')$$, '42501', null, 'not even an issuer: there is no desk capture');
select throws_ok($$select pg_temp.upload('frank', 'org_b')$$, '42501', null, 'nor into an org where they hold no live credential');
select throws_ok($$select pg_temp.upload('frank', 'bad')$$, '42501', null, 'and a malformed name is refused');

-- Reading ----------------------------------------------------------------------------------------------------------------
select is(pg_temp.visible('frank', 'own'), 1, 'the uploader reads their photo while it is scanned');
select is(pg_temp.visible('dave', 'own'), 0, 'a credential reader does not, before it scans Clean');
update private.object_scans set scan_status = 'Clean', scanned_at = now()
where bucket_id = 'credential-photos' and object_name = pg_temp.n('own');
select is(pg_temp.visible('dave', 'own'), 1, 'once Clean, a credential reader of the project reads it');
select is(pg_temp.visible('carol', 'own'), 1, 'so does a manager, who reads credentials across the org');
select is(pg_temp.visible('xavier', 'own'), 0, 'another org never reads it');
select pg_temp.as_anon();
select is((select count(*)::int from storage.objects o where o.bucket_id = 'credential-photos'), 0, 'anon reads nothing');
select pg_temp.as_platform();

-- Deleting ---------------------------------------------------------------------------------------------------------------
with r as (insert into app.consent_records (org_id, person_id, purpose_code, notice_version, source)
  values (pg_temp.id('org_a'), pg_temp.id('frank'), 'credential_photo', 'credential-photo-2026-11', 'Web') returning id)
  insert into world select 'consent_frank', id from r;
insert into app.credential_photos (org_id, person_id, photo_path, source, provided_at, provided_by, consent_record_id)
values (pg_temp.id('org_a'), pg_temp.id('frank'), pg_temp.n('own'), 'Holder Upload', now(), pg_temp.id('frank'), pg_temp.id('consent_frank'));
select is(pg_temp.remove('frank', 'own'), 0, 'a photo a live row names cannot be deleted, even by its holder');
select is(pg_temp.remove('alice', 'own'), 0, 'nor by an issuer');

select pg_temp.upload('frank', 'own2');
select pg_temp.upload('frank', 'own3');
select is(pg_temp.remove('dave', 'own2'), 0, 'a reader without credentials.credential.issue on the project deletes nothing');
select pg_temp.as_user('alice');
update app.credentials set revoked_at = now() where id = pg_temp.id('cred_frank');
select pg_temp.as_platform();
insert into names values ('late', pg_temp.id('org_a') || '/' || pg_temp.id('frank') || '/' || gen_random_uuid() || '.jpg');
select throws_ok($$select pg_temp.upload('frank', 'late')$$, '42501', null, 'once revoked, the holder uploads no new photo');
select is(pg_temp.remove('frank', 'own2'), 1, 'after the revoke, the holder still deletes an unreferenced photo of theirs');
update private.object_scans set scan_status = 'Clean', scanned_at = now()
where bucket_id = 'credential-photos' and object_name = pg_temp.n('own3');
select is(pg_temp.remove('alice', 'own3'), 1, 'and an issuer of their credential deletes one too');
update app.credential_photos set deleted_at = now() where person_id = pg_temp.id('frank');
select is(pg_temp.remove('frank', 'own'), 1, 'once its row is removed, the photo it named can be deleted');
select is((select count(*)::int from private.object_scans where bucket_id = 'credential-photos'), 0, 'and its scan state goes with it');

select * from finish();
rollback;
