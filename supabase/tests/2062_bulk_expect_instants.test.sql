-- pgTAP: 2062, a bulk row's expect matches an instant in any ISO 8601 form with an offset (A106, RRR-151, ADR 0044).
-- A stored instant reads back as +00:00; a client that sends the same instant with Z is not refused as stale, a
-- different instant still is, and nothing that is not a full timestamp with an offset compares as an instant.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(12);

-- The instant test ----------------------------------------------------------------------------------------------------
select is(private.bulk_same_instant('"2026-10-08T14:30:00Z"', '"2026-10-08T14:30:00+00:00"'), true,
  'Z and +00:00 name the same instant');
select is(private.bulk_same_instant('"2026-10-08T16:30:00.000+02:00"', '"2026-10-08T14:30:00Z"'), true,
  'so do another offset and fractional seconds');
select is(private.bulk_same_instant('"2026-10-08T14:30:01Z"', '"2026-10-08T14:30:00+00:00"'), false,
  'a second apart is a different instant');
select is(private.bulk_same_instant('"2026-10-08"', '"2026-10-08T00:00:00Z"'), false, 'a date alone is not an instant');
select is(private.bulk_same_instant('"2026-10-08T14:30:00"', '"2026-10-08T14:30:00Z"'), false,
  'nor is a timestamp without an offset');
select is(private.bulk_same_instant('"2026-13-08T14:30:00Z"', '"2026-13-08T14:30:00Z"'), false,
  'an impossible date is false, not an error');
select is(private.bulk_same_instant('"Ready"', '"Ready"'), false, 'text is never compared as an instant');
select ok(not has_function_privilege('authenticated', 'private.bulk_same_instant(jsonb,jsonb)', 'execute'),
  'no signed-in caller runs it directly');

-- Through a bulk change -----------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
with x as (
  insert into app.records (project_id, record_kind, title, xyz, xyz_basis, due_at)
  values (pg_temp.id('prj_a'), 'Task', 'Hang the banner', 'Y', 'Declared', '2026-10-08T14:30:00Z') returning id
) insert into world select 't1', id from x;

select isnt((select to_jsonb(due_at) #>> '{}' from app.records where id = pg_temp.id('t1')), '2026-10-08T14:30:00Z',
  'the stored instant reads back in another form than the client sends');
select is(
  app.bulk_update_records(jsonb_build_array(jsonb_build_object('id', pg_temp.id('t1'),
    'set', jsonb_build_object('owner_party_id', pg_temp.id('erin')),
    'expect', jsonb_build_object('due_at', '2026-10-08T14:30:00Z')))) ->> 'committed',
  'true', 'an expect that names the stored instant with Z commits');
select is(
  app.bulk_update_records(jsonb_build_array(jsonb_build_object('id', pg_temp.id('t1'),
    'set', jsonb_build_object('owner_party_id', pg_temp.id('dave')),
    'expect', jsonb_build_object('due_at', '2026-10-08T15:30:00Z')))) #>> '{refused,0,rule}',
  'bulk_stale', 'an expect that names another instant is refused as stale');
select is(
  app.bulk_update_records(jsonb_build_array(jsonb_build_object('id', pg_temp.id('t1'),
    'set', jsonb_build_object('owner_party_id', pg_temp.id('dave')),
    'expect', jsonb_build_object('record_state', 'Closed')))) #>> '{refused,0,rule}',
  'bulk_stale', 'and any other field still compares exactly');
select pg_temp.as_platform();

select * from finish();
rollback;
