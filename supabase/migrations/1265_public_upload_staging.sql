-- 1265_public_upload_staging.sql
-- A63 (RRR-108), ADR 0034 amendment: the public buckets profile-media and org-brand take a file only
-- after it scans Clean.
--
-- Anyone with a public URL reads an object in profile-media or org-brand, so a read gate cannot hold a
-- file back while it is scanned: until now the worker removed what was not Clean, after it had been
-- public for a while. Uploads now land in a private staging bucket first:
--   * upload-staging (private): a file meant for profile-media or org-brand is uploaded to
--     `<target bucket>/<object name in that bucket>`, for example `org-brand/<org id>/logoLight-1.png`.
--     The write policy applies the target bucket's own rules: who may write there, passive content only
--     (A22-004, 0938), and the target bucket's type allowlist and size limit. Only the uploader reads,
--     replaces or deletes a staged file.
--   * Signed-in callers no longer write profile-media or org-brand directly (their insert and update
--     policies are dropped; delete stays). Only the service role writes them: the upload-scan worker
--     publishes a staged file once it scans Clean, then removes it from staging.
--   * Staged files are scanned through private.object_scans like the other upload buckets (1041, 1240).
--     The published copy is recorded Clean when it is written while its staged original is held by a
--     scan worker, so it is never scanned twice and never public unscanned. Any other service-role write
--     to a public bucket is still queued and scanned.
--   * An Infected or refused file is removed from staging and never published. Its verdict stays for
--     the uploader (app.my_upload_scan_status on upload-staging, 1240), and Atlas explains it with the
--     existing plain-language copy.
-- Policy helpers take column values as arguments and never re-read storage.objects (ADR 0016 crash rule).

-- Bucket ------------------------------------------------------------------------------------------------------

-- The limit and types are the union of the two public buckets'; the write policy narrows each upload to
-- its target bucket's own allowlist and limit.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('upload-staging', 'upload-staging', false, 26214400,
        array['image/png', 'image/jpeg', 'image/webp', 'image/x-icon', 'image/vnd.microsoft.icon',
              'application/pdf', 'video/mp4', 'audio/mpeg'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- Helpers -----------------------------------------------------------------------------------------------------

create or replace function private.staged_upload_bucket(p_name text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when strpos(p_name, '/') > 0 and split_part(p_name, '/', 1) in ('org-brand', 'profile-media')
      then split_part(p_name, '/', 1)
  end;
$$;

comment on function private.staged_upload_bucket(text) is 'The public bucket a staged upload is meant for: the first segment of its upload-staging name when it is org-brand or profile-media, else NULL (1265).';

create or replace function private.staged_upload_object(p_name text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when strpos(p_name, '/') > 0 then substr(p_name, strpos(p_name, '/') + 1) end;
$$;

comment on function private.staged_upload_object(text) is 'The object name a staged upload takes in its public bucket: its upload-staging name without the first segment (1265).';

create or replace function private.can_publish_upload(p_bucket text, p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(case p_bucket
    when 'org-brand' then private.has_capability(private.brand_object_org(p_name), 'org.white_label.write')
    when 'profile-media' then private.brand_object_org(p_name) = private.current_person_id()
                              or private.can_edit_org_profile(private.brand_object_org(p_name))
  end, false);
$$;

comment on function private.can_publish_upload(text, text) is 'Whether the caller may put an object of this name in a public bucket: org.white_label.write on the org for org-brand (0850); their own folder, or an org profile they edit, for profile-media (0860). The rules the dropped direct write policies held (1265).';

create or replace function private.fits_public_bucket(p_bucket text, p_metadata jsonb)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from storage.buckets b
    where b.id = p_bucket
      and (p_metadata ->> 'mimetype' is null or b.allowed_mime_types is null
           or lower(p_metadata ->> 'mimetype') = any (b.allowed_mime_types))
      and (p_metadata ->> 'size' is null or b.file_size_limit is null
           or (p_metadata ->> 'size')::bigint <= b.file_size_limit));
$$;

comment on function private.fits_public_bucket(text, jsonb) is 'Whether an object''s declared type and size fit a public bucket''s allowlist and limit, so a staged upload is refused at once rather than failing when it is published (1265).';

revoke all on function private.staged_upload_bucket(text) from public, anon;
grant execute on function private.staged_upload_bucket(text) to authenticated, service_role;
revoke all on function private.staged_upload_object(text) from public, anon;
grant execute on function private.staged_upload_object(text) to authenticated, service_role;
revoke all on function private.can_publish_upload(text, text) from public, anon;
grant execute on function private.can_publish_upload(text, text) to authenticated, service_role;
revoke all on function private.fits_public_bucket(text, jsonb) from public, anon;
grant execute on function private.fits_public_bucket(text, jsonb) to authenticated, service_role;

-- Policies ----------------------------------------------------------------------------------------------------

drop policy org_brand_insert on storage.objects;
drop policy org_brand_update on storage.objects;
drop policy profile_media_insert on storage.objects;
drop policy profile_media_update on storage.objects;

create policy upload_staging_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'upload-staging'
              and private.can_publish_upload(private.staged_upload_bucket(name), private.staged_upload_object(name))
              and private.is_passive_public_object(name, metadata)
              and private.fits_public_bucket(private.staged_upload_bucket(name), metadata));

comment on policy upload_staging_insert on storage.objects is 'A file for profile-media or org-brand is uploaded to upload-staging under `<bucket>/<name>`, under that bucket''s own write rules, passive content only and its type and size limits (1265).';

create policy upload_staging_read on storage.objects
  for select to authenticated
  using (bucket_id = 'upload-staging' and owner_id = (select auth.uid())::text);

comment on policy upload_staging_read on storage.objects is 'Only the uploader reads a staged file, which also keeps INSERT ... RETURNING working for the storage API (1265).';

create policy upload_staging_update on storage.objects
  for update to authenticated
  using (bucket_id = 'upload-staging' and owner_id = (select auth.uid())::text)
  with check (bucket_id = 'upload-staging'
              and private.can_publish_upload(private.staged_upload_bucket(name), private.staged_upload_object(name))
              and private.is_passive_public_object(name, metadata)
              and private.fits_public_bucket(private.staged_upload_bucket(name), metadata));

comment on policy upload_staging_update on storage.objects is 'The uploader may replace a staged file under the same rules as a new upload; the replacement is scanned again (1265).';

create policy upload_staging_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'upload-staging' and owner_id = (select auth.uid())::text);

comment on policy upload_staging_delete on storage.objects is 'The uploader may withdraw a staged file before it is published (1265).';

-- Scanning ----------------------------------------------------------------------------------------------------

create or replace function private.scanned_upload_bucket(p_bucket_id text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_bucket_id in ('field-media', 'onboarding-uploads', 'profile-media', 'org-brand', 'imports', 'support-screenshots', 'upload-staging');
$$;

comment on function private.scanned_upload_bucket(text) is 'True for a bucket whose objects are virus-scanned through private.object_scans (1041, 1240, 1265): field-media, onboarding-uploads, profile-media, org-brand, imports, support-screenshots and upload-staging. Attachments keep their own scan state (0590).';

create or replace function private.queue_object_scan()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_staged record;
begin
  if not private.scanned_upload_bucket(new.bucket_id) then
    return null;
  end if;
  if tg_op = 'UPDATE' and new.name = old.name and new.version is not distinct from old.version
     and new.metadata is not distinct from old.metadata then
    return null;
  end if;
  -- A public object written while its staged original is held by a scan worker is that original being
  -- published after a Clean verdict (only the service role writes the public buckets, 1265).
  if new.bucket_id in ('org-brand', 'profile-media') then
    select s.owner_id into v_staged from private.object_scans s
    where s.bucket_id = 'upload-staging' and s.object_name = new.bucket_id || '/' || new.name
      and s.scan_status = 'Scanning' and s.locked_at > now() - interval '10 minutes';
  end if;
  if found and new.bucket_id in ('org-brand', 'profile-media') then
    insert into private.object_scans (bucket_id, object_name, owner_id, scan_status, scanned_at, scan_detail)
    values (new.bucket_id, new.name, v_staged.owner_id, 'Clean', now(), 'Scanned in upload-staging before it was published.')
    on conflict (bucket_id, object_name) do update
      set scan_status = 'Clean', attempts = 0, run_after = now(), locked_by = null, locked_at = null,
          scanned_at = now(), scan_detail = excluded.scan_detail, owner_id = excluded.owner_id;
  else
    insert into private.object_scans (bucket_id, object_name, owner_id)
    values (new.bucket_id, new.name, new.owner_id)
    on conflict (bucket_id, object_name) do update
      set scan_status = 'Scanning', attempts = 0, run_after = now(), locked_by = null, locked_at = null,
          scanned_at = null, scan_detail = null, owner_id = excluded.owner_id;
  end if;
  if tg_op = 'UPDATE' and new.name <> old.name then
    delete from private.object_scans s where s.bucket_id = old.bucket_id and s.object_name = old.name;
  end if;
  return null;
end;
$$;

comment on function private.queue_object_scan() is 'After a write to storage.objects in a scanned bucket: queues the object for scanning with its uploader, and again when its content is replaced or it is renamed (A22-011, 1240). A public object written while its staged original is held by a scan worker is recorded Clean, with the staged uploader (1265).';
revoke all on function private.queue_object_scan() from public, anon, authenticated;

comment on table private.object_scans is 'Virus-scan state of each object in the scanned upload buckets (A22-011, 1240, 1265). Private buckets serve an object to anyone but its uploader only once it is Clean; profile-media and org-brand receive a file only after it scans Clean in upload-staging. Infected and Scan Failed rows outlive the removed object so its uploader can be told why.';
