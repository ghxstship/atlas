-- 0941_record_punch.sql
-- A03 Domain Data, late slot (requested by A17 Compass). app.record_punch turns clock punches captured
-- offline into time entries, and the close of stale entries runs on a schedule. Lives in the late slot
-- because it uses A13's shift lifecycle (0460), engagements (0700, 0940) and pg_cron (0500s).
--
-- record_punch, in order:
--   * idempotent on the client punch id: a replay by the same worker returns the stored punch
--   * resolves the worker: the caller's membership in the project's org, or the caller's engagement
--     (open operational area, Section 8.7); a kiosk punch arrives from the platform kiosk service (service
--     role, after private.verify_kiosk_pin) and names the membership or engagement
--   * skew: with a monotonic offset, the device time counts when it is within 2 minutes of the received
--     time less the offset, otherwise that corrected time counts; without one, the device time counts when
--     it is no more than 2 minutes ahead and no more than 72 hours behind the server, otherwise the
--     received time counts. Either way a rejected device time sets skew_flagged and marks the entry
--     for review
--   * geofence_verified comes from app.point_in_geofence, never from the device
--   * a punch on a shift needs the worker's Accepted shift (A13 shift lifecycle)
--   * In opens an entry and is refused while one is open (punch_already_in); Break Start and Break End
--     bracket a break whose whole minutes, rounded up, add to break_minutes; Out closes the entry and any
--     open break

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
    insert into app.time_entries (project_id, membership_id, engagement_id, shift_id, clock_in, source, kiosk_device_id, needs_review)
    values (p_project_id, v_membership, v_engagement, p_shift_id, v_effective, p_source::text::app.time_entry_source,
            p_kiosk_device_id, v_skewed)
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
    if v_effective <= v_entry.clock_in then
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
      update app.time_entries
      set clock_out = v_effective,
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

comment on function app.record_punch(uuid, uuid, app.punch_kind, timestamptz, bigint, uuid, numeric, numeric, numeric, uuid, app.punch_source, uuid, text, uuid, uuid) is 'Records one clock punch exactly once and applies it to the worker''s time entry: In opens one (refused while one is open, punch_already_in), Break Start and Break End add the break, Out closes it. Idempotent on the client punch id. The device time counts within a 2-minute skew tolerance (corrected by the monotonic offset when given); otherwise the server time counts, the punch is skew_flagged and the entry needs review. The server checks the geofence. Members punch for themselves, engaged externals on their open engagement, and the kiosk service (service role) for the member or engagement whose PIN it verified.';

revoke all on function app.record_punch(uuid, uuid, app.punch_kind, timestamptz, bigint, uuid, numeric, numeric, numeric, uuid, app.punch_source, uuid, text, uuid, uuid) from public, anon;
grant execute on function app.record_punch(uuid, uuid, app.punch_kind, timestamptz, bigint, uuid, numeric, numeric, numeric, uuid, app.punch_source, uuid, text, uuid, uuid) to authenticated, service_role;

insert into private.sync_rpcs (rpc, description) values
  ('app.record_punch', 'A crew member clocks in, takes a break or clocks out while offline.');

-- The 16-hour close runs every 15 minutes.
select cron.schedule('xos_close_stale_time_entries', '*/15 * * * *', 'select private.close_stale_time_entries()');
