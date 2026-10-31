-- 2332_sponsor_proof_photos.sql
--
-- A140 (RRR-204; follow-up of A92, ADR 0048 "left for later"): sponsors capture proof-of-performance photos in
-- Compass (Section 4.5.7 role table: "External Sponsor ... Proof-of-performance capture with photos"; journey 47:
-- "entitlement fulfillment is captured with photos in Compass"). The write path for an external party, under
-- Section 8.7 (ADR 0117):
--   * app.proof_of_performance_photos: a photo of one sponsor entitlement, taken on the sponsor's engagement on that
--     entitlement's project. Written only by app.record_proof_of_performance_photo; the org reads it with
--     vendors.vendor.read on the project, as it reads the entitlement's deliveries and brand assets (0492).
--   * field-media objects <org_id>/proof-of-performance/<engagement_id>/<file name>: written and read by whoever
--     reaches the operational area of that Sponsor engagement now (the engaged person, or an Account Owner, Admin or
--     Member of the sponsor's account, while the engagement is Active or Closing), and read by the org with
--     vendors.vendor.read on the project. The folder is the engagement, so no party reaches another party's photos,
--     and capture ends with the operational area at Complete. upload-scan scans every field-media object (1041), and
--     the restrictive read policy keeps an object from everyone but its uploader until it scans Clean. The rules of
--     incident, inspection, kiosk punch and expense receipt media are 1622's, restated below.
--   * app.record_proof_of_performance_photo: records the photo against an entitlement of the sponsor whose engagement
--     the path names, idempotent on the device-minted id, from Compass online or offline.
--   * api_external.proof_of_performance_photos: the photos of the caller's Sponsor engagements while capture is open,
--     the projection Compass downloads; it shows no person ids and no audit columns.

-- 1. Who may capture ---------------------------------------------------------------------------------------------------

create or replace function private.can_capture_proof_photo(p_engagement_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from app.engagements e
    where e.id = p_engagement_id and e.deleted_at is null and e.role_type = 'Sponsor'
      and private.engagement_area_open(e.id, e.person_id, e.counterparty_id, e.role_type, e.engagement_state, 'operational'));
$$;

comment on function private.can_capture_proof_photo(uuid) is 'Section 8.7 helper (A140): true when the engagement is a Sponsor engagement whose operational area the signed-in person reaches now: they hold it, or hold Account Owner, Admin or Member in the sponsor''s account, and it is Active or Closing. Takes the engagement id; never reads app.proof_of_performance_photos.';
revoke all on function private.can_capture_proof_photo(uuid) from public, anon;
grant execute on function private.can_capture_proof_photo(uuid) to authenticated, service_role;

-- 2. Photos ------------------------------------------------------------------------------------------------------------

create table app.proof_of_performance_photos (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  sponsor_entitlement_id uuid not null references app.sponsor_entitlements (id),
  engagement_id uuid not null references app.engagements (id),
  media_uri text not null,
  captured_at timestamptz,
  constraint proof_of_performance_photos_media_uri_format check (media_uri ~
    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/proof-of-performance/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[^/]+$')
);

create unique index proof_of_performance_photos_media_uri_key on app.proof_of_performance_photos (media_uri);
create index proof_of_performance_photos_entitlement_idx on app.proof_of_performance_photos (sponsor_entitlement_id);
create index proof_of_performance_photos_engagement_idx on app.proof_of_performance_photos (engagement_id);

call private.install_domain_table('app.proof_of_performance_photos', 'app.sponsor_entitlements', 'sponsor_entitlement_id',
  array['app.engagements', 'engagement_id']);
call private.install_audit_trail('app.proof_of_performance_photos');
call private.install_default_retention('app.proof_of_performance_photos');
call private.describe('app.proof_of_performance_photos', 'Proof-of-performance photos a sponsor takes in Compass of an entitlement being delivered (Section 4.5.7, journey 47), on their own Sponsor engagement on the entitlement''s project. Written only by app.record_proof_of_performance_photo; the org reads them with vendors.vendor.read on the project, the sponsor through api_external.proof_of_performance_photos.', array[
  'sponsor_entitlement_id', 'The entitlement photographed.',
  'engagement_id', 'The Sponsor engagement the photo was taken on, whose folder holds it.',
  'media_uri', 'Object name of the photo in the field-media bucket: <org_id>/proof-of-performance/<engagement_id>/<file name>.',
  'captured_at', 'When the photo was taken, by the device clock; null when unknown.'
]);

call private.install_policies('app.proof_of_performance_photos',
  $$sponsor_entitlement_id in (select s.id from app.sponsor_entitlements s where s.project_id in (select private.project_ids_with('vendors.vendor.read')))$$);

-- Evidence the sponsor gave, not a record anyone deletes by mistake: nothing deletes it but the retention purge, so it
-- stays out of Trash (ADR 0110).
insert into private.trash_excluded_tables (table_name, rationale) values
  ('proof_of_performance_photos', 'Proof-of-performance photos are evidence a sponsor captured in Compass; no one deletes them through the app, so there is nothing to restore.');

-- 3. Field media -------------------------------------------------------------------------------------------------------
-- From 1490 (subject) and 1622 (allowed), the latest, with proof-of-performance photos added.

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
     or v_parts[2] not in ('incidents', 'inspections', 'kiosk-punches', 'expense-receipts', 'proof-of-performance')
     or v_parts[3] !~ v_uuid then
    return;
  end if;
  if v_parts[2] = 'incidents' then
    return query select i.org_id, 'incidents'::text, i.id, i.project_id from app.incidents i
      where i.id = v_parts[3]::uuid and i.org_id = v_parts[1]::uuid and i.deleted_at is null;
  elsif v_parts[2] = 'inspections' then
    return query select i.org_id, 'inspections'::text, i.id, i.project_id from app.inspections i
      where i.id = v_parts[3]::uuid and i.org_id = v_parts[1]::uuid and i.deleted_at is null;
  elsif v_parts[2] = 'proof-of-performance' then
    return query select e.org_id, 'proof-of-performance'::text, e.id, e.project_id from app.engagements e
      where e.id = v_parts[3]::uuid and e.org_id = v_parts[1]::uuid and e.deleted_at is null and e.role_type = 'Sponsor';
  else
    return query select p.org_id, v_parts[2], p.id, p.id from app.projects p
      where p.id = v_parts[3]::uuid and p.org_id = v_parts[1]::uuid and p.deleted_at is null;
  end if;
end;
$$;

comment on function private.field_media_subject(text) is 'The incident, inspection, engagement or project a field-media object name points to (<org_id>/incidents|inspections/<id>/<file name>; <org_id>/kiosk-punches/<project_id>/<file name> for kiosk punch photos, 1328; <org_id>/expense-receipts/<project_id>/<file name> for expense receipts, 1490; <org_id>/proof-of-performance/<engagement_id>/<file name> for a Sponsor engagement''s proof photos, 2332), the id belonging to that org, with its project; no row for any other name.';

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
      when s.kind = 'expense-receipts' then
        case when p_write then s.project_id in (select private.project_ids_with('finance.expense.write'))
             else s.project_id in (select private.project_ids_with('finance.expense.read'))
               or exists (
                 select 1 from app.expense_receipts r join app.expenses e on e.id = r.expense_id
                 where r.media_uri = p_object_name and r.deleted_at is null and e.deleted_at is null
                   and e.submitter_person_id = private.current_person_id()) end
      when s.kind = 'proof-of-performance' then
        private.can_capture_proof_photo(s.subject_id)
        or (not p_write and s.project_id in (select private.project_ids_with('vendors.vendor.read')))
      else s.project_id in (select private.project_ids_with(
        case when s.kind = 'incidents' then case when p_write then 'safety.incident.write' else 'safety.incident.read' end
             else case when p_write then 'safety.inspection.write' else 'safety.inspection.read' end end))
    end);
$$;

comment on function private.field_media_allowed(text, boolean) is 'True when the signed-in person may write (upload) or read a field-media object: the incident or inspection capability on the subject''s project; for kiosk punch photos (1328), org.time_attendance.write to write or read and crew.time_entry.read on the project to read; for expense receipts (1490), finance.expense.write on the project to write, and finance.expense.read there or having submitted the expense the photo belongs to, to read (1622); for proof-of-performance photos (2332), reaching the operational area of the Sponsor engagement the folder names to write or read, and vendors.vendor.read on its project to read. Access never crosses orgs, projects or engagements.';

-- 4. Recording a photo -------------------------------------------------------------------------------------------------

create function app.record_proof_of_performance_photo(
  p_id uuid,
  p_sponsor_entitlement_id uuid,
  p_media_uri text,
  p_captured_at timestamptz default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_uuid constant text := '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  v_uri text := btrim(coalesce(p_media_uri, ''));
  v_entitlement app.sponsor_entitlements;
  v_engagement app.engagements;
  v_existing app.proof_of_performance_photos;
begin
  if p_id is null then
    perform private.refuse('proof_photo_id_required', 'A photo recorded from a device carries its own id.');
  end if;
  if v_uri !~ ('^' || v_uuid || '/proof-of-performance/' || v_uuid || '/[^/]+$') then
    perform private.refuse('proof_photo_path',
      'The photo is stored under its org and the sponsor''s engagement: <org_id>/proof-of-performance/<engagement_id>/<file name>.');
  end if;

  -- The entitlement and the engagement the folder names must be the same sponsor's on the same project, and the
  -- caller must reach that engagement's operational area now. Anything else reads as not found, so nobody learns
  -- whether another party's entitlement exists.
  select * into v_entitlement from app.sponsor_entitlements s where s.id = p_sponsor_entitlement_id and s.deleted_at is null;
  select * into v_engagement from app.engagements e
  where e.id = split_part(v_uri, '/', 3)::uuid and e.org_id = split_part(v_uri, '/', 1)::uuid and e.deleted_at is null;
  if v_entitlement.id is null or v_engagement.id is null or v_engagement.role_type <> 'Sponsor'
     or v_engagement.project_id <> v_entitlement.project_id or v_engagement.counterparty_id is distinct from v_entitlement.counterparty_id
     or not private.can_capture_proof_photo(v_engagement.id) then
    raise exception using errcode = '42501',
      message = 'Proof photos are recorded only on an entitlement of your own active Sponsor engagement';
  end if;

  -- A replay of the same recording returns the photo it made; another person's or another entitlement's id is refused.
  select * into v_existing from app.proof_of_performance_photos f where f.id = p_id;
  if v_existing.id is not null then
    if v_existing.created_by is distinct from v_person or v_existing.sponsor_entitlement_id <> p_sponsor_entitlement_id
       or v_existing.media_uri <> v_uri then
      perform private.refuse('proof_photo_id_taken', 'Another photo already uses this id.');
    end if;
    return v_existing.id;
  end if;

  insert into app.proof_of_performance_photos (id, sponsor_entitlement_id, engagement_id, media_uri, captured_at)
  values (p_id, v_entitlement.id, v_engagement.id, v_uri, p_captured_at);
  return p_id;
end;
$$;

comment on function app.record_proof_of_performance_photo(uuid, uuid, text, timestamptz) is 'Records a proof-of-performance photo (already stored in field-media under its org and the sponsor''s engagement) against one sponsor entitlement, for a person who reaches the operational area of that Sponsor engagement now, from Compass online or offline (Section 4.5.7, Section 8.7). The entitlement must be the same sponsor''s on the engagement''s project. Idempotent on the device-minted id.';
revoke all on function app.record_proof_of_performance_photo(uuid, uuid, text, timestamptz) from public, anon;
grant execute on function app.record_proof_of_performance_photo(uuid, uuid, text, timestamptz) to authenticated, service_role;

insert into private.sync_rpcs (rpc, description) values
  ('app.record_proof_of_performance_photo', 'A sponsor records a proof-of-performance photo of an entitlement from Compass, online or offline.');

-- 5. The sponsor's projection ------------------------------------------------------------------------------------------
-- An owner-rights view with its own row filter, like the other Compass projections (2080): the photos of Sponsor
-- engagements the caller can capture on now, without person ids or audit columns.

create view api_external.proof_of_performance_photos as
select f.id, f.engagement_id, f.sponsor_entitlement_id, s.project_id, f.media_uri, f.captured_at, f.created_at
from app.proof_of_performance_photos f
join app.sponsor_entitlements s on s.id = f.sponsor_entitlement_id
where f.deleted_at is null and s.deleted_at is null and private.can_capture_proof_photo(f.engagement_id);

call private.describe('api_external.proof_of_performance_photos', 'Proof-of-performance photos of the caller''s Sponsor engagements while they can capture on them (Section 8.7: the engaged person or the sponsor account''s Owners, Admins and Members, while the engagement is Active or Closing). Compass shows the count on each entitlement.', array[
  'id', 'Photo.',
  'engagement_id', 'Sponsor engagement the photo was taken on.',
  'sponsor_entitlement_id', 'Entitlement photographed.',
  'project_id', 'Project of the entitlement.',
  'media_uri', 'Object name of the photo in the field-media bucket.',
  'captured_at', 'When the photo was taken, by the device clock.',
  'created_at', 'When the photo was recorded.'
]);

revoke all on api_external.proof_of_performance_photos from public, anon;
grant select on api_external.proof_of_performance_photos to authenticated, service_role;

select private.sync_trash_tables();
