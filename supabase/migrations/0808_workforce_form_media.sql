-- 0808_workforce_form_media.sql
-- A29 Workforce Suite: storage for form photos and signatures (Section 4.9 Forms: "required photos ...
-- signatures"). A submitter uploads to the private field-media bucket under
-- <org_id>/forms/<person_id>/<file name> before submitting, and app.submit_form stores those object
-- names in the answers and signature. Only the uploader writes there; the uploader, form publishers
-- (knowledge.sop.publish) and anyone who reads a submission naming the object read it, so photos never
-- cross orgs or reach people outside the submission.

create or replace function private.form_media_allowed(p_object_name text, p_write boolean)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_parts text[] := storage.foldername(p_object_name);
  v_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  v_org uuid;
  v_person uuid := private.current_person_id();
begin
  if coalesce(array_length(v_parts, 1), 0) <> 3 or v_parts[1] !~ v_uuid or v_parts[2] <> 'forms' or v_parts[3] !~ v_uuid then
    return false;
  end if;
  v_org := v_parts[1]::uuid;
  if private.my_membership_in(v_org) is null then
    return false;
  end if;
  if v_parts[3]::uuid = v_person then
    return true;
  end if;
  if p_write then
    return false;
  end if;
  return private.has_capability(v_org, 'knowledge.sop.publish')
    or exists (select 1 from app.form_submissions s
               where s.org_id = v_org and s.deleted_at is null
                 and (s.signature_path = p_object_name or s.answers::text like '%"' || p_object_name || '"%')
                 and private.can_read_form_submission(s.org_id, s.form_template_id, s.submitted_by_membership_id));
end;
$$;

comment on function private.form_media_allowed(text, boolean) is 'Whether the signed-in person writes or reads a form photo or signature in field-media (<org_id>/forms/<person_id>/<file>): the uploader always; to read, also form publishers and readers of a submission that names the object.';
revoke all on function private.form_media_allowed(text, boolean) from public, anon;
grant execute on function private.form_media_allowed(text, boolean) to authenticated, service_role;

create policy field_media_form_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'field-media' and private.form_media_allowed(name, true));
create policy field_media_form_read on storage.objects for select to authenticated
  using (bucket_id = 'field-media' and private.form_media_allowed(name, false));
