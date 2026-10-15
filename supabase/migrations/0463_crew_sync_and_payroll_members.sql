-- 0463_crew_sync_and_payroll_members.sql
-- A13 People and Crew (ADR 0022 range 0460 to 0469).
--   * Compass replays accept_shift and claim_open_shift from its offline queue, so both are allowlisted
--     in private.sync_rpcs (A03F 0364).
--   * External crew time (A03F 0940) lets a timesheet name an engagement instead of a membership.
--     External crew are paid through their engagement (Section 4.4.5), never through payroll, so the
--     payroll calculation counts member timesheets only; an approved external timesheet no longer
--     blocks a run with a missing pay rate.

insert into private.sync_rpcs (rpc, description) values
  ('app.accept_shift', 'A crew member accepts a published shift assigned to them.'),
  ('app.claim_open_shift', 'A crew member claims a published open shift.')
on conflict (rpc) do nothing;

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
    date_trunc('week', e.clock_in at time zone p.time_zone)::date,
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

comment on function app.calculate_payroll_run(uuid, text) is 'Writes a Draft payroll run''s lines from approved member timesheets of its pay period (external crew are paid through their engagement): hours by person and role at the pay rate in force, weekly overtime split by the wage-hour rule of each project''s jurisdiction at its multiplier, then moves the run to Calculated. Needs crew.pay_period.manage; never returns a rate. Refuses with no answer when a rate, an earning code or a wage-hour rule is missing.';
