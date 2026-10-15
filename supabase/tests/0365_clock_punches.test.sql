-- pgTAP: clock punches and the 16-hour automatic close (requested by A17). The punch record is
-- append-only and readable by the person and by time readers of the project; stale open entries close at
-- clock in plus 16 hours and are marked for review. The punch RPC is covered by 0941.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(17);

-- Automatic close -------------------------------------------------------------------------------------
select pg_temp.as_user('frank');
with x as (insert into app.time_entries (project_id, membership_id, clock_in, source)
  values (pg_temp.id('prj_a'), pg_temp.id('frank@org_a'), now() - interval '20 hours', 'Mobile') returning id) insert into world select 'stale', id from x;
select pg_temp.as_user('carol');
with x as (insert into app.time_entries (project_id, membership_id, clock_in, source)
  values (pg_temp.id('prj_a'), pg_temp.id('dave@org_a'), now() - interval '2 hours', 'Mobile') returning id) insert into world select 'fresh', id from x;
select pg_temp.as_platform();
select is(private.close_stale_time_entries(), 1, 'one entry was open longer than 16 hours');
select is((select clock_out - clock_in from app.time_entries where id = pg_temp.id('stale')), interval '16 hours', 'it closes at clock in plus 16 hours');
select isnt((select auto_closed_at from app.time_entries where id = pg_temp.id('stale')), null, 'the automatic close is stamped');
select is((select needs_review from app.time_entries where id = pg_temp.id('stale')), true, 'and marked for review');
select is((select clock_out from app.time_entries where id = pg_temp.id('fresh')), null, 'a recent open entry stays open');
select is((select count(*)::int from app.time_entry_audit where time_entry_id = pg_temp.id('stale')), 2, 'the close is audited');
select is(private.close_stale_time_entries(), 0, 'running again closes nothing');
select pg_temp.as_user('frank');
select throws_ok($$select private.close_stale_time_entries()$$, '42501', null, 'signed-in callers cannot run the close');
select pg_temp.as_platform();

-- Punch record -------------------------------------------------------------------------------------------
insert into world values ('p1', gen_random_uuid());
insert into app.clock_punches (id, project_id, membership_id, time_entry_id, punch_kind, device_time, effective_at, source, latitude, longitude, accuracy_m)
values (pg_temp.id('p1'), pg_temp.id('prj_a'), pg_temp.id('frank@org_a'), pg_temp.id('stale'), 'In', now() - interval '20 hours', now() - interval '20 hours', 'Mobile', 25.774, -80.19, 12);
select is((select org_id from app.clock_punches where id = pg_temp.id('p1')), pg_temp.id('org_a'), 'a punch takes its project''s org');
select throws_ok($$insert into app.clock_punches (id, project_id, membership_id, punch_kind, device_time, effective_at, source) values (gen_random_uuid(), (select id from world where key = 'prj_a'), (select id from world where key = 'frank@org_a'), 'In', now(), now(), 'Kiosk')$$,
  '23514', null, 'a Kiosk punch names its kiosk');
select throws_ok($$insert into app.clock_punches (id, project_id, membership_id, punch_kind, device_time, effective_at, source, latitude) values (gen_random_uuid(), (select id from world where key = 'prj_a'), (select id from world where key = 'frank@org_a'), 'In', now(), now(), 'Mobile', 25.7)$$,
  '23514', null, 'latitude and longitude come together');
select throws_ok($$update app.clock_punches set punch_kind = 'Out' where id = (select id from world where key = 'p1')$$, 'XR001', null, 'punches are append-only');
select pg_temp.as_user('frank');
select is((select count(*)::int from app.clock_punches), 1, 'the person reads their own punches');
select throws_ok($$insert into app.clock_punches (id, project_id, membership_id, punch_kind, device_time, effective_at, source) values (gen_random_uuid(), (select id from world where key = 'prj_a'), (select id from world where key = 'frank@org_a'), 'In', now(), now(), 'Mobile')$$,
  '42501', null, 'punches are written only through the punch RPC');
select pg_temp.as_user('gina');
select is((select count(*)::int from app.clock_punches), 0, 'a Viewer outside the project reads none');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.clock_punches), 0, 'another org reads none');
select pg_temp.as_anon();
select throws_ok('select 1 from app.clock_punches', '42501', null, 'anon cannot read punches');
select pg_temp.as_platform();

select * from finish();
rollback;
