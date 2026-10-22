-- pgTAP: migration 1384, finding A65-014 (RRR-127). State wage-hour rules in the app layer: a project's labor subdivision
-- comes from its venue, else its canon region; California's daily overtime, double time and seventh consecutive day apply
-- beside the federal weekly rule; the payroll calculation pays double time on the DT earning code.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(12);

-- Labor subdivision ------------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
select is(private.labor_subdivision(pg_temp.id('prj_a')), 'US-FL', 'without a venue subdivision, the canon region of the jurisdiction');
update app.venues set subdivision_code = 'US-CA' where id = pg_temp.id('venue_a');
select is(private.labor_subdivision(pg_temp.id('prj_a')), 'US-CA', 'the venue''s subdivision governs');
select throws_ok($$update app.venues set subdivision_code = 'California' where id = (select id from world where key = 'venue_a')$$,
  '23514', null, 'a subdivision is an ISO 3166-2 code');

-- The split itself -------------------------------------------------------------------------------------------------------
create temporary table work_minutes (
  membership_id uuid, role_code text, project_id uuid, jurisdiction_id text, subdivision_code text,
  week date, work_date date, clock_in timestamptz, minutes integer
) on commit drop;
-- A 13-hour day in California: 8 regular, 4 overtime, 1 double time. The same day in Florida: 13 regular.
insert into pg_temp.work_minutes values
  (pg_temp.id('frank@org_a'), '0000.50.01', pg_temp.id('prj_a'), 'US', 'US-CA', '2027-06-14', '2027-06-14', '2027-06-14 12:00+00', 780),
  (pg_temp.id('dave@org_a'), '0000.50.01', pg_temp.id('prj_a'), 'US', 'US-FL', '2027-06-14', '2027-06-14', '2027-06-14 12:00+00', 780);
select results_eq($$select regular_minutes, ot_minutes, dt_minutes, ot_multiplier, dt_multiplier from private.split_work_minutes()
  where membership_id = (select id from world where key = 'frank@org_a')$$,
  $$values (480, 240, 60, 1.5::numeric, 2.0::numeric)$$, 'California: daily overtime after 8 hours and double time after 12');
select results_eq($$select regular_minutes, ot_minutes, dt_minutes from private.split_work_minutes()
  where membership_id = (select id from world where key = 'dave@org_a')$$,
  $$values (780, 0, 0)$$, 'Florida has no daily rule: the federal weekly rule alone');
truncate pg_temp.work_minutes;

-- End to end: seven consecutive days in California -------------------------------------------------------------------------
-- The org's workweek runs Monday to Sunday (payroll.week_start, the week 1399 counts in), so Sunday is the seventh day.
select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'payroll.week_start', 'Organization', pg_temp.id('org_a'), p_value_text => 'monday');
select pg_temp.as_user('bob');
insert into app.pay_rates (membership_id, role_code, rate_minor, currency_code, effective_from)
values (pg_temp.id('frank@org_a'), '0000.50.01', 3200, 'USD', '2027-01-01');
insert into app.earning_codes (org_id, code, name) values (pg_temp.id('org_a'), 'REG', 'Regular');
insert into app.earning_codes (org_id, code, name, is_overtime) values (pg_temp.id('org_a'), 'OT', 'Overtime', true);
insert into app.earning_codes (org_id, code, name, is_overtime) values (pg_temp.id('org_a'), 'DT', 'Double time', true);
select pg_temp.as_user('frank');
-- Monday to Saturday 10 hours, Sunday 9 hours (08:00 local in New York).
insert into app.time_entries (project_id, membership_id, clock_in, clock_out)
select pg_temp.id('prj_a'), pg_temp.id('frank@org_a'), (d::date + time '12:00') at time zone 'UTC',
  (d::date + case when d::date = date '2027-06-20' then time '21:00' else time '22:00' end) at time zone 'UTC'
from generate_series(date '2027-06-14', date '2027-06-20', interval '1 day') d;
with x as (insert into app.timesheets (project_id, membership_id, period_start, period_end)
  values (pg_temp.id('prj_a'), pg_temp.id('frank@org_a'), '2027-06-14', '2027-06-20') returning id) insert into world select 'ts', id from x;
select app.submit_timesheet(pg_temp.id('ts'));
select pg_temp.as_user('carol');
select app.decide_timesheet(pg_temp.id('ts'), 'Approved', 'Matches the call sheet.');
with x as (insert into app.pay_periods (org_id, starts_on, ends_on) values (pg_temp.id('org_a'), '2027-06-14', '2027-06-27') returning id) insert into world select 'pp', id from x;
with x as (insert into app.payroll_runs (pay_period_id, currency_code) values (pg_temp.id('pp'), 'USD') returning id) insert into world select 'run', id from x;
select is(app.calculate_payroll_run(pg_temp.id('run')), 3, 'regular, overtime and double-time lines');

create function pg_temp.hours(p_code text) returns numeric language sql as $$
  select sum(l.hours) from app.payroll_lines l join app.earning_codes e on e.id = l.earning_code_id
  where l.payroll_run_id = pg_temp.id('run') and e.code = p_code and l.deleted_at is null $$;
select is(pg_temp.hours('REG'), 40.00, 'forty regular hours');
select is(pg_temp.hours('OT'), 28.00,
  'overtime: 2 hours a day Monday to Saturday, Saturday''s 8 past 40 in the week, and the first 8 of the seventh day');
select is(pg_temp.hours('DT'), 1.00, 'double time past 8 hours on the seventh consecutive day');
select pg_temp.as_user('alice');
select is((select rate_minor from app.payroll_line_amounts a join app.earning_codes e on e.id = a.earning_code_id
  where a.payroll_run_id = pg_temp.id('run') and e.code = 'DT'), 6400::bigint, 'double time pays twice the rate');
select is((select rate_minor from app.payroll_line_amounts a join app.earning_codes e on e.id = a.earning_code_id
  where a.payroll_run_id = pg_temp.id('run') and e.code = 'OT'), 4800::bigint, 'overtime pays one and a half times');

-- Platform reference data ------------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
select throws_ok('select 1 from private.state_wage_hour_rules', '42501', null, 'members do not read the rule table directly');

select * from finish();
rollback;
