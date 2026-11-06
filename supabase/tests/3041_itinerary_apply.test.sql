-- pgTAP: itinerary lines into segments (B15, RRR-239, migration 3041). Traveler candidates hold names and no travel value,
-- write no fact log row and need fulfillment read. Applying writes kept lines with the person's traveler in one transaction,
-- leaves untouched lines Proposed, and refuses a traveler with no standing, another's engagement, a repeat (a service left
-- blank included), a zone the guard refuses and a suggestion read for another project, each naming its line.
-- World: 0700_engagement_world (ivy Crew and art Artist on prj_a, quinn on org_b only; dave coordinator, gina viewer).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select no_plan();

create function pg_temp.segment(p_key text, p_request text) returns uuid
language plpgsql as $$
declare v uuid;
begin
  v := app.ai_propose_suggestion(pg_temp.id(p_request), 'travelSegments.create', null, 'Add a segment from the itinerary.',
    '[{"field_path": "passenger_name", "value": "MARCHETTI/IVY MS", "confidence": 0.9},
      {"field_path": "travel_mode", "value": "Flight", "confidence": 0.9},
      {"field_path": "departs_from", "value": "MIA", "confidence": 0.9},
      {"field_path": "departs_time_zone", "value": "America/New_York", "confidence": 0.5},
      {"field_path": "arrives_at_place", "value": "ORD", "confidence": 0.9},
      {"field_path": "arrives_time_zone", "value": "America/Chicago", "confidence": 0.5},
      {"field_path": "year_inferred", "value": true, "confidence": 1},
      {"field_path": "price_minor", "refusal": "NO_ANSWER", "missing": "No price is printed for this passenger."}]');
  insert into world values (p_key, v);
  return v;
end $$;

create function pg_temp.item(p_suggestion text, p_person text, p_departs text, p_extra jsonb default '{}') returns jsonb
language sql stable as $$
  select jsonb_build_object('suggestion_id', pg_temp.id(p_suggestion),
    'values', jsonb_build_object('person_id', pg_temp.id(p_person), 'departs_at', p_departs) || p_extra)
$$;

create function pg_temp.segments() returns integer
language sql stable as $$ select count(*)::int from app.travel_segments where project_id = pg_temp.id('prj_a') and deleted_at is null $$;

select pg_temp.as_user('bob');
insert into app.ai_settings (org_id, extraction_enabled) values (pg_temp.id('org_a'), true);
select pg_temp.as_user('dave');
with x as (insert into app.fulfillments (project_id, fulfillment_kind, title) values (pg_temp.id('prj_a'), 'Travel', 'Artist Travel') returning id)
  insert into world select 'ful_travel', id from x;
with x as (insert into app.fulfillments (project_id, fulfillment_kind, title) values (pg_temp.id('prj_a'), 'Catering', 'Crew Meals') returning id)
  insert into world select 'ful_catering', id from x;
insert into world values ('r1', app.ai_begin_request(pg_temp.id('org_a'), 'extraction', 'claude-sonnet-5-5', 'app.projects', pg_temp.id('prj_a')));
select app.ai_complete_request(pg_temp.id('r1'), 'Answered', 'Read the itinerary.', 'Lines.', 100, 40);
select pg_temp.segment('s1', 'r1');
select pg_temp.segment('s2', 'r1');
select pg_temp.segment('s3', 'r1');
select pg_temp.segment('s4', 'r1');
insert into world values ('r_other', app.ai_begin_request(pg_temp.id('org_a'), 'extraction', 'claude-sonnet-5-5', 'app.projects', pg_temp.id('prj_a2')));
select app.ai_complete_request(pg_temp.id('r_other'), 'Answered', 'Read.', 'Lines.', 100, 40);
select pg_temp.segment('s_other', 'r_other');

-- Candidates ----------------------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
create temporary table fact_log_before as select count(*)::int as n from app.work_detail_events where action like 'project_facts%';
grant select on fact_log_before to public;
select pg_temp.as_user('dave');
select ok(exists (select 1 from app.itinerary_traveler_candidates(pg_temp.id('prj_a')) c where c.person_id = pg_temp.id('ivy') and c.engagement_id = pg_temp.id('eng_ivy_a') and c.display_name = 'Ivy Marchetti' and c.source = 'Engagement'),
  'an engaged person is a candidate with their name and engagement');
select ok(exists (select 1 from app.itinerary_traveler_candidates(pg_temp.id('prj_a')) c where c.source = 'Member'), 'project members are candidates');
select ok(not exists (select 1 from app.itinerary_traveler_candidates(pg_temp.id('prj_a')) c where c.person_id = pg_temp.id('quinn')), 'someone off the project is not');
select pg_temp.as_platform();
select is((select count(*)::int from app.work_detail_events where action like 'project_facts%'), (select n from fact_log_before), 'reading candidates writes no fact log row');
select pg_temp.as_user('quinn');
select throws_ok($$select * from app.itinerary_traveler_candidates((select id from world where key = 'prj_a'))$$, '42501', null, 'without fulfillment read on the project it is refused');

-- Refusals write nothing ------------------------------------------------------------------------------------------------------
select pg_temp.as_user('gina');
select throws_ok($$select app.apply_itinerary_lines((select id from world where key = 'prj_a'), null, jsonb_build_array(pg_temp.item('s1', 'ivy', '2027-06-01T12:15:00Z')))$$,
  '42501', null, 'without fulfillment write it is refused');
select pg_temp.as_user('dave');
select throws_ok($$select app.apply_itinerary_lines((select id from world where key = 'prj_a'), null, jsonb_build_array(pg_temp.item('s_other', 'ivy', '2027-06-01T12:15:00Z')))$$,
  'XR001', 'aurora_intake_item_invalid: Line 1 is not a line read for this project.', 'the request''s subject decides the project, not a field');
select throws_ok($$select app.apply_itinerary_lines((select id from world where key = 'prj_a'), null, jsonb_build_array(pg_temp.item('s1', 'quinn', '2027-06-01T12:15:00Z')))$$,
  'XR001', 'aurora_itinerary_traveler: Line 1: choose someone on this project, with their own engagement.', 'a person with no standing is refused');
select throws_ok($$select app.apply_itinerary_lines((select id from world where key = 'prj_a'), null, jsonb_build_array(pg_temp.item('s1', 'ivy', '2027-06-01T12:15:00Z', jsonb_build_object('engagement_id', (select id from world where key = 'eng_art_a')))))$$,
  'XR001', 'aurora_itinerary_traveler: Line 1: choose someone on this project, with their own engagement.', 'another person''s engagement is refused');
select throws_ok($$select app.apply_itinerary_lines((select id from world where key = 'prj_a'), null, jsonb_build_array(jsonb_build_object('suggestion_id', (select id from world where key = 's1'), 'values', jsonb_build_object('departs_at', '2027-06-01T12:15:00Z'))))$$,
  'XR001', 'aurora_itinerary_traveler: Line 1: choose someone on this project, with their own engagement.', 'a traveler never comes from the model');
select throws_ok($$select app.apply_itinerary_lines((select id from world where key = 'prj_a'), null, jsonb_build_array(pg_temp.item('s1', 'ivy', '2027-06-01T12:15:00Z', jsonb_build_object('departs_time_zone', 'Mars/Olympus'))))$$,
  'XR001', null, 'a zone the guard refuses is refused by line');
select throws_ok($$select app.apply_itinerary_lines((select id from world where key = 'prj_a'), (select id from world where key = 'ful_catering'), jsonb_build_array(pg_temp.item('s1', 'ivy', '2027-06-01T12:15:00Z')))$$,
  'XR001', null, 'a Catering fulfillment is refused');
select throws_ok($$select app.apply_itinerary_lines((select id from world where key = 'prj_a'), null, jsonb_build_array(pg_temp.item('s1', 'ivy', '2027-06-01T12:15:00Z'), pg_temp.item('s1', 'ivy', '2027-06-02T12:15:00Z')))$$,
  'XR001', 'aurora_intake_item_invalid: Line 2 is listed twice.', 'a suggestion named twice is refused');
select throws_ok($$select app.apply_itinerary_lines((select id from world where key = 'prj_a'), null, jsonb_build_array(pg_temp.item('s1', 'ivy', '2027-06-01T12:15:00Z', jsonb_build_object('project_id', 'x'))))$$,
  'XR001', 'aurora_intake_item_invalid: Line 1 cannot set project_id.', 'an unknown value is refused');
select pg_temp.as_platform();
select is(pg_temp.segments(), 0, 'no refusal left a segment');
select is((select suggestion_state::text from app.ai_suggestions where id = pg_temp.id('s1')), 'Proposed', 'nor moved the line');

-- Applying ------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
create temporary table applied as
  select app.apply_itinerary_lines(pg_temp.id('prj_a'), pg_temp.id('ful_travel'),
    jsonb_build_array(pg_temp.item('s1', 'ivy', '2027-06-01T12:15:00Z', jsonb_build_object('engagement_id', pg_temp.id('eng_ivy_a'), 'service_identifier', 'GA 100')),
      pg_temp.item('s2', 'art', '2027-06-01T12:15:00Z'))) as r;
grant select on applied to public;
select pg_temp.as_platform();
select is(pg_temp.segments(), 2, 'kept lines are written');
select is(jsonb_array_length((select r -> 'written' from applied)), 2, 'it answers what it wrote');
select is((select fulfillment_id from app.travel_segments where person_id = pg_temp.id('ivy') and project_id = pg_temp.id('prj_a')), pg_temp.id('ful_travel'), 'under the Travel fulfillment');
select is((select suggestion_state::text from app.ai_suggestions where id = pg_temp.id('s1')), 'Applied', 'a kept line ends Applied');
select ok((select applied_id from app.ai_suggestions where id = pg_temp.id('s1')) = (select id from app.travel_segments where person_id = pg_temp.id('ivy') and project_id = pg_temp.id('prj_a')), 'with its segment');
select is((select suggestion_state::text from app.ai_suggestions where id = pg_temp.id('s3')), 'Proposed', 'an untouched line stays open');
select is((select count(*)::int from app.domain_events e where e.event_type = 'travel_segment.created' and e.subject_id in (select id from app.travel_segments where project_id = pg_temp.id('prj_a'))), 2, 'travel_segment.created fires per row');
select is((select count(*)::int from app.roster_travel_requests), 0, 'no roster travel request changes');

-- Duplicates --------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select throws_ok($$select app.apply_itinerary_lines((select id from world where key = 'prj_a'), null, jsonb_build_array(pg_temp.item('s3', 'ivy', '2027-06-01T12:15:00Z', jsonb_build_object('service_identifier', 'GA 100'))))$$,
  'XR001', 'aurora_itinerary_duplicate: Line 1 is already booked for this traveler.', 'the same person, service and departure is refused');
select throws_ok($$select app.apply_itinerary_lines((select id from world where key = 'prj_a'), null, jsonb_build_array(pg_temp.item('s3', 'art', '2027-06-01T12:15:00Z')))$$,
  'XR001', 'aurora_itinerary_duplicate: Line 1 is already booked for this traveler.', 'a blank service repeats a blank service');
select lives_ok($$select app.apply_itinerary_lines((select id from world where key = 'prj_a'), null, jsonb_build_array(pg_temp.item('s3', 'ivy', '2027-06-01T12:15:00Z', jsonb_build_object('service_identifier', 'GA 101'))))$$,
  'another service at that time is not a repeat');
select throws_ok($$select app.apply_itinerary_lines((select id from world where key = 'prj_a'), null, jsonb_build_array(pg_temp.item('s3', 'ivy', '2027-06-03T12:15:00Z')))$$,
  'XR001', 'aurora_intake_item_invalid: Line 1 is no longer proposed. Read the file again.', 'an applied line cannot apply again');

select * from finish();
rollback;
