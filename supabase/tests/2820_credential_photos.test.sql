-- pgTAP: migration 2820 (P5, G-144), app.credential_photos. The constraints keep a photo's object in the holder's own
-- folder of the org and give every stored photo a consent record; one live row per org and holder. The holder reads
-- their rows, a credential reader of a project where the person holds a live credential reads theirs, and nobody else
-- does; nobody writes the table directly. The table is out of Trash and out of AI features, the photo path is personal
-- data in audit diffs, and the credential_photo consent purpose rests on consent.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select * from no_plan();

select has_table('app', 'credential_photos', 'app.credential_photos exists');
select isnt(obj_description('app.credential_photos'::regclass, 'pg_class'), null, 'it is documented');
select ok((select relrowsecurity from pg_class where oid = 'app.credential_photos'::regclass), 'it has row level security');
select ok(not has_table_privilege('authenticated', 'app.credential_photos', 'insert')
  and not has_table_privilege('authenticated', 'app.credential_photos', 'update')
  and not has_table_privilege('authenticated', 'app.credential_photos', 'delete'),
  'signed-in callers never write it directly');
select ok(not has_table_privilege('anon', 'app.credential_photos', 'select'), 'anon reads nothing');
select is(enum_range(null::app.credential_photo_source)::text, '{"Holder Upload","Holder Profile Photo"}',
  'a photo comes from the holder''s upload or their profile photo, never a desk');

-- Fixture: alice issues frank a Crew badge on prj_a, and mia one on prj_a2 (which has no project members).
select pg_temp.as_user('alice');
with c as (insert into app.credential_categories (project_id, code, name) values (pg_temp.id('prj_a'), 'CREW', 'Crew') returning id)
  insert into world select 'cat_a', id from c;
with c as (insert into app.credential_categories (project_id, code, name) values (pg_temp.id('prj_a2'), 'GALA', 'Gala') returning id)
  insert into world select 'cat_a2', id from c;
with c as (insert into app.credentials (credential_category_id, holder_person_id) values (pg_temp.id('cat_a'), pg_temp.id('frank')) returning id)
  insert into world select 'cred_frank', id from c;
with c as (insert into app.credentials (credential_category_id, holder_person_id) values (pg_temp.id('cat_a2'), pg_temp.id('mia')) returning id)
  insert into world select 'cred_mia', id from c;
select pg_temp.as_platform();

create function pg_temp.path(p_org text, p_person text, p_ext text default 'jpg') returns text
language sql stable as $$ select pg_temp.id(p_org) || '/' || pg_temp.id(p_person) || '/' || gen_random_uuid() || '.' || p_ext $$;

with r as (insert into app.consent_records (org_id, person_id, purpose_code, notice_version, source)
  values (pg_temp.id('org_a'), pg_temp.id('frank'), 'credential_photo', 'credential-photo-2026-11', 'Web') returning id)
  insert into world select 'consent_frank', id from r;
with r as (insert into app.consent_records (org_id, person_id, purpose_code, notice_version, source)
  values (pg_temp.id('org_a'), pg_temp.id('mia'), 'credential_photo', 'credential-photo-2026-11', 'Web') returning id)
  insert into world select 'consent_mia', id from r;

-- Constraints --------------------------------------------------------------------------------------------------------
select throws_ok(format($$insert into app.credential_photos (org_id, person_id, photo_path, consent_record_id)
    values (%L, %L, %L, %L)$$, pg_temp.id('org_a'), pg_temp.id('frank'), pg_temp.path('org_a', 'frank'), pg_temp.id('consent_frank')),
  '23514', null, 'a photo, its source and when it was given are set together');
select throws_ok(format($$insert into app.credential_photos (org_id, person_id, photo_path, source, provided_at, consent_record_id)
    values (%L, %L, %L, 'Holder Upload', now(), %L)$$, pg_temp.id('org_a'), pg_temp.id('frank'),
    pg_temp.id('org_a') || '/' || pg_temp.id('frank') || '/face.gif', pg_temp.id('consent_frank')),
  '23514', null, 'the object is a .jpg or .png named by a uuid');
select throws_ok(format($$insert into app.credential_photos (org_id, person_id, photo_path, source, provided_at, consent_record_id)
    values (%L, %L, %L, 'Holder Upload', now(), %L)$$, pg_temp.id('org_a'), pg_temp.id('frank'), pg_temp.path('org_a', 'mia'),
    pg_temp.id('consent_frank')),
  '23514', null, 'the object lies in the holder''s own folder');
select throws_ok(format($$insert into app.credential_photos (org_id, person_id, photo_path, source, provided_at, consent_record_id)
    values (%L, %L, %L, 'Holder Upload', now(), %L)$$, pg_temp.id('org_a'), pg_temp.id('frank'), pg_temp.path('org_b', 'frank'),
    pg_temp.id('consent_frank')),
  '23514', null, 'and in the org''s folder');
select throws_ok(format($$insert into app.credential_photos (org_id, person_id, photo_path, source, provided_at)
    values (%L, %L, %L, 'Holder Upload', now())$$, pg_temp.id('org_a'), pg_temp.id('frank'), pg_temp.path('org_a', 'frank')),
  '23514', null, 'every stored photo has a consent record');
select throws_ok(format($$insert into app.credential_photos (org_id, person_id, requested_at) values (%L, %L, now())$$,
    pg_temp.id('org_a'), pg_temp.id('frank')),
  '23514', null, 'when and by whom a photo was asked for are set together');
select lives_ok(format($$insert into app.credential_photos (org_id, person_id, photo_path, source, provided_at, provided_by, consent_record_id)
    values (%L, %L, %L, 'Holder Upload', now(), %L, %L)$$, pg_temp.id('org_a'), pg_temp.id('frank'), pg_temp.path('org_a', 'frank'),
    pg_temp.id('frank'), pg_temp.id('consent_frank')),
  'a holder''s photo in their own folder with their consent is stored');
select throws_ok(format($$insert into app.credential_photos (org_id, person_id, requested_at, requested_by) values (%L, %L, now(), %L)$$,
    pg_temp.id('org_a'), pg_temp.id('frank'), pg_temp.id('alice')),
  '23505', null, 'one live row per org and holder');
update app.credential_photos set deleted_at = now() where person_id = pg_temp.id('frank');
select lives_ok(format($$insert into app.credential_photos (org_id, person_id, requested_at, requested_by) values (%L, %L, now(), %L)$$,
    pg_temp.id('org_a'), pg_temp.id('frank'), pg_temp.id('alice')),
  'once removed, the org may ask again');
select throws_ok(format($$insert into app.credential_photos (org_id, person_id, photo_path, source, provided_at, consent_record_id)
    values (%L, %L, %L, 'Holder Upload', now(), %L)$$, pg_temp.id('org_b'), pg_temp.id('mia'), pg_temp.path('org_b', 'mia'),
    pg_temp.id('consent_mia')),
  'XR001', null, 'the consent record belongs to the same org');
insert into app.credential_photos (org_id, person_id, requested_at, requested_by)
values (pg_temp.id('org_a'), pg_temp.id('mia'), now(), pg_temp.id('alice'));

-- Reading ------------------------------------------------------------------------------------------------------------
create function pg_temp.rows(p_who text, p_person text) returns integer
language plpgsql as $$
declare v integer;
begin
  perform pg_temp.as_user(p_who);
  select count(*)::int into v from app.credential_photos where person_id = pg_temp.id(p_person) and deleted_at is null;
  perform pg_temp.as_platform();
  return v;
end $$;

select is(pg_temp.rows('frank', 'frank'), 1, 'the holder reads their own row');
select is(pg_temp.rows('mia', 'mia'), 1, 'and so does another holder');
select is(pg_temp.rows('dave', 'frank'), 1, 'a member who reads credentials on the project reads the holder''s row');
select is(pg_temp.rows('carol', 'mia'), 1, 'a manager reads credentials across the org, so reads it too');
select is(pg_temp.rows('erin', 'frank'), 1, 'a collaborator assigned to prj_a reads its holder''s row');
select is(pg_temp.rows('erin', 'mia'), 0, 'but not that of a holder on prj_a2, where she reads no credentials');
select is(pg_temp.rows('frank', 'mia'), 0, 'a holder never reads another holder''s row');
select is(pg_temp.rows('xavier', 'frank'), 0, 'another org reads nothing');

select pg_temp.as_user('alice');
update app.credentials set revoked_at = now() where id = pg_temp.id('cred_mia');
select pg_temp.as_platform();
select is(pg_temp.rows('carol', 'mia'), 0, 'once the holder''s only credential is revoked, readers no longer read the row');
select is(pg_temp.rows('mia', 'mia'), 1, 'the holder still does');

select pg_temp.as_user('frank');
select throws_ok(format($$insert into app.credential_photos (org_id, person_id, requested_at, requested_by) values (%L, %L, now(), %L)$$,
    pg_temp.id('org_a'), pg_temp.id('frank'), pg_temp.id('frank')),
  '42501', null, 'the holder cannot insert a row directly');
select throws_ok($$update app.credential_photos set requested_at = null, requested_by = null$$, '42501', null, 'nor change one');
select pg_temp.as_platform();

-- Registries ---------------------------------------------------------------------------------------------------------
select is((select lawful_basis from private.consent_purposes where code = 'credential_photo'), 'consent',
  'badge photos rest on the holder''s consent');
select ok(exists (select 1 from private.ai_excluded_tables where table_name = 'app.credential_photos'), 'no AI feature reads badge photos');
select ok(exists (select 1 from private.trash_excluded_tables where table_name = 'credential_photos'), 'badge photos stay out of Trash');
select ok(not exists (select 1 from private.trash_tables where table_name = 'credential_photos'), 'so Trash lists no badge photo');
select is(private.sync_trash_tables(), 0, 'and the Trash registry is already in step');
select ok(exists (select 1 from private.personal_data_keys where json_key = 'photo_path'), 'photo paths are redacted in audit diffs');
select is((select retention from private.retention_policies where table_name = 'app.credential_photos'), interval '90 days',
  'a removed photo row is kept 90 days');
select is((select count(*)::int from private.domain_event_types where code like 'credential_photo.%'), 3,
  'requested, provided and removed are domain events');

select * from finish();
rollback;
