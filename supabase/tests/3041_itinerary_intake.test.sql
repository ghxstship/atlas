-- pgTAP: itinerary intake (B15, RRR-239, migration 3041). Traveler candidates: the project's people by folded name at a
-- similarity of 0.85 or more, never someone outside the project, no fact log row, the capability. Applying: the kept
-- segments in one transaction under the batch's fulfillment with the person's values, Applied with their segments, the
-- rest Rejected and the batch closed; the refusals (a missing required value named by item, a traveler outside the
-- project, a suggestion of another batch, a repeated segment within the items or against a live one, a zone the guard
-- refuses, a closed batch, another person) leave nothing behind.
-- World: 0700_engagement_world (ivy Crew and art Artist on prj_a, quinn on org_b's prj_b only).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select no_plan();

create function pg_temp.segment(p_key text, p_request text, p_from text, p_to text, p_service text) returns uuid
language plpgsql as $$
declare v uuid;
begin
  v := app.ai_propose_suggestion(pg_temp.id(p_request), 'auroraIntakes.applyItineraries', null, 'Add a segment from ' || p_from || ' to ' || p_to || '.',
    jsonb_build_array(
      jsonb_build_object('field_path', 'passenger_name', 'value', 'Ivy Marchetti', 'confidence', 0.9),
      jsonb_build_object('field_path', 'travel_mode', 'value', 'Flight', 'confidence', 0.9),
      jsonb_build_object('field_path', 'operator_name', 'value', 'Gulf Air Lines', 'confidence', 0.8),
      case when p_service is null
        then jsonb_build_object('field_path', 'service_identifier', 'refusal', 'NO_ANSWER', 'missing', 'No service number is printed.')
        else jsonb_build_object('field_path', 'service_identifier', 'value', p_service, 'confidence', 0.9) end,
      jsonb_build_object('field_path', 'departs_from', 'value', p_from, 'confidence', 0.9),
      jsonb_build_object('field_path', 'departs_time_zone', 'value', 'America/New_York', 'confidence', 0.6),
      jsonb_build_object('field_path', 'arrives_at_place', 'value', p_to, 'confidence', 0.9),
      jsonb_build_object('field_path', 'arrives_time_zone', 'value', 'America/Chicago', 'confidence', 0.6),
      jsonb_build_object('field_path', 'price_minor', 'refusal', 'NO_ANSWER', 'missing', 'The fare is for two passengers.')));
  insert into world values (p_key, v);
  return v;
end $$;

create function pg_temp.item(p_suggestion text, p_values jsonb) returns jsonb
language sql stable as $$ select jsonb_build_object('suggestion_id', pg_temp.id(p_suggestion), 'values', p_values) $$;

create function pg_temp.traveler(p_person text, p_departs text) returns jsonb
language sql stable as $$ select jsonb_build_object('person_id', pg_temp.id(p_person), 'departs_at', p_departs) $$;

create function pg_temp.segments() returns integer
language sql stable as $$ select count(*)::int from app.travel_segments where project_id = pg_temp.id('prj_a') and deleted_at is null $$;

select pg_temp.as_user('bob');
insert into app.ai_settings (org_id, extraction_enabled) values (pg_temp.id('org_a'), true);
select pg_temp.as_user('dave');
with x as (insert into app.fulfillments (project_id, fulfillment_kind, title) values (pg_temp.id('prj_a'), 'Travel', 'Artist Travel') returning id)
  insert into world select 'ful_travel', id from x;
insert into world values ('b_it', app.start_ai_intake(pg_temp.id('prj_a'), 'Itineraries', 3, pg_temp.id('ful_travel')));
insert into world values ('r1', app.ai_begin_request(pg_temp.id('org_a'), 'extraction', 'claude-sonnet-5-5', 'app.ai_intake_batches', pg_temp.id('b_it')));
select app.ai_complete_request(pg_temp.id('r1'), 'Answered', 'Read the itinerary.', 'Four segments.', 100, 40);
select pg_temp.segment('s1', 'r1', 'MIA', 'ORD', 'GA 100');
select pg_temp.segment('s2', 'r1', 'ORD', 'MIA', 'GA 101');
select pg_temp.segment('s3', 'r1', 'MIA', 'JFK', 'GA 102');
select pg_temp.segment('s4', 'r1', 'JFK', 'MIA', null);

-- Another batch's segment, to show items stay within their batch.
insert into world values ('b_other', app.start_ai_intake(pg_temp.id('prj_a'), 'Itineraries', 1));
insert into world values ('r_other', app.ai_begin_request(pg_temp.id('org_a'), 'extraction', 'claude-sonnet-5-5', 'app.ai_intake_batches', pg_temp.id('b_other')));
select app.ai_complete_request(pg_temp.id('r_other'), 'Answered', 'q', 'a');
select pg_temp.segment('s_other', 'r_other', 'MIA', 'BOS', 'GA 200');

-- Traveler candidates -----------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
create temporary table fact_log_before as select count(*)::int as n from app.work_detail_events where action like 'project_facts%';
grant select on fact_log_before to public;
select pg_temp.as_user('dave');
select set_eq($$select name_index, person_id from app.itinerary_traveler_candidates((select id from world where key = 'b_it'),
    array['IVY MARCHETTI', 'Árturo  Bell', 'Quinn Ashby', 'Nobody At All'])$$,
  $$values (1, (select id from world where key = 'ivy')), (2, (select id from world where key = 'art'))$$,
  'case and accents fold, and only people of the project match');
select ok((select bool_and(similarity >= 0.85) from app.itinerary_traveler_candidates(pg_temp.id('b_it'), array['Ivy Marchetti', 'Arturo Bell'])),
  'every candidate meets the 0.85 threshold');
select is((select engagement_id from app.itinerary_traveler_candidates(pg_temp.id('b_it'), array['Ivy Marchetti'])),
  pg_temp.id('eng_ivy_a'), 'an engaged traveler carries the engagement');
select pg_temp.as_platform();
select is((select count(*)::int from app.work_detail_events where action like 'project_facts%'), (select n from fact_log_before),
  'reading candidates writes no fact log row');
select pg_temp.as_user('gina');
select throws_ok($$select * from app.itinerary_traveler_candidates((select id from world where key = 'b_it'), array['Ivy'])$$,
  '42501', null, 'someone else is refused');
select pg_temp.as_user('dave');
select throws_ok($$select * from app.itinerary_traveler_candidates((select id from world where key = 'b_it'), array_fill('x'::text, array[101]))$$,
  'XR001', 'aurora_intake_item_invalid: Look up at most 100 names at a time.', 'at most 100 names');

-- Refusals write nothing ----------------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select throws_ok($$select app.apply_itinerary_intake((select id from world where key = 'b_it'),
    jsonb_build_array(pg_temp.item('s1', jsonb_build_object('person_id', (select id from world where key = 'ivy')))))$$,
  'XR001', 'aurora_intake_item_invalid: Item 1 needs departs at.', 'a segment without a departure is refused by item');
select throws_ok($$select app.apply_itinerary_intake((select id from world where key = 'b_it'),
    jsonb_build_array(pg_temp.item('s1', pg_temp.traveler('ivy', '2027-06-01T12:15:00Z') - 'person_id')))$$,
  'XR001', 'aurora_intake_item_invalid: Item 1 needs person id.', 'a segment without a traveler is refused');
select throws_ok($$select app.apply_itinerary_intake((select id from world where key = 'b_it'),
    jsonb_build_array(pg_temp.item('s1', pg_temp.traveler('quinn', '2027-06-01T12:15:00Z'))))$$,
  'XR001', 'aurora_intake_item_invalid: Item 1: the traveler is not one of this project''s people.', 'a traveler outside the project is refused');
select throws_ok($$select app.apply_itinerary_intake((select id from world where key = 'b_it'),
    jsonb_build_array(pg_temp.item('s_other', pg_temp.traveler('ivy', '2027-06-01T12:15:00Z'))))$$,
  'XR001', 'aurora_intake_item_invalid: Item 1 is not a segment of this intake.', 'a segment of another batch is refused');
select throws_ok($$select app.apply_itinerary_intake((select id from world where key = 'b_it'),
    jsonb_build_array(pg_temp.item('s1', pg_temp.traveler('ivy', '2027-06-01T12:15:00Z') || '{"departs_from": "   "}')))$$,
  'XR001', 'aurora_intake_item_invalid: Item 1 needs departs from.', 'a blank place is missing, not kept');
select throws_ok($$select app.apply_itinerary_intake((select id from world where key = 'b_it'),
    jsonb_build_array(pg_temp.item('s1', pg_temp.traveler('ivy', '2027-06-01T12:15:00Z')),
      pg_temp.item('s1', pg_temp.traveler('ivy', '2027-06-01T12:15:00Z'))))$$,
  'XR001', 'aurora_intake_item_invalid: Item 2 is listed twice.', 'a suggestion is applied once');
select throws_ok($$select app.apply_itinerary_intake((select id from world where key = 'b_it'),
    jsonb_build_array(pg_temp.item('s1', pg_temp.traveler('ivy', '2027-06-01T12:15:00Z')),
      pg_temp.item('s2', pg_temp.traveler('ivy', '2027-06-01T12:15:00Z') || '{"service_identifier": "ga 100"}')))$$,
  'XR001', 'itinerary_duplicate: Item 2 repeats another segment of this import.', 'two items repeating one segment are refused');
select throws_ok($$select app.apply_itinerary_intake((select id from world where key = 'b_it'),
    jsonb_build_array(pg_temp.item('s1', pg_temp.traveler('ivy', '2027-06-01T12:15:00Z') || '{"departs_time_zone": "Mars/Olympus"}')))$$,
  'XR001', null, 'a zone the travel guard refuses is refused');
with x as (insert into app.travel_segments (project_id, person_id, travel_mode, service_identifier, departs_from, departs_at,
    departs_time_zone, arrives_at_place, arrives_time_zone)
  values (pg_temp.id('prj_a'), pg_temp.id('art'), 'Flight', 'GA 102', 'MIA', '2027-06-03T14:00:00Z', 'America/New_York', 'JFK',
    'America/New_York') returning id)
  insert into world select 'seg_booked', id from x;
select throws_ok($$select app.apply_itinerary_intake((select id from world where key = 'b_it'),
    jsonb_build_array(pg_temp.item('s1', pg_temp.traveler('ivy', '2027-06-01T12:15:00Z')),
      pg_temp.item('s3', pg_temp.traveler('art', '2027-06-03T14:00:00Z'))))$$,
  'XR001', 'itinerary_duplicate: Item 2 is already booked for this traveler.', 'a segment the traveler already has is refused');

-- Another org's booking of the same traveler never counts as a repeat here (the apply below writes ivy's GA 100).
select pg_temp.as_user('xavier');
insert into app.travel_segments (project_id, person_id, travel_mode, service_identifier, departs_from, departs_at,
    departs_time_zone, arrives_at_place, arrives_time_zone)
  values (pg_temp.id('prj_b'), pg_temp.id('ivy'), 'Flight', 'GA 100', 'MIA', '2027-06-01T12:15:00Z', 'America/New_York', 'ORD',
    'America/Chicago');
select pg_temp.as_user('dave');
select is(pg_temp.segments(), 1, 'no refused apply wrote a segment');
select is((select count(*)::int from app.ai_suggestions where request_id = pg_temp.id('r1') and suggestion_state = 'Proposed'), 4,
  'and every suggestion is still Proposed');

-- Applying ------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('erin');
select throws_ok($$select app.apply_itinerary_intake((select id from world where key = 'b_it'),
    jsonb_build_array(pg_temp.item('s1', pg_temp.traveler('ivy', '2027-06-01T12:15:00Z'))))$$,
  '42501', null, 'only the batch''s creator applies it');
select pg_temp.as_user('dave');
create temporary table applied as
select app.apply_itinerary_intake(pg_temp.id('b_it'), jsonb_build_array(
  pg_temp.item('s1', pg_temp.traveler('ivy', '2027-06-01T12:15:00Z') || jsonb_build_object('arrives_at', '2027-06-01T15:40:00Z',
    'engagement_id', pg_temp.id('eng_ivy_a'))),
  pg_temp.item('s4', pg_temp.traveler('art', '2027-06-05T19:00:00Z') || '{"departs_from": "JFK Terminal 4", "travel_mode": "Ground"}'))) as result;
select is((select jsonb_array_length(result -> 'written') from applied), 2, 'two segments are written');
select is((select (result ->> 'rejected')::int from applied), 2, 'the two left out are rejected');
select is(pg_temp.segments(), 3, 'the project has the two new segments');
select is((select count(*)::int from app.travel_segments where fulfillment_id = pg_temp.id('ful_travel')), 2,
  'both are filed under the batch''s Travel fulfillment');
select results_eq($$select person_id, engagement_id, travel_mode::text, departs_from, departs_at, arrives_at, service_identifier, price_minor
    from app.travel_segments where fulfillment_id = (select id from world where key = 'ful_travel') order by departs_at$$,
  $$values ((select id from world where key = 'ivy'), (select id from world where key = 'eng_ivy_a'), 'Flight', 'MIA',
      '2027-06-01T12:15:00Z'::timestamptz, '2027-06-01T15:40:00Z'::timestamptz, 'GA 100', null::bigint),
    ((select id from world where key = 'art'), null::uuid, 'Ground', 'JFK Terminal 4', '2027-06-05T19:00:00Z'::timestamptz, null::timestamptz,
      null::text, null::bigint)$$,
  'the person''s values override the proposal, and a NO_ANSWER fare stays unpriced');
select is((select suggestion_state::text from app.ai_suggestions where id = pg_temp.id('s1')), 'Applied', 'a kept suggestion is Applied');
select is((select applied_id from app.ai_suggestions where id = pg_temp.id('s1')),
  (select (e ->> 'id')::uuid from applied, jsonb_array_elements(result -> 'written') e where e ->> 'suggestion_id' = pg_temp.id('s1')::text),
  'with the segment it wrote');
select is((select suggestion_state::text from app.ai_suggestions where id = pg_temp.id('s3')), 'Rejected', 'a left-out suggestion is Rejected');
select is((select suggestion_state::text from app.ai_suggestions where id = pg_temp.id('s_other')), 'Proposed', 'another batch is untouched');
select isnt((select closed_at from app.ai_intake_batches where id = pg_temp.id('b_it')), null, 'the batch is closed');
select throws_ok($$select app.apply_itinerary_intake((select id from world where key = 'b_it'),
    jsonb_build_array(pg_temp.item('s2', pg_temp.traveler('ivy', '2027-06-02T12:15:00Z'))))$$,
  'XR001', 'aurora_intake_closed: This intake is closed. Start a new one to read more files.', 'a batch applies once');

select pg_temp.as_platform();
select ok(not has_function_privilege('anon', 'app.apply_itinerary_intake(uuid, jsonb)', 'execute'), 'anon cannot apply');
select ok(not has_function_privilege('authenticated', 'private.fold_name(text)', 'execute'), 'the name folding is private');

select * from finish();
rollback;
