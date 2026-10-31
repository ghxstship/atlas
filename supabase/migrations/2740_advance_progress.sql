-- 2740_advance_progress.sql
-- R11 Advancing heatmap (RRR-192; Section 11.11, ADR 0100 and 0103; owner decisions 4, 5 and 8). Every outstanding
-- advancing item on one screen: who has answered which section, how ready each person on a roster is, and where each
-- party's allocations stand. Everything here is computed from the rows that own each state and nothing is stored.
--
--   1. app.advance_progress (security_invoker): one row per live sent packet, live recipient and live section, with
--      the latest answer and its cell_state (Missing, Awaiting Review, Accepted, Returned, Complete or Not
--      Applicable) and overdue. A Crew Roster section is Complete from the recipient engagement's roster, never
--      answered; a Guest List section is Not Applicable for a Contractor or Sponsor engagement.
--   2. app.roster_readiness(project): a person-by-category grid of each live roster entry, with states only (On File,
--      Missing, Not Shared, Shared, Submitted, Not Offered, Hidden and the person's answer). No value leaves the
--      database, so nothing is logged; each category is Hidden from a reader without its capability.
--   3. app.advance_allocation_heat (security_invoker): R7's app.advance_allocation_status summed by engagement, party
--      and offering (owner decision 8: no rollup is stored).
--   4. app.advance_submissions and app.engagement_roster_entries join the supabase_realtime publication (1450), so
--      the heatmap follows answers and roster changes live.
--   5. app.advance_recipients and app.advance_sections become field history subjects (A131), with audit trails.
-- The definer helpers name parties only for readers of the project's packets, so a person's name never depends on
-- the reader's people policies, and they never answer for anyone else.

-- Helpers (column values in, ADR 0016 item 14) ------------------------------------------------------------------------

create or replace function private.advance_party_label(p_project_id uuid, p_person_id uuid, p_counterparty_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case when private.can_on_project(p_project_id, 'advancing.packet.read')
      or private.can_on_project(p_project_id, 'opportunities.engagement.read') then
    coalesce(
      (select p.full_name from app.people p where p.id = p_person_id),
      (select o.name from app.counterparties c join app.organizations o on o.id = c.organization_id where c.id = p_counterparty_id))
  end;
$$;

comment on function private.advance_party_label(uuid, uuid, uuid) is 'R11: the name an advancing grid shows for a person (their full name) or a counterparty (its organization''s name), only for a caller who reads the project''s packets or engagements (advancing.packet.read or opportunities.engagement.read); NULL for anyone else. Takes column values.';
revoke all on function private.advance_party_label(uuid, uuid, uuid) from public, anon;
-- Function calls inside a security_invoker view run with the caller's execute privilege.
grant execute on function private.advance_party_label(uuid, uuid, uuid) to authenticated, service_role;

create or replace function private.advance_engagement_label(p_engagement_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select private.advance_party_label(e.project_id, e.person_id, e.counterparty_id)
  from app.engagements e where e.id = p_engagement_id;
$$;

comment on function private.advance_engagement_label(uuid) is 'R11: the party an engagement is with (the engaged person, or the counterparty''s organization), named as private.advance_party_label names it.';
revoke all on function private.advance_engagement_label(uuid) from public, anon;
grant execute on function private.advance_engagement_label(uuid) to authenticated, service_role;

create or replace function private.advance_section_cell(p_section_kind app.advance_section_kind, p_engagement_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p_section_kind = 'Crew Roster' then
      case when exists (
          select 1 from app.engagement_roster_entries r
          where r.engagement_id = p_engagement_id and r.deleted_at is null and r.entry_state <> 'Withdrawn')
        and not exists (
          select 1 from app.engagement_roster_entries r
          where r.engagement_id = p_engagement_id and r.deleted_at is null and r.entry_state in ('Draft', 'Returned'))
      then 'Complete' else 'Missing' end
    when p_section_kind = 'Guest List' and exists (
        select 1 from app.engagements e where e.id = p_engagement_id and e.role_type in ('Contractor', 'Sponsor'))
      then 'Not Applicable'
  end;
$$;

comment on function private.advance_section_cell(app.advance_section_kind, uuid) is 'R11: the cell state a section kind takes from the recipient''s engagement rather than from an answer: a Crew Roster section is Complete when the engagement has at least one live entry and none is Draft or Returned, else Missing; a Guest List section is Not Applicable for a Contractor or Sponsor engagement; NULL for every other kind, which reads its latest answer. Says nothing about who is on the roster. Takes column values.';
revoke all on function private.advance_section_cell(app.advance_section_kind, uuid) from public, anon;
grant execute on function private.advance_section_cell(app.advance_section_kind, uuid) to authenticated, service_role;

-- 1. Packets ------------------------------------------------------------------------------------------------------------

create view app.advance_progress with (security_invoker = on) as
select p.org_id, p.project_id, p.id as advance_packet_id, p.title as packet_title, p.due_at,
  r.id as advance_recipient_id, r.engagement_id as recipient_engagement_id,
  private.advance_party_label(p.project_id, r.person_id, r.counterparty_id) as recipient_label,
  s.id as advance_section_id, s.position, s.title as section_title, s.section_kind,
  l.id as latest_submission_id, l.submitted_at, c.cell_state,
  coalesce(p.due_at < now() and c.cell_state in ('Missing', 'Returned'), false) as overdue
from app.advance_packets p
join app.advance_recipients r on r.advance_packet_id = p.id and r.deleted_at is null
join app.advance_sections s on s.advance_packet_id = p.id and s.deleted_at is null
left join lateral (
  select x.id, x.submitted_at, x.review_outcome
  from app.advance_submissions x
  where x.advance_section_id = s.id and x.advance_recipient_id = r.id and x.deleted_at is null
  order by x.submitted_at desc, x.id desc limit 1
) l on true
cross join lateral (
  select coalesce(private.advance_section_cell(s.section_kind, r.engagement_id),
    case when l.id is null then 'Missing' when l.review_outcome is null then 'Awaiting Review' else l.review_outcome::text end)
    as cell_state
) c
where p.deleted_at is null and p.sent_at is not null;

call private.describe('app.advance_progress', 'Where every recipient of every sent advance packet stands on each section (R11, Section 11.11): one row per live sent packet, live recipient and live section, computed from the answers and never stored. Runs with the caller''s policies, so only readers of the project''s packets see rows.', array[
  'org_id', 'Org that sent the packet.',
  'project_id', 'Project of the packet.',
  'advance_packet_id', 'Packet.',
  'packet_title', 'Packet title.',
  'due_at', 'When the packet is due; NULL without a due date.',
  'advance_recipient_id', 'Recipient.',
  'recipient_engagement_id', 'Engagement the recipient answers under (R9); NULL when none is linked.',
  'recipient_label', 'The recipient''s name: the person''s full name, or the counterparty''s organization name.',
  'advance_section_id', 'Section.',
  'position', 'Order of the section in the packet.',
  'section_title', 'Section title.',
  'section_kind', 'Text, File, Schedule Window, Item Request, Crew Roster, Guest List or Credential Request.',
  'latest_submission_id', 'The recipient''s latest answer to the section; NULL when none was given.',
  'submitted_at', 'When the latest answer was given.',
  'cell_state', 'Missing, Awaiting Review, Accepted, Returned, Complete (a Crew Roster with every entry past review) or Not Applicable (a Guest List for a Contractor or Sponsor).',
  'overdue', 'True when the packet is past due and the section is Missing or Returned.'
]);

revoke all on app.advance_progress from public, anon;
grant select on app.advance_progress to authenticated, service_role;
revoke select on app.advance_progress from xos_backup;

-- 2. Crew readiness ---------------------------------------------------------------------------------------------------------

create or replace function app.roster_readiness(p_project_id uuid)
returns table (
  roster_entry_id uuid,
  engagement_id uuid,
  party_label text,
  person_label text,
  role_code text,
  entry_state app.roster_entry_state,
  category text,
  cell_state text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_contact boolean;
  v_emergency boolean;
  v_dietary boolean;
  v_accessibility boolean;
  v_passport boolean;
  v_medical boolean;
  v_uniform boolean;
  v_travel boolean;
  v_vehicle boolean;
begin
  perform private.require_person();
  if p_project_id is null or not (private.can_on_project(p_project_id, 'advancing.packet.read')
      or private.can_on_project(p_project_id, 'opportunities.engagement.read')) then
    raise exception using errcode = '42501', message = 'the crew readiness of this project is not readable';
  end if;
  v_contact := private.can_read_work_detail_category(p_project_id, 'Contact');
  v_emergency := private.can_read_work_detail_category(p_project_id, 'Emergency Contacts');
  v_dietary := private.can_read_work_detail_category(p_project_id, 'Dietary Needs');
  v_accessibility := private.can_read_work_detail_category(p_project_id, 'Accessibility Needs');
  v_passport := private.can_read_work_detail_category(p_project_id, 'Passport');
  v_medical := private.can_on_project(p_project_id, 'data.restricted.read.medical');
  v_uniform := private.can_read_project_fact_kind(p_project_id, 'Uniform');
  v_travel := private.can_read_project_fact_kind(p_project_id, 'Travel');
  v_vehicle := private.can_read_project_fact_kind(p_project_id, 'Vehicle');

  return query
  with entries as (
    select r.id, r.engagement_id, r.role_code, r.entry_state, r.person_response,
      private.roster_entry_person_id(r.is_self, r.person_id, e.person_id) as person_id,
      private.advance_party_label(e.project_id, e.person_id, e.counterparty_id) as party_label,
      r.is_self, r.created_at
    from app.engagement_roster_entries r
    join app.engagements e on e.id = r.engagement_id and e.deleted_at is null
    where e.project_id = p_project_id and r.deleted_at is null and r.entry_state <> 'Withdrawn'
  ),
  facts as (
    select x.*, p.full_name as person_label,
      coalesce(s.categories, '{}'::app.work_detail_category[]) as shared,
      w.person_id is not null as has_details,
      coalesce(cardinality(w.dietary_needs) > 0 or w.dietary_notes is not null, false) as dietary_on_file,
      coalesce(cardinality(w.accessibility_needs) > 0 or w.accessibility_notes is not null, false) as accessibility_on_file,
      exists (select 1 from app.person_emergency_contacts c where c.person_id = x.person_id and c.deleted_at is null) as emergency_on_file,
      x.person_id is not null and (private.recipient_address(x.person_id, 'Email') is not null
        or private.recipient_address(x.person_id, 'SMS') is not null) as contact_on_file,
      private.project_fact_offered(x.engagement_id, 'Travel') as travel_offered,
      private.project_fact_offered(x.engagement_id, 'Uniforms') as uniforms_offered,
      private.project_fact_offered(x.engagement_id, 'Parking') as parking_offered,
      exists (select 1 from app.roster_travel_requests t where t.roster_entry_id = x.id and t.deleted_at is null) as has_travel,
      exists (select 1 from app.roster_uniform_sizes u where u.roster_entry_id = x.id and u.deleted_at is null) as has_uniform,
      exists (select 1 from app.roster_vehicles v where v.roster_entry_id = x.id and v.deleted_at is null) as has_vehicle
    from entries x
    left join app.people p on p.id = x.person_id
    left join app.work_detail_shares s on s.roster_entry_id = x.id and s.revoked_at is null and s.deleted_at is null
    left join app.person_work_details w on w.person_id = x.person_id and w.deleted_at is null
  )
  select f.id, f.engagement_id, f.party_label, f.person_label, f.role_code, f.entry_state, g.category, g.cell_state
  from facts f
  cross join lateral (values
    (1, 'Acceptance', case f.person_response when 'Accepted' then 'Accepted' when 'Declined' then 'Declined' else 'Awaiting Person' end),
    (2, 'Contact', case when not v_contact then 'Hidden' when not ('Contact' = any (f.shared)) then 'Not Shared'
      when f.contact_on_file then 'On File' else 'Missing' end),
    (3, 'Emergency Contacts', case when not v_emergency then 'Hidden' when not ('Emergency Contacts' = any (f.shared)) then 'Not Shared'
      when f.emergency_on_file then 'On File' else 'Missing' end),
    (4, 'Dietary Needs', case when not v_dietary then 'Hidden' when not ('Dietary Needs' = any (f.shared)) then 'Not Shared'
      when f.dietary_on_file then 'On File' else 'Missing' end),
    (5, 'Accessibility Needs', case when not v_accessibility then 'Hidden' when not ('Accessibility Needs' = any (f.shared)) then 'Not Shared'
      when f.accessibility_on_file then 'On File' else 'Missing' end),
    -- Owner decision 5: whether an allergy exists never shows, only whether the person shares the category it lives in.
    (6, 'Allergies', case when not v_medical then 'Hidden' when 'Dietary Needs' = any (f.shared) then 'Shared' else 'Not Shared' end),
    (7, 'Passport', case when not v_passport then 'Hidden' when not f.travel_offered then 'Not Offered'
      when 'Passport' = any (f.shared) then 'Shared' else 'Not Shared' end),
    (8, 'Uniform', case when not v_uniform then 'Hidden' when not f.uniforms_offered then 'Not Offered'
      when f.has_uniform then 'Submitted' else 'Missing' end),
    (9, 'Travel', case when not v_travel then 'Hidden' when not f.travel_offered then 'Not Offered'
      when f.has_travel then 'Submitted' else 'Missing' end),
    (10, 'Vehicle', case when not v_vehicle then 'Hidden' when not f.parking_offered then 'Not Offered'
      when f.has_vehicle then 'Submitted' else 'Missing' end)
  ) as g (sort, category, cell_state)
  order by f.party_label nulls last, f.is_self desc, f.person_label nulls last, f.created_at, f.id, g.sort;
end;
$$;

comment on function app.roster_readiness(uuid) is 'R11 crew readiness (Section 11.11; owner decisions 4 and 5): for each live, non-Withdrawn roster entry on the project, one row per category with its state only. Acceptance is Accepted, Awaiting Person or Declined. Contact, Emergency Contacts, Dietary Needs and Accessibility Needs are Not Shared, On File or Missing, for readers of the category (private.work_detail_category_capabilities). Allergies are Shared or Not Shared (whether the person shares Dietary Needs, never whether an allergy exists), only for holders of data.restricted.read.medical. Passport is Shared or Not Shared, or Not Offered without travel. Uniform, Travel and Vehicle are Submitted or Missing, or Not Offered when the offering is off, for readers of the project fact kind. A category the caller may not read is Hidden. No value column: no Confidential or Restricted value leaves the database, so nothing is logged. Refuses 42501 unless the caller holds advancing.packet.read or opportunities.engagement.read on the project.';
revoke all on function app.roster_readiness(uuid) from public, anon;
grant execute on function app.roster_readiness(uuid) to authenticated, service_role;

-- 3. Allocations ------------------------------------------------------------------------------------------------------------

create view app.advance_allocation_heat with (security_invoker = on) as
select s.org_id, s.project_id, x.engagement_id, private.advance_engagement_label(x.engagement_id) as party_label,
  s.kind, s.offering,
  coalesce(sum(s.quantity) filter (where s.allocation_state = 'Requested'), 0) as requested_quantity,
  coalesce(sum(s.quantity) filter (where s.allocation_state = 'Approved'), 0) as approved_quantity,
  coalesce(sum(s.on_order_quantity) filter (where s.allocation_state = 'Approved'), 0) as on_order_quantity,
  coalesce(sum(s.received_quantity) filter (where s.allocation_state = 'Approved'), 0) as received_quantity,
  coalesce(sum(s.reserved_quantity) filter (where s.allocation_state = 'Approved'), 0) as reserved_quantity,
  coalesce(sum(s.issued_quantity), 0) as issued_quantity,
  coalesce(sum(s.returned_quantity), 0) as returned_quantity,
  coalesce(sum(s.lost_quantity), 0) as lost_quantity,
  count(*) as allocation_count
from app.advance_allocation_status s
cross join lateral (
  select coalesce(s.holder_engagement_id,
    (select r.engagement_id from app.engagement_roster_entries r where r.id = s.roster_entry_id)) as engagement_id
) x
group by s.org_id, s.project_id, x.engagement_id, s.kind, s.offering;

call private.describe('app.advance_allocation_heat', 'What each party''s engagement is allocated, by offering (R11, owner decision 8): R7''s computed app.advance_allocation_status summed per project, engagement and offering, the pool and its people''s shares together. Computed, never stored; readers of the project''s packets see rows.', array[
  'org_id', 'Producing org.',
  'project_id', 'Project.',
  'engagement_id', 'Engagement the allocations are held under: the pool''s own, or the roster entry''s.',
  'party_label', 'The party: the engaged person, or the counterparty''s organization name.',
  'kind', 'Credential, Parking Pass, Asset, Catering, Lodging, Travel or Per Diem.',
  'offering', 'Offering the allocations draw on; NULL for badges and site assets.',
  'requested_quantity', 'Quantity requested and not yet decided.',
  'approved_quantity', 'Quantity approved.',
  'on_order_quantity', 'Approved quantity still on order with a supplier.',
  'received_quantity', 'Approved quantity received from a supplier.',
  'reserved_quantity', 'Approved quantity held for the party.',
  'issued_quantity', 'Quantity handed over.',
  'returned_quantity', 'Quantity handed back.',
  'lost_quantity', 'Quantity lost.',
  'allocation_count', 'How many allocations, pools and shares, are summed.'
]);

revoke all on app.advance_allocation_heat from public, anon;
grant select on app.advance_allocation_heat to authenticated, service_role;
revoke select on app.advance_allocation_heat from xos_backup;

-- 4. Live updates (as 1450) -------------------------------------------------------------------------------------------------

do $$
declare
  v_table record;
begin
  if not exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime') then
    return;
  end if;
  for v_table in
    select t.table_name from (values ('advance_submissions'), ('engagement_roster_entries')) as t (table_name)
  loop
    if not exists (
      select 1 from pg_catalog.pg_publication_tables p
      where p.pubname = 'supabase_realtime' and p.schemaname = 'app' and p.tablename = v_table.table_name
    ) then
      execute format('alter publication supabase_realtime add table app.%I', v_table.table_name);
    end if;
  end loop;
end;
$$;

-- 5. Field history (as 2241) -------------------------------------------------------------------------------------------------

call private.install_audit_trail('app.advance_recipients');
call private.install_audit_trail('app.advance_sections');

insert into private.field_history_subjects (table_name) values
  ('app.advance_recipients'),
  ('app.advance_sections')
on conflict (table_name) do nothing;
