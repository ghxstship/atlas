-- 2632_engagement_access_roster_area.sql
-- R4 Crew roster core (RRR-182, ADR 0101 decisions 1 and 3; owner decision 6 of 2026-10-28). Each function is recreated
-- from its only definition, in 0710_external_identity.sql. The Section 8.7 time box of 0710 changes as follows:
--   * a sixth area, roster, opens at Onboarding, Blocked, Active and Closing and closes at Complete and Canceled;
--   * the engaged person and an Account Owner or Admin reach every area, roster included; Account Finance keeps
--     engagement, documents and money; the Account Member role alone opens nothing;
--   * a live assignment (2631) of the caller on the engagement, through their active, confirmed membership in the
--     account that supplies it, opens engagement, operational, onboarding and roster for an Advancing Lead, and
--     engagement and operational for a Member;
--   * a representative with the Advance scope also reaches roster.
-- private.engagement_party_areas takes the engagement id now (a 4-argument form), because assignments are per
-- engagement. The 3-argument form stays as a wrapper for compatibility; nothing calls it. Every helper built on
-- private.engagement_area_open (my_engagement_ids, is_engaged_party, engaged_role_types, engaged_organization_ids,
-- counterparty_area_open 0766, guest_party_open 0965, deliverable_party_open 0771, engagement_principal 2601) follows
-- without change. No backfill: Account Members lose unassigned engagements on purpose (ADR 0101), and their sync
-- scopes refresh at the end.

create or replace function private.engagement_state_areas(p_state app.engagement_state, p_closed_at timestamptz)
returns text[]
language sql
stable
set search_path = ''
as $$
  select case
    when p_state in ('Onboarding', 'Blocked') then array['engagement', 'documents', 'onboarding', 'roster']
    when p_state in ('Active', 'Closing') then array['engagement', 'documents', 'onboarding', 'operational', 'money', 'roster']
    when p_state = 'Complete' and p_closed_at is not null and p_closed_at > pg_catalog.now() - interval '18 months'
      then array['engagement', 'documents', 'money']
    when p_state = 'Canceled' and p_closed_at is not null and p_closed_at > pg_catalog.now() - interval '18 months'
      then array['engagement', 'documents']
    else array[]::text[]
  end;
$$;

comment on function private.engagement_state_areas(app.engagement_state, timestamptz) is 'Section 8.7 time box: the areas an engagement state opens to its external parties. The roster opens at Onboarding and closes at Complete (R4); operational access opens at Active, narrows to money and documents at Complete and closes 18 months after Complete.';

create or replace function private.engagement_party_areas(
  p_engagement_id uuid,
  p_person_id uuid,
  p_counterparty_id uuid,
  p_role_type app.external_role_type
)
returns text[]
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.current_person_id();
  v_account uuid;
  v_areas text[] := array[]::text[];
  v_roles app.account_role[];
  v_duties app.account_engagement_duty[];
begin
  if v_me is null then
    return v_areas;
  end if;
  if p_person_id = v_me then
    return array['engagement', 'documents', 'onboarding', 'operational', 'money', 'roster'];
  end if;
  if p_counterparty_id is not null then
    select c.organization_id into v_account from app.counterparties c where c.id = p_counterparty_id and c.deleted_at is null;
    select array_agg(r) into v_roles from private.account_role(v_account) r;
    if v_roles && array['Account Owner', 'Account Admin']::app.account_role[] then
      return array['engagement', 'documents', 'onboarding', 'operational', 'money', 'roster'];
    end if;
    if 'Account Finance' = any (v_roles) then
      v_areas := v_areas || array['engagement', 'documents', 'money'];
    end if;
    -- The Account Member role alone opens nothing: an assignment does (owner decision 6).
    if p_engagement_id is not null and v_roles is not null then
      select array_agg(d) into v_duties from private.my_engagement_duties(p_engagement_id) d;
      if 'Advancing Lead' = any (v_duties) then
        v_areas := v_areas || array['engagement', 'operational', 'onboarding', 'roster'];
      elsif 'Member' = any (v_duties) then
        v_areas := v_areas || array['engagement', 'operational'];
      end if;
    end if;
  end if;
  if p_person_id is not null and p_role_type = 'Artist' then
    if private.represents(p_person_id, 'Offers') then
      v_areas := v_areas || array['engagement'];
    end if;
    if private.represents(p_person_id, 'Advance') then
      v_areas := v_areas || array['engagement', 'operational', 'onboarding', 'roster'];
    end if;
    if private.represents(p_person_id, 'Settlement') then
      v_areas := v_areas || array['engagement', 'money'];
    end if;
    if private.represents(p_person_id, 'Documents') then
      v_areas := v_areas || array['engagement', 'documents'];
    end if;
  end if;
  return v_areas;
end;
$$;

comment on function private.engagement_party_areas(uuid, uuid, uuid, app.external_role_type) is 'Section 8.7 (R4): the areas the signed-in person reaches on an engagement through their relationship to it: as the engaged person or an Account Owner or Admin (every area), Account Finance (engagement, documents, money), a live assignment on the engagement (Advancing Lead: engagement, operational, onboarding, roster; Member: engagement, operational), or the artist''s representative within its scopes (Advance adds roster). The Account Member role alone opens nothing. Takes the engagement''s id and column values (ADR 0016 item 14).';

create or replace function private.engagement_party_areas(p_person_id uuid, p_counterparty_id uuid, p_role_type app.external_role_type)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select private.engagement_party_areas(null::uuid, p_person_id, p_counterparty_id, p_role_type);
$$;

comment on function private.engagement_party_areas(uuid, uuid, app.external_role_type) is 'Deprecated, kept for compatibility; nothing calls it. The 4-argument form without an engagement, so assignments open nothing through it (R4).';

create or replace function private.engagement_area_open(
  p_engagement_id uuid,
  p_person_id uuid,
  p_counterparty_id uuid,
  p_role_type app.external_role_type,
  p_state app.engagement_state,
  p_area text
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_closed timestamptz;
begin
  if not (p_area = any (private.engagement_party_areas(p_engagement_id, p_person_id, p_counterparty_id, p_role_type))) then
    return false;
  end if;
  if p_state in ('Complete', 'Canceled') then
    v_closed := private.engagement_closed_at(p_engagement_id);
  end if;
  if p_area = any (private.engagement_state_areas(p_state, v_closed)) then
    return true;
  end if;
  -- After the 18-month close, the engaged person keeps their own payments.
  return p_area = 'money' and p_state = 'Complete' and p_person_id = private.current_person_id();
end;
$$;

comment on function private.engagement_area_open(uuid, uuid, uuid, app.external_role_type, app.engagement_state, text) is 'Section 8.7: true when the signed-in person reaches the area (engagement, documents, onboarding, operational, money, roster) of an engagement now: their relationship opens it (including a live assignment on this engagement, R4) and the engagement state and time box allow it. Takes the engagement''s column values.';

create or replace function private.engagement_scope(p_engagement_id uuid)
returns setof text
language sql
stable
security definer
set search_path = ''
as $$
  select a.area
  from app.engagements e
  cross join unnest(array['engagement', 'documents', 'onboarding', 'operational', 'money', 'roster']) as a (area)
  where e.id = p_engagement_id and e.deleted_at is null
    and private.engagement_area_open(e.id, e.person_id, e.counterparty_id, e.role_type, e.engagement_state, a.area);
$$;

comment on function private.engagement_scope(uuid) is 'Section 8.7 helper: the areas of one engagement the signed-in person reaches now as an external party, roster included (R4); empty when none.';

-- As 0710 kept the 3-argument form: called only inside definer helpers.
revoke all on function private.engagement_party_areas(uuid, uuid, uuid, app.external_role_type) from public, anon, authenticated;
revoke all on function private.engagement_party_areas(uuid, uuid, app.external_role_type) from public, anon, authenticated;

-- Engagement principals (from R1's 2601) ----------------------------------------------------------------------------------
-- An Advancing Lead answers for the people of the engagement assigned to them (owner decisions 4 and 6), so the badges,
-- lodging, hospitality lines, travel and per diems R1's views read through this helper reach them too.

create or replace function private.engagement_principal(p_engagement_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from app.engagements e
    left join app.counterparties c on c.id = e.counterparty_id
    where e.id = p_engagement_id and e.deleted_at is null
      and private.engagement_area_open(e.id, e.person_id, e.counterparty_id, e.role_type, e.engagement_state, 'operational')
      and (e.person_id = private.current_person_id()
        or c.organization_id in (select private.my_account_ids(array['Account Owner', 'Account Admin']::app.account_role[]))
        or 'Advancing Lead' in (select private.my_engagement_duties(e.id))
        or (e.role_type = 'Artist' and private.represents(e.person_id, 'Advance'))));
$$;

comment on function private.engagement_principal(uuid) is 'Section 8.7 (R1, widened by R4): true when the signed-in person answers for the engagement while its operational area is open: its person, an Account Owner or Admin of the account that supplies it, a live Advancing Lead assigned to it, or the Advance representative of an Artist. R7''s private.guard_credential_engagement builds on the same principals.';

revoke all on function private.engagement_principal(uuid) from public, anon;
-- Function calls inside a view run with the caller's execute privilege, so signed-in users need this.
grant execute on function private.engagement_principal(uuid) to authenticated, service_role;

-- Account Members lose the engagements nobody assigned them: refresh what Compass syncs for them.
select private.refresh_sync_scopes_of_people(array(
  select distinct m.person_id from app.account_memberships m
  join app.account_membership_roles r on r.account_membership_id = m.id and r.deleted_at is null
  where r.account_role = 'Account Member' and m.deleted_at is null));
