-- 0592_kiosk_punch_record_punch.sql
-- A18 Platform Services. The kiosk PIN service for A17 Compass: app.kiosk_punch now takes the client punch id
-- (UUID v7), the punch kind (In, Break Start, Break End, Out), the device time with its monotonic offset for
-- punches queued offline, and an optional photo, and records the punch through A03F's app.record_punch
-- (migration 0941) as the kiosk service: idempotent on the punch id, skew-corrected, with breaks. The PIN
-- check and the per-device failure limit stay here. Refusals come back as codes, so failure counts persist.
-- record_punch is resolved when the function runs, so this migration may precede 0941 on a fresh reset.

drop function if exists app.kiosk_punch(text, uuid, text, uuid);
drop type if exists app.kiosk_punch;

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

comment on function app.kiosk_punch(text, uuid, text, uuid, app.punch_kind, timestamptz, bigint, text, uuid) is 'Kiosk PIN service (service role only, called by the kiosk-punch Edge Function for A17 Compass): verifies the device key and member PIN through private.verify_kiosk_pin, limits failed PINs to 20 per device in 15 minutes, then records the punch through app.record_punch as a Kiosk punch on the kiosk''s project: idempotent on the client punch id, with the device time corrected by the monotonic offset for punches queued offline. Every refusal (PIN, rate limit, project, photo or a record_punch rule such as punch_already_in) returns as a code instead of raising, so failure counts persist (invariant 8).';

revoke all on function app.kiosk_punch(text, uuid, text, uuid, app.punch_kind, timestamptz, bigint, text, uuid) from public, anon, authenticated;
grant execute on function app.kiosk_punch(text, uuid, text, uuid, app.punch_kind, timestamptz, bigint, text, uuid) to service_role;
