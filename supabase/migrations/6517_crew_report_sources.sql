-- 6517_crew_report_sources.sql
-- B9 (RRR-233; ADR 0148 decision 5; parity gap G-131): four report sources for the five standard crew reports
-- (utilization, invitation responses, removals, ratings, scheduled against actual hours). The reports themselves are
-- code-defined standard definitions (packages/data report-builder STANDARD_REPORTS); an org saves its own editable
-- copy. Nothing is seeded per org.
--
-- Each source is an owner-rights view with its own row filter (the precedent of app.asset_unit_hire, 2683, and
-- app.expense_budget_lines, 1622): the private resolvers they need are not executable by signed-in readers, and the
-- report-run worker reads them as the run's person (app.report_run_rows, 1050), so each filter decides every row:
--   app.crew_shift_hours  one row per live shift with a worker, on projects where the reader reads shifts; actual and
--                         variance hours only where they also read time entries (crew.time_entry.read)
--   app.crew_responses    one row per shift ask (app.shift_responses, 6510) on projects where they read shifts, and per
--                         roster invitation answer (R4) on projects where they read engagements
--   app.crew_removals     roster entries moved to Withdrawn, with the state they left, where they read engagements
--   app.crew_ratings      the org's own ratings of its engagements (rater_side Organization), as 0740's policy reads them
-- Each person's name appears only under private.may_read_worker_name (6516), so a reader of shifts or engagements sees a
-- roster person's name only where the pages show it (advancing.packet.read).
-- private.report_source_relation (from 1050) maps the four new codes.

create view app.crew_shift_hours as
select s.id as shift_id, s.org_id, s.project_id, s.role_code,
  case when s.membership_id is not null then 'Member'
       when s.roster_entry_id is not null or private.is_agency_slot_engagement(s.engagement_id) then 'Agency'
       else 'Engaged' end as worker_kind,
  case when private.may_read_worker_name(w.id, s.project_id) then w.full_name end as worker_name,
  s.starts_at,
  round((extract(epoch from (s.ends_at - s.starts_at)) / 3600.0 - coalesce(s.scheduled_break_minutes, 0) / 60.0)::numeric, 2)::numeric(8, 2)
    as scheduled_hours,
  case when s.project_id in (select private.project_ids_with('crew.time_entry.read')) then a.actual_hours end as actual_hours,
  case when s.project_id in (select private.project_ids_with('crew.time_entry.read'))
    then (a.actual_hours - round((extract(epoch from (s.ends_at - s.starts_at)) / 3600.0
                                  - coalesce(s.scheduled_break_minutes, 0) / 60.0)::numeric, 2))::numeric(8, 2) end as variance_hours,
  exists (select 1 from app.shift_no_shows n where n.shift_id = s.id and n.deleted_at is null) as no_show
from app.shifts s
left join app.memberships m on m.id = s.membership_id
left join app.engagements e on e.id = s.engagement_id
left join private.roster_people rp on rp.roster_entry_id = s.roster_entry_id
left join app.people w on w.id = coalesce(m.person_id, e.person_id, rp.person_id)
left join lateral (
  -- Worked hours: each entry's length less its unpaid break; a paid break is worked time (6515).
  select round(sum(extract(epoch from (t.clock_out - t.clock_in)) / 3600.0 - t.break_minutes / 60.0)::numeric, 2)::numeric(8, 2) as actual_hours
  from app.time_entries t where t.shift_id = s.id and t.deleted_at is null and t.clock_out is not null
) a on true
where s.deleted_at is null and s.shift_state <> 'Canceled'
  and num_nonnulls(s.membership_id, s.engagement_id, s.roster_entry_id) = 1
  and s.project_id in (select private.project_ids_with('crew.shift.read'));

call private.describe('app.crew_shift_hours', 'Report source crew_hours (B9): one row per live shift with a worker, on projects where the reader reads shifts, with its scheduled hours (length less the scheduled break) and, where the reader also reads time entries (crew.time_entry.read), the hours worked on it (time entries less unpaid breaks) and the difference. Owner-rights view with its own row filter; computed, never stored.', array[
  'shift_id', 'Shift.',
  'org_id', 'Org.',
  'project_id', 'Project of the shift.',
  'role_code', 'Canon role of the shift.',
  'worker_kind', 'Member, Engaged (an external person on their engagement) or Agency (an agency slot or a person of its roster).',
  'worker_name', 'Name of the person who works the shift; null for an agency slot, and for a roster person without advancing.packet.read on the project.',
  'starts_at', 'When the shift starts.',
  'scheduled_hours', 'Scheduled hours: the shift''s length less its scheduled break.',
  'actual_hours', 'Hours worked on the shift from closed time entries, less unpaid breaks; null without crew.time_entry.read on the project.',
  'variance_hours', 'Actual less scheduled hours; null without crew.time_entry.read on the project.',
  'no_show', 'True while the shift has a live no-show.'
]);
revoke all on app.crew_shift_hours from public, anon;
grant select on app.crew_shift_hours to authenticated, service_role;
revoke select on app.crew_shift_hours from xos_backup;

create view app.crew_responses as
select r.id, r.org_id, r.project_id, r.ask_kind::text as kind, r.answer::text as answer, r.asked_at, r.answered_at,
  case when private.may_read_worker_name(p.id, r.project_id) then p.full_name end as person_name, s.role_code
from app.shift_responses r
join app.shifts s on s.id = r.shift_id
left join app.people p on p.id = r.person_id
where r.deleted_at is null
  and r.project_id in (select private.project_ids_with('crew.shift.read'))
union all
select x.id, x.org_id, e.project_id, 'Roster invitation', x.person_response::text, x.created_at, x.responded_at,
  case when private.may_read_worker_name(p.id, e.project_id) then p.full_name end, x.role_code
from app.engagement_roster_entries x
join app.engagements e on e.id = x.engagement_id
left join private.roster_people rp on rp.roster_entry_id = x.id
left join app.people p on p.id = rp.person_id
where x.deleted_at is null and e.project_id is not null
  and e.project_id in (select private.project_ids_with('opportunities.engagement.read'));

call private.describe('app.crew_responses', 'Report source crew_responses (B9): every ask of a person about a shift (Offer or Reconfirmation, app.shift_responses) on projects where the reader reads shifts, and every roster invitation answer (R4: Pending, Accepted or Declined) on projects where they read engagements, as R4''s roster readers do. Owner-rights view with its own row filter.', array[
  'id', 'Shift response or roster entry.',
  'org_id', 'Org.',
  'project_id', 'Project.',
  'kind', 'Offer, Reconfirmation or Roster invitation.',
  'answer', 'For shift asks: Waiting, Accepted, Declined, No Answer or Withdrawn. For roster invitations: Pending, Accepted or Declined.',
  'asked_at', 'When the person was asked (for a roster invitation, when the entry was added).',
  'answered_at', 'When they answered; null while waiting.',
  'person_name', 'Name of the person asked, under private.may_read_worker_name.',
  'role_code', 'Canon role of the shift or the roster entry.'
]);
revoke all on app.crew_responses from public, anon;
grant select on app.crew_responses to authenticated, service_role;
revoke select on app.crew_responses from xos_backup;

create view app.crew_removals as
select t.id, x.org_id, e.project_id, t.created_at as removed_at, t.from_state::text as from_state,
  case when private.may_read_worker_name(p.id, e.project_id) then p.full_name end as person_name,
  x.role_code,
  coalesce(o.name, ep.full_name) as engagement_party,
  t.reason, case when private.may_read_worker_name(rb.id, e.project_id) then rb.full_name end as removed_by_name
from app.roster_entry_state_transitions t
join app.engagement_roster_entries x on x.id = t.roster_entry_id
join app.engagements e on e.id = x.engagement_id
left join private.roster_people rp on rp.roster_entry_id = x.id
left join app.people p on p.id = rp.person_id
left join app.counterparties c on c.id = e.counterparty_id
left join app.organizations o on o.id = c.organization_id
left join app.people ep on ep.id = e.person_id
left join app.people rb on rb.id = t.created_by
where t.to_state = 'Withdrawn' and t.from_state is not null and e.project_id is not null
  and e.project_id in (select private.project_ids_with('opportunities.engagement.read'));

call private.describe('app.crew_removals', 'Report source crew_removals (B9): roster entries moved to Withdrawn (app.roster_entry_state_transitions, R4) on projects where the reader reads engagements, with the state they left: the standard Removals report keeps those that left Accepted, since an agency withdrawing a Draft is not a removal. Owner-rights view with its own row filter.', array[
  'id', 'Ledger entry of the withdrawal.',
  'org_id', 'Org.',
  'project_id', 'Project of the engagement.',
  'removed_at', 'When the entry was withdrawn.',
  'from_state', 'State the entry left: Draft, Submitted, Accepted or Returned.',
  'person_name', 'Name of the person on the entry, under private.may_read_worker_name.',
  'role_code', 'Canon role of the entry.',
  'engagement_party', 'The engagement''s party: the agency, or the person engaged.',
  'reason', 'Why it was withdrawn.',
  'removed_by_name', 'Who withdrew it, under private.may_read_worker_name.'
]);
revoke all on app.crew_removals from public, anon;
grant select on app.crew_removals to authenticated, service_role;
revoke select on app.crew_removals from xos_backup;

create view app.crew_ratings as
select g.id, g.org_id, e.project_id, coalesce(o.name, ep.full_name) as party_name, e.role_type::text as role_type, g.score,
  g.submitted_at
from app.ratings g
join app.engagements e on e.id = g.engagement_id
left join app.counterparties c on c.id = e.counterparty_id
left join app.organizations o on o.id = c.organization_id
left join app.people ep on ep.id = e.person_id
where g.deleted_at is null and g.rater_side = 'Organization'
  and g.engagement_id in (select private.internal_engagement_ids('opportunities.engagement.read'));

call private.describe('app.crew_ratings', 'Report source crew_ratings (B9): the org''s own ratings of the parties it engaged (rater_side Organization), on engagements the reader reads (0740''s policy rule). Comments never appear. Owner-rights view with its own row filter.', array[
  'id', 'Rating.',
  'org_id', 'Org.',
  'project_id', 'Project of the engagement.',
  'party_name', 'The party rated: the company, or the person engaged.',
  'role_type', 'Role type of the engagement.',
  'score', 'Score from 1 to 5.',
  'submitted_at', 'When the rating was submitted.'
]);
revoke all on app.crew_ratings from public, anon;
grant select on app.crew_ratings to authenticated, service_role;
revoke select on app.crew_ratings from xos_backup;

-- Sources ----------------------------------------------------------------------------------------------------------------------

insert into private.report_sources (code, read_capability, sort_order) values
  ('crew_hours', 'crew.shift.read', 8),
  ('crew_responses', 'crew.shift.read', 9),
  ('crew_removals', 'opportunities.engagement.read', 10),
  ('crew_ratings', 'opportunities.engagement.read', 11);

-- The relation each report source reads (latest: 1050; the same map as packages/data report-builder REPORT_SOURCES).
create or replace function private.report_source_relation(p_source_code text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_source_code
    when 'records' then 'records'
    when 'finance' then 'budget_line_facts'
    when 'crew' then 'shifts'
    when 'procurement' then 'purchase_order_totals'
    when 'assets' then 'asset_units'
    when 'incidents' then 'incidents'
    when 'custom_object' then 'custom_object_records'
    when 'crew_hours' then 'crew_shift_hours'
    when 'crew_responses' then 'crew_responses'
    when 'crew_removals' then 'crew_removals'
    when 'crew_ratings' then 'crew_ratings'
  end;
$$;

comment on function private.report_source_relation(text) is 'Relation in schema app that a report source reads.';
revoke all on function private.report_source_relation(text) from public, anon, authenticated;
grant execute on function private.report_source_relation(text) to service_role;
