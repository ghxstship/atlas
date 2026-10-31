-- 2731_token_guests_and_roster.sql
-- R10 Token advance parity (RRR-191; owner decisions 0/1, 6 and 8), second part. The holder of an advance link is the
-- party's representative: through the link they ask for guests and build the crew roster, as a signed-in roster
-- manager does. The people they invite still accept their own entry and enter their own facts (decisions 0/1 and 6).
--
--   1. api_public.request_advance_guest: a guest on a Guest List section of a recipient with an engagement that is
--      Active or Closing (guest_list_closed otherwise), within R9's offering and cap (private.assert_guest_capacity),
--      inserted as app.request_engaged_guest does (0965, 2715) under its trusted operation; 50 per link per day
--      (advance_guest_rate).
--   2. app.roster_invitations.advance_recipient_token_id: an invitation sent through an advance link, which then has no
--      invited_by (exactly one of the two, roster_invitations_one_inviter). private.issue_roster_invitation (from 2636)
--      takes the token and records it; app.my_pending_invitations (from 2636) names the party as the inviter of such
--      an invitation.
--   3. private.roster_entry_creator (from 2635) answers created_by, else the person who claimed the link an
--      invitation came through, so after the claim the claimer does not review the entries they invited
--      (sod_roster_reviewer). Nothing is stamped at claim.
--   4. private.submit_roster_entries: the body of app.submit_roster (from 2656, names lock included), which
--      app.submit_roster now calls after its own checks, as the token RPC does.
--   5. On a Crew Roster section of a recipient with a rosterable engagement whose roster area is open (R4,
--      roster_closed and roster_role_type otherwise): api_public.advance_roster lists the roster with each person's
--      name once they accept and the invited address masked before; api_public.invite_advance_roster_member invites
--      an address onto a Draft entry through R4's private.insert_roster_entry and private.issue_roster_invitation,
--      50 per link per day (advance_roster_rate); api_public.submit_advance_roster submits it.
-- Every new api_public function is volatile and security definer, starts with private.resolve_advance_token, answers
-- refusals as rows (REFUSE and the rule) and is granted to anon, authenticated and service_role.

-- 1. Guests through the link ------------------------------------------------------------------------------------------------

create or replace function api_public.request_advance_guest(
  p_token text,
  p_access_code text,
  p_section_id uuid,
  p_guest_name text,
  p_plus_ones integer,
  p_note text
)
returns table (guest_entry_id uuid, refusal text, reason text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_token_id uuid;
  v_reason text;
  v_recipient app.advance_recipients;
  v_engagement app.engagements;
  v_name text := btrim(coalesce(p_guest_name, ''));
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_plus integer := coalesce(p_plus_ones, 0);
  v_id uuid;
begin
  select r.token_id, r.reason into v_token_id, v_reason from private.resolve_advance_token(p_token, p_access_code) r;
  if v_reason is not null then
    return query select null::uuid, 'REFUSE'::text, v_reason;
    return;
  end if;
  select r.* into v_recipient from app.advance_recipient_tokens t join app.advance_recipients r on r.id = t.advance_recipient_id
  where t.id = v_token_id;
  if not exists (select 1 from app.advance_sections s
                 where s.id = p_section_id and s.deleted_at is null and s.advance_packet_id = v_recipient.advance_packet_id
                   and s.section_kind = 'Guest List') then
    return query select null::uuid, 'REFUSE'::text, 'advance_section_open'::text;
    return;
  end if;
  select e.* into v_engagement from app.engagements e where e.id = v_recipient.engagement_id and e.deleted_at is null;
  if v_engagement.id is null then
    return query select null::uuid, 'REFUSE'::text, 'advance_recipient_engagement'::text;
    return;
  end if;
  if v_engagement.role_type in ('Contractor', 'Sponsor') then
    return query select null::uuid, 'REFUSE'::text, 'advance_section_role'::text;
    return;
  end if;
  if v_engagement.engagement_state not in ('Active', 'Closing') then
    return query select null::uuid, 'REFUSE'::text, 'guest_list_closed'::text;
    return;
  end if;
  if char_length(v_name) not between 1 and 200 then
    return query select null::uuid, 'REFUSE'::text, 'guest_name_length'::text;
    return;
  end if;
  if v_plus not between 0 and 20 then
    return query select null::uuid, 'REFUSE'::text, 'guest_plus_ones'::text;
    return;
  end if;
  if char_length(coalesce(v_note, '')) > 500 then
    return query select null::uuid, 'REFUSE'::text, 'guest_note_length'::text;
    return;
  end if;
  if private.rate_limit_exceeded('advance_token_guest', v_token_id::text, 50, interval '1 day') then
    return query select null::uuid, 'REFUSE'::text, 'advance_guest_rate'::text;
    return;
  end if;
  begin
    perform private.assert_guest_capacity(v_engagement.id, v_plus);
    perform private.begin_trusted_operation('request_engaged_guest');
    insert into app.guest_list_entries (project_id, person_id, counterparty_id, engagement_id, guest_name, plus_ones, note)
    values (v_engagement.project_id, v_engagement.person_id,
            case when v_engagement.person_id is null then v_engagement.counterparty_id end,
            v_engagement.id, v_name, v_plus, v_note)
    returning id into v_id;
    perform private.end_trusted_operation('request_engaged_guest');
  exception when sqlstate 'XR001' then
    get stacked diagnostics v_reason = pg_exception_hint;
    return query select null::uuid, 'REFUSE'::text, v_reason;
    return;
  end;
  perform private.note_rate_event('advance_token_guest', v_token_id::text);
  return query select v_id, null::text, null::text;
end;
$$;
comment on function api_public.request_advance_guest(text, text, uuid, text, integer, text) is 'Gateway advance form without an account (R10): with a valid token and access code, asks for a guest (Requested) on a Guest List section of the recipient''s packet, for the recipient''s engagement, as app.request_engaged_guest does signed in; the production approves or declines in Atlas. Refusals come back as REFUSE with a reason: the token reasons of preview_advance; advance_section_open (not a Guest List of the packet); advance_recipient_engagement (no engagement); advance_section_role (a contractor or sponsor); guest_list_closed (the engagement is not Active or Closing); guest_name_length, guest_plus_ones, guest_note_length; offering_not_offered and guest_list_cap (private.assert_guest_capacity); advance_guest_rate (50 per link per day). Returns the guest entry id.';
revoke all on function api_public.request_advance_guest(text, text, uuid, text, integer, text) from public;
grant execute on function api_public.request_advance_guest(text, text, uuid, text, integer, text) to anon, authenticated, service_role;

-- 2. Invitations through the link ---------------------------------------------------------------------------------------------

alter table app.roster_invitations
  add column advance_recipient_token_id uuid references app.advance_recipient_tokens (id),
  alter column invited_by drop not null,
  add constraint roster_invitations_one_inviter check (num_nonnulls(invited_by, advance_recipient_token_id) = 1);
create index roster_invitations_advance_recipient_token_id_idx on app.roster_invitations (advance_recipient_token_id);
comment on column app.roster_invitations.invited_by is 'Roster manager who invited; NULL for an invitation sent through an advance link (advance_recipient_token_id).';
comment on column app.roster_invitations.advance_recipient_token_id is 'Advance link the invitation was sent through (R10), when the party''s representative invited without an account; exactly one of this and invited_by is set. The person who claims the link counts as the inviter for the reviewer separation rule.';

drop function private.issue_roster_invitation(uuid, text, interval);

create function private.issue_roster_invitation(p_roster_entry_id uuid, p_email text, p_valid_for interval, p_token_id uuid default null)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := case when p_token_id is null then private.current_person_id() end;
  v_id uuid;
begin
  perform private.assert_invitation_validity(p_valid_for);
  update app.roster_invitations set revoked_at = now()
  where roster_entry_id = p_roster_entry_id and claimed_at is null and declined_at is null and revoked_at is null and deleted_at is null;
  insert into app.roster_invitations (roster_entry_id, email, invited_by, advance_recipient_token_id, expires_at)
  values (p_roster_entry_id, p_email, v_me, p_token_id, now() + p_valid_for)
  returning id into v_id;
  perform private.queue_party_invitation_email('roster', p_email, (
    select jsonb_build_object(
      'org_name', o.name,
      'project_name', p.name,
      'party_name', coalesce(a.name, ep.full_name),
      'job_title', xr.job_title,
      -- Through an advance link nobody signed in invites: the party does.
      'inviter_name', coalesce((select ip.full_name from app.people ip where ip.id = v_me), a.name, ep.full_name),
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

comment on function private.issue_roster_invitation(uuid, text, interval, uuid) is 'Revokes the entry''s pending invitation, records a new one open for p_valid_for (1 hour to 30 days) and queues one email to the address. With p_token_id the invitation is sent through that advance link (R10): it records the link instead of a person, and the email names the party as the inviter. Callers authorize first.';
revoke all on function private.issue_roster_invitation(uuid, text, interval, uuid) from public, anon, authenticated;

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
    coalesce(ip.full_name, a.name, ep.full_name), i.expires_at
  from app.roster_invitations i
  join me on me.email = i.email
  join app.engagement_roster_entries r on r.id = i.roster_entry_id and r.deleted_at is null and r.entry_state <> 'Withdrawn'
  join app.engagements e on e.id = r.engagement_id and e.deleted_at is null
  join app.organizations o on o.id = e.org_id
  join app.projects p on p.id = e.project_id
  left join app.people ip on ip.id = i.invited_by
  left join app.counterparties c on c.id = e.counterparty_id
  left join app.organizations a on a.id = c.organization_id
  left join app.people ep on ep.id = e.person_id
  left join xpms.role xr on xr.role_code = r.role_code
  where i.deleted_at is null and i.claimed_at is null and i.declined_at is null and i.revoked_at is null and i.expires_at > now()
  order by 10, 2;
$$;

comment on function app.my_pending_invitations() is 'The signed-in person''s pending, unexpired account and roster invitations, matched by their confirmed email (lowercased; empty until the email is confirmed): the account, the producing org, project, party and role for a roster, the role offered for an account, who invited (the party for a roster invitation sent through an advance link, R10) and when it lapses.';
revoke all on function app.my_pending_invitations() from public, anon;
grant execute on function app.my_pending_invitations() to authenticated, service_role;

-- 3. The creator of a token-invited entry, from 2635 ---------------------------------------------------------------------------

create or replace function private.roster_entry_creator(p_roster_entry_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(r.created_by, (
    select t.claimed_by
    from app.roster_invitations i
    join app.advance_recipient_tokens t on t.id = i.advance_recipient_token_id
    where i.roster_entry_id = r.id
    order by i.created_at, i.id limit 1))
  from app.engagement_roster_entries r where r.id = p_roster_entry_id;
$$;

comment on function private.roster_entry_creator(uuid) is 'Who created a roster entry, for the reviewer separation rule (sod_roster_reviewer): its created_by, else, for an entry invited through an advance link (R10), the person who claimed that link; NULL until it is claimed. Nothing is stamped at claim.';
revoke all on function private.roster_entry_creator(uuid) from public, anon, authenticated;

-- 4. One submit, from 2656 -------------------------------------------------------------------------------------------------------

create or replace function private.submit_roster_entries(p_engagement_id uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_entry app.engagement_roster_entries;
  v_count integer := 0;
  v_locked boolean := private.roster_locked(p_engagement_id);
  v_drafts_held integer := 0;
begin
  for v_entry in
    select * from app.engagement_roster_entries r
    where r.engagement_id = p_engagement_id and r.deleted_at is null and not r.is_self and r.person_id is not null
      and r.entry_state in ('Draft', 'Returned')
    order by r.created_at, r.id
    for update
  loop
    -- Under a names lock a Draft stays a Draft; a Returned entry is still resubmitted.
    if v_locked and v_entry.entry_state = 'Draft' then
      v_drafts_held := v_drafts_held + 1;
      continue;
    end if;
    perform private.transition_lifecycle('roster_entry', 'app.engagement_roster_entries', 'entry_state',
      'app.roster_entry_state_transitions', 'roster_entry_id', v_entry.id, v_entry.entry_state::text, 'Submitted', 'Submitted.');
    v_count := v_count + 1;
  end loop;
  if v_count = 0 and v_drafts_held > 0 then
    perform private.refuse('roster_locked', 'Names are locked on this engagement. Ask the producing organization to change the roster.');
  end if;
  if v_count = 0 then
    perform private.refuse('roster_empty_submit', 'Add or change someone on the roster before submitting it.');
  end if;
  return v_count;
end;
$$;

comment on function private.submit_roster_entries(uuid) is 'The roster submit of an engagement (R4, from 2656), after the caller authorized: every non-self Draft or Returned entry naming a person moves to Submitted (an unclaimed invitation stays Draft). Under a names lock (R5) only Returned entries move; it refuses roster_locked when nothing Returned is left and a Draft was held back, and roster_empty_submit when there is nothing to submit. app.submit_roster and api_public.submit_advance_roster (R10) call it. Returns how many were submitted.';
revoke all on function private.submit_roster_entries(uuid) from public, anon, authenticated;

create or replace function app.submit_roster(p_engagement_id uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_engagement app.engagements;
begin
  perform private.require_person();
  select * into v_engagement from app.engagements e where e.id = p_engagement_id and e.deleted_at is null;
  perform private.assert_roster_manager(v_engagement);
  return private.submit_roster_entries(v_engagement.id);
end;
$$;

comment on function app.submit_roster(uuid) is 'A roster manager submits the roster: every non-self Draft or Returned entry naming a person moves to Submitted for the producing org to review (an unclaimed invitation stays Draft). Under a names lock (R5) only Returned entries move and Drafts stay; it refuses roster_locked when nothing Returned is left and a Draft was held back, and roster_empty_submit when there is nothing to submit. The submit itself is private.submit_roster_entries (R10). Returns how many were submitted.';
revoke all on function app.submit_roster(uuid) from public, anon;
grant execute on function app.submit_roster(uuid) to authenticated, service_role;

-- 5. The crew roster through the link ---------------------------------------------------------------------------------------------

-- The engagement of a token's Crew Roster section, or the refusal: the section is the packet's Crew Roster, the recipient
-- has a rosterable engagement, and its state opens the roster area (R4, 2632).
create or replace function private.advance_token_roster(p_token_id uuid, p_section_id uuid)
returns table (engagement_id uuid, reason text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_recipient app.advance_recipients;
  v_engagement app.engagements;
  v_closed timestamptz;
begin
  select r.* into v_recipient from app.advance_recipient_tokens t join app.advance_recipients r on r.id = t.advance_recipient_id
  where t.id = p_token_id;
  if not exists (select 1 from app.advance_sections s
                 where s.id = p_section_id and s.deleted_at is null and s.advance_packet_id = v_recipient.advance_packet_id
                   and s.section_kind = 'Crew Roster') then
    return query select null::uuid, 'advance_section_open'::text;
    return;
  end if;
  select e.* into v_engagement from app.engagements e where e.id = v_recipient.engagement_id and e.deleted_at is null;
  if v_engagement.id is null then
    return query select null::uuid, 'advance_recipient_engagement'::text;
    return;
  end if;
  if not private.engagement_rosterable(v_engagement.role_type, v_engagement.counterparty_id) then
    return query select null::uuid, 'roster_role_type'::text;
    return;
  end if;
  if v_engagement.engagement_state in ('Complete', 'Canceled') then
    v_closed := private.engagement_closed_at(v_engagement.id);
  end if;
  if not ('roster' = any (private.engagement_state_areas(v_engagement.engagement_state, v_closed))) then
    return query select null::uuid, 'roster_closed'::text;
    return;
  end if;
  return query select v_engagement.id, null::text;
end;
$$;

comment on function private.advance_token_roster(uuid, uuid) is 'R10: the engagement whose roster an advance link manages through a section, or why not: advance_section_open (not a Crew Roster section of the packet), advance_recipient_engagement (no engagement), roster_role_type (the engagement carries no roster) or roster_closed (its state opens no roster area).';
revoke all on function private.advance_token_roster(uuid, uuid) from public, anon, authenticated;

create or replace function api_public.advance_roster(p_token text, p_access_code text, p_section_id uuid)
returns table (
  refusal text,
  reason text,
  roster_entry_id uuid,
  display_name text,
  role_code text,
  entry_state app.roster_entry_state,
  invitation_state text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_token_id uuid;
  v_reason text;
  v_engagement uuid;
begin
  select r.token_id, r.reason into v_token_id, v_reason from private.resolve_advance_token(p_token, p_access_code) r;
  if v_reason is null then
    select x.engagement_id, x.reason into v_engagement, v_reason from private.advance_token_roster(v_token_id, p_section_id) x;
  end if;
  if v_reason is not null then
    return query select 'REFUSE'::text, v_reason, null::uuid, null::text, null::text, null::app.roster_entry_state, null::text;
    return;
  end if;
  return query
    select null::text, null::text, r.id, private.advance_roster_display_name(r.id), r.role_code, r.entry_state,
      case
        when i.id is null then null
        when i.claimed_at is not null then 'Accepted'
        when i.declined_at is not null then 'Declined'
        when i.revoked_at is not null then 'Revoked'
        when i.expires_at <= now() then 'Expired'
        else 'Pending'
      end
    from app.engagement_roster_entries r
    left join lateral (
      select iv.* from app.roster_invitations iv
      where iv.roster_entry_id = r.id and iv.deleted_at is null
      order by iv.created_at desc, iv.id desc limit 1
    ) i on true
    where r.engagement_id = v_engagement and r.deleted_at is null
    order by r.is_self desc, r.created_at, r.id;
end;
$$;

comment on function api_public.advance_roster(text, text, uuid) is 'Gateway advance form without an account (R10): with a valid token and access code, the crew roster of the recipient''s engagement behind a Crew Roster section, one row per live entry: its display name (the person''s name once they accepted, else the invited address masked as its first letter, *** and the domain), role code, entry state and the state of its latest invitation (Pending, Accepted, Declined, Revoked or Expired; NULL without one). Otherwise one row with refusal REFUSE and the reason: the token reasons of preview_advance, or those of private.advance_token_roster.';
revoke all on function api_public.advance_roster(text, text, uuid) from public;
grant execute on function api_public.advance_roster(text, text, uuid) to anon, authenticated, service_role;

create or replace function api_public.invite_advance_roster_member(
  p_token text,
  p_access_code text,
  p_section_id uuid,
  p_email text,
  p_role_code text,
  p_arrival_starts_at timestamptz,
  p_arrival_ends_at timestamptz,
  p_arrival_zone text
)
returns table (roster_entry_id uuid, refusal text, reason text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_token_id uuid;
  v_reason text;
  v_engagement uuid;
  v_email text;
  v_window tstzrange;
  v_entry uuid;
begin
  select r.token_id, r.reason into v_token_id, v_reason from private.resolve_advance_token(p_token, p_access_code) r;
  if v_reason is null then
    select x.engagement_id, x.reason into v_engagement, v_reason from private.advance_token_roster(v_token_id, p_section_id) x;
  end if;
  if v_reason is null and private.rate_limit_exceeded('advance_token_roster', v_token_id::text, 50, interval '1 day') then
    v_reason := 'advance_roster_rate';
  end if;
  if v_reason is not null then
    return query select null::uuid, 'REFUSE'::text, v_reason;
    return;
  end if;
  begin
    v_email := private.normalized_invitation_email(p_email);
    if exists (
      select 1 from app.roster_invitations i join app.engagement_roster_entries r on r.id = i.roster_entry_id
      where r.engagement_id = v_engagement and r.deleted_at is null and r.entry_state <> 'Withdrawn' and i.email = v_email
        and i.claimed_at is null and i.declined_at is null and i.revoked_at is null and i.deleted_at is null) then
      perform private.refuse('roster_person_duplicate', 'This address is already invited onto the engagement''s roster.');
    end if;
    v_window := private.roster_arrival(p_arrival_starts_at, p_arrival_ends_at, p_arrival_zone);
    perform private.begin_trusted_operation('invite_advance_roster_member');
    v_entry := private.insert_roster_entry(v_engagement, null, nullif(btrim(coalesce(p_role_code, '')), ''), v_window,
      p_arrival_zone, null, false);
    perform private.issue_roster_invitation(v_entry, v_email, interval '14 days', v_token_id);
    perform private.end_trusted_operation('invite_advance_roster_member');
  exception when sqlstate 'XR001' then
    get stacked diagnostics v_reason = pg_exception_hint;
    return query select null::uuid, 'REFUSE'::text, v_reason;
    return;
  end;
  perform private.note_rate_event('advance_token_roster', v_token_id::text);
  return query select v_entry, null::text, null::text;
end;
$$;

comment on function api_public.invite_advance_roster_member(text, text, uuid, text, text, timestamptz, timestamptz, text) is 'Gateway advance form without an account (R10): with a valid token and access code, the party''s representative invites an email address onto the roster behind a Crew Roster section, as app.invite_to_roster does signed in: a Draft entry through private.insert_roster_entry (the role and names lock rules hold) and one invitation open for 14 days, sent through the link, with one email queued. The invitee accepts the entry themselves after signing in with that address (owner decision 6). Refusals come back as REFUSE with a reason: the token reasons of preview_advance, those of private.advance_token_roster, advance_roster_rate (50 per link per day), invitation_email, roster_person_duplicate, roster_arrival_window, roster_role_unknown, time_zone_unknown or roster_locked. Returns the entry id.';
revoke all on function api_public.invite_advance_roster_member(text, text, uuid, text, text, timestamptz, timestamptz, text) from public;
grant execute on function api_public.invite_advance_roster_member(text, text, uuid, text, text, timestamptz, timestamptz, text) to anon, authenticated, service_role;

create or replace function api_public.submit_advance_roster(p_token text, p_access_code text, p_section_id uuid)
returns table (submitted integer, refusal text, reason text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_token_id uuid;
  v_reason text;
  v_engagement uuid;
  v_count integer;
begin
  select r.token_id, r.reason into v_token_id, v_reason from private.resolve_advance_token(p_token, p_access_code) r;
  if v_reason is null then
    select x.engagement_id, x.reason into v_engagement, v_reason from private.advance_token_roster(v_token_id, p_section_id) x;
  end if;
  if v_reason is not null then
    return query select null::integer, 'REFUSE'::text, v_reason;
    return;
  end if;
  begin
    v_count := private.submit_roster_entries(v_engagement);
  exception when sqlstate 'XR001' then
    get stacked diagnostics v_reason = pg_exception_hint;
    return query select null::integer, 'REFUSE'::text, v_reason;
    return;
  end;
  return query select v_count, null::text, null::text;
end;
$$;

comment on function api_public.submit_advance_roster(text, text, uuid) is 'Gateway advance form without an account (R10): with a valid token and access code, submits the roster behind a Crew Roster section through private.submit_roster_entries, as app.submit_roster does signed in: entries whose person accepted their invitation move to Submitted, unclaimed invitations stay Draft. Refusals come back as REFUSE with a reason: the token reasons of preview_advance, those of private.advance_token_roster, roster_locked or roster_empty_submit. Returns how many were submitted.';
revoke all on function api_public.submit_advance_roster(text, text, uuid) from public;
grant execute on function api_public.submit_advance_roster(text, text, uuid) to anon, authenticated, service_role;
