-- pgTAP: 1398 (RRR-116). Pay periods follow the org's calendar: app.next_pay_period_dates takes today on the org's
-- calendar when no date is given, and app.create_next_pay_period adds the first period on that date, never on the
-- database's UTC date. Postgres's clock cannot be set inside a test, so the suite moves the place instead, as 1305
-- does: org_a takes a zone whose date differs from UTC's right now (UTC+14 from noon UTC, UTC-12 before it).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(6);

create temporary table clock as
  select s.zone, (now() at time zone s.zone)::date as local_on, (now() at time zone 'UTC')::date as utc_on
  from (select case when extract(hour from now() at time zone 'UTC') >= 12 then 'Pacific/Kiritimati' else 'Etc/GMT+12' end as zone) s;
grant select on clock to public;
create function pg_temp.zone() returns text language sql stable as $$ select zone from clock $$;
create function pg_temp.local_on() returns date language sql stable as $$ select local_on from clock $$;

-- Pay periods on the org's calendar ---------------------------------------------------------------------------------
select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'locale.time_zone', 'Organization', pg_temp.id('org_a'), pg_temp.zone(), null, null, true);
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

select * from finish();
rollback;
