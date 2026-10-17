-- pgTAP: voice notes on incident reports (A42, SIM-003, journey 54). A voice note is incident media with a
-- kind and a length, stored in field-media like a photo, replayed from a device through the sync wrapper.
-- Same-tenant allow, cross-tenant deny, anon deny, role bands, and the shape invariants.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(13);

select pg_temp.as_user('frank');
select ok((select id from app.report_incident(pg_temp.id('prj_a'), 'Spill at Bar 3', 'ENM-100', now(), null, null, null, null, now(),
  '01920000-0000-7000-8000-00000000e101'::uuid)) is not null, 'a Field member files an incident');
insert into world values ('inc', '01920000-0000-7000-8000-00000000e101');

select is(app.add_incident_media(pg_temp.id('inc'), pg_temp.id('org_a') || '/incidents/' || pg_temp.id('inc') || '/note.m4a', now(),
  '01920000-0000-7000-8000-00000000e102'::uuid, 'Voice Note', 12500), '01920000-0000-7000-8000-00000000e102'::uuid,
  'and attaches a voice note with its length');
select is((select media_kind || ' ' || duration_ms from app.incident_media where id = '01920000-0000-7000-8000-00000000e102'),
  'Voice Note 12500', 'stored as a voice note of 12.5 s');
select is(app.add_incident_media(pg_temp.id('inc'), 'x/incidents/y/photo.jpg', now(), '01920000-0000-7000-8000-00000000e103'::uuid),
  '01920000-0000-7000-8000-00000000e103'::uuid, 'a caller that names no kind still attaches a photo');
select is((select media_kind from app.incident_media where id = '01920000-0000-7000-8000-00000000e103'), 'Photo', 'which is stored as a Photo');

-- Shape invariants.
select throws_ok($$select app.add_incident_media((select id from world where key = 'inc'), 'a.jpg', now(), null, 'Photo', 3000)$$,
  '23514', null, 'only a voice note has a length');
select throws_ok($$select app.add_incident_media((select id from world where key = 'inc'), 'a.wav', now(), null, 'Recording')$$,
  '23514', null, 'the kind is Photo, Video or Voice Note');
select throws_ok($$select app.add_incident_media((select id from world where key = 'inc'), 'a.m4a', now(), null, 'Voice Note', 600001)$$,
  '23514', null, 'a voice note runs at most ten minutes');

-- The device replays the queued voice note through the sync wrapper, once.
select is((select (app.apply_sync_mutation('01920000-0000-7000-8000-00000000e104'::uuid, pg_temp.id('org_a'), 'device-1', 'app.add_incident_media',
  jsonb_build_object('p_incident_id', pg_temp.id('inc'), 'p_media_uri', 'o/incidents/i/n2.m4a', 'p_id', '01920000-0000-7000-8000-00000000e105',
    'p_media_kind', 'Voice Note', 'p_duration_ms', 8000)) ? 'data')), true, 'a device replays a voice note through the sync wrapper');

-- Bands, tenants, anon.
select pg_temp.as_user('gina');
select throws_ok($$select app.add_incident_media((select id from world where key = 'inc'), 'n.m4a', now(), null, 'Voice Note', 1000)$$,
  '42501', null, 'a Viewer cannot attach a voice note');
select pg_temp.as_user('xavier');
select throws_ok($$select app.add_incident_media((select id from world where key = 'inc'), 'n.m4a', now(), null, 'Voice Note', 1000)$$,
  '42501', null, 'another org cannot attach one');
select pg_temp.as_anon();
select throws_ok($$select app.add_incident_media((select id from world where key = 'inc'), 'n.m4a')$$, '42501', null, 'anon cannot attach media');

select pg_temp.as_platform();
select ok((select allowed_mime_types @> array['audio/mp4', 'audio/aac', 'audio/x-m4a'] and not public from storage.buckets where id = 'field-media'),
  'the private field-media bucket accepts recorded AAC audio');

select * from finish();
rollback;
