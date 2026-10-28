-- 2630_account_membership_acceptance.sql
-- R4 Crew roster core (RRR-182, ADR 0101 decision 2; owner decisions 0/1 of 2026-10-28). The person accepts account
-- membership before anything about them flows to the company or a producing org.
--
--   * app.account_memberships.accepted_at: when the person confirmed. A membership app.add_account_member creates keeps
--     today's account access while unconfirmed (accepted_at NULL, as every existing membership is after this migration),
--     so API v1 and every reader of account_memberships stay as they are; an unconfirmed member cannot be rostered,
--     assigned or listed in the talent pool, and Gateway Home asks them to confirm. No backfill.
--   * app.create_external_account (from 0710) accepts the creator's own membership.
--   * app.accept_account_membership: the person confirms. Declining is app.end_account_membership (0710).
--   * app.account_invitations: an account invites an address. There is no token: the invitee claims it by signing in to
--     Gateway with that confirmed email (Section 4.4.6, prompt line 589), as app.claim_token_submissions (0769) does.
--     Each invitation queues one platform email (private.platform_emails, 1382) to the address with a link to Gateway
--     sign-in; the address is never put in a URL.
--   * app.invite_account_member and app.revoke_account_invitation; api_external.account_members gains accepted_at as its
--     last column and api_external.account_invitations lists an account's pending invitations to its Owners and Admins.

-- Acceptance --------------------------------------------------------------------------------------------------------------

alter table app.account_memberships add column accepted_at timestamptz;

comment on column app.account_memberships.accepted_at is 'When the person confirmed the membership; NULL for a membership an account admin created that the person has not confirmed. An unconfirmed member keeps account access but is never rostered, assigned or listed in the talent pool (ADR 0101).';

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
  insert into app.account_memberships (org_id, person_id, accepted_at) values (v_account, v_person, now()) returning id into v_membership;
  insert into app.account_membership_roles (account_membership_id, account_role, granted_by)
  values (v_membership, 'Account Owner', null);
  return v_account;
end;
$$;

comment on function app.create_external_account(text, text, text) is 'Creates an external account (Section 4.4.1): an organization without a subscription, with the signed-in person as its Account Owner, their membership accepted at once (R4). Returns the organization id.';

create or replace function app.accept_account_membership(p_account_membership_id uuid)
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
  select * into v_member from app.account_memberships m
  where m.id = p_account_membership_id and m.deleted_at is null
    and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now());
  if v_member.id is null or v_member.person_id <> v_me then
    perform private.refuse('account_membership_not_yours', 'Only the person a live account membership names confirms it.');
  end if;
  update app.account_memberships set accepted_at = now() where id = v_member.id and accepted_at is null;
end;
$$;

comment on function app.accept_account_membership(uuid) is 'The person a live, active account membership names confirms it (ADR 0101 decision 2); confirming again changes nothing. Declining is app.end_account_membership.';

-- Invitations -------------------------------------------------------------------------------------------------------------

create table app.account_invitations (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  email text not null,
  account_role app.account_role not null,
  invited_by uuid not null references app.people (id),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  accepted_person_id uuid references app.people (id),
  declined_at timestamptz,
  revoked_at timestamptz,
  deleted_at timestamptz,
  constraint account_invitations_email check (email = lower(btrim(email)) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and char_length(email) <= 320),
  constraint account_invitations_accepted_pair check ((accepted_at is null) = (accepted_person_id is null)),
  constraint account_invitations_one_outcome check (num_nonnulls(accepted_at, declined_at, revoked_at) <= 1)
);

create index account_invitations_invited_by_idx on app.account_invitations (invited_by);
create index account_invitations_accepted_person_id_idx on app.account_invitations (accepted_person_id);
create index account_invitations_email_idx on app.account_invitations (email);
create unique index account_invitations_pending_key on app.account_invitations (org_id, email)
  where accepted_at is null and declined_at is null and revoked_at is null and deleted_at is null;

call private.install_domain_table('app.account_invitations');
call private.describe('app.account_invitations', 'An external account''s invitation of an email address to join it with a role (ADR 0101). Claimed by the invitee signing in to Gateway with that confirmed email; no token travels. Written only by app.invite_account_member, app.revoke_account_invitation and app.respond_party_invitation. One pending invitation per account and address.', array[
  'org_id', 'The inviting external account.',
  'email', 'Invited address, lowercased. Never put in a URL.',
  'account_role', 'Account role the invitee receives on accepting.',
  'invited_by', 'Account Owner or Admin who invited.',
  'expires_at', 'When the invitation lapses unanswered.',
  'accepted_at', 'When the invitee accepted.',
  'accepted_person_id', 'Person who accepted, signed in with the invited address.',
  'declined_at', 'When the invitee declined.',
  'revoked_at', 'When the account revoked it, or replaced it with a newer invitation.'
]);

call private.install_policies('app.account_invitations',
  $$org_id in (select private.my_account_ids(array['Account Owner', 'Account Admin']::app.account_role[]))$$);
revoke insert, update on app.account_invitations from authenticated;
call private.install_default_retention('app.account_invitations');
call private.install_audit_trail('app.account_invitations');

insert into private.trash_excluded_tables (table_name, rationale) values
  ('account_invitations', 'An invitation is access: a revoked or replaced invitation is sent again, never restored from Trash.')
on conflict (table_name) do nothing;

-- Platform emails ---------------------------------------------------------------------------------------------------------
-- Invitations reach people who are not on the platform, so the platform sends them in its own name (1382).

alter table private.platform_emails drop constraint platform_emails_template;
alter table private.platform_emails add constraint platform_emails_template
  check (template in ('subprocessor_confirm', 'subprocessor_notice', 'party_invitation'));
comment on column private.platform_emails.template is 'Template: subprocessor_confirm, subprocessor_notice or party_invitation (packages/email).';

create or replace function private.queue_party_invitation_email(p_kind text, p_email text, p_args jsonb)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  insert into private.platform_emails (template, to_email, locale, args)
  values ('party_invitation', p_email, 'en-US', coalesce(p_args, '{}'::jsonb) || jsonb_build_object('kind', p_kind));
end;
$$;

comment on function private.queue_party_invitation_email(text, text, jsonb) is 'Queues one party_invitation platform email (1382) to an invited address: kind account or roster, with the names to show. The worker links to Gateway sign-in; the address never goes into the link.';
revoke all on function private.queue_party_invitation_email(text, text, jsonb) from public, anon, authenticated;

create or replace function private.normalized_invitation_email(p_email text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
begin
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or char_length(v_email) > 320 then
    perform private.refuse('invitation_email', 'Enter one email address.');
  end if;
  return v_email;
end;
$$;

comment on function private.normalized_invitation_email(text) is 'An invited address lowercased and trimmed; refuses (invitation_email) anything that is not one address.';
revoke all on function private.normalized_invitation_email(text) from public, anon, authenticated;

create or replace function private.assert_invitation_validity(p_valid_for interval)
returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_valid_for is null or p_valid_for < interval '1 hour' or p_valid_for > interval '30 days' then
    perform private.refuse('invite_expiry_range', 'An invitation stays open between 1 hour and 30 days.');
  end if;
end;
$$;

comment on function private.assert_invitation_validity(interval) is 'Refuses (invite_expiry_range) an invitation lifetime outside 1 hour to 30 days.';
revoke all on function private.assert_invitation_validity(interval) from public, anon, authenticated;

create or replace function private.my_confirmed_email()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select lower(u.email) from auth.users u
  where u.id = (select auth.uid()) and u.email_confirmed_at is not null and u.email is not null;
$$;

comment on function private.my_confirmed_email() is 'The signed-in user''s email address, lowercased, only once it is confirmed; NULL otherwise. Invitations are claimed by it (Section 4.4.6).';
revoke all on function private.my_confirmed_email() from public, anon, authenticated;

create or replace function app.invite_account_member(
  p_account_id uuid,
  p_email text,
  p_role app.account_role,
  p_valid_for interval default interval '14 days'
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_person();
  v_email text;
  v_id uuid;
begin
  perform private.assert_account_admin(p_account_id);
  v_email := private.normalized_invitation_email(p_email);
  if p_role is null then
    perform private.refuse('account_role_required', 'Choose the account role the invitee receives.');
  end if;
  if p_role = 'Account Owner' and not exists (select 1 from private.account_role(p_account_id) r where r = 'Account Owner') then
    perform private.refuse('account_role_band', 'Only an Account Owner offers Account Owner.');
  end if;
  if v_email = (select lower(u.email) from auth.users u join app.people p on p.user_id = u.id where p.id = v_me) then
    perform private.refuse('sod_self_grant', 'A person cannot grant themselves a role or capability.');
  end if;
  perform private.assert_invitation_validity(p_valid_for);
  update app.account_invitations set revoked_at = now()
  where org_id = p_account_id and email = v_email and accepted_at is null and declined_at is null and revoked_at is null
    and deleted_at is null;
  insert into app.account_invitations (org_id, email, account_role, invited_by, expires_at)
  values (p_account_id, v_email, p_role, v_me, now() + p_valid_for)
  returning id into v_id;
  perform private.queue_party_invitation_email('account', v_email, jsonb_build_object(
    'account_name', (select o.name from app.organizations o where o.id = p_account_id),
    'account_role', p_role,
    'inviter_name', (select p.full_name from app.people p where p.id = v_me),
    'expires_at', now() + p_valid_for));
  return v_id;
end;
$$;

comment on function app.invite_account_member(uuid, text, app.account_role, interval) is 'An Account Owner or Admin invites an email address to the account with a role, open for 1 hour to 30 days (14 by default); only an Owner offers Owner; never the caller''s own address. Replaces the pending invitation to the same address and queues one email to it. Returns the invitation id.';

create or replace function app.revoke_account_invitation(p_account_invitation_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_invitation app.account_invitations;
begin
  perform private.require_person();
  select * into v_invitation from app.account_invitations i where i.id = p_account_invitation_id and i.deleted_at is null;
  if v_invitation.id is null then
    raise exception using errcode = '42501', message = 'account invitation not found';
  end if;
  perform private.assert_account_admin(v_invitation.org_id);
  if v_invitation.accepted_at is not null or v_invitation.declined_at is not null or v_invitation.revoked_at is not null then
    perform private.refuse('invitation_closed', 'This invitation was already answered or revoked.');
  end if;
  update app.account_invitations set revoked_at = now() where id = v_invitation.id;
end;
$$;

comment on function app.revoke_account_invitation(uuid) is 'An Account Owner or Admin of the inviting account revokes a pending invitation.';

-- Views (as 0750: run as owner with explicit filters) ---------------------------------------------------------------------

create or replace view api_external.account_members as
select m.id as account_membership_id, m.org_id as account_id, m.person_id, pe.full_name, m.valid_from, m.valid_to,
  array(select r.account_role from app.account_membership_roles r where r.account_membership_id = m.id and r.deleted_at is null order by r.account_role) as roles,
  m.accepted_at
from app.account_memberships m
join app.people pe on pe.id = m.person_id
where m.deleted_at is null and (m.valid_to is null or m.valid_to > now())
  and m.org_id in (select private.my_account_ids(null));

call private.describe('api_external.account_members', 'The roster of accounts the caller belongs to.', array[
  'account_membership_id', 'Account membership.', 'account_id', 'Account.', 'person_id', 'Member.', 'full_name', 'Name.',
  'valid_from', 'Since.', 'valid_to', 'Until.', 'roles', 'Account roles.',
  'accepted_at', 'When the member confirmed; NULL while not confirmed.']);

create view api_external.account_invitations as
select i.id, i.org_id as account_id, i.email, i.account_role, p.full_name as invited_by_name, i.expires_at
from app.account_invitations i
join app.people p on p.id = i.invited_by
where i.deleted_at is null and i.accepted_at is null and i.declined_at is null and i.revoked_at is null and i.expires_at > now()
  and i.org_id in (select private.my_account_ids(array['Account Owner', 'Account Admin']::app.account_role[]));

call private.describe('api_external.account_invitations', 'Pending, unexpired invitations of the accounts where the caller is an Account Owner or Admin (R4).', array[
  'id', 'Invitation.', 'account_id', 'Inviting account.', 'email', 'Invited address.', 'account_role', 'Role offered.',
  'invited_by_name', 'Who invited.', 'expires_at', 'When it lapses.']);

revoke all on api_external.account_members, api_external.account_invitations from public, anon;
grant select on api_external.account_members, api_external.account_invitations to authenticated, service_role;

-- Privileges --------------------------------------------------------------------------------------------------------------

revoke all on function app.create_external_account(text, text, text) from public, anon;
revoke all on function app.accept_account_membership(uuid) from public, anon;
revoke all on function app.invite_account_member(uuid, text, app.account_role, interval) from public, anon;
revoke all on function app.revoke_account_invitation(uuid) from public, anon;
grant execute on function app.create_external_account(text, text, text) to authenticated, service_role;
grant execute on function app.accept_account_membership(uuid) to authenticated, service_role;
grant execute on function app.invite_account_member(uuid, text, app.account_role, interval) to authenticated, service_role;
grant execute on function app.revoke_account_invitation(uuid) to authenticated, service_role;

select private.sync_trash_tables();
