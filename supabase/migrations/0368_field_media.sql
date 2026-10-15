-- 0368_field_media.sql
-- A03 Domain Data (requested by A17 Compass). Photos taken in the field:
--   * inspection_results.photo_uri, the photo of a finding
--   * the private storage bucket field-media for incident and inspection media. Object names are
--     <org_id>/incidents/<incident_id>/<file name> or <org_id>/inspections/<inspection_id>/<file name>.
--     A person who writes the incident or inspection on its project uploads; a person who reads it reads
--     the file. Objects are never updated or deleted by signed-in users: a retake is a new object.
-- The storage helpers take the object name as a value and never re-read storage.objects (ADR 0016
-- crash rule).

alter table app.inspection_results add column photo_uri text;
alter table app.inspection_results add constraint inspection_results_photo_uri_format
  check (photo_uri is null or photo_uri ~ '^[0-9a-f-]{36}/inspections/[0-9a-f-]{36}/[^/]+$');
comment on column app.inspection_results.photo_uri is 'Object name of the finding''s photo in the field-media bucket: <org_id>/inspections/<inspection_id>/<file name>.';

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('field-media', 'field-media', false, 52428800,
  array['image/jpeg', 'image/png', 'image/heic', 'image/webp', 'video/mp4', 'video/quicktime'])
on conflict (id) do nothing;

create or replace function private.field_media_subject(p_object_name text)
returns table (org_id uuid, kind text, subject_id uuid, project_id uuid)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_parts text[] := storage.foldername(p_object_name);
  v_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
  if coalesce(array_length(v_parts, 1), 0) <> 3 or v_parts[1] !~ v_uuid or v_parts[2] not in ('incidents', 'inspections') or v_parts[3] !~ v_uuid then
    return;
  end if;
  if v_parts[2] = 'incidents' then
    return query select i.org_id, 'incidents'::text, i.id, i.project_id from app.incidents i
      where i.id = v_parts[3]::uuid and i.org_id = v_parts[1]::uuid and i.deleted_at is null;
  else
    return query select i.org_id, 'inspections'::text, i.id, i.project_id from app.inspections i
      where i.id = v_parts[3]::uuid and i.org_id = v_parts[1]::uuid and i.deleted_at is null;
  end if;
end;
$$;

comment on function private.field_media_subject(text) is 'The incident or inspection a field-media object name points to (<org_id>/incidents|inspections/<id>/<file name>, the id belonging to that org), with its project; no row for any other name.';
revoke all on function private.field_media_subject(text) from public, anon;
grant execute on function private.field_media_subject(text) to authenticated, service_role;

create or replace function private.field_media_allowed(p_object_name text, p_write boolean)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from private.field_media_subject(p_object_name) s
    where s.project_id in (select private.project_ids_with(
      case when s.kind = 'incidents' then case when p_write then 'safety.incident.write' else 'safety.incident.read' end
           else case when p_write then 'safety.inspection.write' else 'safety.inspection.read' end end)));
$$;

comment on function private.field_media_allowed(text, boolean) is 'True when the signed-in person may write (upload) or read a field-media object: the incident or inspection capability on the subject''s project, so access never crosses orgs or projects.';
revoke all on function private.field_media_allowed(text, boolean) from public, anon;
grant execute on function private.field_media_allowed(text, boolean) to authenticated, service_role;

create policy field_media_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'field-media' and private.field_media_allowed(name, true));
create policy field_media_read on storage.objects for select to authenticated
  using (bucket_id = 'field-media' and private.field_media_allowed(name, false));
