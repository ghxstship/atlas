-- pgTAP: the US federal holiday preset and the worked-holiday multiplier (2854, P8, ADR 0112). The preset adds the eleven
-- 5 U.S.C. 6103 holidays on their observed days, 8 paid hours each, once, with the names given, refusing other presets,
-- years and names and callers without org.payroll.write. A payroll run pays work on a holiday of the governing calendar at
-- its multiplier (regular minutes on the holiday code, overtime at the greater of the two multipliers), pays nothing extra
-- with the multiplier unset, refuses a premium with no holiday code, and asks for an overtime code only when overtime was
-- worked. Frank works on prj_a (Miami-Dade, weekly overtime after 40 hours, weeks from Sunday): Sunday 2027-06-13 to
-- Friday 2027-06-18 (Juneteenth, observed), and Monday 2027-07-05 (Independence Day, observed) to Thursday 2027-07-08,
-- 8 hours a day at 3200 an hour.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(22);

select results_eq($$select observed_on from private.us_federal_holidays(2027) order by observed_on$$,
  $$values ('2027-01-01'::date), ('2027-01-18'), ('2027-02-15'), ('2027-05-31'), ('2027-06-18'), ('2027-07-05'), ('2027-09-06'),
    ('2027-10-11'), ('2027-11-11'), ('2027-11-25'), ('2027-12-24')$$,
  'the eleven federal holidays of 2027 on their observed days, a Saturday holiday on the Friday and a Sunday one on the Monday');
select is((select observed_on from private.us_federal_holidays(2028) where code = 'new_years_day'), '2027-12-31'::date,
  'New Year''s Day 2028, a Saturday, is observed on December 31, 2027');
select is((select count(*)::int from private.us_federal_holidays(2101)), 0, 'no holidays outside 2021 to 2100');

-- The preset ---------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('bob');
with x as (insert into app.holiday_calendars (org_id, name, applies_to_org) values (pg_temp.id('org_a'), 'United States', true) returning id)
  insert into world select 'cal_us', id from x;
select is(app.add_holiday_preset(pg_temp.id('cal_us'), 'us_federal', 2027, '{"independence_day": "Día de la Independencia"}'), 11,
  'an admin adds the eleven federal holidays of 2027');
select is((select count(*)::int from app.holidays where holiday_calendar_id = pg_temp.id('cal_us') and paid_hours = 8), 11,
  'each pays 8 hours');
select is((select name from app.holidays where holiday_calendar_id = pg_temp.id('cal_us') and observed_on = '2027-07-05'), 'Día de la Independencia',
  'a name given by code is used');
select is((select name from app.holidays where holiday_calendar_id = pg_temp.id('cal_us') and observed_on = '2027-11-25'), 'Thanksgiving Day',
  'otherwise the English name');
select is(app.add_holiday_preset(pg_temp.id('cal_us'), 'us_federal', 2027), 0, 'adding the same year again adds nothing');
select is(app.add_holiday_preset(pg_temp.id('cal_us'), 'us_federal', 2028), 11, '2028 adds its eleven');
select ok(exists (select 1 from app.holidays where holiday_calendar_id = pg_temp.id('cal_us') and observed_on = '2027-12-31'),
  'including New Year''s Day observed on December 31, 2027');
select throws_ok($$select app.add_holiday_preset(pg_temp.id('cal_us'), 'us_federal', 2020)$$, 'XR001',
  'holiday_preset_year: Choose a year from 2021 to 2100.', 'a year outside 2021 to 2100 is refused');
select throws_ok($$select app.add_holiday_preset(pg_temp.id('cal_us'), 'uk_bank', 2027)$$, 'XR001', null, 'an unknown preset is refused');
select throws_ok($$select app.add_holiday_preset(pg_temp.id('cal_us'), 'us_federal', 2029, '{"boxing_day": "Boxing Day"}')$$, 'XR001',
  'holiday_preset_names: Each holiday name is 1 to 100 characters, for a holiday of the preset.', 'a name for a day outside the preset is refused');
select throws_ok($$update app.holiday_calendars set worked_holiday_multiplier = 3.5 where id = pg_temp.id('cal_us')$$, '23514', null,
  'a worked-holiday multiplier is 1 to 3');
select pg_temp.as_user('carol');
select throws_ok($$select app.add_holiday_preset(pg_temp.id('cal_us'), 'us_federal', 2029)$$, '42501', null,
  'a manager without org.payroll.write adds nothing');

-- Worked holidays in a payroll run ---------------------------------------------------------------------------------------------
select pg_temp.as_user('bob');
insert into app.pay_rates (membership_id, role_code, rate_minor, currency_code, effective_from)
values (pg_temp.id('frank@org_a'), '0000.50.01', 3200, 'USD', '2027-01-01');
insert into app.earning_codes (org_id, code, name) values (pg_temp.id('org_a'), 'REG', 'Regular');
with x as (insert into app.earning_codes (org_id, code, name, is_holiday) values (pg_temp.id('org_a'), 'HOL', 'Holiday', true) returning id)
  insert into world select 'hol', id from x;
select pg_temp.as_user('frank');
insert into app.time_entries (project_id, membership_id, clock_in, clock_out)
select pg_temp.id('prj_a'), pg_temp.id('frank@org_a'), (d::date + time '09:00') at time zone 'America/New_York',
  (d::date + time '17:00') at time zone 'America/New_York'
from (select generate_series(date '2027-06-13', date '2027-06-18', interval '1 day') d
      union all select generate_series(date '2027-07-05', date '2027-07-08', interval '1 day')) x;
with x as (insert into app.timesheets (project_id, membership_id, period_start, period_end)
  values (pg_temp.id('prj_a'), pg_temp.id('frank@org_a'), '2027-06-13', '2027-06-19') returning id) insert into world select 'ts1', id from x;
with x as (insert into app.timesheets (project_id, membership_id, period_start, period_end)
  values (pg_temp.id('prj_a'), pg_temp.id('frank@org_a'), '2027-07-04', '2027-07-10') returning id) insert into world select 'ts2', id from x;
select app.submit_timesheet(pg_temp.id('ts1'));
select app.submit_timesheet(pg_temp.id('ts2'));
select pg_temp.as_user('carol');
select app.decide_timesheet(pg_temp.id('ts1'), 'Approved', 'Matches the call sheet.');
select app.decide_timesheet(pg_temp.id('ts2'), 'Approved', 'Matches the call sheet.');
with x as (insert into app.pay_periods (org_id, starts_on, ends_on) values (pg_temp.id('org_a'), '2027-06-13', '2027-06-26') returning id) insert into world select 'pp1', id from x;
with x as (insert into app.pay_periods (org_id, starts_on, ends_on) values (pg_temp.id('org_a'), '2027-06-27', '2027-07-10') returning id) insert into world select 'pp2', id from x;

create function pg_temp.new_run(p_key text, p_period text) returns uuid language sql as $$
  with x as (insert into app.payroll_runs (pay_period_id, currency_code) values (pg_temp.id(p_period), 'USD') returning id)
  insert into world select p_key, id from x returning id $$;
-- Each line as code, hours and rate (rates are read by an Owner, through app.payroll_line_amounts).
create function pg_temp.lines(p_key text) returns table (code text, hours numeric, rate_minor bigint) language plpgsql as $$
begin
  perform pg_temp.as_user('alice');
  return query select e.code, a.hours, a.rate_minor from app.payroll_line_amounts a join app.earning_codes e on e.id = a.earning_code_id
    where a.payroll_run_id = pg_temp.id(p_key) order by e.code, a.rate_minor desc;
  perform pg_temp.as_user('carol');
end $$;

-- Independence Day worked at 1.5: its 8 hours go on the holiday code at 1.5 times the rate, beside its 8 paid hours.
-- There is no overtime code yet, and none is needed: the two holiday lines are no overtime.
select pg_temp.as_user('bob');
update app.holiday_calendars set worked_holiday_multiplier = 1.5 where id = pg_temp.id('cal_us');
select pg_temp.as_user('carol');
select pg_temp.new_run('run_july', 'pp2');
select is(app.calculate_payroll_run(pg_temp.id('run_july')), 3, 'a worked holiday adds its own line');
select results_eq($$select * from pg_temp.lines('run_july')$$,
  $$values ('HOL'::text, 8.00::numeric, 4800::bigint), ('HOL', 8.00, 3200), ('REG', 24.00, 3200)$$,
  'the worked holiday pays 1.5 times the rate on the holiday code; its paid hours and the other days pay as before');

-- Juneteenth falls after 40 hours: worked at 2, its overtime pays the greater multiplier.
select pg_temp.new_run('run_june', 'pp1');
select throws_ok($$select app.calculate_payroll_run(pg_temp.id('run_june'))$$, 'XR001',
  'payroll_overtime_code_missing: Overtime was worked; add an overtime earning code in Payroll and Time Off settings before calculating.',
  'overtime with no overtime code is still refused');
select pg_temp.as_user('bob');
insert into app.earning_codes (org_id, code, name, is_overtime) values (pg_temp.id('org_a'), 'OT', 'Overtime', true);
update app.holiday_calendars set worked_holiday_multiplier = 2 where id = pg_temp.id('cal_us');
select pg_temp.as_user('carol');
select app.calculate_payroll_run(pg_temp.id('run_june'));
select results_eq($$select * from pg_temp.lines('run_june')$$,
  $$values ('HOL'::text, 8.00::numeric, 3200::bigint), ('OT', 8.00, 6400), ('REG', 40.00, 3200)$$,
  'holiday overtime pays the greater of the overtime multiplier (1.5) and the holiday''s (2), and the minutes still count toward overtime');

-- With the multiplier unset, the run is 2271's.
select pg_temp.as_user('bob');
update app.holiday_calendars set worked_holiday_multiplier = null where id = pg_temp.id('cal_us');
select pg_temp.as_user('carol');
select pg_temp.new_run('run_plain', 'pp2');
select app.calculate_payroll_run(pg_temp.id('run_plain'));
select results_eq($$select * from pg_temp.lines('run_plain')$$,
  $$values ('HOL'::text, 8.00::numeric, 3200::bigint), ('REG', 32.00, 3200)$$,
  'with no multiplier, work on a holiday earns no premium');

-- A premium owed with no holiday code is refused, even on a holiday that pays no hours.
select pg_temp.as_user('bob');
update app.holidays set paid_hours = 0 where holiday_calendar_id = pg_temp.id('cal_us') and observed_on = '2027-07-05';
update app.earning_codes set deleted_at = now() where id = pg_temp.id('hol');
update app.holiday_calendars set worked_holiday_multiplier = 1.5 where id = pg_temp.id('cal_us');
select pg_temp.as_user('carol');
select pg_temp.new_run('run_no_code', 'pp2');
select throws_ok($$select app.calculate_payroll_run(pg_temp.id('run_no_code'))$$, 'XR001',
  'payroll_holiday_code_missing: This pay period includes holiday pay; add a holiday earning code in Payroll and Time Off settings before calculating.',
  'a worked-holiday premium with no holiday code is refused');
select pg_temp.as_user('bob');
update app.holiday_calendars set worked_holiday_multiplier = null where id = pg_temp.id('cal_us');
select pg_temp.as_user('carol');
select is(app.calculate_payroll_run(pg_temp.id('run_no_code')), 1, 'with no premium and the holiday unpaid, no holiday code is needed');

select * from finish();
rollback;
