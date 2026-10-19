-- pgTAP: the generated plan seed 1251 leaves the plan registry of packages/schemas/plans.yaml in the
-- database (pricing v4, ADR 0034): seat allowances, unlimited projects and field crew on paid plans,
-- local-currency list prices, extra-seat prices, the Aurora pack and the partner wholesale default.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;

select plan(14);

select results_eq(
  $$select plan_code, limit_value from private.plan_limits where limit_code = 'seats' order by plan_code$$,
  $$values ('access', 1::bigint), ('core', 5::bigint), ('enterprise', null::bigint), ('pro', 15::bigint), ('team', 40::bigint)$$,
  'seat allowances are 1, 5, 15 and 40, and unlimited on Enterprise');
select is((select count(*)::integer from private.plan_limits
  where plan_code <> 'access' and limit_code in ('active_projects', 'field_members') and limit_value is not null), 0,
  'paid plans have unlimited projects and field crew');
select results_eq(
  $$select l.limit_code::text, l.limit_value from private.plan_limits l where l.plan_code = 'access' order by l.limit_code$$,
  $$values ('seats', 1::bigint), ('active_projects', 1::bigint), ('field_members', 10::bigint),
    ('active_external_engagements_per_month', 25::bigint), ('aurora_requests_per_month', 0::bigint)$$,
  'Access keeps 1 seat, 1 project and 10 field members');
select results_eq(
  $$select plan_code, limit_value from private.plan_limits where limit_code = 'aurora_requests_per_month' order by plan_code$$,
  $$values ('access', 0::bigint), ('core', 500::bigint), ('enterprise', null::bigint), ('pro', 2000::bigint), ('team', 10000::bigint)$$,
  'Aurora allowances are unchanged');
select results_eq(
  $$select plan_code, monthly_minor from private.plan_list_prices where currency_code = 'USD' order by plan_code$$,
  $$values ('access', 0::bigint), ('core', 14900::bigint), ('enterprise', null::bigint), ('pro', 39900::bigint), ('team', 89900::bigint)$$,
  'USD list prices are 149, 399 and 899 a month; Enterprise is quoted, so unpriced');
select results_eq(
  $$select currency_code::text, monthly_minor from private.plan_list_prices where plan_code = 'core' and currency_code <> 'USD' order by currency_code$$,
  $$values ('AUD', 22900::bigint), ('CAD', 19900::bigint), ('EUR', 13900::bigint), ('GBP', 11900::bigint)$$,
  'Core is priced in every local currency');
select is((select monthly_minor from private.plan_list_prices where plan_code = 'team' and currency_code = 'CAD'), 122900::bigint,
  'Team lists at C$1,229 a month');
select results_eq(
  $$select plan_code, monthly_minor, annual_minor from private.plan_extra_seat_prices where currency_code = 'USD' order by plan_code$$,
  $$values ('core', 1900::bigint, 19000::bigint), ('pro', 1900::bigint, 19000::bigint), ('team', 1500::bigint, 15000::bigint)$$,
  'extra seats cost 19 dollars a month on Core and Pro and 15 on Team, annual at ten times monthly');
select results_eq(
  $$select currency_code::text, monthly_minor from private.plan_extra_seat_prices where plan_code = 'team' and currency_code <> 'USD' order by currency_code$$,
  $$values ('AUD', 2300::bigint), ('CAD', 2100::bigint), ('EUR', 1400::bigint), ('GBP', 1200::bigint)$$,
  'Team extra seats are priced in every local currency');
select is((select count(*)::integer from private.plan_extra_seat_prices where plan_code in ('access', 'enterprise')), 0,
  'Access and Enterprise sell no extra seats');
select results_eq(
  $$select plan_code, limit_code::text, amount from private.plan_addons where addon_code = 'aurora_requests_1000' order by plan_code$$,
  $$values ('core', 'aurora_requests_per_month', 1000), ('pro', 'aurora_requests_per_month', 1000), ('team', 'aurora_requests_per_month', 1000)$$,
  'Core, Pro and Team can buy 1,000 extra Aurora requests');
select is((select column_default from information_schema.columns
  where table_schema = 'app' and table_name = 'partner_agreements' and column_name = 'wholesale_discount_bps'), '3000',
  'a partner agreement defaults to the 30 percent wholesale discount');
select is((select count(*)::integer from private.plan_features where plan_code = 'enterprise'), 23,
  'Enterprise keeps every feature');
select is((select count(*)::integer from private.plan_features where plan_code = 'core'), 5,
  'Core keeps its features');

select * from finish();
rollback;
