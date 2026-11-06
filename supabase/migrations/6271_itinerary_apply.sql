-- 6271_itinerary_apply.sql
-- B15 itineraries into travel segments (RRR-239, parity gap G-59; ADR 0154). Extraction proposes one travelSegments.create
-- suggestion per passenger and segment on a request about the project; the person picks each traveler and adds the lines
-- they keep. No table, column or view is added: segments are ordinary app.travel_segments rows under their own guards.
--
--   * private.project_people: who stands on a project, one function so the review and the apply cannot disagree.
--   * app.itinerary_traveler_candidates: those people's names, and no travel value, so no project_facts.viewed row.
--   * app.apply_itinerary_lines: writes the kept lines in one transaction. Unlike a drafted list the others stay Proposed,
--     so a person may finish later; rejecting them is explicit.

create or replace function private.project_people(p_project_id uuid)
returns table (person_id uuid, engagement_id uuid, source text)
language sql
stable
security definer
set search_path = ''
as $$
  select m.person_id, null::uuid, 'Member'::text
  from app.project_members pm
  join app.memberships m on m.id = pm.membership_id and m.deleted_at is null
    and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
  where pm.project_id = p_project_id and pm.deleted_at is null
    and pm.valid_from <= now() and (pm.valid_to is null or pm.valid_to > now())
  union all
  select e.person_id, e.id, 'Engagement'::text
  from app.engagements e
  where e.project_id = p_project_id and e.person_id is not null and e.deleted_at is null
    and e.engagement_state in ('Onboarding', 'Blocked', 'Active', 'Closing')
  union all
  select t.person_id, t.engagement_id, 'Roster'::text
  from private.travel_party_entries(p_project_id) t;
$$;

comment on function private.project_people(uuid) is 'The people who stand on a project (B15): current project members, the people of live engagements, and R5''s travel party with their engagement. Read by app.itinerary_traveler_candidates and by the applies that take a traveler or a party, so they cannot disagree.';

create or replace function app.itinerary_traveler_candidates(p_project_id uuid)
returns table (person_id uuid, engagement_id uuid, display_name text, source text)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_org uuid;
begin
  select p.org_id into v_org from app.projects p where p.id = p_project_id and p.deleted_at is null;
  if v_org is null or not private.is_member(v_org) or not private.can_on_project(p_project_id, 'hospitality.fulfillment.read') then
    raise exception using errcode = '42501', message = 'traveler candidates need hospitality.fulfillment.read on the project in your org';
  end if;
  return query
    select s.person_id, s.engagement_id, n.full_name, s.source
    from private.project_people(p_project_id) s
    join app.person_names(array(select x.person_id from private.project_people(p_project_id) x)) n on n.person_id = s.person_id
    order by n.full_name, s.person_id, s.source, s.engagement_id;
end;
$$;

comment on function app.itinerary_traveler_candidates(uuid) is 'Who an itinerary''s passengers may be on a project (B15): private.project_people with display names through app.person_names. Needs hospitality.fulfillment.read on the project and membership in its org, otherwise 42501. Names only, no travel value, so it writes no project_facts.viewed row.';

create or replace function app.apply_itinerary_lines(p_project_id uuid, p_fulfillment_id uuid, p_items jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_keys constant text[] := array['person_id', 'engagement_id', 'travel_mode', 'operator_name', 'service_identifier',
    'confirmation_identifier', 'departs_from', 'departs_at', 'departs_time_zone', 'arrives_at_place', 'arrives_at',
    'arrives_time_zone', 'price_minor', 'currency_code'];
  v_org uuid;
  v_item jsonb;
  v_values jsonb;
  v_key text;
  v_value jsonb;
  v_row jsonb;
  v_rows jsonb := '[]';
  v_line integer := 0;
  v_suggestion app.ai_suggestions;
  v_request app.ai_requests;
  v_suggestion_id uuid;
  v_seen uuid[] := '{}';
  v_person uuid;
  v_engagement uuid;
  v_departs timestamptz;
  v_service text;
  v_id uuid;
  v_written jsonb := '[]';
  v_state text;
  v_message text;
  v_hint text;
begin
  select p.org_id into v_org from app.projects p where p.id = p_project_id and p.deleted_at is null;
  if v_org is null or not private.is_member(v_org) or not private.can_on_project(p_project_id, 'hospitality.fulfillment.write') then
    raise exception using errcode = '42501', message = 'adding travel segments needs hospitality.fulfillment.write on the project in your org';
  end if;
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) not between 1 and 100 then
    perform private.refuse('aurora_intake_item_invalid', 'Add between 1 and 100 lines.');
  end if;

  for v_item in select value from jsonb_array_elements(p_items) loop
    v_line := v_line + 1;
    if jsonb_typeof(v_item) <> 'object' or jsonb_typeof(v_item -> 'suggestion_id') is distinct from 'string'
       or (v_item ->> 'suggestion_id') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
      perform private.refuse('aurora_intake_item_invalid', format('Line %s does not name a suggestion.', v_line));
    end if;
    v_suggestion_id := (v_item ->> 'suggestion_id')::uuid;
    select * into v_suggestion from app.ai_suggestions s where s.id = v_suggestion_id and s.deleted_at is null;
    if v_suggestion.id is null or not private.ai_request_is_mine(v_suggestion.request_id) then
      raise exception using errcode = '42501', message = 'only the person who asked adds these lines';
    end if;
    select * into v_request from app.ai_requests r where r.id = v_suggestion.request_id;
    -- The request's subject is the proof a line belongs to this project; a suggestion's own fields prove nothing.
    if v_request.feature <> 'extraction' or v_request.outcome <> 'Answered' or v_request.subject_table is distinct from 'app.projects'
       or v_request.subject_id is distinct from p_project_id or v_request.org_id is distinct from v_org
       or v_suggestion.operation_id <> 'travelSegments.create' then
      perform private.refuse('aurora_intake_item_invalid', format('Line %s is not a line read for this project.', v_line));
    end if;
    if v_suggestion_id = any (v_seen) then
      perform private.refuse('aurora_intake_item_invalid', format('Line %s is listed twice.', v_line));
    end if;
    v_seen := v_seen || v_suggestion_id;
    if v_suggestion.suggestion_state <> 'Proposed' or v_suggestion.expires_at <= now() then
      perform private.refuse('aurora_intake_item_invalid', format('Line %s is no longer proposed. Read the file again.', v_line));
    end if;
    v_values := coalesce(v_item -> 'values', '{}'::jsonb);
    if jsonb_typeof(v_values) <> 'object' then
      perform private.refuse('aurora_intake_item_invalid', format('Line %s gives its values as an object.', v_line));
    end if;
    for v_key in select jsonb_object_keys(v_values) loop
      if not (v_key = any (v_keys)) then
        perform private.refuse('aurora_intake_item_invalid', format('Line %s cannot set %s.', v_line, v_key));
      end if;
    end loop;

    -- A value given overrides the proposal key by key; a NO_ANSWER field stays empty unless a value is given. The
    -- traveler and the engagement come only from the person.
    v_row := jsonb_build_object('suggestion_id', v_suggestion_id);
    foreach v_key in array v_keys loop
      v_value := null;
      if v_values ? v_key then
        v_value := v_values -> v_key;
      elsif v_key not in ('person_id', 'engagement_id') then
        select f.proposed_value into v_value from app.ai_suggestion_fields f
        where f.suggestion_id = v_suggestion_id and f.field_path = v_key and f.refusal is null and f.deleted_at is null;
      end if;
      if v_value is not null and jsonb_typeof(v_value) = 'string' and btrim(v_value #>> '{}') = '' then
        v_value := null;
      end if;
      v_row := v_row || jsonb_build_object(v_key, coalesce(v_value, 'null'::jsonb));
    end loop;
    v_rows := v_rows || jsonb_build_array(v_row);
  end loop;

  -- Inserts in the given order. A refusal names the line and rolls back the whole call.
  v_line := 0;
  for v_row in select value from jsonb_array_elements(v_rows) loop
    v_line := v_line + 1;
    begin
      v_person := (v_row ->> 'person_id')::uuid;
      v_engagement := (v_row ->> 'engagement_id')::uuid;
      if v_person is null or not exists (
           select 1 from private.project_people(p_project_id) s
           where s.person_id = v_person and (v_engagement is null or s.engagement_id = v_engagement)) then
        perform private.refuse('aurora_itinerary_traveler', format('Line %s: choose someone on this project, with their own engagement.', v_line));
      end if;
      v_departs := (v_row ->> 'departs_at')::timestamptz;
      v_service := nullif(btrim(v_row ->> 'service_identifier'), '');
      if v_departs is null then
        perform private.refuse('aurora_intake_item_invalid', format('Line %s needs a departure time and zone.', v_line));
      end if;
      if exists (
           select 1 from app.travel_segments ts
           where ts.person_id = v_person and ts.departs_at = v_departs and ts.deleted_at is null
             and nullif(btrim(ts.service_identifier), '') is not distinct from v_service) then
        perform private.refuse('aurora_itinerary_duplicate', format('Line %s is already booked for this traveler.', v_line));
      end if;
      insert into app.travel_segments (project_id, person_id, engagement_id, fulfillment_id, travel_mode, operator_name,
        service_identifier, confirmation_identifier, departs_from, departs_at, departs_time_zone, arrives_at_place,
        arrives_at, arrives_time_zone, price_minor, currency_code)
      values (p_project_id, v_person, v_engagement, p_fulfillment_id, (v_row ->> 'travel_mode')::app.travel_mode,
        nullif(btrim(v_row ->> 'operator_name'), ''), v_service, nullif(btrim(v_row ->> 'confirmation_identifier'), ''),
        v_row ->> 'departs_from', v_departs, v_row ->> 'departs_time_zone', v_row ->> 'arrives_at_place',
        (v_row ->> 'arrives_at')::timestamptz, v_row ->> 'arrives_time_zone', (v_row ->> 'price_minor')::bigint,
        nullif(upper(btrim(v_row ->> 'currency_code')), ''))
      returning id into v_id;
    exception when others then
      get stacked diagnostics v_state = returned_sqlstate, v_message = message_text, v_hint = pg_exception_hint;
      if v_state = 'XR001' then
        -- Keep the refusal contract: message '<rule>: <sentence>' and hint '<rule>'.
        v_hint := coalesce(nullif(v_hint, ''), 'refused');
        raise exception using errcode = 'XR001', hint = v_hint,
          message = v_hint || ': ' || case when v_message like '%Line ' || v_line || '%' then '' else 'Line ' || v_line || ': ' end
            || case when left(v_message, char_length(v_hint) + 2) = v_hint || ': '
                    then substr(v_message, char_length(v_hint) + 3) else v_message end;
      elsif v_state in ('23514', '23502', '23503', '22P02', '22003', '22007', '22008') then
        raise exception using errcode = v_state, message = 'Line ' || v_line || ': ' || v_message;
      end if;
      raise;
    end;
    v_written := v_written || jsonb_build_array(jsonb_build_object('suggestion_id', v_row ->> 'suggestion_id', 'id', v_id));
  end loop;

  for v_row in select value from jsonb_array_elements(v_written) loop
    perform app.transition_ai_suggestion((v_row ->> 'suggestion_id')::uuid, 'Proposed', 'Confirmed',
      'Kept in the itinerary review.');
    perform app.transition_ai_suggestion((v_row ->> 'suggestion_id')::uuid, 'Confirmed', 'Applied',
      'Written by app.apply_itinerary_lines.', (v_row ->> 'id')::uuid);
  end loop;

  return jsonb_build_object('written', v_written, 'duplicates_checked', jsonb_array_length(v_written));
end;
$$;

comment on function app.apply_itinerary_lines(uuid, uuid, jsonb) is 'Adds kept itinerary lines as travel segments (B15, ADR 0154). Needs hospitality.fulfillment.write on the project and membership in its org, otherwise 42501. p_items lists 1 to 100 {suggestion_id, values}: each suggestion is the caller''s own (42501), Proposed and unexpired, a travelSegments.create suggestion of an Answered extraction request whose subject is this project in its org, named once (aurora_intake_item_invalid otherwise). values override the proposed fields key by key (person_id, engagement_id, travel_mode, operator_name, service_identifier, confirmation_identifier, departs_from, departs_at, departs_time_zone, arrives_at_place, arrives_at, arrives_time_zone, price_minor, currency_code); the traveler and the engagement come only from values. The traveler must stand on the project through private.project_people, and a given engagement must be theirs there (aurora_itinerary_traveler). A live segment with the same person, service (is not distinct from) and departure refuses aurora_itinerary_duplicate. A given fulfillment must be a Travel fulfillment of the project (the segment''s own guard and t39 decide). Every refusal names its line and rolls back the call. Kept suggestions move Proposed, Confirmed, Applied with their segment; the others stay Proposed. travel_segment.created fires per row. Returns {written: [{suggestion_id, id}], duplicates_checked}. Calls no model and meters nothing, and no project fact changes.';

revoke all on function private.project_people(uuid) from public, anon, authenticated;
revoke all on function app.itinerary_traveler_candidates(uuid) from public, anon;
revoke all on function app.apply_itinerary_lines(uuid, uuid, jsonb) from public, anon;
grant execute on function app.itinerary_traveler_candidates(uuid) to authenticated, service_role;
grant execute on function app.apply_itinerary_lines(uuid, uuid, jsonb) to authenticated, service_role;
