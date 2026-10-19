-- pgTAP: pricing v4 (ADR 0034). Seat limits with extra seats and grandfathering, seat refusals that
-- name the fix, Aurora request packs that raise the month's allowance, and the Stripe sync of extra seats.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(32);

select pg_temp.as_platform();

-- Mirrors and privileges --------------------------------------------------------------------------------
select has_table('private', 'plan_extra_seat_prices', 'extra-seat prices are mirrored in the database');
select has_table('private', 'plan_addons', 'add-ons are mirrored in the database');
select has_table('app', 'addon_purchases', 'paid add-ons are recorded');
select ok(not has_table_privilege('authenticated', 'private.plan_extra_seat_prices', 'select'),
  'signed-in people cannot read the private mirrors');
select ok(not has_table_privilege('authenticated', 'app.addon_purchases', 'insert'),
  'nobody inserts a purchase directly; only the billing RPC writes it');
select ok(not has_function_privilege('authenticated',
  'app.record_addon_purchase_from_stripe(uuid, text, integer, text, text, bigint, boolean, timestamptz)', 'execute'),
  'only the service role records a paid add-on');
select ok(not has_function_privilege('authenticated',
  'app.sync_subscription_from_stripe(uuid, text, text, text, app.billing_interval, text, timestamptz, boolean, integer)', 'execute'),
  'only the service role syncs a Stripe subscription');
select ok(not has_column_privilege('authenticated', 'app.subscriptions', 'extra_seats', 'update'),
  'an Owner cannot grant the org extra seats by writing the subscription');

-- Seat allowances ---------------------------------------------------------------------------------------
select is(private.plan_limit(pg_temp.id('org_b'), 'seats'), 1::bigint, 'an Access org has one seat');
select is(private.plan_limit(pg_temp.id('org_a'), 'seats'), 40::bigint, 'a Team org has 40 seats');
select is(private.plan_limit(pg_temp.id('org_a'), 'field_members'), null::bigint, 'and unlimited field crew');
select is(private.plan_limit(pg_temp.id('org_a'), 'active_projects'), null::bigint, 'and unlimited projects');

-- Seat refusals name the fix ------------------------------------------------------------------------------
select throws_like($$select private.assert_within_plan_limit(pg_temp.id('org_b'), 'seats', 2)$$,
  'seat_limit_upgrade: All 1 seats are in use, and the access plan sells no extra seats.%',
  'Access sells no extra seats, so a second seat is told to upgrade');
update app.subscriptions set plan_code = 'core' where org_id = pg_temp.id('org_b');
select is(private.plan_limit(pg_temp.id('org_b'), 'seats'), 5::bigint, 'a Core org has 5 seats');
select lives_ok($$select private.assert_within_plan_limit(pg_temp.id('org_b'), 'seats', 5)$$,
  'the fifth seat fits on Core');
select throws_like($$select private.assert_within_plan_limit(pg_temp.id('org_b'), 'seats', 6)$$,
  'seat_limit_reached: All 5 seats are in use. Buy extra seats in Billing and Plan, or upgrade the plan.',
  'the sixth seat on Core is told to buy extra seats or upgrade');
select throws_like($$select private.assert_within_plan_limit(pg_temp.id('org_b'), 'active_external_engagements_per_month', 251)$$,
  'plan_limit_exceeded:%', 'other limits keep their refusal');

-- Extra seats through Stripe -----------------------------------------------------------------------------
select is(app.sync_subscription_from_stripe(pg_temp.id('org_b'), 'cus_H4rb0r', 'sub_H4rb0r', 'core', 'Monthly', 'active',
  now() + interval '30 days', false, 3), 'active'::app.subscription_state, 'a Core subscription with 3 extra seats syncs');
select is(private.plan_limit(pg_temp.id('org_b'), 'seats'), 8::bigint, 'extra seats add to the allowance');
select lives_ok($$select private.assert_within_plan_limit(pg_temp.id('org_b'), 'seats', 8)$$,
  'so an org at its allowance adds seats by buying them');
select throws_ok($$select app.sync_subscription_from_stripe(pg_temp.id('org_b'), 'cus_H4rb0r', 'sub_H4rb0r', 'enterprise', 'Annual', 'active',
  now(), false, 2)$$, 'XR001', 'extra_seats_not_sold: The enterprise plan sells no extra seats.',
  'a plan without extra seats cannot carry them');
select is(app.sync_subscription_from_stripe(pg_temp.id('org_b'), 'cus_H4rb0r', 'sub_H4rb0r', 'core', 'Monthly', 'active',
  now() + interval '30 days', false), 'active'::app.subscription_state, 'a sync without the seat item removes extra seats');
select is((select extra_seats from app.subscriptions where org_id = pg_temp.id('org_b') and subscription_state <> 'canceled'), 0,
  'the extra seats are back to none');

-- Grandfathering ---------------------------------------------------------------------------------------------
update app.subscriptions set seats_grandfathered = true where org_id = pg_temp.id('org_a');
select is(private.plan_limit(pg_temp.id('org_a'), 'seats'), null::bigint,
  'a subscription from before seat limits keeps unlimited seats');
update app.subscriptions set plan_code = 'pro' where org_id = pg_temp.id('org_a');
select is((select seats_grandfathered from app.subscriptions where org_id = pg_temp.id('org_a') and subscription_state <> 'canceled'), false,
  'changing plan ends the grandfathering');
select is(private.plan_limit(pg_temp.id('org_a'), 'seats'), 15::bigint, 'and the new plan''s seats apply');

-- Seat usage -------------------------------------------------------------------------------------------------
select pg_temp.as_user('alice');
select results_eq($$select seats_used >= 1, seat_limit, plan_seats, extra_seats, sells_extra_seats, grandfathered from app.seat_usage(pg_temp.id('org_a'))$$,
  $$values (true, 15::bigint, 15::bigint, 0, true, false)$$, 'members read the seat usage of their org');
select throws_ok($$select * from app.seat_usage(pg_temp.id('org_b'))$$, '42501', null, 'but not of another org');
select pg_temp.as_platform();

-- Aurora request packs ----------------------------------------------------------------------------------------
select isnt(app.record_addon_purchase_from_stripe(pg_temp.id('org_a'), 'aurora_requests_1000', 2, 'cs_test_N0rthw1nd1',
  'usd', 9800, false, now()), null, 'a paid pack is recorded');
select is(private.plan_limit(pg_temp.id('org_a'), 'aurora_requests_per_month'), 4000::bigint,
  'two packs add 2,000 requests to the Pro allowance this month');
select is(app.record_addon_purchase_from_stripe(pg_temp.id('org_a'), 'aurora_requests_1000', 2, 'cs_test_N0rthw1nd1',
  'usd', 9800, false, now()), (select id from app.addon_purchases where stripe_checkout_session_id = 'cs_test_N0rthw1nd1'),
  'a redelivered payment is recorded once');
select app.record_addon_purchase_from_stripe(pg_temp.id('org_a'), 'aurora_requests_1000', 1, 'cs_test_N0rthw1nd2',
  'usd', 4900, false, now() - interval '40 days');
select is(private.plan_limit(pg_temp.id('org_a'), 'aurora_requests_per_month'), 4000::bigint,
  'a pack from an earlier month adds nothing now');

select * from finish();
rollback;
