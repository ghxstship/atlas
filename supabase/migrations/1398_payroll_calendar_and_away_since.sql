-- 1398_payroll_calendar_and_away_since.sql
-- Orchestrator (RRR-116, A71 and A76). Payroll and out of office follow the org's and the person's calendars, never
-- the database's UTC date or the ISO Monday week:
--
--   * app.next_pay_period_dates (1323) took p_today default current_date, and app.create_next_pay_period called it
--     without a date, so an org's first pay period lined up on the UTC date. At 21:00 on Oct 31 in New York (Nov 1
--     in UTC) a monthly org got November; a biweekly org with Sunday weeks got the next week on a Saturday evening.
--     Atlas's proposal passed the org's date, so the two disagreed. p_today now defaults to null, which means today
--     on the org's calendar (private.org_today, 1305), and create_next_pay_period passes that date. Every other
--     behavior of 1323 is unchanged.
--   * app.calculate_payroll_run (0463) counts weekly overtime over the org's payroll.week_start, the week pay periods,
--     timesheets and the Atlas schedule start on, not over date_trunc('week') Monday weeks.
--   * private.away_since (1325) starts an out-of-office period at midnight in the person's time zone, the day
--     private.person_away counts in, not at midnight UTC.

-- Pay periods on the org's calendar -------------------------------------------------------------------------------

create or replace function app.next_pay_period_dates(p_org_id uuid, p_today date default null)
returns table (starts_on date, ends_on date)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_pay_period text := coalesce(private.setting_text(p_org_id, 'payroll.pay_period'), 'biweekly');
  v_week_start integer := case private.setting_text(p_org_id, 'payroll.week_start') when 'monday' then 1 else 0 end;
  v_latest date;
  v_start date;
begin
  if p_org_id is null or p_org_id not in (select private.my_org_ids()) then
    raise exception using errcode = '42501', message = 'the org does not exist or you are not in it';
  end if;
  p_today := coalesce(p_today, private.org_today(p_org_id));
  select max(p.ends_on) into v_latest from app.pay_periods p where p.org_id = p_org_id and p.deleted_at is null;
  if v_latest is not null then
    v_start := v_latest + 1;
  elsif v_pay_period in ('weekly', 'biweekly') then
    v_start := p_today - ((extract(dow from p_today)::integer - v_week_start + 7) % 7);
  elsif v_pay_period = 'semimonthly' then
    v_start := case when extract(day from p_today) <= 15 then date_trunc('month', p_today)::date
      else (date_trunc('month', p_today) + interval '15 days')::date end;
  else
    v_start := date_trunc('month', p_today)::date;
  end if;
  return query select v_start, private.pay_period_end(v_start, v_pay_period);
end;
$$;

comment on function app.next_pay_period_dates(uuid, date) is 'The next pay period an org adds (1323): the day after its latest period, or for its first period today aligned to the org''s week start (weekly and biweekly), the 1st or 16th (semimonthly) or the 1st (monthly); it lasts as long as payroll.pay_period says. Today is p_today, or the org''s date (private.org_today) when it is null or omitted, never the UTC date (1398). For members of the org.';

create or replace function app.create_next_pay_period(p_org_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_dates record;
  v_id uuid;
begin
  perform private.require_person();
  if not private.has_capability(p_org_id, 'crew.pay_period.manage') then
    raise exception using errcode = '42501', message = 'crew.pay_period.manage is required';
  end if;
  select * into v_dates from app.next_pay_period_dates(p_org_id, private.org_today(p_org_id));
  insert into app.pay_periods (org_id, starts_on, ends_on) values (p_org_id, v_dates.starts_on, v_dates.ends_on)
  returning id into v_id;
  return v_id;
end;
$$;

comment on function app.create_next_pay_period(uuid) is 'Adds the org''s next pay period on the dates app.next_pay_period_dates proposes for today on the org''s calendar (payroll.pay_period and payroll.week_start, 1323; private.org_today, 1398). Needs crew.pay_period.manage. Returns the period id.';

revoke all on function app.next_pay_period_dates(uuid, date) from public, anon;
revoke all on function app.create_next_pay_period(uuid) from public, anon;
grant execute on function app.next_pay_period_dates(uuid, date) to authenticated, service_role;
grant execute on function app.create_next_pay_period(uuid) to authenticated, service_role;

-- Weekly overtime on the org's payroll week -------------------------------------------------------------------------
-- app.calculate_payroll_run (0463) grouped overtime by date_trunc('week'), always a Monday week, and never read
-- payroll.week_start, while pay periods (1323), new timesheets and the Atlas schedule's overtime warning start weeks
-- on it (Sunday by default). A Sunday shift counted in the previous Monday week, so 10 hours on Sunday and 38 from
-- Monday to Thursday paid no overtime though the planner warned of 8. The week a time entry counts in now starts on
-- the org's payroll.week_start, in the project's time zone as before; everything else is 0463's definition.

create or replace function app.calculate_payroll_run(p_payroll_run_id uuid, p_reason text default 'Calculated from approved timesheets.')
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_run app.payroll_runs;
  v_period app.pay_periods;
  v_regular uuid;
  v_overtime uuid;
  v_count integer;
  v_week_start integer;
begin
  perform private.require_person();
  select * into v_run from app.payroll_runs r where r.id = p_payroll_run_id and r.deleted_at is null for update;
  if v_run.id is null or not private.has_capability(v_run.org_id, 'crew.pay_period.manage') then
    raise exception using errcode = '42501', message = 'crew.pay_period.manage is required';
  end if;
  -- Overtime weeks start on the org's payroll.week_start (1323's pay periods start on it too), never a person's.
  v_week_start := case private.setting_text(v_run.org_id, 'payroll.week_start') when 'monday' then 1 else 0 end;
  if v_run.payroll_run_state <> 'Draft' then
    perform private.refuse('payroll_run_not_draft', 'Only a Draft payroll run is calculated; return it to Draft first.');
  end if;
  select * into v_period from app.pay_periods p where p.id = v_run.pay_period_id;
  if v_period.pay_period_state = 'Posted' then
    perform private.refuse('pay_period_posted', 'A posted pay period accepts no payroll changes.');
  end if;
  select e.id into v_regular from app.earning_codes e
  where e.org_id = v_run.org_id and e.deleted_at is null and not e.is_overtime order by e.code limit 1;
  select e.id into v_overtime from app.earning_codes e
  where e.org_id = v_run.org_id and e.deleted_at is null and e.is_overtime order by e.code limit 1;
  if v_regular is null then
    perform private.refuse('payroll_earning_code_missing', 'Add a regular earning code in Payroll and Time Off settings before calculating.');
  end if;

  create temporary table if not exists pg_temp.payroll_minutes (
    membership_id uuid, role_code text, jurisdiction_id text, week date, clock_in timestamptz, minutes integer
  ) on commit drop;
  truncate pg_temp.payroll_minutes;

  insert into pg_temp.payroll_minutes
  select t.membership_id,
    coalesce(sh.role_code, (select pr.role_code from app.pay_rates pr
                            where pr.membership_id = t.membership_id and pr.currency_code = v_run.currency_code
                              and pr.effective_from <= v_period.ends_on and pr.deleted_at is null
                            order by pr.effective_from desc, pr.created_at desc limit 1)),
    p.jurisdiction_id,
    (e.clock_in at time zone p.time_zone)::date
      - ((extract(dow from e.clock_in at time zone p.time_zone)::integer - v_week_start + 7) % 7),
    e.clock_in,
    greatest(0, (extract(epoch from (e.clock_out - e.clock_in)) / 60)::integer - e.break_minutes)
  from app.timesheets t
  join app.timesheet_approvals a on a.timesheet_id = t.id and a.voided_at is null
  join app.projects p on p.id = t.project_id
  join app.time_entries e on e.membership_id = t.membership_id and e.project_id = t.project_id and e.deleted_at is null
    and e.clock_out is not null and e.clock_in >= t.period_start::timestamptz and e.clock_in < (t.period_end + 1)::timestamptz
  left join app.shifts sh on sh.id = e.shift_id
  where t.org_id = v_run.org_id and t.deleted_at is null and t.timesheet_state = 'Approved' and t.membership_id is not null
    and t.period_start >= v_period.starts_on and t.period_end <= v_period.ends_on;

  if exists (select 1 from pg_temp.payroll_minutes m where m.role_code is null) then
    perform private.refuse('payroll_rate_missing', 'A person on an approved timesheet has no pay rate in this currency; record one in the pay rate ledger.');
  end if;
  if exists (select 1 from pg_temp.payroll_minutes m where m.jurisdiction_id is null
             or not exists (select 1 from private.wage_hour_rule_for(m.jurisdiction_id))) then
    perform private.refuse('payroll_wage_rule_missing', 'A project on an approved timesheet has no jurisdiction with a wage-hour rule, so overtime has no answer; set the project jurisdiction.');
  end if;
  if exists (
    select 1 from pg_temp.payroll_minutes m
    where not exists (select 1 from app.pay_rates pr where pr.membership_id = m.membership_id and pr.role_code = m.role_code
                        and pr.currency_code = v_run.currency_code and pr.effective_from <= v_period.ends_on and pr.deleted_at is null)) then
    perform private.refuse('payroll_rate_missing', 'A person on an approved timesheet has no pay rate in this currency; record one in the pay rate ledger.');
  end if;

  update app.payroll_lines set deleted_at = now() where payroll_run_id = p_payroll_run_id and deleted_at is null;

  with split as (
    select m.membership_id, m.role_code, m.minutes,
      w.weekly_ot_after_hours, w.min_ot_multiplier,
      sum(m.minutes) over (partition by m.membership_id, m.week order by m.clock_in rows unbounded preceding) as running
    from pg_temp.payroll_minutes m
    cross join lateral private.wage_hour_rule_for(m.jurisdiction_id) w
  ), parts as (
    select s.membership_id, s.role_code, s.min_ot_multiplier,
      case when s.weekly_ot_after_hours is null then 0
           else least(s.minutes, greatest(0, s.running - (s.weekly_ot_after_hours * 60)::integer)) end as ot_minutes,
      s.minutes
    from split s
  ), totals as (
    select p.membership_id, p.role_code, max(p.min_ot_multiplier) as multiplier,
      sum(p.minutes - p.ot_minutes) as regular_minutes, sum(p.ot_minutes) as ot_minutes
    from parts p group by p.membership_id, p.role_code
  ), rated as (
    select t.*, (select pr.rate_minor from app.pay_rates pr
                 where pr.membership_id = t.membership_id and pr.role_code = t.role_code and pr.currency_code = v_run.currency_code
                   and pr.effective_from <= v_period.ends_on and pr.deleted_at is null
                 order by pr.effective_from desc, pr.created_at desc limit 1) as rate_minor
    from totals t
  )
  insert into app.payroll_lines (payroll_run_id, membership_id, earning_code_id, hours, rate_minor, role_code)
  select p_payroll_run_id, r.membership_id, v_regular, round(r.regular_minutes / 60.0, 2), r.rate_minor, r.role_code
  from rated r where r.regular_minutes > 0
  union all
  select p_payroll_run_id, r.membership_id, coalesce(v_overtime, v_regular), round(r.ot_minutes / 60.0, 2),
    round(r.rate_minor * coalesce(r.multiplier, 1))::bigint, r.role_code
  from rated r where r.ot_minutes > 0;

  if v_overtime is null and exists (select 1 from app.payroll_lines l where l.payroll_run_id = p_payroll_run_id and l.deleted_at is null
                                   group by l.membership_id, l.earning_code_id having count(*) > 1) then
    perform private.refuse('payroll_overtime_code_missing', 'Overtime was worked; add an overtime earning code in Payroll and Time Off settings before calculating.');
  end if;

  select count(*)::integer into v_count from app.payroll_lines l where l.payroll_run_id = p_payroll_run_id and l.deleted_at is null;
  perform private.emit_event(v_run.org_id, 'payroll_run.calculated', 'payroll_runs', v_run.id, null,
    jsonb_build_object('line_count', v_count, 'pay_period_id', v_run.pay_period_id));
  perform private.transition_lifecycle('payroll_run', 'app.payroll_runs', 'payroll_run_state', 'app.payroll_run_state_transitions',
    'payroll_run_id', p_payroll_run_id, 'Draft', 'Calculated', p_reason);
  return v_count;
end;
$$;

comment on function app.calculate_payroll_run(uuid, text) is 'Writes a Draft payroll run''s lines from approved member timesheets of its pay period (external crew are paid through their engagement): hours by person and role at the pay rate in force, weekly overtime split by the wage-hour rule of each project''s jurisdiction at its multiplier, then moves the run to Calculated. Overtime weeks start on the org''s payroll.week_start, in each project''s time zone (1398). Needs crew.pay_period.manage; never returns a rate. Refuses with no answer when a rate, an earning code or a wage-hour rule is missing.';
revoke all on function app.calculate_payroll_run(uuid, text) from public, anon;
grant execute on function app.calculate_payroll_run(uuid, text) to authenticated, service_role;

-- Out of office from midnight in the person's time zone -------------------------------------------------------------
-- private.away_since (1325) cast me.out_of_office.starts_on to timestamptz, which is midnight UTC, while
-- private.person_away counts the day in the person's locale.time_zone. In Tokyo the person was away from 00:00 on the
-- start date but away_since was 09:00, so app.send_chat_message found no automatic reply since away_since and sent
-- another for every direct message until then. The start date now begins at midnight in the zone person_away uses
-- (UTC for a blank or unknown zone); the fallbacks are 1325's.

create or replace function private.away_since(p_person_id uuid, p_org_id uuid)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (private.setting_date(private.setting_text(p_org_id, 'me.out_of_office.starts_on', null, null, p_person_id)))::timestamp
      at time zone coalesce(
        (select z.name from pg_catalog.pg_timezone_names z
         where z.name = private.setting_text(p_org_id, 'locale.time_zone', null, null, p_person_id) limit 1),
        'UTC'),
    (select max(v.updated_at) from app.personal_setting_values v
     where v.person_id = p_person_id and v.setting_key = 'me.out_of_office.enabled' and v.deleted_at is null
       and (v.org_id is null or v.org_id = p_org_id)),
    '-infinity'::timestamptz);
$$;

comment on function private.away_since(uuid, uuid) is 'When a person''s current time away began: midnight of their me.out_of_office.starts_on in their locale.time_zone (the day private.person_away counts in; UTC when unset or unknown, 1398), else when they last turned out of office on.';
revoke all on function private.away_since(uuid, uuid) from public, anon, authenticated;
