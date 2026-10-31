-- 2978_scan_bucket_union.sql
-- B8 (RRR-232): the scanned upload buckets and the restrictive read gate hold both stacked additions.
--
-- R9's 2712 adds party-uploads and P5's 2821 adds credential-photos, each rebuilding the bucket list and the read gate
-- from the definitions it saw. In file order 2821 runs after 2712 and so drops party-uploads: party files would be
-- neither scanned nor held back before a Clean scan. This restates both from their latest definitions (2712 and 2821)
-- with the union of the two lists. Nothing else changes.

-- Scanning (from 2712 and 2821) -----------------------------------------------------------------------------------------

create or replace function private.scanned_upload_bucket(p_bucket_id text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_bucket_id in ('field-media', 'onboarding-uploads', 'profile-media', 'org-brand', 'imports', 'support-screenshots', 'upload-staging',
    'party-uploads', 'credential-photos');
$$;

comment on function private.scanned_upload_bucket(text) is 'True for a bucket whose objects are virus-scanned through private.object_scans (1041, 1240, 1265, 2712, 2821, 2978): field-media, onboarding-uploads, profile-media, org-brand, imports, support-screenshots, upload-staging, party-uploads and credential-photos. Attachments keep their own scan state (0590).';
revoke all on function private.scanned_upload_bucket(text) from public, anon;
grant execute on function private.scanned_upload_bucket(text) to authenticated, service_role;

-- Read gate (from 2712 and 2821) ----------------------------------------------------------------------------------------

drop policy object_scan_read_gate on storage.objects;

create policy object_scan_read_gate on storage.objects
  as restrictive
  for select to authenticated
  using (bucket_id not in ('field-media', 'onboarding-uploads', 'party-uploads', 'credential-photos')
         or owner_id = (select auth.uid())::text
         or private.object_scan_clean(bucket_id, name));

comment on policy object_scan_read_gate on storage.objects is 'A22-011: in the private upload buckets field-media, onboarding-uploads, party-uploads (R9, 2712) and credential-photos (P5, 2821), only the uploader reads an object before it scans Clean (2978 keeps both).';
