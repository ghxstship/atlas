-- pgTAP: migration 904100201, where Checkout is offered (ADR 0033 decision 59, RRR-130). Billing and Plan reads from
-- app.billing_account the rule that refuses every plan's Checkout for the org, the same rule the checkout checks raise,
-- so it offers Checkout only where it opens; a session recorded for another checkout is refused, not taken as a repeat.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(24);

-- Nina starts an org on the 14-day Pro trial (1350), and a second org that is her sandbox (1530).
select pg_temp.as_user('nina');
insert into world values ('org_n', app.create_organization('Nina Lighting', 'nina-lighting'));
insert into world values ('org_s', app.create_organization('Nina Sandbox', 'nina-sandbox'));
select pg_temp.as_platform();
insert into app.sandbox_orgs (org_id, person_id, expires_at) values (pg_temp.id('org_s'), pg_temp.id('nina'), now() + interval '1 day');

select ok(not has_function_privilege('authenticated', 'private.billing_checkout_refusal(uuid, text, boolean)', 'execute'),
  'the refusal rule is read through app.billing_account, never called directly');
select is((select count(*)::integer from information_schema.routines
           where routine_schema = 'app' and routine_name = 'billing_account'), 1,
  'app.billing_account has one signature');

-- What Billing and Plan reads ---------------------------------------------------------------------------------------
select pg_temp.as_user('nina');
select is((select b.checkout_refusal from app.billing_account(pg_temp.id('org_n'), false) b), null,
  'a trialing org may check out, so the page offers Checkout');
select is((select b.checkout_refusal from app.billing_account(pg_temp.id('org_s'), false) b), 'sandbox_not_billable',
  'a sandbox is never offered Checkout');
select pg_temp.as_user('cora');
select is((select b.checkout_refusal from app.billing_account(pg_temp.id('org_c'), false) b), 'billing_through_partner',
  'nor a client org its partner bills');
select pg_temp.as_user('xavier');
select is((select b.checkout_refusal from app.billing_account(pg_temp.id('org_b'), false) b), null,
  'an org on Access may check out');
select pg_temp.as_user('alice');
select throws_ok($$select * from app.billing_account(pg_temp.id('org_n'), false)$$,
  '42501', 'org.billing.read is required', 'the Owner of another org reads nothing');

-- The rule the page reads is the rule Checkout raises ----------------------------------------------------------------
select pg_temp.as_user_stepped_up('cora');
select throws_ok($$select * from app.begin_billing_checkout(pg_temp.id('org_c'), 'core', false)$$,
  'XR001', 'billing_through_partner: Your partner bills this organization. Ask the partner to change its plan.',
  'Checkout refuses the client org with the same rule');
select pg_temp.as_user_stepped_up('nina');
select throws_ok($$select * from app.begin_billing_checkout(pg_temp.id('org_n'), null, false)$$,
  'XR001', 'plan_not_self_serve: The  plan cannot be bought through Checkout.', 'a checkout names a plan');

-- Recording a session --------------------------------------------------------------------------------------------
select is(app.record_billing_checkout(pg_temp.id('org_n'), 'core', 'Monthly', 'cs_test_N1naOffer', false, now() + interval '1 day'),
  '{}'::text[], 'the Owner records a session');
select is(app.record_billing_checkout(pg_temp.id('org_n'), 'core', 'Monthly', 'cs_test_N1naOffer', false, now() + interval '1 day'),
  '{}'::text[], 'recording it again changes nothing');
select throws_ok($$select app.record_billing_checkout(pg_temp.id('org_n'), 'pro', 'Monthly', 'cs_test_N1naOffer', false, now() + interval '1 day')$$,
  'XR001', 'checkout_session_taken: That Checkout session was recorded for another checkout.',
  'the same session for another plan is refused, not taken as a repeat');
select pg_temp.as_user_stepped_up('xavier');
select throws_ok($$select app.record_billing_checkout(pg_temp.id('org_b'), 'core', 'Monthly', 'cs_test_N1naOffer', false, now() + interval '1 day')$$,
  'XR001', 'checkout_session_taken: That Checkout session was recorded for another checkout.',
  'and so is the same session for another org');
select pg_temp.as_platform();
select is((select count(*)::integer from app.billing_checkouts c where c.stripe_checkout_session_id = 'cs_test_N1naOffer'
  and c.org_id = pg_temp.id('org_n') and c.plan_code = 'core' and c.checkout_state = 'Open'), 1,
  'the session stays Nina''s, open, for Core');

-- A live mode repeat: the renewal consent trigger (6811) must not see it ---------------------------------------------
select pg_temp.as_user_stepped_up('nina');
select app.record_renewal_consent(pg_temp.id('org_n'), 'core', 'Monthly', 14900, 'USD', (now() at time zone 'UTC')::date + 10,
  '2026-11-06', 'en-US', 'Core renews every month.', '', true);
select is(app.record_billing_checkout(pg_temp.id('org_n'), 'core', 'Monthly', 'cs_live_N1naRepeat', true, now() + interval '1 day'),
  '{}'::text[], 'with consent the Owner records a live session');
select is(app.record_billing_checkout(pg_temp.id('org_n'), 'core', 'Monthly', 'cs_live_N1naRepeat', true, now() + interval '1 day'),
  '{}'::text[], 'recording it again in live mode changes nothing, though its consent is already taken');
select app.record_renewal_consent(pg_temp.id('org_n'), 'core', 'Monthly', 14900, 'USD', (now() at time zone 'UTC')::date + 10,
  '2026-11-06', 'en-US', 'Core renews every month.', '', true);
select is(app.record_billing_checkout(pg_temp.id('org_n'), 'core', 'Monthly', 'cs_live_N1naNewer', true, now() + interval '1 day'),
  array['cs_live_N1naRepeat'], 'a newer live session closes the first');
select is(app.record_billing_checkout(pg_temp.id('org_n'), 'core', 'Monthly', 'cs_live_N1naRepeat', true, now() + interval '1 day'),
  '{}'::text[], 'a late repeat of the first changes nothing');
select pg_temp.as_platform();
select is((select array_agg(c.stripe_checkout_session_id || ':' || c.checkout_state::text order by c.stripe_checkout_session_id)
           from app.billing_checkouts c where c.org_id = pg_temp.id('org_n') and c.livemode),
  array['cs_live_N1naNewer:Open', 'cs_live_N1naRepeat:Expired'],
  'the newer session stays open and the first stays closed');

-- Paid, then subscribed, then read-only ----------------------------------------------------------------------------
set local role service_role;
select is(app.finish_billing_checkout_from_stripe('cs_test_N1naOffer', 'Completed'), true, 'Stripe completes the session');
reset role;
select pg_temp.as_user('nina');
select is((select b.checkout_refusal from app.billing_account(pg_temp.id('org_n'), false) b), 'checkout_completed',
  'while its subscription has not synced, the page offers no second Checkout');
select pg_temp.as_platform();
select is(app.sync_subscription_from_stripe(pg_temp.id('org_n'), 'cus_N1naOffer', 'sub_N1naOffer', 'core', 'Monthly', 'trialing',
  now() + interval '14 days', false), 'active'::app.subscription_state, 'the subscription syncs and converts the trial');
select pg_temp.as_user('nina');
select is((select b.checkout_refusal from app.billing_account(pg_temp.id('org_n'), false) b), 'billing_already_subscribed',
  'once it pays through Stripe, the portal changes the plan instead');

select pg_temp.as_platform();
insert into app.org_cancellations (org_id, reason, read_only_until, purge_after)
values (pg_temp.id('org_b'), 'Closing the season.', now() + interval '30 days', now() + interval '90 days');
select pg_temp.as_user('xavier');
select is((select b.checkout_refusal from app.billing_account(pg_temp.id('org_b'), false) b), 'org_read_only',
  'a canceled org is offered no Checkout until it is reactivated');

select * from finish();
rollback;
