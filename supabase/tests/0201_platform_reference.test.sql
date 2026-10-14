-- pgTAP: platform reference data (plans and limits of Section 16, subscription transitions,
-- reserved slugs) and the privileges around them.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;

select plan(17);

select results_eq(
  'select code from app.plans order by sort_order',
  array['access', 'core', 'pro', 'team', 'enterprise'],
  'five plans in order from the free plan upward'
);
select is(
  (select limit_value from private.plan_limits where plan_code = 'access' and limit_code = 'seats'),
  1::bigint,
  'Access allows one seat'
);
select is(
  (select limit_value from private.plan_limits where plan_code = 'access' and limit_code = 'active_projects'),
  1::bigint,
  'Access allows one active project: the first project is free (ADR 0018)'
);
select is(
  (select limit_value from private.plan_limits where plan_code = 'access' and limit_code = 'field_members'),
  10::bigint,
  'Access allows Compass for ten field members'
);
select results_eq(
  $$select limit_value from private.plan_limits
    where limit_code = 'active_external_engagements_per_month'
    order by (select sort_order from app.plans p where p.code = plan_code)$$,
  $$values (25::bigint), (250::bigint), (2500::bigint), (null::bigint), (null::bigint)$$,
  'external engagement limits per month follow Section 16'
);
select ok(
  not exists (select 1 from private.plan_features where plan_code = 'core' and feature_code = 'custom_roles')
  and exists (select 1 from private.plan_features where plan_code = 'team' and feature_code = 'custom_roles'),
  'custom roles start at the Team plan'
);
select ok(
  exists (select 1 from private.plan_features where plan_code = 'pro' and feature_code = 'public_marketplace_listings')
  and not exists (select 1 from private.plan_features where plan_code = 'core' and feature_code = 'public_marketplace_listings'),
  'public marketplace listings require Pro or above'
);
select is(
  (select count(*)::integer from private.plan_features where plan_code = 'access'),
  0,
  'Access includes no gated feature'
);
select results_eq(
  $$select plan_code from private.plan_features where feature_code = 'aurora_ai'
    order by (select sort_order from app.plans p where p.code = plan_code)$$,
  array['core', 'pro', 'team', 'enterprise'],
  'Aurora AI is in every paid plan (ADR 0020, seed 0902)'
);
select results_eq(
  $$select limit_value from private.plan_limits
    where limit_code = 'aurora_requests_per_month'
    order by (select sort_order from app.plans p where p.code = plan_code)$$,
  $$values (0::bigint), (500::bigint), (2000::bigint), (10000::bigint), (null::bigint)$$,
  'Aurora AI allowances rise by tier and Enterprise is unlimited (ADR 0020)'
);
select results_eq(
  $$select plan_code from private.plan_features where feature_code = 'legend_early_access'$$,
  array['enterprise'],
  'Legend early access is Enterprise only (ADR 0020)'
);
select ok(
  not exists (select 1 from app.subscription_state_transition_rules where from_state = 'canceled'),
  'canceled is a terminal subscription state'
);
select ok(
  exists (select 1 from private.reserved_org_slugs where slug = 'partner'),
  'route segments are reserved slugs'
);

set local role anon;
select throws_ok('select * from app.plans', '42501', null, 'anon cannot read plans');
reset role;

set local role authenticated;
select isnt_empty('select * from app.plans', 'authenticated reads plans');
select throws_ok('select * from private.plan_limits', '42501', null, 'authenticated cannot read private plan limits');
select throws_ok($$insert into app.plans (code, sort_order) values ('gold', 9)$$, '42501', null, 'authenticated cannot add plans');
reset role;

select * from finish();
rollback;
