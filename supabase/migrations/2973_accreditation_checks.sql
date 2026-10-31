-- 2973_accreditation_checks.sql
-- B8 One accreditation list (RRR-232, gap G-147, ADR 0147 decision 5). The Issued page is the one list of everyone
-- accredited on a project, crew, members, party and roster people alike; guests stay on the guest list with passes
-- (2974). This migration:
--
--   * refuses a duplicate (t45_guard_credential_duplicate): a second live credential of the same Access category for
--     the same holder whose window overlaps a live one. Parking categories are exempt, because one person may hold
--     passes for several vehicles (R5 app.roster_vehicles). The guard also runs when deleted_at or revoked_at changes:
--     credentials are not in Trash (1031), so a deleted_at cleared by hand must not bring a duplicate back. Moving a
--     credential to revoked is always allowed. An R7 allocation of an Access category to one person with a quantity of
--     2 or more therefore refuses its second issue with credential_duplicate (ADR 0147 decision 5);
--   * answers, for a holder, whether they are booked elsewhere in the org (a live overlapping credential or a live
--     overlapping engagement on another project), with app.credential_bookings_elsewhere naming only the projects the
--     caller can read;
--   * adds app.credential_review, one row per credential the reader can read with its checks, for the Issued page's
--     chips and "Needs attention" filter, and the accreditation rows of app.credential_issue_check.
--
-- The view scans app.credentials, so its definer helpers take column values and never a credential id (ADR 0016 rule
-- 14), and each answers nothing to a reader without credentials.credential.read on the project, so none is an oracle.

-- The duplicate rule ------------------------------------------------------------------------------------------------------

create function private.guard_credential_duplicate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_other uuid;
begin
  if new.revoked_at is not null or new.deleted_at is not null then
    return new;
  end if;
  if (select c.category_kind from app.credential_categories c where c.id = new.credential_category_id) <> 'Access' then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('credential_duplicate:' || new.holder_person_id || ':' || new.credential_category_id, 0));
  select c.id into v_other from app.credentials c
  where c.holder_person_id = new.holder_person_id and c.credential_category_id = new.credential_category_id
    and c.id <> new.id and c.deleted_at is null and c.revoked_at is null
    and tstzrange(c.valid_from, coalesce(c.valid_to, 'infinity')) && tstzrange(new.valid_from, coalesce(new.valid_to, 'infinity'))
  limit 1;
  if v_other is not null then
    perform private.refuse('credential_duplicate',
      'This person already holds a live credential of this category for an overlapping window. Revoke the earlier credential first, or change the window.');
  end if;
  return new;
end;
$$;
comment on function private.guard_credential_duplicate() is 'Credentials (ADR 0147 decision 5): one live credential per holder and Access category per window. Refuses credential_duplicate when another live (not deleted, not revoked) credential of the same holder and Access category overlaps [valid_from, valid_to). Parking categories are exempt. Moving to revoked is always allowed; restoring a deleted or unrevoked state is checked. Serialized per holder and category with an advisory lock.';
revoke all on function private.guard_credential_duplicate() from public, anon, authenticated;
create trigger t45_guard_credential_duplicate before insert or update of valid_from, valid_to, deleted_at, revoked_at on app.credentials
  for each row execute function private.guard_credential_duplicate();

-- Booked elsewhere --------------------------------------------------------------------------------------------------------------

create function private.holder_booked_elsewhere(
  p_org_id uuid,
  p_project_id uuid,
  p_holder_person_id uuid,
  p_valid_from timestamptz,
  p_valid_to timestamptz,
  p_exclude_credential_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.can_on_project(p_project_id, 'credentials.credential.read') then
    return false;
  end if;
  return exists (
      select 1 from app.credentials c
      where c.org_id = p_org_id and c.holder_person_id = p_holder_person_id and c.project_id <> p_project_id
        and c.id is distinct from p_exclude_credential_id and c.deleted_at is null and c.revoked_at is null
        and tstzrange(c.valid_from, coalesce(c.valid_to, 'infinity')) && tstzrange(p_valid_from, coalesce(p_valid_to, 'infinity')))
    or exists (
      select 1 from app.engagements e
      join app.projects pr on pr.id = e.project_id
      where e.org_id = p_org_id and e.person_id = p_holder_person_id and e.project_id <> p_project_id
        and e.deleted_at is null and e.engagement_state in ('Onboarding', 'Blocked', 'Active', 'Closing')
        and daterange(e.start_date, coalesce(e.end_date, e.start_date), '[]')
            && daterange((p_valid_from at time zone pr.time_zone)::date,
                         case when p_valid_to is null then null else (p_valid_to at time zone pr.time_zone)::date end, '[]'));
end;
$$;
comment on function private.holder_booked_elsewhere(uuid, uuid, uuid, timestamptz, timestamptz, uuid) is 'True when the holder, in the same org, has on another project a live credential whose window overlaps, or a live engagement (Onboarding, Blocked, Active or Closing) whose days overlap the window''s days in that project''s time zone (gap G-147). Takes values, never a credential id (ADR 0016 rule 14); false for a caller without credentials.credential.read on the project.';
revoke all on function private.holder_booked_elsewhere(uuid, uuid, uuid, timestamptz, timestamptz, uuid) from public, anon;
grant execute on function private.holder_booked_elsewhere(uuid, uuid, uuid, timestamptz, timestamptz, uuid) to authenticated, service_role;

create function private.same_name_holders(p_project_id uuid, p_holder_person_id uuid)
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.can_on_project(p_project_id, 'credentials.credential.read') then
    return 0;
  end if;
  return (
    select count(distinct c.holder_person_id)::integer
    from app.credentials c
    join app.people o on o.id = c.holder_person_id
    join app.people h on h.id = p_holder_person_id
    where c.project_id = p_project_id and c.holder_person_id <> p_holder_person_id and c.deleted_at is null
      and lower(btrim(o.full_name)) = lower(btrim(h.full_name)));
end;
$$;
comment on function private.same_name_holders(uuid, uuid) is 'How many other people hold credentials on the project under the same name, ignoring case and outer spaces: perhaps the same person twice. Takes values (ADR 0016 rule 14); 0 for a caller without credentials.credential.read on the project.';
revoke all on function private.same_name_holders(uuid, uuid) from public, anon;
grant execute on function private.same_name_holders(uuid, uuid) to authenticated, service_role;

create function private.holder_is_member(p_project_id uuid, p_org_id uuid, p_person_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.can_on_project(p_project_id, 'credentials.credential.read') then
    return false;
  end if;
  return exists (select 1 from app.memberships m
                 where m.org_id = p_org_id and m.person_id = p_person_id and m.deleted_at is null
                   and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now()));
end;
$$;
comment on function private.holder_is_member(uuid, uuid, uuid) is 'True when the holder is a current member of the org, for app.credential_review''s holder source; a reader of the project''s credentials need not read the member directory. Takes values (ADR 0016 rule 14); false without credentials.credential.read on the project.';
revoke all on function private.holder_is_member(uuid, uuid, uuid) from public, anon;
grant execute on function private.holder_is_member(uuid, uuid, uuid) to authenticated, service_role;

create function app.credential_bookings_elsewhere(p_credential_id uuid)
returns table (
  project_id uuid,
  project_key text,
  kind text,
  starts_at timestamptz,
  ends_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_credential app.credentials;
begin
  perform private.require_person();
  select * into v_credential from app.credentials c where c.id = p_credential_id and c.deleted_at is null;
  if v_credential.id is null or not private.can_on_project(v_credential.project_id, 'credentials.credential.read') then
    raise exception using errcode = '42501', message = 'the credential does not exist or is not visible';
  end if;
  return query
    with bookings as (
      select c.project_id as pid, 'Credential'::text as k, c.valid_from as s, c.valid_to as e
      from app.credentials c
      where c.org_id = v_credential.org_id and c.holder_person_id = v_credential.holder_person_id
        and c.project_id <> v_credential.project_id and c.deleted_at is null and c.revoked_at is null
        and tstzrange(c.valid_from, coalesce(c.valid_to, 'infinity'))
            && tstzrange(v_credential.valid_from, coalesce(v_credential.valid_to, 'infinity'))
      union all
      select e.project_id, 'Engagement'::text, (e.start_date::timestamp at time zone pr.time_zone),
        ((coalesce(e.end_date, e.start_date) + 1)::timestamp at time zone pr.time_zone)
      from app.engagements e
      join app.projects pr on pr.id = e.project_id
      where e.org_id = v_credential.org_id and e.person_id = v_credential.holder_person_id
        and e.project_id <> v_credential.project_id and e.deleted_at is null
        and e.engagement_state in ('Onboarding', 'Blocked', 'Active', 'Closing')
        and daterange(e.start_date, coalesce(e.end_date, e.start_date), '[]')
            && daterange((v_credential.valid_from at time zone pr.time_zone)::date,
                         case when v_credential.valid_to is null then null
                              else (v_credential.valid_to at time zone pr.time_zone)::date end, '[]')
    )
    select case when b.pid in (select private.readable_project_ids()) then b.pid end,
      (select p.project_key from app.projects p where p.id = b.pid and p.id in (select private.readable_project_ids())),
      b.k, b.s, b.e
    from bookings b
    order by b.s, b.k;
end;
$$;
comment on function app.credential_bookings_elsewhere(uuid) is 'Where else in the org a credential''s holder is booked during its window (gap G-147): live overlapping credentials and live overlapping engagements on other projects. Needs credentials.credential.read on the credential''s project. The project id and key are NULL for a project the caller cannot read, which the page shows as another production.';
revoke all on function app.credential_bookings_elsewhere(uuid) from public, anon;
grant execute on function app.credential_bookings_elsewhere(uuid) to authenticated, service_role;

-- The review view ------------------------------------------------------------------------------------------------------------

create view app.credential_review with (security_invoker = on) as
select c.id as credential_id, c.org_id, c.project_id, c.holder_person_id,
  case
    when c.allocation_id is not null then 'Allocation'
    when c.engagement_id is not null then 'Engagement'
    when private.holder_is_member(c.project_id, c.org_id, c.holder_person_id) then 'Member'
    else 'Direct'
  end as holder_source,
  (select count(*)::integer from app.credentials o
   where o.project_id = c.project_id and o.holder_person_id = c.holder_person_id
     and o.credential_category_id <> c.credential_category_id and o.deleted_at is null and o.revoked_at is null) as other_badges_on_project,
  private.same_name_holders(c.project_id, c.holder_person_id) as same_name_on_project,
  (cc.category_kind = 'Access' and c.revoked_at is null and exists (
     select 1 from app.credentials o
     where o.holder_person_id = c.holder_person_id and o.credential_category_id = c.credential_category_id and o.id <> c.id
       and o.deleted_at is null and o.revoked_at is null
       and tstzrange(o.valid_from, coalesce(o.valid_to, 'infinity')) && tstzrange(c.valid_from, coalesce(c.valid_to, 'infinity')))) as duplicate_live,
  (select count(*)::integer from private.credential_requirements_missing(c.credential_category_id, c.holder_person_id, c.valid_to) m
   where not m.is_met) as missing_requirements,
  private.holder_booked_elsewhere(c.org_id, c.project_id, c.holder_person_id, c.valid_from, c.valid_to, c.id) as booked_elsewhere
from app.credentials c
join app.credential_categories cc on cc.id = c.credential_category_id
where c.deleted_at is null;

call private.describe('app.credential_review', 'The accreditation checks of each credential the reader can read (gap G-147, ADR 0147 decision 5), for the Issued page. Runs as the reader; its helpers answer only with credentials.credential.read on the project.', array[
  'credential_id', 'Credential.',
  'org_id', 'Org.',
  'project_id', 'Project.',
  'holder_person_id', 'Holder.',
  'holder_source', 'How the holder came to be accredited: Allocation (issued under an R7 allocation), Engagement, Member (a current member of the org) or Direct.',
  'other_badges_on_project', 'Live credentials of the same holder on the same project in another category.',
  'same_name_on_project', 'Other holders on the project with the same name, ignoring case and outer spaces.',
  'duplicate_live', 'Another live credential of the same holder and Access category overlaps this one. Only possible for credentials issued before migration 2973.',
  'missing_requirements', 'Requirements of the category the holder does not meet now.',
  'booked_elsewhere', 'The holder has a live overlapping credential or engagement on another project of the org.'
]);
revoke all on app.credential_review from public, anon;
grant select on app.credential_review to authenticated, service_role;
revoke select on app.credential_review from xos_backup;

insert into private.view_column_sources (view_name, column_name, source_table, source_column) values
  ('app.credential_review', 'credential_id', 'app.credentials', 'id');

-- The issue form's checks (from 2972) -----------------------------------------------------------------------------------------

create or replace function app.credential_issue_check(
  p_category_id uuid,
  p_holder_person_id uuid,
  p_valid_from timestamptz default null,
  p_valid_to timestamptz default null
)
returns table (
  check_code text,
  blocking boolean,
  requirement_id uuid,
  title text,
  other_credential_id uuid,
  project_id uuid,
  project_key text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_category app.credential_categories;
  v_from timestamptz := coalesce(p_valid_from, now());
begin
  perform private.require_person();
  select * into v_category from app.credential_categories c where c.id = p_category_id and c.deleted_at is null;
  if v_category.id is null or not private.can_on_project(v_category.project_id, 'credentials.credential.issue') then
    raise exception using errcode = '42501', message = 'credentials.credential.issue is required on the project';
  end if;
  return query
    select case when s.is_met then 'training_expires_first' else 'training_missing' end, not s.is_met, s.requirement_id,
      s.title, null::uuid, null::uuid, null::text
    from private.credential_requirements_state(p_category_id, p_holder_person_id, p_valid_to) s
    where not s.is_met or s.expires_at is not null;
  if v_category.category_kind = 'Access' then
    return query
      select 'duplicate'::text, true, null::uuid, null::text, c.id, null::uuid, null::text
      from app.credentials c
      where c.holder_person_id = p_holder_person_id and c.credential_category_id = p_category_id
        and c.deleted_at is null and c.revoked_at is null
        and tstzrange(c.valid_from, coalesce(c.valid_to, 'infinity')) && tstzrange(v_from, coalesce(p_valid_to, 'infinity'));
  end if;
  return query
    select 'other_badge_on_project'::text, false, null::uuid, k.name, c.id, null::uuid, null::text
    from app.credentials c
    join app.credential_categories k on k.id = c.credential_category_id
    where c.project_id = v_category.project_id and c.holder_person_id = p_holder_person_id
      and c.credential_category_id <> p_category_id and c.deleted_at is null and c.revoked_at is null;
  if private.same_name_holders(v_category.project_id, p_holder_person_id) > 0 then
    return query select 'same_name_on_project'::text, false, null::uuid, null::text, null::uuid, null::uuid, null::text;
  end if;
  if private.holder_booked_elsewhere(v_category.org_id, v_category.project_id, p_holder_person_id, v_from, p_valid_to, null) then
    return query
      select 'booked_elsewhere'::text, false, null::uuid, null::text, null::uuid,
        case when b.pid in (select private.readable_project_ids()) then b.pid end,
        (select p.project_key from app.projects p where p.id = b.pid and p.id in (select private.readable_project_ids()))
      from (
        select distinct c.project_id as pid from app.credentials c
        where c.org_id = v_category.org_id and c.holder_person_id = p_holder_person_id and c.project_id <> v_category.project_id
          and c.deleted_at is null and c.revoked_at is null
          and tstzrange(c.valid_from, coalesce(c.valid_to, 'infinity')) && tstzrange(v_from, coalesce(p_valid_to, 'infinity'))
        union
        select e.project_id from app.engagements e
        join app.projects pr on pr.id = e.project_id
        where e.org_id = v_category.org_id and e.person_id = p_holder_person_id and e.project_id <> v_category.project_id
          and e.deleted_at is null and e.engagement_state in ('Onboarding', 'Blocked', 'Active', 'Closing')
          and daterange(e.start_date, coalesce(e.end_date, e.start_date), '[]')
              && daterange((v_from at time zone pr.time_zone)::date,
                           case when p_valid_to is null then null else (p_valid_to at time zone pr.time_zone)::date end, '[]')
      ) b;
  end if;
end;
$$;
comment on function app.credential_issue_check(uuid, uuid, timestamptz, timestamptz) is 'What the issue form shows before Issue (credentials.credential.issue on the category''s project, ADR 0147 decisions 4 and 5): training_missing (blocking) for each unmet requirement; training_expires_first for one that expires before the badge ends; duplicate (blocking) naming the live overlapping credential of the same Access category; other_badge_on_project, same_name_on_project and booked_elsewhere (not blocking), with the other project''s id and key only when the caller can read it. The window defaults to now and open-ended.';
