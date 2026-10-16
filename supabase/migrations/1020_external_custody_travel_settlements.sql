-- 1020_external_custody_travel_settlements.sql
-- A32 Gateway and Compass follow-up (RRR-76), late slot 1020 to 1029: api_external projections over the
-- module late slots, which every module migration has created by now (ADR 0019 item 5, ADR 0022). Each view
-- is owner-run and allowlists its columns; every row filter uses the 0710 helpers with column values (ADR 0016
-- item 14). Columns appended to an existing view keep the earlier columns unchanged.
--   * api_external.asset_custody: gear the caller's engagements hold now (A12 0975 custodian_engagement_id),
--     while the operational area is open (Section 4.5.7, Compass Asset scan for assigned gear)
--   * api_external.travel: travel segments of the caller's engagements (A11 0442 and 0971), without the price
--   * api_external.settlements and api_external.settlement_lines: settlements once submitted to the party, with
--     the NULL-aware net (A15 0991); the party answers through app.respond_to_settlement
--   * api_external.shared_reports: report runs shared with the caller's engagement while the share is open
--     (A15 0992, private.shared_report_open)
--   * api_external.per_diems: allowances paid through the caller's engagement (A13 0981)
--   * api_external.cues gains project_id; api_external.opportunities gains the venue coordinates (A09 0420), so
--     Gateway searches by distance and never guesses a position for a venue that is not located

-- Asset custody ------------------------------------------------------------------------------------------------------

create view api_external.asset_custody as
select c.id, c.asset_unit_id, u.asset_tag, k.name as class_name, u.asset_state, c.custodian_engagement_id as engagement_id,
  c.project_id, p.name as project_name, c.created_at as held_since
from app.asset_custody c
join app.asset_units u on u.id = c.asset_unit_id and u.deleted_at is null
join app.asset_classes k on k.id = u.asset_class_id
left join app.projects p on p.id = c.project_id
where c.custodian_engagement_id in (select private.my_engagement_ids('operational'))
  and not exists (
    select 1 from app.asset_custody n
    where n.asset_unit_id = c.asset_unit_id and (n.created_at, n.id) > (c.created_at, c.id));

call private.describe('api_external.asset_custody', 'Asset units the caller''s engagements hold now: the latest custody row of each unit, while the operational area is open (Section 8.7). Handover notes and other custodians never appear.', array[
  'id', 'Custody row that handed the unit to the engagement.', 'asset_unit_id', 'Asset unit held.', 'asset_tag', 'Asset tag printed on the unit.',
  'class_name', 'Asset class.', 'asset_state', 'Asset state of the unit.', 'engagement_id', 'Engagement holding the unit.',
  'project_id', 'Project the unit is out for.', 'project_name', 'Project name.', 'held_since', 'When the engagement took custody.']);

-- Travel ------------------------------------------------------------------------------------------------------------------

create view api_external.travel as
select t.id, t.engagement_id, t.project_id, p.name as project_name, t.travel_mode, t.operator_name, t.service_identifier,
  t.confirmation_identifier, t.departs_from, t.departs_at, t.departs_time_zone, t.arrives_at_place, t.arrives_at, t.arrives_time_zone
from app.travel_segments t
join app.projects p on p.id = t.project_id
where t.deleted_at is null and t.engagement_id in (select private.my_engagement_ids('operational'));

call private.describe('api_external.travel', 'Flights and ground transport booked under the caller''s engagements (Section 4.5.8 Crew Travel and Lodging), while the operational area is open. What the org paid never appears.', array[
  'id', 'Travel segment.', 'engagement_id', 'Engagement travelled under.', 'project_id', 'Project.', 'project_name', 'Project name.',
  'travel_mode', 'Flight or Ground.', 'operator_name', 'Airline or ground operator.', 'service_identifier', 'Flight or service number.',
  'confirmation_identifier', 'Booking confirmation.', 'departs_from', 'Departure place.', 'departs_at', 'Departure time.',
  'departs_time_zone', 'IANA time zone of the departure.', 'arrives_at_place', 'Arrival place.', 'arrives_at', 'Arrival time; NULL when open.',
  'arrives_time_zone', 'IANA time zone of the arrival.']);

-- Settlements -----------------------------------------------------------------------------------------------------------------

create view api_external.settlements as
select s.id, s.engagement_id, s.project_id, p.name as project_name, s.settlement_number, s.title, s.currency_code, s.settled_on,
  s.settlement_state,
  (select case when count(*) = 0 or count(*) filter (where l.amount_minor is null) > 0 then null
               else sum(case when l.line_kind in ('Deduction', 'Withholding') then -l.amount_minor else l.amount_minor end)::bigint end
   from app.settlement_lines l where l.settlement_id = s.id and l.deleted_at is null) as net_minor,
  (select max(t.created_at) from app.settlement_state_transitions t where t.settlement_id = s.id and t.to_state = 'Submitted') as submitted_at,
  (select max(t.created_at) from app.settlement_state_transitions t
   where t.settlement_id = s.id and t.to_state in ('Accepted', 'Disputed')) as responded_at
from app.settlements s
join app.projects p on p.id = s.project_id
where s.deleted_at is null and s.settlement_state <> 'Proposed'
  and exists (select 1 from app.settlement_state_transitions t where t.settlement_id = s.id and t.to_state = 'Submitted')
  and s.engagement_id in (select private.my_engagement_ids('money'));

call private.describe('api_external.settlements', 'Settlements of the caller''s engagements once submitted to them (Section 4.5.8 Artist Settlement), while the money area is open. Drafts and reworked settlements stay hidden until submitted again. The party accepts or disputes through app.respond_to_settlement.', array[
  'id', 'Settlement.', 'engagement_id', 'Engagement settled.', 'project_id', 'Project.', 'project_name', 'Project name.',
  'settlement_number', 'Number from the project sequence.', 'title', 'Settlement title.', 'currency_code', 'ISO 4217 currency.',
  'settled_on', 'Date of the show or period settled.', 'settlement_state', 'Submitted, Accepted, Disputed, Paid or Canceled.',
  'net_minor', 'Additions less deductions and withholding in minor units; NULL while any line is unpriced.',
  'submitted_at', 'When last submitted.', 'responded_at', 'When the party last accepted or disputed it.']);

create view api_external.settlement_lines as
select l.id, l.settlement_id, l.line_number, l.line_kind, l.description, l.amount_minor
from app.settlement_lines l
join app.settlements s on s.id = l.settlement_id
where l.deleted_at is null and s.deleted_at is null and s.settlement_state <> 'Proposed'
  and exists (select 1 from app.settlement_state_transitions t where t.settlement_id = s.id and t.to_state = 'Submitted')
  and s.engagement_id in (select private.my_engagement_ids('money'));

call private.describe('api_external.settlement_lines', 'Lines of the settlements in api_external.settlements. The amount is unsigned; the kind decides whether it adds or subtracts.', array[
  'id', 'Settlement line.', 'settlement_id', 'Settlement.', 'line_number', 'Order of the line.',
  'line_kind', 'Guarantee, Bonus, Split, Expense, Deduction or Withholding.', 'description', 'What the line settles.',
  'amount_minor', 'Amount in minor units; NULL is unpriced.']);

-- Shared reports ------------------------------------------------------------------------------------------------------------------

create view api_external.shared_reports as
select s.id, s.engagement_id, s.project_id, p.name as project_name, s.title, s.created_at as shared_at, s.expires_at,
  r.export_format, r.finished_at, r.row_count, r.unpriced_count
from app.shared_reports s
join app.projects p on p.id = s.project_id
join app.report_runs r on r.id = s.report_run_id
where private.shared_report_open(s.engagement_id, s.expires_at, s.revoked_at, s.deleted_at);

call private.describe('api_external.shared_reports', 'Report runs shared with the caller''s engagement (Section 4.5.8 Client Reports) while the share is open: not revoked, not expired and the engagement area reachable. Who shared or revoked it and the report definition never appear.', array[
  'id', 'Share.', 'engagement_id', 'Engagement the report is shared with.', 'project_id', 'Project.', 'project_name', 'Project name.',
  'title', 'Title the org gave the share.', 'shared_at', 'When the org shared it.', 'expires_at', 'When the share stops opening; NULL while open-ended.',
  'export_format', 'Result file format.', 'finished_at', 'When the run finished.', 'row_count', 'Rows in the result.',
  'unpriced_count', 'Rows with an unpriced amount.']);

-- Per diems ------------------------------------------------------------------------------------------------------------------------

create view api_external.per_diems as
select d.id, d.engagement_id, d.project_id, p.name as project_name, d.day, d.amount_minor, d.currency_code
from app.per_diems d
join app.projects p on p.id = d.project_id
where d.deleted_at is null and d.engagement_id in (select private.my_engagement_ids('operational'));

call private.describe('api_external.per_diems', 'Per diem allowances paid through the caller''s engagements (Section 4.5.8 Crew Per Diem), while the operational area is open, as A13''s policy reads them.', array[
  'id', 'Per diem.', 'engagement_id', 'Engagement paid through.', 'project_id', 'Project.', 'project_name', 'Project name.',
  'day', 'Day the allowance covers.', 'amount_minor', 'Allowance in minor units.', 'currency_code', 'ISO 4217 currency.']);

-- Cues gain project_id (columns appended to the 0760 view) ----------------------------------------------------------------------------

create or replace view api_external.cues as
select c.id, c.run_of_show_id, c.position, c.label, c.planned_at, c.duration, c.called_at,
  (c.id in (select private.my_set_cue_ids())) as is_my_set,
  r.project_id
from app.cues c
join app.run_of_show r on r.id = c.run_of_show_id and r.deleted_at is null
where c.deleted_at is null
  and (private.engaged_as(r.project_id, 'Client') or c.id in (select private.my_set_cue_ids()));

comment on column api_external.cues.project_id is 'Project of the running order, so a page narrows cues to one engagement''s project.';

-- Opportunities gain the venue coordinates (columns appended to the 1001 view) ----------------------------------------------------------

create or replace view api_external.opportunities as
select op.id, op.org_id, o.name as org_name, op.title, op.description, op.role_type, op.role_code, op.cat_urid,
  v.name as venue_name, op.jurisdiction_id, op.starts_on, op.ends_on, op.visibility, op.rate_type,
  op.pay_min_minor, op.pay_max_minor, op.currency_code, (op.rate_type is null) as rate_on_request,
  op.deadline_at, op.minimum_age, op.opportunity_state,
  (select count(*) from app.opportunity_positions pp where pp.opportunity_id = op.id and pp.deleted_at is null) as position_count,
  v.locality as venue_locality,
  private.organization_verified(op.org_id) as org_verified,
  extensions.st_y(v.location::extensions.geometry) as venue_latitude,
  extensions.st_x(v.location::extensions.geometry) as venue_longitude
from app.opportunities op
join app.organizations o on o.id = op.org_id
left join app.venues v on v.id = op.venue_id
where op.deleted_at is null
  and (op.id in (select private.visible_opportunity_ids())
    or op.id in (select a.opportunity_id from app.applications a where a.id in (select private.my_application_ids())));

comment on column api_external.opportunities.venue_latitude is 'Latitude of the venue in WGS 84 degrees; NULL when the venue is not located, and then distance search leaves the listing out.';
comment on column api_external.opportunities.venue_longitude is 'Longitude of the venue in WGS 84 degrees; NULL when the venue is not located.';

-- Privileges --------------------------------------------------------------------------------------------------------------------------------

revoke all on api_external.asset_custody, api_external.travel, api_external.settlements, api_external.settlement_lines,
  api_external.shared_reports, api_external.per_diems from public, anon;
grant select on api_external.asset_custody, api_external.travel, api_external.settlements, api_external.settlement_lines,
  api_external.shared_reports, api_external.per_diems to authenticated, service_role;
