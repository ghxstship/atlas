-- pgTAP: migration 1640, Checkout (owner decision 21 of 2026-10-23, RRR-130). The Owner of an org on a trial or Access
-- opens Checkout for a self-serve plan after step-up; a newer checkout closes the open ones; the webhook records each
-- session completed or expired; an org that pays through Stripe changes its billing in the customer portal instead.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(45);

-- Nina starts an org on the 14-day Pro trial (1350), and a second org that is her sandbox (1530).
select pg_temp.as_user('nina');
insert into world values ('org_n', app.create_organization('Nina Lighting', 'nina-lighting'));
insert into world values ('org_s', app.create_organization('Nina Sandbox', 'nina-sandbox'));
select pg_temp.as_platform();
insert into app.sandbox_orgs (org_id, person_id, expires_at) values (pg_temp.id('org_s'), pg_temp.id('nina'), now() + interval '1 day');

-- Table and privileges --------------------------------------------------------------------------------------------
select has_table('app', 'billing_checkouts', 'Checkout sessions Atlas opens are recorded');
select ok(not has_table_privilege('authenticated', 'app.billing_checkouts', 'insert')
  and not has_table_privilege('authenticated', 'app.billing_checkouts', 'update'),
  'nobody writes a checkout directly; only the checkout RPCs do');
select ok(not has_function_privilege('authenticated',
  'app.finish_billing_checkout_from_stripe(text, app.billing_checkout_state)', 'execute'),
  'only the service role records what Stripe did with a session');
select ok(has_function_privilege('authenticated', 'app.begin_billing_checkout(uuid, text, boolean)', 'execute')
  and not has_function_privilege('anon', 'app.begin_billing_checkout(uuid, text, boolean)', 'execute'),
  'signed-in people call the checkout checks; anonymous callers cannot');

-- Who may open a checkout, and for what ---------------------------------------------------------------------------
select pg_temp.as_user_stepped_up('bob');
select throws_ok($$select * from app.begin_billing_checkout(pg_temp.id('org_a'), 'core', false)$$,
  '42501', 'org.billing.manage is required', 'an Admin cannot open a checkout (billing is the Owner''s)');

select pg_temp.as_user('nina');
select throws_ok($$select * from app.begin_billing_checkout(pg_temp.id('org_n'), 'core', false)$$,
  'XR001', 'step_up_required: Confirm it is you with your second factor to change billing.',
  'the Owner passes a second factor first');

select pg_temp.as_user_stepped_up('nina');
select is((select b.stripe_customer_id from app.begin_billing_checkout(pg_temp.id('org_n'), 'core', false) b), null,
  'an org that never paid has no Stripe customer yet');
select is((select b.trial_ends_at from app.begin_billing_checkout(pg_temp.id('org_n'), 'core', false) b),
  (select s.trial_ends_at from app.subscriptions s where s.org_id = pg_temp.id('org_n') and s.subscription_state = 'trialing'),
  'a trialing org carries its trial end to Checkout');
select is((select b.open_session_ids from app.begin_billing_checkout(pg_temp.id('org_n'), 'core', false) b), '{}'::text[],
  'and has no open session yet');
select throws_ok($$select * from app.begin_billing_checkout(pg_temp.id('org_n'), 'access', false)$$,
  'XR001', 'plan_not_self_serve: The access plan cannot be bought through Checkout.', 'Access is free, never checked out');
select throws_ok($$select * from app.begin_billing_checkout(pg_temp.id('org_n'), 'enterprise', false)$$,
  'XR001', 'plan_not_self_serve: The enterprise plan cannot be bought through Checkout.', 'Enterprise is sold by quote');
select throws_ok($$select * from app.begin_billing_checkout(pg_temp.id('org_s'), 'core', false)$$,
  'XR001', 'sandbox_not_billable: A sandbox is never billed.', 'a sandbox is never billed');

select pg_temp.as_user_stepped_up('cora');
select throws_ok($$select * from app.begin_billing_checkout(pg_temp.id('org_c'), 'pro', false)$$,
  'XR001', 'billing_through_partner: Your partner bills this organization. Ask the partner to change its plan.',
  'a client org its partner bills does not check out on its own');

select pg_temp.as_user_stepped_up('mia');
select throws_ok($$select * from app.begin_billing_checkout(pg_temp.id('org_b'), 'team', false)$$,
  '42501', null, 'a Viewer cannot open a checkout either');
select pg_temp.as_user('xavier');
select throws_ok($$select * from app.begin_billing_checkout(pg_temp.id('org_b'), 'team', false)$$,
  'XR001', 'step_up_required: Confirm it is you with your second factor to change billing.',
  'the plan and org checks pass before step-up is asked');
select pg_temp.as_user_stepped_up('xavier');
select is((select b.trial_ends_at from app.begin_billing_checkout(pg_temp.id('org_b'), 'team', false) b), null,
  'an org on Access opens a checkout with no trial to carry');

-- Recording sessions ------------------------------------------------------------------------------------------------
select pg_temp.as_user_stepped_up('nina');
select is(app.record_billing_checkout(pg_temp.id('org_n'), 'core', 'Monthly', 'cs_test_N1naFirst', false, now() + interval '1 day'),
  '{}'::text[], 'the first session closes nothing');
select ok((select c.checkout_state = 'Open' and c.created_by = pg_temp.id('nina') and c.plan_code = 'core'
  from app.billing_checkouts c where c.stripe_checkout_session_id = 'cs_test_N1naFirst'),
  'it is recorded open, with the Owner who started it');
select is((select b.open_session_ids from app.begin_billing_checkout(pg_temp.id('org_n'), 'pro', false) b),
  array['cs_test_N1naFirst'], 'the next checkout hears of the open session, to expire it in Stripe');
select is(app.record_billing_checkout(pg_temp.id('org_n'), 'pro', 'Annual', 'cs_test_N1naSecond', false, now() + interval '1 day'),
  array['cs_test_N1naFirst'], 'recording a newer session closes the open one and names it');
select ok((select c.checkout_state = 'Expired' and c.finished_at is not null
  from app.billing_checkouts c where c.stripe_checkout_session_id = 'cs_test_N1naFirst'),
  'the older session is expired');
select is(app.record_billing_checkout(pg_temp.id('org_n'), 'pro', 'Annual', 'cs_test_N1naSecond', false, now() + interval '1 day'),
  '{}'::text[], 'recording the same session again changes nothing');
select is((select count(*)::integer from app.billing_checkouts c where c.org_id = pg_temp.id('org_n')), 2,
  'one row per session');
select throws_ok($$select app.record_billing_checkout(pg_temp.id('org_n'), 'core', 'Monthly', 'cs_live_N1na', false, now() + interval '1 day')$$,
  'XR001', 'checkout_session_invalid: That is not a Stripe Checkout session of this mode.', 'a live session is not a test mode one');
select throws_ok($$select app.record_billing_checkout(pg_temp.id('org_n'), 'core', 'Monthly', 'cs_test_N1naLater', false, now() + interval '3 days')$$,
  'XR001', 'checkout_expiry_range: A Checkout session expires within a day.', 'a session expires within a day');
select pg_temp.as_user('nina');
select throws_ok($$select app.record_billing_checkout(pg_temp.id('org_n'), 'core', 'Monthly', 'cs_test_N1naThird', false, now() + interval '1 day')$$,
  'XR001', 'step_up_required: Confirm it is you with your second factor to change billing.', 'recording asks for step-up too');
select pg_temp.as_user_stepped_up('alice');
select throws_ok($$select app.record_billing_checkout(pg_temp.id('org_n'), 'core', 'Monthly', 'cs_test_N1naThird', false, now() + interval '1 day')$$,
  '42501', null, 'the Owner of another org cannot record one');
select is((select count(*)::integer from app.billing_checkouts c where c.org_id = pg_temp.id('org_n')), 0,
  'nor read the org''s checkouts');
select pg_temp.as_user('nina');
select is((select count(*)::integer from app.billing_checkouts c where c.org_id = pg_temp.id('org_n')), 2,
  'the Owner reads them');

-- The webhook ----------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
set local role service_role;
select is(app.finish_billing_checkout_from_stripe('cs_test_N1naSecond', 'Completed'), true, 'Stripe completed a session Atlas opened');
reset role;
select ok((select c.checkout_state = 'Completed' and c.finished_at is not null
  from app.billing_checkouts c where c.stripe_checkout_session_id = 'cs_test_N1naSecond'), 'it is completed');
select is(app.finish_billing_checkout_from_stripe('cs_test_N1naSecond', 'Expired'), true, 'a later expiry event is answered');
select is((select c.checkout_state from app.billing_checkouts c where c.stripe_checkout_session_id = 'cs_test_N1naSecond'),
  'Completed'::app.billing_checkout_state, 'but a completed session stays completed');
select is(app.finish_billing_checkout_from_stripe('cs_test_Unknown', 'Expired'), false, 'a session Atlas never opened is not ours');
select throws_ok($$select app.finish_billing_checkout_from_stripe('cs_test_N1naSecond', 'Open')$$,
  'XR001', 'checkout_state_invalid: A Checkout session finishes Completed or Expired.', 'a session never reopens');

-- Once the org pays through Stripe -------------------------------------------------------------------------------
select is(app.sync_subscription_from_stripe(pg_temp.id('org_n'), 'cus_N1na', 'sub_N1na', 'pro', 'Annual', 'trialing',
  now() + interval '14 days', false), 'active'::app.subscription_state, 'the paid subscription converts the trial');
select pg_temp.as_user_stepped_up('nina');
select throws_ok($$select * from app.begin_billing_checkout(pg_temp.id('org_n'), 'team', false)$$,
  'XR001', 'billing_already_subscribed: This organization already pays through Stripe. Change the plan or the payment method in the billing portal.',
  'an org that pays changes its plan in the portal, never through a second checkout');
select is((select b.paid_through_stripe::text || ' ' || b.has_stripe_customer::text || ' ' || b.billing_interval::text
  from app.billing_account(pg_temp.id('org_n'), false) b), 'true true Annual', 'Billing and Plan sees the paid subscription');
select is((select b.paid_through_stripe from app.billing_account(pg_temp.id('org_n'), true) b), false,
  'live mode billing is separate from test mode');
select is(app.billing_portal_customer(pg_temp.id('org_n'), false), 'cus_N1na', 'the portal opens on the org''s customer');
select pg_temp.as_user('nina');
select throws_ok($$select app.billing_portal_customer(pg_temp.id('org_n'), false)$$,
  'XR001', 'step_up_required: Confirm it is you with your second factor to change billing.', 'after step-up');
select pg_temp.as_user_stepped_up('xavier');
select throws_ok($$select app.billing_portal_customer(pg_temp.id('org_b'), false)$$,
  'XR001', 'billing_no_customer: This organization has not paid through Stripe yet. Choose a plan first.',
  'an org that never paid has no portal');

select pg_temp.as_platform();
select is(app.sync_subscription_from_stripe(pg_temp.id('org_n'), 'cus_N1na', 'sub_N1na', 'pro', 'Annual', 'canceled',
  now(), false), 'canceled'::app.subscription_state, 'the subscription ends and the org returns to Access');
select pg_temp.as_user_stepped_up('nina');
select is((select b.stripe_customer_id from app.begin_billing_checkout(pg_temp.id('org_n'), 'core', false) b), 'cus_N1na',
  'a new checkout reuses the org''s Stripe customer');

-- A canceled org is read-only until it is reactivated ------------------------------------------------------------
select pg_temp.as_platform();
insert into app.org_cancellations (org_id, reason, read_only_until, purge_after)
values (pg_temp.id('org_b'), 'Closing the season.', now() + interval '30 days', now() + interval '90 days');
select pg_temp.as_user_stepped_up('xavier');
select throws_ok($$select * from app.begin_billing_checkout(pg_temp.id('org_b'), 'core', false)$$,
  'XR001', 'org_read_only: This organization is read-only. Recover or reactivate it in Settings, Danger zone, before choosing a plan.',
  'a canceled org reactivates before it chooses a plan');

select * from finish();
rollback;
