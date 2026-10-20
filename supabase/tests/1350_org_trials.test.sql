-- pgTAP: org trials (1350, A79, finding A65-015, Section 14.7). A new org starts a 14-day Pro trial with no card; billing
-- owners hear on days 3 and 1; at the end the org moves to the Access plan in place with its data kept; adding a card
-- through Stripe converts the trial; a partner's client org keeps the plan the partner set; nothing charges a card.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(24);

-- Starting ------------------------------------------------------------------------------------------------------
select pg_temp.as_user('nina');
insert into world values ('trial_org', app.create_organization('Lantern Works', 'lantern-works'));
insert into app.workspaces (org_id, slug, name) values (pg_temp.id('trial_org'), 'main-stage', 'Main Stage');
select results_eq($$select plan_code, subscription_state::text from app.subscriptions where org_id = (select id from world where key = 'trial_org')$$,
  $$values ('pro'::text, 'trialing'::text)$$, 'a new org starts a Pro trial');
select is((select days_left from app.org_trial(pg_temp.id('trial_org'))), 14, 'the countdown starts at 14 days');
select pg_temp.as_platform();
select ok(private.org_has_feature(pg_temp.id('trial_org'), 'white_label'), 'the trial gives Pro features, white label among them');
select is((select count(*)::int from app.stripe_subscription_links l join app.subscriptions s on s.id = l.subscription_id
  where s.org_id = pg_temp.id('trial_org')), 0, 'no Stripe subscription exists for a trial: no card, nothing to charge');
select is((select plan_code from app.subscriptions where org_id = pg_temp.id('org_c')), 'core',
  'a client org keeps the plan its partner set, with no trial');
select pg_temp.as_user('xavier');
select is_empty($$select * from app.org_trial((select id from world where key = 'trial_org'))$$,
  'someone outside the org reads no trial');

-- Notices ---------------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
select ok(private.run_trials(now() + interval '11 days 1 hour') >= 1, 'three days before the end the job acts');
select private.run_trials(now() + interval '11 days 2 hours');
select is((select count(*)::int from app.notifications where kind = 'billing.trial_ending' and recipient_person_id = pg_temp.id('nina')
  and message_args ->> 'days' = '3'), 1, 'the Owner hears once on day 3, however often the job runs');
select private.run_trials(now() + interval '13 days 1 hour');
select is((select count(*)::int from app.notifications where kind = 'billing.trial_ending' and recipient_person_id = pg_temp.id('nina')),
  2, 'and once more the day before the end');
select is((select subscription_state::text from app.subscriptions where org_id = pg_temp.id('trial_org')), 'trialing',
  'the trial runs until its end');

-- Expiry ----------------------------------------------------------------------------------------------------------
select private.run_trials(now() + interval '14 days 1 hour');
select results_eq($$select plan_code, subscription_state::text, extra_seats from app.subscriptions where org_id = (select id from world where key = 'trial_org')$$,
  $$values ('access'::text, 'active'::text, 0)$$, 'at the end the org moves to the Access plan in place');
select ok(not private.org_has_feature(pg_temp.id('trial_org'), 'white_label'), 'Pro features end with the trial');
select is((select count(*)::int from app.workspaces where org_id = pg_temp.id('trial_org')), 1, 'no data is deleted');
select is((select count(*)::int from app.notifications where kind = 'billing.trial_ended' and recipient_person_id = pg_temp.id('nina')),
  1, 'the Owner is told the trial ended');
select ok((select reason from app.subscription_state_transitions where org_id = pg_temp.id('trial_org') and from_state = 'trialing')
  like '%moved to the Access plan%', 'the ledger records why');
select is((select trial_ends_at is not null from app.subscriptions where org_id = pg_temp.id('trial_org')), true,
  'the trial end stays as history');
select is(private.run_trials(now() + interval '15 days'), 0, 'an ended trial is not touched again');
select pg_temp.as_user('nina');
select is_empty($$select * from app.org_trial((select id from world where key = 'trial_org'))$$, 'no countdown after the trial');

-- Conversion ------------------------------------------------------------------------------------------------------
insert into world values ('card_org', app.create_organization('Beacon Hall', 'beacon-hall'));
select pg_temp.as_platform();
select is(app.sync_subscription_from_stripe(pg_temp.id('card_org'), 'cus_A79Beacon', 'sub_A79Beacon', 'team', 'Monthly',
  'trialing', now() + interval '14 days', false), 'active'::app.subscription_state,
  'adding a card through Checkout converts the trial, while Stripe holds the charge to the trial end');
select results_eq($$select plan_code, subscription_state::text from app.subscriptions where org_id = (select id from world where key = 'card_org')$$,
  $$values ('team'::text, 'active'::text)$$, 'the org is on the plan it bought');
select private.run_trials(now() + interval '20 days');
select is((select plan_code from app.subscriptions where org_id = pg_temp.id('card_org')), 'team', 'a converted trial never expires');

-- Machinery ---------------------------------------------------------------------------------------------------------
select ok(exists (select 1 from cron.job where jobname = 'xos_hourly_org_lifecycle' and command like '%private.run_org_lifecycle()%'),
  'the lifecycle job runs hourly');
select ok(not has_function_privilege('authenticated', 'private.expire_trial(uuid)', 'execute'), 'no client ends a trial');
select ok(not has_function_privilege('authenticated', 'private.start_trial(uuid, text, timestamptz, text)', 'execute'),
  'no client starts or extends a trial');

select * from finish();
rollback;
