-- 2612_engagement_up_next.sql
-- R2 Advancing read gaps (RRR-180, ADR 0100 to 0104). Gateway Home's Up Next card says when and where to be and whom
-- to ask (Section 4.4.4: the engaged party's next call, the venue and the org contact).
--
--   * api_external.engagement_up_next: one row per engagement whose engagement area the caller reaches, with the
--     project's venue, the name of the member who created the engagement while they still belong to the org, and,
--     while the operational area is open, the next call: the earliest future start among the engagement's Published
--     or Accepted shifts (in the shift's zone), its dock slots not yet checked in and its set cues not yet called
--     (both in the project's zone).
-- The tables read here carry no private.column_classifications rows, so the view adds no logged read.

create view api_external.engagement_up_next as
select e.id as engagement_id, e.project_id,
  v.name as venue_name, v.street_address as venue_street_address, v.locality as venue_locality, v.postal_code as venue_postal_code,
  case when exists (
    select 1 from app.memberships m
    where m.person_id = e.created_by and m.org_id = e.org_id and m.deleted_at is null
      and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now()))
  then cp.full_name end as contact_name,
  n.starts_at as next_call_at, n.time_zone as next_call_time_zone, n.call_kind as next_call_kind
from app.engagements e
join app.projects p on p.id = e.project_id
left join app.venues v on v.id = p.venue_id and v.deleted_at is null
left join app.people cp on cp.id = e.created_by
cross join lateral (select array(select s from private.engagement_scope(e.id) s) as areas) a
left join lateral (
  select x.starts_at, x.time_zone, x.call_kind
  from (
    select s.starts_at, s.time_zone, 'Shift'::text as call_kind
    from app.shifts s
    where s.engagement_id = e.id and s.deleted_at is null and s.shift_state in ('Published', 'Accepted') and s.starts_at > now()
    union all
    select d.starts_at, p.time_zone, 'Dock Slot'::text
    from app.dock_slots d
    where d.engagement_id = e.id and d.deleted_at is null and d.checked_in_at is null and d.starts_at > now()
    union all
    select c.planned_at, p.time_zone, 'Set'::text
    from app.engagement_cues ec
    join app.cues c on c.id = ec.cue_id and c.deleted_at is null
    join app.run_of_show r on r.id = c.run_of_show_id and r.deleted_at is null
    where ec.engagement_id = e.id and ec.deleted_at is null and c.planned_at > now() and c.called_at is null
  ) x
  where 'operational' = any (a.areas)
  order by x.starts_at
  limit 1
) n on true
where e.deleted_at is null and e.id in (select private.my_engagement_ids('engagement'));

call private.describe('api_external.engagement_up_next', 'What Gateway Home''s Up Next card shows for the caller''s engagements (Section 4.4.4): the project''s venue, the org member who set up the engagement while they still belong to the org, and, while the operational area is open, the next call: a Published or Accepted shift, a dock slot not yet checked in or a set cue not yet called.', array[
  'engagement_id', 'Engagement.', 'project_id', 'Project.', 'venue_name', 'Venue of the project.',
  'venue_street_address', 'Street address line of the venue.', 'venue_locality', 'City or locality of the venue.',
  'venue_postal_code', 'Postal code of the venue.', 'contact_name', 'Org member who set up the engagement; NULL once they leave the org.',
  'next_call_at', 'Start of the next call; NULL when none or the operational area is closed.',
  'next_call_time_zone', 'IANA time zone the next call is shown in: the shift''s, or the project''s for a dock slot or set.',
  'next_call_kind', 'Shift, Dock Slot or Set.']);

revoke all on api_external.engagement_up_next from public, anon;
grant select on api_external.engagement_up_next to authenticated, service_role;
