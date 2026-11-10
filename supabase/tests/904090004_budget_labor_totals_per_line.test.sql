-- pgTAP: migration 904090004, budget line labour totals one line at a time. The view no longer groups every readable
-- line, so the budget's reads grow with its lines, not with their square: on a 60-line budget the amounts, the
-- forecasts and the forecast totals each aggregate a few times per line, where the grouped view aggregated every line
-- again for each one (3,600 rows here; about 45,000 on journey 34's 200-line paste). A line with no postings reads
-- zero and a reader without finance.budget.read reads none, as before; 6555 and 6556 cover the posted amounts.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(6);

-- Rows the plan's aggregate nodes produced, over all their loops: linear in the lines when each line aggregates its own.
create function pg_temp.aggregated_rows(p_sql text) returns bigint
language plpgsql as $$
declare v jsonb;
begin
  execute 'explain (analyze, format json) ' || p_sql into v;
  return (select coalesce(sum((n ->> 'Actual Rows')::numeric * (n ->> 'Actual Loops')::numeric), 0)::bigint
          from jsonb_path_query(v, 'strict $.**') n
          where jsonb_typeof(n) = 'object' and n ->> 'Node Type' = 'Aggregate');
end $$;

select ok(pg_get_viewdef('app.budget_line_labor_totals'::regclass) !~* 'group by',
  'the view aggregates each line on its own, with no GROUP BY over every line');

select pg_temp.as_user('carol');
with x as (insert into app.budgets (project_id, name, currency_code) values (pg_temp.id('prj_a'), 'Per line', 'USD') returning id)
insert into world select 'bud', id from x;
insert into app.budget_lines (budget_id, line_number, description, urid, line_type, quantity, unit_price_minor, xyz, xyz_basis)
select pg_temp.id('bud'), g, 'Pasted line ' || g, '5000.51.02', 'Labor', 1, case when g % 10 = 0 then null else 12500 end, 'X', 'Declared'
from generate_series(1, 60) g;

select ok(pg_temp.aggregated_rows(format('select * from app.budget_line_amounts where budget_id = %L', pg_temp.id('bud'))) < 60 * 10,
  'the amounts of a 60-line budget aggregate a few rows per line, not every line for each');
select ok(pg_temp.aggregated_rows(format('select * from app.budget_line_forecasts where budget_id = %L', pg_temp.id('bud'))) < 60 * 30,
  'so do its forecasts');
select ok(pg_temp.aggregated_rows(format('select * from app.budget_forecast_totals where budget_id = %L', pg_temp.id('bud'))) < 60 * 30,
  'and its forecast totals');
select is((select count(*)::int from app.budget_line_labor_totals where budget_id = pg_temp.id('bud')
  and labor_actual_minor = 0 and labor_unpriced_minutes = 0 and labor_other_currency_count = 0), 60,
  'a line with no postings reads zero, never NULL');
select pg_temp.as_user('frank');
select is((select count(*)::int from app.budget_line_labor_totals where budget_id = pg_temp.id('bud')), 0,
  'a reader without finance.budget.read reads none');
select pg_temp.as_platform();

select * from finish();
rollback;
