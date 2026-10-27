-- pgTAP: 2120, versions in the bulk property RPCs (A118, RRR-163, Section 11.7). A save carries the updated_at the
-- caller loaded: a matching version commits, a version that moved on merges a change to another field and refuses a
-- change to the same field with the row's current values, which a "keep mine" resend uses. Times compare by meaning,
-- set never carries the version, and a refusal never shows a row the caller cannot read.
-- Every update in this transaction shares one now(), so a stale save is a version older than the row's.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(22);

create function pg_temp.new_record(p_project text, p_title text) returns uuid
language plpgsql as $$
declare v uuid;
begin
  insert into app.records (project_id, record_kind, title, xyz, xyz_basis)
  values (pg_temp.id(p_project), 'Task', p_title, 'Y', 'Declared') returning id into v;
  return v;
end $$;

create function pg_temp.version_of(p_key text) returns jsonb
language sql as $$ select to_jsonb(r) -> 'updated_at' from app.records r where r.id = pg_temp.id(p_key) $$;

create function pg_temp.save(p_key text, p_set jsonb, p_expect jsonb, p_preview boolean default false) returns jsonb
language sql as $$
  select app.bulk_update_records(jsonb_build_array(jsonb_build_object('id', pg_temp.id(p_key), 'set', p_set, 'expect', p_expect)), p_preview);
$$;

create function pg_temp.owner_of(p_key text) returns uuid
language sql as $$ select owner_party_id from app.records where id = pg_temp.id(p_key) $$;

create temporary table answer (r jsonb);
grant all on answer to public;

-- Fixtures ----------------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
insert into world values ('t1', pg_temp.new_record('prj_a', 'Hang the banner'));
insert into world values ('t2', pg_temp.new_record('prj_a', 'Sweep the deck'));
select pg_temp.as_user('carol');
insert into world values ('g1', pg_temp.new_record('prj_a2', 'Book the gala band'));

-- The version the caller loaded ------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select is(
  (select r ->> 'committed' from (select pg_temp.save('t1', jsonb_build_object('owner_party_id', pg_temp.id('dave')),
    jsonb_build_object('updated_at', pg_temp.version_of('t1')))) x(r)),
  'true', 'a save that carries the row''s version commits');
select is(pg_temp.owner_of('t1'), pg_temp.id('dave'), 'and lands');
select is(
  (select r ->> 'committed' from (select pg_temp.save('t1', jsonb_build_object('owner_party_id', pg_temp.id('erin')),
    jsonb_build_object('updated_at', to_char((pg_temp.version_of('t1') #>> '{}')::timestamptz at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')))) x(r)),
  'true', 'the same instant spelled with Z and other precision is the same version');
select is(pg_temp.owner_of('t1'), pg_temp.id('erin'), 'so it lands too');

-- A version that moved on --------------------------------------------------------------------------------------------------
insert into answer select pg_temp.save('t1', jsonb_build_object('owner_party_id', pg_temp.id('dave')),
  jsonb_build_object('updated_at', '2020-01-01T00:00:00+00:00'));
select is((select r ->> 'committed' from answer), 'false', 'a save that carries only an older version is refused');
select is((select r -> 'refused' -> 0 ->> 'rule' from answer), 'bulk_stale', 'as stale');
select is((select r -> 'refused' -> 0 -> 'current' ->> 'owner_party_id' from answer), pg_temp.id('erin')::text,
  'the refusal carries the value the row holds now');
select is((select (r -> 'refused' -> 0 -> 'current' ->> 'updated_at')::timestamptz from answer), (pg_temp.version_of('t1') #>> '{}')::timestamptz,
  'and the row''s version, for a resend');
select is(pg_temp.owner_of('t1'), pg_temp.id('erin'), 'nothing is overwritten');

-- Keep mine: the resend expects the version in current.
select is(
  (select r ->> 'committed' from (select pg_temp.save('t1', jsonb_build_object('owner_party_id', pg_temp.id('dave')),
    jsonb_build_object('updated_at', (select r -> 'refused' -> 0 -> 'current' -> 'updated_at' from answer)))) x(r)),
  'true', 'keeping mine resends with the version the refusal named, and commits');
select is(pg_temp.owner_of('t1'), pg_temp.id('dave'), 'mine lands');

-- Another field merges, the same field conflicts -----------------------------------------------------------------------------
select is(
  (select r ->> 'committed' from (select pg_temp.save('t2', jsonb_build_object('due_at', '2027-06-05T18:00:00Z'),
    jsonb_build_object('updated_at', '2020-01-01T00:00:00+00:00', 'due_at', null))) x(r)),
  'true', 'with an older version, a field nobody changed since saves: the other person''s changes merge');
select is((select due_at from app.records where id = pg_temp.id('t2')), '2027-06-05T18:00:00Z'::timestamptz, 'the due time lands');
delete from answer;
insert into answer select pg_temp.save('t2', jsonb_build_object('due_at', '2027-06-06T18:00:00Z'),
  jsonb_build_object('updated_at', '2020-01-01T00:00:00+00:00', 'due_at', null));
select is((select r -> 'refused' -> 0 ->> 'rule' from answer), 'bulk_stale', 'a field someone else changed since is a conflict');
select is((select (r -> 'refused' -> 0 -> 'current' ->> 'due_at')::timestamptz from answer), '2027-06-05T18:00:00Z'::timestamptz,
  'and the refusal shows their value');
select is((select due_at from app.records where id = pg_temp.id('t2')), '2027-06-05T18:00:00Z'::timestamptz, 'theirs stays until the person chooses');
select ok(
  (select (r -> 'refused' -> 0 -> 'current') ? 'owner_party_id' from (select pg_temp.save('t2', jsonb_build_object('owner_party_id', pg_temp.id('erin')),
    jsonb_build_object('updated_at', '2020-01-01T00:00:00+00:00'), true)) x(r)),
  'a preview reports the conflict too, with the current values');

-- Shape and reach ---------------------------------------------------------------------------------------------------------------
select is(
  (select r -> 'refused' -> 0 ->> 'rule' from (select pg_temp.save('t1', jsonb_build_object('updated_at', '2030-01-01T00:00:00Z'), '{}'::jsonb)) x(r)),
  'bulk_field_not_editable', 'the version is expected, never set');
delete from answer;
insert into answer select pg_temp.save('g1', jsonb_build_object('owner_party_id', pg_temp.id('dave')),
  jsonb_build_object('updated_at', '2020-01-01T00:00:00+00:00'));
select is((select r -> 'refused' -> 0 ->> 'rule' from answer), 'bulk_row_not_found', 'a row outside the caller''s projects reads as not found');
select ok(not ((select r -> 'refused' -> 0 from answer) ? 'current'), 'and never carries its values');

-- Undo is unchanged: the inverse expects the values after, field by field ------------------------------------------------------
delete from answer;
insert into answer select pg_temp.save('t1', jsonb_build_object('phase_code', 'SCP'), jsonb_build_object('updated_at', pg_temp.version_of('t1')));
select is((select r -> 'inverse' -> 0 -> 'expect' ->> 'phase_code' from answer), 'SCP', 'the inverse of a versioned save expects the value after');
select is(
  (select r ->> 'committed' from (select app.bulk_update_records((select r -> 'inverse' from answer))) x(r)),
  'true', 'and undoes it');

select * from finish();
rollback;
