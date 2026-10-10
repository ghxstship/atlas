-- 0340_crew_time.sql
-- A03 Domain Data. Crew and time (Section 7.4 Crew, invariants 10 and 18 to 20, Section 8.2): shifts
-- (a shift cannot end before it starts), shift swaps (a crew member cannot approve their own swap),
-- time entries (no overlap for one person), corrections with approval, the time entry audit log,
-- timesheets and approvals (no self-approval; an approval is voided when the hours change), kiosk
-- devices and hashed kiosk PINs. Crew assigned to a shift can read its project header (invariant 2).

-- Enums and rules ----------------------------------------------------------------------------------------

create type app.swap_state as enum ('Proposed', 'Approved', 'Rejected', 'Canceled');
comment on type app.swap_state is 'Shift swap states.';

create type app.time_entry_source as enum ('Web', 'Mobile', 'Kiosk');
comment on type app.time_entry_source is 'Where a time entry was captured.';

create type app.timesheet_state as enum ('Proposed', 'Submitted', 'Approved', 'Rejected');
comment on type app.timesheet_state is 'Timesheet states: drafted (Proposed), Submitted, Approved by someone other than the submitter, or Rejected. An approval whose hours change returns the timesheet to Proposed (invariant 19).';

create type app.correction_state as enum ('Proposed', 'Approved', 'Rejected');
comment on type app.correction_state is 'Time entry correction states.';

insert into private.lifecycle_transition_rules (lifecycle, from_state, to_state) values
  ('swap', 'Proposed', 'Approved'),
  ('swap', 'Proposed', 'Rejected'),
  ('swap', 'Proposed', 'Canceled'),
  ('timesheet', 'Proposed', 'Submitted'),
  ('timesheet', 'Submitted', 'Approved'),
  ('timesheet', 'Submitted', 'Rejected'),
  ('timesheet', 'Submitted', 'Proposed'),
  ('timesheet', 'Rejected', 'Submitted'),
  ('timesheet', 'Approved', 'Proposed'),
  ('correction', 'Proposed', 'Approved'),
  ('correction', 'Proposed', 'Rejected');

insert into private.domain_event_types (code, subject, description) values
  ('shift.swap_approved', 'shift_swaps', 'A shift swap was approved and the shift reassigned.'),
  ('time_entry.corrected', 'time_entries', 'An approved correction changed a time entry.'),
  ('timesheet.submitted', 'timesheets', 'A timesheet was submitted for approval.'),
  ('timesheet.approved', 'timesheets', 'A timesheet was approved by someone other than its submitter.'),
  ('timesheet.approval_voided', 'timesheets', 'A timesheet approval was voided because its hours changed.');

-- Shifts ----------------------------------------------------------------------------------------------------

create table app.shifts (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  record_id uuid references app.records (id),
  scope_node_id uuid references app.scope_nodes (id),
  membership_id uuid references app.memberships (id),
  role_code text references xpms.role (role_code),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  time_zone text not null,
  deleted_at timestamptz,
  constraint shifts_ends_after_start check (ends_at > starts_at)
);

create index shifts_project_id_idx on app.shifts (project_id, starts_at);
create index shifts_record_id_idx on app.shifts (record_id);
create index shifts_scope_node_id_idx on app.shifts (scope_node_id);
create index shifts_membership_id_idx on app.shifts (membership_id, starts_at);
create index shifts_role_code_idx on app.shifts (role_code);

call private.install_domain_table('app.shifts', 'app.projects', 'project_id',
  array['app.records', 'record_id', 'app.scope_nodes', 'scope_node_id', 'app.memberships', 'membership_id']);
call private.describe('app.shifts', 'Crew shifts: one person (or an open slot) in one role for one block of time on a project. A shift cannot end before it starts (invariant 20).', array[
  'project_id', 'Project the shift works on.',
  'record_id', 'Shift record of the same project the shift staffs, when planned through one.',
  'scope_node_id', 'Scope node of the same project, such as the show.',
  'membership_id', 'Membership of the assigned person; NULL for an open shift.',
  'role_code', 'Canon role worked (Roles Library).',
  'starts_at', 'Call time.',
  'ends_at', 'End of the shift; after starts_at.',
  'time_zone', 'IANA zone the shift times were typed in.'
]);

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
  if tg_op = 'UPDATE' and new.membership_id is distinct from old.membership_id and not private.in_trusted_operation('swap_transition')
     and auth.uid() is not null and not private.can_on_project(new.project_id, 'crew.shift.write') then
    raise exception using errcode = '42501', message = 'crew.shift.write is required to reassign a shift';
  end if;
  return new;
end;
$$;

comment on function private.guard_shift() is 'Shifts: IANA zone, Shift record and scope node of the same project, reassignment only by shift writers or an approved swap.';

create trigger t40_guard_shift before insert or update on app.shifts
  for each row execute function private.guard_shift();

-- Shift swaps --------------------------------------------------------------------------------------------------

create table app.shift_swaps (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  shift_id uuid not null references app.shifts (id),
  requested_by_membership_id uuid not null references app.memberships (id),
  proposed_membership_id uuid not null references app.memberships (id),
  swap_state app.swap_state not null default 'Proposed',
  deleted_at timestamptz,
  constraint shift_swaps_distinct check (requested_by_membership_id <> proposed_membership_id)
);

create index shift_swaps_shift_id_idx on app.shift_swaps (shift_id);
create index shift_swaps_requested_by_idx on app.shift_swaps (requested_by_membership_id);
create index shift_swaps_proposed_idx on app.shift_swaps (proposed_membership_id);

call private.install_domain_table('app.shift_swaps', 'app.shifts', 'shift_id',
  array['app.memberships', 'requested_by_membership_id', 'app.memberships', 'proposed_membership_id']);
call private.describe('app.shift_swaps', 'Requests to hand a shift to another member. Approved by someone with crew.swap.approve who is neither party (invariant 18).', array[
  'shift_id', 'Shift to hand over.',
  'requested_by_membership_id', 'Membership of the person currently on the shift who asks to swap.',
  'proposed_membership_id', 'Membership of the person who would take the shift.',
  'swap_state', 'Swap state. Changes only through app.decide_shift_swap and app.cancel_shift_swap.'
]);

call private.install_lifecycle('app.shift_swaps', 'shift_swap_id', 'swap_state', 'swap', 'Proposed',
  $$shift_swap_id in (select s.id from app.shift_swaps s where s.shift_id in (
      select sh.id from app.shifts sh where sh.project_id in (select private.project_ids_with('crew.shift.read'))
        or sh.membership_id in (select private.my_membership_ids())))$$);

create trigger t90_emit_swap_approved after insert on app.swap_state_transitions
  for each row when (new.to_state = 'Approved')
  execute function private.emit_subject_event('shift.swap_approved', 'shift_swaps', 'shift_swap_id', 'from_state', 'to_state');

create or replace function private.guard_shift_swap()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if (select s.membership_id from app.shifts s where s.id = new.shift_id) is distinct from new.requested_by_membership_id then
      perform private.refuse('swap_not_on_shift', 'Only the person on a shift asks to swap it.');
    end if;
  elsif new.shift_id <> old.shift_id or new.requested_by_membership_id <> old.requested_by_membership_id
        or new.proposed_membership_id <> old.proposed_membership_id then
    perform private.refuse('swap_immutable', 'A swap keeps its shift and people; cancel it and ask again.');
  end if;
  return new;
end;
$$;

comment on function private.guard_shift_swap() is 'Shift swaps are asked for by the person on the shift and never change parties.';

create trigger t40_guard_shift_swap before insert or update on app.shift_swaps
  for each row execute function private.guard_shift_swap();

create or replace function app.decide_shift_swap(p_shift_swap_id uuid, p_decision app.approval_decision, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_swap app.shift_swaps;
  v_shift app.shifts;
  v_entry uuid;
begin
  select * into v_swap from app.shift_swaps s where s.id = p_shift_swap_id and s.deleted_at is null for update;
  select * into v_shift from app.shifts s where s.id = v_swap.shift_id for update;
  if v_swap.id is null or not private.can_on_project(v_shift.project_id, 'crew.swap.approve') then
    raise exception using errcode = '42501', message = 'crew.swap.approve is required on the project';
  end if;
  perform private.assert_separation('sod_swap_requester', v_person,
    (select m.person_id from app.memberships m where m.id = v_swap.requested_by_membership_id));
  perform private.assert_separation('sod_swap_requester', v_person,
    (select m.person_id from app.memberships m where m.id = v_swap.proposed_membership_id));
  v_entry := private.transition_lifecycle('swap', 'app.shift_swaps', 'swap_state', 'app.swap_state_transitions',
    'shift_swap_id', p_shift_swap_id, 'Proposed', p_decision::text, p_reason);
  if p_decision = 'Approved' then
    if v_shift.membership_id is distinct from v_swap.requested_by_membership_id then
      perform private.refuse('swap_stale', 'The shift changed hands since the swap was asked for.');
    end if;
    perform private.begin_trusted_operation('swap_transition');
    update app.shifts set membership_id = v_swap.proposed_membership_id where id = v_shift.id;
    perform private.end_trusted_operation('swap_transition');
  end if;
  return v_entry;
end;
$$;

comment on function app.decide_shift_swap(uuid, app.approval_decision, text) is 'Approves or rejects a shift swap: crew.swap.approve on the project, never by either party (sod_swap_requester, invariant 18). Approval reassigns the shift.';

create or replace function app.cancel_shift_swap(p_shift_swap_id uuid, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform private.require_person();
  if not exists (select 1 from app.shift_swaps s where s.id = p_shift_swap_id
                 and s.requested_by_membership_id in (select private.my_membership_ids())) then
    raise exception using errcode = '42501', message = 'only the requester cancels a swap';
  end if;
  return private.transition_lifecycle('swap', 'app.shift_swaps', 'swap_state', 'app.swap_state_transitions',
    'shift_swap_id', p_shift_swap_id, 'Proposed', 'Canceled', p_reason);
end;
$$;

comment on function app.cancel_shift_swap(uuid, text) is 'Withdraws a swap request; only the requester may.';

-- Time entries (invariant 20) ------------------------------------------------------------------------------------

create table app.time_entries (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  membership_id uuid not null references app.memberships (id),
  shift_id uuid references app.shifts (id),
  clock_in timestamptz not null,
  clock_out timestamptz,
  break_minutes integer not null default 0,
  source app.time_entry_source not null default 'Web',
  kiosk_device_id uuid,
  deleted_at timestamptz,
  constraint time_entries_out_after_in check (clock_out is null or clock_out > clock_in),
  constraint time_entries_break_nonnegative check (break_minutes >= 0)
);

create index time_entries_project_id_idx on app.time_entries (project_id);
create index time_entries_membership_id_idx on app.time_entries (membership_id, clock_in);
create index time_entries_shift_id_idx on app.time_entries (shift_id);

call private.install_domain_table('app.time_entries', 'app.projects', 'project_id',
  array['app.memberships', 'membership_id', 'app.shifts', 'shift_id']);
call private.describe('app.time_entries', 'Clock-in and clock-out punches. Entries of one person never overlap (invariant 20). Every change is written to app.time_entry_audit, and a change inside an approved timesheet voids the approval (invariant 19).', array[
  'project_id', 'Project worked.',
  'membership_id', 'Membership of the person who worked.',
  'shift_id', 'Shift of the same person and project the entry works, when there is one.',
  'clock_in', 'When work started.',
  'clock_out', 'When work stopped; NULL while clocked in.',
  'break_minutes', 'Unpaid break minutes inside the entry.',
  'source', 'Web, Mobile or Kiosk.',
  'kiosk_device_id', 'Kiosk device the punch came from, for Kiosk entries.'
]);

create table app.time_entry_audit (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  time_entry_id uuid not null references app.time_entries (id),
  old_values jsonb,
  new_values jsonb not null
);

create index time_entry_audit_time_entry_id_idx on app.time_entry_audit (time_entry_id);

call private.install_domain_table('app.time_entry_audit', 'app.time_entries', 'time_entry_id', '{}', true);
call private.describe('app.time_entry_audit', 'Append-only audit of every change to a time entry: who (created_by), when (created_at) and the diff (an audit diff, a documented JSON exception).', array[
  'time_entry_id', 'Entry that changed.',
  'old_values', 'Clock in, clock out and break before the change; NULL for the creation entry.',
  'new_values', 'Clock in, clock out and break after the change.'
]);

create or replace function private.guard_time_entry()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_person uuid := (select m.person_id from app.memberships m where m.id = new.membership_id);
begin
  if tg_op = 'INSERT' then
    perform private.assert_production_open(new.project_id);
    if auth.uid() is not null and new.membership_id in (select private.my_membership_ids())
       and not private.can_on_project(new.project_id, 'crew.time_entry.write')
       and not (new.project_id in (select private.my_project_ids())
                or exists (select 1 from app.shifts s where s.project_id = new.project_id and s.membership_id = new.membership_id and s.deleted_at is null)) then
      perform private.refuse('time_entry_project', 'A person records time only on projects they belong to or have a shift on.');
    end if;
  elsif new.membership_id <> old.membership_id or new.project_id <> old.project_id then
    perform private.refuse('time_entry_immutable', 'A time entry keeps its person and project.');
  end if;
  if new.shift_id is not null and not exists (
    select 1 from app.shifts s where s.id = new.shift_id and s.project_id = new.project_id
      and s.membership_id is not distinct from new.membership_id) then
    perform private.refuse('time_entry_shift', 'A time entry works a shift of the same person and project.');
  end if;
  if new.clock_out is not null and new.clock_out <= new.clock_in then
    return new;
  end if;
  if new.deleted_at is null then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('time_entries:' || v_person::text, 0));
    if exists (
      select 1 from app.time_entries t join app.memberships m on m.id = t.membership_id
      where m.person_id = v_person and t.org_id = new.org_id and t.id <> new.id and t.deleted_at is null
        and tstzrange(t.clock_in, coalesce(t.clock_out, 'infinity')) && tstzrange(new.clock_in, coalesce(new.clock_out, 'infinity'))
    ) then
      perform private.refuse('time_entry_overlap', 'Time entries of one person cannot overlap.');
    end if;
  end if;
  return new;
end;
$$;

comment on function private.guard_time_entry() is 'Time entries: no new entry on a closed production (invariant 10), a person''s own entries only on their projects or shifts, shift of the same person and project, and no overlap for one person within the org (invariant 20, serialized per person).';

create trigger t40_guard_time_entry before insert or update on app.time_entries
  for each row execute function private.guard_time_entry();

-- Timesheets (invariants 18 and 19) ----------------------------------------------------------------------------------

create table app.timesheets (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid not null references app.projects (id),
  membership_id uuid not null references app.memberships (id),
  period_start date not null,
  period_end date not null,
  submitted_by uuid references app.people (id),
  timesheet_state app.timesheet_state not null default 'Proposed',
  deleted_at timestamptz,
  constraint timesheets_period check (period_end >= period_start)
);

create index timesheets_project_id_idx on app.timesheets (project_id);
create index timesheets_membership_id_idx on app.timesheets (membership_id, period_start);
create index timesheets_submitted_by_idx on app.timesheets (submitted_by);
create unique index timesheets_one_per_period on app.timesheets (project_id, membership_id, period_start) where deleted_at is null;

call private.install_domain_table('app.timesheets', 'app.projects', 'project_id', array['app.memberships', 'membership_id']);
call private.describe('app.timesheets', 'A person''s time on a project for a period. Hours are derived from the time entries (app.timesheet_hours). The submitter and the worker cannot approve (invariant 18), and an approval is voided when the hours change (invariant 19).', array[
  'project_id', 'Project.',
  'membership_id', 'Membership of the person whose time it is.',
  'period_start', 'First day covered.',
  'period_end', 'Last day covered.',
  'submitted_by', 'Person who submitted it, set by app.submit_timesheet.',
  'timesheet_state', 'Timesheet state. Changes only through the timesheet RPCs and the void trigger.'
]);

call private.install_lifecycle('app.timesheets', 'timesheet_id', 'timesheet_state', 'timesheet', 'Proposed',
  $$timesheet_id in (select t.id from app.timesheets t where t.project_id in (select private.project_ids_with('crew.timesheet.read'))
    or t.membership_id in (select private.my_membership_ids()))$$);

create trigger t90_emit_timesheet_submitted after insert on app.timesheet_state_transitions
  for each row when (new.to_state = 'Submitted')
  execute function private.emit_subject_event('timesheet.submitted', 'timesheets', 'timesheet_id', 'from_state', 'to_state');
create trigger t90_emit_timesheet_approved after insert on app.timesheet_state_transitions
  for each row when (new.to_state = 'Approved')
  execute function private.emit_subject_event('timesheet.approved', 'timesheets', 'timesheet_id', 'from_state', 'to_state');
create trigger t90_emit_timesheet_voided after insert on app.timesheet_state_transitions
  for each row when (new.from_state = 'Approved' and new.to_state = 'Proposed')
  execute function private.emit_subject_event('timesheet.approval_voided', 'timesheets', 'timesheet_id', 'from_state', 'to_state', 'reason');

create or replace function private.guard_timesheet()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.submitted_by := null;
  elsif new.project_id <> old.project_id or new.membership_id <> old.membership_id
        or ((new.period_start <> old.period_start or new.period_end <> old.period_end) and old.timesheet_state <> 'Proposed') then
    perform private.refuse('timesheet_immutable', 'A timesheet keeps its project and person, and its period once submitted.');
  elsif new.submitted_by is distinct from old.submitted_by and not private.in_trusted_operation('timesheet_transition') then
    perform private.refuse('timesheet_submitter', 'The submitter is recorded by app.submit_timesheet.');
  end if;
  return new;
end;
$$;

comment on function private.guard_timesheet() is 'Timesheets keep their project and person, their period once submitted, and a submitter set only by submission.';

create trigger t40_guard_timesheet before insert or update on app.timesheets
  for each row execute function private.guard_timesheet();

create table app.timesheet_approvals (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  timesheet_id uuid not null references app.timesheets (id),
  approved_by uuid not null references app.people (id),
  approved_minutes integer not null,
  voided_at timestamptz,
  constraint timesheet_approvals_minutes_nonnegative check (approved_minutes >= 0)
);

create index timesheet_approvals_timesheet_id_idx on app.timesheet_approvals (timesheet_id);
create index timesheet_approvals_approved_by_idx on app.timesheet_approvals (approved_by);

call private.install_domain_table('app.timesheet_approvals', 'app.timesheets', 'timesheet_id');
call private.describe('app.timesheet_approvals', 'Approvals given to a timesheet with the minutes approved at that moment. An approval is voided (voided_at) when the timesheet''s hours change afterwards (invariant 19); only the database writes these rows.', array[
  'timesheet_id', 'Timesheet approved.',
  'approved_by', 'Person who approved; never the submitter or the worker.',
  'approved_minutes', 'Worked minutes the approval covered, the fact the approver signed.',
  'voided_at', 'When a change to the hours voided the approval; NULL while it stands.'
]);

create or replace function private.worked_minutes(p_membership_id uuid, p_project_id uuid, p_from date, p_to date)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(greatest(0, (extract(epoch from (e.clock_out - e.clock_in)) / 60)::integer - e.break_minutes)), 0)::integer
  from app.time_entries e
  where e.membership_id = p_membership_id and e.project_id = p_project_id and e.deleted_at is null
    and e.clock_out is not null and e.clock_in >= p_from::timestamptz and e.clock_in < (p_to + 1)::timestamptz;
$$;

comment on function private.worked_minutes(uuid, uuid, date, date) is 'Worked minutes of a person on a project for a date range: closed entries clocked in during the range, less breaks.';
revoke all on function private.worked_minutes(uuid, uuid, date, date) from public, anon, authenticated;
grant execute on function private.worked_minutes(uuid, uuid, date, date) to authenticated, service_role;

create or replace function private.has_open_entry(p_membership_id uuid, p_project_id uuid, p_from date, p_to date)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from app.time_entries e
    where e.membership_id = p_membership_id and e.project_id = p_project_id and e.deleted_at is null
      and e.clock_out is null and e.clock_in >= p_from::timestamptz and e.clock_in < (p_to + 1)::timestamptz);
$$;

comment on function private.has_open_entry(uuid, uuid, date, date) is 'True while a person has an entry without a clock out on a project in a date range.';
revoke all on function private.has_open_entry(uuid, uuid, date, date) from public, anon, authenticated;
grant execute on function private.has_open_entry(uuid, uuid, date, date) to authenticated, service_role;

create or replace function private.timesheet_minutes(p_timesheet_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select private.worked_minutes(t.membership_id, t.project_id, t.period_start, t.period_end) from app.timesheets t where t.id = p_timesheet_id;
$$;

comment on function private.timesheet_minutes(uuid) is 'Worked minutes of a timesheet, for RPCs.';
revoke all on function private.timesheet_minutes(uuid) from public, anon, authenticated;

create view app.timesheet_hours with (security_invoker = true) as
select t.id as timesheet_id, t.project_id, t.membership_id,
  private.worked_minutes(t.membership_id, t.project_id, t.period_start, t.period_end) as worked_minutes,
  private.has_open_entry(t.membership_id, t.project_id, t.period_start, t.period_end) as has_open_entry
from app.timesheets t
where t.deleted_at is null;

call private.describe('app.timesheet_hours', 'Worked minutes per timesheet, derived from its time entries, and whether an entry is still open.', array[
  'timesheet_id', 'Timesheet.',
  'project_id', 'Project.',
  'membership_id', 'Membership of the worker.',
  'worked_minutes', 'Closed entry minutes less breaks.',
  'has_open_entry', 'True while an entry in the period has no clock out.'
]);
revoke all on app.timesheet_hours from public, anon;
grant select on app.timesheet_hours to authenticated, service_role;

create or replace function app.submit_timesheet(p_timesheet_id uuid, p_reason text default 'Submitted.')
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_sheet app.timesheets;
  v_from text;
  v_entry uuid;
begin
  select * into v_sheet from app.timesheets t where t.id = p_timesheet_id and t.deleted_at is null for update;
  if v_sheet.id is null or not (
    (v_sheet.membership_id in (select private.my_membership_ids()) and private.capability_reach(v_sheet.org_id, 'crew.timesheet.submit') is not null)
    or private.can_on_project(v_sheet.project_id, 'crew.timesheet.submit')) then
    raise exception using errcode = '42501', message = 'crew.timesheet.submit is required';
  end if;
  if private.has_open_entry(v_sheet.membership_id, v_sheet.project_id, v_sheet.period_start, v_sheet.period_end) then
    perform private.refuse('timesheet_open_entry', 'Clock out of every entry in the period before submitting.');
  end if;
  v_from := v_sheet.timesheet_state::text;
  perform private.begin_trusted_operation('timesheet_transition');
  update app.timesheets set submitted_by = v_person where id = p_timesheet_id;
  v_entry := private.transition_lifecycle('timesheet', 'app.timesheets', 'timesheet_state', 'app.timesheet_state_transitions',
    'timesheet_id', p_timesheet_id, v_from, 'Submitted', p_reason);
  perform private.end_trusted_operation('timesheet_transition');
  return v_entry;
end;
$$;

comment on function app.submit_timesheet(uuid, text) is 'Submits a drafted or rejected timesheet with no open entries; the worker (own reach) or a project submitter may. Records the submitter.';

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
    (select m.person_id from app.memberships m where m.id = v_sheet.membership_id));
  v_entry := private.transition_lifecycle('timesheet', 'app.timesheets', 'timesheet_state', 'app.timesheet_state_transitions',
    'timesheet_id', p_timesheet_id, 'Submitted', p_decision::text, p_reason);
  if p_decision = 'Approved' then
    insert into app.timesheet_approvals (timesheet_id, approved_by, approved_minutes)
    values (p_timesheet_id, v_person, private.timesheet_minutes(p_timesheet_id));
  end if;
  return v_entry;
end;
$$;

comment on function app.decide_timesheet(uuid, app.approval_decision, text) is 'Approves or rejects a submitted timesheet: crew.timesheet.approve on the project, never by its submitter or the worker (sod_timesheet_submitter, invariant 18). Approval records the minutes approved.';

create or replace function private.void_timesheet_approvals()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row app.time_entries := case when tg_op = 'DELETE' then old else new end;
  v_sheet record;
begin
  if tg_op = 'UPDATE' and new.clock_in = old.clock_in and new.clock_out is not distinct from old.clock_out
     and new.break_minutes = old.break_minutes and new.deleted_at is not distinct from old.deleted_at then
    return null;
  end if;
  for v_sheet in
    select t.id from app.timesheets t
    where t.membership_id = v_row.membership_id and t.project_id = v_row.project_id and t.timesheet_state = 'Approved'
      and t.deleted_at is null
      and ((v_row.clock_in >= t.period_start::timestamptz and v_row.clock_in < (t.period_end + 1)::timestamptz)
           or (tg_op = 'UPDATE' and old.clock_in >= t.period_start::timestamptz and old.clock_in < (t.period_end + 1)::timestamptz))
  loop
    update app.timesheet_approvals set voided_at = now() where timesheet_id = v_sheet.id and voided_at is null;
    perform private.transition_lifecycle('timesheet', 'app.timesheets', 'timesheet_state', 'app.timesheet_state_transitions',
      'timesheet_id', v_sheet.id, 'Approved', 'Proposed', 'Hours changed after approval; the approval is voided.');
  end loop;
  return null;
end;
$$;

comment on function private.void_timesheet_approvals() is 'Invariant 19: when a time entry inside an approved timesheet changes, the approval is voided and the timesheet returns to Proposed for resubmission.';

create or replace function private.audit_time_entry()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.clock_in = old.clock_in and new.clock_out is not distinct from old.clock_out
     and new.break_minutes = old.break_minutes and new.deleted_at is not distinct from old.deleted_at then
    return null;
  end if;
  insert into app.time_entry_audit (time_entry_id, old_values, new_values)
  values (new.id,
    case when tg_op = 'UPDATE' then jsonb_build_object('clock_in', old.clock_in, 'clock_out', old.clock_out, 'break_minutes', old.break_minutes, 'deleted_at', old.deleted_at) end,
    jsonb_build_object('clock_in', new.clock_in, 'clock_out', new.clock_out, 'break_minutes', new.break_minutes, 'deleted_at', new.deleted_at));
  return null;
end;
$$;

comment on function private.audit_time_entry() is 'Writes every creation and change of a time entry''s times to app.time_entry_audit.';

create trigger t85_audit_time_entry after insert or update on app.time_entries
  for each row execute function private.audit_time_entry();
create trigger t86_void_timesheet_approvals after insert or update on app.time_entries
  for each row execute function private.void_timesheet_approvals();
create trigger t42_refuse_time_entry_delete before delete on app.time_entries
  for each row execute function private.refuse_ledger_change();

-- Corrections ---------------------------------------------------------------------------------------------------------

create table app.time_entry_corrections (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  time_entry_id uuid not null references app.time_entries (id),
  requested_by uuid references app.people (id),
  proposed_clock_in timestamptz not null,
  proposed_clock_out timestamptz,
  proposed_break_minutes integer not null default 0,
  reason text not null,
  correction_state app.correction_state not null default 'Proposed',
  deleted_at timestamptz,
  constraint time_entry_corrections_window check (proposed_clock_out is null or proposed_clock_out > proposed_clock_in),
  constraint time_entry_corrections_break check (proposed_break_minutes >= 0),
  constraint time_entry_corrections_reason_length check (char_length(btrim(reason)) between 1 and 500)
);

create index time_entry_corrections_time_entry_id_idx on app.time_entry_corrections (time_entry_id);
create index time_entry_corrections_requested_by_idx on app.time_entry_corrections (requested_by);

call private.install_domain_table('app.time_entry_corrections', 'app.time_entries', 'time_entry_id');
call private.describe('app.time_entry_corrections', 'Requested corrections to a time entry. Approved by someone with crew.timesheet.approve other than the requester; approval rewrites the entry (audited, and voiding any approval of its timesheet).', array[
  'time_entry_id', 'Entry to correct.',
  'requested_by', 'Person who asked for the correction, from the session.',
  'proposed_clock_in', 'Corrected clock in.',
  'proposed_clock_out', 'Corrected clock out.',
  'proposed_break_minutes', 'Corrected break minutes.',
  'reason', 'Why the entry is wrong.',
  'correction_state', 'Correction state. Changes only through app.decide_time_entry_correction.'
]);

call private.install_lifecycle('app.time_entry_corrections', 'time_entry_correction_id', 'correction_state', 'correction', 'Proposed',
  $$time_entry_correction_id in (select c.id from app.time_entry_corrections c join app.time_entries e on e.id = c.time_entry_id
    where e.project_id in (select private.project_ids_with('crew.time_entry.read')) or e.membership_id in (select private.my_membership_ids()))$$);

create or replace function private.guard_time_entry_correction()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.requested_by := coalesce(private.current_person_id(), new.requested_by);
  elsif new.requested_by is distinct from old.requested_by or new.time_entry_id <> old.time_entry_id
        or new.proposed_clock_in <> old.proposed_clock_in or new.proposed_clock_out is distinct from old.proposed_clock_out
        or new.proposed_break_minutes <> old.proposed_break_minutes or new.reason <> old.reason then
    perform private.refuse('correction_immutable', 'A correction never changes; request another.');
  end if;
  return new;
end;
$$;

comment on function private.guard_time_entry_correction() is 'Corrections: requester from the session; never edited.';

create trigger t40_guard_time_entry_correction before insert or update on app.time_entry_corrections
  for each row execute function private.guard_time_entry_correction();

create or replace function app.decide_time_entry_correction(p_correction_id uuid, p_decision app.approval_decision, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_correction app.time_entry_corrections;
  v_entry_row app.time_entries;
  v_ledger uuid;
begin
  select * into v_correction from app.time_entry_corrections c where c.id = p_correction_id and c.deleted_at is null for update;
  select * into v_entry_row from app.time_entries e where e.id = v_correction.time_entry_id for update;
  if v_correction.id is null or not private.can_on_project(v_entry_row.project_id, 'crew.timesheet.approve') then
    raise exception using errcode = '42501', message = 'crew.timesheet.approve is required on the project';
  end if;
  perform private.assert_separation('sod_approval_requester', v_person, v_correction.requested_by);
  perform private.assert_separation('sod_timesheet_submitter', v_person,
    (select m.person_id from app.memberships m where m.id = v_entry_row.membership_id));
  v_ledger := private.transition_lifecycle('correction', 'app.time_entry_corrections', 'correction_state',
    'app.correction_state_transitions', 'time_entry_correction_id', p_correction_id, 'Proposed', p_decision::text, p_reason);
  if p_decision = 'Approved' then
    update app.time_entries
    set clock_in = v_correction.proposed_clock_in, clock_out = v_correction.proposed_clock_out,
        break_minutes = v_correction.proposed_break_minutes
    where id = v_entry_row.id;
    perform private.emit_event(v_entry_row.org_id, 'time_entry.corrected', 'time_entries', v_entry_row.id, v_entry_row.project_id,
      jsonb_build_object('time_entry_correction_id', p_correction_id));
  end if;
  return v_ledger;
end;
$$;

comment on function app.decide_time_entry_correction(uuid, app.approval_decision, text) is 'Approves or rejects a time entry correction: crew.timesheet.approve on the project, never by the requester or the worker. Approval rewrites the entry, which is audited and voids any approval of its timesheet (invariant 19).';

-- Kiosk devices and PINs ---------------------------------------------------------------------------------------------

create table app.kiosk_devices (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid references app.projects (id),
  name text not null,
  device_key_hash bytea not null,
  last_seen_at timestamptz,
  revoked_at timestamptz,
  deleted_at timestamptz,
  constraint kiosk_devices_name_length check (char_length(btrim(name)) between 1 and 100),
  constraint kiosk_devices_key_hash_length check (octet_length(device_key_hash) = 32)
);

create index kiosk_devices_project_id_idx on app.kiosk_devices (project_id);
create unique index kiosk_devices_key_hash_key on app.kiosk_devices (device_key_hash);

call private.install_domain_table('app.kiosk_devices', null, null, array['app.projects', 'project_id']);
call private.describe('app.kiosk_devices', 'Shared clock-in kiosks. Only a SHA-256 hash of the device key is stored; the key is shown once at registration (invariant 8).', array[
  'project_id', 'Project the kiosk serves, when it serves one.',
  'name', 'Kiosk name, such as Dock Gate Kiosk.',
  'device_key_hash', 'SHA-256 of the device key. Never selectable by signed-in callers.',
  'last_seen_at', 'Last time the kiosk checked in.',
  'revoked_at', 'When the kiosk was revoked; a revoked kiosk accepts no punches.'
]);

alter table app.time_entries add constraint time_entries_kiosk_device_id_fkey foreign key (kiosk_device_id) references app.kiosk_devices (id);
create index time_entries_kiosk_device_id_idx on app.time_entries (kiosk_device_id);

create table app.kiosk_pins (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  membership_id uuid not null references app.memberships (id),
  pin_hash text not null,
  failed_attempts smallint not null default 0,
  locked_at timestamptz,
  deleted_at timestamptz,
  constraint kiosk_pins_failed_attempts_range check (failed_attempts between 0 and 5)
);

create unique index kiosk_pins_membership_key on app.kiosk_pins (membership_id) where deleted_at is null;

call private.install_domain_table('app.kiosk_pins', 'app.memberships', 'membership_id');
call private.describe('app.kiosk_pins', 'Kiosk PINs of org members, stored only as bcrypt hashes and set through app.set_kiosk_pin (invariant 8). Five failed attempts lock the PIN.', array[
  'membership_id', 'Membership the PIN identifies at a kiosk.',
  'pin_hash', 'bcrypt hash of the PIN. Never selectable by signed-in callers.',
  'failed_attempts', 'Consecutive failed attempts; the PIN locks at 5.',
  'locked_at', 'When the PIN locked; a locked PIN must be reset.'
]);

create or replace function app.register_kiosk_device(p_org_id uuid, p_name text, p_project_id uuid default null)
returns table (kiosk_device_id uuid, device_key text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_key text := 'xkio_' || encode(extensions.gen_random_bytes(32), 'hex');
  v_id uuid;
begin
  perform private.require_person();
  if not private.has_capability(p_org_id, 'org.time_attendance.write') then
    raise exception using errcode = '42501', message = 'org.time_attendance.write is required';
  end if;
  insert into app.kiosk_devices (org_id, project_id, name, device_key_hash)
  values (p_org_id, p_project_id, btrim(p_name), extensions.digest(v_key, 'sha256'))
  returning id into v_id;
  return query select v_id, v_key;
end;
$$;

comment on function app.register_kiosk_device(uuid, text, uuid) is 'Registers a kiosk and returns its device key once; only the hash is kept. Needs org.time_attendance.write.';

create or replace function app.set_kiosk_pin(p_membership_id uuid, p_pin text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid := (select m.org_id from app.memberships m where m.id = p_membership_id);
begin
  perform private.require_person();
  if v_org is null or not (p_membership_id in (select private.my_membership_ids())
                           or private.has_capability(v_org, 'org.time_attendance.write')) then
    raise exception using errcode = '42501', message = 'only the member or org.time_attendance.write sets a kiosk PIN';
  end if;
  if p_pin !~ '^[0-9]{4,8}$' then
    perform private.refuse('kiosk_pin_format', 'A kiosk PIN is 4 to 8 digits.');
  end if;
  update app.kiosk_pins set deleted_at = now() where membership_id = p_membership_id and deleted_at is null;
  insert into app.kiosk_pins (membership_id, pin_hash) values (p_membership_id, extensions.crypt(p_pin, extensions.gen_salt('bf')));
end;
$$;

comment on function app.set_kiosk_pin(uuid, text) is 'Sets or resets a member''s kiosk PIN, storing only its bcrypt hash. The member or org.time_attendance.write may.';

create or replace function private.verify_kiosk_pin(p_device_key text, p_membership_id uuid, p_pin text)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_device app.kiosk_devices;
  v_pin app.kiosk_pins;
begin
  select * into v_device from app.kiosk_devices d where d.device_key_hash = extensions.digest(p_device_key, 'sha256')
    and d.revoked_at is null and d.deleted_at is null;
  select * into v_pin from app.kiosk_pins k where k.membership_id = p_membership_id and k.deleted_at is null for update;
  if v_device.id is null or v_pin.id is null or v_pin.org_id <> v_device.org_id or v_pin.locked_at is not null then
    return false;
  end if;
  if v_pin.pin_hash = extensions.crypt(p_pin, v_pin.pin_hash) then
    update app.kiosk_pins set failed_attempts = 0 where id = v_pin.id;
    update app.kiosk_devices set last_seen_at = now() where id = v_device.id;
    return true;
  end if;
  update app.kiosk_pins set failed_attempts = least(failed_attempts + 1, 5),
    locked_at = case when failed_attempts + 1 >= 5 then now() end
  where id = v_pin.id;
  return false;
end;
$$;

comment on function private.verify_kiosk_pin(text, uuid, text) is 'Checks a kiosk punch for the platform kiosk service: a live device key of the member''s org and the member''s PIN. Counts failures and locks the PIN at 5 (invariant 8). Executable only by the service role.';

-- Project visibility for assigned crew (invariant 2) -------------------------------------------------------------------

create or replace function private.readable_project_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select private.project_ids_with('projects.project.read')
  union
  select r.project_id from app.records r where r.id in (select private.my_record_ids('work.record.read'))
  union
  select s.project_id from app.shifts s
  where s.deleted_at is null and s.membership_id in (select private.my_membership_ids());
$$;

comment on function private.readable_project_ids() is 'Projects whose header the signed-in person may read: projects they may read under invariant 2, projects of records assigned to them, and projects they hold a shift on.';

-- Policies ------------------------------------------------------------------------------------------------------------

call private.install_policies('app.shifts',
  $$project_id in (select private.project_ids_with('crew.shift.read'))
    or membership_id in (select private.my_membership_ids())$$,
  $$project_id in (select private.project_ids_with('crew.shift.write'))$$,
  $$project_id in (select private.project_ids_with('crew.shift.write'))
    or membership_id in (select private.my_membership_ids())$$);

call private.install_policies('app.shift_swaps',
  $$shift_id in (select s.id from app.shifts s where s.project_id in (select private.project_ids_with('crew.shift.read'))
      or s.membership_id in (select private.my_membership_ids()))
    or proposed_membership_id in (select private.my_membership_ids())$$,
  $$requested_by_membership_id in (select private.my_membership_ids())
    and private.capability_reach(org_id, 'crew.swap.request') is not null$$);

call private.install_policies('app.time_entries',
  $$project_id in (select private.project_ids_with('crew.time_entry.read'))
    or membership_id in (select private.my_membership_ids())$$,
  $$project_id in (select private.project_ids_with('crew.time_entry.write'))
    or (membership_id in (select private.my_membership_ids())
        and private.capability_reach(org_id, 'crew.time_entry.write') is not null)$$);
call private.install_policies('app.time_entry_audit',
  $$time_entry_id in (select e.id from app.time_entries e where e.project_id in (select private.project_ids_with('crew.time_entry.read'))
    or e.membership_id in (select private.my_membership_ids()))$$);
call private.install_policies('app.time_entry_corrections',
  $$time_entry_id in (select e.id from app.time_entries e where e.project_id in (select private.project_ids_with('crew.time_entry.read'))
    or e.membership_id in (select private.my_membership_ids()))$$,
  $$time_entry_id in (select e.id from app.time_entries e where e.project_id in (select private.project_ids_with('crew.time_entry.write'))
    or (e.membership_id in (select private.my_membership_ids())
        and private.capability_reach(e.org_id, 'crew.time_entry.write') is not null))$$);

call private.install_policies('app.timesheets',
  $$project_id in (select private.project_ids_with('crew.timesheet.read'))
    or membership_id in (select private.my_membership_ids())$$,
  $$project_id in (select private.project_ids_with('crew.timesheet.submit'))
    or (membership_id in (select private.my_membership_ids())
        and private.capability_reach(org_id, 'crew.timesheet.submit') is not null)$$);
call private.install_policies('app.timesheet_approvals',
  $$timesheet_id in (select t.id from app.timesheets t where t.project_id in (select private.project_ids_with('crew.timesheet.read'))
    or t.membership_id in (select private.my_membership_ids()))$$);

call private.install_policies('app.kiosk_devices',
  $$org_id in (select private.orgs_with_capability('org.time_attendance.write'))$$);
call private.install_policies('app.kiosk_pins',
  $$membership_id in (select private.my_membership_ids())
    or org_id in (select private.orgs_with_capability('org.time_attendance.write'))$$);

-- Hashes are never selectable by signed-in callers (invariant 8).
revoke select on app.kiosk_devices from authenticated;
grant select (id, org_id, project_id, name, last_seen_at, revoked_at, created_at, created_by, updated_at, updated_by, deleted_at)
  on app.kiosk_devices to authenticated;
revoke select on app.kiosk_pins from authenticated;
grant select (id, org_id, membership_id, failed_attempts, locked_at, created_at, created_by, updated_at, updated_by, deleted_at)
  on app.kiosk_pins to authenticated;

-- Function privileges ----------------------------------------------------------------------------------------------------

revoke all on function private.guard_shift() from public, anon, authenticated;
revoke all on function private.guard_shift_swap() from public, anon, authenticated;
revoke all on function private.guard_time_entry() from public, anon, authenticated;
revoke all on function private.guard_timesheet() from public, anon, authenticated;
revoke all on function private.void_timesheet_approvals() from public, anon, authenticated;
revoke all on function private.audit_time_entry() from public, anon, authenticated;
revoke all on function private.guard_time_entry_correction() from public, anon, authenticated;
revoke all on function private.verify_kiosk_pin(text, uuid, text) from public, anon, authenticated;
grant execute on function private.verify_kiosk_pin(text, uuid, text) to service_role;
revoke all on function app.decide_shift_swap(uuid, app.approval_decision, text) from public, anon;
revoke all on function app.cancel_shift_swap(uuid, text) from public, anon;
revoke all on function app.submit_timesheet(uuid, text) from public, anon;
revoke all on function app.decide_timesheet(uuid, app.approval_decision, text) from public, anon;
revoke all on function app.decide_time_entry_correction(uuid, app.approval_decision, text) from public, anon;
revoke all on function app.register_kiosk_device(uuid, text, uuid) from public, anon;
revoke all on function app.set_kiosk_pin(uuid, text) from public, anon;
grant execute on function app.decide_shift_swap(uuid, app.approval_decision, text) to authenticated, service_role;
grant execute on function app.cancel_shift_swap(uuid, text) to authenticated, service_role;
grant execute on function app.submit_timesheet(uuid, text) to authenticated, service_role;
grant execute on function app.decide_timesheet(uuid, app.approval_decision, text) to authenticated, service_role;
grant execute on function app.decide_time_entry_correction(uuid, app.approval_decision, text) to authenticated, service_role;
grant execute on function app.register_kiosk_device(uuid, text, uuid) to authenticated, service_role;
grant execute on function app.set_kiosk_pin(uuid, text) to authenticated, service_role;
