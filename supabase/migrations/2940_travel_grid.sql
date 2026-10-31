-- 2940_travel_grid.sql
-- B5 Travel, lodging, ground transport and local contacts (RRR-229, ADR 0144; parity gap G-58). The project-wide flight
-- grid: every live travel segment a reader may see, with its journey (the legs a traveller flies within 24 hours of the
-- last landing) and its phase computed from the clock. Segments stay one traveller per row (0442), unchanged.
--
--   * private.person_name_known(person) is the rule app.person_names (1275) applies, widened to the person of a live
--     roster entry (not Withdrawn, not Declined) on a live engagement of one of the reader's orgs: a roster person the
--     org moves and houses is someone it knows by name. app.person_names is recreated from 1275 over it.
--   * private.known_person_name(person) returns that person's full_name exactly when app.person_names would. app.people
--     is readable only for the reader and members of the reader's orgs (0205), so the invoker views of B5 never join it:
--     they read names through this helper. Function calls inside an invoker view run with the caller's execute right
--     (2601), so signed-in users may execute it.
--   * app.travel_grid (security invoker) reads app.travel_segments under its own policies (hospitality.fulfillment.read on
--     the project), so a reader sees every segment of a project or none, and the journey windows never split.
--     The fare (price_minor) is left out. The grid's export reads this relation (A102).

-- Names ---------------------------------------------------------------------------------------------------------------

create or replace function private.person_name_known(p_person_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_person_id is not null and (
    p_person_id in (select private.visible_person_ids())
    or exists (
      select 1 from app.engagements e
      where e.person_id = p_person_id and e.deleted_at is null and e.org_id in (select private.my_org_ids()))
    or exists (
      select 1 from app.applications a
      where a.applicant_person_id = p_person_id and a.deleted_at is null and a.org_id in (select private.my_org_ids()))
    or exists (
      select 1 from app.credentials c
      where c.holder_person_id = p_person_id and c.deleted_at is null and c.org_id in (select private.my_org_ids()))
    or exists (
      select 1 from app.certification_holders h
      where h.person_id = p_person_id and h.deleted_at is null and h.org_id in (select private.my_org_ids()))
    or exists (
      select 1 from private.roster_people rp
      join app.engagement_roster_entries r on r.id = rp.roster_entry_id
      join app.engagements e on e.id = r.engagement_id
      where rp.person_id = p_person_id and r.deleted_at is null and r.entry_state <> 'Withdrawn'
        and r.person_response <> 'Declined' and e.deleted_at is null and e.org_id in (select private.my_org_ids())));
$$;

comment on function private.person_name_known(uuid) is 'True when the signed-in person may know the person by name (1275, widened by B5): members of the reader''s orgs, and people those orgs engage, received an application from, recorded a credential or certification for, or carry on a live roster entry (not Withdrawn, not Declined) of a live engagement. The one rule of app.person_names and private.known_person_name.';
revoke all on function private.person_name_known(uuid) from public, anon, authenticated;

create or replace function app.person_names(p_person_ids uuid[])
returns table (person_id uuid, full_name text)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, p.full_name
  from app.people p
  where p.id = any (p_person_ids)
    and p.deleted_at is null
    and private.person_name_known(p.id);
$$;

comment on function app.person_names(uuid[]) is 'Display names of the requested people the reader may know by name: members of the reader''s orgs, and people those orgs engage, received an application from, recorded a credential or certification for (Section 4.8.3 Network), or carry on a live roster entry (not Withdrawn, not Declined) of a live engagement (B5). Returns full_name only.';

revoke all on function app.person_names(uuid[]) from public, anon;
grant execute on function app.person_names(uuid[]) to authenticated, service_role;

create or replace function private.known_person_name(p_person_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select p.full_name from app.people p
  where p.id = p_person_id and p.deleted_at is null and private.person_name_known(p.id);
$$;

comment on function private.known_person_name(uuid) is 'The person''s full_name when the signed-in person may know them by name (private.person_name_known, the rule of app.person_names), else NULL. B5''s invoker views read names through it instead of joining app.people, which RLS limits to the reader and their orgs'' members.';
revoke all on function private.known_person_name(uuid) from public, anon;
-- Function calls inside a view run with the caller's execute privilege, so signed-in users need it.
grant execute on function private.known_person_name(uuid) to authenticated, service_role;

-- The grid --------------------------------------------------------------------------------------------------------------

create view app.travel_grid with (security_invoker = on) as
with flights as (
  select t.*,
    lag(coalesce(t.arrives_at, t.departs_at)) over (partition by t.project_id, t.person_id order by t.departs_at, t.id) as previous_end
  from app.travel_segments t
  where t.deleted_at is null and t.travel_mode = 'Flight'
),
numbered as (
  select f.*,
    sum(case when f.previous_end is null or f.departs_at - f.previous_end > interval '24 hours' then 1 else 0 end)
      over (partition by f.project_id, f.person_id order by f.departs_at, f.id) as journey_seq
  from flights f
),
legs as (
  select n.id, n.org_id, n.project_id, n.person_id, n.engagement_id, n.fulfillment_id, n.travel_mode, n.operator_name,
    n.service_identifier, n.confirmation_identifier, n.departs_from, n.departs_at, n.departs_time_zone, n.arrives_at_place,
    n.arrives_at, n.arrives_time_zone,
    first_value(n.id) over j as journey_id,
    (row_number() over j)::integer as leg_number,
    (count(*) over (partition by n.project_id, n.person_id, n.journey_seq))::integer as leg_count,
    last_value(n.arrives_at) over jw as final_arrival_at,
    last_value(n.arrives_at_place) over jw as final_arrival_place,
    last_value(n.arrives_time_zone) over jw as final_arrival_time_zone
  from numbered n
  window j as (partition by n.project_id, n.person_id, n.journey_seq order by n.departs_at, n.id),
    jw as (partition by n.project_id, n.person_id, n.journey_seq order by n.departs_at, n.id
           rows between unbounded preceding and unbounded following)
),
segments as (
  select l.id, l.org_id, l.project_id, l.person_id, l.engagement_id, l.fulfillment_id, l.travel_mode, l.operator_name,
    l.service_identifier, l.confirmation_identifier, l.departs_from, l.departs_at, l.departs_time_zone, l.arrives_at_place,
    l.arrives_at, l.arrives_time_zone, l.journey_id, l.leg_number, l.leg_count, l.final_arrival_at, l.final_arrival_place,
    l.final_arrival_time_zone
  from legs l
  union all
  select g.id, g.org_id, g.project_id, g.person_id, g.engagement_id, g.fulfillment_id, g.travel_mode, g.operator_name,
    g.service_identifier, g.confirmation_identifier, g.departs_from, g.departs_at, g.departs_time_zone, g.arrives_at_place,
    g.arrives_at, g.arrives_time_zone, g.id, 1, 1, g.arrives_at, g.arrives_at_place, g.arrives_time_zone
  from app.travel_segments g
  where g.deleted_at is null and g.travel_mode = 'Ground'
)
select s.id, s.org_id, s.project_id, s.person_id, private.known_person_name(s.person_id) as traveler_name, s.engagement_id,
  s.fulfillment_id, s.travel_mode, s.operator_name, s.service_identifier, s.confirmation_identifier, s.departs_from,
  s.departs_at, s.departs_time_zone, s.arrives_at_place, s.arrives_at, s.arrives_time_zone,
  case
    when s.departs_at > now() then 'Upcoming'
    when s.arrives_at is null then 'Departed'
    when s.arrives_at > now() then 'In Flight'
    else 'Landed'
  end as phase,
  s.journey_id, s.leg_number, s.leg_count, s.final_arrival_at, s.final_arrival_place, s.final_arrival_time_zone
from segments s;

call private.describe('app.travel_grid', 'Every live travel segment the reader may see across the org or a project (B5, G-58), with the traveller''s name, the journey the segment belongs to and its phase now. Flight legs of one traveller on one project form a journey while each departs within 24 hours of the previous leg''s arrival (its departure when the arrival is unknown); a Ground segment is a journey of one leg. Phase and journey are computed on every read, never stored. The fare never appears. Rows follow the travel segments'' policies (hospitality.fulfillment.read on the project).', array[
  'id', 'Travel segment.',
  'org_id', 'Owning org.',
  'project_id', 'Project.',
  'person_id', 'Traveller.',
  'traveler_name', 'Traveller''s full name when the reader may know them by name (private.known_person_name), else NULL.',
  'engagement_id', 'Engagement travelled under, when one is named.',
  'fulfillment_id', 'Travel fulfillment the segment belongs to, when one does.',
  'travel_mode', 'Flight or Ground.',
  'operator_name', 'Airline, car service or other operator.',
  'service_identifier', 'Flight or service number, issued by the operator.',
  'confirmation_identifier', 'Booking confirmation code, issued by the operator.',
  'departs_from', 'Departure airport, station or pickup address.',
  'departs_at', 'Departure instant.',
  'departs_time_zone', 'IANA zone the departure time was entered in.',
  'arrives_at_place', 'Arrival airport, station or drop-off address.',
  'arrives_at', 'Arrival instant, when known.',
  'arrives_time_zone', 'IANA zone the arrival time was entered in.',
  'phase', 'Upcoming before departure; In Flight after departure while the arrival is still ahead; Departed after departure when the arrival is unknown; Landed once the arrival has passed. Computed with now().',
  'journey_id', 'Id of the first leg of the journey; a Ground segment''s own id.',
  'leg_number', 'Position of the segment in its journey, from 1.',
  'leg_count', 'Legs in the journey.',
  'final_arrival_at', 'Arrival instant of the journey''s last leg, when known.',
  'final_arrival_place', 'Arrival place of the journey''s last leg.',
  'final_arrival_time_zone', 'IANA zone of the journey''s last arrival.'
]);

revoke all on app.travel_grid from public, anon;
grant select on app.travel_grid to authenticated, service_role;
-- 1650 grants the backup login SELECT on every new relation; pg_dump never reads a view's rows.
revoke select on app.travel_grid from xos_backup;
