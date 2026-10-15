-- 0861_joins_offboarding.sql
-- A30 Identity, Profiles and Settings. Ways to join and offboarding (Section 4.8.1):
--   * invitation links with a role, an expiry and a use limit, accepted by any signed-in person who has the link
--   * requests to join, approved by a member holding org.members.manage with a role at or below their band
--   * automatic join for a verified email domain with the domain's default role, when the org turns it on
--   * offboarding: ending a membership opens an offboarding checklist listing the person's open records; the org
--     reassigns them and completes it. The person keeps their profile and their own documents.
-- SSO just-in-time provisioning and SCIM need the identity provider integration (A19) and are not in this range.

-- Invitation links -----------------------------------------------------------------------------------------------

create table app.invite_links (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  role_id uuid not null references app.roles (id),
  token_hash bytea not null,
  expires_at timestamptz not null,
  max_uses integer not null,
  use_count integer not null default 0,
  revoked_at timestamptz,
  deleted_at timestamptz,
  constraint invite_links_token_hash_length check (octet_length(token_hash) = 32),
  constraint invite_links_max_uses check (max_uses between 1 and 1000),
  constraint invite_links_use_count check (use_count between 0 and max_uses)
);

create unique index invite_links_token_hash_key on app.invite_links (token_hash);
create index invite_links_role_id_idx on app.invite_links (role_id);

call private.install_domain_table('app.invite_links', null, null, array['app.roles', 'role_id']);
call private.describe('app.invite_links', 'Shareable invitation links (Section 4.8.1): anyone signed in with the link joins with its role until it expires, runs out of uses or is revoked. Only a SHA-256 hash of the token is stored; the token is shown once.', array[
  'role_id', 'Role a person receives on joining.',
  'token_hash', 'SHA-256 of the link token.',
  'expires_at', 'When the link stops working.',
  'max_uses', 'How many people may join with it.',
  'use_count', 'How many have joined with it. Set by the database.',
  'revoked_at', 'When it was revoked.'
]);

call private.install_policies('app.invite_links',
  $$org_id in (select private.orgs_with_capability('org.members.invite'))$$);
revoke insert, update on app.invite_links from authenticated;

create or replace function app.create_invite_link(p_org_id uuid, p_role_id uuid, p_valid_for interval default interval '7 days', p_max_uses integer default 25)
returns table (invite_link_id uuid, invite_token text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_person();
  v_token text := 'xlnk_' || encode(extensions.gen_random_bytes(32), 'hex');
  v_role app.roles;
  v_id uuid;
begin
  if not private.has_capability(p_org_id, 'org.members.invite') then
    raise exception using errcode = '42501', message = 'org.members.invite is required';
  end if;
  select * into v_role from app.roles r where r.id = p_role_id and r.deleted_at is null and (r.org_id is null or r.org_id = p_org_id);
  if v_role.id is null then
    perform private.refuse('role_unknown', 'That role is not available in this organization.');
  end if;
  if v_role.band <= 2 then
    perform private.refuse('invite_link_role_band', 'Invitation links cannot give Owner or Admin; invite those people by email.');
  end if;
  if coalesce(private.best_band(v_me, p_org_id), 8) > v_role.band then
    perform private.refuse('role_band', 'A person can give only roles at or below their own band.');
  end if;
  perform private.assert_holds_role_capabilities(v_me, p_org_id, p_role_id);
  if p_valid_for < interval '1 hour' or p_valid_for > interval '30 days' then
    perform private.refuse('invite_expiry_range', 'An invitation link lasts between 1 hour and 30 days.');
  end if;
  insert into app.invite_links (org_id, role_id, token_hash, expires_at, max_uses)
  values (p_org_id, p_role_id, private.invite_token_hash(v_token), now() + p_valid_for, p_max_uses)
  returning id into v_id;
  return query select v_id, v_token;
end;
$$;

comment on function app.create_invite_link(uuid, uuid, interval, integer) is 'Creates an invitation link for a role below Admin, lasting 1 hour to 30 days, for up to max_uses people. The creator needs org.members.invite, a band at or above the role and every capability it grants. Returns the token once.';

create or replace function app.revoke_invite_link(p_invite_link_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_org uuid;
begin
  perform private.require_person();
  select l.org_id into v_org from app.invite_links l where l.id = p_invite_link_id and l.revoked_at is null and l.deleted_at is null;
  if v_org is null or not private.has_capability(v_org, 'org.members.invite') then
    raise exception using errcode = '42501', message = 'org.members.invite is required';
  end if;
  update app.invite_links set revoked_at = now() where id = p_invite_link_id;
end;
$$;

comment on function app.revoke_invite_link(uuid) is 'Revokes an invitation link at once. Needs org.members.invite.';

create or replace function private.join_org_with_role(p_org_id uuid, p_person_id uuid, p_role_id uuid, p_granted_by uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_membership uuid;
begin
  select m.id into v_membership from app.memberships m
  where m.org_id = p_org_id and m.person_id = p_person_id and m.deleted_at is null
    and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now());
  perform private.begin_trusted_operation('membership_write');
  if v_membership is null then
    insert into app.memberships (org_id, person_id) values (p_org_id, p_person_id) returning id into v_membership;
  end if;
  if not exists (
    select 1 from app.membership_roles mr where mr.membership_id = v_membership and mr.role_id = p_role_id and mr.deleted_at is null) then
    insert into app.membership_roles (membership_id, role_id, granted_by) values (v_membership, p_role_id, p_granted_by);
  end if;
  perform private.end_trusted_operation('membership_write');
  return v_membership;
end;
$$;

comment on function private.join_org_with_role(uuid, uuid, uuid, uuid) is 'Gives a person an active membership in an org (reusing one that is active) with a role, granted by the named person; plan limits still apply.';
revoke all on function private.join_org_with_role(uuid, uuid, uuid, uuid) from public, anon, authenticated;

create or replace function app.accept_invite_link(p_token text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_person();
  v_user uuid := (select auth.uid());
  v_link app.invite_links;
begin
  if (select count(*) from private.invite_accept_failures f where f.user_id = v_user and f.attempted_at > now() - interval '15 minutes') >= 10 then
    perform private.refuse('invite_rate_limited', 'Too many invitation attempts. Wait 15 minutes and try again.');
  end if;
  select * into v_link from app.invite_links l
  where l.token_hash = private.invite_token_hash(p_token) and l.deleted_at is null
  for update;
  if v_link.id is null then
    insert into private.invite_accept_failures (user_id) values (v_user);
    perform private.refuse('invite_unknown', 'This invitation link is not valid.');
  end if;
  if v_link.revoked_at is not null or v_link.expires_at <= now() or v_link.use_count >= v_link.max_uses then
    perform private.refuse('invite_link_closed', 'This invitation link has expired, been revoked or been used up.');
  end if;
  update app.invite_links set use_count = use_count + 1 where id = v_link.id;
  return private.join_org_with_role(v_link.org_id, v_me, v_link.role_id, v_link.created_by);
end;
$$;

comment on function app.accept_invite_link(text) is 'Joins the signed-in person to the link''s org with its role while the link is open, counting one use. Unknown tokens count toward a rate limit. Returns the membership id.';

revoke all on function app.create_invite_link(uuid, uuid, interval, integer) from public, anon;
revoke all on function app.revoke_invite_link(uuid) from public, anon;
revoke all on function app.accept_invite_link(text) from public, anon;
grant execute on function app.create_invite_link(uuid, uuid, interval, integer) to authenticated, service_role;
grant execute on function app.revoke_invite_link(uuid) to authenticated, service_role;
grant execute on function app.accept_invite_link(text) to authenticated, service_role;

-- Requests to join -------------------------------------------------------------------------------------------------

create type app.join_request_state as enum ('Pending', 'Approved', 'Declined', 'Withdrawn');
comment on type app.join_request_state is 'State of a request to join an org: Pending until an Admin approves or declines it or the person withdraws it.';

create table app.join_requests (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  person_id uuid not null references app.people (id),
  message text,
  join_request_state app.join_request_state not null default 'Pending',
  decided_by uuid references app.people (id),
  decided_at timestamptz,
  granted_role_id uuid references app.roles (id),
  deleted_at timestamptz,
  constraint join_requests_message check (message is null or char_length(btrim(message)) between 1 and 1000),
  constraint join_requests_decision check ((join_request_state in ('Approved', 'Declined')) = (decided_at is not null)),
  constraint join_requests_role check ((join_request_state = 'Approved') = (granted_role_id is not null))
);

create unique index join_requests_pending_key on app.join_requests (org_id, person_id) where join_request_state = 'Pending' and deleted_at is null;
create index join_requests_person_idx on app.join_requests (person_id);
create index join_requests_decided_by_idx on app.join_requests (decided_by);
create index join_requests_role_idx on app.join_requests (granted_role_id);

call private.install_domain_table('app.join_requests', null, null, array['app.roles', 'granted_role_id']);
call private.describe('app.join_requests', 'Requests to join an org (Section 4.8.1), approved by a member holding org.members.manage. Written only by the join request RPCs.', array[
  'person_id', 'Person asking to join.',
  'message', 'Note from the person.',
  'join_request_state', 'Pending, Approved, Declined or Withdrawn.',
  'decided_by', 'Member who approved or declined it.',
  'decided_at', 'When it was approved or declined.',
  'granted_role_id', 'Role given on approval.'
]);

call private.install_policies('app.join_requests',
  $$person_id = (select private.current_person_id()) or org_id in (select private.orgs_with_capability('org.members.manage'))$$);
revoke insert, update on app.join_requests from authenticated;

create or replace function app.request_to_join(p_org_id uuid, p_message text default null)
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
  if not exists (
    select 1 from app.organization_profiles p
    where p.org_id = p_org_id and p.deleted_at is null and private.org_profile_visible_to_me(p.org_id, p.visibility)) then
    perform private.refuse('join_request_not_open', 'This organization does not take requests to join from you.');
  end if;
  if exists (
    select 1 from app.memberships m where m.org_id = p_org_id and m.person_id = v_me and m.deleted_at is null
      and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())) then
    perform private.refuse('already_member', 'You already belong to this organization.');
  end if;
  insert into app.join_requests (org_id, person_id, message) values (p_org_id, v_me, nullif(btrim(p_message), ''))
  returning id into v_id;
  return v_id;
end;
$$;

comment on function app.request_to_join(uuid, text) is 'The signed-in person asks to join an org whose profile they can see. One pending request per org. Returns the request id.';

create or replace function app.decide_join_request(p_join_request_id uuid, p_approve boolean, p_role_id uuid default null)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_person();
  v_req app.join_requests;
  v_role app.roles;
  v_membership uuid;
begin
  select * into v_req from app.join_requests r where r.id = p_join_request_id and r.deleted_at is null for update;
  if v_req.id is null or not private.has_capability(v_req.org_id, 'org.members.manage') then
    raise exception using errcode = '42501', message = 'org.members.manage is required';
  end if;
  if v_req.join_request_state <> 'Pending' then
    perform private.refuse('join_request_decided', 'This request was already decided or withdrawn.');
  end if;
  if v_req.person_id = v_me then
    perform private.refuse('sod_self_grant', 'A person cannot grant themselves a role or capability.');
  end if;
  if not p_approve then
    update app.join_requests set join_request_state = 'Declined', decided_by = v_me, decided_at = now() where id = v_req.id;
    return null;
  end if;
  select * into v_role from app.roles r where r.id = p_role_id and r.deleted_at is null and (r.org_id is null or r.org_id = v_req.org_id);
  if v_role.id is null then
    perform private.refuse('role_unknown', 'That role is not available in this organization.');
  end if;
  if coalesce(private.best_band(v_me, v_req.org_id), 8) > v_role.band then
    perform private.refuse('role_band', 'A person can give only roles at or below their own band.');
  end if;
  perform private.assert_holds_role_capabilities(v_me, v_req.org_id, v_role.id);
  v_membership := private.join_org_with_role(v_req.org_id, v_req.person_id, v_role.id, v_me);
  update app.join_requests set join_request_state = 'Approved', decided_by = v_me, decided_at = now(), granted_role_id = v_role.id
  where id = v_req.id;
  return v_membership;
end;
$$;

comment on function app.decide_join_request(uuid, boolean, uuid) is 'Approves a pending request with a role (at or below the approver''s band, never to themselves) or declines it. Needs org.members.manage. Returns the membership id on approval.';

create or replace function app.withdraw_join_request(p_join_request_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_person();
begin
  update app.join_requests set join_request_state = 'Withdrawn'
  where id = p_join_request_id and person_id = v_me and join_request_state = 'Pending';
  if not found then
    perform private.refuse('join_request_decided', 'Only your own pending request can be withdrawn.');
  end if;
end;
$$;

comment on function app.withdraw_join_request(uuid) is 'The person withdraws their own pending request.';

revoke all on function app.request_to_join(uuid, text) from public, anon;
revoke all on function app.decide_join_request(uuid, boolean, uuid) from public, anon;
revoke all on function app.withdraw_join_request(uuid) from public, anon;
grant execute on function app.request_to_join(uuid, text) to authenticated, service_role;
grant execute on function app.decide_join_request(uuid, boolean, uuid) to authenticated, service_role;
grant execute on function app.withdraw_join_request(uuid) to authenticated, service_role;

-- Automatic join for verified domains -------------------------------------------------------------------------------

create or replace function app.join_by_verified_domain(p_org_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_person();
  v_email text;
  v_confirmed timestamptz;
  v_role uuid;
  v_enabled boolean;
begin
  select lower(u.email), u.email_confirmed_at into v_email, v_confirmed from auth.users u where u.id = (select auth.uid());
  if v_email is null or v_confirmed is null then
    perform private.refuse('email_unconfirmed', 'Confirm your email address first.');
  end if;
  select v.value_boolean into v_enabled from app.setting_values v
  where v.org_id = p_org_id and v.setting_key = 'security.auto_join_enabled' and v.scope_kind = 'Organization' and v.deleted_at is null;
  select d.auto_join_role_id into v_role from app.org_domains d
  where d.org_id = p_org_id and d.purpose = 'Verified Domain' and d.verification_state = 'Verified' and d.deleted_at is null
    and d.auto_join_role_id is not null and d.hostname = split_part(v_email, '@', 2);
  if not coalesce(v_enabled, false) or v_role is null then
    perform private.refuse('auto_join_unavailable', 'This organization does not let your email domain join automatically.');
  end if;
  return private.join_org_with_role(p_org_id, v_me, v_role, null);
end;
$$;

comment on function app.join_by_verified_domain(uuid) is 'Automatic join (Section 4.8.1): a person whose confirmed email address is at one of the org''s verified domains joins with that domain''s default role, when the org turned automatic join on in Security. Returns the membership id.';
revoke all on function app.join_by_verified_domain(uuid) from public, anon;
grant execute on function app.join_by_verified_domain(uuid) to authenticated, service_role;

create or replace function app.auto_join_offers()
returns table (org_id uuid, org_name text, org_slug text)
language sql
stable
security definer
set search_path = ''
as $$
  select o.id, o.name, o.slug
  from auth.users u
  join app.org_domains d on d.hostname = split_part(lower(u.email), '@', 2) and d.purpose = 'Verified Domain'
    and d.verification_state = 'Verified' and d.deleted_at is null and d.auto_join_role_id is not null
  join app.organizations o on o.id = d.org_id and o.deleted_at is null
  join app.setting_values v on v.org_id = o.id and v.setting_key = 'security.auto_join_enabled'
    and v.scope_kind = 'Organization' and v.value_boolean and v.deleted_at is null
  where u.id = (select auth.uid()) and u.email_confirmed_at is not null
    and not exists (
      select 1 from app.memberships m where m.org_id = o.id and m.person_id = private.current_person_id() and m.deleted_at is null
        and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now()));
$$;

comment on function app.auto_join_offers() is 'Orgs the signed-in person may join automatically through their confirmed email domain, for the sign-up and Organizations pages.';
revoke all on function app.auto_join_offers() from public, anon;
grant execute on function app.auto_join_offers() to authenticated, service_role;

-- Offboarding ----------------------------------------------------------------------------------------------------

create table app.offboardings (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  membership_id uuid not null references app.memberships (id),
  person_id uuid not null references app.people (id),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  completed_by uuid references app.people (id),
  deleted_at timestamptz,
  constraint offboardings_completed_pair check ((completed_at is null) = (completed_by is null))
);

create unique index offboardings_membership_key on app.offboardings (membership_id) where deleted_at is null;
create index offboardings_person_idx on app.offboardings (person_id);
create index offboardings_completed_by_idx on app.offboardings (completed_by);

call private.install_domain_table('app.offboardings', 'app.memberships', 'membership_id');
call private.describe('app.offboardings', 'The offboarding checklist opened when a membership ends (Section 4.8.1): the org reassigns the person''s open records, then completes it. Access already ended; the person keeps their profile and own documents.', array[
  'membership_id', 'Membership that ended.',
  'person_id', 'Person who left.',
  'started_at', 'When the membership ended.',
  'completed_at', 'When the org completed the checklist.',
  'completed_by', 'Member who completed it.'
]);

call private.install_policies('app.offboardings', $$org_id in (select private.orgs_with_capability('org.members.manage'))$$);
revoke insert, update on app.offboardings from authenticated;

create or replace function private.open_offboarding()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.valid_to is not null and new.valid_to <= now() and (old.valid_to is null or old.valid_to > now()) and new.deleted_at is null then
    insert into app.offboardings (membership_id, person_id) values (new.id, new.person_id)
    on conflict do nothing;
  end if;
  return null;
end;
$$;

comment on function private.open_offboarding() is 'After a membership ends: opens its offboarding checklist.';
revoke all on function private.open_offboarding() from public, anon, authenticated;

create trigger t81_open_offboarding after update on app.memberships
  for each row execute function private.open_offboarding();

create view app.offboarding_open_records as
select o.id as offboarding_id, o.org_id, r.id as record_id, r.project_id, r.record_kind, r.title, r.record_state,
  case when r.owner_party_id = o.person_id then 'Owner'
       when r.accountable_party_id = o.person_id then 'Accountable'
       else 'Assigned' end as responsibility
from app.offboardings o
join app.records r on r.org_id = o.org_id and r.deleted_at is null
  and r.record_state not in ('Complete', 'Canceled', 'Deferred')
  and (r.owner_party_id = o.person_id or r.accountable_party_id = o.person_id
    or exists (select 1 from app.record_assignments a where a.record_id = r.id and a.membership_id = o.membership_id and a.deleted_at is null))
where o.deleted_at is null and o.completed_at is null
  and o.org_id in (select private.orgs_with_capability('org.members.manage'));

call private.describe('app.offboarding_open_records', 'Open records a departed person still owns, is accountable for or is assigned to, for the offboarding checklist.', array[
  'offboarding_id', 'Offboarding.', 'org_id', 'Org.', 'record_id', 'Record.', 'project_id', 'Project.', 'record_kind', 'Record kind.',
  'title', 'Record title.', 'record_state', 'Record state.', 'responsibility', 'Owner, Accountable or Assigned.'
]);
revoke all on app.offboarding_open_records from public, anon;
grant select on app.offboarding_open_records to authenticated, service_role;

create or replace function app.reassign_offboarding_records(p_offboarding_id uuid, p_to_person_id uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_off app.offboardings;
  v_to_membership uuid;
  v_count integer := 0;
  v_n integer;
begin
  perform private.require_person();
  select * into v_off from app.offboardings o where o.id = p_offboarding_id and o.deleted_at is null and o.completed_at is null;
  if v_off.id is null or not private.has_capability(v_off.org_id, 'org.members.manage') then
    raise exception using errcode = '42501', message = 'org.members.manage is required';
  end if;
  select m.id into v_to_membership from app.memberships m
  where m.org_id = v_off.org_id and m.person_id = p_to_person_id and m.deleted_at is null
    and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now());
  if v_to_membership is null then
    perform private.refuse('not_member', 'Reassign to someone who belongs to the org now.');
  end if;
  update app.records r set owner_party_id = p_to_person_id
  where r.org_id = v_off.org_id and r.owner_party_id = v_off.person_id and r.deleted_at is null
    and r.record_state not in ('Complete', 'Canceled', 'Deferred');
  get diagnostics v_n = row_count;
  v_count := v_count + v_n;
  update app.records r set accountable_party_id = p_to_person_id
  where r.org_id = v_off.org_id and r.accountable_party_id = v_off.person_id and r.deleted_at is null
    and r.record_state not in ('Complete', 'Canceled', 'Deferred');
  get diagnostics v_n = row_count;
  v_count := v_count + v_n;
  insert into app.record_assignments (record_id, membership_id)
  select a.record_id, v_to_membership from app.record_assignments a
  join app.records r on r.id = a.record_id and r.record_state not in ('Complete', 'Canceled', 'Deferred') and r.deleted_at is null
  where a.membership_id = v_off.membership_id and a.deleted_at is null
    and not exists (select 1 from app.record_assignments b where b.record_id = a.record_id and b.membership_id = v_to_membership and b.deleted_at is null);
  get diagnostics v_n = row_count;
  v_count := v_count + v_n;
  update app.record_assignments a set deleted_at = now()
  where a.membership_id = v_off.membership_id and a.deleted_at is null
    and a.record_id in (select r.id from app.records r where r.record_state not in ('Complete', 'Canceled', 'Deferred'));
  return v_count;
end;
$$;

comment on function app.reassign_offboarding_records(uuid, uuid) is 'Moves a departed person''s open records to an active member: ownership, accountability and assignments. Needs org.members.manage. Returns how many responsibilities moved.';

create or replace function app.complete_offboarding(p_offboarding_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_person();
  v_off app.offboardings;
begin
  select * into v_off from app.offboardings o where o.id = p_offboarding_id and o.deleted_at is null;
  if v_off.id is null or not private.has_capability(v_off.org_id, 'org.members.manage') then
    raise exception using errcode = '42501', message = 'org.members.manage is required';
  end if;
  if v_off.completed_at is not null then
    perform private.refuse('offboarding_completed', 'This offboarding is already complete.');
  end if;
  if exists (select 1 from app.offboarding_open_records r where r.offboarding_id = v_off.id) then
    perform private.refuse('offboarding_open_records', 'Reassign every open record before completing the offboarding.');
  end if;
  update app.offboardings set completed_at = now(), completed_by = v_me where id = v_off.id;
end;
$$;

comment on function app.complete_offboarding(uuid) is 'Completes an offboarding once no open record remains with the departed person. Needs org.members.manage.';

revoke all on function app.reassign_offboarding_records(uuid, uuid) from public, anon;
revoke all on function app.complete_offboarding(uuid) from public, anon;
grant execute on function app.reassign_offboarding_records(uuid, uuid) to authenticated, service_role;
grant execute on function app.complete_offboarding(uuid) to authenticated, service_role;

-- Domain events, audit and retention -------------------------------------------------------------------------------

insert into private.domain_event_types (code, subject, description) values
  ('membership.join_requested', 'join_requests', 'A person asked to join the org.'),
  ('membership.offboarding_opened', 'offboardings', 'A membership ended and its offboarding checklist opened.')
on conflict (code) do nothing;

create trigger t80_emit_event after insert on app.join_requests
  for each row execute function private.emit_row_event('membership.join_requested', '-', 'person_id');
create trigger t80_emit_event after insert on app.offboardings
  for each row execute function private.emit_row_event('membership.offboarding_opened', '-', 'person_id');

call private.install_audit_trail('app.invite_links');
call private.install_audit_trail('app.join_requests');
call private.install_audit_trail('app.offboardings');

call private.install_default_retention('app.invite_links');
call private.install_default_retention('app.join_requests');
call private.install_default_retention('app.offboardings');
