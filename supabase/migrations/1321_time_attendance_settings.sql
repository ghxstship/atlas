-- 1321_time_attendance_settings.sql
-- A76 Settings enforcement (RRR-121, A65-001, WP1): the four Time and Attendance settings (Section 4.5.6 item 24,
-- Section 13 Clock and Kiosk) take effect where punches are recorded. Each resolves for the punch's project
-- through private.project_setting_* (1320): project, workspace, org, default, with the org lock.
--
--   * time.geofence_required (default on): a phone clock-in (Mobile In) on a project whose venue has a live
--     geofence needs a location inside one of that venue's geofences, checked by the server. Without a location
--     it is refused with punch_location_required, outside with punch_outside_geofence. Kiosk punches come from
--     a supervised device on site. A self clock-in from Atlas on the web carries no location, so it is refused
--     the same way (punch_location_required) while the geofence applies.
--   * time.photo_on_punch (default off): a kiosk clock-in and clock-out (Kiosk In and Out) carries a photo
--     (Section 13: kiosk "photo on punch when enabled"); otherwise punch_photo_required.
--   * time.rounding_minutes (default 0): the time entry's clock-in and clock-out round to the nearest 5, 6 or 15
--     minutes. The punch keeps its exact time; breaks count from the exact times. A clock-out that would round
--     onto or before the clock-in keeps its exact time.
--   * time.kiosk_enabled (default off): app.kiosk_punch answers kiosk_disabled until the org, or the kiosk
--     project's workspace, turns kiosks on.
--
-- app.record_punch and app.kiosk_punch are redefined with their signatures, grants and earlier rules unchanged.

-- Rounding ------------------------------------------------------------------------------------------------------

create or replace function private.round_punch_time(p_at timestamptz, p_minutes integer)
returns timestamptz
language sql
immutable
set search_path = ''
as $$
  select case when coalesce(p_minutes, 0) <= 0 then p_at
    else pg_catalog.to_timestamp(round(extract(epoch from p_at) / (p_minutes * 60)) * (p_minutes * 60)) end;
$$;

comment on function private.round_punch_time(timestamptz, integer) is 'A punch time rounded to the nearest multiple of the given minutes (time.rounding_minutes); 0 leaves it exact.';
revoke all on function private.round_punch_time(timestamptz, integer) from public, anon, authenticated;

-- The geofence rule shared by phone and web clock-ins ---------------------------------------------------------------

create or replace function private.project_clock_in_geofence(
  p_project_id uuid,
  p_latitude numeric,
  p_longitude numeric,
  p_geofence_id uuid
)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_venue uuid := (select p.venue_id from app.projects p where p.id = p_project_id);
  v_point extensions.geography;
begin
  if not coalesce(private.project_setting_boolean(p_project_id, 'time.geofence_required'), true)
     or v_venue is null
     or not exists (select 1 from app.geofences g where g.venue_id = v_venue and g.deleted_at is null) then
    return null;
  end if;
  if p_latitude is null or p_longitude is null then
    return 'punch_location_required';
  end if;
  v_point := extensions.st_setsrid(extensions.st_makepoint(p_longitude::double precision, p_latitude::double precision), 4326)::extensions.geography;
  if exists (
    select 1 from app.geofences g
    where g.venue_id = v_venue and g.deleted_at is null and (p_geofence_id is null or g.id = p_geofence_id)
      and extensions.st_covers(g.boundary, v_point)) then
    return null;
  end if;
  return 'punch_outside_geofence';
end;
$$;

comment on function private.project_clock_in_geofence(uuid, numeric, numeric, uuid) is 'time.geofence_required for a clock-in on a project: null when the clock-in may go ahead (the setting is off, the project''s venue has no live geofence, or the point is inside one of them, the named one when given), else the refusal rule punch_location_required or punch_outside_geofence.';
revoke all on function private.project_clock_in_geofence(uuid, numeric, numeric, uuid) from public, anon, authenticated;

create or replace function private.refuse_clock_in_geofence(p_rule text)
returns void
language plpgsql
volatile
set search_path = ''
as $$
begin
  if p_rule = 'punch_location_required' then
    perform private.refuse(p_rule, 'This project needs your location to clock in; clock in on site from Compass with location on.');
  elsif p_rule = 'punch_outside_geofence' then
    perform private.refuse(p_rule, 'You are outside the project''s geofence; clock in on site.');
  end if;
end;
$$;

comment on function private.refuse_clock_in_geofence(text) is 'Raises the refusal named by private.project_clock_in_geofence, or nothing for null.';
revoke all on function private.refuse_clock_in_geofence(text) from public, anon, authenticated;

-- app.record_punch -------------------------------------------------------------------------------------------------------

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
  v_worker_person uuid;
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
  if v_service then
    if p_source <> 'Kiosk' or p_kiosk_device_id is null or num_nonnulls(p_membership_id, p_engagement_id) <> 1 then
      perform private.refuse('punch_kiosk_worker', 'A kiosk punch names its kiosk and exactly one membership or engagement.');
    end if;
    v_membership := p_membership_id;
    v_engagement := p_engagement_id;
  else
    if p_source <> 'Mobile' then
      perform private.refuse('punch_source_mobile', 'A signed-in device records Mobile punches; kiosk punches come from the kiosk service.');
    end if;
    if p_engagement_id is not null then
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
  v_worker_person := private.worker_person_id(v_membership, v_engagement);

  -- Replay
  select * into v_existing from app.clock_punches c where c.id = p_punch_id;
  if v_existing.id is not null then
    if v_existing.membership_id is not distinct from v_membership and v_existing.engagement_id is not distinct from v_engagement
       and v_existing.punch_kind = p_punch_kind then
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
    where s.id = p_shift_id and s.project_id = p_project_id and s.deleted_at is null and s.shift_state = 'Accepted'
      and s.membership_id is not distinct from v_membership and s.engagement_id is not distinct from v_engagement) then
    perform private.refuse('punch_shift_not_accepted', 'Punch on a shift only once it is yours and Accepted.');
  end if;

  -- The worker's open entry in the org
  select t.* into v_entry from app.time_entries t
  where t.org_id = v_project.org_id and t.clock_out is null and t.deleted_at is null
    and (t.membership_id in (select m.id from app.memberships m where m.person_id = v_worker_person)
         or t.engagement_id in (select g.id from app.engagements g where g.person_id = v_worker_person))
  order by t.clock_in desc limit 1 for update;

  if p_punch_kind = 'In' then
    if v_entry.id is not null then
      perform private.refuse('punch_already_in', 'You are already clocked in; clock out first.');
    end if;
    -- Geofence required (time.geofence_required): a phone clock-in happens inside the project's geofence.
    if p_source = 'Mobile' then
      perform private.refuse_clock_in_geofence(private.project_clock_in_geofence(p_project_id, p_latitude, p_longitude, p_geofence_id));
    end if;
    insert into app.time_entries (project_id, membership_id, engagement_id, shift_id, clock_in, source, kiosk_device_id, needs_review)
    values (p_project_id, v_membership, v_engagement, p_shift_id, private.round_punch_time(v_effective, v_rounding),
            p_source::text::app.time_entry_source, p_kiosk_device_id, v_skewed)
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

  insert into app.clock_punches (id, project_id, membership_id, engagement_id, shift_id, time_entry_id, punch_kind, device_time,
    monotonic_offset_ms, received_at, effective_at, latitude, longitude, accuracy_m, geofence_id, geofence_verified, skew_flagged,
    source, kiosk_device_id, photo_uri)
  values (p_punch_id, p_project_id, v_membership, v_engagement, coalesce(p_shift_id, v_entry.shift_id), v_entry.id, p_punch_kind,
    p_device_time, p_monotonic_offset_ms, v_received, v_effective, p_latitude, p_longitude, p_accuracy_m, p_geofence_id,
    case when p_geofence_id is null then null else v_verified end, v_skewed, p_source, p_kiosk_device_id, p_photo_uri)
  returning * into v_punch;
  return v_punch;
end;
$$;

comment on function app.record_punch(uuid, uuid, app.punch_kind, timestamptz, bigint, uuid, numeric, numeric, numeric, uuid, app.punch_source, uuid, text, uuid, uuid) is 'Records one clock punch exactly once and applies it to the worker''s time entry: In opens one (refused while one is open, punch_already_in), Break Start and Break End add the break, Out closes it. Idempotent on the client punch id. The device time counts within a 2-minute skew tolerance (corrected by the monotonic offset when given); otherwise the server time counts, the punch is skew_flagged and the entry needs review. The server checks the geofence. The project''s time settings apply (1321): a phone clock-in inside the geofence while time.geofence_required, a photo on kiosk clock-ins and clock-outs while time.photo_on_punch, and entry times rounded by time.rounding_minutes. Members punch for themselves, engaged externals on their open engagement, and the kiosk service (service role) for the member or engagement whose PIN it verified.';

-- app.kiosk_punch ------------------------------------------------------------------------------------------------------------

create or replace function app.kiosk_punch(
  p_device_key text,
  p_membership_id uuid,
  p_pin text,
  p_punch_id uuid,
  p_punch_kind app.punch_kind,
  p_device_time timestamptz,
  p_monotonic_offset_ms bigint default null,
  p_photo_uri text default null,
  p_project_id uuid default null
)
returns table (
  punch_id uuid,
  time_entry_id uuid,
  punch_kind app.punch_kind,
  effective_at timestamptz,
  skew_flagged boolean,
  refusal text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_device app.kiosk_devices;
  v_project uuid;
  v_punch app.clock_punches;
  v_rule text;
begin
  if private.rate_limit_exceeded('kiosk_pin.failure', p_device_key, 20, interval '15 minutes') then
    return query select p_punch_id, null::uuid, p_punch_kind, null::timestamptz, null::boolean, 'kiosk_rate_limited'::text;
    return;
  end if;
  if not private.verify_kiosk_pin(p_device_key, p_membership_id, p_pin) then
    perform private.note_rate_event('kiosk_pin.failure', p_device_key);
    return query select p_punch_id, null::uuid, p_punch_kind, null::timestamptz, null::boolean, 'kiosk_pin_rejected'::text;
    return;
  end if;
  if p_photo_uri is not null and (p_photo_uri !~ '^(storage|https)://[^\s]+$' or char_length(p_photo_uri) > 1000) then
    return query select p_punch_id, null::uuid, p_punch_kind, null::timestamptz, null::boolean, 'kiosk_photo_uri'::text;
    return;
  end if;
  select * into v_device from app.kiosk_devices d where d.device_key_hash = extensions.digest(p_device_key, 'sha256');
  v_project := coalesce(v_device.project_id, p_project_id);
  if v_project is null or (v_device.project_id is not null and p_project_id is not null and p_project_id <> v_device.project_id)
     or not exists (select 1 from app.projects p where p.id = v_project and p.org_id = v_device.org_id and p.deleted_at is null) then
    return query select p_punch_id, null::uuid, p_punch_kind, null::timestamptz, null::boolean, 'kiosk_project'::text;
    return;
  end if;
  -- Kiosk clock-in (time.kiosk_enabled): off until the org, or the project's workspace, turns kiosks on.
  if not coalesce(private.setting_boolean(v_device.org_id, 'time.kiosk_enabled',
       (select p.workspace_id from app.projects p where p.id = v_project)), false) then
    return query select p_punch_id, null::uuid, p_punch_kind, null::timestamptz, null::boolean, 'kiosk_disabled'::text;
    return;
  end if;
  begin
    select * into v_punch from app.record_punch(
      p_punch_id => p_punch_id,
      p_project_id => v_project,
      p_punch_kind => p_punch_kind,
      p_device_time => p_device_time,
      p_monotonic_offset_ms => p_monotonic_offset_ms,
      p_source => 'Kiosk',
      p_kiosk_device_id => v_device.id,
      p_photo_uri => p_photo_uri,
      p_membership_id => p_membership_id);
  exception when sqlstate 'XR001' then
    get stacked diagnostics v_rule = pg_exception_hint;
    return query select p_punch_id, null::uuid, p_punch_kind, null::timestamptz, null::boolean, coalesce(nullif(v_rule, ''), 'punch_refused');
    return;
  end;
  update app.kiosk_devices set last_seen_at = now() where id = v_device.id;
  return query select v_punch.id, v_punch.time_entry_id, v_punch.punch_kind, v_punch.effective_at, v_punch.skew_flagged, null::text;
end;
$$;

comment on function app.kiosk_punch(text, uuid, text, uuid, app.punch_kind, timestamptz, bigint, text, uuid) is 'Kiosk PIN service (service role only, called by the kiosk-punch Edge Function for A17 Compass): verifies the device key and member PIN through private.verify_kiosk_pin, limits failed PINs to 20 per device in 15 minutes, refuses with kiosk_disabled until time.kiosk_enabled is on for the org or the project''s workspace (1321), then records the punch through app.record_punch as a Kiosk punch on the kiosk''s project: idempotent on the client punch id, with the device time corrected by the monotonic offset for punches queued offline. Every refusal (PIN, rate limit, project, kiosk off, photo or a record_punch rule such as punch_already_in or punch_photo_required) returns as a code instead of raising, so failure counts persist (invariant 8).';

-- Web clock-ins from Atlas -------------------------------------------------------------------------------------------------
-- A person clocking themselves in on the web (a Web entry with no clock-out yet) meets the project's geofence rule, and
-- the person's own web clock-in and clock-out round like punches. Entries a supervisor records for someone else and
-- completed manual entries are corrections, not clock events, and keep their times.

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
    and private.worker_person_id(new.membership_id, new.engagement_id) = private.current_person_id();
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

comment on function private.apply_web_clock_rules() is 'Time settings on a person''s own web clock-in (1321): time.geofence_required refuses it while the project''s venue has a geofence (the web carries no location), and time.rounding_minutes rounds its clock-in and clock-out. Supervisor and completed manual entries keep their times.';
revoke all on function private.apply_web_clock_rules() from public, anon, authenticated;

create trigger t36_apply_web_clock_rules before insert or update on app.time_entries
  for each row execute function private.apply_web_clock_rules();
