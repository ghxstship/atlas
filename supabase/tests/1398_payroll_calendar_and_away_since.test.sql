-- pgTAP: 1398 (RRR-116). Pay periods follow the org's calendar: app.next_pay_period_dates takes today on the org's
-- calendar when no date is given, and app.create_next_pay_period adds the first period on that date, never on the
-- database's UTC date. Postgres's clock cannot be set inside a test, so the suite moves the place instead, as 1305
-- does: org_a takes a zone whose date differs from UTC's right now (UTC+14 from noon UTC, UTC-12 before it).
-- Weekly overtime counts over the org's payroll.week_start, the week pay periods and timesheets start on. Out of office
-- starts at midnight in the person's time zone (locale.time_zone), the day private.person_away counts in.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(12);

create temporary table clock as
  select s.zone, (now() at time zone s.zone)::date as local_on, (now() at time zone 'UTC')::date as utc_on
  from (select case when extract(hour from now() at time zone 'UTC') >= 12 then 'Pacific/Kiritimati' else 'Etc/GMT+12' end as zone) s;
grant select on clock to public;
create function pg_temp.zone() returns text language sql stable as $$ select zone from clock $$;
create function pg_temp.local_on() returns date language sql stable as $$ select local_on from clock $$;

-- Pay periods on the org's calendar ---------------------------------------------------------------------------------
select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'locale.time_zone', 'Organization', pg_temp.id('org_a'), p_value_text => pg_temp.zone());
select app.set_setting(pg_temp.id('org_a'), 'payroll.week_start', 'Organization', pg_temp.id('org_a'), p_value_text => 'monday');
select app.set_setting(pg_temp.id('org_a'), 'payroll.pay_period', 'Organization', pg_temp.id('org_a'), p_value_text => 'weekly');
select pg_temp.as_platform();
select is(private.org_today(pg_temp.id('org_a')), pg_temp.local_on(), 'the org''s today is its zone''s date, not UTC''s');
select pg_temp.as_user('alice');

select results_eq(
  $$select starts_on, ends_on from app.next_pay_period_dates((select id from world where key = 'org_a'), null)$$,
  $$select starts_on, ends_on from app.next_pay_period_dates((select id from world where key = 'org_a'), (select local_on from clock))$$,
  'with no date given, the first period is proposed for today on the org''s calendar');
select results_eq(
  $$select starts_on, ends_on from app.next_pay_period_dates((select id from world where key = 'org_a'))$$,
  $$select starts_on, ends_on from app.next_pay_period_dates((select id from world where key = 'org_a'), (select local_on from clock))$$,
  'also when the date is left out');
select ok((select starts_on is not null from app.next_pay_period_dates(pg_temp.id('org_a'))), 'and the proposal has dates');

select lives_ok($$select app.create_next_pay_period((select id from world where key = 'org_a'))$$, 'the Owner adds the first period');
select results_eq(
  $$select starts_on, ends_on from app.pay_periods where org_id = (select id from world where key = 'org_a') and deleted_at is null$$,
  $$select (select local_on from clock) - ((extract(dow from (select local_on from clock))::integer + 6) % 7), (select local_on from clock) - ((extract(dow from (select local_on from clock))::integer + 6) % 7) + 6$$,
  'on the org''s week that holds the org''s today');

-- Weekly overtime on the org's payroll week --------------------------------------------------------------------------
-- Frank works 10 hours on Sunday 2027-06-13 and 38 from Monday to Thursday in New York, under the federal 40-hour rule
-- of prj_a's jurisdiction. On Sunday weeks (the default) that is one 48-hour week; on Monday weeks Sunday belongs to
-- the week before and no week passes 40 hours.
select app.set_setting(pg_temp.id('org_a'), 'payroll.week_start', 'Organization', pg_temp.id('org_a'), p_value_text => 'sunday');
select pg_temp.as_user('bob');
insert into app.pay_rates (membership_id, role_code, rate_minor, currency_code, effective_from)
values (pg_temp.id('frank@org_a'), '0000.50.01', 3200, 'USD', '2027-01-01');
insert into app.earning_codes (org_id, code, name) values (pg_temp.id('org_a'), 'REG', 'Regular');
insert into app.earning_codes (org_id, code, name, is_overtime) values (pg_temp.id('org_a'), 'OT', 'Overtime', true);
select pg_temp.as_user('frank');
insert into app.time_entries (project_id, membership_id, clock_in, clock_out)
select pg_temp.id('prj_a'), pg_temp.id('frank@org_a'), (d::date + time '08:00') at time zone 'America/New_York',
  (d::date + case when d::date = date '2027-06-17' then time '16:00' else time '18:00' end) at time zone 'America/New_York'
from generate_series(date '2027-06-13', date '2027-06-17', interval '1 day') d;
with x as (insert into app.timesheets (project_id, membership_id, period_start, period_end)
  values (pg_temp.id('prj_a'), pg_temp.id('frank@org_a'), '2027-06-13', '2027-06-19') returning id) insert into world select 'ts', id from x;
select app.submit_timesheet(pg_temp.id('ts'));
select pg_temp.as_user('carol');
select app.decide_timesheet(pg_temp.id('ts'), 'Approved', 'Matches the call sheet.');
with x as (insert into app.pay_periods (org_id, starts_on, ends_on) values (pg_temp.id('org_a'), '2027-06-13', '2027-06-26') returning id) insert into world select 'pp', id from x;
with x as (insert into app.payroll_runs (pay_period_id, currency_code) values (pg_temp.id('pp'), 'USD') returning id) insert into world select 'run_sunday', id from x;
select app.calculate_payroll_run(pg_temp.id('run_sunday'));
select results_eq(
  $$select e.code, l.hours from app.payroll_lines l join app.earning_codes e on e.id = l.earning_code_id
    where l.payroll_run_id = (select id from world where key = 'run_sunday') and l.deleted_at is null order by e.code$$,
  $$values ('OT'::text, 8.00::numeric), ('REG', 40.00)$$,
  'on the org''s Sunday weeks, Sunday and Monday to Thursday are one week: 8 overtime hours');

select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'payroll.week_start', 'Organization', pg_temp.id('org_a'), p_value_text => 'monday');
select pg_temp.as_user('carol');
with x as (insert into app.payroll_runs (pay_period_id, currency_code) values (pg_temp.id('pp'), 'USD') returning id) insert into world select 'run_monday', id from x;
select app.calculate_payroll_run(pg_temp.id('run_monday'));
select results_eq(
  $$select e.code, l.hours from app.payroll_lines l join app.earning_codes e on e.id = l.earning_code_id
    where l.payroll_run_id = (select id from world where key = 'run_monday') and l.deleted_at is null order by e.code$$,
  $$values ('REG'::text, 48.00::numeric)$$,
  'on Monday weeks Sunday counts in the week before: no week passes 40 hours');

-- Out of office from midnight in the person's time zone ---------------------------------------------------------------
-- app.send_chat_message sends one automatic reply per conversation since away_since, so away_since must be the instant
-- private.person_away turns true: midnight of the start date where the person is, not midnight UTC. org_a did not lock
-- its zone, so bob's own locale.time_zone applies.
select pg_temp.as_user('bob');
select app.set_personal_setting('me.out_of_office.enabled', null, p_value_boolean => true);
select app.set_personal_setting('me.out_of_office.starts_on', null, p_value_text => '2026-11-02');
select app.set_personal_setting('locale.time_zone', null, p_value_text => 'Asia/Tokyo');
select pg_temp.as_platform();
select is(private.away_since(pg_temp.id('bob'), pg_temp.id('org_a')), '2026-11-01 15:00+00'::timestamptz,
  'in Tokyo the time away starts at midnight Tokyo time on the start date');
select is(private.person_away(pg_temp.id('bob'), pg_temp.id('org_a'), private.away_since(pg_temp.id('bob'), pg_temp.id('org_a'))), true,
  'the person is away from that instant');
select is(private.person_away(pg_temp.id('bob'), pg_temp.id('org_a'), private.away_since(pg_temp.id('bob'), pg_temp.id('org_a')) - interval '1 second'), false,
  'and not a second before');
select pg_temp.as_user('bob');
select app.set_personal_setting('locale.time_zone', null, p_value_text => 'America/New_York');
select pg_temp.as_platform();
select is(private.away_since(pg_temp.id('bob'), pg_temp.id('org_a')), '2026-11-02 05:00+00'::timestamptz,
  'in New York it starts at midnight New York time');

select * from finish();
rollback;
