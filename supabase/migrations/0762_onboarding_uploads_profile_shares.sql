-- 0762_onboarding_uploads_profile_shares.sql
-- A28 Engagements and Marketplace (RRR-30), Gateway group 1 for A27:
--   * the private storage bucket onboarding-uploads, where an engaged party uploads the file an onboarding item
--     takes (Section 4.4.4). Object names are <org_id>/<engagement_id>/<onboarding_item_id>/<file name>. The
--     party writes while the onboarding area of the engagement is open (Section 8.7); org members who read the
--     engagement read the file. Objects are never updated or deleted by users: a new upload is a new object.
--   * app.register_onboarding_upload: records an uploaded object as a document of the org with its first version
--     and submits the onboarding item with it, in one transaction
--   * api_external.my_profile_shares and api_external.my_profile_share_fields: the shares a person or their
--     account gave, so Gateway lists them and revokes them through app.revoke_profile_share

-- Bucket -----------------------------------------------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('onboarding-uploads', 'onboarding-uploads', false, 26214400,
  array['application/pdf', 'image/jpeg', 'image/png', 'image/heic', 'image/webp'])
on conflict (id) do nothing;

create or replace function private.onboarding_upload_item(p_object_name text)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_parts text[] := storage.foldername(p_object_name);
  v_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  v_item uuid;
begin
  if coalesce(array_length(v_parts, 1), 0) <> 3 or v_parts[1] !~ v_uuid or v_parts[2] !~ v_uuid or v_parts[3] !~ v_uuid then
    return null;
  end if;
  select i.id into v_item from app.onboarding_items i
  where i.id = v_parts[3]::uuid and i.engagement_id = v_parts[2]::uuid and i.org_id = v_parts[1]::uuid and i.deleted_at is null;
  return v_item;
end;
$$;

comment on function private.onboarding_upload_item(text) is 'The onboarding item an object name in onboarding-uploads belongs to: <org_id>/<engagement_id>/<onboarding_item_id>/<file name>, all three matching one live item; NULL for any other name.';

create or replace function private.onboarding_upload_writable(p_object_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from app.onboarding_items i
    join app.engagements e on e.id = i.engagement_id
    where i.id = private.onboarding_upload_item(p_object_name)
      and private.engagement_area_open(e.id, e.person_id, e.counterparty_id, e.role_type, e.engagement_state, 'onboarding'));
$$;

comment on function private.onboarding_upload_writable(text) is 'Section 8.7: true when the signed-in person reaches the onboarding area of the engagement the object name points to, so they may upload for its item.';

create or replace function private.onboarding_upload_readable(p_object_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.onboarding_upload_writable(p_object_name)
    or private.onboarding_upload_item(p_object_name) in (select private.internal_onboarding_item_ids('opportunities.engagement.read'));
$$;

comment on function private.onboarding_upload_readable(text) is 'True when the signed-in person may read an onboarding upload: the party while the onboarding area is open, or an org member who reads the engagement.';

create policy onboarding_uploads_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'onboarding-uploads' and private.onboarding_upload_writable(name));
create policy onboarding_uploads_read on storage.objects for select to authenticated
  using (bucket_id = 'onboarding-uploads' and private.onboarding_upload_readable(name));

-- Registering an upload ---------------------------------------------------------------------------------------------------

create or replace function app.register_onboarding_upload(p_object_name text, p_title text, p_checksum_sha256 text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_item app.onboarding_items;
  v_project uuid;
  v_document uuid;
begin
  perform private.require_person();
  select i.* into v_item from app.onboarding_items i where i.id = private.onboarding_upload_item(p_object_name);
  if v_item.id is null or not private.onboarding_upload_writable(p_object_name) then
    raise exception using errcode = '42501', message = 'the onboarding of this engagement is not open to the caller';
  end if;
  if not exists (select 1 from storage.objects o where o.bucket_id = 'onboarding-uploads' and o.name = p_object_name) then
    perform private.refuse('onboarding_upload_missing', 'Upload the file before registering it.');
  end if;
  if p_checksum_sha256 is null or p_checksum_sha256 !~ '^[0-9a-f]{64}$' then
    perform private.refuse('onboarding_upload_checksum', 'The file checksum must be a SHA-256 in lowercase hex.');
  end if;
  select e.project_id into v_project from app.engagements e where e.id = v_item.engagement_id;
  insert into app.documents (org_id, project_id, title) values (v_item.org_id, v_project, btrim(p_title)) returning id into v_document;
  insert into app.document_versions (document_id, storage_uri, checksum_sha256)
  values (v_document, 'storage://onboarding-uploads/' || p_object_name, p_checksum_sha256);
  update app.onboarding_items set document_id = v_document, submitted_at = now() where id = v_item.id;
  return v_document;
end;
$$;

comment on function app.register_onboarding_upload(text, text, text) is 'The engaged party registers a file uploaded to onboarding-uploads for an onboarding item while the onboarding area is open: the file becomes a document of the org (project scoped, first version with its checksum) and the item is submitted with it. Returns the document id.';

-- Profile shares the caller gave ----------------------------------------------------------------------------------------------

create or replace function private.my_given_profile_share_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select s.id from app.profile_shares s
  where s.deleted_at is null
    and (s.person_id = private.current_person_id()
      or s.organization_id in (select private.my_account_ids(array['Account Owner', 'Account Admin']::app.account_role[])));
$$;

comment on function private.my_given_profile_share_ids() is 'Profile shares the signed-in person gave: their own, or their account''s as Account Owner or Admin. Never the shares an org received.';

create view api_external.my_profile_shares as
select s.id, s.org_id, o.name as org_name, s.person_id, s.organization_id as account_id, s.engagement_id, s.shared_at, s.revoked_at
from app.profile_shares s
join app.organizations o on o.id = s.org_id
where s.id in (select private.my_given_profile_share_ids());

call private.describe('api_external.my_profile_shares', 'Profile shares the caller gave to orgs (Section 4.4.1), their own or their account''s, for listing and revoking through app.revoke_profile_share.', array[
  'id', 'Profile share.', 'org_id', 'Org the profile is shared with.', 'org_name', 'Org name.', 'person_id', 'Person who shared.',
  'account_id', 'Account that shared its company profile.', 'engagement_id', 'Engagement the share serves.',
  'shared_at', 'When consent was given.', 'revoked_at', 'When consent was revoked.']);

create view api_external.my_profile_share_fields as
select f.id, f.profile_share_id, f.field_key, f.field_value
from app.profile_share_fields f
where f.deleted_at is null and f.profile_share_id in (select private.my_given_profile_share_ids());

call private.describe('api_external.my_profile_share_fields', 'The fields of the caller''s profile shares, with the value shared.', array[
  'id', 'Field.', 'profile_share_id', 'Profile share.', 'field_key', 'Profile field key.', 'field_value', 'Value shared.']);

-- Privileges ----------------------------------------------------------------------------------------------------------------

revoke all on function private.onboarding_upload_item(text) from public, anon;
revoke all on function private.onboarding_upload_writable(text) from public, anon;
revoke all on function private.onboarding_upload_readable(text) from public, anon;
revoke all on function private.my_given_profile_share_ids() from public, anon;
grant execute on function private.onboarding_upload_item(text) to authenticated, service_role;
grant execute on function private.onboarding_upload_writable(text) to authenticated, service_role;
grant execute on function private.onboarding_upload_readable(text) to authenticated, service_role;
grant execute on function private.my_given_profile_share_ids() to authenticated, service_role;
revoke all on function app.register_onboarding_upload(text, text, text) from public, anon;
grant execute on function app.register_onboarding_upload(text, text, text) to authenticated, service_role;

revoke all on api_external.my_profile_shares, api_external.my_profile_share_fields from public, anon;
grant select on api_external.my_profile_shares, api_external.my_profile_share_fields to authenticated, service_role;
