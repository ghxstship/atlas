-- pgTAP: idempotent Stripe event ingestion, subscription sync through the transition engine, dunning
-- reminders and read-only on day 21 (Section 7.3 Billing, Section 16, Section 14.7).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(24);

create temporary table k (key text primary key, id uuid);
grant select, insert on k to public;

-- Idempotent ingestion ----------------------------------------------------------------------------------------
select pg_temp.as_platform();
insert into k select 'evt', stripe_event_row_id from app.record_stripe_event('evt_1A2b3C', 'customer.subscription.updated', false, now(), '{"id": "evt_1A2b3C"}', pg_temp.id('org_a'));
select ok((select is_new from app.record_stripe_event('evt_9Z8y7X', 'invoice.paid', false, now(), '{"id": "evt_9Z8y7X"}')), 'a new event is stored');
select results_eq($$select stripe_event_row_id, is_new from app.record_stripe_event('evt_1A2b3C', 'customer.subscription.updated', false, now(), '{"id": "evt_1A2b3C"}')$$,
  $$select (select id from k where key = 'evt'), false$$, 'a redelivered event returns the stored row and is not new');
select is((select count(*)::integer from app.stripe_events where stripe_event_id = 'evt_1A2b3C'), 1, 'each Stripe event is stored once');
select throws_ok($$select app.record_stripe_event('not-an-event', 'x.y', false, now(), '{}')$$, '23514', null, 'only Stripe event ids are accepted');
select app.finish_stripe_event((select id from k where key = 'evt'));
select ok((select processed_at is not null and attempts = 1 and org_id = pg_temp.id('org_a') from app.stripe_events where id = (select id from k where key = 'evt')),
  'applying an event records its org and time');

-- Subscription sync ---------------------------------------------------------------------------------------------------
select is(app.sync_subscription_from_stripe(pg_temp.id('org_a'), 'cus_N0rthw1nd', 'sub_N0rthw1nd', 'pro', 'Monthly', 'active', now() + interval '30 days', false),
  'active'::app.subscription_state, 'an active Stripe subscription keeps the org active');
select is((select plan_code from app.subscriptions where org_id = pg_temp.id('org_a') and subscription_state <> 'canceled'), 'pro',
  'the plan resolved from the price lookup key is applied');
select is((select stripe_customer_id from app.stripe_subscription_links), 'cus_N0rthw1nd', 'the Stripe ids are linked to the subscription');
select throws_ok($$select app.sync_subscription_from_stripe(pg_temp.id('org_b'), 'cus_X', 'sub_N0rthw1nd', 'pro', 'Monthly', 'active', now(), false)$$,
  'XR001', null, 'a Stripe subscription cannot move to another org');
select throws_ok($$select app.sync_subscription_from_stripe(pg_temp.id('org_a'), 'cus_N0rthw1nd', 'sub_N0rthw1nd', 'platinum', 'Monthly', 'active', now(), false)$$,
  'XR001', null, 'an unknown plan is refused');
select is(app.sync_subscription_from_stripe(pg_temp.id('org_a'), 'cus_N0rthw1nd', 'sub_N0rthw1nd', 'pro', 'Monthly', 'incomplete', now(), false),
  'active'::app.subscription_state, 'an incomplete status changes nothing');
select is(app.sync_subscription_from_stripe(pg_temp.id('org_a'), 'cus_N0rthw1nd', 'sub_N0rthw1nd', 'pro', 'Monthly', 'past_due', now(), false),
  'past_due'::app.subscription_state, 'a failed payment makes the subscription past due');
select is((select reason from app.subscription_state_transitions t join app.subscriptions s on s.id = t.subscription_id
           where s.org_id = pg_temp.id('org_a') and t.to_state = 'past_due'), 'Stripe subscription is past_due.',
  'the change goes through the transition ledger');

-- Dunning ------------------------------------------------------------------------------------------------------------
select ok(private.run_dunning() >= 1, 'day 0 of dunning sends reminders');
select is((select count(*)::integer from app.notifications where kind = 'billing.payment_failed' and recipient_person_id = pg_temp.id('alice')), 1,
  'the billing owner is reminded');
select is((select count(*)::integer from app.notifications where kind = 'billing.payment_failed' and recipient_person_id = pg_temp.id('bob')), 0,
  'members without org.billing.read are not');
select is(private.run_dunning(), 0, 'a reminder goes once per dunning day');
select ok(private.run_dunning(now() + interval '3 days') >= 1, 'day 3 sends the next reminder');
select is((select subscription_state from app.subscriptions where org_id = pg_temp.id('org_a') and subscription_state <> 'canceled'),
  'past_due'::app.subscription_state, 'the org stays writable before day 21');
select private.run_dunning(now() + interval '21 days');
select is((select subscription_state from app.subscriptions where org_id = pg_temp.id('org_a') and subscription_state <> 'canceled'),
  'read_only'::app.subscription_state, 'on day 21 the org becomes read-only');
select is(app.sync_subscription_from_stripe(pg_temp.id('org_a'), 'cus_N0rthw1nd', 'sub_N0rthw1nd', 'pro', 'Monthly', 'active', now(), false),
  'active'::app.subscription_state, 'a recovered payment restores full access');

-- Cancellation returns the org to Access ---------------------------------------------------------------------------------
select app.sync_subscription_from_stripe(pg_temp.id('org_a'), 'cus_N0rthw1nd', 'sub_N0rthw1nd', 'pro', 'Monthly', 'canceled', now(), false);
select results_eq($$select plan_code, subscription_state from app.subscriptions where org_id = pg_temp.id('org_a') and subscription_state <> 'canceled'$$,
  $$values ('access'::text, 'active'::app.subscription_state)$$, 'a canceled Stripe subscription returns the org to the Access plan, keeping its data');

-- Row level security -------------------------------------------------------------------------------------------------------
select pg_temp.as_user('bob');
select is((select count(*)::integer from app.stripe_events) + (select count(*)::integer from app.stripe_subscription_links), 0,
  'an admin without billing access sees no billing records');
select pg_temp.as_user('alice');
select ok((select count(*) from app.stripe_subscription_links) = 1 and (select count(*) from app.stripe_events) = 1, 'the owner reads the org''s billing records');

select * from finish();
rollback;
