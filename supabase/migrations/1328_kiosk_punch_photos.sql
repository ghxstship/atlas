-- 1328_kiosk_punch_photos.sql
-- A76 Settings enforcement (RRR-121, A65-001, WP1): the photo a kiosk takes when the project asks for one on every
-- punch (time.photo_on_punch, enforced in app.record_punch by 1321, Section 13 kiosk "photo on punch when
-- enabled"). The kiosk stores it in the private field-media bucket before it sends the punch, under
-- <org_id>/kiosk-punches/<project_id>/<file name>, and the punch carries storage://field-media/<that name>.
--
--   * Writing such an object needs org.time_attendance.write in the org, the capability that runs a kiosk.
--   * Reading it needs crew.time_entry.read on the project, so supervisors who review time see the photo, or
--     org.time_attendance.write.
--   * Incident and inspection media keep their rules (0368).

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
  if coalesce(array_length(v_parts, 1), 0) <> 3 or v_parts[1] !~ v_uuid
     or v_parts[2] not in ('incidents', 'inspections', 'kiosk-punches') or v_parts[3] !~ v_uuid then
    return;
  end if;
  if v_parts[2] = 'incidents' then
    return query select i.org_id, 'incidents'::text, i.id, i.project_id from app.incidents i
      where i.id = v_parts[3]::uuid and i.org_id = v_parts[1]::uuid and i.deleted_at is null;
  elsif v_parts[2] = 'inspections' then
    return query select i.org_id, 'inspections'::text, i.id, i.project_id from app.inspections i
      where i.id = v_parts[3]::uuid and i.org_id = v_parts[1]::uuid and i.deleted_at is null;
  else
    return query select p.org_id, 'kiosk-punches'::text, p.id, p.id from app.projects p
      where p.id = v_parts[3]::uuid and p.org_id = v_parts[1]::uuid and p.deleted_at is null;
  end if;
end;
$$;

comment on function private.field_media_subject(text) is 'The incident, inspection or kiosk punch project a field-media object name points to (<org_id>/incidents|inspections/<id>/<file name>, or <org_id>/kiosk-punches/<project_id>/<file name> for kiosk punch photos, 1328), the id belonging to that org, with its project; no row for any other name.';

create or replace function private.field_media_allowed(p_object_name text, p_write boolean)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from private.field_media_subject(p_object_name) s
    where case
      when s.kind = 'kiosk-punches' then
        private.has_capability(s.org_id, 'org.time_attendance.write')
        or (not p_write and s.project_id in (select private.project_ids_with('crew.time_entry.read')))
      else s.project_id in (select private.project_ids_with(
        case when s.kind = 'incidents' then case when p_write then 'safety.incident.write' else 'safety.incident.read' end
             else case when p_write then 'safety.inspection.write' else 'safety.inspection.read' end end))
    end);
$$;

comment on function private.field_media_allowed(text, boolean) is 'True when the signed-in person may write (upload) or read a field-media object: the incident or inspection capability on the subject''s project; for kiosk punch photos (1328), org.time_attendance.write to write or read and crew.time_entry.read on the project to read. Access never crosses orgs or projects.';
