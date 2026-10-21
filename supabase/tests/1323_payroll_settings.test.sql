-- pgTAP: migration 1323, the Payroll settings shape new pay periods (A76, RRR-121, A65-001). payroll.pay_period sets
-- how long a period lasts (weekly, biweekly, semimonthly, monthly); payroll.week_start aligns the first weekly or
-- biweekly period; the next period follows the latest one. app.create_next_pay_period adds it for holders of
-- crew.pay_period.manage only; next_pay_period_dates answers only for members.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(13);

-- 2027-06-09 is a Wednesday.
select pg_temp.as_user('alice');
select results_eq($$select starts_on, ends_on from app.next_pay_period_dates((select id from world where key = 'org_a'), '2027-06-09')$$,
  $$values ('2027-06-06'::date, '2027-06-19'::date)$$, 'by default a first period is biweekly and starts on the Sunday on or before today');

select app.set_setting(pg_temp.id('org_a'), 'payroll.week_start', 'Organization', pg_temp.id('org_a'), p_value_text => 'monday');
select results_eq($$select starts_on, ends_on from app.next_pay_period_dates((select id from world where key = 'org_a'), '2027-06-09')$$,
  $$values ('2027-06-07'::date, '2027-06-20'::date)$$, 'a Monday week start moves it to the Monday');

select app.set_setting(pg_temp.id('org_a'), 'payroll.pay_period', 'Organization', pg_temp.id('org_a'), p_value_text => 'weekly');
select results_eq($$select starts_on, ends_on from app.next_pay_period_dates((select id from world where key = 'org_a'), '2027-06-09')$$,
  $$values ('2027-06-07'::date, '2027-06-13'::date)$$, 'a weekly period lasts seven days');

select app.set_setting(pg_temp.id('org_a'), 'payroll.pay_period', 'Organization', pg_temp.id('org_a'), p_value_text => 'semimonthly');
select results_eq($$select starts_on, ends_on from app.next_pay_period_dates((select id from world where key = 'org_a'), '2027-06-09')$$,
  $$values ('2027-06-01'::date, '2027-06-15'::date)$$, 'a semimonthly period runs from the 1st to the 15th');
select results_eq($$select starts_on, ends_on from app.next_pay_period_dates((select id from world where key = 'org_a'), '2027-06-20')$$,
  $$values ('2027-06-16'::date, '2027-06-30'::date)$$, 'or from the 16th to the month''s last day');

select app.set_setting(pg_temp.id('org_a'), 'payroll.pay_period', 'Organization', pg_temp.id('org_a'), p_value_text => 'monthly');
select results_eq($$select starts_on, ends_on from app.next_pay_period_dates((select id from world where key = 'org_a'), '2027-02-10')$$,
  $$values ('2027-02-01'::date, '2027-02-28'::date)$$, 'a monthly period covers the calendar month');

-- The next period follows the latest one.
select app.set_setting(pg_temp.id('org_a'), 'payroll.pay_period', 'Organization', pg_temp.id('org_a'), p_value_text => 'semimonthly');
insert into app.pay_periods (org_id, starts_on, ends_on) values (pg_temp.id('org_a'), '2027-06-01', '2027-06-15');
select results_eq($$select starts_on, ends_on from app.next_pay_period_dates((select id from world where key = 'org_a'), '2027-06-09')$$,
  $$values ('2027-06-16'::date, '2027-06-30'::date)$$, 'the next period starts the day after the latest one');
select lives_ok($$select app.create_next_pay_period((select id from world where key = 'org_a'))$$, 'the Owner adds the next period');
select results_eq($$select starts_on, ends_on from app.pay_periods where org_id = (select id from world where key = 'org_a') order by starts_on desc limit 1$$,
  $$values ('2027-06-16'::date, '2027-06-30'::date)$$, 'on the proposed dates');
select results_eq($$select starts_on, ends_on from app.next_pay_period_dates((select id from world where key = 'org_a'))$$,
  $$values ('2027-07-01'::date, '2027-07-15'::date)$$, 'and the one after follows it');

-- Access
select pg_temp.as_user('frank');
select throws_ok($$select app.create_next_pay_period((select id from world where key = 'org_a'))$$, '42501', null,
  'a Field member cannot add pay periods');
select pg_temp.as_user('xavier');
select throws_ok($$select * from app.next_pay_period_dates((select id from world where key = 'org_a'))$$, '42501', null,
  'another org cannot read the proposal');
select pg_temp.as_anon();
select throws_ok($$select * from app.next_pay_period_dates((select id from world where key = 'org_a'))$$, '42501', null, 'anon cannot call it');

select * from finish();
rollback;
