-- 2935_workload.sql
-- B4 Scheduling depth (RRR-228; parity gap G-45; ADR 0143 decisions 5 to 7; ADR 0103; ADR 0022 block 2930 to 2939). The
-- workload view: hours per person per day from shifts and task estimates, computed at read time and never stored.
--
--   * scheduling.workload_day_hours (organization, org.scheduling.write, default 10, 4 to 24): the day above which a
--     person's hours show as over. packages/data/src/workload.ts applies it (isOver); the database only sums.
--   * app.view_type gains Heatmap, the saved label of views.yaml's heatmap view (ADR 0143 decision 7). It is not used
--     in this file, so the new value is committed before anything stores it.
--   * app.workload(org, from, to, project) runs as the caller (security invoker), so row level security decides which
--     shifts and records count and a viewer without access to a project sees none of its hours (decision 6):
--       - shift minutes: live shifts that are not Canceled, for the membership's person or the engagement's person,
--         split at local midnight in the shift's own zone;
--       - task hours: record_task.effort_hours of live Task records that are not Complete or Canceled, spread evenly over
--         the local days (project zone) from start to end, or all on the due day of a due-only record, shared equally
--         by the record's live assignees, else given to its owner;
--       - unestimated tasks: such Task records without an estimate, counted once on each of their days.
--     At most 92 days (22023). Only person-days with something on them are returned.

select private.define_setting('scheduling.workload_day_hours', 'Integer', 'org.scheduling.write', array['organization'], false, p_default_integer => 10, p_min_integer => 4, p_max_integer => 24);

alter type app.view_type add value if not exists 'Heatmap';

create or replace function app.workload(p_org_id uuid, p_from date, p_to date, p_project_id uuid default null)
returns table (
  person_id uuid,
  person_name text,
  day date,
  shift_minutes integer,
  task_hours numeric,
  unestimated_tasks integer,
  total_hours numeric
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
#variable_conflict use_column
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'a signed-in person is required';
  end if;
  if p_org_id is null or p_from is null or p_to is null or p_to < p_from or p_to - p_from > 91 then
    raise exception using errcode = '22023', message = 'the workload covers 1 to 92 days of one organization';
  end if;

  return query
  with shift_days as (
    -- Each shift split at local midnight in its own zone.
    select coalesce(m.person_id, e.person_id) as person_id, d::date as day,
      (extract(epoch from (
        least(s.ends_at, ((d::date + 1)::timestamp at time zone s.time_zone))
        - greatest(s.starts_at, (d::date::timestamp at time zone s.time_zone))
      )) / 60)::integer as minutes
    from app.shifts s
    join app.projects p on p.id = s.project_id and p.deleted_at is null and p.org_id = p_org_id
    left join app.memberships m on m.id = s.membership_id
    left join app.engagements e on e.id = s.engagement_id
    cross join lateral generate_series((s.starts_at at time zone s.time_zone)::date::timestamp,
      ((s.ends_at - interval '1 microsecond') at time zone s.time_zone)::date::timestamp, interval '1 day') d
    where s.deleted_at is null and s.shift_state <> 'Canceled'
      and (p_project_id is null or s.project_id = p_project_id)
      and coalesce(m.person_id, e.person_id) is not null
      and s.ends_at > (p_from::timestamp at time zone s.time_zone) - interval '1 day'
      and s.starts_at < ((p_to + 1)::timestamp at time zone s.time_zone) + interval '1 day'
  ), tasks as (
    -- Open Task records with their local days in the project zone.
    select r.id, r.owner_party_id, t.effort_hours,
      (coalesce(r.starts_at, r.due_at) at time zone p.time_zone)::date as first_day,
      (coalesce(r.ends_at, r.starts_at, r.due_at) at time zone p.time_zone)::date as last_day
    from app.records r
    join app.projects p on p.id = r.project_id and p.deleted_at is null and p.org_id = p_org_id
    left join app.record_task t on t.record_id = r.id
    where r.deleted_at is null and r.record_kind = 'Task' and r.record_state not in ('Complete', 'Canceled')
      and (p_project_id is null or r.project_id = p_project_id)
      and coalesce(r.starts_at, r.due_at) is not null
  ), task_people as (
    -- The live assignees share a task; with none, its owner carries it.
    select k.id, x.person_id, x.share
    from tasks k
    cross join lateral (
      select a.person_id, 1.0 / count(*) over () as share
      from (select distinct m.person_id from app.record_assignments ra
            join app.memberships m on m.id = ra.membership_id
            where ra.record_id = k.id and ra.deleted_at is null) a
      union all
      select k.owner_party_id, 1.0
      where k.owner_party_id is not null
        and not exists (select 1 from app.record_assignments ra where ra.record_id = k.id and ra.deleted_at is null)
    ) x
  ), task_days as (
    select tp.person_id, d::date as day,
      case when k.effort_hours is null then 0
        else k.effort_hours * tp.share / (greatest(k.last_day, k.first_day) - k.first_day + 1) end as hours,
      (k.effort_hours is null)::integer as unestimated
    from tasks k
    join task_people tp on tp.id = k.id
    cross join lateral generate_series(k.first_day::timestamp, greatest(k.last_day, k.first_day)::timestamp, interval '1 day') d
  ), merged as (
    select x.person_id, x.day, sum(x.minutes)::integer as shift_minutes, 0::numeric as task_hours, 0 as unestimated
    from shift_days x where x.day between p_from and p_to and x.minutes > 0 group by x.person_id, x.day
    union all
    select y.person_id, y.day, 0, sum(y.hours), sum(y.unestimated)::integer
    from task_days y where y.day between p_from and p_to group by y.person_id, y.day
  )
  select g.person_id, pp.full_name, g.day, sum(g.shift_minutes)::integer, round(sum(g.task_hours), 2),
    sum(g.unestimated)::integer, round(sum(g.shift_minutes) / 60.0 + sum(g.task_hours), 2)
  from merged g
  left join lateral app.person_names(array[g.person_id]) pp on true
  group by g.person_id, pp.full_name, g.day
  having sum(g.shift_minutes) > 0 or sum(g.task_hours) > 0 or sum(g.unestimated) > 0
  order by pp.full_name nulls last, g.person_id, g.day;
end;
$$;

comment on function app.workload(uuid, date, date, uuid) is 'Hours per person per day (G-45, ADR 0143 decision 5), computed at read time as the caller so row level security decides what counts: shift minutes of live, non-Canceled shifts (the membership''s or the engagement''s person) split at local midnight in each shift''s zone; task hours from the effort estimates of open Task records spread evenly over their local days in the project zone (a due-only record on its due day), shared equally by the live assignees or carried by the owner; and the open Task records without an estimate, counted on each of their days. 1 to 92 days (22023). Returns only person-days with something on them; scheduling.workload_day_hours is applied by packages/data.';
revoke all on function app.workload(uuid, date, date, uuid) from public, anon;
grant execute on function app.workload(uuid, date, date, uuid) to authenticated, service_role;
