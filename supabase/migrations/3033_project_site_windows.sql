-- 3033_project_site_windows.sql
-- B14 Event types and project setup (RRR-238; parity gap G-262; ADR 0153 decision D1; ADR 0143 decision 1; block 3030
-- to 3039). Bump-in and bump-out windows. ADR 0143 decision 1 (B4) derives them from a project's days and stores no
-- second load-in or load-out date, so nothing is stored here (ADR 0153 C1):
--
--   * projects.starts_on and ends_on are the show dates, the first and last show or event day (D1); the frozen v1
--     contract already reads them as "First show day" and "Last show day", and their column comments now say so.
--   * private.project_bump_windows computes the windows from the live Load In and Load Out days of app.project_days
--     (2930): bump-in runs from 00:00 of the first Load In day to 00:00 of the day after the last one, bump-out the same
--     over Load Out days, each day at midnight in its own zone (the venue's, the stored zone, else the project's).
--   * app.project_site_window_warnings lists, without refusing anything, a Load In day after the first Show day at its
--     venue, a Load Out day before the last one there, load-in and load-out dates that overlap at a venue, more than 60
--     dates of load-in or load-out and bump days without show dates. Each day is judged at its venue (its own, else its
--     Show node's) against the Show days there, and against starts_on and ends_on only when the project has no Show day
--     at that venue, so a tour that loads in at each stop raises nothing; B4's day editor is never refused. The windows
--     themselves (private.project_bump_windows, private.project_site_window) stay project-wide.
--   * app.project_site_windows gives the apps both windows and the site window of each project they read.
--   * private.project_site_window (R7a, 2683) is restated with the bump windows first: its lower bound is the bump-in
--     start, else the earliest live Build record, else starts_on at 00:00; its upper bound the bump-out end, else the
--     latest live Strike record, else the day after ends_on at 00:00. app.po_line_hire_warnings and
--     app.hire_window_warnings read it and follow without change; private.hire_window_rules is untouched.
-- Both views revoke select from xos_backup (1650).

comment on column app.projects.starts_on is 'First show day: the first show or event day of the project (ADR 0153 D1). Build days are Load In days of app.project_days, which give the bump-in window.';
comment on column app.projects.ends_on is 'Last show day: the last show or event day of the project (ADR 0153 D1). Strike days are Load Out days of app.project_days, which give the bump-out window.';

-- The windows, computed from the days ------------------------------------------------------------------------------------------

create or replace function private.project_bump_windows(p_project_id uuid)
returns table (bump_in tstzrange, bump_out tstzrange)
language sql
stable
security definer
set search_path = ''
as $$
  with days as (
    select d.day_type,
      (d.day_on::timestamp at time zone coalesce(v.time_zone, nv.time_zone, d.time_zone, p.time_zone)) as opens_at,
      ((d.day_on + 1)::timestamp at time zone coalesce(v.time_zone, nv.time_zone, d.time_zone, p.time_zone)) as closes_at
    from app.project_days d
    join app.projects p on p.id = d.project_id
    left join app.venues v on v.id = d.venue_id
    left join app.scope_nodes n on n.id = d.scope_node_id
    left join app.venues nv on nv.id = n.venue_id
    where d.project_id = p_project_id and d.deleted_at is null and d.day_type in ('Load In', 'Load Out')
      and (private.can_on_project(p_project_id, 'procurement.po.read')
           or private.can_on_project(p_project_id, 'schedule.timeline.read'))
  )
  select
    (select tstzrange(min(x.opens_at), max(x.closes_at), '[)') from days x where x.day_type = 'Load In' having count(*) > 0),
    (select tstzrange(min(x.opens_at), max(x.closes_at), '[)') from days x where x.day_type = 'Load Out' having count(*) > 0);
$$;

comment on function private.project_bump_windows(uuid) is 'The project''s bump-in and bump-out windows (G-262, ADR 0153 D1 and C1), computed from its live project days (2930) and never stored: bump-in runs from 00:00 of the first Load In day to 00:00 of the day after the last Load In day, bump-out the same over Load Out days, each day at midnight in its own zone (its venue''s, its Show node''s venue''s, its stored zone, else the project''s). A window is NULL when the project has no such day. Both are NULL unless the caller reads purchase orders (procurement.po.read) or the schedule (schedule.timeline.read) on the project.';
revoke all on function private.project_bump_windows(uuid) from public, anon;
grant execute on function private.project_bump_windows(uuid) to authenticated, service_role;

-- The site window, bump windows first --------------------------------------------------------------------------------------------
-- Restated from 2683_hire_views_and_warnings.sql, its only definition, with the bump windows taking precedence.

create or replace function private.project_site_window(p_project_id uuid)
returns tstzrange
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_project app.projects;
  v_from timestamptz;
  v_to timestamptz;
  v_bump_in tstzrange;
  v_bump_out tstzrange;
begin
  if not private.can_on_project(p_project_id, 'procurement.po.read') then
    return null;
  end if;
  select * into v_project from app.projects p where p.id = p_project_id;
  select w.bump_in, w.bump_out into v_bump_in, v_bump_out from private.project_bump_windows(p_project_id) w;
  select min(r.starts_at) into v_from from app.records r
  where r.project_id = p_project_id and r.record_kind = 'Build' and r.deleted_at is null
    and r.record_state not in ('Deferred', 'Canceled');
  select max(r.ends_at) into v_to from app.records r
  where r.project_id = p_project_id and r.record_kind = 'Strike' and r.deleted_at is null
    and r.record_state not in ('Deferred', 'Canceled');
  v_from := coalesce(lower(v_bump_in), v_from, v_project.starts_on::timestamp at time zone v_project.time_zone);
  v_to := coalesce(upper(v_bump_out), v_to, (v_project.ends_on + 1)::timestamp at time zone v_project.time_zone);
  -- A Strike recorded before the Build leaves no usable window end.
  if v_from is not null and v_to is not null and v_to < v_from then
    v_to := null;
  end if;
  return tstzrange(v_from, v_to, '[)');
end;
$$;
comment on function private.project_site_window(uuid) is 'The project''s site window (R7a, G-99; B14, G-262): from the start of its bump-in window (its first Load In day, private.project_bump_windows), else the earliest start of its live Build records (not Deferred or Canceled), else its starts_on at 00:00 in its time zone, to the end of its bump-out window (the day after its last Load Out day), else the latest end of its live Strike records, else the day after its ends_on at 00:00. Either bound may be unbounded when nothing sets it. NULL unless the caller reads purchase orders on the project (procurement.po.read).';
revoke all on function private.project_site_window(uuid) from public, anon;
grant execute on function private.project_site_window(uuid) to authenticated, service_role;

-- The windows for the apps ---------------------------------------------------------------------------------------------------------

create view app.project_site_windows with (security_invoker = true) as
select p.id as project_id, p.org_id, w.bump_in, w.bump_out, private.project_site_window(p.id) as site_window
from app.projects p
cross join lateral private.project_bump_windows(p.id) w
where p.deleted_at is null;

call private.describe('app.project_site_windows', 'Bump-in, bump-out and site windows of each live project the reader reads (G-262, ADR 0153 C1), computed from its days and never stored. The dock schedule shades the bump windows and procurement compares hires with the site window. Runs as the reader.', array[
  'project_id', 'Project.',
  'org_id', 'Org.',
  'bump_in', 'From 00:00 of the first Load In day to 00:00 of the day after the last; NULL with no Load In day, or for a reader of neither purchase orders nor the schedule.',
  'bump_out', 'From 00:00 of the first Load Out day to 00:00 of the day after the last; NULL with no Load Out day, or for a reader of neither purchase orders nor the schedule.',
  'site_window', 'The R7a site window (private.project_site_window); NULL unless the reader reads purchase orders on the project.'
]);
revoke all on app.project_site_windows from public, anon;
grant select on app.project_site_windows to authenticated, service_role;
revoke select on app.project_site_windows from xos_backup;

-- Warnings, never refusals ------------------------------------------------------------------------------------------------------------

create view app.project_site_window_warnings with (security_invoker = true) as
with days as (
  -- Each live day at its venue: its own, else its Show node's.
  select d.project_id, d.day_on, d.day_type, coalesce(d.venue_id, n.venue_id) as venue_id
  from app.project_days d
  left join app.scope_nodes n on n.id = d.scope_node_id
  where d.deleted_at is null and d.day_type in ('Load In', 'Show', 'Load Out')
),
shows as (
  select s.project_id, s.venue_id, min(s.day_on) as first_on, max(s.day_on) as last_on
  from days s where s.day_type = 'Show'
  group by s.project_id, s.venue_id
),
bumps as (
  select b.project_id, b.venue_id,
    min(b.day_on) filter (where b.day_type = 'Load In') as in_first, max(b.day_on) filter (where b.day_type = 'Load In') as in_last,
    min(b.day_on) filter (where b.day_type = 'Load Out') as out_first, max(b.day_on) filter (where b.day_type = 'Load Out') as out_last
  from days b where b.day_type in ('Load In', 'Load Out')
  group by b.project_id, b.venue_id
)
select x.project_id, x.org_id, x.warning, x.day_on
from (
  -- A Load In day after the first Show day at its venue; with no Show day there, after the first show day. The show
  -- day itself never warns.
  select p.id as project_id, p.org_id, 'project_bump_in_after_show'::text as warning, d.day_on, 1 as ord
  from app.projects p
  join days d on d.project_id = p.id and d.day_type = 'Load In'
  left join shows s on s.project_id = p.id and s.venue_id is not distinct from d.venue_id
  where p.deleted_at is null and d.day_on > coalesce(s.first_on, p.starts_on)
  union all
  select p.id, p.org_id, 'project_bump_out_before_show', d.day_on, 2
  from app.projects p
  join days d on d.project_id = p.id and d.day_type = 'Load Out'
  left join shows s on s.project_id = p.id and s.venue_id is not distinct from d.venue_id
  where p.deleted_at is null and d.day_on < coalesce(s.last_on, p.ends_on)
  union all
  -- Load-in and load-out dates that overlap at one venue.
  select p.id, p.org_id, 'project_bump_windows_overlap', null::date, 3
  from app.projects p
  where p.deleted_at is null
    and exists (select 1 from bumps b
                where b.project_id = p.id and b.in_first <= b.out_last and b.out_first <= b.in_last)
  union all
  -- More than 60 dates from the first to the last Load In day, or Load Out day, counted as dates.
  select p.id, p.org_id, 'project_bump_window_length', null::date, 4
  from app.projects p
  where p.deleted_at is null
    and exists (select 1 from days d where d.project_id = p.id and d.day_type in ('Load In', 'Load Out')
                group by d.day_type having max(d.day_on) - min(d.day_on) + 1 > 60)
  union all
  select p.id, p.org_id, 'project_bump_window_dates', null::date, 5
  from app.projects p
  where p.deleted_at is null and (p.starts_on is null or p.ends_on is null)
    and exists (select 1 from app.project_days d
                where d.project_id = p.id and d.deleted_at is null and d.day_type in ('Load In', 'Load Out'))
) x
order by x.project_id, x.ord, x.day_on;

call private.describe('app.project_site_window_warnings', 'Bump-in and bump-out checks against the show dates (G-262, ADR 0153 C1), one row per warning; nothing is refused, since a touring project has load-ins between show days. Each day is judged at its venue (its own, else its Show node''s) against the Show days of app.project_days at that venue, and against the project''s show dates only when the project has no Show day there. project_bump_in_after_show: a Load In day after the first Show day at its venue (a load-in on that day is fine); project_bump_out_before_show: a Load Out day before the last Show day at its venue; project_bump_windows_overlap: load-in and load-out dates overlap at one venue; project_bump_window_length: more than 60 dates from the project''s first to its last Load In day, or Load Out day; project_bump_window_dates: Load In or Load Out days on a project without both show dates. Computed, never stored; runs as the reader, so the days'' row level security (schedule.timeline.read) applies.', array[
  'project_id', 'Project.',
  'org_id', 'Org.',
  'warning', 'The warning''s code.',
  'day_on', 'The Load In or Load Out day the warning is about; NULL for a warning about the windows or the dates.'
]);
revoke all on app.project_site_window_warnings from public, anon;
grant select on app.project_site_window_warnings to authenticated, service_role;
revoke select on app.project_site_window_warnings from xos_backup;
