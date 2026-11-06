-- 2983_scheduling_policy.sql
-- B9 (RRR-233; ADR 0148; parity gap G-121, built on A132's scheduling board): an org's rest gap and daily and weekly
-- maximum hours, shown as warnings before a person is put on a shift. They are org scheduling policies, never refusals
-- and never pay rules: state overtime and break rules stay deferred (ADR 0033 decision 54, trace S14.5-05, ADR 0041),
-- and app.calculate_payroll_run is untouched.
--
--   * scheduling.min_rest_hours, scheduling.max_daily_hours and scheduling.max_weekly_hours (2980, organization scope;
--     0 is off, the default).
--   * private.shift_policy_warnings(shift, person): the warnings for that person if they held the shift. Scheduled
--     minutes are a shift's length less its scheduled_break_minutes (A132's templates write it). The shifts counted are
--     the person's live, not canceled shifts in the org through any worker column, plus the candidate shift. Codes:
--     shift_rest_short (the gap to the nearest earlier or later shift is under the rest), shift_day_over (the minutes
--     starting on the shift's day, in its time zone) and shift_week_over (the minutes in the week starting on the org's
--     payroll.week_start, read as 1399 reads it, in the shift's time zone). Overlap is A132's conflict flag and B4's
--     person_double_booked, not repeated here. B4's scheduling.workload_day_hours is the workload heatmap's threshold,
--     a separate setting.
--   * app.shift_policy_warnings(shift, people): up to 200 people at once, for crew.shift.write holders on the project,
--     or a person asking about themself on a shift they can read (they work it, read shifts on the project, or it is a
--     published open shift). Minutes count org-wide, as app.rank_shift_candidates (2251) does; the other shift's id is
--     returned only to a caller who can read that shift.

create or replace function private.policy_shifts(p_shift_id uuid, p_person_id uuid)
returns table (id uuid, starts_at timestamptz, ends_at timestamptz, minutes integer, local_day date)
language sql
stable
security definer
set search_path = ''
as $$
  with v as (select s.* from app.shifts s where s.id = p_shift_id and s.deleted_at is null)
  select s.id, s.starts_at, s.ends_at,
    greatest((extract(epoch from (s.ends_at - s.starts_at)) / 60)::integer - coalesce(s.scheduled_break_minutes, 0), 0),
    (s.starts_at at time zone v.time_zone)::date
  from v join app.shifts s on s.org_id = v.org_id
  where s.deleted_at is null and s.shift_state <> 'Canceled'
    and (s.id = v.id or private.shift_worker_person_id(s.membership_id, s.engagement_id, s.roster_entry_id) = p_person_id);
$$;

comment on function private.policy_shifts(uuid, uuid) is 'The shifts the scheduling warnings count (B9): the person''s live, not canceled shifts in the shift''s org through any worker column, plus the shift itself as if they held it, each with its scheduled minutes (length less scheduled_break_minutes) and its start day in the shift''s time zone.';
revoke all on function private.policy_shifts(uuid, uuid) from public, anon, authenticated;

create or replace function private.shift_policy_warnings(p_shift_id uuid, p_person_id uuid)
returns table (code text, minutes integer, limit_minutes integer, other_shift_id uuid)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_shift app.shifts;
  v_rest integer;
  v_daily integer;
  v_weekly integer;
  v_week_start integer;
  v_day date;
  v_week date;
  v_total integer;
  v_other record;
begin
  select * into v_shift from app.shifts s where s.id = p_shift_id and s.deleted_at is null;
  if v_shift.id is null or p_person_id is null then
    return;
  end if;
  v_rest := coalesce(private.org_setting_integer(v_shift.org_id, 'scheduling.min_rest_hours'), 0)::integer;
  v_daily := coalesce(private.org_setting_integer(v_shift.org_id, 'scheduling.max_daily_hours'), 0)::integer;
  v_weekly := coalesce(private.org_setting_integer(v_shift.org_id, 'scheduling.max_weekly_hours'), 0)::integer;
  if v_rest = 0 and v_daily = 0 and v_weekly = 0 then
    return;
  end if;

  if v_rest > 0 then
    select x.id, x.ends_at into v_other from private.policy_shifts(p_shift_id, p_person_id) x
    where x.id <> v_shift.id and x.ends_at <= v_shift.starts_at order by x.ends_at desc limit 1;
    if v_other.id is not null and v_shift.starts_at - v_other.ends_at < make_interval(hours => v_rest) then
      return query select 'shift_rest_short'::text, (extract(epoch from (v_shift.starts_at - v_other.ends_at)) / 60)::integer,
        v_rest * 60, v_other.id;
    end if;
    select x.id, x.starts_at into v_other from private.policy_shifts(p_shift_id, p_person_id) x
    where x.id <> v_shift.id and x.starts_at >= v_shift.ends_at order by x.starts_at limit 1;
    if v_other.id is not null and v_other.starts_at - v_shift.ends_at < make_interval(hours => v_rest) then
      return query select 'shift_rest_short'::text, (extract(epoch from (v_other.starts_at - v_shift.ends_at)) / 60)::integer,
        v_rest * 60, v_other.id;
    end if;
  end if;

  v_day := (v_shift.starts_at at time zone v_shift.time_zone)::date;
  if v_daily > 0 then
    select coalesce(sum(x.minutes), 0)::integer into v_total from private.policy_shifts(p_shift_id, p_person_id) x where x.local_day = v_day;
    if v_total > v_daily * 60 then
      return query select 'shift_day_over'::text, v_total, v_daily * 60, null::uuid;
    end if;
  end if;

  if v_weekly > 0 then
    -- Weeks start on the org's payroll.week_start, as payroll counts them (1398, kept by 1399).
    v_week_start := case private.setting_text(v_shift.org_id, 'payroll.week_start') when 'monday' then 1 else 0 end;
    v_week := v_day - ((extract(dow from v_day)::integer - v_week_start + 7) % 7);
    select coalesce(sum(x.minutes), 0)::integer into v_total from private.policy_shifts(p_shift_id, p_person_id) x
    where x.local_day >= v_week and x.local_day < v_week + 7;
    if v_total > v_weekly * 60 then
      return query select 'shift_week_over'::text, v_total, v_weekly * 60, null::uuid;
    end if;
  end if;
end;
$$;

comment on function private.shift_policy_warnings(uuid, uuid) is 'The org''s scheduling warnings (B9, ADR 0148) for a person if they held a shift: shift_rest_short when the gap to their nearest earlier or later shift is under scheduling.min_rest_hours, shift_day_over when the scheduled minutes starting on the shift''s day exceed scheduling.max_daily_hours, shift_week_over when the week starting on payroll.week_start exceeds scheduling.max_weekly_hours, both in the shift''s time zone. Scheduled minutes are a shift''s length less scheduled_break_minutes; the person''s live, not canceled shifts in the org through any worker column count. Warnings only, never pay rules; 0 turns each off.';
revoke all on function private.shift_policy_warnings(uuid, uuid) from public, anon, authenticated;

create or replace function app.shift_policy_warnings(p_shift_id uuid, p_person_ids uuid[])
returns table (person_id uuid, code text, minutes integer, limit_minutes integer, other_shift_id uuid)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_shift app.shifts;
begin
  select * into v_shift from app.shifts s where s.id = p_shift_id and s.deleted_at is null;
  -- Asking about yourself still needs the shift: a shift id elsewhere must not say that org's limits or that it exists.
  if v_shift.id is null
     or not (private.can_on_project(v_shift.project_id, 'crew.shift.write')
             or (p_person_ids = array[v_person]
                 and (private.shift_worker_person_id(v_shift.membership_id, v_shift.engagement_id, v_shift.roster_entry_id) is not distinct from v_person
                      or private.can_on_project(v_shift.project_id, 'crew.shift.read')
                      or (num_nonnulls(v_shift.membership_id, v_shift.engagement_id, v_shift.roster_entry_id, v_shift.project_position_id) = 0
                          and v_shift.shift_state = 'Published'
                          and private.capability_reach(v_shift.org_id, 'crew.shift.read') is not null)))) then
    raise exception using errcode = '42501', message = 'crew.shift.write on the project, or asking about yourself, reads scheduling warnings';
  end if;
  if coalesce(cardinality(p_person_ids), 0) not between 1 and 200 then
    perform private.refuse('shift_policy_batch', 'Ask about 1 to 200 people at a time.');
  end if;
  return query
    select p.id, w.code, w.minutes, w.limit_minutes,
      case when w.other_shift_id is not null and exists (
             select 1 from app.shifts o where o.id = w.other_shift_id
               and (private.can_on_project(o.project_id, 'crew.shift.read')
                    or private.shift_worker_person_id(o.membership_id, o.engagement_id, o.roster_entry_id) = v_person))
           then w.other_shift_id end
    from (select distinct u.id from unnest(p_person_ids) u (id) where u.id is not null) p
    cross join lateral private.shift_policy_warnings(p_shift_id, p.id) w
    order by p.id, w.code;
end;
$$;

comment on function app.shift_policy_warnings(uuid, uuid[]) is 'The org''s scheduling warnings (rest, daily and weekly maximum hours; B9, ADR 0148) for 1 to 200 people if they held a shift (shift_policy_batch), for the scheduling board and claim approval: crew.shift.write on the shift''s project, or a person asking only about themself on a shift they can read (they work it, crew.shift.read on the project, or a published open shift). Minutes count org-wide; other_shift_id is returned only when the caller can read that shift. Warnings never refuse an assignment.';
revoke all on function app.shift_policy_warnings(uuid, uuid[]) from public, anon;
grant execute on function app.shift_policy_warnings(uuid, uuid[]) to authenticated, service_role;
