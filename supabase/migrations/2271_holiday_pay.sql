-- 2271_holiday_pay.sql
--
-- A134 (RRR-196), trace S4.5.6-26, ADR 0105: a payroll run pays holiday pay through an earning code. This restates
-- app.calculate_payroll_run from its latest definition, 1399 (which joined 1384's state rules to 1398's org week; 0461 and
-- 0463 came before), and adds:
--   * the regular earning code is never a holiday code (app.earning_codes.is_holiday, 2270), so adding HOL, which sorts
--     before REG, never moves regular hours onto it;
--   * holiday lines: for each person with worked time in the run, the paid hours of each holiday on the calendar that
--     governs a project (2270) inside the period of their approved timesheet for that project, counted once a day, at
--     the rate of the role they worked most, on the org's holiday earning code (the first is_holiday code by code);
--   * a refusal, payroll_holiday_code_missing, when such a holiday is owed and the org has no holiday code.
-- Holiday hours are paid, not worked: they never count toward overtime, and work on a holiday is paid as any other day
-- (no premium; state break and meal rules stay deferred, decision 54).

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
  v_double uuid;
  v_holiday uuid;
  v_week_start integer;
  v_count integer;
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
  where e.org_id = v_run.org_id and e.deleted_at is null and not e.is_overtime and not e.is_holiday order by e.code limit 1;
  select e.id into v_overtime from app.earning_codes e
  where e.org_id = v_run.org_id and e.deleted_at is null and e.is_overtime order by (upper(e.code) like 'DT%'), e.code limit 1;
  select e.id into v_double from app.earning_codes e
  where e.org_id = v_run.org_id and e.deleted_at is null and e.is_overtime and upper(e.code) like 'DT%' order by e.code limit 1;
  select e.id into v_holiday from app.earning_codes e
  where e.org_id = v_run.org_id and e.deleted_at is null and e.is_holiday order by e.code limit 1;
  if v_regular is null then
    perform private.refuse('payroll_earning_code_missing', 'Add a regular earning code in Payroll and Time Off settings before calculating.');
  end if;

  create temporary table if not exists pg_temp.work_minutes (
    membership_id uuid, role_code text, project_id uuid, jurisdiction_id text, subdivision_code text,
    week date, work_date date, clock_in timestamptz, minutes integer
  ) on commit drop;
  truncate pg_temp.work_minutes;

  insert into pg_temp.work_minutes
  select t.membership_id,
    coalesce(sh.role_code, (select pr.role_code from app.pay_rates pr
                            where pr.membership_id = t.membership_id and pr.currency_code = v_run.currency_code
                              and pr.effective_from <= v_period.ends_on and pr.deleted_at is null
                            order by pr.effective_from desc, pr.created_at desc limit 1)),
    p.id,
    p.jurisdiction_id,
    private.labor_subdivision(p.id),
    (e.clock_in at time zone p.time_zone)::date
      - ((extract(dow from e.clock_in at time zone p.time_zone)::integer - v_week_start + 7) % 7),
    (e.clock_in at time zone p.time_zone)::date,
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

  if exists (select 1 from pg_temp.work_minutes m where m.role_code is null) then
    perform private.refuse('payroll_rate_missing', 'A person on an approved timesheet has no pay rate in this currency; record one in the pay rate ledger.');
  end if;
  if exists (select 1 from pg_temp.work_minutes m where m.jurisdiction_id is null
             or not exists (select 1 from private.wage_hour_rule_for(m.jurisdiction_id))) then
    perform private.refuse('payroll_wage_rule_missing', 'A project on an approved timesheet has no jurisdiction with a wage-hour rule, so overtime has no answer; set the project jurisdiction.');
  end if;
  if exists (
    select 1 from pg_temp.work_minutes m
    where not exists (select 1 from app.pay_rates pr where pr.membership_id = m.membership_id and pr.role_code = m.role_code
                        and pr.currency_code = v_run.currency_code and pr.effective_from <= v_period.ends_on and pr.deleted_at is null)) then
    perform private.refuse('payroll_rate_missing', 'A person on an approved timesheet has no pay rate in this currency; record one in the pay rate ledger.');
  end if;

  -- Holiday pay (2270, ADR 0105): each paid holiday on the calendar that governs a project, inside the period of a person's
  -- approved timesheet for that project, pays its hours once a day however many projects share it. Only people with
  -- worked time in the run are paid, at the rate of the role they worked most.
  create temporary table if not exists pg_temp.holiday_hours (membership_id uuid, observed_on date, hours numeric) on commit drop;
  truncate pg_temp.holiday_hours;

  insert into pg_temp.holiday_hours
  select t.membership_id, h.observed_on, max(h.paid_hours)
  from app.timesheets t
  join app.timesheet_approvals a on a.timesheet_id = t.id and a.voided_at is null
  join app.holidays h on h.holiday_calendar_id = private.project_holiday_calendar_id(t.project_id) and h.deleted_at is null
    and h.paid_hours > 0 and h.observed_on between t.period_start and t.period_end
    and h.observed_on between v_period.starts_on and v_period.ends_on
  where t.org_id = v_run.org_id and t.deleted_at is null and t.timesheet_state = 'Approved' and t.membership_id is not null
    and t.period_start >= v_period.starts_on and t.period_end <= v_period.ends_on
    and t.membership_id in (select m.membership_id from pg_temp.work_minutes m)
  group by t.membership_id, h.observed_on;

  if v_holiday is null and exists (select 1 from pg_temp.holiday_hours) then
    perform private.refuse('payroll_holiday_code_missing', 'A paid holiday falls in this pay period; add a holiday earning code in Payroll and Time Off settings before calculating.');
  end if;

  update app.payroll_lines set deleted_at = now() where payroll_run_id = p_payroll_run_id and deleted_at is null;

  with totals as (
    select s.membership_id, s.role_code, max(s.ot_multiplier) as ot_multiplier, max(s.dt_multiplier) as dt_multiplier,
      sum(s.regular_minutes) as regular_minutes, sum(s.ot_minutes) as ot_minutes, sum(s.dt_minutes) as dt_minutes
    from private.split_work_minutes() s group by s.membership_id, s.role_code
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
    round(r.rate_minor * r.ot_multiplier)::bigint, r.role_code
  from rated r where r.ot_minutes > 0
  union all
  select p_payroll_run_id, r.membership_id, coalesce(v_double, v_overtime, v_regular), round(r.dt_minutes / 60.0, 2),
    round(r.rate_minor * r.dt_multiplier)::bigint, r.role_code
  from rated r where r.dt_minutes > 0;

  with main_role as (
    select distinct on (m.membership_id) m.membership_id, m.role_code
    from pg_temp.work_minutes m group by m.membership_id, m.role_code
    order by m.membership_id, sum(m.minutes) desc, m.role_code
  ), owed as (
    select h.membership_id, sum(h.hours) as hours from pg_temp.holiday_hours h group by h.membership_id
  )
  insert into app.payroll_lines (payroll_run_id, membership_id, earning_code_id, hours, rate_minor, role_code)
  select p_payroll_run_id, o.membership_id, v_holiday, round(o.hours, 2),
    (select pr.rate_minor from app.pay_rates pr
     where pr.membership_id = o.membership_id and pr.role_code = r.role_code and pr.currency_code = v_run.currency_code
       and pr.effective_from <= v_period.ends_on and pr.deleted_at is null
     order by pr.effective_from desc, pr.created_at desc limit 1),
    r.role_code
  from owed o join main_role r on r.membership_id = o.membership_id
  where o.hours > 0;

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
comment on function app.calculate_payroll_run(uuid, text) is 'Writes a Draft payroll run''s lines from approved member timesheets of its pay period (external crew are paid through their engagement): hours by person and role at the pay rate in force, split by private.split_work_minutes into regular, overtime (weekly by the canon rule of each project''s jurisdiction, daily and seventh-day by its state''s rule) and double time, each at its multiplier, then moves the run to Calculated. Workweeks start on the org''s payroll.week_start, in each project''s time zone (1398, kept by 1399). Double time is paid on the overtime earning code whose code starts with DT, else the overtime code; the regular code is never a holiday code. Holiday pay (2271): the paid hours of each holiday on the calendar that governs a project (private.project_holiday_calendar_id) inside the period of the person''s approved timesheet for it, once a day, on the org''s holiday earning code at the rate of the role they worked most. Needs crew.pay_period.manage; never returns a rate. Refuses with no answer when a rate, an earning code (a holiday code when a paid holiday falls in the period) or a wage-hour rule is missing.';
revoke all on function app.calculate_payroll_run(uuid, text) from public, anon;
grant execute on function app.calculate_payroll_run(uuid, text) to authenticated, service_role;
