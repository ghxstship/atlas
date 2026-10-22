-- pgTAP: 1399 (RRR-116). app.calculate_payroll_run keeps 1384's state rules (California daily overtime, double time and
-- the seventh consecutive day, double time on the DT code) and counts its weeks on the org's payroll.week_start (1398).
-- Frank works seven days in a row on a California project, Sunday 2027-06-13 to Saturday 2027-06-19: 10 hours a day,
-- 9 on Saturday. On the org's Sunday weeks Saturday is the seventh consecutive day of one workweek; on Monday weeks
-- Sunday belongs to the week before and no week has seven days. Times are pinned in New York, prj_a's zone, so the
-- result never depends on the time of day the suite runs.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(7);

select pg_temp.as_platform();
update app.venues set subdivision_code = 'US-CA' where id = pg_temp.id('venue_a');
select is(private.labor_subdivision(pg_temp.id('prj_a')), 'US-CA', 'prj_a''s work falls under California''s rules');

select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'payroll.week_start', 'Organization', pg_temp.id('org_a'), p_value_text => 'sunday');
select pg_temp.as_user('bob');
insert into app.pay_rates (membership_id, role_code, rate_minor, currency_code, effective_from)
values (pg_temp.id('frank@org_a'), '0000.50.01', 3200, 'USD', '2027-01-01');
insert into app.earning_codes (org_id, code, name) values (pg_temp.id('org_a'), 'REG', 'Regular');
insert into app.earning_codes (org_id, code, name, is_overtime) values (pg_temp.id('org_a'), 'OT', 'Overtime', true);
insert into app.earning_codes (org_id, code, name, is_overtime) values (pg_temp.id('org_a'), 'DT', 'Double time', true);
select pg_temp.as_user('frank');
insert into app.time_entries (project_id, membership_id, clock_in, clock_out)
select pg_temp.id('prj_a'), pg_temp.id('frank@org_a'), (d::date + time '08:00') at time zone 'America/New_York',
  (d::date + case when d::date = date '2027-06-19' then time '17:00' else time '18:00' end) at time zone 'America/New_York'
from generate_series(date '2027-06-13', date '2027-06-19', interval '1 day') d;
with x as (insert into app.timesheets (project_id, membership_id, period_start, period_end)
  values (pg_temp.id('prj_a'), pg_temp.id('frank@org_a'), '2027-06-13', '2027-06-19') returning id) insert into world select 'ts', id from x;
select app.submit_timesheet(pg_temp.id('ts'));
select pg_temp.as_user('carol');
select app.decide_timesheet(pg_temp.id('ts'), 'Approved', 'Matches the call sheet.');
with x as (insert into app.pay_periods (org_id, starts_on, ends_on) values (pg_temp.id('org_a'), '2027-06-13', '2027-06-26') returning id) insert into world select 'pp', id from x;

create function pg_temp.lines(p_key text) returns table (code text, hours numeric) language sql as $$
  select e.code, l.hours from app.payroll_lines l join app.earning_codes e on e.id = l.earning_code_id
  where l.payroll_run_id = pg_temp.id(p_key) and l.deleted_at is null order by e.code $$;

-- Sunday weeks (the org's default) ----------------------------------------------------------------------------------------
with x as (insert into app.payroll_runs (pay_period_id, currency_code) values (pg_temp.id('pp'), 'USD') returning id) insert into world select 'run_sunday', id from x;
select is(app.calculate_payroll_run(pg_temp.id('run_sunday')), 3, 'on Sunday weeks: regular, overtime and double-time lines');
select results_eq($$select code, hours from pg_temp.lines('run_sunday')$$,
  $$values ('DT'::text, 1.00::numeric), ('OT', 28.00), ('REG', 40.00)$$,
  'Saturday is the seventh day of the org''s week: 2 daily overtime hours Sunday to Friday, Friday''s 8 past 40, Saturday''s first 8 as overtime and its ninth as double time');
select pg_temp.as_user('alice');
select is((select rate_minor from app.payroll_line_amounts a join app.earning_codes e on e.id = a.earning_code_id
  where a.payroll_run_id = pg_temp.id('run_sunday') and e.code = 'DT'), 6400::bigint, 'double time still pays twice the rate');

-- Monday weeks ------------------------------------------------------------------------------------------------------------
select app.set_setting(pg_temp.id('org_a'), 'payroll.week_start', 'Organization', pg_temp.id('org_a'), p_value_text => 'monday');
select pg_temp.as_user('carol');
with x as (insert into app.payroll_runs (pay_period_id, currency_code) values (pg_temp.id('pp'), 'USD') returning id) insert into world select 'run_monday', id from x;
select is(app.calculate_payroll_run(pg_temp.id('run_monday')), 2, 'on Monday weeks: regular and overtime lines, no double time');
select results_eq($$select code, hours from pg_temp.lines('run_monday')$$,
  $$values ('OT'::text, 21.00::numeric), ('REG', 48.00)$$,
  'Sunday counts in the week before, so no week has a seventh day: daily overtime each day and 8 hours past 40 from Monday to Saturday');

-- A person's own week start never moves payroll's week -------------------------------------------------------------------
select pg_temp.as_user('carol');
select app.set_personal_setting('payroll.week_start', null, p_value_text => 'sunday');
with x as (insert into app.payroll_runs (pay_period_id, currency_code) values (pg_temp.id('pp'), 'USD') returning id) insert into world select 'run_personal', id from x;
select app.calculate_payroll_run(pg_temp.id('run_personal'));
select results_eq($$select code, hours from pg_temp.lines('run_personal')$$,
  $$select code, hours from pg_temp.lines('run_monday')$$,
  'the calculating manager''s own Sunday week start leaves the org''s Monday weeks in place');

select * from finish();
rollback;
