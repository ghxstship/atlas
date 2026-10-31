-- 2751_roster_time.sql
-- R12 Agency staff on shifts (RRR-190; ADR 0101 R12 amendment). Agency staff record time and submit timesheets through
-- their roster entry (R4), never through a membership or an engagement of their own.
--
--   * app.time_entries (partitioned by A130's 2231), app.timesheets and app.clock_punches gain roster_entry_id. Each
--     *_one_worker check becomes num_nonnulls(membership_id, engagement_id, roster_entry_id) = 1; the tenant guards
--     take the entries pair and t39_*_roster_entry_project checks the entry's engagement is on the row's project. One
--     timesheet per roster entry, project and period start.
--   * Recreated, each from its latest definition (0940), resolving the roster worker through private.roster_people:
--     private.guard_time_entry (the shift names the same entry, the overlap check covers every worker column,
--     roster_entry_id is immutable, and new time needs the entry's engagement Active or Closing and the entry live and
--     not Withdrawn: roster_entry_not_working), private.guard_timesheet, private.timesheet_minutes,
--     private.void_timesheet_approvals, app.timesheet_hours, app.submit_timesheet (the entry's person or the
--     agency's lead submits) and app.decide_timesheet (the approver is never the worker). private.worker_minutes and
--     private.worker_has_open_entry gain overloads with the roster entry; the two-worker versions stay.
--   * app.record_punch (latest 1321) is split, with its signature unchanged. private.apply_punch holds the replay,
--     skew, photo, geofence, shift, rounding and time-entry logic for a worker already resolved; R12's parity
--     addition (2754) calls it for a supervisor's team punches. app.record_punch resolves the worker: a member, an
--     engaged external, or, when neither is named and p_shift_id is a live shift of a roster entry, that entry: on
--     Mobile only its person while the entry is operational (my_roster_entry_ids('operational')), on a kiosk the
--     kiosk service. It still refuses any source but Mobile from a signed-in caller (punch_source_mobile).
--     In apply_punch the geofence rule (time.geofence_required) applies to Mobile and Supervisor clock-ins, a
--     Supervisor punch may land on a Published or Accepted shift of the same worker (crews without the app cannot
--     accept their shifts) and every other punch on an Accepted one, and a Supervisor punch writes the time entry's
--     source as Mobile: app.time_entry_source and its frozen API label stay Web, Mobile and Kiosk, while
--     app.clock_punches.source keeps Supervisor, which is where Clocked by is read.
--   * api_external.time_entries and api_external.timesheets (1000, the first recreated by 2231) append
--     roster_entry_id and admit the caller's operational roster entries.

-- Columns ------------------------------------------------------------------------------------------------------------------

alter table app.time_entries add column roster_entry_id uuid references app.engagement_roster_entries (id);
alter table app.timesheets add column roster_entry_id uuid references app.engagement_roster_entries (id);
alter table app.clock_punches add column roster_entry_id uuid references app.engagement_roster_entries (id);

create index time_entries_roster_entry_id_idx on app.time_entries (roster_entry_id, clock_in);
create index timesheets_roster_entry_id_idx on app.timesheets (roster_entry_id, period_start);
create index clock_punches_roster_entry_id_idx on app.clock_punches (roster_entry_id, effective_at);

alter table app.time_entries drop constraint time_entries_one_worker;
alter table app.timesheets drop constraint timesheets_one_worker;
alter table app.clock_punches drop constraint clock_punches_one_worker;
alter table app.time_entries add constraint time_entries_one_worker check (num_nonnulls(membership_id, engagement_id, roster_entry_id) = 1);
alter table app.timesheets add constraint timesheets_one_worker check (num_nonnulls(membership_id, engagement_id, roster_entry_id) = 1);
alter table app.clock_punches add constraint clock_punches_one_worker check (num_nonnulls(membership_id, engagement_id, roster_entry_id) = 1);

create unique index timesheets_one_per_roster_entry_period on app.timesheets (project_id, roster_entry_id, period_start)
  where roster_entry_id is not null and deleted_at is null;

comment on column app.time_entries.roster_entry_id is 'Roster entry (R4) of the agency staff member who worked, when they work through a staffing agency''s roster (R12). Exactly one of membership_id, engagement_id and roster_entry_id.';
comment on column app.timesheets.roster_entry_id is 'Roster entry (R4) of the agency staff member whose time it is (R12). Exactly one of membership_id, engagement_id and roster_entry_id.';
comment on column app.clock_punches.roster_entry_id is 'Roster entry (R4) of the agency staff member who was punched (R12). Exactly one of membership_id, engagement_id and roster_entry_id.';

-- The month partitions made before this column carry the parent's comment too, as private.create_month_partition
-- gives the ones made later.
do $$
declare
  v_partition regclass;
begin
  for v_partition in select i.inhrelid::regclass from pg_catalog.pg_inherits i where i.inhparent = 'app.time_entries'::regclass loop
    execute format('comment on column %s.roster_entry_id is %L', v_partition,
      col_description('app.time_entries'::regclass, (select a.attnum from pg_catalog.pg_attribute a
        where a.attrelid = 'app.time_entries'::regclass and a.attname = 'roster_entry_id')));
  end loop;
end;
$$;

call private.install_tenant_guards('app.time_entries', 'app.projects', 'project_id',
  array['app.memberships', 'membership_id', 'app.shifts', 'shift_id', 'app.engagements', 'engagement_id',
        'app.engagement_roster_entries', 'roster_entry_id']);
call private.install_tenant_guards('app.timesheets', 'app.projects', 'project_id',
  array['app.memberships', 'membership_id', 'app.engagements', 'engagement_id', 'app.engagement_roster_entries', 'roster_entry_id']);
call private.install_tenant_guards('app.clock_punches', 'app.projects', 'project_id',
  array['app.memberships', 'membership_id', 'app.shifts', 'shift_id', 'app.time_entries', 'time_entry_id',
        'app.geofences', 'geofence_id', 'app.kiosk_devices', 'kiosk_device_id', 'app.engagements', 'engagement_id',
        'app.engagement_roster_entries', 'roster_entry_id']);

create trigger t39_time_entry_roster_entry_project before insert or update of roster_entry_id on app.time_entries
  for each row execute function private.assert_roster_entry_project();
create trigger t39_timesheet_roster_entry_project before insert or update of roster_entry_id on app.timesheets
  for each row execute function private.assert_roster_entry_project();
create trigger t39_clock_punch_roster_entry_project before insert on app.clock_punches
  for each row execute function private.assert_roster_entry_project();

-- Is a roster entry working? ------------------------------------------------------------------------------------------------

create or replace function private.roster_entry_working(p_roster_entry_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from app.engagement_roster_entries r
    join app.engagements e on e.id = r.engagement_id and e.deleted_at is null
    where r.id = p_roster_entry_id and r.deleted_at is null and r.entry_state <> 'Withdrawn'
      and e.engagement_state in ('Active', 'Closing'));
$$;

comment on function private.roster_entry_working(uuid) is 'R12: true while a roster entry may take new time: the entry is live and not Withdrawn, and its engagement is Active or Closing.';
revoke all on function private.roster_entry_working(uuid) from public, anon, authenticated;

-- Time entries (latest: 0940) ----------------------------------------------------------------------------------------------

create or replace function private.guard_time_entry()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.worker_person_id(new.membership_id, new.engagement_id, new.roster_entry_id);
begin
  if tg_op = 'INSERT' then
    perform private.assert_production_open(new.project_id);
    if auth.uid() is not null and new.membership_id in (select private.my_membership_ids())
       and not private.can_on_project(new.project_id, 'crew.time_entry.write')
       and not (new.project_id in (select private.my_project_ids())
                or exists (select 1 from app.shifts s where s.project_id = new.project_id and s.membership_id = new.membership_id and s.deleted_at is null)) then
      perform private.refuse('time_entry_project', 'A person records time only on projects they belong to or have a shift on.');
    end if;
    if new.roster_entry_id is not null and (v_person is null or not private.roster_entry_working(new.roster_entry_id)) then
      perform private.refuse('roster_entry_not_working', 'Agency staff record time only while their roster entry stands and its engagement is Active or Closing.');
    end if;
  elsif new.membership_id is distinct from old.membership_id or new.project_id <> old.project_id
        or new.roster_entry_id is distinct from old.roster_entry_id then
    perform private.refuse('time_entry_immutable', 'A time entry keeps its person and project.');
  end if;
  if new.shift_id is not null and not exists (
    select 1 from app.shifts s where s.id = new.shift_id and s.project_id = new.project_id
      and s.membership_id is not distinct from new.membership_id and s.engagement_id is not distinct from new.engagement_id
      and s.roster_entry_id is not distinct from new.roster_entry_id) then
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
             or t.engagement_id in (select g.id from app.engagements g where g.person_id = v_person)
             or t.roster_entry_id in (select rp.roster_entry_id from private.roster_people rp where rp.person_id = v_person))
        and tstzrange(t.clock_in, coalesce(t.clock_out, 'infinity')) && tstzrange(new.clock_in, coalesce(new.clock_out, 'infinity'))
    ) then
      perform private.refuse('time_entry_overlap', 'Time entries of one person cannot overlap.');
    end if;
  end if;
  return new;
end;
$$;

comment on function private.guard_time_entry() is 'Time entries: no new entry on a closed production (invariant 10), a member''s own entries only on their projects or shifts, new agency time only on a standing roster entry of an Active or Closing engagement (roster_entry_not_working, R12), shift of the same worker and project, and no overlap for one person within the org whether they work through a membership, an engagement or a roster entry (invariant 20, serialized per person).';

create or replace function private.guard_timesheet()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.submitted_by := null;
    if new.roster_entry_id is not null and not private.roster_entry_working(new.roster_entry_id) then
      perform private.refuse('roster_entry_not_working', 'Agency staff record time only while their roster entry stands and its engagement is Active or Closing.');
    end if;
  elsif new.project_id <> old.project_id or new.membership_id is distinct from old.membership_id
        or new.engagement_id is distinct from old.engagement_id or new.roster_entry_id is distinct from old.roster_entry_id
        or ((new.period_start <> old.period_start or new.period_end <> old.period_end) and old.timesheet_state <> 'Proposed') then
    perform private.refuse('timesheet_immutable', 'A timesheet keeps its project and person, and its period once submitted.');
  elsif new.submitted_by is distinct from old.submitted_by and not private.in_trusted_operation('timesheet_transition') then
    perform private.refuse('timesheet_submitter', 'The submitter is recorded by app.submit_timesheet.');
  end if;
  return new;
end;
$$;

comment on function private.guard_timesheet() is 'Timesheets keep their project and worker (membership, engagement or roster entry), their period once submitted, and a submitter set only by submission; an agency staff member''s timesheet opens only on a working roster entry (R12).';

-- Minutes and open entries for any worker ------------------------------------------------------------------------------------

create or replace function private.worker_minutes(p_membership_id uuid, p_engagement_id uuid, p_roster_entry_id uuid, p_project_id uuid, p_from date, p_to date)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(greatest(0, (extract(epoch from (e.clock_out - e.clock_in)) / 60)::integer - e.break_minutes)), 0)::integer
  from app.time_entries e
  where e.membership_id is not distinct from p_membership_id and e.engagement_id is not distinct from p_engagement_id
    and e.roster_entry_id is not distinct from p_roster_entry_id
    and e.project_id = p_project_id and e.deleted_at is null
    and e.clock_out is not null and e.clock_in >= p_from::timestamptz and e.clock_in < (p_to + 1)::timestamptz;
$$;

comment on function private.worker_minutes(uuid, uuid, uuid, uuid, date, date) is 'Worked minutes of a worker (membership, engagement or roster entry, R12) on a project for a date range: closed entries clocked in during the range, less breaks.';
revoke all on function private.worker_minutes(uuid, uuid, uuid, uuid, date, date) from public, anon, authenticated;
grant execute on function private.worker_minutes(uuid, uuid, uuid, uuid, date, date) to authenticated, service_role;

create or replace function private.worker_has_open_entry(p_membership_id uuid, p_engagement_id uuid, p_roster_entry_id uuid, p_project_id uuid, p_from date, p_to date)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from app.time_entries e
    where e.membership_id is not distinct from p_membership_id and e.engagement_id is not distinct from p_engagement_id
      and e.roster_entry_id is not distinct from p_roster_entry_id
      and e.project_id = p_project_id and e.deleted_at is null
      and e.clock_out is null and e.clock_in >= p_from::timestamptz and e.clock_in < (p_to + 1)::timestamptz);
$$;

comment on function private.worker_has_open_entry(uuid, uuid, uuid, uuid, date, date) is 'True while a worker (membership, engagement or roster entry, R12) has an entry without a clock out on a project in a date range.';
revoke all on function private.worker_has_open_entry(uuid, uuid, uuid, uuid, date, date) from public, anon, authenticated;
grant execute on function private.worker_has_open_entry(uuid, uuid, uuid, uuid, date, date) to authenticated, service_role;

create or replace function private.timesheet_minutes(p_timesheet_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select private.worker_minutes(t.membership_id, t.engagement_id, t.roster_entry_id, t.project_id, t.period_start, t.period_end)
  from app.timesheets t where t.id = p_timesheet_id;
$$;

comment on function private.timesheet_minutes(uuid) is 'Worked minutes of a timesheet, for RPCs, whichever worker column it names.';
revoke all on function private.timesheet_minutes(uuid) from public, anon, authenticated;

create or replace view app.timesheet_hours with (security_invoker = true) as
select t.id as timesheet_id, t.project_id, t.membership_id,
  private.worker_minutes(t.membership_id, t.engagement_id, t.roster_entry_id, t.project_id, t.period_start, t.period_end) as worked_minutes,
  private.worker_has_open_entry(t.membership_id, t.engagement_id, t.roster_entry_id, t.project_id, t.period_start, t.period_end) as has_open_entry,
  t.engagement_id,
  t.roster_entry_id
from app.timesheets t
where t.deleted_at is null;

comment on column app.timesheet_hours.roster_entry_id is 'Roster entry of the agency staff member, when the timesheet is theirs (R12).';

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
      and t.roster_entry_id is not distinct from v_row.roster_entry_id
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

comment on function private.void_timesheet_approvals() is 'Invariant 19: when a time entry inside an approved timesheet changes, the approval is voided and the timesheet returns to Proposed for resubmission, whichever worker column the timesheet names.';
revoke all on function private.void_timesheet_approvals() from public, anon, authenticated;

-- Submission and approval (latest: 0940) ------------------------------------------------------------------------------------------

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
    or (v_sheet.roster_entry_id in (select private.my_roster_entry_ids('operational'))
        and private.roster_entry_person(v_sheet.roster_entry_id) = v_person)
    or (v_sheet.roster_entry_id is not null and private.roster_entry_lead(v_sheet.roster_entry_id))
    or private.can_on_project(v_sheet.project_id, 'crew.timesheet.submit')) then
    raise exception using errcode = '42501', message = 'crew.timesheet.submit is required';
  end if;
  if private.worker_has_open_entry(v_sheet.membership_id, v_sheet.engagement_id, v_sheet.roster_entry_id, v_sheet.project_id,
       v_sheet.period_start, v_sheet.period_end) then
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

comment on function app.submit_timesheet(uuid, text) is 'Submits a drafted or rejected timesheet with no open entries; the worker (own reach, the engaged person while their operational access is open, or the agency staff member on an operational roster entry, R12), the staffing agency''s lead or a project submitter may. Records the submitter.';

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
  v_entry := private.transition_lifecycle('timesheet', 'app.timesheets', 'timesheet_state', 'app.timesheet_state_transitions',
    'timesheet_id', p_timesheet_id, 'Submitted', p_decision::text, p_reason);
  if p_decision = 'Approved' then
    insert into app.timesheet_approvals (timesheet_id, approved_by, approved_minutes)
    values (p_timesheet_id, v_person, private.timesheet_minutes(p_timesheet_id));
  end if;
  return v_entry;
end;
$$;

comment on function app.decide_timesheet(uuid, app.approval_decision, text) is 'Approves or rejects a submitted timesheet: crew.timesheet.approve on the project, never by its submitter or the worker, member, external or agency staff member (sod_timesheet_submitter, invariant 18). Approval records the minutes approved.';

-- Punches (latest: 1321) --------------------------------------------------------------------------------------------------------

create or replace function private.apply_punch(
  p_punch_id uuid,
  p_project_id uuid,
  p_punch_kind app.punch_kind,
  p_device_time timestamptz,
  p_monotonic_offset_ms bigint,
  p_shift_id uuid,
  p_latitude numeric,
  p_longitude numeric,
  p_accuracy_m numeric,
  p_geofence_id uuid,
  p_source app.punch_source,
  p_kiosk_device_id uuid,
  p_photo_uri text,
  p_membership_id uuid,
  p_engagement_id uuid,
  p_roster_entry_id uuid
)
returns app.clock_punches
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_project app.projects;
  v_worker_person uuid := private.worker_person_id(p_membership_id, p_engagement_id, p_roster_entry_id);
  v_existing app.clock_punches;
  v_received timestamptz := now();
  v_reference timestamptz;
  v_effective timestamptz;
  v_skewed boolean;
  v_verified boolean;
  v_entry app.time_entries;
  v_break_start timestamptz;
  v_opened_at timestamptz;
  v_rounding integer;
  v_clock_out timestamptz;
  v_punch app.clock_punches;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('clock_punch:' || p_punch_id::text, 0));
  select * into v_project from app.projects p where p.id = p_project_id and p.deleted_at is null;

  -- Replay
  select * into v_existing from app.clock_punches c where c.id = p_punch_id;
  if v_existing.id is not null then
    if v_existing.membership_id is not distinct from p_membership_id and v_existing.engagement_id is not distinct from p_engagement_id
       and v_existing.roster_entry_id is not distinct from p_roster_entry_id and v_existing.punch_kind = p_punch_kind then
      return v_existing;
    end if;
    perform private.refuse('punch_id_conflict', 'This punch id was already used for another punch; generate a new id.');
  end if;

  -- Photo on punch (time.photo_on_punch): kiosk clock-ins and clock-outs carry a photo while the project asks for one.
  if p_source = 'Kiosk' and p_punch_kind in ('In', 'Out') and p_photo_uri is null
     and coalesce(private.project_setting_boolean(p_project_id, 'time.photo_on_punch'), false) then
    perform private.refuse('punch_photo_required', 'This project asks for a photo at every kiosk clock-in and clock-out.');
  end if;

  -- Time the punch counts at
  if p_device_time is null then
    perform private.refuse('punch_device_time_required', 'A punch carries the device time it was made at.');
  end if;
  if p_monotonic_offset_ms is not null then
    v_reference := v_received - make_interval(secs => p_monotonic_offset_ms / 1000.0);
    v_skewed := abs(extract(epoch from (p_device_time - v_reference))) > 120;
    v_effective := case when v_skewed then v_reference else p_device_time end;
  else
    v_skewed := p_device_time > v_received + interval '2 minutes' or p_device_time < v_received - interval '72 hours';
    v_effective := case when v_skewed then v_received else p_device_time end;
  end if;
  v_rounding := coalesce(nullif(private.project_setting_text(p_project_id, 'time.rounding_minutes'), '')::integer, 0);

  -- Geofence and shift
  if p_geofence_id is not null and p_latitude is not null and p_longitude is not null then
    select extensions.st_covers(g.boundary, extensions.st_setsrid(extensions.st_makepoint(p_longitude::double precision, p_latitude::double precision), 4326)::extensions.geography)
    into v_verified from app.geofences g where g.id = p_geofence_id and g.org_id = v_project.org_id and g.deleted_at is null;
  end if;
  if p_shift_id is not null and not exists (
    select 1 from app.shifts s
    where s.id = p_shift_id and s.project_id = p_project_id and s.deleted_at is null
      and (s.shift_state = 'Accepted' or (p_source::text = 'Supervisor' and s.shift_state = 'Published'))
      and s.membership_id is not distinct from p_membership_id and s.engagement_id is not distinct from p_engagement_id
      and s.roster_entry_id is not distinct from p_roster_entry_id) then
    perform private.refuse('punch_shift_not_accepted', 'Punch on a shift only once it is yours and Accepted.');
  end if;

  -- The worker's open entry in the org
  select t.* into v_entry from app.time_entries t
  where t.org_id = v_project.org_id and t.clock_out is null and t.deleted_at is null
    and (t.membership_id in (select m.id from app.memberships m where m.person_id = v_worker_person)
         or t.engagement_id in (select g.id from app.engagements g where g.person_id = v_worker_person)
         or t.roster_entry_id in (select rp.roster_entry_id from private.roster_people rp where rp.person_id = v_worker_person))
  order by t.clock_in desc limit 1 for update;

  if p_punch_kind = 'In' then
    if v_entry.id is not null then
      perform private.refuse('punch_already_in', 'You are already clocked in; clock out first.');
    end if;
    -- Geofence required (time.geofence_required): a phone clock-in, the worker's own or a supervisor's for the team,
    -- happens inside the project's geofence.
    if p_source::text in ('Mobile', 'Supervisor') then
      perform private.refuse_clock_in_geofence(private.project_clock_in_geofence(p_project_id, p_latitude, p_longitude, p_geofence_id));
    end if;
    insert into app.time_entries (project_id, membership_id, engagement_id, roster_entry_id, shift_id, clock_in, source, kiosk_device_id, needs_review)
    values (p_project_id, p_membership_id, p_engagement_id, p_roster_entry_id, p_shift_id, private.round_punch_time(v_effective, v_rounding),
            (case when p_source::text = 'Supervisor' then 'Mobile' else p_source::text end)::app.time_entry_source, p_kiosk_device_id, v_skewed)
    returning * into v_entry;
  else
    if v_entry.id is null then
      perform private.refuse('punch_not_in', 'You are not clocked in.');
    end if;
    select c.effective_at into v_break_start from app.clock_punches c
    where c.time_entry_id = v_entry.id and c.punch_kind in ('Break Start', 'Break End')
    order by c.effective_at desc, c.received_at desc limit 1;
    if v_break_start is not null and (select c.punch_kind from app.clock_punches c
        where c.time_entry_id = v_entry.id and c.punch_kind in ('Break Start', 'Break End')
        order by c.effective_at desc, c.received_at desc limit 1) = 'Break End' then
      v_break_start := null;
    end if;
    -- A rounded clock-in may sit after the exact one, so later punches compare with the earlier of the entry's
    -- clock-in and the exact In punch.
    v_opened_at := least(v_entry.clock_in, (select c.effective_at from app.clock_punches c
      where c.time_entry_id = v_entry.id and c.punch_kind = 'In' order by c.received_at limit 1));
    if v_effective <= v_opened_at then
      perform private.refuse('punch_before_clock_in', 'A punch counts after the entry''s clock in.');
    end if;
    if p_punch_kind = 'Break Start' then
      if v_break_start is not null then
        perform private.refuse('punch_break_open', 'A break is already running; end it first.');
      end if;
      update app.time_entries set needs_review = needs_review or v_skewed where id = v_entry.id;
    elsif p_punch_kind = 'Break End' then
      if v_break_start is null then
        perform private.refuse('punch_no_break', 'No break is running.');
      end if;
      update app.time_entries
      set break_minutes = break_minutes + greatest(0, ceil(extract(epoch from (v_effective - v_break_start)) / 60)::integer),
          needs_review = needs_review or v_skewed
      where id = v_entry.id;
    else
      v_clock_out := private.round_punch_time(v_effective, v_rounding);
      if v_clock_out <= v_entry.clock_in then
        v_clock_out := greatest(v_effective, v_entry.clock_in + interval '1 minute');
      end if;
      update app.time_entries
      set clock_out = v_clock_out,
          break_minutes = break_minutes + case when v_break_start is null then 0
                                               else greatest(0, ceil(extract(epoch from (v_effective - v_break_start)) / 60)::integer) end,
          needs_review = needs_review or v_skewed
      where id = v_entry.id;
    end if;
  end if;

  insert into app.clock_punches (id, project_id, membership_id, engagement_id, roster_entry_id, shift_id, time_entry_id, punch_kind,
    device_time, monotonic_offset_ms, received_at, effective_at, latitude, longitude, accuracy_m, geofence_id, geofence_verified,
    skew_flagged, source, kiosk_device_id, photo_uri)
  values (p_punch_id, p_project_id, p_membership_id, p_engagement_id, p_roster_entry_id, coalesce(p_shift_id, v_entry.shift_id),
    v_entry.id, p_punch_kind, p_device_time, p_monotonic_offset_ms, v_received, v_effective, p_latitude, p_longitude, p_accuracy_m,
    p_geofence_id, case when p_geofence_id is null then null else v_verified end, v_skewed, p_source, p_kiosk_device_id, p_photo_uri)
  returning * into v_punch;
  return v_punch;
end;
$$;

comment on function private.apply_punch(uuid, uuid, app.punch_kind, timestamptz, bigint, uuid, numeric, numeric, numeric, uuid, app.punch_source, uuid, text, uuid, uuid, uuid) is 'Records one clock punch for a worker the caller already resolved and authorized (exactly one of a membership, an engagement or a roster entry) and applies it to the worker''s time entry, exactly once per client punch id: the body of app.record_punch since 1321, split out by R12 so app.record_supervisor_punches (2754) shares it. Replay and punch_id_conflict, the 2-minute skew tolerance, time.photo_on_punch on kiosk punches, time.geofence_required on Mobile and Supervisor clock-ins, a shift of the same worker that is Accepted (or Published, for a Supervisor punch), punch_already_in, breaks, and time.rounding_minutes. A Supervisor punch writes its time entry as Mobile; the punch keeps Supervisor.';
revoke all on function private.apply_punch(uuid, uuid, app.punch_kind, timestamptz, bigint, uuid, numeric, numeric, numeric, uuid, app.punch_source, uuid, text, uuid, uuid, uuid) from public, anon, authenticated;

create or replace function app.record_punch(
  p_punch_id uuid,
  p_project_id uuid,
  p_punch_kind app.punch_kind,
  p_device_time timestamptz,
  p_monotonic_offset_ms bigint default null,
  p_shift_id uuid default null,
  p_latitude numeric default null,
  p_longitude numeric default null,
  p_accuracy_m numeric default null,
  p_geofence_id uuid default null,
  p_source app.punch_source default 'Mobile',
  p_kiosk_device_id uuid default null,
  p_photo_uri text default null,
  p_membership_id uuid default null,
  p_engagement_id uuid default null
)
returns app.clock_punches
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.current_person_id();
  v_service boolean := auth.uid() is null;
  v_project app.projects;
  v_membership uuid;
  v_engagement uuid;
  v_roster uuid;
begin
  if p_punch_id is null then
    perform private.refuse('punch_id_required', 'Every punch carries its client punch id.');
  end if;
  if not v_service and v_person is null then
    raise exception using errcode = '42501', message = 'a signed-in person or the kiosk service records punches';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('clock_punch:' || p_punch_id::text, 0));

  -- Worker
  select * into v_project from app.projects p where p.id = p_project_id and p.deleted_at is null;
  if v_project.id is null then
    raise exception using errcode = '42501', message = 'the project is not visible';
  end if;
  if p_membership_id is null and p_engagement_id is null and p_shift_id is not null then
    select s.roster_entry_id into v_roster from app.shifts s
    where s.id = p_shift_id and s.project_id = p_project_id and s.deleted_at is null;
  end if;
  if v_service then
    if p_source <> 'Kiosk' or p_kiosk_device_id is null
       or (num_nonnulls(p_membership_id, p_engagement_id) <> 1 and v_roster is null) then
      perform private.refuse('punch_kiosk_worker', 'A kiosk punch names its kiosk and exactly one membership or engagement, or the shift of a roster entry.');
    end if;
    v_membership := p_membership_id;
    v_engagement := p_engagement_id;
  else
    if p_source <> 'Mobile' then
      perform private.refuse('punch_source_mobile', 'A signed-in device records Mobile punches; kiosk punches come from the kiosk service.');
    end if;
    if v_roster is not null then
      if v_roster not in (select private.my_roster_entry_ids('operational'))
         or private.roster_entry_person(v_roster) is distinct from v_person then
        raise exception using errcode = '42501', message = 'only the person on the roster entry punches on its shift while it is operational';
      end if;
    elsif p_engagement_id is not null then
      if p_engagement_id not in (select private.my_engagement_ids('operational'))
         or private.worker_person_id(null, p_engagement_id) is distinct from v_person then
        raise exception using errcode = '42501', message = 'only the engaged person punches on their engagement while it is open';
      end if;
      v_engagement := p_engagement_id;
    else
      select m.id into v_membership from app.memberships m
      where m.person_id = v_person and m.org_id = v_project.org_id and m.deleted_at is null
        and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now());
      if v_membership is null or (p_membership_id is not null and p_membership_id <> v_membership) then
        raise exception using errcode = '42501', message = 'a person punches only for themselves in an org they belong to';
      end if;
    end if;
  end if;

  return private.apply_punch(p_punch_id, p_project_id, p_punch_kind, p_device_time, p_monotonic_offset_ms, p_shift_id,
    p_latitude, p_longitude, p_accuracy_m, p_geofence_id, p_source, p_kiosk_device_id, p_photo_uri,
    v_membership, v_engagement, v_roster);
end;
$$;

comment on function app.record_punch(uuid, uuid, app.punch_kind, timestamptz, bigint, uuid, numeric, numeric, numeric, uuid, app.punch_source, uuid, text, uuid, uuid) is 'Records one clock punch exactly once and applies it to the worker''s time entry: In opens one (refused while one is open, punch_already_in), Break Start and Break End add the break, Out closes it. Idempotent on the client punch id. The device time counts within a 2-minute skew tolerance (corrected by the monotonic offset when given); otherwise the server time counts, the punch is skew_flagged and the entry needs review. The server checks the geofence. The project''s time settings apply (1321): a phone clock-in inside the geofence while time.geofence_required, a photo on kiosk clock-ins and clock-outs while time.photo_on_punch, and entry times rounded by time.rounding_minutes. Members punch for themselves, engaged externals on their open engagement, agency staff on the shift of their operational roster entry with neither named (R12), and the kiosk service (service role) for the member, engagement or roster shift it verified. Signed-in callers record Mobile punches only (punch_source_mobile). The worker is resolved here and the punch applied by private.apply_punch.';

-- External time views (latest: 1000, the first recreated by 2231) ------------------------------------------------------------------

create or replace view api_external.time_entries as
select t.id, t.engagement_id, t.project_id, t.shift_id, t.clock_in, t.clock_out, t.break_minutes, t.source, t.roster_entry_id
from app.time_entries t
where t.deleted_at is null
  and (t.engagement_id in (select private.my_engagement_ids('operational'))
    or t.roster_entry_id in (select private.my_roster_entry_ids('operational')));

comment on view api_external.time_entries is 'Time worked under the caller''s engagements, or on their roster entries (R12), while the operational area is open. Recorded through app.record_punch.';
comment on column api_external.time_entries.roster_entry_id is 'Roster entry the agency staff member worked under (R12); NULL otherwise.';

create or replace view api_external.timesheets as
select ts.id, ts.engagement_id, ts.project_id, p.name as project_name, ts.period_start, ts.period_end, ts.timesheet_state,
  private.external_timesheet_minutes(ts.id) as worked_minutes,
  (select max(t.created_at) from app.timesheet_state_transitions t where t.timesheet_id = ts.id and t.to_state = 'Submitted') as submitted_at,
  (select max(t.created_at) from app.timesheet_state_transitions t where t.timesheet_id = ts.id and t.to_state in ('Approved', 'Rejected')) as decided_at,
  ts.roster_entry_id
from app.timesheets ts
join app.projects p on p.id = ts.project_id
where ts.deleted_at is null
  and (ts.engagement_id in (select private.my_engagement_ids('operational'))
    or ts.roster_entry_id in (select private.my_roster_entry_ids('operational')));

comment on view api_external.timesheets is 'Timesheets of the caller''s engagements, or of their roster entries (R12), with minutes derived from their time entries, while the operational area is open. Submitted through app.submit_timesheet.';
comment on column api_external.timesheets.roster_entry_id is 'Roster entry of the agency staff member whose timesheet it is (R12); NULL otherwise.';

-- External punches (latest: 1022) --------------------------------------------------------------------------------------------------

create or replace view api_external.clock_punches as
select c.id, c.engagement_id, c.project_id, c.shift_id, c.time_entry_id, c.punch_kind, c.device_time, c.effective_at,
  c.geofence_verified, c.skew_flagged, c.source, c.roster_entry_id
from app.clock_punches c
where c.deleted_at is null
  and (c.engagement_id in (select private.my_engagement_ids('operational'))
    or c.roster_entry_id in (select private.my_roster_entry_ids('operational'))
    or private.roster_entry_lead(c.roster_entry_id));

comment on view api_external.clock_punches is 'The caller''s own clock punches under their engagements or roster entries while the operational area is open, so Compass shows the clock state offline, and the punches of a staffing agency''s roster staff for its leads, who clock the team in (R12). Location, photo and kiosk device never appear. Recorded through app.record_punch and app.record_supervisor_punches.';
comment on column api_external.clock_punches.roster_entry_id is 'Roster entry punched under (R12); NULL otherwise.';
