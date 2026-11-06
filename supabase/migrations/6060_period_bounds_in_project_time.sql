-- 6060_period_bounds_in_project_time.sql
-- RRR-244: a timesheet or payroll period is a run of the project's local days. Every check compared clock_in with
-- period_start::timestamptz, which reads the date in the session's zone, UTC. So in zones behind UTC an evening's work
-- counted on the next day and could fall in the next period, and in zones ahead of it a morning's counted on the day
-- before. Each function below is recreated from its latest definition with only those bounds changed.
--
--   * private.project_day_start(project, date): the instant a local day starts on the project.
--   * app.timesheet_hours appends period_starts_at and period_ends_at, the instants a timesheet's period covers, so the
--     pages that list its entries read the same bounds as the database's sums.

create or replace function private.project_day_start(p_project_id uuid, p_day date)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select p_day::timestamp at time zone p.time_zone from app.projects p where p.id = p_project_id;
$$;

comment on function private.project_day_start(uuid, date) is 'The instant a local day starts in the project''s time zone; period bounds use it (RRR-244).';
revoke all on function private.project_day_start(uuid, date) from public, anon;
grant execute on function private.project_day_start(uuid, date) to authenticated, service_role;

-- private.worked_minutes, from 0340_crew_time.sql.
create or replace function private.worked_minutes(p_membership_id uuid, p_project_id uuid, p_from date, p_to date)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(greatest(0, (extract(epoch from (e.clock_out - e.clock_in)) / 60)::integer - e.break_minutes)), 0)::integer
  from app.time_entries e
  where e.membership_id = p_membership_id and e.project_id = p_project_id and e.deleted_at is null
    and e.clock_out is not null and e.clock_in >= private.project_day_start(p_project_id, p_from) and e.clock_in < private.project_day_start(p_project_id, p_to + 1);
$$;

-- private.has_open_entry, from 0340_crew_time.sql.
create or replace function private.has_open_entry(p_membership_id uuid, p_project_id uuid, p_from date, p_to date)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from app.time_entries e
    where e.membership_id = p_membership_id and e.project_id = p_project_id and e.deleted_at is null
      and e.clock_out is null and e.clock_in >= private.project_day_start(p_project_id, p_from) and e.clock_in < private.project_day_start(p_project_id, p_to + 1));
$$;

-- app.certified_payroll, from 1386_certified_payroll.sql.
create or replace function app.certified_payroll(p_project_id uuid, p_week_ending date, p_final boolean default false)
returns table (
  payroll_number integer,
  entry_number integer,
  last_name text,
  first_name text,
  middle_initial text,
  identifying_number text,
  apprentice text,
  labor_classification text,
  straight_minutes integer[],
  overtime_minutes integer[],
  total_minutes integer,
  currency_code text,
  straight_rate_minor bigint,
  overtime_rate_minor bigint,
  gross_project_minor bigint,
  gross_all_work_minor bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_person uuid := private.require_person();
  v_project app.projects;
  v_start date := p_week_ending - 6;
  v_number integer;
begin
  select * into v_project from app.projects p where p.id = p_project_id and p.deleted_at is null;
  if v_project.id is null or not private.has_capability(v_project.org_id, 'crew.payroll.export') then
    raise exception using errcode = '42501', message = 'crew.payroll.export is required';
  end if;
  if not private.has_capability(v_project.org_id, 'data.restricted.read.payroll')
     or not private.has_capability(v_project.org_id, 'data.export.restricted') then
    perform private.refuse('export_restricted', 'A certified payroll carries Restricted pay rates and needs the restricted export capability.');
  end if;
  if private.session_aal() <> 'aal2' then
    perform private.refuse('step_up_required', 'Exporting Restricted columns needs step-up authentication.');
  end if;
  if not exists (select 1 from app.certified_payroll_projects c where c.project_id = p_project_id and c.deleted_at is null) then
    perform private.refuse('certified_payroll_header_missing', 'Enter the project''s contract and wage determination numbers before issuing a certified payroll.');
  end if;
  if p_week_ending is null then
    perform private.refuse('certified_payroll_week', 'Choose the week ending date.');
  end if;

  -- The submission: a week keeps its number when issued again.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('certified_payroll:' || p_project_id::text, 0));
  select s.payroll_number into v_number from app.certified_payroll_submissions s
  where s.project_id = p_project_id and s.week_ending = p_week_ending and s.deleted_at is null;
  if v_number is null then
    select coalesce(max(s.payroll_number), 0) + 1 into v_number from app.certified_payroll_submissions s
    where s.project_id = p_project_id and s.deleted_at is null;
    insert into app.certified_payroll_submissions (project_id, week_ending, payroll_number, final_submission, issued_by)
    values (p_project_id, p_week_ending, v_number, coalesce(p_final, false), v_person);
  else
    update app.certified_payroll_submissions s set final_submission = s.final_submission or coalesce(p_final, false),
      issued_by = v_person, issued_at = now()
    where s.project_id = p_project_id and s.week_ending = p_week_ending and s.deleted_at is null;
  end if;

  -- All of the week's approved work of everyone who worked on the project, on any of the org's projects.
  create temporary table if not exists pg_temp.work_minutes (
    membership_id uuid, role_code text, project_id uuid, jurisdiction_id text, subdivision_code text,
    week date, work_date date, clock_in timestamptz, minutes integer
  ) on commit drop;
  truncate pg_temp.work_minutes;

  insert into pg_temp.work_minutes
  select e.membership_id,
    coalesce(sh.role_code, (select pr.role_code from app.pay_rates pr
                            where pr.membership_id = e.membership_id and pr.effective_from <= p_week_ending and pr.deleted_at is null
                            order by pr.effective_from desc, pr.created_at desc limit 1)),
    p.id, p.jurisdiction_id, private.labor_subdivision(p.id), v_start,
    (e.clock_in at time zone p.time_zone)::date, e.clock_in,
    greatest(0, (extract(epoch from (e.clock_out - e.clock_in)) / 60)::integer - e.break_minutes)
  from app.time_entries e
  join app.projects p on p.id = e.project_id
  left join app.shifts sh on sh.id = e.shift_id
  where e.org_id = v_project.org_id and e.deleted_at is null and e.clock_out is not null and e.membership_id is not null
    and (e.clock_in at time zone p.time_zone)::date between v_start and p_week_ending
    and e.membership_id in (
      select e2.membership_id from app.time_entries e2 join app.projects p2 on p2.id = e2.project_id
      where e2.project_id = p_project_id and e2.deleted_at is null and e2.clock_out is not null
        and (e2.clock_in at time zone p2.time_zone)::date between v_start and p_week_ending)
    and exists (
      select 1 from app.timesheets t join app.timesheet_approvals a on a.timesheet_id = t.id and a.voided_at is null
      where t.membership_id = e.membership_id and t.project_id = e.project_id and t.deleted_at is null
        and t.timesheet_state = 'Approved' and e.clock_in >= private.project_day_start(t.project_id, t.period_start) and e.clock_in < private.project_day_start(t.project_id, t.period_end + 1));

  return query
  with split as (
    select s.*, (select pr.rate_minor from app.pay_rates pr
                 where pr.membership_id = s.membership_id and pr.role_code = s.role_code and pr.effective_from <= p_week_ending
                   and pr.deleted_at is null and pr.currency_code = v_project.currency
                 order by pr.effective_from desc, pr.created_at desc limit 1) as rate_minor
    from private.split_work_minutes() s
  ), earned as (
    select s.*, round(coalesce(s.rate_minor, 0) * (s.regular_minutes + s.ot_minutes * s.ot_multiplier + s.dt_minutes * s.dt_multiplier) / 60.0)::bigint as gross
    from split s
  ), all_work as (
    select e.membership_id, sum(e.gross)::bigint as gross from earned e group by 1
  ), project_rows as (
    select e.membership_id, e.role_code,
      array(select coalesce(sum(x.regular_minutes), 0)::integer from generate_series(0, 6) d
            left join earned x on x.membership_id = e.membership_id and x.role_code = e.role_code and x.project_id = p_project_id
              and x.work_date = v_start + d group by d order by d) as st,
      array(select coalesce(sum(x.ot_minutes + x.dt_minutes), 0)::integer from generate_series(0, 6) d
            left join earned x on x.membership_id = e.membership_id and x.role_code = e.role_code and x.project_id = p_project_id
              and x.work_date = v_start + d group by d order by d) as ot,
      sum(e.minutes)::integer as total, max(e.rate_minor) as rate, max(e.ot_multiplier) as ot_multiplier, sum(e.gross)::bigint as gross
    from earned e where e.project_id = p_project_id
    group by e.membership_id, e.role_code
  ), named as (
    select r.*, pe.full_name,
      coalesce(nullif(btrim(pe.family_name), ''), (regexp_match(btrim(pe.full_name), '(\S+)$'))[1]) as last_name,
      coalesce(nullif(btrim(pe.given_name), ''), (regexp_match(btrim(pe.full_name), '^(\S+)'))[1]) as first_name,
      case when pe.given_name is null and array_length(regexp_split_to_array(btrim(pe.full_name), '\s+'), 1) >= 3
           then left((regexp_split_to_array(btrim(pe.full_name), '\s+'))[2], 1) end as middle_initial,
      upper(left(replace(r.membership_id::text, '-', ''), 8)) as identifying_number,
      (select 'RA' || coalesce(' ' || ra.progression_level, '') from app.registered_apprentices ra
       where ra.membership_id = r.membership_id and ra.deleted_at is null and ra.valid_from <= p_week_ending
         and (ra.valid_to is null or ra.valid_to >= v_start) order by ra.valid_from desc limit 1) as apprentice,
      (select xr.job_title::text from xpms.role xr where xr.role_code = r.role_code) as classification
    from project_rows r
    join app.memberships m on m.id = r.membership_id
    join app.people pe on pe.id = m.person_id
  )
  select v_number,
    dense_rank() over (order by n.last_name, n.first_name, n.membership_id)::integer,
    n.last_name, n.first_name, n.middle_initial, n.identifying_number, coalesce(n.apprentice, 'J'),
    coalesce(n.classification, n.role_code), n.st, n.ot, n.total, v_project.currency::text,
    n.rate, round(n.rate * n.ot_multiplier)::bigint, n.gross, w.gross
  from named n join all_work w on w.membership_id = n.membership_id
  order by 2, 8;

  perform private.write_audit_event(v_project.org_id, 'crew.certified_payroll_exported', 'app.certified_payroll_submissions', null,
    jsonb_build_object('project_id', p_project_id, 'week_ending', p_week_ending, 'payroll_number', v_number, 'classification', 'Restricted'));
end;
$$;

-- app.calculate_payroll_run, from 3271_holiday_pay.sql.
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
    and e.clock_out is not null and e.clock_in >= private.project_day_start(t.project_id, t.period_start) and e.clock_in < private.project_day_start(t.project_id, t.period_end + 1)
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

  -- Holiday pay (3270, ADR 0112): each paid holiday on the calendar that governs a project, inside the period of a person's
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

-- private.void_timesheet_approvals, from 4751_roster_time.sql.
create or replace function private.void_timesheet_approvals()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row app.time_entries := case when tg_op = 'DELETE' then old else new end;
  v_sheet record;
begin
  if tg_op = 'UPDATE' and new.clock_in = old.clock_in and new.clock_out is not distinct from old.clock_out
     and new.break_minutes = old.break_minutes and new.deleted_at is not distinct from old.deleted_at then
    return null;
  end if;
  for v_sheet in
    select t.id from app.timesheets t
    where t.membership_id is not distinct from v_row.membership_id and t.engagement_id is not distinct from v_row.engagement_id
      and t.roster_entry_id is not distinct from v_row.roster_entry_id
      and t.project_id = v_row.project_id and t.timesheet_state = 'Approved' and t.deleted_at is null
      and ((v_row.clock_in >= private.project_day_start(t.project_id, t.period_start) and v_row.clock_in < private.project_day_start(t.project_id, t.period_end + 1))
           or (tg_op = 'UPDATE' and old.clock_in >= private.project_day_start(t.project_id, t.period_start) and old.clock_in < private.project_day_start(t.project_id, t.period_end + 1)))
  loop
    update app.timesheet_approvals set voided_at = now() where timesheet_id = v_sheet.id and voided_at is null;
    perform private.transition_lifecycle('timesheet', 'app.timesheets', 'timesheet_state', 'app.timesheet_state_transitions',
      'timesheet_id', v_sheet.id, 'Approved', 'Proposed', 'Hours changed after approval; the approval is voided.');
  end loop;
  return null;
end;
$$;

-- private.worker_minutes, from 4751_roster_time.sql.
create or replace function private.worker_minutes(p_membership_id uuid, p_engagement_id uuid, p_roster_entry_id uuid, p_project_id uuid, p_from date, p_to date)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(greatest(0, (extract(epoch from (e.clock_out - e.clock_in)) / 60)::integer - e.break_minutes)), 0)::integer
  from app.time_entries e
  where e.membership_id is not distinct from p_membership_id and e.engagement_id is not distinct from p_engagement_id
    and e.roster_entry_id is not distinct from p_roster_entry_id
    and e.project_id = p_project_id and e.deleted_at is null
    and e.clock_out is not null and e.clock_in >= private.project_day_start(p_project_id, p_from) and e.clock_in < private.project_day_start(p_project_id, p_to + 1);
$$;

-- private.worker_has_open_entry, from 4751_roster_time.sql.
create or replace function private.worker_has_open_entry(p_membership_id uuid, p_engagement_id uuid, p_roster_entry_id uuid, p_project_id uuid, p_from date, p_to date)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from app.time_entries e
    where e.membership_id is not distinct from p_membership_id and e.engagement_id is not distinct from p_engagement_id
      and e.roster_entry_id is not distinct from p_roster_entry_id
      and e.project_id = p_project_id and e.deleted_at is null
      and e.clock_out is null and e.clock_in >= private.project_day_start(p_project_id, p_from) and e.clock_in < private.project_day_start(p_project_id, p_to + 1));
$$;

-- app.decide_timesheet, from 4754_supervisor_punches.sql.
create or replace function app.decide_timesheet(p_timesheet_id uuid, p_decision app.approval_decision, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_person uuid := private.require_person();
  v_sheet app.timesheets;
  v_entry uuid;
begin
  select * into v_sheet from app.timesheets t where t.id = p_timesheet_id and t.deleted_at is null for update;
  if v_sheet.id is null or not private.can_on_project(v_sheet.project_id, 'crew.timesheet.approve') then
    raise exception using errcode = '42501', message = 'crew.timesheet.approve is required on the project';
  end if;
  perform private.assert_separation('sod_timesheet_submitter', v_person, v_sheet.submitted_by);
  perform private.assert_separation('sod_timesheet_submitter', v_person,
    private.worker_person_id(v_sheet.membership_id, v_sheet.engagement_id, v_sheet.roster_entry_id));
  if exists (
    select 1 from app.clock_punches c
    join app.time_entries e on e.id = c.time_entry_id
    where c.source = 'Supervisor' and c.created_by = v_person and e.deleted_at is null
      and e.project_id = v_sheet.project_id
      and e.membership_id is not distinct from v_sheet.membership_id and e.engagement_id is not distinct from v_sheet.engagement_id
      and e.roster_entry_id is not distinct from v_sheet.roster_entry_id
      and e.clock_in >= private.project_day_start(v_sheet.project_id, v_sheet.period_start) and e.clock_in < private.project_day_start(v_sheet.project_id, v_sheet.period_end + 1)) then
    perform private.assert_separation('sod_supervisor_punch', v_person, v_person);
  end if;
  v_entry := private.transition_lifecycle('timesheet', 'app.timesheets', 'timesheet_state', 'app.timesheet_state_transitions',
    'timesheet_id', p_timesheet_id, 'Submitted', p_decision::text, p_reason);
  if p_decision = 'Approved' then
    insert into app.timesheet_approvals (timesheet_id, approved_by, approved_minutes)
    values (p_timesheet_id, v_person, private.timesheet_minutes(p_timesheet_id));
  end if;
  return v_entry;
end;
$$;

-- private.timesheet_approver_person_ids, from 4755_roster_shift_editor_and_approvals.sql.
create or replace function private.timesheet_approver_person_ids(p_timesheet_id uuid)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select distinct m.person_id
  from app.timesheets t
  join app.memberships m on m.org_id = t.org_id and m.deleted_at is null
    and m.valid_from <= now() and (m.valid_to is null or m.valid_to > now())
  where t.id = p_timesheet_id
    and private.person_capability_reach(m.person_id, t.org_id, 'crew.timesheet.approve', true) = 'organization'
    and m.person_id is distinct from t.submitted_by
    and m.person_id is distinct from private.worker_person_id(t.membership_id, t.engagement_id, t.roster_entry_id)
    -- The same Supervisor punch test app.decide_timesheet applies (sod_supervisor_punch, 4754).
    and not exists (
      select 1 from app.clock_punches c
      join app.time_entries e on e.id = c.time_entry_id
      where c.source = 'Supervisor' and c.created_by = m.person_id and e.deleted_at is null
        and e.project_id = t.project_id
        and e.membership_id is not distinct from t.membership_id and e.engagement_id is not distinct from t.engagement_id
        and e.roster_entry_id is not distinct from t.roster_entry_id
        and e.clock_in >= private.project_day_start(t.project_id, t.period_start) and e.clock_in < private.project_day_start(t.project_id, t.period_end + 1));
$$;

-- app.timesheet_hours, from 4751, with the period's instants appended.
create or replace view app.timesheet_hours with (security_invoker = true) as
select t.id as timesheet_id, t.project_id, t.membership_id,
  private.worker_minutes(t.membership_id, t.engagement_id, t.roster_entry_id, t.project_id, t.period_start, t.period_end) as worked_minutes,
  private.worker_has_open_entry(t.membership_id, t.engagement_id, t.roster_entry_id, t.project_id, t.period_start, t.period_end) as has_open_entry,
  t.engagement_id,
  t.roster_entry_id,
  private.project_day_start(t.project_id, t.period_start) as period_starts_at,
  private.project_day_start(t.project_id, t.period_end + 1) as period_ends_at
from app.timesheets t
where t.deleted_at is null;

comment on column app.timesheet_hours.period_starts_at is 'The instant the period''s first local day starts on the project.';
comment on column app.timesheet_hours.period_ends_at is 'The instant after the period''s last local day ends on the project.';
