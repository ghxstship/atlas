-- 2636_roster_invitations.sql
-- R4 Crew roster core (RRR-182, ADR 0101 decision 7). People not yet on the platform join a roster by invitation
-- (prompt line 1084), for a company engagement or an individual artist's band (line 883).
--
--   * app.roster_invitations: an email invited onto a Draft entry whose person is not known yet. No token: the invitee
--     claims it by signing in to Gateway with that confirmed email (line 589). Each invitation queues one platform email
--     (1382) to the address with a link to Gateway sign-in; the address is never put in a URL.
--   * app.invite_to_roster and app.reissue_roster_invitation, for roster managers.
--   * app.my_pending_invitations lists the caller's pending account (2630) and roster invitations by their confirmed
--     email; app.respond_party_invitation accepts or declines either. Accepting a roster invitation claims the entry for
--     the caller and accepts it, and on a company engagement also makes them a confirmed Account Member of the account.
--     Declining withdraws the Draft entry.

create table app.roster_invitations (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  roster_entry_id uuid not null references app.engagement_roster_entries (id),
  email text not null,
  invited_by uuid not null references app.people (id),
  expires_at timestamptz not null,
  claimed_at timestamptz,
  claimed_person_id uuid references app.people (id),
  declined_at timestamptz,
  revoked_at timestamptz,
  deleted_at timestamptz,
  constraint roster_invitations_email check (email = lower(btrim(email)) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and char_length(email) <= 320),
  constraint roster_invitations_claimed_pair check ((claimed_at is null) = (claimed_person_id is null)),
  constraint roster_invitations_one_outcome check (num_nonnulls(claimed_at, declined_at, revoked_at) <= 1)
);

create index roster_invitations_roster_entry_id_idx on app.roster_invitations (roster_entry_id);
create index roster_invitations_invited_by_idx on app.roster_invitations (invited_by);
create index roster_invitations_claimed_person_id_idx on app.roster_invitations (claimed_person_id);
create index roster_invitations_email_idx on app.roster_invitations (email);
create unique index roster_invitations_pending_key on app.roster_invitations (roster_entry_id)
  where claimed_at is null and declined_at is null and revoked_at is null and deleted_at is null;

call private.install_domain_table('app.roster_invitations', 'app.engagement_roster_entries', 'roster_entry_id');
call private.describe('app.roster_invitations', 'An email address invited onto a roster entry whose person is not on the platform yet (ADR 0101 decision 7, prompt line 1084). Claimed by the invitee signing in to Gateway with that confirmed email; no token travels. Written only by the roster invitation RPCs; one pending invitation per entry.', array[
  'org_id', 'Producing org, derived from the roster entry.',
  'roster_entry_id', 'Draft roster entry the invitation fills.',
  'email', 'Invited address, lowercased. Never put in a URL.',
  'invited_by', 'Roster manager who invited.',
  'expires_at', 'When the invitation lapses unanswered.',
  'claimed_at', 'When the invitee accepted and the entry became theirs.',
  'claimed_person_id', 'Person who accepted, signed in with the invited address.',
  'declined_at', 'When the invitee declined.',
  'revoked_at', 'When a manager revoked or replaced it, or withdrew the entry.'
]);

call private.install_policies('app.roster_invitations',
  $$roster_entry_id in (select r.id from app.engagement_roster_entries r join app.engagements e on e.id = r.engagement_id
      where e.project_id in (select private.project_ids_with('advancing.packet.read'))
        or e.project_id in (select private.project_ids_with('opportunities.engagement.read')))$$);
revoke insert, update on app.roster_invitations from authenticated;
call private.install_default_retention('app.roster_invitations');
call private.install_audit_trail('app.roster_invitations');

insert into private.trash_excluded_tables (table_name, rationale) values
  ('roster_invitations', 'An invitation is access: a revoked or replaced invitation is sent again, never restored from Trash.')
on conflict (table_name) do nothing;

-- Sending ----------------------------------------------------------------------------------------------------------------------

create or replace function private.issue_roster_invitation(p_roster_entry_id uuid, p_email text, p_valid_for interval)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.current_person_id();
  v_id uuid;
begin
  perform private.assert_invitation_validity(p_valid_for);
  update app.roster_invitations set revoked_at = now()
  where roster_entry_id = p_roster_entry_id and claimed_at is null and declined_at is null and revoked_at is null and deleted_at is null;
  insert into app.roster_invitations (roster_entry_id, email, invited_by, expires_at)
  values (p_roster_entry_id, p_email, v_me, now() + p_valid_for)
  returning id into v_id;
  perform private.queue_party_invitation_email('roster', p_email, (
    select jsonb_build_object(
      'org_name', o.name,
      'project_name', p.name,
      'party_name', coalesce(a.name, ep.full_name),
      'job_title', xr.job_title,
      'inviter_name', (select ip.full_name from app.people ip where ip.id = v_me),
      'expires_at', now() + p_valid_for)
    from app.engagement_roster_entries r
    join app.engagements e on e.id = r.engagement_id
    join app.organizations o on o.id = e.org_id
    join app.projects p on p.id = e.project_id
    left join app.counterparties c on c.id = e.counterparty_id
    left join app.organizations a on a.id = c.organization_id
    left join app.people ep on ep.id = e.person_id
    left join xpms.role xr on xr.role_code = r.role_code
    where r.id = p_roster_entry_id), private.roster_entry_account(p_roster_entry_id));
  return v_id;
end;
$$;

comment on function private.issue_roster_invitation(uuid, text, interval) is 'Revokes the entry''s pending invitation, records a new one open for p_valid_for (1 hour to 30 days) and queues one email to the address. Callers authorize first.';
revoke all on function private.issue_roster_invitation(uuid, text, interval) from public, anon, authenticated;

create or replace function app.invite_to_roster(
  p_engagement_id uuid,
  p_email text,
  p_role_code text default null,
  p_arrival_starts_at timestamptz default null,
  p_arrival_ends_at timestamptz default null,
  p_arrival_time_zone text default null,
  p_valid_for interval default interval '14 days'
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_engagement app.engagements;
  v_email text;
  v_window tstzrange;
  v_entry uuid;
begin
  perform private.require_person();
  select * into v_engagement from app.engagements e where e.id = p_engagement_id and e.deleted_at is null;
  perform private.assert_roster_manager(v_engagement);
  v_email := private.normalized_invitation_email(p_email);
  perform private.assert_invitation_validity(p_valid_for);
  if exists (
    select 1 from app.roster_invitations i join app.engagement_roster_entries r on r.id = i.roster_entry_id
    where r.engagement_id = v_engagement.id and r.deleted_at is null and r.entry_state <> 'Withdrawn' and i.email = v_email
      and i.claimed_at is null and i.declined_at is null and i.revoked_at is null and i.deleted_at is null) then
    perform private.refuse('roster_person_duplicate', 'This address is already invited onto the engagement''s roster.');
  end if;
  v_window := private.roster_arrival(p_arrival_starts_at, p_arrival_ends_at, p_arrival_time_zone);
  v_entry := private.insert_roster_entry(v_engagement.id, null, p_role_code, v_window, p_arrival_time_zone, null, false);
  perform private.issue_roster_invitation(v_entry, v_email, p_valid_for);
  return v_entry;
end;
$$;

comment on function app.invite_to_roster(uuid, text, text, timestamptz, timestamptz, text, interval) is 'A roster manager invites an email address onto the roster, for a company engagement or an individual artist''s band: a Draft entry with no person yet and one invitation open for 1 hour to 30 days (14 by default), with one email queued to the address. Same authority and checks as app.add_roster_entry, plus invite_expiry_range. Returns the entry id.';

create or replace function app.reissue_roster_invitation(p_roster_entry_id uuid, p_valid_for interval default interval '14 days')
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_entry app.engagement_roster_entries;
  v_engagement app.engagements;
  v_email text;
begin
  perform private.require_person();
  select * into v_entry from app.engagement_roster_entries r where r.id = p_roster_entry_id and r.deleted_at is null for update;
  select * into v_engagement from app.engagements e where e.id = v_entry.engagement_id and e.deleted_at is null;
  if v_entry.id is null then
    raise exception using errcode = '42501', message = 'roster entry not found';
  end if;
  perform private.assert_roster_manager(v_engagement);
  select i.email into v_email from app.roster_invitations i
  where i.roster_entry_id = v_entry.id and i.claimed_at is null and i.declined_at is null and i.deleted_at is null
  order by i.created_at desc, i.id desc limit 1;
  if v_entry.person_id is not null or v_entry.entry_state = 'Withdrawn' or v_email is null then
    perform private.refuse('invitation_closed', 'This entry has no open invitation to send again.');
  end if;
  return private.issue_roster_invitation(v_entry.id, v_email, p_valid_for);
end;
$$;

comment on function app.reissue_roster_invitation(uuid, interval) is 'A roster manager sends a roster entry''s invitation again: revokes the pending one and records a fresh one to the same address, with one email queued. Refuses invitation_closed once the entry is claimed, withdrawn or declined. Returns the new invitation id.';

-- Answering ------------------------------------------------------------------------------------------------------------------------

create or replace function app.my_pending_invitations()
returns table (
  invitation_kind text,
  invitation_id uuid,
  account_name text,
  org_name text,
  project_name text,
  party_name text,
  job_title text,
  account_role app.account_role,
  inviter_name text,
  expires_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  with me as (select private.my_confirmed_email() as email)
  select 'account', i.id, o.name, null::text, null::text, null::text, null::text, i.account_role, ip.full_name, i.expires_at
  from app.account_invitations i
  join me on me.email = i.email
  join app.organizations o on o.id = i.org_id
  join app.people ip on ip.id = i.invited_by
  where i.deleted_at is null and i.accepted_at is null and i.declined_at is null and i.revoked_at is null and i.expires_at > now()
  union all
  select 'roster', i.id, a.name, o.name, p.name, coalesce(a.name, ep.full_name), xr.job_title, null::app.account_role,
    ip.full_name, i.expires_at
  from app.roster_invitations i
  join me on me.email = i.email
  join app.engagement_roster_entries r on r.id = i.roster_entry_id and r.deleted_at is null and r.entry_state <> 'Withdrawn'
  join app.engagements e on e.id = r.engagement_id and e.deleted_at is null
  join app.organizations o on o.id = e.org_id
  join app.projects p on p.id = e.project_id
  join app.people ip on ip.id = i.invited_by
  left join app.counterparties c on c.id = e.counterparty_id
  left join app.organizations a on a.id = c.organization_id
  left join app.people ep on ep.id = e.person_id
  left join xpms.role xr on xr.role_code = r.role_code
  where i.deleted_at is null and i.claimed_at is null and i.declined_at is null and i.revoked_at is null and i.expires_at > now()
  order by 10, 2;
$$;

comment on function app.my_pending_invitations() is 'The signed-in person''s pending, unexpired account and roster invitations, matched by their confirmed email (lowercased; empty until the email is confirmed): the account, the producing org, project, party and role for a roster, the role offered for an account, who invited and when it lapses.';

create or replace function app.respond_party_invitation(p_invitation_kind text, p_invitation_id uuid, p_accept boolean)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_person();
  v_email text := private.my_confirmed_email();
  v_account app.account_invitations;
  v_roster app.roster_invitations;
  v_entry app.engagement_roster_entries;
  v_engagement app.engagements;
  v_counterparty_account uuid;
  v_membership uuid;
begin
  if p_invitation_kind = 'account' then
    select * into v_account from app.account_invitations i where i.id = p_invitation_id and i.deleted_at is null for update;
    if v_account.id is null or v_email is null or v_account.email <> v_email then
      perform private.refuse('invitation_not_yours', 'This invitation was sent to another address. Sign in with the address it was sent to.');
    end if;
    if v_account.accepted_at is not null or v_account.declined_at is not null or v_account.revoked_at is not null
       or v_account.expires_at <= now() then
      perform private.refuse('invitation_closed', 'This invitation was answered, revoked or has expired.');
    end if;
    if not p_accept then
      update app.account_invitations set declined_at = now() where id = v_account.id;
      return null;
    end if;
    v_membership := private.ensure_accepted_membership(v_account.org_id, v_me, v_account.account_role, v_account.invited_by);
    update app.account_invitations set accepted_at = now(), accepted_person_id = v_me where id = v_account.id;
    return v_membership;
  elsif p_invitation_kind = 'roster' then
    select * into v_roster from app.roster_invitations i where i.id = p_invitation_id and i.deleted_at is null for update;
    if v_roster.id is null or v_email is null or v_roster.email <> v_email then
      perform private.refuse('invitation_not_yours', 'This invitation was sent to another address. Sign in with the address it was sent to.');
    end if;
    select * into v_entry from app.engagement_roster_entries r where r.id = v_roster.roster_entry_id and r.deleted_at is null for update;
    if v_roster.claimed_at is not null or v_roster.declined_at is not null or v_roster.revoked_at is not null
       or v_roster.expires_at <= now() or v_entry.id is null or v_entry.entry_state = 'Withdrawn' or v_entry.person_id is not null then
      perform private.refuse('invitation_closed', 'This invitation was answered, revoked or has expired.');
    end if;
    if not p_accept then
      update app.roster_invitations set declined_at = now() where id = v_roster.id;
      if v_entry.entry_state = 'Draft' then
        perform private.transition_lifecycle('roster_entry', 'app.engagement_roster_entries', 'entry_state',
          'app.roster_entry_state_transitions', 'roster_entry_id', v_entry.id, 'Draft', 'Withdrawn', 'Invitation declined.');
      end if;
      return v_entry.id;
    end if;
    select * into v_engagement from app.engagements e where e.id = v_entry.engagement_id and e.deleted_at is null;
    if v_engagement.person_id = v_me then
      perform private.refuse('roster_person_is_engaged', 'You are on this engagement''s roster through your own entry.');
    end if;
    select c.organization_id into v_counterparty_account from app.counterparties c where c.id = v_engagement.counterparty_id;
    if v_counterparty_account is not null then
      perform private.ensure_accepted_membership(v_counterparty_account, v_me, 'Account Member', v_roster.invited_by);
    end if;
    perform private.begin_trusted_operation('roster_invitation_claim');
    begin
      update app.engagement_roster_entries set person_id = v_me, person_response = 'Accepted', responded_at = now()
      where id = v_entry.id;
    exception when unique_violation then
      perform private.refuse('roster_person_duplicate', 'You are already on this engagement''s roster.');
    end;
    perform private.end_trusted_operation('roster_invitation_claim');
    update app.roster_invitations set claimed_at = now(), claimed_person_id = v_me where id = v_roster.id;
    perform private.sync_account_roster_consent(v_counterparty_account, v_me);
    return v_entry.id;
  end if;
  perform private.refuse('invitation_kind', 'An invitation is an account or a roster invitation.');
  return null;
end;
$$;

comment on function app.respond_party_invitation(text, uuid, boolean) is 'The invitee, signed in with the confirmed address an invitation was sent to, accepts or declines it while it is pending and unexpired (invitation_not_yours, invitation_closed). Account: accepting confirms their membership with the offered role, creating it when needed, and returns the membership id. Roster: accepting claims the entry for them and accepts it, and on a company engagement also confirms them as an Account Member of the account (refusing roster_person_duplicate and roster_person_is_engaged); declining withdraws the Draft entry. Returns the entry id.';

create or replace function private.ensure_accepted_membership(p_account_id uuid, p_person_id uuid, p_role app.account_role, p_granted_by uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_membership uuid;
begin
  select m.id into v_membership from app.account_memberships m
  where m.org_id = p_account_id and m.person_id = p_person_id and m.deleted_at is null
    and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now());
  if v_membership is null then
    insert into app.account_memberships (org_id, person_id, accepted_at) values (p_account_id, p_person_id, now())
    returning id into v_membership;
  else
    update app.account_memberships set accepted_at = now() where id = v_membership and accepted_at is null;
  end if;
  if not exists (select 1 from app.account_membership_roles r
                 where r.account_membership_id = v_membership and r.account_role = p_role and r.deleted_at is null) then
    insert into app.account_membership_roles (account_membership_id, account_role, granted_by)
    values (v_membership, p_role, p_granted_by);
  end if;
  return v_membership;
end;
$$;

comment on function private.ensure_accepted_membership(uuid, uuid, app.account_role, uuid) is 'An invitee''s accepted membership in an account with the role: confirms their active membership, or creates one confirmed now, and grants the role when they do not hold it (granted by the inviter). Returns the membership id.';
revoke all on function private.ensure_accepted_membership(uuid, uuid, app.account_role, uuid) from public, anon, authenticated;

-- Privileges -------------------------------------------------------------------------------------------------------------------------

revoke all on function app.invite_to_roster(uuid, text, text, timestamptz, timestamptz, text, interval) from public, anon;
revoke all on function app.reissue_roster_invitation(uuid, interval) from public, anon;
revoke all on function app.my_pending_invitations() from public, anon;
revoke all on function app.respond_party_invitation(text, uuid, boolean) from public, anon;
grant execute on function app.invite_to_roster(uuid, text, text, timestamptz, timestamptz, text, interval) to authenticated, service_role;
grant execute on function app.reissue_roster_invitation(uuid, interval) to authenticated, service_role;
grant execute on function app.my_pending_invitations() to authenticated, service_role;
grant execute on function app.respond_party_invitation(text, uuid, boolean) to authenticated, service_role;

select private.sync_trash_tables();
