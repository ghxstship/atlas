-- pgTAP: 2270_holiday_calendars and 2271_holiday_pay (A134, RRR-196, ADR 0105). Holiday calendars are written under
-- org.payroll.write and read across the org; time off policies are written under the same capability; a time off
-- request's day count skips holidays on the org's calendar; a payroll run pays holiday pay on the holiday earning code
-- from the calendar that governs the work (venue, then subdivision, then the org's), and refuses when no code is set.
-- Frank works Tuesday 2027-07-06 to Friday 2027-07-09, 8 hours a day, on prj_a (venue_a); his approved timesheet covers
-- the week of Sunday 2027-07-04, inside the pay period 2027-06-27 to 2027-07-10. Times are pinned in New York.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(29);

-- Calendar writes and RLS -------------------------------------------------------------------------------------------------
select pg_temp.as_user('bob');
with x as (insert into app.holiday_calendars (org_id, name, applies_to_org) values (pg_temp.id('org_a'), 'United States', true) returning id)
  insert into world select 'cal_us', id from x;
select isnt(pg_temp.id('cal_us'), null, 'an admin (org.payroll.write) adds an org holiday calendar');
select throws_ok($$insert into app.holiday_calendars (org_id, name, applies_to_org) values (pg_temp.id('org_a'), 'Second', true)$$,
  '23505', null, 'the org has one calendar with no subdivision that applies to it');
with x as (insert into app.holidays (holiday_calendar_id, observed_on, name) values (pg_temp.id('cal_us'), '2027-06-28', 'Founders Day') returning id)
  insert into world select 'hol_founders', id from x;
select is((select org_id from app.holidays where id = pg_temp.id('hol_founders')), pg_temp.id('org_a'), 'a holiday takes its calendar''s org');
select is((select paid_hours from app.holidays where id = pg_temp.id('hol_founders')), 8::numeric, 'a holiday pays 8 hours unless set');
select throws_ok($$insert into app.holidays (holiday_calendar_id, observed_on, name) values (pg_temp.id('cal_us'), '2027-06-28', 'Again')$$,
  '23505', null, 'a calendar has one holiday a day');
select throws_ok($$insert into app.holidays (holiday_calendar_id, observed_on, name, paid_hours) values (pg_temp.id('cal_us'), '2027-06-29', 'Long', 25)$$,
  '23514', null, 'a holiday pays at most 24 hours');
select throws_ok($$insert into app.holiday_calendar_venues (holiday_calendar_id, venue_id) values (pg_temp.id('cal_us'), pg_temp.id('venue_b'))$$,
  'XR001', null, 'a calendar is never assigned to another org''s venue');

select pg_temp.as_user('carol');
select throws_ok($$insert into app.holiday_calendars (org_id, name) values (pg_temp.id('org_a'), 'Managers')$$,
  '42501', null, 'a manager, who runs payroll, does not edit holiday calendars');
select is((select count(*)::integer from app.holidays where holiday_calendar_id = pg_temp.id('cal_us')), 1, 'a manager reads the org''s holidays');
update app.holidays set name = 'Renamed' where id = pg_temp.id('hol_founders');
select pg_temp.as_user('bob');
select is((select name from app.holidays where id = pg_temp.id('hol_founders')), 'Founders Day', 'a manager''s update changes no holiday');
select pg_temp.as_user('gina');
select is((select count(*)::integer from app.holiday_calendars where org_id = pg_temp.id('org_a')), 1, 'a viewer reads the org''s calendars');
select pg_temp.as_user('xavier');
select is((select count(*)::integer from app.holiday_calendars where org_id = pg_temp.id('org_a')), 0, 'another org reads none of them');
select throws_ok($$insert into app.holidays (holiday_calendar_id, observed_on, name) values (pg_temp.id('cal_us'), '2027-12-25', 'Christmas')$$,
  '42501', null, 'another org adds no holiday to the calendar');

-- Earning codes and time off policies ---------------------------------------------------------------------------------------
select pg_temp.as_user('bob');
select throws_ok($$insert into app.earning_codes (org_id, code, name, is_overtime, is_holiday) values (pg_temp.id('org_a'), 'HOT', 'Both', true, true)$$,
  '23514', null, 'an earning code is never both overtime and holiday');
with x as (insert into app.time_off_policies (org_id, name, accrual_hours_per_period) values (pg_temp.id('org_a'), 'Paid Time Off', 4) returning id)
  insert into world select 'pto', id from x;
update app.time_off_policies set name = 'Vacation', accrual_hours_per_period = 6 where id = pg_temp.id('pto');
select is((select name || ' ' || accrual_hours_per_period::text from app.time_off_policies where id = pg_temp.id('pto')), 'Vacation 6',
  'an admin edits a time off policy under org.payroll.write');
select pg_temp.as_user('carol');
select throws_ok($$insert into app.time_off_policies (org_id, name) values (pg_temp.id('org_a'), 'Sick')$$,
  '42501', null, 'a manager adds no time off policy');

-- Time off day counts ------------------------------------------------------------------------------------------------------
select pg_temp.as_user('frank');
with x as (insert into app.time_off_requests (time_off_policy_id, membership_id, starts_on, ends_on, hours)
  values (pg_temp.id('pto'), pg_temp.id('frank@org_a'), '2027-07-02', '2027-07-06', 40) returning id) insert into world select 'to', id from x;
create function pg_temp.days() returns integer language sql as $$
  select app.time_off_day_count(r) from app.time_off_requests r where r.id = pg_temp.id('to') $$;
select is(pg_temp.days(), 5, 'five days off, Friday to Tuesday, with no holiday among them');
select pg_temp.as_user('bob');
insert into app.holidays (holiday_calendar_id, observed_on, name) values (pg_temp.id('cal_us'), '2027-07-05', 'Independence Day (observed)');
select pg_temp.as_user('frank');
select is(pg_temp.days(), 4, 'the requester sees four once Independence Day is observed on Monday');
select pg_temp.as_user('bob');
with x as (insert into app.holiday_calendars (org_id, name, subdivision_code, applies_to_org) values (pg_temp.id('org_a'), 'California', 'US-CA', true) returning id)
  insert into world select 'cal_ca', id from x;
insert into app.holidays (holiday_calendar_id, observed_on, name) values (pg_temp.id('cal_ca'), '2027-07-06', 'State Day');
select is(pg_temp.days(), 4, 'a subdivision calendar leaves time off, which names no place, alone');
update app.holidays set deleted_at = now() where holiday_calendar_id = pg_temp.id('cal_us') and observed_on = '2027-07-05';
select is(pg_temp.days(), 5, 'removing the holiday counts the day again');
update app.holidays set deleted_at = null where holiday_calendar_id = pg_temp.id('cal_us') and observed_on = '2027-07-05';

-- Holiday pay in a payroll run --------------------------------------------------------------------------------------------------
select pg_temp.as_user('bob');
insert into app.pay_rates (membership_id, role_code, rate_minor, currency_code, effective_from)
values (pg_temp.id('frank@org_a'), '0000.50.01', 3200, 'USD', '2027-01-01');
insert into app.earning_codes (org_id, code, name) values (pg_temp.id('org_a'), 'REG', 'Regular');
insert into app.earning_codes (org_id, code, name, is_overtime) values (pg_temp.id('org_a'), 'OT', 'Overtime', true);
select pg_temp.as_user('frank');
insert into app.time_entries (project_id, membership_id, clock_in, clock_out)
select pg_temp.id('prj_a'), pg_temp.id('frank@org_a'), (d::date + time '09:00') at time zone 'America/New_York',
  (d::date + time '17:00') at time zone 'America/New_York'
from generate_series(date '2027-07-06', date '2027-07-09', interval '1 day') d;
with x as (insert into app.timesheets (project_id, membership_id, period_start, period_end)
  values (pg_temp.id('prj_a'), pg_temp.id('frank@org_a'), '2027-07-04', '2027-07-10') returning id) insert into world select 'ts', id from x;
select app.submit_timesheet(pg_temp.id('ts'));
select pg_temp.as_user('carol');
select app.decide_timesheet(pg_temp.id('ts'), 'Approved', 'Matches the call sheet.');
with x as (insert into app.pay_periods (org_id, starts_on, ends_on) values (pg_temp.id('org_a'), '2027-06-27', '2027-07-10') returning id) insert into world select 'pp', id from x;

create function pg_temp.lines(p_key text) returns table (code text, hours numeric) language sql as $$
  select e.code, l.hours from app.payroll_lines l join app.earning_codes e on e.id = l.earning_code_id
  where l.payroll_run_id = pg_temp.id(p_key) and l.deleted_at is null order by e.code $$;
create function pg_temp.new_run(p_key text) returns uuid language sql as $$
  with x as (insert into app.payroll_runs (pay_period_id, currency_code) values (pg_temp.id('pp'), 'USD') returning id)
  insert into world select p_key, id from x returning id $$;

select pg_temp.new_run('run_org');
select throws_ok($$select app.calculate_payroll_run(pg_temp.id('run_org'))$$,
  'XR001', null, 'a paid holiday in the period with no holiday earning code refuses to calculate');
select pg_temp.as_user('bob');
insert into app.earning_codes (org_id, code, name, is_holiday) values (pg_temp.id('org_a'), 'HOL', 'Holiday', true);
select pg_temp.as_user('carol');
select is(app.calculate_payroll_run(pg_temp.id('run_org')), 2, 'regular and holiday lines');
select results_eq($$select code, hours from pg_temp.lines('run_org')$$,
  $$values ('HOL'::text, 8.00::numeric), ('REG', 32.00)$$,
  'the org calendar pays Independence Day inside Frank''s timesheet, not Founders Day before it, and HOL never takes the regular hours');
select pg_temp.as_user('alice');
select is((select rate_minor from app.payroll_line_amounts a join app.earning_codes e on e.id = a.earning_code_id
  where a.payroll_run_id = pg_temp.id('run_org') and e.code = 'HOL'), 3200::bigint, 'holiday hours pay the rate of the role worked');

-- The subdivision's org calendar governs work there: venue_a in California takes the California calendar.
select pg_temp.as_platform();
update app.venues set subdivision_code = 'US-CA' where id = pg_temp.id('venue_a');
select pg_temp.as_user('carol');
select pg_temp.new_run('run_ca');
select app.calculate_payroll_run(pg_temp.id('run_ca'));
select results_eq($$select code, hours from pg_temp.lines('run_ca')$$,
  $$values ('HOL'::text, 8.00::numeric), ('REG', 32.00)$$,
  'in California the California calendar''s State Day is paid in place of the org calendar''s holiday');
select is((select count(*)::integer from app.payroll_lines l join app.earning_codes e on e.id = l.earning_code_id
  where l.payroll_run_id = pg_temp.id('run_ca') and l.deleted_at is null and e.code = 'HOL'), 1, 'one holiday line per person');

-- A venue's own calendar comes first, and a holiday paying 0 hours is observed unpaid.
select pg_temp.as_user('bob');
with x as (insert into app.holiday_calendars (org_id, name) values (pg_temp.id('org_a'), 'Pier Pavilion') returning id)
  insert into world select 'cal_pier', id from x;
insert into app.holiday_calendar_venues (holiday_calendar_id, venue_id) values (pg_temp.id('cal_pier'), pg_temp.id('venue_a'));
insert into app.holidays (holiday_calendar_id, observed_on, name, paid_hours) values
  (pg_temp.id('cal_pier'), '2027-07-07', 'Pier Day', 10), (pg_temp.id('cal_pier'), '2027-07-08', 'Quiet Day', 0);
select throws_ok($$insert into app.holiday_calendar_venues (holiday_calendar_id, venue_id) values (pg_temp.id('cal_us'), pg_temp.id('venue_a'))$$,
  '23505', null, 'a venue has one calendar');
select pg_temp.as_user('carol');
select pg_temp.new_run('run_venue');
select app.calculate_payroll_run(pg_temp.id('run_venue'));
select results_eq($$select code, hours from pg_temp.lines('run_venue')$$,
  $$values ('HOL'::text, 10.00::numeric), ('REG', 32.00)$$,
  'the venue''s calendar pays Pier Day''s 10 hours; its unpaid day and the org calendars pay nothing');
select pg_temp.as_user('frank');
select is(pg_temp.days(), 4, 'time off still counts on the org calendar, whatever the venues observe');

select * from finish();
rollback;
