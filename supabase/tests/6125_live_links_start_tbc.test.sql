-- pgTAP: migration 6125, P2 and P1 (RRR-216, RRR-215; ADR 0131, ADR 0130). A cue or record whose time is to be confirmed
-- never reads as a firm time on a public live link or a display screen: a cue sends start_tbc and no planned time, so a
-- screen has nothing to count down to; a confirmed cue is unchanged; a called cue keeps its call time; a schedule record
-- keeps its estimate for the day it sits on, with the flag beside it; and every key stays on the allowlist.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(11);

create temporary table k (key text primary key, val text);
grant select, insert, update, delete on k to public;
create function pg_temp.val(p_key text) returns text
language sql stable as $$ select val from k where key = p_key $$;

create function pg_temp.grant_for(p_key text) returns void
language plpgsql as $$
declare v jsonb;
begin
  perform pg_temp.as_anon();
  perform set_config('request.headers', json_build_object('x-forwarded-for', '192.0.2.10')::text, true);
  v := api_public.open_live_link(pg_temp.val(p_key), pg_temp.val(p_key || ':code'), '198.51.100.7');
  perform pg_temp.as_platform();
  insert into k values (p_key || ':grant', v ->> 'grant');
end $$;

create function pg_temp.read(p_key text) returns jsonb
language plpgsql as $$
declare v jsonb;
begin
  perform pg_temp.as_anon();
  perform set_config('request.headers', json_build_object('x-forwarded-for', '192.0.2.10')::text, true);
  v := api_public.live_view(pg_temp.val(p_key), pg_temp.val(p_key || ':grant'), '198.51.100.7');
  perform pg_temp.as_platform();
  return v;
end $$;

create function pg_temp.display(p_key text) returns jsonb
language plpgsql as $$
declare v jsonb;
begin
  perform pg_temp.as_anon();
  perform set_config('request.headers', json_build_object('x-forwarded-for', '192.0.2.10')::text, true);
  v := api_public.live_display(pg_temp.val(p_key), pg_temp.val(p_key || ':grant'), '198.51.100.7');
  perform pg_temp.as_platform();
  return v;
end $$;

create function pg_temp.view_link(p_key text, p_collection text) returns void
language plpgsql as $$
declare
  v_view uuid;
  v record;
begin
  perform pg_temp.as_user('dave');
  insert into app.saved_views (membership_id, collection_key, name, view_type, shared)
  values (pg_temp.id('dave@org_a'), p_collection, p_key, 'List', true) returning id into v_view;
  select * into v from app.create_view_link(v_view, pg_temp.id('prj_a'), now() + interval '30 days') limit 1;
  perform pg_temp.as_platform();
  insert into k values (p_key, v.token), (p_key || ':code', v.access_code);
end $$;

select pg_temp.as_user('dave');
with x as (insert into app.run_of_show (project_id, name, show_date) values (pg_temp.id('prj_a'), 'Opening Night', current_date + 5) returning id)
  insert into world select 'ros', id from x;
insert into app.cues (run_of_show_id, position, label, planned_at, start_tbc, duration) values
  (pg_temp.id('ros'), 1, 'House to Half', now() + interval '1 hour', false, interval '5 minutes'),
  (pg_temp.id('ros'), 2, 'Host Welcome', now() + interval '2 hours', true, interval '5 minutes'),
  (pg_temp.id('ros'), 3, 'Headliner On', now() + interval '3 hours', true, interval '45 minutes');
select app.call_cue((select id from app.cues where run_of_show_id = pg_temp.id('ros') and position = 3));
insert into app.records (project_id, record_kind, title, xyz, xyz_basis, starts_at, start_tbc, owner_party_id, accountable_party_id) values
  (pg_temp.id('prj_a'), 'Milestone', 'Doors Open', 'Y', 'Declared', now() + interval '2 days', true, pg_temp.id('dave'), pg_temp.id('erin')),
  (pg_temp.id('prj_a'), 'Milestone', 'Curfew Reached', 'Y', 'Declared', now() + interval '3 days', false, pg_temp.id('dave'), pg_temp.id('erin'));
select pg_temp.as_platform();

select pg_temp.view_link('shows', 'project/show');
select pg_temp.view_link('schedule', 'project/schedule');
select pg_temp.as_user('dave');
create temporary table made on commit drop as select * from app.create_display_link(pg_temp.id('ros')) limit 1;
select pg_temp.as_platform();
insert into k select 'd', token from made union all select 'd:code', access_code from made;
select pg_temp.grant_for('shows');
select pg_temp.grant_for('schedule');
select pg_temp.grant_for('d');

-- Display screens ----------------------------------------------------------------------------------------------------
select is((pg_temp.display('d') -> 'cues' -> 0 ->> 'start_tbc')::boolean, false, 'a confirmed cue says so');
select ok((pg_temp.display('d') -> 'cues' -> 0 ->> 'planned_at') is not null, 'and keeps its planned time');
select is((pg_temp.display('d') -> 'cues' -> 1 ->> 'start_tbc')::boolean, true, 'a cue to be confirmed says so');
select ok((pg_temp.display('d') -> 'cues' -> 1 -> 'planned_at') = 'null'::jsonb,
  'and sends no planned time, so a screen has nothing to read as firm or count down to');
select ok((pg_temp.display('d') -> 'cues' -> 2 ->> 'called_at') is not null and (pg_temp.display('d') -> 'cues' -> 2 -> 'planned_at') = 'null'::jsonb,
  'a called cue to be confirmed keeps when it was called and no planned time');

-- Show links ---------------------------------------------------------------------------------------------------------
select is((pg_temp.read('shows') -> 'rows' -> 0 -> 'cues' -> 1 ->> 'start_tbc')::boolean, true, 'a show link flags the cue too');
select ok((pg_temp.read('shows') -> 'rows' -> 0 -> 'cues' -> 1 -> 'planned_at') = 'null'::jsonb, 'and sends no planned time');
select ok((pg_temp.read('shows') -> 'rows' -> 0 -> 'cues' -> 0 ->> 'planned_at') is not null, 'its confirmed cue keeps its time');

-- Schedule links -----------------------------------------------------------------------------------------------------
select is((select (e ->> 'start_tbc')::boolean from jsonb_array_elements(pg_temp.read('schedule') -> 'rows') e where e ->> 'title' = 'Doors Open'), true,
  'a schedule record to be confirmed says so');
select is((select (e ->> 'start_tbc')::boolean from jsonb_array_elements(pg_temp.read('schedule') -> 'rows') e where e ->> 'title' = 'Curfew Reached'), false,
  'a confirmed record says so');

-- The allowlist ------------------------------------------------------------------------------------------------------
select is((select array_agg(distinct key order by key) from jsonb_array_elements(pg_temp.display('d') -> 'cues') e, jsonb_object_keys(e) key),
  (select array_agg(field_key order by field_key)::text[] from private.live_view_fields where collection_key = 'display' and part = 'cue' and shown),
  'every display cue carries exactly the allowlisted keys');

select * from finish();
rollback;
