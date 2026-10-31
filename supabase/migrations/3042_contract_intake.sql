-- 3042_contract_intake.sql
-- B15 contract and rider intake (RRR-239, parity gap G-177; ADR 0154). Aurora reads up to 25 booking contracts and
-- riders into one preview grouped by act, following P3's import review, and the person books the acts they keep in one
-- step: an Artist engagement per new act at Onboarding with the contract's dates, fee and currency, and the act's
-- riders and rider lines. Section 4.4.4 stages 3 to 5 (application, offer) are not repeated: the signed contract stands
-- for the accepted offer, and engagements.create in API v1 is unchanged (ADR 0154).
--
--   * app.intake_party_candidates: for each act or party name, the org's counterparties, the people the org already
--     holds (members, people on its engagements or applications), and the project's live Artist engagements whose
--     party matches (already_booked), each with a folded-name similarity of 0.85 or more. Never a platform-wide search.
--   * app.apply_contract_intake: books the groups in one transaction under the engagement guards and plan limit,
--     writes the riders (engagement_id for a person, counterparty_id for an account, as riders_one_party and
--     rider_engagement_artist require) and their lines, marks the kept suggestions Applied, rejects the rest and
--     closes the batch. Any refusal leaves nothing behind.
-- No table, column or view is added.

-- Party candidates ---------------------------------------------------------------------------------------------------------

create or replace function private.fold_act(p_name text)
returns text
language sql
immutable
set search_path = ''
as $$
  select regexp_replace(private.fold_name(p_name), '^the ', '');
$$;

comment on function private.fold_act(text) is 'An act or party name as the contract intake compares it: private.fold_name without a leading "the".';

create or replace function app.intake_party_candidates(p_batch_id uuid, p_names text[])
returns table (
  name_index integer,
  candidate_kind text,
  candidate_id uuid,
  name text,
  similarity numeric,
  engagement_id uuid,
  already_booked boolean
)
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
     or v_batch.intake_kind <> 'Contracts and Riders'
     or not private.can_on_project(v_batch.project_id, 'opportunities.engagement.write') then
    raise exception using errcode = '42501', message = 'party candidates need your own contract intake and opportunities.engagement.write on its project';
  end if;
  if coalesce(cardinality(p_names), 0) > 100 then
    perform private.refuse('aurora_intake_item_invalid', 'Look up at most 100 names at a time.');
  end if;
  return query
    with named as (
      select n.ord::integer as idx, private.fold_act(n.name) as probe
      from unnest(p_names) with ordinality n (name, ord)
      where private.fold_act(n.name) <> ''
    ),
    booked as (
      select e.id, e.person_id, e.counterparty_id,
        coalesce(h.full_name, o.name) as party_name
      from app.engagements e
      left join app.people h on h.id = e.person_id
      left join app.counterparties c on c.id = e.counterparty_id
      left join app.organizations o on o.id = c.organization_id
      where e.project_id = v_batch.project_id and e.role_type = 'Artist' and e.deleted_at is null
        and e.engagement_state not in ('Complete', 'Canceled')
    ),
    held as (
      select m.person_id from app.memberships m
      where m.org_id = v_batch.org_id and m.deleted_at is null and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
      union
      select e.person_id from app.engagements e where e.org_id = v_batch.org_id and e.person_id is not null and e.deleted_at is null
      union
      select a.applicant_person_id from app.applications a
      where a.org_id = v_batch.org_id and a.applicant_person_id is not null and a.deleted_at is null
    ),
    candidates as (
      select 'counterparty'::text as kind, c.id, o.name as label,
        (select b.id from booked b where b.counterparty_id = c.id order by b.id limit 1) as booked_id
      from app.counterparties c join app.organizations o on o.id = c.organization_id
      where c.org_id = v_batch.org_id and c.deleted_at is null
      union all
      select 'person', h.id, h.full_name,
        (select b.id from booked b where b.person_id = h.id order by b.id limit 1)
      from held x join app.people h on h.id = x.person_id
      union all
      select 'engagement', b.id, b.party_name, b.id from booked b where b.party_name is not null
    )
    select nm.idx, c.kind, c.id, c.label,
      round(extensions.similarity(private.fold_act(c.label), nm.probe)::numeric, 3),
      c.booked_id, c.booked_id is not null
    from named nm cross join candidates c
    where extensions.similarity(private.fold_act(c.label), nm.probe) >= 0.85
    order by nm.idx, (c.kind = 'engagement') desc, extensions.similarity(private.fold_act(c.label), nm.probe) desc, c.label, c.id;
end;
$$;

comment on function app.intake_party_candidates(uuid, text[]) is 'For each act or contracting party name (at most 100) of the caller''s own Contracts and Riders batch, the candidates whose folded name (private.fold_act) has a trigram similarity of 0.85 or more: the org''s counterparties by organization name, the people the org already holds (current members, people on its engagements, applicants), and the project''s live Artist engagements by their party''s name (candidate_kind engagement). Each counterparty or person carries the live Artist engagement it already has on the project, and already_booked. Needs opportunities.engagement.write on the project (42501 otherwise). Never searches people outside the org.';

-- Applying a contract intake -----------------------------------------------------------------------------------------------

create or replace function private.intake_suggestion(p_batch_id uuid, p_suggestion_id uuid, p_operation text)
returns app.ai_suggestions
language sql
stable
security definer
set search_path = ''
as $$
  select s.* from app.ai_suggestions s join app.ai_requests r on r.id = s.request_id
  where s.id = p_suggestion_id and s.deleted_at is null and s.operation_id = p_operation
    and r.subject_table = 'app.ai_intake_batches' and r.subject_id = p_batch_id
    and s.suggestion_state = 'Proposed' and s.expires_at > now();
$$;

comment on function private.intake_suggestion(uuid, uuid, text) is 'The Proposed, unexpired suggestion of an intake batch''s request with the given operation, or no row.';

create or replace function private.intake_field(p_suggestion_id uuid, p_path text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select f.proposed_value from app.ai_suggestion_fields f
  where f.suggestion_id = p_suggestion_id and f.field_path = p_path and f.refusal is null and f.deleted_at is null;
$$;

comment on function private.intake_field(uuid, text) is 'A proposed field''s value, or null when it is NO_ANSWER or absent.';

create or replace function app.apply_contract_intake(p_batch_id uuid, p_groups jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_batch app.ai_intake_batches;
  v_payroll boolean;
  v_group jsonb;
  v_engagement jsonb;
  v_values jsonb;
  v_rider jsonb;
  v_line_values jsonb;
  v_g integer := 0;
  v_mode text;
  v_contract app.ai_suggestions;
  v_header app.ai_suggestions;
  v_line app.ai_suggestions;
  v_line_id uuid;
  v_seen uuid[] := '{}';
  v_engagement_id uuid;
  v_eng app.engagements;
  v_person uuid;
  v_counterparty uuid;
  v_rate jsonb;
  v_currency jsonb;
  v_start jsonb;
  v_end jsonb;
  v_title text;
  v_description text;
  v_quantity numeric;
  v_rider_id uuid;
  v_rider_line_id uuid;
  v_applied jsonb := '[]';
  v_books integer := 0;
  v_riders integer := 0;
  v_lines integer := 0;
  v_rejected integer := 0;
  v_other uuid;
  v_row jsonb;
  v_key text;
  v_state text;
  v_message text;
  v_hint text;
begin
  -- (a) The caller's own open Contracts and Riders batch, locked.
  select * into v_batch from app.ai_intake_batches b where b.id = p_batch_id and b.deleted_at is null for update;
  if v_batch.id is null or v_batch.created_by is distinct from private.current_person_id()
     or v_batch.intake_kind <> 'Contracts and Riders' then
    raise exception using errcode = '42501', message = 'only the person who opened a contract intake applies it';
  end if;
  if not (private.can_on_project(v_batch.project_id, 'opportunities.engagement.write')
          and private.can_on_project(v_batch.project_id, 'advancing.rider.write')) then
    raise exception using errcode = '42501', message = 'booking acts needs opportunities.engagement.write and advancing.rider.write on the project';
  end if;
  if v_batch.closed_at is not null then
    perform private.refuse('aurora_intake_closed', 'This intake is closed. Start a new one to read more files.');
  end if;
  v_payroll := private.has_capability(v_batch.org_id, 'data.restricted.read.payroll');
  if jsonb_typeof(p_groups) is distinct from 'array' or jsonb_array_length(p_groups) not between 1 and 25 then
    perform private.refuse('aurora_intake_item_invalid', 'Book between 1 and 25 acts.');
  end if;

  for v_group in select value from jsonb_array_elements(p_groups) loop
    v_g := v_g + 1;
    v_engagement := v_group -> 'engagement';
    if jsonb_typeof(v_group) <> 'object' or jsonb_typeof(v_engagement) is distinct from 'object'
       or char_length(btrim(coalesce(v_group ->> 'act_name', ''))) not between 1 and 200 then
      perform private.refuse('aurora_intake_item_invalid', format('Act %s needs a name and an engagement.', v_g));
    end if;
    v_mode := v_engagement ->> 'mode';
    v_contract := null;
    if jsonb_typeof(v_engagement -> 'contract_suggestion_id') = 'string' then
      v_contract := private.intake_suggestion(p_batch_id, (v_engagement ->> 'contract_suggestion_id')::uuid, 'aurora.applyContracts');
      if v_contract.id is null or v_contract.id = any (v_seen) then
        perform private.refuse('aurora_intake_item_invalid', format('Act %s: the contract is not a proposed contract of this intake.', v_g));
      end if;
      v_seen := v_seen || v_contract.id;
    end if;

    begin
      if v_mode = 'existing' then
        -- (b) An act already booked on the project takes its riders; no engagement is created.
        select e.* into v_eng from app.engagements e
        where e.id = nullif(v_engagement ->> 'engagement_id', '')::uuid and e.project_id = v_batch.project_id
          and e.role_type = 'Artist' and e.deleted_at is null and e.engagement_state not in ('Complete', 'Canceled');
        if v_eng.id is null then
          perform private.refuse('aurora_intake_item_invalid', format('Act %s: the engagement is not a live Artist engagement of this project.', v_g));
        end if;
        v_engagement_id := v_eng.id;
      elsif v_mode = 'new' then
        -- (c) A new act: the person's party, role and terms, the contract's dates, fee and currency (values override
        -- the proposed fields key by key; the fee is the proposed fee_minor).
        v_values := coalesce(v_engagement -> 'values', '{}'::jsonb);
        if jsonb_typeof(v_values) <> 'object' then
          perform private.refuse('aurora_intake_item_invalid', format('Act %s gives its values as an object.', v_g));
        end if;
        for v_key in select jsonb_object_keys(v_values) loop
          if not (v_key = any (array['person_id', 'counterparty_id', 'role_code', 'worker_classification', 'pay_basis',
              'arrangement', 'start_date', 'end_date', 'agreed_rate_minor', 'currency_code'])) then
            perform private.refuse('aurora_intake_item_invalid', format('Act %s cannot set %s.', v_g, v_key));
          end if;
        end loop;
        v_person := nullif(v_values ->> 'person_id', '')::uuid;
        v_counterparty := nullif(v_values ->> 'counterparty_id', '')::uuid;
        if v_person is null and v_counterparty is null then
          perform private.refuse('intake_group_party', format('Act %s needs a party: a person, an account, or both.', v_g));
        end if;
        if v_person is not null and not exists (
             select 1 from app.memberships m where m.person_id = v_person and m.org_id = v_batch.org_id and m.deleted_at is null
               and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
             union all
             select 1 from app.engagements e where e.person_id = v_person and e.org_id = v_batch.org_id and e.deleted_at is null
             union all
             select 1 from app.applications a where a.applicant_person_id = v_person and a.org_id = v_batch.org_id and a.deleted_at is null) then
          perform private.refuse('intake_group_party', format('Act %s: the person is not one of the org''s people.', v_g));
        end if;
        v_rate := case when v_values ? 'agreed_rate_minor' then v_values -> 'agreed_rate_minor'
                       when v_contract.id is not null then private.intake_field(v_contract.id, 'fee_minor') end;
        v_currency := case when v_values ? 'currency_code' then v_values -> 'currency_code'
                           when v_contract.id is not null then private.intake_field(v_contract.id, 'currency_code') end;
        v_start := case when v_values ? 'start_date' then v_values -> 'start_date'
                        when v_contract.id is not null then private.intake_field(v_contract.id, 'start_date') end;
        v_end := case when v_values ? 'end_date' then v_values -> 'end_date'
                      when v_contract.id is not null then private.intake_field(v_contract.id, 'end_date') end;
        if v_rate is not null and jsonb_typeof(v_rate) <> 'null' and not v_payroll then
          perform private.refuse('intake_fee_restricted', format('Act %s: only someone who may see pay rates sets a fee.', v_g));
        end if;
        if v_start is null or jsonb_typeof(v_start) <> 'string' then
          perform private.refuse('aurora_intake_item_invalid', format('Act %s needs a start date.', v_g));
        end if;
        insert into app.engagements (project_id, person_id, counterparty_id, role_type, role_code, worker_classification,
          pay_basis, arrangement, agreed_rate_minor, currency_code, start_date, end_date)
        values (v_batch.project_id, v_person, v_counterparty, 'Artist', v_values ->> 'role_code',
          v_values ->> 'worker_classification', nullif(v_values ->> 'pay_basis', ''), nullif(v_values ->> 'arrangement', ''),
          case when jsonb_typeof(v_rate) = 'number' then (v_rate #>> '{}')::bigint end,
          case when jsonb_typeof(v_currency) = 'string' then upper(v_currency #>> '{}') end,
          (v_start #>> '{}')::date,
          case when jsonb_typeof(v_end) = 'string' then (v_end #>> '{}')::date end)
        returning * into v_eng;
        v_engagement_id := v_eng.id;
        v_books := v_books + 1;
        if v_contract.id is not null then
          v_applied := v_applied || jsonb_build_array(jsonb_build_object('suggestion_id', v_contract.id, 'id', v_engagement_id));
        end if;
      else
        perform private.refuse('aurora_intake_item_invalid', format('Act %s: the engagement mode is new or existing.', v_g));
      end if;

      -- (d) The act's riders: a person's engagement holds them, otherwise the engagement's account does.
      if jsonb_typeof(coalesce(v_group -> 'riders', '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(v_group -> 'riders', '[]'::jsonb)) > 25 then
        perform private.refuse('aurora_intake_item_invalid', format('Act %s gives at most 25 riders as a list.', v_g));
      end if;
      for v_rider in select value from jsonb_array_elements(coalesce(v_group -> 'riders', '[]'::jsonb)) loop
        v_header := private.intake_suggestion(p_batch_id, nullif(v_rider ->> 'header_suggestion_id', '')::uuid, 'riders.create');
        if v_header.id is null or v_header.id = any (v_seen) then
          perform private.refuse('aurora_intake_item_invalid', format('Act %s: a rider is not a proposed rider of this intake.', v_g));
        end if;
        v_seen := v_seen || v_header.id;
        v_title := btrim(coalesce(nullif(v_rider ->> 'title', ''), private.intake_field(v_header.id, 'title') #>> '{}', ''));
        if char_length(v_title) not between 1 and 200 then
          perform private.refuse('aurora_intake_item_invalid', format('Act %s: a rider needs a title of 1 to 200 characters.', v_g));
        end if;
        insert into app.riders (project_id, counterparty_id, engagement_id, title)
        values (v_batch.project_id,
          case when v_eng.person_id is null then v_eng.counterparty_id end,
          case when v_eng.person_id is not null then v_eng.id end,
          v_title)
        returning id into v_rider_id;
        v_riders := v_riders + 1;
        v_applied := v_applied || jsonb_build_array(jsonb_build_object('suggestion_id', v_header.id, 'id', v_rider_id));

        v_line_values := coalesce(v_rider -> 'line_values', '{}'::jsonb);
        if jsonb_typeof(coalesce(v_rider -> 'line_suggestion_ids', '[]'::jsonb)) <> 'array'
           or jsonb_array_length(coalesce(v_rider -> 'line_suggestion_ids', '[]'::jsonb)) > 100
           or jsonb_typeof(v_line_values) <> 'object' then
          perform private.refuse('aurora_intake_item_invalid', format('Act %s: a rider keeps at most 100 lines.', v_g));
        end if;
        for v_line_id in select (value #>> '{}')::uuid from jsonb_array_elements(coalesce(v_rider -> 'line_suggestion_ids', '[]'::jsonb)) loop
          v_line := private.intake_suggestion(p_batch_id, v_line_id, 'riderLines.create');
          if v_line.id is null or v_line.id = any (v_seen) then
            perform private.refuse('aurora_intake_item_invalid', format('Act %s: a rider line is not a proposed line of this intake.', v_g));
          end if;
          v_seen := v_seen || v_line.id;
          v_row := coalesce(v_line_values -> v_line_id::text, '{}'::jsonb);
          v_description := btrim(coalesce(
            case when v_row ? 'description' then v_row ->> 'description' else private.intake_field(v_line.id, 'description') #>> '{}' end, ''));
          if char_length(v_description) not between 1 and 500 then
            perform private.refuse('aurora_intake_item_invalid', format('Act %s: a rider line needs a description of 1 to 500 characters.', v_g));
          end if;
          v_quantity := (case when v_row ? 'quantity' then v_row -> 'quantity' else private.intake_field(v_line.id, 'quantity') end) #>> '{}';
          if v_quantity is not null and v_quantity < 0 then
            perform private.refuse('aurora_intake_item_invalid', format('Act %s: a rider line quantity is not negative.', v_g));
          end if;
          insert into app.rider_lines (rider_id, description, quantity) values (v_rider_id, v_description, v_quantity)
          returning id into v_rider_line_id;
          v_lines := v_lines + 1;
          v_applied := v_applied || jsonb_build_array(jsonb_build_object('suggestion_id', v_line.id, 'id', v_rider_line_id));
        end loop;
      end loop;
    exception when others then
      get stacked diagnostics v_state = returned_sqlstate, v_message = message_text, v_hint = pg_exception_hint;
      if v_state = 'XR001' and v_message not like '%Act ' || v_g || '%' then
        -- Keep the refusal contract: message '<rule>: <sentence>' and hint '<rule>'.
        v_hint := coalesce(nullif(v_hint, ''), 'refused');
        raise exception using errcode = 'XR001', hint = v_hint,
          message = v_hint || ': Act ' || v_g || ': '
            || case when left(v_message, char_length(v_hint) + 2) = v_hint || ': '
                    then substr(v_message, char_length(v_hint) + 3) else v_message end;
      elsif v_state in ('23514', '23502', '23503', '22P02', '22003', '22007', '22008') then
        raise exception using errcode = v_state, message = 'Act ' || v_g || ': ' || v_message;
      end if;
      raise;
    end;
  end loop;

  -- (e) Kept suggestions Applied with what they wrote; every other Proposed suggestion of the batch Rejected.
  perform private.begin_trusted_operation('aurora_batch_apply');
  for v_row in select value from jsonb_array_elements(v_applied) loop
    perform app.transition_ai_suggestion((v_row ->> 'suggestion_id')::uuid, 'Proposed', 'Confirmed',
      'Kept when the contract intake was applied.');
    perform app.transition_ai_suggestion((v_row ->> 'suggestion_id')::uuid, 'Confirmed', 'Applied',
      'Written by app.apply_contract_intake.', (v_row ->> 'id')::uuid);
  end loop;
  for v_other in
    select s.id from app.ai_suggestions s join app.ai_requests r on r.id = s.request_id
    where r.subject_table = 'app.ai_intake_batches' and r.subject_id = p_batch_id
      and s.suggestion_state = 'Proposed' and s.deleted_at is null
    order by s.created_at, s.id
  loop
    perform app.transition_ai_suggestion(v_other, 'Proposed', 'Rejected', 'Left out when the contract intake was applied.');
    v_rejected := v_rejected + 1;
  end loop;
  perform private.end_trusted_operation('aurora_batch_apply');
  update app.ai_intake_batches set closed_at = now() where id = p_batch_id;

  return jsonb_build_object('applied', v_applied, 'engagements', v_books, 'riders', v_riders, 'rider_lines', v_lines,
    'rejected', v_rejected);
end;
$$;

comment on function app.apply_contract_intake(uuid, jsonb) is 'Books the acts of the caller''s own open Contracts and Riders batch in one transaction (B15, ADR 0154; 42501 for anyone else or without opportunities.engagement.write and advancing.rider.write on its project, aurora_intake_closed once closed). p_groups lists 1 to 25 {act_name, engagement: {mode new or existing, engagement_id, contract_suggestion_id, values}, riders: [{header_suggestion_id, title, line_suggestion_ids, line_values}]}. existing: a live Artist engagement of the project takes the riders. new: an Artist engagement at Onboarding with the person''s values (person_id and/or counterparty_id, at least one, else intake_group_party; a person the org already holds; role_code, worker_classification, pay_basis, arrangement) and the contract''s start_date, end_date, fee (fee_minor as agreed_rate_minor) and currency_code, values overriding the proposed fields key by key; a fee from either source without data.restricted.read.payroll refuses intake_fee_restricted. The engagement guards (XOS-ENG rules, the rate card, the active_external_engagements_per_month plan limit) apply. Each rider (at most 25 per act, 100 lines each) is written for the engagement when it names a person and for its account otherwise, with the kept riders.create and riderLines.create suggestions'' title, description and quantity. Every refusal names its act and rolls back every act. Kept suggestions move Proposed, Confirmed, Applied with the engagement, rider or rider line written inside aurora_batch_apply; every other Proposed suggestion of the batch is Rejected and the batch is closed. Returns {applied: [{suggestion_id, id}], engagements, riders, rider_lines, rejected}. Calls no model and meters nothing.';

-- Privileges ---------------------------------------------------------------------------------------------------------------

revoke all on function private.fold_act(text) from public, anon, authenticated;
revoke all on function private.intake_suggestion(uuid, uuid, text) from public, anon, authenticated;
revoke all on function private.intake_field(uuid, text) from public, anon, authenticated;
revoke all on function app.intake_party_candidates(uuid, text[]) from public, anon;
revoke all on function app.apply_contract_intake(uuid, jsonb) from public, anon;

grant execute on function private.fold_act(text) to service_role;
grant execute on function app.intake_party_candidates(uuid, text[]) to authenticated, service_role;
grant execute on function app.apply_contract_intake(uuid, jsonb) to authenticated, service_role;
