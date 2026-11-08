-- pgTAP: stopping Stripe (6810, ADR 0161, audit finding M1). Canceling or deleting an org queues the cancel of its Stripe
-- subscriptions in the same transaction, the worker retries with backoff, only the service role records that Stripe accepted
-- it, the customer is told the truth, webhooks reconcile (a subscription Stripe says is live on a deleted org raises an
-- alert), and an org cannot finish deletion until the cancel is accepted.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0200_identity_world.psql

select plan(108);

create function pg_temp.as_service() returns void
language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform set_config('role', 'service_role', true);
end $$;
create function pg_temp.notices(p_kind text, p_org text) returns integer
language sql stable as $$
  select count(*)::integer from app.notifications n where n.kind = p_kind and n.org_id = pg_temp.id(p_org) and n.deleted_at is null $$;
create function pg_temp.cancel_state(p_sub text, p_mode app.stripe_cancel_mode) returns text
language sql stable as $$
  select c.cancellation_state::text from private.stripe_cancellations c
  where c.stripe_subscription_id = p_sub and c.cancel_mode = p_mode order by c.created_at desc limit 1 $$;

-- Northwind pays monthly and Harbor Lights yearly through Stripe.
select pg_temp.as_service();
select app.sync_subscription_from_stripe(pg_temp.id('org_a'), 'cus_N0rth', 'sub_N0rth', 'team', 'Monthly', 'active', now() + interval '20 days', false);
select app.sync_subscription_from_stripe(pg_temp.id('org_b'), 'cus_H4rb', 'sub_H4rb', 'team', 'Annual', 'active', now() + interval '200 days', false);

-- Who can touch it -----------------------------------------------------------------------------------------------------
select ok(not has_table_privilege('authenticated', 'private.stripe_cancellations', 'select')
  and not has_table_privilege('authenticated', 'private.billing_alerts', 'select'), 'nobody reads the queue or the alerts directly');
select ok(not has_function_privilege('authenticated', 'app.finish_stripe_cancellation(uuid, boolean, text, text)', 'execute')
  and not has_function_privilege('authenticated', 'app.claim_stripe_cancellations(text, boolean, integer)', 'execute')
  and not has_function_privilege('authenticated', 'app.reconcile_stripe_subscription(uuid, text, text, text, boolean, timestamptz)', 'execute')
  and not has_function_privilege('authenticated', 'app.note_stripe_subscription_terms(text, timestamptz, bigint, text, timestamptz)', 'execute'),
  'an Owner cannot mark a cancel accepted: only the service role moves it');

-- Ending a plan: online, no second factor ------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select throws_ok($$select * from app.request_plan_end(pg_temp.id('org_a'), false)$$, '42501', null, 'only who manages billing ends a plan');
select pg_temp.as_user('nina');
insert into world values ('org_n', app.create_organization('Nina Lighting', 'nina-lighting'));
select throws_ok($$select * from app.request_plan_end(pg_temp.id('org_n'), false)$$, 'XR001',
  'billing_no_subscription: This organization has no paid plan to end.', 'there must be a paid plan');
select pg_temp.as_user('alice');
select throws_ok($$select * from app.request_plan_end(pg_temp.id('org_a'), true)$$, 'XR001',
  'billing_no_subscription: This organization has no paid plan to end.', 'in the same Stripe mode');
select is((select cancellation_state::text from app.request_plan_end(pg_temp.id('org_a'), false)), 'Queued',
  'the Owner ends the plan with no second factor, and it is queued');
select is((select count(*)::integer from app.request_plan_end(pg_temp.id('org_a'), false)), 1, 'asking again is safe');
select pg_temp.as_platform();
select is((select count(*)::integer from private.stripe_cancellations where stripe_subscription_id = 'sub_N0rth'), 1, 'and queues no second cancel');
select pg_temp.as_user('alice');
select results_eq($$select cancel_mode::text, cancellation_state::text, source::text from app.stripe_cancellation_status(pg_temp.id('org_a'))$$,
  $$values ('At Period End'::text, 'Queued'::text, 'Plan Ended'::text)$$, 'Billing and Plan reads where it stands');
select pg_temp.as_user('dave');
select throws_ok($$select * from app.stripe_cancellation_status(pg_temp.id('org_a'))$$, '42501', null, 'a member without billing access does not');

-- The lifecycle --------------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
select throws_ok($$update private.stripe_cancellations set cancellation_state = 'Withdrawn' where stripe_subscription_id = 'sub_N0rth';
                   update private.stripe_cancellations set cancellation_state = 'Queued' where stripe_subscription_id = 'sub_N0rth'$$, 'XR001',
  'stripe_cancellation_transition_not_allowed: A Stripe cancellation cannot move from Withdrawn to Queued.', 'a withdrawn cancel stays withdrawn');
select is(pg_temp.cancel_state('sub_N0rth', 'At Period End'), 'Queued', 'the refused change left it queued');

-- The worker: retries, and tells the truth -------------------------------------------------------------------------------
select pg_temp.as_service();
create temporary table claimed as select * from app.claim_stripe_cancellations('worker-1', false, 10);
grant select on claimed to public;
select results_eq($$select stripe_subscription_id, cancel_mode::text, attempt from claimed$$,
  $$values ('sub_N0rth'::text, 'At Period End'::text, 1)$$, 'the worker claims what is due in its mode');
select is((select count(*)::integer from app.claim_stripe_cancellations('worker-2', false, 10)), 0, 'a claimed cancel is not claimed twice');
select is(app.finish_stripe_cancellation((select cancellation_id from claimed), false, null, 'connect ETIMEDOUT')::text, 'Queued', 'a failure stays queued');
select pg_temp.as_platform();
select results_eq($$select locked_by is null, last_error, next_attempt_at > now() + interval '4 minutes' and next_attempt_at <= now() + interval '6 minutes'
                    from private.stripe_cancellations where stripe_subscription_id = 'sub_N0rth'$$,
  $$values (true, 'connect ETIMEDOUT'::text, true)$$, 'and waits 5 minutes');
select results_eq($$select via, accepted, error from private.stripe_cancellation_attempts$$,
  $$values ('Worker'::text, false, 'connect ETIMEDOUT'::text)$$, 'each attempt is recorded');
select is(pg_temp.notices('billing.cancellation_delayed', 'org_a'), 1, 'the billing owners are told it is not confirmed');
select ok(exists (select 1 from private.billing_alerts where alert_kind = 'cancel_delayed' and stripe_subscription_id = 'sub_N0rth' and resolved_at is null),
  'the platform owner gets an alert');
update private.stripe_cancellations set next_attempt_at = now() - interval '1 minute' where stripe_subscription_id = 'sub_N0rth';
select pg_temp.as_service();
truncate claimed;
insert into claimed select * from app.claim_stripe_cancellations('worker-1', false, 10);
select is((select attempt from claimed), 2, 'the next try counts up');
select app.finish_stripe_cancellation((select cancellation_id from claimed), false, null, 'Stripe is down');
select pg_temp.as_platform();
select ok((select next_attempt_at > now() + interval '9 minutes' from private.stripe_cancellations where stripe_subscription_id = 'sub_N0rth'), 'the wait doubles');
select is(pg_temp.notices('billing.cancellation_delayed', 'org_a'), 1, 'the owners are told once');
-- A worker that died mid-call only delays the cancel.
update private.stripe_cancellations set next_attempt_at = now() - interval '1 minute', locked_by = 'dead', locked_at = now() - interval '11 minutes' where stripe_subscription_id = 'sub_N0rth';
select pg_temp.as_service();
truncate claimed;
insert into claimed select * from app.claim_stripe_cancellations('worker-1', false, 10);
select is((select count(*)::integer from claimed), 1, 'an abandoned claim can be taken again');
select is(app.finish_stripe_cancellation((select cancellation_id from claimed), true, 'active')::text, 'Accepted', 'Stripe accepts it');
select pg_temp.as_platform();
select is(pg_temp.notices('billing.plan_ending', 'org_a'), 1, 'the owners get the confirmation');
select ok((select (n.message_args ->> 'endsOn') is not null and n.message_args ->> 'plan' = 'Team' from app.notifications n
           where n.kind = 'billing.plan_ending' and n.org_id = pg_temp.id('org_a') limit 1), 'naming the plan and the date it ends');
select ok(not exists (select 1 from private.billing_alerts where alert_kind = 'cancel_delayed' and stripe_subscription_id = 'sub_N0rth' and resolved_at is null),
  'and the alert clears');
select pg_temp.as_service();
select app.finish_stripe_cancellation((select cancellation_id from claimed), true, 'active');
select pg_temp.as_platform();
select is(pg_temp.notices('billing.plan_ending', 'org_a'), 1, 'accepting twice confirms once');

-- Period-end terms from the webhook ---------------------------------------------------------------------------------------
select pg_temp.as_service();
select ok(app.note_stripe_subscription_terms('sub_H4rb', now() + interval '200 days', 149000, 'usd', now()), 'a cancel set in the Stripe portal is noted');
select pg_temp.as_platform();
select results_eq($$select cancellation_state::text, source::text, accepted_via from private.stripe_cancellations where stripe_subscription_id = 'sub_H4rb'$$,
  $$values ('Accepted'::text, 'Stripe Portal'::text, 'Webhook'::text)$$, 'and recorded as accepted');
select is(pg_temp.notices('billing.plan_ending', 'org_b'), 1, 'with its confirmation, since a portal cancel gets one too');
select results_eq($$select recurring_amount_minor, currency_code from app.stripe_subscription_links where stripe_subscription_id = 'sub_H4rb'$$,
  $$values (149000::bigint, 'USD'::text)$$, 'the amount each period charges is kept for renewal notices');
select pg_temp.as_service();
select ok(not app.note_stripe_subscription_terms('sub_H4rb', null, null, null, now() - interval '1 hour'), 'an older event changes nothing');
select ok(app.note_stripe_subscription_terms('sub_H4rb', null, null, null, now() + interval '1 minute'), 'the customer renews in the portal');
select pg_temp.as_platform();
select is(pg_temp.cancel_state('sub_H4rb', 'At Period End'), 'Withdrawn', 'which withdraws the cancel');
select is((select cancel_at from app.stripe_subscription_links where stripe_subscription_id = 'sub_H4rb'), null, 'and the plan renews again');

-- Canceling the org queues the Stripe cancel in the same transaction -----------------------------------------------------
select pg_temp.as_user('alice');
insert into world values ('cancel_a', app.cancel_organization(pg_temp.id('org_a'), 'Northwind Live', 'Closing down.'));
select pg_temp.as_platform();
select results_eq($$select cancellation_state::text, source::text, requested_by from private.stripe_cancellations
                    where stripe_subscription_id = 'sub_N0rth' and cancel_mode = 'Immediately'$$,
  $$values ('Queued'::text, 'Organization Canceled'::text, pg_temp.id('alice'))$$, 'canceling the org queues the immediate cancel');
select pg_temp.as_user('alice');
select is((select count(*)::integer from app.stripe_cancellation_status(pg_temp.id('org_a')) where cancel_mode = 'Immediately' and cancellation_state = 'Queued'), 1,
  'and the Owner can see it is not accepted yet');
select is((select count(*)::integer from app.stripe_cancellation_status(pg_temp.id('org_a')) where cancel_mode = 'At Period End'), 0,
  'and the plan End plan let run to its period end no longer reads as running, on an org that is canceled');

-- A webhook on an org that is ending never brings the subscription back ------------------------------------------------------
select pg_temp.as_service();
select is(app.reconcile_stripe_subscription(pg_temp.id('org_a'), 'cus_N0rth', 'sub_N0rth', 'active', false, now()), 'queued',
  'a live subscription on a canceled org does not reach the sync');
select pg_temp.as_platform();
select is((select count(*)::integer from app.subscriptions where org_id = pg_temp.id('org_a') and subscription_state <> 'canceled'), 0, 'and no subscription comes back');
select pg_temp.as_service();
select is(app.reconcile_stripe_subscription(pg_temp.id('org_a'), 'cus_N0rth', 'sub_N0rth', 'canceled', false, now()), 'ended', 'Stripe reports it ended');
select pg_temp.as_platform();
select is(pg_temp.cancel_state('sub_N0rth', 'Immediately'), 'Accepted', 'which settles the queued cancel');
select ok((select stripe_ended_at is not null from app.stripe_subscription_links where stripe_subscription_id = 'sub_N0rth'), 'and marks the subscription ended');
select is(pg_temp.notices('billing.cancellation_confirmed', 'org_a'), 1, 'and confirms it');
select pg_temp.as_service();
select is(app.reconcile_stripe_subscription(pg_temp.id('org_a'), 'cus_N0rth', 'sub_N0rth', 'active', false, now()), 'stale',
  'an older event after the accepted cancel says nothing new');
select is(app.reconcile_stripe_subscription(pg_temp.id('org_a'), 'cus_N0rth', 'sub_N0rth', 'active', false, now() + interval '11 minutes'), 'queued',
  'but Stripe calling it live later is a problem');
select pg_temp.as_platform();
select is(pg_temp.cancel_state('sub_N0rth', 'Immediately'), 'Queued', 'so the cancel is queued again');
select ok(exists (select 1 from private.billing_alerts where alert_kind = 'active_after_cancel' and stripe_subscription_id = 'sub_N0rth' and resolved_at is null),
  'and it raises an alert');
select pg_temp.as_service();
select is(app.reconcile_stripe_subscription(pg_temp.id('org_a'), 'cus_N0rth', 'sub_N0rth', 'canceled', false, now() + interval '12 minutes'), 'ended', 'once it ends');
select pg_temp.as_platform();
select ok(exists (select 1 from private.billing_alerts where stripe_subscription_id = 'sub_N0rth' and resolved_at is null and alert_kind = 'active_after_cancel'), 'the alert stays open, since it may have charged, until a person closes it');
select is(pg_temp.notices('billing.cancellation_confirmed', 'org_a'), 1, 'and the owners are not told a second time');
select pg_temp.as_service();
select is(app.reconcile_stripe_subscription(pg_temp.id('org_c'), 'cus_T1d3', 'sub_T1d3', 'active', false, now()), 'proceed', 'an ordinary subscription on a live org goes to the sync');
-- A subscription that ended in Stripe on its own, such as after failed retries: on record, and nobody is told they canceled.
select is(app.reconcile_stripe_subscription(pg_temp.id('org_c'), 'cus_T1d3', 'sub_Unasked', 'canceled', false, now()), 'proceed', 'a subscription that ended unasked goes on to the sync');
select pg_temp.as_platform();
select results_eq($$select cancellation_state::text, source::text from private.stripe_cancellations where stripe_subscription_id = 'sub_Unasked'$$,
  $$values ('Accepted'::text, 'Ended In Stripe'::text)$$, 'it is on record as having ended in Stripe');
select is(pg_temp.notices('billing.cancellation_confirmed', 'org_c'), 0, 'and the customer is not told they canceled');

-- The deletion gate ------------------------------------------------------------------------------------------------------
select pg_temp.as_user_stepped_up('xavier');
insert into world values ('del_b', app.request_org_deletion(pg_temp.id('org_b'), 'Harbor Lights Productions', 'We are closing down.'));
select pg_temp.as_platform();
select results_eq($$select cancellation_state::text, source::text from private.stripe_cancellations where stripe_subscription_id = 'sub_H4rb' and cancel_mode = 'Immediately'$$,
  $$values ('Queued'::text, 'Organization Deleted'::text)$$, 'asking to delete the org queues the immediate cancel');
select is(private.schedule_deletions(now() + interval '9 days'), 0, 'an org with an open Stripe subscription cannot finish deletion');
select is((select count(*)::integer from app.deletion_certificates where deleted_org_id = pg_temp.id('org_b')), 0, 'no certificate, so no purge');
select ok(exists (select 1 from private.billing_alerts where alert_kind = 'deletion_blocked' and subject_org_id = pg_temp.id('org_b') and resolved_at is null),
  'the platform owner is told it is waiting');
-- The worker's first failure tells the Owner too.
update private.stripe_cancellations set requested_at = now() - interval '16 minutes' where stripe_subscription_id = 'sub_H4rb' and cancel_mode = 'Immediately';
select is(private.run_stripe_cancellation_watch(now()), 1, 'a cancel left queued 15 minutes is reported even if the worker never ran');
select is(pg_temp.notices('billing.cancellation_delayed', 'org_b'), 1, 'to the owners');
insert into world select 'cancel_b', c.id from private.stripe_cancellations c where c.stripe_subscription_id = 'sub_H4rb' and c.cancel_mode = 'Immediately';
select pg_temp.as_service();
select results_eq($$select stripe_subscription_id from app.claim_stripe_cancellations('worker-1', false, 10) where stripe_subscription_id = 'sub_H4rb'$$,
  $$values ('sub_H4rb'::text)$$, 'the worker picks it up');
select is(app.finish_stripe_cancellation(pg_temp.id('cancel_b'), true, 'missing')::text,
  'Accepted', 'a subscription Stripe no longer has is accepted');
select pg_temp.as_platform();
select is(private.schedule_deletions(now() + interval '9 days'), 1, 'and now deletion goes on');
select ok(not exists (select 1 from private.billing_alerts where alert_kind = 'deletion_blocked' and subject_org_id = pg_temp.id('org_b') and resolved_at is null), 'and the alert clears');
-- A subscription that appears after the certificate still stops the purge.
insert into private.stripe_cancellations (subject_org_id, stripe_subscription_id, livemode, cancel_mode, source)
values (pg_temp.id('org_b'), 'sub_L4te', false, 'Immediately', 'Reconciliation');
select throws_ok($$update app.deletion_certificates set storage_cleared_at = now(), purged_at = now(), rows_purged = 0, tables_purged = 0 where deleted_org_id = pg_temp.id('org_b')$$,
  'XR001', 'purge_stripe_cancel_open: Stripe has not accepted the cancel of this org''s subscription, so its deletion waits.', 'the purge cannot finish past an open cancel');
update private.stripe_cancellations set cancellation_state = 'Withdrawn' where stripe_subscription_id = 'sub_L4te';

-- A purged org ---------------------------------------------------------------------------------------------------------
select pg_temp.as_service();
select ok((select is_new from app.record_stripe_event('evt_G0ne', 'customer.subscription.updated', false, now(), '{"id":"evt_G0ne"}'::jsonb, '00000000-0000-4000-8000-00000000dead')),
  'an event naming a purged org is still stored');
select is((select org_id from app.stripe_events where stripe_event_id = 'evt_G0ne'), null, 'with no org');
select is(app.reconcile_stripe_subscription('00000000-0000-4000-8000-00000000dead', 'cus_G0ne', 'sub_G0ne', 'active', false, now()), 'queued',
  'a subscription Stripe says is active on a deleted org is queued for cancel');
select pg_temp.as_platform();
select ok(exists (select 1 from private.billing_alerts where alert_kind = 'active_on_deleted_org' and stripe_subscription_id = 'sub_G0ne' and resolved_at is null), 'and raises an alert');
select pg_temp.as_service();
-- The normal case: Stripe accepts the cancel on the worker's next run, before anyone has been told. The alert must survive it.
select is(app.finish_stripe_cancellation((select cancellation_id from app.claim_stripe_cancellations('worker-1', false, 10) where stripe_subscription_id = 'sub_G0ne'), true, 'canceled')::text,
  'Accepted', 'Stripe accepts the cancel before the alert was sent');
select results_eq($$select alert_kind from app.billing_alerts_to_send(50) where stripe_subscription_id = 'sub_G0ne'$$,
  $$values ('active_on_deleted_org'::text)$$, 'and the alert still goes to the platform owner');
select app.mark_billing_alert_sent((select alert_id from app.billing_alerts_to_send(50) where stripe_subscription_id = 'sub_G0ne'));
select is((select count(*)::integer from app.billing_alerts_to_send(50) where stripe_subscription_id = 'sub_G0ne'), 0, 'once');
select is(app.reconcile_stripe_subscription('00000000-0000-4000-8000-00000000dead', 'cus_G0ne', 'sub_G0ne', 'canceled', false, now()), 'ended', 'and when it ends');
select pg_temp.as_platform();
select ok(exists (select 1 from private.billing_alerts where stripe_subscription_id = 'sub_G0ne' and resolved_at is null), 'it stays open until someone has looked for a charge');

-- A charge after a cancel ------------------------------------------------------------------------------------------------
select pg_temp.as_service();
select ok(app.note_stripe_charge('sub_H4rb', 'in_Late1', 149000, 'usd', 'subscription_cycle', now() + interval '1 minute'), 'a charge after the cancel raises an alert');
select ok(not app.note_stripe_charge('sub_H4rb', 'in_Zero', 0, 'usd', 'subscription_cycle', now() + interval '1 minute'), 'nothing charged, nothing raised');
select ok(not app.note_stripe_charge('sub_Oth3r', 'in_Oth3r', 100, 'usd', 'subscription_cycle', now()), 'nor for a subscription nobody asked to stop');
select ok(not app.note_stripe_charge('sub_Unasked', 'in_Owed', 149000, 'usd', 'manual', now() + interval '1 minute'),
  'nor for an overdue invoice paid on a subscription that ended in Stripe on its own');
select pg_temp.as_platform();
select ok((select detail like '%1,490.00 USD%in_Late1%' from private.billing_alerts where dedupe_key = 'charged_after_cancel:in_Late1'), 'naming the amount and invoice to refund');

-- A renewal paid while End plan waits on Stripe. The customer has been told they will not be charged again, so it is a refund
-- whether Stripe has accepted the cancel yet or not.
select pg_temp.as_service();
select app.sync_subscription_from_stripe(pg_temp.id('org_c'), 'cus_T1d3', 'sub_Renew', 'team', 'Annual', 'active', now() + interval '1 day', false);
select pg_temp.as_platform();
select private.queue_stripe_cancellation(pg_temp.id('org_c'), 'sub_Renew', 'cus_T1d3', false, 'At Period End', 'Plan Ended', null);
select pg_temp.as_service();
select ok(not app.note_stripe_charge('sub_Renew', 'in_Before', 149000, 'usd', 'subscription_cycle', now() - interval '1 hour'), 'a renewal paid before the request does not count');
select ok(not app.note_stripe_charge('sub_Renew', 'in_Seats', 5000, 'usd', 'subscription_update', now() + interval '1 hour'), 'nor does a change the Owner made, which is not a renewal');
select ok(app.note_stripe_charge('sub_Renew', 'in_Queued', 149000, 'usd', 'subscription_cycle', now() + interval '1 hour'), 'a renewal paid while the cancel is still queued raises an alert');
select is(app.finish_stripe_cancellation((select cancellation_id from app.claim_stripe_cancellations('worker-1', false, 10) where stripe_subscription_id = 'sub_Renew'), true, 'active')::text,
  'Accepted', 'Stripe then accepts the cancel');
select pg_temp.as_platform();
select ok(exists (select 1 from private.billing_alerts where dedupe_key = 'charged_after_cancel:in_Queued' and resolved_at is null), 'and the alert stays open for the refund');
select pg_temp.as_service();
select ok(app.note_stripe_charge('sub_Renew', 'in_Accepted', 149000, 'usd', 'subscription_cycle', now() + interval '2 hours'), 'a renewal paid after Stripe accepted it raises one too');
select pg_temp.as_platform();
update private.stripe_cancellations set cancellation_state = 'Withdrawn' where stripe_subscription_id = 'sub_Renew';
select pg_temp.as_service();
select ok(not app.note_stripe_charge('sub_Renew', 'in_Kept', 149000, 'usd', 'subscription_cycle', now() + interval '3 hours'), 'and none once the customer kept the plan');

-- A delayed older event never revives a plan that ended at period end ---------------------------------------------------------
select pg_temp.as_platform();
select private.queue_stripe_cancellation(pg_temp.id('org_c'), 'sub_Renew', 'cus_T1d3', false, 'At Period End', 'Plan Ended', null);
select pg_temp.as_service();
select app.finish_stripe_cancellation((select cancellation_id from app.claim_stripe_cancellations('worker-1', false, 10) where stripe_subscription_id = 'sub_Renew'), true, 'active');
select is(app.reconcile_stripe_subscription(pg_temp.id('org_c'), 'cus_T1d3', 'sub_Renew', 'canceled', false, now() + interval '4 hours'), 'proceed', 'the plan ends in Stripe');
select app.sync_subscription_from_stripe(pg_temp.id('org_c'), 'cus_T1d3', 'sub_Renew', 'team', 'Annual', 'canceled', now() + interval '4 hours', false, 0, false, null, now() + interval '4 hours');
select pg_temp.as_platform();
select is((select plan_code from app.subscriptions where org_id = pg_temp.id('org_c') and subscription_state <> 'canceled' and deleted_at is null), 'access', 'and the sync moves the org to Access');
select pg_temp.as_service();
select is(app.reconcile_stripe_subscription(pg_temp.id('org_c'), 'cus_T1d3', 'sub_Renew', 'active', false, now() + interval '3 hours'), 'stale', 'a retried event from before the end is stale');
select is(app.reconcile_stripe_subscription(pg_temp.id('org_c'), 'cus_T1d3', 'sub_Renew', 'active', false, now() + interval '4 hours'), 'stale', 'and so is one from the same moment');
select pg_temp.as_platform();
select is((select count(*)::integer from private.billing_alerts where stripe_subscription_id = 'sub_Renew' and alert_kind = 'active_after_cancel'), 0, 'with no alert, since Stripe said nothing new');
select is((select plan_code from app.subscriptions where org_id = pg_temp.id('org_c') and subscription_state <> 'canceled' and deleted_at is null), 'access', 'and the org stays on Access');
select pg_temp.as_service();
select is(app.reconcile_stripe_subscription(pg_temp.id('org_c'), 'cus_T1d3', 'sub_Renew', 'active', false, now() + interval '5 hours'), 'queued', 'Stripe calling it live after the end is a problem, not a sync');
select pg_temp.as_platform();
select is(pg_temp.cancel_state('sub_Renew', 'Immediately'), 'Queued', 'so its cancel is queued');
select ok(exists (select 1 from private.billing_alerts where alert_kind = 'active_after_cancel' and stripe_subscription_id = 'sub_Renew' and resolved_at is null), 'and it raises an alert');

-- A cancel between reconciliation and the sync ---------------------------------------------------------------------------------
-- Northwind was canceled above. An event reconciliation let through just before that reaches the sync now.
select pg_temp.as_service();
select is(app.sync_subscription_from_stripe(pg_temp.id('org_a'), 'cus_N0rth', 'sub_Race', 'team', 'Monthly', 'active', now() + interval '20 days', false)::text, 'canceled',
  'the sync refuses a live subscription on an org that is ending');
select pg_temp.as_platform();
select is((select count(*)::integer from app.subscriptions where org_id = pg_temp.id('org_a') and subscription_state <> 'canceled'), 0, 'no subscription comes back');
select is((select count(*)::integer from app.stripe_subscription_links where stripe_subscription_id = 'sub_Race'), 0, 'and no link is made');
select is(pg_temp.cancel_state('sub_Race', 'Immediately'), 'Queued', 'its cancel is queued');
select ok(exists (select 1 from private.billing_alerts where alert_kind = 'active_after_cancel' and stripe_subscription_id = 'sub_Race' and resolved_at is null), 'with an alert');

-- Stripe has no such subscription ---------------------------------------------------------------------------------------------
select ok(not exists (select 1 from private.billing_alerts where alert_kind = 'cancel_missing'), 'a test mode cancel Stripe did not know raises nothing');
select pg_temp.as_platform();
select private.queue_stripe_cancellation(pg_temp.id('org_c'), 'sub_L1veGone', 'cus_T1d3', true, 'Immediately', 'Reconciliation', null);
select pg_temp.as_service();
select is(app.finish_stripe_cancellation((select cancellation_id from app.claim_stripe_cancellations('worker-1', true, 10) where stripe_subscription_id = 'sub_L1veGone'), true, 'missing')::text,
  'Accepted', 'a live cancel Stripe answers as unknown settles');
select pg_temp.as_platform();
select ok(exists (select 1 from private.billing_alerts where alert_kind = 'cancel_missing' and stripe_subscription_id = 'sub_L1veGone' and resolved_at is null),
  'but a person checks the Dashboard, since another account''s key gets the same answer');

-- Recovering a deleted org leaves the paid plan ended --------------------------------------------------------------------------
select pg_temp.as_service();
select app.sync_subscription_from_stripe(pg_temp.id('org_n'), 'cus_N1na', 'sub_N1naR', 'team', 'Monthly', 'active', now() + interval '20 days', false);
select pg_temp.as_user_stepped_up('nina');
insert into world values ('del_n', app.request_org_deletion(pg_temp.id('org_n'), 'Nina Lighting', 'Trying it out.'));
select pg_temp.as_service();
select app.finish_stripe_cancellation((select cancellation_id from app.claim_stripe_cancellations('worker-1', false, 10) where stripe_subscription_id = 'sub_N1naR'), true, 'canceled');
select pg_temp.as_user('nina');
select is(app.recover_org_deletion(pg_temp.id('org_n')), pg_temp.id('del_n'), 'the Owner recovers the org');
select pg_temp.as_service();
select isnt(app.reconcile_stripe_subscription(pg_temp.id('org_n'), 'cus_N1na', 'sub_N1naR', 'canceled', false, now() + interval '1 minute'), 'queued',
  'Stripe''s late deleted event is no problem');
select pg_temp.as_platform();
select results_eq($$select plan_code from app.subscriptions where org_id = pg_temp.id('org_n') and subscription_state <> 'canceled' and deleted_at is null$$,
  $$values ('access'::text)$$, 'and the org is back on Access, not the paid plan');

select * from finish();
rollback;
