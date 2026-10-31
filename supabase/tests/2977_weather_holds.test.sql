-- pgTAP: migration 2977 (B8, G-150), weather hold and all-clear. Authority; one open hold; the message rules; recipients
-- are the alert-role people, the dispatchers and everyone present in the project's zones, each once; replays by client
-- id; a hold made more than 10 minutes before it arrives is refused; the all-clear closes the hold once; templates and
-- holds follow row level security; both RPCs are in the sync allowlist.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select no_plan();

create function pg_temp.notified(p_who text, p_kind text) returns integer
language sql security definer as $$
  select count(*)::int from app.notifications n where n.recipient_person_id = pg_temp.id(p_who) and n.kind = p_kind
$$;

-- Someone present in a zone who is neither an alert role nor a dispatcher: mia, scanned in by carol
select pg_temp.as_user('carol');
with x as (insert into app.zones (venue_id, code, name) values (pg_temp.id('venue_a'), 'FOH', 'Front of House') returning id) insert into world select 'zone', id from x;
with x as (insert into app.credential_categories (project_id, code, name) values (pg_temp.id('prj_a'), 'CREW', 'Crew') returning id) insert into world select 'cat', id from x;
insert into app.access_grid (credential_category_id, zone_id, access_level_enum_id, window_starts_at, window_ends_at)
  values (pg_temp.id('cat'), pg_temp.id('zone'), 'ENM-036', now() - interval '1 day', now() + interval '1 day');
with x as (insert into app.credentials (credential_category_id, holder_person_id) values (pg_temp.id('cat'), pg_temp.id('gina')) returning id) insert into world select 'cred', id from x;
select app.record_scan(pg_temp.id('zone'), pg_temp.id('cred'));
insert into app.role_assignments (project_id, role_code, person_id) values (pg_temp.id('prj_a'), (select role_code from xpms.dim_role order by role_code limit 1), pg_temp.id('bob'));
insert into app.weather_alert_roles (org_id, project_id, alert_level, role_code) values
  (pg_temp.id('org_a'), pg_temp.id('prj_a'), 'Evacuate', (select role_code from xpms.dim_role order by role_code limit 1));

-- Templates -----------------------------------------------------------------------------------------------------------------
insert into app.weather_message_templates (project_id, message_kind, body) values
  (pg_temp.id('prj_a'), 'Hold', 'Weather hold: stop work and move to shelter.');
select throws_ok($$insert into app.weather_message_templates (project_id, message_kind, body) values ((select id from world where key = 'prj_a'), 'Hold', 'Again')$$,
  '23505', null, 'one live template per kind');
select pg_temp.as_user('dave');
select throws_ok($$insert into app.weather_message_templates (project_id, message_kind, body) values ((select id from world where key = 'prj_a'), 'All Clear', 'Back to work')$$,
  '42501', null, 'templates need safety.emergency_code.write');
select is((select count(*)::int from app.weather_message_templates where project_id = pg_temp.id('prj_a')), 1, 'a reader of incidents reads them');

-- Calling a hold -----------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('gina');
select throws_ok($$select app.call_weather_hold((select id from world where key = 'prj_a'), 'Hold')$$, '42501', null, 'a Viewer cannot call a hold');
select pg_temp.as_user('carol');
select throws_ok($$select app.call_weather_hold((select id from world where key = 'prj_a'), '  ')$$,
  'XR001', 'weather_hold_message: Write a message of 1 to 1,000 characters.', 'a hold needs a message');
select throws_ok($$select app.call_weather_hold((select id from world where key = 'prj_a'), 'Hold', 'Wind', null, null, null, now() - interval '11 minutes')$$,
  'XR001', 'weather_hold_stale: This hold was made more than 10 minutes ago and was not sent. Check the weather and call it again.',
  'a hold made offline more than 10 minutes ago is refused');
insert into world values ('hold', app.call_weather_hold(pg_temp.id('prj_a'), 'Weather hold: lightning within 8 miles. Move to shelter.', 'Lightning',
  null, null, '01920000-0000-7000-8977-000000000001', now() - interval '2 minutes'));
select is(pg_temp.id('hold'), '01920000-0000-7000-8977-000000000001'::uuid, 'the hold takes the client id');
select is(app.call_weather_hold(pg_temp.id('prj_a'), 'Weather hold: lightning within 8 miles. Move to shelter.', 'Lightning',
  null, null, '01920000-0000-7000-8977-000000000001', now() - interval '2 minutes'), pg_temp.id('hold'), 'a replay by the same person returns the stored hold');
select throws_ok($$select app.call_weather_hold((select id from world where key = 'prj_a'), 'Another')$$,
  'XR001', 'weather_hold_open: A weather hold is already open on this project. Give the all-clear first.', 'one open hold per project');
select pg_temp.as_user('dave');
select throws_ok($$select app.call_weather_hold((select id from world where key = 'prj_a'), 'Hold', null, null, null, '01920000-0000-7000-8977-000000000001')$$,
  'XR001', 'weather_hold_id_taken: Another hold already uses this id.', 'another person cannot replay the id');
select pg_temp.as_platform();
select is(pg_temp.notified('bob', 'weather.hold'), 1, 'the alert-role person hears the hold once');
select is(pg_temp.notified('dave', 'weather.hold'), 1, 'a dispatcher hears it once');
select is(pg_temp.notified('frank', 'weather.hold'), 0, 'a Field member is no dispatcher (1110)');
select is(pg_temp.notified('gina', 'weather.hold'), 1, 'someone present in a zone of the project hears it');
select is(pg_temp.notified('mia', 'weather.hold'), 0, 'someone neither present nor named does not');

-- The all-clear -------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('gina');
select throws_ok($$select app.give_weather_all_clear((select id from world where key = 'hold'), 'All clear')$$, '42501', null, 'a Viewer cannot give the all-clear');
select pg_temp.as_user('erin');
select is(app.give_weather_all_clear(pg_temp.id('hold'), 'All clear: back to work.', '01920000-0000-7000-8977-000000000002'), pg_temp.id('hold'),
  'a project dispatcher gives the all-clear');
select is(app.give_weather_all_clear(pg_temp.id('hold'), 'All clear: back to work.', '01920000-0000-7000-8977-000000000002'), pg_temp.id('hold'),
  'a replay returns the hold');
select throws_ok($$select app.give_weather_all_clear((select id from world where key = 'hold'), 'Again')$$,
  'XR001', 'weather_hold_closed: This weather hold already has its all-clear.', 'a closed hold takes no second all-clear');
select pg_temp.as_platform();
select is((select row(cleared_by = pg_temp.id('erin'), all_clear_message)::text from app.weather_holds where id = pg_temp.id('hold')),
  '(t,"All clear: back to work.")', 'the hold records who cleared it and the message');
select is(pg_temp.notified('gina', 'weather.all_clear'), 1, 'the all-clear reaches the same people');
select is(pg_temp.notified('bob', 'weather.all_clear'), 1, 'each once');
select pg_temp.as_user('carol');
select lives_ok($$select app.call_weather_hold((select id from world where key = 'prj_a'), 'Second hold')$$, 'a new hold may be called after the all-clear');

-- Reads and writes ---------------------------------------------------------------------------------------------------------------------
select throws_ok($$update app.weather_holds set message = 'Edited' where id = (select id from world where key = 'hold')$$, '42501', null, 'holds are written only by the RPCs');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.weather_holds), 0, 'another org reads no holds');
select pg_temp.as_platform();
select is((select count(*)::int from private.sync_rpcs where rpc in ('app.call_weather_hold', 'app.give_weather_all_clear')), 2, 'both are in the sync allowlist');

select * from finish();
rollback;
