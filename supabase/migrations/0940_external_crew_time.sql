-- 0940_external_crew_time.sql
-- A03 Domain Data, late slot (ADR 0022 section 6; requested by A17 Compass and A28b). External crew work
-- shifts and record time without an org membership: externals never get memberships (Section 4.4), they
-- work through engagements (0700). Shifts, time entries, timesheets and clock punches gain a nullable
-- engagement_id:
--   * a time entry, timesheet or punch names exactly one of membership_id or engagement_id
--   * a shift names at most one (neither is an open shift)
--   * the engagement belongs to the same org (cross-org guard) and the same project, and new time needs
--     an Active or Closing engagement with a named person
--   * the engaged person reads their own rows through private.my_engagement_ids('operational'), so the
--     Section 8.7 time box applies; A28b adds the api_external projections
-- Timesheet minutes, open-entry checks, approval voiding, submission and the approver separation now
-- resolve the worker from either column. Lives here because app.engagements is created in 0700.

-- Columns -------------------------------------------------------------------------------------------------

alter table app.shifts add column engagement_id uuid references app.engagements (id);
alter table app.time_entries add column engagement_id uuid references app.engagements (id);
alter table app.timesheets add column engagement_id uuid references app.engagements (id);
alter table app.clock_punches add column engagement_id uuid references app.engagements (id);

create index shifts_engagement_id_idx on app.shifts (engagement_id);
create index time_entries_engagement_id_idx on app.time_entries (engagement_id, clock_in);
create index timesheets_engagement_id_idx on app.timesheets (engagement_id, period_start);
create index clock_punches_engagement_id_idx on app.clock_punches (engagement_id, effective_at);

alter table app.time_entries alter column membership_id drop not null;
alter table app.timesheets alter column membership_id drop not null;
alter table app.clock_punches alter column membership_id drop not null;

alter table app.shifts add constraint shifts_one_worker check (num_nonnulls(membership_id, engagement_id) <= 1);
alter table app.time_entries add constraint time_entries_one_worker check (num_nonnulls(membership_id, engagement_id) = 1);
alter table app.timesheets add constraint timesheets_one_worker check (num_nonnulls(membership_id, engagement_id) = 1);
alter table app.clock_punches add constraint clock_punches_one_worker check (num_nonnulls(membership_id, engagement_id) = 1);

create unique index timesheets_one_per_engagement_period on app.timesheets (project_id, engagement_id, period_start)
  where engagement_id is not null and deleted_at is null;

comment on column app.shifts.engagement_id is 'Engagement of the external person assigned, when the shift is worked by someone without a membership. At most one of membership_id and engagement_id; neither is an open shift.';
comment on column app.time_entries.engagement_id is 'Engagement of the external person who worked, when they have no membership. Exactly one of membership_id and engagement_id.';
comment on column app.time_entries.membership_id is 'Membership of the person who worked; NULL for external crew, who work through engagement_id.';
comment on column app.timesheets.engagement_id is 'Engagement of the external person whose time it is. Exactly one of membership_id and engagement_id.';
comment on column app.timesheets.membership_id is 'Membership of the person whose time it is; NULL for external crew, who work through engagement_id.';
comment on column app.clock_punches.engagement_id is 'Engagement of the external person who punched. Exactly one of membership_id and engagement_id.';
comment on column app.clock_punches.membership_id is 'Membership of the person who punched; NULL for external crew, who punch through engagement_id.';

-- Tenancy and project guards --------------------------------------------------------------------------------

call private.install_tenant_guards('app.shifts', 'app.projects', 'project_id',
  array['app.records', 'record_id', 'app.scope_nodes', 'scope_node_id', 'app.memberships', 'membership_id', 'app.engagements', 'engagement_id']);
call private.install_tenant_guards('app.time_entries', 'app.projects', 'project_id',
  array['app.memberships', 'membership_id', 'app.shifts', 'shift_id', 'app.engagements', 'engagement_id']);
call private.install_tenant_guards('app.timesheets', 'app.projects', 'project_id',
  array['app.memberships', 'membership_id', 'app.engagements', 'engagement_id']);
call private.install_tenant_guards('app.clock_punches', 'app.projects', 'project_id',
  array['app.memberships', 'membership_id', 'app.shifts', 'shift_id', 'app.time_entries', 'time_entry_id',
        'app.geofences', 'geofence_id', 'app.kiosk_devices', 'kiosk_device_id', 'app.engagements', 'engagement_id']);

create trigger t39_shift_engagement_project before insert or update of engagement_id on app.shifts
  for each row execute function private.assert_same_project('app.engagements', 'engagement_id');
create trigger t39_time_entry_engagement_project before insert or update of engagement_id on app.time_entries
  for each row execute function private.assert_same_project('app.engagements', 'engagement_id');
create trigger t39_timesheet_engagement_project before insert or update of engagement_id on app.timesheets
  for each row execute function private.assert_same_project('app.engagements', 'engagement_id');
create trigger t39_clock_punch_engagement_project before insert on app.clock_punches
  for each row execute function private.assert_same_project('app.engagements', 'engagement_id');

-- Worker resolution ----------------------------------------------------------------------------------------------

create or replace function private.worker_person_id(p_membership_id uuid, p_engagement_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select m.person_id from app.memberships m where m.id = p_membership_id),
                  (select e.person_id from app.engagements e where e.id = p_engagement_id));
$$;

comment on function private.worker_person_id(uuid, uuid) is 'Person behind a worker reference: the membership''s person or the engagement''s person. Takes column values (ADR 0016 crash rule).';
revoke all on function private.worker_person_id(uuid, uuid) from public, anon, authenticated;

create or replace function private.guard_engaged_worker()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_engagement app.engagements;
begin
  if tg_op = 'UPDATE' and new.engagement_id is not distinct from old.engagement_id then
    return new;
  end if;
  if tg_op = 'UPDATE' and tg_table_name <> 'shifts' then
    perform private.refuse(tg_table_name || '_worker_immutable', 'The worker of time never changes.');
  end if;
  if tg_op = 'UPDATE' and auth.uid() is not null and not private.can_on_project(new.project_id, 'crew.shift.write') then
    raise exception using errcode = '42501', message = 'crew.shift.write is required to reassign a shift';
  end if;
  if new.engagement_id is null then
    return new;
  end if;
  select * into v_engagement from app.engagements e where e.id = new.engagement_id;
  if v_engagement.person_id is null then
    perform private.refuse('engagement_worker_person', 'Time and shifts go to an engagement that names the person who works.');
  end if;
  if tg_table_name <> 'shifts' and v_engagement.engagement_state not in ('Active', 'Closing') then
    perform private.refuse('engagement_not_working', 'External crew record time only while their engagement is Active or Closing.');
  end if;
  return new;
end;
$$;

comment on function private.guard_engaged_worker() is 'Shifts, time entries, timesheets and punches worked through an engagement: the engagement names a person, new time needs it Active or Closing, the worker of time never changes, and only shift writers reassign a shift to an engagement.';
revoke all on function private.guard_engaged_worker() from public, anon, authenticated;

create trigger t38_guard_engaged_worker before insert or update of engagement_id on app.shifts
  for each row execute function private.guard_engaged_worker();
create trigger t38_guard_engaged_worker before insert or update of engagement_id on app.time_entries
  for each row execute function private.guard_engaged_worker();
create trigger t38_guard_engaged_worker before insert or update of engagement_id on app.timesheets
  for each row execute function private.guard_engaged_worker();
create trigger t38_guard_engaged_worker before insert on app.clock_punches
  for each row execute function private.guard_engaged_worker();

-- Time entries: the guard resolves the person from either column ------------------------------------------------

create or replace function private.guard_time_entry()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.worker_person_id(new.membership_id, new.engagement_id);
begin
  if tg_op = 'INSERT' then
    perform private.assert_production_open(new.project_id);
    if auth.uid() is not null and new.membership_id in (select private.my_membership_ids())
       and not private.can_on_project(new.project_id, 'crew.time_entry.write')
       and not (new.project_id in (select private.my_project_ids())
                or exists (select 1 from app.shifts s where s.project_id = new.project_id and s.membership_id = new.membership_id and s.deleted_at is null)) then
      perform private.refuse('time_entry_project', 'A person records time only on projects they belong to or have a shift on.');
    end if;
  elsif new.membership_id is distinct from old.membership_id or new.project_id <> old.project_id then
    perform private.refuse('time_entry_immutable', 'A time entry keeps its person and project.');
  end if;
  if new.shift_id is not null and not exists (
    select 1 from app.shifts s where s.id = new.shift_id and s.project_id = new.project_id
      and s.membership_id is not distinct from new.membership_id and s.engagement_id is not distinct from new.engagement_id) then
    perform private.refuse('time_entry_shift', 'A time entry works a shift of the same person and project.');
  end if;
  if new.clock_out is not null and new.clock_out <= new.clock_in then
    return new;
  end if;
  if new.deleted_at is null then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('time_entries:' || v_person::text, 0));
    if exists (
      select 1 from app.time_entries t
      where t.org_id = new.org_id and t.id <> new.id and t.deleted_at is null
        and (t.membership_id in (select m.id from app.memberships m where m.person_id = v_person)
             or t.engagement_id in (select g.id from app.engagements g where g.person_id = v_person))
        and tstzrange(t.clock_in, coalesce(t.clock_out, 'infinity')) && tstzrange(new.clock_in, coalesce(new.clock_out, 'infinity'))
    ) then
      perform private.refuse('time_entry_overlap', 'Time entries of one person cannot overlap.');
    end if;
  end if;
  return new;
end;
$$;

comment on function private.guard_time_entry() is 'Time entries: no new entry on a closed production (invariant 10), a member''s own entries only on their projects or shifts, shift of the same worker and project, and no overlap for one person within the org whether they work through a membership or an engagement (invariant 20, serialized per person).';

create or replace function private.guard_timesheet()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.submitted_by := null;
  elsif new.project_id <> old.project_id or new.membership_id is distinct from old.membership_id
        or new.engagement_id is distinct from old.engagement_id
        or ((new.period_start <> old.period_start or new.period_end <> old.period_end) and old.timesheet_state <> 'Proposed') then
    perform private.refuse('timesheet_immutable', 'A timesheet keeps its project and person, and its period once submitted.');
  elsif new.submitted_by is distinct from old.submitted_by and not private.in_trusted_operation('timesheet_transition') then
    perform private.refuse('timesheet_submitter', 'The submitter is recorded by app.submit_timesheet.');
  end if;
  return new;
end;
$$;

comment on function private.guard_timesheet() is 'Timesheets keep their project and worker (membership or engagement), their period once submitted, and a submitter set only by submission.';

-- Minutes and open entries for either worker -----------------------------------------------------------------------

create or replace function private.worker_minutes(p_membership_id uuid, p_engagement_id uuid, p_project_id uuid, p_from date, p_to date)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(greatest(0, (extract(epoch from (e.clock_out - e.clock_in)) / 60)::integer - e.break_minutes)), 0)::integer
  from app.time_entries e
  where e.membership_id is not distinct from p_membership_id and e.engagement_id is not distinct from p_engagement_id
    and e.project_id = p_project_id and e.deleted_at is null
    and e.clock_out is not null and e.clock_in >= p_from::timestamptz and e.clock_in < (p_to + 1)::timestamptz;
$$;

comment on function private.worker_minutes(uuid, uuid, uuid, date, date) is 'Worked minutes of a worker (membership or engagement) on a project for a date range: closed entries clocked in during the range, less breaks.';
revoke all on function private.worker_minutes(uuid, uuid, uuid, date, date) from public, anon, authenticated;
grant execute on function private.worker_minutes(uuid, uuid, uuid, date, date) to authenticated, service_role;

create or replace function private.worker_has_open_entry(p_membership_id uuid, p_engagement_id uuid, p_project_id uuid, p_from date, p_to date)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from app.time_entries e
    where e.membership_id is not distinct from p_membership_id and e.engagement_id is not distinct from p_engagement_id
      and e.project_id = p_project_id and e.deleted_at is null
      and e.clock_out is null and e.clock_in >= p_from::timestamptz and e.clock_in < (p_to + 1)::timestamptz);
$$;

comment on function private.worker_has_open_entry(uuid, uuid, uuid, date, date) is 'True while a worker (membership or engagement) has an entry without a clock out on a project in a date range.';
revoke all on function private.worker_has_open_entry(uuid, uuid, uuid, date, date) from public, anon, authenticated;
grant execute on function private.worker_has_open_entry(uuid, uuid, uuid, date, date) to authenticated, service_role;

create or replace function private.timesheet_minutes(p_timesheet_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select private.worker_minutes(t.membership_id, t.engagement_id, t.project_id, t.period_start, t.period_end)
  from app.timesheets t where t.id = p_timesheet_id;
$$;

create or replace view app.timesheet_hours with (security_invoker = true) as
select t.id as timesheet_id, t.project_id, t.membership_id,
  private.worker_minutes(t.membership_id, t.engagement_id, t.project_id, t.period_start, t.period_end) as worked_minutes,
  private.worker_has_open_entry(t.membership_id, t.engagement_id, t.project_id, t.period_start, t.period_end) as has_open_entry,
  t.engagement_id
from app.timesheets t
where t.deleted_at is null;

comment on column app.timesheet_hours.engagement_id is 'Engagement of the external worker, when the timesheet is theirs.';

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
    where t.membership_id is not distinct from v_row.membership_id and t.engagement_id is not distinct from v_row.engagement_id
      and t.project_id = v_row.project_id and t.timesheet_state = 'Approved' and t.deleted_at is null
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
    or (v_sheet.engagement_id in (select private.my_engagement_ids('operational'))
        and private.worker_person_id(null, v_sheet.engagement_id) = v_person)
    or private.can_on_project(v_sheet.project_id, 'crew.timesheet.submit')) then
    raise exception using errcode = '42501', message = 'crew.timesheet.submit is required';
  end if;
  if private.worker_has_open_entry(v_sheet.membership_id, v_sheet.engagement_id, v_sheet.project_id, v_sheet.period_start, v_sheet.period_end) then
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

comment on function app.submit_timesheet(uuid, text) is 'Submits a drafted or rejected timesheet with no open entries; the worker (own reach, or the engaged person while their operational access is open) or a project submitter may. Records the submitter.';

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
  perform private.assert_separation('sod_timesheet_submitter', v_person, private.worker_person_id(v_sheet.membership_id, v_sheet.engagement_id));
  v_entry := private.transition_lifecycle('timesheet', 'app.timesheets', 'timesheet_state', 'app.timesheet_state_transitions',
    'timesheet_id', p_timesheet_id, 'Submitted', p_decision::text, p_reason);
  if p_decision = 'Approved' then
    insert into app.timesheet_approvals (timesheet_id, approved_by, approved_minutes)
    values (p_timesheet_id, v_person, private.timesheet_minutes(p_timesheet_id));
  end if;
  return v_entry;
end;
$$;

comment on function app.decide_timesheet(uuid, app.approval_decision, text) is 'Approves or rejects a submitted timesheet: crew.timesheet.approve on the project, never by its submitter or the worker, member or external (sod_timesheet_submitter, invariant 18). Approval records the minutes approved.';

-- Policies: the engaged person reads their own rows (Section 8.7 operational area) ---------------------------------

call private.install_policies('app.shifts',
  $$project_id in (select private.project_ids_with('crew.shift.read'))
    or membership_id in (select private.my_membership_ids())
    or engagement_id in (select private.my_engagement_ids('operational'))$$,
  $$project_id in (select private.project_ids_with('crew.shift.write'))$$,
  $$project_id in (select private.project_ids_with('crew.shift.write'))
    or membership_id in (select private.my_membership_ids())$$);

call private.install_policies('app.shift_state_transitions',
  $$shift_id in (select s.id from app.shifts s where s.project_id in (select private.project_ids_with('crew.shift.read'))
      or s.membership_id in (select private.my_membership_ids())
      or s.engagement_id in (select private.my_engagement_ids('operational')))$$);

call private.install_policies('app.time_entries',
  $$project_id in (select private.project_ids_with('crew.time_entry.read'))
    or membership_id in (select private.my_membership_ids())
    or engagement_id in (select private.my_engagement_ids('operational'))$$,
  $$project_id in (select private.project_ids_with('crew.time_entry.write'))
    or (membership_id in (select private.my_membership_ids())
        and private.capability_reach(org_id, 'crew.time_entry.write') is not null)$$);

call private.install_policies('app.time_entry_audit',
  $$time_entry_id in (select e.id from app.time_entries e where e.project_id in (select private.project_ids_with('crew.time_entry.read'))
    or e.membership_id in (select private.my_membership_ids())
    or e.engagement_id in (select private.my_engagement_ids('operational')))$$);

call private.install_policies('app.timesheets',
  $$project_id in (select private.project_ids_with('crew.timesheet.read'))
    or membership_id in (select private.my_membership_ids())
    or engagement_id in (select private.my_engagement_ids('operational'))$$,
  $$project_id in (select private.project_ids_with('crew.timesheet.submit'))
    or (membership_id in (select private.my_membership_ids())
        and private.capability_reach(org_id, 'crew.timesheet.submit') is not null)$$);

call private.install_policies('app.timesheet_state_transitions',
  $$timesheet_id in (select t.id from app.timesheets t where t.project_id in (select private.project_ids_with('crew.timesheet.read'))
    or t.membership_id in (select private.my_membership_ids())
    or t.engagement_id in (select private.my_engagement_ids('operational')))$$);

call private.install_policies('app.timesheet_approvals',
  $$timesheet_id in (select t.id from app.timesheets t where t.project_id in (select private.project_ids_with('crew.timesheet.read'))
    or t.membership_id in (select private.my_membership_ids())
    or t.engagement_id in (select private.my_engagement_ids('operational')))$$);

call private.install_policies('app.clock_punches',
  $$project_id in (select private.project_ids_with('crew.time_entry.read'))
    or membership_id in (select private.my_membership_ids())
    or engagement_id in (select private.my_engagement_ids('operational'))$$);
