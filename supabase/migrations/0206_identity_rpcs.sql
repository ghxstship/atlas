-- 0206_identity_rpcs.sql
-- A02 Platform Data. Signup and org creation path (Wave 2 exit: sign up, create an org,
-- invite members, see an empty Home).
--   * every new auth user gets a person row
--   * app.create_organization: org, Access subscription, creator as Owner, atomically
--   * app.create_client_organization: a partner creates a client org with an Owner invite
--   * app.invite_member: invite by email with role and expiry; the token is returned once
--   * app.preview_invite and app.accept_invite: resolve a token for a confirmed sign-in
--   * app.leave_organization and app.end_membership: end access at once
-- Separation of duties (Section 8.2) is enforced by the guards in 0204; RPCs mark only the
-- acts they authorize themselves (the creator's own Owner role, an inviter's role grant).

-- People for new sign-ins -------------------------------------------------------------------

create or replace function private.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into app.people (user_id, full_name)
  values (new.id, nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''))
  on conflict (user_id) do nothing;
  return new;
end;
$$;

comment on function private.handle_new_auth_user() is 'After a sign-up, creates the person row linked to the auth user, taking full_name from the sign-up metadata when given.';
revoke all on function private.handle_new_auth_user() from public, anon, authenticated;

create trigger xos_create_person after insert on auth.users
  for each row execute function private.handle_new_auth_user();

-- Shared checks ---------------------------------------------------------------------------------

create or replace function private.require_person()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.current_person_id();
begin
  if v_person is null then
    raise exception using errcode = '42501', message = 'a signed-in person is required';
  end if;
  return v_person;
end;
$$;

comment on function private.require_person() is 'Signed-in person id, or an insufficient privilege error.';
revoke all on function private.require_person() from public, anon, authenticated;

create or replace function private.assert_org_slug_available(p_slug text)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from private.reserved_org_slugs r where r.slug = p_slug) then
    perform private.refuse('slug_reserved', format('%s is reserved by the platform.', p_slug));
  end if;
  if exists (select 1 from app.organizations o where o.slug = p_slug) then
    perform private.refuse('slug_taken', format('%s is already in use.', p_slug));
  end if;
end;
$$;

comment on function private.assert_org_slug_available(text) is 'Refuses an org slug that routes reserve or another org uses.';
revoke all on function private.assert_org_slug_available(text) from public, anon, authenticated;

create or replace function private.system_role_id(p_code text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select r.id from app.roles r where r.org_id is null and r.code = p_code;
$$;

comment on function private.system_role_id(text) is 'Id of a platform system role by code.';
revoke all on function private.system_role_id(text) from public, anon, authenticated;

create or replace function private.issue_invite_token()
returns text
language sql
volatile
set search_path = ''
as $$
  select 'xinv_' || encode(extensions.gen_random_bytes(32), 'hex');
$$;

comment on function private.issue_invite_token() is 'New invite token: 256 random bits, hex encoded with an xinv_ prefix.';
revoke all on function private.issue_invite_token() from public, anon, authenticated;

create or replace function private.invite_token_hash(p_token text)
returns bytea
language sql
immutable
set search_path = ''
as $$
  select extensions.digest(p_token, 'sha256');
$$;

comment on function private.invite_token_hash(text) is 'SHA-256 of an invite token, the only form stored.';
revoke all on function private.invite_token_hash(text) from public, anon, authenticated;

create or replace function private.create_subscription(p_org_id uuid, p_plan_code text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_subscription uuid;
begin
  if not exists (select 1 from app.plans p where p.code = p_plan_code) then
    perform private.refuse('plan_unknown', format('%s is not a plan.', p_plan_code));
  end if;
  insert into app.subscriptions (org_id, plan_code, subscription_state)
  values (p_org_id, p_plan_code, 'active')
  returning id into v_subscription;
  insert into app.subscription_state_transitions (subscription_id, from_state, to_state, reason)
  values (v_subscription, null, 'active', 'Organization created.');
end;
$$;

comment on function private.create_subscription(uuid, text) is 'Starts an org''s subscription in the active state and logs the creation entry.';
revoke all on function private.create_subscription(uuid, text) from public, anon, authenticated;

-- Organization creation ----------------------------------------------------------------------------

create or replace function app.create_organization(p_name text, p_slug text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_org uuid;
  v_membership uuid;
begin
  perform private.assert_org_slug_available(p_slug);
  insert into app.organizations (name, slug) values (btrim(p_name), p_slug) returning id into v_org;
  perform private.create_subscription(v_org, 'access');

  perform private.begin_trusted_operation('membership_write');
  insert into app.memberships (org_id, person_id) values (v_org, v_person) returning id into v_membership;
  insert into app.membership_roles (membership_id, role_id, granted_by)
  values (v_membership, private.system_role_id('owner'), null);
  perform private.end_trusted_operation('membership_write');
  return v_org;
end;
$$;

comment on function app.create_organization(text, text) is 'Creates an organization on the Access plan with the signed-in person as its Owner, in one transaction. Returns the org id.';

create or replace function app.create_client_organization(
  p_partner_org_id uuid,
  p_name text,
  p_slug text,
  p_owner_email text,
  p_plan_code text default 'access'
)
returns table (org_id uuid, invite_id uuid, invite_token text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_org uuid;
  v_token text := private.issue_invite_token();
  v_invite uuid;
begin
  if not private.has_capability(p_partner_org_id, 'org.partner.manage') then
    raise exception using errcode = '42501', message = 'org.partner.manage is required in the partner org';
  end if;
  perform private.assert_org_slug_available(p_slug);
  insert into app.organizations (name, slug, parent_org_id)
  values (btrim(p_name), p_slug, p_partner_org_id)
  returning id into v_org;
  perform private.create_subscription(v_org, p_plan_code);
  insert into app.invites (org_id, email, role_id, token_hash, expires_at, invited_by, partner_bootstrap)
  values (v_org, lower(btrim(p_owner_email)), private.system_role_id('owner'), private.invite_token_hash(v_token),
          now() + interval '14 days', v_person, true)
  returning id into v_invite;
  return query select v_org, v_invite, v_token;
end;
$$;

comment on function app.create_client_organization(uuid, text, text, text, text) is 'Partner console (Section 4.6.1): creates a client org under the partner on the given plan and an Owner invite for the client. Partner staff gain no access to the client org. The token is returned once.';

-- Invitations ---------------------------------------------------------------------------------------

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

  update app.invites i set revoked_at = now()
  where i.org_id = p_org_id and i.email = v_email and i.accepted_at is null and i.revoked_at is null;

  insert into app.invites (org_id, email, role_id, token_hash, expires_at, invited_by)
  values (p_org_id, v_email, p_role_id, private.invite_token_hash(v_token), now() + p_valid_for, v_person)
  returning id into v_invite;
  return query select v_invite, v_token;
end;
$$;

comment on function app.invite_member(uuid, text, uuid, interval) is 'Invites an email to the org with a role the inviter may grant and an expiry of 1 hour to 30 days. Replaces any pending invite for the same email. Returns the token once; only its hash is stored.';

create or replace function private.resolve_invite(p_token text)
returns table (invite_id uuid, reason text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_invite app.invites;
  v_email text;
  v_confirmed timestamptz;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'a signed-in user is required';
  end if;
  if (select count(*) from private.invite_accept_failures f
      where f.user_id = v_uid and f.attempted_at > now() - interval '15 minutes') >= 10 then
    return query select null::uuid, 'invite_rate_limited'::text;
    return;
  end if;
  select * into v_invite from app.invites i where i.token_hash = private.invite_token_hash(coalesce(p_token, ''));
  if v_invite.id is null or v_invite.accepted_at is not null or v_invite.revoked_at is not null
     or v_invite.deleted_at is not null or v_invite.expires_at <= now() or v_invite.failed_attempts >= 5 then
    insert into private.invite_accept_failures (user_id) values (v_uid);
    return query select null::uuid, 'invite_invalid'::text;
    return;
  end if;
  select lower(u.email), u.email_confirmed_at into v_email, v_confirmed from auth.users u where u.id = v_uid;
  if v_confirmed is null or v_email is distinct from v_invite.email then
    update app.invites i set failed_attempts = least(i.failed_attempts + 1, 5) where i.id = v_invite.id;
    insert into private.invite_accept_failures (user_id) values (v_uid);
    return query select null::uuid, 'invite_invalid'::text;
    return;
  end if;
  return query select v_invite.id, null::text;
end;
$$;

comment on function private.resolve_invite(text) is 'Resolves an invite token for the signed-in user. Returns a refusal reason instead of raising, so failed attempts persist: more than 10 failures in 15 minutes rate-limits the user, and 5 email mismatches lock the token (Section 7.5 invariant 8).';
revoke all on function private.resolve_invite(text) from public, anon, authenticated;

create or replace function app.preview_invite(p_token text)
returns table (org_name text, role_code text, role_name text, expires_at timestamptz, refusal text, reason text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_invite app.invites;
  v_invite_id uuid;
  v_reason text;
begin
  select r.invite_id, r.reason into v_invite_id, v_reason from private.resolve_invite(p_token) r;
  select * into v_invite from app.invites i where i.id = v_invite_id;
  if v_reason is not null then
    return query select null::text, null::text, null::text, null::timestamptz, 'REFUSE'::text, v_reason;
    return;
  end if;
  return query
    select o.name, ro.code, ro.name, v_invite.expires_at, null::text, null::text
    from app.organizations o, app.roles ro
    where o.id = v_invite.org_id and ro.id = v_invite.role_id;
end;
$$;

comment on function app.preview_invite(text) is 'Shows the org name, role and expiry an invite offers, only to the confirmed sign-in it was sent to. Returns REFUSE with a reason otherwise.';

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

comment on function app.accept_invite(text) is 'Accepts an invite for the confirmed sign-in it was sent to: joins the org (or reuses the active membership) and receives the role, granted by the inviter, who must still hold org.members.invite. Returns the membership id, or REFUSE with a reason.';

-- Leaving and removal ----------------------------------------------------------------------------------

create or replace function app.leave_organization(p_org_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_updated integer;
begin
  update app.memberships m set valid_to = now()
  where m.org_id = p_org_id and m.person_id = v_person and m.deleted_at is null
    and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now());
  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    perform private.refuse('not_member', 'The signed-in person is not a member of this org.');
  end if;
end;
$$;

comment on function app.leave_organization(uuid) is 'Ends the signed-in person''s membership now; access ends at once (Section 7.5 invariant 3). The sole Owner is refused.';

create or replace function app.end_membership(p_membership_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_updated integer;
begin
  perform private.require_person();
  update app.memberships m set valid_to = now()
  where m.id = p_membership_id and m.deleted_at is null and (m.valid_to is null or m.valid_to > now());
  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    perform private.refuse('not_member', 'The membership is not active.');
  end if;
end;
$$;

comment on function app.end_membership(uuid) is 'Ends another member''s membership now. Needs org.members.manage at or above the member''s band; the sole Owner is refused.';

revoke all on function app.create_organization(text, text) from public, anon;
revoke all on function app.create_client_organization(uuid, text, text, text, text) from public, anon;
revoke all on function app.invite_member(uuid, text, uuid, interval) from public, anon;
revoke all on function app.preview_invite(text) from public, anon;
revoke all on function app.accept_invite(text) from public, anon;
revoke all on function app.leave_organization(uuid) from public, anon;
revoke all on function app.end_membership(uuid) from public, anon;

grant execute on function app.create_organization(text, text) to authenticated, service_role;
grant execute on function app.create_client_organization(uuid, text, text, text, text) to authenticated, service_role;
grant execute on function app.invite_member(uuid, text, uuid, interval) to authenticated, service_role;
grant execute on function app.preview_invite(text) to authenticated, service_role;
grant execute on function app.accept_invite(text) to authenticated, service_role;
grant execute on function app.leave_organization(uuid) to authenticated, service_role;
grant execute on function app.end_membership(uuid) to authenticated, service_role;
