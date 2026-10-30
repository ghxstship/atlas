-- 2821_credential_photos_bucket.sql
-- P5 Printable photo badges (RRR-219, gap G-144). The private credential-photos bucket holds badge photos, one folder per
-- org and holder: <org_id>/<holder_person_id>/<uuid>.jpg or .png, at most 2 MiB, JPEG or PNG. Names start with the org
-- id, so an org purge removes them through private.org_storage_objects (1351).
--
--   * Objects are virus-scanned like every other upload bucket: private.scanned_upload_bucket is recreated from its
--     latest definition (1265) with credential-photos added, and the restrictive read gate object_scan_read_gate from
--     1041 with credential-photos joining the private buckets, so before a Clean scan only the uploader reads a photo.
--     Rebuild both from the union of every definition on the branch when merging (R9 adds party-uploads in 27xx).
--   * Only the holder uploads, into their own folder, while they hold a live credential in the org. The holder and the
--     org's credential readers read a photo; the holder, or an issuer of the org who issued them a credential (revoked
--     or expired included), deletes an object once no live badge photo row names it.
-- Helpers take the object name as a value and never read storage.objects (ADR 0016 crash rule).

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('credential-photos', 'credential-photos', false, 2097152, array['image/jpeg', 'image/png'])
on conflict (id) do nothing;

-- Scanning (from 1265) --------------------------------------------------------------------------------------------------

create or replace function private.scanned_upload_bucket(p_bucket_id text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_bucket_id in ('field-media', 'onboarding-uploads', 'profile-media', 'org-brand', 'imports', 'support-screenshots', 'upload-staging',
    'credential-photos');
$$;

comment on function private.scanned_upload_bucket(text) is 'True for a bucket whose objects are virus-scanned through private.object_scans (1041, 1240, 1265, 2821): field-media, onboarding-uploads, profile-media, org-brand, imports, support-screenshots, upload-staging and credential-photos. Attachments keep their own scan state (0590).';
revoke all on function private.scanned_upload_bucket(text) from public, anon;
grant execute on function private.scanned_upload_bucket(text) to authenticated, service_role;

-- Read gate (from 1041) -------------------------------------------------------------------------------------------------

drop policy object_scan_read_gate on storage.objects;

create policy object_scan_read_gate on storage.objects
  as restrictive
  for select to authenticated
  using (bucket_id not in ('field-media', 'onboarding-uploads', 'credential-photos')
         or owner_id = (select auth.uid())::text
         or private.object_scan_clean(bucket_id, name));

comment on policy object_scan_read_gate on storage.objects is 'A22-011: in the private upload buckets field-media, onboarding-uploads and credential-photos (2821), only the uploader reads an object before it scans Clean.';

-- Path helpers ----------------------------------------------------------------------------------------------------------

create or replace function private.credential_photo_object(p_name text)
returns table (org_id uuid, person_id uuid)
language sql
immutable
set search_path = ''
as $$
  select split_part(p_name, '/', 1)::uuid, split_part(p_name, '/', 2)::uuid
  where p_name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png)$';
$$;

comment on function private.credential_photo_object(text) is 'P5: the org and holder a credential-photos object name names, <org_id>/<holder_person_id>/<uuid>.jpg or .png; no row for any other name. Takes the name as a value (ADR 0016).';
revoke all on function private.credential_photo_object(text) from public, anon;
grant execute on function private.credential_photo_object(text) to authenticated, service_role;

create or replace function private.credential_photo_holder_writable(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from private.credential_photo_object(p_name) o
    where o.person_id = private.current_person_id() and private.credential_holder_live(o.org_id, o.person_id));
$$;

comment on function private.credential_photo_holder_writable(text) is 'P5: true when the object name is in the signed-in person''s own folder of an org where they hold a live credential. Takes the name as a value (ADR 0016).';
revoke all on function private.credential_photo_holder_writable(text) from public, anon;
grant execute on function private.credential_photo_holder_writable(text) to authenticated, service_role;

create or replace function private.credential_photo_issuer(p_org_id uuid, p_person_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from app.credentials c
    where c.org_id = p_org_id and c.holder_person_id = p_person_id and c.deleted_at is null
      and c.project_id in (select private.project_ids_with('credentials.credential.issue')));
$$;

comment on function private.credential_photo_issuer(uuid, uuid) is 'P5: true when the signed-in person issues credentials on a project of the org where the person holds or held a credential (revoked or expired included, deleted not). Takes column values.';
revoke all on function private.credential_photo_issuer(uuid, uuid) from public, anon;
grant execute on function private.credential_photo_issuer(uuid, uuid) to authenticated, service_role;

create or replace function private.credential_photo_readable(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from private.credential_photo_object(p_name) o
    where o.person_id = private.current_person_id()
      or private.credential_photo_reader(o.org_id, o.person_id)
      or (private.credential_photo_issuer(o.org_id, o.person_id)
          and not exists (select 1 from app.credential_photos p where p.photo_path = p_name and p.deleted_at is null)));
$$;

comment on function private.credential_photo_readable(text) is 'P5: true when the signed-in person may read a credential-photos object: the holder, a credential reader on a project where the holder holds a live credential, or an issuer of the org for an object no live photo names (so their Remove photo can delete it after a revoke). Takes the name as a value (ADR 0016).';
revoke all on function private.credential_photo_readable(text) from public, anon;
grant execute on function private.credential_photo_readable(text) to authenticated, service_role;

create or replace function private.credential_photo_removable(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from private.credential_photo_object(p_name) o
    where (o.person_id = private.current_person_id() or private.credential_photo_issuer(o.org_id, o.person_id))
      and not exists (select 1 from app.credential_photos p where p.photo_path = p_name and p.deleted_at is null));
$$;

comment on function private.credential_photo_removable(text) is 'P5: true when the signed-in person may delete a credential-photos object: no live badge photo names it, and the caller is the holder (whatever their credentials now) or issues credentials on a project of the org where the holder holds or held one. Takes the name as a value (ADR 0016).';
revoke all on function private.credential_photo_removable(text) from public, anon;
grant execute on function private.credential_photo_removable(text) to authenticated, service_role;

-- Storage policies ------------------------------------------------------------------------------------------------------

create policy credential_photos_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'credential-photos' and private.credential_photo_holder_writable(name));

comment on policy credential_photos_insert on storage.objects is 'P5: a holder uploads a badge photo into their own folder of an org where they hold a live credential.';

create policy credential_photos_read on storage.objects for select to authenticated
  using (bucket_id = 'credential-photos' and private.credential_photo_readable(name));

comment on policy credential_photos_read on storage.objects is 'P5: the holder and the org''s credential readers read a badge photo; object_scan_read_gate keeps it to the uploader until it scans Clean.';

create policy credential_photos_delete on storage.objects for delete to authenticated
  using (bucket_id = 'credential-photos' and private.credential_photo_removable(name));

comment on policy credential_photos_delete on storage.objects is 'P5: the holder or the org''s issuer deletes a badge photo object once no live row names it.';
