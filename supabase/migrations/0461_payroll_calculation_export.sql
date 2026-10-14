-- 0461_payroll_calculation_export.sql
-- A13 People and Crew (ADR 0022 range 0460 to 0469). Payroll calculation and the payroll export
-- (Section 4.2 Crew, Section 16, journey 12):
--   * app.calculate_payroll_run writes a Draft run's lines from approved timesheets at the pay rate
--     in force, splitting weekly overtime by the canon wage-hour rule of the project's jurisdiction.
--     It runs as definer, so callers without data.restricted.read.payroll calculate without ever
--     reading a rate.
--   * app.produce_payroll_export renders the export file of an Approved run (Universal CSV, one row per
--     payroll line), records its checksum, and moves the run to Exported. The file carries Restricted
--     rates, so it needs data.export.restricted and step-up authentication. A19's payroll handoffs
--     (Gusto, ADP, Rippling) consume the file. app.payroll_export_file renders it again on download
--     and checks the checksum, because the lines are frozen once the run is Approved.
--   * The payroll_export plan feature (Team and up, Section 16) is enforced in SQL on every export row
--     and on every move of a run to Exported.

insert into private.domain_event_types (code, subject, description) values
  ('payroll_run.calculated', 'payroll_runs', 'A payroll run''s lines were calculated from approved timesheets.'),
  ('payroll_export.produced', 'payroll_exports', 'A payroll export file was produced for an approved run.');

-- Wage-hour rule of a jurisdiction, inherited down the chain (canon, Section 3.7) ----------------------

create or replace function private.wage_hour_rule_for(p_jurisdiction_id text)
returns table (jurisdiction_id text, weekly_ot_after_hours numeric, min_ot_multiplier numeric)
language sql
stable
security definer
set search_path = ''
as $$
  with recursive chain as (
    select j.jurisdiction_id::text as id, j.parent::text as parent, 0 as depth
    from xpms.jurisdiction j where j.jurisdiction_id = p_jurisdiction_id
    union all
    select j.jurisdiction_id::text, j.parent::text, c.depth + 1
    from chain c join xpms.jurisdiction j on j.jurisdiction_id = c.parent
  )
  select w.jurisdiction_id::text, w.weekly_ot_after_hours::numeric, w.min_ot_multiplier::numeric
  from chain c join xpms.wage_hour_rule w on w.jurisdiction_id = c.id
  order by c.depth
  limit 1;
$$;

comment on function private.wage_hour_rule_for(text) is 'The nearest wage-hour rule up the jurisdiction chain; no row when no level of the chain states one (no answer, never a default).';

-- Calculation -------------------------------------------------------------------------------------------

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
  where t.org_id = v_run.org_id and t.deleted_at is null and t.timesheet_state = 'Approved'
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
  insert into app.payroll_lines (payroll_run_id, membership_id, earning_code_id, hours, rate_minor)
  select p_payroll_run_id, r.membership_id, v_regular, round(r.regular_minutes / 60.0, 2), r.rate_minor
  from rated r where r.regular_minutes > 0
  union all
  select p_payroll_run_id, r.membership_id, coalesce(v_overtime, v_regular), round(r.ot_minutes / 60.0, 2),
    round(r.rate_minor * coalesce(r.multiplier, 1))::bigint
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

comment on function app.calculate_payroll_run(uuid, text) is 'Writes a Draft payroll run''s lines from approved timesheets of its pay period: hours by person and role at the pay rate in force, weekly overtime split by the wage-hour rule of each project''s jurisdiction at its multiplier, then moves the run to Calculated. Needs crew.pay_period.manage; never returns a rate. Refuses with no answer when a rate, an earning code or a wage-hour rule is missing.';

-- Plan gate (Section 16: payroll export from Team) --------------------------------------------------------

create or replace function private.assert_payroll_export_plan(p_org_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.org_has_feature(p_org_id, 'payroll_export') then
    perform private.refuse('plan_feature_required', 'Payroll export is included from the Team plan; upgrade in Billing and Plan.');
  end if;
end;
$$;

comment on function private.assert_payroll_export_plan(uuid) is 'Refuses unless the org''s plan includes the payroll_export feature (Team and Enterprise).';

create or replace function private.guard_payroll_export_plan()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.assert_payroll_export_plan((select r.org_id from app.payroll_runs r where r.id = new.payroll_run_id));
  return new;
end;
$$;

comment on function private.guard_payroll_export_plan() is 'Plan gate on payroll exports and on runs moving to Exported.';

create trigger t44_guard_payroll_export_plan before insert on app.payroll_exports
  for each row execute function private.guard_payroll_export_plan();
create trigger t44_guard_payroll_export_plan before insert on app.payroll_run_state_transitions
  for each row when (new.to_state = 'Exported')
  execute function private.guard_payroll_export_plan();

-- Export file ------------------------------------------------------------------------------------------

create or replace function private.render_payroll_export(p_payroll_run_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select 'payroll_run_id,pay_period_start,pay_period_end,person_id,membership_id,earning_code,hours,rate_minor,amount_minor,currency_code' || E'\n'
    || coalesce(string_agg(
         concat_ws(',', r.id, p.starts_on, p.ends_on, m.person_id, l.membership_id, e.code, l.hours::text, l.rate_minor,
                   private.extended_minor(l.hours, l.rate_minor), r.currency_code),
         E'\n' order by m.person_id, l.membership_id, e.code, l.id), '')
    || E'\n'
  from app.payroll_runs r
  join app.pay_periods p on p.id = r.pay_period_id
  left join app.payroll_lines l on l.payroll_run_id = r.id and l.deleted_at is null
  left join app.memberships m on m.id = l.membership_id
  left join app.earning_codes e on e.id = l.earning_code_id
  where r.id = p_payroll_run_id
  group by r.id, p.starts_on, p.ends_on, r.currency_code;
$$;

comment on function private.render_payroll_export(uuid) is 'Renders a run''s export file: a header and one CSV row per payroll line with person, earning code, hours, rate and amount in minor units. Deterministic, so a frozen run renders the same bytes every time. Names are left out so the checksum survives renames; A19 maps person_id to the provider''s employee.';

create or replace function private.assert_payroll_export_access(p_org_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.has_capability(p_org_id, 'crew.payroll.export') then
    raise exception using errcode = '42501', message = 'crew.payroll.export is required';
  end if;
  perform private.assert_payroll_export_plan(p_org_id);
  if not private.has_capability(p_org_id, 'data.export.restricted') then
    perform private.refuse('export_restricted', 'A payroll export carries Restricted pay rates and needs the restricted export capability.');
  end if;
  if private.session_aal() <> 'aal2' then
    perform private.refuse('step_up_required', 'Exporting Restricted columns needs step-up authentication.');
  end if;
end;
$$;

comment on function private.assert_payroll_export_access(uuid) is 'Who may produce or download a payroll export: crew.payroll.export, the payroll_export plan feature, data.export.restricted and step-up authentication (Section 8.6, journey 31).';

create or replace function app.produce_payroll_export(p_payroll_run_id uuid, p_provider text default 'CSV')
returns table (payroll_export_id uuid, file_uri text, checksum_sha256 text, content text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_run app.payroll_runs;
  v_content text;
  v_checksum text;
  v_id uuid := private.uuid_v7();
  v_uri text;
begin
  perform private.require_person();
  select * into v_run from app.payroll_runs r where r.id = p_payroll_run_id and r.deleted_at is null for update;
  if v_run.id is null then
    raise exception using errcode = '42501', message = 'payroll run not found';
  end if;
  perform private.assert_payroll_export_access(v_run.org_id);
  if v_run.payroll_run_state <> 'Approved' then
    perform private.refuse('payroll_run_not_approved', 'Only an Approved payroll run is exported.');
  end if;
  if p_provider is null or char_length(btrim(p_provider)) not between 1 and 50 then
    perform private.refuse('payroll_export_provider', 'Name the payroll provider the file goes to.');
  end if;
  v_content := private.render_payroll_export(p_payroll_run_id);
  v_checksum := encode(extensions.digest(v_content, 'sha256'), 'hex');
  v_uri := format('payroll-exports/%s/%s/%s.csv', v_run.org_id, v_run.id, v_id);
  insert into app.payroll_exports (id, payroll_run_id, provider, file_uri, checksum_sha256)
  values (v_id, p_payroll_run_id, btrim(p_provider), v_uri, v_checksum);
  perform private.transition_lifecycle('payroll_run', 'app.payroll_runs', 'payroll_run_state', 'app.payroll_run_state_transitions',
    'payroll_run_id', p_payroll_run_id, 'Approved', 'Exported', format('Exported to %s.', btrim(p_provider)));
  return query select v_id, v_uri, v_checksum, v_content;
end;
$$;

comment on function app.produce_payroll_export(uuid, text) is 'Produces the export file of an Approved payroll run, records it with its checksum and moves the run to Exported. Needs crew.payroll.export, the payroll_export plan feature, data.export.restricted and step-up authentication.';

create or replace function app.payroll_export_file(p_payroll_export_id uuid)
returns table (file_uri text, checksum_sha256 text, content text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_export app.payroll_exports;
  v_content text;
begin
  perform private.require_person();
  select * into v_export from app.payroll_exports x where x.id = p_payroll_export_id and x.deleted_at is null;
  if v_export.id is null then
    raise exception using errcode = '42501', message = 'payroll export not found';
  end if;
  perform private.assert_payroll_export_access(v_export.org_id);
  v_content := private.render_payroll_export(v_export.payroll_run_id);
  if encode(extensions.digest(v_content, 'sha256'), 'hex') <> v_export.checksum_sha256 then
    perform private.refuse('payroll_export_changed', 'The payroll lines changed since this file was produced; produce a new export.');
  end if;
  return query select v_export.file_uri, v_export.checksum_sha256, v_content;
end;
$$;

comment on function app.payroll_export_file(uuid) is 'Renders a produced payroll export again for download and refuses if its checksum no longer matches. Same access as producing it.';

create trigger t90_emit_payroll_export_produced after insert on app.payroll_exports
  for each row execute function private.emit_subject_event('payroll_export.produced', 'payroll_exports', 'id', 'payroll_run_id', 'provider', 'checksum_sha256');

-- Function privileges ------------------------------------------------------------------------------------------

revoke all on function private.wage_hour_rule_for(text) from public, anon, authenticated;
revoke all on function private.assert_payroll_export_plan(uuid) from public, anon, authenticated;
revoke all on function private.guard_payroll_export_plan() from public, anon, authenticated;
revoke all on function private.render_payroll_export(uuid) from public, anon, authenticated;
revoke all on function private.assert_payroll_export_access(uuid) from public, anon, authenticated;
revoke all on function app.calculate_payroll_run(uuid, text) from public, anon;
revoke all on function app.produce_payroll_export(uuid, text) from public, anon;
revoke all on function app.payroll_export_file(uuid) from public, anon;
grant execute on function app.calculate_payroll_run(uuid, text) to authenticated, service_role;
grant execute on function app.produce_payroll_export(uuid, text) to authenticated, service_role;
grant execute on function app.payroll_export_file(uuid) to authenticated, service_role;
