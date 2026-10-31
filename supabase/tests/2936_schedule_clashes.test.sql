-- pgTAP: schedule clashes (2936, B4 G-46 and G-47). Each rule's positive and negative case, TBC and Draft inputs
-- flagged, a person double booked across two projects, a supplier at the same venue left out, the settings defined, the
-- caller's row level security deciding what they see, and the logged travel request check of R5's travel party.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql
\ir 2654_project_facts_world.psql

select plan(30);

create temporary table clash (rule text, project_id uuid, other_project_id uuid, day date, subject_table text, subject_id uuid,
  other_table text, other_id uuid, party_kind text, party_id uuid, party_name text, other_party_name text, starts_at timestamptz,
  ends_at timestamptz, other_starts_at timestamptz, other_ends_at timestamptz, gap_minutes integer, tbc boolean, draft boolean);
grant select, insert, delete on clash to public;
create function pg_temp.load() returns void language sql as $$
  delete from clash;
  insert into clash select * from app.schedule_clashes(pg_temp.id('org_a'), '2027-06-01', '2027-06-30');
$$;

select has_function('app', 'schedule_clashes', array['uuid', 'date', 'date', 'uuid'], 'app.schedule_clashes exists');
select has_function('app', 'travel_request_clashes', array['uuid'], 'app.travel_request_clashes exists');
select is((select array_agg(row(setting_key, default_integer, min_integer, max_integer)::text order by setting_key) from app.setting_definitions
           where setting_key in ('scheduling.changeover_minutes', 'scheduling.travel_buffer_minutes')),
  array[row('scheduling.changeover_minutes', 15, 0, 240)::text, row('scheduling.travel_buffer_minutes', 120, 0, 720)::text],
  'the changeover minimum and the travel buffer are org settings with their defaults and bounds');

-- Fixture (as the platform, so only the rules are under test): Northwind Summer Series (prj_a, venue_a) and Winter
-- Gala (prj_a2), America/New_York, June 2027.
select pg_temp.as_platform();
with x as (insert into app.venues (org_id, name, jurisdiction_id, time_zone)
  values (pg_temp.id('org_a'), 'Northwind Riverside Hall', 'US-FL-MIAMI-DADE', 'America/New_York') returning id)
  insert into world select 'venue_c', id from x;
with x as (insert into app.scope_nodes (project_id, parent_id, scope_kind, scope_code, name, venue_id)
  values (pg_temp.id('prj_a'), pg_temp.id('root_a'), 'Show', 'NWL-E02', 'Side Stage', pg_temp.id('venue_a')) returning id)
  insert into world select 'show_b', id from x;

-- frank: two Draft shifts on two projects that overlap, and a flight during the first.
with x as (insert into app.shifts (project_id, membership_id, starts_at, ends_at, time_zone)
  values (pg_temp.id('prj_a'), pg_temp.id('frank@org_a'), '2027-06-05 14:00+00', '2027-06-05 22:00+00', 'America/New_York') returning id)
  insert into world select 's1', id from x;
with x as (insert into app.shifts (project_id, membership_id, starts_at, ends_at, time_zone)
  values (pg_temp.id('prj_a2'), pg_temp.id('frank@org_a'), '2027-06-05 20:00+00', '2027-06-05 23:00+00', 'America/New_York') returning id)
  insert into world select 's2', id from x;
with x as (insert into app.shifts (project_id, membership_id, starts_at, ends_at, time_zone)
  values (pg_temp.id('prj_a2'), pg_temp.id('frank@org_a'), '2027-06-09 20:00+00', '2027-06-09 23:00+00', 'America/New_York') returning id)
  insert into world select 's3', id from x;
insert into app.travel_segments (project_id, person_id, travel_mode, departs_from, departs_at, departs_time_zone, arrives_at_place,
  arrives_at, arrives_time_zone)
values (pg_temp.id('prj_a'), pg_temp.id('frank'), 'Flight', 'MIA', '2027-06-05 21:00+00', 'America/New_York', 'JFK',
  '2027-06-05 23:30+00', 'America/New_York');

-- art plays both stages at once; quinn follows art on the main stage after ten minutes and overlaps on the side stage.
with x as (insert into app.engagements (project_id, person_id, role_type, role_code,
  worker_classification, pay_basis, arrangement, start_date)
  values (pg_temp.id('prj_a'), pg_temp.id('quinn'), 'Artist', '2000.50.02', 'INDEPENDENT_CONTRACTOR', 'Day Rate', 'Per Engagement',
    '2027-06-01') returning id)
  insert into world select 'eng_q', id from x;
with x as (insert into app.run_of_show (project_id, scope_node_id, name, show_date, curfew_at)
  values (pg_temp.id('prj_a'), pg_temp.id('show_a'), 'Main Stage', '2027-06-05', '2027-06-06 03:00+00') returning id)
  insert into world select 'ros1', id from x;
with x as (insert into app.run_of_show (project_id, scope_node_id, name, show_date, curfew_at)
  values (pg_temp.id('prj_a'), pg_temp.id('show_b'), 'Side Stage', '2027-06-05', '2027-06-06 05:00+00') returning id)
  insert into world select 'ros2', id from x;
with x as (insert into app.cues (run_of_show_id, position, label, planned_at, duration)
  values (pg_temp.id('ros1'), 1, 'Art Set', '2027-06-06 01:00+00', interval '60 minutes') returning id)
  insert into world select 'a1', id from x;
with x as (insert into app.cues (run_of_show_id, position, label, planned_at, duration)
  values (pg_temp.id('ros1'), 2, 'Quinn Set', '2027-06-06 02:10+00', interval '45 minutes') returning id)
  insert into world select 'a2', id from x;
with x as (insert into app.cues (run_of_show_id, position, label, planned_at)
  values (pg_temp.id('ros1'), 3, 'Art Encore', '2027-06-06 08:00+00') returning id)
  insert into world select 'a3', id from x;
with x as (insert into app.cues (run_of_show_id, position, label, planned_at, duration, start_tbc)
  values (pg_temp.id('ros2'), 1, 'Art Acoustic Set', '2027-06-06 01:30+00', interval '30 minutes', true) returning id)
  insert into world select 'b1', id from x;
with x as (insert into app.cues (run_of_show_id, position, label, planned_at, duration)
  values (pg_temp.id('ros2'), 2, 'Quinn Acoustic Set', '2027-06-06 01:50+00', interval '15 minutes') returning id)
  insert into world select 'b2', id from x;
insert into app.engagement_cues (engagement_id, cue_id) values
  (pg_temp.id('eng_art_a'), pg_temp.id('a1')), (pg_temp.id('eng_q'), pg_temp.id('a2')), (pg_temp.id('eng_art_a'), pg_temp.id('a3')),
  (pg_temp.id('eng_art_a'), pg_temp.id('b1')), (pg_temp.id('eng_q'), pg_temp.id('b2'));
-- art's flights: one lands 30 minutes before the first set, one leaves 30 minutes after the encore, one lands two days early.
insert into app.travel_segments (project_id, person_id, travel_mode, departs_from, departs_at, departs_time_zone, arrives_at_place,
  arrives_at, arrives_time_zone) values
  (pg_temp.id('prj_a'), pg_temp.id('art'), 'Flight', 'LAX', '2027-06-05 22:00+00', 'America/Los_Angeles', 'MIA', '2027-06-06 00:30+00', 'America/New_York'),
  (pg_temp.id('prj_a'), pg_temp.id('art'), 'Flight', 'MIA', '2027-06-06 08:30+00', 'America/New_York', 'LAX', '2027-06-06 13:30+00', 'America/Los_Angeles'),
  (pg_temp.id('prj_a'), pg_temp.id('art'), 'Flight', 'LAX', '2027-06-04 10:00+00', 'America/Los_Angeles', 'MIA', '2027-06-04 12:00+00', 'America/New_York');

-- Bayside Audio, as a company, on both projects over overlapping dates, with dock slots at two venues.
with x as (insert into app.engagements (project_id, counterparty_id, role_type, role_code,
  worker_classification, pay_basis, arrangement, start_date, end_date)
  values (pg_temp.id('prj_a'), pg_temp.id('cp_v_a'), 'Vendor', '9000.50.02', 'VENDOR_SUPPLIED', 'Day Rate', 'Per Engagement',
    '2027-06-01', '2027-06-10') returning id)
  insert into world select 'sup1', id from x;
with x as (insert into app.engagements (project_id, counterparty_id, role_type, role_code,
  worker_classification, pay_basis, arrangement, start_date, end_date)
  values (pg_temp.id('prj_a2'), pg_temp.id('cp_v_a'), 'Vendor', '9000.50.02', 'VENDOR_SUPPLIED', 'Day Rate', 'Per Engagement',
    '2027-06-05', '2027-06-08') returning id)
  insert into world select 'sup2', id from x;
with x as (insert into app.zones (venue_id, code, name) values (pg_temp.id('venue_a'), 'DOCK-A', 'Dock A') returning id)
  insert into world select 'za', id from x;
with x as (insert into app.zones (venue_id, code, name) values (pg_temp.id('venue_c'), 'DOCK-C', 'Dock C') returning id)
  insert into world select 'zc', id from x;
insert into app.dock_slots (project_id, zone_id, engagement_id, starts_at, ends_at) values
  (pg_temp.id('prj_a'), pg_temp.id('za'), pg_temp.id('sup1'), '2027-06-05 12:00+00', '2027-06-05 14:00+00'),
  (pg_temp.id('prj_a2'), pg_temp.id('zc'), pg_temp.id('sup2'), '2027-06-05 13:00+00', '2027-06-05 15:00+00'),
  (pg_temp.id('prj_a2'), pg_temp.id('zc'), pg_temp.id('sup2'), '2027-06-07 13:00+00', '2027-06-07 15:00+00');

-- carol reads both projects ----------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
select pg_temp.load();
select is((select row(project_id, other_project_id, draft, gap_minutes)::text from clash where rule = 'person_double_booked'),
  row(pg_temp.id('prj_a'), pg_temp.id('prj_a2'), true, 120)::text,
  'frank''s overlapping shifts on two projects are one clash, 120 minutes, with a Draft input');
select is((select count(*)::int from clash where rule = 'person_double_booked' and (subject_id = pg_temp.id('s3') or other_id = pg_temp.id('s3'))), 0,
  'a shift that overlaps nothing is not a clash');
select is((select row(subject_id, gap_minutes)::text from clash where rule = 'person_in_transit' and subject_id = pg_temp.id('s1')),
  row(pg_temp.id('s1'), 60)::text, 'a shift during the person''s flight is a clash, 60 minutes of overlap');
select is((select gap_minutes from clash where rule = 'departure_near_call_end' and party_id = pg_temp.id('frank')), -60,
  'and the flight leaves an hour before that shift ends');
select is((select row(subject_id, other_id, tbc)::text from clash where rule = 'set_two_stages'),
  row(pg_temp.id('a1'), pg_temp.id('b1'), true)::text, 'art has sets on two stages at overlapping times, one of them TBC');
select is((select count(*)::int from clash where rule = 'set_two_stages'), 1, 'quinn''s two sets do not overlap, so they are not a clash');
select is((select array_agg(gap_minutes order by gap_minutes) from clash where rule = 'changeover'), array[-10, 10],
  'a 10-minute changeover on the main stage, and sets overlapping by 10 minutes on the side stage');
select is((select other_party_name from clash where rule = 'changeover' and gap_minutes = 10), 'Quinn Ashby',
  'a changeover names both artists');
select is((select count(*)::int from clash where rule = 'changeover' and subject_id = pg_temp.id('a2')), 0,
  'a gap of 305 minutes before the encore is no changeover');
select is((select gap_minutes from clash where rule = 'arrival_near_call' and party_id = pg_temp.id('art')), 30,
  'art lands 30 minutes before the first set');
select is((select count(*)::int from clash where rule = 'arrival_near_call' and party_id = pg_temp.id('art')), 1,
  'a flight landing two days early is no clash');
select is((select gap_minutes from clash where rule = 'departure_near_call_end' and party_id = pg_temp.id('art')), 30,
  'art leaves 30 minutes after the encore ends');
select is((select row(subject_id, gap_minutes)::text from clash where rule = 'past_curfew'), row(pg_temp.id('ros1'), 300)::text,
  'the main stage ends 300 minutes past its curfew; the side stage ends before its own');
select is((select row(project_id, other_project_id, party_id)::text from clash where rule = 'supplier_overlap'),
  row(pg_temp.id('prj_a'), pg_temp.id('prj_a2'), pg_temp.id('cp_v_a'))::text,
  'one supplier engaged on two productions over overlapping dates, the second venue unknown');
select is((select count(*)::int from clash where rule = 'supplier_dock_overlap'), 1,
  'the supplier''s dock slots overlap at two venues once; the later slot overlaps nothing');
select is((select count(*)::int from clash where rule = 'supplier_overlap' and (subject_id = pg_temp.id('eng_vendor_a') or other_id = pg_temp.id('eng_vendor_a'))), 0,
  'a vendor-supplied person''s engagement is left to the person rules');

select pg_temp.as_platform();
update app.projects set venue_id = pg_temp.id('venue_a') where id = pg_temp.id('prj_a2');
select pg_temp.as_user('carol');
select pg_temp.load();
select is((select count(*)::int from clash where rule = 'supplier_overlap'), 0, 'a supplier on two projects at the same venue is not returned');
select is((select count(*)::int from app.schedule_clashes(pg_temp.id('org_a'), '2027-06-01', '2027-06-30', pg_temp.id('prj_a2'))
           where rule = 'person_double_booked'), 1, 'filtering by a project keeps the clashes it is a side of');

-- Visibility: the caller's row level security decides.
select pg_temp.as_user('gina');
select is((select count(*)::int from app.schedule_clashes(pg_temp.id('org_a'), '2027-06-01', '2027-06-30')), 0,
  'a viewer who reads neither project sees no clash');
select pg_temp.as_user('xavier');
select is((select count(*)::int from app.schedule_clashes(pg_temp.id('org_a'), '2027-06-01', '2027-06-30')), 0, 'another org sees none');
select throws_ok(format('select * from app.schedule_clashes(%L, %L, %L)', pg_temp.id('org_a'), '2027-06-01', '2027-12-31'),
  '22023', null, 'clashes cover at most 92 days');

-- Requested travel against calls ------------------------------------------------------------------------------------------
-- ivy asks to arrive on the 3rd and leave on the 4th but works on the 2nd and the 5th; kai asks for travel with no calls.
select pg_temp.as_user('ivy');
select app.save_roster_travel_request(pg_temp.id('self_ivy'), 'MIA', 'JFK', '2027-06-03', '2027-06-04');
select pg_temp.as_user('kai');
select app.save_roster_travel_request(pg_temp.id('e_kai'), 'MIA', 'JFK', '2027-06-01', '2027-06-04');
select pg_temp.as_platform();
insert into app.shifts (project_id, engagement_id, starts_at, ends_at, time_zone) values
  (pg_temp.id('prj_a'), pg_temp.id('eng_ivy_a'), '2027-06-02 13:00+00', '2027-06-02 21:00+00', 'America/New_York'),
  (pg_temp.id('prj_a'), pg_temp.id('eng_ivy_a'), '2027-06-05 13:00+00', '2027-06-05 21:00+00', 'America/New_York');
delete from app.work_detail_events where action in ('project_facts.viewed', 'project_facts.counted');
create temporary table audits_before as select count(*) as n from app.audit_events where action = 'project_facts.counted';

select pg_temp.as_user('creds');
select throws_ok(format('select * from app.travel_request_clashes(%L)', pg_temp.id('prj_a')), '42501', null,
  'checking travel requests needs hospitality.fulfillment.read');
select pg_temp.as_user('alice');
select is((select array_agg(rule || ':' || requested_on || '>' || call_day order by rule) from app.travel_request_clashes(pg_temp.id('prj_a'))),
  array['requested_arrival_after_call:2027-06-03>2027-06-02', 'requested_departure_before_call:2027-06-04>2027-06-05'],
  'ivy''s requested arrival is after her first call and her departure before her last');
select pg_temp.as_platform();
select is((select count(*)::int from app.work_detail_events where action = 'project_facts.viewed' and person_id = pg_temp.id('ivy')), 1,
  'the person whose requested dates are returned gets one project_facts.viewed row');
select is((select count(*)::int from app.work_detail_events where action = 'project_facts.counted' and person_id = pg_temp.id('kai')), 1,
  'a person compared with no clash gets one project_facts.counted row');
select is((select count(*)::int from app.audit_events where action = 'project_facts.counted') - (select n from audits_before)::int, 1,
  'and the project one project_facts.counted audit event');
insert into app.offering_rules (org_id, project_id, offering, external_role_type, offering_mode) values
  (pg_temp.id('org_a'), pg_temp.id('prj_a'), 'Travel', 'Crew', 'Not Offered'),
  (pg_temp.id('org_a'), pg_temp.id('prj_a'), 'Travel', 'Vendor', 'Not Offered');
select pg_temp.as_user('alice');
select is((select count(*)::int from app.travel_request_clashes(pg_temp.id('prj_a'))), 0, 'with Travel not offered there is nothing to check');

select * from finish();
rollback;
