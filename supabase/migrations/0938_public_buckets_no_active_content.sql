-- Security finding A22-004: the public buckets org-brand and profile-media admitted SVG, and nothing
-- sanitizes it. Section 9 forbids serving active content inline from public buckets: a script-bearing
-- SVG uploaded to a profile folder ran on the storage origin for anyone given its public URL.
--
-- Fix: neither public bucket admits SVG, HTML or XML. The bucket allowlists drop image/svg+xml, and
-- the write policies refuse active-content names and types too, because a direct insert into
-- storage.objects does not pass through the storage API's type check. Logo and profile uploads take
-- PNG, JPEG, WebP or ICO.

update storage.buckets
set allowed_mime_types = array_remove(allowed_mime_types, 'image/svg+xml')
where id in ('org-brand', 'profile-media');

create or replace function private.is_passive_public_object(p_name text, p_metadata jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select lower(coalesce(substring(p_name from '\.([^./]+)$'), '')) not in ('svg', 'svgz', 'html', 'htm', 'xhtml', 'xml', 'xsl', 'js', 'mjs')
     and lower(coalesce(p_metadata ->> 'mimetype', '')) not in
         ('image/svg+xml', 'text/html', 'application/xhtml+xml', 'text/xml', 'application/xml', 'text/javascript', 'application/javascript');
$$;

comment on function private.is_passive_public_object(text, jsonb) is 'Whether an object written to a public bucket is passive content: not SVG, HTML, XML or script by extension or declared type (A22-004, Section 9).';
revoke all on function private.is_passive_public_object(text, jsonb) from public, anon;
grant execute on function private.is_passive_public_object(text, jsonb) to authenticated;

drop policy org_brand_insert on storage.objects;
create policy org_brand_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'org-brand'
              and private.has_capability(private.brand_object_org(name), 'org.white_label.write')
              and private.is_passive_public_object(name, metadata));

drop policy org_brand_update on storage.objects;
create policy org_brand_update on storage.objects
  for update to authenticated
  using (bucket_id = 'org-brand'
         and private.has_capability(private.brand_object_org(name), 'org.white_label.write'))
  with check (bucket_id = 'org-brand'
              and private.has_capability(private.brand_object_org(name), 'org.white_label.write')
              and private.is_passive_public_object(name, metadata));

drop policy profile_media_insert on storage.objects;
create policy profile_media_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'profile-media'
              and (private.brand_object_org(name) = private.current_person_id()
                   or private.can_edit_org_profile(private.brand_object_org(name)))
              and private.is_passive_public_object(name, metadata));

drop policy profile_media_update on storage.objects;
create policy profile_media_update on storage.objects
  for update to authenticated
  using (bucket_id = 'profile-media'
         and (private.brand_object_org(name) = private.current_person_id()
              or private.can_edit_org_profile(private.brand_object_org(name))))
  with check (bucket_id = 'profile-media'
              and (private.brand_object_org(name) = private.current_person_id()
                   or private.can_edit_org_profile(private.brand_object_org(name)))
              and private.is_passive_public_object(name, metadata));
