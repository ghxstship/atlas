-- pgTAP: migration 2822 (P5, G-144), asking for, giving and withdrawing badge photos, and the photo a badge prints.
-- An issuer asks a holder once a day, through credential_photo.requested opening /profile/badge-photos; a holder without
-- a sign-in, or with a photo already, is not asked. The holder records a photo from their own folder with a consent
-- record, replaces it, and withdraws it with the consent, even after their credential lapsed. An issuer removes a photo
-- once it scanned Clean or its object is gone, never while it is being scanned or after a scan that could not clear it.
-- The state follows the resolution order: the badge photo once Clean (Scanning, then Refused when the scan rejects it),
-- else a profile photo the caller may see, JPEG or PNG of at most 2 MiB, with no block either way, else Requested or
-- Missing. The state view is not backed up.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select * from no_plan();
-- Deleting objects here stands in for the Storage API, as 1041 does.
set local storage.allow_delete_query = 'true';

select has_function('app', 'request_credential_photos', array['uuid[]'], 'app.request_credential_photos exists');
select ok(not has_function_privilege('anon', 'app.request_credential_photos(uuid[])', 'execute')
  and not has_function_privilege('anon', 'app.record_credential_photo(uuid, text, app.credential_photo_source, text)', 'execute')
  and not has_function_privilege('anon', 'app.remove_credential_photo(uuid, uuid)', 'execute')
  and not has_function_privilege('anon', 'app.withdraw_my_credential_photos(uuid)', 'execute')
  and not has_function_privilege('anon', 'app.credential_badge_photos(uuid[])', 'execute')
  and not has_function_privilege('anon', 'app.my_credential_photos()', 'execute'),
  'anon calls none of the badge photo functions');
select ok((select bool_and(p.prosecdef and p.proconfig @> array['search_path=""']) from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app' and p.proname in ('request_credential_photos', 'record_credential_photo', 'remove_credential_photo',
      'withdraw_my_credential_photos', 'credential_badge_photos', 'my_credential_photos')),
  'each is security definer with an empty search_path');
select ok(not has_table_privilege('xos_backup', 'app.credential_photo_states', 'select'), 'the backup login does not read the state view');
select ok(not has_table_privilege('anon', 'app.credential_photo_states', 'select'), 'nor does anon');
select ok(has_table_privilege('authenticated', 'app.credential_photo_states', 'select'), 'signed-in callers read it under their own access');
select is(enum_range(null::app.credential_photo_state)::text, '{Provided,Scanning,Refused,Profile,Requested,Missing}',
  'the states in resolution order');

-- Fixture: alice issues frank and gina badges on prj_a, and one to a crew member with no sign-in. Dave coordinates prj_a.
select pg_temp.as_platform();
with p as (insert into app.people (full_name) values ('Nadia Offline') returning id) insert into world select 'nadia', id from p;
select pg_temp.as_user('alice');
with c as (insert into app.credential_categories (project_id, code, name) values (pg_temp.id('prj_a'), 'CREW', 'Crew') returning id)
  insert into world select 'cat_a', id from c;
with c as (insert into app.credentials (credential_category_id, holder_person_id) values (pg_temp.id('cat_a'), pg_temp.id('frank')) returning id)
  insert into world select 'cred_frank', id from c;
with c as (insert into app.credentials (credential_category_id, holder_person_id) values (pg_temp.id('cat_a'), pg_temp.id('frank')) returning id)
  insert into world select 'cred_frank2', id from c;
with c as (insert into app.credentials (credential_category_id, holder_person_id) values (pg_temp.id('cat_a'), pg_temp.id('gina')) returning id)
  insert into world select 'cred_gina', id from c;
with c as (insert into app.credentials (credential_category_id, holder_person_id) values (pg_temp.id('cat_a'), pg_temp.id('nadia')) returning id)
  insert into world select 'cred_nadia', id from c;
select pg_temp.as_platform();

create function pg_temp.state(p_who text, p_credential text) returns text
language plpgsql as $$
declare v text;
begin
  perform pg_temp.as_user(p_who);
  select b.photo_state::text into v from app.credential_badge_photos(array[pg_temp.id(p_credential)]) b;
  perform pg_temp.as_platform();
  return v;
end $$;

create function pg_temp.source(p_who text, p_credential text) returns text
language plpgsql as $$
declare v text;
begin
  perform pg_temp.as_user(p_who);
  select b.bucket_id || '|' || b.photo_path into v from app.credential_badge_photos(array[pg_temp.id(p_credential)]) b;
  perform pg_temp.as_platform();
  return v;
end $$;

create function pg_temp.outcomes(p_who text, p_credentials text[]) returns text
language plpgsql as $$
declare v text;
begin
  perform pg_temp.as_user(p_who);
  select string_agg(r.outcome, ',' order by array_position(p_credentials, w.key)) into v
  from app.request_credential_photos(array(select pg_temp.id(k) from unnest(p_credentials) k)) r
  join world w on w.id = r.credential_id;
  perform pg_temp.as_platform();
  return v;
end $$;

create function pg_temp.upload(p_who text, p_ext text default 'jpg', p_org text default 'org_a') returns text
language plpgsql as $$
declare v text := pg_temp.id(p_org) || '/' || pg_temp.id(p_who) || '/' || gen_random_uuid() || '.' || p_ext;
begin
  insert into storage.objects (bucket_id, name, owner_id, metadata)
  values ('credential-photos', v, pg_temp.id(p_who || '_user')::text, jsonb_build_object('mimetype', 'image/jpeg', 'size', 40960));
  return v;
end $$;

create function pg_temp.scanned(p_name text, p_status app.scan_status) returns void
language sql as $$
  update private.object_scans set scan_status = p_status, scanned_at = case when p_status = 'Scanning' then null else now() end
  where bucket_id = 'credential-photos' and object_name = p_name $$;

select is(pg_temp.state('alice', 'cred_frank'), 'Missing', 'a holder with no photo and a Private profile reads Missing');

-- Asking ---------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
select throws_ok($$select * from app.request_credential_photos('{}')$$, 'XR001',
  'credential_photo_batch_size: Ask for the photos of 1 to 100 credentials at a time.', 'an empty request is refused');
select throws_ok($$select * from app.request_credential_photos(array(select gen_random_uuid() from generate_series(1, 101)))$$, 'XR001',
  'credential_photo_batch_size: Ask for the photos of 1 to 100 credentials at a time.', 'so is one for more than 100 credentials');
select throws_ok($$select * from app.credential_badge_photos(array(select gen_random_uuid() from generate_series(1, 101)))$$, 'XR001',
  'credential_photo_batch_size: Ask for the photos of 1 to 100 credentials at a time.', 'and reading more than 100 badges at once');
select pg_temp.as_platform();

select is(pg_temp.outcomes('gina', array['cred_frank']), 'not_allowed', 'a viewer cannot ask: she does not issue credentials');
select is(pg_temp.outcomes('dave', array['cred_frank', 'cred_frank2', 'cred_nadia']), 'requested,requested,no_sign_in',
  'an issuer asks; two badges of one holder ask once, and a holder with no sign-in is not asked');
select is((select count(*)::int from app.notifications n where n.recipient_person_id = pg_temp.id('frank') and n.kind = 'credential_photo.requested'), 1,
  'the holder gets one notification');
select is((select n.message_args ->> 'gatewayPath' || '|' || (n.message_args ->> 'orgName') || '|' || n.subject_table from app.notifications n
    where n.recipient_person_id = pg_temp.id('frank') and n.kind = 'credential_photo.requested'),
  '/profile/badge-photos|Northwind Live|app.credentials', 'it opens the badge photos page in Gateway and names the org');
select is((select requested_by from app.credential_photos where person_id = pg_temp.id('frank') and deleted_at is null), pg_temp.id('dave'),
  'the request is stamped with who asked');
select is((select count(*)::int from app.domain_events where event_type = 'credential_photo.requested' and not (data ? 'photo_path')), 1,
  'and emits credential_photo.requested, which carries ids only');
select is(pg_temp.state('alice', 'cred_frank'), 'Requested', 'the badge now reads Requested');
select is(pg_temp.outcomes('alice', array['cred_frank']), 'recently_requested', 'a second request within 24 hours sends nothing');
select is((select count(*)::int from app.notifications n where n.recipient_person_id = pg_temp.id('frank') and n.kind = 'credential_photo.requested'), 1,
  'so there is still one notification');
update app.credential_photos set requested_at = now() - interval '25 hours' where person_id = pg_temp.id('frank');
select is(pg_temp.outcomes('alice', array['cred_frank']), 'requested', 'a day later the org may ask again');

-- Giving -----------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('frank');
select throws_ok(format($$select * from app.record_credential_photo(%L, %L, 'Holder Upload', 'credential-photo-2026-11')$$,
    pg_temp.id('org_a'), pg_temp.id('org_a') || '/' || pg_temp.id('gina') || '/' || gen_random_uuid() || '.jpg'),
  'XR001', 'credential_photo_path: Upload the photo to your own folder, then record it.', 'a holder records only a photo in their own folder');
select throws_ok(format($$select * from app.record_credential_photo(%L, %L, 'Holder Upload', 'credential-photo-2026-11')$$,
    pg_temp.id('org_a'), pg_temp.id('org_a') || '/' || pg_temp.id('frank') || '/' || gen_random_uuid() || '.jpg'),
  'XR001', 'credential_photo_path: Upload the photo to your own folder, then record it.', 'and only one they uploaded');
select throws_ok(format($$select * from app.record_credential_photo(%L, %L, 'Holder Upload', 'credential-photo-2026-11')$$,
    pg_temp.id('org_b'), pg_temp.id('org_b') || '/' || pg_temp.id('frank') || '/' || gen_random_uuid() || '.jpg'),
  'XR001', 'credential_photo_no_credential: You hold no live credential with this organization, so it takes no badge photo from you.',
  'an org where they hold no live credential takes no photo from them');
create temporary table paths (key text primary key, name text);
grant select, insert, update on paths to public;
insert into paths values ('one', pg_temp.upload('frank'));
select throws_ok(format($$select * from app.record_credential_photo(%L, %L, 'Holder Upload', '')$$,
    pg_temp.id('org_a'), (select name from paths where key = 'one')),
  'XR001', null, 'the notice version shown is required');
select is((select replaced_path from app.record_credential_photo(pg_temp.id('org_a'), (select name from paths where key = 'one'), 'Holder Upload',
    'credential-photo-2026-11')), null, 'the holder records the photo they uploaded; it replaces nothing');
select pg_temp.as_platform();
select is((select r.purpose_code || '|' || r.notice_version || '|' || r.source::text from app.consent_records r
    join app.credential_photos p on p.consent_record_id = r.id where p.person_id = pg_temp.id('frank') and p.deleted_at is null),
  'credential_photo|credential-photo-2026-11|Web', 'with a credential_photo consent record for the notice shown');
select is((select source::text from app.credential_photos where person_id = pg_temp.id('frank') and deleted_at is null), 'Holder Upload',
  'and its source');
select is(pg_temp.state('alice', 'cred_frank'), 'Scanning', 'while the photo is scanned the badge reads Scanning');
select is(pg_temp.outcomes('alice', array['cred_frank']), 'already_provided', 'and the org asks no more');
select pg_temp.scanned((select name from paths where key = 'one'), 'Clean');
select is(pg_temp.state('alice', 'cred_frank'), 'Provided', 'once Clean the badge prints the photo');
select is(pg_temp.source('alice', 'cred_frank'),
  'credential-photos|' || (select name from paths where key = 'one'), 'from the credential-photos bucket');
select is(pg_temp.state('frank', 'cred_frank'), 'Provided', 'the holder reads the same state');
select is(pg_temp.state('xavier', 'cred_frank'), null, 'another org reads nothing');

select pg_temp.as_user('frank');
insert into paths values ('two', pg_temp.upload('frank', 'png'));
select is((select replaced_path from app.record_credential_photo(pg_temp.id('org_a'), (select name from paths where key = 'two'), 'Holder Upload',
    'credential-photo-2026-11')), (select name from paths where key = 'one'), 'a new photo returns the one it replaced, for removal');
select pg_temp.as_platform();
select is((select count(*)::int from app.consent_records where person_id = pg_temp.id('frank') and purpose_code = 'credential_photo'), 1,
  'the standing consent is reused');
select pg_temp.scanned((select name from paths where key = 'two'), 'Infected');
select is(pg_temp.state('alice', 'cred_frank'), 'Refused', 'a photo the scan finds Infected reads Refused, never Missing');
delete from storage.objects where bucket_id = 'credential-photos' and name = (select name from paths where key = 'two');
select is(pg_temp.state('alice', 'cred_frank'), 'Refused', 'and so does a photo whose object is gone');

-- Removing ---------------------------------------------------------------------------------------------------------------
create function pg_temp.removed(p_who text, p_person text) returns text
language plpgsql as $$
declare v text;
begin
  perform pg_temp.as_user(p_who);
  select coalesce(string_agg(r, ',' order by r), '') into v from app.remove_credential_photo(pg_temp.id('org_a'), pg_temp.id(p_person)) r;
  perform pg_temp.as_platform();
  return v;
end $$;

select pg_temp.as_user('gina');
select throws_ok(format($$select * from app.remove_credential_photo(%L, %L)$$, pg_temp.id('org_a'), pg_temp.id('frank')), 'XR001',
  'credential_photo_not_issuer: Only an issuer of this person''s credentials removes their badge photo.',
  'a viewer cannot remove a photo, and is told so by rule');
select pg_temp.as_user('frank');
insert into paths values ('four', pg_temp.upload('frank'));
select app.record_credential_photo(pg_temp.id('org_a'), (select name from paths where key = 'four'), 'Holder Upload', 'credential-photo-2026-11');
select pg_temp.as_user('dave');
select throws_ok(format($$select * from app.remove_credential_photo(%L, %L)$$, pg_temp.id('org_a'), pg_temp.id('frank')), 'XR001',
  'credential_photo_scanning: This photo is still being scanned. Remove it once the scan finishes, in a few minutes.',
  'an issuer cannot remove a photo still being scanned: the read gate keeps its object from them');
select pg_temp.as_platform();
select is(pg_temp.state('alice', 'cred_frank'), 'Scanning', 'so the photo stays, Scanning');
select pg_temp.scanned((select name from paths where key = 'four'), 'Scan Failed');
select pg_temp.as_user('dave');
select throws_ok(format($$select * from app.remove_credential_photo(%L, %L)$$, pg_temp.id('org_a'), pg_temp.id('frank')), 'XR001',
  'credential_photo_unscanned: This photo could not be cleared by the virus scan, so only its holder can delete it. Ask them to replace or remove it in Gateway.',
  'nor one the scan could not clear while its object is still stored');
select pg_temp.as_platform();
select is(pg_temp.state('alice', 'cred_frank'), 'Refused', 'which stays Refused');
delete from storage.objects where bucket_id = 'credential-photos' and name = (select name from paths where key = 'four');
select is(pg_temp.removed('dave', 'frank'), (select name from paths where key = 'one'),
  'once the scanner deleted the object the issuer removes the photo, and gets only the Clean copy still stored to delete');
select is(pg_temp.state('alice', 'cred_frank'), 'Missing', 'the badge reads Missing');
select pg_temp.as_user('frank');
insert into paths values ('five', pg_temp.upload('frank'));
select app.record_credential_photo(pg_temp.id('org_a'), (select name from paths where key = 'five'), 'Holder Upload', 'credential-photo-2026-11');
select pg_temp.as_platform();
select pg_temp.scanned((select name from paths where key = 'five'), 'Clean');
select is(pg_temp.state('alice', 'cred_frank'), 'Provided', 'a new photo scanned Clean prints');
select is(pg_temp.removed('dave', 'frank'), (select string_agg(name, ',' order by name) from paths where key in ('one', 'five')),
  'an issuer removes a Clean photo and gets it, with the older Clean copy, to delete');
select is(pg_temp.removed('dave', 'frank'), '', 'removing again finds nothing');
select pg_temp.as_user('dave');
select ok((select bool_and(private.credential_photo_removable(name)) from paths where key in ('one', 'five')),
  'and the storage policy lets that issuer delete both objects now no live photo names them');
delete from storage.objects where bucket_id = 'credential-photos' and name = (select name from paths where key = 'five');
select pg_temp.as_platform();
select is(pg_temp.state('alice', 'cred_frank'), 'Missing', 'the badge reads Missing again');
select is((select withdrawn_at from app.consent_records where person_id = pg_temp.id('frank') and purpose_code = 'credential_photo'), null,
  'an org''s removal leaves the holder''s consent to them');

-- Profile photo ----------------------------------------------------------------------------------------------------------
select pg_temp.as_user('frank');
select app.ensure_my_profile();
select pg_temp.as_platform();
insert into storage.objects (bucket_id, name, metadata)
values ('profile-media', pg_temp.id('frank') || '/avatar.jpg', jsonb_build_object('mimetype', 'image/jpeg', 'size', 120000));
update app.person_profiles set photo_path = pg_temp.id('frank') || '/avatar.jpg', visibility = 'Private' where person_id = pg_temp.id('frank');
select is(pg_temp.state('alice', 'cred_frank'), 'Missing', 'a Private profile photo never stands in');
update app.person_profiles set visibility = 'Network' where person_id = pg_temp.id('frank');
select is(pg_temp.state('alice', 'cred_frank'), 'Profile', 'a Network profile photo stands in for someone in the holder''s network');
select is(pg_temp.source('alice', 'cred_frank'),
  'profile-media|' || pg_temp.id('frank') || '/avatar.jpg', 'read from the profile-media bucket');
insert into app.profile_section_visibility (person_id, section, visibility) values (pg_temp.id('frank'), 'photo', 'Private');
select is(pg_temp.state('alice', 'cred_frank'), 'Missing', 'unless the holder made the photo section Private');
update app.profile_section_visibility set deleted_at = now() where person_id = pg_temp.id('frank');
update app.person_profiles set visibility = 'Public' where person_id = pg_temp.id('frank');
select is(pg_temp.state('alice', 'cred_frank'), 'Profile', 'a Public profile photo stands in');
update storage.objects set metadata = jsonb_build_object('mimetype', 'image/webp', 'size', 120000)
where bucket_id = 'profile-media' and name = pg_temp.id('frank') || '/avatar.jpg';
select is(pg_temp.state('alice', 'cred_frank'), 'Missing', 'but never a WebP');
update storage.objects set metadata = jsonb_build_object('mimetype', 'image/png', 'size', 2097153)
where bucket_id = 'profile-media' and name = pg_temp.id('frank') || '/avatar.jpg';
select is(pg_temp.state('alice', 'cred_frank'), 'Missing', 'nor one over 2 MiB');
update storage.objects set metadata = jsonb_build_object('mimetype', 'image/png', 'size', 2097152)
where bucket_id = 'profile-media' and name = pg_temp.id('frank') || '/avatar.jpg';
select is(pg_temp.state('alice', 'cred_frank'), 'Profile', 'a PNG of exactly 2 MiB stands in');

select pg_temp.as_user('frank');
insert into app.blocks (blocked_urn) values ('urn:xpms:person:' || pg_temp.id('alice'));
select pg_temp.as_platform();
select is(pg_temp.state('alice', 'cred_frank'), 'Missing', 'a block by the holder hides their profile photo from the person they blocked');
select is(pg_temp.state('dave', 'cred_frank'), 'Profile', 'and from nobody else');
update app.blocks set deleted_at = now() where person_id = pg_temp.id('frank');
select pg_temp.as_user('alice');
insert into app.blocks (blocked_urn) values ('urn:xpms:person:' || pg_temp.id('frank'));
select pg_temp.as_platform();
select is(pg_temp.state('alice', 'cred_frank'), 'Missing', 'and a block the other way does too');
update app.blocks set deleted_at = now() where person_id = pg_temp.id('alice');

-- Gateway and withdrawal -------------------------------------------------------------------------------------------------
select pg_temp.as_user('frank');
insert into paths values ('three', pg_temp.upload('frank'));
select app.record_credential_photo(pg_temp.id('org_a'), (select name from paths where key = 'three'), 'Holder Profile Photo', 'credential-photo-2026-11');
insert into paths values ('orphan', pg_temp.upload('frank'));
select is((select org_name || '|' || photo_state::text || '|' || source::text || '|' || photo_path || '|' || has_profile_photo::text
    from app.my_credential_photos()),
  'Northwind Live|Scanning|Holder Profile Photo|' || (select name from paths where key = 'three') || '|true',
  'the holder sees one card per org: the state, the source, their photo and that their profile photo can stand in');
select is((select count(*)::int from app.my_credential_photos()), 1, 'two badges in one org make one card');
select is((select string_agg(photo_path, ',' order by photo_path) from app.withdraw_my_credential_photos(pg_temp.id('org_a'))),
  (select string_agg(name, ',' order by name) from paths where key in ('one', 'three', 'orphan')),
  'withdrawing returns every object of theirs still stored, unrecorded ones included');
select pg_temp.as_platform();
select is((select count(*)::int from app.credential_photos where person_id = pg_temp.id('frank') and deleted_at is null), 0,
  'the photo row is removed');
select ok((select bool_and(withdrawn_at is not null) from app.consent_records where person_id = pg_temp.id('frank') and purpose_code = 'credential_photo'),
  'and the consent is withdrawn');
select is((select count(*)::int from app.domain_events where event_type = 'credential_photo.removed'), 3,
  'credential_photo.removed is emitted for the org''s two removals and the withdrawal, never for a refused one');
select ok((select bool_and(not (data ? 'photo_path')) from app.domain_events where event_type like 'credential_photo.%'),
  'no event carries a photo path');

select pg_temp.as_user('gina');
select is((select count(*)::int from app.my_credential_photos()), 1, 'another holder sees her own org card');
select is((select holds_credential from app.my_credential_photos()), true, 'as an org where she holds a live credential');
insert into paths values ('gina', pg_temp.upload('gina'));
select app.record_credential_photo(pg_temp.id('org_a'), (select name from paths where key = 'gina'), 'Holder Upload', 'credential-photo-2026-11');
select pg_temp.as_user('alice');
update app.credentials set revoked_at = now() where id = pg_temp.id('cred_gina');
select pg_temp.as_user('gina');
select is((select org_name || '|' || photo_state::text || '|' || holds_credential::text || '|' || has_profile_photo::text
    from app.my_credential_photos()),
  'Northwind Live|Scanning|false|false',
  'once her only credential there is revoked the org still lists the photo it keeps, so she can withdraw it');
select is((select string_agg(photo_path, ',') from app.withdraw_my_credential_photos(pg_temp.id('org_a'))),
  (select name from paths where key = 'gina'), 'and withdrawing it returns the object to remove');
select is((select count(*)::int from app.my_credential_photos()), 0, 'after which she has no card');
select pg_temp.as_platform();

select * from finish();
rollback;
