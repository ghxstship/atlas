-- 1420_kiosk_device_unregistered.sql
-- A85 (RRR-130), kiosk re-keying. A kiosk whose device key was retired in Atlas (1171), revoked, or never known
-- to this database got kiosk_pin_rejected for every punch, so Compass counted down each worker's PIN attempts
-- and then said the PIN was locked, and nothing told the supervisor the device itself had to be set up again.
-- app.kiosk_punch now answers kiosk_device_unregistered when the device key names no live kiosk:
--   * one answer for a key that never existed and one that was revoked or retired, so it says nothing about
--     whether a key was ever valid;
--   * decided from the key alone, before the rate limit, the member or the PIN are looked at, so it says
--     nothing about members, PINs or other kiosks, and costs no bcrypt comparison;
--   * no failure is counted for it: the per-device limit protects the PINs of a live kiosk, and a retired
--     kiosk retrying its queued punches keeps getting the same clear answer instead of kiosk_rate_limited.
-- The key is a 256-bit secret (0340), so learning that a guessed key is unregistered gives an unauthenticated
-- caller nothing to enumerate. A read-only transaction is refused first, before the device lookup, as every
-- attempt-counting helper does (1295, A69-001). Everything else is as in 1321, which added kiosk_disabled
-- (time.kiosk_enabled) to 0592.

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
  perform private.require_read_write();
  select * into v_device from app.kiosk_devices d
  where d.device_key_hash = extensions.digest(p_device_key, 'sha256')
    and d.revoked_at is null and d.deleted_at is null;
  if v_device.id is null then
    return query select p_punch_id, null::uuid, p_punch_kind, null::timestamptz, null::boolean, 'kiosk_device_unregistered'::text;
    return;
  end if;
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

comment on function app.kiosk_punch(text, uuid, text, uuid, app.punch_kind, timestamptz, bigint, text, uuid) is 'Kiosk PIN service (service role only, called by the kiosk-punch Edge Function for A17 Compass). A device key that names no live kiosk (unknown, revoked or retired) is refused as kiosk_device_unregistered before the member or PIN are looked at, uncounted (1420). For a live kiosk: limits failed PINs to 20 per device in 15 minutes, verifies the member PIN through private.verify_kiosk_pin, refuses with kiosk_disabled until time.kiosk_enabled is on for the org or the project''s workspace (1321), then records the punch through app.record_punch as a Kiosk punch on the kiosk''s project: idempotent on the client punch id, with the device time corrected by the monotonic offset for punches queued offline. Every refusal (device, PIN, rate limit, project, kiosk off, photo or a record_punch rule such as punch_already_in or punch_photo_required) returns as a code instead of raising, so failure counts persist (invariant 8).';

revoke all on function app.kiosk_punch(text, uuid, text, uuid, app.punch_kind, timestamptz, bigint, text, uuid) from public, anon, authenticated;
grant execute on function app.kiosk_punch(text, uuid, text, uuid, app.punch_kind, timestamptz, bigint, text, uuid) to service_role;
