-- 2830_drafted_lists.sql
-- P6 Aurora drafts a run of show and a risk assessment into an empty list (RRR-220, parity gap G-83; Section 4.7,
-- ADR 0051). Drafting proposes one suggestion per line (cues.create or records.create) on a drafting request whose
-- subject is the list it fills: a running order (app.run_of_show) or a project's risks (app.projects). The person
-- confirms the lines they keep as a whole, and only while the list is still empty.
--
--   * app.drafted_list_is_empty     whether the list has no entry yet, for a caller who may write to it
--   * app.apply_drafted_list        writes the kept lines in one transaction, marks them Applied and rejects the rest
--   * app.transition_ai_suggestion  (from 0650) refuses confirming a drafted-list line one at a time
--
-- Drafting requests whose subject_table is app.run_of_show or app.projects are reserved for drafted lists: the
-- transition guard keys on them. No table, column, view or foreign key is added; drafted cues and Risk records are
-- ordinary rows, already in Trash (ADR 0110) and covered by their tables' policies.
-- 2831 to 2839 are reserved and unused.

-- Emptiness -----------------------------------------------------------------------------------------------------------

create or replace function app.drafted_list_is_empty(p_kind text, p_target_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid;
begin
  if p_kind = 'run_of_show' then
    select r.org_id into v_org from app.run_of_show r
    where r.id = p_target_id and r.deleted_at is null
      and r.project_id in (select private.project_ids_with('show.run_of_show.write'));
    if v_org is null or not private.is_member(v_org) then
      raise exception using errcode = '42501', message = 'drafting a run of show needs show.run_of_show.write on its project in your org';
    end if;
    return not exists (select 1 from app.cues c where c.run_of_show_id = p_target_id and c.deleted_at is null);
  elsif p_kind = 'risk_assessment' then
    select p.org_id into v_org from app.projects p
    where p.id = p_target_id and p.deleted_at is null
      and p.id in (select private.project_ids_with('work.record.write'));
    if v_org is null or not private.is_member(v_org) then
      raise exception using errcode = '42501', message = 'drafting a risk assessment needs work.record.write on the project in your org';
    end if;
    return not exists (
      select 1 from app.records rec
      where rec.project_id = p_target_id and rec.record_kind = 'Risk' and rec.deleted_at is null);
  end if;
  perform private.refuse('aurora_draft_kind', 'Aurora drafts only a run of show or a risk assessment into a list.');
  return null;
end;
$$;

comment on function app.drafted_list_is_empty(text, uuid) is 'Whether a list Aurora may draft into has no entry yet. run_of_show: the running order is live, its project is in private.project_ids_with(''show.run_of_show.write'') and its org is one the caller is a member of; it is empty while no cue has deleted_at null. risk_assessment: the same for the project with work.record.write; it is empty while no Risk record has deleted_at null, in any record state, Canceled and archived included (Canceled records are retained and can never be trashed). Otherwise 42501. Definer, so it counts entries the caller cannot see, and returns only the boolean. Any other kind refuses aurora_draft_kind.';

-- Applying a drafted list ---------------------------------------------------------------------------------------------

create or replace function app.apply_drafted_list(p_request_id uuid, p_items jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_request app.ai_requests;
  v_kind text;
  v_operation text;
  v_max integer;
  v_keys text[];
  v_target_org uuid;
  v_project uuid;
  v_item jsonb;
  v_values jsonb;
  v_key text;
  v_line integer := 0;
  v_suggestion app.ai_suggestions;
  v_suggestion_id uuid;
  v_seen uuid[] := '{}';
  v_rows jsonb := '[]';
  v_row jsonb;
  v_value jsonb;
  v_id uuid;
  v_written jsonb := '[]';
  v_rejected integer := 0;
  v_other uuid;
  v_text text;
  v_state text;
  v_message text;
  v_hint text;
begin
  -- (a) The caller's own answered drafting request about a list.
  select * into v_request from app.ai_requests r where r.id = p_request_id and r.deleted_at is null;
  if v_request.id is null or v_request.person_id is distinct from private.current_person_id() then
    raise exception using errcode = '42501', message = 'only the person who asked confirms a drafted list';
  end if;
  if v_request.feature <> 'drafting' or v_request.outcome <> 'Answered' or v_request.subject_id is null
     or v_request.subject_table not in ('app.run_of_show', 'app.projects') then
    perform private.refuse('aurora_draft_request_invalid', 'This request did not draft a run of show or a risk assessment.');
  end if;
  if v_request.subject_table = 'app.run_of_show' then
    v_kind := 'run_of_show';
    v_operation := 'cues.create';
    v_max := 60;
    v_keys := array['label', 'planned_at', 'duration', 'segment', 'description'];
  else
    v_kind := 'risk_assessment';
    v_operation := 'records.create';
    v_max := 40;
    v_keys := array['record_subtype', 'title', 'risk.likelihood', 'risk.impact', 'risk.mitigation'];
  end if;

  -- (b) Lock the list's parent row. Every cue or record insert takes FOR KEY SHARE on it through its foreign key,
  -- which conflicts with FOR UPDATE: an entry added after this waits until the apply commits, and one committed
  -- earlier is seen by the emptiness check below.
  if v_kind = 'run_of_show' then
    select r.org_id, r.project_id into v_target_org, v_project
    from app.run_of_show r where r.id = v_request.subject_id and r.deleted_at is null for update;
  else
    select p.org_id, p.id into v_target_org, v_project
    from app.projects p where p.id = v_request.subject_id and p.deleted_at is null for update;
  end if;
  if v_target_org is null then
    raise exception using errcode = '42501', message = 'the list this request drafted is not available';
  end if;
  if v_target_org is distinct from v_request.org_id then
    perform private.refuse('aurora_draft_request_invalid', 'This request was made in another org than the list it drafted.');
  end if;

  -- (c) Still empty, for a caller who may still write to it (the function repeats the capability check).
  if not app.drafted_list_is_empty(v_kind, v_request.subject_id) then
    if v_kind = 'run_of_show' then
      perform private.refuse('aurora_draft_list_not_empty', 'This running order already has cues. Aurora only drafts into an empty list.');
    end if;
    perform private.refuse('aurora_draft_list_not_empty', 'This list already has entries, including archived or canceled ones. Aurora only drafts into an empty list.');
  end if;

  -- (d) Every line names a Proposed suggestion of this request once, with values for the kind's fields only.
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) < 1 or jsonb_array_length(p_items) > v_max then
    perform private.refuse('aurora_draft_item_invalid', format('Add between 1 and %s lines.', v_max));
  end if;
  for v_item in select value from jsonb_array_elements(p_items) loop
    v_line := v_line + 1;
    if jsonb_typeof(v_item) <> 'object' or jsonb_typeof(v_item -> 'suggestion_id') is distinct from 'string'
       or (v_item ->> 'suggestion_id') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
      perform private.refuse('aurora_draft_item_invalid', format('Line %s does not name a suggestion.', v_line));
    end if;
    v_suggestion_id := (v_item ->> 'suggestion_id')::uuid;
    select * into v_suggestion from app.ai_suggestions s where s.id = v_suggestion_id and s.deleted_at is null;
    if v_suggestion.id is null or v_suggestion.request_id <> p_request_id then
      perform private.refuse('aurora_draft_item_invalid', format('Line %s is not part of this draft.', v_line));
    end if;
    if v_suggestion_id = any (v_seen) then
      perform private.refuse('aurora_draft_item_invalid', format('Line %s is listed twice.', v_line));
    end if;
    v_seen := v_seen || v_suggestion_id;
    if v_suggestion.suggestion_state <> 'Proposed' then
      perform private.refuse('aurora_draft_item_invalid', format('Line %s is no longer proposed.', v_line));
    end if;
    if v_suggestion.expires_at <= now() then
      perform private.refuse('aurora_draft_item_invalid', format('Line %s has expired. Ask Aurora for a fresh draft.', v_line));
    end if;
    if v_suggestion.operation_id <> v_operation then
      perform private.refuse('aurora_draft_item_invalid', format('Line %s is not a line of this list.', v_line));
    end if;
    v_values := coalesce(v_item -> 'values', '{}'::jsonb);
    if jsonb_typeof(v_values) <> 'object' then
      perform private.refuse('aurora_draft_item_invalid', format('Line %s gives its values as an object.', v_line));
    end if;
    for v_key in select jsonb_object_keys(v_values) loop
      if not (v_key = any (v_keys)) then
        perform private.refuse('aurora_draft_item_invalid', format('Line %s cannot set %s.', v_line, v_key));
      end if;
    end loop;
    -- A value given overrides the proposed one key by key; a key left out keeps the proposal, and a NO_ANSWER
    -- field stays null unless a value is given.
    v_row := jsonb_build_object('suggestion_id', v_suggestion_id);
    foreach v_key in array v_keys loop
      if v_values ? v_key then
        v_value := v_values -> v_key;
      else
        select f.proposed_value into v_value from app.ai_suggestion_fields f
        where f.suggestion_id = v_suggestion_id and f.field_path = v_key and f.refusal is null and f.deleted_at is null;
      end if;
      v_row := v_row || jsonb_build_object(v_key, coalesce(v_value, 'null'::jsonb));
      v_value := null;
    end loop;
    if v_kind = 'run_of_show' then
      if jsonb_typeof(v_row -> 'label') is distinct from 'string' then
        perform private.refuse('aurora_draft_item_invalid', format('Line %s needs a label.', v_line));
      end if;
      foreach v_key in array array['planned_at', 'duration', 'segment', 'description'] loop
        if jsonb_typeof(v_row -> v_key) not in ('string', 'null') then
          perform private.refuse('aurora_draft_item_invalid', format('Line %s gives %s as text.', v_line, v_key));
        end if;
      end loop;
      if jsonb_typeof(v_row -> 'duration') = 'string' then
        if (v_row ->> 'duration') !~ '^\d{2}:[0-5]\d:[0-5]\d$' then
          perform private.refuse('aurora_draft_item_invalid', format('Line %s: a duration is HH:MM:SS, up to 24 hours.', v_line));
        end if;
        if (v_row ->> 'duration')::interval > interval '24 hours' then
          perform private.refuse('aurora_draft_item_invalid', format('Line %s: a duration is HH:MM:SS, up to 24 hours.', v_line));
        end if;
      end if;
    else
      if jsonb_typeof(v_row -> 'title') is distinct from 'string' then
        perform private.refuse('aurora_draft_item_invalid', format('Line %s needs a title.', v_line));
      end if;
      if jsonb_typeof(v_row -> 'record_subtype') is distinct from 'string'
         or not exists (select 1 from xpms.dim_record_subtype st
                        where st.record_kind = 'Risk' and st.record_subtype = (v_row ->> 'record_subtype')) then
        perform private.refuse('aurora_draft_item_invalid', format('Line %s: the category is not a Risk category.', v_line));
      end if;
      foreach v_key in array array['risk.likelihood', 'risk.impact'] loop
        if jsonb_typeof(v_row -> v_key) not in ('number', 'null') then
          perform private.refuse('aurora_draft_item_invalid', format('Line %s gives %s as a number.', v_line, v_key));
        end if;
      end loop;
      -- app.record_risk has no length rule on mitigation, so the list checks it here.
      v_text := case when jsonb_typeof(v_row -> 'risk.mitigation') = 'string' then btrim(v_row ->> 'risk.mitigation') else '' end;
      if char_length(v_text) not between 1 and 2000 then
        perform private.refuse('aurora_draft_item_invalid', format('Line %s needs a mitigation of 1 to 2,000 characters.', v_line));
      end if;
    end if;
    v_rows := v_rows || jsonb_build_array(v_row);
  end loop;

  -- (e) Inserts in the given order. A database refusal on a line names the line and rolls back the whole call.
  v_line := 0;
  for v_row in select value from jsonb_array_elements(v_rows) loop
    v_line := v_line + 1;
    begin
      if v_kind = 'run_of_show' then
        insert into app.cues (org_id, run_of_show_id, position, label, planned_at, duration, segment, description)
        values (v_target_org, v_request.subject_id, v_line, btrim(v_row ->> 'label'),
          (v_row ->> 'planned_at')::timestamptz, (v_row ->> 'duration')::interval,
          nullif(btrim(v_row ->> 'segment'), ''), nullif(btrim(v_row ->> 'description'), ''))
        returning id into v_id;
      else
        insert into app.records (org_id, project_id, record_kind, record_subtype, title, xyz, xyz_basis,
          phase_code, scope_node_id, owner_party_id)
        values (v_target_org, v_project, 'Risk', v_row ->> 'record_subtype', btrim(v_row ->> 'title'), 'Z', 'Declared',
          null, null, null)
        returning id into v_id;
        insert into app.record_risk (record_id, likelihood, impact, mitigation)
        values (v_id, (v_row ->> 'risk.likelihood')::smallint, (v_row ->> 'risk.impact')::smallint,
          btrim(v_row ->> 'risk.mitigation'));
      end if;
    exception when others then
      get stacked diagnostics v_state = returned_sqlstate, v_message = message_text, v_hint = pg_exception_hint;
      if v_state = 'XR001' then
        -- Keep the refusal contract: message '<rule>: <sentence>' and hint '<rule>'.
        v_hint := coalesce(nullif(v_hint, ''), 'refused');
        raise exception using errcode = 'XR001', hint = v_hint,
          message = v_hint || ': Line ' || v_line || ': '
            || case when left(v_message, char_length(v_hint) + 2) = v_hint || ': '
                    then substr(v_message, char_length(v_hint) + 3) else v_message end;
      elsif v_state in ('23514', '23502', '22P02', '22003', '22007', '22008') then
        raise exception using errcode = v_state, message = 'Line ' || v_line || ': ' || v_message;
      end if;
      raise;
    end;
    v_written := v_written || jsonb_build_array(jsonb_build_object('suggestion_id', v_row ->> 'suggestion_id', 'id', v_id));
  end loop;

  -- (f) Every kept line Proposed, Confirmed, Applied with the row it wrote; every other Proposed line Rejected.
  perform private.begin_trusted_operation('drafted_list_apply');
  for v_row in select value from jsonb_array_elements(v_written) loop
    perform app.transition_ai_suggestion((v_row ->> 'suggestion_id')::uuid, 'Proposed', 'Confirmed',
      'Kept when the drafted list was confirmed.');
    perform app.transition_ai_suggestion((v_row ->> 'suggestion_id')::uuid, 'Confirmed', 'Applied',
      'Written by app.apply_drafted_list.', (v_row ->> 'id')::uuid);
  end loop;
  for v_other in
    select s.id from app.ai_suggestions s
    where s.request_id = p_request_id and s.suggestion_state = 'Proposed' and s.deleted_at is null
    order by s.created_at, s.id
  loop
    perform app.transition_ai_suggestion(v_other, 'Proposed', 'Rejected', 'Left out when the drafted list was confirmed.');
    v_rejected := v_rejected + 1;
  end loop;
  perform private.end_trusted_operation('drafted_list_apply');

  -- (g)
  return jsonb_build_object('written', v_written, 'rejected', v_rejected);
end;
$$;

comment on function app.apply_drafted_list(uuid, jsonb) is 'Confirms a list Aurora drafted (P6): the caller''s own Answered drafting request about a running order (app.run_of_show) or a project''s risks (app.projects), in the list''s org. Locks the list''s parent row FOR UPDATE, so no cue or record can be added while it runs, and refuses aurora_draft_list_not_empty unless the list is still empty. p_items lists 1 to 60 cues or 1 to 40 risks as {suggestion_id, values}, each a Proposed, unexpired suggestion of the request named once; values override the proposed fields key by key (cues: label, planned_at, duration, segment, description; risks: record_subtype, title, risk.likelihood, risk.impact, risk.mitigation). Writes cues numbered 1..n or Risk records (xyz Z Declared) with their app.record_risk row; a database refusal names the line and rolls back the whole call. Every kept suggestion moves Proposed, Confirmed, Applied with the row written; every other Proposed suggestion of the request is Rejected. Returns {written: [{suggestion_id, id}], rejected}. Calls no model and meters nothing.';

-- Suggestion transitions ----------------------------------------------------------------------------------------------
-- From 0650 (no later redefinition), with one rule added: a drafted-list line is confirmed only by
-- app.apply_drafted_list, so it can never be added one at a time into a list that is no longer empty.

create or replace function app.transition_ai_suggestion(
  p_suggestion_id uuid,
  p_expected app.ai_suggestion_state,
  p_next app.ai_suggestion_state,
  p_reason text,
  p_applied_id uuid default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_suggestion app.ai_suggestions;
  v_entry uuid;
begin
  select * into v_suggestion from app.ai_suggestions s where s.id = p_suggestion_id and s.deleted_at is null;
  if v_suggestion.id is null or not private.ai_request_is_mine(v_suggestion.request_id) then
    raise exception using errcode = '42501', message = 'only the person who asked decides on a suggestion';
  end if;
  if p_next = 'Expired' then
    perform private.refuse('ai_suggestion_expiry_system', 'Suggestions expire on their own; reject it instead.');
  end if;
  if p_next = 'Confirmed' and not private.in_trusted_operation('drafted_list_apply') and exists (
       select 1 from app.ai_requests r
       where r.id = v_suggestion.request_id and r.feature = 'drafting'
         and r.subject_table in ('app.run_of_show', 'app.projects')) then
    perform private.refuse('ai_suggestion_drafted_list', 'Confirm a drafted list as a whole so it only fills an empty list.');
  end if;
  if p_next = 'Confirmed' and v_suggestion.expires_at <= now() then
    perform private.refuse('ai_suggestion_expired', 'This suggestion has expired. Ask again to get a fresh one.');
  end if;
  if (p_next = 'Applied') <> (p_applied_id is not null) then
    perform private.refuse('ai_suggestion_applied_id', 'An applied suggestion names the record the API wrote, and only then.');
  end if;

  v_entry := private.transition_lifecycle('ai_suggestion', 'app.ai_suggestions', 'suggestion_state',
    'app.ai_suggestion_state_transitions', 'suggestion_id', p_suggestion_id, p_expected::text, p_next::text, p_reason);
  if p_next = 'Applied' then
    perform private.begin_trusted_operation('ai_suggestion_transition');
    update app.ai_suggestions set applied_id = p_applied_id where id = p_suggestion_id;
    perform private.end_trusted_operation('ai_suggestion_transition');
  end if;
  if p_next in ('Confirmed', 'Applied', 'Rejected') then
    perform private.emit_event(v_suggestion.org_id, 'ai_suggestion.' || lower(p_next::text), 'ai_suggestions',
      p_suggestion_id, null, jsonb_build_object('operation_id', v_suggestion.operation_id));
  end if;
  return v_entry;
end;
$$;

comment on function app.transition_ai_suggestion(uuid, app.ai_suggestion_state, app.ai_suggestion_state, text, uuid) is 'Moves a suggestion with compare-and-set: the person who asked confirms or rejects it, marks it Applied with the record the public API wrote, or returns it to Proposed when the API refused the write. Expiry belongs to private.expire_ai_suggestions. A drafted-list line (a drafting request about app.run_of_show or app.projects) is confirmed only by app.apply_drafted_list, refused ai_suggestion_drafted_list otherwise; rejecting it stays allowed.';

-- Comments ----------------------------------------------------------------------------------------------------------------

comment on column app.ai_settings.drafting_enabled is 'Drafting of SOPs, advance packets, emails, day sheets, change order descriptions, running orders and risk assessments.';
comment on column app.ai_suggestions.operation_id is 'Public API operation that performs the change, for example records.create or savedViews.create. A drafted list''s suggestions (drafting requests about app.run_of_show or app.projects) are applied together by app.apply_drafted_list.';

-- Privileges --------------------------------------------------------------------------------------------------------------

revoke all on function app.drafted_list_is_empty(text, uuid) from public, anon;
revoke all on function app.apply_drafted_list(uuid, jsonb) from public, anon;
revoke all on function app.transition_ai_suggestion(uuid, app.ai_suggestion_state, app.ai_suggestion_state, text, uuid) from public, anon;

grant execute on function app.drafted_list_is_empty(text, uuid) to authenticated, service_role;
grant execute on function app.apply_drafted_list(uuid, jsonb) to authenticated, service_role;
grant execute on function app.transition_ai_suggestion(uuid, app.ai_suggestion_state, app.ai_suggestion_state, text, uuid) to authenticated, service_role;
