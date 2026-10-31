-- 3041_itinerary_intake.sql
-- B15 itinerary intake (RRR-239, parity gap G-59; ADR 0154). Aurora reads up to 25 confirmations into one preview of
-- proposed travel segments, one auroraIntakes.applyItineraries suggestion per passenger and segment, and the person files the
-- rows they keep under a Travel fulfillment in one step.
--
--   * private.fold_name: the name key both candidate lookups compare (case-folded, accents and punctuation removed).
--   * app.itinerary_traveler_candidates: for each printed passenger name, the project's people with a name similarity
--     of 0.85 or more (the P3 threshold): the org's members, the people engaged on the project, and the travel party
--     of R5 with their roster entry. Names and ids only, so nothing reaches R5's fact log.
--   * app.apply_itinerary_intake: writes the kept segments in one transaction with the person's values, refuses a
--     repeated segment (itinerary_duplicate), marks the kept suggestions Applied with their segments, rejects the
--     batch's other suggestions and closes the batch.
-- No table, column or view is added; the segments are ordinary app.travel_segments rows under their own guards.

-- Names --------------------------------------------------------------------------------------------------------------------

create or replace function private.fold_name(p_name text)
returns text
language sql
immutable
set search_path = ''
as $$
  select btrim(regexp_replace(regexp_replace(
    regexp_replace(lower(normalize(coalesce(p_name, ''), NFKD)), '[̀-ͯ]', '', 'g'),
    '[^a-z0-9 ]+', ' ', 'g'), '\s+', ' ', 'g'));
$$;

comment on function private.fold_name(text) is 'A name as the B15 candidate lookups compare it: NFKD-normalized, lower case, combining accents removed, other punctuation as spaces, spaces collapsed. No unaccent dictionary is needed.';

-- Traveler candidates ------------------------------------------------------------------------------------------------------

create or replace function app.itinerary_traveler_candidates(p_batch_id uuid, p_names text[])
returns table (name_index integer, person_id uuid, full_name text, roster_entry_id uuid, engagement_id uuid, similarity numeric)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_batch app.ai_intake_batches;
begin
  select * into v_batch from app.ai_intake_batches b where b.id = p_batch_id and b.deleted_at is null;
  if v_batch.id is null or v_batch.created_by is distinct from private.current_person_id()
     or v_batch.intake_kind <> 'Itineraries'
     or not private.can_on_project(v_batch.project_id, 'hospitality.fulfillment.write') then
    raise exception using errcode = '42501', message = 'traveler candidates need your own itinerary intake and hospitality.fulfillment.write on its project';
  end if;
  if coalesce(cardinality(p_names), 0) > 100 then
    perform private.refuse('aurora_intake_item_invalid', 'Look up at most 100 names at a time.');
  end if;
  return query
    with people as (
      select m.person_id, null::uuid as roster_entry_id, null::uuid as engagement_id
      from app.memberships m
      where m.org_id = v_batch.org_id and m.deleted_at is null and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
      union
      select e.person_id, null::uuid, e.id
      from app.engagements e
      where e.project_id = v_batch.project_id and e.person_id is not null and e.deleted_at is null
        and e.engagement_state in ('Onboarding', 'Blocked', 'Active', 'Closing')
      union
      select t.person_id, t.roster_entry_id, t.engagement_id
      from private.travel_party_entries(v_batch.project_id) t
    ),
    named as (
      select n.ord::integer as idx, private.fold_name(n.name) as probe
      from unnest(p_names) with ordinality n (name, ord)
      where private.fold_name(n.name) <> ''
    )
    select x.idx, x.person_id, x.full_name, x.roster_entry_id, x.engagement_id, x.sim
    from (
      select nm.idx, pe.person_id, h.full_name, pe.roster_entry_id, pe.engagement_id,
        round(extensions.similarity(private.fold_name(h.full_name), nm.probe)::numeric, 3) as sim,
        row_number() over (partition by nm.idx, pe.person_id
          order by (pe.roster_entry_id is not null) desc, (pe.engagement_id is not null) desc) as pick
      from named nm
      cross join people pe
      join app.people h on h.id = pe.person_id
      where extensions.similarity(private.fold_name(h.full_name), nm.probe) >= 0.85
    ) x
    where x.pick = 1
    order by x.idx, x.sim desc, x.full_name, x.person_id;
end;
$$;

comment on function app.itinerary_traveler_candidates(uuid, text[]) is 'For each passenger name an itinerary prints (at most 100), the people of the caller''s own Itineraries batch''s project whose folded name (private.fold_name) has a trigram similarity of 0.85 or more: the org''s current members, the people of the project''s live engagements, and R5''s travel party (private.travel_party_entries) with the roster entry and engagement, one row per name and person. Needs hospitality.fulfillment.write on the project (42501 otherwise). Returns names and ids only, never a travel fact, so it writes no project_facts read log row.';

-- Applying an itinerary intake ---------------------------------------------------------------------------------------------

create or replace function app.apply_itinerary_intake(p_batch_id uuid, p_items jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_batch app.ai_intake_batches;
  v_keys constant text[] := array['person_id', 'engagement_id', 'fulfillment_id', 'departs_at', 'departs_time_zone',
    'arrives_at', 'arrives_time_zone', 'departs_from', 'arrives_at_place', 'operator_name', 'service_identifier',
    'confirmation_identifier', 'travel_mode', 'price_minor', 'currency_code'];
  -- Keys whose proposed field (same path) stands when the person gives no value. Instants and people come from them.
  v_proposed constant text[] := array['departs_time_zone', 'arrives_time_zone', 'departs_from', 'arrives_at_place',
    'operator_name', 'service_identifier', 'confirmation_identifier', 'travel_mode', 'price_minor', 'currency_code'];
  v_item jsonb;
  v_values jsonb;
  v_key text;
  v_value jsonb;
  v_line integer := 0;
  v_suggestion app.ai_suggestions;
  v_request app.ai_requests;
  v_suggestion_id uuid;
  v_seen uuid[] := '{}';
  v_rows jsonb := '[]';
  v_row jsonb;
  v_text text;
  v_person uuid;
  v_departs timestamptz;
  v_arrives timestamptz;
  v_dupes text[] := '{}';
  v_dupe text;
  v_id uuid;
  v_written jsonb := '[]';
  v_rejected integer := 0;
  v_other uuid;
  v_state text;
  v_message text;
  v_hint text;
begin
  -- (a) The caller's own open Itineraries batch, locked so a second apply waits and then finds it closed.
  select * into v_batch from app.ai_intake_batches b where b.id = p_batch_id and b.deleted_at is null for update;
  if v_batch.id is null or v_batch.created_by is distinct from private.current_person_id()
     or v_batch.intake_kind <> 'Itineraries' then
    raise exception using errcode = '42501', message = 'only the person who opened an itinerary intake applies it';
  end if;
  if not private.can_on_project(v_batch.project_id, 'hospitality.fulfillment.write') then
    raise exception using errcode = '42501', message = 'adding travel segments needs hospitality.fulfillment.write on the project';
  end if;
  if v_batch.closed_at is not null then
    perform private.refuse('aurora_intake_closed', 'This intake is closed. Start a new one to read more files.');
  end if;

  -- (b) 1 to 1,500 items (25 files of at most 60 segments), each a Proposed segment suggestion of this batch, once.
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) not between 1 and 1500 then
    perform private.refuse('aurora_intake_item_invalid', 'Add between 1 and 1,500 segments.');
  end if;
  for v_item in select value from jsonb_array_elements(p_items) loop
    v_line := v_line + 1;
    if jsonb_typeof(v_item) <> 'object' or jsonb_typeof(v_item -> 'suggestion_id') is distinct from 'string'
       or (v_item ->> 'suggestion_id') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
      perform private.refuse('aurora_intake_item_invalid', format('Item %s does not name a suggestion.', v_line));
    end if;
    v_suggestion_id := (v_item ->> 'suggestion_id')::uuid;
    select * into v_suggestion from app.ai_suggestions s where s.id = v_suggestion_id and s.deleted_at is null;
    select * into v_request from app.ai_requests r where r.id = v_suggestion.request_id;
    if v_suggestion.id is null or v_request.subject_table is distinct from 'app.ai_intake_batches'
       or v_request.subject_id is distinct from p_batch_id or v_suggestion.operation_id <> 'auroraIntakes.applyItineraries' then
      perform private.refuse('aurora_intake_item_invalid', format('Item %s is not a segment of this intake.', v_line));
    end if;
    if v_suggestion_id = any (v_seen) then
      perform private.refuse('aurora_intake_item_invalid', format('Item %s is listed twice.', v_line));
    end if;
    v_seen := v_seen || v_suggestion_id;
    if v_suggestion.suggestion_state <> 'Proposed' or v_suggestion.expires_at <= now() then
      perform private.refuse('aurora_intake_item_invalid', format('Item %s is no longer proposed. Read the file again.', v_line));
    end if;
    v_values := coalesce(v_item -> 'values', '{}'::jsonb);
    if jsonb_typeof(v_values) <> 'object' then
      perform private.refuse('aurora_intake_item_invalid', format('Item %s gives its values as an object.', v_line));
    end if;
    for v_key in select jsonb_object_keys(v_values) loop
      if not (v_key = any (v_keys)) then
        perform private.refuse('aurora_intake_item_invalid', format('Item %s cannot set %s.', v_line, v_key));
      end if;
    end loop;

    -- A value given overrides the proposed field key by key; a NO_ANSWER field stays empty unless a value is given.
    v_row := jsonb_build_object('suggestion_id', v_suggestion_id);
    foreach v_key in array v_keys loop
      v_value := null;
      if v_values ? v_key then
        v_value := v_values -> v_key;
      elsif v_key = any (v_proposed) then
        select f.proposed_value into v_value from app.ai_suggestion_fields f
        where f.suggestion_id = v_suggestion_id and f.field_path = v_key and f.refusal is null and f.deleted_at is null;
      end if;
      if v_value is not null and jsonb_typeof(v_value) = 'string' and btrim(v_value #>> '{}') = '' then
        v_value := null;
      end if;
      v_row := v_row || jsonb_build_object(v_key, coalesce(v_value, 'null'::jsonb));
    end loop;
    if jsonb_typeof(v_row -> 'fulfillment_id') = 'null' and v_batch.fulfillment_id is not null then
      v_row := v_row || jsonb_build_object('fulfillment_id', v_batch.fulfillment_id);
    end if;

    -- (c) The columns app.travel_segments requires, and their lengths, named by item.
    foreach v_key in array array['person_id', 'travel_mode', 'departs_from', 'departs_at', 'departs_time_zone',
      'arrives_at_place', 'arrives_time_zone'] loop
      if jsonb_typeof(v_row -> v_key) is distinct from 'string' then
        perform private.refuse('aurora_intake_item_invalid', format('Item %s needs %s.', v_line, replace(v_key, '_', ' ')));
      end if;
    end loop;
    if (v_row ->> 'travel_mode') not in ('Flight', 'Ground') then
      perform private.refuse('aurora_intake_item_invalid', format('Item %s: the travel mode is Flight or Ground.', v_line));
    end if;
    foreach v_key in array array['departs_from', 'arrives_at_place'] loop
      if char_length(btrim(v_row ->> v_key)) not between 1 and 200 then
        perform private.refuse('aurora_intake_item_invalid', format('Item %s: a place runs 1 to 200 characters.', v_line));
      end if;
    end loop;
    v_text := v_row ->> 'operator_name';
    if v_text is not null and char_length(btrim(v_text)) > 120 then
      perform private.refuse('aurora_intake_item_invalid', format('Item %s: the operator runs at most 120 characters.', v_line));
    end if;
    foreach v_key in array array['service_identifier', 'confirmation_identifier'] loop
      v_text := v_row ->> v_key;
      if v_text is not null and char_length(btrim(v_text)) > 40 then
        perform private.refuse('aurora_intake_item_invalid', format('Item %s: %s runs at most 40 characters.', v_line, replace(v_key, '_', ' ')));
      end if;
    end loop;
    begin
      v_person := (v_row ->> 'person_id')::uuid;
      v_departs := (v_row ->> 'departs_at')::timestamptz;
      v_arrives := (v_row ->> 'arrives_at')::timestamptz;
      perform (v_row ->> 'engagement_id')::uuid, (v_row ->> 'fulfillment_id')::uuid, (v_row ->> 'price_minor')::bigint;
    exception when invalid_text_representation or datetime_field_overflow or invalid_datetime_format or numeric_value_out_of_range then
      perform private.refuse('aurora_intake_item_invalid', format('Item %s has a value of the wrong type.', v_line));
    end;
    -- The traveler is one of the project's people, as the Travel form offers them.
    if not exists (
         select 1 from app.memberships m
         where m.person_id = v_person and m.org_id = v_batch.org_id and m.deleted_at is null
           and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now()))
       and not exists (
         select 1 from app.engagements e
         where e.person_id = v_person and e.project_id = v_batch.project_id and e.deleted_at is null
           and e.engagement_state in ('Onboarding', 'Blocked', 'Active', 'Closing'))
       and not exists (select 1 from private.travel_party_entries(v_batch.project_id) t where t.person_id = v_person) then
      perform private.refuse('aurora_intake_item_invalid', format('Item %s: the traveler is not one of this project''s people.', v_line));
    end if;
    if jsonb_typeof(v_row -> 'engagement_id') = 'string' and not exists (
         select 1 from app.engagements e
         where e.id = (v_row ->> 'engagement_id')::uuid and e.person_id = v_person and e.project_id = v_batch.project_id
           and e.deleted_at is null) then
      perform private.refuse('aurora_intake_item_invalid', format('Item %s: the engagement is not the traveler''s on this project.', v_line));
    end if;

    -- (d) The same person, service and departure once: within the items and against live segments.
    if jsonb_typeof(v_row -> 'service_identifier') = 'string' then
      v_dupe := v_person::text || '|' || upper(btrim(v_row ->> 'service_identifier')) || '|' || v_departs::text;
      if v_dupe = any (v_dupes) then
        perform private.refuse('itinerary_duplicate', format('Item %s repeats another segment of this import.', v_line));
      end if;
      v_dupes := v_dupes || v_dupe;
      if exists (
           select 1 from app.travel_segments ts
           where ts.org_id = v_batch.org_id and ts.person_id = v_person and ts.deleted_at is null and ts.departs_at = v_departs
             and upper(btrim(ts.service_identifier)) = upper(btrim(v_row ->> 'service_identifier'))) then
        perform private.refuse('itinerary_duplicate', format('Item %s is already booked for this traveler.', v_line));
      end if;
    end if;
    v_rows := v_rows || jsonb_build_array(v_row);
  end loop;

  -- (e) Inserts in the given order; a database refusal names the item and rolls back the whole call.
  v_line := 0;
  for v_row in select value from jsonb_array_elements(v_rows) loop
    v_line := v_line + 1;
    begin
      insert into app.travel_segments (project_id, person_id, engagement_id, fulfillment_id, travel_mode, operator_name,
        service_identifier, confirmation_identifier, departs_from, departs_at, departs_time_zone, arrives_at_place,
        arrives_at, arrives_time_zone, price_minor, currency_code)
      values (v_batch.project_id, (v_row ->> 'person_id')::uuid, (v_row ->> 'engagement_id')::uuid,
        (v_row ->> 'fulfillment_id')::uuid, (v_row ->> 'travel_mode')::app.travel_mode,
        nullif(btrim(v_row ->> 'operator_name'), ''), nullif(btrim(v_row ->> 'service_identifier'), ''),
        nullif(btrim(v_row ->> 'confirmation_identifier'), ''), btrim(v_row ->> 'departs_from'),
        (v_row ->> 'departs_at')::timestamptz, v_row ->> 'departs_time_zone', btrim(v_row ->> 'arrives_at_place'),
        (v_row ->> 'arrives_at')::timestamptz, v_row ->> 'arrives_time_zone', (v_row ->> 'price_minor')::bigint,
        nullif(upper(btrim(v_row ->> 'currency_code')), ''))
      returning id into v_id;
    exception when others then
      get stacked diagnostics v_state = returned_sqlstate, v_message = message_text, v_hint = pg_exception_hint;
      if v_state = 'XR001' then
        -- Keep the refusal contract: message '<rule>: <sentence>' and hint '<rule>'.
        v_hint := coalesce(nullif(v_hint, ''), 'refused');
        raise exception using errcode = 'XR001', hint = v_hint,
          message = v_hint || ': Item ' || v_line || ': '
            || case when left(v_message, char_length(v_hint) + 2) = v_hint || ': '
                    then substr(v_message, char_length(v_hint) + 3) else v_message end;
      elsif v_state in ('23514', '23502', '23503', '22P02', '22003', '22007', '22008') then
        raise exception using errcode = v_state, message = 'Item ' || v_line || ': ' || v_message;
      end if;
      raise;
    end;
    v_written := v_written || jsonb_build_array(jsonb_build_object('suggestion_id', v_row ->> 'suggestion_id', 'id', v_id));
  end loop;

  -- (f) Kept suggestions Proposed, Confirmed, Applied with their segment; every other Proposed one of the batch Rejected.
  perform private.begin_trusted_operation('aurora_batch_apply');
  for v_row in select value from jsonb_array_elements(v_written) loop
    perform app.transition_ai_suggestion((v_row ->> 'suggestion_id')::uuid, 'Proposed', 'Confirmed',
      'Kept when the itinerary intake was applied.');
    perform app.transition_ai_suggestion((v_row ->> 'suggestion_id')::uuid, 'Confirmed', 'Applied',
      'Written by app.apply_itinerary_intake.', (v_row ->> 'id')::uuid);
  end loop;
  for v_other in
    select s.id from app.ai_suggestions s join app.ai_requests r on r.id = s.request_id
    where r.subject_table = 'app.ai_intake_batches' and r.subject_id = p_batch_id
      and s.suggestion_state = 'Proposed' and s.deleted_at is null
    order by s.created_at, s.id
  loop
    perform app.transition_ai_suggestion(v_other, 'Proposed', 'Rejected', 'Left out when the itinerary intake was applied.');
    v_rejected := v_rejected + 1;
  end loop;
  perform private.end_trusted_operation('aurora_batch_apply');
  update app.ai_intake_batches set closed_at = now() where id = p_batch_id;

  return jsonb_build_object('written', v_written, 'rejected', v_rejected);
end;
$$;

comment on function app.apply_itinerary_intake(uuid, jsonb) is 'Applies the caller''s own open Itineraries batch (B15; 42501 for anyone else or without hospitality.fulfillment.write on its project, aurora_intake_closed once closed). p_items lists 1 to 1,500 {suggestion_id, values}: each a Proposed, unexpired auroraIntakes.applyItineraries suggestion of a request about the batch, named once (aurora_intake_item_invalid otherwise). values (person_id, engagement_id, fulfillment_id, departs_at, departs_time_zone, arrives_at, arrives_time_zone, departs_from, arrives_at_place, operator_name, service_identifier, confirmation_identifier, travel_mode, price_minor, currency_code) override the proposed fields of the same path key by key; the traveler, the engagement and the instants come only from values, and the fulfillment defaults to the batch''s. The traveler is a current member of the org, engaged on the project or in its travel party; person_id, travel_mode, departs_from, departs_at, departs_time_zone, arrives_at_place and arrives_time_zone are required, with the column lengths, each refusal naming its item. A segment with a service identifier that repeats one of the items or a live segment of the same person in the org with the same departure refuses itinerary_duplicate. Inserts app.travel_segments in one transaction under their own guards (IANA zones, Travel fulfillment, same project); a database refusal names the item. Kept suggestions move Proposed, Confirmed, Applied with the segment written inside aurora_batch_apply; every other Proposed suggestion of the batch is Rejected and the batch is closed. Returns {written: [{suggestion_id, id}], rejected}. Calls no model and meters nothing.';

-- Privileges ---------------------------------------------------------------------------------------------------------------

revoke all on function private.fold_name(text) from public, anon, authenticated;
revoke all on function app.itinerary_traveler_candidates(uuid, text[]) from public, anon;
revoke all on function app.apply_itinerary_intake(uuid, jsonb) from public, anon;

grant execute on function private.fold_name(text) to service_role;
grant execute on function app.itinerary_traveler_candidates(uuid, text[]) to authenticated, service_role;
grant execute on function app.apply_itinerary_intake(uuid, jsonb) to authenticated, service_role;
