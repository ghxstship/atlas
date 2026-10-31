-- 2755_roster_shift_editor_and_approvals.sql
-- R12 Agency staff on shifts (RRR-190), the review's repairs.
--
--   * app.save_roster_shift: Atlas's shift editor creates or edits a shift and places, moves or takes off a person of
--     an agency's roster in one transaction. Before it, the editor wrote the slot (or removed the member) and only then
--     called app.assign_roster_shift, so a refusal (roster_training_incomplete, roster_entry_not_accepted,
--     roster_shift_overlap) left a write the planner never meant. It runs as the caller (security invoker), so the
--     shift's own policies and guards decide the write exactly as for the editor's other saves, and the placement goes
--     through app.assign_roster_shift and app.unassign_roster_shift with every rule they check.
--   * Agency staff timesheets name their worker. Each function below still resolved the worker with the two-argument
--     private.worker_person_id, which never sees a roster entry; each is recreated from its only definition with the
--     three-argument resolver (2750):
--       - private.timesheet_approver_person_ids and private.timesheet_approval_requests (1140): an agency staff
--         member's submitted timesheet asks for approval with their name in the title, and they are never among its
--         approvers (invariant 18). Nor is a supervisor who punched the worker in or out on the timesheet's time:
--         app.decide_timesheet refuses them (sod_supervisor_punch, 2754), so an Inbox item or push asking them to
--         approve could never be acted on.
--       - private.apply_web_clock_rules (1321): their own web clock-in follows time.geofence_required and
--         time.rounding_minutes like everyone else's.
--       - private.bulk_my_timesheets_row (2160): they submit and recall their own timesheets from Gateway's Money,
--         Timesheets table, which already lists them (api_external.timesheets, 2751).

-- The shift editor ----------------------------------------------------------------------------------------------------------------------

create or replace function app.save_roster_shift(
  p_shift_id uuid,
  p_org_id uuid,
  p_project_id uuid,
  p_role_code text,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_time_zone text,
  p_membership_id uuid,
  p_engagement_id uuid,
  p_roster_entry_id uuid,
  p_reason text default null
)
returns uuid
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_id uuid := p_shift_id;
  v_held uuid;
begin
  if num_nonnulls(p_membership_id, p_engagement_id) > 1 or (p_roster_entry_id is not null and p_engagement_id is null) then
    -- Raised here rather than through private.refuse: the caller has no usage on schema private.
    raise exception using errcode = 'XR001', hint = 'roster_shift_worker',
      message = 'roster_shift_worker: A shift names one member, one agency or one person of an agency''s roster on its slot.';
  end if;
  if v_id is null then
    insert into app.shifts (org_id, project_id, role_code, starts_at, ends_at, time_zone, membership_id, engagement_id)
    values (p_org_id, p_project_id, p_role_code, p_starts_at, p_ends_at, p_time_zone, p_membership_id, p_engagement_id)
    returning id into v_id;
  else
    select s.roster_entry_id into v_held from app.shifts s where s.id = v_id and s.deleted_at is null for update;
    if not found then
      raise exception using errcode = '42501', message = 'the shift is not visible';
    end if;
    -- Off the roster first, so the shift is the agency's slot again before it takes a member or another agency.
    if v_held is not null and p_roster_entry_id is null then
      perform app.unassign_roster_shift(v_id, coalesce(nullif(btrim(coalesce(p_reason, '')), ''), 'Reassigned in the shift editor.'));
      v_held := null;
    end if;
    -- A shift still held through the roster keeps its worker columns; another entry of the agency takes it below.
    update app.shifts s set
      role_code = p_role_code,
      starts_at = p_starts_at,
      ends_at = p_ends_at,
      time_zone = p_time_zone,
      membership_id = case when v_held is null then p_membership_id else s.membership_id end,
      engagement_id = case when v_held is null then p_engagement_id else s.engagement_id end
    where s.id = v_id;
  end if;
  if p_roster_entry_id is not null and v_held is distinct from p_roster_entry_id then
    perform app.assign_roster_shift(v_id, p_roster_entry_id);
  end if;
  return v_id;
end;
$$;

comment on function app.save_roster_shift(uuid, uuid, uuid, text, timestamptz, timestamptz, text, uuid, uuid, uuid, text) is 'Atlas''s shift editor (R12): creates a shift (p_shift_id null) or edits its times, role and worker in one transaction. The worker is a member (p_membership_id), an agency slot (p_engagement_id) or a person of that agency''s roster on its slot (p_engagement_id with p_roster_entry_id, placed through app.assign_roster_shift); anything else refuses roster_shift_worker. A shift taken off the roster goes through app.unassign_roster_shift with p_reason first. Runs as the caller, so the shift''s policies and guards decide the write, and any refusal leaves the shift as it was. Returns the shift id.';
revoke all on function app.save_roster_shift(uuid, uuid, uuid, text, timestamptz, timestamptz, text, uuid, uuid, uuid, text) from public, anon;
grant execute on function app.save_roster_shift(uuid, uuid, uuid, text, timestamptz, timestamptz, text, uuid, uuid, uuid, text) to authenticated, service_role;

-- Approval requests (latest: 1140) ----------------------------------------------------------------------------------------------------

create or replace function private.timesheet_approver_person_ids(p_timesheet_id uuid)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select distinct m.person_id
  from app.timesheets t
  join app.memberships m on m.org_id = t.org_id and m.deleted_at is null
    and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
  where t.id = p_timesheet_id
    and private.person_capability_reach(m.person_id, t.org_id, 'crew.timesheet.approve', true) = 'organization'
    and m.person_id is distinct from t.submitted_by
    and m.person_id is distinct from private.worker_person_id(t.membership_id, t.engagement_id, t.roster_entry_id)
    -- The same Supervisor punch test app.decide_timesheet applies (sod_supervisor_punch, 2754).
    and not exists (
      select 1 from app.clock_punches c
      join app.time_entries e on e.id = c.time_entry_id
      where c.source = 'Supervisor' and c.created_by = m.person_id and e.deleted_at is null
        and e.project_id = t.project_id
        and e.membership_id is not distinct from t.membership_id and e.engagement_id is not distinct from t.engagement_id
        and e.roster_entry_id is not distinct from t.roster_entry_id
        and e.clock_in >= t.period_start::timestamptz and e.clock_in < (t.period_end + 1)::timestamptz);
$$;

comment on function private.timesheet_approver_person_ids(uuid) is 'People who may approve a timesheet org-wide now, for approval request notifications: never its submitter or its worker, member, external or agency staff member (invariant 18), nor a supervisor who punched the worker in or out on the timesheet''s time (sod_supervisor_punch, R12).';
revoke all on function private.timesheet_approver_person_ids(uuid) from public, anon, authenticated;

create or replace function private.timesheet_approval_requests()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_sheet record;
  v_person uuid;
  v_title text;
begin
  if new.from_state = 'Submitted' and new.to_state <> 'Submitted' then
    update app.notifications set archived_at = now()
    where subject_table = 'timesheets' and subject_id = new.timesheet_id
      and kind = 'approval.requested' and archived_at is null and deleted_at is null;
  end if;
  if new.to_state = 'Submitted' then
    select t.id, t.org_id, t.project_id, t.period_start, t.period_end, t.submitted_by,
      (select p.full_name from app.people p
       where p.id = private.worker_person_id(t.membership_id, t.engagement_id, t.roster_entry_id)) as worker_name,
      (select p.full_name from app.people p where p.id = t.submitted_by) as submitter_name
    into v_sheet
    from app.timesheets t where t.id = new.timesheet_id;
    v_title := format('Timesheet %s, %s to %s', coalesce(v_sheet.worker_name, ''), v_sheet.period_start, v_sheet.period_end);
    for v_person in select x from private.timesheet_approver_person_ids(new.timesheet_id) x loop
      perform private.notify(v_sheet.org_id, v_person, 'approval.requested', 'timesheets', v_sheet.id, v_sheet.project_id,
        jsonb_build_object('title', v_title, 'actorName', coalesce(v_sheet.submitter_name, ''),
          'workerName', coalesce(v_sheet.worker_name, ''), 'periodStart', v_sheet.period_start::text,
          'periodEnd', v_sheet.period_end::text));
    end loop;
  end if;
  return null;
end;
$$;

comment on function private.timesheet_approval_requests() is 'On a timesheet transition: Submitted notifies every org-wide approver except the submitter and the worker, member, external or agency staff member (approval.requested about the timesheet, named for the worker); leaving Submitted takes the open requests out of every Inbox.';
revoke all on function private.timesheet_approval_requests() from public, anon, authenticated;

-- A person's own web clock (latest: 1321) ---------------------------------------------------------------------------------------------

create or replace function private.apply_web_clock_rules()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_self boolean;
  v_rounding integer;
  v_out timestamptz;
begin
  if new.source <> 'Web' or new.deleted_at is not null then
    return new;
  end if;
  v_self := private.current_person_id() is not null
    and private.worker_person_id(new.membership_id, new.engagement_id, new.roster_entry_id) = private.current_person_id();
  if not v_self then
    return new;
  end if;
  v_rounding := coalesce(nullif(private.project_setting_text(new.project_id, 'time.rounding_minutes'), '')::integer, 0);
  if tg_op = 'INSERT' and new.clock_out is null then
    perform private.refuse_clock_in_geofence(private.project_clock_in_geofence(new.project_id, null, null, null));
    new.clock_in := private.round_punch_time(new.clock_in, v_rounding);
  elsif tg_op = 'UPDATE' and old.clock_out is null and new.clock_out is not null then
    v_out := private.round_punch_time(new.clock_out, v_rounding);
    new.clock_out := case when v_out <= new.clock_in then new.clock_out else v_out end;
  end if;
  return new;
end;
$$;

comment on function private.apply_web_clock_rules() is 'Time settings on a person''s own web clock-in (1321), agency staff on their roster entry included (R12): time.geofence_required refuses it while the project''s venue has a geofence (the web carries no location), and time.rounding_minutes rounds its clock-in and clock-out. Supervisor and completed manual entries keep their times.';
revoke all on function private.apply_web_clock_rules() from public, anon, authenticated;

-- Gateway bulk actions on one's own timesheets (latest: 2160) -------------------------------------------------------------------------

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
  if v_old.id is null
     or not (
       (v_old.engagement_id is not null
        and exists (select 1 from private.engagement_scope(v_old.engagement_id) a where a = 'operational')
        and private.worker_person_id(null, v_old.engagement_id, null) is not distinct from v_person)
       or (v_old.roster_entry_id is not null
        and v_old.roster_entry_id in (select private.my_roster_entry_ids('operational')))) then
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

comment on function private.bulk_my_timesheets_row(uuid, jsonb, jsonb, text) is 'One of the person''s own timesheets in a Gateway bulk action, through their engagement or their roster entry (R12): submit a drafted or rejected one through app.submit_timesheet, or recall one they submitted while it is still Submitted (back to Proposed, which is how a submit is undone). Rows outside the person''s open operational area read as not found.';
revoke all on function private.bulk_my_timesheets_row(uuid, jsonb, jsonb, text) from public, anon, authenticated;
