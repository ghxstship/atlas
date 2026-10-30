-- 2820_credential_photos.sql
-- P5 Printable photo badges (RRR-219, gap G-144, ADR 0031 amendment). An org keeps one badge photo per credential holder,
-- given by the holder in Gateway, so a printed badge shows who wears it.
--
--   * app.credential_photos: per org and holder, the badge photo (an object in the private credential-photos bucket,
--     2821), where it came from, the consent the holder gave for it, and when the org last asked for one. Writes go only
--     through the functions of 2822; members read nothing directly but the rows of holders they read credentials of.
--   * Every stored photo has a consent record (purpose credential_photo, lawful basis consent): the holder uploads it or
--     chooses their own profile photo, and withdraws it at any time. There is no capture at a desk.
--   * The photo is Internal: it prints on a badge worn at the venue (DOCUMENT_CLASSIFICATION stays Internal), so no row
--     joins private.column_classifications. No machine learning reads a photo: cropping is manual, nothing detects
--     faces, and the table is excluded from AI features, so no biometric processing takes place.
--   * A removed photo is withdrawn consent or a wrong picture; it is collected again, never restored, so the table stays
--     out of Trash.

insert into private.consent_purposes (code, lawful_basis, sort_order) values ('credential_photo', 'consent', 125);

insert into private.domain_event_types (code, subject, description) values
  ('credential_photo.requested', 'credential_photos', 'An org asked a credential holder for a badge photo.'),
  ('credential_photo.provided', 'credential_photos', 'A credential holder gave the org a badge photo.'),
  ('credential_photo.removed', 'credential_photos', 'A badge photo was withdrawn by its holder or removed by the org.')
on conflict (code) do nothing;

create type app.credential_photo_source as enum ('Holder Upload', 'Holder Profile Photo');
comment on type app.credential_photo_source is 'Where a badge photo came from (P5): the holder uploaded it, or chose their own profile photo. Both carry the holder''s consent.';

create table app.credential_photos (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  person_id uuid not null references app.people (id),
  photo_path text,
  source app.credential_photo_source,
  provided_at timestamptz,
  provided_by uuid references app.people (id),
  consent_record_id uuid references app.consent_records (id),
  requested_at timestamptz,
  requested_by uuid references app.people (id),
  deleted_at timestamptz,
  constraint credential_photos_provided_together check (
    (photo_path is null) = (source is null) and (photo_path is null) = (provided_at is null)),
  constraint credential_photos_path_format check (
    photo_path is null or photo_path ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|png)$'),
  constraint credential_photos_path_owner check (
    photo_path is null or (split_part(photo_path, '/', 1) = org_id::text and split_part(photo_path, '/', 2) = person_id::text)),
  constraint credential_photos_consent check (photo_path is null or consent_record_id is not null),
  constraint credential_photos_requested_pair check ((requested_at is null) = (requested_by is null))
);

create unique index credential_photos_holder_key on app.credential_photos (org_id, person_id) where deleted_at is null;
create index credential_photos_person_id_idx on app.credential_photos (person_id);
create index credential_photos_consent_record_id_idx on app.credential_photos (consent_record_id);
create index credential_photos_provided_by_idx on app.credential_photos (provided_by);
create index credential_photos_requested_by_idx on app.credential_photos (requested_by);

call private.install_domain_table('app.credential_photos', null, null, array['app.consent_records', 'consent_record_id']);
call private.describe('app.credential_photos', 'The badge photo an org keeps for one credential holder (P5, ADR 0031 amendment): the object in the private credential-photos bucket, where it came from and the consent the holder gave, and when the org last asked for one. One live row per org and holder. The holder reads their own rows; a member who reads credentials on a project where the person holds a live credential reads theirs. Writes go only through app.request_credential_photos, app.record_credential_photo, app.remove_credential_photo and app.withdraw_my_credential_photos.', array[
  'person_id', 'Credential holder the photo shows.',
  'photo_path', 'Object name in the credential-photos bucket, <org_id>/<person_id>/<uuid>.jpg or .png; NULL while the org has only asked.',
  'source', 'Where the photo came from: the holder''s upload or their profile photo.',
  'provided_at', 'When the holder gave the photo.',
  'provided_by', 'Person who gave the photo: always the holder.',
  'consent_record_id', 'The holder''s credential_photo consent record; required whenever a photo is stored.',
  'requested_at', 'When the org last asked the holder for a photo; a second request waits 24 hours.',
  'requested_by', 'Who last asked the holder for a photo.'
]);

-- A live credential: not deleted, not revoked, and not past its end (2821, 2822 and the read policy use the same rule).
create or replace function private.credential_holder_live(p_org_id uuid, p_person_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from app.credentials c
    where c.org_id = p_org_id and c.holder_person_id = p_person_id and c.deleted_at is null
      and c.revoked_at is null and (c.valid_to is null or c.valid_to > now()));
$$;

comment on function private.credential_holder_live(uuid, uuid) is 'P5: true when the person holds a live credential in the org (not deleted, not revoked, and with no end or an end still ahead). Takes column values.';
revoke all on function private.credential_holder_live(uuid, uuid) from public, anon;
grant execute on function private.credential_holder_live(uuid, uuid) to authenticated, service_role;

create or replace function private.credential_photo_reader(p_org_id uuid, p_person_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from app.credentials c
    where c.org_id = p_org_id and c.holder_person_id = p_person_id and c.deleted_at is null
      and c.revoked_at is null and (c.valid_to is null or c.valid_to > now())
      and c.project_id in (select private.project_ids_with('credentials.credential.read')));
$$;

comment on function private.credential_photo_reader(uuid, uuid) is 'P5: true when the signed-in person reads credentials on a project where the person holds a live credential in the org, so they read the person''s badge photo there. Takes column values.';
revoke all on function private.credential_photo_reader(uuid, uuid) from public, anon;
grant execute on function private.credential_photo_reader(uuid, uuid) to authenticated, service_role;

call private.install_policies('app.credential_photos',
  $$person_id = (select private.current_person_id()) or private.credential_photo_reader(org_id, person_id)$$);
revoke insert, update on app.credential_photos from authenticated;

-- Retention: a removed or withdrawn photo row is kept 90 days as evidence of the consent and its withdrawal; its object
-- is gone already. A live photo whose holder has held no live credential in the org for 90 days should go too; no
-- nightly sweep takes a rule of that shape yet, so that cleanup is a follow-up (P5 report).
call private.install_default_retention('app.credential_photos', interval '90 days');
call private.install_audit_trail('app.credential_photos');

-- Audit diffs hold the object path of a face photo; the redactor hides it, the profile photo path included.
insert into private.personal_data_keys (json_key) values ('photo_path') on conflict (json_key) do nothing;

insert into private.ai_excluded_tables (table_name, reason) values
  ('app.credential_photos', 'Badge photos are face images; no AI feature reads them, so no biometric processing takes place (P5).');

insert into private.trash_excluded_tables (table_name, rationale) values
  ('credential_photos', 'A badge photo is replaced or collected again, never restored: a removed photo is withdrawn consent or a wrong picture.')
on conflict (table_name) do nothing;

select private.sync_trash_tables();
