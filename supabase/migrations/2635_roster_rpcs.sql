-- 2635_roster_rpcs.sql
-- R4 Crew roster core (RRR-182, ADR 0101 decisions 4, 7 and 8; owner decisions 0/1 and 4). Who manages a roster, who
-- may be put on it, and the RPCs that build, submit, review and answer it. Every RPC is security definer with
-- search_path '', starts with private.require_person(), and is granted to authenticated and service_role only.
--
-- Helpers, each with one owner (ADR 0101 decision 4):
--   * private.can_advance_engagement(engagement): the engagement is live and its roster area is open to the caller as
--     the engaged person of an Artist engagement or of one no account supplies, an Account Owner or Admin of the
--     supplying account, a live Advancing Lead or an Advance representative (2632). The worker a company sends is on
--     its roster and manages nothing. private.can_manage_roster adds that the engagement is rosterable. R5 and R8 use
--     both.
--   * private.roster_manager_ids(engagement): the people who manage it, for notifications.
--   * private.roster_talent_eligible(engagement, person): a confirmed, active member of the supplying account, or an
--     artist the caller represents with the Advance scope (the talent pool of ADR 0101 decision 6).
--   * private.my_roster_entry_ids(area): the caller's live entries for 'roster' (Onboarding to Closing), 'onboarding'
--     (Onboarding to Closing, accepted by the person) and 'operational' (Active or Closing, accepted by both sides).
--     R7 and R8 read it.
--   * private.insert_roster_entry: the one internal creator, used by add_roster_entry, invite_to_roster (2636), R10 and
--     R12. private.roster_entry_creator(entry) is created_by, read by the reviewer separation rule; R10 extends it with
--     the token claimer.
-- Consent (owner decision 4, review correction): when the person accepts a roster entry of a company engagement, an
-- account_roster_sharing consent is recorded for the company account; it lets the company read their profile through
-- app.roster_shared_work_details (2638). A decline, a withdrawal or the entry leaving withdraws it once no other accepted
-- entry of the person on that account's engagements stands.

insert into private.consent_purposes (code, lawful_basis, sort_order) values ('account_roster_sharing', 'consent', 80);

insert into private.separation_of_duties_rules (code, enforced_on, description) values
  ('sod_roster_reviewer', 'Crew roster entries', 'The person who added or submitted a roster entry cannot accept or return it.')
on conflict (code) do nothing;

-- Helpers ------------------------------------------------------------------------------------------------------------------

create or replace function private.roster_entry_person_id(p_is_self boolean, p_entry_person uuid, p_engagement_person uuid)
returns uuid
language sql
immutable
set search_path = ''
as $$
  select case when p_is_self then p_engagement_person else p_entry_person end;
$$;

comment on function private.roster_entry_person_id(boolean, uuid, uuid) is 'The person a roster entry resolves to, from column values: the engagement''s person for the self entry, the entry''s own otherwise.';
revoke all on function private.roster_entry_person_id(boolean, uuid, uuid) from public, anon;
grant execute on function private.roster_entry_person_id(boolean, uuid, uuid) to authenticated, service_role;

create or replace function private.can_advance_engagement(p_engagement_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select 'roster' in (select private.engagement_scope(p_engagement_id));
$$;

comment on function private.can_advance_engagement(uuid) is 'ADR 0101 (R4): true when the engagement is live and its roster area is open to the signed-in person as the engaged person of an Artist engagement or of one no account supplies, an Account Owner or Admin of the supplying account, a live Advancing Lead assigned to it or the artist''s Advance representative; never as the worker a company sends (2632). R5 and R8 use it.';

create or replace function private.can_manage_roster(p_engagement_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.can_advance_engagement(p_engagement_id) and exists (
    select 1 from app.engagements e
    where e.id = p_engagement_id and e.deleted_at is null and private.engagement_rosterable(e.role_type, e.counterparty_id));
$$;

comment on function private.can_manage_roster(uuid) is 'ADR 0101 (R4): true when the signed-in person may add, invite, submit, withdraw and replace roster entries of the engagement: private.can_advance_engagement and the engagement is rosterable.';

create or replace function private.roster_relationship(p_engagement app.engagements)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.engagement_rosterable(p_engagement.role_type, p_engagement.counterparty_id)
    and 'roster' = any (private.engagement_party_areas(p_engagement.id, p_engagement.person_id, p_engagement.counterparty_id,
      p_engagement.role_type));
$$;

comment on function private.roster_relationship(app.engagements) is 'True when the signed-in person''s relationship to a rosterable engagement opens its roster, whatever its state; the RPCs refuse roster_closed separately when the state does not.';
revoke all on function private.roster_relationship(app.engagements) from public, anon, authenticated;

create or replace function private.assert_roster_manager(p_engagement app.engagements)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_closed timestamptz;
begin
  if p_engagement.id is null or not ('roster' = any (private.engagement_party_areas(p_engagement.id, p_engagement.person_id,
      p_engagement.counterparty_id, p_engagement.role_type))) then
    raise exception using errcode = '42501', message = 'only the people who manage this engagement''s roster may change it';
  end if;
  if not private.engagement_rosterable(p_engagement.role_type, p_engagement.counterparty_id) then
    perform private.refuse('roster_role_type', 'Only artist engagements and the company engagements of a vendor, contractor, staffing company or sponsor carry a roster.');
  end if;
  if p_engagement.engagement_state in ('Complete', 'Canceled') then
    v_closed := private.engagement_closed_at(p_engagement.id);
  end if;
  if not ('roster' = any (private.engagement_state_areas(p_engagement.engagement_state, v_closed))) then
    perform private.refuse('roster_closed', 'This engagement is complete or canceled, so its roster is closed.');
  end if;
end;
$$;

comment on function private.assert_roster_manager(app.engagements) is 'Raises insufficient privilege unless the signed-in person manages the engagement''s roster, and refuses roster_closed when the engagement state opens no roster area.';
revoke all on function private.assert_roster_manager(app.engagements) from public, anon, authenticated;

create or replace function private.roster_manager_ids(p_engagement_id uuid)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select e.person_id from app.engagements e
  where e.id = p_engagement_id and e.deleted_at is null and e.role_type = 'Artist' and e.person_id is not null
  union
  select m.person_id from app.engagements e
  join app.counterparties c on c.id = e.counterparty_id
  join app.account_memberships m on m.org_id = c.organization_id and m.deleted_at is null
    and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
  join app.account_membership_roles r on r.account_membership_id = m.id and r.deleted_at is null
    and r.account_role in ('Account Owner', 'Account Admin')
  where e.id = p_engagement_id and e.deleted_at is null and private.engagement_rosterable(e.role_type, e.counterparty_id)
  union
  select m.person_id from app.account_engagement_assignments a
  join app.account_memberships m on m.id = a.account_membership_id and m.deleted_at is null and m.accepted_at is not null
    and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
  join app.engagements e on e.id = a.engagement_id and e.deleted_at is null
  where a.engagement_id = p_engagement_id and a.deleted_at is null and a.duty = 'Advancing Lead'
    and private.engagement_rosterable(e.role_type, e.counterparty_id)
  union
  select coalesce(rp.representative_person_id, m.person_id)
  from app.engagements e
  join app.representations rp on rp.artist_person_id = e.person_id and rp.deleted_at is null and rp.accepted_at is not null
    and rp.revoked_at is null and rp.expires_on >= current_date
  join app.representation_scopes s on s.representation_id = rp.id and s.deleted_at is null and s.scope = 'Advance'
  left join app.account_memberships m on rp.representative_person_id is null and m.org_id = rp.org_id and m.deleted_at is null
    and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
    and exists (select 1 from app.account_membership_roles r where r.account_membership_id = m.id and r.deleted_at is null
                and r.account_role in ('Account Owner', 'Account Admin'))
  where e.id = p_engagement_id and e.deleted_at is null and e.role_type = 'Artist'
    and coalesce(rp.representative_person_id, m.person_id) is not null;
$$;

comment on function private.roster_manager_ids(uuid) is 'The people who manage an engagement''s roster (ADR 0101): the engaged person of an Artist engagement, the Account Owners and Admins of the account supplying a rosterable engagement, its live Advancing Leads, and the artist''s Advance representatives (the named agent, else the agency''s Owners and Admins). Used to address notifications.';
revoke all on function private.roster_manager_ids(uuid) from public, anon, authenticated;

create or replace function private.roster_talent_eligible(p_engagement_id uuid, p_person_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_person_id is not null and (
    exists (
      select 1 from app.engagements e
      join app.counterparties c on c.id = e.counterparty_id
      join app.account_memberships m on m.org_id = c.organization_id and m.person_id = p_person_id and m.deleted_at is null
        and m.accepted_at is not null and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
      where e.id = p_engagement_id and e.deleted_at is null)
    or private.represents(p_person_id, 'Advance'));
$$;

comment on function private.roster_talent_eligible(uuid, uuid) is 'ADR 0101 decision 6: true when the person may be put on the engagement''s roster: a confirmed, active member of the account that supplies it, or an artist the signed-in person represents with an accepted, unexpired, unrevoked Advance representation.';
revoke all on function private.roster_talent_eligible(uuid, uuid) from public, anon, authenticated;

create or replace function private.my_roster_entry_ids(p_area text)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select r.id
  from app.engagement_roster_entries r
  join app.engagements e on e.id = r.engagement_id and e.deleted_at is null
  where r.deleted_at is null and r.entry_state <> 'Withdrawn'
    and private.roster_entry_person_id(r.is_self, r.person_id, e.person_id) = private.current_person_id()
    and case p_area
      when 'roster' then e.engagement_state in ('Onboarding', 'Blocked', 'Active', 'Closing')
      when 'onboarding' then e.engagement_state in ('Onboarding', 'Blocked', 'Active', 'Closing') and r.person_response = 'Accepted'
      when 'operational' then e.engagement_state in ('Active', 'Closing') and r.entry_state = 'Accepted' and r.person_response = 'Accepted'
      else false
    end;
$$;

comment on function private.my_roster_entry_ids(text) is 'ADR 0101 (R4): the signed-in person''s live roster entries whose engagement opens the area: roster (Onboarding to Closing), onboarding (Onboarding to Closing, accepted by the person) or operational (Active or Closing, accepted by the reviewer and the person). R7 and R8 read it; private.my_engagement_ids never matches a rostered person.';
revoke all on function private.my_roster_entry_ids(text) from public, anon;
grant execute on function private.my_roster_entry_ids(text) to authenticated, service_role;

create or replace function private.roster_entry_creator(p_roster_entry_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select r.created_by from app.engagement_roster_entries r where r.id = p_roster_entry_id;
$$;

comment on function private.roster_entry_creator(uuid) is 'Who created a roster entry, for the reviewer separation rule (sod_roster_reviewer). R10 extends it with the person who claimed a token.';
revoke all on function private.roster_entry_creator(uuid) from public, anon, authenticated;

create or replace function private.roster_arrival(p_starts_at timestamptz, p_ends_at timestamptz, p_time_zone text)
returns tstzrange
language plpgsql
stable
set search_path = ''
as $$
begin
  if p_starts_at is null and p_ends_at is null and p_time_zone is null then
    return null;
  end if;
  if p_starts_at is null or p_ends_at is null or p_ends_at <= p_starts_at or nullif(btrim(coalesce(p_time_zone, '')), '') is null then
    perform private.refuse('roster_arrival_window', 'An arrival window has a start, a later end and a time zone.');
  end if;
  return tstzrange(p_starts_at, p_ends_at, '[)');
end;
$$;

comment on function private.roster_arrival(timestamptz, timestamptz, text) is 'An arrival window from its start, end and time zone: NULL when all three are missing; refuses roster_arrival_window unless the end follows the start and the zone is given.';
revoke all on function private.roster_arrival(timestamptz, timestamptz, text) from public, anon, authenticated;

create or replace function private.assert_roster_role(p_role_code text)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_role_code is not null and not exists (select 1 from xpms.role r where r.role_code = p_role_code) then
    perform private.refuse('roster_role_unknown', 'Choose a role from the Roles Library.');
  end if;
end;
$$;

comment on function private.assert_roster_role(text) is 'Refuses roster_role_unknown for a role code the Roles Library does not hold.';
revoke all on function private.assert_roster_role(text) from public, anon, authenticated;

-- Account consent ------------------------------------------------------------------------------------------------------------

create or replace function private.roster_entry_account(p_roster_entry_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select c.organization_id from app.engagement_roster_entries r
  join app.engagements e on e.id = r.engagement_id
  join app.counterparties c on c.id = e.counterparty_id
  where r.id = p_roster_entry_id;
$$;

comment on function private.roster_entry_account(uuid) is 'The external account that supplies a roster entry''s engagement; NULL for an engagement without a counterparty.';
revoke all on function private.roster_entry_account(uuid) from public, anon, authenticated;

create or replace function private.account_roster_consent(p_account_id uuid, p_person_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select r.id from app.consent_records r
  where r.org_id = p_account_id and r.person_id = p_person_id and r.purpose_code = 'account_roster_sharing'
    and r.withdrawn_at is null and r.deleted_at is null
  order by r.captured_at desc limit 1;
$$;

comment on function private.account_roster_consent(uuid, uuid) is 'The person''s live account_roster_sharing consent for an external account; NULL when none stands.';
revoke all on function private.account_roster_consent(uuid, uuid) from public, anon, authenticated;

create or replace function private.sync_account_roster_consent(p_account_id uuid, p_person_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_accepted boolean;
begin
  if p_account_id is null or p_person_id is null then
    return;
  end if;
  select exists (
    select 1 from app.engagement_roster_entries r
    join app.engagements e on e.id = r.engagement_id and e.deleted_at is null
    join app.counterparties c on c.id = e.counterparty_id and c.organization_id = p_account_id
    where r.deleted_at is null and not r.is_self and r.person_id = p_person_id and r.entry_state <> 'Withdrawn'
      and r.person_response = 'Accepted') into v_accepted;
  if v_accepted and private.account_roster_consent(p_account_id, p_person_id) is null then
    insert into app.consent_records (org_id, person_id, purpose_code, notice_version, source)
    values (p_account_id, p_person_id, 'account_roster_sharing', '1.0.0', 'Web');
  elsif not v_accepted then
    update app.consent_records r set withdrawn_at = now()
    where r.org_id = p_account_id and r.person_id = p_person_id and r.purpose_code = 'account_roster_sharing'
      and r.withdrawn_at is null and r.deleted_at is null;
  end if;
end;
$$;

comment on function private.sync_account_roster_consent(uuid, uuid) is 'Owner decision 4 (R4): records the person''s account_roster_sharing consent for an external account while they have accepted a live roster entry on one of its engagements, and withdraws it once none stands (a decline, a withdrawal or the entry leaving).';
revoke all on function private.sync_account_roster_consent(uuid, uuid) from public, anon, authenticated;

-- The internal creator ---------------------------------------------------------------------------------------------------------

create or replace function private.insert_roster_entry(
  p_engagement_id uuid,
  p_person_id uuid,
  p_role_code text,
  p_arrival_window tstzrange,
  p_arrival_time_zone text,
  p_replaces_entry_id uuid,
  p_accepted_by_person boolean default false
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform private.assert_roster_role(p_role_code);
  begin
    insert into app.engagement_roster_entries (engagement_id, person_id, role_code, arrival_window, arrival_time_zone,
      replaces_entry_id, person_response, responded_at)
    values (p_engagement_id, p_person_id, p_role_code, p_arrival_window, nullif(btrim(coalesce(p_arrival_time_zone, '')), ''),
      p_replaces_entry_id,
      case when p_accepted_by_person then 'Accepted' else 'Pending' end::app.roster_person_response,
      case when p_accepted_by_person then now() end)
    returning id into v_id;
  exception when unique_violation then
    perform private.refuse('roster_person_duplicate', 'This person is already on the engagement''s roster.');
  end;
  if p_accepted_by_person then
    perform private.sync_account_roster_consent(private.roster_entry_account(v_id), p_person_id);
  end if;
  return v_id;
end;
$$;

comment on function private.insert_roster_entry(uuid, uuid, text, tstzrange, text, uuid, boolean) is 'The one internal creator of a Draft roster entry, used by app.add_roster_entry, app.invite_to_roster, R10 and R12 after they authorize: refuses an unknown role and roster_person_duplicate; with p_accepted_by_person the person''s answer is Accepted at once and their account consent recorded.';
revoke all on function private.insert_roster_entry(uuid, uuid, text, tstzrange, text, uuid, boolean) from public, anon, authenticated;

-- Building the roster ----------------------------------------------------------------------------------------------------------

create or replace function app.add_roster_entry(
  p_engagement_id uuid,
  p_person_id uuid,
  p_role_code text default null,
  p_arrival_starts_at timestamptz default null,
  p_arrival_ends_at timestamptz default null,
  p_arrival_time_zone text default null,
  p_replaces_entry_id uuid default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_person();
  v_engagement app.engagements;
  v_window tstzrange;
begin
  select * into v_engagement from app.engagements e where e.id = p_engagement_id and e.deleted_at is null;
  perform private.assert_roster_manager(v_engagement);
  if p_person_id is not null and p_person_id = v_engagement.person_id then
    perform private.refuse('roster_person_is_engaged', 'The engaged person is on the roster through their own entry.');
  end if;
  if not private.roster_talent_eligible(v_engagement.id, p_person_id) then
    perform private.refuse('roster_person_not_in_team', 'Add people who confirmed their membership in the account, or artists you represent; invite anyone else by email.');
  end if;
  v_window := private.roster_arrival(p_arrival_starts_at, p_arrival_ends_at, p_arrival_time_zone);
  return private.insert_roster_entry(v_engagement.id, p_person_id, p_role_code, v_window, p_arrival_time_zone, p_replaces_entry_id,
    p_person_id = v_me);
end;
$$;

comment on function app.add_roster_entry(uuid, uuid, text, timestamptz, timestamptz, text, uuid) is 'A roster manager (private.can_manage_roster) puts a person from the team on the engagement''s roster as a Draft entry, with an optional role, arrival window and the withdrawn entry it replaces. Refuses roster_closed, roster_person_not_in_team (not a confirmed member of the account nor a represented artist), roster_person_is_engaged, roster_person_duplicate and roster_arrival_window. Adding oneself counts as one''s own acceptance. Returns the entry id.';

create or replace function app.update_roster_entry(
  p_roster_entry_id uuid,
  p_role_code text,
  p_arrival_starts_at timestamptz,
  p_arrival_ends_at timestamptz,
  p_arrival_time_zone text
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_person();
  v_entry app.engagement_roster_entries;
  v_engagement app.engagements;
  v_window tstzrange;
begin
  select * into v_entry from app.engagement_roster_entries r where r.id = p_roster_entry_id and r.deleted_at is null for update;
  select * into v_engagement from app.engagements e where e.id = v_entry.engagement_id and e.deleted_at is null;
  if v_entry.id is null or v_engagement.id is null then
    raise exception using errcode = '42501', message = 'roster entry not found';
  end if;
  if v_entry.is_self and v_engagement.person_id = v_me then
    -- The engaged person keeps their own entry current, whether or not they manage the roster.
    if not ('roster' = any (private.engagement_state_areas(v_engagement.engagement_state, null))) then
      perform private.refuse('roster_closed', 'This engagement is complete or canceled, so its roster is closed.');
    end if;
  else
    perform private.assert_roster_manager(v_engagement);
    if not v_entry.is_self and v_entry.entry_state not in ('Draft', 'Returned') then
      perform private.refuse('roster_entry_not_editable', 'Change a roster entry while it is a draft or returned.');
    end if;
  end if;
  perform private.assert_roster_role(p_role_code);
  v_window := private.roster_arrival(p_arrival_starts_at, p_arrival_ends_at, p_arrival_time_zone);
  update app.engagement_roster_entries set role_code = p_role_code, arrival_window = v_window,
    arrival_time_zone = nullif(btrim(coalesce(p_arrival_time_zone, '')), '')
  where id = v_entry.id;
end;
$$;

comment on function app.update_roster_entry(uuid, text, timestamptz, timestamptz, text) is 'A roster manager changes a Draft or Returned entry''s role and arrival window; the self entry also changes by the engaged person, in any open state. Refuses roster_entry_not_editable, roster_closed and roster_arrival_window.';

create or replace function app.submit_roster(p_engagement_id uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_engagement app.engagements;
  v_entry app.engagement_roster_entries;
  v_count integer := 0;
begin
  perform private.require_person();
  select * into v_engagement from app.engagements e where e.id = p_engagement_id and e.deleted_at is null;
  perform private.assert_roster_manager(v_engagement);
  for v_entry in
    select * from app.engagement_roster_entries r
    where r.engagement_id = v_engagement.id and r.deleted_at is null and not r.is_self and r.person_id is not null
      and r.entry_state in ('Draft', 'Returned')
    order by r.created_at, r.id
    for update
  loop
    perform private.transition_lifecycle('roster_entry', 'app.engagement_roster_entries', 'entry_state',
      'app.roster_entry_state_transitions', 'roster_entry_id', v_entry.id, v_entry.entry_state::text, 'Submitted', 'Submitted.');
    v_count := v_count + 1;
  end loop;
  if v_count = 0 then
    perform private.refuse('roster_empty_submit', 'Add or change someone on the roster before submitting it.');
  end if;
  return v_count;
end;
$$;

comment on function app.submit_roster(uuid) is 'A roster manager submits the roster: every non-self Draft or Returned entry naming a person moves to Submitted for the producing org to review (an unclaimed invitation stays Draft). Refuses roster_empty_submit when there is none. Returns how many were submitted.';

create or replace function app.withdraw_roster_entry(p_roster_entry_id uuid, p_reason text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_entry app.engagement_roster_entries;
  v_engagement app.engagements;
  v_share app.work_detail_shares;
begin
  perform private.require_person();
  select * into v_entry from app.engagement_roster_entries r where r.id = p_roster_entry_id and r.deleted_at is null for update;
  select * into v_engagement from app.engagements e where e.id = v_entry.engagement_id and e.deleted_at is null;
  if v_entry.id is null then
    raise exception using errcode = '42501', message = 'roster entry not found';
  end if;
  perform private.assert_roster_manager(v_engagement);
  if v_entry.is_self then
    perform private.refuse('roster_self_entry_fixed', 'The engaged person''s own entry stays on the roster.');
  end if;
  if v_entry.entry_state = 'Withdrawn' then
    perform private.refuse('roster_entry_withdrawn', 'This roster entry was withdrawn.');
  end if;
  perform private.transition_lifecycle('roster_entry', 'app.engagement_roster_entries', 'entry_state',
    'app.roster_entry_state_transitions', 'roster_entry_id', v_entry.id, v_entry.entry_state::text, 'Withdrawn',
    coalesce(nullif(btrim(coalesce(p_reason, '')), ''), 'Withdrawn.'));
  update app.roster_invitations set revoked_at = now()
  where roster_entry_id = v_entry.id and claimed_at is null and declined_at is null and revoked_at is null and deleted_at is null;
  for v_share in select * from app.work_detail_shares s where s.roster_entry_id = v_entry.id and s.revoked_at is null and s.deleted_at is null loop
    perform private.close_work_detail_share(v_share, 'work_details.share_revoked');
  end loop;
  perform private.sync_account_roster_consent(private.roster_entry_account(v_entry.id), v_entry.person_id);
end;
$$;

comment on function app.withdraw_roster_entry(uuid, text) is 'A roster manager takes someone off the roster (to Withdrawn, with the reason in the ledger): revokes the entry''s pending invitation, closes its live work details share and withdraws the person''s account consent when no other accepted entry stands. The self entry stays (roster_self_entry_fixed).';

create or replace function app.respond_roster_entry(p_roster_entry_id uuid, p_response app.roster_person_response)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.require_person();
  v_entry app.engagement_roster_entries;
  v_share app.work_detail_shares;
begin
  select * into v_entry from app.engagement_roster_entries r where r.id = p_roster_entry_id and r.deleted_at is null for update;
  if v_entry.id is null or v_entry.is_self or v_entry.person_id is distinct from v_me then
    perform private.refuse('roster_response_not_yours', 'Only the person on a roster entry answers it.');
  end if;
  if v_entry.entry_state = 'Withdrawn' then
    perform private.refuse('roster_entry_withdrawn', 'This roster entry was withdrawn.');
  end if;
  if p_response is null or p_response not in ('Accepted', 'Declined') then
    perform private.refuse('roster_response_invalid', 'Accept or decline the roster entry.');
  end if;
  if v_entry.person_response = p_response then
    return;
  end if;
  update app.engagement_roster_entries set person_response = p_response, responded_at = now() where id = v_entry.id;
  if p_response = 'Declined' then
    for v_share in select * from app.work_detail_shares s where s.roster_entry_id = v_entry.id and s.revoked_at is null and s.deleted_at is null loop
      perform private.close_work_detail_share(v_share, 'work_details.share_revoked');
    end loop;
  end if;
  perform private.sync_account_roster_consent(private.roster_entry_account(v_entry.id), v_me);
end;
$$;

comment on function app.respond_roster_entry(uuid, app.roster_person_response) is 'The person on a live roster entry accepts or declines it (owner decisions 0/1), and may change their answer while the entry is live. Accepting records their account_roster_sharing consent for the supplying account; declining closes the entry''s live work details share and withdraws that consent when no other accepted entry stands.';

-- Review -------------------------------------------------------------------------------------------------------------------------

create or replace function private.review_roster_entry_core(p_roster_entry_id uuid, p_outcome app.roster_entry_state, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := private.current_person_id();
  v_entry app.engagement_roster_entries;
  v_project uuid;
  v_submitter uuid;
begin
  select * into v_entry from app.engagement_roster_entries r where r.id = p_roster_entry_id and r.deleted_at is null for update;
  select e.project_id into v_project from app.engagements e where e.id = v_entry.engagement_id and e.deleted_at is null;
  if v_entry.id is null or v_project is null or not private.can_on_project(v_project, 'advancing.submission.review') then
    raise exception using errcode = '42501', message = 'advancing.submission.review is required on the engagement''s project';
  end if;
  if p_outcome is null or p_outcome not in ('Accepted', 'Returned') then
    perform private.refuse('roster_review_outcome', 'A reviewer accepts or returns a roster entry.');
  end if;
  if v_entry.entry_state <> 'Submitted' then
    perform private.refuse('roster_entry_not_submitted', 'Only a submitted roster entry is reviewed.');
  end if;
  select t.created_by into v_submitter from app.roster_entry_state_transitions t
  where t.roster_entry_id = v_entry.id and t.to_state = 'Submitted'
  order by t.created_at desc, t.id desc limit 1;
  if v_me = private.roster_entry_creator(v_entry.id) or v_me = v_submitter then
    perform private.refuse('sod_roster_reviewer', 'Someone other than the person who added or submitted a roster entry reviews it.');
  end if;
  if p_outcome = 'Returned' and char_length(btrim(coalesce(p_reason, ''))) not between 1 and 500 then
    perform private.refuse('roster_review_reason', 'Say what to change, in 1 to 500 characters.');
  end if;
  return private.transition_lifecycle('roster_entry', 'app.engagement_roster_entries', 'entry_state',
    'app.roster_entry_state_transitions', 'roster_entry_id', v_entry.id, 'Submitted', p_outcome::text,
    coalesce(nullif(btrim(coalesce(p_reason, '')), ''), 'Accepted.'));
end;
$$;

comment on function private.review_roster_entry_core(uuid, app.roster_entry_state, text) is 'The review of one roster entry, shared by app.review_roster_entry and the bulk row: advancing.submission.review on the project, a Submitted entry, Accepted or Returned, a reviewer other than its creator and its latest submitter (sod_roster_reviewer), and a reason of 1 to 500 characters to return. Returns the ledger entry id.';
revoke all on function private.review_roster_entry_core(uuid, app.roster_entry_state, text) from public, anon, authenticated;

create or replace function app.review_roster_entry(p_roster_entry_id uuid, p_outcome app.roster_entry_state, p_reason text default null)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform private.require_person();
  perform private.review_roster_entry_core(p_roster_entry_id, p_outcome, p_reason);
end;
$$;

comment on function app.review_roster_entry(uuid, app.roster_entry_state, text) is 'A reviewer of the producing org (advancing.submission.review) accepts a submitted roster entry or returns it with a reason of 1 to 500 characters. Refuses roster_review_outcome, roster_entry_not_submitted, sod_roster_reviewer and roster_review_reason.';

create or replace function private.bulk_engagement_roster_entries_row(p_id uuid, p_set jsonb, p_expect jsonb, p_reason text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_old app.engagement_roster_entries;
  v_project uuid;
  v_state app.roster_entry_state;
begin
  perform private.bulk_check_fields(p_set, p_expect, 'entry_state');
  select r.* into v_old from app.engagement_roster_entries r where r.id = p_id and r.deleted_at is null;
  select e.project_id into v_project from app.engagements e where e.id = v_old.engagement_id;
  if v_old.id is null or v_project not in (select private.project_ids_with('advancing.packet.read')) then
    perform private.refuse('bulk_row_not_found', 'This row no longer exists or is not available to you.');
  end if;
  perform private.bulk_check_expect(to_jsonb(v_old), p_expect);
  v_state := case when p_set ? 'entry_state' then (p_set ->> 'entry_state')::app.roster_entry_state else v_old.entry_state end;
  if v_state = v_old.entry_state then
    return jsonb_build_object('org_id', v_old.org_id, 'changed', false);
  end if;
  -- Every rule of a single review applies to each row.
  perform private.review_roster_entry_core(p_id, v_state, p_reason);
  return jsonb_build_object('org_id', v_old.org_id, 'changed', true,
    'before', jsonb_build_object('entry_state', v_old.entry_state),
    'after', jsonb_build_object('entry_state', v_state));
end;
$$;

comment on function private.bulk_engagement_roster_entries_row(uuid, jsonb, jsonb, text) is 'One roster entry of a bulk review: accept or return (with the call''s one reason). Goes through private.review_roster_entry_core, so the capability, the Submitted state, the reviewer separation and the reason rule apply to each row.';
revoke all on function private.bulk_engagement_roster_entries_row(uuid, jsonb, jsonb, text) from public, anon, authenticated;

insert into private.bulk_resources (resource, table_name, row_function) values
  ('engagement_roster_entries', 'app.engagement_roster_entries', 'private.bulk_engagement_roster_entries_row');

create or replace function app.bulk_update_roster_entries(p_rows jsonb, p_preview boolean default false, p_reason text default null)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  select private.run_bulk('engagement_roster_entries', p_rows, coalesce(p_preview, false), p_reason);
$$;

comment on function app.bulk_update_roster_entries(jsonb, boolean, text) is 'Accepts or returns roster entries in bulk in one transaction (Section 11.7), every rule of a single review applying to each row, with the answer of app.bulk_update_records. A return carries the call''s one reason.';

-- Privileges ---------------------------------------------------------------------------------------------------------------------

revoke all on function private.can_advance_engagement(uuid) from public, anon;
revoke all on function private.can_manage_roster(uuid) from public, anon;
-- Function calls inside a view run with the caller's execute privilege, so signed-in users need these.
grant execute on function private.can_advance_engagement(uuid) to authenticated, service_role;
grant execute on function private.can_manage_roster(uuid) to authenticated, service_role;

revoke all on function app.add_roster_entry(uuid, uuid, text, timestamptz, timestamptz, text, uuid) from public, anon;
revoke all on function app.update_roster_entry(uuid, text, timestamptz, timestamptz, text) from public, anon;
revoke all on function app.submit_roster(uuid) from public, anon;
revoke all on function app.withdraw_roster_entry(uuid, text) from public, anon;
revoke all on function app.respond_roster_entry(uuid, app.roster_person_response) from public, anon;
revoke all on function app.review_roster_entry(uuid, app.roster_entry_state, text) from public, anon;
revoke all on function app.bulk_update_roster_entries(jsonb, boolean, text) from public, anon;
grant execute on function app.add_roster_entry(uuid, uuid, text, timestamptz, timestamptz, text, uuid) to authenticated, service_role;
grant execute on function app.update_roster_entry(uuid, text, timestamptz, timestamptz, text) to authenticated, service_role;
grant execute on function app.submit_roster(uuid) to authenticated, service_role;
grant execute on function app.withdraw_roster_entry(uuid, text) to authenticated, service_role;
grant execute on function app.respond_roster_entry(uuid, app.roster_person_response) to authenticated, service_role;
grant execute on function app.review_roster_entry(uuid, app.roster_entry_state, text) to authenticated, service_role;
grant execute on function app.bulk_update_roster_entries(jsonb, boolean, text) to authenticated, service_role;
