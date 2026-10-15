-- pgTAP: A11 dock slots naming a vendor engagement (migration 0970). The engagement belongs to the
-- slot's project and org, and the booking event carries it.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(5);

select pg_temp.as_user('alice');
with x as (insert into app.zones (venue_id, code, name) values (pg_temp.id('venue_a'), 'DOCK-V', 'Vendor Dock') returning id) insert into world select 'dock', id from x;

select pg_temp.as_user('dave');
select lives_ok($$insert into app.dock_slots (project_id, zone_id, engagement_id, starts_at, ends_at)
  values ((select id from world where key = 'prj_a'), (select id from world where key = 'dock'), (select id from world where key = 'eng_vendor_a'), '2027-06-01 06:00+00', '2027-06-01 07:00+00')$$,
  'a slot names a vendor engagement of its project');
select throws_ok($$insert into app.dock_slots (project_id, zone_id, engagement_id, starts_at, ends_at)
  values ((select id from world where key = 'prj_a2'), (select id from world where key = 'dock'), (select id from world where key = 'eng_vendor_a'), '2027-06-02 06:00+00', '2027-06-02 07:00+00')$$,
  'XR001', null, 'an engagement of another project is refused');
select throws_ok($$insert into app.dock_slots (project_id, zone_id, engagement_id, starts_at, ends_at)
  values ((select id from world where key = 'prj_a'), (select id from world where key = 'dock'), (select id from world where key = 'eng_ivy_b'), '2027-06-03 06:00+00', '2027-06-03 07:00+00')$$,
  'XR001', null, 'an engagement of another org is refused');
select pg_temp.as_platform();
select is((select (data ->> 'engagement_id')::uuid from app.domain_events where event_type = 'dock_slot.booked' order by occurred_at desc limit 1),
  pg_temp.id('eng_vendor_a'), 'the booking event carries the engagement');
select is((select count(*)::int from app.dock_slots where engagement_id = pg_temp.id('eng_vendor_a')), 1, 'the slot is stored with its engagement');

select * from finish();
rollback;
