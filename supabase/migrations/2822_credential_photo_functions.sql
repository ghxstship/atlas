-- 2822_credential_photo_functions.sql
-- P5 Printable photo badges (RRR-219, gap G-144, ADR 0031 amendment). The org asks for badge photos, the holder gives or
-- withdraws one, and every badge reads the photo it prints from one computation.
--
-- Resolution order, computed at read time and never stored:
--   1. the org's badge photo for the holder, once its object scanned Clean (Provided; Scanning while it is scanned,
--      Refused when the scan found it Infected or failed, or the object is gone);
--   2. otherwise the holder's profile photo (Profile) when the caller may see the photo section of their profile, no
--      block stands between them (ADR 0033 decision 57, 1206), and it is a JPEG or PNG of at most 2 MiB;
--   3. otherwise Requested while the org has asked, or Missing.
-- app.credential_photo_states is that computation, one row per live credential; app.credential_badge_photos and
-- app.my_credential_photos read it, so the badge, the print panel and Gateway never disagree.
--
-- Functions (security definer, search_path '', refusals through private.refuse):
--   * app.request_credential_photos: an issuer asks up to 100 credentials' holders for a photo, once per holder, at most
--     once a day, through the credential_photo.requested notification that opens /profile/badge-photos in Gateway.
--   * app.record_credential_photo: the holder records a photo they uploaded to their own folder, opening a
--     credential_photo consent record unless one stands; returns the photo it replaced so the caller removes it.
--   * app.remove_credential_photo: an issuer removes the holder's photo (soft delete) once it scanned Clean, or its object
--     is gone; returns the holder's Clean objects in the org's folder to delete.
--   * app.withdraw_my_credential_photos: the holder withdraws their photos and consent, in one org or all, and gets every
--     object of theirs still stored so they remove it (account deletion calls it first, 1670 is unchanged).
-- Domain event payloads carry ids only, never the object name.
-- Retention (C16): a live badge photo whose holder has held no live credential in the org for 90 days should be
-- soft-deleted and its object removed by the org's next cleanup. No nightly sweep takes such a rule yet, so it is a
-- follow-up; until then the org's issuer removes it, and an org purge removes every object (1351).

create type app.credential_photo_state as enum ('Provided', 'Scanning', 'Refused', 'Profile', 'Requested', 'Missing');
comment on type app.credential_photo_state is 'The photo a badge prints (P5), in resolution order: Provided (the org''s badge photo, scanned Clean), Scanning (being scanned), Refused (found Infected, the scan failed, or the object is gone), Profile (the holder''s visible profile photo), Requested (asked, none given) or Missing.';

-- Helpers ------------------------------------------------------------------------------------------------------------

create or replace function private.credential_photo_scan(p_photo_path text)
returns app.scan_status
language sql
stable
security definer
set search_path = ''
as $$
  select s.scan_status from private.object_scans s where s.bucket_id = 'credential-photos' and s.object_name = p_photo_path;
$$;

comment on function private.credential_photo_scan(text) is 'P5: the scan state of a credential-photos object, or NULL when the object or its scan row is gone. Takes the name as a value.';
revoke all on function private.credential_photo_scan(text) from public, anon;
-- Called inside the security_invoker view app.credential_photo_states, so signed-in users need it.
grant execute on function private.credential_photo_scan(text) to authenticated, service_role;

create or replace function private.badge_profile_photo(p_person_id uuid)
returns table (photo_path text, content_type text, size_bytes bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select pp.photo_path, lower(o.metadata ->> 'mimetype'), (o.metadata ->> 'size')::bigint
  from app.person_profiles pp
  join storage.objects o on o.bucket_id = 'profile-media' and o.name = pp.photo_path
  where pp.person_id = p_person_id and pp.deleted_at is null and pp.photo_path is not null
    and private.section_visible_to_me(pp.person_id, pp.visibility, 'photo')
    and not private.blocked_between(private.current_person_id(), p_person_id)
    and lower(o.metadata ->> 'mimetype') in ('image/jpeg', 'image/png')
    and (o.metadata ->> 'size')::bigint <= 2097152;
$$;

comment on function private.badge_profile_photo(uuid) is 'P5: the person''s profile photo a badge may print for the signed-in caller: only when the caller sees the photo section of the profile (0860), no block stands between them (1206), and the object in profile-media is a JPEG or PNG of at most 2 MiB (2,097,152 bytes, from its storage metadata). No row otherwise.';
revoke all on function private.badge_profile_photo(uuid) from public, anon;
grant execute on function private.badge_profile_photo(uuid) to authenticated, service_role;

-- The one computation -----------------------------------------------------------------------------------------------

create view app.credential_photo_states with (security_invoker = true) as
select c.id as credential_id, c.org_id, c.holder_person_id,
  (case
    when p.photo_path is not null and private.credential_photo_scan(p.photo_path) = 'Clean' then 'Provided'
    when p.photo_path is not null and private.credential_photo_scan(p.photo_path) = 'Scanning' then 'Scanning'
    when p.photo_path is not null then 'Refused'
    when exists (select 1 from private.badge_profile_photo(c.holder_person_id)) then 'Profile'
    when p.requested_at is not null then 'Requested'
    else 'Missing'
  end)::app.credential_photo_state as photo_state,
  p.requested_at, p.provided_at, p.source
from app.credentials c
left join app.credential_photos p on p.org_id = c.org_id and p.person_id = c.holder_person_id and p.deleted_at is null
where c.deleted_at is null and c.revoked_at is null and (c.valid_to is null or c.valid_to > now());

call private.describe('app.credential_photo_states', 'The photo each live credential''s badge prints (P5), for the credential list, the print panel and the badge: one row per live credential the caller reads, with the state in resolution order (Provided, Scanning, Refused, Profile, Requested, Missing). Reads with the caller''s own row level security.', array[
  'credential_id', 'Credential.', 'org_id', 'Org of the credential.', 'holder_person_id', 'Credential holder.',
  'photo_state', 'Photo the badge prints, in resolution order.', 'requested_at', 'When the org last asked the holder for a photo.',
  'provided_at', 'When the holder gave the badge photo.', 'source', 'Where the badge photo came from.']);

revoke all on app.credential_photo_states from public, anon;
grant select on app.credential_photo_states to authenticated, service_role;
-- 1650 gives the backup login every new relation; this view joins face photo state to people, so it is not backed up.
revoke select on app.credential_photo_states from xos_backup;

create or replace function app.credential_badge_photos(p_credential_ids uuid[])
returns table (
  credential_id uuid, holder_person_id uuid, photo_state app.credential_photo_state, bucket_id text, photo_path text,
  requested_at timestamptz, provided_at timestamptz, source app.credential_photo_source
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if coalesce(cardinality(p_credential_ids), 0) > 100 then
    perform private.refuse('credential_photo_batch_size', 'Ask for the photos of 1 to 100 credentials at a time.');
  end if;
  return query
  select s.credential_id, s.holder_person_id, s.photo_state,
    case s.photo_state when 'Provided' then 'credential-photos' when 'Profile' then 'profile-media' end,
    case s.photo_state
      when 'Provided' then p.photo_path
      when 'Profile' then (select b.photo_path from private.badge_profile_photo(s.holder_person_id) b limit 1)
    end,
    s.requested_at, s.provided_at, s.source
  from app.credential_photo_states s
  join app.credentials c on c.id = s.credential_id
  left join app.credential_photos p on p.org_id = s.org_id and p.person_id = s.holder_person_id and p.deleted_at is null
  where s.credential_id = any(p_credential_ids)
    and (c.holder_person_id = private.current_person_id()
         or c.project_id in (select private.project_ids_with('credentials.credential.read')));
end;
$$;

comment on function app.credential_badge_photos(uuid[]) is 'P5: for up to 100 live credentials the caller reads (the holder, or credentials.credential.read on the project), the photo the badge prints: its state from app.credential_photo_states and, for Provided and Profile only, the bucket and object name to read it from. Refuses more than 100 ids (credential_photo_batch_size).';
revoke all on function app.credential_badge_photos(uuid[]) from public, anon;
grant execute on function app.credential_badge_photos(uuid[]) to authenticated, service_role;

create or replace function app.my_credential_photos()
returns table (
  org_id uuid, org_name text, photo_state app.credential_photo_state, source app.credential_photo_source,
  provided_at timestamptz, photo_path text, has_profile_photo boolean, holds_credential boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  with live as (
    select distinct on (s.org_id) s.org_id, o.name as org_name, s.photo_state, s.source, s.provided_at, p.photo_path,
      exists (select 1 from private.badge_profile_photo(s.holder_person_id)) as has_profile_photo, true as holds_credential
    from app.credential_photo_states s
    join app.organizations o on o.id = s.org_id
    left join app.credential_photos p on p.org_id = s.org_id and p.person_id = s.holder_person_id and p.deleted_at is null
    where s.holder_person_id = private.current_person_id()
    order by s.org_id
  ),
  -- An org whose credentials of the holder all lapsed still keeps their photo and consent until they withdraw them.
  lapsed as (
    select p.org_id, o.name as org_name,
      (case private.credential_photo_scan(p.photo_path)
        when 'Clean' then 'Provided' when 'Scanning' then 'Scanning' else 'Refused'
      end)::app.credential_photo_state as photo_state,
      p.source, p.provided_at, p.photo_path, false as has_profile_photo, false as holds_credential
    from app.credential_photos p
    join app.organizations o on o.id = p.org_id
    where p.person_id = private.current_person_id() and p.deleted_at is null and p.photo_path is not null
      and not exists (select 1 from live l where l.org_id = p.org_id)
  )
  select * from live
  union all
  select * from lapsed
  order by 1;
$$;

comment on function app.my_credential_photos() is 'P5: for the signed-in person, one row per org where they hold a live credential (holds_credential): the photo their badge prints there, where it came from and when, the object name of their badge photo (for their own thumbnail) and whether their profile photo can stand in (a JPEG or PNG of at most 2 MiB). An org where they hold no live credential any more but that still keeps their badge photo has a row too, with holds_credential false, so they can withdraw it.';
revoke all on function app.my_credential_photos() from public, anon;
grant execute on function app.my_credential_photos() to authenticated, service_role;

-- Asking for photos ---------------------------------------------------------------------------------------------------

create or replace function app.request_credential_photos(p_credential_ids uuid[])
returns table (credential_id uuid, outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_person();
  v_ids uuid[] := array(select distinct u.id from unnest(p_credential_ids) as u(id) where u.id is not null);
  v_cred record;
  v_done jsonb := '{}'::jsonb;
  v_key text;
  v_outcome text;
  v_photo app.credential_photos;
  v_scan app.scan_status;
begin
  if coalesce(cardinality(v_ids), 0) not between 1 and 100 then
    perform private.refuse('credential_photo_batch_size', 'Ask for the photos of 1 to 100 credentials at a time.');
  end if;
  for v_cred in
    select u.id, c.org_id, c.holder_person_id, c.project_id, o.name as org_name, pe.user_id,
      (c.id is not null and c.deleted_at is null and c.revoked_at is null and (c.valid_to is null or c.valid_to > now())
       and c.project_id in (select private.project_ids_with('credentials.credential.issue'))) as allowed
    from unnest(v_ids) as u(id)
    left join app.credentials c on c.id = u.id
    left join app.organizations o on o.id = c.org_id
    left join app.people pe on pe.id = c.holder_person_id
    order by u.id
  loop
    if not v_cred.allowed then
      credential_id := v_cred.id;
      outcome := 'not_allowed';
      return next;
      continue;
    end if;
    v_key := v_cred.org_id::text || ':' || v_cred.holder_person_id::text;
    if v_done ? v_key then
      credential_id := v_cred.id;
      outcome := v_done ->> v_key;
      return next;
      continue;
    end if;
    select * into v_photo from app.credential_photos p
    where p.org_id = v_cred.org_id and p.person_id = v_cred.holder_person_id and p.deleted_at is null
    for update;
    v_scan := case when v_photo.photo_path is not null then private.credential_photo_scan(v_photo.photo_path) end;
    if v_scan in ('Clean', 'Scanning') then
      v_outcome := 'already_provided';
    elsif v_photo.requested_at is not null and v_photo.requested_at > now() - interval '24 hours' then
      v_outcome := 'recently_requested';
    elsif v_cred.user_id is null then
      v_outcome := 'no_sign_in';
    else
      if v_photo.id is null then
        insert into app.credential_photos (org_id, person_id, requested_at, requested_by)
        values (v_cred.org_id, v_cred.holder_person_id, now(), v_me)
        returning * into v_photo;
      else
        update app.credential_photos p set requested_at = now(), requested_by = v_me
        where p.id = v_photo.id
        returning * into v_photo;
      end if;
      perform private.emit_event(v_cred.org_id, 'credential_photo.requested', 'credential_photos', v_photo.id, v_cred.project_id,
        jsonb_build_object('credential_photo_id', v_photo.id, 'person_id', v_cred.holder_person_id, 'credential_id', v_cred.id));
      v_outcome := case
        when private.notify(v_cred.org_id, v_cred.holder_person_id, 'credential_photo.requested', 'app.credentials', v_cred.id,
               v_cred.project_id, jsonb_build_object('orgName', v_cred.org_name, 'gatewayPath', '/profile/badge-photos')) is null
          then 'not_notified'
        else 'requested'
      end;
    end if;
    v_done := v_done || jsonb_build_object(v_key, v_outcome);
    credential_id := v_cred.id;
    outcome := v_outcome;
    return next;
  end loop;
end;
$$;

comment on function app.request_credential_photos(uuid[]) is 'P5: asks the holders of 1 to 100 credentials for a badge photo (credential_photo_batch_size otherwise). Per credential the caller needs credentials.credential.issue on its project and a live credential (not_allowed). Once per holder: already_provided (a photo is Provided or Scanning), recently_requested (asked within 24 hours), no_sign_in (the holder has no sign-in), or requested, which stamps requested_at and sends credential_photo.requested opening /profile/badge-photos in Gateway (not_notified when the holder takes no notification from the org).';
revoke all on function app.request_credential_photos(uuid[]) from public, anon;
grant execute on function app.request_credential_photos(uuid[]) to authenticated, service_role;

-- The holder gives a photo --------------------------------------------------------------------------------------------

create or replace function app.record_credential_photo(
  p_org_id uuid,
  p_photo_path text,
  p_source app.credential_photo_source,
  p_notice_version text
)
returns table (credential_photo_id uuid, replaced_path text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_person();
  v_photo app.credential_photos;
  v_consent uuid;
  v_replaced text;
begin
  if p_source is null then
    perform private.refuse('credential_photo_path', 'Upload the photo to your own folder, then record it.');
  end if;
  if not exists (select 1 from private.credential_photo_object(p_photo_path) o where o.org_id = p_org_id and o.person_id = v_me) then
    perform private.refuse('credential_photo_path', 'Upload the photo to your own folder, then record it.');
  end if;
  if not private.credential_holder_live(p_org_id, v_me) then
    perform private.refuse('credential_photo_no_credential', 'You hold no live credential with this organization, so it takes no badge photo from you.');
  end if;
  if not exists (
    select 1 from storage.objects o
    where o.bucket_id = 'credential-photos' and o.name = p_photo_path and o.owner_id = (select auth.uid())::text) then
    perform private.refuse('credential_photo_path', 'Upload the photo to your own folder, then record it.');
  end if;
  if char_length(btrim(coalesce(p_notice_version, ''))) not between 1 and 50 then
    perform private.refuse('credential_photo_notice', 'Name the version of the notice you were shown, in 1 to 50 characters.');
  end if;
  select r.id into v_consent from app.consent_records r
  where r.org_id = p_org_id and r.person_id = v_me and r.purpose_code = 'credential_photo'
    and r.withdrawn_at is null and r.deleted_at is null
  order by r.captured_at desc limit 1;
  if v_consent is null then
    insert into app.consent_records (org_id, person_id, purpose_code, notice_version, source)
    values (p_org_id, v_me, 'credential_photo', btrim(p_notice_version), 'Web')
    returning id into v_consent;
  end if;
  select * into v_photo from app.credential_photos p
  where p.org_id = p_org_id and p.person_id = v_me and p.deleted_at is null
  for update;
  if v_photo.id is null then
    insert into app.credential_photos (org_id, person_id, photo_path, source, provided_at, provided_by, consent_record_id)
    values (p_org_id, v_me, p_photo_path, p_source, now(), v_me, v_consent)
    returning * into v_photo;
  else
    v_replaced := nullif(v_photo.photo_path, p_photo_path);
    update app.credential_photos p
    set photo_path = p_photo_path, source = p_source, provided_at = now(), provided_by = v_me, consent_record_id = v_consent
    where p.id = v_photo.id
    returning * into v_photo;
  end if;
  perform private.emit_event(p_org_id, 'credential_photo.provided', 'credential_photos', v_photo.id, null,
    jsonb_build_object('credential_photo_id', v_photo.id, 'person_id', v_me));
  credential_photo_id := v_photo.id;
  replaced_path := v_replaced;
  return next;
end;
$$;

comment on function app.record_credential_photo(uuid, text, app.credential_photo_source, text) is 'P5: the holder records a badge photo they uploaded to their own folder of the org (credential_photo_path otherwise: the object must be theirs, named <org>/<them>/<uuid>.jpg or .png), while they hold a live credential there (credential_photo_no_credential). Opens a credential_photo consent record with the notice version shown (Web) unless one stands, stores the photo and emits credential_photo.provided. Returns the photo id and the object it replaced, which the caller removes.';
revoke all on function app.record_credential_photo(uuid, text, app.credential_photo_source, text) from public, anon;
grant execute on function app.record_credential_photo(uuid, text, app.credential_photo_source, text) to authenticated, service_role;

-- Removing and withdrawing --------------------------------------------------------------------------------------------

create or replace function app.remove_credential_photo(p_org_id uuid, p_person_id uuid)
returns setof text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_photo app.credential_photos;
  v_scan app.scan_status;
begin
  perform private.require_person();
  if not private.credential_photo_issuer(p_org_id, p_person_id) then
    perform private.refuse('credential_photo_not_issuer', 'Only an issuer of this person''s credentials removes their badge photo.');
  end if;
  select * into v_photo from app.credential_photos p
  where p.org_id = p_org_id and p.person_id = p_person_id and p.deleted_at is null
  for update;
  if v_photo.id is null then
    return;
  end if;
  -- The restrictive read gate (2821) lets only the holder or a Clean object through, so an issuer can delete an object
  -- only once it scanned Clean. One still being scanned waits for its verdict; one the scanner could not clear stays
  -- for its holder to replace or remove. A photo whose object the scanner already deleted is simply removed.
  if v_photo.photo_path is not null
     and exists (select 1 from storage.objects o where o.bucket_id = 'credential-photos' and o.name = v_photo.photo_path) then
    v_scan := private.credential_photo_scan(v_photo.photo_path);
    if v_scan is null or v_scan in ('Pending Upload', 'Scanning') then
      perform private.refuse('credential_photo_scanning', 'This photo is still being scanned. Remove it once the scan finishes, in a few minutes.');
    elsif v_scan <> 'Clean' then
      perform private.refuse('credential_photo_unscanned', 'This photo could not be cleared by the virus scan, so only its holder can delete it. Ask them to replace or remove it in Gateway.');
    end if;
  end if;
  update app.credential_photos p set deleted_at = now() where p.id = v_photo.id;
  perform private.emit_event(p_org_id, 'credential_photo.removed', 'credential_photos', v_photo.id, null,
    jsonb_build_object('credential_photo_id', v_photo.id, 'person_id', p_person_id));
  return query
  select s.name
  from storage.objects s
  cross join lateral private.credential_photo_object(s.name) o
  where s.bucket_id = 'credential-photos' and o.org_id = p_org_id and o.person_id = p_person_id
    and private.credential_photo_scan(s.name) = 'Clean'
  order by s.name;
end;
$$;

comment on function app.remove_credential_photo(uuid, uuid) is 'P5: an issuer of the org (credentials.credential.issue on a project where the person holds or held a credential; credential_photo_not_issuer otherwise) removes the person''s badge photo, a soft delete, and gets every Clean object of the person still stored in the org''s folder, the removed photo and replaced copies, which the caller deletes. Nothing when there was no photo or its object is gone. Refuses while the photo is being scanned (credential_photo_scanning) or when the scan could not clear it (credential_photo_unscanned): the read gate keeps such an object from everyone but its holder. The consent record stays: the holder withdraws it themselves.';
revoke all on function app.remove_credential_photo(uuid, uuid) from public, anon;
grant execute on function app.remove_credential_photo(uuid, uuid) to authenticated, service_role;

create or replace function app.withdraw_my_credential_photos(p_org_id uuid default null)
returns table (org_id uuid, photo_path text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_person();
  v_photo record;
begin
  for v_photo in
    update app.credential_photos p set deleted_at = now()
    where p.person_id = v_me and p.deleted_at is null and (p_org_id is null or p.org_id = p_org_id)
    returning p.id, p.org_id
  loop
    perform private.emit_event(v_photo.org_id, 'credential_photo.removed', 'credential_photos', v_photo.id, null,
      jsonb_build_object('credential_photo_id', v_photo.id, 'person_id', v_me));
  end loop;
  update app.consent_records r set withdrawn_at = now()
  where r.person_id = v_me and r.purpose_code = 'credential_photo' and r.withdrawn_at is null and r.deleted_at is null
    and (p_org_id is null or r.org_id = p_org_id);
  return query
  select o.org_id, s.name
  from storage.objects s
  cross join lateral private.credential_photo_object(s.name) o
  where s.bucket_id = 'credential-photos' and o.person_id = v_me and (p_org_id is null or o.org_id = p_org_id)
  order by s.name;
end;
$$;

comment on function app.withdraw_my_credential_photos(uuid) is 'P5: the signed-in holder withdraws their badge photos in one org, or in every org when NULL: the rows are soft-deleted, the credential_photo consent records closed (withdrawn_at) and credential_photo.removed emitted. Returns every object of theirs still stored in those orgs'' folders, replaced copies included, so the caller removes them; account deletion calls it before app.delete_my_account.';
revoke all on function app.withdraw_my_credential_photos(uuid) from public, anon;
grant execute on function app.withdraw_my_credential_photos(uuid) to authenticated, service_role;
