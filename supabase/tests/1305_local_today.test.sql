-- pgTAP: 1305 (A71, RRR-116). "Today" on the project's and the org's calendar: private.zone_date, zone_today,
-- project_today, org_time_zone and org_today; invoices issued, posted and reversed on those calendars, never on
-- the database's UTC date. Postgres's clock cannot be set inside a test, so the suite moves the place instead:
-- prj_a and org_a take a zone whose date differs from UTC's right now (UTC+14 from noon UTC, UTC-12 before it),
-- which is what 23:30 in New York is to UTC, at any time of day.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(23);

create temporary table clock as
  select s.zone, (now() at time zone s.zone)::date as local_on, (now() at time zone 'UTC')::date as utc_on
  from (select case when extract(hour from now() at time zone 'UTC') >= 12 then 'Pacific/Kiritimati' else 'Etc/GMT+12' end as zone) s;
grant select on clock to public;
create function pg_temp.zone() returns text language sql stable as $$ select zone from clock $$;
create function pg_temp.local_on() returns date language sql stable as $$ select local_on from clock $$;
create function pg_temp.utc_on() returns date language sql stable as $$ select utc_on from clock $$;

select isnt(pg_temp.local_on(), pg_temp.utc_on(), 'the suite''s zone is on another date than UTC right now');

-- Zones --------------------------------------------------------------------------------------------------------
select is(private.zone_date('2026-11-01 03:30+00', 'America/New_York'), '2026-10-31'::date,
  '23:30 on the last evening of October in New York is still October there');
select is(private.zone_date('2026-11-01 03:30+00', 'UTC'), '2026-11-01'::date, 'while UTC is already in November');
select is(private.zone_today('America/New_York'), (now() at time zone 'America/New_York')::date, 'zone_today is the date in the zone');
select is(private.zone_today(pg_temp.zone()), pg_temp.local_on(), 'also in a zone a day away from UTC');
select is(private.zone_today(null), pg_temp.utc_on(), 'no zone is UTC');
select is(private.zone_today('Nowhere/Zone'), pg_temp.utc_on(), 'an unknown zone is UTC, never an error');

-- Project and org calendars --------------------------------------------------------------------------------------
update app.projects set time_zone = pg_temp.zone() where id = pg_temp.id('prj_a');
select is(private.project_today(pg_temp.id('prj_a')), pg_temp.local_on(), 'project_today follows the project''s time zone');
select is(private.project_today(pg_temp.id('prj_a2')), (now() at time zone 'America/New_York')::date, 'each project keeps its own zone');
select is(private.org_time_zone(pg_temp.id('org_a')), 'UTC', 'an org that never set locale.time_zone is on UTC');
select is(private.org_today(pg_temp.id('org_a')), pg_temp.utc_on(), 'so its today is UTC''s');
select pg_temp.as_user('alice');
select app.set_setting(pg_temp.id('org_a'), 'locale.time_zone', 'Organization', pg_temp.id('org_a'), pg_temp.zone(), null, null, true);
select pg_temp.as_platform();
select is(private.org_time_zone(pg_temp.id('org_a')), pg_temp.zone(), 'the org''s locale.time_zone setting is its zone');
select is(private.org_today(pg_temp.id('org_a')), pg_temp.local_on(), 'and its today is that zone''s');
select is(private.org_today(pg_temp.id('org_b')), pg_temp.utc_on(), 'another org keeps its own calendar');

-- Invoices ------------------------------------------------------------------------------------------------------
-- Only the project's month has an open period, so a posting dated on the UTC calendar in another month would be refused.
select pg_temp.as_user('carol');
with x as (insert into app.accounting_periods (org_id, starts_on, ends_on)
  values (pg_temp.id('org_a'), date_trunc('month', pg_temp.local_on())::date, (date_trunc('month', pg_temp.local_on()) + interval '1 month - 1 day')::date)
  returning id) insert into world select 'period', id from x;
insert into world values ('cp_client', app.create_counterparty(pg_temp.id('org_a'), 'Lakeshore Brands', null));
insert into world values ('cp_vendor', app.create_counterparty(pg_temp.id('org_a'), 'Pier Rigging Co', 'Rigging Engineering'));
select pg_temp.as_user('bob');
insert into app.spend_authorities (org_id, role_id, document_type, currency_code, limit_minor) values
  (pg_temp.id('org_a'), pg_temp.system_role('owner'), 'Invoice Approval', 'USD', 10000000);

select pg_temp.as_user('carol');
with x as (insert into app.invoices (project_id, direction, counterparty_id, invoice_number, currency_code)
  values (pg_temp.id('prj_a'), 'Receivable', pg_temp.id('cp_client'), 'NWL-1305-R', 'USD') returning id) insert into world select 'inv_r', id from x;
insert into app.invoice_lines (invoice_id, line_number, description, quantity, unit_price_minor, urid)
  values (pg_temp.id('inv_r'), 1, 'Production fee.', 1, 50000, '0000.01.01');
select lives_ok($$select app.issue_invoice((select id from world where key = 'inv_r'), 'Sent to the client.')$$,
  'an undated receivable is issued and posts in the project''s month');
select pg_temp.as_platform();
select is((select issued_on from app.invoices where id = pg_temp.id('inv_r')), pg_temp.local_on(), 'issuing dates it today on the project''s calendar');
select is((select entry_date from app.journal_entries where source_id = pg_temp.id('inv_r')), pg_temp.local_on(), 'and its posting has that date');

select pg_temp.as_user('carol');
with x as (insert into app.invoices (project_id, direction, counterparty_id, invoice_number, currency_code)
  values (pg_temp.id('prj_a'), 'Payable', pg_temp.id('cp_vendor'), 'PRC-1305', 'USD') returning id) insert into world select 'inv_p', id from x;
insert into app.invoice_lines (invoice_id, line_number, description, quantity, unit_price_minor, urid)
  values (pg_temp.id('inv_p'), 1, 'Rigging labor.', 1, 40000, '5000.01.01');
select pg_temp.as_user('alice');
select is(app.approve_invoice(pg_temp.id('inv_p'), 'Work received.'), true, 'an undated payable is approved');
select pg_temp.as_platform();
select is((select entry_date from app.journal_entries where source_id = pg_temp.id('inv_p')), pg_temp.local_on(),
  'and posts today on the project''s calendar');

select is(private.reversal_date(pg_temp.id('org_a'), 'invoices', pg_temp.id('inv_r')), pg_temp.local_on(),
  'a reversal inside the open period keeps the original date');
select pg_temp.as_user('carol');
select app.transition_accounting_period(pg_temp.id('period'), 'Open', 'In Period', 'Month in progress.');
select app.transition_accounting_period(pg_temp.id('period'), 'In Period', 'Closing', 'Month end.');
select app.transition_accounting_period(pg_temp.id('period'), 'Closing', 'Closed', 'Closed.');
select pg_temp.as_platform();
select is((select period_state::text from app.accounting_periods where id = pg_temp.id('period')), 'Closed', 'the period closes');
select is(private.reversal_date(pg_temp.id('org_a'), 'invoices', pg_temp.id('inv_r')), private.org_today(pg_temp.id('org_a')),
  'once it is closed, a reversal is dated today on the org''s calendar');
select isnt(private.reversal_date(pg_temp.id('org_a'), 'invoices', pg_temp.id('inv_r')), pg_temp.utc_on(), 'not on UTC''s');

select * from finish();
rollback;
