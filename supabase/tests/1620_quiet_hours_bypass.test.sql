-- pgTAP: migration 1620, the quiet-hours bypass list after ADR 0033 decision 62 (2026-10-23, RRR-125). A new shift
-- assigned within 12 hours goes at once, as a shift change does; a change to the person's sign-in security, a
-- recovery code used on their account and emergency access taken in their org go at once; billing notices wait until
-- the quiet hours end. Dave's quiet hours
-- run from an hour ago to ten hours from now in UTC, so nothing here depends on the clock.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = extensions, public;
\ir 0300_domain_world.psql

select plan(14);

create function pg_temp.delivery(p_notification uuid, p_channel app.notification_channel) returns text
language sql as $$
  select d.message_status::text || case when d.deliver_after > now() then ' until +' || (d.deliver_after - now())::text else '' end
  from app.notification_deliveries d where d.notification_id = p_notification and d.channel = p_channel
$$;

create function pg_temp.notify(p_kind text, p_args jsonb) returns uuid
language sql as $$
  select private.notify(pg_temp.id('org_a'), pg_temp.id('dave'), p_kind, null, null, null, p_args);
$$;

-- Dave takes texts and pushes for schedule and account notices, and is inside his quiet hours.
select pg_temp.as_platform();
update auth.users set phone = '15555550122', phone_confirmed_at = now() where id = pg_temp.id('dave_user');
insert into app.sms_consent_events (org_id, person_id, phone_e164, action, source)
values (pg_temp.id('org_a'), pg_temp.id('dave'), '+15555550122', 'Opt In', 'Web');
insert into app.notification_settings (membership_id, time_zone, quiet_hours_start, quiet_hours_end)
values (pg_temp.id('dave@org_a'), 'UTC', ((now() at time zone 'UTC') - interval '1 hour')::time,
  ((now() at time zone 'UTC') + interval '10 hours')::time);
select pg_temp.as_user('dave');
select app.set_my_notification_preferences(pg_temp.id('org_a'), '[
  {"category": "schedule", "channel": "SMS", "enabled": true},
  {"category": "account", "channel": "SMS", "enabled": true}]'::jsonb);
insert into app.push_subscriptions (membership_id, expo_push_token, platform)
values (pg_temp.id('dave@org_a'), 'ExponentPushToken[cccccccccccccccccccc]', 'ios');
select pg_temp.as_platform();

select set_eq($$select kind, starts_within from private.notification_quiet_hours_bypass$$,
  $$values ('shift.assigned', interval '12 hours'), ('shift.changed', interval '12 hours'), ('incident.reported', null::interval),
    ('occupancy.threshold', null::interval), ('weather.alert', null::interval), ('account.security_changed', null::interval),
    ('account.recovery_code_used', null::interval), ('access.break_glass_started', null::interval)$$,
  'the bypass list adds a new shift, security changes and emergency access, and stays short');

-- 1. A new shift within 12 hours goes at once, like a shift change ---------------------------------------------------------
select pg_temp.notify('shift.assigned', jsonb_build_object('title', 'Load in', 'startsAt', now() + interval '3 hours')) as v_soon \gset
select is(pg_temp.delivery(:'v_soon', 'Push'), 'Queued', 'a shift assigned that starts in 3 hours is pushed at once');
select is(pg_temp.delivery(:'v_soon', 'SMS'), 'Queued', 'and texted at once');
select pg_temp.notify('shift.assigned', jsonb_build_object('title', 'Strike', 'startsAt', now() + interval '12 hours 30 minutes')) as v_window \gset
select is(pg_temp.delivery(:'v_window', 'Push'), 'Deferred until +00:30:00',
  'one that starts in 12.5 hours waits only until it is 12 hours away');
select pg_temp.notify('shift.assigned', jsonb_build_object('title', 'Doors', 'startsAt', now() + interval '30 hours')) as v_later \gset
select is(pg_temp.delivery(:'v_later', 'Push'), 'Deferred until +10:00:00', 'one that starts tomorrow waits out the quiet hours');

-- 2. Security changes and emergency access go at once ------------------------------------------------------------------------
select pg_temp.notify('account.security_changed', '{"change": "password"}') as v_security \gset
select is(pg_temp.delivery(:'v_security', 'Push') || ', ' || pg_temp.delivery(:'v_security', 'SMS'), 'Queued, Queued',
  'a change to his sign-in security reaches him at once');
select pg_temp.notify('account.recovery_code_used', '{"remaining": 9}') as v_recovery \gset
select is(pg_temp.delivery(:'v_recovery', 'Push') || ', ' || pg_temp.delivery(:'v_recovery', 'SMS'), 'Queued, Queued',
  'as does a recovery code used on his account, the security notice A99 sends');
select pg_temp.notify('access.break_glass_started', '{"orgName": "Northwind Live", "actorName": "Alice Moreno", "reason": "Payroll outage"}')
  as v_break_glass \gset
select is(pg_temp.delivery(:'v_break_glass', 'Push') || ', ' || pg_temp.delivery(:'v_break_glass', 'SMS'), 'Queued, Queued',
  'and so does emergency access taken in his org');

-- 3. Billing notices wait until morning ----------------------------------------------------------------------------------------
select pg_temp.notify('billing.payment_failed', '{"days": 1}') as v_payment \gset
select is(pg_temp.delivery(:'v_payment', 'Push'), 'Deferred until +10:00:00', 'a failed payment waits out the quiet hours');
select is(pg_temp.delivery(:'v_payment', 'SMS'), 'Digest until +10:00:00', 'and its text is held for the morning summary');
select pg_temp.notify('billing.read_only', '{}') as v_read_only \gset
select is(pg_temp.delivery(:'v_read_only', 'Push'), 'Deferred until +10:00:00', 'so does a read-only notice, although the category is urgent');

-- 4. The sender hands over only what may go now -------------------------------------------------------------------------------
create temporary table claimed as select * from app.claim_notification_deliveries('Push', 500);
select set_eq($$select notification_id from claimed where recipient_person_id = pg_temp.id('dave')$$,
  format($$values ('%s'::uuid), ('%s'::uuid), ('%s'::uuid), ('%s'::uuid)$$, :'v_soon', :'v_security', :'v_recovery',
    :'v_break_glass'),
  'claimed inside his quiet hours, the pushes that bypass them go and the rest wait');
select is(pg_temp.delivery(:'v_payment', 'Push'), 'Deferred until +10:00:00', 'the billing push is still waiting');
select set_eq($$select d.notification_id from app.sms_summary_queue q
           join app.notification_deliveries d on d.id = q.notification_delivery_id
           where q.membership_id = pg_temp.id('dave@org_a') and q.deleted_at is null and q.sent_at is null$$,
  format($$values ('%s'::uuid), ('%s'::uuid), ('%s'::uuid), ('%s'::uuid)$$, :'v_window', :'v_later', :'v_payment', :'v_read_only'),
  'his summary holds the billing texts and the shifts further away, never a text that bypasses quiet hours');

select * from finish();
rollback;
