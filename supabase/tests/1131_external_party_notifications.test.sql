-- pgTAP: migration 1131, notifications for external parties (finding A38-002, journey 56). The invoicing account's
-- Owner, Admin and Finance members are notified at each Money tracker step (Submitted, Approved, Scheduled, Paid) with
-- an in-app notification, an Email and a Push delivery as their own preferences allow; a supplied Account Member,
-- another account and anyone outside the org get nothing. Party preferences are owner-only. Members keep the
-- membership path. The worker no longer suppresses an external party as having left the org; Push without a device is
-- suppressed with its reason.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0700_engagement_world.psql

select plan(29);

create function pg_temp.n(p_who text, p_sql text) returns integer
language plpgsql as $$
declare v integer;
begin
  perform pg_temp.as_user(p_who);
  execute 'select count(*)::int from (' || p_sql || ') x' into v;
  perform pg_temp.as_platform();
  return v;
end $$;

create function pg_temp.kinds(p_person text) returns text
language sql as $$
  select coalesce(string_agg(n.kind, ',' order by n.kind), '') from app.notifications n
  where n.recipient_person_id = pg_temp.id(p_person) and n.subject_table = 'invoices'
$$;

-- Preferences: owner-only, Email and Push only ----------------------------------------------------------------------
select pg_temp.as_user('fiona');
select lives_ok($$insert into app.person_notification_preferences (person_id, category_code, channel, enabled)
  values ((select id from world where key = 'fiona'), 'finance', 'Push', false)$$, 'a party turns off finance pushes for themself');
select throws_ok($$insert into app.person_notification_preferences (person_id, category_code, channel, enabled)
  values ((select id from world where key = 'fiona'), 'finance', 'SMS', true)$$, '23514', null, 'SMS is not a party channel');
select throws_ok($$insert into app.person_notification_preferences (person_id, category_code, channel, enabled)
  values ((select id from world where key = 'victor'), 'finance', 'Email', false)$$, '42501', null, 'nobody sets another person''s preferences');
select pg_temp.as_user('victor');
select is((select count(*)::int from app.person_notification_preferences), 0, 'a person reads only their own preferences');
select pg_temp.as_anon();
select throws_ok('select 1 from app.person_notification_preferences', '42501', null, 'anon reads no preferences');

-- Submitted ------------------------------------------------------------------------------------------------------------
select pg_temp.as_platform();
select pg_temp.move_engagement('eng_vendor_a', 'Onboarding', 'Active');
select pg_temp.as_user('victor');
with i as (select app.submit_engagement_invoice(pg_temp.id('eng_vendor_a'), 'BA-1131', '2027-06-05', '2027-07-05', 'USD',
  '[{"description": "Audio crew day", "quantity": 2, "unit_price_minor": 120000}]'::jsonb) as id)
  insert into world select 'inv', id from i;
select pg_temp.as_platform();
select is(pg_temp.kinds('victor'), 'invoice.submitted', 'the account Owner is notified the invoice was submitted');
select is(pg_temp.kinds('fiona'), 'invoice.submitted', 'and Account Finance');
select is(pg_temp.kinds('sam'), '', 'a supplied Account Member is not');
select is((select message_args ->> 'title' from app.notifications where recipient_person_id = pg_temp.id('victor')), 'BA-1131',
  'the message names the invoice number');
select is((select message_args ->> 'gatewayPath' from app.notifications where recipient_person_id = pg_temp.id('victor')), '/money/invoices',
  'and where to follow it in Gateway');
select is((select string_agg(d.channel::text, ',' order by d.channel) from app.notification_deliveries d
  join app.notifications n on n.id = d.notification_id where n.recipient_person_id = pg_temp.id('victor')), 'Email,Push',
  'with the defaults the Owner gets an Email and a Push delivery');
select is((select string_agg(d.channel::text, ',' order by d.channel) from app.notification_deliveries d
  join app.notifications n on n.id = d.notification_id where n.recipient_person_id = pg_temp.id('fiona')), 'Email',
  'Finance, who turned finance pushes off, gets Email only');
select is((select count(*)::int from app.notification_deliveries d join app.notifications n on n.id = d.notification_id
  where n.recipient_person_id = pg_temp.id('victor') and d.message_status <> 'Queued'), 0, 'party deliveries go at once, never deferred or digested');

-- Reading ---------------------------------------------------------------------------------------------------------------
select is(pg_temp.n('victor', 'select 1 from app.notifications'), 1, 'the party reads their own notification');
select is(pg_temp.n('victor', 'select 1 from app.notification_deliveries'), 2, 'and its deliveries');
select is(pg_temp.n('fiona', format($$select 1 from app.notifications where recipient_person_id <> '%s'$$, pg_temp.id('fiona'))), 0,
  'nobody reads another person''s notifications');
select is(pg_temp.n('xavier', 'select 1 from app.notifications'), 0, 'another tenant reads none');
select pg_temp.as_user('victor');
select lives_ok($$update app.notifications set read_at = now() where recipient_person_id = (select id from world where key = 'victor')$$,
  'the party marks it read');

-- Approved, Scheduled, Paid --------------------------------------------------------------------------------------------
select pg_temp.as_platform();
-- Posting to the ledger needs an accounting calendar this world does not set up; it is not what this suite tests.
alter table app.invoice_state_transitions disable trigger t85_post_invoice;
select private.transition_lifecycle('invoice', 'app.invoices', 'invoice_state', 'app.invoice_state_transitions', 'invoice_id',
  pg_temp.id('inv'), 'Proposed', 'Approved', 'Approved for payment.');
select is(pg_temp.kinds('victor'), 'invoice.approved,invoice.submitted', 'Approved notifies the account');
select pg_temp.as_user('alice');
with p as (insert into app.payments (counterparty_id, direction, amount_minor, currency_code, paid_on)
  values (pg_temp.id('cp_v_a'), 'Payable', 240000, 'USD', current_date) returning id) insert into world select 'pay', id from p;
insert into app.payment_applications (payment_id, invoice_id, amount_minor) values (pg_temp.id('pay'), pg_temp.id('inv'), 240000);
select pg_temp.as_platform();
select is(pg_temp.kinds('victor'), 'invoice.approved,invoice.scheduled,invoice.submitted', 'a payment applied to it is Scheduled');
select private.transition_lifecycle('payment', 'app.payments', 'payment_state', 'app.payment_state_transitions', 'payment_id',
  pg_temp.id('pay'), 'Proposed', 'Approved', 'Paid by ACH.');
select is(pg_temp.kinds('victor'), 'invoice.approved,invoice.paid,invoice.scheduled,invoice.submitted', 'approving the payment that settles it is Paid');
select is(pg_temp.kinds('fiona'), 'invoice.approved,invoice.paid,invoice.scheduled,invoice.submitted', 'Finance follows every step too');
select is(pg_temp.kinds('sam'), '', 'the supplied member never does');

-- Members keep their path; strangers get nothing --------------------------------------------------------------------------
select ok(private.notify(pg_temp.id('org_a'), pg_temp.id('dave'), 'invoice.approved') is not null, 'a member is still notified');
select ok(private.notify(pg_temp.id('org_a'), pg_temp.id('quinn'), 'invoice.approved') is null, 'a party of another org only gets nothing');
select ok(private.notify(pg_temp.id('org_b'), pg_temp.id('victor'), 'invoice.approved') is not null, 'the account is a party of org_b too (cp_v_b)');

-- The worker ---------------------------------------------------------------------------------------------------------------
select is((select count(*)::int from app.claim_notification_deliveries('Email', 500) c where c.recipient_person_id = pg_temp.id('victor')), 5,
  'the worker claims the party''s emails instead of suppressing them');
select is((select count(*)::int from app.claim_notification_deliveries('Push', 500) c where c.recipient_person_id = pg_temp.id('victor')), 0,
  'pushes to a party without a registered device are not sent');
select is((select max(d.last_error) from app.notification_deliveries d join app.notifications n on n.id = d.notification_id
  where n.recipient_person_id = pg_temp.id('victor') and d.channel = 'Push'), 'No registered device.',
  'and stay recorded as suppressed with the reason');

select * from finish();
rollback;
