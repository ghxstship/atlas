-- pgTAP: 6556, a line's Actual is approved and paid expenses plus approved labor (B13, RRR-237, gap G-133). actual_minor
-- stays numeric, the appended columns exist, and app.budget_totals, app.budget_revised_totals and app.budget_line_facts
-- follow.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select no_plan();

select pg_temp.as_user('carol');
with x as (insert into app.budgets (project_id, name, currency_code) values (pg_temp.id('prj_a'), 'Actuals', 'USD') returning id) insert into world select 'bud', id from x;
with x as (insert into app.budget_lines (budget_id, line_number, description, urid, line_type, quantity, unit_price_minor, xyz, xyz_basis)
  values (pg_temp.id('bud'), 1, 'Stagehands.', '5000.51.02', 'Labor', 100, 2000, 'X', 'Declared') returning id) insert into world select 'labor', id from x;
with x as (insert into app.shifts (project_id, membership_id, role_code, starts_at, ends_at, time_zone, budget_line_id)
  values (pg_temp.id('prj_a'), pg_temp.id('frank@org_a'), '5000.51.02', '2027-06-14 12:00+00', '2027-06-14 20:00+00', 'America/New_York', pg_temp.id('labor')) returning id)
  insert into world select 'sh', id from x;

select is((select data_type from information_schema.columns where table_schema = 'app' and table_name = 'budget_line_amounts' and column_name = 'actual_minor'),
  'numeric', 'actual_minor stays numeric');
select is((select array_agg(column_name::text order by ordinal_position) from (select column_name, ordinal_position from information_schema.columns
           where table_schema = 'app' and table_name = 'budget_line_amounts' and ordinal_position > 9) c),
  array['actual_minor', 'expense_actual_minor', 'labor_actual_minor', 'labor_unpriced_minutes', 'labor_other_currency_count'], 'the labor columns are appended after it');

select pg_temp.as_platform();
insert into app.pay_rates (membership_id, role_code, rate_minor, currency_code, effective_from) values (pg_temp.id('frank@org_a'), '5000.51.02', 2500, 'USD', '2027-01-01');
insert into app.time_entries (project_id, membership_id, shift_id, clock_in, clock_out)
  values (pg_temp.id('prj_a'), pg_temp.id('frank@org_a'), pg_temp.id('sh'), '2027-06-14 12:00+00', '2027-06-14 20:00+00');
select pg_temp.as_user('frank');
with x as (insert into app.timesheets (project_id, membership_id, period_start, period_end)
  values (pg_temp.id('prj_a'), pg_temp.id('frank@org_a'), '2027-06-13', '2027-06-19') returning id) insert into world select 'ts', id from x;
select app.submit_timesheet(pg_temp.id('ts'));
select pg_temp.as_user('carol');
select app.decide_timesheet(pg_temp.id('ts'), 'Approved', 'Checked.');

select pg_temp.as_platform();
alter table app.expenses disable trigger user;
insert into app.expenses (org_id, budget_line_id, amount_minor, currency_code, description, incurred_on, expense_state)
  values (pg_temp.id('org_a'), pg_temp.id('labor'), 7000, 'USD', 'Per diem.', '2027-06-14', 'Approved');
alter table app.expenses enable trigger user;
select pg_temp.as_user('carol');
select is((select labor_actual_minor::bigint from app.budget_line_amounts where budget_line_id = pg_temp.id('labor')), 20000::bigint, 'labor is 8 hours at 25.00');
select is((select actual_minor::bigint from app.budget_line_amounts where budget_line_id = pg_temp.id('labor')), 27000::bigint, 'actual = expenses + labor');
select is((select actual_minor::bigint from app.budget_totals where budget_id = pg_temp.id('bud')), 27000::bigint, 'app.budget_totals follows');
select is((select actual_minor::bigint from app.budget_revised_totals where budget_id = pg_temp.id('bud')), 27000::bigint, 'app.budget_revised_totals follows');
select is((select actual_minor::bigint from app.budget_line_facts where budget_line_id = pg_temp.id('labor')), 27000::bigint, 'app.budget_line_facts follows');
select is((select labor_unpriced_minutes from app.budget_line_amounts where budget_line_id = pg_temp.id('labor')), 0, 'nothing unpriced');

-- The filter reaches the grouped view: a read of one line never aggregates every line the reader can see.
select pg_temp.as_platform();
create function pg_temp.plan_of(p_sql text) returns text language plpgsql as $$
declare v_line text; v_out text := '';
begin
  for v_line in execute 'explain ' || p_sql loop v_out := v_out || v_line || E'\n'; end loop;
  return v_out;
end $$;
select ok(pg_temp.plan_of(format($$select * from app.budget_line_amounts where budget_line_id = '%s'$$, pg_temp.id('labor'))) !~ 'Seq Scan on budget_lines bl_[0-9]+[^\n]*\n\s+Filter: \(deleted_at IS NULL\)',
  'the labor totals are not aggregated for the whole org on each read');

select * from finish();
rollback;
