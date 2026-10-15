-- pgTAP: A11 late slot 0971. Logistics and hospitality records are comment subjects, and a travel
-- segment may name an engagement of its own project and org only.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(5);

select is((select count(*)::int from private.comment_subjects where table_name in
  ('app.shipments', 'app.dock_slots', 'app.fulfillments', 'app.beos', 'app.accommodation_blocks', 'app.travel_segments')), 6,
  'logistics and hospitality records take comments and attachments');

select pg_temp.as_user('dave');
select lives_ok($$insert into app.travel_segments (project_id, person_id, engagement_id, travel_mode, departs_from, departs_at, departs_time_zone, arrives_at_place, arrives_time_zone)
  values ((select id from world where key = 'prj_a'), (select id from world where key = 'ivy'), (select id from world where key = 'eng_ivy_a'), 'Flight', 'BOS', '2027-05-31 12:00+00', 'America/New_York', 'MIA', 'America/New_York')$$,
  'a segment names an engagement of its project');
select throws_ok($$insert into app.travel_segments (project_id, person_id, engagement_id, travel_mode, departs_from, departs_at, departs_time_zone, arrives_at_place, arrives_time_zone)
  values ((select id from world where key = 'prj_a2'), (select id from world where key = 'ivy'), (select id from world where key = 'eng_ivy_a'), 'Flight', 'BOS', now(), 'UTC', 'MIA', 'UTC')$$,
  'XR001', null, 'an engagement of another project is refused');
select throws_ok($$insert into app.travel_segments (project_id, person_id, engagement_id, travel_mode, departs_from, departs_at, departs_time_zone, arrives_at_place, arrives_time_zone)
  values ((select id from world where key = 'prj_a'), (select id from world where key = 'ivy'), (select id from world where key = 'eng_ivy_b'), 'Flight', 'BOS', now(), 'UTC', 'MIA', 'UTC')$$,
  'XR001', null, 'an engagement of another org is refused');
select pg_temp.as_platform();
select is((select (data ->> 'engagement_id')::uuid from app.domain_events where event_type = 'travel_segment.created' order by occurred_at desc limit 1),
  pg_temp.id('eng_ivy_a'), 'the booking event carries the engagement');

select * from finish();
rollback;
