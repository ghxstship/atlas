-- 2712_party_uploads.sql
-- R9 Party uploads (RRR-189; the pattern of 0762 and 1041). Files a party gives an advance File section, and the
-- brand assets a sponsor supplies, go to one private, virus-scanned bucket:
--
--   1. Bucket party-uploads: private, 25 MB, PDF, JPEG, PNG, HEIC, WebP, CSV, XLSX and DOCX (all in
--      packages/platform/src/scanning/content.ts). Object names:
--        <org_id>/advance/<advance_recipient_id>/<advance_section_id>/<file name>
--        <org_id>/sponsor-asset/<sponsor_entitlement_id>/<file name>
--   2. private.party_upload_target parses a name (ADR 0016: column values in); private.party_upload_writable is the
--      recipient side of a File section of a sent packet while private.advance_recipient_open holds, or the sponsor
--      side (private.sponsor_side_open); private.party_upload_readable adds org readers (advancing.packet.read or
--      vendors.vendor.read on the project).
--   3. Policies party_uploads_insert and party_uploads_read. No update or delete: a new upload is a new object.
--   4. private.scanned_upload_bucket (from 1265) and the restrictive object_scan_read_gate (from 1041) include
--      party-uploads, so nobody but the uploader reads a file before it scans Clean.
--   5. app.register_party_upload makes an uploaded object a document of the project with its first version, as
--      app.register_onboarding_upload does (0762); app.party_file_object tells Atlas which object a version is.
-- Files are Internal, so no row goes in private.column_classifications.

-- 1. Bucket -----------------------------------------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('party-uploads', 'party-uploads', false, 26214400,
  array['application/pdf', 'image/jpeg', 'image/png', 'image/heic', 'image/webp', 'text/csv',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'])
on conflict (id) do nothing;

-- 2. Helpers -------------------------------------------------------------------------------------------------------------

create or replace function private.party_upload_target(p_object_name text)
returns table (target_kind text, org_id uuid, project_id uuid, advance_recipient_id uuid, advance_section_id uuid,
  sponsor_entitlement_id uuid)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_parts text[] := storage.foldername(p_object_name);
  v_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
  if coalesce(array_length(v_parts, 1), 0) = 4 and v_parts[1] ~ v_uuid and v_parts[2] = 'advance'
     and v_parts[3] ~ v_uuid and v_parts[4] ~ v_uuid then
    return query
      select 'advance'::text, r.org_id, p.project_id, r.id, s.id, null::uuid
      from app.advance_recipients r
      join app.advance_packets p on p.id = r.advance_packet_id and p.deleted_at is null
      join app.advance_sections s on s.advance_packet_id = p.id and s.id = v_parts[4]::uuid and s.deleted_at is null
      where r.id = v_parts[3]::uuid and r.org_id = v_parts[1]::uuid and r.deleted_at is null;
  elsif coalesce(array_length(v_parts, 1), 0) = 3 and v_parts[1] ~ v_uuid and v_parts[2] = 'sponsor-asset' and v_parts[3] ~ v_uuid then
    return query
      select 'sponsor-asset'::text, s.org_id, s.project_id, null::uuid, null::uuid, s.id
      from app.sponsor_entitlements s
      where s.id = v_parts[3]::uuid and s.org_id = v_parts[1]::uuid and s.deleted_at is null;
  end if;
end;
$$;
comment on function private.party_upload_target(text) is 'What a party-uploads object name points to (R9): <org_id>/advance/<advance_recipient_id>/<advance_section_id>/<file name> for a live recipient and a live section of its packet, or <org_id>/sponsor-asset/<sponsor_entitlement_id>/<file name> for a live entitlement, each in that org, with the project; no row for any other name.';

create or replace function private.party_upload_writable(p_object_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from private.party_upload_target(p_object_name) t
    left join app.advance_recipients r on r.id = t.advance_recipient_id
    left join app.advance_sections s on s.id = t.advance_section_id
    left join app.advance_packets p on p.id = s.advance_packet_id
    where case t.target_kind
      when 'advance' then s.section_kind = 'File' and p.sent_at is not null
        and private.advance_recipient_open(t.project_id, r.person_id, r.counterparty_id)
      when 'sponsor-asset' then private.sponsor_side_open(t.sponsor_entitlement_id)
      else false
    end);
$$;
comment on function private.party_upload_writable(text) is 'Section 8.7 (R9): true when the signed-in person may upload this party-uploads object: the recipient side (private.advance_recipient_open) of a File section of a sent packet, or the sponsor side (private.sponsor_side_open) of the entitlement.';

create or replace function private.party_upload_readable(p_object_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.party_upload_writable(p_object_name)
    or exists (
      select 1 from private.party_upload_target(p_object_name) t
      where private.can_on_project(t.project_id, case t.target_kind when 'advance' then 'advancing.packet.read' else 'vendors.vendor.read' end));
$$;
comment on function private.party_upload_readable(text) is 'True when the signed-in person may read a party-uploads object (R9): the side that may write it, or an org member with advancing.packet.read (advance files) or vendors.vendor.read (sponsor assets) on the project. The scan read gate still holds an object back from everyone but its uploader until it is Clean.';

revoke all on function private.party_upload_target(text) from public, anon;
revoke all on function private.party_upload_writable(text) from public, anon;
revoke all on function private.party_upload_readable(text) from public, anon;
grant execute on function private.party_upload_target(text) to authenticated, service_role;
grant execute on function private.party_upload_writable(text) to authenticated, service_role;
grant execute on function private.party_upload_readable(text) to authenticated, service_role;

-- 3. Policies -------------------------------------------------------------------------------------------------------------

create policy party_uploads_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'party-uploads' and private.party_upload_writable(name));
comment on policy party_uploads_insert on storage.objects is 'R9: the recipient side of an advance File section, or the sponsor side of an entitlement, uploads to party-uploads under its own folder.';
create policy party_uploads_read on storage.objects for select to authenticated
  using (bucket_id = 'party-uploads' and private.party_upload_readable(name));
comment on policy party_uploads_read on storage.objects is 'R9: the side that uploads, and org members who read the packet or the entitlement, read party-uploads objects.';

-- 4. Scanning, from 1265 and 1041 -------------------------------------------------------------------------------------------

create or replace function private.scanned_upload_bucket(p_bucket_id text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_bucket_id in ('field-media', 'onboarding-uploads', 'profile-media', 'org-brand', 'imports', 'support-screenshots',
    'upload-staging', 'party-uploads');
$$;
comment on function private.scanned_upload_bucket(text) is 'True for a bucket whose objects are virus-scanned through private.object_scans (1041, 1240, 1265, 2712): field-media, onboarding-uploads, profile-media, org-brand, imports, support-screenshots, upload-staging and party-uploads. Attachments keep their own scan state (0590).';
revoke all on function private.scanned_upload_bucket(text) from public, anon;
grant execute on function private.scanned_upload_bucket(text) to authenticated, service_role;

drop policy object_scan_read_gate on storage.objects;
create policy object_scan_read_gate on storage.objects
  as restrictive
  for select to authenticated
  using (bucket_id not in ('field-media', 'onboarding-uploads', 'party-uploads')
         or owner_id = (select auth.uid())::text
         or private.object_scan_clean(bucket_id, name));
comment on policy object_scan_read_gate on storage.objects is 'A22-011: in the private upload buckets field-media, onboarding-uploads and party-uploads (R9), only the uploader reads an object before it scans Clean.';

-- 5. Registering and serving --------------------------------------------------------------------------------------------------

create or replace function app.register_party_upload(p_object_name text, p_title text, p_checksum_sha256 text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_target record;
  v_document uuid;
begin
  perform private.require_person();
  select t.* into v_target from private.party_upload_target(p_object_name) t;
  if v_target.target_kind is null or not private.party_upload_writable(p_object_name) then
    raise exception using errcode = '42501', message = 'this upload folder is not open to the caller';
  end if;
  if not exists (select 1 from storage.objects o where o.bucket_id = 'party-uploads' and o.name = p_object_name) then
    perform private.refuse('party_upload_missing', 'Upload the file before registering it.');
  end if;
  if p_checksum_sha256 is null or p_checksum_sha256 !~ '^[0-9a-f]{64}$' then
    perform private.refuse('party_upload_checksum', 'The file checksum must be a SHA-256 in lowercase hex.');
  end if;
  insert into app.documents (org_id, project_id, title)
  values (v_target.org_id, v_target.project_id, left(btrim(coalesce(p_title, '')), 200))
  returning id into v_document;
  insert into app.document_versions (document_id, storage_uri, checksum_sha256)
  values (v_document, 'storage://party-uploads/' || p_object_name, p_checksum_sha256);
  return v_document;
end;
$$;
comment on function app.register_party_upload(text, text, text) is 'The party registers a file it uploaded to party-uploads (R9), while its folder is writable to it (42501 otherwise): the object must exist (party_upload_missing) and the checksum be a lowercase SHA-256 (party_upload_checksum). The file becomes a document of the packet''s or entitlement''s project with its first version at storage://party-uploads/<name>, ready to attach to an answer or a supplied sponsor asset. Returns the document id.';
revoke all on function app.register_party_upload(text, text, text) from public, anon;
grant execute on function app.register_party_upload(text, text, text) to authenticated, service_role;

create or replace function app.party_file_object(p_document_version_id uuid)
returns table (bucket_id text, object_name text, content_type text, title text)
language sql
stable
security definer
set search_path = ''
as $$
  select 'party-uploads'::text, x.object_name, o.metadata ->> 'mimetype', d.title
  from app.document_versions v
  join app.documents d on d.id = v.document_id and d.deleted_at is null
  cross join lateral (select substr(v.storage_uri, char_length('storage://party-uploads/') + 1) as object_name) x
  left join storage.objects o on o.bucket_id = 'party-uploads' and o.name = x.object_name
  where v.id = p_document_version_id and starts_with(v.storage_uri, 'storage://party-uploads/')
    and private.party_upload_readable(x.object_name);
$$;
comment on function app.party_file_object(uuid) is 'Which party-uploads object a document version is (R9), with its content type and the document title, for a caller who may read it (private.party_upload_readable); no row otherwise. Atlas then downloads it under the caller''s session, where the scan read gate applies.';
revoke all on function app.party_file_object(uuid) from public, anon;
grant execute on function app.party_file_object(uuid) to authenticated, service_role;
