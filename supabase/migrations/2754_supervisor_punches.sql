-- 2754_supervisor_punches.sql
-- R12 parity addition G-126 (RRR-190, competitor parity audit 2026-10-28, owner-approved): a supervisor clocks in a
-- whole team from Compass, offline too.
--
--   * app.record_supervisor_punches(batch, project, kind, device time, punches, ...): 1 to 100 punches, each
--     {punch_id, shift_id} and each in its own subtransaction, so one refused worker never fails the team. Per punch:
--     the shift is live on the project and not Canceled (supervisor_punch_project) and names a person through a worker
--     column (supervisor_punch_no_worker: an open shift or an agency slot names nobody); the caller holds
--     crew.shift.write on the project or, for a roster shift, leads its agency (R4's private.can_manage_roster),
--     else supervisor_punch_not_lead; the worker is not the caller (supervisor_punch_self); an In counts between two
--     hours before the shift starts and its end (supervisor_punch_outside_shift); a roster worker's entry is working
--     (roster_entry_not_working). Then private.apply_punch (2751) records it with source Supervisor, the shift's worker
--     and the supervisor's device time and position, so time.geofence_required applies to where the supervisor stands.
--     A replay of a punch the caller already recorded answers duplicate before any other check, so a lost answer
--     replayed after the shift was canceled or its window passed is not refused. Who punched is created_by on each app.clock_punches row; no new column.
--   * One audit event per call (time.supervisor_punches). The RPC replays offline (private.sync_rpcs), idempotent on
--     each client punch id, and has exactly one signature.
--   * Separation of duties: sod_supervisor_punch. app.decide_timesheet, recreated from 2751, refuses an approver who
--     created a Supervisor punch on the timesheet's time entries. Every approval path, bulk and the Inbox included,
--     goes through it.

insert into private.separation_of_duties_rules (code, enforced_on, description) values
  ('sod_supervisor_punch', 'Timesheets', 'A person who punched a worker in or out cannot approve the timesheet holding that time.')
on conflict (code) do nothing;

-- The team punch ---------------------------------------------------------------------------------------------------------------

create or replace function app.record_supervisor_punches(
  p_batch_id uuid,
  p_project_id uuid,
  p_punch_kind app.punch_kind,
  p_device_time timestamptz,
  p_punches jsonb,
  p_monotonic_offset_ms bigint default null,
  p_latitude numeric default null,
  p_longitude numeric default null,
  p_accuracy_m numeric default null,
  p_geofence_id uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_person();
  v_project app.projects;
  v_item jsonb;
  v_punch_id uuid;
  v_shift_id uuid;
  v_shift app.shifts;
  v_worker uuid;
  v_entry_engagement uuid;
  v_effective timestamptz;
  v_duplicate boolean;
  v_outcome text;
  v_code text;
  v_state text;
  v_results jsonb := '[]'::jsonb;
  v_punch_ids jsonb := '[]'::jsonb;
  v_applied integer := 0;
  v_refused integer := 0;
begin
  if p_batch_id is null then
    perform private.refuse('supervisor_punch_batch_required', 'A team punch carries its batch id.');
  end if;
  if p_punches is null or jsonb_typeof(p_punches) <> 'array' or jsonb_array_length(p_punches) not between 1 and 100 then
    perform private.refuse('supervisor_punch_batch', 'Punch between 1 and 100 people at a time.');
  end if;
  select * into v_project from app.projects p where p.id = p_project_id and p.deleted_at is null;
  if v_project.id is null then
    raise exception using errcode = '42501', message = 'the project is not visible';
  end if;
  if p_device_time is null then
    perform private.refuse('punch_device_time_required', 'A punch carries the device time it was made at.');
  end if;
  -- The time an In counts at, for the shift window: the device time within the 2-minute skew tolerance, as
  -- private.apply_punch counts it.
  if p_monotonic_offset_ms is not null then
    v_effective := now() - make_interval(secs => p_monotonic_offset_ms / 1000.0);
    if abs(extract(epoch from (p_device_time - v_effective))) <= 120 then
      v_effective := p_device_time;
    end if;
  elsif p_device_time > now() + interval '2 minutes' or p_device_time < now() - interval '72 hours' then
    v_effective := now();
  else
    v_effective := p_device_time;
  end if;

  for v_item in select value from jsonb_array_elements(p_punches) loop
    v_punch_id := null;
    v_shift_id := null;
    v_code := null;
    begin
      v_punch_id := (v_item ->> 'punch_id')::uuid;
      v_shift_id := (v_item ->> 'shift_id')::uuid;
      if v_punch_id is null then
        perform private.refuse('punch_id_required', 'Every punch carries its client punch id.');
      end if;
      -- A replay of a punch this supervisor already recorded answers duplicate before the shift is checked again:
      -- the answer to the first upload may have been lost, and since then the shift may have been canceled, the
      -- entry withdrawn or the In window passed.
      if exists (select 1 from app.clock_punches c
                 where c.id = v_punch_id and c.created_by = v_me and c.source = 'Supervisor'
                   and c.punch_kind = p_punch_kind and c.shift_id is not distinct from v_shift_id) then
        v_outcome := 'duplicate';
      else
        select * into v_shift from app.shifts s where s.id = v_shift_id and s.deleted_at is null;
        if v_shift.id is null or v_shift.project_id <> p_project_id or v_shift.shift_state = 'Canceled' then
          perform private.refuse('supervisor_punch_project', 'Punch the team in on live shifts of this project.');
        end if;
        v_worker := private.shift_worker_person_id(v_shift.membership_id, v_shift.engagement_id, v_shift.roster_entry_id);
        if v_worker is null then
          perform private.refuse('supervisor_punch_no_worker', 'Nobody holds this shift yet.');
        end if;
        select r.engagement_id into v_entry_engagement from app.engagement_roster_entries r where r.id = v_shift.roster_entry_id;
        if not (private.can_on_project(p_project_id, 'crew.shift.write')
                or (v_entry_engagement is not null and private.can_manage_roster(v_entry_engagement))) then
          perform private.refuse('supervisor_punch_not_lead', 'You punch in only the people you supervise.');
        end if;
        if v_worker = v_me then
          perform private.refuse('supervisor_punch_self', 'Clock yourself in from your own clock.');
        end if;
        if p_punch_kind = 'In' and (v_effective < v_shift.starts_at - interval '2 hours' or v_effective > v_shift.ends_at) then
          perform private.refuse('supervisor_punch_outside_shift', 'Punch the team in from two hours before the shift starts until it ends.');
        end if;
        if v_shift.roster_entry_id is not null and not private.roster_entry_working(v_shift.roster_entry_id) then
          perform private.refuse('roster_entry_not_working', 'Agency staff record time only while their roster entry stands and its engagement is Active or Closing.');
        end if;
        v_duplicate := exists (select 1 from app.clock_punches c where c.id = v_punch_id);
        perform private.apply_punch(v_punch_id, p_project_id, p_punch_kind, p_device_time, p_monotonic_offset_ms, v_shift.id,
          p_latitude, p_longitude, p_accuracy_m, p_geofence_id, 'Supervisor', null, null,
          v_shift.membership_id, v_shift.engagement_id, v_shift.roster_entry_id);
        v_outcome := case when v_duplicate then 'duplicate' else 'applied' end;
      end if;
    exception when sqlstate 'XR001' or sqlstate '42501' or invalid_text_representation then
      get stacked diagnostics v_code = pg_exception_hint, v_state = returned_sqlstate;
      v_outcome := 'refused';
      v_code := case when v_state = 'XR001' then coalesce(nullif(v_code, ''), 'punch_refused')
                     when v_state = '42501' then 'supervisor_punch_not_lead'
                     else 'supervisor_punch_batch' end;
    end;
    if v_outcome = 'refused' then
      v_refused := v_refused + 1;
    elsif v_outcome = 'applied' then
      v_applied := v_applied + 1;
    end if;
    if v_punch_id is not null then
      v_punch_ids := v_punch_ids || to_jsonb(v_punch_id);
    end if;
    v_results := v_results || jsonb_build_array(jsonb_build_object('punch_id', v_punch_id, 'shift_id', v_shift_id,
      'outcome', v_outcome, 'code', v_code));
  end loop;

  perform private.write_audit_event(v_project.org_id, 'time.supervisor_punches', 'app.projects', v_project.id,
    jsonb_build_object('batch_id', p_batch_id, 'punch_kind', p_punch_kind, 'punch_ids', v_punch_ids,
      'applied', v_applied, 'refused', v_refused));
  -- The whole batch as Compass keeps it (supervisor_punch_batches): the answer replaces the optimistic row, so it
  -- carries the project, the kind and the device time beside each worker's outcome.
  return jsonb_build_object('id', p_batch_id, 'batch_id', p_batch_id, 'project_id', p_project_id,
    'punch_kind', p_punch_kind, 'device_time', p_device_time, 'results', v_results);
end;
$$;

comment on function app.record_supervisor_punches(uuid, uuid, app.punch_kind, timestamptz, jsonb, bigint, numeric, numeric, numeric, uuid) is 'A supervisor punches a team in or out at once (R12, G-126), offline too: p_punches is 1 to 100 {punch_id, shift_id} (supervisor_punch_batch; the batch id is required, supervisor_punch_batch_required). Each punch runs on its own, so one refusal never fails the rest: the shift is live on the project and not Canceled (supervisor_punch_project) and names a person (supervisor_punch_no_worker); the caller holds crew.shift.write on the project or leads the roster of a roster shift (supervisor_punch_not_lead) and is not the worker (supervisor_punch_self); an In counts from two hours before the shift until its end (supervisor_punch_outside_shift); a roster worker''s entry is working (roster_entry_not_working). Each punch is then recorded by private.apply_punch as a Supervisor punch at the supervisor''s time and position, so every punch rule, time.geofence_required included, applies. A replay of a punch the caller already recorded answers duplicate before any other check. Returns {id, batch_id, project_id, punch_kind, device_time, results: [{punch_id, shift_id, outcome: applied, duplicate or refused, code}]}, id being the batch id so Compass keeps the answer as the batch''s row, and writes one audit event (time.supervisor_punches).';

revoke all on function app.record_supervisor_punches(uuid, uuid, app.punch_kind, timestamptz, jsonb, bigint, numeric, numeric, numeric, uuid) from public, anon;
grant execute on function app.record_supervisor_punches(uuid, uuid, app.punch_kind, timestamptz, jsonb, bigint, numeric, numeric, numeric, uuid) to authenticated, service_role;

insert into private.sync_rpcs (rpc, description) values
  ('app.record_supervisor_punches', 'A supervisor punches a team in or out offline; each punch is idempotent on its client punch id.')
on conflict (rpc) do nothing;

-- Approval (latest: 2751) ------------------------------------------------------------------------------------------------------

create or replace function app.decide_timesheet(p_timesheet_id uuid, p_decision app.approval_decision, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_sheet app.timesheets;
  v_entry uuid;
begin
  select * into v_sheet from app.timesheets t where t.id = p_timesheet_id and t.deleted_at is null for update;
  if v_sheet.id is null or not private.can_on_project(v_sheet.project_id, 'crew.timesheet.approve') then
    raise exception using errcode = '42501', message = 'crew.timesheet.approve is required on the project';
  end if;
  perform private.assert_separation('sod_timesheet_submitter', v_person, v_sheet.submitted_by);
  perform private.assert_separation('sod_timesheet_submitter', v_person,
    private.worker_person_id(v_sheet.membership_id, v_sheet.engagement_id, v_sheet.roster_entry_id));
  if exists (
    select 1 from app.clock_punches c
    join app.time_entries e on e.id = c.time_entry_id
    where c.source = 'Supervisor' and c.created_by = v_person and e.deleted_at is null
      and e.project_id = v_sheet.project_id
      and e.membership_id is not distinct from v_sheet.membership_id and e.engagement_id is not distinct from v_sheet.engagement_id
      and e.roster_entry_id is not distinct from v_sheet.roster_entry_id
      and e.clock_in >= v_sheet.period_start::timestamptz and e.clock_in < (v_sheet.period_end + 1)::timestamptz) then
    perform private.assert_separation('sod_supervisor_punch', v_person, v_person);
  end if;
  v_entry := private.transition_lifecycle('timesheet', 'app.timesheets', 'timesheet_state', 'app.timesheet_state_transitions',
    'timesheet_id', p_timesheet_id, 'Submitted', p_decision::text, p_reason);
  if p_decision = 'Approved' then
    insert into app.timesheet_approvals (timesheet_id, approved_by, approved_minutes)
    values (p_timesheet_id, v_person, private.timesheet_minutes(p_timesheet_id));
  end if;
  return v_entry;
end;
$$;

comment on function app.decide_timesheet(uuid, app.approval_decision, text) is 'Approves or rejects a submitted timesheet: crew.timesheet.approve on the project, never by its submitter or the worker, member, external or agency staff member (sod_timesheet_submitter, invariant 18), nor by a supervisor who punched the worker in or out on the timesheet''s time (sod_supervisor_punch, R12). Approval records the minutes approved.';
