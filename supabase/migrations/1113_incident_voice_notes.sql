-- 1113_incident_voice_notes.sql
-- A42 Compass launch gaps, SIM-003 (journey 54; Section 11.13 Incidents: "add photos or a voice note").
-- A voice note is incident media like a photo: recorded in Compass, uploaded to the field-media bucket under
-- the incident's folder before the RPC, queued offline with the report.
--   * app.incident_media.media_kind ('Photo', 'Video' or 'Voice Note', default Photo, so existing rows and
--     callers keep meaning photos) and duration_ms, set for a voice note only.
--   * field-media accepts AAC audio as recorded on iOS and Android (audio/mp4, audio/aac, audio/x-m4a) and
--     MP3. The bucket is private; A22-004 limits public buckets only, and audio is not active content.
--   * app.add_incident_media takes the kind and duration; it stays one signature, as the sync wrapper needs.
-- Transcription after reconnecting is deferred past 4.0: it needs a new subprocessor (owner decision
-- 2026-10-17), so no transcript column is added yet.

alter table app.incident_media
  add column media_kind text not null default 'Photo',
  add column duration_ms integer,
  add constraint incident_media_kind check (media_kind in ('Photo', 'Video', 'Voice Note')),
  add constraint incident_media_duration check (
    duration_ms is null or (media_kind = 'Voice Note' and duration_ms between 1 and 600000));

comment on column app.incident_media.media_kind is 'What the file is: Photo, Video or Voice Note.';
comment on column app.incident_media.duration_ms is 'Length of a voice note in milliseconds, up to ten minutes; null for photos and video.';

update storage.buckets
set allowed_mime_types = (
  select array_agg(distinct t order by t)
  from unnest(allowed_mime_types || array['audio/mp4', 'audio/aac', 'audio/x-m4a', 'audio/mpeg']) t)
where id = 'field-media';

drop function app.add_incident_media(uuid, text, timestamptz, uuid);

create function app.add_incident_media(
  p_incident_id uuid,
  p_media_uri text,
  p_captured_at timestamptz default null,
  p_id uuid default null,
  p_media_kind text default 'Photo',
  p_duration_ms integer default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_existing app.incident_media;
  v_id uuid;
begin
  if not private.can_on_project(private.incident_project(p_incident_id), 'safety.incident.write') then
    raise exception using errcode = '42501', message = 'safety.incident.write is required on the incident''s project';
  end if;
  if p_id is not null then
    select * into v_existing from app.incident_media x where x.id = p_id;
    if v_existing.id is not null then
      if v_existing.created_by is distinct from v_person or v_existing.incident_id <> p_incident_id then
        perform private.refuse('incident_media_id_taken', 'Another photo, video or voice note already uses this id.');
      end if;
      return v_existing.id;
    end if;
  end if;
  insert into app.incident_media (id, org_id, incident_id, media_uri, captured_at, media_kind, duration_ms)
  values (coalesce(p_id, private.uuid_v7()), (select i.org_id from app.incidents i where i.id = p_incident_id),
    p_incident_id, btrim(p_media_uri), p_captured_at, coalesce(p_media_kind, 'Photo'), p_duration_ms)
  returning incident_media.id into v_id;
  return v_id;
end;
$$;

comment on function app.add_incident_media(uuid, text, timestamptz, uuid, text, integer) is 'Attaches a stored photo, video or voice note (with its length) to an incident for a person with safety.incident.write on its project. Idempotent on a client id.';
revoke all on function app.add_incident_media(uuid, text, timestamptz, uuid, text, integer) from public, anon;
grant execute on function app.add_incident_media(uuid, text, timestamptz, uuid, text, integer) to authenticated, service_role;

update private.sync_rpcs set description = 'A field person attaches a photo, video or voice note to an incident.'
where rpc = 'app.add_incident_media';
