-- 2944_local_contacts.sql
-- B5 Travel, lodging, ground transport and local contacts (RRR-229, ADR 0144 decision 4; parity gap G-56). Local
-- contacts in one home: the promoter's rep, the venue's production manager, the car service dispatcher, the house
-- doctor. Each row belongs to a project (for every day, or for one day) or to a venue (for every project there).
--
--   * A Contact row carries a typed name, title, business phone (E.164) and email. A Member row names a membership of the
--     org and copies nothing: the member's current name and their directory work phone (the personal setting
--     workforce.work_phone, read as 1632's app.workforce_directory reads it) are read live, so a change of either
--     changes every list at once, and the work phone is NULL once the membership ends.
--   * Audience Internal stays inside the org. Shared rows also reach the people engaged on the project, or on an
--     operational roster of it, through api_external.local_contacts; a Member row reaches them with its name and title
--     only, never the work phone or an email. The member's work phone never leaves the org.
--   * org_id is stamped from the project or the venue before t10, as private.stamp_allocation_project does (2691).
--     Policies are installed with private.install_policies, because a table without a parent gets none:
--       read: show.run_of_show.read on the project, or for a venue row places.venue.read in its org or
--             show.run_of_show.read on a project at the venue;
--       write: show.day_sheet.write on the project, or for a venue row places.venue.write in its org.
--   * phone and email are in private.personal_data_keys, so audit diffs redact them, and are registered Confidential
--     with their sources on app.project_local_contacts, so any export classifies them (2030).
-- Trash: app.local_contacts has no title column (private.trash_title_column), so a deleted contact is not in Trash; it
-- is added again.

create type app.local_contact_role as enum ('Promoter', 'Venue', 'Production', 'Security', 'Transport', 'Hospitality', 'Medical', 'Other');
comment on type app.local_contact_role is 'What a local contact is called for: Promoter, Venue, Production, Security, Transport, Hospitality, Medical or Other.';
create type app.local_contact_audience as enum ('Internal', 'Shared');
comment on type app.local_contact_audience is 'Internal stays inside the org; Shared also reaches the people engaged or rostered on the project.';

create table app.local_contacts (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references app.organizations (id),
  project_id uuid references app.projects (id),
  venue_id uuid references app.venues (id),
  day date,
  membership_id uuid references app.memberships (id),
  counterparty_id uuid references app.counterparties (id),
  contact_name text,
  contact_title text,
  phone text,
  email text,
  contact_role app.local_contact_role not null,
  audience app.local_contact_audience not null default 'Internal',
  notes text,
  deleted_at timestamptz,
  constraint local_contacts_one_home check (num_nonnulls(project_id, venue_id) = 1),
  constraint local_contacts_day_on_project check (day is null or project_id is not null),
  constraint local_contacts_member_or_name check ((membership_id is null) <> (contact_name is null)),
  constraint local_contacts_member_copies_nothing check (membership_id is null or (phone is null and email is null and counterparty_id is null)),
  constraint local_contacts_name_length check (contact_name is null or char_length(btrim(contact_name)) between 1 and 120),
  constraint local_contacts_title_length check (contact_title is null or char_length(btrim(contact_title)) between 1 and 120),
  constraint local_contacts_phone_format check (phone is null or phone ~ '^\+[1-9][0-9]{6,14}$'),
  constraint local_contacts_email_format check (email is null or (email = lower(email) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  constraint local_contacts_notes_length check (notes is null or char_length(btrim(notes)) between 1 and 500)
);

create index local_contacts_project_id_idx on app.local_contacts (project_id, day);
create index local_contacts_venue_id_idx on app.local_contacts (venue_id);
create index local_contacts_membership_id_idx on app.local_contacts (membership_id);
create index local_contacts_counterparty_id_idx on app.local_contacts (counterparty_id);

-- org_id comes from the project or the venue, before t10 to t30 read it.
create or replace function private.stamp_local_contact_org()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
begin
  if new.project_id is not null then
    select p.org_id into v_org from app.projects p where p.id = new.project_id;
  else
    select v.org_id into v_org from app.venues v where v.id = new.venue_id;
  end if;
  if tg_op = 'UPDATE' and v_org is distinct from old.org_id then
    perform private.refuse('local_contact_org_fixed', 'A local contact stays in its org.');
  end if;
  new.org_id := coalesce(v_org, new.org_id);
  return new;
end;
$$;

comment on function private.stamp_local_contact_org() is 'Before insert or update trigger: stamps a local contact''s org from its project or venue; a contact never moves to another org (local_contact_org_fixed).';
revoke all on function private.stamp_local_contact_org() from public, anon, authenticated;
create trigger t05_stamp_local_contact_org before insert or update on app.local_contacts
  for each row execute function private.stamp_local_contact_org();

-- Venues of the projects whose day sheets the reader reads. Projects are read with projects.project.read (0301), which a
-- day-sheet reader may not hold, so the policy reads them here.
create or replace function private.show_reader_venue_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select distinct p.venue_id from app.projects p
  where p.venue_id is not null and p.deleted_at is null and p.id in (select private.project_ids_with('show.run_of_show.read'));
$$;

comment on function private.show_reader_venue_ids() is 'Venues of the live projects on which the signed-in person holds show.run_of_show.read: the venue contacts their day sheets list.';
revoke all on function private.show_reader_venue_ids() from public, anon;
-- Policies run with the caller's execute privilege.
grant execute on function private.show_reader_venue_ids() to authenticated, service_role;

call private.install_domain_table('app.local_contacts', null, null,
  array['app.projects', 'project_id', 'app.venues', 'venue_id', 'app.memberships', 'membership_id', 'app.counterparties', 'counterparty_id']);
call private.install_policies('app.local_contacts',
  $$project_id in (select private.project_ids_with('show.run_of_show.read'))
    or venue_id in (select v.id from app.venues v where v.org_id in (select private.orgs_with_capability('places.venue.read')))
    or venue_id in (select private.show_reader_venue_ids())$$,
  $$project_id in (select private.project_ids_with('show.day_sheet.write'))
    or (project_id is null and org_id in (select private.orgs_with_capability('places.venue.write')))$$);
call private.describe('app.local_contacts', 'Local contacts of a project (every day, or one day) or of a venue (every project there) (B5, G-56): a member of the org, whose name and directory work phone are read live and never copied, or a typed contact with a business phone and email. Shared rows also reach the people engaged or rostered on the project (api_external.local_contacts), a member''s with name and title only.', array[
  'org_id', 'Owning org, stamped from the project or the venue; never changed.',
  'project_id', 'Project the contact serves; NULL for a venue contact.',
  'venue_id', 'Venue the contact serves for every project there; NULL for a project contact.',
  'day', 'Project day the contact serves; NULL for every day. Only on a project contact, within the project''s dates.',
  'membership_id', 'Member of the org this row names; their name and work phone are read live. NULL for a typed contact.',
  'counterparty_id', 'Organization a typed contact works for, when it is a counterparty of the org.',
  'contact_name', 'Name of a typed contact; NULL for a member.',
  'contact_title', 'Title or job, such as Production Manager.',
  'phone', 'Business phone of a typed contact in E.164 (+15551234567); NULL for a member. Confidential.',
  'email', 'Business email of a typed contact, lowercase; NULL for a member. Confidential.',
  'contact_role', 'Promoter, Venue, Production, Security, Transport, Hospitality, Medical or Other.',
  'audience', 'Internal stays inside the org; Shared also reaches the people engaged or rostered on the project.',
  'notes', 'Notes for the org; never shared.'
]);

insert into private.column_classifications (table_name, column_name, classification, read_capability) values
  ('app.local_contacts', 'phone', 'Confidential', null),
  ('app.local_contacts', 'email', 'Confidential', null)
on conflict (table_name, column_name) do nothing;

create or replace function private.guard_local_contact()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_starts date;
  v_ends date;
begin
  if new.deleted_at is not null then
    return new;
  end if;
  if new.membership_id is not null and not exists (
      select 1 from app.memberships m
      where m.id = new.membership_id and m.org_id = new.org_id and m.deleted_at is null and m.valid_from <= now()
        and (m.valid_to is null or m.valid_to > now())) then
    perform private.refuse('local_contact_member', 'A member contact names an active member of the org.');
  end if;
  if new.day is not null then
    select p.starts_on, p.ends_on into v_starts, v_ends from app.projects p where p.id = new.project_id;
    if (v_starts is not null and new.day < v_starts) or (v_ends is not null and new.day > v_ends) then
      perform private.refuse('local_contact_day_outside_project', 'The day falls outside the project''s dates.');
    end if;
  end if;
  return new;
end;
$$;

comment on function private.guard_local_contact() is 'A live member contact names an active member of the row''s org (local_contact_member), and a day contact falls within the project''s starts_on to ends_on where those are set (local_contact_day_outside_project).';
revoke all on function private.guard_local_contact() from public, anon, authenticated;
create trigger t40_guard_local_contact before insert or update on app.local_contacts
  for each row execute function private.guard_local_contact();

-- Live member values ---------------------------------------------------------------------------------------------------

create or replace function private.member_work_phone(p_membership_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select (select psv.value_text from app.personal_setting_values psv
          where psv.person_id = m.person_id and psv.setting_key = 'workforce.work_phone' and psv.deleted_at is null
            and (psv.org_id is null or psv.org_id = m.org_id)
          order by psv.org_id nulls last limit 1)
  from app.memberships m
  where m.id = p_membership_id and m.deleted_at is null and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
    and m.org_id in (select private.my_org_ids());
$$;

comment on function private.member_work_phone(uuid) is 'The directory work phone of an active member (the personal setting workforce.work_phone, the org''s value before the person''s own, as app.workforce_directory reads it, 1632), for a reader in the membership''s org; NULL once the membership has ended and for anyone outside the org.';
revoke all on function private.member_work_phone(uuid) from public, anon;
-- Function calls inside a view run with the caller's execute privilege, so signed-in users need these.
grant execute on function private.member_work_phone(uuid) to authenticated, service_role;

create or replace function private.member_contact(p_membership_id uuid)
returns table (full_name text, is_active boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select pe.full_name, m.deleted_at is null and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
  from app.memberships m
  join app.people pe on pe.id = m.person_id
  where m.id = p_membership_id and m.org_id in (select private.my_org_ids());
$$;

comment on function private.member_contact(uuid) is 'The current name of the member a contact row names and whether the membership is still active, for a reader in the membership''s org; no row for anyone else.';
revoke all on function private.member_contact(uuid) from public, anon;
grant execute on function private.member_contact(uuid) to authenticated, service_role;

-- What the org reads ---------------------------------------------------------------------------------------------------

-- The projects a venue row is listed for: live projects at the venue the reader may see the day sheets of. Projects are
-- read with projects.project.read (0301), which a day-sheet reader may not hold, so the view expands venue rows here.
create or replace function private.venue_contact_project_ids(p_venue_id uuid)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.id from app.projects p
  where p.venue_id = p_venue_id and p.deleted_at is null
    and (p.id in (select private.project_ids_with('show.run_of_show.read')) or p.id in (select private.readable_project_ids()));
$$;

comment on function private.venue_contact_project_ids(uuid) is 'Live projects at the venue the signed-in person reads day sheets of (show.run_of_show.read) or may read: the projects a venue contact is listed for.';
revoke all on function private.venue_contact_project_ids(uuid) from public, anon;
grant execute on function private.venue_contact_project_ids(uuid) to authenticated, service_role;

create view app.project_local_contacts with (security_invoker = on) as
with homes as (
  select c.*, c.project_id as for_project_id from app.local_contacts c where c.deleted_at is null and c.project_id is not null
  union all
  select c.*, x.project_id as for_project_id
  from app.local_contacts c
  cross join lateral private.venue_contact_project_ids(c.venue_id) x (project_id)
  where c.deleted_at is null and c.venue_id is not null
)
select h.id, h.org_id, h.for_project_id as project_id, h.venue_id, h.day, h.contact_role, h.contact_title,
  case when h.membership_id is null then 'Contact' else 'Member' end as source,
  h.membership_id,
  coalesce(mc.full_name, h.contact_name) as display_name,
  case when h.membership_id is null then o.name else org.name end as organization_name,
  case when h.membership_id is null then h.phone else private.member_work_phone(h.membership_id) end as phone,
  h.email,
  h.audience,
  case when h.membership_id is null then true else coalesce(mc.is_active, false) end as member_active,
  h.notes
from homes h
left join lateral private.member_contact(h.membership_id) mc on h.membership_id is not null
left join app.counterparties cp on cp.id = h.counterparty_id
left join app.organizations o on o.id = cp.organization_id
left join app.organizations org on org.id = h.org_id;

call private.describe('app.project_local_contacts', 'Local contacts by project (B5, G-56): the project''s own rows, and each venue row once for every live project at that venue. A member row shows the member''s current name and directory work phone, read live. Rows follow the contacts'' policies; the expansion follows the projects the reader may read.', array[
  'id', 'Local contact.',
  'org_id', 'Owning org.',
  'project_id', 'Project the row is listed for.',
  'venue_id', 'Venue of a venue contact; NULL for a project contact.',
  'day', 'Project day the contact serves; NULL for every day.',
  'contact_role', 'What the contact is called for.',
  'contact_title', 'Title or job.',
  'source', 'Member (a member of the org, read live) or Contact (typed).',
  'membership_id', 'Membership of a member contact.',
  'display_name', 'The member''s current name, or the typed contact name.',
  'organization_name', 'The typed contact''s organization (its counterparty), or the org for a member.',
  'phone', 'The typed business phone, or the member''s directory work phone while the membership is active. Confidential.',
  'email', 'The typed business email; NULL for a member. Confidential.',
  'audience', 'Internal or Shared.',
  'member_active', 'False once a member contact''s membership has ended; true for typed contacts. Lists leave ended members out by default.',
  'notes', 'Notes for the org.'
]);

insert into private.view_column_sources (view_name, column_name, source_table, source_column) values
  ('app.project_local_contacts', 'phone', 'app.local_contacts', 'phone'),
  ('app.project_local_contacts', 'email', 'app.local_contacts', 'email')
on conflict do nothing;

revoke all on app.project_local_contacts from public, anon;
grant select on app.project_local_contacts to authenticated, service_role;
-- 1650 grants the backup login SELECT on every new relation; pg_dump never reads a view's rows.
revoke select on app.project_local_contacts from xos_backup;

-- What people outside the org read --------------------------------------------------------------------------------------

create or replace view api_external.local_contacts as
with homes as (
  select c.*, c.project_id as for_project_id from app.local_contacts c
  where c.deleted_at is null and c.audience = 'Shared' and c.project_id is not null
  union all
  select c.*, p.id as for_project_id
  from app.local_contacts c
  join app.projects p on p.venue_id = c.venue_id and p.deleted_at is null
  where c.deleted_at is null and c.audience = 'Shared' and c.venue_id is not null
)
select h.id, h.for_project_id as project_id, h.day, h.contact_role, h.contact_title,
  coalesce(pe.full_name, h.contact_name) as display_name,
  case when h.membership_id is null then o.name else org.name end as organization_name,
  case when h.membership_id is null then h.phone end as phone,
  case when h.membership_id is null then h.email end as email,
  case when h.membership_id is null then 'Contact' else 'Member' end as source
from homes h
left join app.memberships m on m.id = h.membership_id
left join app.people pe on pe.id = m.person_id
left join app.counterparties cp on cp.id = h.counterparty_id
left join app.organizations o on o.id = cp.organization_id
left join app.organizations org on org.id = h.org_id
where (h.membership_id is null or (m.deleted_at is null and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())))
  and (private.is_engaged_party(h.for_project_id)
    or exists (select 1 from app.engagement_roster_entries r
               join app.engagements e on e.id = r.engagement_id
               where r.id in (select private.my_roster_entry_ids('operational')) and e.project_id = h.for_project_id));

comment on view api_external.local_contacts is 'Shared local contacts of the projects the caller works on outside the org (B5, G-56): through an engagement in the operational area (their own, their account''s or a represented artist''s) or an operational roster entry. A typed contact carries its business phone and email; a member contact carries its name and title only, never the work phone or an email. Internal rows and notes never appear.';

revoke all on api_external.local_contacts from public, anon;
grant select on api_external.local_contacts to authenticated, service_role;

-- Retention and Trash --------------------------------------------------------------------------------------------------

call private.install_default_retention('app.local_contacts');

select private.sync_trash_tables();
