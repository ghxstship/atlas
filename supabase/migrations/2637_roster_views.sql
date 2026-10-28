-- 2637_roster_views.sql
-- R4 Crew roster core (RRR-182, ADR 0101 decisions 3, 4 and 6; Section 8.7). Views run as their owner with explicit
-- filters, as 0750 does, because people are not readable to producing-org members through row level security
-- (0204_access_helpers.sql) and external parties never read the entries table itself.
--
--   * app.roster_entry_people: the producing org's read of every entry with its resolved person, party, role, arrival,
--     review state and latest return reason, pending invitation and the live share's categories, on projects where the
--     reader holds advancing.packet.read.
--   * api_external.engagement_roster: the same, without org_id, for the engagements whose roster area the caller reaches
--     (private.my_engagement_ids('roster')) and the caller's own entries; the invited address only for a roster manager.
--   * api_external.my_roster_entries: the caller's own entries in open roster states, for Gateway Home and Compass.
--   * api_external.my_account_talent: the talent pool (ADR 0101 decision 6): confirmed, active members of accounts where
--     the caller is Owner or Admin or holds a live Advancing Lead assignment, and the artists the caller represents with
--     the Advance scope. Former members and people rostered before are not in it.
-- No view carries an internal column (internal notes, rates). Views in app are revoked from the backup login (1650).

-- The share column 2638 keys work details shares on, added first so these views read the live share of each entry.
alter table app.work_detail_shares add column roster_entry_id uuid references app.engagement_roster_entries (id);
create index work_detail_shares_roster_entry_id_idx on app.work_detail_shares (roster_entry_id);
comment on column app.work_detail_shares.roster_entry_id is 'Roster entry the share serves (R4): the person''s own entry on the engagement, the self entry for the engaged person. Required on a new share (2638).';

create view app.roster_entry_people as
select r.id, r.org_id, e.project_id, r.engagement_id,
  coalesce(a.name, ep.full_name) as party_name, e.role_type, r.is_self,
  private.roster_entry_person_id(r.is_self, r.person_id, e.person_id) as person_id,
  rp.full_name,
  case when r.person_id is null and not r.is_self then i.email end as invited_email,
  case when r.person_id is null and not r.is_self then i.expires_at end as invitation_expires_at,
  r.role_code, xr.job_title,
  lower(r.arrival_window) as arrival_starts_at, upper(r.arrival_window) as arrival_ends_at, r.arrival_time_zone,
  r.entry_state, r.person_response, r.responded_at,
  case when r.entry_state = 'Returned' then rt.reason end as return_reason,
  r.replaces_entry_id,
  coalesce(s.categories, '{}') as share_categories
from app.engagement_roster_entries r
join app.engagements e on e.id = r.engagement_id and e.deleted_at is null
left join app.counterparties c on c.id = e.counterparty_id
left join app.organizations a on a.id = c.organization_id
left join app.people ep on ep.id = e.person_id
left join app.people rp on rp.id = private.roster_entry_person_id(r.is_self, r.person_id, e.person_id)
left join xpms.role xr on xr.role_code = r.role_code
left join lateral (
  select iv.email, iv.expires_at from app.roster_invitations iv
  where iv.roster_entry_id = r.id and iv.claimed_at is null and iv.declined_at is null and iv.revoked_at is null and iv.deleted_at is null
  order by iv.created_at desc limit 1
) i on true
left join lateral (
  select t.reason from app.roster_entry_state_transitions t
  where t.roster_entry_id = r.id and t.to_state = 'Returned'
  order by t.created_at desc, t.id desc limit 1
) rt on true
left join app.work_detail_shares s on s.roster_entry_id = r.id and s.revoked_at is null and s.deleted_at is null
where r.deleted_at is null and e.project_id in (select private.project_ids_with('advancing.packet.read'));

call private.describe('app.roster_entry_people', 'The producing org''s read of crew roster entries with their people (ADR 0101), on projects where the reader holds advancing.packet.read: the party, the resolved person (the engaged person for the self entry), a pending invitation''s address, the role and arrival, the review state with the latest return reason, the person''s answer and the categories of their live work details share. Profile values are read only through app.roster_shared_work_details, which logs each read.', array[
  'id', 'Roster entry.', 'org_id', 'Producing org.', 'project_id', 'Project.', 'engagement_id', 'Engagement.',
  'party_name', 'Supplying account, else the engaged person.', 'role_type', 'External role type of the engagement.',
  'is_self', 'True for the engaged person''s own entry.', 'person_id', 'Resolved person; NULL for an unclaimed invitation.',
  'full_name', 'Name of the person.', 'invited_email', 'Address of the pending invitation, while nobody has claimed it.',
  'invitation_expires_at', 'When the pending invitation lapses.', 'role_code', 'Role worked, from the Roles Library.',
  'job_title', 'Job title of the role.', 'arrival_starts_at', 'Arrival window start.', 'arrival_ends_at', 'Arrival window end.',
  'arrival_time_zone', 'IANA time zone of the arrival window.', 'entry_state', 'Review state.',
  'person_response', 'The person''s answer.', 'responded_at', 'When the person last answered.',
  'return_reason', 'What the reviewer asked to change, while Returned.', 'replaces_entry_id', 'Withdrawn entry this one replaces.',
  'share_categories', 'Work details categories the person shares on this entry; empty when none.']);

revoke all on app.roster_entry_people from public, anon;
grant select on app.roster_entry_people to authenticated, service_role;
revoke select on app.roster_entry_people from xos_backup;

create view api_external.engagement_roster as
select r.id, e.project_id, r.engagement_id,
  coalesce(a.name, ep.full_name) as party_name, e.role_type, r.is_self,
  private.roster_entry_person_id(r.is_self, r.person_id, e.person_id) as person_id,
  rp.full_name,
  case when r.person_id is null and not r.is_self and private.can_manage_roster(e.id) then i.email end as invited_email,
  case when r.person_id is null and not r.is_self then i.expires_at end as invitation_expires_at,
  r.role_code, xr.job_title,
  lower(r.arrival_window) as arrival_starts_at, upper(r.arrival_window) as arrival_ends_at, r.arrival_time_zone,
  r.entry_state, r.person_response, r.responded_at,
  case when r.entry_state = 'Returned' then rt.reason end as return_reason,
  r.replaces_entry_id,
  coalesce(s.categories, '{}') as share_categories
from app.engagement_roster_entries r
join app.engagements e on e.id = r.engagement_id and e.deleted_at is null
left join app.counterparties c on c.id = e.counterparty_id
left join app.organizations a on a.id = c.organization_id
left join app.people ep on ep.id = e.person_id
left join app.people rp on rp.id = private.roster_entry_person_id(r.is_self, r.person_id, e.person_id)
left join xpms.role xr on xr.role_code = r.role_code
left join lateral (
  select iv.email, iv.expires_at from app.roster_invitations iv
  where iv.roster_entry_id = r.id and iv.claimed_at is null and iv.declined_at is null and iv.revoked_at is null and iv.deleted_at is null
  order by iv.created_at desc limit 1
) i on true
left join lateral (
  select t.reason from app.roster_entry_state_transitions t
  where t.roster_entry_id = r.id and t.to_state = 'Returned'
  order by t.created_at desc, t.id desc limit 1
) rt on true
left join app.work_detail_shares s on s.roster_entry_id = r.id and s.revoked_at is null and s.deleted_at is null
where r.deleted_at is null
  and (r.engagement_id in (select private.my_engagement_ids('roster')) or r.id in (select private.my_roster_entry_ids('roster')));

call private.describe('api_external.engagement_roster', 'Crew roster entries the caller reaches (Section 8.7, ADR 0101): every entry of an engagement whose roster area is open to them (the engaged person of an Artist engagement, the supplying account''s Owner or Admin, an assigned Advancing Lead, an Advance representative), and their own entries otherwise, as for the worker a company sends. The invited address shows only to a roster manager. Internal notes and rates never appear.', array[
  'id', 'Roster entry.', 'project_id', 'Project.', 'engagement_id', 'Engagement.',
  'party_name', 'Supplying account, else the engaged person.', 'role_type', 'External role type of the engagement.',
  'is_self', 'True for the engaged person''s own entry.', 'person_id', 'Resolved person; NULL for an unclaimed invitation.',
  'full_name', 'Name of the person.', 'invited_email', 'Address of the pending invitation, for roster managers only.',
  'invitation_expires_at', 'When the pending invitation lapses.', 'role_code', 'Role worked, from the Roles Library.',
  'job_title', 'Job title of the role.', 'arrival_starts_at', 'Arrival window start.', 'arrival_ends_at', 'Arrival window end.',
  'arrival_time_zone', 'IANA time zone of the arrival window.', 'entry_state', 'Review state.',
  'person_response', 'The person''s answer.', 'responded_at', 'When the person last answered.',
  'return_reason', 'What the reviewer asked to change, while Returned.', 'replaces_entry_id', 'Withdrawn entry this one replaces.',
  'share_categories', 'Work details categories the person shares on this entry; empty when none.']);

create view api_external.my_roster_entries as
select r.id, r.engagement_id, e.project_id, o.name as org_name, p.name as project_name,
  coalesce(a.name, ep.full_name) as party_name, e.role_type, r.role_code, xr.job_title,
  lower(r.arrival_window) as arrival_starts_at, upper(r.arrival_window) as arrival_ends_at, r.arrival_time_zone,
  r.entry_state, r.person_response, r.is_self,
  coalesce(s.categories, '{}') as share_categories
from app.engagement_roster_entries r
join app.engagements e on e.id = r.engagement_id and e.deleted_at is null
join app.organizations o on o.id = e.org_id
join app.projects p on p.id = e.project_id
left join app.counterparties c on c.id = e.counterparty_id
left join app.organizations a on a.id = c.organization_id
left join app.people ep on ep.id = e.person_id
left join xpms.role xr on xr.role_code = r.role_code
left join app.work_detail_shares s on s.roster_entry_id = r.id and s.revoked_at is null and s.deleted_at is null
where r.id in (select private.my_roster_entry_ids('roster'));

call private.describe('api_external.my_roster_entries', 'The caller''s own crew roster entries on engagements from Onboarding to Closing (R4): the producing org, project and party, the role and arrival, the review state, their own answer and what they share.', array[
  'id', 'Roster entry.', 'engagement_id', 'Engagement.', 'project_id', 'Project.', 'org_name', 'Producing org.',
  'project_name', 'Project name.', 'party_name', 'Supplying account, else the engaged person.',
  'role_type', 'External role type of the engagement.', 'role_code', 'Role worked.', 'job_title', 'Job title of the role.',
  'arrival_starts_at', 'Arrival window start.', 'arrival_ends_at', 'Arrival window end.', 'arrival_time_zone', 'IANA time zone of the arrival window.',
  'entry_state', 'Review state.', 'person_response', 'The caller''s answer.', 'is_self', 'True for their own engagement''s entry.',
  'share_categories', 'Work details categories they share on this entry; empty when none.']);

create view api_external.my_account_talent as
select distinct m.org_id as account_id, m.person_id, p.full_name, 'Account Member'::text as source
from app.account_memberships m
join app.people p on p.id = m.person_id and p.deleted_at is null
where m.deleted_at is null and m.accepted_at is not null and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
  and (m.org_id in (select private.my_account_ids(array['Account Owner', 'Account Admin']::app.account_role[]))
    or m.org_id in (
      select am.org_id from app.account_engagement_assignments x
      join app.account_memberships am on am.id = x.account_membership_id
      where x.deleted_at is null and x.duty = 'Advancing Lead' and x.account_membership_id in (select private.my_account_membership_ids())))
union
select r.org_id, r.artist_person_id, p.full_name, 'Represented Artist'::text
from app.representations r
join app.people p on p.id = r.artist_person_id and p.deleted_at is null
where r.deleted_at is null and private.represents(r.artist_person_id, 'Advance')
  and (r.org_id in (select private.my_account_ids(array['Account Owner', 'Account Admin']::app.account_role[]))
    or r.representative_person_id = private.current_person_id());

call private.describe('api_external.my_account_talent', 'The talent pool the caller may roster (ADR 0101 decision 6): confirmed, active members of accounts where they are an Account Owner or Admin or hold a live Advancing Lead assignment, and the artists they represent with the Advance scope. Former members and people rostered before are not in it.', array[
  'account_id', 'Account the person belongs to, or that represents them.', 'person_id', 'Person.', 'full_name', 'Name.',
  'source', 'Account Member or Represented Artist.']);

revoke all on api_external.engagement_roster, api_external.my_roster_entries, api_external.my_account_talent from public, anon;
grant select on api_external.engagement_roster, api_external.my_roster_entries, api_external.my_account_talent to authenticated, service_role;
