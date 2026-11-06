-- 2985_break_types.sql
-- B9 (RRR-233; ADR 0148 decision 4; parity gap G-127, after A134's earning codes): org-defined break types, paid or
-- unpaid. A break type is data on the Break Start punch; app.punch_kind keeps its four values.
--
--   * app.break_types: name (unique live per org), paid or unpaid, planned minutes, and at most one default per org.
--     Read by the org's members; external workers read api_external.break_types. Written with
--     org.time_attendance.write on Settings, Time and Attendance; app.set_default_break_type moves the default in one
--     step, and retiring the default clears it, so a restored type comes back as not the default.
--   * app.clock_punches.break_type_id, set only on a Break Start.
--   * app.time_entries.paid_break_minutes: a paid break is worked time. Its minutes are kept here and never subtracted,
--     so every payroll and compliance formula that subtracts break_minutes (0340, 0461, 0463, 0940, 1384, 1385, 1386,
--     1398, 1399, 2271, 2751's private.worker_minutes, and P8's 2854 if it has merged) is correct unchanged.
--     break_minutes stays the unpaid break. A time entry correction (0340 proposed_break_minutes) changes break_minutes
--     only and keeps paid_break_minutes.
--   * private.apply_punch (from 2751) takes a 17th argument p_break_type_id: a Break Start resolves it, else the org's
--     default type, else none (today's behavior), refusing break_type_unknown for another org's or a retired type; a
--     Break End, or an Out closing a running break, adds the minutes to paid_break_minutes for a paid type and to
--     break_minutes otherwise. app.record_supervisor_punches (2754) calls it positionally and keeps working with the
--     org default; it is not redefined. app.record_punch (from 2751) takes p_break_type_id last and passes it through.
-- No org has a break type until it adds one, so punches behave exactly as before.

-- Break types --------------------------------------------------------------------------------------------------------------------

create table app.break_types (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  name text not null,
  paid boolean not null default false,
  planned_minutes smallint,
  is_default boolean not null default false,
  constraint break_types_name_length check (char_length(btrim(name)) between 1 and 80),
  constraint break_types_planned_minutes check (planned_minutes is null or planned_minutes between 1 and 240)
);

call private.install_domain_table('app.break_types');
create unique index break_types_name_key on app.break_types (org_id, lower(btrim(name))) where deleted_at is null;
create unique index break_types_one_default on app.break_types (org_id) where is_default and deleted_at is null;

call private.describe('app.break_types', 'The kinds of break an org''s crew take (Section 4.5.6 item 24, B9): a meal break, a rest break and the like, each paid or unpaid. A Break Start punch names one; a paid break''s minutes are worked time (app.time_entries.paid_break_minutes). Read by the org''s members (externals through api_external.break_types); written by holders of org.time_attendance.write.', array[
  'name', 'Name crew pick the break by, unique among the org''s live types.',
  'paid', 'True when the break is paid: its minutes count as worked time and are never subtracted.',
  'planned_minutes', 'How long the break usually is, in minutes (1 to 240); null when it varies.',
  'is_default', 'The type a break takes when none is chosen (Compass''s Live Activity, the kiosk and a supervisor''s team punch). At most one live default per org.'
]);

create or replace function private.guard_break_type()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Retiring the default clears it; a restored type comes back as not the default.
  if new.deleted_at is not null then
    new.is_default := false;
  end if;
  return new;
end;
$$;

comment on function private.guard_break_type() is 'B9: a retired break type is never the default, so restoring it never makes two defaults.';
revoke all on function private.guard_break_type() from public, anon, authenticated;

create trigger t36_guard_break_type before insert or update on app.break_types
  for each row execute function private.guard_break_type();

call private.install_policies('app.break_types',
  $$org_id in (select private.my_org_ids())$$,
  $$private.has_capability(org_id, 'org.time_attendance.write')$$);
call private.install_default_retention('app.break_types');
call private.install_audit_trail('app.break_types');

create or replace function app.set_default_break_type(p_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_type app.break_types;
begin
  perform private.require_person();
  select * into v_type from app.break_types b where b.id = p_id and b.deleted_at is null for update;
  if v_type.id is null or not private.has_capability(v_type.org_id, 'org.time_attendance.write') then
    raise exception using errcode = '42501', message = 'org.time_attendance.write is required to choose the default break type';
  end if;
  update app.break_types set is_default = false where org_id = v_type.org_id and is_default and id <> v_type.id;
  update app.break_types set is_default = true where id = v_type.id;
  return v_type.id;
end;
$$;

comment on function app.set_default_break_type(uuid) is 'Makes a live break type the org''s default in one step (B9): the previous default is cleared first, so the one-default index always holds. Needs org.time_attendance.write. Returns the type id.';
revoke all on function app.set_default_break_type(uuid) from public, anon;
grant execute on function app.set_default_break_type(uuid) to authenticated, service_role;

-- Punches carry their break type ----------------------------------------------------------------------------------------------------

alter table app.clock_punches add column break_type_id uuid references app.break_types (id);
alter table app.clock_punches add constraint clock_punches_break_type check (break_type_id is null or punch_kind = 'Break Start');
create index clock_punches_break_type_id_idx on app.clock_punches (break_type_id);
comment on column app.clock_punches.break_type_id is 'Break type of a Break Start punch (B9): the one chosen, else the org''s default; null for every other punch and when the org has no break type.';

-- 2751's references with the break type added.
call private.install_tenant_guards('app.clock_punches', 'app.projects', 'project_id',
  array['app.memberships', 'membership_id', 'app.shifts', 'shift_id', 'app.time_entries', 'time_entry_id',
        'app.geofences', 'geofence_id', 'app.kiosk_devices', 'kiosk_device_id', 'app.engagements', 'engagement_id',
        'app.engagement_roster_entries', 'roster_entry_id', 'app.break_types', 'break_type_id']);

comment on type app.punch_kind is 'Kinds of clock punch: In opens a time entry, Break Start and Break End bracket a break of one of the org''s break types (unpaid unless its type is paid, B9), Out closes the entry.';

alter table app.time_entries add column paid_break_minutes integer not null default 0;
alter table app.time_entries add constraint time_entries_paid_break_nonnegative check (paid_break_minutes >= 0);
comment on column app.time_entries.paid_break_minutes is 'Minutes of paid breaks taken during the entry (B9): worked time, never subtracted from the hours. break_minutes stays the unpaid break.';

-- The month partitions made before this column carry the parent's comment too, as private.create_month_partition gives
-- the ones made later (the shape of 2751).
do $$
declare
  v_partition regclass;
begin
  for v_partition in select i.inhrelid::regclass from pg_catalog.pg_inherits i where i.inhparent = 'app.time_entries'::regclass loop
    execute format('comment on column %s.paid_break_minutes is %L', v_partition,
      col_description('app.time_entries'::regclass, (select a.attnum from pg_catalog.pg_attribute a
        where a.attrelid = 'app.time_entries'::regclass and a.attname = 'paid_break_minutes')));
  end loop;
end;
$$;

-- Punch functions (latest: 2751) ------------------------------------------------------------------------------------------------------

drop function private.apply_punch(uuid, uuid, app.punch_kind, timestamptz, bigint, uuid, numeric, numeric, numeric, uuid, app.punch_source, uuid, text, uuid, uuid, uuid);
drop function app.record_punch(uuid, uuid, app.punch_kind, timestamptz, bigint, uuid, numeric, numeric, numeric, uuid, app.punch_source, uuid, text, uuid, uuid);

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
  p_roster_entry_id uuid,
  p_break_type_id uuid default null
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
  v_break_type uuid;
  v_break_paid boolean := false;
  v_break_minutes integer := 0;
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
    -- A running break is paid or unpaid by the type its Break Start carried (B9, 2985); no type is unpaid, as before.
    if v_break_start is not null then
      v_break_paid := coalesce((select b.paid from app.clock_punches c join app.break_types b on b.id = c.break_type_id
        where c.time_entry_id = v_entry.id and c.punch_kind = 'Break Start'
        order by c.effective_at desc, c.received_at desc limit 1), false);
      v_break_minutes := greatest(0, ceil(extract(epoch from (v_effective - v_break_start)) / 60)::integer);
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
      -- The break's type: the one named, else the org's default, else none (an unpaid break, as before B9).
      if p_break_type_id is not null and not exists (
        select 1 from app.break_types b where b.id = p_break_type_id and b.org_id = v_project.org_id and b.deleted_at is null) then
        perform private.refuse('break_type_unknown', 'That break type is retired or belongs to another organization. Pick one of this organization''s break types.');
      end if;
      v_break_type := coalesce(p_break_type_id, (select b.id from app.break_types b
        where b.org_id = v_project.org_id and b.is_default and b.deleted_at is null));
      update app.time_entries set needs_review = needs_review or v_skewed where id = v_entry.id;
    elsif p_punch_kind = 'Break End' then
      if v_break_start is null then
        perform private.refuse('punch_no_break', 'No break is running.');
      end if;
      update app.time_entries
      set break_minutes = break_minutes + case when v_break_paid then 0 else v_break_minutes end,
          paid_break_minutes = paid_break_minutes + case when v_break_paid then v_break_minutes else 0 end,
          needs_review = needs_review or v_skewed
      where id = v_entry.id;
    else
      v_clock_out := private.round_punch_time(v_effective, v_rounding);
      if v_clock_out <= v_entry.clock_in then
        v_clock_out := greatest(v_effective, v_entry.clock_in + interval '1 minute');
      end if;
      update app.time_entries
      set clock_out = v_clock_out,
          break_minutes = break_minutes + case when v_break_paid then 0 else v_break_minutes end,
          paid_break_minutes = paid_break_minutes + case when v_break_paid then v_break_minutes else 0 end,
          needs_review = needs_review or v_skewed
      where id = v_entry.id;
    end if;
  end if;

  insert into app.clock_punches (id, project_id, membership_id, engagement_id, roster_entry_id, shift_id, time_entry_id, punch_kind,
    device_time, monotonic_offset_ms, received_at, effective_at, latitude, longitude, accuracy_m, geofence_id, geofence_verified,
    skew_flagged, source, kiosk_device_id, photo_uri, break_type_id)
  values (p_punch_id, p_project_id, p_membership_id, p_engagement_id, p_roster_entry_id, coalesce(p_shift_id, v_entry.shift_id),
    v_entry.id, p_punch_kind, p_device_time, p_monotonic_offset_ms, v_received, v_effective, p_latitude, p_longitude, p_accuracy_m,
    p_geofence_id, case when p_geofence_id is null then null else v_verified end, v_skewed, p_source, p_kiosk_device_id, p_photo_uri,
    v_break_type)
  returning * into v_punch;
  return v_punch;
end;
$$;

comment on function private.apply_punch(uuid, uuid, app.punch_kind, timestamptz, bigint, uuid, numeric, numeric, numeric, uuid, app.punch_source, uuid, text, uuid, uuid, uuid, uuid) is 'Records one clock punch for a worker the caller already resolved and authorized (exactly one of a membership, an engagement or a roster entry) and applies it to the worker''s time entry, exactly once per client punch id: the body of app.record_punch since 1321, split out by R12 so app.record_supervisor_punches (2754) shares it. Replay and punch_id_conflict, the 2-minute skew tolerance, time.photo_on_punch on kiosk punches, time.geofence_required on Mobile and Supervisor clock-ins, a shift of the same worker that is Accepted (or Published, for a Supervisor punch), punch_already_in, breaks, and time.rounding_minutes. A Break Start carries a break type (p_break_type_id, else the org''s default, else none; break_type_unknown for another org''s or a retired one, B9); a paid type''s minutes go to time_entries.paid_break_minutes and are never subtracted, an unpaid or untyped break''s to break_minutes. A Supervisor punch writes its time entry as Mobile; the punch keeps Supervisor.';
revoke all on function private.apply_punch(uuid, uuid, app.punch_kind, timestamptz, bigint, uuid, numeric, numeric, numeric, uuid, app.punch_source, uuid, text, uuid, uuid, uuid, uuid) from public, anon, authenticated;

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
  p_engagement_id uuid default null,
  p_break_type_id uuid default null
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
    v_membership, v_engagement, v_roster, p_break_type_id);
end;
$$;

comment on function app.record_punch(uuid, uuid, app.punch_kind, timestamptz, bigint, uuid, numeric, numeric, numeric, uuid, app.punch_source, uuid, text, uuid, uuid, uuid) is 'Records one clock punch exactly once and applies it to the worker''s time entry: In opens one (refused while one is open, punch_already_in), Break Start and Break End add the break (of p_break_type_id, else the org''s default type; a paid type''s minutes are worked time, B9), Out closes it. Idempotent on the client punch id. The device time counts within a 2-minute skew tolerance (corrected by the monotonic offset when given); otherwise the server time counts, the punch is skew_flagged and the entry needs review. The server checks the geofence. The project''s time settings apply (1321): a phone clock-in inside the geofence while time.geofence_required, a photo on kiosk clock-ins and clock-outs while time.photo_on_punch, and entry times rounded by time.rounding_minutes. Members punch for themselves, engaged externals on their open engagement, agency staff on the shift of their operational roster entry with neither named (R12), and the kiosk service (service role) for the member, engagement or roster shift it verified. Signed-in callers record Mobile punches only (punch_source_mobile). The worker is resolved here and the punch applied by private.apply_punch.';

revoke all on function app.record_punch(uuid, uuid, app.punch_kind, timestamptz, bigint, uuid, numeric, numeric, numeric, uuid, app.punch_source, uuid, text, uuid, uuid, uuid) from public, anon;
grant execute on function app.record_punch(uuid, uuid, app.punch_kind, timestamptz, bigint, uuid, numeric, numeric, numeric, uuid, app.punch_source, uuid, text, uuid, uuid, uuid) to authenticated, service_role;
-- app.record_punch keeps its private.sync_rpcs row (0941): Compass replays it offline, now with the break type.

-- External workers' break types --------------------------------------------------------------------------------------------------------

create or replace view api_external.break_types as
select b.id, b.org_id, b.name, b.paid, b.planned_minutes, b.is_default
from app.break_types b
where b.deleted_at is null
  and (b.org_id in (select private.my_org_ids())
    or b.org_id in (select e.org_id from app.engagements e where e.id in (select private.my_engagement_ids('operational')))
    or b.org_id in (select r.org_id from app.engagement_roster_entries r where r.id in (select private.my_roster_entry_ids('operational'))));

call private.describe('api_external.break_types', 'The break types of the orgs the caller works for (B9): as a member, or through an engagement or a roster entry whose operational area is open, so Compass''s break picker offers them offline. Read through the view''s own filter.', array[
  'id', 'Break type.',
  'org_id', 'Org whose break type it is.',
  'name', 'Name of the break.',
  'paid', 'True when the break is paid (worked time).',
  'planned_minutes', 'How long the break usually is, in minutes.',
  'is_default', 'The type a break takes when none is chosen.'
]);
revoke all on api_external.break_types from public, anon;
grant select on api_external.break_types to authenticated, service_role;

-- A retired break type belongs in Trash (ADR 0110): register it now rather than at the nightly sweep.
select private.sync_trash_tables();
