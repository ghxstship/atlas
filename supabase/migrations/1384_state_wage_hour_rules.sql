-- 1384_state_wage_hour_rules.sql
-- A82 compliance flows (RRR-127), finding A65-014 (Section 14.5, "state overrides including California daily overtime").
-- The payroll calculation (0461, 0463) applied weekly overtime only, from xpms.wage_hour_rule, which holds the federal FLSA
-- row and no state. The sanctioned way to add a state is a canon row, but canon is off limits to this work: ADR 0002 says
-- the xpms schema is populated only by the importer and read-only, ADR 0004 gives canon/ to its owner (A01), and the
-- Bible's jurisdiction tab declares seven jurisdictions with no US-CA. So the state rules live in the app layer, keyed by
-- ISO 3166-2 subdivision code as private.pay_transparency_rules (1125) is, and the calculation reads them beside canon:
--   * private.state_wage_hour_rules: California (Cal. Lab. Code section 510(a)): overtime at 1.5 after 8 hours in a workday
--     and 40 in a workweek, and for the first 8 hours of the seventh consecutive day of work in a workweek; double time
--     after 12 hours in a workday and after 8 hours on that seventh day. Exemptions (alternative workweek schedules,
--     collective bargaining agreements under section 514, exempt employees) are not modeled; counsel_reviewed_on stays
--     empty until counsel confirms the row;
--   * app.venues.subdivision_code: the state or province a venue sits in. A project's labor subdivision is its venue's, else
--     the region its canon jurisdiction names (for example US-FL);
--   * private.split_work_minutes: splits each worked entry into regular, overtime and double-time minutes by the federal
--     weekly rule (the strictest up the canon chain, as before) and the state's daily, double-time and seventh-day rules,
--     so the payroll calculation and the WH-347 certified payroll (1386) count overtime the same way;
--   * app.calculate_payroll_run now pays double time on an overtime earning code (the one whose code starts with DT, else
--     the overtime code) at the state multiplier.
-- When canon adds a state row, the app row for that subdivision is removed in the same release.

alter table app.venues add column subdivision_code text,
  add constraint venues_subdivision_code_format check (subdivision_code is null or subdivision_code ~ '^[A-Z]{2}-[A-Z0-9]{1,3}$');
comment on column app.venues.subdivision_code is 'ISO 3166-2 code of the state or province the venue is in, for example US-CA. State wage-hour rules (private.state_wage_hour_rules) apply to work on its projects.';

create table private.state_wage_hour_rules (
  subdivision_code text primary key,
  source text not null,
  weekly_ot_after_hours numeric,
  daily_ot_after_hours numeric,
  daily_dt_after_hours numeric,
  seventh_day_premium boolean not null default false,
  min_ot_multiplier numeric not null,
  min_dt_multiplier numeric,
  counsel_reviewed_on date,
  note text,
  constraint state_wage_hour_rules_code check (subdivision_code ~ '^[A-Z]{2}-[A-Z0-9]{1,3}$'),
  constraint state_wage_hour_rules_weekly check (weekly_ot_after_hours is null or weekly_ot_after_hours > 0),
  constraint state_wage_hour_rules_daily check (daily_ot_after_hours is null or daily_ot_after_hours > 0),
  constraint state_wage_hour_rules_dt check (daily_dt_after_hours is null or (daily_ot_after_hours is not null and daily_dt_after_hours > daily_ot_after_hours)),
  constraint state_wage_hour_rules_ot_multiplier check (min_ot_multiplier >= 1),
  constraint state_wage_hour_rules_dt_multiplier check ((daily_dt_after_hours is null and not seventh_day_premium) or min_dt_multiplier >= min_ot_multiplier),
  constraint state_wage_hour_rules_seventh check (not seventh_day_premium or daily_ot_after_hours is not null)
);

comment on table private.state_wage_hour_rules is 'State wage-and-hour overtime rules the canon does not hold yet (Section 14.5), keyed by ISO 3166-2 subdivision. Platform reference data read by private.split_work_minutes; the strictest of the state and the federal canon rule governs.';
comment on column private.state_wage_hour_rules.subdivision_code is 'ISO 3166-2 subdivision, for example US-CA.';
comment on column private.state_wage_hour_rules.source is 'Law the rule comes from.';
comment on column private.state_wage_hour_rules.weekly_ot_after_hours is 'Weekly hours after which overtime applies.';
comment on column private.state_wage_hour_rules.daily_ot_after_hours is 'Hours in a workday after which overtime applies.';
comment on column private.state_wage_hour_rules.daily_dt_after_hours is 'Hours in a workday after which double time applies.';
comment on column private.state_wage_hour_rules.seventh_day_premium is 'True when the seventh consecutive day of work in a workweek pays overtime for its first daily_ot_after_hours hours and double time after them.';
comment on column private.state_wage_hour_rules.min_ot_multiplier is 'Overtime multiplier.';
comment on column private.state_wage_hour_rules.min_dt_multiplier is 'Double-time multiplier.';
comment on column private.state_wage_hour_rules.counsel_reviewed_on is 'When counsel confirmed the row; empty until then.';
comment on column private.state_wage_hour_rules.note is 'What the row does not model.';

alter table private.state_wage_hour_rules enable row level security;
revoke all on private.state_wage_hour_rules from public, anon, authenticated;
grant select on private.state_wage_hour_rules to service_role;

insert into private.state_wage_hour_rules (subdivision_code, source, weekly_ot_after_hours, daily_ot_after_hours, daily_dt_after_hours,
  seventh_day_premium, min_ot_multiplier, min_dt_multiplier, note) values
  ('US-CA', 'California Labor Code section 510(a)', 40, 8, 12, true, 1.5, 2.0,
   'Does not model alternative workweek schedules (section 511), collective bargaining exemptions (section 514), exempt employees or industry wage order variations.');

-- A project's labor subdivision ------------------------------------------------------------------------------------------

create or replace function private.labor_subdivision(p_project_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select v.subdivision_code from app.projects p join app.venues v on v.id = p.venue_id and v.deleted_at is null where p.id = p_project_id),
    (with recursive chain as (
       select j.jurisdiction_id::text as id, j.parent::text as parent, j.level::text as level
       from app.projects p join xpms.jurisdiction j on j.jurisdiction_id = p.jurisdiction_id where p.id = p_project_id
       union all
       select j.jurisdiction_id::text, j.parent::text, j.level::text from chain c join xpms.jurisdiction j on j.jurisdiction_id = c.parent
     )
     select c.id from chain c where c.level = 'region' limit 1));
$$;

comment on function private.labor_subdivision(uuid) is 'The ISO 3166-2 subdivision whose wage-hour law governs work on a project: its venue''s subdivision_code, else the region its canon jurisdiction names. NULL when neither is known.';
revoke all on function private.labor_subdivision(uuid) from public, anon, authenticated;

-- Splitting worked minutes -------------------------------------------------------------------------------------------------
-- The caller fills pg_temp.work_minutes (one row per worked entry) and reads the split back. Entries of one person never
-- overlap (invariant 20), so clock_in orders them.

create or replace function private.split_work_minutes()
returns table (
  membership_id uuid,
  role_code text,
  project_id uuid,
  work_date date,
  clock_in timestamptz,
  minutes integer,
  regular_minutes integer,
  ot_minutes integer,
  dt_minutes integer,
  ot_multiplier numeric,
  dt_multiplier numeric
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  return query
  with base as (
    select w.membership_id, w.role_code, w.project_id, w.week, w.work_date, w.clock_in, w.minutes,
      f.weekly_ot_after_hours as f_weekly, f.min_ot_multiplier as f_multiplier,
      s.weekly_ot_after_hours as s_weekly, s.daily_ot_after_hours as d_ot, s.daily_dt_after_hours as d_dt,
      coalesce(s.seventh_day_premium, false) as seventh_rule, s.min_ot_multiplier as s_multiplier, s.min_dt_multiplier as s_dt_multiplier
    from pg_temp.work_minutes w
    left join lateral private.wage_hour_rule_for(w.jurisdiction_id) f on true
    left join private.state_wage_hour_rules s on s.subdivision_code = w.subdivision_code
  ), weeks as (
    select b.membership_id, b.week, count(distinct b.work_date) as days_worked from base b group by 1, 2
  ), daily as (
    select b.*,
      (sum(b.minutes) over (partition by b.membership_id, b.work_date order by b.clock_in rows unbounded preceding) - b.minutes)::integer as day_before,
      (b.seventh_rule and k.days_worked = 7 and b.work_date = b.week + 6) as seventh,
      (b.d_ot * 60)::integer as lo_ot,
      (b.d_dt * 60)::integer as lo_dt
    from base b join weeks k on k.membership_id = b.membership_id and k.week = b.week
  ), day_split as (
    select d.*,
      case
        when d.lo_ot is null then 0
        when d.seventh then greatest(0, least(d.day_before + d.minutes, d.lo_ot) - d.day_before)
        else greatest(0, least(d.day_before + d.minutes, coalesce(d.lo_dt, 1000000000)) - greatest(d.day_before, d.lo_ot))
      end as d_ot_minutes,
      case
        when d.lo_ot is null then 0
        when d.seventh then greatest(0, (d.day_before + d.minutes) - greatest(d.day_before, d.lo_ot))
        when d.lo_dt is null then 0
        else greatest(0, (d.day_before + d.minutes) - greatest(d.day_before, d.lo_dt))
      end as d_dt_minutes
    from daily d
  ), weekly as (
    select x.*,
      x.minutes - x.d_ot_minutes - x.d_dt_minutes as daily_regular,
      least(x.f_weekly, x.s_weekly) as weekly_after,
      sum(x.minutes - x.d_ot_minutes - x.d_dt_minutes) over (partition by x.membership_id, x.week order by x.clock_in rows unbounded preceding) as running_regular
    from day_split x
  ), final as (
    select y.*,
      case when y.weekly_after is null then 0
           else least(y.daily_regular, greatest(0, y.running_regular - (y.weekly_after * 60)::integer))::integer end as weekly_ot
    from weekly y
  )
  select o.membership_id, o.role_code, o.project_id, o.work_date, o.clock_in, o.minutes,
    (o.daily_regular - o.weekly_ot)::integer, (o.d_ot_minutes + o.weekly_ot)::integer, o.d_dt_minutes::integer,
    coalesce(greatest(o.f_multiplier, o.s_multiplier), 1)::numeric, coalesce(o.s_dt_multiplier, 2)::numeric
  from final o
  order by o.membership_id, o.clock_in;
end;
$$;

comment on function private.split_work_minutes() is 'Splits the entries the caller put in pg_temp.work_minutes into regular, overtime and double-time minutes: the state''s daily rule, double time and seventh consecutive day (private.state_wage_hour_rules) per workday, then weekly overtime on the remaining regular minutes by the strictest weekly threshold of the canon chain and the state. The overtime multiplier is the higher of the two.';
revoke all on function private.split_work_minutes() from public, anon, authenticated;

-- The payroll calculation ------------------------------------------------------------------------------------------------

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
  v_count integer;
begin
  perform private.require_person();
  select * into v_run from app.payroll_runs r where r.id = p_payroll_run_id and r.deleted_at is null for update;
  if v_run.id is null or not private.has_capability(v_run.org_id, 'crew.pay_period.manage') then
    raise exception using errcode = '42501', message = 'crew.pay_period.manage is required';
  end if;
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
  where e.org_id = v_run.org_id and e.deleted_at is null and e.is_overtime order by (upper(e.code) like 'DT%'), e.code limit 1;
  select e.id into v_double from app.earning_codes e
  where e.org_id = v_run.org_id and e.deleted_at is null and e.is_overtime and upper(e.code) like 'DT%' order by e.code limit 1;
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
    date_trunc('week', e.clock_in at time zone p.time_zone)::date,
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

comment on function app.calculate_payroll_run(uuid, text) is 'Writes a Draft payroll run''s lines from approved member timesheets of its pay period (external crew are paid through their engagement): hours by person and role at the pay rate in force, split by private.split_work_minutes into regular, overtime (weekly by the canon rule of each project''s jurisdiction, daily and seventh-day by its state''s rule) and double time, each at its multiplier, then moves the run to Calculated. Double time is paid on the overtime earning code whose code starts with DT, else the overtime code. Needs crew.pay_period.manage; never returns a rate. Refuses with no answer when a rate, an earning code or a wage-hour rule is missing.';
