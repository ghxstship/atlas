-- pgTAP: the push and SMS senders' database side (A80, RRR-125, finding A65-012): push tickets with idempotency
-- per delivery and device, receipts and pruning of devices Expo no longer knows, quiet hours at claim time with
-- the default SMS window in the recipient's time zone, inbound STOP, START and HELP, and SMS status callbacks
-- (Section 14.5, ADR 0030).
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(30);

create function pg_temp.delivery(p_notification uuid, p_channel app.notification_channel) returns uuid
language sql as $$
  select d.id from app.notification_deliveries d where d.notification_id = p_notification and d.channel = p_channel
$$;

create function pg_temp.status(p_delivery uuid) returns text
language sql as $$ select d.message_status::text from app.notification_deliveries d where d.id = p_delivery $$;

create function pg_temp.due(p_delivery uuid) returns void
language sql as $$
  update app.notification_deliveries set message_status = 'Queued', deliver_after = now() where id = p_delivery
$$;

-- A zone where it is now night (inside 21:00 to 08:00) and one where it is now day.
create function pg_temp.zone(p_night boolean) returns text
language sql stable as $$
  select z.name from pg_timezone_names z
  where z.name like '%/%' and z.name not like 'posix/%' and z.name not like 'Etc/%'
    and case when p_night then (now() at time zone z.name)::time >= time '21:30' or (now() at time zone z.name)::time < time '07:30'
             else (now() at time zone z.name)::time between time '10:00' and time '18:00' end
  order by z.name limit 1
$$;

select pg_temp.as_platform();
update auth.users set phone = '15555550100', phone_confirmed_at = now() where id = pg_temp.id('dave_user');
insert into app.sms_consent_events (org_id, person_id, phone_e164, action, source)
values (pg_temp.id('org_a'), pg_temp.id('dave'), '+15555550100', 'Opt In', 'Web');

select is(private.recipient_address(pg_temp.id('dave'), 'SMS'), '+15555550100',
  'the verified phone comes back in E.164, as consent and suppression rows store it');

select pg_temp.as_user('dave');
insert into app.notification_preferences (membership_id, category_code, channel, enabled)
values (pg_temp.id('dave@org_a'), 'approvals', 'SMS', true);
insert into app.notification_settings (membership_id, time_zone) values (pg_temp.id('dave@org_a'), pg_temp.zone(true));
insert into app.push_subscriptions (membership_id, expo_push_token, platform) values
  (pg_temp.id('dave@org_a'), 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaa]', 'ios'),
  (pg_temp.id('dave@org_a'), 'ExponentPushToken[bbbbbbbbbbbbbbbbbbbb]', 'android');
select pg_temp.as_platform();

create temporary table n (key text primary key, id uuid);
grant select on n to public;
insert into n values ('a1', private.notify(pg_temp.id('org_a'), pg_temp.id('dave'), 'approval.requested', 'app.expenses',
  gen_random_uuid(), pg_temp.id('prj_a'), '{"title": "Rigging rental"}'));

-- SMS: the default window at night, then consent and the verified number by day ----------------------------------
select is((select count(*)::integer from app.claim_notification_deliveries('SMS', 50)), 0,
  'at night in the member''s time zone no SMS is claimed');
select is(pg_temp.status(pg_temp.delivery((select id from n where key = 'a1'), 'SMS')), 'Deferred',
  'the SMS waits for the default window to end');
select ok((select (deliver_after at time zone pg_temp.zone(true))::time = time '08:00'
           from app.notification_deliveries where id = pg_temp.delivery((select id from n where key = 'a1'), 'SMS')),
  'it is due at 08:00 in the member''s time zone');
select ok(private.sms_quiet_until(pg_temp.id('dave@org_a'), now()) is not null and private.local_quiet_until(pg_temp.id('dave@org_a'), now()) is null,
  'the default window applies to SMS only; push keeps the member''s own quiet hours (none)');

update app.notification_settings set time_zone = pg_temp.zone(false) where membership_id = pg_temp.id('dave@org_a');
select pg_temp.due(pg_temp.delivery((select id from n where key = 'a1'), 'SMS'));
create temporary table sms1 as select * from app.claim_notification_deliveries('SMS', 50);
select is((select address from sms1), '+15555550100', 'by day the SMS is claimed for the consented, verified number');
select is((select category_code from sms1), 'approvals', 'the claim names the category');
select is((select notification_id from sms1), (select id from n where key = 'a1'), 'and the notification, for the push data contract');

update app.notification_settings set time_zone = pg_temp.zone(true),
  quiet_hours_start = ((now() at time zone pg_temp.zone(true)) + interval '2 hours')::time,
  quiet_hours_end = ((now() at time zone pg_temp.zone(true)) + interval '3 hours')::time
where membership_id = pg_temp.id('dave@org_a');
select is(private.sms_quiet_until(pg_temp.id('dave@org_a'), now()), null::timestamptz,
  'a member''s own quiet hours replace the default SMS window');
update app.notification_settings set quiet_hours_start = null, quiet_hours_end = null, time_zone = pg_temp.zone(false)
where membership_id = pg_temp.id('dave@org_a');

-- Push: devices, tickets and idempotency per delivery ------------------------------------------------------------------
create temporary table push1 as select * from app.claim_notification_deliveries('Push', 50);
select is((select jsonb_array_length(push_devices) from push1), 2, 'a push claim lists every live device of the member');
select app.record_push_tickets((select delivery_id from push1), jsonb_build_array(
  jsonb_build_object('subscriptionId', (select (push_devices -> 0 ->> 'subscriptionId') from push1), 'status', 'ok', 'ticketId', 'tkt-a1'),
  jsonb_build_object('subscriptionId', (select (push_devices -> 1 ->> 'subscriptionId') from push1), 'status', 'error',
    'error', 'DeviceNotRegistered', 'message', 'not a registered push token')));
select is((select string_agg(message_status::text, ',' order by message_status) from app.push_tickets where notification_delivery_id = (select delivery_id from push1)),
  'Sent,Bounced', 'one ticket per device: accepted, and refused because the device is gone');
select ok((select revoked_at is not null from app.push_subscriptions where expo_push_token = 'ExponentPushToken[bbbbbbbbbbbbbbbbbbbb]'),
  'DeviceNotRegistered revokes the device');

select pg_temp.due((select delivery_id from push1));
create temporary table push2 as select * from app.claim_notification_deliveries('Push', 50);
select is((select push_devices from push2), '[]'::jsonb,
  'a retried delivery lists no device already pushed: Expo is never asked twice for the same device');
select lives_ok($$select app.record_notification_delivery((select delivery_id from push2), 'Sent', 'tkt-a1', null)$$,
  'the sender records the outcome');
select throws_ok($$select app.record_push_tickets(gen_random_uuid(), '[]'::jsonb)$$, 'XR001', null,
  'tickets belong to a known push delivery');

-- Receipts and pruning ------------------------------------------------------------------------------------------------
select is((select count(*)::integer from app.claim_push_receipts()), 0, 'receipts are not asked for before 15 minutes');
-- The audit trigger keeps created_at; step around it to age the ticket.
set local session_replication_role = replica;
update app.push_tickets set created_at = now() - interval '20 minutes' where expo_ticket_id = 'tkt-a1';
set local session_replication_role = origin;
select is((select array_agg(ticket_id) from app.claim_push_receipts()), array['tkt-a1'], 'then the ticket is due for its receipt');
select is(app.record_push_receipts('[{"ticketId": "tkt-a1", "status": "ok"}]'::jsonb), 0, 'an ok receipt prunes nothing');
select is(pg_temp.status((select delivery_id from push1)), 'Delivered', 'an ok receipt marks the delivery Delivered');
select is((select count(*)::integer from app.claim_push_receipts()), 0, 'a read receipt is not asked for again');

insert into n values ('a2', private.notify(pg_temp.id('org_a'), pg_temp.id('dave'), 'approval.requested'));
create temporary table push3 as select * from app.claim_notification_deliveries('Push', 50);
select app.record_push_tickets((select delivery_id from push3), jsonb_build_array(jsonb_build_object(
  'subscriptionId', (select (push_devices -> 0 ->> 'subscriptionId') from push3), 'status', 'ok', 'ticketId', 'tkt-a2')));
select app.record_notification_delivery((select delivery_id from push3), 'Sent', 'tkt-a2', null);
select is(app.record_push_receipts('[{"ticketId": "tkt-a2", "status": "error", "error": "DeviceNotRegistered", "message": "gone"}]'::jsonb), 1,
  'a DeviceNotRegistered receipt prunes the device');
select is(pg_temp.status((select delivery_id from push3)), 'Bounced', 'and the delivery that reached no device bounces');
insert into n values ('a3', private.notify(pg_temp.id('org_a'), pg_temp.id('dave'), 'approval.requested'));
select is((select count(*)::integer from app.claim_notification_deliveries('Push', 50)), 0, 'a member with no live device gets no push claim');
select is((select last_error from app.notification_deliveries where id = pg_temp.delivery((select id from n where key = 'a3'), 'Push')),
  'No registered device.', 'the delivery is suppressed with the reason');

-- Inbound keywords and status callbacks ----------------------------------------------------------------------------------
select is(app.record_sms_keyword('+15555550100', 'Opt Out', 'stop'), 1, 'STOP is recorded in every org that texts the number');
select is((select count(*)::integer from app.suppression_list where address = '+15555550100' and reason = 'STOP' and lifted_at is null), 1,
  'STOP writes the STOP suppression');
select ok(not (select may_text from app.sms_consent_status where org_id = pg_temp.id('org_a') and phone_e164 = '+15555550100'),
  'and withdraws consent');
select app.record_sms_keyword('+15555550100', 'Opt In', 'START');
select ok((select may_text from app.sms_consent_status where org_id = pg_temp.id('org_a') and phone_e164 = '+15555550100')
  and not exists (select 1 from app.suppression_list where address = '+15555550100' and lifted_at is null),
  'START restores consent and lifts the STOP suppression');

select app.record_notification_delivery((select delivery_id from sms1), 'Sent', 'SM-test-1', null);
select ok(app.record_sms_status('SM-test-1', 'undelivered', '30003 Unreachable destination handset')
  and pg_temp.status((select delivery_id from sms1)) = 'Bounced', 'an undelivered status callback bounces the SMS');

-- Who may see and call it ---------------------------------------------------------------------------------------------
select pg_temp.as_user('dave');
select throws_ok($$select app.record_sms_keyword('+15555550100', 'Opt Out', 'STOP')$$, '42501', null,
  'only the webhook (service role) records inbound keywords');

select * from finish();
rollback;
