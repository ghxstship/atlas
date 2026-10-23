-- pgTAP: migration 1542, ECB reference rates (A97, RRR-142, Section 15, ADR 0053). The worker's call writes one
-- publication date's rates into the reference table and into every live org's fx_rates as EUR to each currency,
-- with the ECB date as effective_on; a rerun for the same date writes nothing; an org's own rate for the same pair
-- and day is kept; unknown currencies are skipped and counted; every run, failed or not, is recorded and
-- summarized for finance pages; only the service role may write; pg_cron runs the feed on ECB business days, and
-- without the Vault secrets the run is recorded as failed instead of silently doing nothing.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(17);

create temporary table k (key text primary key, value jsonb);
grant select, insert on k to public;

-- An org's own rate for a pair and day the ECB also publishes: it must survive.
select pg_temp.as_platform();
insert into app.fx_rates (org_id, base_currency, quote_currency, rate, effective_on, source)
values (pg_temp.id('org_a'), 'EUR', 'GBP', 0.85, date '2026-10-20', 'Treasury');

-- Writing ------------------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
select throws_ok($$select app.record_fx_reference_rates('ECB', date '2026-10-20', '{"USD":1.0893}'::jsonb)$$,
  '42501', null, 'a signed-in person cannot write reference rates');
select throws_ok($$select app.record_fx_feed_failure('ECB', 'x')$$, '42501', null, 'nor record feed runs');

set local role service_role;
insert into k select 'first', app.record_fx_reference_rates('ECB', date '2026-10-20',
  '{"USD":1.0893,"GBP":0.83815,"JPY":162.41,"QQQ":1.5,"EUR":1}'::jsonb);
reset role;
select pg_temp.as_platform();
select is((select value ->> 'currencies' from k where key = 'first'), '3', 'three known currencies are written');
select is((select value ->> 'skipped' from k where key = 'first'), '2', 'the unknown currency and EUR itself are skipped and counted');
select is((select count(*)::int from private.fx_reference_rates where source = 'ECB' and rate_date = '2026-10-20'), 3,
  'the reference table keeps the day once for the platform');
select is(
  (select count(distinct org_id)::int from app.fx_rates where source = 'ECB' and effective_on = '2026-10-20'),
  (select count(*)::int from app.organizations where deleted_at is null),
  'every live org receives the day''s rates');
select results_eq(
  $$select base_currency::text, quote_currency::text, rate, effective_on from app.fx_rates
    where org_id = pg_temp.id('org_a') and source = 'ECB' order by quote_currency$$,
  $$values ('EUR'::text, 'JPY'::text, 162.41::numeric, date '2026-10-20'), ('EUR', 'USD', 1.0893, date '2026-10-20')$$,
  'rates read one euro to each currency, dated by the ECB publication date');
select results_eq(
  $$select rate, source from app.fx_rates where org_id = pg_temp.id('org_a') and quote_currency = 'GBP' and effective_on = '2026-10-20'$$,
  $$values (0.85::numeric, 'Treasury'::text)$$, 'an org''s own rate for the same pair and day is never overwritten');

set local role service_role;
insert into k select 'again', app.record_fx_reference_rates('ECB', date '2026-10-20',
  '{"USD":1.0893,"GBP":0.83815,"JPY":162.41}'::jsonb);
reset role;
select pg_temp.as_platform();
select is((select value ->> 'rows_written' from k where key = 'again'), '0', 'a rerun for the same date writes nothing');
select is((select count(*)::int from app.fx_rates where org_id = pg_temp.id('org_a') and source = 'ECB'), 2,
  'and adds no duplicate');
set local role service_role;
select throws_ok($$select app.record_fx_reference_rates('ECB', date '2026-10-21', '{"QQQ":1}'::jsonb)$$, '22023', null,
  'a file with no known currency is refused');
select throws_ok($$select app.record_fx_reference_rates('E C B', date '2026-10-21', '{"USD":1}'::jsonb)$$, '22023', null,
  'the source is a short code, as the API''s fx rate source is');
select app.record_fx_feed_failure('ECB', 'fetch: The ECB answered HTTP 503.');
reset role;

-- Status ------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
select results_eq(
  $$select last_rate_date, last_error, failures_since_success from app.fx_feed_status('ECB')$$,
  $$values (date '2026-10-20', 'fetch: The ECB answered HTTP 503.'::text, 1)$$,
  'finance pages see the last publication date written and the failure since');
select pg_temp.as_platform();
select is((select count(*)::int from private.fx_feed_runs where source = 'ECB'), 3, 'every run is recorded');

-- Schedule ----------------------------------------------------------------------------------------------------------
select results_eq($$select schedule::text from cron.job where jobname = 'xos_fx_rates_ecb'$$,
  $$values ('30 15,21 * * 1-5'::text)$$, 'pg_cron runs the feed after publication on ECB business days');
select private.request_fx_feed();
select ok((select error from private.fx_feed_runs where source = 'ECB' order by ran_at desc, id desc limit 1)
  like 'The ECB feed is not configured%', 'without the Vault secrets the run is recorded as failed, never silent');
select pg_temp.as_anon();
select throws_ok($$select * from app.fx_feed_status('ECB')$$, '42501', null, 'anonymous visitors cannot read the feed state');

select * from finish();
rollback;
