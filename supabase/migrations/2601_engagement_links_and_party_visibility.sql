-- 2601_engagement_links_and_party_visibility.sql
-- R1 Advancing wiring fixes (RRR-179, ADR 0100 to 0104). Badges issued under an engagement name its person, and the
-- external views read people through the engagement's principals.
--
--   * private.guard_credential_engagement (from 0985) also refuses an engagement that is Complete or Canceled, and
--     one whose person is not the holder, except an Artist engagement's party badges (0985, Section 4.5.7).
--   * private.engagement_principal(engagement): the signed-in person is the engagement's person, an Account Owner
--     or Admin of the account that supplies it, or the Advance representative of an Artist, while the operational
--     area is open. private.party_person_visible(project, person) asks it of the person's live engagements on the
--     project.
--   * Badges, lodging, hospitality lines, travel and per diems read through those helpers, so a vendor's Owner
--     and Admin see what concerns the people their account supplies under person-plus-counterparty engagements.
--     An Account Member or Account Finance sees only their own (decision 6). Artists and Advance representatives
--     read as before. Party badges (private.party_badge_visible) open to every principal of the engagement,
--     not only an Artist's.
-- Every view keeps its columns in the same order, its descriptions and its grants.

-- Badges under an engagement name its person ----------------------------------------------------------------------------

create or replace function private.guard_credential_engagement()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_engagement app.engagements;
begin
  if new.engagement_id is null then
    return new;
  end if;
  select e.* into v_engagement from app.engagements e
  where e.id = new.engagement_id and e.project_id = new.project_id and e.deleted_at is null;
  if v_engagement.id is null then
    perform private.refuse('credential_engagement_project', 'A credential''s engagement belongs to the same project as its category.');
  end if;
  if v_engagement.engagement_state in ('Complete', 'Canceled') then
    perform private.refuse('credential_engagement_closed', 'A badge is issued under an engagement that is still open.');
  end if;
  if v_engagement.person_id is distinct from new.holder_person_id and v_engagement.role_type <> 'Artist' then
    perform private.refuse('credential_engagement_holder', 'A badge issued under an engagement is held by the person it names; only an artist''s engagement carries party badges.');
  end if;
  return new;
end;
$$;
comment on function private.guard_credential_engagement() is 'Credentials: an engagement, when given, is a live engagement on the credential''s project that is not Complete or Canceled, and names the holder, unless it is an Artist engagement carrying party badges (R1). R7 recreates this function from this definition so a roster entry''s person can hold a badge on a company engagement.';
revoke all on function private.guard_credential_engagement() from public, anon, authenticated;

drop trigger t42_guard_credential_engagement on app.credentials;
create trigger t42_guard_credential_engagement before insert or update of engagement_id, credential_category_id, holder_person_id on app.credentials
  for each row execute function private.guard_credential_engagement();

-- Engagement principals ---------------------------------------------------------------------------------------------------

create or replace function private.engagement_principal(p_engagement_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from app.engagements e
    left join app.counterparties c on c.id = e.counterparty_id
    where e.id = p_engagement_id and e.deleted_at is null
      and private.engagement_area_open(e.id, e.person_id, e.counterparty_id, e.role_type, e.engagement_state, 'operational')
      and (e.person_id = private.current_person_id()
        or c.organization_id in (select private.my_account_ids(array['Account Owner', 'Account Admin']::app.account_role[]))
        or (e.role_type = 'Artist' and private.represents(e.person_id, 'Advance'))));
$$;

comment on function private.engagement_principal(uuid) is 'Section 8.7 (R1): true when the signed-in person answers for the engagement while its operational area is open: its person, an Account Owner or Admin of the account that supplies it, or the Advance representative of an Artist. R4 widens it with the live Advancing Lead assignment; R7''s private.guard_credential_engagement builds on the same principals.';

create or replace function private.party_person_visible(p_project_id uuid, p_person_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_person_id is not null and exists (
    select 1 from app.engagements e
    where e.project_id = p_project_id and e.person_id = p_person_id and e.deleted_at is null
      and private.engagement_principal(e.id));
$$;

comment on function private.party_person_visible(uuid, uuid) is 'Section 8.7 (R1): true when a live engagement of the person on the project has the signed-in person as a principal (private.engagement_principal). Takes column values.';

revoke all on function private.engagement_principal(uuid) from public, anon;
revoke all on function private.party_person_visible(uuid, uuid) from public, anon;
-- Function calls inside a view run with the caller's execute privilege, so signed-in users need these.
grant execute on function private.engagement_principal(uuid) to authenticated, service_role;
grant execute on function private.party_person_visible(uuid, uuid) to authenticated, service_role;

-- Party badges open to every principal of the engagement -----------------------------------------------------------------

create or replace function private.party_badge_visible(p_engagement_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_engagement_id is not null and private.engagement_principal(p_engagement_id);
$$;

comment on function private.party_badge_visible(uuid) is 'Section 8.7: true when the signed-in person is a principal of the engagement a badge was issued under (private.engagement_principal: its person, the supplying account''s Owner or Admin, or an artist''s Advance representative) while the operational area is open. Takes the badge''s engagement_id.';

-- Views -----------------------------------------------------------------------------------------------------------------------

create or replace view api_external.credentials as
select c.id, k.project_id, p.name as project_name, k.code as category_code, k.name as category_name, c.holder_person_id,
  h.full_name as holder_name, c.credential_number, c.valid_from, c.valid_to, c.revoked_at, c.engagement_id
from app.credentials c
join app.credential_categories k on k.id = c.credential_category_id and k.deleted_at is null
join app.projects p on p.id = k.project_id
join app.people h on h.id = c.holder_person_id
where c.deleted_at is null
  and (private.party_person_visible(k.project_id, c.holder_person_id) or private.party_badge_visible(c.engagement_id));

comment on view api_external.credentials is 'Badges the caller may read (Section 8.7): those of people whose engagement on the project has the caller as a principal (the person, the supplying account''s Owner or Admin, or an artist''s Advance representative) while its operational area is open, and the party badges issued under an engagement for its principals. Who issued or revoked a badge never appears.';
comment on column api_external.credentials.engagement_id is 'Engagement the badge was issued under, for party badges.';

create or replace view api_external.lodging as
select a.id, b.project_id, p.name as project_name, b.title as block_title, o.name as hotel_name, a.person_id, g.full_name as guest_name,
  a.check_in_on, a.check_out_on
from app.accommodation_assignments a
join app.accommodation_blocks b on b.id = a.accommodation_block_id and b.deleted_at is null
join app.projects p on p.id = b.project_id
join app.people g on g.id = a.person_id
left join app.counterparties c on c.id = b.counterparty_id
left join app.organizations o on o.id = c.organization_id
where a.deleted_at is null and private.party_person_visible(b.project_id, a.person_id);

call private.describe('api_external.lodging', 'Room assignments of people whose engagement on the project has the caller as a principal (the person, the supplying account''s Owner or Admin, or an artist''s Advance representative) while that engagement is in the operational area (Section 8.7). Contracted rates and room counts never appear.', array[
  'id', 'Room assignment.', 'project_id', 'Project.', 'project_name', 'Project name.', 'block_title', 'Accommodation block.',
  'hotel_name', 'Hotel or lodging supplier.', 'person_id', 'Guest.', 'guest_name', 'Guest name.', 'check_in_on', 'First night.',
  'check_out_on', 'Departure date.']);

create or replace view api_external.hospitality as
select l.id, f.id as fulfillment_id, f.project_id, p.name as project_name, f.fulfillment_kind, f.title, o.name as supplier_name,
  f.starts_at, f.ends_at, l.description, l.quantity, l.person_id
from app.fulfillment_lines l
join app.fulfillments f on f.id = l.fulfillment_id and f.deleted_at is null
join app.projects p on p.id = f.project_id
left join app.counterparties c on c.id = f.counterparty_id
left join app.organizations o on o.id = c.organization_id
where l.deleted_at is null and private.party_person_visible(f.project_id, l.person_id);

call private.describe('api_external.hospitality', 'Travel, lodging, catering and amenity lines for people whose engagement on the project has the caller as a principal (the person, the supplying account''s Owner or Admin, or an artist''s Advance representative) while that engagement is in the operational area. Prices never appear.', array[
  'id', 'Line.', 'fulfillment_id', 'Fulfillment.', 'project_id', 'Project.', 'project_name', 'Project name.',
  'fulfillment_kind', 'Lodging, Catering, Travel or Amenity.', 'title', 'What is fulfilled.', 'supplier_name', 'Supplier.',
  'starts_at', 'Start.', 'ends_at', 'End.', 'description', 'What is provided.', 'quantity', 'Quantity.', 'person_id', 'Guest.']);

create or replace view api_external.travel as
select t.id, t.engagement_id, t.project_id, p.name as project_name, t.travel_mode, t.operator_name, t.service_identifier,
  t.confirmation_identifier, t.departs_from, t.departs_at, t.departs_time_zone, t.arrives_at_place, t.arrives_at, t.arrives_time_zone
from app.travel_segments t
join app.projects p on p.id = t.project_id
where t.deleted_at is null and t.engagement_id in (select private.my_engagement_ids('operational'))
  and (t.person_id = private.current_person_id() or private.engagement_principal(t.engagement_id));

call private.describe('api_external.travel', 'Flights and ground transport booked under the caller''s engagements (Section 4.5.8 Crew Travel and Lodging), while the operational area is open: the traveller''s own, and those of an engagement the caller answers for (the supplying account''s Owner or Admin, or an artist''s Advance representative). What the org paid never appears.', array[
  'id', 'Travel segment.', 'engagement_id', 'Engagement travelled under.', 'project_id', 'Project.', 'project_name', 'Project name.',
  'travel_mode', 'Flight or Ground.', 'operator_name', 'Airline or ground operator.', 'service_identifier', 'Flight or service number.',
  'confirmation_identifier', 'Booking confirmation.', 'departs_from', 'Departure place.', 'departs_at', 'Departure time.',
  'departs_time_zone', 'IANA time zone of the departure.', 'arrives_at_place', 'Arrival place.', 'arrives_at', 'Arrival time; NULL when open.',
  'arrives_time_zone', 'IANA time zone of the arrival.']);

create or replace view api_external.per_diems as
select d.id, d.engagement_id, d.project_id, p.name as project_name, d.day, d.amount_minor, d.currency_code
from app.per_diems d
join app.projects p on p.id = d.project_id
where d.deleted_at is null and d.engagement_id in (select private.my_engagement_ids('operational'))
  and private.engagement_principal(d.engagement_id);

call private.describe('api_external.per_diems', 'Per diem allowances paid through engagements the caller answers for (Section 4.5.8 Crew Per Diem): the person''s own, and those of the people the caller''s account supplies for its Owner and Admin, while the operational area is open.', array[
  'id', 'Per diem.', 'engagement_id', 'Engagement paid through.', 'project_id', 'Project.', 'project_name', 'Project name.',
  'day', 'Day the allowance covers.', 'amount_minor', 'Allowance in minor units.', 'currency_code', 'ISO 4217 currency.']);

-- Grants are kept by create or replace; restated so this file reads whole.
revoke all on api_external.credentials, api_external.lodging, api_external.hospitality, api_external.travel, api_external.per_diems
  from public, anon;
grant select on api_external.credentials, api_external.lodging, api_external.hospitality, api_external.travel, api_external.per_diems
  to authenticated, service_role;
