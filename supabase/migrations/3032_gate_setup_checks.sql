-- 3032_gate_setup_checks.sql
-- B14 Event types and project setup (RRR-238; parity gaps G-250 and G-266; ADR 0153 decision D3; block 3030 to 3039).
-- Setup completeness is checked in the database, beside the gate's blocking criteria: a gate of a typed project passes
-- only once every Required document type and every required field of its event type due by that gate is satisfied.
--
--   * private.project_setup_unmet lists what is missing by private.project_setup_item_met (3031), the rule
--     app.project_setup_progress also reads, without the reader filter, for the gate to read as its definer.
--   * app.pass_gate is restated from 0301, its only definition, unchanged up to the blocking-criteria refusal. Then it
--     refuses gate_documents_missing, naming the document types, and gate_fields_missing, naming the fields.
--     Recommended items never block, and a project without an event type passes and refuses exactly as before.

create or replace function private.project_setup_unmet(p_project_id uuid, p_gate integer)
returns table (item_kind text, label text, required_by_gate integer)
language sql
stable
security definer
set search_path = ''
as $$
  select 'Document'::text, dt.name, r.required_by_gate
  from app.projects p
  join app.event_type_document_requirements r on r.event_type_id = p.event_type_id and r.deleted_at is null
  join app.document_types dt on dt.id = r.document_type_id and dt.deleted_at is null
  where p.id = p_project_id and r.requirement = 'Required' and r.required_by_gate <= p_gate
    and not private.project_setup_item_met(p.id, r.document_type_id, null)
  union all
  select 'Field', d.label, f.required_by_gate
  from app.projects p
  join app.event_type_fields f on f.event_type_id = p.event_type_id and f.deleted_at is null
  join app.custom_field_definitions d on d.id = f.custom_field_definition_id and d.deleted_at is null
  where p.id = p_project_id and f.required_for_type and f.required_by_gate <= p_gate
    and not private.project_setup_item_met(p.id, null, d.id);
$$;

comment on function private.project_setup_unmet(uuid, integer) is 'What the project''s event type requires by a gate and the project lacks (G-266, ADR 0153 D3): each Required document type due at or before the gate with no live project document of the type that has a version, and each field required for the type due at or before the gate with no live value. Document types and fields that are deleted are left out. Read by app.pass_gate; the same rules as app.project_setup_progress without its reader filter.';
revoke all on function private.project_setup_unmet(uuid, integer) from public, anon, authenticated;

-- Restated from 0301_scope.sql, its only definition, with the setup checks after the blocking criteria.
create or replace function app.pass_gate(p_project_id uuid, p_expected_phase text, p_reason text)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_project app.projects;
  v_gate integer;
  v_next text;
  v_unmet text;
begin
  perform private.require_person();
  if not private.can_on_project(p_project_id, 'projects.gate.transition') then
    raise exception using errcode = '42501', message = 'projects.gate.transition is required on the project';
  end if;
  if p_reason is null or char_length(btrim(p_reason)) = 0 then
    perform private.refuse('transition_reason_required', 'Every gate transition carries a reason.');
  end if;
  select * into v_project from app.projects p where p.id = p_project_id and p.deleted_at is null for update;
  if v_project.current_phase_code is distinct from p_expected_phase then
    perform private.refuse('gate_phase_conflict',
      format('The project is in %s, not %s; reload and try again.', v_project.current_phase_code, p_expected_phase));
  end if;
  if v_project.project_state = 'Canceled' then
    perform private.refuse('project_canceled', 'A canceled project passes no gates.');
  end if;
  select ph.gate into v_gate from xpms.dim_phase ph where ph.phase_code = p_expected_phase;
  if exists (select 1 from app.project_phase_transitions t where t.project_id = p_project_id and t.gate = v_gate) then
    perform private.refuse('gate_already_passed', format('Gate %s has already been passed.', v_gate));
  end if;
  select string_agg(c.criterion_id, ', ' order by c.ordinal) into v_unmet
  from xpms.dim_gate_criterion c
  where c.gate = v_gate and c.is_blocking
    and not exists (
      select 1 from app.gate_evidence e
      where e.project_id = p_project_id and e.criterion_id = c.criterion_id
        and e.deleted_at is null and e.assertion_rank >= 1);
  if v_unmet is not null then
    perform private.refuse('gate_criteria_unmet',
      format('Gate %s needs evidence for every blocking criterion; missing: %s.', v_gate, v_unmet));
  end if;
  -- B14 (G-266, ADR 0153 D3): the event type's Required documents, then its required fields, due by this gate.
  if v_project.event_type_id is not null then
    select string_agg(u.label, ', ' order by u.required_by_gate, u.label) into v_unmet
    from private.project_setup_unmet(p_project_id, v_gate) u where u.item_kind = 'Document';
    if v_unmet is not null then
      perform private.refuse('gate_documents_missing',
        format('Gate %s needs the required documents; missing: %s.', v_gate, v_unmet));
    end if;
    select string_agg(u.label, ', ' order by u.required_by_gate, u.label) into v_unmet
    from private.project_setup_unmet(p_project_id, v_gate) u where u.item_kind = 'Field';
    if v_unmet is not null then
      perform private.refuse('gate_fields_missing',
        format('Gate %s needs the required details; missing: %s.', v_gate, v_unmet));
    end if;
  end if;
  select ph.phase_code into v_next from xpms.dim_phase ph where ph.gate = v_gate + 1;

  if v_next is not null then
    perform private.begin_trusted_operation('project_phase_transition');
    update app.projects set current_phase_code = v_next where id = p_project_id;
    perform private.end_trusted_operation('project_phase_transition');
  end if;
  insert into app.project_phase_transitions (project_id, gate, from_phase_code, to_phase_code, reason)
  values (p_project_id, v_gate, p_expected_phase, v_next, btrim(p_reason));
  return coalesce(v_next, p_expected_phase);
end;
$$;

comment on function app.pass_gate(uuid, text, text) is 'Invariant 9: passes the gate that closes the expected current phase. Compare-and-set on the expected phase; refuses while any blocking criterion of the gate lacks evidence of assertion rank 1 or more, then, for a project with an event type (B14, ADR 0153 D3), while a Required document type due by the gate has no live project document with a version (gate_documents_missing) or a field required for the type due by the gate has no value (gate_fields_missing). Recommended items never block. Gate 9 closes the last phase and leaves the project in CLS. Returns the phase the project is in afterwards.';
revoke all on function app.pass_gate(uuid, text, text) from public, anon;
grant execute on function app.pass_gate(uuid, text, text) to authenticated, service_role;
