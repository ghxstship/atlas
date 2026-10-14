-- 0710_external_identity.sql
-- A28 Engagements and Marketplace. External identity (Section 4.4.1, Section 4.8.1, Section 7.3 final names):
--   * account_memberships and account_membership_roles: people in an external organization's account with
--     the account roles Account Owner, Account Admin, Account Finance and Account Member
--   * representations with scopes, expiry and artist acceptance, held by the representing agency account
--   * profile_shares and profile_share_fields: the consent snapshot a person or company gives an org
--   * the Section 8.7 helpers in private: account_role(account_id), represents(artist_party_id, scope),
--     engagement_scope(engagement_id), is_engaged_party(project_id), and the area and time-box rule they share
--   * the party's own document signature (app.sign_engagement_document)
--
-- An external account is an organization in the canonical identity model without a subscription
-- (Section 4.4.1); account rows carry that organization as org_id.
--
-- Section 8.7 time box, by engagement state, in areas:
--   Onboarding, Blocked   engagement, documents, onboarding
--   Active, Closing       engagement, documents, onboarding, operational, money
--   Complete              engagement, documents, money, for 18 months after Complete
--   Canceled              engagement, documents, for 18 months after Canceled
--   afterwards            nothing, except the engaged person's own money (their payments); tax forms are the
--                         person's own rows and never close (0730)
-- and by relationship to the engagement:
--   the engaged person                     every area
--   Account Owner or Account Admin         every area of the account's engagements
--   Account Finance                        engagement, documents, money
--   Account Member                         engagement, operational
--   representative of the engaged artist   Offers: engagement; Advance: engagement, operational, onboarding;
--                                          Settlement: engagement, money; Documents: engagement, documents
--
-- ADR 0016 item 14: every helper a policy calls takes column values or reads tables other than the one the
-- policy protects. External reads of tables with internal columns go through api_external definer views (0750).

-- Enums -------------------------------------------------------------------------------------------------

create type app.account_role as enum ('Account Owner', 'Account Admin', 'Account Finance', 'Account Member');
comment on type app.account_role is 'Roles in an external account (Section 4.4.1): Account Owner, Account Admin, Account Finance (submits invoices, sees payments) and Account Member. A member may hold several.';

create type app.representation_scope as enum ('Offers', 'Advance', 'Settlement', 'Documents');
comment on type app.representation_scope is 'What a representation lets the representative do for the artist (Section 4.4.1): offers, advance, settlement and documents.';

-- Account memberships --------------------------------------------------------------------------------------

create table app.account_memberships (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  person_id uuid not null references app.people (id),
  valid_from timestamptz not null default now(),
  valid_to timestamptz,
  deleted_at timestamptz,
  constraint account_memberships_valid_period check (valid_to is null or valid_to >= valid_from)
);

create index account_memberships_person_id_idx on app.account_memberships (person_id, org_id);

call private.install_domain_table('app.account_memberships');
call private.describe('app.account_memberships', 'A person in an external organization''s account (Section 4.8.1 Account Membership). Access holds only between valid_from and valid_to. Written only by the account RPCs.', array[
  'org_id', 'The external account: an organization in the canonical identity model.',
  'person_id', 'Account member.',
  'valid_from', 'When account access starts.',
  'valid_to', 'When account access ends; NULL while open-ended.'
]);

create table app.account_membership_roles (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  account_membership_id uuid not null references app.account_memberships (id),
  account_role app.account_role not null,
  granted_by uuid references app.people (id),
  deleted_at timestamptz
);

create index account_membership_roles_membership_idx on app.account_membership_roles (account_membership_id);
create index account_membership_roles_granted_by_idx on app.account_membership_roles (granted_by);
create unique index account_membership_roles_key on app.account_membership_roles (account_membership_id, account_role)
  where deleted_at is null;

call private.install_domain_table('app.account_membership_roles', 'app.account_memberships', 'account_membership_id');
call private.describe('app.account_membership_roles', 'Account roles held through an account membership; a member may hold several and their reach is the union (Section 4.8.1).', array[
  'account_membership_id', 'Account membership that holds the role.',
  'account_role', 'Account Owner, Account Admin, Account Finance or Account Member.',
  'granted_by', 'Person who granted the role; NULL for the creator''s own Account Owner role.'
]);

-- Representations ---------------------------------------------------------------------------------------------

create table app.representations (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  artist_person_id uuid not null references app.people (id),
  representative_person_id uuid references app.people (id),
  expires_on date not null,
  accepted_at timestamptz,
  revoked_at timestamptz,
  deleted_at timestamptz,
  constraint representations_not_self check (representative_person_id is distinct from artist_person_id)
);

create index representations_artist_person_id_idx on app.representations (artist_person_id);
create index representations_representative_person_id_idx on app.representations (representative_person_id);

call private.install_domain_table('app.representations');
call private.describe('app.representations', 'An agency or management account acting for an artist (Section 4.4.1, Section 4.8.1 Representation). It takes effect once the artist accepts, within its scopes and until it expires or is revoked.', array[
  'org_id', 'Representing account: the artist agency or management company.',
  'artist_person_id', 'Represented artist.',
  'representative_person_id', 'Named agent or manager in the account; NULL when every Account Owner and Admin acts for the artist.',
  'expires_on', 'Last day the representation holds.',
  'accepted_at', 'When the artist accepted. Without acceptance the representation grants nothing.',
  'revoked_at', 'When the artist or the account revoked it.'
]);

create table app.representation_scopes (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  representation_id uuid not null references app.representations (id),
  scope app.representation_scope not null,
  deleted_at timestamptz
);

create index representation_scopes_representation_id_idx on app.representation_scopes (representation_id);
create unique index representation_scopes_key on app.representation_scopes (representation_id, scope) where deleted_at is null;

call private.install_domain_table('app.representation_scopes', 'app.representations', 'representation_id');
call private.describe('app.representation_scopes', 'Scopes of a representation, one row each: Offers, Advance, Settlement, Documents.', array[
  'representation_id', 'Representation.',
  'scope', 'Delegated scope.'
]);

-- Profile shares -----------------------------------------------------------------------------------------------

create table app.profile_shares (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  person_id uuid references app.people (id),
  organization_id uuid references app.organizations (id),
  engagement_id uuid references app.engagements (id),
  shared_at timestamptz not null default now(),
  revoked_at timestamptz,
  deleted_at timestamptz,
  constraint profile_shares_one_owner check (num_nonnulls(person_id, organization_id) = 1),
  constraint profile_shares_not_own_org check (organization_id is distinct from org_id)
);

create index profile_shares_person_id_idx on app.profile_shares (person_id);
create index profile_shares_organization_id_idx on app.profile_shares (organization_id);
create index profile_shares_engagement_id_idx on app.profile_shares (engagement_id);

call private.install_domain_table('app.profile_shares', null, null, array['app.engagements', 'engagement_id']);
call private.describe('app.profile_shares', 'Consent to share profile fields with one org (Section 4.4.1): the snapshot taken when a person or company applies or is engaged. Revoking stops future updates; the org keeps the snapshot it must retain.', array[
  'org_id', 'Org the profile is shared with.',
  'person_id', 'Person sharing their profile; NULL when a company shares.',
  'organization_id', 'External account sharing its company profile; NULL when a person shares.',
  'engagement_id', 'Engagement the share serves, once there is one; live updates flow only while it is open.',
  'shared_at', 'When consent was given.',
  'revoked_at', 'When consent was revoked.'
]);

create table app.profile_share_fields (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  profile_share_id uuid not null references app.profile_shares (id),
  field_key text not null,
  field_value text,
  deleted_at timestamptz,
  constraint profile_share_fields_key_format check (field_key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'),
  constraint profile_share_fields_value_length check (field_value is null or char_length(field_value) <= 4000)
);

create index profile_share_fields_share_idx on app.profile_share_fields (profile_share_id);
create unique index profile_share_fields_key on app.profile_share_fields (profile_share_id, field_key) where deleted_at is null;

call private.install_domain_table('app.profile_share_fields', 'app.profile_shares', 'profile_share_id');
call private.describe('app.profile_share_fields', 'The fields of a profile share, one row per field the owner chose to share, with the value at the time of sharing.', array[
  'profile_share_id', 'Profile share.',
  'field_key', 'Profile field key, for example headline or skills.0000.01.01.',
  'field_value', 'Value shared; NULL when the field was shared empty.'
]);

-- Account helpers (Section 8.7) ----------------------------------------------------------------------------------

create or replace function private.my_account_membership_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.id from app.account_memberships m
  where m.person_id = private.current_person_id() and m.deleted_at is null
    and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now());
$$;

comment on function private.my_account_membership_ids() is 'Active account memberships of the signed-in person.';

create or replace function private.account_role(p_account_id uuid)
returns setof app.account_role
language sql
stable
security definer
set search_path = ''
as $$
  select distinct r.account_role
  from app.account_memberships m
  join app.account_membership_roles r on r.account_membership_id = m.id and r.deleted_at is null
  where m.org_id = p_account_id and m.person_id = private.current_person_id() and m.deleted_at is null
    and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now());
$$;

comment on function private.account_role(uuid) is 'Section 8.7 helper: the account roles the signed-in person holds now in an external account; empty when none.';

create or replace function private.my_account_ids(p_roles app.account_role[] default null)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select distinct m.org_id
  from app.account_memberships m
  join app.account_membership_roles r on r.account_membership_id = m.id and r.deleted_at is null
  where m.person_id = private.current_person_id() and m.deleted_at is null
    and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
    and (p_roles is null or r.account_role = any (p_roles));
$$;

comment on function private.my_account_ids(app.account_role[]) is 'External accounts where the signed-in person holds any of the given account roles now (any role when NULL).';

create or replace function private.represents(p_artist_party_id uuid, p_scope app.representation_scope)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from app.representations r
    join app.representation_scopes s on s.representation_id = r.id and s.deleted_at is null and s.scope = p_scope
    where r.artist_person_id = p_artist_party_id and r.deleted_at is null
      and r.accepted_at is not null and r.revoked_at is null and r.expires_on >= current_date
      and (r.org_id in (select private.my_account_ids(array['Account Owner', 'Account Admin']::app.account_role[]))
           or (r.representative_person_id = private.current_person_id()
               and r.org_id in (select private.my_account_ids(null))))
  );
$$;

comment on function private.represents(uuid, app.representation_scope) is 'Section 8.7 helper: true when the signed-in person acts for the artist within the scope: the named agent while still in the representing account, or an Account Owner or Admin of that account; only for an accepted, unrevoked, unexpired representation.';

-- Engagement areas and time box (Section 8.7) ---------------------------------------------------------------------

create or replace function private.engagement_closed_at(p_engagement_id uuid)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select max(t.created_at) from app.engagement_state_transitions t
  where t.engagement_id = p_engagement_id and t.to_state in ('Complete', 'Canceled');
$$;

comment on function private.engagement_closed_at(uuid) is 'When an engagement became Complete or Canceled, from its ledger; NULL while open.';

create or replace function private.engagement_state_areas(p_state app.engagement_state, p_closed_at timestamptz)
returns text[]
language sql
stable
set search_path = ''
as $$
  select case
    when p_state in ('Onboarding', 'Blocked') then array['engagement', 'documents', 'onboarding']
    when p_state in ('Active', 'Closing') then array['engagement', 'documents', 'onboarding', 'operational', 'money']
    when p_state = 'Complete' and p_closed_at is not null and p_closed_at > pg_catalog.now() - interval '18 months'
      then array['engagement', 'documents', 'money']
    when p_state = 'Canceled' and p_closed_at is not null and p_closed_at > pg_catalog.now() - interval '18 months'
      then array['engagement', 'documents']
    else array[]::text[]
  end;
$$;

comment on function private.engagement_state_areas(app.engagement_state, timestamptz) is 'Section 8.7 time box: the areas an engagement state opens to its external parties. Operational access opens at Active, narrows to money and documents at Complete and closes 18 months after Complete.';

create or replace function private.engagement_party_areas(p_person_id uuid, p_counterparty_id uuid, p_role_type app.external_role_type)
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
begin
  if v_me is null then
    return v_areas;
  end if;
  if p_person_id = v_me then
    return array['engagement', 'documents', 'onboarding', 'operational', 'money'];
  end if;
  if p_counterparty_id is not null then
    select c.organization_id into v_account from app.counterparties c where c.id = p_counterparty_id and c.deleted_at is null;
    select array_agg(r) into v_roles from private.account_role(v_account) r;
    if v_roles && array['Account Owner', 'Account Admin']::app.account_role[] then
      return array['engagement', 'documents', 'onboarding', 'operational', 'money'];
    end if;
    if 'Account Finance' = any (v_roles) then
      v_areas := v_areas || array['engagement', 'documents', 'money'];
    end if;
    if 'Account Member' = any (v_roles) then
      v_areas := v_areas || array['engagement', 'operational'];
    end if;
  end if;
  if p_person_id is not null and p_role_type = 'Artist' then
    if private.represents(p_person_id, 'Offers') then
      v_areas := v_areas || array['engagement'];
    end if;
    if private.represents(p_person_id, 'Advance') then
      v_areas := v_areas || array['engagement', 'operational', 'onboarding'];
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

comment on function private.engagement_party_areas(uuid, uuid, app.external_role_type) is 'Section 8.7: the areas the signed-in person reaches on an engagement through their relationship to it: as the engaged person, through their account role in the engaged account, or as the artist''s representative within its scopes. Takes the engagement''s column values (ADR 0016 item 14).';

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
  if not (p_area = any (private.engagement_party_areas(p_person_id, p_counterparty_id, p_role_type))) then
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

comment on function private.engagement_area_open(uuid, uuid, uuid, app.external_role_type, app.engagement_state, text) is 'Section 8.7: true when the signed-in person reaches the area (engagement, documents, onboarding, operational, money) of an engagement now: their relationship opens it and the engagement state and time box allow it. Takes the engagement''s column values.';

create or replace function private.engagement_scope(p_engagement_id uuid)
returns setof text
language sql
stable
security definer
set search_path = ''
as $$
  select a.area
  from app.engagements e
  cross join unnest(array['engagement', 'documents', 'onboarding', 'operational', 'money']) as a (area)
  where e.id = p_engagement_id and e.deleted_at is null
    and private.engagement_area_open(e.id, e.person_id, e.counterparty_id, e.role_type, e.engagement_state, a.area);
$$;

comment on function private.engagement_scope(uuid) is 'Section 8.7 helper: the areas of one engagement the signed-in person reaches now as an external party; empty when none.';

create or replace function private.my_engagement_ids(p_area text)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select e.id from app.engagements e
  where e.deleted_at is null
    and private.engagement_area_open(e.id, e.person_id, e.counterparty_id, e.role_type, e.engagement_state, p_area);
$$;

comment on function private.my_engagement_ids(text) is 'Engagements whose area the signed-in person reaches now as an external party. Policies on engagement child tables use it as engagement_id in (select ...).';

create or replace function private.is_engaged_party(p_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from app.engagements e
    where e.project_id = p_project_id and e.deleted_at is null
      and private.engagement_area_open(e.id, e.person_id, e.counterparty_id, e.role_type, e.engagement_state, 'operational')
  );
$$;

comment on function private.is_engaged_party(uuid) is 'Section 8.7 helper: true when the signed-in person reaches the operational records of the project through an engagement (their own, their account''s or a represented artist''s) that is Active or Closing.';

create or replace function private.engaged_role_types(p_project_id uuid)
returns setof app.external_role_type
language sql
stable
security definer
set search_path = ''
as $$
  select distinct e.role_type from app.engagements e
  where e.project_id = p_project_id and e.deleted_at is null
    and private.engagement_area_open(e.id, e.person_id, e.counterparty_id, e.role_type, e.engagement_state, 'operational');
$$;

comment on function private.engaged_role_types(uuid) is 'External role types through which the signed-in person reaches the project''s operational records now; used for record external_visibility.';

create or replace function private.engaged_organization_ids(p_project_id uuid)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select distinct c.organization_id from app.engagements e
  join app.counterparties c on c.id = e.counterparty_id
  where e.project_id = p_project_id and e.deleted_at is null
    and private.engagement_area_open(e.id, e.person_id, e.counterparty_id, e.role_type, e.engagement_state, 'operational');
$$;

comment on function private.engaged_organization_ids(uuid) is 'External organizations whose engagement on the project gives the signed-in person operational reach now.';

-- Guards --------------------------------------------------------------------------------------------------

create or replace function private.guard_account_membership_role()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and (new.account_membership_id <> old.account_membership_id or new.account_role <> old.account_role) then
    perform private.refuse('account_role_immutable', 'Change an account role by removing it and granting another.');
  end if;
  if tg_op = 'UPDATE' and old.account_role = 'Account Owner' and new.deleted_at is not null and old.deleted_at is null
     and not exists (
       select 1 from app.account_membership_roles r join app.account_memberships m on m.id = r.account_membership_id
       where r.org_id = new.org_id and r.id <> new.id and r.account_role = 'Account Owner' and r.deleted_at is null
         and m.deleted_at is null and m.valid_to is null) then
    perform private.refuse('sole_account_owner', 'An account keeps at least one Account Owner.');
  end if;
  return new;
end;
$$;

comment on function private.guard_account_membership_role() is 'Account roles never change in place, and an account keeps at least one open-ended Account Owner.';

create trigger t40_guard_account_membership_role before insert or update on app.account_membership_roles
  for each row execute function private.guard_account_membership_role();

create or replace function private.guard_account_membership()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.person_id <> old.person_id then
    perform private.refuse('account_membership_person_immutable', 'An account membership never moves to another person.');
  end if;
  if new.deleted_at is null and exists (
    select 1 from app.account_memberships m
    where m.org_id = new.org_id and m.person_id = new.person_id and m.id <> new.id and m.deleted_at is null
      and tstzrange(m.valid_from, m.valid_to) && tstzrange(new.valid_from, new.valid_to)) then
    perform private.refuse('account_membership_overlap', 'A person holds one membership per account at a time.');
  end if;
  if tg_op = 'UPDATE' and new.valid_to is not null and old.valid_to is null and exists (
    select 1 from app.account_membership_roles r where r.account_membership_id = new.id and r.account_role = 'Account Owner' and r.deleted_at is null)
    and not exists (
      select 1 from app.account_membership_roles r join app.account_memberships m on m.id = r.account_membership_id
      where r.org_id = new.org_id and m.id <> new.id and r.account_role = 'Account Owner' and r.deleted_at is null
        and m.deleted_at is null and m.valid_to is null) then
    perform private.refuse('sole_account_owner', 'An account keeps at least one Account Owner.');
  end if;
  return new;
end;
$$;

comment on function private.guard_account_membership() is 'Account memberships: one at a time per person and account, never moved to another person, and the last Account Owner cannot leave.';

create trigger t40_guard_account_membership before insert or update on app.account_memberships
  for each row execute function private.guard_account_membership();

create or replace function private.guard_representation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and (new.artist_person_id <> old.artist_person_id
      or new.representative_person_id is distinct from old.representative_person_id or new.org_id <> old.org_id) then
    perform private.refuse('representation_immutable', 'A representation keeps its artist, account and agent; propose a new one.');
  end if;
  if tg_op = 'UPDATE' and old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at then
    perform private.refuse('representation_revoked', 'A revoked representation stays revoked.');
  end if;
  if tg_op = 'UPDATE' and new.expires_on > old.expires_on then
    perform private.refuse('representation_extension', 'A representation can be shortened, not extended; propose a new one for the artist to accept.');
  end if;
  return new;
end;
$$;

comment on function private.guard_representation() is 'Representations keep their parties, are shortened but never extended, and stay revoked once revoked.';

create trigger t40_guard_representation before insert or update on app.representations
  for each row execute function private.guard_representation();

-- Policies ----------------------------------------------------------------------------------------------------
-- Account rows are written only by the account RPCs; members read their own rows here and their account's
-- roster through api_external.account_members (0750).

call private.install_policies('app.account_memberships',
  $$person_id = (select private.current_person_id())$$);
call private.install_policies('app.account_membership_roles',
  $$account_membership_id in (select private.my_account_membership_ids())$$);

call private.install_policies('app.representations',
  $$artist_person_id = (select private.current_person_id())
    or representative_person_id = (select private.current_person_id())
    or org_id in (select private.my_account_ids(array['Account Owner', 'Account Admin']::app.account_role[]))$$);

create or replace function private.my_representation_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select r.id from app.representations r
  where r.deleted_at is null
    and (r.artist_person_id = private.current_person_id()
      or r.representative_person_id = private.current_person_id()
      or r.org_id in (select private.my_account_ids(array['Account Owner', 'Account Admin']::app.account_role[])));
$$;

comment on function private.my_representation_ids() is 'Representations the signed-in person is party to: as the artist, the named agent, or an Account Owner or Admin of the representing account.';

call private.install_policies('app.representation_scopes',
  $$representation_id in (select private.my_representation_ids())$$);

call private.install_policies('app.profile_shares',
  $$person_id = (select private.current_person_id())
    or organization_id in (select private.my_account_ids(array['Account Owner', 'Account Admin']::app.account_role[]))
    or org_id in (select private.orgs_with_capability('people.profile.read'))$$);

create or replace function private.my_profile_share_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select s.id from app.profile_shares s
  where s.deleted_at is null
    and (s.person_id = private.current_person_id()
      or s.organization_id in (select private.my_account_ids(array['Account Owner', 'Account Admin']::app.account_role[]))
      or s.org_id in (select private.orgs_with_capability('people.profile.read')));
$$;

comment on function private.my_profile_share_ids() is 'Profile shares the signed-in person may read: their own, their account''s, or shares to an org where they read people profiles.';

call private.install_policies('app.profile_share_fields',
  $$profile_share_id in (select private.my_profile_share_ids())$$);

-- Engagement documents: the external half (documents area) joins the internal half.
call private.install_policies('app.engagement_documents',
  $$engagement_id in (select e.id from app.engagements e where e.project_id in (select private.project_ids_with('opportunities.engagement.read')))
    or engagement_id in (select private.my_engagement_ids('documents'))$$,
  $$engagement_id in (select e.id from app.engagements e where e.project_id in (select private.project_ids_with('opportunities.engagement.write')))$$);

revoke insert, update on app.account_memberships, app.account_membership_roles, app.representations,
  app.representation_scopes, app.profile_shares, app.profile_share_fields from authenticated;

-- RPCs ----------------------------------------------------------------------------------------------------------

create or replace function private.assert_account_admin(p_account_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from private.account_role(p_account_id) r where r in ('Account Owner', 'Account Admin')) then
    raise exception using errcode = '42501', message = 'Account Owner or Account Admin is required';
  end if;
end;
$$;

comment on function private.assert_account_admin(uuid) is 'Raises insufficient privilege unless the signed-in person is an Account Owner or Account Admin of the account.';

create or replace function app.create_external_account(p_name text, p_slug text, p_organization_type text default 'For-Profit')
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_account uuid;
  v_membership uuid;
begin
  perform private.assert_org_slug_available(p_slug);
  insert into app.organizations (name, slug, organization_type) values (btrim(p_name), p_slug, p_organization_type)
  returning id into v_account;
  insert into app.account_memberships (org_id, person_id) values (v_account, v_person) returning id into v_membership;
  insert into app.account_membership_roles (account_membership_id, account_role, granted_by)
  values (v_membership, 'Account Owner', null);
  return v_account;
end;
$$;

comment on function app.create_external_account(text, text, text) is 'Creates an external account (Section 4.4.1): an organization without a subscription, with the signed-in person as its Account Owner. Returns the organization id.';

create or replace function app.add_account_member(p_account_id uuid, p_person_id uuid, p_role app.account_role)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_person();
  v_membership uuid;
begin
  perform private.assert_account_admin(p_account_id);
  if p_person_id = v_me then
    perform private.refuse('sod_self_grant', 'A person cannot grant themselves a role or capability.');
  end if;
  if p_role = 'Account Owner' and not exists (select 1 from private.account_role(p_account_id) r where r = 'Account Owner') then
    perform private.refuse('account_role_band', 'Only an Account Owner grants Account Owner.');
  end if;
  select m.id into v_membership from app.account_memberships m
  where m.org_id = p_account_id and m.person_id = p_person_id and m.deleted_at is null
    and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now());
  if v_membership is null then
    insert into app.account_memberships (org_id, person_id) values (p_account_id, p_person_id) returning id into v_membership;
  end if;
  insert into app.account_membership_roles (account_membership_id, account_role, granted_by)
  values (v_membership, p_role, v_me);
  return v_membership;
end;
$$;

comment on function app.add_account_member(uuid, uuid, app.account_role) is 'Adds a person to an external account with a role, or grants an existing member another role. Needs Account Owner or Admin; only an Owner grants Owner; never to oneself (Section 8.2). Returns the account membership id.';

create or replace function app.remove_account_role(p_account_membership_role_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_person();
  v_role app.account_membership_roles;
begin
  select * into v_role from app.account_membership_roles r where r.id = p_account_membership_role_id and r.deleted_at is null;
  if v_role.id is null then
    raise exception using errcode = '42501', message = 'account role not found';
  end if;
  perform private.assert_account_admin(v_role.org_id);
  if v_role.account_role = 'Account Owner' and not exists (select 1 from private.account_role(v_role.org_id) r where r = 'Account Owner') then
    perform private.refuse('account_role_band', 'Only an Account Owner removes Account Owner.');
  end if;
  update app.account_membership_roles set deleted_at = now() where id = v_role.id;
end;
$$;

comment on function app.remove_account_role(uuid) is 'Removes an account role. Needs Account Owner or Admin; only an Owner removes Owner; the last Account Owner stays.';

create or replace function app.end_account_membership(p_account_membership_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_person();
  v_member app.account_memberships;
begin
  select * into v_member from app.account_memberships m where m.id = p_account_membership_id and m.deleted_at is null;
  if v_member.id is null then
    raise exception using errcode = '42501', message = 'account membership not found';
  end if;
  if v_member.person_id <> v_me then
    perform private.assert_account_admin(v_member.org_id);
  end if;
  update app.account_memberships set valid_to = now() where id = v_member.id and (valid_to is null or valid_to > now());
end;
$$;

comment on function app.end_account_membership(uuid) is 'Ends an account membership at once: a member leaving, or an Account Owner or Admin removing them. The last Account Owner cannot leave.';

create or replace function app.propose_representation(
  p_account_id uuid,
  p_artist_person_id uuid,
  p_representative_person_id uuid,
  p_expires_on date,
  p_scopes app.representation_scope[]
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_person();
  v_id uuid;
begin
  perform private.assert_account_admin(p_account_id);
  if p_expires_on is null or p_expires_on < current_date then
    perform private.refuse('representation_expiry', 'A representation needs an expiry date in the future.');
  end if;
  if p_scopes is null or cardinality(p_scopes) = 0 then
    perform private.refuse('representation_scope_required', 'A representation names at least one scope.');
  end if;
  if p_representative_person_id is not null and not exists (
    select 1 from app.account_memberships m where m.org_id = p_account_id and m.person_id = p_representative_person_id
      and m.deleted_at is null and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())) then
    perform private.refuse('representative_not_in_account', 'The named representative must be a member of the representing account.');
  end if;
  insert into app.representations (org_id, artist_person_id, representative_person_id, expires_on)
  values (p_account_id, p_artist_person_id, p_representative_person_id, p_expires_on) returning id into v_id;
  insert into app.representation_scopes (representation_id, scope)
  select v_id, s from (select distinct unnest(p_scopes) as s) x;
  return v_id;
end;
$$;

comment on function app.propose_representation(uuid, uuid, uuid, date, app.representation_scope[]) is 'An Account Owner or Admin of an agency proposes to represent an artist with scopes and an expiry. It grants nothing until the artist accepts.';

create or replace function app.accept_representation(p_representation_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_person();
begin
  update app.representations set accepted_at = now()
  where id = p_representation_id and artist_person_id = v_me and accepted_at is null and revoked_at is null and deleted_at is null;
  if not found then
    perform private.refuse('representation_not_acceptable', 'Only the artist accepts a pending representation.');
  end if;
end;
$$;

comment on function app.accept_representation(uuid) is 'The artist accepts a representation (Section 4.4.1).';

create or replace function app.revoke_representation(p_representation_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_person();
  v_rep app.representations;
begin
  select * into v_rep from app.representations r where r.id = p_representation_id and r.deleted_at is null;
  if v_rep.id is null then
    raise exception using errcode = '42501', message = 'representation not found';
  end if;
  if v_rep.artist_person_id <> v_me then
    perform private.assert_account_admin(v_rep.org_id);
  end if;
  update app.representations set revoked_at = now() where id = v_rep.id and revoked_at is null;
end;
$$;

comment on function app.revoke_representation(uuid) is 'The artist, or an Account Owner or Admin of the representing account, revokes a representation at once.';

create or replace function app.share_profile(
  p_org_id uuid,
  p_field_keys text[],
  p_field_values text[],
  p_account_id uuid default null,
  p_engagement_id uuid default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_person();
  v_id uuid;
begin
  if coalesce(cardinality(p_field_keys), 0) = 0 or cardinality(p_field_keys) <> coalesce(cardinality(p_field_values), 0) then
    perform private.refuse('profile_share_fields', 'A share names each field once with its value.');
  end if;
  if p_account_id is not null then
    perform private.assert_account_admin(p_account_id);
  end if;
  if p_engagement_id is not null and not exists (
    select 1 from app.engagements e where e.id = p_engagement_id and e.org_id = p_org_id
      and private.engagement_area_open(e.id, e.person_id, e.counterparty_id, e.role_type, e.engagement_state, 'engagement')) then
    perform private.refuse('profile_share_engagement', 'A share can name only an engagement the sharer holds with that org.');
  end if;
  insert into app.profile_shares (org_id, person_id, organization_id, engagement_id)
  values (p_org_id, case when p_account_id is null then v_me end, p_account_id, p_engagement_id)
  returning id into v_id;
  insert into app.profile_share_fields (profile_share_id, field_key, field_value)
  select v_id, k, v from unnest(p_field_keys, p_field_values) as f (k, v);
  return v_id;
end;
$$;

comment on function app.share_profile(uuid, text[], text[], uuid, uuid) is 'Gives an org a consent snapshot of chosen profile fields (Section 4.4.1): the signed-in person''s own profile, or an account''s company profile by an Account Owner or Admin. Returns the share id.';

create or replace function app.revoke_profile_share(p_profile_share_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_person();
  v_share app.profile_shares;
begin
  select * into v_share from app.profile_shares s where s.id = p_profile_share_id and s.deleted_at is null;
  if v_share.id is null or not (v_share.person_id = v_me
      or v_share.organization_id in (select private.my_account_ids(array['Account Owner', 'Account Admin']::app.account_role[]))) then
    raise exception using errcode = '42501', message = 'only the owner of a share revokes it';
  end if;
  update app.profile_shares set revoked_at = now() where id = v_share.id and revoked_at is null;
end;
$$;

comment on function app.revoke_profile_share(uuid) is 'The owner revokes consent; future updates stop and the org keeps the snapshot it must retain.';

create or replace function app.sign_engagement_document(p_document_id uuid, p_reason text default 'Signed.')
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_engagement uuid := (select d.engagement_id from app.engagement_documents d where d.id = p_document_id and d.deleted_at is null);
begin
  perform private.require_person();
  if v_engagement is null or not exists (select 1 from private.engagement_scope(v_engagement) a where a = 'documents') then
    raise exception using errcode = '42501', message = 'the documents of this engagement are not open to the caller';
  end if;
  return private.transition_lifecycle('engagement_document', 'app.engagement_documents', 'engagement_document_state',
    'app.engagement_document_state_transitions', 'engagement_document_id', p_document_id, 'Sent', 'Signed', p_reason);
end;
$$;

comment on function app.sign_engagement_document(uuid, text) is 'The engaged party signs a Sent document (Sent to Signed): the engaged person, an Account Owner, Admin or Finance of the engaged account, or the artist''s representative with the Documents scope, while the documents area is open (Section 8.7).';

create or replace function app.engaged_person_name(p_engagement_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select p.full_name from app.people p
  join app.engagements e on e.person_id = p.id
  where e.id = p_engagement_id and e.deleted_at is null
    and e.project_id in (select private.project_ids_with('opportunities.engagement.read'));
$$;

comment on function app.engaged_person_name(uuid) is 'The engaged person''s name from its one home on app.people, for internal readers of the engagement; NULL for anyone else.';

-- Function privileges ----------------------------------------------------------------------------------------------

revoke all on function private.my_account_membership_ids() from public, anon;
revoke all on function private.account_role(uuid) from public, anon;
revoke all on function private.my_account_ids(app.account_role[]) from public, anon;
revoke all on function private.represents(uuid, app.representation_scope) from public, anon;
revoke all on function private.engagement_closed_at(uuid) from public, anon, authenticated;
revoke all on function private.engagement_state_areas(app.engagement_state, timestamptz) from public, anon;
revoke all on function private.engagement_party_areas(uuid, uuid, app.external_role_type) from public, anon, authenticated;
revoke all on function private.engagement_area_open(uuid, uuid, uuid, app.external_role_type, app.engagement_state, text) from public, anon;
revoke all on function private.engagement_scope(uuid) from public, anon;
revoke all on function private.my_engagement_ids(text) from public, anon;
revoke all on function private.is_engaged_party(uuid) from public, anon;
revoke all on function private.engaged_role_types(uuid) from public, anon;
revoke all on function private.engaged_organization_ids(uuid) from public, anon;
revoke all on function private.my_representation_ids() from public, anon;
revoke all on function private.my_profile_share_ids() from public, anon;
revoke all on function private.assert_account_admin(uuid) from public, anon, authenticated;
revoke all on function private.guard_account_membership_role() from public, anon, authenticated;
revoke all on function private.guard_account_membership() from public, anon, authenticated;
revoke all on function private.guard_representation() from public, anon, authenticated;

grant execute on function private.my_account_membership_ids() to authenticated, service_role;
grant execute on function private.account_role(uuid) to authenticated, service_role;
grant execute on function private.my_account_ids(app.account_role[]) to authenticated, service_role;
grant execute on function private.represents(uuid, app.representation_scope) to authenticated, service_role;
grant execute on function private.engagement_state_areas(app.engagement_state, timestamptz) to authenticated, service_role;
grant execute on function private.engagement_area_open(uuid, uuid, uuid, app.external_role_type, app.engagement_state, text) to authenticated, service_role;
grant execute on function private.engagement_scope(uuid) to authenticated, service_role;
grant execute on function private.my_engagement_ids(text) to authenticated, service_role;
grant execute on function private.is_engaged_party(uuid) to authenticated, service_role;
grant execute on function private.engaged_role_types(uuid) to authenticated, service_role;
grant execute on function private.engaged_organization_ids(uuid) to authenticated, service_role;
grant execute on function private.my_representation_ids() to authenticated, service_role;
grant execute on function private.my_profile_share_ids() to authenticated, service_role;

revoke all on function app.create_external_account(text, text, text) from public, anon;
revoke all on function app.add_account_member(uuid, uuid, app.account_role) from public, anon;
revoke all on function app.remove_account_role(uuid) from public, anon;
revoke all on function app.end_account_membership(uuid) from public, anon;
revoke all on function app.propose_representation(uuid, uuid, uuid, date, app.representation_scope[]) from public, anon;
revoke all on function app.accept_representation(uuid) from public, anon;
revoke all on function app.revoke_representation(uuid) from public, anon;
revoke all on function app.share_profile(uuid, text[], text[], uuid, uuid) from public, anon;
revoke all on function app.revoke_profile_share(uuid) from public, anon;
revoke all on function app.sign_engagement_document(uuid, text) from public, anon;
revoke all on function app.engaged_person_name(uuid) from public, anon;

grant execute on function app.create_external_account(text, text, text) to authenticated, service_role;
grant execute on function app.add_account_member(uuid, uuid, app.account_role) to authenticated, service_role;
grant execute on function app.remove_account_role(uuid) to authenticated, service_role;
grant execute on function app.end_account_membership(uuid) to authenticated, service_role;
grant execute on function app.propose_representation(uuid, uuid, uuid, date, app.representation_scope[]) to authenticated, service_role;
grant execute on function app.accept_representation(uuid) to authenticated, service_role;
grant execute on function app.revoke_representation(uuid) to authenticated, service_role;
grant execute on function app.share_profile(uuid, text[], text[], uuid, uuid) to authenticated, service_role;
grant execute on function app.revoke_profile_share(uuid) to authenticated, service_role;
grant execute on function app.sign_engagement_document(uuid, text) to authenticated, service_role;
grant execute on function app.engaged_person_name(uuid) to authenticated, service_role;
