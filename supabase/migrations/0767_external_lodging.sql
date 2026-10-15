-- 0767_external_lodging.sql
-- A28 Engagements and Marketplace (RRR-30), Gateway group 5 for A27 (Section 4.4.4 Crew: travel and lodging; Artist:
-- travel and hospitality details). Over A11's accommodation blocks (0440):
--   * api_external.lodging: the caller's own room assignments, and a represented artist's with the Advance scope,
--     on projects where that person's engagement is in the operational area. Hotel and dates only; contracted
--     rates and room counts never appear.
-- Travel (flights and ground transport) has no source table yet.

create view api_external.lodging as
select a.id, b.project_id, p.name as project_name, b.title as block_title, o.name as hotel_name, a.person_id, g.full_name as guest_name,
  a.check_in_on, a.check_out_on
from app.accommodation_assignments a
join app.accommodation_blocks b on b.id = a.accommodation_block_id and b.deleted_at is null
join app.projects p on p.id = b.project_id
join app.people g on g.id = a.person_id
left join app.counterparties c on c.id = b.counterparty_id
left join app.organizations o on o.id = c.organization_id
where a.deleted_at is null and private.external_credential_visible(b.project_id, a.person_id);

call private.describe('api_external.lodging', 'Room assignments of the caller, and of a represented artist with the Advance scope, on projects where that engagement is in the operational area (Section 8.7). Contracted rates and room counts never appear.', array[
  'id', 'Room assignment.', 'project_id', 'Project.', 'project_name', 'Project name.', 'block_title', 'Accommodation block.',
  'hotel_name', 'Hotel or lodging supplier.', 'person_id', 'Guest.', 'guest_name', 'Guest name.', 'check_in_on', 'First night.',
  'check_out_on', 'Departure date.']);

revoke all on api_external.lodging from public, anon;
grant select on api_external.lodging to authenticated, service_role;
