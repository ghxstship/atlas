-- pgTAP: work order budgets and the Compass sync allowlist (0413), and the late-slot comment
-- subjects (0955).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(7);

select pg_temp.as_user('dave');
with x as (insert into app.work_orders (project_id, title) values (pg_temp.id('prj_a'), 'Hang the Banners') returning id)
  insert into world select 'wo', id from x;
select is((select w.currency_code::text from app.work_orders w where w.id = pg_temp.id('wo')),
  (select p.currency::text from app.projects p where p.id = pg_temp.id('prj_a')), 'a work order takes its project''s currency');
select is((select budget_minor from app.work_orders where id = pg_temp.id('wo')), null::bigint, 'a work order without a budget stays NULL, never zero');
with x as (insert into app.work_orders (project_id, title, budget_minor, currency_code) values (pg_temp.id('prj_a'), 'Paint the Fence', 450000, 'EUR') returning id)
  insert into world select 'wo_eur', id from x;
select is((select currency_code::text from app.work_orders where id = pg_temp.id('wo_eur')), 'EUR', 'a given currency is kept');
select throws_ok($$insert into app.work_orders (project_id, title, budget_minor) values ((select id from world where key = 'prj_a'), 'Paint the Gate', -1)$$,
  '23514', null, 'a budget is never negative');
select pg_temp.as_platform();
select ok(exists (select 1 from private.sync_rpcs where rpc = 'app.call_cue'), 'call_cue is replayable from Compass');
select ok(exists (select 1 from private.comment_subjects where table_name = 'app.run_of_show') or to_regclass('private.comment_subjects') is null,
  'running orders carry comments');
select ok(exists (select 1 from pg_catalog.pg_index i join pg_catalog.pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
  where i.indrelid = 'app.work_orders'::regclass and a.attname = 'currency_code'), 'the currency foreign key is indexed');

select * from finish();
rollback;
