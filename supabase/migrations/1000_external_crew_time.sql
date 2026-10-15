-- 1000_external_crew_time.sql
-- A28 Engagements and Marketplace (RRR-30), post-late-slot range 1000 to 1009 (ADR 0022, orchestrator approval):
-- api_external projections over late-slot columns, for Gateway groups 4 and 5 and external Compass (A17).
--   * api_external.shifts: shifts assigned to the caller's engagements (0940 engagement_id), once published
--   * api_external.time_entries and api_external.timesheets: the caller's time and timesheets with derived minutes;
--     externals record time through A03's app.record_punch (0941) and submit through app.submit_timesheet (0940)
--   * app.accept_engaged_shift: the engaged person accepts a Published shift, which record_punch requires
--   * api_external.credentials gains party badges (0985 credentials.engagement_id): an artist and their Advance
--     representative read badges issued under the artist's engagement
--   * api_external.dock_slots gains slots booked for the vendor's own engagement (0970 dock_slots.engagement_id)
-- Every row filter uses the 0710 helpers with column values (ADR 0016 item 14): operational reach opens at Active and
-- closes at Complete (Section 8.7).

-- Shifts ------------------------------------------------------------------------------------------------------------

create view api_external.shifts as
select s.id, s.engagement_id, s.project_id, p.name as project_name, s.scope_node_id, n.name as scope_node_name,
  s.role_code, r.job_title, s.starts_at, s.ends_at, s.time_zone, s.shift_state
from app.shifts s
join app.projects p on p.id = s.project_id
left join app.scope_nodes n on n.id = s.scope_node_id
left join xpms.role r on r.role_code = s.role_code
where s.deleted_at is null and s.shift_state in ('Published', 'Accepted', 'Canceled')
  and s.engagement_id in (select private.my_engagement_ids('operational'));

call private.describe('api_external.shifts', 'Shifts assigned to the caller''s engagements, once published (Section 4.4.4 Crew and Staff: shifts and call times), while the operational area is open. Drafts never appear.', array[
  'id', 'Shift.', 'engagement_id', 'Engagement the shift is worked under.', 'project_id', 'Project.', 'project_name', 'Project name.',
  'scope_node_id', 'Scope node, such as the show.', 'scope_node_name', 'Scope node name.', 'role_code', 'Canon role.',
  'job_title', 'Job title from the Roles Library.', 'starts_at', 'Call time.', 'ends_at', 'End.', 'time_zone', 'IANA time zone of the shift.',
  'shift_state', 'Published, Accepted or Canceled.']);

create or replace function app.accept_engaged_shift(p_shift_id uuid, p_reason text default 'Accepted.')
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_shift app.shifts;
  v_person uuid;
begin
  v_person := private.require_person();
  select s.* into v_shift from app.shifts s where s.id = p_shift_id and s.deleted_at is null for update;
  if v_shift.id is null or v_shift.engagement_id is null
     or (select e.person_id from app.engagements e where e.id = v_shift.engagement_id) is distinct from v_person
     or v_shift.engagement_id not in (select private.my_engagement_ids('operational')) then
    raise exception using errcode = '42501', message = 'only the engaged person assigned accepts a shift';
  end if;
  return private.transition_lifecycle('shift', 'app.shifts', 'shift_state', 'app.shift_state_transitions',
    'shift_id', p_shift_id, 'Published', 'Accepted', p_reason);
end;
$$;

comment on function app.accept_engaged_shift(uuid, text) is 'The engaged person assigned to a Published shift through their engagement accepts it while the operational area is open (the external half of A13''s app.accept_shift). Returns the ledger entry id.';

-- Time --------------------------------------------------------------------------------------------------------------------

create view api_external.time_entries as
select t.id, t.engagement_id, t.project_id, t.shift_id, t.clock_in, t.clock_out, t.break_minutes, t.source
from app.time_entries t
where t.deleted_at is null and t.engagement_id in (select private.my_engagement_ids('operational'));

call private.describe('api_external.time_entries', 'Time worked under the caller''s engagements while the operational area is open. Recorded through app.record_punch.', array[
  'id', 'Time entry.', 'engagement_id', 'Engagement.', 'project_id', 'Project.', 'shift_id', 'Shift worked.', 'clock_in', 'Clock in.',
  'clock_out', 'Clock out; NULL while open.', 'break_minutes', 'Break minutes.', 'source', 'Where the time was captured.']);

create or replace function private.external_timesheet_minutes(p_timesheet_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select private.timesheet_minutes(p_timesheet_id);
$$;

comment on function private.external_timesheet_minutes(uuid) is 'Worked minutes of a timesheet for the external projection.';

create view api_external.timesheets as
select ts.id, ts.engagement_id, ts.project_id, p.name as project_name, ts.period_start, ts.period_end, ts.timesheet_state,
  private.external_timesheet_minutes(ts.id) as worked_minutes,
  (select max(t.created_at) from app.timesheet_state_transitions t where t.timesheet_id = ts.id and t.to_state = 'Submitted') as submitted_at,
  (select max(t.created_at) from app.timesheet_state_transitions t where t.timesheet_id = ts.id and t.to_state in ('Approved', 'Rejected')) as decided_at
from app.timesheets ts
join app.projects p on p.id = ts.project_id
where ts.deleted_at is null and ts.engagement_id in (select private.my_engagement_ids('operational'));

call private.describe('api_external.timesheets', 'Timesheets of the caller''s engagements with minutes derived from their time entries, while the operational area is open. Submitted through app.submit_timesheet.', array[
  'id', 'Timesheet.', 'engagement_id', 'Engagement.', 'project_id', 'Project.', 'project_name', 'Project name.',
  'period_start', 'First day.', 'period_end', 'Last day.', 'timesheet_state', 'Proposed, Submitted, Approved or Rejected.',
  'worked_minutes', 'Closed entry minutes less breaks.', 'submitted_at', 'When last submitted.', 'decided_at', 'When last approved or rejected.']);

-- Party badges (columns appended to the 0760 view) ------------------------------------------------------------------------

create or replace function private.party_badge_visible(p_engagement_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_engagement_id is not null and exists (
    select 1 from app.engagements e
    where e.id = p_engagement_id and e.deleted_at is null and e.role_type = 'Artist'
      and (e.person_id = private.current_person_id() or private.represents(e.person_id, 'Advance'))
      and private.engagement_area_open(e.id, e.person_id, e.counterparty_id, e.role_type, e.engagement_state, 'operational'));
$$;

comment on function private.party_badge_visible(uuid) is 'Section 8.7: true when the signed-in person is the artist of the engagement a badge was issued under, or their representative with the Advance scope, while the operational area is open. Takes the badge''s engagement_id.';

create or replace view api_external.credentials as
select c.id, k.project_id, p.name as project_name, k.code as category_code, k.name as category_name, c.holder_person_id,
  h.full_name as holder_name, c.credential_number, c.valid_from, c.valid_to, c.revoked_at, c.engagement_id
from app.credentials c
join app.credential_categories k on k.id = c.credential_category_id and k.deleted_at is null
join app.projects p on p.id = k.project_id
join app.people h on h.id = c.holder_person_id
where c.deleted_at is null
  and (private.external_credential_visible(k.project_id, c.holder_person_id) or private.party_badge_visible(c.engagement_id));

comment on view api_external.credentials is 'Badges the caller may read (Section 8.7): their own on projects where their engagement is in the operational area, a represented artist''s with the Advance scope, and the party badges issued under an artist''s engagement for the artist and that representative. Who issued or revoked a badge never appears.';
comment on column api_external.credentials.engagement_id is 'Engagement the badge was issued under, for party badges.';

-- Dock slots of the vendor's own engagement (columns appended to the 0760 view) ---------------------------------------------

create or replace view api_external.dock_slots as
select d.id, d.project_id, p.name as project_name, d.zone_id, z.code as zone_code, z.name as zone_name, d.shipment_id,
  s.direction, s.tracking_identifier, d.starts_at, d.ends_at, d.engagement_id
from app.dock_slots d
join app.projects p on p.id = d.project_id
join app.zones z on z.id = d.zone_id
left join app.shipments s on s.id = d.shipment_id
where d.deleted_at is null
  and ((d.shipment_id is not null and private.external_dock_slot_visible(d.project_id, d.shipment_id))
    or d.engagement_id in (select private.my_engagement_ids('operational')));

comment on view api_external.dock_slots is 'Dock slots of the caller''s vendor account: slots booked for shipments it carries and slots booked for its own engagement, while that engagement is in the operational area (Section 8.7). Other vendors'' slots never appear.';
comment on column api_external.dock_slots.engagement_id is 'Vendor engagement the slot serves, when booked for one.';

-- Privileges ----------------------------------------------------------------------------------------------------------------

revoke all on function app.accept_engaged_shift(uuid, text) from public, anon;
grant execute on function app.accept_engaged_shift(uuid, text) to authenticated, service_role;
revoke all on function private.external_timesheet_minutes(uuid) from public, anon;
grant execute on function private.external_timesheet_minutes(uuid) to authenticated, service_role;
revoke all on function private.party_badge_visible(uuid) from public, anon;
grant execute on function private.party_badge_visible(uuid) to authenticated, service_role;

revoke all on api_external.shifts, api_external.time_entries, api_external.timesheets from public, anon;
grant select on api_external.shifts, api_external.time_entries, api_external.timesheets to authenticated, service_role;
