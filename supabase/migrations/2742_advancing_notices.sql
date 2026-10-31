-- 2742_advancing_notices.sql
-- R11 Advancing notices (RRR-192; Section 11.11, owner decision 6). The advancing events the approved report lists that
-- no other package already announces. Each emitter goes through private.notify in the producing org and never tells the
-- person who acted; 2749 seeds the kinds.
--
--   * advance_submission.returned (assignments): a reviewer returns an answer, to the recipient's people
--     (private.advance_reminder_recipients) and the person who claimed its token link, with the reason.
--   * submittal.returned (approvals): a submittal moves to Returned, to the vendor account's Owners and Admins and the
--     Advancing Leads assigned to its Vendor engagement on the project, never an unassigned Account Member.
--   * roster_entry.removed (assignments): a roster entry is withdrawn or deleted, to its person, sent just before the
--     change so a rostered person who is no account member still counts as the org's external party.
--   * roster_entry.facts_requested (assignments): an entry is accepted by the reviewer and the person while an
--     offering's project fact is missing (2741's private.roster_missing_facts), to the person; 2741 reminds them again
--     before arrival.
--   * roster_entry.share_revoked (assignments): a person revokes the work details shared on a roster entry, to the
--     project's readers of advancing packets (at most 50).
--   * credential.revoked (assignments): a credential issued under an engagement or an allocation is revoked, to its
--     holder; skipped inside R7's engagement_close and roster_entry_close cascades, which already notify.
-- R4's roster_entry.invited, roster_entry.returned and roster_entry.declined and R7's allocation.* kinds are theirs.
--
-- private.party_org_ids: A127 (2200) and R4 (2641) each recreated it from 1131 on separate branches, so the later 2641
-- dropped A127's open-offer branch once both were merged. It is recreated here as the union of the two, changing
-- nothing else; no R11 behavior depends on it.

-- The two branches of private.party_org_ids (2200 and 2641) --------------------------------------------------------------

create or replace function private.party_org_ids(p_person_id uuid)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select e.org_id from app.engagements e
  where e.person_id = p_person_id and e.deleted_at is null
  union
  select c.org_id from app.counterparties c
  join app.account_memberships m on m.org_id = c.organization_id and m.person_id = p_person_id and m.deleted_at is null
    and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
  where c.deleted_at is null
  union
  select r.org_id from app.engagement_roster_entries r
  where r.person_id = p_person_id and r.deleted_at is null and r.entry_state <> 'Withdrawn'
  union
  select a.org_id from app.applications a
  join app.offers o on o.application_id = a.id and o.deleted_at is null and o.offer_state in ('Sent', 'Countered')
  where a.applicant_person_id = p_person_id and a.deleted_at is null;
$$;
comment on function private.party_org_ids(uuid) is 'Orgs a person works with as an external party: through an engagement of their own, an active membership in an external account the org holds as a counterparty, a live roster entry on one of the org''s engagements (R4), or an application of their own with an offer still open (A127), so the offer''s notices reach them.';
revoke all on function private.party_org_ids(uuid) from public, anon, authenticated;

-- advance_submission.returned ----------------------------------------------------------------------------------------------

create or replace function private.notify_advance_answer_returned()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_section app.advance_sections;
  v_packet app.advance_packets;
  v_me uuid := private.current_person_id();
  v_person uuid;
  v_args jsonb;
begin
  if new.review_outcome is distinct from 'Returned' or old.review_outcome is not distinct from new.review_outcome
     or new.deleted_at is not null then
    return null;
  end if;
  select s.* into v_section from app.advance_sections s where s.id = new.advance_section_id;
  select p.* into v_packet from app.advance_packets p where p.id = v_section.advance_packet_id;
  v_args := jsonb_build_object('title', v_section.title, 'packetTitle', v_packet.title, 'reason', coalesce(new.return_reason, ''))
    || coalesce((select jsonb_build_object('gatewayPath',
         '/work/engagements/' || private.gateway_display_key('ENG', r.engagement_id) || '/advance')
       from app.advance_recipients r where r.id = new.advance_recipient_id and r.engagement_id is not null), '{}'::jsonb);
  for v_person in
    select x from private.advance_reminder_recipients(new.advance_recipient_id) x
    union
    select t.claimed_by from app.advance_recipient_tokens t
    where t.id = new.advance_recipient_token_id and t.claimed_by is not null
  loop
    continue when v_person is not distinct from v_me;
    perform private.notify(new.org_id, v_person, 'advance_submission.returned', 'advance_submissions', new.id,
      v_packet.project_id, v_args);
  end loop;
  return null;
end;
$$;

comment on function private.notify_advance_answer_returned() is 'After an advance answer is reviewed Returned: sends advance_submission.returned, with the section title, the packet title and the reason, to the recipient''s people (private.advance_reminder_recipients) and to whoever claimed the token link the answer came through, except the reviewer.';
revoke all on function private.notify_advance_answer_returned() from public, anon, authenticated;

create trigger t97_notify_advance_answer_returned after update of review_outcome on app.advance_submissions
  for each row execute function private.notify_advance_answer_returned();

-- submittal.returned ----------------------------------------------------------------------------------------------------------

create or replace function private.vendor_engagement_people(p_project_id uuid, p_vendor_id uuid)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.person_id from app.vendors v
  join app.counterparties c on c.id = v.counterparty_id
  join app.account_memberships m on m.org_id = c.organization_id and m.deleted_at is null and m.accepted_at is not null
    and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
  join app.account_membership_roles x on x.account_membership_id = m.id and x.deleted_at is null
    and x.account_role in ('Account Owner', 'Account Admin')
  where v.id = p_vendor_id
  union
  select m.person_id from app.vendors v
  join app.engagements e on e.counterparty_id = v.counterparty_id and e.project_id = p_project_id and e.role_type = 'Vendor'
    and e.deleted_at is null
  join app.account_engagement_assignments a on a.engagement_id = e.id and a.deleted_at is null and a.duty = 'Advancing Lead'
  join app.account_memberships m on m.id = a.account_membership_id and m.deleted_at is null and m.accepted_at is not null
    and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
  where v.id = p_vendor_id;
$$;

comment on function private.vendor_engagement_people(uuid, uuid) is 'Who a vendor''s submittal notice reaches (R11, owner decision 6): the vendor account''s live, accepted Account Owners and Admins, and the Advancing Leads assigned to its Vendor engagements on the project. Never an unassigned Account Member.';
revoke all on function private.vendor_engagement_people(uuid, uuid) from public, anon, authenticated;

create or replace function private.notify_submittal_returned()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_submittal app.submittals;
  v_me uuid := private.current_person_id();
  v_person uuid;
  v_args jsonb;
begin
  if new.to_state <> 'Returned' then
    return null;
  end if;
  select s.* into v_submittal from app.submittals s where s.id = new.submittal_id;
  v_args := jsonb_build_object('title', v_submittal.title, 'reason', new.reason,
      'projectName', (select p.name from app.projects p where p.id = v_submittal.project_id))
    || coalesce((
      select jsonb_build_object('gatewayPath', '/work/engagements/' || private.gateway_display_key('ENG', e.id) || '/submittals')
      from app.vendors v
      join app.engagements e on e.counterparty_id = v.counterparty_id and e.project_id = v_submittal.project_id
        and e.role_type = 'Vendor' and e.deleted_at is null
      where v.id = v_submittal.vendor_id
      order by e.engagement_state in ('Complete', 'Canceled'), e.created_at desc, e.id desc limit 1), '{}'::jsonb);
  for v_person in select x from private.vendor_engagement_people(v_submittal.project_id, v_submittal.vendor_id) x loop
    continue when v_person is not distinct from v_me;
    perform private.notify(v_submittal.org_id, v_person, 'submittal.returned', 'submittals', v_submittal.id,
      v_submittal.project_id, v_args);
  end loop;
  return null;
end;
$$;

comment on function private.notify_submittal_returned() is 'After a submittal moves to Returned: sends submittal.returned, with the title, the reason and the project, to private.vendor_engagement_people, except the reviewer. The notice opens the Vendor engagement''s Submittals tab in Gateway.';
revoke all on function private.notify_submittal_returned() from public, anon, authenticated;

create trigger t97_notify_submittal_returned after insert on app.submittal_state_transitions
  for each row execute function private.notify_submittal_returned();

-- Roster entries -----------------------------------------------------------------------------------------------------------------

create or replace function private.notify_roster_entry_removed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_engagement app.engagements;
  v_person uuid;
begin
  if not ((new.entry_state = 'Withdrawn' and old.entry_state <> 'Withdrawn')
          or (new.deleted_at is not null and old.deleted_at is null and old.entry_state <> 'Withdrawn')) then
    return new;
  end if;
  select e.* into v_engagement from app.engagements e where e.id = new.engagement_id;
  v_person := private.roster_entry_person_id(new.is_self, new.person_id, v_engagement.person_id);
  if v_person is null or v_person is not distinct from private.current_person_id() then
    return new;
  end if;
  perform private.notify(new.org_id, v_person, 'roster_entry.removed', 'engagement_roster_entries', new.id,
    v_engagement.project_id, private.roster_notification_args(new.id));
  return new;
end;
$$;

comment on function private.notify_roster_entry_removed() is 'Before a roster entry is withdrawn or deleted while on the roster: sends roster_entry.removed to its person unless they made the change. It runs before the change, while the entry still makes the person an external party of the org (private.party_org_ids), so a rostered person who is no account member is told by email and push too; a refused change rolls the notice back with it.';
revoke all on function private.notify_roster_entry_removed() from public, anon, authenticated;

create trigger t89_notify_roster_entry_removed before update of entry_state, deleted_at on app.engagement_roster_entries
  for each row execute function private.notify_roster_entry_removed();

create or replace function private.notify_roster_entry_accepted()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_engagement app.engagements;
  v_person uuid;
  v_missing text[];
begin
  -- Accepted by both sides just now, with a project fact the offerings ask for still missing.
  if new.deleted_at is not null or new.entry_state <> 'Accepted' or not (new.is_self or new.person_response = 'Accepted')
     or (old.entry_state = 'Accepted' and (old.is_self or old.person_response = 'Accepted')) then
    return null;
  end if;
  select e.* into v_engagement from app.engagements e where e.id = new.engagement_id;
  v_person := private.roster_entry_person_id(new.is_self, new.person_id, v_engagement.person_id);
  if v_person is null or v_person is not distinct from private.current_person_id() then
    return null;
  end if;
  v_missing := private.roster_missing_facts(new.id);
  if cardinality(v_missing) > 0 then
    perform private.notify(new.org_id, v_person, 'roster_entry.facts_requested', 'engagement_roster_entries', new.id,
      v_engagement.project_id, private.roster_notification_args(new.id) || jsonb_build_object(
        'missing', array_to_string(v_missing, ','),
        'kind', case when cardinality(v_missing) = 1 then v_missing[1] else 'several' end));
  end if;
  return null;
end;
$$;

comment on function private.notify_roster_entry_accepted() is 'After a roster entry becomes Accepted by the reviewer and by the person (or is the self entry) while an offering''s project fact is missing (private.roster_missing_facts): sends roster_entry.facts_requested to the person unless they made the change. R4 announces the invitation, a return and a decline.';
revoke all on function private.notify_roster_entry_accepted() from public, anon, authenticated;

create trigger t97_notify_roster_entry_accepted after update of entry_state, person_response on app.engagement_roster_entries
  for each row execute function private.notify_roster_entry_accepted();

-- roster_entry.share_revoked ---------------------------------------------------------------------------------------------------

create or replace function private.notify_roster_share_revoked()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project uuid;
  v_me uuid := private.current_person_id();
  v_person uuid;
begin
  if new.roster_entry_id is null or old.revoked_at is not null or new.revoked_at is null then
    return null;
  end if;
  select e.project_id into v_project from app.engagements e where e.id = new.engagement_id;
  for v_person in
    select x from private.project_member_people_with(v_project, 'advancing.packet.read') x order by x limit 50
  loop
    continue when v_person is not distinct from v_me;
    perform private.notify(new.org_id, v_person, 'roster_entry.share_revoked', 'engagement_roster_entries', new.roster_entry_id,
      v_project, private.roster_notification_args(new.roster_entry_id));
  end loop;
  return null;
end;
$$;

comment on function private.notify_roster_share_revoked() is 'After the work details shared on a roster entry are revoked: sends roster_entry.share_revoked, naming the person and the party but no category or value, to at most 50 people who read the project''s advancing packets (private.project_member_people_with), except whoever revoked it.';
revoke all on function private.notify_roster_share_revoked() from public, anon, authenticated;

create trigger t97_notify_roster_share_revoked after update of revoked_at on app.work_detail_shares
  for each row execute function private.notify_roster_share_revoked();

-- credential.revoked ----------------------------------------------------------------------------------------------------------

create or replace function private.notify_credential_revoked()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.revoked_at is not null or new.revoked_at is null or (new.engagement_id is null and new.allocation_id is null)
     or new.holder_person_id is not distinct from private.current_person_id()
     or private.in_trusted_operation('engagement_close') or private.in_trusted_operation('roster_entry_close') then
    return null;
  end if;
  perform private.notify(new.org_id, new.holder_person_id, 'credential.revoked', 'credentials', new.id, new.project_id,
    jsonb_build_object(
      'title', coalesce((select k.name from app.credential_categories k where k.id = new.credential_category_id), ''),
      'projectName', coalesce((select p.name from app.projects p where p.id = new.project_id), '')));
  return null;
end;
$$;

comment on function private.notify_credential_revoked() is 'After a credential issued under an engagement or an allocation is revoked: sends credential.revoked, with its category and project, to its holder unless they revoked it. Skipped inside the engagement_close and roster_entry_close cascades, where R7 already notifies.';
revoke all on function private.notify_credential_revoked() from public, anon, authenticated;

create trigger t97_notify_credential_revoked after update of revoked_at on app.credentials
  for each row execute function private.notify_credential_revoked();
