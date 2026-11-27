-- pgTAP: the generated plan seed 904190501 (ADR 0035, 2026-11-27 amendment; ghxstship/atlas issue 125). Support session
-- controls are on every plan, starting with the free plan, where plans.yaml used to list them on Enterprise alone. No
-- function reads that feature code, so no organization gains or loses anything it could do; the row now says what was
-- already true. Every other plan feature, limit and price is as plan seed 1251 left it. The open territories are the
-- ones plans.yaml lists under offering.open_territories.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;

select plan(8);

select results_eq(
  $$select plan_code from private.plan_features where feature_code = 'support_session_controls' order by plan_code$$,
  $$values ('access'), ('core'), ('enterprise'), ('pro'), ('team')$$,
  'every plan has support session controls');
select results_eq(
  $$select feature_code::text from private.plan_features where plan_code = 'access'$$,
  $$values ('support_session_controls')$$,
  'the free plan has that feature and no other');
select results_eq(
  $$select plan_code, count(*)::integer from private.plan_features group by plan_code order by plan_code$$,
  $$values ('access', 1), ('core', 6), ('enterprise', 23), ('pro', 12), ('team', 17)$$,
  'each plan above adds what it added before, and Enterprise still has every feature');
select is((select count(*)::integer from private.plan_features
  where feature_code <> 'support_session_controls' and plan_code = 'access'), 0,
  'no other feature moved to the free plan');
select is((select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('app', 'api', 'api_public', 'private') and p.prokind = 'f'
    and p.prosrc like '%support_session_controls%'), 0,
  'no function reads the feature code, so the seed changes no behavior');
select results_eq(
  $$select plan_code, limit_value from private.plan_limits where limit_code = 'seats' order by plan_code$$,
  $$values ('access', 1::bigint), ('core', 5::bigint), ('enterprise', null::bigint), ('pro', 15::bigint), ('team', 40::bigint)$$,
  'seat allowances are unchanged');
select results_eq(
  $$select plan_code, monthly_minor from private.plan_list_prices where currency_code = 'USD' order by plan_code$$,
  $$values ('access', 0::bigint), ('core', 14900::bigint), ('enterprise', null::bigint), ('pro', 39900::bigint), ('team', 89900::bigint)$$,
  'USD list prices are unchanged');
select results_eq(
  $$select code from private.territories where offered order by code$$,
  $$values ('US')$$,
  'the open territories are the ones plans.yaml lists under offering.open_territories');

select * from finish();
rollback;
