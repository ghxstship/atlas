-- 3050_member_blocklist.sql
-- B16 (RRR-240), parity gap G-269, Section 4.8.1, ADR 0155 D3. An org keeps a blocklist of email addresses and
-- domains (a Domain entry also matches every subdomain). A person whose sign-in address matches a live entry cannot
-- become a member:
--   * t12_refuse_blocked_member, before insert on app.memberships, refuses every new membership whoever is acting,
--     so every path is covered: app.accept_invite (0206), app.accept_invite_link and app.decide_join_request (through
--     private.join_org_with_role, 0861), app.join_by_verified_domain (0861), app.join_by_sso and app.scim_provision
--     (0638, and app.join_by_sso_session, 1332), and every later path. Reusing an active membership inserts nothing,
--     so SCIM updating a current member and existing members are never touched.
--   * app.invite_member refuses invite_blocked, so the inviter sees why; app.accept_invite answers REFUSE
--     member_blocked before its insert, keeping its table-returning shape; app.request_to_join refuses member_blocked
--     with the same generic sentence, after its own checks; app.auto_join_offers leaves the org out.
--   * Matching reads auth.users.email, lowercased, whether or not it is confirmed: an invitation link does not need a
--     confirmed address. Service accounts (0922 inserts their membership before the app.service_accounts row exists)
--     are recognised by their auth user's provider xos_service_account and never refused, nor is a person without a
--     user or an email.
--   * Adding an entry revokes the matching pending invites and declines the matching pending requests to join through
--     app.decide_join_request (the caller already holds org.members.manage). Current members are counted, never removed.
--   * The org's own verified domains (Verified Domain purpose) cannot be blocked, nor a parent of one; one address
--     inside them can. entry_value is Internal like app.invites.email, so private.column_classifications holds no row;
--     the read policy (org.members.manage) protects it.

-- The blocklist --------------------------------------------------------------------------------------------------

create type app.blocklist_entry_kind as enum ('Email', 'Domain');
comment on type app.blocklist_entry_kind is 'What a blocklist entry matches: one email address, or a domain and every subdomain of it.';

create table app.member_blocklist_entries (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  entry_kind app.blocklist_entry_kind not null,
  entry_value text not null,
  reason text,
  constraint member_blocklist_entries_value_lower check (entry_value = lower(btrim(entry_value))),
  constraint member_blocklist_entries_value_shape check (
    (entry_kind = 'Email' and entry_value ~ '^[^@\s]+@[a-z0-9.-]+\.[a-z]{2,}$')
    or (entry_kind = 'Domain' and entry_value ~ '^([a-z0-9-]+\.)+[a-z]{2,}$' and char_length(entry_value) <= 253)),
  constraint member_blocklist_entries_reason_length check (reason is null or char_length(btrim(reason)) between 1 and 500)
);

call private.install_domain_table('app.member_blocklist_entries');
create unique index member_blocklist_entries_value_key on app.member_blocklist_entries (org_id, entry_kind, entry_value)
  where deleted_at is null;
call private.describe('app.member_blocklist_entries', 'Email addresses and domains an org does not accept new members from (Section 4.8.1, ADR 0155 D3). Every new membership whose sign-in address matches a live entry is refused (t12_refuse_blocked_member); current members are never removed. Written only by app.add_blocklist_entry and app.remove_blocklist_entry.', array[
  'entry_kind', 'Email for one address, Domain for a domain and every subdomain of it.',
  'entry_value', 'The address or domain, lowercased and trimmed.',
  'reason', 'Why the entry was added, shown to the org''s admins; null when none was given.'
]);

call private.install_policies('app.member_blocklist_entries',
  $$org_id in (select private.orgs_with_capability('org.members.manage'))$$);
revoke insert, update, delete on app.member_blocklist_entries from authenticated;
call private.install_audit_trail('app.member_blocklist_entries');
call private.install_default_retention('app.member_blocklist_entries');

insert into private.trash_excluded_tables (table_name, rationale) values
  ('member_blocklist_entries', 'A removed entry is restored access, changed in Settings, Members, as the IP allow-list is (ADR 0110).')
on conflict (table_name) do nothing;

-- Matching -------------------------------------------------------------------------------------------------------

create or replace function private.blocklist_matches(p_kind app.blocklist_entry_kind, p_value text, p_email text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_email is not null and case p_kind
    when 'Email' then lower(btrim(p_email)) = p_value
    when 'Domain' then split_part(lower(btrim(p_email)), '@', 2) = p_value
      or right(split_part(lower(btrim(p_email)), '@', 2), char_length(p_value) + 1) = '.' || p_value
    else false end;
$$;

comment on function private.blocklist_matches(app.blocklist_entry_kind, text, text) is 'Whether an email address matches one blocklist entry: an Email entry exactly, a Domain entry on the address''s domain or any subdomain of it, ignoring case.';
revoke all on function private.blocklist_matches(app.blocklist_entry_kind, text, text) from public, anon, authenticated;

create or replace function private.blocklist_entry_for(p_org_id uuid, p_email text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select e.id from app.member_blocklist_entries e
  where e.org_id = p_org_id and e.deleted_at is null and private.blocklist_matches(e.entry_kind, e.entry_value, p_email)
  order by e.created_at
  limit 1;
$$;

comment on function private.blocklist_entry_for(uuid, text) is 'The org''s live blocklist entry an email address matches (the exact address, its domain or a parent domain), or null.';
revoke all on function private.blocklist_entry_for(uuid, text) from public, anon, authenticated;

create or replace function private.user_blocklist_entry(p_org_id uuid, p_user_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select private.blocklist_entry_for(p_org_id, u.email)
  from auth.users u
  where u.id = p_user_id and u.email is not null
    and coalesce(u.raw_app_meta_data ->> 'provider', '') <> 'xos_service_account'
    and exists (select 1 from app.member_blocklist_entries e where e.org_id = p_org_id and e.deleted_at is null);
$$;

comment on function private.user_blocklist_entry(uuid, uuid) is 'The org''s blocklist entry an auth user''s sign-in address matches (auth.users.email, confirmed or not), or null: always null for a service account (provider xos_service_account, 0922), a user without an email, and an org with no live entry.';
revoke all on function private.user_blocklist_entry(uuid, uuid) from public, anon, authenticated;

create or replace function private.refuse_blocked_member()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Fast path: most orgs keep no blocklist.
  if not exists (select 1 from app.member_blocklist_entries e where e.org_id = new.org_id and e.deleted_at is null) then
    return new;
  end if;
  if private.user_blocklist_entry(new.org_id, (select p.user_id from app.people p where p.id = new.person_id)) is not null then
    perform private.refuse('member_blocked', 'You cannot join this organization. Ask one of its administrators.');
  end if;
  return new;
end;
$$;

comment on function private.refuse_blocked_member() is 'Refuses a new membership whose person''s sign-in address matches a live entry of the org''s blocklist (member_blocked, 3050), whoever is acting, the service role and SCIM included. Service accounts and people without a user or an email are never refused. Inserts only: current memberships are never touched.';
revoke all on function private.refuse_blocked_member() from public, anon, authenticated;

create trigger t12_refuse_blocked_member before insert on app.memberships
  for each row execute function private.refuse_blocked_member();

-- RPCs -----------------------------------------------------------------------------------------------------------

create or replace function private.blocklist_members_matching(p_org_id uuid, p_kind app.blocklist_entry_kind, p_value text)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(distinct m.person_id)::integer
  from app.memberships m
  join app.people p on p.id = m.person_id
  join auth.users u on u.id = p.user_id
  where m.org_id = p_org_id and m.deleted_at is null and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
    and coalesce(u.raw_app_meta_data ->> 'provider', '') <> 'xos_service_account'
    and private.blocklist_matches(p_kind, p_value, u.email);
$$;

comment on function private.blocklist_members_matching(uuid, app.blocklist_entry_kind, text) is 'How many people with an active membership in the org have a sign-in address an entry matches; service accounts are not counted.';
revoke all on function private.blocklist_members_matching(uuid, app.blocklist_entry_kind, text) from public, anon, authenticated;

create or replace function app.add_blocklist_entry(
  p_org_id uuid,
  p_kind app.blocklist_entry_kind,
  p_value text,
  p_reason text default null
)
returns table (entry_id uuid, invites_revoked integer, requests_declined integer, members_matching integer)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_person();
  v_value text := lower(btrim(coalesce(p_value, '')));
  v_id uuid;
  v_invites integer;
  v_requests integer := 0;
  v_request uuid;
begin
  if not private.has_capability(p_org_id, 'org.members.manage') then
    raise exception using errcode = '42501', message = 'org.members.manage is required';
  end if;
  if p_kind = 'Domain' then
    v_value := ltrim(v_value, '@');
  end if;
  if p_kind is null
     or (p_kind = 'Email' and v_value !~ '^[^@\s]+@[a-z0-9.-]+\.[a-z]{2,}$')
     or (p_kind = 'Domain' and (v_value !~ '^([a-z0-9-]+\.)+[a-z]{2,}$' or char_length(v_value) > 253
                                or right(v_value, 8) = '.invalid')) then
    perform private.refuse('blocklist_value_invalid', 'Enter an email address such as name@example.com, or a domain such as example.com.');
  end if;
  if p_kind = 'Domain' and exists (
    select 1 from app.org_domains d
    where d.org_id = p_org_id and d.purpose = 'Verified Domain' and d.verification_state = 'Verified' and d.deleted_at is null
      and (d.hostname = v_value or right(d.hostname, char_length(v_value) + 1) = '.' || v_value)) then
    perform private.refuse('blocklist_own_domain', 'This domain is, or contains, one of the organization''s verified domains. Block single addresses there instead.');
  end if;
  -- One writer at a time per org, so the count of live entries holds.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('blocklist:' || p_org_id::text, 0));
  if exists (
    select 1 from app.member_blocklist_entries e
    where e.org_id = p_org_id and e.entry_kind = p_kind and e.entry_value = v_value and e.deleted_at is null) then
    perform private.refuse('blocklist_duplicate', 'This address or domain is already on the blocklist.');
  end if;
  if (select count(*) from app.member_blocklist_entries e where e.org_id = p_org_id and e.deleted_at is null) >= 1000 then
    perform private.refuse('blocklist_full', 'A blocklist holds at most 1,000 entries. Remove some, or block a domain instead of its addresses.');
  end if;

  insert into app.member_blocklist_entries (org_id, entry_kind, entry_value, reason)
  values (p_org_id, p_kind, v_value, nullif(btrim(coalesce(p_reason, '')), ''))
  returning id into v_id;

  update app.invites i set revoked_at = now()
  where i.org_id = p_org_id and i.accepted_at is null and i.revoked_at is null and i.deleted_at is null
    and private.blocklist_matches(p_kind, v_value, i.email);
  get diagnostics v_invites = row_count;

  -- Declined exactly as an admin declines one in Members; the caller's own request, if any, stays theirs to withdraw.
  for v_request in
    select r.id from app.join_requests r
    join app.people p on p.id = r.person_id
    join auth.users u on u.id = p.user_id
    where r.org_id = p_org_id and r.join_request_state = 'Pending' and r.deleted_at is null and r.person_id <> v_me
      and private.blocklist_matches(p_kind, v_value, u.email)
  loop
    perform app.decide_join_request(v_request, false);
    v_requests := v_requests + 1;
  end loop;

  return query select v_id, v_invites, v_requests, private.blocklist_members_matching(p_org_id, p_kind, v_value);
end;
$$;

comment on function app.add_blocklist_entry(uuid, app.blocklist_entry_kind, text, text) is 'Adds an email address or a domain to the org''s blocklist (org.members.manage, 42501 otherwise; ADR 0155 D3). The value is lowercased and trimmed. Refuses a malformed value or a .invalid domain (blocklist_value_invalid), a Domain that is or contains one of the org''s verified domains (blocklist_own_domain), a duplicate (blocklist_duplicate) and a 1,001st live entry (blocklist_full). In the same transaction it revokes the matching pending invitations and declines the matching pending requests to join, and returns those counts with how many current members match; current members are not removed.';
revoke all on function app.add_blocklist_entry(uuid, app.blocklist_entry_kind, text, text) from public, anon;
grant execute on function app.add_blocklist_entry(uuid, app.blocklist_entry_kind, text, text) to authenticated;

create or replace function app.remove_blocklist_entry(p_entry_id uuid)
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
  select e.org_id into v_org from app.member_blocklist_entries e where e.id = p_entry_id and e.deleted_at is null;
  if v_org is null or not private.has_capability(v_org, 'org.members.manage') then
    raise exception using errcode = '42501', message = 'org.members.manage is required';
  end if;
  update app.member_blocklist_entries set deleted_at = now() where id = p_entry_id;
end;
$$;

comment on function app.remove_blocklist_entry(uuid) is 'Removes an entry from the org''s blocklist (soft delete, org.members.manage); the address or domain may join again.';
revoke all on function app.remove_blocklist_entry(uuid) from public, anon;
grant execute on function app.remove_blocklist_entry(uuid) to authenticated;

create or replace function app.member_blocklist(p_org_id uuid)
returns table (
  entry_id uuid,
  entry_kind app.blocklist_entry_kind,
  entry_value text,
  reason text,
  created_at timestamptz,
  created_by_name text,
  members_matching integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.has_capability(p_org_id, 'org.members.manage') then
    raise exception using errcode = '42501', message = 'org.members.manage is required';
  end if;
  return query
    select e.id, e.entry_kind, e.entry_value, e.reason, e.created_at, p.full_name,
           private.blocklist_members_matching(p_org_id, e.entry_kind, e.entry_value)
    from app.member_blocklist_entries e
    left join app.people p on p.id = e.created_by
    where e.org_id = p_org_id and e.deleted_at is null
    order by e.created_at desc;
end;
$$;

comment on function app.member_blocklist(uuid) is 'The org''s live blocklist for Settings, Members (org.members.manage, 42501 otherwise): each entry with who added it and when, and how many current members it matches. Nothing is removed automatically: admins end those memberships in Members.';
revoke all on function app.member_blocklist(uuid) from public, anon;
grant execute on function app.member_blocklist(uuid) to authenticated;

create or replace function app.scim_email_blocked(p_identity_provider_id uuid, p_email text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select private.blocklist_entry_for(p.org_id, p_email) is not null
      and not exists (
        select 1 from auth.users u
        join app.people pe on pe.user_id = u.id
        join app.memberships m on m.person_id = pe.id and m.org_id = p.org_id and m.deleted_at is null
          and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
        where lower(u.email) = lower(btrim(p_email)))
    from app.identity_providers p where p.id = p_identity_provider_id and p.deleted_at is null), false);
$$;

comment on function app.scim_email_blocked(uuid, text) is 'SCIM endpoint (service role): whether provisioning this email into the identity provider''s org would be refused by the blocklist, checked before the auth user is created so a refused person gets neither a user nor a membership. False for a current member, whom SCIM keeps updating.';
revoke all on function app.scim_email_blocked(uuid, text) from public, anon, authenticated;
grant execute on function app.scim_email_blocked(uuid, text) to service_role;

-- Join paths -----------------------------------------------------------------------------------------------------

-- Redefined from 0206 (its only definition): a blocked address is not invited. The check follows the capability and
-- role checks, so a caller without org.members.invite learns nothing about the blocklist.
create or replace function app.invite_member(
  p_org_id uuid,
  p_email text,
  p_role_id uuid,
  p_valid_for interval default interval '14 days'
)
returns table (invite_id uuid, invite_token text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_email text := lower(btrim(p_email));
  v_role app.roles;
  v_token text := private.issue_invite_token();
  v_invite uuid;
begin
  if not private.has_capability(p_org_id, 'org.members.invite') then
    raise exception using errcode = '42501', message = 'org.members.invite is required';
  end if;
  select * into v_role from app.roles r
  where r.id = p_role_id and r.deleted_at is null and (r.org_id is null or r.org_id = p_org_id);
  if v_role.id is null then
    perform private.refuse('role_unknown', 'The role is not available in this org.');
  end if;
  if coalesce(private.best_band(v_person, p_org_id), 8) > v_role.band then
    perform private.refuse('role_band', 'A person can assign only roles at or below their own band.');
  end if;
  perform private.assert_holds_role_capabilities(v_person, p_org_id, p_role_id);
  if p_valid_for < interval '1 hour' or p_valid_for > interval '30 days' then
    perform private.refuse('invite_expiry_range', 'An invite expires between 1 hour and 30 days after it is sent.');
  end if;
  if v_email = (select lower(u.email) from auth.users u where u.id = (select auth.uid())) then
    perform private.refuse('sod_self_grant', 'A person cannot grant themselves a role or capability.');
  end if;
  if private.blocklist_entry_for(p_org_id, v_email) is not null then
    perform private.refuse('invite_blocked', 'This email address or its domain is on the organization''s blocklist. Remove it in Settings, Members, first.');
  end if;

  update app.invites i set revoked_at = now()
  where i.org_id = p_org_id and i.email = v_email and i.accepted_at is null and i.revoked_at is null;

  insert into app.invites (org_id, email, role_id, token_hash, expires_at, invited_by)
  values (p_org_id, v_email, p_role_id, private.invite_token_hash(v_token), now() + p_valid_for, v_person)
  returning id into v_invite;
  return query select v_invite, v_token;
end;
$$;

comment on function app.invite_member(uuid, text, uuid, interval) is 'Invites an email to the org with a role the inviter may grant and an expiry of 1 hour to 30 days. Replaces any pending invite for the same email. Refuses an address the org''s blocklist matches (invite_blocked, 3050), after the capability and role checks. Returns the token once; only its hash is stored.';
revoke all on function app.invite_member(uuid, text, uuid, interval) from public, anon;
grant execute on function app.invite_member(uuid, text, uuid, interval) to authenticated, service_role;

-- Redefined from 0206 (its only definition): a blocked person gets REFUSE member_blocked before the membership insert,
-- in the function's own shape; t12_refuse_blocked_member stays the backstop.
create or replace function app.accept_invite(p_token text)
returns table (membership_id uuid, refusal text, reason text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_invite app.invites;
  v_invite_id uuid;
  v_reason text;
  v_person uuid;
  v_membership uuid;
begin
  select r.invite_id, r.reason into v_invite_id, v_reason from private.resolve_invite(p_token) r;
  select * into v_invite from app.invites i where i.id = v_invite_id;
  if v_reason is not null then
    return query select null::uuid, 'REFUSE'::text, v_reason;
    return;
  end if;
  if not v_invite.partner_bootstrap and private.person_capability_reach(
       v_invite.invited_by, v_invite.org_id, 'org.members.invite', false) is distinct from 'organization' then
    return query select null::uuid, 'REFUSE'::text, 'invite_inviter_inactive'::text;
    return;
  end if;

  v_person := private.current_person_id();
  if v_person is null then
    insert into app.people (user_id) values ((select auth.uid())) returning id into v_person;
  end if;

  perform private.begin_trusted_operation('membership_write');
  select m.id into v_membership from app.memberships m
  where m.org_id = v_invite.org_id and m.person_id = v_person and m.deleted_at is null
    and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now());
  if v_membership is null then
    if private.user_blocklist_entry(v_invite.org_id, (select auth.uid())) is not null then
      perform private.end_trusted_operation('membership_write');
      return query select null::uuid, 'REFUSE'::text, 'member_blocked'::text;
      return;
    end if;
    insert into app.memberships (org_id, person_id) values (v_invite.org_id, v_person)
    returning id into v_membership;
  end if;
  if not exists (
    select 1 from app.membership_roles mr
    where mr.membership_id = v_membership and mr.role_id = v_invite.role_id and mr.deleted_at is null
  ) then
    insert into app.membership_roles (membership_id, role_id, granted_by)
    values (v_membership, v_invite.role_id, v_invite.invited_by);
  end if;
  update app.invites i set accepted_at = now(), accepted_person_id = v_person where i.id = v_invite.id;
  perform private.end_trusted_operation('membership_write');
  return query select v_membership, null::text, null::text;
end;
$$;

comment on function app.accept_invite(text) is 'Accepts an invite for the confirmed sign-in it was sent to: joins the org (or reuses the active membership) and receives the role, granted by the inviter, who must still hold org.members.invite. Returns the membership id, or REFUSE with a reason: member_blocked when the org''s blocklist matches the person''s sign-in address and they are not already a member (3050).';
revoke all on function app.accept_invite(text) from public, anon;
grant execute on function app.accept_invite(text) to authenticated, service_role;

-- Redefined from 0861 (its only definition): a blocked person is refused with the generic sentence, after the
-- function's own checks.
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
  if private.user_blocklist_entry(p_org_id, (select auth.uid())) is not null then
    perform private.refuse('member_blocked', 'You cannot join this organization. Ask one of its administrators.');
  end if;
  insert into app.join_requests (org_id, person_id, message) values (p_org_id, v_me, nullif(btrim(p_message), ''))
  returning id into v_id;
  return v_id;
end;
$$;

comment on function app.request_to_join(uuid, text) is 'The signed-in person asks to join an org whose profile they can see. One pending request per org. A person the org''s blocklist matches is refused member_blocked with a generic sentence that does not say why (3050). Returns the request id.';
revoke all on function app.request_to_join(uuid, text) from public, anon;
grant execute on function app.request_to_join(uuid, text) to authenticated, service_role;

-- Redefined from 0861 (its only definition): an org whose blocklist matches the caller is not offered.
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
    and private.user_blocklist_entry(o.id, u.id) is null
    and not exists (
      select 1 from app.memberships m where m.org_id = o.id and m.person_id = private.current_person_id() and m.deleted_at is null
        and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now()));
$$;

comment on function app.auto_join_offers() is 'Orgs the signed-in person may join automatically through their confirmed email domain, for the sign-up and Organizations pages. An org whose blocklist matches the person''s address is left out (3050).';
revoke all on function app.auto_join_offers() from public, anon;
grant execute on function app.auto_join_offers() to authenticated, service_role;

select private.sync_trash_tables();
