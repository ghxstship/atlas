-- pgTAP: 6550, client pricing on budget lines (B13, RRR-237, gap G-188 phase 1, ADR 0152). The client unit price is the
-- override, else the cost price marked up by the line's markup, else by the budget's default, rounded half away from
-- zero; a line with no cost price or no markup has no client price, and margins and totals stay NULL-aware (S3.7-02).
-- Range checks, RLS and the backup login's revoke.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select * from no_plan();

-- World ------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('carol');
with x as (insert into app.budgets (project_id, name, currency_code) values (pg_temp.id('prj_a'), 'Pricing Budget', 'USD') returning id)
  insert into world select 'bud', id from x;
create function pg_temp.line(p_key text, p_number integer, p_quantity numeric, p_price bigint, p_markup integer, p_override bigint)
returns void language plpgsql as $$
declare v uuid;
begin
  insert into app.budget_lines (budget_id, line_number, description, urid, quantity, unit_price_minor, markup_bp,
    client_unit_price_minor, xyz, xyz_basis)
  values (pg_temp.id('bud'), p_number, 'Line ' || p_number || '.', '5000.01.01', p_quantity, p_price, p_markup, p_override, 'X', 'Declared')
  returning id into v;
  insert into world values (p_key, v);
end $$;
select pg_temp.line('marked', 1, 3, 10000, 2500, null);
select pg_temp.line('default', 2, 1, 10000, null, null);
select pg_temp.line('override', 3, 2, 10000, 2500, 9900);
select pg_temp.line('unpriced', 4, 1, null, 2500, null);
select pg_temp.line('half', 5, 1, 1, 5000, null);

-- Markup math and sources ------------------------------------------------------------------------------------------------
select is((select client_unit_price_minor from app.budget_line_prices where budget_line_id = pg_temp.id('marked')), 12500::bigint,
  'a unit price of 100.00 marked up 25 percent is 125.00');
select is((select client_extended_minor from app.budget_line_prices where budget_line_id = pg_temp.id('marked')), 37500::bigint,
  'the client amount is quantity times the client unit price');
select is((select margin_minor from app.budget_line_prices where budget_line_id = pg_temp.id('marked')), 7500::bigint,
  'the margin is the client amount less the cost amount');
select is((select markup_source || '/' || client_price_source from app.budget_line_prices where budget_line_id = pg_temp.id('marked')),
  'Line/Markup', 'the line''s own markup is its source');
select is((select client_unit_price_minor from app.budget_line_prices where budget_line_id = pg_temp.id('default')), null::bigint,
  'with no markup at either level there is no client price, never the cost price or zero');
select is((select markup_source from app.budget_line_prices where budget_line_id = pg_temp.id('default')), null::text,
  'and no markup source');
update app.budgets set default_markup_bp = 1000 where id = pg_temp.id('bud');
select is((select client_unit_price_minor || '/' || markup_source from app.budget_line_prices where budget_line_id = pg_temp.id('default')),
  '11000/Budget', 'the budget default applies to a line without its own markup');
select is((select client_unit_price_minor || '/' || client_price_source from app.budget_line_prices where budget_line_id = pg_temp.id('override')),
  '9900/Override', 'an override wins over any markup');
select is((select client_unit_price_minor from app.budget_line_prices where budget_line_id = pg_temp.id('unpriced')), null::bigint,
  'an unpriced cost gives no client price');
select is((select margin_minor from app.budget_line_prices where budget_line_id = pg_temp.id('unpriced')), null::bigint,
  'and no margin');
select is((select client_unit_price_minor from app.budget_line_prices where budget_line_id = pg_temp.id('half')), 2::bigint,
  '1 minor unit marked up 50 percent is 1.5, rounded half away from zero to 2');
select pg_temp.as_platform();
select is(private.client_unit_price_minor(3, 5000), 5::bigint, '4.5 rounds to 5');
select is(private.client_unit_price_minor(1, 2500), 1::bigint, '1.25 rounds to 1');
select is(private.client_unit_price_minor(null, 2500), null::bigint, 'NULL in, NULL out');
select pg_temp.as_user('carol');

-- Totals -----------------------------------------------------------------------------------------------------------------
select is((select client_total_minor from app.budget_price_totals where budget_id = pg_temp.id('bud')), null::bigint,
  'the client total is NULL while an included line is unpriced');
select is((select client_unpriced_count from app.budget_price_totals where budget_id = pg_temp.id('bud')), 1,
  'with the unpriced count beside it');
select is((select margin_minor from app.budget_price_totals where budget_id = pg_temp.id('bud')), null::bigint,
  'and the margin NULL');
update app.budget_lines set excluded_from_quote = true where id = pg_temp.id('unpriced');
select is((select client_total_minor from app.budget_price_totals where budget_id = pg_temp.id('bud')), (37500 + 11000 + 19800 + 2)::bigint,
  'excluding the unpriced internal line makes the client total known');
select is((select included_line_count from app.budget_price_totals where budget_id = pg_temp.id('bud')), 4,
  'excluded lines are not counted');
select is((select margin_minor from app.budget_price_totals where budget_id = pg_temp.id('bud')),
  ((37500 + 11000 + 19800 + 2) - (30000 + 10000 + 20000 + 1))::bigint, 'the margin covers the included lines only');

-- Range checks -----------------------------------------------------------------------------------------------------------
select throws_ok(format($$update app.budget_lines set markup_bp = -1 where id = '%s'$$, pg_temp.id('marked')), '23514', null,
  'a negative markup is refused (budget_lines_markup_range)');
select throws_ok(format($$update app.budget_lines set markup_bp = 100001 where id = '%s'$$, pg_temp.id('marked')), '23514', null,
  'a markup above 1000 percent is refused');
select throws_ok(format($$update app.budget_lines set client_unit_price_minor = -5 where id = '%s'$$, pg_temp.id('marked')), '23514', null,
  'a negative client price is refused (budget_lines_client_price_nonnegative)');
select throws_ok(format($$update app.budgets set default_markup_bp = 100001 where id = '%s'$$, pg_temp.id('bud')), '23514', null,
  'a default markup out of range is refused (budgets_default_markup_range)');

-- RLS and privileges ------------------------------------------------------------------------------------------------------
select pg_temp.as_user('frank');
select is_empty($$select 1 from app.budget_line_prices$$, 'no rows without finance.budget.read');
select is_empty($$select 1 from app.budget_price_totals$$, 'and no totals');
select pg_temp.as_user('xavier');
select is_empty($$select 1 from app.budget_line_prices$$, 'cross tenant: none');
select pg_temp.as_platform();
select ok((select reloptions @> array['security_invoker=true'] from pg_class where oid = 'app.budget_line_prices'::regclass),
  'the prices view is security invoker');
select ok(not has_table_privilege('anon', 'app.budget_line_prices', 'select'), 'anonymous callers may not select it');
select ok(not exists (select 1 from pg_roles where rolname = 'xos_backup')
  or (not has_table_privilege('xos_backup', 'app.budget_line_prices', 'select')
      and not has_table_privilege('xos_backup', 'app.budget_price_totals', 'select')),
  'the backup login has no SELECT on either view (1650)');

-- The table packages/data/test/b13-quotes-budget.test.ts checks clientUnitPrice against, so TypeScript and SQL agree.
select pg_temp.as_platform();
select results_eq($$select private.client_unit_price_minor(u, b) from (values
    (10000::bigint, 2500), (10000, 0), (333, 1000), (5, 5000), (1, 2500), (3, 5000), (null, 2500), (10000, null)) as c(u, b)$$,
  $$values (12500::bigint), (10000), (366), (8), (1), (5), (null), (null)$$,
  'client prices round half away from zero, and NULL stays NULL');

select * from finish();
rollback;
