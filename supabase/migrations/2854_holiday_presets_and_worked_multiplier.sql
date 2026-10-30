-- 2854_holiday_presets_and_worked_multiplier.sql
-- P8 (RRR-222; parity gap G-117; ADR 0022 block 2850 to 2859; ADR 0112 amended 2026-10-28). Section 4.5.6 Payroll and
-- Time Off (S4.5.6-26):
--
--   * private.us_federal_holidays(year): the eleven holidays of 5 U.S.C. 6103 observed in a year, a fixed date on a
--     Saturday observed the Friday before and on a Sunday the Monday after (so New Year's Day of a year can be observed
--     on December 31 of the year before). app.add_holiday_preset adds them to a holiday calendar, 8 paid hours each,
--     skipping a day the calendar already holds, with the names Atlas passes in the viewer's language. It checks the
--     holidays write policy's rule (org.payroll.write) itself: it runs as its owner, since the preset is private.
--   * app.holiday_calendars.worked_holiday_multiplier: an org pay policy, set per calendar, that pays work on a holiday
--     of that calendar at a multiple of the rate. It is not jurisdictional overtime: ADR 0033 decision 54 stands, no
--     state holiday rule is applied, and break and meal rules stay deferred. NULL pays no premium, as before.
--   * app.calculate_payroll_run is restated from 2271 (its latest definition). Work on a day that is a holiday on the
--     calendar governing its project (private.project_holiday_calendar_id), when that calendar sets a multiplier m
--     above 1, pays its regular minutes on the holiday earning code at m times the rate, its overtime minutes at the
--     greater of their own multiplier and m, and its double time at the greater of its multiplier and m. Premiums
--     never stack, and the minutes still count toward overtime. Unworked holiday pay is unchanged, and the premium
--     applies on a holiday whether it pays hours or not. payroll_overtime_code_missing now asks only whether overtime
--     or double time was worked, so the separate holiday lines never trip it.

-- 1. The US federal preset -------------------------------------------------------------------------------------------------

create or replace function private.us_federal_holidays(p_year integer)
returns table (code text, observed_on date)
language sql
immutable
parallel safe
set search_path = ''
as $$
  with fixed (code, actual) as (
    values
      ('new_years_day', pg_catalog.make_date(p_year, 1, 1)),
      ('juneteenth', pg_catalog.make_date(p_year, 6, 19)),
      ('independence_day', pg_catalog.make_date(p_year, 7, 4)),
      ('veterans_day', pg_catalog.make_date(p_year, 11, 11)),
      ('christmas_day', pg_catalog.make_date(p_year, 12, 25))
  ), nth (code, month, dow, n) as (
    -- The nth given weekday (0 Sunday to 6 Saturday) of a month.
    values
      ('mlk_day', 1, 1, 3),
      ('washingtons_birthday', 2, 1, 3),
      ('labor_day', 9, 1, 1),
      ('columbus_day', 10, 1, 2),
      ('thanksgiving', 11, 4, 4)
  )
  select f.code,
    case extract(dow from f.actual)::integer when 6 then f.actual - 1 when 0 then f.actual + 1 else f.actual end
  from fixed f
  where p_year between 2021 and 2100
  union all
  select n.code,
    pg_catalog.make_date(p_year, n.month, 1)
      + ((n.dow - extract(dow from pg_catalog.make_date(p_year, n.month, 1))::integer + 7) % 7)
      + 7 * (n.n - 1)
  from nth n
  where p_year between 2021 and 2100
  union all
  -- Memorial Day, the last Monday of May.
  select 'memorial_day',
    pg_catalog.make_date(p_year, 5, 31) - ((extract(dow from pg_catalog.make_date(p_year, 5, 31))::integer - 1 + 7) % 7)
  where p_year between 2021 and 2100;
$$;

comment on function private.us_federal_holidays(integer) is 'The eleven US federal holidays of 5 U.S.C. 6103 for a year from 2021 to 2100, by code, on the day each is observed: a fixed date on a Saturday is observed the Friday before and on a Sunday the Monday after, so New Year''s Day can be observed on December 31 of the year before. No rows for another year.';
revoke all on function private.us_federal_holidays(integer) from public, anon;
grant execute on function private.us_federal_holidays(integer) to authenticated, service_role;

create or replace function app.add_holiday_preset(
  p_holiday_calendar_id uuid,
  p_preset text,
  p_year integer,
  p_names jsonb default null
)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_calendar app.holiday_calendars;
  v_added integer;
begin
  perform private.require_person();
  select * into v_calendar from app.holiday_calendars c where c.id = p_holiday_calendar_id and c.deleted_at is null;
  -- The holidays write policy's rule (2270), checked here: the function runs as its owner to read the preset.
  if v_calendar.id is null or v_calendar.org_id not in (select private.orgs_with_capability('org.payroll.write')) then
    raise exception using errcode = '42501', message = 'org.payroll.write is required on the calendar''s org';
  end if;
  if p_preset is distinct from 'us_federal' then
    perform private.refuse('holiday_preset_unknown', 'Choose the US federal holidays.');
  end if;
  if p_year is null or p_year not between 2021 and 2100 then
    perform private.refuse('holiday_preset_year', 'Choose a year from 2021 to 2100.');
  end if;
  if p_names is not null and (
    jsonb_typeof(p_names) <> 'object'
    or exists (
      select 1 from jsonb_each(p_names) n
      where n.key not in (select h.code from private.us_federal_holidays(2027) h)
         or jsonb_typeof(n.value) <> 'string'
         or char_length(btrim(n.value #>> '{}')) not between 1 and 100)) then
    perform private.refuse('holiday_preset_names', 'Each holiday name is 1 to 100 characters, for a holiday of the preset.');
  end if;

  insert into app.holidays (holiday_calendar_id, observed_on, name, paid_hours)
  select v_calendar.id, h.observed_on,
    coalesce(btrim(p_names ->> h.code), case h.code
      when 'new_years_day' then 'New Year''s Day'
      when 'mlk_day' then 'Birthday of Martin Luther King, Jr.'
      when 'washingtons_birthday' then 'Washington''s Birthday'
      when 'memorial_day' then 'Memorial Day'
      when 'juneteenth' then 'Juneteenth National Independence Day'
      when 'independence_day' then 'Independence Day'
      when 'labor_day' then 'Labor Day'
      when 'columbus_day' then 'Columbus Day'
      when 'veterans_day' then 'Veterans Day'
      when 'thanksgiving' then 'Thanksgiving Day'
      when 'christmas_day' then 'Christmas Day' end),
    8
  from private.us_federal_holidays(p_year) h
  order by h.observed_on
  on conflict (holiday_calendar_id, observed_on) where deleted_at is null do nothing;
  get diagnostics v_added = row_count;
  return v_added;
end;
$$;

comment on function app.add_holiday_preset(uuid, text, integer, jsonb) is 'Adds a preset''s holidays for a year to a holiday calendar, each paying 8 hours, and returns how many it added: us_federal, the eleven holidays of 5 U.S.C. 6103 on their observed days (private.us_federal_holidays), for a year from 2021 to 2100. A day the calendar already holds is skipped. Names come from p_names by code (Atlas passes them in the viewer''s language), else English. Needs org.payroll.write on the calendar''s org, the rule of the holidays write policy.';
revoke all on function app.add_holiday_preset(uuid, text, integer, jsonb) from public, anon;
grant execute on function app.add_holiday_preset(uuid, text, integer, jsonb) to authenticated, service_role;

-- 2. The worked-holiday multiplier -----------------------------------------------------------------------------------------

alter table app.holiday_calendars add column worked_holiday_multiplier numeric,
  add constraint holiday_calendars_worked_holiday_multiplier_range
    check (worked_holiday_multiplier is null or worked_holiday_multiplier between 1 and 3);

comment on column app.holiday_calendars.worked_holiday_multiplier is 'An org pay policy, not jurisdictional overtime (ADR 0033 decision 54 stands): work on a holiday of this calendar is paid at this multiple of the rate, 1 to 3, on the holiday earning code, and its overtime at the greater of its own multiplier and this one. NULL pays no premium.';

-- 3. Payroll: the worked-holiday premium -----------------------------------------------------------------------------------

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

  -- The split of worked minutes (1384), once, with the worked-holiday multiplier of each day: the governing calendar's
  -- worked_holiday_multiplier when the day is a holiday on it and the multiplier is above 1, else NULL.
  create temporary table if not exists pg_temp.split_minutes (
    membership_id uuid, role_code text, project_id uuid, work_date date, clock_in timestamptz, minutes integer,
    regular_minutes integer, ot_minutes integer, dt_minutes integer, ot_multiplier numeric, dt_multiplier numeric,
    holiday_multiplier numeric
  ) on commit drop;
  truncate pg_temp.split_minutes;

  insert into pg_temp.split_minutes
  select s.membership_id, s.role_code, s.project_id, s.work_date, s.clock_in, s.minutes, s.regular_minutes, s.ot_minutes,
    s.dt_minutes, s.ot_multiplier, s.dt_multiplier,
    (select c.worked_holiday_multiplier from app.holiday_calendars c
     where c.id = private.project_holiday_calendar_id(s.project_id) and c.deleted_at is null and c.worked_holiday_multiplier > 1
       and exists (select 1 from app.holidays h
                   where h.holiday_calendar_id = c.id and h.deleted_at is null and h.observed_on = s.work_date))
  from private.split_work_minutes() s;

  -- Holiday pay (2270, ADR 0112): each paid holiday on the calendar that governs a project, inside the period of a person's
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

  if v_holiday is null and (exists (select 1 from pg_temp.holiday_hours)
     or exists (select 1 from pg_temp.split_minutes s where s.holiday_multiplier is not null and s.regular_minutes > 0)) then
    perform private.refuse('payroll_holiday_code_missing', 'This pay period includes holiday pay; add a holiday earning code in Payroll and Time Off settings before calculating.');
  end if;

  update app.payroll_lines set deleted_at = now() where payroll_run_id = p_payroll_run_id and deleted_at is null;

  -- Worked minutes by person, role and worked-holiday multiplier: days without a premium pay as before, holiday days
  -- with one pay regular minutes on the holiday code and every part at the greater of its multiplier and the premium.
  with totals as (
    select s.membership_id, s.role_code, s.holiday_multiplier,
      max(s.ot_multiplier) as ot_multiplier, max(s.dt_multiplier) as dt_multiplier,
      sum(s.regular_minutes) as regular_minutes, sum(s.ot_minutes) as ot_minutes, sum(s.dt_minutes) as dt_minutes
    from pg_temp.split_minutes s group by s.membership_id, s.role_code, s.holiday_multiplier
  ), rated as (
    select t.*, (select pr.rate_minor from app.pay_rates pr
                 where pr.membership_id = t.membership_id and pr.role_code = t.role_code and pr.currency_code = v_run.currency_code
                   and pr.effective_from <= v_period.ends_on and pr.deleted_at is null
                 order by pr.effective_from desc, pr.created_at desc limit 1) as rate_minor
    from totals t
  )
  insert into app.payroll_lines (payroll_run_id, membership_id, earning_code_id, hours, rate_minor, role_code)
  select p_payroll_run_id, r.membership_id, case when r.holiday_multiplier is null then v_regular else v_holiday end,
    round(r.regular_minutes / 60.0, 2),
    case when r.holiday_multiplier is null then r.rate_minor else round(r.rate_minor * r.holiday_multiplier)::bigint end,
    r.role_code
  from rated r where r.regular_minutes > 0
  union all
  select p_payroll_run_id, r.membership_id, coalesce(v_overtime, v_regular), round(r.ot_minutes / 60.0, 2),
    round(r.rate_minor * greatest(r.ot_multiplier, coalesce(r.holiday_multiplier, r.ot_multiplier)))::bigint, r.role_code
  from rated r where r.ot_minutes > 0
  union all
  select p_payroll_run_id, r.membership_id, coalesce(v_double, v_overtime, v_regular), round(r.dt_minutes / 60.0, 2),
    round(r.rate_minor * greatest(r.dt_multiplier, coalesce(r.holiday_multiplier, r.dt_multiplier)))::bigint, r.role_code
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

  if v_overtime is null and exists (select 1 from pg_temp.split_minutes s where s.ot_minutes > 0 or s.dt_minutes > 0) then
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
comment on function app.calculate_payroll_run(uuid, text) is 'Writes a Draft payroll run''s lines from approved member timesheets of its pay period (external crew are paid through their engagement): hours by person and role at the pay rate in force, split by private.split_work_minutes into regular, overtime (weekly by the canon rule of each project''s jurisdiction, daily and seventh-day by its state''s rule) and double time, each at its multiplier, then moves the run to Calculated. Workweeks start on the org''s payroll.week_start, in each project''s time zone (1398, kept by 1399). Double time is paid on the overtime earning code whose code starts with DT, else the overtime code; the regular code is never a holiday code. Holiday pay (2271): the paid hours of each holiday on the calendar that governs a project (private.project_holiday_calendar_id) inside the period of the person''s approved timesheet for it, once a day, on the org''s holiday earning code at the rate of the role they worked most. Worked holidays (2854): when that calendar sets worked_holiday_multiplier above 1, work on its holidays pays regular minutes on the holiday code at that multiple, and overtime and double time at the greater of their multiplier and it, an org pay policy that never stacks. Needs crew.pay_period.manage; never returns a rate. Refuses with no answer when a rate, an earning code (a holiday code when a paid holiday or a worked-holiday premium falls in the period, an overtime code when overtime was worked) or a wage-hour rule is missing.';
revoke all on function app.calculate_payroll_run(uuid, text) from public, anon;
grant execute on function app.calculate_payroll_run(uuid, text) to authenticated, service_role;
