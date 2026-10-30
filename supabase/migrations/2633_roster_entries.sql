-- 2633_roster_entries.sql
-- R4 Crew roster core (RRR-182, ADR 0101 decisions 3, 5, 7 and 8). The people a party puts on an engagement: a vendor's
-- technicians, a band and its touring crew, a sponsor's activation staff (Section 4.5.8 Crew Roster, prompt line 883).
--
--   * app.engagement_roster_entries: one row per person on an engagement, with the role they work (an xpms role, never
--     the engagement's own, which may be NULL since 1624), an arrival window in its IANA zone, and two separate answers:
--     entry_state, the review lifecycle (Draft, Submitted, Accepted, Returned, Withdrawn; the return reason and the
--     reviewer live in app.roster_entry_state_transitions, never on the entry), and person_response, the person's own
--     accept or decline (owner decisions 0/1). No project_id and no profile field is copied: the project is read through
--     the engagement and the person's facts through their share.
--   * The self entry (is_self) stands for the engaged person themselves; its person_id is NULL and the person is
--     app.engagements.person_id, resolved by private.roster_people, so nothing restates it. 2634 creates it.
--   * Rosterable (ADR 0101 decision 8): an Artist engagement, or a company engagement (counterparty set) of a Vendor,
--     Contractor, Staff or Sponsor. Client never; self entries skip Client and Sponsor.
--   * private.roster_people (roster_entry_id, engagement_id, person_id) is the unfiltered resolver, in schema private and
--     revoked from every signed-in role; private.roster_entry_person(entry) answers one entry. R5, R7, R9, R11 and R12
--     read these.
--   * Entries never count toward plan limits (prompt lines 2648-2649) and never create project membership (line 1689).
--     A107's over-limit guard covers the table through engagement_id; nothing joins its exemption lists.
-- Writes go only through the RPCs of 2635 and 2636. Internal readers read through the policy below and app.roster_entry_people
-- (2637); external readers only through the api_external views of 2637 (Section 8.7).

create type app.roster_entry_state as enum ('Draft', 'Submitted', 'Accepted', 'Returned', 'Withdrawn');
comment on type app.roster_entry_state is 'Review lifecycle of a roster entry (ADR 0101 decision 7): the party drafts and submits it, a reviewer of the producing org accepts or returns it with a reason, and the party withdraws it. A swap after acceptance withdraws the entry and adds a replacement.';

create type app.roster_person_response as enum ('Pending', 'Accepted', 'Declined');
comment on type app.roster_person_response is 'The rostered person''s own answer to being on the roster (owner decisions 0/1), separate from the review state.';

create table app.engagement_roster_entries (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  engagement_id uuid not null references app.engagements (id),
  is_self boolean not null default false,
  person_id uuid references app.people (id),
  role_code text references xpms.role (role_code),
  arrival_window tstzrange,
  arrival_time_zone text,
  replaces_entry_id uuid references app.engagement_roster_entries (id),
  entry_state app.roster_entry_state not null default 'Draft',
  person_response app.roster_person_response not null default 'Pending',
  responded_at timestamptz,
  deleted_at timestamptz,
  constraint engagement_roster_entries_arrival_zone check ((arrival_window is null) = (arrival_time_zone is null)),
  constraint engagement_roster_entries_arrival_bounded check (arrival_window is null
    or (not isempty(arrival_window) and not lower_inf(arrival_window) and not upper_inf(arrival_window))),
  constraint engagement_roster_entries_self_person check (not is_self or person_id is null),
  constraint engagement_roster_entries_responded check ((person_response = 'Pending') = (responded_at is null))
);

create index engagement_roster_entries_engagement_id_idx on app.engagement_roster_entries (engagement_id);
create index engagement_roster_entries_person_id_idx on app.engagement_roster_entries (person_id);
create index engagement_roster_entries_role_code_idx on app.engagement_roster_entries (role_code);
create index engagement_roster_entries_replaces_entry_id_idx on app.engagement_roster_entries (replaces_entry_id);
create unique index engagement_roster_entries_person_key on app.engagement_roster_entries (engagement_id, person_id)
  where person_id is not null and deleted_at is null and entry_state <> 'Withdrawn';
create unique index engagement_roster_entries_self_key on app.engagement_roster_entries (engagement_id)
  where is_self and deleted_at is null;

call private.install_domain_table('app.engagement_roster_entries', 'app.engagements', 'engagement_id',
  array['app.engagement_roster_entries', 'replaces_entry_id']);
call private.describe('app.engagement_roster_entries', 'A person on an engagement''s crew roster (Section 4.5.8, ADR 0101): the party''s people with the role they work and when they arrive, the review state and the person''s own answer. The self entry stands for the engaged person. Written only by the roster RPCs; never a project membership and never counted toward plan limits.', array[
  'org_id', 'Producing org, derived from the engagement.',
  'engagement_id', 'Engagement the person works under.',
  'is_self', 'True for the engaged person''s own entry, whose person is app.engagements.person_id.',
  'person_id', 'Rostered person; NULL on the self entry (read the engagement''s person) and on an unclaimed invitation.',
  'role_code', 'Role the person works, from the Roles Library; NULL when not yet chosen. Never copied from the engagement.',
  'arrival_window', 'When the person arrives on site, as a bounded range; NULL when not yet known.',
  'arrival_time_zone', 'IANA time zone of the arrival window.',
  'replaces_entry_id', 'Withdrawn entry of the same engagement this one replaces (a swap after acceptance).',
  'entry_state', 'Draft, Submitted, Accepted, Returned or Withdrawn. The return reason and the reviewer are in app.roster_entry_state_transitions.',
  'person_response', 'Pending, Accepted or Declined: the person''s own answer.',
  'responded_at', 'When the person last answered; NULL while Pending.'
]);

-- Rosterable (ADR 0101 decision 8) -------------------------------------------------------------------------------------------

create or replace function private.engagement_rosterable(p_role_type app.external_role_type, p_counterparty_id uuid)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_role_type = 'Artist' or (p_counterparty_id is not null and p_role_type in ('Vendor', 'Contractor', 'Staff', 'Sponsor'));
$$;

comment on function private.engagement_rosterable(app.external_role_type, uuid) is 'ADR 0101 decision 8: an engagement carries a roster beyond its self entry when it is an Artist engagement or a company engagement (counterparty set) of a Vendor, Contractor, Staff or Sponsor. Client never. Takes column values.';
revoke all on function private.engagement_rosterable(app.external_role_type, uuid) from public, anon;
grant execute on function private.engagement_rosterable(app.external_role_type, uuid) to authenticated, service_role;

-- Lifecycle ----------------------------------------------------------------------------------------------------------------

call private.install_lifecycle('app.engagement_roster_entries', 'roster_entry_id', 'entry_state', 'roster_entry', 'Draft',
  $$roster_entry_id in (select r.id from app.engagement_roster_entries r join app.engagements e on e.id = r.engagement_id
      where e.project_id in (select private.project_ids_with('advancing.packet.read'))
        or e.project_id in (select private.project_ids_with('opportunities.engagement.read')))$$);

insert into private.lifecycle_transition_rules (lifecycle, from_state, to_state) values
  ('roster_entry', 'Draft', 'Submitted'),
  ('roster_entry', 'Draft', 'Withdrawn'),
  ('roster_entry', 'Submitted', 'Accepted'),
  ('roster_entry', 'Submitted', 'Returned'),
  ('roster_entry', 'Submitted', 'Withdrawn'),
  ('roster_entry', 'Returned', 'Submitted'),
  ('roster_entry', 'Returned', 'Withdrawn'),
  ('roster_entry', 'Accepted', 'Withdrawn');

call private.install_default_retention('app.roster_entry_state_transitions');

-- Guard --------------------------------------------------------------------------------------------------------------------

create or replace function private.guard_roster_entry()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_engagement app.engagements;
begin
  if tg_op = 'UPDATE' and (new.engagement_id <> old.engagement_id or new.is_self <> old.is_self) then
    perform private.refuse('roster_entry_immutable', 'A roster entry keeps its engagement; withdraw it and add another.');
  end if;
  if new.deleted_at is not null and tg_op = 'UPDATE' and old.deleted_at is null then
    return new;
  end if;
  select * into v_engagement from app.engagements e where e.id = new.engagement_id and e.deleted_at is null;
  if v_engagement.id is null then
    perform private.refuse('roster_engagement_missing', 'A roster entry belongs to a live engagement.');
  end if;
  if tg_op = 'INSERT' then
    if v_engagement.role_type = 'Client' or (new.is_self and v_engagement.role_type = 'Sponsor') then
      perform private.refuse('roster_role_type', 'This engagement carries no roster.');
    end if;
    if new.is_self then
      if not private.in_trusted_operation('roster_self_entry') or v_engagement.person_id is null then
        perform private.refuse('roster_self_entry_internal', 'The engaged person''s own entry is created with the engagement.');
      end if;
    elsif not private.engagement_rosterable(v_engagement.role_type, v_engagement.counterparty_id) then
      perform private.refuse('roster_role_type', 'Only artist engagements and the company engagements of a vendor, contractor, staffing company or sponsor carry a roster.');
    end if;
  end if;
  if new.person_id is not null and new.person_id = v_engagement.person_id then
    perform private.refuse('roster_person_is_engaged', 'The engaged person is on the roster through their own entry.');
  end if;
  if tg_op = 'UPDATE' and new.person_id is distinct from old.person_id
     and not (old.person_id is null and not new.is_self and private.in_trusted_operation('roster_invitation_claim')) then
    perform private.refuse('roster_person_immutable', 'A roster entry keeps its person; withdraw it and add another.');
  end if;
  if new.replaces_entry_id is not null and (tg_op = 'INSERT' or new.replaces_entry_id is distinct from old.replaces_entry_id)
     and not exists (select 1 from app.engagement_roster_entries r
                     where r.id = new.replaces_entry_id and r.engagement_id = new.engagement_id and r.entry_state = 'Withdrawn'
                       and r.id <> new.id) then
    perform private.refuse('roster_replacement_invalid', 'A replacement names a withdrawn entry of the same engagement.');
  end if;
  if tg_op = 'UPDATE' and not new.is_self and old.entry_state not in ('Draft', 'Returned')
     and (new.role_code is distinct from old.role_code or new.arrival_window is distinct from old.arrival_window
       or new.arrival_time_zone is distinct from old.arrival_time_zone) then
    perform private.refuse('roster_entry_not_editable', 'Change a roster entry while it is a draft or returned.');
  end if;
  perform private.assert_time_zone(new.arrival_time_zone);
  return new;
end;
$$;

comment on function private.guard_roster_entry() is 'Roster entries: on a live engagement; never on a Client engagement, a self entry never on a Sponsor one, any other entry only on a rosterable engagement; the self entry only from its trusted operation and only when the engagement names a person; never the engaged person; engagement and self flag fixed; the person fixed except an invitation claimed; a replacement names a withdrawn entry of the engagement; role and arrival change only while Draft or Returned, except on the self entry; a known time zone.';
revoke all on function private.guard_roster_entry() from public, anon, authenticated;

create trigger t40_guard_roster_entry before insert or update on app.engagement_roster_entries
  for each row execute function private.guard_roster_entry();

-- Reads --------------------------------------------------------------------------------------------------------------------

call private.install_policies('app.engagement_roster_entries',
  $$engagement_id in (select e.id from app.engagements e
      where e.project_id in (select private.project_ids_with('advancing.packet.read'))
        or e.project_id in (select private.project_ids_with('opportunities.engagement.read')))$$);
revoke insert, update on app.engagement_roster_entries from authenticated;
call private.install_default_retention('app.engagement_roster_entries');
call private.install_audit_trail('app.engagement_roster_entries');

insert into private.trash_excluded_tables (table_name, rationale) values
  ('engagement_roster_entries', 'A roster entry is withdrawn through its lifecycle, never deleted; a removed entry is added again.')
on conflict (table_name) do nothing;

-- The resolver (ADR 0101 decision 4) --------------------------------------------------------------------------------------

create view private.roster_people as
select r.id as roster_entry_id, r.engagement_id, case when r.is_self then e.person_id else r.person_id end as person_id
from app.engagement_roster_entries r
join app.engagements e on e.id = r.engagement_id;

comment on view private.roster_people is 'Unfiltered resolver of roster entries to people (ADR 0101): the self entry resolves to the engagement''s person, every other entry to its own. Read only inside definer functions; R5, R7, R9, R11 and R12 build on it.';
comment on column private.roster_people.roster_entry_id is 'Roster entry.';
comment on column private.roster_people.engagement_id is 'Engagement of the entry.';
comment on column private.roster_people.person_id is 'Resolved person; NULL for an unclaimed invitation.';
revoke all on private.roster_people from public, anon, authenticated;
grant select on private.roster_people to service_role;
revoke select on private.roster_people from xos_backup;

create or replace function private.roster_entry_person(p_roster_entry_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.person_id from private.roster_people p where p.roster_entry_id = p_roster_entry_id;
$$;

comment on function private.roster_entry_person(uuid) is 'The person a roster entry resolves to (private.roster_people); NULL for an unclaimed invitation.';
revoke all on function private.roster_entry_person(uuid) from public, anon, authenticated;

-- Live lists (as 1450 and 2170) ---------------------------------------------------------------------------------------------

do $$
declare
  v_table text;
begin
  if not exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime') then
    return;
  end if;
  foreach v_table in array array['engagement_roster_entries', 'account_engagement_assignments'] loop
    if not exists (
      select 1 from pg_catalog.pg_publication_tables p
      where p.pubname = 'supabase_realtime' and p.schemaname = 'app' and p.tablename = v_table
    ) then
      execute format('alter publication supabase_realtime add table app.%I', v_table);
    end if;
  end loop;
end $$;

select private.sync_trash_tables();
