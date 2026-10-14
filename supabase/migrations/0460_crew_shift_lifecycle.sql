-- 0460_crew_shift_lifecycle.sql
-- A13 People and Crew (ADR 0022 range 0460 to 0469). The shift lifecycle the Crew journeys need
-- (Section 20.2 journeys 10 and 66): a shift is drafted, published to crew, accepted by the person
-- assigned or claimed from the open shifts by a member, and can be canceled. Publishing, accepting
-- and claiming go through RPCs that log every move. Domain events for the Crew tables feed the
-- audit ledger, the activity feed and webhooks (A18, 0501).

-- Shift lifecycle ------------------------------------------------------------------------------------

create type app.shift_state as enum ('Draft', 'Published', 'Accepted', 'Canceled');
comment on type app.shift_state is 'Shift lifecycle: Draft while planned, Published to crew, Accepted by the assigned or claiming member, or Canceled (retained, never deleted).';

alter table app.shifts add column shift_state app.shift_state not null default 'Draft';
comment on column app.shifts.shift_state is 'Shift state. Changes only through app.transition_shift, app.publish_shifts, app.accept_shift and app.claim_open_shift.';

create index shifts_open_idx on app.shifts (org_id, starts_at) where membership_id is null and deleted_at is null;

insert into private.lifecycle_transition_rules (lifecycle, from_state, to_state) values
  ('shift', 'Draft', 'Published'),
  ('shift', 'Draft', 'Canceled'),
  ('shift', 'Published', 'Draft'),
  ('shift', 'Published', 'Accepted'),
  ('shift', 'Published', 'Canceled'),
  ('shift', 'Accepted', 'Published'),
  ('shift', 'Accepted', 'Canceled');

call private.install_lifecycle('app.shifts', 'shift_id', 'shift_state', 'shift', 'Draft',
  $$shift_id in (select s.id from app.shifts s where s.project_id in (select private.project_ids_with('crew.shift.read'))
      or s.membership_id in (select private.my_membership_ids()))$$);

insert into private.domain_event_types (code, subject, description) values
  ('shift.created', 'shifts', 'A shift was planned on a project.'),
  ('shift.updated', 'shifts', 'A shift''s times, role or assignee changed.'),
  ('shift.state_changed', 'shifts', 'A shift moved to another shift state: published, accepted, claimed, returned or canceled.'),
  ('shift_swap.requested', 'shift_swaps', 'A crew member asked to hand a shift to another member.'),
  ('shift_swap.state_changed', 'shift_swaps', 'A shift swap was approved, rejected or withdrawn.'),
  ('time_entry.clocked_in', 'time_entries', 'A person clocked in.'),
  ('time_entry.clocked_out', 'time_entries', 'A person clocked out.'),
  ('time_entry.correction_requested', 'time_entry_corrections', 'A correction to a time entry was requested.'),
  ('timesheet.created', 'timesheets', 'A timesheet was opened for a person and period.'),
  ('timesheet.rejected', 'timesheets', 'A submitted timesheet was rejected.'),
  ('rate_card.created', 'rate_cards', 'A labor rate card was created.'),
  ('rate_card.updated', 'rate_cards', 'A labor rate card''s name or effective dates changed.'),
  ('rate_card_line.changed', 'rate_card_lines', 'A rate card line was added, edited or removed. The rate itself is Restricted and never in the payload.'),
  ('pay_rate.recorded', 'pay_rates', 'A pay rate entry was added to the ledger. The rate itself is Restricted and never in the payload.'),
  ('pay_period.created', 'pay_periods', 'A pay period was opened.'),
  ('pay_period.state_changed', 'pay_periods', 'A pay period was closed, reopened or posted.'),
  ('payroll_run.created', 'payroll_runs', 'A payroll run was started for a pay period.'),
  ('time_off.requested', 'time_off_requests', 'Time off was requested.'),
  ('time_off.canceled', 'time_off_requests', 'A time off request was canceled.');

-- Swap project (for Compass sync buckets) --------------------------------------------------------------

alter table app.shift_swaps add column project_id uuid references app.projects (id);
update app.shift_swaps w set project_id = s.project_id from app.shifts s where s.id = w.shift_id;
alter table app.shift_swaps alter column project_id set not null;
create index shift_swaps_project_id_idx on app.shift_swaps (project_id);
comment on column app.shift_swaps.project_id is 'Project of the shift, maintained by the database from shift_id (a swap never changes shift), so Compass can sync swaps by project.';

create or replace function private.set_shift_swap_project()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.project_id := (select s.project_id from app.shifts s where s.id = new.shift_id);
  return new;
end;
$$;

comment on function private.set_shift_swap_project() is 'Copies the shift''s project onto a swap on every write, so the column always matches its shift.';

create trigger t05_set_shift_swap_project before insert or update on app.shift_swaps
  for each row execute function private.set_shift_swap_project();

-- Shift guard: reassignment by writers, an approved swap or a claim; times by writers only. ----------

create or replace function private.guard_shift()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.assert_time_zone(new.time_zone);
  if new.record_id is not null then
    if (select r.project_id from app.records r where r.id = new.record_id) <> new.project_id
       or (select r.record_kind from app.records r where r.id = new.record_id) <> 'Shift' then
      perform private.refuse('shift_record', 'A shift staffs a Shift record of its own project.');
    end if;
  end if;
  if new.scope_node_id is not null and (select n.project_id from app.scope_nodes n where n.id = new.scope_node_id) <> new.project_id then
    perform private.refuse('shift_scope_project', 'A shift''s scope node belongs to its project.');
  end if;
  if tg_op = 'UPDATE' then
    if new.membership_id is distinct from old.membership_id
       and not private.in_trusted_operation('swap_transition') and not private.in_trusted_operation('shift_claim')
       and auth.uid() is not null and not private.can_on_project(new.project_id, 'crew.shift.write') then
      raise exception using errcode = '42501', message = 'crew.shift.write is required to reassign a shift';
    end if;
    if (new.starts_at <> old.starts_at or new.ends_at <> old.ends_at or new.role_code is distinct from old.role_code
        or new.time_zone <> old.time_zone or new.project_id <> old.project_id
        or new.scope_node_id is distinct from old.scope_node_id or new.record_id is distinct from old.record_id)
       and auth.uid() is not null and not private.can_on_project(new.project_id, 'crew.shift.write') then
      raise exception using errcode = '42501', message = 'crew.shift.write is required to change a shift';
    end if;
    if old.shift_state = 'Canceled' and new.shift_state = 'Canceled'
       and (new.starts_at <> old.starts_at or new.ends_at <> old.ends_at or new.membership_id is distinct from old.membership_id) then
      perform private.refuse('shift_canceled', 'A canceled shift keeps its times and person; plan a new shift instead.');
    end if;
  end if;
  return new;
end;
$$;

comment on function private.guard_shift() is 'Shifts: IANA zone, Shift record and scope node of the same project, reassignment only by shift writers, an approved swap or a claim, times and role only by shift writers, and a canceled shift is frozen.';

-- A shift handed to someone else by a writer goes back to Published for the new person to accept.
create or replace function private.return_reassigned_shift()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.shift_state = 'Accepted' and new.membership_id is distinct from old.membership_id
     and not private.in_trusted_operation('swap_transition') and not private.in_trusted_operation('shift_claim') then
    perform private.transition_lifecycle('shift', 'app.shifts', 'shift_state', 'app.shift_state_transitions',
      'shift_id', new.id, 'Accepted', 'Published', 'Reassigned; the new person accepts the shift.');
  end if;
  return null;
end;
$$;

comment on function private.return_reassigned_shift() is 'When a writer reassigns an Accepted shift, it returns to Published so the new person accepts it. Swaps and claims keep their acceptance.';

create trigger t87_return_reassigned_shift after update of membership_id on app.shifts
  for each row execute function private.return_reassigned_shift();

-- Shift RPCs -------------------------------------------------------------------------------------------

create or replace function app.transition_shift(p_shift_id uuid, p_expected app.shift_state, p_next app.shift_state, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_project uuid := (select s.project_id from app.shifts s where s.id = p_shift_id and s.deleted_at is null);
begin
  perform private.require_person();
  if v_project is null or not private.can_on_project(v_project, 'crew.shift.write') then
    raise exception using errcode = '42501', message = 'crew.shift.write is required on the project';
  end if;
  if p_next = 'Accepted' then
    perform private.refuse('shift_accept_rpc', 'A shift is accepted by its person through app.accept_shift or claimed through app.claim_open_shift.');
  end if;
  return private.transition_lifecycle('shift', 'app.shifts', 'shift_state', 'app.shift_state_transitions',
    'shift_id', p_shift_id, p_expected::text, p_next::text, p_reason);
end;
$$;

comment on function app.transition_shift(uuid, app.shift_state, app.shift_state, text) is 'Publishes, returns to draft or cancels a shift with compare-and-set. Needs crew.shift.write on the project; acceptance goes through app.accept_shift and app.claim_open_shift.';

create or replace function app.publish_shifts(p_shift_ids uuid[], p_reason text default 'Published to crew.')
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_count integer := 0;
begin
  perform private.require_person();
  foreach v_id in array coalesce(p_shift_ids, '{}') loop
    perform app.transition_shift(v_id, 'Draft', 'Published', p_reason);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

comment on function app.publish_shifts(uuid[], text) is 'Publishes drafted shifts in one transaction: every shift moves from Draft to Published or none does.';

create or replace function app.accept_shift(p_shift_id uuid, p_reason text default 'Accepted.')
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_shift app.shifts;
begin
  perform private.require_person();
  select * into v_shift from app.shifts s where s.id = p_shift_id and s.deleted_at is null for update;
  if v_shift.id is null or v_shift.membership_id is null
     or v_shift.membership_id not in (select private.my_membership_ids()) then
    raise exception using errcode = '42501', message = 'only the person assigned accepts a shift';
  end if;
  return private.transition_lifecycle('shift', 'app.shifts', 'shift_state', 'app.shift_state_transitions',
    'shift_id', p_shift_id, 'Published', 'Accepted', p_reason);
end;
$$;

comment on function app.accept_shift(uuid, text) is 'The person assigned to a Published shift accepts it (journey 10).';

create or replace function app.claim_open_shift(p_shift_id uuid, p_reason text default 'Claimed from open shifts.')
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_shift app.shifts;
  v_membership uuid;
  v_person uuid := private.require_person();
  v_entry uuid;
begin
  select * into v_shift from app.shifts s where s.id = p_shift_id and s.deleted_at is null for update;
  if v_shift.id is null then
    raise exception using errcode = '42501', message = 'shift not found';
  end if;
  select m.id into v_membership from app.memberships m
  where m.id in (select private.my_membership_ids()) and m.org_id = v_shift.org_id
  limit 1;
  if v_membership is null or private.capability_reach(v_shift.org_id, 'crew.shift.read') is null then
    raise exception using errcode = '42501', message = 'crew.shift.read is required to claim a shift';
  end if;
  if v_shift.membership_id is not null then
    perform private.refuse('shift_already_claimed', 'Someone already holds this shift.');
  end if;
  if v_shift.shift_state <> 'Published' then
    perform private.refuse('shift_not_published', 'Only a published open shift can be claimed.');
  end if;
  if exists (
    select 1 from app.shifts s join app.memberships m on m.id = s.membership_id
    where m.person_id = v_person and s.org_id = v_shift.org_id and s.deleted_at is null and s.shift_state <> 'Canceled'
      and tstzrange(s.starts_at, s.ends_at) && tstzrange(v_shift.starts_at, v_shift.ends_at)) then
    perform private.refuse('shift_double_booked', 'You already hold a shift that overlaps this one.');
  end if;
  perform private.begin_trusted_operation('shift_claim');
  update app.shifts set membership_id = v_membership where id = p_shift_id;
  perform private.end_trusted_operation('shift_claim');
  v_entry := private.transition_lifecycle('shift', 'app.shifts', 'shift_state', 'app.shift_state_transitions',
    'shift_id', p_shift_id, 'Published', 'Accepted', p_reason);
  return v_entry;
end;
$$;

comment on function app.claim_open_shift(uuid, text) is 'A member of the org claims a Published open shift (journey 66): the shift becomes theirs and Accepted. Refused when it is already held, not published, or overlaps another shift the person holds.';

-- Domain event triggers -----------------------------------------------------------------------------------

create trigger t90_emit_shift_created after insert on app.shifts
  for each row execute function private.emit_subject_event('shift.created', 'shifts', 'id', 'membership_id', 'role_code', 'starts_at', 'ends_at');
create trigger t90_emit_shift_updated after update on app.shifts
  for each row when (new.starts_at is distinct from old.starts_at or new.ends_at is distinct from old.ends_at
    or new.role_code is distinct from old.role_code or new.membership_id is distinct from old.membership_id
    or new.deleted_at is distinct from old.deleted_at)
  execute function private.emit_subject_event('shift.updated', 'shifts', 'id', 'membership_id', 'role_code', 'starts_at', 'ends_at', 'deleted_at');
create trigger t90_emit_shift_state after insert on app.shift_state_transitions
  for each row when (new.from_state is not null)
  execute function private.emit_subject_event('shift.state_changed', 'shifts', 'shift_id', 'from_state', 'to_state', 'reason');

create trigger t90_emit_swap_requested after insert on app.shift_swaps
  for each row execute function private.emit_subject_event('shift_swap.requested', 'shift_swaps', 'id', 'shift_id', 'requested_by_membership_id', 'proposed_membership_id');
create trigger t90_emit_swap_state after insert on app.swap_state_transitions
  for each row when (new.from_state is not null)
  execute function private.emit_subject_event('shift_swap.state_changed', 'shift_swaps', 'shift_swap_id', 'from_state', 'to_state', 'reason');

create trigger t90_emit_clocked_in after insert on app.time_entries
  for each row execute function private.emit_subject_event('time_entry.clocked_in', 'time_entries', 'id', 'membership_id', 'shift_id', 'clock_in', 'source');
create trigger t90_emit_clocked_out after update on app.time_entries
  for each row when (old.clock_out is null and new.clock_out is not null)
  execute function private.emit_subject_event('time_entry.clocked_out', 'time_entries', 'id', 'membership_id', 'shift_id', 'clock_out', 'break_minutes');
create trigger t90_emit_correction_requested after insert on app.time_entry_corrections
  for each row execute function private.emit_subject_event('time_entry.correction_requested', 'time_entry_corrections', 'id', 'time_entry_id', 'reason');

create trigger t90_emit_timesheet_created after insert on app.timesheets
  for each row execute function private.emit_subject_event('timesheet.created', 'timesheets', 'id', 'membership_id', 'period_start', 'period_end');
create trigger t90_emit_timesheet_rejected after insert on app.timesheet_state_transitions
  for each row when (new.to_state = 'Rejected')
  execute function private.emit_subject_event('timesheet.rejected', 'timesheets', 'timesheet_id', 'from_state', 'to_state', 'reason');

create trigger t90_emit_rate_card_created after insert on app.rate_cards
  for each row execute function private.emit_subject_event('rate_card.created', 'rate_cards', 'id', 'name', 'currency_code', 'effective_from', 'effective_to');
create trigger t90_emit_rate_card_updated after update on app.rate_cards
  for each row when (new.name is distinct from old.name or new.effective_from is distinct from old.effective_from
    or new.effective_to is distinct from old.effective_to or new.deleted_at is distinct from old.deleted_at)
  execute function private.emit_subject_event('rate_card.updated', 'rate_cards', 'id', 'name', 'effective_from', 'effective_to', 'deleted_at');
create trigger t90_emit_rate_card_line_inserted after insert on app.rate_card_lines
  for each row execute function private.emit_subject_event('rate_card_line.changed', 'rate_card_lines', 'id', 'rate_card_id', 'role_code', 'worker_classification', 'pay_basis', 'arrangement');
create trigger t90_emit_rate_card_line_updated after update on app.rate_card_lines
  for each row when (new.rate_minor is distinct from old.rate_minor or new.overtime_rule_id is distinct from old.overtime_rule_id
    or new.deleted_at is distinct from old.deleted_at)
  execute function private.emit_subject_event('rate_card_line.changed', 'rate_card_lines', 'id', 'rate_card_id', 'role_code', 'overtime_rule_id', 'deleted_at');
create trigger t90_emit_pay_rate_recorded after insert on app.pay_rates
  for each row execute function private.emit_subject_event('pay_rate.recorded', 'pay_rates', 'id', 'membership_id', 'role_code', 'currency_code', 'effective_from');

create trigger t90_emit_pay_period_created after insert on app.pay_periods
  for each row execute function private.emit_subject_event('pay_period.created', 'pay_periods', 'id', 'starts_on', 'ends_on');
create trigger t90_emit_pay_period_state after insert on app.pay_period_state_transitions
  for each row when (new.from_state is not null)
  execute function private.emit_subject_event('pay_period.state_changed', 'pay_periods', 'pay_period_id', 'from_state', 'to_state', 'reason');
create trigger t90_emit_payroll_run_created after insert on app.payroll_runs
  for each row execute function private.emit_subject_event('payroll_run.created', 'payroll_runs', 'id', 'pay_period_id', 'currency_code');

create trigger t90_emit_time_off_requested after insert on app.time_off_requests
  for each row execute function private.emit_subject_event('time_off.requested', 'time_off_requests', 'id', 'membership_id', 'starts_on', 'ends_on', 'hours');
create trigger t90_emit_time_off_canceled after insert on app.time_off_state_transitions
  for each row when (new.to_state = 'Canceled')
  execute function private.emit_subject_event('time_off.canceled', 'time_off_requests', 'time_off_request_id', 'from_state', 'to_state', 'reason');

-- Function privileges ------------------------------------------------------------------------------------------

revoke all on function private.guard_shift() from public, anon, authenticated;
revoke all on function private.return_reassigned_shift() from public, anon, authenticated;
revoke all on function private.set_shift_swap_project() from public, anon, authenticated;
revoke all on function app.transition_shift(uuid, app.shift_state, app.shift_state, text) from public, anon;
revoke all on function app.publish_shifts(uuid[], text) from public, anon;
revoke all on function app.accept_shift(uuid, text) from public, anon;
revoke all on function app.claim_open_shift(uuid, text) from public, anon;
grant execute on function app.transition_shift(uuid, app.shift_state, app.shift_state, text) to authenticated, service_role;
grant execute on function app.publish_shifts(uuid[], text) to authenticated, service_role;
grant execute on function app.accept_shift(uuid, text) to authenticated, service_role;
grant execute on function app.claim_open_shift(uuid, text) to authenticated, service_role;
