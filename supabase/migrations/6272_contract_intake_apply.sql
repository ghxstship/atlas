-- 3042_contract_intake_apply.sql
-- B15 contracts and riders into Artist bookings (RRR-239, parity gap G-177; ADR 0154). Extraction proposes one
-- engagements.createFromContract suggestion per document on a request about the project; the review groups them by act,
-- and the person chooses the party and the terms. Aurora never creates a person, account or counterparty. No table,
-- column or view is added: engagements enter at Onboarding under their own triggers, so private.engagement_compliance,
-- the rate card and the Active gate apply unchanged.
--
--   * app.contract_intake_options: the org's live counterparties and the people on the project, with any live Artist
--     engagement each already has, and the non-employee rate card rows the terms step offers.
--   * app.apply_contract_intake: books or attaches each group in one transaction.

create or replace function app.contract_intake_options(p_project_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid;
begin
  select p.org_id into v_org from app.projects p where p.id = p_project_id and p.deleted_at is null;
  if v_org is null or not private.is_member(v_org) or not private.can_on_project(p_project_id, 'opportunities.engagement.write') then
    raise exception using errcode = '42501', message = 'contract intake needs opportunities.engagement.write on the project in your org';
  end if;
  return jsonb_build_object(
    'parties', coalesce((
      select jsonb_agg(jsonb_build_object('kind', x.kind, 'id', x.id, 'name', x.name, 'engagement_ids', x.engagement_ids)
        order by x.name, x.id)
      from (
        select 'counterparty'::text as kind, c.id, o.name,
          coalesce((select jsonb_agg(e.id order by e.id) from app.engagements e
            where e.project_id = p_project_id and e.counterparty_id = c.id and e.role_type = 'Artist' and e.deleted_at is null
              and e.engagement_state not in ('Complete', 'Canceled')), '[]'::jsonb) as engagement_ids
        from app.counterparties c join app.organizations o on o.id = c.organization_id
        where c.org_id = v_org and c.deleted_at is null
        union all
        select 'person', n.person_id, n.full_name,
          coalesce((select jsonb_agg(e.id order by e.id) from app.engagements e
            where e.project_id = p_project_id and e.person_id = n.person_id and e.role_type = 'Artist' and e.deleted_at is null
              and e.engagement_state not in ('Complete', 'Canceled')), '[]'::jsonb)
        from app.person_names(array(select s.person_id from private.project_people(p_project_id) s)) n
      ) x), '[]'::jsonb),
    'rate_cards', coalesce((
      select jsonb_agg(jsonb_build_object('role_code', rc.role_code, 'role_name', r.job_title,
          'worker_classification', rc.worker_classification, 'worker_classification_label', wc.label,
          'pay_basis', rc.pay_basis, 'arrangement', rc.arrangement)
        order by r.job_title, wc.label, rc.pay_basis, rc.arrangement)
      from xpms.rate_card rc
      join xpms.role r on r.role_code = rc.role_code
      join xpms.worker_classification wc on wc.code = rc.worker_classification
      where not wc.is_employee), '[]'::jsonb));
end;
$$;

comment on function app.contract_intake_options(uuid) is 'What a contract review offers (B15, ADR 0154): parties, the org''s live counterparties by organization name and the people on the project (private.project_people, named through app.person_names), each with the ids of its live Artist engagements on the project; and rate_cards, the canon rate card rows with a non-employee classification, since intake takes no employment or FLSA status (XOS-ENG-2). Needs opportunities.engagement.write on the project and membership in its org, otherwise 42501.';

create or replace function app.apply_contract_intake(p_project_id uuid, p_items jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_keys constant text[] := array['suggestion_ids', 'party', 'engagement_id', 'role_code', 'worker_classification', 'pay_basis',
    'arrangement', 'start_date', 'end_date', 'agreed_rate_minor', 'currency_code', 'create_riders'];
  v_org uuid;
  v_payroll boolean;
  v_can_riders boolean;
  v_item jsonb;
  v_party jsonb;
  v_key text;
  v_line integer := 0;
  v_seen uuid[] := '{}';
  v_suggestion_id uuid;
  v_suggestion app.ai_suggestions;
  v_request app.ai_requests;
  v_person uuid;
  v_counterparty uuid;
  v_engagement_id uuid;
  v_engagement app.engagements;
  v_given uuid;
  v_live integer;
  v_created boolean;
  v_type text;
  v_title text;
  v_doc uuid;
  v_rider uuid;
  v_docs jsonb;
  v_create_riders boolean;
  v_engagements jsonb := '[]';
  v_riders integer := 0;
  v_applied jsonb := '[]';
  v_row jsonb;
  v_state text;
  v_message text;
  v_hint text;
begin
  select p.org_id into v_org from app.projects p where p.id = p_project_id and p.deleted_at is null;
  if v_org is null or not private.is_member(v_org) or not private.can_on_project(p_project_id, 'opportunities.engagement.write') then
    raise exception using errcode = '42501', message = 'booking from a contract needs opportunities.engagement.write on the project in your org';
  end if;
  v_payroll := private.has_capability(v_org, 'data.restricted.read.payroll');
  v_can_riders := private.can_on_project(p_project_id, 'advancing.rider.write');
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) not between 1 and 50 then
    perform private.refuse('aurora_intake_item_invalid', 'Add between 1 and 50 bookings.');
  end if;

  for v_item in select value from jsonb_array_elements(p_items) loop
    v_line := v_line + 1;
    begin
      if jsonb_typeof(v_item) <> 'object' or jsonb_typeof(v_item -> 'suggestion_ids') is distinct from 'array'
         or jsonb_array_length(v_item -> 'suggestion_ids') = 0 then
        perform private.refuse('aurora_intake_item_invalid', 'It names no documents.');
      end if;
      for v_key in select jsonb_object_keys(v_item) loop
        if not (v_key = any (v_keys)) then
          perform private.refuse('aurora_intake_item_invalid', format('It cannot set %s.', v_key));
        end if;
      end loop;

      -- Each document is the caller's own proposal read for this project, named once in the call.
      for v_suggestion_id in select (value #>> '{}')::uuid from jsonb_array_elements(v_item -> 'suggestion_ids') loop
        select * into v_suggestion from app.ai_suggestions s where s.id = v_suggestion_id and s.deleted_at is null;
        if v_suggestion.id is null or not private.ai_request_is_mine(v_suggestion.request_id) then
          raise exception using errcode = '42501', message = 'only the person who asked adds these bookings';
        end if;
        select * into v_request from app.ai_requests r where r.id = v_suggestion.request_id;
        if v_request.feature <> 'extraction' or v_request.outcome <> 'Answered' or v_request.subject_table is distinct from 'app.projects'
           or v_request.subject_id is distinct from p_project_id or v_request.org_id is distinct from v_org
           or v_suggestion.operation_id <> 'engagements.createFromContract' then
          perform private.refuse('aurora_intake_item_invalid', 'A document was not read for this project.');
        end if;
        if v_suggestion_id = any (v_seen) then
          perform private.refuse('aurora_intake_item_invalid', 'A document is listed twice.');
        end if;
        v_seen := v_seen || v_suggestion_id;
        if v_suggestion.suggestion_state <> 'Proposed' or v_suggestion.expires_at <= now() then
          perform private.refuse('aurora_intake_item_invalid', 'A document is no longer proposed. Read the file again.');
        end if;
        select f.proposed_value #>> '{}' into v_type from app.ai_suggestion_fields f
        where f.suggestion_id = v_suggestion_id and f.field_path = 'document_type' and f.refusal is null and f.deleted_at is null;
        if v_type is null or v_type not in ('Contract', 'Rider') then
          perform private.refuse('aurora_intake_item_invalid', 'Only a contract or a rider can be added.');
        end if;
      end loop;

      v_party := v_item -> 'party';
      v_person := nullif(v_party ->> 'person_id', '')::uuid;
      v_counterparty := nullif(v_party ->> 'counterparty_id', '')::uuid;
      if num_nonnulls(v_person, v_counterparty) <> 1 then
        perform private.refuse('aurora_intake_item_invalid', 'Choose one party: a person or a counterparty.');
      end if;
      if v_person is not null and not exists (select 1 from private.project_people(p_project_id) s where s.person_id = v_person) then
        perform private.refuse('aurora_intake_item_invalid', 'The person is not on this project.');
      end if;
      if v_counterparty is not null and not exists (
           select 1 from app.counterparties c where c.id = v_counterparty and c.org_id = v_org and c.deleted_at is null) then
        perform private.refuse('aurora_intake_item_invalid', 'The counterparty is not one of this org''s.');
      end if;
      if (v_item ->> 'agreed_rate_minor') is not null and not v_payroll then
        perform private.refuse('aurora_fee_restricted', 'Only someone who may read pay sets a fee.');
      end if;
      v_create_riders := coalesce((v_item ->> 'create_riders')::boolean, false);
      if v_create_riders and not v_can_riders then
        raise exception using errcode = '42501', message = 'adding a rider needs advancing.rider.write on the project';
      end if;

      -- A named engagement, or the party's one live Artist engagement, takes the documents; the fee is then ignored.
      v_given := nullif(v_item ->> 'engagement_id', '')::uuid;
      select count(*), min(e.id::text)::uuid into v_live, v_engagement_id from app.engagements e
      where e.project_id = p_project_id and e.role_type = 'Artist' and e.deleted_at is null
        and e.engagement_state not in ('Complete', 'Canceled')
        and e.person_id is not distinct from v_person and e.counterparty_id is not distinct from v_counterparty;
      if v_given is not null then
        if not exists (
             select 1 from app.engagements e
             where e.id = v_given and e.project_id = p_project_id and e.deleted_at is null
               and e.engagement_state not in ('Complete', 'Canceled')
               and e.person_id is not distinct from v_person and e.counterparty_id is not distinct from v_counterparty) then
          perform private.refuse('aurora_intake_item_invalid', 'That engagement is not a live engagement of this party on this project.');
        end if;
        v_engagement_id := v_given;
      elsif v_live > 1 then
        perform private.refuse('aurora_intake_item_invalid', 'This party has more than one live Artist engagement here. Choose one.');
      end if;
      v_created := v_engagement_id is null;
      if v_created then
        if nullif(v_item ->> 'start_date', '') is null then
          perform private.refuse('aurora_intake_item_invalid', 'It needs a start date.');
        end if;
        insert into app.engagements (project_id, person_id, counterparty_id, role_type, role_code, worker_classification,
          pay_basis, arrangement, agreed_rate_minor, currency_code, start_date, end_date)
        values (p_project_id, v_person, v_counterparty, 'Artist', v_item ->> 'role_code', v_item ->> 'worker_classification',
          nullif(v_item ->> 'pay_basis', ''), nullif(v_item ->> 'arrangement', ''), (v_item ->> 'agreed_rate_minor')::bigint,
          nullif(upper(btrim(v_item ->> 'currency_code')), ''), (v_item ->> 'start_date')::date,
          nullif(v_item ->> 'end_date', '')::date)
        returning id into v_engagement_id;
      end if;
      select * into v_engagement from app.engagements e where e.id = v_engagement_id;

      v_docs := '[]';
      for v_suggestion_id in select (value #>> '{}')::uuid from jsonb_array_elements(v_item -> 'suggestion_ids') loop
        select f.proposed_value #>> '{}' into v_type from app.ai_suggestion_fields f
        where f.suggestion_id = v_suggestion_id and f.field_path = 'document_type' and f.refusal is null and f.deleted_at is null;
        select nullif(btrim(left(f.proposed_value #>> '{}', 200)), '') into v_title from app.ai_suggestion_fields f
        where f.suggestion_id = v_suggestion_id and f.field_path = 'title' and f.refusal is null and f.deleted_at is null;
        v_doc := null;
        if v_type = 'Contract' then
          insert into app.engagement_documents (engagement_id, document_kind, title)
          values (v_engagement_id, 'Agreement', coalesce(v_title, 'Agreement'))
          returning id into v_doc;
        elsif v_create_riders then
          insert into app.riders (project_id, counterparty_id, engagement_id, title)
          values (p_project_id,
            case when v_engagement.person_id is null then v_engagement.counterparty_id end,
            case when v_engagement.person_id is not null then v_engagement.id end,
            coalesce(v_title, 'Rider'))
          returning id into v_rider;
          v_riders := v_riders + 1;
          insert into app.engagement_documents (engagement_id, document_kind, title)
          values (v_engagement_id, 'Rider', coalesce(v_title, 'Rider'))
          returning id into v_doc;
        end if;
        v_docs := v_docs || jsonb_build_array(jsonb_build_object('suggestion_id', v_suggestion_id, 'engagement_document_id', v_doc,
          'document_type', v_type));
        v_applied := v_applied || jsonb_build_array(jsonb_build_object('suggestion_id', v_suggestion_id, 'id', v_engagement_id));
      end loop;
    exception when others then
      get stacked diagnostics v_state = returned_sqlstate, v_message = message_text, v_hint = pg_exception_hint;
      if v_state = 'XR001' then
        -- Keep the refusal contract: message '<rule>: <sentence>' and hint '<rule>'.
        v_hint := coalesce(nullif(v_hint, ''), 'refused');
        raise exception using errcode = 'XR001', hint = v_hint,
          message = v_hint || ': Line ' || v_line || ': '
            || case when left(v_message, char_length(v_hint) + 2) = v_hint || ': '
                    then substr(v_message, char_length(v_hint) + 3) else v_message end;
      elsif v_state in ('23514', '23502', '23503', '22P02', '22003', '22007', '22008') then
        raise exception using errcode = v_state, message = 'Line ' || v_line || ': ' || v_message;
      end if;
      raise;
    end;
    v_engagements := v_engagements || jsonb_build_array(jsonb_build_object('suggestion_ids', v_item -> 'suggestion_ids',
      'engagement_id', v_engagement_id, 'created', v_created, 'documents', v_docs));
  end loop;

  for v_row in select value from jsonb_array_elements(v_applied) loop
    perform app.transition_ai_suggestion((v_row ->> 'suggestion_id')::uuid, 'Proposed', 'Confirmed', 'Kept in the contract review.');
    perform app.transition_ai_suggestion((v_row ->> 'suggestion_id')::uuid, 'Confirmed', 'Applied',
      'Written by app.apply_contract_intake.', (v_row ->> 'id')::uuid);
  end loop;

  return jsonb_build_object('engagements', v_engagements, 'riders', v_riders);
end;
$$;

comment on function app.apply_contract_intake(uuid, jsonb) is 'Books the groups of a contract review in one transaction (B15, ADR 0154). Needs opportunities.engagement.write on the project and membership in its org, otherwise 42501. p_items lists 1 to 50 {suggestion_ids, party: {person_id | counterparty_id}, engagement_id, role_code, worker_classification, pay_basis, arrangement, start_date, end_date, agreed_rate_minor, currency_code, create_riders}. Each suggestion is the caller''s own (42501), Proposed and unexpired, an engagements.createFromContract suggestion of an Answered extraction request whose subject is this project in its org, named once in the call, with document_type Contract or Rider (aurora_intake_item_invalid otherwise, so an Other document cannot be applied). A person party stands on the project and a counterparty is the org''s own. A fee without data.restricted.read.payroll refuses aurora_fee_restricted. A given engagement must be a live engagement of that party on the project; a party with two live Artist engagements and none named refuses aurora_intake_item_invalid; one live Artist engagement takes the documents and the fee is ignored; with none an Artist engagement is inserted at Onboarding with the given terms, so private.engagement_compliance, the rate card foreign key (23503) and the plan limit apply, and a missing start date refuses aurora_intake_item_invalid. Each Contract becomes an engagement document of kind Agreement, state Proposed. Each Rider, with create_riders, becomes an app.riders row (for the engagement when it names a person, for its counterparty otherwise) and an engagement document of kind Rider; create_riders without advancing.rider.write raises 42501, and the rider''s lines stay with the rider panel. Every refusal names its line and rolls back the call. The suggestions move Proposed, Confirmed, Applied with the engagement. Returns {engagements: [{suggestion_ids, engagement_id, created, documents: [{suggestion_id, engagement_document_id, document_type}]}], riders}. Calls no model and meters nothing.';

revoke all on function app.contract_intake_options(uuid) from public, anon;
revoke all on function app.apply_contract_intake(uuid, jsonb) from public, anon;
grant execute on function app.contract_intake_options(uuid) to authenticated, service_role;
grant execute on function app.apply_contract_intake(uuid, jsonb) to authenticated, service_role;
