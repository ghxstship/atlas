-- 2160_gateway_bulk_actions.sql
-- A122 (RRR-166, ADR 0082; follow-up of A88's 1451). Gateway's collections act on a selection (Section 11.7): the
-- actions a row of a Gateway list already offers one at a time, on many rows in one all-or-nothing call through
-- 1451's driver, private.run_bulk. Each resource is the person's own side of a table, so its row function checks
-- the person's reach on each row the way the single action does, and then calls that action's own RPC, so every
-- rule of a single action applies in bulk too.
--
--   * my_timesheets: the engaged person submits their own drafted or rejected timesheets (app.submit_timesheet), and
--     recalls one they submitted while it still waits for approval. A recall is how undo works: undoing a submit
--     returns the timesheet to draft, never to an approver's Rejected, so the inverse row of a submit names
--     Proposed. Once an approver decided, compare-and-set refuses the undo (bulk_stale).
--   * my_engagement_documents: the engaged party signs documents sent for signature (app.sign_engagement_document,
--     which keeps its rule on who signs). A signature is final; nothing undoes it.
--   * my_applications: the applicant side withdraws open applications (app.transition_application). An offered
--     application is answered on its own (accept, decline or counter), as its row offers, so bulk withdraw refuses
--     it. A withdrawal is final.
--   * Rows the person does not reach read as not found (bulk_row_not_found), as in 1451. run_bulk writes one
--     <resource>.bulk_update audit event per org, as for every resource; the orgs already see each submission,
--     signature and withdrawal in their own records.

-- Timesheets ---------------------------------------------------------------------------------------------------------

create or replace function private.bulk_my_timesheets_row(p_id uuid, p_set jsonb, p_expect jsonb, p_reason text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_old app.timesheets;
  v_new app.timesheets;
  v_state app.timesheet_state;
begin
  perform private.bulk_check_fields(p_set, p_expect, 'timesheet_state');
  select * into v_old from app.timesheets t where t.id = p_id and t.deleted_at is null for update;
  if v_old.id is null or v_old.engagement_id is null
     or not exists (select 1 from private.engagement_scope(v_old.engagement_id) a where a = 'operational')
     or private.worker_person_id(null, v_old.engagement_id) is distinct from v_person then
    perform private.refuse('bulk_row_not_found', 'This row no longer exists or is not available to you.');
  end if;
  perform private.bulk_check_expect(to_jsonb(v_old), p_expect);
  v_state := case when p_set ? 'timesheet_state' then (p_set ->> 'timesheet_state')::app.timesheet_state else v_old.timesheet_state end;
  if v_state = v_old.timesheet_state then
    return jsonb_build_object('org_id', v_old.org_id, 'changed', false);
  end if;
  if v_state = 'Submitted' and v_old.timesheet_state in ('Proposed', 'Rejected') then
    perform app.submit_timesheet(p_id, coalesce(nullif(btrim(p_reason), ''), 'Submitted from Gateway.'));
  elsif v_state = 'Proposed' and v_old.timesheet_state = 'Submitted' then
    if v_old.submitted_by is distinct from v_person then
      perform private.refuse('timesheet_recall_not_submitter', 'Only the person who submitted this timesheet can recall it.');
    end if;
    perform private.transition_lifecycle('timesheet', 'app.timesheets', 'timesheet_state', 'app.timesheet_state_transitions',
      'timesheet_id', p_id, 'Submitted', 'Proposed', coalesce(nullif(btrim(p_reason), ''), 'Recalled from Gateway.'));
  else
    perform private.refuse('bulk_field_not_editable', 'In Gateway a timesheet is submitted, or recalled while it waits for approval.');
  end if;
  select * into v_new from app.timesheets t where t.id = p_id;
  -- A recall returns to draft, so the undo of a submit from Rejected names Proposed.
  return jsonb_build_object('org_id', v_old.org_id, 'changed', true,
    'before', jsonb_build_object('timesheet_state',
      case when v_old.timesheet_state = 'Rejected' then 'Proposed' else v_old.timesheet_state::text end),
    'after', jsonb_build_object('timesheet_state', v_new.timesheet_state));
end;
$$;

comment on function private.bulk_my_timesheets_row(uuid, jsonb, jsonb, text) is 'One of the engaged person''s own timesheets in a Gateway bulk action: submit a drafted or rejected one through app.submit_timesheet, or recall one they submitted while it is still Submitted (back to Proposed, which is how a submit is undone). Rows outside the person''s open operational area read as not found.';
revoke all on function private.bulk_my_timesheets_row(uuid, jsonb, jsonb, text) from public, anon, authenticated;

-- Engagement documents -----------------------------------------------------------------------------------------------

create or replace function private.bulk_my_engagement_documents_row(p_id uuid, p_set jsonb, p_expect jsonb, p_reason text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_old app.engagement_documents;
  v_new app.engagement_documents;
  v_state app.engagement_document_state;
begin
  perform private.require_person();
  perform private.bulk_check_fields(p_set, p_expect, 'engagement_document_state');
  select * into v_old from app.engagement_documents d where d.id = p_id and d.deleted_at is null for update;
  if v_old.id is null
     or not exists (select 1 from private.engagement_scope(v_old.engagement_id) a where a = 'documents') then
    perform private.refuse('bulk_row_not_found', 'This row no longer exists or is not available to you.');
  end if;
  perform private.bulk_check_expect(to_jsonb(v_old), p_expect);
  v_state := case when p_set ? 'engagement_document_state'
                  then (p_set ->> 'engagement_document_state')::app.engagement_document_state
                  else v_old.engagement_document_state end;
  if v_state = v_old.engagement_document_state then
    return jsonb_build_object('org_id', v_old.org_id, 'changed', false);
  end if;
  if v_state <> 'Signed' then
    perform private.refuse('bulk_field_not_editable', 'In Gateway a document is signed; a signature cannot be undone.');
  end if;
  if v_old.engagement_document_state <> 'Sent' then
    perform private.refuse('document_not_awaiting_signature', 'This document is not waiting for your signature.');
  end if;
  perform app.sign_engagement_document(p_id, coalesce(nullif(btrim(p_reason), ''), 'Signed in Gateway.'));
  select * into v_new from app.engagement_documents d where d.id = p_id;
  return jsonb_build_object('org_id', v_old.org_id, 'changed', true,
    'before', jsonb_build_object('engagement_document_state', v_old.engagement_document_state),
    'after', jsonb_build_object('engagement_document_state', v_new.engagement_document_state));
end;
$$;

comment on function private.bulk_my_engagement_documents_row(uuid, jsonb, jsonb, text) is 'One document of the person''s engagements in a Gateway bulk action: sign a document sent for signature through app.sign_engagement_document, with its rule on who signs. A signature is final. Rows outside the person''s open documents area read as not found.';
revoke all on function private.bulk_my_engagement_documents_row(uuid, jsonb, jsonb, text) from public, anon, authenticated;

-- Applications -------------------------------------------------------------------------------------------------------

create or replace function private.bulk_my_applications_row(p_id uuid, p_set jsonb, p_expect jsonb, p_reason text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_old app.applications;
  v_new app.applications;
  v_state app.application_state;
begin
  perform private.require_person();
  perform private.bulk_check_fields(p_set, p_expect, 'application_state');
  select * into v_old from app.applications a where a.id = p_id and a.deleted_at is null for update;
  if v_old.id is null or not exists (select 1 from private.my_application_ids() x where x = p_id) then
    perform private.refuse('bulk_row_not_found', 'This row no longer exists or is not available to you.');
  end if;
  perform private.bulk_check_expect(to_jsonb(v_old), p_expect);
  v_state := case when p_set ? 'application_state' then (p_set ->> 'application_state')::app.application_state
                  else v_old.application_state end;
  if v_state = v_old.application_state then
    return jsonb_build_object('org_id', v_old.org_id, 'changed', false);
  end if;
  if v_state <> 'Withdrawn' then
    perform private.refuse('bulk_field_not_editable', 'In Gateway an application is withdrawn; the organization decides the rest.');
  end if;
  if v_old.application_state = 'Offered' then
    perform private.refuse('application_offered', 'This application has an offer: accept, decline or counter it on its own.');
  end if;
  perform app.transition_application(p_id, v_old.application_state, 'Withdrawn',
    coalesce(nullif(btrim(p_reason), ''), 'Withdrawn.'));
  select * into v_new from app.applications a where a.id = p_id;
  return jsonb_build_object('org_id', v_old.org_id, 'changed', true,
    'before', jsonb_build_object('application_state', v_old.application_state),
    'after', jsonb_build_object('application_state', v_new.application_state));
end;
$$;

comment on function private.bulk_my_applications_row(uuid, jsonb, jsonb, text) is 'One of the person''s applications in a Gateway bulk action: withdraw it through app.transition_application, for the applicant side only. An offered application is answered on its own, so bulk withdraw refuses it; a withdrawal is final. Applications the person does not hold read as not found.';
revoke all on function private.bulk_my_applications_row(uuid, jsonb, jsonb, text) from public, anon, authenticated;

insert into private.bulk_resources (resource, table_name, row_function) values
  ('my_timesheets', 'app.timesheets', 'private.bulk_my_timesheets_row'),
  ('my_engagement_documents', 'app.engagement_documents', 'private.bulk_my_engagement_documents_row'),
  ('my_applications', 'app.applications', 'private.bulk_my_applications_row');

-- App RPCs -------------------------------------------------------------------------------------------------------------

create or replace function app.bulk_update_my_timesheets(p_rows jsonb, p_preview boolean default false, p_reason text default null)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  select private.run_bulk('my_timesheets', p_rows, coalesce(p_preview, false), p_reason);
$$;

comment on function app.bulk_update_my_timesheets(jsonb, boolean, text) is 'Submits the engaged person''s own timesheets in bulk in one transaction (Section 11.7, Gateway), or recalls submitted ones still waiting for approval, which is how a submit is undone. Rows as [{id, set, expect}] with timesheet_state; all or nothing, with the answer of app.bulk_update_records. p_preview checks without changing anything.';

create or replace function app.bulk_update_my_engagement_documents(p_rows jsonb, p_preview boolean default false, p_reason text default null)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  select private.run_bulk('my_engagement_documents', p_rows, coalesce(p_preview, false), p_reason);
$$;

comment on function app.bulk_update_my_engagement_documents(jsonb, boolean, text) is 'Signs documents of the person''s engagements in bulk in one transaction (Section 11.7, Gateway): rows as [{id, set: {engagement_document_state: Signed}}], every rule of a single signature applying to each. All or nothing, with the answer of app.bulk_update_records; a signature is final.';

create or replace function app.bulk_update_my_applications(p_rows jsonb, p_preview boolean default false, p_reason text default null)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  select private.run_bulk('my_applications', p_rows, coalesce(p_preview, false), p_reason);
$$;

comment on function app.bulk_update_my_applications(jsonb, boolean, text) is 'Withdraws the person''s open applications in bulk in one transaction (Section 11.7, Gateway): rows as [{id, set: {application_state: Withdrawn}}]. Offered applications are answered on their own. All or nothing, with the answer of app.bulk_update_records; a withdrawal is final.';

revoke all on function app.bulk_update_my_timesheets(jsonb, boolean, text) from public, anon;
revoke all on function app.bulk_update_my_engagement_documents(jsonb, boolean, text) from public, anon;
revoke all on function app.bulk_update_my_applications(jsonb, boolean, text) from public, anon;
grant execute on function app.bulk_update_my_timesheets(jsonb, boolean, text) to authenticated, service_role;
grant execute on function app.bulk_update_my_engagement_documents(jsonb, boolean, text) to authenticated, service_role;
grant execute on function app.bulk_update_my_applications(jsonb, boolean, text) to authenticated, service_role;
