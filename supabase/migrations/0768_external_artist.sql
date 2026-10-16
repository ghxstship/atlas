-- 0768_external_artist.sql
-- A28 Engagements and Marketplace (RRR-30), Gateway group 7 for A27 (Section 4.4.4 Artist: rider, advance packet,
-- travel and hospitality details, set times, day sheet). Over A10's advancing tables (0351, 0430) and A11's
-- fulfillments (0351, 0440):
--   * api_external.advance_packets, advance_sections, my_advance_recipients and advance_submissions: sent packets
--     where the caller, their account or a represented artist (Advance scope) is a recipient
--   * app.submit_engaged_advance_answer: the signed-in recipient answers a section; token answers stay A10's
--   * api_external.riders and api_external.rider_lines: riders of the caller's account on its projects
--   * api_external.hospitality: travel, lodging, catering and amenity lines for the caller or a represented artist,
--     without prices
-- Set times are api_external.cues (0760). Guest lists and settlements have no source tables yet.

-- Helpers (column values in, ADR 0016 item 14) -------------------------------------------------------------------

create or replace function private.person_party_open(p_project_id uuid, p_person_id uuid, p_areas text[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_person_id is not null and exists (
    select 1 from app.engagements e cross join unnest(p_areas) a (area)
    where e.project_id = p_project_id and e.person_id = p_person_id and e.deleted_at is null
      and (p_person_id = private.current_person_id() or (e.role_type = 'Artist' and private.represents(p_person_id, 'Advance')))
      and private.engagement_area_open(e.id, e.person_id, e.counterparty_id, e.role_type, e.engagement_state, a.area));
$$;

comment on function private.person_party_open(uuid, uuid, text[]) is 'Section 8.7: true when the signed-in person is the person, or the Advance representative of the artist, and one of the areas of that person''s engagement on the project is open. Takes column values.';

create or replace function private.advance_recipient_open(p_project_id uuid, p_person_id uuid, p_counterparty_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.person_party_open(p_project_id, p_person_id, array['onboarding', 'operational'])
    or (p_counterparty_id is not null and (
      private.counterparty_area_open(p_project_id, p_counterparty_id, 'operational', array['Account Owner', 'Account Admin', 'Account Member']::app.account_role[])
      or private.counterparty_area_open(p_project_id, p_counterparty_id, 'onboarding', array['Account Owner', 'Account Admin']::app.account_role[])));
$$;

comment on function private.advance_recipient_open(uuid, uuid, uuid) is 'Section 8.7: true when the signed-in person answers for an advance recipient: the person or their Advance representative, or the counterparty''s account, while the engagement''s onboarding or operational area is open.';

create or replace function private.rider_party_open(p_project_id uuid, p_counterparty_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_counterparty_id is not null and (
    private.counterparty_area_open(p_project_id, p_counterparty_id, 'operational', array['Account Owner', 'Account Admin', 'Account Member']::app.account_role[])
    or exists (
      select 1 from app.counterparties c
      join app.representations r on r.org_id = c.organization_id and r.deleted_at is null
      where c.id = p_counterparty_id
        and c.organization_id in (select private.my_account_ids(array['Account Owner', 'Account Admin']::app.account_role[]))
        and private.person_party_open(p_project_id, r.artist_person_id, array['operational'])));
$$;

comment on function private.rider_party_open(uuid, uuid) is 'Section 8.7: true when the signed-in person reads a rider of the counterparty: its account with an engagement on the project in the operational area, or the representing agency''s Owner or Admin for an artist it represents with the Advance scope.';

-- Advancing -------------------------------------------------------------------------------------------------------------

create view api_external.my_advance_recipients as
select r.id, r.advance_packet_id, r.person_id, c.organization_id as account_id
from app.advance_recipients r
join app.advance_packets p on p.id = r.advance_packet_id and p.deleted_at is null and p.sent_at is not null
left join app.counterparties c on c.id = r.counterparty_id
where r.deleted_at is null and private.advance_recipient_open(p.project_id, r.person_id, r.counterparty_id);

call private.describe('api_external.my_advance_recipients', 'Advance recipients the caller answers for: themselves, their account, or a represented artist with the Advance scope, on sent packets.', array[
  'id', 'Recipient.', 'advance_packet_id', 'Packet.', 'person_id', 'Recipient person.', 'account_id', 'Recipient account.']);

create view api_external.advance_packets as
select p.id, p.project_id, pr.name as project_name, o.name as org_name, p.title, p.due_at, p.sent_at
from app.advance_packets p
join app.projects pr on pr.id = p.project_id
join app.organizations o on o.id = p.org_id
where p.deleted_at is null and p.sent_at is not null
  and p.id in (select x.advance_packet_id from api_external.my_advance_recipients x);

call private.describe('api_external.advance_packets', 'Sent advance packets the caller answers for (Section 4.4.4).', array[
  'id', 'Packet.', 'project_id', 'Project.', 'project_name', 'Project name.', 'org_name', 'Org.', 'title', 'Title.',
  'due_at', 'When answers are due.', 'sent_at', 'When sent.']);

create view api_external.advance_sections as
select s.id, s.advance_packet_id, s.position, s.title, s.prompt
from app.advance_sections s
where s.deleted_at is null and s.advance_packet_id in (select x.id from api_external.advance_packets x);

call private.describe('api_external.advance_sections', 'Sections of the caller''s advance packets.', array[
  'id', 'Section.', 'advance_packet_id', 'Packet.', 'position', 'Order.', 'title', 'Title.', 'prompt', 'What is asked.']);

create view api_external.advance_submissions as
select a.id, a.advance_section_id, a.advance_recipient_id, a.body, a.submitted_at, a.reviewed_at, a.review_outcome, a.return_reason
from app.advance_submissions a
where a.deleted_at is null and a.advance_recipient_id in (select x.id from api_external.my_advance_recipients x);

call private.describe('api_external.advance_submissions', 'Answers given for the caller''s advance recipients, with the review outcome and any reason an answer was returned. Who reviewed never appears.', array[
  'id', 'Answer.', 'advance_section_id', 'Section.', 'advance_recipient_id', 'Recipient.', 'body', 'Answer as rich text.',
  'submitted_at', 'When given.', 'reviewed_at', 'When reviewed.', 'review_outcome', 'Accepted or Returned.', 'return_reason', 'Why it was returned.']);

create or replace function app.submit_engaged_advance_answer(p_recipient_id uuid, p_section_id uuid, p_body text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_recipient app.advance_recipients;
  v_project uuid;
  v_id uuid;
begin
  perform private.require_person();
  select r.* into v_recipient from app.advance_recipients r where r.id = p_recipient_id and r.deleted_at is null;
  select p.project_id into v_project from app.advance_packets p where p.id = v_recipient.advance_packet_id;
  if v_recipient.id is null or not private.advance_recipient_open(v_project, v_recipient.person_id, v_recipient.counterparty_id) then
    raise exception using errcode = '42501', message = 'only the recipient side answers this packet';
  end if;
  insert into app.advance_submissions (advance_section_id, advance_recipient_id, body)
  values (p_section_id, p_recipient_id, p_body) returning id into v_id;
  return v_id;
end;
$$;

comment on function app.submit_engaged_advance_answer(uuid, uuid, text) is 'A signed-in recipient (the person, their Advance representative, or the recipient account) answers a section of a sent packet while the engagement''s onboarding or operational area is open. A10''s guards apply: same packet, sent, arrives unreviewed. Returns the answer id.';

-- Riders -------------------------------------------------------------------------------------------------------------------

create view api_external.riders as
select r.id, r.project_id, p.name as project_name, c.organization_id as account_id, r.title
from app.riders r
join app.projects p on p.id = r.project_id
join app.counterparties c on c.id = r.counterparty_id
where r.deleted_at is null and private.rider_party_open(r.project_id, r.counterparty_id);

call private.describe('api_external.riders', 'Riders of the caller''s account on projects where it, or an artist it represents, is engaged in the operational area.', array[
  'id', 'Rider.', 'project_id', 'Project.', 'project_name', 'Project name.', 'account_id', 'Account whose rider it is.', 'title', 'Title.']);

create view api_external.rider_lines as
select l.id, l.rider_id, l.description, l.element_id, l.quantity, l.fulfilled_at
from app.rider_lines l
where l.deleted_at is null and l.rider_id in (select x.id from api_external.riders x);

call private.describe('api_external.rider_lines', 'Asks of the caller''s riders and whether each was fulfilled.', array[
  'id', 'Line.', 'rider_id', 'Rider.', 'description', 'What is asked.', 'element_id', 'Catalog element.', 'quantity', 'Quantity.',
  'fulfilled_at', 'When fulfilled; NULL while open.']);

-- Travel and hospitality --------------------------------------------------------------------------------------------------

create view api_external.hospitality as
select l.id, f.id as fulfillment_id, f.project_id, p.name as project_name, f.fulfillment_kind, f.title, o.name as supplier_name,
  f.starts_at, f.ends_at, l.description, l.quantity, l.person_id
from app.fulfillment_lines l
join app.fulfillments f on f.id = l.fulfillment_id and f.deleted_at is null
join app.projects p on p.id = f.project_id
left join app.counterparties c on c.id = f.counterparty_id
left join app.organizations o on o.id = c.organization_id
where l.deleted_at is null and private.person_party_open(f.project_id, l.person_id, array['operational']);

call private.describe('api_external.hospitality', 'Travel, lodging, catering and amenity lines for the caller, or a represented artist with the Advance scope, on projects where that engagement is in the operational area. Prices never appear.', array[
  'id', 'Line.', 'fulfillment_id', 'Fulfillment.', 'project_id', 'Project.', 'project_name', 'Project name.',
  'fulfillment_kind', 'Lodging, Catering, Travel or Amenity.', 'title', 'What is fulfilled.', 'supplier_name', 'Supplier.',
  'starts_at', 'Start.', 'ends_at', 'End.', 'description', 'What is provided.', 'quantity', 'Quantity.', 'person_id', 'Guest.']);

-- Privileges -----------------------------------------------------------------------------------------------------------------

revoke all on function private.person_party_open(uuid, uuid, text[]) from public, anon;
revoke all on function private.advance_recipient_open(uuid, uuid, uuid) from public, anon;
revoke all on function private.rider_party_open(uuid, uuid) from public, anon;
grant execute on function private.person_party_open(uuid, uuid, text[]) to authenticated, service_role;
grant execute on function private.advance_recipient_open(uuid, uuid, uuid) to authenticated, service_role;
grant execute on function private.rider_party_open(uuid, uuid) to authenticated, service_role;
revoke all on function app.submit_engaged_advance_answer(uuid, uuid, text) from public, anon;
grant execute on function app.submit_engaged_advance_answer(uuid, uuid, text) to authenticated, service_role;

revoke all on api_external.my_advance_recipients, api_external.advance_packets, api_external.advance_sections,
  api_external.advance_submissions, api_external.riders, api_external.rider_lines, api_external.hospitality from public, anon;
grant select on api_external.my_advance_recipients, api_external.advance_packets, api_external.advance_sections,
  api_external.advance_submissions, api_external.riders, api_external.rider_lines, api_external.hospitality to authenticated, service_role;
